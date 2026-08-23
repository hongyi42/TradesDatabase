import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createTenant } from '../db/tenants.js';
import { insertTechnician } from '../db/technicians.js';
import { runGapSummaries, HOLDBACK_DAYS } from './summarize.js';

// ⑤ Phase 2 against the real local stack: the sweep summarizes gaps a test
// CLOSED itself (the seed has no closed nudges — review find 11a), with
// explicit timestamps via pg. Assertions are row-scoped by nudge id: the
// lister is tenant-global and other suites share the stack.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
const TZ = 'America/Los_Angeles';
const RUN = Date.now().toString(36);
const NOW = '2026-08-24T18:00:00Z';

let tenantId: string;
let techId: string;

async function insertClosedNudge(over: Record<string, unknown>): Promise<string> {
  const { rows } = await pg.query(
    `insert into nudges (tenant_id, technician_id, kind, subject_ref, status, context,
                         asked_at, resolved_at, resolution, answered_by_capture_id, escalate_after)
     values ($1, $2, 'overdue_visit_gap', $3, $4, $5::jsonb, $6, $7, $8, null, $9)
     returning id`,
    [
      tenantId,
      techId,
      over.subjectRef,
      over.status,
      JSON.stringify(over.context ?? {}),
      over.askedAt ?? null,
      over.resolvedAt ?? null,
      over.resolution ?? null,
      over.escalateAfter ?? null,
    ],
  );
  return rows[0].id;
}

async function insertDecision(nudgeId: string, action: string, decidedAt: string): Promise<void> {
  await pg.query(
    `insert into nudge_decisions (tenant_id, nudge_id, decided_at, mode, action, confidence,
                                  reason, outcome)
     values ($1, $2, $3, 'live', $4, 'high', 'test', 'applied')`,
    [tenantId, nudgeId, decidedAt, action],
  );
}

const summaryFor = async (nudgeId: string) =>
  (await pg.query(`select * from gap_summaries where nudge_id = $1`, [nudgeId])).rows;

beforeAll(async () => {
  await pg.connect();
  tenantId = (await createTenant(`summarize-tenant-${RUN}`, { managerSeats: 1 })).id;
  await pg.query(`update tenants set timezone = $1 where id = $2`, [TZ, tenantId]);
  techId = (
    await insertTechnician({
      tenantId,
      ref: `summarize-tech-${RUN}`,
      displayName: 'Summarize Tech',
      seatExempt: true,
    })
  ).id;
});

afterAll(async () => {
  await pg.query(`delete from nudges where tenant_id = $1`, [tenantId]); // summaries cascade
  await pg.query(`delete from review_items where tenant_id = $1`, [tenantId]);
  await pg.query(`delete from technicians where tenant_id = $1`, [tenantId]);
  await pg.query(`delete from tenants where id = $1`, [tenantId]);
  await pg.end();
});

