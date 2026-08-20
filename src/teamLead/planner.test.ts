import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { createPendingNudge, listNudgesByStatus } from '../db/nudges.js';
import type { Nudge, Tenant, JobEvidenceRow, RawCapture } from '../db/index.js';
import {
  EVIDENCE_PER_GAP,
  runPlanner,
  validateDecisions,
  type PlannerDeps,
} from './planner.js';
import { SUBMIT_PLAN_TOOL } from './plannerPrompt.js';
import type { ToolLoopResult } from '../model/toolLoop.js';

// NOW is inside the 7am–7pm UTC ask window for a UTC firm.
const NOW = '2026-08-16T12:00:00.000Z';

function nudge(over: Partial<Nudge> = {}): Nudge {
  return {
    id: 'n1',
    tenant_id: 't1',
    kind: 'overdue_visit_gap',
    subject_ref: 'a1',
    technician_id: 'tech-1',
    status: 'asked',
    question: 'How did the Henderson visit go?',
    context: {
      customerName: 'Henderson',
      jobTitle: 'Furnace tune-up',
      technicianRef: 'ben-shelton',
      technicianName: 'Ben Shelton',
      jobId: 'j1',
      startsAtLocal: '2026-08-14T07:00:00.000Z',
      endsAtLocal: '2026-08-14T08:00:00.000Z',
    },
    attempts: 0,
    serve_count: 0,
    actor_ref: 'spine:team-lead',
    resolution: null,
    not_before: null,
    escalate_after: null,
    queued_at: null,
    asked_at: '2026-08-15T12:00:00.000Z',
    resolved_at: null,
    created_at: '2026-08-15T11:00:00.000Z',
    updated_at: '2026-08-15T11:00:00.000Z',
    ...over,
  } as unknown as Nudge;
}

const evidence = (capturedAt: string, text: string, jobId = 'j1'): JobEvidenceRow => ({
  jobId,
  via: 'job_stamp',
  capture: {
    id: `c-${capturedAt}`,
    captured_at: capturedAt,
    channel: 'technician_note',
    technician_ref: 'ben-shelton',
    raw_text: text,
    sensitivity: null,
  } as unknown as RawCapture,
});

// A loop stub that captures the prompt and replays a canned submit_plan call.
function loopReturning(decisions: unknown[], seen: { user?: string } = {}) {
  return (async (
    req: { user: string },
    _tools: unknown,
    execute: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  ): Promise<ToolLoopResult> => {
    seen.user = req.user;
    await execute(SUBMIT_PLAN_TOOL.name, { decisions });
    return { text: '', turns: 1, calls: [] };
  }) as unknown as NonNullable<PlannerDeps['runLoop']>;
}

function baseDeps(over: Partial<PlannerDeps> = {}): PlannerDeps {
  return {
    listTenants: async () => ['t1'],
    getTenant: async () => ({ id: 't1', timezone: 'UTC' }) as unknown as Tenant,
    listNudges: async () => [nudge()],
    listEvidence: async () => [],
    runLoop: loopReturning([]),
    ...over,
  };
}

