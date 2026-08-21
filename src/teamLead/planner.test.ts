import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { createPendingNudge, listNudgesByStatus } from '../db/nudges.js';
import { recordNudgeDecisions } from '../db/nudgeDecisions.js';
import type { Nudge, NudgeDecision, Tenant, JobEvidenceRow, RawCapture } from '../db/index.js';
import {
  EVIDENCE_PER_GAP,
  runPlanner,
  validateDecisions,
  type PlannerDeps,
} from './planner.js';
import { SUBMIT_PLAN_TOOL } from './plannerPrompt.js';
import { NUDGE_DELIVERY_DEADLINE_HOURS } from '../jobs/watchers.js';
import { ToolLoopLimitError, type ToolLoopResult } from '../model/toolLoop.js';

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
//
// It CATCHES the executor's error the way runToolLoop does — the planner now
// rejects a wholly-refused submission so the model can correct it, and a stub
// that let that throw escape would test a loop this repo does not have.
// `attempts` optionally replays a second submission, the way a real model would.
function loopReturning(
  decisions: unknown[],
  seen: { user?: string; errors?: string[] } = {},
  retry?: unknown[],
) {
  return (async (
    req: { user: string },
    _tools: unknown,
    execute: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  ): Promise<ToolLoopResult> => {
    seen.user = req.user;
    seen.errors = [];
    const submit = async (d: unknown[]) => {
      try {
        await execute(SUBMIT_PLAN_TOOL.name, { decisions: d });
        return true;
      } catch (err) {
        seen.errors?.push(err instanceof Error ? err.message : String(err));
        return false;
      }
    };
    const ok = await submit(decisions);
    if (!ok && retry) await submit(retry);
    return { text: '', turns: 1, calls: [] };
  }) as unknown as NonNullable<PlannerDeps['runLoop']>;
}

