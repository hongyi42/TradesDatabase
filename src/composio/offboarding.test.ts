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

function sweepStubs(rows: Technician[], opts: { casMissIds?: string[] } = {}) {
  const patches: Array<{ id: string; patch: TechnicianPatch }> = [];
  const casCalls: Array<{ id: string; from: string; patch: TechnicianPatch }> = [];
  const reminders: Array<{ subjectRef: string; startedAt: string }> = [];
  const closed: Array<{ kind: string; subjectRef: string; resolution?: string | null }> = [];
  return {
    patches,
    casCalls,
    reminders,
    closed,
    deps: {
      listInStates: async () => rows,
      update: async (id: string, patch: TechnicianPatch) => {
        patches.push({ id, patch });
        return row({ id, ...patch } as Partial<Technician>);
      },
      cas: async (id: string, from: string, patch: TechnicianPatch) => {
        casCalls.push({ id, from, patch });
        if (opts.casMissIds?.includes(id)) return null; // a reactivation won the race
        return row({ id, ...patch } as Partial<Technician>);
      },
      flagReminder: async (input: { subjectRef: string; startedAt: string }) => {
        reminders.push(input);
        return { id: 'reminder-1' } as ReviewItem;
      },
      resolveItemFor: async (
        _tenantId: string,
        kind: string,
        subjectRef: string,
        _status: string,
        resolution?: string | null,
      ) => {
        closed.push({ kind, subjectRef, resolution });
        return { id: 'closed-1' } as ReviewItem;
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

  test('expired: CLAIM first (CAS offboarding→offboarded), then teardown trigger-first; ids KEPT; reminder closed', async () => {
    const s = sweepStubs([row({ offboarding_started_at: daysAgo(8) })]);
    const { client, calls } = clientStub();
    const r = await expireOffboarding(NOW, { ...s.deps, client });
    expect(r).toMatchObject({ expired: 1, raced: 0, failed: 0 });
    expect(s.casCalls).toEqual([
      { id: 'row-1', from: 'offboarding', patch: { state: 'offboarded' } }, // no id nulling
    ]);
    expect(calls).toEqual([
      { method: 'triggers.delete', id: 'ti_gone' },
      { method: 'accounts.delete', id: 'ca_gone' },
    ]);
    expect(s.closed).toEqual([
      { kind: 'offboarding_reminder', subjectRef: 'gone-guy', resolution: 'offboarding completed' },
    ]);
  });

  test('a reactivation that wins the race is NEVER torn down: lost claim skips the row', async () => {
    const s = sweepStubs([row({ offboarding_started_at: daysAgo(8) })], { casMissIds: ['row-1'] });
    const { client, calls } = clientStub();
    const r = await expireOffboarding(NOW, { ...s.deps, client });
    expect(r).toMatchObject({ expired: 0, raced: 1, failed: 0 });
    expect(calls).toHaveLength(0); // the just-re-enabled pairing survives untouched
    expect(s.closed).toHaveLength(0);
  });

  test('teardown failure AFTER the claim: failed++, row stays offboarded (objects are disabled+inert)', async () => {
    const s = sweepStubs([row({ offboarding_started_at: daysAgo(8) })]);
    const { client } = clientStub({ deleteThrows: new Error('503 unavailable') });
    const r = await expireOffboarding(NOW, { ...s.deps, client });
    expect(r).toMatchObject({ expired: 0, failed: 1 });
    expect(s.casCalls).toHaveLength(1); // claim happened — reactivate can no longer race in
    expect(s.closed).toHaveLength(0);
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
