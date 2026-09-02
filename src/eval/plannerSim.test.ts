import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createTenant } from '../db/tenants.js';
import { spineNowIso } from '../evalClock.js';
import { SMOKE_SCENARIOS } from './plannerCorpus.js';
import {
  atOffset,
  clearSimClock,
  parseOffsetMs,
  runArc,
  runTick,
  seedScenario,
  setSimClock,
  simStartIso,
  SIM_TZ,
  EVAL_LOOP_BUDGET_MS,
  toNaiveLocal,
  type ScenarioWorld,
} from './plannerSim.js';
import type { TimelineStep } from './plannerCorpus.js';
import type { runToolLoop } from '../model/toolLoop.js';
import { localTimeHHMM, localDateISO } from '../schedule/availability.js';
import { runPlanner } from '../teamLead/planner.js';
import { runWatchers } from '../jobs/watchers.js';
import { TEAM_LEAD_REF } from '../teamLead/identity.js';
import { dispatchForIdentity, TEAM_LEAD_TOOL_SCHEMAS } from '../mcp/server.js';

// Integration test against the LOCAL stack (testEnvGuard enforces local-only).
// The simulator is what the agentic eval trusts about time: offsets resolve,
// the tool-side clock follows the tick clock, seeded rows land with the
// EXPLICIT timestamps a scenario names, and the post-tick fix-up rewrites the
// tick's own wall-clock stamps to sim-now.

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  const t = await createTenant(`Eval PlannerSimTest ${Date.now()}`);
  tenantId = t.id;
  // The window guard and every label want the firm's own zone, explicitly.
  await pg.query(`update tenants set timezone = $2 where id = $1`, [tenantId, SIM_TZ]);
});

afterAll(async () => {
  clearSimClock();
  await pg.end();
});

describe('offsets and the sim clock', () => {
  test('parseOffsetMs reads signed hours and days', () => {
    expect(parseOffsetMs('-30h')).toBe(-30 * 3_600_000);
    expect(parseOffsetMs('+2.5h')).toBe(2.5 * 3_600_000);
    expect(parseOffsetMs('-3d')).toBe(-3 * 24 * 3_600_000);
    expect(() => parseOffsetMs('30h')).toThrow(/bad offset/);
    expect(() => parseOffsetMs('-2m')).toThrow(/bad offset/);
  });

  test('simStartIso lands on the requested firm-local hour', () => {
    const iso = simStartIso(10);
    expect(localTimeHHMM(iso, SIM_TZ)).toBe('10:00');
    expect(localDateISO(iso, SIM_TZ)).toBe(localDateISO(new Date().toISOString(), SIM_TZ));
  });

  test('setSimClock pins exactly one tenant; others keep the real clock', () => {
    const pinned = '2026-08-24T17:00:00.000Z';
    setSimClock(tenantId, pinned);
    expect(spineNowIso(tenantId)).toBe(pinned);
    const other = spineNowIso('00000000-0000-0000-0000-000000000000');
    expect(Math.abs(Date.parse(other) - Date.now())).toBeLessThan(5_000);
    clearSimClock();
    expect(Math.abs(Date.parse(spineNowIso(tenantId)) - Date.now())).toBeLessThan(5_000);
  });
});

