import { afterEach, describe, expect, test } from 'vitest';
import type { Technician, TechnicianPatch } from '../db/technicians.js';
import type { ReviewItem } from '../db/index.js';
import { disablePairing, enablePairing, expireOffboarding } from './offboarding.js';
import type { PairingClient } from './pairing.js';

// Pure unit tests — every seam injected (no DB, no COMPOSIO_API_KEY).

afterEach(() => {
  delete process.env.GRACE_DAYS;
});

const NOW = '2026-07-02T12:00:00.000Z';
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();

function row(over: Partial<Technician> = {}): Technician {
  return {
    id: 'row-1',
    tenant_id: 'tenant-1',
    ref: 'gone-guy',
    display_name: 'Gone Guy',
    tier: 'technician',
    state: 'offboarding',
    sandbox_ref: null,
    composio_connected_account_id: 'ca_gone',
    composio_trigger_id: 'ti_gone',
    connected_email: 'gone@gmail.com',
    badge_hash: null,
    host_id: null,
    offboarding_started_at: daysAgo(1),
    link_issued_at: null,
    created_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
    ...over,
  };
}

function clientStub(opts: { deleteThrows?: Error } = {}) {
  const calls: Array<{ method: string; id: string }> = [];
  const rec = (method: string) => async (id: string) => {
    calls.push({ method, id });
    if (opts.deleteThrows && method.endsWith('delete')) throw opts.deleteThrows;
    return {};
  };
  const client: PairingClient = {
    connectedAccounts: {
      list: async () => ({ items: [] }),
      link: async () => ({}),
      delete: rec('accounts.delete'),
      disable: rec('accounts.disable'),
      enable: rec('accounts.enable'),
    },
    triggers: {
      listActive: async () => ({ items: [] }),
      create: async () => ({}),
      delete: rec('triggers.delete'),
      disable: rec('triggers.disable'),
      enable: rec('triggers.enable'),
    },
    tools: { execute: async () => ({}) },
  };
  return { client, calls };
}

function sweepStubs(rows: Technician[]) {
  const patches: Array<{ id: string; patch: TechnicianPatch }> = [];
  const reminders: Array<{ subjectRef: string; startedAt: string }> = [];
  const resolved: string[] = [];
  let openReminder: ReviewItem | null = null;
  return {
    patches,
    reminders,
    resolved,
    setOpenReminder(item: ReviewItem | null) {
      openReminder = item;
    },
    deps: {
      listInStates: async () => rows,
      update: async (id: string, patch: TechnicianPatch) => {
        patches.push({ id, patch });
        return row({ id, ...patch } as Partial<Technician>);
      },
      flagReminder: async (input: { subjectRef: string; startedAt: string }) => {
        reminders.push(input);
        return { id: 'reminder-1' } as ReviewItem;
      },
      findOpenItem: async () => openReminder,
      resolveItem: async (id: string) => {
        resolved.push(id);
        return { id } as ReviewItem;
      },
    },
  };
}

describe('disablePairing / enablePairing', () => {
  test('disable: trigger then account; enable: account then trigger', async () => {
    const d = clientStub();
    await disablePairing(row(), { client: d.client });
    expect(d.calls).toEqual([
      { method: 'triggers.disable', id: 'ti_gone' },
      { method: 'accounts.disable', id: 'ca_gone' },
    ]);

    const e = clientStub();
    await enablePairing(row(), { client: e.client });
    expect(e.calls).toEqual([
      { method: 'accounts.enable', id: 'ca_gone' },
      { method: 'triggers.enable', id: 'ti_gone' },
    ]);
  });

  test('no-ops cleanly on a row that never paired', async () => {
    const { client, calls } = clientStub();
    await disablePairing(
      row({ composio_connected_account_id: null, composio_trigger_id: null }),
      { client },
    );
    expect(calls).toHaveLength(0);
  });
});

