import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTenant } from './tenants.js';
import { insertTechnician } from './technicians.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';
import { workingHoursBetween } from '../jobs/workingHours.js';

// ⑤ Phase 1: the metrics views asserted against the real database — fixtures
// with EXPLICIT timestamps (pg-direct: the accessors stamp now(), and these
// tests are entirely about time math), plus the ACL posture and the SQL↔TS
// working-hours parity the plan pins.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
const TZ = 'America/Los_Angeles';
// Unique per run: subject_ref is once-EVER unique and the local stack persists
// between suite runs.
const RUN = Date.now().toString(36);

let tenantId: string;
let techId: string;
let jobId: string;
const nudgeIds: string[] = [];

async function insertNudge(over: Record<string, unknown>): Promise<string> {
  const { rows } = await pg.query(
    `insert into nudges (tenant_id, technician_id, kind, subject_ref, status, context,
                         asked_at, resolved_at, escalate_after, resolution)
     values ($1, $2, 'overdue_visit_gap', $3, $4, '{}'::jsonb, $5, $6, $7, $8)
     returning id`,
    [
      tenantId,
      techId,
      over.subjectRef,
      over.status,
      over.askedAt ?? null,
      over.resolvedAt ?? null,
      over.escalateAfter ?? null,
      over.resolution ?? null,
    ],
  );
  nudgeIds.push(rows[0].id);
  return rows[0].id;
}

async function insertDecision(
  nudgeId: string,
  jobId: string | null,
  action: string,
  decidedAt: string,
  over: Record<string, unknown> = {},
): Promise<void> {
  await pg.query(
    `insert into nudge_decisions (tenant_id, nudge_id, job_id, decided_at, mode, action,
                                  confidence, reason, outcome, escalate_after)
     values ($1, $2, $3, $4, 'live', $5, 'high', 'test', $6, $7)`,
    [tenantId, nudgeId, jobId, decidedAt, action, over.outcome ?? 'applied', over.escalateAfter ?? null],
  );
}

beforeAll(async () => {
  await pg.connect();
  tenantId = (await createTenant(`metrics-tenant-${RUN}`, { managerSeats: 1 })).id;
  await pg.query(`update tenants set timezone = $1 where id = $2`, [TZ, tenantId]);
  techId = (
    await insertTechnician({
      tenantId,
      ref: 'metrics-tech',
      displayName: 'Metrics Tech',
      seatExempt: true,
    })
  ).id;
  const customer = await createCustomer({ tenantId, name: 'Metrics Customer' });
  jobId = (await createJob({ tenantId, customerId: customer.id, title: 'Metrics Job' })).id;
});

afterAll(async () => {
  // The capture fixture makes this tenant PERMANENTLY undeletable (L1 is
  // append-only — delete is trigger-refused, and the FK chain pins job,
  // customer and tenant; the recorded doctrine applies to test fixtures too).
  // Clean what can be cleaned; unique-per-run refs keep reruns collision-free
  // on a stack that persists between suite runs.
  await pg.query(`delete from nudges where tenant_id = $1`, [tenantId]);
  await pg.query(`delete from review_items where tenant_id = $1`, [tenantId]);
  await pg.end();
});