describe('seedScenario — explicit timestamps, pinned subjects', () => {
  test('SMOKE-1 round-trips with every time-bearing column at its offset', async () => {
    const t0 = simStartIso(10);
    const t0Ms = Date.parse(t0);
    const seeded = await seedScenario(tenantId, SMOKE_SCENARIOS[0].world, t0Ms);

    const { rows: nudges } = await pg.query(
      `select * from nudges where tenant_id = $1 and id = $2`,
      [tenantId, seeded.nudgeIds.gap],
    );
    expect(nudges).toHaveLength(1);
    const n = nudges[0];
    expect(n.status).toBe('asked');
    // subject_ref pinned by kind: the ASSIGNMENT id for a visit gap, so the
    // live detector's once-ever dedup sees the gap as already surfaced.
    expect(n.subject_ref).toBe(seeded.assignmentId);
    expect(new Date(n.asked_at).toISOString()).toBe(atOffset(t0Ms, '-24.5h'));
    expect(new Date(n.escalate_after).toISOString()).toBe(atOffset(t0Ms, '+2h'));

    const { rows: history } = await pg.query(
      `select action, outcome, decided_at from nudge_decisions
       where tenant_id = $1 and nudge_id = $2 order by decided_at`,
      [tenantId, seeded.nudgeIds.gap],
    );
    expect(history.map((h) => h.action)).toEqual(['leave', 'extend']);
    expect(new Date(history[0].decided_at).toISOString()).toBe(atOffset(t0Ms, '-22h'));

    // Evidence captures land append-only with the SEEDED captured_at — the
    // reader bound buildGapView filters on.
    const { rows: caps } = await pg.query(
      `select raw_text, captured_at, technician_ref from raw_captures
       where tenant_id = $1 and job_id = $2`,
      [tenantId, seeded.jobId],
    );
    expect(caps).toHaveLength(1);
    expect(caps[0].raw_text).toContain('spare cartridges');
    expect(caps[0].technician_ref).toBe(seeded.technicianRef);
    expect(new Date(caps[0].captured_at).toISOString()).toBe(atOffset(t0Ms, '-4h'));

    // The visit stores the firm's wall clock (naive-local, as-if-UTC) — the
    // stored instant equals the naiveLocalISO string read as UTC.
    const { rows: visits } = await pg.query(`select starts_at from assignments where id = $1`, [
      seeded.assignmentId,
    ]);
    expect(new Date(visits[0].starts_at).getTime()).toBe(
      Date.parse(toNaiveLocal(atOffset(t0Ms, '-27h'))),
    );
  });

  test('SMOKE-2 money rows carry the seeded created_at (the reader bound)', async () => {
    const t0Ms = Date.parse(simStartIso(10));
    const seeded = await seedScenario(tenantId, SMOKE_SCENARIOS[1].world, t0Ms);
    const { rows } = await pg.query(
      `select kind, amount_cents, created_at from money_events where tenant_id = $1 and job_id = $2`,
      [tenantId, seeded.jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('payment_received');
    expect(new Date(rows[0].created_at).toISOString()).toBe(atOffset(t0Ms, '-1h'));
  });
});

describe('runTick — production wiring, stubbed model', () => {
  test('sweep runs, a stub-driven submit_plan decision lands, fix-up stamps sim-now', async () => {
    // Fresh tenant: the seeding tests above left open gaps that would join
    // this tick's plan and make the assertions relative.
    const t = await createTenant(`Eval PlannerSimTick ${Date.now()}`);
    await pg.query(`update tenants set timezone = $2 where id = $1`, [t.id, SIM_TZ]);
    const t0 = simStartIso(10);
    const t0Ms = Date.parse(t0);
    const seeded = await seedScenario(t.id, SMOKE_SCENARIOS[0].world, t0Ms);
    const gapId = seeded.nudgeIds.gap;

    // The stub MUST drive the executor — decisions exist only via
    // validateDecisions inside the submit_plan branch (planner.ts).
    // Build 1b: RECORDED here, ASSERTED after runTick returns. An expect() that
    // throws inside this stub is caught by runPlanner's per-tenant try/catch and
    // becomes tenantErrors — so the failure would surface as an unrelated
    // "expected +0 to be 1" three assertions later, naming nothing about what
    // actually broke.
    let loopReq: { budgetMs?: number; maxTurns?: number | null } | undefined;
    const stubLoop: typeof runToolLoop = async (req, _tools, execute) => {
      loopReq = req;
      expect(req.user).toContain(`gap ${gapId}`);
      const reply = (await execute('submit_plan', {
        decisions: [
          {
            nudgeId: gapId,
            action: 'leave',
            confidence: 'high',
            reason: 'stub: morning is young, give it the afternoon',
          },
        ],
      })) as { accepted: number };
      expect(reply.accepted).toBe(1);
      return {
        text: '',
        turns: 1,
        calls: [
          { turn: 1, name: 'submit_plan', args: {}, ok: true, result: JSON.stringify(reply) },
        ],
      };
    };

    const tick = await runTick(t.id, t0, { runLoop: stubLoop });

    // FIRST, before anything else: the per-tenant catch turns a swallowed
    // assertion into this counter, so a non-zero value means the expectations
    // inside the stub above never really ran.
    expect(tick.planner.tenantErrors).toBe(0);
    expect(loopReq).toBeDefined();
    // The sim overrides production's fifteen-minute clock on the way through
    // wrapLoop, so one stalled call cannot hold an eval run for a quarter-hour.
    expect(loopReq!.budgetMs).toBe(EVAL_LOOP_BUDGET_MS);
    // The TURN behaviour is deliberately NOT overridden — the eval has to
    // reproduce production's unbounded turns, which is the thing it measures.
    expect(loopReq!.maxTurns).toBeNull();

    expect(tick.watchers.tenants).toBe(1);
    expect(tick.planner.planned).toBe(1);
    expect(tick.planner.applied).toBe(1);
    expect(tick.userPrompt).toContain('open gap');
    expect(tick.toolCalls.map((c) => c.name)).toContain('submit_plan');

    const leave = tick.decisions.find((d) => d.action === 'leave');
    expect(leave).toBeDefined();
    expect(leave!.outcome).toBe('applied');
    // THE FIX-UP: the DB stamped the real wall clock; the record must read
    // sim-now, or any >24h arc misreads its own history.
    expect(new Date(leave!.decided_at).toISOString()).toBe(t0);
    const { rows } = await pg.query(`select decided_at from nudge_decisions where id = $1`, [
      leave!.id,
    ]);
    expect(new Date(rows[0].decided_at).toISOString()).toBe(t0);

    // And the row itself is untouched — leave changes nothing (and since
    // build 5, nothing else in the tick moves a gap either).
    const after = tick.nudgesAfter.find((n) => n.id === gapId);
    expect(after?.status).toBe('asked');
  });

  test('a seat inform rides the tick prompt and is marked read (build 5.5)', async () => {
    const t = await createTenant(`Eval PlannerSimOffice ${Date.now()}`);
    await pg.query(`update tenants set timezone = $2 where id = $1`, [t.id, SIM_TZ]);
    const t0 = simStartIso(10);
    const t0Ms = Date.parse(t0);
    const world: ScenarioWorld = {
      ...SMOKE_SCENARIOS[0].world,
      officeMessages: [{ at: '-2h', body: 'Ben is on leave this week — nothing urgent should go to him' }],
    };
    await seedScenario(t.id, world, t0Ms);

    const stubLoop: typeof runToolLoop = async (req, _tools, execute) => {
      // An EMPTY plan is a legitimate choice — this test is about the READ.
      await execute('submit_plan', { decisions: [] });
      return { text: '', turns: 1, calls: [] };
    };
    const tick = await runTick(t.id, t0, { runLoop: stubLoop });

    expect(tick.planner.tenantErrors).toBe(0);
    // The inform reached the deciding planner, framed as information.
    expect(tick.userPrompt).toContain('OFFICE MESSAGES');
    expect(tick.userPrompt).toContain('information not instruction');
    expect(tick.userPrompt).toContain('Ben is on leave this week');
    // …and the successful tick drained it: read, with the read stamp at sim-now
    // (markOfficeMessagesRead takes the tick's own nowIso).
    const inform = tick.officeAfter.find((m) => m.kind === 'inform');
    expect(inform?.status).toBe('read');
    expect(new Date(inform!.read_at!).toISOString()).toBe(t0);
  });

  test('the cadence guard throws off-grid, and expectCadenceSkip records the skip', async () => {
    const t = await createTenant(`Eval PlannerSimCadence ${Date.now()}`);
    await pg.query(`update tenants set timezone = $2 where id = $1`, [t.id, SIM_TZ]);
    const t0Ms = Date.parse(simStartIso(10));
    // Deadline pushed past the late tick: the sweep runs on EVERY tick, so a due
    // gap would be escalated before the planner could demonstrate the skip.
    const world = {
      ...SMOKE_SCENARIOS[0].world,
      nudges: SMOKE_SCENARIOS[0].world.nudges.map((n) => ({ ...n, escalateAfter: '+40h' })),
    };
    await seedScenario(t.id, world, t0Ms);

    // 22:15 firm-local — a real hour, but off the 30-minute grid.
    const offGrid = atOffset(t0Ms, '+12.25h');
    await expect(runTick(t.id, offGrid)).rejects.toThrow(/cadence/);

    const skipped = await runTick(t.id, offGrid, { expectCadenceSkip: true });
    expect(skipped.planner.skippedCadence).toBe(1);
    expect(skipped.planner.planned).toBe(0);
    expect(skipped.userPrompt).toBeNull();
    expect(skipped.decisions).toHaveLength(0);
  });

  test('22:00 is a NORMAL tick now — the ask window is gone', async () => {
    // The counterpart, and the one that proves the deletion rather than the
    // rename: this exact hour used to skip the tenant before the model call. A
    // firm that has recorded no approximate hours runs at the full rate around
    // the clock, so the planner thinks here like any other tick.
    const t = await createTenant(`Eval PlannerSimEvening ${Date.now()}`);
    await pg.query(`update tenants set timezone = $2 where id = $1`, [t.id, SIM_TZ]);
    const t0Ms = Date.parse(simStartIso(10));
    const world = {
      ...SMOKE_SCENARIOS[0].world,
      nudges: SMOKE_SCENARIOS[0].world.nudges.map((n) => ({ ...n, escalateAfter: '+40h' })),
    };
    await seedScenario(t.id, world, t0Ms);

    // An EMPTY plan is a legitimate submission ("leave them all alone"), so this
    // is the cheapest stub that still proves the model call HAPPENED.
    const emptyPlan: typeof runToolLoop = async (_req, _tools, execute) => {
      await execute('submit_plan', { decisions: [] });
      return { text: '', turns: 1, calls: [] };
    };
    const evening = atOffset(t0Ms, '+12h'); // 22:00 firm-local
    const tick = await runTick(t.id, evening, { runLoop: emptyPlan });
    expect(tick.planner.skippedCadence).toBe(0);
    expect(tick.planner.planned).toBe(1);
    expect(tick.userPrompt).not.toBeNull();
  });
});

describe('the sim clock owns job-note stamps', () => {
  test('a note written during a tick is stamped at SIM now, not the wall clock', async () => {
    // write_job_note goes through MCP dispatch, which holds no nowIso, so it
    // stamps written_at from the NODE clock. Unrewritten, the next tick renders
    // "last written 8h ago" one tick after the note was written — or a future
    // stamp on a run starting before 10:00 firm-local. Nothing else catches it:
    // the fix-up is invisible in every prompt the tick itself produces.
    const t = await createTenant(`Eval JobNoteClock ${Date.now()}`);
    await pg.query(`update tenants set timezone = $2 where id = $1`, [t.id, SIM_TZ]);
    const t0 = simStartIso(10);
    const t0Ms = Date.parse(t0);
    const seeded = await seedScenario(
      t.id,
      {
        customer: { name: 'Clock Customer' },
        job: { title: 'Clock job', status: 'in_progress' },
        technician: { ref: 'clock-tech', name: 'Dee Marsh' },
        visit: { startsAt: '-6h', endsAt: '-5h' },
        nudges: [
          {
            key: 'gap',
            kind: 'overdue_visit_gap',
            status: 'asked',
            createdAt: '-4h',
            askedAt: '-3h',
            question: 'How did it go?',
          },
        ],
      },
      t0Ms,
    );
    // The planner writes a note through the REAL tool, mid-tick.
    await runTick(t.id, t0, {
      runLoop: (async (_req: unknown, _tools: unknown, execute: never) => {
        const run = execute as unknown as (n: string, a: Record<string, unknown>) => Promise<void>;
        await run('write_job_note', { jobId: seeded.jobId, content: 'written mid-tick' });
        await run('submit_plan', { decisions: [] });
        return { text: '', turns: 1, calls: [] };
      }) as never,
    });
    const { rows } = await pg.query(
      'select written_at from job_notes where tenant_id = $1 and job_id = $2',
      [t.id, seeded.jobId],
    );
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].written_at).toISOString()).toBe(t0);
    clearSimClock();
    // Take the NOTE with it. This file's afterAll only clears the sim clock, so
    // a note left here leaks into every later file — and it did: an unscoped
    // count in server.test.ts failed depending on run order.
    //
    // The rows, not the tenant: `technicians_tenant_id_fkey` is NO ACTION, so
    // deleting the tenant needs the whole world torn down in FK order, and the
    // tenant row itself leaks harmlessly (every eval test leaves one). It is
    // the job_notes row that any other file can see.
    await pg.query('delete from job_note_versions where tenant_id = $1', [t.id]);
    await pg.query('delete from job_notes where tenant_id = $1', [t.id]);
  });
});

