import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { focusedPassBlockedBy, runFocusedObservationPass, runPlannerPass } from './plannerPass.js';
import type { PlannerDeps, PlannerSummary } from '../teamLead/planner.js';
import type { Observation } from '../db/index.js';

// This module decides TWO things nothing else can: whether a focused pass may
// run at all (the ping loop claims a row on the strength of that answer, and
// nothing releases a claim), and what the planner is allowed to see and touch
// when it does. Both are pure wiring, so both are testable without a database
// — and neither was covered until this file existed.

const obs = (over: Partial<Observation> = {}): Observation =>
  ({
    id: 'obs-1',
    tenant_id: 'tenant-1',
    kind: 'inbound_commitment',
    subject_ref: 'cap-1',
    technician_id: null,
    author: 'detector',
    context: {},
    status: 'open',
    dismiss_reason: null,
    dismissed_at: null,
    not_before: null,
    pinged_at: null,
    asked_at: null,
    noticed_at: '2026-09-07T10:00:00.000Z',
    updated_at: '2026-09-07T10:00:00.000Z',
    ...over,
  }) as unknown as Observation;

const EMPTY: PlannerSummary = {
  mode: 'live',
  tenants: 0,
  planned: 0,
  skippedNoGaps: 0,
  skippedCadence: 0,
  decisions: 0,
  dropped: 0,
  applied: 0,
  refusedAtApply: 0,
  recorded: 0,
  tenantErrors: 0,
  limitHits: { budget: 0, turns: 0 },
  byAction: {},
  plans: [],
};

// Capture what the wrapper hands the planner, without running one.
const spyImpl = (seen: { deps?: PlannerDeps; mode?: string }) =>
  (async (_now: string, mode: string, deps: PlannerDeps = {}) => {
    seen.mode = mode;
    seen.deps = deps;
    return EMPTY;
  }) as unknown as Parameters<typeof runPlannerPass>[3];

describe('focusedPassBlockedBy', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.PLANNER_MODE = 'live';
    process.env.INFERENCE_API_KEY = 'test-key';
    delete process.env.INFERENCE_MODEL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  test('an unset or off PLANNER_MODE blocks — a worker deployed before its env must not plan', () => {
    delete process.env.PLANNER_MODE;
    expect(focusedPassBlockedBy()).toContain('PLANNER_MODE');
    process.env.PLANNER_MODE = 'off';
    expect(focusedPassBlockedBy()).toContain('PLANNER_MODE');
    // A typo is 'off' here rather than a loud error: the heartbeat is where a
    // bad value turns the run red, and two processes shouting about one
    // misconfiguration is one too many.
    process.env.PLANNER_MODE = 'liv';
    expect(focusedPassBlockedBy()).toContain('PLANNER_MODE');
  });

  test('missing credentials block', () => {
    delete process.env.INFERENCE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(focusedPassBlockedBy()).toBe('no inference credentials');
  });

  test('a SEAT model blocks — the Calls-worker carries its own INFERENCE_MODEL now', () => {
    // The heartbeat turns red on this; nothing else would catch it here.
    process.env.INFERENCE_MODEL = 'google/gemini-3.8-flash';
    const why = focusedPassBlockedBy();
    expect(why).not.toBeNull();
    expect(why).not.toContain('PLANNER_MODE');
  });

  test('a live, credentialled, correctly-modelled worker is not blocked', () => {
    expect(focusedPassBlockedBy()).toBeNull();
  });
});

describe('runFocusedObservationPass', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.PLANNER_MODE = 'live';
    process.env.INFERENCE_API_KEY = 'test-key';
    delete process.env.INFERENCE_MODEL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  test('a blocked worker runs NOTHING and says why', async () => {
    process.env.PLANNER_MODE = 'off';
    const seen: { deps?: PlannerDeps } = {};
    const out = await runFocusedObservationPass(obs(), spyImpl(seen));
    expect(out).toEqual({ skipped: "PLANNER_MODE 'off'" });
    expect(seen.deps).toBeUndefined();
  });

  test('the pass is scoped to ONE item, and to work it was actually shown', async () => {
    const seen: { deps?: PlannerDeps; mode?: string } = {};
    const row = obs();
    await runFocusedObservationPass(row, spyImpl(seen), 180_000);
    const deps = seen.deps as PlannerDeps;
    expect(seen.mode).toBe('live');
    expect(deps.focus).toEqual({ observationId: 'obs-1', budgetMs: 180_000 });
    // ONE ITEM: the nudge reader and the observation reader together ARE the
    // gap list, so emptying one and pinning the other is the scoping.
    expect(await deps.listObservations?.('tenant-1', ['open'])).toEqual([row]);
    expect(await deps.listNudges?.('tenant-1', [])).toEqual([]);
    // The firm's other traffic is not this call's business, and CONSUMING it
    // here would mark it read.
    expect(await deps.listOfficeMessages?.('tenant-1', 'to_planner', ['unread'])).toEqual([]);
    expect(await deps.listDeskTranscripts?.('tenant-1', '')).toEqual([]);
    // NOTHING UNSHOWN MAY BE MUTATED: `recover` is validated against these
    // sets, not against the gaps on screen, so an unscoped read would let a
    // pass about one call un-dismiss any gap in the firm.
    expect(await deps.listDismissedIds?.('tenant-1')).toEqual([]);
    expect(await deps.listDismissedNudges?.('tenant-1')).toEqual([]);
    // The tools ride — a focused pass is the same planner, not a lesser one.
    expect((deps.tools ?? []).length).toBeGreaterThan(0);
    expect(typeof deps.execute).toBe('function');
    // NOT overridden: focus mode skips the run marker inside runPlanner itself,
    // and a stub here would hide that.
    expect(deps.plannerRun).toBeUndefined();
  });

  test('an INELIGIBLE firm yields no tenants — office rows nothing delivers are never queued', async () => {
    const seen: { deps?: PlannerDeps } = {};
    await runFocusedObservationPass(obs({ tenant_id: 'no-binding' }), spyImpl(seen));
    // listTenants filters the REAL eligibility read (firms with a Telegram
    // binding) down to this observation's tenant. The local stack's seed firm
    // is not 'no-binding', so the filter empties and the pass does nothing.
    expect(await seen.deps?.listTenants?.()).toEqual([]);
  });

  test('the default budget is three minutes — it runs inside the call worker s loop', async () => {
    const seen: { deps?: PlannerDeps } = {};
    await runFocusedObservationPass(obs(), spyImpl(seen));
    expect(seen.deps?.focus?.budgetMs).toBe(180_000);
  });
});

describe('runPlannerPass', () => {
  test('every caller gets the SAME tool surface and executor', async () => {
    const seen: { deps?: PlannerDeps } = {};
    await runPlannerPass('2026-09-07T12:00:00.000Z', 'shadow', {}, spyImpl(seen));
    expect((seen.deps?.tools ?? []).length).toBeGreaterThan(0);
    expect(typeof seen.deps?.execute).toBe('function');
  });

  test('extra deps override the wiring, so a caller can scope what it hands over', async () => {
    const seen: { deps?: PlannerDeps } = {};
    await runPlannerPass('2026-09-07T12:00:00.000Z', 'shadow', { tools: [] }, spyImpl(seen));
    expect(seen.deps?.tools).toEqual([]);
  });
});
