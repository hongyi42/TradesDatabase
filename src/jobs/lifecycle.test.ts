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
  for (const k of ['DEFAULT_TENANT_ID', 'COMPOSIO_API_KEY'] as const) {
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

describe('runLifecycle', () => {
  test('sweeps only rows with a link issued; counts paired', async () => {
    const checked: string[] = [];
    const summary = await runLifecycle(NOW, {
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

  test('a throwing step is reported and fails the run â€” but the other steps still ran', async () => {
    let expired = false;
    const summary = await runLifecycle(NOW, {
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

  test('sessions step: EVERY attempted row failing goes red (exists-rows never dilute it)', async () => {
    process.env.COMPOSIO_API_KEY = 'test-key';
    const summary = await runLifecycle(NOW, {
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