// Build 5, Phase 3, codified against the REAL store: the sweep DECIDES
// NOTHING. A 30h-silent asked gap, an 18h+ queued relic and a cancelled-visit
// observation all pass through a live sweep untouched — no escalation, no
// expiry, no moot-dismiss, no review item, ever.
describe('the sweep touches nothing (build 5)', () => {
  test('silent, stuck and moot gaps all survive a live sweep unmoved', async () => {
    const t = await createTenant(`Eval SweepInert ${Date.now()}`);
    await pg.query(`update tenants set timezone = $2 where id = $1`, [t.id, SIM_TZ]);
    const t0 = simStartIso(10);
    const t0Ms = Date.parse(t0);
    // An asked gap 30h silent (past the OLD 24h clock) on a visit that has
    // since been CANCELLED (the OLD moot would close it on sight).
    const seeded = await seedScenario(t.id, {
      ...SMOKE_SCENARIOS[0].world,
      nudges: SMOKE_SCENARIOS[0].world.nudges.map((n) => ({
        ...n, status: 'asked' as const, createdAt: '-31h' as const, askedAt: '-30h' as const,
      })),
    }, t0Ms);
    const gapId = seeded.nudgeIds.gap;
    const { rows: [g] } = await pg.query('select subject_ref from nudges where id = $1', [gapId]);
    await pg.query("update assignments set status = 'cancelled' where id = $1", [g.subject_ref]);
    // A queued relic past the OLD 18h delivery deadline.
    const { rows: [q] } = await pg.query(
      `insert into nudges (tenant_id, kind, subject_ref, status, question, queued_at, created_at)
       values ($1, 'overdue_visit_gap', $2, 'queued', 'stub question', $3, $3) returning id`,
      [t.id, `inert-${Date.now()}`, atOffset(t0Ms, '-20h')],
    );
    // An open observation whose visit is cancelled (the OLD moot-dismiss
    // case). The asked world already seeded the subject's once-ever twin
    // (status 'asked'), so reopen THAT row rather than inserting a second.
    const { rows: [o] } = await pg.query(
      `update observations set status = 'open' where id = $1 returning id`,
      [gapId],
    );

    // Make the reopened observation genuinely STALE (>72h) so the alarm's
    // third counter is exercised through the real reads too — and clear the
    // smoke world's seeded history (its -22h `leave` counts as attention,
    // correctly, and this test wants a genuinely NEGLECTED ask).
    await pg.query('update observations set noticed_at = $2 where id = $1', [
      gapId, atOffset(t0Ms, '-80h'),
    ]);
    await pg.query('delete from nudge_decisions where tenant_id = $1', [t.id]);

    const watchers = await runWatchers(t0, 'live', { listTenants: async () => [t.id] });
    expect(watchers.tenantErrors).toBe(0);
    // THE ALARMS see all three conditions — and still, nothing moved (below).
    expect(watchers.alarms).toEqual({ asksUnattended: 1, deliveryStuck: 1, observationsStale: 1 });

    const { rows: after } = await pg.query(
      'select id, status from nudges where id = any($1::uuid[])', [[gapId, q.id]],
    );
    expect(Object.fromEntries(after.map((r) => [r.id, r.status]))).toEqual({
      [gapId]: 'asked', // 30h silent, visit cancelled — UNTOUCHED
      [q.id]: 'queued', // 20h undelivered — UNTOUCHED
    });
    const { rows: [obsAfter] } = await pg.query(
      'select status, dismiss_reason from observations where id = $1', [o.id],
    );
    expect(obsAfter).toEqual({ status: 'open', dismiss_reason: null }); // no moot-dismiss
    const { rows: [items] } = await pg.query(
      'select count(*)::int as n from review_items where tenant_id = $1', [t.id],
    );
    expect(items.n).toBe(0); // the sweep opens NO review items, ever
  });
});