function baseDeps(over: Partial<PlannerDeps> = {}): PlannerDeps {
  return {
    listTenants: async () => ['t1'],
    getTenant: async () => ({ id: 't1', timezone: 'UTC' }) as unknown as Tenant,
    listNudges: async () => [nudge()],
    listEvidence: async () => [],
    listCostEvents: async () => [],
    // Phase 4: stubbed by default so a prompt/rail test never reaches the
    // database. Tests that care about the memory or the writers override these.
    listDecisions: async () => new Map(),
    recordDecisions: async (rows) => rows.length,
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

  // `send` and `hold` only mean anything on a PENDING row — the state rail fires
  // before every other check, so the tests for their OTHER rails need a pending
  // fixture or the rail under test is never reached. (This is the test-rot shape
  // the constants retune already cost us once: a fixture that quietly stops
  // exercising the thing its name claims.)
  const runPending = async (decisions: unknown[]) =>
    runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [nudge({ status: 'pending', asked_at: null, question: null })],
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
    const s = await runPending([
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
    const s = await runPending([
      { nudgeId: 'n1', action: 'hold', notBefore: 'later', confidence: 'high', reason: 'x' },
    ]);
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('without a usable notBefore');
  });

  test('an unreadable confidence reads as LOW, never as high', async () => {
    const s = await runPending([{ nudgeId: 'n1', action: 'send', confidence: 'certain', reason: 'x' }]);
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

  test('a citation too short to be evidence is refused — "the" is in almost any note', async () => {
    const s = await run(
      [{ nudgeId: 'n1', action: 'close', citation: 'the', confidence: 'high', reason: 'x' }],
      [evidence('2026-08-15T13:00:00.000Z', 'the van broke down, nothing to report on this job yet')],
    );
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('too short to be evidence');
  });

  test('a genuinely short answer still passes — "forty dollars" is evidence, "the" is not', async () => {
    const s = await run(
      [{ nudgeId: 'n1', action: 'close', citation: 'forty dollars', confidence: 'high', reason: 'x' }],
      [evidence('2026-08-15T13:00:00.000Z', 'parts came to forty dollars all in')],
    );
    expect(s.decisions).toBe(1);
  });

  test('ONE quote may close ONE gap — a shared note cannot close every gap on a job', async () => {
    // The two shipped detectors land on the same job, and nothing in code can
    // tell which QUESTION a sentence answers. This stops the shape that would
    // actually happen: one note closing all of them.
    const shared = 'all wrapped up, customer signed off';
    const s = await runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [
        nudge({ id: 'n1', subject_ref: 'a1' }),
        nudge({ id: 'n2', kind: 'job_cost_gap', subject_ref: 'j1' }),
      ],
      listEvidence: async () => [evidence('2026-08-15T13:00:00.000Z', shared)],
      runLoop: loopReturning([
        { nudgeId: 'n1', action: 'close', citation: shared, confidence: 'high', reason: 'a' },
        { nudgeId: 'n2', action: 'close', citation: shared, confidence: 'high', reason: 'b' },
      ]),
    }));
    expect(s.decisions).toBe(1);
    expect(s.plans[0].dropped[0].why).toContain('already closed another gap');
  });

  test('a job with two open gaps SAYS SO in the prompt — code knows it, the model would have to guess', async () => {
    const seen: { user?: string } = {};
    await runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [
        nudge({ id: 'n1', subject_ref: 'a1' }),
        nudge({ id: 'n2', kind: 'job_cost_gap', subject_ref: 'j1' }),
      ],
      listEvidence: async () => [evidence('2026-08-15T13:00:00.000Z', 'all wrapped up')],
      runLoop: loopReturning([], seen),
    }));
    expect(seen.user).toContain('this job has more than one open gap');
  });

  test('a hold in the PAST is refused — it holds nothing', async () => {
    const s = await runPending([
      { nudgeId: 'n1', action: 'hold', notBefore: '1999-01-01T00:00:00Z', confidence: 'high', reason: 'x' },
    ]);
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('already passed');
  });

  test('a hold past the delivery deadline is refused — it would hand the gap over, not hold it', async () => {
    const s = await runPending([
      { nudgeId: 'n1', action: 'hold', notBefore: '2099-01-01T00:00:00Z', confidence: 'high', reason: 'x' },
    ]);
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain(`past the ${NUDGE_DELIVERY_DEADLINE_HOURS}h delivery deadline`);
  });

  test('a WHOLLY refused plan comes back as a tool error the model can correct', async () => {
    // Validating after the loop would lose the plan silently: the model never
    // learns its citation was unusable and the gap just stays open.
    const seen: { user?: string; errors?: string[] } = {};
    const good = 'parts came to forty dollars';
    const s = await runPlanner(NOW, 'shadow', baseDeps({
      listEvidence: async () => [evidence('2026-08-15T13:00:00.000Z', good)],
      runLoop: loopReturning(
        [{ nudgeId: 'n1', action: 'close', citation: 'invented words', confidence: 'high', reason: 'x' }],
        seen,
        [{ nudgeId: 'n1', action: 'close', citation: good, confidence: 'high', reason: 'x' }],
      ),
    }));
    expect(seen.errors?.[0]).toContain('every decision was refused');
    expect(seen.errors?.[0]).toContain('does not appear in the evidence');
    expect(s.decisions).toBe(1); // the retry landed
  });

  test('an EMPTY plan is accepted as a real choice, not treated as a mistake', async () => {
    const seen: { errors?: string[] } = {};
    const s = await runPlanner(NOW, 'shadow', baseDeps({ runLoop: loopReturning([], seen) }));
    expect(seen.errors).toEqual([]);
    expect(s.planned).toBe(1);
    expect(s.decisions).toBe(0);
  });

  // ── the record basis: a gap is a HOLE, not an unanswered message ──────────
  // Live 2026-08-20: a cost gap whose figure the MANAGER had already entered was
  // held rather than closed — the planner found the ledger row, said so, and then
  // chased the technician anyway, because the only closure it had was "quote the
  // person who answered" and nobody had.

  test('a cost gap whose figure is already on the ledger closes on the RECORD, with no quote', async () => {
    const s = await runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [nudge({ id: 'n1', kind: 'job_cost_gap', subject_ref: 'j1' })],
      listCostEvents: async () => ['j1'], // the ledger says the hole is filled
      listEvidence: async () => [],
      runLoop: loopReturning([
        { nudgeId: 'n1', action: 'close', basis: 'record', confidence: 'high', reason: 'already recorded' },
      ]),
    }));
    expect(s.decisions).toBe(1);
    expect(s.plans[0].decisions[0].basis).toBe('record');
    // The resolution text is CODE's words, never the model's.
    expect(s.plans[0].decisions[0].citation).toBe(
      'a cost is recorded against this job on the money ledger',
    );
  });

  test('the record basis is REFUSED when the ledger says the hole is still open', async () => {
    const s = await runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [nudge({ id: 'n1', kind: 'job_cost_gap', subject_ref: 'j1' })],
      listCostEvents: async () => [], // nothing recorded
      listEvidence: async () => [],
      runLoop: loopReturning([
        { nudgeId: 'n1', action: 'close', basis: 'record', confidence: 'high', reason: 'trust me' },
      ]),
    }));
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('record is not filled');
  });

  test('a VISIT gap can never close on the record — only a cost gap has that test', async () => {
    const s = await runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [nudge({ id: 'n1', kind: 'overdue_visit_gap', subject_ref: 'a1' })],
      listCostEvents: async () => ['j1'],
      listEvidence: async () => [],
      runLoop: loopReturning([
        { nudgeId: 'n1', action: 'close', basis: 'record', confidence: 'high', reason: 'x' },
      ]),
    }));
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('record is not filled');
  });

  test('the prompt TELLS the planner what the record says, both ways', async () => {
    const filled: { user?: string } = {};
    await runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [nudge({ id: 'n1', kind: 'job_cost_gap', subject_ref: 'j1' })],
      listCostEvents: async () => ['j1'],
      runLoop: loopReturning([], filled),
    }));
    expect(filled.user).toContain('THE RECORD: a cost is recorded against this job');
    expect(filled.user).toContain('The hole this gap names is CLOSED');

    const open: { user?: string } = {};
    await runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [nudge({ id: 'n1', kind: 'job_cost_gap', subject_ref: 'j1' })],
      listCostEvents: async () => [],
      runLoop: loopReturning([], open),
    }));
    expect(open.user).toContain('no cost is recorded against this job yet');
  });

  test('the ledger is read ONLY for cost gaps, and only for their jobs', async () => {
    const asked: string[][] = [];
    await runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [nudge({ id: 'n1', kind: 'overdue_visit_gap', subject_ref: 'a1' })],
      listCostEvents: async (_t, ids) => {
        asked.push(ids);
        return [];
      },
      runLoop: loopReturning([]),
    }));
    expect(asked).toEqual([]); // no cost gaps → no ledger read at all
  });

  test('the gap block carries the JOB ID, so the planner filters by key instead of hunting by name', async () => {
    // Live 2026-08-20: given only names it searched `customer_name LIKE '%Okafor%'`
    // and burned turns on queries that returned nothing.
    const seen: { user?: string } = {};
    await runPlanner(NOW, 'shadow', baseDeps({ runLoop: loopReturning([], seen) }));
    expect(seen.user).toContain('job id: j1');
    expect(seen.user).toContain('filter by this id, never by name');
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
describe('the state rails — no decision may be a silent no-op', () => {
  const runOn = async (over: Partial<Nudge>, decisions: unknown[], deps: Partial<PlannerDeps> = {}) =>
    runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [nudge(over)],
      runLoop: loopReturning(decisions),
      ...deps,
    }));

  // The defect this rail exists for, observed live 2026-08-20: the planner chose
  // `send` on a row asked hours earlier. not_before gates COMPOSE and nothing
  // else, so the write would have returned the row happily and changed nothing.
  test('send on an ALREADY-ASKED gap is refused, and says why', async () => {
    const s = await runOn({ status: 'asked' }, [
      { nudgeId: 'n1', action: 'send', confidence: 'high', reason: 'chase it again' },
    ]);
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('ALREADY been asked');
    expect(s.plans[0].dropped[0].why).toContain('leave the gap out of your plan');
  });

  test('hold on an already-asked gap is refused too — the question is already out', async () => {
    const s = await runOn({ status: 'asked' }, [
      { nudgeId: 'n1', action: 'hold', notBefore: '2099-01-01T00:00:00Z', confidence: 'high', reason: 'wait' },
    ]);
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('ALREADY been asked');
  });

  test('send on a QUEUED gap is refused — it is written and waiting to be delivered', async () => {
    const s = await runOn({ status: 'queued', asked_at: null }, [
      { nudgeId: 'n1', action: 'send', confidence: 'high', reason: 'go' },
    ]);
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('waiting to be delivered');
  });

  // The sweep's handoff requires status 'asked' AND an asked_at, so bringing the
  // deadline forward on a pending row moves nothing at all.
  test('escalate on a gap that was never asked is refused', async () => {
    const s = await runOn({ status: 'pending', asked_at: null }, [
      { nudgeId: 'n1', action: 'escalate', confidence: 'high', reason: 'manager should see this' },
    ]);
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('has not been asked yet');
  });

  test('a rail-refused decision is RECORDED with the model own words, not just counted', async () => {
    const recorded: unknown[] = [];
    await runOn(
      { status: 'asked' },
      [{ nudgeId: 'n1', action: 'send', confidence: 'medium', reason: 'chase it again' }],
      {
        recordDecisions: async (rows) => {
          recorded.push(...rows);
          return rows.length;
        },
      },
    );
    expect(recorded).toHaveLength(1);
    const row = recorded[0] as Record<string, unknown>;
    expect(row.outcome).toBe('refused');
    expect(row.action).toBe('send');
    expect(row.confidence).toBe('medium');
    expect(row.reason).toBe('chase it again');
    expect(String(row.outcomeDetail)).toContain('ALREADY been asked');
  });

  // A refused close must not preserve the quote the rails rejected: storing it
  // would keep model-invented text in a column read as evidence.
  test('a refused close records no citation', async () => {
    const recorded: unknown[] = [];
    await runOn({ status: 'asked' }, [
      { nudgeId: 'n1', action: 'close', citation: 'words nobody said', confidence: 'high', reason: 'done' },
    ], {
      recordDecisions: async (rows) => {
        recorded.push(...rows);
        return rows.length;
      },
    });
    expect((recorded[0] as Record<string, unknown>).citation ?? null).toBeNull();
  });
});

