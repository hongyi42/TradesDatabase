import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { Technician } from '../db/technicians.js';
import { runLifecycle } from './lifecycle.js';

// Pure unit tests â€” every step injected. The exit-code contract is `ok`
// (main() maps ok:false â†’ exit 1 so Render marks the run failed).

// The test setup loads .env, which legitimately carries
// DEFAULT_TENANT_ID / COMPOSIO_API_KEY â€” clear them BEFORE each test (not just
// after), or the sessions gate would sweep against LIVE Composio.
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  // WATCHERS_MODE cleared for the same reason as COMPOSIO_API_KEY: .env may
  // carry it, and the default runWatchers dep would hit the real database.
  for (const k of ['DEFAULT_TENANT_ID', 'COMPOSIO_API_KEY', 'WATCHERS_MODE'] as const) {
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

// The three cost steps default to REAL database accessors — and the DeepInfra
// one to a REAL network call — so every runLifecycle call here must inject them.
// Otherwise this "pure unit tests" file quietly starts writing to the database,
// and (once a billing key resolves from the environment) hitting DeepInfra's
// billing API, on each of the calls below.
const COST_STUBS = {
  backfillBrave: async () => ({ scanned: 0 }),
  latestBrave: async () => null,
  rollup: async () => ({ rowsWritten: 0, tenantsTouched: 0, unpricedEvents: 0 }),
  hasBillingKey: () => false,
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

    // Invoices arrive AFTER the month they cover: the July DeepInfra bill is
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

    test('shadow and live pass through to the dep with the run nowIso', async () => {
      const calls: Array<[string, string]> = [];
      for (const mode of ['shadow', 'live'] as const) {
        process.env.WATCHERS_MODE = mode;
        const summary = await runLifecycle(NOW, {
          ...COST_STUBS,
          ...BASE,
          runWatchers: async (nowIso, m) => {
            calls.push([nowIso, m]);
            return { ...WATCH_OK, mode };
          },
        });
        expect(summary.watchers).toMatchObject({ mode, gapsFound: 2 });
        expect(summary.ok).toBe(true);
      }
      expect(calls).toEqual([
        [NOW, 'shadow'],
        [NOW, 'live'],
      ]);
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
      expect(off.deepinfraUsage).toEqual(OFF);
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

  describe('DeepInfra usage collection (step 6)', () => {
    const BASE = {
      listInStates: async () => [],
      expire: async () => EXPIRE_OK,
      ensureSession: async () => ({ status: 'skipped' as const, reason: 'state is invited' }),
      ingestLogs: async () => INGEST_OK,
    };

    test('skips cleanly — not an error — when no billing key resolves', async () => {
      // The normal state after a failover to NVIDIA: that key cannot read a
      // DeepInfra account, so calling would 401 the cron every 15 minutes.
      let called = false;
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        hasBillingKey: () => false,
        collectDeepinfra: async () => {
          called = true;
          return { months: [], rejected: [] };
        },
      });
      expect(called).toBe(false);
      expect(summary.deepinfraUsage).toEqual({ skipped: 'no DeepInfra billing key configured' });
      expect(summary.ok).toBe(true);
    });

    test('collects and reports the month when a key is present', async () => {
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        hasBillingKey: () => true,
        collectDeepinfra: async () => ({
          months: [
            {
              period: '2026.07',
              amountUsd: 37.31,
              source: 'estimate' as const,
              created: true,
              allocation: 'per_sandbox' as const,
            },
          ],
          rejected: [],
        }),
      });
      expect(summary.deepinfraUsage).toMatchObject({ months: [{ amountUsd: 37.31 }] });
      expect(summary.ok).toBe(true);
    });

    test('runs BEFORE the rollup, so a fresh invoice allocates on the same tick', async () => {
      const order: string[] = [];
      await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        hasBillingKey: () => true,
        collectDeepinfra: async () => {
          order.push('collect');
          return { months: [], rejected: [] };
        },
        rollup: async () => {
          order.push('rollup');
          return { rowsWritten: 0, tenantsTouched: 0, unpricedEvents: 0 };
        },
      });
      expect(order[0]).toBe('collect');
      expect(order).toContain('rollup');
    });

    test('a vendor failure is reported red but never blocks the rollup', async () => {
      let rolled = false;
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        hasBillingKey: () => true,
        collectDeepinfra: async () => {
          throw new Error('deepinfra usage 503: upstream');
        },
        rollup: async () => {
          rolled = true;
          return { rowsWritten: 0, tenantsTouched: 0, unpricedEvents: 0 };
        },
      });
      expect(summary.deepinfraUsage).toEqual({ stepError: 'deepinfra usage 503: upstream' });
      expect(rolled).toBe(true);
      expect(summary.ok).toBe(false);
    });

    test('reports `skipped` when the cost ledger is not migrated here', async () => {
      const summary = await runLifecycle(NOW, {
        ...COST_STUBS,
        ...BASE,
        hasBillingKey: () => true,
        collectDeepinfra: async () => {
          throw Object.assign(new Error('relation "infra_costs" does not exist'), { code: '42P01' });
        },
      });
      expect(summary.deepinfraUsage).toEqual({ skipped: 'cost ledger not migrated here yet' });
      expect(summary.ok).toBe(true);
    });
  });
});
