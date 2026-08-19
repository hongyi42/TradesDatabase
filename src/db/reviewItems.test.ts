import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  flagNudgeGap,
  flagOverdueVisitGap,
  openCallActionReview,
  reviewItemExistsFor,
  resolveReviewItem,
} from './reviewItems.js';
import { createTenant } from './tenants.js';

// Integration test against the LOCAL stack (testEnvGuard enforces local-only).
// Exercises the call_action review helper's write + the one-open-per-call dedup
// that the worker relies on across retries.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let tenantB: string | undefined;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  await pg.query('truncate table review_items cascade');
  // After the truncate, tenant B has no children left — the row deletes clean.
  if (tenantB) await pg.query('delete from tenants where id = $1', [tenantB]);
  await pg.end();
});

describe('openCallActionReview', () => {
  test('writes a call_action row carrying the intent list in detail', async () => {
    const captureId = 'cap-call-action-1';
    const item = await openCallActionReview({
      tenantId,
      captureId,
      intents: ['cancel'],
      priority: 'normal',
      callerPhone: '+15551230001',
      snippet: 'please cancel my Tuesday appointment',
    });

    expect(item.kind).toBe('call_action');
    expect(item.subject_ref).toBe(captureId);
    expect(item.status).toBe('open');
    expect(item.suggestion).toBe('+15551230001'); // caller number for callback

    // Cross-check the persisted detail via direct pg.
    const row = await pg.query<{ detail: { intents?: string[]; priority?: string } }>(
      'select detail from review_items where id = $1',
      [item.id],
    );
    expect(row.rows[0].detail.intents).toEqual(['cancel']);
    expect(row.rows[0].detail.priority).toBe('normal');
  });

  test('a second call on the same captureId returns the SAME open row (dedup by captureId)', async () => {
    const captureId = 'cap-call-action-dedup';
    const first = await openCallActionReview({ tenantId, captureId, intents: ['cancel'] });
    // Different intents on the retry — still one review per call (the partial
    // unique index resolves to the existing open row rather than a second one).
    const second = await openCallActionReview({
      tenantId,
      captureId,
      intents: ['cancel', 'complaint'],
      priority: 'high',
    });

    expect(second.id).toBe(first.id); // same open row, not a duplicate

    const count = await pg.query<{ n: string }>(
      "select count(*)::int as n from review_items where tenant_id = $1 and kind = 'call_action' and subject_ref = $2 and status = 'open'",
      [tenantId, captureId],
    );
    expect(Number(count.rows[0].n)).toBe(1); // exactly one open call_action for this call
  });
});

// Stage-0 watcher flag (plan 2026-08-15 feature A): once per assignment, EVER —
// the dedup must hold across status changes, not just while the item is open.
describe('flagOverdueVisitGap', () => {
  const GAP = {
    jobId: 'job-watch-1',
    technicianRef: 'ben-shelton',
    startsAtLocal: '2026-08-10T15:00:00.000Z',
    endsAtLocal: '2026-08-10T16:00:00.000Z',
    suggestion: "Visit for 'Furnace' (Casa) scheduled to end … has no field report",
  };

  test('first flag opens; detail carries jobId/technicianRef/endsAtLocal', async () => {
    const item = await flagOverdueVisitGap({ tenantId, assignmentId: 'asg-watch-1', ...GAP });
    expect(item).not.toBeNull();
    expect(item?.kind).toBe('overdue_visit_gap');
    expect(item?.subject_ref).toBe('asg-watch-1');
    expect(item?.status).toBe('open');
    expect(item?.suggestion).toBe(GAP.suggestion);

    const row = await pg.query<{ detail: Record<string, unknown> }>(
      'select detail from review_items where id = $1',
      [item!.id],
    );
    expect(row.rows[0].detail).toEqual({
      jobId: GAP.jobId,
      technicianRef: GAP.technicianRef,
      startsAtLocal: GAP.startsAtLocal,
      endsAtLocal: GAP.endsAtLocal,
    });
  });

  test('second flag on the same assignment returns null (not a second row)', async () => {
    expect(await flagOverdueVisitGap({ tenantId, assignmentId: 'asg-watch-1', ...GAP })).toBeNull();
    const count = await pg.query<{ n: number }>(
      "select count(*)::int as n from review_items where tenant_id = $1 and kind = 'overdue_visit_gap' and subject_ref = 'asg-watch-1'",
      [tenantId],
    );
    expect(count.rows[0].n).toBe(1);
  });

  test('dedup holds ACROSS status: resolve, then re-flag → null (never re-opens)', async () => {
    const item = await flagOverdueVisitGap({ tenantId, assignmentId: 'asg-watch-2', ...GAP });
    expect(item).not.toBeNull();
    await resolveReviewItem(item!.id, tenantId, 'resolved', 'field report arrived');
    expect(await flagOverdueVisitGap({ tenantId, assignmentId: 'asg-watch-2', ...GAP })).toBeNull();
    const open = await pg.query<{ n: number }>(
      "select count(*)::int as n from review_items where tenant_id = $1 and kind = 'overdue_visit_gap' and subject_ref = 'asg-watch-2' and status = 'open'",
      [tenantId],
    );
    expect(open.rows[0].n).toBe(0); // the resolved item stayed closed
  });

  test('the dedup is tenant-scoped: tenant B flags the SAME assignment id independently', async () => {
    tenantB = (await createTenant(`ri-tenant-b-${Date.now()}`)).id;
    // Tenant A flagged 'asg-watch-1' above — that must never suppress B's flag.
    const item = await flagOverdueVisitGap({ tenantId: tenantB, assignmentId: 'asg-watch-1', ...GAP });
    expect(item).not.toBeNull();
    expect(item?.tenant_id).toBe(tenantB);
  });
});

