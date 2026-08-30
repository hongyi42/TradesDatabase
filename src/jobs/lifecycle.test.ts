import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Technician } from '../db/technicians.js';
import { redactForRecord, runLifecycle } from './lifecycle.js';
import type { PlannerDeps } from '../teamLead/planner.js';

// Pure unit tests â€” every step injected. The exit-code contract is `ok`
// (main() maps ok:false â†’ exit 1 so Render marks the run failed).

// The test setup loads .env, which legitimately carries
// DEFAULT_TENANT_ID / COMPOSIO_API_KEY â€” clear them BEFORE each test (not just
// after), or the sessions gate would sweep against LIVE Composio.
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  // WATCHERS_MODE cleared for the same reason as COMPOSIO_API_KEY: .env may
  // carry it, and the default runWatchers dep would hit the real database.
  for (const k of ['DEFAULT_TENANT_ID', 'COMPOSIO_API_KEY', 'WATCHERS_MODE', 'NUDGES_MODE', 'PLANNER_MODE', 'LIFECYCLE_RUN_RETENTION_DAYS'] as const) {
    if (!(k in saved)) saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const NOW = '2026-07-02T12:00:00.000Z';

function row(over: Partial<Technician>): Technician {
  return {
    id: 'r1',
    tenant_id: 't1',
    ref: 'someone',
    display_name: 'Someone',
    tier: 'technician',
    state: 'invited',
    sandbox_ref: null,
    composio_connected_account_id: null,
    composio_trigger_id: null,
    connected_email: null,
    badge_hash: null,
    host_id: null,
    offboarding_started_at: null,
    link_issued_at: '2026-07-02T11:00:00.000Z',
    composio_session_id: null,
    availability: null,
    service_cities: [],
    telegram_user_id: null,
    seat_exempt: false,
    skills: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

const EXPIRE_OK = { scanned: 0, stamped: 0, reminded: 0, expired: 0, raced: 0, failed: 0, sessionsCleaned: 0 };
const INGEST_OK = {
  scanned: 0,
  captured: 0,
  skippedReads: 0,
  skippedNonComposite: 0,
  skippedTechnicianSends: 0,
  deduped: 0,
  rowErrors: 0,
};

// The cost steps AND the run-record prune default to REAL database accessors, so
// every runLifecycle call here must inject them. Otherwise this "pure unit tests"
// file quietly starts writing to the database on each of the calls below.
const COST_STUBS = {
  backfillBrave: async () => ({ scanned: 0 }),
  latestBrave: async () => null,
  rollup: async () => ({ rowsWritten: 0, tenantsTouched: 0, unpricedEvents: 0 }),
  // Not a cost step, but the same hazard and the same fix: pruneLifecycleRuns
  // is a real DELETE against whatever stack DATABASE_URL points at.
  prune: async () => 0,
};

describe('runLifecycle', () => {
  test('sweeps only rows with a link issued; counts paired', async () => {
    const checked: string[] = [];
    const summary = await runLifecycle(NOW, {
      ...COST_STUBS,
      listInStates: async () => [
        row({ ref: 'linked', link_issued_at: '2026-07-02T11:00:00.000Z' }),
        row({ id: 'r2', ref: 'never-linked', link_issued_at: null }),
      ],
      checkPairing: async (t) => {
        checked.push(t.ref);
        return { status: 'paired', connectedAccountId: 'ca_x', email: 'x@y.z' };
      },
      expire: async () => EXPIRE_OK,
    });
    expect(checked).toEqual(['linked']); // never-linked rows are not swept
    expect(summary.pairing).toEqual({ checked: 1, paired: 1, rowErrors: 0 });
    expect(summary.ok).toBe(true);
  });

  // Between this phase merging and the migration reaching the pilot, the cost
  // tables simply do not exist there. main() exits 1 on ok:false and Render
  // marks the run FAILED, so treating that as an error would alarm every 15
  // minutes for a condition that resolves itself. Same shape as the existing
  // COMPOSIO_API_KEY skip gates.
  describe('cost steps', () => {
    // The REAL shape: the accessors wrap the PostgrestError and attach it as
    // `cause`, so the structured code travels with the error. A bare message
    // saying "does not exist" is deliberately NOT enough — that text also
    // appears on a half-applied migration or a botched rename, and swallowing
    // those would leave a green cron and an empty ledger forever.
    const missing = new Error('rollupCosts failed: …', { cause: { code: 'PGRST202' } });
    const missingTable = new Error('backfill failed: …', { cause: { code: '42P01' } });

    // Same contract for the run-record prune: this code can deploy before its
    // migration is applied by hand, and a heartbeat that goes red every 15
    // minutes for a self-resolving condition trains people to ignore it.
    test('a not-yet-migrated lifecycle_runs is SKIPPED, not an error', async () => {
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        listInStates: async () => [],
        expire: async () => EXPIRE_OK,
        prune: async () => {
          throw missingTable;
        },
      });
      expect(summary.lifecycleRuns).toEqual({ skipped: 'lifecycle_runs not migrated here yet' });
      expect(summary.ok).toBe(true);
    });

    test('a REAL prune failure is loud', async () => {
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        listInStates: async () => [],
        expire: async () => EXPIRE_OK,
        prune: async () => {
          throw new Error('connection reset');
        },
      });
      expect(summary.lifecycleRuns).toEqual({ stepError: 'connection reset' });
      expect(summary.ok).toBe(false);
    });

    test('the prune keeps the heavy-tick cadence — an off-cadence tick never deletes', async () => {
      let pruned = 0;
      const deps = {
        ...COST_STUBS,
        listInStates: async () => [],
        expire: async () => EXPIRE_OK,
        prune: async () => {
          pruned += 1;
          return 0;
        },
      };
      await runLifecycle('2026-07-02T12:05:00.000Z', deps); // off-cadence
      expect(pruned).toBe(0);
      const on = await runLifecycle(NOW, deps);
      expect(pruned).toBe(1);
      expect(on.lifecycleRuns).toMatchObject({ pruned: 0 });
    });

    // 90 days back from the tick's own clock — not from "now", which on a
    // replayed or delayed tick would silently prune a different window.
    test('the cutoff is 90 days before the TICK, and is overridable', async () => {
      const seen: string[] = [];
      const deps = {
        ...COST_STUBS,
        listInStates: async () => [],
        expire: async () => EXPIRE_OK,
        prune: async (before: string) => {
          seen.push(before);
          return 0;
        },
      };
      await runLifecycle(NOW, deps);
      expect(seen[0]).toBe('2026-04-03T12:00:00.000Z');

      process.env.LIFECYCLE_RUN_RETENTION_DAYS = '7';
      await runLifecycle(NOW, deps);
      expect(seen[1]).toBe('2026-06-25T12:00:00.000Z');

      // A nonsense value must not widen the delete to everything.
      process.env.LIFECYCLE_RUN_RETENTION_DAYS = 'soon';
      await runLifecycle(NOW, deps);
      expect(seen[2]).toBe('2026-04-03T12:00:00.000Z');
      delete process.env.LIFECYCLE_RUN_RETENTION_DAYS;
    });

    test('a not-yet-migrated ledger is SKIPPED, not an error', async () => {
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        listInStates: async () => [],
        expire: async () => EXPIRE_OK,
        backfillBrave: async () => { throw missingTable; },
        rollup: async () => { throw missing; },
      });
      expect(summary.braveBackfill).toEqual({ skipped: 'cost ledger not migrated here yet' });
      expect(summary.costRollup).toEqual({ skipped: 'cost ledger not migrated here yet' });
      expect(summary.ok).toBe(true); // the cron stays green
    });

    // A codeless "does not exist" is a REAL fault — a half-applied migration, a
    // renamed column — and must go red rather than be mistaken for "not migrated".
    test('a codeless "does not exist" is treated as a real fault, not a skip', async () => {
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        listInStates: async () => [],
        expire: async () => EXPIRE_OK,
        rollup: async () => { throw new Error('column cost_events.occurred_at does not exist'); },
      });
      expect(summary.costRollup).toHaveProperty('stepError');
      expect(summary.ok).toBe(false);
    });

    test('a GENUINE fault still fails the run', async () => {
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        listInStates: async () => [],
        expire: async () => EXPIRE_OK,
        rollup: async () => { throw new Error('connection terminated unexpectedly'); },
      });
      expect(summary.costRollup).toEqual({ stepError: 'connection terminated unexpectedly' });
      expect(summary.ok).toBe(false);
      // …and the earlier steps still reported normally.
      expect(summary.pairing).toEqual({ checked: 0, paired: 0, rowErrors: 0 });
      expect(summary.braveBackfill).toMatchObject({ scanned: 0 });
    });

    // Invoices arrive AFTER the month they cover: a July inference bill is
    // entered in August. A current-month-only rollup would therefore never
    // allocate a completed month's inference cost — the whole allocated-cost
    // mechanism would silently produce nothing for every settled month.
    test('rolls up the previous month as well as the current one', async () => {
      const months: string[] = [];
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        listInStates: async () => [],
        expire: async () => EXPIRE_OK,
        rollup: async (month: string) => {
          months.push(month);
          return { rowsWritten: 2, tenantsTouched: 1, unpricedEvents: 3 };
        },
      });
      expect(months).toEqual(['2026-07-01', '2026-06-01']); // NOW is 2026-07-02
      expect(summary.costRollup).toEqual({
        months: ['2026-07-01', '2026-06-01'],
        rowsWritten: 4,
        tenantsTouched: 1,
        unpricedEvents: 6, // surfaced so a price-book gap is visible in the log
      });
    });

    test('previous-month arithmetic crosses a year boundary', async () => {
      const months: string[] = [];
      await runLifecycle('2026-01-09T00:00:00.000Z', {
        ...COST_STUBS,
        listInStates: async () => [],
        expire: async () => EXPIRE_OK,
        rollup: async (m: string) => { months.push(m); return { rowsWritten: 0, tenantsTouched: 0, unpricedEvents: 0 }; },
      });
      expect(months).toEqual(['2026-01-01', '2025-12-01']);
    });

    // A fixed look-back window would bill only the last few hours on the first
    // run after the migration and abandon everything already in web_requests.
    test('the backfill sweeps from the beginning when the ledger is empty', async () => {
      const sinces: string[] = [];
      await runLifecycle(NOW, {
        ...COST_STUBS,
        listInStates: async () => [],
        expire: async () => EXPIRE_OK,
        latestBrave: async () => null,
        backfillBrave: async (since: string) => { sinces.push(since); return { scanned: 7 }; },
      });
      expect(sinces).toEqual(['2026-07-01T00:00:00.000Z']);
    });

    test('the backfill resumes from the watermark, with an overlap', async () => {
      const sinces: string[] = [];
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        listInStates: async () => [],
        expire: async () => EXPIRE_OK,
        latestBrave: async () => '2026-07-02T09:00:00.000Z',
        backfillBrave: async (since: string) => { sinces.push(since); return { scanned: 2 }; },
      });
      expect(sinces).toEqual(['2026-07-02T08:00:00.000Z']); // 1h overlap
      expect(summary.braveBackfill).toEqual({ scanned: 2, since: '2026-07-02T08:00:00.000Z' });
    });
  });

  describe('watchers (step 8) + the cadence gate', () => {
    const WATCH_OK = {
      mode: 'shadow' as const,
      tenants: 1,
      gapsFound: 2,
      freshGaps: 1,
      itemsOpened: 0,
      itemsResolved: 0,
      pushed: 0,
      pushSkipped: false,
      tenantErrors: 0,
      nudgeMode: 'off' as const,
      nudgesWouldCreate: 0,
      nudgesCreated: 0,
      nudgesResolved: 0,
      nudgesAutoClosed: 0,
      nudgesEscalated: 0,
      nudgesExpired: 0,
        byKind: {},
    };
    const BASE = {
      listInStates: async () => [],
      expire: async () => EXPIRE_OK,
    };

    test('WATCHERS_MODE unset → skipped; the real dep is never called', async () => {
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        runWatchers: async () => {
          throw new Error('unit test must not reach the watcher when the mode is unset');
        },
      });
      expect(summary.watchers).toEqual({ skipped: 'WATCHERS_MODE unset (shadow|live)' });
      expect(summary.ok).toBe(true);
    });

    test('an invalid WATCHERS_MODE is a LOUD stepError — a typo must never read as off', async () => {
      process.env.WATCHERS_MODE = 'shdaow';
      let called = false;
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        runWatchers: async () => {
          called = true;
          return WATCH_OK;
        },
      });
      expect(called).toBe(false);
      expect(summary.watchers).toEqual({
        stepError: "WATCHERS_MODE must be 'shadow' or 'live', got 'shdaow'",
      });
      expect(summary.ok).toBe(false);
    });

    test('shadow and live pass through to the dep with the run nowIso; unset NUDGES_MODE rides as off', async () => {
      const calls: Array<[string, string, string]> = [];
      for (const mode of ['shadow', 'live'] as const) {
        process.env.WATCHERS_MODE = mode;
        const summary = await runLifecycle(NOW, {
          ...COST_STUBS,
          ...BASE,
          runWatchers: async (nowIso, m, _deps, nudgeMode) => {
            calls.push([nowIso, m, nudgeMode ?? 'MISSING']);
            return { ...WATCH_OK, mode };
          },
        });
        expect(summary.watchers).toMatchObject({ mode, gapsFound: 2 });
        expect(summary.ok).toBe(true);
      }
      expect(calls).toEqual([
        [NOW, 'shadow', 'off'],
        [NOW, 'live', 'off'],
      ]);
    });

    test('NUDGES_MODE gates the ladder: shadow/live pass through; a typo is a LOUD stepError', async () => {
      process.env.WATCHERS_MODE = 'live';
      const nudgeModes: string[] = [];
      for (const nm of ['shadow', 'live'] as const) {
        process.env.NUDGES_MODE = nm;
        const summary = await runLifecycle(NOW, {
          ...COST_STUBS,
          ...BASE,
          runWatchers: async (_nowIso, _m, _deps, nudgeMode) => {
            nudgeModes.push(nudgeMode ?? 'MISSING');
            return { ...WATCH_OK, mode: 'live' as const, nudgeMode: nm };
          },
        });
        expect(summary.ok).toBe(true);
      }
      expect(nudgeModes).toEqual(['shadow', 'live']);

      // The typo: watchers step errors, dep never called — a half-typed
      // rollout must not silently run with the ladder off.
      process.env.NUDGES_MODE = 'lvie';
      let called = false;
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        runWatchers: async () => {
          called = true;
          return WATCH_OK;
        },
      });
      expect(called).toBe(false);
      expect(summary.watchers).toEqual({
        stepError: "NUDGES_MODE must be 'shadow' or 'live' when set, got 'lvie'",
      });
      expect(summary.ok).toBe(false);
    });

    // Build 1b. Until this existed the planner was the only step with no
    // systemic detector: runPlanner catches per tenant, so it returns normally
    // however badly a firm did, and a firm burning the whole 15-minute clock
    // every half hour left every lifecycle row reading ok:true — green forever
    // with nothing working. `ok` is what becomes exit 1, which is what Render
    // shows as a failed run.
    test('step 9: a planner LOOP-LIMIT hit turns the tick red; a lone blip does not', async () => {
      process.env.WATCHERS_MODE = 'live';
      process.env.NUDGES_MODE = 'live';
      process.env.PLANNER_MODE = 'live';

      const plannerSummary = (over: Record<string, unknown>) => ({
        mode: 'live' as const,
        tenants: 2,
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
        ...over,
      });
      const run = (over: Record<string, unknown>) =>
        runLifecycle(NOW, {
          ...COST_STUBS,
          ...BASE,
          runWatchers: async () => ({
            ...WATCH_OK,
            mode: 'live' as const,
            nudgeMode: 'live' as const,
          }),
          runPlanner: async () => plannerSummary(over),
          hasModelKey: () => true,
        });

      // ONE budget hit out of two firms is enough. Waiting for all of them would
      // let a single firm sit in a permanent runaway behind a healthy one.
      const budget = await run({ limitHits: { budget: 1, turns: 0 }, tenantErrors: 1 });
      expect(budget.ok).toBe(false);

      // Same for a turns hit — structurally impossible while the planner passes
      // maxTurns: null, so if it appears the ceiling came back.
      const turns = await run({ limitHits: { budget: 0, turns: 1 }, tenantErrors: 1 });
      expect(turns.ok).toBe(false);

      // A lone provider blip is NOT systemic and must not cry wolf: an alarm
      // that fires on a fault which fixed itself is one people learn to ignore.
      const blip = await run({ tenantErrors: 1 });
      expect(blip.ok).toBe(true);

      // …but every firm failing is, on the same test the watcher sweep uses.
      const allDown = await run({ tenantErrors: 2 });
      expect(allDown.ok).toBe(false);

      // And a clean planner stays green.
      expect((await run({})).ok).toBe(true);
    });

    // The compose step retired with the collapse (plan 2026-08-24). What its
    // gates used to protect is now a VISIBILITY problem: the planner is the only
    // author of a question, so a live ladder with a non-live planner mints gaps
    // nobody will ever ask about. That state must be reported, not silent — and
    // never red, because rolling the planner back is a legitimate choice.
    test('step 10 ladderMute: reported when the ladder can mint gaps but nothing can ask', async () => {
      process.env.WATCHERS_MODE = 'live';
      process.env.NUDGES_MODE = 'live';
      process.env.PLANNER_MODE = 'live';
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Both live → nothing to warn about. runPlanner is INJECTED: this case is
      // the only one in the file that opens every planner gate at once, and an
      // un-injected planner here would make a real billed call and apply real
      // decisions from a unit test (the file's standing rule).
      const healthy = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        runWatchers: async () => ({ ...WATCH_OK, mode: 'live' as const, nudgeMode: 'live' as const }),
        runPlanner: async () => ({
          mode: 'live' as const,
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
        }),
        hasModelKey: () => true,
      });
      expect(healthy.ladderMute).toBeUndefined();
      expect(healthy.ok).toBe(true);

      // Ladder live, planner rolled back, sweep live → mute WITH the backstop.
      process.env.PLANNER_MODE = 'off';
      const mute = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        runWatchers: async () => ({ ...WATCH_OK, mode: 'live' as const, nudgeMode: 'live' as const }),
        hasModelKey: () => true,
      });
      expect(mute.ladderMute).toContain('18h never-asked sweep');
      expect(mute.ok).toBe(true); // a rollback is a choice, not a failure

      // Sweep rolled back too → the harsher wording: no backstop at all.
      process.env.WATCHERS_MODE = 'shadow';
      const noFloor = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        runWatchers: async () => ({ ...WATCH_OK, mode: 'shadow' as const, nudgeMode: 'live' as const }),
        hasModelKey: () => true,
      });
      expect(noFloor.ladderMute).toContain('NO backstop sweep is running');
      expect(noFloor.ok).toBe(true);

      // The OTHER way to be voiceless — planner live, no credentials. It used to
      // surface as compose's own credential skip; with compose gone the mute
      // check is the only thing that names it.
      process.env.WATCHERS_MODE = 'live';
      process.env.PLANNER_MODE = 'live';
      const keyless = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        runWatchers: async () => ({ ...WATCH_OK, mode: 'live' as const, nudgeMode: 'live' as const }),
        hasModelKey: () => false,
      });
      expect(keyless.ladderMute).toContain('no inference credentials');
      expect(keyless.teamLeadPlanner).toEqual({ skipped: 'no inference credentials' });
      expect(keyless.ok).toBe(true);

      expect(spy.mock.calls.some((c: unknown[]) => String(c[0]).includes('LADDER IS MUTE'))).toBe(
        true,
      );
      spy.mockRestore();
    });

    test('a throwing watcher is a stepError, red — the other steps still reported', async () => {
      process.env.WATCHERS_MODE = 'shadow';
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        runWatchers: async () => {
          throw new Error('watcher db unreachable');
        },
      });
      expect(summary.watchers).toEqual({ stepError: 'watcher db unreachable' });
      expect(summary.ok).toBe(false);
      expect(summary.pairing).toEqual({ checked: 0, paired: 0, rowErrors: 0 });
    });

    test('EVERY tenant failing is systemic → red; a partial failure is not', async () => {
      process.env.WATCHERS_MODE = 'live';
      const all = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        runWatchers: async () => ({ ...WATCH_OK, mode: 'live' as const, tenants: 3, tenantErrors: 3 }),
      });
      expect(all.ok).toBe(false);
      const some = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        runWatchers: async () => ({ ...WATCH_OK, mode: 'live' as const, tenants: 3, tenantErrors: 1 }),
      });
      expect(some.ok).toBe(true);
    });

    // The */5 schedule serves the WATCHER lane; steps 1-7 keep their
    // quarter-hour cadence via the stateless minute gate (< 5 tolerates a
    // delayed firing).
    test('cadence gate: quarter-hour ticks (incl. a delayed one) run steps 1-7; off-cadence ticks skip them, step 8 still runs', async () => {
      process.env.WATCHERS_MODE = 'shadow';
      let watched = 0;
      const deps = {
        ...COST_STUBS,
        ...BASE,
        runWatchers: async () => {
          watched += 1;
          return WATCH_OK;
        },
      };

      // :00 (NOW) and a delayed :15 tick firing at :16 → heavy steps run.
      for (const iso of [NOW, '2026-07-02T12:16:00.000Z']) {
        const summary = await runLifecycle(iso, deps);
        expect(summary.pairing).toEqual({ checked: 0, paired: 0, rowErrors: 0 });
        expect(summary.costRollup).toMatchObject({ rowsWritten: 0 });
      }

      // :05 → off-cadence: all seven heavy steps skip; the watcher still runs.
      const off = await runLifecycle('2026-07-02T12:05:00.000Z', {
        ...deps,
        // Sentinels prove the gate short-circuits BEFORE the heavy deps.
        listInStates: async () => {
          throw new Error('off-cadence tick must not sweep the roster');
        },
        expire: async () => {
          throw new Error('off-cadence tick must not run expiry');
        },
      });
      const OFF = { skipped: 'off-cadence tick' };
      expect(off.pairing).toEqual(OFF);
      expect(off.offboarding).toEqual(OFF);
      expect(off.sessions).toEqual(OFF);
      expect(off.logIngest).toEqual(OFF);
      expect(off.braveBackfill).toEqual(OFF);
      expect(off.costRollup).toEqual(OFF);
      expect(off.watchers).toEqual(WATCH_OK);
      expect(off.ok).toBe(true);
      expect(watched).toBe(3); // step 8 ran on every tick, heavy or not
    });
  });

  test('a throwing step is reported and fails the run â€” but the other steps still ran', async () => {
    let expired = false;
    const summary = await runLifecycle(NOW, {
      ...COST_STUBS,
      listInStates: async () => {
        throw new Error('db unreachable');
      },
      expire: async () => {
        expired = true;
        return EXPIRE_OK;
      },
    });
    expect(summary.pairing).toEqual({ stepError: 'db unreachable' });
    expect(expired).toBe(true); // isolation: later steps unaffected
    expect(summary.ok).toBe(false); // â†’ exit 1 â†’ Render marks the run failed
  });

  test('per-row pairing errors are counted, retried next tick, and do NOT fail the run', async () => {
    const summary = await runLifecycle(NOW, {
      ...COST_STUBS,
      listInStates: async () => [row({ ref: 'flaky' }), row({ id: 'r2', ref: 'fine' })],
      checkPairing: async (t) => {
        if (t.ref === 'flaky') throw new Error('composio blip');
        return { status: 'not_connected' };
      },
      expire: async () => EXPIRE_OK,
    });
    expect(summary.pairing).toEqual({ checked: 2, paired: 0, rowErrors: 1 });
    expect(summary.ok).toBe(true);
  });

  test('EVERY row failing is a systemic failure, not a row blip â€” the run goes red', async () => {
    // e.g. a missing/revoked COMPOSIO_API_KEY throws for every row; exit 0
    // would leave Render green while pairing is dead indefinitely.
    const summary = await runLifecycle(NOW, {
      ...COST_STUBS,
      listInStates: async () => [row({ ref: 'a' }), row({ id: 'r2', ref: 'b' })],
      checkPairing: async () => {
        throw new Error('401 invalid api key');
      },
      expire: async () => EXPIRE_OK,
    });
    expect(summary.pairing).toEqual({ checked: 2, paired: 0, rowErrors: 2 });
    expect(summary.ok).toBe(false);
  });

  test('sessions step: skipped cleanly when COMPOSIO_API_KEY is unset â€” never red', async () => {
    const summary = await runLifecycle(NOW, {
      ...COST_STUBS,
      listInStates: async () => [],
      expire: async () => EXPIRE_OK,
      ensureSession: async () => {
        throw new Error('unit test must not reach the session sweep when the key is unset');
      },
    });
    expect(summary.sessions).toEqual({ skipped: 'COMPOSIO_API_KEY unset' });
    expect(summary.ok).toBe(true);
  });

  test('sessions step: sweeps ACTIVE rows, counts creations, tolerates row blips', async () => {
    process.env.COMPOSIO_API_KEY = 'test-key';
    const ensured: string[] = [];
    const summary = await runLifecycle(NOW, {
      ...COST_STUBS,
      listInStates: async (states) =>
        states.includes('active')
          ? [
              row({ ref: 'needs-session', state: 'active' }),
              row({ id: 'r2', ref: 'has-session', state: 'active', composio_session_id: 'trs_x' }),
              row({ id: 'r3', ref: 'flaky', state: 'active' }),
            ]
          : [],
      checkPairing: async () => ({ status: 'not_connected' }),
      expire: async () => EXPIRE_OK,
      ensureSession: async (t) => {
        ensured.push(t.ref);
        if (t.ref === 'flaky') throw new Error('composio blip');
        if (t.composio_session_id) return { status: 'exists', sessionId: t.composio_session_id };
        return { status: 'created', sessionId: 'trs_new' };
      },
      ingestLogs: async () => INGEST_OK,
    });
    expect(ensured).toEqual(['needs-session', 'has-session', 'flaky']);
    expect(summary.sessions).toEqual({ checked: 3, created: 1, rowErrors: 1 });
    expect(summary.ok).toBe(true); // one blip is not systemic
  });

  test('sessions step: seat-exempt active rows are never swept (schedule-only, no agent)', async () => {
    process.env.COMPOSIO_API_KEY = 'test-key';
    const ensured: string[] = [];
    const summary = await runLifecycle(NOW, {
      ...COST_STUBS,
      listInStates: async (states) =>
        states.includes('active')
          ? [
              row({ ref: 'seated', state: 'active' }),
              row({ id: 'r2', ref: 'helper', state: 'active', seat_exempt: true }),
            ]
          : [],
      checkPairing: async () => ({ status: 'not_connected' }),
      expire: async () => EXPIRE_OK,
      ensureSession: async (t) => {
        ensured.push(t.ref);
        return { status: 'created', sessionId: 'trs_new' };
      },
      ingestLogs: async () => INGEST_OK,
    });
    expect(ensured).toEqual(['seated']); // the exempt row never reaches Composio
    expect(summary.sessions).toEqual({ checked: 1, created: 1, rowErrors: 0 });
    expect(summary.ok).toBe(true);
  });

  test('sessions step: EVERY attempted row failing goes red (exists-rows never dilute it)', async () => {
    process.env.COMPOSIO_API_KEY = 'test-key';
    const summary = await runLifecycle(NOW, {
      ...COST_STUBS,
      listInStates: async (states) =>
        states.includes('active')
          ? [
              row({ ref: 'a', state: 'active' }),
              row({ id: 'r2', ref: 'has-session', state: 'active', composio_session_id: 'trs_x' }),
            ]
          : [],
      checkPairing: async () => ({ status: 'not_connected' }),
      expire: async () => EXPIRE_OK,
      ensureSession: async (t) => {
        if (t.composio_session_id) return { status: 'exists', sessionId: t.composio_session_id };
        throw new Error('401 invalid api key');
      },
      ingestLogs: async () => INGEST_OK,
    });
    expect(summary.sessions).toEqual({ checked: 2, created: 0, rowErrors: 1 });
    expect(summary.ok).toBe(false); // 1 attempt, 1 failure â€” systemic
  });

  test('logIngest step: skipped when the key is unset; reported when set; stepError goes red', async () => {
    // Unset key: skipped, and the injected thrower proves no reach-through.
    const skipped = await runLifecycle(NOW, {
      ...COST_STUBS,
      listInStates: async () => [],
      expire: async () => EXPIRE_OK,
      ingestLogs: async () => {
        throw new Error('unit test must not reach log ingestion when the key is unset');
      },
    });
    expect(skipped.logIngest).toEqual({ skipped: 'COMPOSIO_API_KEY unset' });
    expect(skipped.ok).toBe(true);

    // Key set: the summary is reported; per-row errors do not go red.
    process.env.COMPOSIO_API_KEY = 'test-key';
    const ran = await runLifecycle(NOW, {
      ...COST_STUBS,
      listInStates: async () => [],
      expire: async () => EXPIRE_OK,
      ensureSession: async () => ({ status: 'skipped', reason: 'state is invited' }),
      ingestLogs: async (nowIso) => {
        expect(nowIso).toBe(NOW);
        return { ...INGEST_OK, scanned: 5, captured: 2, rowErrors: 1 };
      },
    });
    expect(ran.logIngest).toMatchObject({ scanned: 5, captured: 2, rowErrors: 1 });
    expect(ran.ok).toBe(true);

    // A step-level throw goes red but never blocks the other steps.
    const red = await runLifecycle(NOW, {
      ...COST_STUBS,
      listInStates: async () => [],
      expire: async () => EXPIRE_OK,
      ensureSession: async () => ({ status: 'skipped', reason: 'state is invited' }),
      ingestLogs: async () => {
        throw new Error('logs API 500');
      },
    });
    expect(red.logIngest).toEqual({ stepError: 'logs API 500' });
    expect(red.ok).toBe(false);
  });
});