describe('runGapSummaries', () => {
  test('an answered gap with a known arc produces the exact expected row', async () => {
    const nudgeId = await insertClosedNudge({
      subjectRef: `sum-answered-${RUN}`,
      status: 'answered',
      context: { customerName: 'Henderson', jobTitle: 'Furnace tune-up', jobId: null },
      askedAt: '2026-08-24T17:00:00Z', // 10:00 PDT
      resolvedAt: '2026-08-24T19:00:00Z', // 12:00 PDT → 2 working hours
      resolution: 'a field report arrived — the gap filled itself',
    });
    await insertDecision(nudgeId, 'leave', '2026-08-24T17:30:00Z');
    await insertDecision(nudgeId, 'unmentioned', '2026-08-24T18:00:00Z');
    await insertDecision(nudgeId, 'close', '2026-08-24T18:30:00Z');

    await runGapSummaries(NOW);
    const rows = await summaryFor(nudgeId);
    expect(rows).toHaveLength(1);
    const s = rows[0];
    expect(s.subject).toBe('Henderson — Furnace tune-up');
    expect(s.status).toBe('answered');
    expect(Number(s.working_hours_open)).toBeCloseTo(2, 2);
    expect(s.arc).toEqual({ leave: 1, unmentioned: 1, close: 1 });
    expect(s.considered).toBe(3);
    expect(s.escalated).toBe(false);
    expect(s.manager_fate).toBe('none');
  });

  test('idempotence: a second run writes nothing for the same gap', async () => {
    const nudgeId = await insertClosedNudge({
      subjectRef: `sum-idem-${RUN}`,
      status: 'cancelled',
      askedAt: '2026-08-24T17:00:00Z',
      resolvedAt: '2026-08-24T18:00:00Z',
    });
    await runGapSummaries(NOW);
    await runGapSummaries(NOW);
    expect(await summaryFor(nudgeId)).toHaveLength(1);
  });

  test('a gap closed with no decisions still summarizes (considered 0, empty arc)', async () => {
    const nudgeId = await insertClosedNudge({
      subjectRef: `sum-bare-${RUN}`,
      status: 'failed',
      resolvedAt: '2026-08-24T18:00:00Z',
      resolution: 'delivery failed 3x',
    });
    await runGapSummaries(NOW);
    const rows = await summaryFor(nudgeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].arc).toEqual({});
    expect(rows[0].considered).toBe(0);
    expect(rows[0].subject).toBe(`sum-bare-${RUN}`); // no context names → subject_ref
  });

  test('escalation holdback: an OPEN item defers the summary; resolution completes it', async () => {
    const nudgeId = await insertClosedNudge({
      subjectRef: `sum-holdback-${RUN}`,
      status: 'escalated',
      askedAt: '2026-08-24T15:00:00Z',
      resolvedAt: '2026-08-24T16:00:00Z', // 9:00 PDT
      resolution: 'no reply — handed to the manager',
    });
    await pg.query(
      `insert into review_items (tenant_id, kind, subject_ref, status, suggestion, detail, created_at)
       values ($1, 'overdue_visit_gap', $2, 'open', 'chase it',
               jsonb_build_object('escalatedFromNudge', $3::text), '2026-08-24T16:00:00Z')`,
      [tenantId, `sum-holdback-item-${RUN}`, nudgeId],
    );

    const first = await runGapSummaries(NOW);
    expect(await summaryFor(nudgeId)).toHaveLength(0); // held back
    expect(first.heldBack).toBeGreaterThanOrEqual(1);

    await pg.query(
      `update review_items set status = 'dismissed', resolution = 'premature — tech answers Mondays',
              resolved_at = '2026-08-24T18:00:00Z'
        where tenant_id = $1 and detail->>'escalatedFromNudge' = $2`,
      [tenantId, nudgeId],
    );
    await runGapSummaries(NOW);
    const rows = await summaryFor(nudgeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].manager_fate).toBe('dismissed');
    expect(rows[0].manager_resolution).toBe('premature — tech answers Mondays');
    expect(Number(rows[0].manager_latency_wh)).toBeCloseTo(2, 2); // 9-11am PDT
    expect(rows[0].escalated).toBe(true);
  });

  test('the holdback times out: still-open past the window writes still_open', async () => {
    const closedAt = new Date(Date.parse(NOW) - (HOLDBACK_DAYS + 1) * 24 * 3_600_000).toISOString();
    const nudgeId = await insertClosedNudge({
      subjectRef: `sum-stale-${RUN}`,
      status: 'escalated',
      askedAt: closedAt,
      resolvedAt: closedAt,
    });
    await pg.query(
      `insert into review_items (tenant_id, kind, subject_ref, status, suggestion, detail, created_at)
       values ($1, 'overdue_visit_gap', $2, 'open', 'chase it',
               jsonb_build_object('escalatedFromNudge', $3::text), $4)`,
      [tenantId, `sum-stale-item-${RUN}`, nudgeId, closedAt],
    );
    await runGapSummaries(NOW);
    const rows = await summaryFor(nudgeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].manager_fate).toBe('still_open');
  });
});
