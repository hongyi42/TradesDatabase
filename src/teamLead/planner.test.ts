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
import { NUDGE_DELIVERY_DEADLINE_HOURS } from '../jobs/watchers.js';
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
    const s = await run([
      { nudgeId: 'n1', action: 'hold', notBefore: '1999-01-01T00:00:00Z', confidence: 'high', reason: 'x' },
    ]);
    expect(s.decisions).toBe(0);
    expect(s.plans[0].dropped[0].why).toContain('already passed');
  });

  test('a hold past the delivery deadline is refused — it would hand the gap over, not hold it', async () => {
    const s = await run([
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
    await pg.query("update nudges set status='asked', asked_at=now() - interval '2 hours' where id=$1", [
      planted[2],
    ]);
    const before = await pg.query('select * from nudges where tenant_id=$1 order by subject_ref', [tenantId]);
    expect(rows).toHaveLength(4);

    const summary = await runPlanner(NOW, 'shadow', {
      listTenants: async () => [tenantId],
      getTenant: async () => ({ id: tenantId, timezone: 'UTC' }) as unknown as Tenant,
      listNudges: async () =>
        (await listNudgesByStatus(tenantId, ['pending', 'queued', 'asked'])).map((n) =>
          n.id === planted[2] ? ({ ...n, asked_at: '2026-08-16T10:00:00.000Z' } as Nudge) : n,
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
  });
});