// The `describe('the reflector gate')` that stood here was deleted with the
// Reflector itself (build 3, plan 2026-08-30, Phase 3). It tested REFLECTOR_MODE
// parsing for a step that no longer exists; there is nothing to port.

describe('the planner gate', () => {
  const STUBS = {
    ...COST_STUBS,
    listInStates: async () => [],
    expire: async () => EXPIRE_OK,
    ingestLogs: async () => INGEST_OK,
    hasModelKey: () => true,
  };

  const planned = (over: Record<string, unknown> = {}) => {
    const calls: Array<[string, string]> = [];
    // The third argument too: `sweepLive` rides in here, and the planner cannot
    // work it out for itself.
    const opts: Array<PlannerDeps | undefined> = [];
    return {
      calls,
      opts,
      deps: {
        ...STUBS,
        runPlanner: async (nowIso: string, mode: string, o?: PlannerDeps) => {
          calls.push([nowIso, mode]);
          opts.push(o);
          return {
            mode: mode as 'shadow',
            tenants: 1,
            planned: 1,
            skippedNoGaps: 0,
            skippedCadence: 0,
            decisions: 0,
            dropped: 0,
            applied: 0,
      refusedAtApply: 0,
      recorded: 0,
      limitHits: { budget: 0, turns: 0 },
            tenantErrors: 0,
            byAction: {},
            plans: [],
          };
        },
        ...over,
      },
    };
  };

  test('unset PLANNER_MODE is a clean OFF — a cron deployed before the var must not go red', async () => {
    const { calls, deps } = planned();
    const s = await runLifecycle('2026-07-02T12:00:00.000Z', deps);
    expect(calls).toEqual([]);
    expect(s.teamLeadPlanner).toEqual({ skipped: "PLANNER_MODE 'off'" });
    expect(s.ok).toBe(true);
  });

  test('a TYPO is loud — it must never read as "the planner is quietly off"', async () => {
    process.env.PLANNER_MODE = 'shaddow';
    const { calls, deps } = planned();
    const s = await runLifecycle('2026-07-02T12:00:00.000Z', deps);
    expect(calls).toEqual([]);
    expect(s.teamLeadPlanner).toEqual({
      stepError: "PLANNER_MODE must be 'off', 'shadow' or 'live', got 'shaddow'",
    });
    expect(s.ok).toBe(false);
  });

  test('a SEAT model in INFERENCE_MODEL turns the heartbeat red, not the planner quiet', async () => {
    // User ruling 2026-08-28: Gemini is a seat model, never the spine's.
    // forcedTool enforces it per-REQUEST too, but that throw lands in
    // runPlanner's per-tenant catch and presents as `tenantErrors` — a config
    // typo wearing a provider outage's clothes. This is the loud half.
    const savedModel = process.env.INFERENCE_MODEL;
    process.env.INFERENCE_MODEL = 'google/gemini-3.7-flash';
    process.env.PLANNER_MODE = 'live';
    try {
      const { calls, deps } = planned();
      const s = await runLifecycle('2026-07-02T12:00:00.000Z', deps);
      expect(calls).toEqual([]); // the planner never ran
      expect(s.teamLeadPlanner).toMatchObject({ stepError: expect.stringMatching(/SEAT model/) });
      expect(s.ok).toBe(false);
    } finally {
      if (savedModel === undefined) delete process.env.INFERENCE_MODEL;
      else process.env.INFERENCE_MODEL = savedModel;
    }
  });

  test('the COARSE candidate gate: :00 and :30 run, :10 and :40 skip', async () => {
    // This is no longer the whole cadence decision (plan 2026-08-29 Phase 3) —
    // it is the cheap "could ANY firm be due?" check that keeps an off-cadence
    // tick free of database reads. The per-firm rate lives in runPlanner, and it
    // is only ever SLOWER, which is why a multiple-of check pins the pair.
    process.env.PLANNER_MODE = 'shadow';
    for (const [minute, shouldRun] of [
      ['00', true],
      ['04', true], // `< 5` tolerates a delayed firing, like heavyTick
      ['10', false],
      // :15 and :45 are the ONLY minutes that separate a half-hour cadence from
      // the quarter-hour one steps 1-7 use — without them this table passes
      // against `% 15` and pins nothing.
      ['15', false],
      ['19', false],
      ['30', true],
      ['34', true],
      ['40', false],
      ['45', false],
      ['55', false],
    ] as Array<[string, boolean]>) {
      const { calls, deps } = planned();
      const s = await runLifecycle(`2026-07-02T12:${minute}:00.000Z`, deps);
      expect(calls.length, `minute :${minute}`).toBe(shouldRun ? 1 : 0);
      if (!shouldRun) {
        expect(s.teamLeadPlanner).toEqual({
          skipped: 'off-cadence tick (no firm can be due this minute)',
        });
      }
    }
  });

  test('no inference credentials skips rather than erroring', async () => {
    process.env.PLANNER_MODE = 'shadow';
    const { calls, deps } = planned({ hasModelKey: () => false });
    const s = await runLifecycle('2026-07-02T12:00:00.000Z', deps);
    expect(calls).toEqual([]);
    expect(s.teamLeadPlanner).toEqual({ skipped: 'no inference credentials' });
    expect(s.ok).toBe(true);
  });

  test("the mode reaches the planner verbatim, and 'live' is passed through", async () => {
    process.env.PLANNER_MODE = 'live';
    const { calls, deps } = planned();
    await runLifecycle('2026-07-02T12:30:00.000Z', deps);
    expect(calls).toEqual([['2026-07-02T12:30:00.000Z', 'live']]);
  });

  // The rail in validateDecisions is only real if this wiring is right: the
  // planner's `escalate` is performed by the SWEEP in step 8, and the planner
  // cannot see whether that sweep will run. Both directions are pinned, because
  // a wiring that always said `true` would pass a one-sided test and quietly
  // restore the defect.
  test.each([
    ['live', true],
    ['shadow', false],
  ] as const)('WATCHERS_MODE %s reaches the planner as sweepLive=%s', async (watchers, expected) => {
    process.env.PLANNER_MODE = 'live';
    process.env.WATCHERS_MODE = watchers;
    const { opts, deps } = planned();
    await runLifecycle('2026-07-02T12:30:00.000Z', deps);
    expect(opts).toHaveLength(1);
    expect(opts[0]?.sweepLive).toBe(expected);
  });

  test('an UNSET watcher also reads as sweepLive=false — step 8 never runs at all', async () => {
    process.env.PLANNER_MODE = 'live';
    delete process.env.WATCHERS_MODE;
    const { opts, deps } = planned();
    await runLifecycle('2026-07-02T12:30:00.000Z', deps);
    expect(opts[0]?.sweepLive).toBe(false);
  });

  test('a throwing planner is a stepError, red — and the tick keeps going', async () => {
    process.env.PLANNER_MODE = 'shadow';
    process.env.NUDGES_MODE = 'live';
    const s = await runLifecycle('2026-07-02T12:00:00.000Z', {
      ...STUBS,
      runPlanner: async () => {
        throw new Error('provider down');
      },
    });
    expect(s.teamLeadPlanner).toEqual({ stepError: 'provider down' });
    expect(s.ok).toBe(false);
    // Shadow planner + live ladder is a mute ladder, and the tick says so.
    expect(s.ladderMute).toBeDefined();
  });
});

