import { afterEach, describe, expect, test } from 'vitest';
import type { Technician, TechnicianPatch } from '../db/technicians.js';
import type { Observation } from '../db/index.js';
import { disablePairing, enablePairing, expireOffboarding } from './offboarding.js';
import { unpair, type PairingClient } from './pairing.js';

// Pure unit tests â€” every seam injected (no DB, no COMPOSIO_API_KEY).

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
    composio_session_id: null,
    availability: null,
    service_cities: [],
    telegram_user_id: null,
    seat_exempt: false,
    skills: [],
    created_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
    ...over,
  };
}

function clientStub(opts: { deleteThrows?: Error; activeTriggers?: Array<{ id: string }> } = {}) {
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
      listActive: async () => {
        calls.push({ method: 'triggers.listActive', id: '' });
        return { items: opts.activeTriggers ?? [] };
      },
      create: async () => ({}),
      delete: rec('triggers.delete'),
      disable: rec('triggers.disable'),
      enable: rec('triggers.enable'),
    },
    tools: { execute: async () => ({}) },
    sessions: {
      create: async () => {
        throw new Error('offboarding must not create sessions');
      },
      use: async () => {
        throw new Error('offboarding must not use sessions');
      },
      delete: rec('sessions.delete'),
    },
  };
  return { client, calls };
}

function sweepStubs(rows: Technician[], opts: { casMissIds?: string[] } = {}) {
  const patches: Array<{ id: string; patch: TechnicianPatch }> = [];
  const casCalls: Array<{ id: string; from: string; patch: TechnicianPatch }> = [];
  const reminders: Array<{ ref: string; displayName?: string | null; startedAt: string }> = [];
  const closed: Array<{ kind: string; ref: string; reason: string }> = [];
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
      raiseReminder: async (input: {
        tenantId: string;
        ref: string;
        displayName?: string | null;
        startedAt: string;
      }) => {
        reminders.push({ ref: input.ref, displayName: input.displayName, startedAt: input.startedAt });
        return { id: 'reminder-1' } as Observation;
      },
      dismissFor: async (_tenantId: string, kind: string, ref: string, reason: string) => {
        closed.push({ kind, ref, reason });
        return 1;
      },
    },
  };
}