describe('working_hours_between — SQL and TS agree (the pinned definition)', () => {
  const CASES: Array<[string, string, number]> = [
    // 10:00 → 13:00 PDT, same day: 3h inside the window.
    ['2026-08-20T17:00:00Z', '2026-08-20T20:00:00Z', 3],
    // 5pm → 9am next day PDT: 2h (17-19) + 2h (7-9).
    ['2026-08-21T00:00:00Z', '2026-08-21T16:00:00Z', 4],
    // Entirely before the window opens: 0.
    ['2026-08-20T09:00:00Z', '2026-08-20T13:00:00Z', 0],
    // Half-hour granularity: 10:00 → 10:30 = 0.5.
    ['2026-08-20T17:00:00Z', '2026-08-20T17:30:00Z', 0.5],
    // Odd seconds straddling the window's opening edge: 06:59:30 → 07:30 PDT
    // = exactly 0.5 (the wall-clock-aligned grid, review find 6).
    ['2026-08-20T13:59:30Z', '2026-08-20T14:30:00Z', 0.5],
    // Across the 2026-11-01 fall-back day (America/Los_Angeles): the range
    // starts 5am PST (already past the 09:00Z fall-back) and ends 8pm PST;
    // the repeated 1-2am hour lies OUTSIDE the window, so the day contributes
    // exactly its full 12 working hours in BOTH implementations.
    ['2026-11-01T13:00:00Z', '2026-11-02T04:00:00Z', 12],
  ];
  test.each(CASES)('%s → %s = %sh, both implementations', async (from, to, hours) => {
    const { rows } = await pg.query(
      `select working_hours_between($1::timestamptz, $2::timestamptz, $3) as wh`,
      [from, to, TZ],
    );
    expect(Number(rows[0].wh)).toBeCloseTo(hours, 2);
    expect(workingHoursBetween(from, to, TZ)).toBeCloseTo(hours, 2);
  });

  test('null / inverted ranges are null in both', async () => {
    const { rows } = await pg.query(
      `select working_hours_between('2026-08-20T20:00:00Z'::timestamptz,
                                    '2026-08-20T17:00:00Z'::timestamptz, $1) as wh`,
      [TZ],
    );
    expect(rows[0].wh).toBeNull();
    expect(workingHoursBetween('2026-08-20T20:00:00Z', '2026-08-20T17:00:00Z', TZ)).toBeNull();
    expect(workingHoursBetween(null, '2026-08-20T17:00:00Z', TZ)).toBeNull();
  });
});

describe('mv_escalation_fates', () => {
  test('a sweep escalation whose item resolved within 12 working hours is premature', async () => {
    const nudgeId = await insertNudge({
      subjectRef: `metrics-premature-${RUN}`,
      status: 'escalated',
      askedAt: '2026-08-20T17:00:00Z',
      resolvedAt: '2026-08-20T18:00:00Z', // 11:00 PDT
      resolution: 'no reply — handed to the manager',
    });
    await pg.query(
      `insert into review_items (tenant_id, kind, subject_ref, status, suggestion, detail,
                                 resolution, created_at, resolved_at)
       values ($1, 'overdue_visit_gap', $3, 'resolved', 'check it',
               jsonb_build_object('escalatedFromNudge', $2::text),
               'field report arrived after this was flagged',
               '2026-08-20T18:00:00Z', '2026-08-20T20:00:00Z')`, // 13:00 PDT → 2 wh later
      [tenantId, nudgeId, `metrics-premature-item-${RUN}`],
    );
    const { rows } = await pg.query(
      `select fate, premature, late, by_planner, working_hours_to_fate
         from mv_escalation_fates where nudge_id = $1`,
      [nudgeId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].fate).toBe('resolved');
    expect(rows[0].premature).toBe(true);
    expect(rows[0].by_planner).toBe(false); // sweep-escalated: no decision row
    expect(Number(rows[0].working_hours_to_fate)).toBeCloseTo(2, 2);
  });

  test('an escalation with no item and no fate is neither premature nor resolved', async () => {
    const nudgeId = await insertNudge({
      subjectRef: `metrics-noitem-${RUN}`,
      status: 'escalated',
      askedAt: '2026-08-20T17:00:00Z',
      resolvedAt: '2026-08-20T18:00:00Z',
    });
    const { rows } = await pg.query(
      `select fate, premature from mv_escalation_fates where nudge_id = $1`,
      [nudgeId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].fate).toBe('no_item');
    expect(rows[0].premature).toBe(false);
  });
});

