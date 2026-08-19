import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  createPendingNudge,
  listNudgedSubjectRefs,
  listNudgesByStatus,
  markNudgeAsked,
  markNudgeOutcome,
  markNudgeQueued,
  setNudgeAttempts,
} from './nudges.js';
import { createTenant } from './tenants.js';

// Integration test against the LOCAL stack (testEnvGuard enforces local-only).
// Exercises the nudge lifecycle guards the watcher/compose/transport steps
// lean on: the ask-once-EVER unique index, the status-guarded transitions,
// the per-person budget read, and the review_items once-ever backstop index
// this migration added for Feature A.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let tenantB: string | undefined;
let techId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  await pg.query('truncate table nudges cascade');
  // A dedicated recipient row — seat_exempt so the seat-cap trigger never
  // depends on how much roster the current seed left behind.
  const tech = await pg.query<{ id: string }>(
    `insert into technicians (tenant_id, ref, display_name, tier, state, seat_exempt)
     values ($1, 'nudge-test-tech', 'Nudge Test Tech', 'technician', 'active', true)
     returning id`,
    [tenantId],
  );
  techId = tech.rows[0].id;
});

afterAll(async () => {
  await pg.query('truncate table nudges cascade');
  await pg.query("delete from review_items where subject_ref like 'nudge-bt-%'");
  await pg.query('delete from technicians where id = $1', [techId]);
  if (tenantB) await pg.query('delete from tenants where id = $1', [tenantB]);
  await pg.end();
});

describe('createPendingNudge — ask once per subject, ever', () => {
  test('first insert lands pending; the repeat converges to null', async () => {
    const first = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-dedup-1',
      technicianId: techId,
      context: { jobTitle: 'Furnace tune-up' },
    });
    expect(first?.status).toBe('pending');
    expect(first?.actor_ref).toBe('spine:team-lead');

    const repeat = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-dedup-1',
      technicianId: techId,
    });
    expect(repeat).toBeNull(); // the unique index IS the dedup

    // Even after the first is CLOSED, the subject stays blocked — the index
    // is deliberately not partial (an assignment's end never recurs).
    await markNudgeOutcome(first!.id, tenantId, 'cancelled', 'test close');
    const afterClose = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-dedup-1',
      technicianId: techId,
    });
    expect(afterClose).toBeNull();
  });
});

describe('status-guarded transitions', () => {
  test('pending→queued→asked walks; wrong-state writes refuse with null', async () => {
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-walk-1',
      technicianId: techId,
    });
    expect(n).not.toBeNull();

    // asked before queued: refused (the runner can only ack a composed row)
    expect(await markNudgeAsked(n!.id, tenantId)).toBeNull();

    const queued = await markNudgeQueued(n!.id, tenantId, 'How did the visit go?');
    expect(queued?.status).toBe('queued');
    expect(queued?.question).toBe('How did the visit go?');
    expect(queued?.queued_at).not.toBeNull();

    // queued→queued: refused (compose must not double-write)
    expect(await markNudgeQueued(n!.id, tenantId, 'second question')).toBeNull();

    const asked = await markNudgeAsked(n!.id, tenantId);
    expect(asked?.status).toBe('asked');
    expect(asked?.asked_at).not.toBeNull();

    const answered = await markNudgeOutcome(n!.id, tenantId, 'answered', 'capture landed');
    expect(answered?.status).toBe('answered');
    expect(answered?.resolved_at).not.toBeNull();

    // Terminal is terminal: a racing escalation sweep must not overwrite.
    expect(await markNudgeOutcome(n!.id, tenantId, 'escalated')).toBeNull();
  });

  test('fromStatuses narrows the outcome guard: the expiry write loses to a racing delivery ack', async () => {
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-race-1',
      technicianId: techId,
    });
    await markNudgeQueued(n!.id, tenantId, 'q');
    await markNudgeAsked(n!.id, tenantId); // the ack landed first
    // The expiry sweep's "never delivered" close is pending|queued-scoped —
    // on an asked row it must write NOTHING (the 48h escalation owns it now).
    expect(
      await markNudgeOutcome(n!.id, tenantId, 'failed', 'never delivered', ['pending', 'queued']),
    ).toBeNull();
    const still = await listNudgesByStatus(tenantId, ['asked']);
    expect(still.some((row) => row.id === n!.id)).toBe(true);
  });

  test('setNudgeAttempts writes only while the row is still in flight (pending/queued)', async () => {
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-attempts-1',
      technicianId: techId,
    });
    const bumped = await setNudgeAttempts(n!.id, tenantId, 1);
    expect(bumped?.attempts).toBe(1);
    await markNudgeOutcome(n!.id, tenantId, 'cancelled');
    // Terminal rows never gain attempts — the write is dropped, not applied.
    expect(await setNudgeAttempts(n!.id, tenantId, 2)).toBeNull();
  });

  test('cross-tenant ids resolve nothing', async () => {
    tenantB = (await createTenant('Nudge Test Tenant B')).id;
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-xtenant-1',
      technicianId: techId,
    });
    expect(await markNudgeQueued(n!.id, tenantB, 'stolen question')).toBeNull();
    expect(await markNudgeOutcome(n!.id, tenantB, 'cancelled')).toBeNull();
    expect(await listNudgesByStatus(tenantB, ['pending'])).toEqual([]);
    expect(await listNudgedSubjectRefs(tenantB, 'overdue_visit_gap', ['asg-xtenant-1'])).toEqual(
      [],
    );
  });
});

describe('listNudgedSubjectRefs — the fresh-gap pre-filter', () => {
  test('returns only the subjects ever nudged, any status; empty input short-circuits', async () => {
    const a = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-filter-a',
      technicianId: techId,
    });
    await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-filter-b',
      technicianId: techId,
    });
    // A CLOSED nudge still counts — the filter is any-status by design.
    await markNudgeOutcome(a!.id, tenantId, 'cancelled');

    const hit = await listNudgedSubjectRefs(tenantId, 'overdue_visit_gap', [
      'asg-filter-a',
      'asg-filter-b',
      'asg-filter-never',
    ]);
    expect(hit.sort()).toEqual(['asg-filter-a', 'asg-filter-b']);

    expect(await listNudgedSubjectRefs(tenantId, 'overdue_visit_gap', [])).toEqual([]);
  });
});

describe('review_items once-ever backstop index (Feature A debt, paid here)', () => {
  test('a duplicate overdue_visit_gap subject fails at the DB even bypassing the app guard', async () => {
    await pg.query(
      `insert into review_items (tenant_id, kind, subject_ref, status, resolution, resolved_at)
       values ($1, 'overdue_visit_gap', 'nudge-bt-1', 'resolved', 'closed once', now())`,
      [tenantId],
    );
    // The open-only partial index would NOT block this (first row is closed);
    // the new any-status index must.
    await expect(
      pg.query(
        `insert into review_items (tenant_id, kind, subject_ref)
         values ($1, 'overdue_visit_gap', 'nudge-bt-1')`,
        [tenantId],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // Other kinds keep their open-only semantics — same subject, closed row,
    // fresh open row is fine.
    await pg.query(
      `insert into review_items (tenant_id, kind, subject_ref, status, resolution, resolved_at)
       values ($1, 'call_action', 'nudge-bt-2', 'resolved', 'closed once', now())`,
      [tenantId],
    );
    await pg.query(
      `insert into review_items (tenant_id, kind, subject_ref)
       values ($1, 'call_action', 'nudge-bt-2')`,
      [tenantId],
    );
  });
});