// The record is written into a row with NO tenant_id (one tick sweeps every
// firm), so anything customer-derived in it would sit outside the tenant
// boundary and outlive that firm being deleted. These tests are the guard.
describe('redactForRecord', () => {
  const summaryWith = (planner: unknown): Parameters<typeof redactForRecord>[0] =>
    ({
      pairing: { skipped: 'x' },
      offboarding: { skipped: 'x' },
      sessions: { skipped: 'x' },
      logIngest: { skipped: 'x' },
      braveBackfill: { skipped: 'x' },
      costRollup: { skipped: 'x' },
      lifecycleRuns: { skipped: 'x' },
      watchers: { skipped: 'x' },
      teamLeadPlanner: planner,
      gapSummaries: { skipped: 'x' },
      ok: true,
    }) as unknown as Parameters<typeof redactForRecord>[0];

  const PLANNER = {
    mode: 'live',
    tenants: 1,
    planned: 1,
    plans: [
      {
        tenantId: 't1',
        gaps: 2,
        turns: 3,
        toolCalls: 5,
        ms: 4200,
        applied: 1,
        refusedAtApply: 0,
        recorded: 2,
        decisions: [
          {
            nudgeId: 'n1',
            action: 'send',
            reason: 'Judy never named the part',
            citation: 'put the new condenser in',
            questionDraft: 'Hey Judy — quick one about the Hartley job on Maple St',
          },
        ],
        dropped: [{ nudgeId: 'n2', why: 'no citation' }],
      },
    ],
  };

  test('per-decision arrays become counts; the numbers that matter survive', () => {
    const out = redactForRecord(summaryWith(PLANNER)) as {
      teamLeadPlanner: { plans: Record<string, unknown>[] };
    };
    const plan = out.teamLeadPlanner.plans[0];
    expect(plan.decisions).toBe(1);
    expect(plan.dropped).toBe(1);
    expect(plan).toMatchObject({
      tenantId: 't1',
      gaps: 2,
      turns: 3,
      toolCalls: 5,
      ms: 4200,
      applied: 1,
      refusedAtApply: 0,
      recorded: 2,
    });
  });

  test('no customer-derived text survives anywhere in the record', () => {
    const json = JSON.stringify(redactForRecord(summaryWith(PLANNER)));
    for (const leak of ['questionDraft', 'citation', 'reason', 'Hartley', 'condenser', 'Judy']) {
      expect(json).not.toContain(leak);
    }
  });

  test('the source summary is not mutated — stdout still prints the full shape', () => {
    const summary = summaryWith(PLANNER);
    redactForRecord(summary);
    const plans = (summary.teamLeadPlanner as { plans: { decisions: unknown[] }[] }).plans;
    expect(Array.isArray(plans[0].decisions)).toBe(true);
  });

  test('a planner that never ran passes through untouched', () => {
    const out = redactForRecord(summaryWith({ skipped: "PLANNER_MODE 'off'" }));
    expect((out as { teamLeadPlanner: unknown }).teamLeadPlanner).toEqual({
      skipped: "PLANNER_MODE 'off'",
    });
  });

  test('a step error is capped, never allowed to grow the row without bound', () => {
    const summary = summaryWith({ skipped: 'x' });
    (summary as unknown as { watchers: unknown }).watchers = { stepError: 'e'.repeat(2000) };
    const out = redactForRecord(summary) as { watchers: { stepError: string } };
    expect(out.watchers.stepError).toHaveLength(500);
  });
});