describe('runPlanner — what it is shown', () => {
  test("evidence is bounded in CODE to what landed AFTER the ask, never at or before it", async () => {
    // The bound is the whole reason the planner cannot mark a gap answered by
    // something that predates the question it is judging.
    const seen: { user?: string } = {};
    await runPlanner(NOW, 'shadow', baseDeps({
      listEvidence: async () => [
        evidence('2026-08-15T11:30:00.000Z', 'BEFORE the ask — a note about something else'),
        evidence('2026-08-15T12:00:00.000Z', 'EXACTLY at the ask — still not an answer'),
        evidence('2026-08-15T12:00:01.000Z', 'AFTER the ask — parts were forty dollars'),
      ],
      runLoop: loopReturning([], seen),
    }));
    expect(seen.user).toContain('AFTER the ask');
    expect(seen.user).not.toContain('BEFORE the ask');
    expect(seen.user).not.toContain('EXACTLY at the ask');
  });

  test('a gap on another job never borrows that job\'s evidence', async () => {
    const seen: { user?: string } = {};
    await runPlanner(NOW, 'shadow', baseDeps({
      listEvidence: async () => [
        evidence('2026-08-15T13:00:00.000Z', 'belongs to a different job', 'j-other'),
      ],
      runLoop: loopReturning([], seen),
    }));
    expect(seen.user).toContain('NOTHING has landed');
    expect(seen.user).not.toContain('different job');
  });

  test('a never-asked gap is shown no evidence at all — there is no question to answer yet', async () => {
    const seen: { user?: string } = {};
    await runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [nudge({ status: 'pending', asked_at: null, question: null })],
      listEvidence: async () => [evidence('2026-08-15T13:00:00.000Z', 'a stray note')],
      runLoop: loopReturning([], seen),
    }));
    expect(seen.user).toContain('nothing was asked yet');
    expect(seen.user).not.toContain('a stray note');
  });

  test("the prompt is grounded in the FIRM's clock, not UTC", async () => {
    // The first live run reasoned "it is the middle of the night" at 18:50
    // firm-local, because it had been handed UTC and nothing else — and pacing
    // is exactly a judgment about whether this is a decent hour to bother
    // someone. Weekday and date come from one derivation so they cannot
    // disagree, and the zone is named so nobody reads it as UTC.
    const seen: { user?: string } = {};
    await runPlanner('2026-08-20T01:50:00.000Z', 'shadow', baseDeps({
      getTenant: async () =>
        ({ id: 't1', timezone: 'America/Los_Angeles' }) as unknown as Tenant,
      runLoop: loopReturning([], seen),
    }));
    expect(seen.user).toContain('Wednesday, August 19, 2026 at 18:50');
    expect(seen.user).toContain("this firm's own timezone (America/Los_Angeles)");
    // UTC is still stated, because that is what a notBefore must be written in.
    expect(seen.user).toContain('2026-08-20T01:50:00.000Z');
  });

  test('an unreadable timezone says so plainly rather than printing a wrong local time', async () => {
    const seen: { user?: string } = {};
    await runPlanner(NOW, 'shadow', baseDeps({
      getTenant: async () => ({ id: 't1', timezone: 'Mars/Olympus' }) as unknown as Tenant,
      runLoop: loopReturning([], seen),
    }));
    expect(seen.user).toContain('could not be read');
  });

  test('evidence is capped per gap, newest kept', async () => {
    const seen: { user?: string } = {};
    const many = Array.from({ length: EVIDENCE_PER_GAP + 3 }, (_, i) =>
      evidence(`2026-08-15T13:0${i}:00.000Z`, `note number ${i}`),
    );
    await runPlanner(NOW, 'shadow', baseDeps({
      listEvidence: async () => many,
      runLoop: loopReturning([], seen),
    }));
    expect(seen.user).not.toContain('note number 0');
    expect(seen.user).toContain(`note number ${EVIDENCE_PER_GAP + 2}`);
  });
});

