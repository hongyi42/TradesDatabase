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
  setNudgeSchedule,
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
    // on an asked row it must write NOTHING (the 24h escalation owns it now).
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

// ── setNudgeSchedule: the planner's only write onto a nudge (Phase 2) ───────
describe('setNudgeSchedule', () => {
  const openRow = async (subjectRef: string) => {
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef,
      technicianId: techId,
      context: { jobId: 'j-sched' },
    });
    if (!n) throw new Error('fixture nudge was not created');
    return n;
  };

  test('stamps both columns, and an unstamped row reads null (the code default)', async () => {
    const n = await openRow('asg-sched-1');
    expect(n.not_before).toBeNull();
    expect(n.escalate_after).toBeNull();

    const updated = await setNudgeSchedule(n.id, tenantId, {
      notBefore: '2026-08-20T15:00:00.000Z',
      escalateAfter: '2026-08-21T15:00:00.000Z',
    });
    expect(updated?.not_before).toBe('2026-08-20T15:00:00+00:00');
    expect(updated?.escalate_after).toBe('2026-08-21T15:00:00+00:00');
  });

  test('an omitted key is LEFT ALONE; an explicit null CLEARS it', async () => {
    // The distinction is load-bearing: "no opinion this tick" and "forget what I
    // said last tick" are different instructions from the planner.
    const n = await openRow('asg-sched-2');
    await setNudgeSchedule(n.id, tenantId, {
      notBefore: '2026-08-20T15:00:00.000Z',
      escalateAfter: '2026-08-21T15:00:00.000Z',
    });

    const partial = await setNudgeSchedule(n.id, tenantId, { notBefore: null });
    expect(partial?.not_before).toBeNull();
    expect(partial?.escalate_after).toBe('2026-08-21T15:00:00+00:00'); // untouched
  });

  test('an explicit undefined leaves the column ALONE — the Phase-4 call shape', async () => {
    // The planner spreads a decision object whose fields are optional, so both
    // KEYS arrive with one value undefined. Keying on `in` would read "no opinion
    // about escalation this tick" as "clear it", erasing last tick's deadline.
    const n = await openRow('asg-sched-6');
    await setNudgeSchedule(n.id, tenantId, {
      notBefore: '2026-08-20T15:00:00.000Z',
      escalateAfter: '2026-08-21T15:00:00.000Z',
    });
    const decision: { notBefore?: string | null; escalateAfter?: string | null } = {
      notBefore: '2026-08-22T15:00:00.000Z',
    };
    const after = await setNudgeSchedule(n.id, tenantId, {
      notBefore: decision.notBefore,
      escalateAfter: decision.escalateAfter, // undefined — no opinion, not "clear it"
    });
    expect(after?.not_before).toBe('2026-08-22T15:00:00+00:00');
    expect(after?.escalate_after).toBe('2026-08-21T15:00:00+00:00');
  });

  test('an empty patch is refused where the caller is named, not as a database error', async () => {
    const n = await openRow('asg-sched-3');
    await expect(setNudgeSchedule(n.id, tenantId, {})).rejects.toThrow(/nothing to set/);
  });

  test('a CLOSED row is never re-scheduled — the planner must lose a race it lost', async () => {
    // A planner call takes seconds; a delivery ack or an auto-resolve can land in
    // that window. The write must return null rather than put a deadline back on
    // a gap that is already done.
    const n = await openRow('asg-sched-4');
    await markNudgeOutcome(n.id, tenantId, 'answered', 'a note landed');
    const late = await setNudgeSchedule(n.id, tenantId, {
      escalateAfter: '2026-08-21T15:00:00.000Z',
    });
    expect(late).toBeNull();
    const [row] = await listNudgesByStatus(tenantId, ['answered']).then((rows) =>
      rows.filter((r) => r.subject_ref === 'asg-sched-4'),
    );
    expect(row.escalate_after).toBeNull();
  });

  test('another tenant cannot schedule this row', async () => {
    // A bare non-matching uuid is enough — the guard is the tenant_id predicate,
    // and inventing a second tenant row here would leak one past the cleanup.
    const n = await openRow('asg-sched-5');
    const cross = await setNudgeSchedule(n.id, '00000000-0000-0000-0000-0000000000ff', {
      notBefore: '2026-08-20T15:00:00.000Z',
    });
    expect(cross).toBeNull();
  });
});
