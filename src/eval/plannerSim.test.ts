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
            action: 'extend',
            escalateAfter: atOffset(t0Ms, '+6h'),
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
    // The seeded gap is not fresh (subject_ref dedup) and not yet due — the
    // sweep must neither escalate nor open items on tick 1.
    expect(tick.watchers.nudgesEscalated).toBe(0);
    expect(tick.watchers.itemsOpened).toBe(0);
    expect(tick.planner.planned).toBe(1);
    expect(tick.planner.applied).toBe(1);
    expect(tick.userPrompt).toContain('open gap');
    expect(tick.toolCalls.map((c) => c.name)).toContain('submit_plan');

    const extend = tick.decisions.find((d) => d.action === 'extend');
    expect(extend).toBeDefined();
    expect(extend!.outcome).toBe('applied');
    // THE FIX-UP: the DB stamped the real wall clock; the record must read
    // sim-now, or watchers' plannerAlive misreads any >24h arc.
    expect(new Date(extend!.decided_at).toISOString()).toBe(t0);
    const { rows } = await pg.query(`select decided_at from nudge_decisions where id = $1`, [
      extend!.id,
    ]);
    expect(new Date(rows[0].decided_at).toISOString()).toBe(t0);

    // The applied extend moved the row's deadline.
    const after = tick.nudgesAfter.find((n) => n.id === gapId);
    expect(after?.escalate_after && new Date(after.escalate_after).toISOString()).toBe(
      atOffset(t0Ms, '+6h'),
    );
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

describe('runArc — a scripted gap life (Phase 2)', () => {
  test('extend → mid-arc capture → escalate → sweep handoff → manager resolve → ⑤ epilogue', async () => {
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
    const timeline: TimelineStep[] = [
      { at: '+0h', kind: 'tick' }, // stub extends to +26h
      { at: '+4h', kind: 'capture', text: 'Pilot is lit, swapped the thermocouple while I was there.' },
      { at: '+5h', kind: 'tick' }, // stub escalates (brings deadline to now)
      { at: '+5.5h', kind: 'tick' }, // sweep performs the handoff; stub sees zero gaps
      { at: '+6h', kind: 'manager_resolve', nudgeKey: 'gap', outcome: 'resolved', note: 'thanked Dee' },
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
          ? { decisions: [{ nudgeId: reqGapId(req.user), action: 'extend', escalateAfter: atOffset(t0Ms, '+26h'), confidence: 'high', reason: 'stub extend' }] }
          : tickNo === 2
            ? { decisions: [{ nudgeId: reqGapId(req.user), action: 'escalate', confidence: 'high', reason: 'stub escalate', handoffNote: 'Water heater relight (Rosa Alvarez) — needs a decision on the thermocouple note.' }] }
            : { decisions: [] };
      await execute('submit_plan', plan);
      return { text: '', turns: 1, calls: [{ turn: 1, name: 'submit_plan', args: {}, ok: true, result: 'ok' }] };
    };
    // The gap id, read from the rendered block — the stub has no other channel.
    const reqGapId = (user: string): string => /gap ([0-9a-f-]{36})/.exec(user)![1];

    const arc = await runArc(t.id, { world, timeline }, t0Ms, { runLoop: stubLoop });

    // Tick 1: extend applied; the clock strictly advanced between ticks.
    expect(arc.ticks).toHaveLength(3);
    expect(arc.ticks[0].decisions.map((d) => `${d.action}/${d.outcome}`)).toContain('extend/applied');
    expect(Date.parse(arc.ticks[1].nowIso)).toBeGreaterThan(Date.parse(arc.ticks[0].nowIso));

    // Tick 2: escalate applied (deadline pulled to now) — the handoff itself
    // happens on the NEXT sweep, which is the production shape.
    expect(arc.ticks[1].decisions.map((d) => `${d.action}/${d.outcome}`)).toContain('escalate/applied');
    const afterTick2 = arc.ticks[1].nudgesAfter[0];
    expect(afterTick2.status).toBe('asked');

    // Tick 3: the sweep performed the handoff — status escalated, item open.
    expect(arc.ticks[2].watchers.nudgesEscalated).toBe(1);
    const afterTick3 = arc.ticks[2].nudgesAfter[0];
    expect(afterTick3.status).toBe('escalated');
    expect(new Date(afterTick3.resolved_at!).toISOString()).toBe(arc.ticks[2].nowIso); // sim-stamped
    const { rows: items } = await pg.query(
      `select status, resolved_at, detail->>'escalatedFromNudge' as from_nudge from review_items where tenant_id = $1`,
      [t.id],
    );
    expect(items).toHaveLength(1);
    expect(items[0].from_nudge).toBe(arc.seeded.nudgeIds.gap);
    // The manager_resolve step settled it at sim +6h.
    expect(items[0].status).toBe('resolved');
    expect(new Date(items[0].resolved_at).toISOString()).toBe(atOffset(t0Ms, '+6h'));

    // The ⑤ epilogue escaped the holdback (item no longer open) and reads the arc.
    expect(arc.epilogue.summaries).toHaveLength(1);
    const s = arc.epilogue.summaries[0];
    expect(s.escalated).toBe(true);
    expect(s.status).toBe('escalated');
    expect(s.manager_fate).toBe('resolved');
    expect(s.manager_latency_wh).not.toBeNull();
    expect(new Date(s.closed_at).toISOString()).toBe(arc.ticks[2].nowIso);
    const arcCounts = s.arc as Record<string, number>;
    expect(arcCounts.extend).toBe(1);
    expect(arcCounts.escalate).toBe(1);
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