describe('runPlanner — when it runs at all', () => {
  test('outside the firm ask window the model is NEVER invoked', async () => {
    const loop = vi.fn(loopReturning([]));
    const summary = await runPlanner('2026-08-16T04:00:00.000Z', 'shadow', baseDeps({
      runLoop: loop as unknown as NonNullable<PlannerDeps['runLoop']>,
    }));
    expect(loop).not.toHaveBeenCalled();
    expect(summary.skippedWindow).toBe(1);
    expect(summary.planned).toBe(0);
  });

  test('the window is the FIRM\'s, not UTC', async () => {
    const loop = vi.fn(loopReturning([]));
    // 04:00 UTC is 21:00 the previous day in Tokyo — still outside — but
    // 12:00 UTC is 21:00 Tokyo too, so use a zone where the two disagree.
    const summary = await runPlanner('2026-08-16T04:00:00.000Z', 'shadow', baseDeps({
      getTenant: async () => ({ id: 't1', timezone: 'Asia/Tokyo' }) as unknown as Tenant, // 13:00
      runLoop: loop as unknown as NonNullable<PlannerDeps['runLoop']>,
    }));
    expect(loop).toHaveBeenCalledTimes(1);
    expect(summary.skippedWindow).toBe(0);
  });

  test('no open gaps → no call, and no tenant read beyond the list', async () => {
    const loop = vi.fn(loopReturning([]));
    const summary = await runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [],
      runLoop: loop as unknown as NonNullable<PlannerDeps['runLoop']>,
    }));
    expect(loop).not.toHaveBeenCalled();
    expect(summary.skippedNoGaps).toBe(1);
  });

  test("mode 'off' does nothing at all — not even a tenant list", async () => {
    const listTenants = vi.fn(async () => ['t1']);
    const summary = await runPlanner(NOW, 'off', baseDeps({ listTenants }));
    expect(listTenants).not.toHaveBeenCalled();
    expect(summary.tenants).toBe(0);
  });

  test('a kind with no registered spec is invisible to the planner too', async () => {
    const loop = vi.fn(loopReturning([]));
    const summary = await runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [nudge({ kind: 'unlinked_call' })],
      runLoop: loop as unknown as NonNullable<PlannerDeps['runLoop']>,
    }));
    expect(loop).not.toHaveBeenCalled();
    expect(summary.skippedNoGaps).toBe(1);
  });

  test('one tenant failing does not stop the others', async () => {
    let call = 0;
    const summary = await runPlanner(NOW, 'shadow', baseDeps({
      listTenants: async () => ['t1', 't2'],
      runLoop: (async () => {
        call += 1;
        if (call === 1) throw new Error('provider down');
        return { text: '', turns: 1, calls: [] };
      }) as unknown as NonNullable<PlannerDeps['runLoop']>,
    }));
    expect(summary.tenantErrors).toBe(1);
    expect(summary.planned).toBe(1);
  });
});

describe('the code rails on what the model returns', () => {
  const run = async (decisions: unknown[], evidenceRows: JobEvidenceRow[] = []) =>
    runPlanner(NOW, 'shadow', baseDeps({
      listEvidence: async () => evidenceRows,
      runLoop: loopReturning(decisions),
    }));

  test('close WITHOUT a citation is refused — in code, not by the prompt', async () => {
    const s = await run([{ nudgeId: 'n1', action: 'close', confidence: 'high', reason: 'looks done' }]);
    expect(s.decisions).toBe(0);
    expect(s.dropped).toBe(1);
    expect(s.plans[0].dropped[0].why).toContain('without a citation');
  });

  test('close whose citation is NOT in the evidence is refused — assert-only-cited', async () => {
    const s = await run(
      [
        {
          nudgeId: 'n1',
          action: 'close',
          citation: 'the technician said it cost forty dollars',
          confidence: 'high',
          reason: 'answered',
        },
      ],
      [evidence('2026-08-15T13:00:00.000Z', 'all done, customer happy')],
    );
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('does not appear in the evidence');
  });

  test('close WITH a real quote survives — spacing and case may differ, words may not', async () => {
    const s = await run(
      [
        {
          nudgeId: 'n1',
          action: 'close',
          citation: 'Parts   Were   FORTY dollars',
          confidence: 'high',
          reason: 'answered',
        },
      ],
      [evidence('2026-08-15T13:00:00.000Z', 'all done — parts were forty dollars')],
    );
    expect(s.decisions).toBe(1);
    expect(s.byAction.close).toBe(1);
  });

  test('a decision naming an unknown gap is dropped', async () => {
    const s = await run([{ nudgeId: 'n-ghost', action: 'send', confidence: 'high', reason: 'x' }]);
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('not in this plan');
  });

  test('a second decision for the same gap is dropped, the first stands', async () => {
    const s = await run([
      { nudgeId: 'n1', action: 'send', confidence: 'high', reason: 'first' },
      { nudgeId: 'n1', action: 'escalate', confidence: 'high', reason: 'second' },
    ]);
    expect(s.decisions).toBe(1);
    expect(s.byAction.send).toBe(1);
    expect(s.plans[0].dropped[0].why).toContain('second decision');
  });

  test('an unknown action is dropped rather than guessed at', async () => {
    const s = await run([{ nudgeId: 'n1', action: 'delete', confidence: 'high', reason: 'x' }]);
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain("unknown action 'delete'");
  });

  test('hold without a usable notBefore is dropped — a hold with no end is a silence', async () => {
    const s = await run([
      { nudgeId: 'n1', action: 'hold', notBefore: 'later', confidence: 'high', reason: 'x' },
    ]);
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('without a usable notBefore');
  });

  test('an unreadable confidence reads as LOW, never as high', async () => {
    const s = await run([{ nudgeId: 'n1', action: 'send', confidence: 'certain', reason: 'x' }]);
    expect(s.plans[0].decisions[0].confidence).toBe('low');
  });

  test('a submit that never arrives yields an empty plan, not a crash', async () => {
    const s = await runPlanner(NOW, 'shadow', baseDeps({
      runLoop: (async () => ({ text: 'I give up', turns: 3, calls: [] })) as unknown as NonNullable<
        PlannerDeps['runLoop']
      >,
    }));
    expect(s.planned).toBe(1);
    expect(s.decisions).toBe(0);
    expect(s.tenantErrors).toBe(0);
  });

  test('validateDecisions tolerates junk in place of a decisions array', () => {
    for (const junk of [undefined, null, {}, { decisions: 'nope' }, { decisions: [null] }]) {
      expect(() => validateDecisions(junk, new Map())).not.toThrow();
    }
  });
});