// Build 5, ruling 2 (moot becomes information), codified against the REAL
// store: the planner — not the sweep — ends a cancelled-visit ask, on the
// record, through the real status reads and the real markNudgeOutcome.
// runPlanner directly (not runTick): the sweep still moots until build 5's
// Phase 3 lands, and this test is about the PLANNER's path.
describe('the planner ends a moot gap on the record (build 5)', () => {
  test('cancelled visit → close basis record → row reads CANCELLED with the fact', async () => {
    const t = await createTenant(`Eval PlannerMootClose ${Date.now()}`);
    await pg.query(`update tenants set timezone = $2 where id = $1`, [t.id, SIM_TZ]);
    const t0 = simStartIso(10);
    const t0Ms = Date.parse(t0);
    const seeded = await seedScenario(t.id, SMOKE_SCENARIOS[0].world, t0Ms);
    const gapId = seeded.nudgeIds.gap;
    const { rows: [gapRow] } = await pg.query(
      'select subject_ref from nudges where id = $1', [gapId],
    );
    await pg.query("update assignments set status = 'cancelled' where id = $1", [
      gapRow.subject_ref,
    ]);

    const stubLoop: typeof runToolLoop = async (req, _tools, execute) => {
      // The fact reached the prompt — the whole point of ruling 2.
      expect(req.user).toContain('THE RECORD: the visit was cancelled');
      const reply = (await execute('submit_plan', {
        decisions: [
          { nudgeId: gapId, action: 'close', basis: 'record', confidence: 'high', reason: 'moot' },
        ],
      })) as { accepted: number };
      expect(reply.accepted).toBe(1);
      return { text: '', turns: 1, calls: [{ turn: 1, name: 'submit_plan', args: {}, ok: true, result: 'ok' }] };
    };
    const summary = await runPlanner(t0, 'live', {
      listTenants: async () => [t.id],
      tools: [...TEAM_LEAD_TOOL_SCHEMAS],
      execute: (tid, name, args) =>
        dispatchForIdentity(name, args, { tenantId: tid, technicianRef: TEAM_LEAD_REF }),
      runLoop: stubLoop,
    });
    expect(summary.applied).toBe(1);

    // Cross-channel read-back: the durable row says CANCELLED (the status the
    // sweep's moot wrote), with code's own words as the resolution.
    const { rows: [after] } = await pg.query(
      'select status, resolution from nudges where id = $1', [gapId],
    );
    expect(after.status).toBe('cancelled');
    expect(after.resolution).toBe(
      'closed on the record — the visit was cancelled — nothing left to ask',
    );
  });
});