describe('flagNudgeGap — the kind-generic flagger (plan 2026-08-19 Phase 4)', () => {
  test('a JOB-scoped gap flags with no visit window, and detail omits the keys entirely', async () => {
    // A cost gap has no startsAtLocal/endsAtLocal. They must be ABSENT from
    // detail, not stored as nulls — the open-gap reader fail-closes on
    // malformed detail, and a null there would read as malformed.
    const item = await flagNudgeGap({
      tenantId,
      kind: 'job_cost_gap',
      subjectRef: 'job-cost-1',
      jobId: 'job-cost-1',
      technicianRef: 'ben-shelton',
      suggestion: 'What did this job cost in parts?',
    });
    expect(item).not.toBeNull();
    const row = await pg.query<{ detail: Record<string, unknown>; kind: string }>(
      'select kind, detail from review_items where id = $1',
      [item!.id],
    );
    expect(row.rows[0].kind).toBe('job_cost_gap');
    expect(row.rows[0].detail).toEqual({ jobId: 'job-cost-1', technicianRef: 'ben-shelton' });
    expect('startsAtLocal' in row.rows[0].detail).toBe(false);
    expect('endsAtLocal' in row.rows[0].detail).toBe(false);
  });

  test('once-ever holds per KIND, and the DB index is the backstop', async () => {
    // App-level dedup: a second flag on the same job returns null.
    expect(
      await flagNudgeGap({
        tenantId,
        kind: 'job_cost_gap',
        subjectRef: 'job-cost-1',
        jobId: 'job-cost-1',
        technicianRef: null,
        suggestion: 'again',
      }),
    ).toBeNull();
    // And the DB refuses it even if the app guard is bypassed — the race loses
    // loudly instead of double-flagging.
    await expect(
      pg.query(
        `insert into review_items (tenant_id, kind, subject_ref, suggestion)
         values ($1, 'job_cost_gap', 'job-cost-1', 'bypass')`,
        [tenantId],
      ),
    ).rejects.toThrow(/uq_review_items_job_cost_gap_ever|duplicate key/);
  });

  test('the two kinds do not collide on the same subject id', async () => {
    // Subject namespaces differ per kind (assignment vs job), so the same
    // string under a different kind is a different gap.
    const visit = await flagOverdueVisitGap({
      tenantId,
      assignmentId: 'job-cost-1',
      jobId: 'job-watch-1',
      technicianRef: 'ben-shelton',
      startsAtLocal: '2026-08-10T15:00:00.000Z',
      endsAtLocal: '2026-08-10T16:00:00.000Z',
      suggestion: 'visit copy',
    });
    expect(visit).not.toBeNull();
    expect(visit?.kind).toBe('overdue_visit_gap');
  });

  test('reviewItemExistsFor distinguishes "already flagged" from "nothing there"', async () => {
    // This is what lets the terminal-failure doctrine tell a dedup-null from a
    // failed handoff.
    expect(await reviewItemExistsFor(tenantId, 'job_cost_gap', 'job-cost-1')).toBe(true);
    expect(await reviewItemExistsFor(tenantId, 'job_cost_gap', 'job-never-seen')).toBe(false);
    // Kind-scoped and tenant-scoped.
    expect(await reviewItemExistsFor(tenantId, 'unlinked_call', 'job-cost-1')).toBe(false);
  });
});