describe('expireOffboarding', () => {
  test('NULL clock self-heals: stamped now, nothing else this run', async () => {
    const s = sweepStubs([row({ offboarding_started_at: null })]);
    const { client, calls } = clientStub();
    const r = await expireOffboarding(NOW, { ...s.deps, client });
    expect(r).toMatchObject({ scanned: 1, stamped: 1, reminded: 0, expired: 0, failed: 0 });
    expect(s.patches[0].patch).toEqual({ offboarding_started_at: NOW });
    expect(calls).toHaveLength(0); // no teardown, no reminder
  });

  test('mid-grace: nothing happens; final 2 days: reminder with the episode key', async () => {
    const quiet = sweepStubs([row({ offboarding_started_at: daysAgo(3) })]); // 4 days left
    const r1 = await expireOffboarding(NOW, { ...quiet.deps, client: clientStub().client });
    expect(r1).toMatchObject({ reminded: 0, expired: 0, stamped: 0 });

    const soon = sweepStubs([row({ offboarding_started_at: daysAgo(6) })]); // 1 day left
    const r2 = await expireOffboarding(NOW, { ...soon.deps, client: clientStub().client });
    expect(r2).toMatchObject({ reminded: 1, expired: 0 });
    expect(soon.reminders[0]).toMatchObject({ subjectRef: 'gone-guy', startedAt: daysAgo(6) });
  });

  test('expired: teardown (trigger first), state → offboarded, ids KEPT, open reminder resolved', async () => {
    const s = sweepStubs([row({ offboarding_started_at: daysAgo(8) })]);
    s.setOpenReminder({ id: 'reminder-open' } as ReviewItem);
    const { client, calls } = clientStub();
    const r = await expireOffboarding(NOW, { ...s.deps, client });
    expect(r).toMatchObject({ expired: 1, failed: 0 });
    expect(calls).toEqual([
      { method: 'triggers.delete', id: 'ti_gone' },
      { method: 'accounts.delete', id: 'ca_gone' },
    ]);
    expect(s.patches).toEqual([{ id: 'row-1', patch: { state: 'offboarded' } }]); // no id nulling
    expect(s.resolved).toEqual(['reminder-open']);
  });

  test('teardown failure: failed++, state unchanged — the next run retries', async () => {
    const s = sweepStubs([row({ offboarding_started_at: daysAgo(8) })]);
    const { client } = clientStub({ deleteThrows: new Error('503 unavailable') });
    const r = await expireOffboarding(NOW, { ...s.deps, client });
    expect(r).toMatchObject({ expired: 0, failed: 1 });
    expect(s.patches).toHaveLength(0); // still 'offboarding' — retryable
    expect(s.resolved).toHaveLength(0);
  });

  test('GRACE_DAYS env changes the boundary (1 day: yesterday is already expired)', async () => {
    process.env.GRACE_DAYS = '1';
    const s = sweepStubs([row({ offboarding_started_at: daysAgo(1.5) })]);
    const r = await expireOffboarding(NOW, { ...s.deps, client: clientStub().client });
    expect(r).toMatchObject({ expired: 1 });
  });

  test('a failing self-heal stamp is isolated: the rest of the sweep still runs', async () => {
    const rows = [
      row({ id: 'row-null', ref: 'null-clock', offboarding_started_at: null }),
      row({ id: 'row-due', ref: 'due-guy', offboarding_started_at: daysAgo(8) }),
    ];
    const s = sweepStubs(rows);
    const failingUpdate = async (id: string, patch: Record<string, unknown>) => {
      if (id === 'row-null') throw new Error('transient db blip');
      return s.deps.update(id, patch);
    };
    const r = await expireOffboarding(NOW, {
      ...s.deps,
      update: failingUpdate as typeof s.deps.update,
      client: clientStub().client,
    });
    expect(r).toMatchObject({ scanned: 2, stamped: 0, failed: 1, expired: 1 });
  });
});