describe('runArc — a scripted gap life (Phase 2)', () => {
  // BUILD 6 PHASE 1 rewrote this arc's ending. It used to run
  // leave → capture → ESCALATE (its own handoff) → manager_resolve, and every
  // one of those last three hops died with the verb. The arc's real subject was
  // never escalation: it is that a capture landing BETWEEN two ticks reaches the
  // second tick's prompt and can end the gap. So the ending is now the honest
  // one — the planner reads the note it was waiting for and CLOSES on it.
  test('leave → mid-arc capture → close on the words that landed', async () => {
    const t = await createTenant(`Eval PlannerSimArc ${Date.now()}`);
    await pg.query(`update tenants set timezone = $2 where id = $1`, [t.id, SIM_TZ]);
    const t0 = simStartIso(10);
    const t0Ms = Date.parse(t0);

    const world: ScenarioWorld = {
      customer: { name: 'Rosa Alvarez' },
      job: { title: 'Water heater relight', status: 'in_progress' },
      technician: { ref: 'arc-tech', name: 'Dee Marsh' },
      visit: { startsAt: '-6h', endsAt: '-5h' },
      nudges: [
        {
          key: 'gap',
          kind: 'overdue_visit_gap',
          status: 'asked',
          createdAt: '-4h',
          askedAt: '-3h',
          question: 'How did the relight at Rosa Alvarez go?',
        },
      ],
    };
    const CAPTURE = 'Pilot is lit, swapped the thermocouple while I was there.';
    const timeline: TimelineStep[] = [
      { at: '+0h', kind: 'tick' }, // stub leaves (watching)
      { at: '+4h', kind: 'capture', text: CAPTURE },
      { at: '+5h', kind: 'tick' }, // stub closes on the capture — the gap ends HERE
      { at: '+5.5h', kind: 'tick' }, // nothing left open — recorded as skipped
    ];

    let tickNo = 0;
    const stubLoop: typeof runToolLoop = async (req, _tools, execute) => {
      tickNo += 1;
      if (tickNo === 2) {
        // The mid-arc capture must be visible to the SECOND tick's prompt.
        expect(req.user).toContain('thermocouple');
      }
      const plan =
        tickNo === 1
          ? { decisions: [{ nudgeId: reqGapId(req.user), action: 'leave', confidence: 'high', reason: 'stub wait' }] }
          : tickNo === 2
            ? { decisions: [{ nudgeId: reqGapId(req.user), action: 'close', basis: 'evidence', citation: CAPTURE, confidence: 'high', reason: 'stub: the note answers it' }] }
            : { decisions: [] };
      await execute('submit_plan', plan);
      return { text: '', turns: 1, calls: [{ turn: 1, name: 'submit_plan', args: {}, ok: true, result: 'ok' }] };
    };
    // The gap id, read from the rendered block — the stub has no other channel.
    const reqGapId = (user: string): string => /gap ([0-9a-f-]{36})/.exec(user)![1];

    const arc = await runArc(t.id, { world, timeline }, t0Ms, { runLoop: stubLoop });

    // Tick 1: leave applied; the clock strictly advanced between ticks.
    // TWO ticks run, not three: the close at tick 2 ends the gap, so the +5.5h
    // tick finds nothing open and is recorded skipped.
    expect(arc.ticks).toHaveLength(2);
    expect(arc.ticksSkipped).toBe(1);
    expect(arc.ticks[0].decisions.map((d) => `${d.action}/${d.outcome}`)).toContain('leave/applied');
    expect(Date.parse(arc.ticks[1].nowIso)).toBeGreaterThan(Date.parse(arc.ticks[0].nowIso));

    // Tick 2: the close applied, and the row really ended — 'answered', with
    // the technician's own words as the durable audit line.
    expect(arc.ticks[1].decisions.map((d) => `${d.action}/${d.outcome}`)).toContain('close/applied');
    const afterTick2 = arc.ticks[1].nudgesAfter[0];
    expect(afterTick2.status).toBe('answered');
    expect(afterTick2.resolution).toBe(`answered — "${CAPTURE}"`);
    expect(new Date(afterTick2.resolved_at!).toISOString()).toBe(arc.ticks[1].nowIso); // sim-stamped

    // NOTHING reached the manager's queue. That is the build-6 fact, and it is
    // worth asserting rather than assuming: the planner has no verb that files
    // an item any more, so an item appearing here would mean one came back.
    const { rows: items } = await pg.query(
      `select id from review_items where tenant_id = $1`, [t.id],
    );
    expect(items).toHaveLength(0);
    //
    // (The manager_resolve step and its assertions stood here — the arc's
    // fourth timeline hop settled the escalated item at +6h. The step KIND
    // survives in plannerSim.ts for historic scripts; nothing the planner can
    // do produces an item for it to settle.)
  });

  test('a backwards timeline throws before touching the world', async () => {
    const t = await createTenant(`Eval PlannerSimBackwards ${Date.now()}`);
    await pg.query(`update tenants set timezone = $2 where id = $1`, [t.id, SIM_TZ]);
    const t0Ms = Date.parse(simStartIso(10));
    const world = SMOKE_SCENARIOS[0].world;
    const timeline: TimelineStep[] = [
      { at: '+1h', kind: 'tick' },
      { at: '+0h', kind: 'tick' },
    ];
    await expect(
      runArc(t.id, { world, timeline }, t0Ms, {
        runLoop: async () => ({ text: '', turns: 1, calls: [] }),
      }),
    ).rejects.toThrow(/timeline regressed/);
  });
});