describe('the planner sees that it has run before', () => {
  const decisionRow = (over: Partial<NudgeDecision> = {}): NudgeDecision =>
    ({
      id: 'd1',
      tenant_id: 't1',
      nudge_id: 'n1',
      job_id: 'j1',
      decided_at: '2026-08-16T11:00:00.000Z', // one hour before NOW
      mode: 'live',
      action: 'hold',
      not_before: null,
      basis: null,
      citation: null,
      confidence: 'high',
      reason: 'giving them the morning',
      outcome: 'applied',
      outcome_detail: null,
      ...over,
    }) as unknown as NudgeDecision;

  const withHistory = async (history: NudgeDecision[], seen: { user?: string }) =>
    runPlanner(NOW, 'shadow', baseDeps({
      listDecisions: async () => new Map([['n1', history]]),
      runLoop: loopReturning([], seen),
    }));

  test('a gap with no history says nothing — the line is absent, not empty', async () => {
    const seen: { user?: string } = {};
    await withHistory([], seen);
    expect(seen.user).not.toContain('prior decisions');
  });

  // The ONE pushed fact. Everything else is pulled with recall_decisions, but
  // "you have decided about this before" has to be present whether or not the
  // model thinks to look — not knowing there is anything to look up IS the
  // failure it prevents.
  test('a gap with history carries a count, the last action, and how long ago', async () => {
    const seen: { user?: string } = {};
    await withHistory([decisionRow({ decided_at: '2026-08-16T09:00:00.000Z' }), decisionRow()], seen);
    expect(seen.user).toContain('prior decisions: 2 (last: hold, 1h ago)');
    expect(seen.user).toContain('recall_decisions');
  });

  test('a refused last decision is marked as refused, not reported as done', async () => {
    const seen: { user?: string } = {};
    await withHistory([decisionRow({ action: 'send', outcome: 'refused' })], seen);
    expect(seen.user).toContain('last: send — REFUSED');
  });

  test('a shadow decision says it was not applied', async () => {
    const seen: { user?: string } = {};
    await withHistory([decisionRow({ outcome: 'shadow', mode: 'shadow' })], seen);
    expect(seen.user).toContain('shadow, not applied');
  });

  test('history is read for the tick gaps in ONE batched call', async () => {
    const listDecisions = vi.fn<NonNullable<PlannerDeps['listDecisions']>>(async () => new Map());
    await runPlanner(NOW, 'shadow', baseDeps({ listDecisions }));
    expect(listDecisions).toHaveBeenCalledTimes(1);
    expect(listDecisions.mock.calls[0][1]).toEqual(['n1']);
  });
});