describe('disablePairing / enablePairing', () => {
  test('disable: triggers then account; enable: account then triggers', async () => {
    const d = clientStub();
    await disablePairing(row(), { client: d.client });
    expect(d.calls.map((c) => c.method)).toEqual([
      'triggers.listActive',
      'triggers.disable',
      'accounts.disable',
    ]);

    const e = clientStub();
    await enablePairing(row(), { client: e.client });
    expect(e.calls.map((c) => c.method)).toEqual([
      'accounts.enable',
      'triggers.listActive',
      'triggers.enable',
    ]);
  });

  // RUNG 10B.4 — EVERY watcher, not just the one the roster names. Gmail's menu
  // has two and the column holds one, so a column-driven disable left a
  // deactivated person's OUTGOING mail streaming to our webhook for the whole
  // grace period: dropped with a receipt, but still delivered and still billed,
  // for somebody who has been told their access is off.
  test('disable reaches watchers the roster never recorded', async () => {
    const { client, calls } = clientStub({
      activeTriggers: [{ id: 'ti_sent_unrecorded' }, { id: 'ti_gone' }],
    });
    await disablePairing(row(), { client });
    const disabled = calls.filter((c) => c.method === 'triggers.disable').map((c) => c.id);
    expect(new Set(disabled)).toEqual(new Set(['ti_gone', 'ti_sent_unrecorded']));
  });

  test('…and so does enable, or a returning person’s own replies stay uncaptured', async () => {
    const { client, calls } = clientStub({ activeTriggers: [{ id: 'ti_sent_unrecorded' }] });
    await enablePairing(row(), { client });
    const enabled = calls.filter((c) => c.method === 'triggers.enable').map((c) => c.id);
    expect(new Set(enabled)).toEqual(new Set(['ti_gone', 'ti_sent_unrecorded']));
  });

  test('no-ops cleanly on a row that never paired', async () => {
    const { client, calls } = clientStub();
    await disablePairing(
      row({ composio_connected_account_id: null, composio_trigger_id: null }),
      { client },
    );
    // Nothing to list and nothing to switch off.
    expect(calls.filter((c) => c.method !== 'triggers.listActive')).toHaveLength(0);
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
    expect(soon.reminders[0]).toEqual({
      ref: 'gone-guy',
      displayName: 'Gone Guy',
      startedAt: daysAgo(6),
    });
  });

  test('the reminder is raised once per EPISODE: a later tick re-observes the same row and counts nothing', async () => {
    // The sweep runs every 15 minutes and sees "under two days left" on every
    // one of them; the observation's once-ever key (ref@startedAt) is what turns
    // every re-observation after the first into a null.
    const started = daysAgo(6);
    const s = sweepStubs([row({ offboarding_started_at: started })]);
    let raised = 0;
    const onceEver = {
      ...s.deps,
      raiseReminder: async (input: Parameters<typeof s.deps.raiseReminder>[0]) => {
        const r = await s.deps.raiseReminder(input);
        return raised++ === 0 ? r : null;
      },
    };
    const first = await expireOffboarding(NOW, { ...onceEver, client: clientStub().client });
    const later = await expireOffboarding(NOW, { ...onceEver, client: clientStub().client });
    expect(first).toMatchObject({ reminded: 1 });
    expect(later).toMatchObject({ reminded: 0 });
    // Both ticks named the SAME episode — that sameness is the dedup key.
    expect(s.reminders).toHaveLength(2);
    expect(s.reminders[0].startedAt).toBe(started);
    expect(s.reminders[1].startedAt).toBe(started);
  });

  test('expired: CLAIM first (CAS offboardingâ†’offboarded), then teardown trigger-first; ids KEPT; reminder dismissed', async () => {
    const s = sweepStubs([row({ offboarding_started_at: daysAgo(8) })]);
    const { client, calls } = clientStub();
    const r = await expireOffboarding(NOW, { ...s.deps, client });
    expect(r).toMatchObject({ expired: 1, raced: 0, failed: 0 });
    expect(s.casCalls).toEqual([
      { id: 'row-1', from: 'offboarding', patch: { state: 'offboarded' } }, // no id nulling
    ]);
    expect(calls.filter((c) => c.method !== 'triggers.listActive')).toEqual([
      { method: 'triggers.delete', id: 'ti_gone' },
      { method: 'accounts.delete', id: 'ca_gone' },
    ]);
    expect(s.closed).toEqual([
      { kind: 'offboarding_reminder', ref: 'gone-guy', reason: 'the removal became permanent' },
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
    expect(s.casCalls).toHaveLength(1); // claim happened â€” reactivate can no longer race in
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

  test('expiry deletes the Composio session AFTER the pairing teardown; the column is NULLED on success', async () => {
    const s = sweepStubs([
      row({ offboarding_started_at: daysAgo(8), composio_session_id: 'trs_gone' }),
    ]);
    const { client, calls } = clientStub();
    const r = await expireOffboarding(NOW, { ...s.deps, client });
    expect(r).toMatchObject({ expired: 1, failed: 0, sessionsCleaned: 0 });
    expect(calls.filter((c) => c.method !== 'triggers.listActive')).toEqual([
      { method: 'triggers.delete', id: 'ti_gone' },
      { method: 'accounts.delete', id: 'ca_gone' },
      { method: 'sessions.delete', id: 'trs_gone' },
    ]);
    expect(s.casCalls).toEqual([
      { id: 'row-1', from: 'offboarding', patch: { state: 'offboarded' } },
    ]);
    // Null-out marks "nothing leaked" â€” a non-null id on an offboarded row is
    // the retry pass's work queue.
    expect(s.patches).toEqual([{ id: 'row-1', patch: { composio_session_id: null } }]);
  });

  test('a LEAKED session on an offboarded row is retried every tick until the delete lands', async () => {
    const leakedRow = row({
      id: 'row-leak',
      ref: 'leaked-guy',
      state: 'offboarded',
      composio_session_id: 'trs_leaked',
      offboarding_started_at: daysAgo(9),
    });
    const s = sweepStubs([leakedRow]);
    const { client, calls } = clientStub();
    const r = await expireOffboarding(NOW, { ...s.deps, client });
    // Not counted as scanned/expired â€” it's the retry pass, not the grace sweep.
    expect(r).toMatchObject({ scanned: 0, expired: 0, failed: 0, sessionsCleaned: 1 });
    expect(calls.filter((c) => c.method !== 'triggers.listActive')).toEqual([{ method: 'sessions.delete', id: 'trs_leaked' }]);
    expect(s.patches).toEqual([{ id: 'row-leak', patch: { composio_session_id: null } }]);

    // A still-failing delete stays queued (failed++, column untouched).
    const s2 = sweepStubs([leakedRow]);
    const err = clientStub({ deleteThrows: new Error('503 unavailable') });
    const r2 = await expireOffboarding(NOW, { ...s2.deps, client: err.client });
    expect(r2).toMatchObject({ sessionsCleaned: 0, failed: 1 });
    expect(s2.patches).toEqual([]);

    // An already-gone session (404) still clears the mark.
    const s3 = sweepStubs([leakedRow]);
    const gone = clientStub({ deleteThrows: Object.assign(new Error('nf'), { status: 404 }) });
    const r3 = await expireOffboarding(NOW, { ...s3.deps, client: gone.client });
    expect(r3).toMatchObject({ sessionsCleaned: 1, failed: 0 });
    expect(s3.patches).toEqual([{ id: 'row-leak', patch: { composio_session_id: null } }]);

    // Offboarded rows with NO session id are ignored entirely.
    const s4 = sweepStubs([row({ id: 'row-clean', state: 'offboarded', composio_session_id: null })]);
    const quiet = clientStub();
    const r4 = await expireOffboarding(NOW, { ...s4.deps, client: quiet.client });
    expect(r4).toMatchObject({ scanned: 0, sessionsCleaned: 0, failed: 0 });
    expect(quiet.calls).toHaveLength(0);
  });

  test('an already-deleted session (404) is success; other session errors â†’ failed', async () => {
    const gone = Object.assign(new Error('not found'), { status: 404 });
    const s404 = sweepStubs([
      row({ offboarding_started_at: daysAgo(8), composio_session_id: 'trs_404' }),
    ]);
    // deleteThrows applies to every *.delete call â€” pairing deletes must survive,
    // so use a client whose sessions.delete alone 404s.
    const base = clientStub();
    const client404: typeof base.client = {
      ...base.client,
      sessions: {
        ...base.client.sessions,
        delete: async (id: string) => {
          base.calls.push({ method: 'sessions.delete', id });
          throw gone;
        },
      },
    };
    const r404 = await expireOffboarding(NOW, { ...s404.deps, client: client404 });
    expect(r404).toMatchObject({ expired: 1, failed: 0 });

    const sErr = sweepStubs([
      row({ offboarding_started_at: daysAgo(8), composio_session_id: 'trs_err' }),
    ]);
    const base2 = clientStub();
    const clientErr: typeof base2.client = {
      ...base2.client,
      sessions: {
        ...base2.client.sessions,
        delete: async () => {
          throw new Error('503 unavailable');
        },
      },
    };
    const rErr = await expireOffboarding(NOW, { ...sErr.deps, client: clientErr });
    expect(rErr).toMatchObject({ expired: 0, failed: 1 });
    expect(sErr.casCalls).toHaveLength(1); // claim landed; clutter is inert, retried never
  });

  test('unpair never deletes the session (wrong-mailbox re-pair keeps it)', async () => {
    const { client, calls } = clientStub();
    const casCalls: Array<{ id: string }> = [];
    await unpair(
      row({
        state: 'pending_verification',
        composio_session_id: 'trs_keep',
      }),
      {
        client,
        cas: async (id: string) => {
          casCalls.push({ id });
          return null;
        },
      },
    );
    // Pairing objects torn down, session untouched.
    expect(calls.filter((c) => c.method !== 'triggers.listActive')).toEqual([
      { method: 'triggers.delete', id: 'ti_gone' },
      { method: 'accounts.delete', id: 'ca_gone' },
    ]);
    expect(casCalls).toHaveLength(1);
  });
});