// ── plan 2026-08-31: the pre-ask world through one production-faithful tick ──
describe('runTick over an observation-seeded world (plan 2026-08-31)', () => {
  test('a pending-seed world becomes an observation; a stub-driven send creates the ask, same id', async () => {
    const t = await createTenant(`Eval PlannerSimObs ${Date.now()}`);
    await pg.query(`update tenants set timezone = $2 where id = $1`, [t.id, SIM_TZ]);
    const t0 = simStartIso(10);
    const t0Ms = Date.parse(t0);
    const world: ScenarioWorld = {
      customer: { name: 'Obs Smoke Co' },
      job: { title: 'Water heater flush', status: 'in_progress' },
      technician: { ref: `obs-smoke-${Date.now()}`, name: 'Sam Obs' },
      visit: { startsAt: '-6h', endsAt: '-4h' },
      nudges: [{ key: 'gap', kind: 'overdue_visit_gap', status: 'pending', createdAt: '-2h' }],
    };
    const seeded = await seedScenario(t.id, world, t0Ms);
    const gapId = seeded.nudgeIds.gap;

    // The seed really is an observation, not a relic nudge.
    const pre = await pg.query(`select status from observations where id = $1`, [gapId]);
    expect(pre.rows[0]?.status).toBe('open');
    const preNudge = await pg.query(`select 1 from nudges where id = $1`, [gapId]);
    expect(preNudge.rows).toHaveLength(0);

    const stubLoop: typeof runToolLoop = async (req, _tools, execute) => {
      expect(req.user).toContain(`gap ${gapId}`);
      expect(req.user).toContain('state: noticed');
      const reply = (await execute('submit_plan', {
        decisions: [
          {
            nudgeId: gapId,
            action: 'send',
            question: 'How did the water heater flush go?',
            confidence: 'high',
            reason: 'stub: worth asking now',
          },
        ],
      })) as { accepted: number };
      expect(reply.accepted).toBe(1);
      return {
        text: '',
        turns: 1,
        calls: [{ turn: 1, name: 'submit_plan', args: {}, ok: true, result: JSON.stringify(reply) }],
      };
    };

    const tick = await runTick(t.id, t0, { runLoop: stubLoop });
    // The ask exists, born queued, SAME id — and the readback presents one
    // id-space: the send decision carries the gap id in nudge_id.
    const sent = tick.nudgesAfter.find((n) => n.id === gapId);
    expect(sent?.status).toBe('queued');
    const sendRow = tick.decisions.find((d) => d.action === 'send');
    expect(sendRow?.nudge_id).toBe(gapId);
    expect(sendRow?.outcome).toBe('applied');
    // The observation is stamped asked and no pseudo-row shadows the nudge.
    const post = await pg.query(`select status from observations where id = $1`, [gapId]);
    expect(post.rows[0]?.status).toBe('asked');
    expect(tick.nudgesAfter.filter((n) => n.id === gapId)).toHaveLength(1);
  }, 60_000);

  test('a dismissed observation joins nudgesAfter as a terminal pseudo-row and stops counting as open', async () => {
    const t = await createTenant(`Eval PlannerSimDismiss ${Date.now()}`);
    await pg.query(`update tenants set timezone = $2 where id = $1`, [t.id, SIM_TZ]);
    const t0 = simStartIso(10);
    const t0Ms = Date.parse(t0);
    const world: ScenarioWorld = {
      customer: { name: 'Dismiss Smoke Co' },
      job: { title: 'Filter swap', status: 'in_progress' },
      technician: { ref: `dis-smoke-${Date.now()}`, name: 'Dee Obs' },
      visit: { startsAt: '-6h', endsAt: '-4h' },
      nudges: [{ key: 'gap', kind: 'overdue_visit_gap', status: 'pending', createdAt: '-2h' }],
    };
    const seeded = await seedScenario(t.id, world, t0Ms);
    const gapId = seeded.nudgeIds.gap;
    const stubLoop: typeof runToolLoop = async (_req, _tools, execute) => {
      await execute('submit_plan', {
        decisions: [
          { nudgeId: gapId, action: 'dismiss', confidence: 'high', reason: 'stub: routine, nothing riding' },
        ],
      });
      return { text: '', turns: 1, calls: [] };
    };
    const tick = await runTick(t.id, t0, { runLoop: stubLoop });
    const row = tick.nudgesAfter.find((n) => n.id === gapId);
    expect(row?.status).toBe('dismissed');
    // The dismissal's sim-clock fix-up landed: the stamp is sim-now, not wall-now.
    const db = await pg.query(`select dismissed_at from observations where id = $1`, [gapId]);
    expect(new Date(db.rows[0].dismissed_at).toISOString()).toBe(t0);
  }, 60_000);
});
