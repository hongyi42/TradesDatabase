import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createPendingNudge } from './nudges.js';
import {
  listDecisionsForJob,
  listDecisionsForNudge,
  listDecisionsForNudges,
  recordNudgeDecisions,
} from './nudgeDecisions.js';

// Integration test against the LOCAL stack (testEnvGuard enforces local-only).
//
// The split this file exists to pin (plan 2026-08-22, Phase 3): the batched
// per-tick read KEEPS the `unmentioned` tick marks, because the consideration
// COUNT is what the pushed history line is made of; the two `recall_decisions`
// lookups DROP them, because a planner asking to read its history wants the
// decisions and 200 rows of "said nothing" would bury the four that matter.
//
// Neither half had any test at all before this — the filters could be deleted
// and the suite would stay green.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let techId: string;
let nudgeA: string;
let nudgeB: string;
const JOB = '55555555-5555-4555-8555-555555555555';

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').order('created_at', { ascending: true }).limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  await pg.query('truncate table nudge_decisions cascade');
  await pg.query("delete from nudges where subject_ref like 'nd-test-%'");
  const tech = await pg.query<{ id: string }>(
    `insert into technicians (tenant_id, ref, display_name, tier, state, seat_exempt)
     values ($1, 'nd-test-tech', 'ND Test Tech', 'technician', 'active', true)
     on conflict (tenant_id, ref) do update set display_name = excluded.display_name
     returning id`,
    [tenantId],
  );
  techId = tech.rows[0].id;
  const mk = async (subjectRef: string) => {
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef,
      technicianId: techId,
      context: { jobId: JOB },
    });
    if (!n) throw new Error('fixture nudge was not created');
    return n.id;
  };
  nudgeA = await mk('nd-test-a');
  nudgeB = await mk('nd-test-b');

  // One real decision on A, then filler on both — the shape a live tick leaves.
  await recordNudgeDecisions([
    {
      tenantId,
      nudgeId: nudgeA,
      jobId: JOB,
      mode: 'live',
      action: 'escalate',
      confidence: 'high',
      reason: 'nobody answered',
      outcome: 'applied',
    },
  ]);
  await recordNudgeDecisions([
    ...Array.from({ length: 5 }, () => ({
      tenantId,
      nudgeId: nudgeA,
      jobId: JOB,
      mode: 'live' as const,
      action: 'unmentioned',
      confidence: 'low' as const,
      reason: '',
      outcome: 'applied' as const,
    })),
    ...Array.from({ length: 3 }, () => ({
      tenantId,
      nudgeId: nudgeB,
      jobId: JOB,
      mode: 'live' as const,
      action: 'unmentioned',
      confidence: 'low' as const,
      reason: '',
      outcome: 'applied' as const,
    })),
  ]);
});

afterAll(async () => {
  await pg.query('truncate table nudge_decisions cascade');
  await pg.query("delete from nudges where subject_ref like 'nd-test-%'");
  await pg.query('delete from technicians where id = $1', [techId]);
  await pg.end();
});

describe('the per-tick read KEEPS the tick marks — the count is the point', () => {
  test('every row comes back, filler included, oldest first', async () => {
    const map = await listDecisionsForNudges(tenantId, [nudgeA, nudgeB]);
    expect(map.get(nudgeA)).toHaveLength(6); // 1 real + 5 filler
    expect(map.get(nudgeB)).toHaveLength(3);
    // Oldest first — historyLine reads history[0] as "watched since".
    expect(map.get(nudgeA)![0].action).toBe('escalate');
  });

  test('a gap with ONLY filler still reports a history — that is the whole phase', async () => {
    // Before this, a gap the planner considered every tick and never acted on
    // was indistinguishable from one it had never seen: both read as zero rows.
    const map = await listDecisionsForNudges(tenantId, [nudgeB]);
    expect(map.get(nudgeB)).toHaveLength(3);
    expect(map.get(nudgeB)!.every((d) => d.action === 'unmentioned')).toBe(true);
  });

  test('another tenant sees none of it', async () => {
    const map = await listDecisionsForNudges('00000000-0000-0000-0000-0000000000ff', [nudgeA]);
    expect(map.size).toBe(0);
  });
});

describe('recall_decisions DROPS the tick marks', () => {
  test('the per-gap lookup returns only real decisions', async () => {
    const rows = await listDecisionsForNudge(tenantId, nudgeA);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('escalate');
  });

  test('a gap the planner only LOOKED at comes back empty, not full of noise', async () => {
    // What the planner is told when this happens: "you have not decided about
    // this before" — true, and the consideration count is already on its block.
    expect(await listDecisionsForNudge(tenantId, nudgeB)).toEqual([]);
  });

  test('the per-JOB lookup drops them too — the whole story of one job, decisions only', async () => {
    const rows = await listDecisionsForJob(tenantId, JOB);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('escalate');
  });

  test('the limit is spent on decisions, never on filler', async () => {
    // The failure the filter prevents: 8 rows exist on this job, 7 of them
    // filler. A limit of 3 without the filter would return three tick marks and
    // hide the escalation entirely.
    const rows = await listDecisionsForJob(tenantId, JOB, 3);
    expect(rows.map((r) => r.action)).toEqual(['escalate']);
  });
});
