import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { Technician } from '../db/technicians.js';
import { runLifecycle } from './lifecycle.js';

// Pure unit tests — every step injected. The exit-code contract is `ok`
// (main() maps ok:false → exit 1 so Render marks the run failed).

// The test setup loads .env, which legitimately carries SCHEDULE_SHEET_ID /
// DEFAULT_TENANT_ID — clear them BEFORE each test (not just after), or the
// un-injected sheet gate would route to the LIVE Google Sheets reader.
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['SCHEDULE_SHEET_ID', 'DEFAULT_TENANT_ID'] as const) {
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
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

const EXPIRE_OK = { scanned: 0, stamped: 0, reminded: 0, expired: 0, failed: 0 };

describe('runLifecycle', () => {
  test('sweeps only rows with a link issued; counts paired; sheet skipped when unconfigured', async () => {
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
      // Injected even though the gate should skip it — a unit test must never
      // be one env var away from a live Sheets call.
      syncSheet: async () => {
        throw new Error('unit test must not reach the sheet reader');
      },
    });
    expect(checked).toEqual(['linked']); // never-linked rows are not swept
    expect(summary.pairing).toEqual({ checked: 1, paired: 1, rowErrors: 0 });
    expect(summary.sheetSync).toMatchObject({ skipped: expect.stringContaining('unset') });
    expect(summary.ok).toBe(true); // skipping the sheet is not a failure
  });

  test('a throwing step is reported and fails the run — but the other steps still ran', async () => {
    let expired = false;
    let synced = false;
    process.env.SCHEDULE_SHEET_ID = 'sheet-1';
    process.env.DEFAULT_TENANT_ID = 't1';
    const summary = await runLifecycle(NOW, {
      listInStates: async () => {
        throw new Error('db unreachable');
      },
      expire: async () => {
        expired = true;
        return EXPIRE_OK;
      },
      syncSheet: async () => {
        synced = true;
        return { upserted: 3, flagged: 1 };
      },
    });
    expect(summary.pairing).toEqual({ stepError: 'db unreachable' });
    expect(expired).toBe(true); // isolation: later steps unaffected
    expect(synced).toBe(true);
    expect(summary.sheetSync).toEqual({ upserted: 3, flagged: 1 });
    expect(summary.ok).toBe(false); // → exit 1 → Render marks the run failed
  });

  test('per-row pairing errors are counted, retried next tick, and do NOT fail the run', async () => {
    const summary = await runLifecycle(NOW, {
      listInStates: async () => [row({ ref: 'flaky' }), row({ id: 'r2', ref: 'fine' })],
      checkPairing: async (t) => {
        if (t.ref === 'flaky') throw new Error('composio blip');
        return { status: 'not_connected' };
      },
      expire: async () => EXPIRE_OK,
      syncSheet: async () => {
        throw new Error('unit test must not reach the sheet reader');
      },
    });
    expect(summary.pairing).toEqual({ checked: 2, paired: 0, rowErrors: 1 });
    expect(summary.ok).toBe(true);
  });

  test('EVERY row failing is a systemic failure, not a row blip — the run goes red', async () => {
    // e.g. a missing/revoked COMPOSIO_API_KEY throws for every row; exit 0
    // would leave Render green while pairing is dead indefinitely.
    const summary = await runLifecycle(NOW, {
      listInStates: async () => [row({ ref: 'a' }), row({ id: 'r2', ref: 'b' })],
      checkPairing: async () => {
        throw new Error('401 invalid api key');
      },
      expire: async () => EXPIRE_OK,
      syncSheet: async () => {
        throw new Error('unit test must not reach the sheet reader');
      },
    });
    expect(summary.pairing).toEqual({ checked: 2, paired: 0, rowErrors: 2 });
    expect(summary.ok).toBe(false);
  });
});