// ── shadow writes NOTHING, proven against the real database ─────────────────
// The unit tests above inject every collaborator, so they can only show that no
// WRITER was called — and in this phase the planner is given none, which makes
// that assertion vacuous. This one plants a real row, runs a real shadow pass,
// and reads the row back.
describe('shadow mode leaves the database untouched', () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  let tenantId: string;
  let techId: string;

  beforeAll(async () => {
    await pg.connect();
    const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
    if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
    tenantId = data.id;
    await pg.query('truncate table nudges cascade');
    const tech = await pg.query<{ id: string }>(
      `insert into technicians (tenant_id, ref, display_name, tier, state, seat_exempt)
       values ($1, 'planner-shadow-tech', 'Planner Shadow Tech', 'technician', 'active', true)
       returning id`,
      [tenantId],
    );
    techId = tech.rows[0].id;
  });

  afterAll(async () => {
    await pg.query('truncate table nudges cascade');
    await pg.query('delete from technicians where id = $1', [techId]);
    await pg.end();
  });

  test('a plan full of send/hold/close/escalate changes not one column', async () => {
    const planted = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-planner-shadow',
      technicianId: techId,
      context: { jobId: '11111111-1111-1111-1111-111111111111', jobTitle: 'Furnace tune-up' },
    });
    if (!planted) throw new Error('fixture nudge was not created');

    const before = (await listNudgesByStatus(tenantId, ['pending']))[0];
    const summary = await runPlanner(NOW, 'shadow', {
      listTenants: async () => [tenantId],
      getTenant: async () => ({ id: tenantId, timezone: 'UTC' }) as unknown as Tenant,
      listEvidence: async () => [],
      runLoop: loopReturning([
        { nudgeId: planted.id, action: 'hold', notBefore: '2026-08-20T15:00:00Z', confidence: 'high', reason: 'pace it' },
      ]),
    });
    expect(summary.decisions).toBe(1);
    expect(summary.applied).toBe(0);

    const after = (await listNudgesByStatus(tenantId, ['pending']))[0];
    expect(after).toEqual(before); // every column, including updated_at
    expect(after.not_before).toBeNull();
    expect(after.escalate_after).toBeNull();
  });
});