describe('mv_whiplash', () => {

  test('a verb flip with no evidence between is a whiplash pair', async () => {
    const nudgeId = await insertNudge({ subjectRef: `metrics-whiplash-${RUN}`, status: 'asked' });
    await insertDecision(nudgeId, jobId, 'hold', '2026-08-20T17:00:00Z');
    await insertDecision(nudgeId, jobId, 'escalate', '2026-08-20T18:30:00Z');
    const { rows } = await pg.query(`select * from mv_whiplash where nudge_id = $1`, [nudgeId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].prev_action).toBe('hold');
    expect(rows[0].action).toBe('escalate');
    expect(Number(rows[0].hours_between)).toBeCloseTo(1.5, 2);
  });

  test('the same flip WITH evidence between it is not whiplash', async () => {
    const nudgeId = await insertNudge({ subjectRef: `metrics-evidence-${RUN}`, status: 'asked' });
    await insertDecision(nudgeId, jobId, 'hold', '2026-08-21T17:00:00Z');
    await pg.query(
      `insert into raw_captures (tenant_id, channel, raw_text, captured_at, job_id)
       values ($1, 'technician_note', 'went fine', '2026-08-21T17:30:00Z', $2)`,
      [tenantId, jobId],
    );
    await insertDecision(nudgeId, jobId, 'escalate', '2026-08-21T18:30:00Z');
    const { rows } = await pg.query(`select * from mv_whiplash where nudge_id = $1`, [nudgeId]);
    expect(rows).toEqual([]);
  });

  test("'leave' and 'unmentioned' are not flip material", async () => {
    const nudgeId = await insertNudge({ subjectRef: `metrics-leave-${RUN}`, status: 'asked' });
    await insertDecision(nudgeId, jobId, 'leave', '2026-08-22T17:00:00Z');
    await insertDecision(nudgeId, jobId, 'unmentioned', '2026-08-22T17:30:00Z');
    await insertDecision(nudgeId, jobId, 'escalate', '2026-08-22T18:00:00Z');
    const { rows } = await pg.query(`select * from mv_whiplash where nudge_id = $1`, [nudgeId]);
    expect(rows).toEqual([]);
  });
});

describe('mv_gap_outcomes', () => {
  test('answered-with-stamp buckets answered/closed_by_technician; failed-with-item buckets manager', async () => {
    const answeredId = await insertNudge({
      subjectRef: `metrics-outcome-a-${RUN}`,
      status: 'answered',
      askedAt: '2026-08-20T17:00:00Z',
      resolvedAt: '2026-08-20T19:00:00Z',
    });
    // The attribution stamp needs a real capture (FK) — reuse the fixture job.
    const cap = await pg.query(
      `insert into raw_captures (tenant_id, channel, raw_text, captured_at, job_id)
       values ($1, 'technician_note', 'done', '2026-08-20T18:00:00Z', $2) returning id`,
      [tenantId, jobId],
    );
    await pg.query(`update nudges set answered_by_capture_id = $1 where id = $2`, [
      cap.rows[0].id,
      answeredId,
    ]);
    const failedId = await insertNudge({
      subjectRef: `metrics-outcome-f-${RUN}`,
      status: 'failed',
      askedAt: '2026-08-20T17:00:00Z',
      resolvedAt: '2026-08-21T17:00:00Z',
      resolution: 'never delivered — handed to the manager',
    });
    await pg.query(
      `insert into review_items (tenant_id, kind, subject_ref, status, suggestion, detail, created_at)
       values ($1, 'overdue_visit_gap', $2, 'open', 'chase',
               jsonb_build_object('escalatedFromNudge', $3::text), '2026-08-21T17:00:00Z')`,
      [tenantId, `metrics-outcome-f-item-${RUN}`, failedId],
    );
    const { rows } = await pg.query(
      `select nudge_id, outcome_bucket, closed_by_technician, working_hours_open
         from mv_gap_outcomes where nudge_id = any($1)`,
      [[answeredId, failedId]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.nudge_id, r]));
    expect(byId[answeredId].outcome_bucket).toBe('answered');
    expect(byId[answeredId].closed_by_technician).toBe(true);
    expect(Number(byId[answeredId].working_hours_open)).toBeCloseTo(2, 2);
    // The expiry-path handoff is a MANAGER outcome, not 'abandoned' (review find 2).
    expect(byId[failedId].outcome_bucket).toBe('manager');
    // ...and it appears in the fates view with its handoff kind.
    const fates = await pg.query(
      `select fate, handoff_kind from mv_escalation_fates where nudge_id = $1`,
      [failedId],
    );
    expect(fates.rows).toHaveLength(1);
    expect(fates.rows[0].handoff_kind).toBe('failed');
    expect(fates.rows[0].fate).toBe('still_open');
  });

  test('late fires against the ORIGINAL 24h allowance, doubled', async () => {
    const lateId = await insertNudge({
      subjectRef: `metrics-late-${RUN}`,
      status: 'escalated',
      askedAt: '2026-08-17T17:00:00Z',
      resolvedAt: '2026-08-20T17:00:00Z', // 72h after the ask > 48h
    });
    const { rows } = await pg.query(
      `select late from mv_escalation_fates where nudge_id = $1`,
      [lateId],
    );
    expect(rows[0].late).toBe(true);
  });
});