describe('live mode — the decision becomes a write, and the write becomes the record', () => {
  const live = async (over: Partial<Nudge>, decisions: unknown[], deps: Partial<PlannerDeps> = {}) => {
    const setSchedule = vi.fn<NonNullable<PlannerDeps['setSchedule']>>(async () => nudge());
    const markOutcome = vi.fn<NonNullable<PlannerDeps['markOutcome']>>(async () => nudge());
    const recorded: Record<string, unknown>[] = [];
    const summary = await runPlanner(NOW, 'live', baseDeps({
      listNudges: async () => [nudge(over)],
      runLoop: loopReturning(decisions),
      setSchedule,
      markOutcome,
      recordDecisions: async (rows) => {
        recorded.push(...(rows as unknown as Record<string, unknown>[]));
        return rows.length;
      },
      ...deps,
    }));
    return { summary, setSchedule, markOutcome, recorded };
  };

  test('send CLEARS the hold, pending-guarded', async () => {
    const { setSchedule, summary, recorded } = await live({ status: 'pending', asked_at: null }, [
      { nudgeId: 'n1', action: 'send', confidence: 'high', reason: 'go now' },
    ]);
    expect(setSchedule).toHaveBeenCalledWith('n1', 't1', { notBefore: null }, ['pending']);
    expect(summary.applied).toBe(1);
    expect(recorded[0].outcome).toBe('applied');
    expect(recorded[0].mode).toBe('live');
  });

  test('hold stamps the instant the model chose', async () => {
    // created_at an hour ago, not a day: the hold ceiling is
    // created_at + NUDGE_DELIVERY_DEADLINE_HOURS, and the default fixture is old
    // enough that any future hold would be refused by THAT rail instead.
    const { setSchedule } = await live(
      { status: 'pending', asked_at: null, created_at: '2026-08-16T11:00:00.000Z' },
      [
        { nudgeId: 'n1', action: 'hold', notBefore: '2026-08-16T18:00:00Z', confidence: 'high', reason: 'pace' },
      ],
    );
    expect(setSchedule).toHaveBeenCalledWith(
      'n1', 't1', { notBefore: '2026-08-16T18:00:00.000Z' }, ['pending'],
    );
  });

  // The planner never escalates by hand: it moves the deadline and the SWEEP
  // performs the handoff, so the rung-2 flag and the orphan doctrine stay in
  // one place.
  test('escalate moves the deadline and touches nothing else', async () => {
    const { setSchedule, markOutcome } = await live({ status: 'asked' }, [
      { nudgeId: 'n1', action: 'escalate', confidence: 'low', reason: 'no reply' },
    ]);
    expect(setSchedule).toHaveBeenCalledWith('n1', 't1', { escalateAfter: NOW }, ['asked']);
    expect(markOutcome).not.toHaveBeenCalled();
  });

  test('close writes a resolution that QUOTES the evidence it cited', async () => {
    const answer = 'parts came to forty dollars';
    const { markOutcome } = await live({ status: 'asked' }, [
      { nudgeId: 'n1', action: 'close', citation: answer, confidence: 'high', reason: 'answered' },
    ], { listEvidence: async () => [evidence('2026-08-15T13:00:00.000Z', answer)] });
    expect(markOutcome).toHaveBeenCalledWith('n1', 't1', 'answered', `answered — "${answer}"`);
  });

  // A status-guarded update that matches nothing means the row moved under us —
  // a real event, and the one thing that must never be logged as success.
  test('a write that lands nowhere is recorded as REFUSED, never as applied', async () => {
    const { summary, recorded } = await live({ status: 'pending', asked_at: null }, [
      { nudgeId: 'n1', action: 'send', confidence: 'high', reason: 'go' },
    ], { setSchedule: async () => null });
    expect(summary.applied).toBe(0);
    expect(summary.refusedAtApply).toBe(1);
    expect(recorded[0].outcome).toBe('refused');
    expect(String(recorded[0].outcomeDetail)).toContain('changed state');
  });

  test('a writer that throws refuses that ONE decision and keeps the reason', async () => {
    const { summary, recorded } = await live({ status: 'pending', asked_at: null }, [
      { nudgeId: 'n1', action: 'send', confidence: 'high', reason: 'go' },
    ], {
      setSchedule: async () => {
        throw new Error('connection reset');
      },
    });
    expect(summary.refusedAtApply).toBe(1);
    expect(String(recorded[0].outcomeDetail)).toContain('connection reset');
  });

  test('SHADOW calls neither writer, but still records', async () => {
    const setSchedule = vi.fn<NonNullable<PlannerDeps['setSchedule']>>(async () => nudge());
    const markOutcome = vi.fn<NonNullable<PlannerDeps['markOutcome']>>(async () => nudge());
    const recorded: Record<string, unknown>[] = [];
    const summary = await runPlanner(NOW, 'shadow', baseDeps({
      listNudges: async () => [nudge({ status: 'pending', asked_at: null })],
      runLoop: loopReturning([{ nudgeId: 'n1', action: 'send', confidence: 'high', reason: 'go' }]),
      setSchedule,
      markOutcome,
      recordDecisions: async (rows) => {
        recorded.push(...(rows as unknown as Record<string, unknown>[]));
        return rows.length;
      },
    }));
    expect(setSchedule).not.toHaveBeenCalled();
    expect(markOutcome).not.toHaveBeenCalled();
    expect(summary.applied).toBe(0);
    expect(summary.recorded).toBe(1);
    expect(recorded[0].outcome).toBe('shadow');
  });

  // A gap that already resolved is not in `open`, so it never reaches the view
  // map and the unknown-gap rail catches it. Pinned explicitly because the
  // REASON is a two-step argument, and a future change to the status filter
  // would break it silently.
  test('a decision for an already-answered gap is dropped, never applied', async () => {
    const setSchedule = vi.fn<NonNullable<PlannerDeps['setSchedule']>>(async () => nudge());
    const markOutcome = vi.fn<NonNullable<PlannerDeps['markOutcome']>>(async () => nudge());
    const s = await runPlanner(NOW, 'live', baseDeps({
      // The row the model names is NOT among the open gaps this tick.
      listNudges: async () => [nudge({ id: 'n-open', status: 'asked' })],
      runLoop: loopReturning([
        { nudgeId: 'n-answered', action: 'close', citation: 'all done here', confidence: 'high', reason: 'x' },
      ]),
      setSchedule,
      markOutcome,
    }));
    expect(s.decisions).toBe(0);
    expect(s.applied).toBe(0);
    expect(markOutcome).not.toHaveBeenCalled();
    expect(s.plans[0].dropped[0].why).toContain('not in this plan');
  });

  // Phase-3 flagged this for Phase 4: at two gaps the planner used 28.6s of a 90s
  // budget, so a twenty-gap firm will hit the ceiling — and in the logs that
  // would look exactly like a provider outage. The two need opposite responses,
  // so they must never read the same.
  test('a LIMIT hit is counted and logged apart from a model failure', async () => {
    const throwing = (err: Error) =>
      runPlanner(NOW, 'live', baseDeps({
        runLoop: (async () => {
          throw err;
        }) as unknown as NonNullable<PlannerDeps['runLoop']>,
      }));

    const budget = await throwing(
      new ToolLoopLimitError('budget', 'teamLeadPlanner: tool loop exceeded its 90000ms budget'),
    );
    expect(budget.limitHits).toEqual({ budget: 1, turns: 0 });

    const turns = await throwing(new ToolLoopLimitError('turns', 'teamLeadPlanner: turn ceiling'));
    expect(turns.limitHits).toEqual({ budget: 0, turns: 1 });

    // A provider failure must NOT land in either bucket...
    const provider = await throwing(new Error('502 from the inference gateway'));
    expect(provider.limitHits).toEqual({ budget: 0, turns: 0 });
    // ...but every one of them still trips the existing alarm.
    for (const s of [budget, turns, provider]) expect(s.tenantErrors).toBe(1);
  });

  // The fail-safe the whole design rests on: a dead planner degrades to exactly
  // the behaviour that shipped before it existed, because the sweep's constants
  // still apply to rows nobody touched.
  test('a planner call that throws touches nothing and writes nothing', async () => {
    const setSchedule = vi.fn<NonNullable<PlannerDeps['setSchedule']>>(async () => nudge());
    const markOutcome = vi.fn<NonNullable<PlannerDeps['markOutcome']>>(async () => nudge());
    const recordDecisions = vi.fn<NonNullable<PlannerDeps['recordDecisions']>>(async () => 0);
    const s = await runPlanner(NOW, 'live', baseDeps({
      runLoop: (async () => {
        throw new Error('provider suspended');
      }) as unknown as NonNullable<PlannerDeps['runLoop']>,
      setSchedule,
      markOutcome,
      recordDecisions,
    }));
    expect(s.tenantErrors).toBe(1);
    expect(s.applied).toBe(0);
    expect(setSchedule).not.toHaveBeenCalled();
    expect(markOutcome).not.toHaveBeenCalled();
    expect(recordDecisions).not.toHaveBeenCalled();
  });

  // Losing the log must not lose the tick: in live the nudges rows still carry
  // the state, so what a failed insert costs is the memory, not the work.
  test('a recording failure is loud but does not take the tick down', async () => {
    const summary = await live({ status: 'pending', asked_at: null }, [
      { nudgeId: 'n1', action: 'send', confidence: 'high', reason: 'go' },
    ], {
      recordDecisions: async () => {
        throw new Error('insert failed');
      },
    });
    expect(summary.summary.applied).toBe(1);
    expect(summary.summary.recorded).toBe(0);
    expect(summary.summary.tenantErrors).toBe(0);
  });
});

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

  test('a plan of send/hold/close/escalate changes not one column', async () => {
    const jobId = '11111111-1111-1111-1111-111111111111';
    const planted: string[] = [];
    for (const ref of ['asg-shadow-1', 'asg-shadow-2', 'asg-shadow-3', 'asg-shadow-4']) {
      const n = await createPendingNudge({
        tenantId,
        kind: 'overdue_visit_gap',
        subjectRef: ref,
        technicianId: techId,
        context: { jobId, jobTitle: 'Furnace tune-up' },
      });
      if (!n) throw new Error('fixture nudge was not created');
      planted.push(n.id);
    }
    // Every action, including a close carrying a citation the rails accept —
    // the whole point is that even a VALID plan writes nothing in shadow.
    const answer = 'all wrapped up, parts came to forty dollars';
    const rows = await listNudgesByStatus(tenantId, ['pending']);
    // asked_at must exist for evidence to be in bounds; these rows are pending,
    // so the close is fed through a row that has one.
    // Two rows must be ASKED, not pending: `close` needs an asked_at for the
    // evidence bound, and `escalate` is refused on a row that was never asked
    // (bringing the deadline forward on a pending row moves nothing).
    await pg.query(
      "update nudges set status='asked', asked_at=now() - interval '2 hours' where id = any($1)",
      [[planted[2], planted[3]]],
    );
    const before = await pg.query('select * from nudges where tenant_id=$1 order by subject_ref', [tenantId]);
    expect(rows).toHaveLength(4);

    const summary = await runPlanner(NOW, 'shadow', {
      listTenants: async () => [tenantId],
      getTenant: async () => ({ id: tenantId, timezone: 'UTC' }) as unknown as Tenant,
      listNudges: async () =>
        (await listNudgesByStatus(tenantId, ['pending', 'queued', 'asked'])).map((n) =>
          n.id === planted[2] || n.id === planted[3]
            ? ({ ...n, asked_at: '2026-08-16T10:00:00.000Z' } as Nudge)
            : n,
        ),
      listEvidence: async () => [evidence('2026-08-16T11:00:00.000Z', answer, jobId)],
      runLoop: loopReturning([
        { nudgeId: planted[0], action: 'send', confidence: 'high', reason: 'go now' },
        { nudgeId: planted[1], action: 'hold', notBefore: '2026-08-16T18:00:00Z', confidence: 'high', reason: 'pace it' },
        { nudgeId: planted[2], action: 'close', citation: answer, confidence: 'high', reason: 'answered' },
        { nudgeId: planted[3], action: 'escalate', confidence: 'low', reason: 'no reply' },
      ]),
    });
    expect(summary.decisions).toBe(4);
    expect(summary.dropped).toBe(0);
    expect(summary.applied).toBe(0);

    const after = await pg.query('select * from nudges where tenant_id=$1 order by subject_ref', [tenantId]);
    expect(after.rows).toEqual(before.rows); // every column, including updated_at

    // ...but the DECISIONS are written, in shadow too. That is the whole point
    // of Phase 4's amendment: the corpus and the planner's own memory start
    // accumulating before anything is applied, so the effect of having a memory
    // can be watched in shadow rather than discovered live.
    expect(summary.recorded).toBe(4);
    const logged = await pg.query(
      'select action, outcome, mode, job_id from nudge_decisions where tenant_id=$1 order by action',
      [tenantId],
    );
    expect(logged.rows.map((r) => r.action)).toEqual(['close', 'escalate', 'hold', 'send']);
    expect(logged.rows.every((r) => r.outcome === 'shadow' && r.mode === 'shadow')).toBe(true);
    // Denormalised so history can be recalled by JOB, not only by gap.
    expect(logged.rows.every((r) => r.job_id === jobId)).toBe(true);
  });

  // `job_id` is a uuid column and the insert is ONE statement per chunk —
  // PostgREST has no partial insert, so a single malformed id would reject up to
  // 500 decisions. The corpus is what this table exists for, so a bad id must
  // cost its own job-keyed recall and nothing else.
  test('a malformed jobId costs that row its job recall, not the whole batch', async () => {
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-badjob',
      technicianId: techId,
      context: { jobId: 'not-a-uuid' },
    });
    if (!n) throw new Error('fixture nudge was not created');
    const good = '33333333-3333-3333-3333-333333333333';

    const written = await recordNudgeDecisions([
      { tenantId, nudgeId: n.id, jobId: 'not-a-uuid', mode: 'shadow', action: 'hold',
        confidence: 'low', reason: 'malformed', outcome: 'shadow' },
      { tenantId, nudgeId: n.id, jobId: good, mode: 'shadow', action: 'escalate',
        confidence: 'low', reason: 'fine', outcome: 'shadow' },
    ]);

    // BOTH rows land — the batch was not rejected.
    expect(written).toBe(2);
    const rows = await pg.query<{ action: string; job_id: string | null }>(
      'select action, job_id from nudge_decisions where nudge_id = $1 order by action',
      [n.id],
    );
    expect(rows.rows).toEqual([
      { action: 'escalate', job_id: good },
      { action: 'hold', job_id: null }, // dropped, loudly, rather than throwing
    ]);
  });
});