describe('mv_extend_effectiveness', () => {
  test('answered-in-time true; a future-deadline open extend is pending', async () => {
    const okId = await insertNudge({
      subjectRef: `metrics-ext-ok-${RUN}`,
      status: 'answered',
      askedAt: '2026-08-20T15:00:00Z',
      resolvedAt: '2026-08-20T18:00:00Z',
    });
    await insertDecision(okId, jobId, 'extend', '2026-08-20T16:00:00Z', {
      escalateAfter: '2026-08-21T16:00:00Z',
    });
    const pendId = await insertNudge({ subjectRef: `metrics-ext-pend-${RUN}`, status: 'asked' });
    await insertDecision(pendId, jobId, 'extend', '2026-08-20T16:00:00Z', {
      escalateAfter: '2126-01-01T00:00:00Z', // far future — stays pending
    });
    const { rows } = await pg.query(
      `select nudge_id, answered_in_time, pending from mv_extend_effectiveness
        where nudge_id = any($1)`,
      [[okId, pendId]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.nudge_id, r]));
    expect(byId[okId].answered_in_time).toBe(true);
    expect(byId[okId].pending).toBe(false);
    expect(byId[pendId].answered_in_time).toBe(false);
    expect(byId[pendId].pending).toBe(true);
  });
});

describe('ACL posture — the revokes are the mechanism', () => {
  test('anon and authenticated cannot SELECT any metrics view or run the function', async () => {
    const { rows } = await pg.query(`
      select viewname,
             has_table_privilege('anon', 'public.' || viewname, 'SELECT') as anon_sel,
             has_table_privilege('authenticated', 'public.' || viewname, 'SELECT') as auth_sel
        from pg_views
       where viewname in ('mv_gap_outcomes','mv_escalation_fates','mv_whiplash',
                          'mv_extend_effectiveness')`);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.anon_sel || r.auth_sel)).toEqual([]);
    const fn = await pg.query(`
      select has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x
        from pg_proc p where p.proname = 'working_hours_between'`);
    expect(fn.rows).toHaveLength(1);
    expect(fn.rows[0].anon_x).toBe(false);
    expect(fn.rows[0].auth_x).toBe(false);
  });
});

describe('the report script', () => {
  test('runs against the local stack and prints the paired sections', async () => {
    const { stdout } = await promisify(execFile)('node', ['scripts/planner-metrics/report.mjs'], {
      env: { ...process.env },
    });
    expect(stdout).toContain('Planner baseline metrics');
    expect(stdout).toContain('Escalation judgment');
    expect(stdout).toContain('Whiplash');
    expect(stdout).toContain('NOT a benchmark');
  });
});
