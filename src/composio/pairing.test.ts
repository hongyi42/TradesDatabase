import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Technician, TechnicianPatch } from '../db/technicians.js';
import type { ReviewItem, UpsertOpenReviewItemInput } from '../db/index.js';
import {
  GMAIL_TRIGGER_CONFIG,
  checkPairing,
  createConnectLink,
  unpair,
  type PairingClient,
} from './pairing.js';

// Pure unit tests â€” the Composio client and both db writes are stubbed, so
// nothing here needs COMPOSIO_API_KEY or the test project.

let prevAuthConfig: string | undefined;
beforeAll(() => {
  prevAuthConfig = process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID;
  process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = 'ac_test_config';
});
afterAll(() => {
  process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = prevAuthConfig;
});

function tech(over: Partial<Technician> = {}): Technician {
  return {
    id: 'tech-1',
    tenant_id: '11111111-1111-1111-1111-111111111111',
    ref: 'jane-doe',
    display_name: 'Jane Doe',
    tier: 'technician',
    state: 'invited',
    sandbox_ref: null,
    composio_connected_account_id: null,
    composio_trigger_id: null,
    connected_email: null,
    badge_hash: null,
    host_id: null,
    offboarding_started_at: null,
    link_issued_at: null,
    composio_session_id: null,
    availability: null,
    service_cities: [],
    telegram_user_id: null,
    seat_exempt: false,
    skills: [],
    created_at: '2026-07-02T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    ...over,
  };
}

// Recording stubs for the db seams. casMiss simulates a concurrent writer
// having won the state race (casTechnician â†’ null).
function dbStubs(opts: { casMiss?: boolean } = {}) {
  const patches: Array<{ id: string; patch: TechnicianPatch }> = [];
  const casCalls: Array<{ id: string; from: string; patch: TechnicianPatch }> = [];
  const items: UpsertOpenReviewItemInput[] = [];
  return {
    patches,
    casCalls,
    items,
    update: async (id: string, patch: TechnicianPatch) => {
      patches.push({ id, patch });
      return tech({ id, ...patch } as Partial<Technician>);
    },
    cas: async (id: string, from: string, patch: TechnicianPatch) => {
      casCalls.push({ id, from, patch });
      if (opts.casMiss) return null;
      return tech({ id, ...patch } as Partial<Technician>);
    },
    openReviewItem: async (input: UpsertOpenReviewItemInput) => {
      items.push(input);
      return { id: 'item-1' } as ReviewItem;
    },
  };
}

// Everything checkPairing/unpair need, from one stub set. recordCost is stubbed
// like every other seam: unstubbed it falls through to the real accessor and
// this "pure unit test" file starts making DB round-trips (which then fail the
// tenant FK and are silently swallowed) on every run.
const costCalls: Array<{ tenantId: string; technicianRef?: string | null }> = [];
function pairingDeps(db: ReturnType<typeof dbStubs>, client: PairingClient) {
  return {
    client,
    update: db.update,
    cas: db.cas,
    openReviewItem: db.openReviewItem,
    recordCost: async (ctx?: { tenantId: string; technicianRef?: string | null }) => {
      if (ctx) costCalls.push(ctx);
    },
  };
}

// Configurable Composio client stub; records every call.
function clientStub(opts: {
  accounts?: Array<Record<string, unknown>>;
  activeTriggers?: Array<Record<string, unknown>>;
  createThrows?: boolean;
  profileData?: Record<string, unknown>;
  profileThrows?: boolean;
  deleteThrows?: (id: string) => Error | null;
} = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rec = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const client: PairingClient = {
    connectedAccounts: {
      list: async (q) => {
        rec('accounts.list', q);
        return { items: opts.accounts ?? [] };
      },
      link: async (userId, authConfigId) => {
        rec('accounts.link', userId, authConfigId);
        return { redirectUrl: 'https://connect.composio.example/abc' };
      },
      delete: async (id) => {
        rec('accounts.delete', id);
        const err = opts.deleteThrows?.(id);
        if (err) throw err;
        return {};
      },
      disable: async (id) => {
        rec('accounts.disable', id);
        return {};
      },
      enable: async (id) => {
        rec('accounts.enable', id);
        return {};
      },
    },
    triggers: {
      listActive: async (q) => {
        rec('triggers.listActive', q);
        return { items: opts.activeTriggers ?? [] };
      },
      create: async (userId, slug, o) => {
        rec('triggers.create', userId, slug, o);
        if (opts.createThrows) throw new Error('upsert refused');
        return { triggerId: 'ti_new123' };
      },
      delete: async (id) => {
        rec('triggers.delete', id);
        const err = opts.deleteThrows?.(id);
        if (err) throw err;
        return {};
      },
      disable: async (id) => {
        rec('triggers.disable', id);
        return {};
      },
      enable: async (id) => {
        rec('triggers.enable', id);
        return {};
      },
    },
    tools: {
      execute: async (slug, body) => {
        rec('tools.execute', slug, body);
        if (opts.profileThrows) throw new Error('tool execution failed');
        return { data: opts.profileData ?? { emailAddress: 'jane.doe@gmail.com' } };
      },
    },
    // Pairing never touches sessions â€” throwing stubs prove it (Phase 3 owns
    // the behavior tests).
    sessions: {
      create: async () => {
        throw new Error('pairing must not create sessions');
      },
      use: async () => {
        throw new Error('pairing must not use sessions');
      },
      delete: async () => {
        throw new Error('pairing must not delete sessions');
      },
    },
  };
  return { client, calls };
}

const ACTIVE_GMAIL = { id: 'ca_abc123', status: 'ACTIVE', toolkit: { slug: 'gmail' } };

describe('createConnectLink', () => {
  test('returns the redirect URL and stamps the cooldown clock', async () => {
    const db = dbStubs();
    const { client, calls } = clientStub();
    const { url } = await createConnectLink(tech(), { client, update: db.update });
    expect(url).toBe('https://connect.composio.example/abc');
    // Composite user id + the configured auth config, verbatim.
    expect(calls[0]).toEqual({
      method: 'accounts.link',
      args: ['11111111-1111-1111-1111-111111111111:jane-doe', 'ac_test_config'],
    });
    expect(db.patches).toHaveLength(1);
    expect(db.patches[0].patch.link_issued_at).toBeTruthy();
  });
});

describe('checkPairing', () => {
  test('no-ops on every non-invited state (the transition is the gate)', async () => {
    const db = dbStubs();
    const { client, calls } = clientStub({ accounts: [ACTIVE_GMAIL] });
    for (const state of ['pending_verification', 'active', 'offboarding', 'offboarded'] as const) {
      const r = await checkPairing(tech({ state }), pairingDeps(db, client));
      expect(r).toEqual({ status: 'no_op', reason: `state is ${state}` });
    }
    expect(calls).toHaveLength(0); // never even lists accounts
    expect(db.items).toHaveLength(0); // a dismissed item can never be re-opened
  });

  test('not_connected when no ACTIVE gmail account exists yet', async () => {
    const db = dbStubs();
    const { client } = clientStub({
      accounts: [{ id: 'ca_x', status: 'INITIATED', toolkit: { slug: 'gmail' } }],
    });
    const r = await checkPairing(tech(), pairingDeps(db, client));
    expect(r).toEqual({ status: 'not_connected' });
    expect(db.casCalls).toHaveLength(0);
  });

  test('paired: claims via CAS, opens the item, then ensures the trigger LAST', async () => {
    const db = dbStubs();
    const { client, calls } = clientStub({ accounts: [ACTIVE_GMAIL] });
    const r = await checkPairing(tech(), pairingDeps(db, client));
    expect(r).toEqual({ status: 'paired', connectedAccountId: 'ca_abc123', email: 'jane.doe@gmail.com' });

    // The claim carries the inventory + state and races on 'invited'.
    expect(db.casCalls[0]).toMatchObject({
      from: 'invited',
      patch: {
        composio_connected_account_id: 'ca_abc123',
        connected_email: 'jane.doe@gmail.com',
        state: 'pending_verification',
      },
    });
    // Trigger created (none existed), PINNED to the verified account, adoption
    // list filtered to our trigger type â€” and only AFTER the claim, so the
    // earliest deliveries can't dodge the webhook's pending stamp.
    const listIdx = calls.findIndex((c) => c.method === 'triggers.listActive');
    const createIdx = calls.findIndex((c) => c.method === 'triggers.create');
    const execIdx = calls.findIndex((c) => c.method === 'tools.execute');
    expect(execIdx).toBeLessThan(listIdx); // profile fetched before the claim/trigger
    expect(calls[listIdx].args[0]).toMatchObject({
      connectedAccountIds: ['ca_abc123'],
      triggerNames: ['GMAIL_NEW_GMAIL_MESSAGE'],
    });
    expect(calls[createIdx].args[2]).toMatchObject({ connectedAccountId: 'ca_abc123' });
    expect(calls[execIdx].args[1]).toMatchObject({
      connectedAccountId: 'ca_abc123',
      dangerouslySkipVersionCheck: true,
    });
    // The trigger id lands in a follow-up write; the item detail is complete.
    expect(db.patches[0].patch).toEqual({ composio_trigger_id: 'ti_new123' });
    expect(db.items[0]).toMatchObject({
      kind: 'pairing_verification',
      subjectRef: 'jane-doe',
      detail: { email: 'jane.doe@gmail.com', connectedAccountId: 'ca_abc123' },
    });
  });

  test('a lost CAS (concurrent deactivate or second sweep) stops before any trigger exists', async () => {
    const db = dbStubs({ casMiss: true });
    const { client, calls } = clientStub({ accounts: [ACTIVE_GMAIL] });
    const r = await checkPairing(tech(), pairingDeps(db, client));
    expect(r).toEqual({ status: 'no_op', reason: 'state changed concurrently' });
    expect(calls.map((c) => c.method)).not.toContain('triggers.create'); // no duplicate trigger
    expect(db.items).toHaveLength(0); // and no review item for a row we don't own
  });

  test('healing branch: a claimed row missing its trigger gets one, nothing else moves', async () => {
    const db = dbStubs();
    const { client, calls } = clientStub();
    const r = await checkPairing(
      tech({
        state: 'pending_verification',
        composio_connected_account_id: 'ca_abc123',
        connected_email: 'jane.doe@gmail.com',
        composio_trigger_id: null,
      }),
      pairingDeps(db, client),
    );
    expect(r).toEqual({ status: 'paired', connectedAccountId: 'ca_abc123', email: 'jane.doe@gmail.com' });
    expect(calls.map((c) => c.method)).toContain('triggers.create');
    expect(db.patches[0].patch).toEqual({ composio_trigger_id: 'ti_new123' });
    expect(db.casCalls).toHaveLength(0); // no re-claim
    expect(db.items).toHaveLength(0); // the item opened once, at the claim
  });

  test('idempotent on an existing trigger CARRYING THE CURRENT CONFIG: adopts it, never calls create', async () => {
    const db = dbStubs();
    const { client, calls } = clientStub({
      accounts: [ACTIVE_GMAIL],
      activeTriggers: [{ id: 'ti_existing', triggerConfig: { ...GMAIL_TRIGGER_CONFIG } }],
    });
    await checkPairing(tech(), pairingDeps(db, client));
    expect(calls.map((c) => c.method)).not.toContain('triggers.create');
    expect(db.patches[0].patch.composio_trigger_id).toBe('ti_existing');
  });

  // RUNG 10B.3. Watching SENT is a change to the trigger's CONFIG, and every
  // seat paired before it carries the old one. Without this the phase ships
  // inert: the code is right and no live mailbox ever delivers the firm's half.
  test('an existing trigger with a STALE config is reconfigured, not left alone', async () => {
    const db = dbStubs();
    const { client, calls } = clientStub({
      accounts: [ACTIVE_GMAIL],
      // What every seat paired before this rung actually holds.
      activeTriggers: [
        { id: 'ti_existing', trigger_config: { interval: 1, labelIds: 'INBOX', userId: 'me' } },
      ],
    });
    await checkPairing(tech(), pairingDeps(db, client));
    const create = calls.find((c) => c.method === 'triggers.create');
    expect(create).toBeDefined();
    // The UPSERT endpoint, pinned to the same account — never a delete+create,
    // which would drop the polling watermark and redeliver the whole mailbox.
    expect(calls.map((c) => c.method)).not.toContain('triggers.delete');
    expect(create?.args[2]).toMatchObject({
      connectedAccountId: 'ca_abc123',
      triggerConfig: { ...GMAIL_TRIGGER_CONFIG },
    });
  });

  test('the config that goes out watches SENT through `query`, not a second labelId', async () => {
    // labelIds takes ONE label (live trigger-type schema, 2026-09-09), and
    // `query` takes precedence over it — so "INBOX plus SENT" is a query.
    expect(GMAIL_TRIGGER_CONFIG.query).toBe('label:inbox OR label:sent');
    expect(GMAIL_TRIGGER_CONFIG.labelIds).toBe('INBOX');
  });

  test('a reconfigure that FAILS keeps the trigger that already works', async () => {
    // The mailbox still delivers INBOX. Turning a live pairing into a failed one
    // over a narrower filter would be the worse trade.
    const db = dbStubs();
    const { client } = clientStub({
      accounts: [ACTIVE_GMAIL],
      activeTriggers: [{ id: 'ti_existing', trigger_config: { labelIds: 'INBOX' } }],
      createThrows: true,
    });
    const r = await checkPairing(tech(), pairingDeps(db, client));
    expect(r).toMatchObject({ status: 'paired' });
    expect(db.patches[0].patch.composio_trigger_id).toBe('ti_existing');
  });

  test('a create that fails with NO trigger to keep still throws — the sweep heals it', async () => {
    const db = dbStubs();
    const { client } = clientStub({ accounts: [ACTIVE_GMAIL], createThrows: true });
    await expect(checkPairing(tech(), pairingDeps(db, client))).rejects.toThrow();
  });

  test('profile fetch failure is advisory: still paired, email null in claim and item', async () => {
    const db = dbStubs();
    const { client } = clientStub({ accounts: [ACTIVE_GMAIL], profileThrows: true });
    const r = await checkPairing(tech(), pairingDeps(db, client));
    expect(r).toEqual({ status: 'paired', connectedAccountId: 'ca_abc123', email: null });
    expect(db.casCalls[0].patch.connected_email).toBeNull();
    expect(db.items[0].detail).toMatchObject({ email: null });
  });

  // GMAIL_GET_PROFILE is a billed Composio execution that never crosses the
  // doorman relay, so the relay's collector cannot see it — it is counted here
  // or nowhere. It also runs unattended on the 15-minute cron for every
  // invited/pending row, making it the only Composio cost that accrues with no
  // human action at all.
  describe('cost metering', () => {
    test('bills exactly one call when the profile probe actually runs', async () => {
      costCalls.length = 0;
      const db = dbStubs();
      const { client } = clientStub({ accounts: [ACTIVE_GMAIL] });
      await checkPairing(tech(), pairingDeps(db, client));
      expect(costCalls).toEqual([{ tenantId: tech().tenant_id, technicianRef: tech().ref }]);
    });

    test('bills nothing on the paths that never execute a tool', async () => {
      costCalls.length = 0;
      const db = dbStubs();
      // No ACTIVE account -> returns before the profile probe.
      await checkPairing(
        tech(),
        pairingDeps(db, clientStub({ accounts: [{ id: 'ca_x', status: 'INITIATED', toolkit: { slug: 'gmail' } }] }).client),
      );
      // Wrong state -> returns before listing accounts at all.
      await checkPairing(tech({ state: 'active' }), pairingDeps(db, clientStub({ accounts: [ACTIVE_GMAIL] }).client));
      // The execution itself threw -> Composio billed nothing.
      await checkPairing(
        tech(),
        pairingDeps(db, clientStub({ accounts: [ACTIVE_GMAIL], profileThrows: true }).client),
      );
      expect(costCalls).toEqual([]);
    });

    test('a failing cost write leaves pairing verification intact', async () => {
      const db = dbStubs();
      const { client } = clientStub({ accounts: [ACTIVE_GMAIL] });
      const r = await checkPairing(tech(), {
        ...pairingDeps(db, client),
        recordCost: async () => { throw new Error('cost ledger is down'); },
      });
      // Still paired, and the email the manager verifies against is still there.
      expect(r).toEqual({ status: 'paired', connectedAccountId: 'ca_abc123', email: 'jane.doe@gmail.com' });
    });
  });

  test('reads a nested response_data profile shape too', async () => {
    const db = dbStubs();
    const { client } = clientStub({
      accounts: [ACTIVE_GMAIL],
      profileData: { response_data: { emailAddress: 'nested@gmail.com' } },
    });
    const r = await checkPairing(tech(), pairingDeps(db, client));
    expect(r).toMatchObject({ email: 'nested@gmail.com' });
  });
});

describe('unpair', () => {
  const paired = () =>
    tech({
      state: 'pending_verification',
      composio_connected_account_id: 'ca_abc123',
      composio_trigger_id: 'ti_new123',
      connected_email: 'jane.doe@gmail.com',
      link_issued_at: '2026-07-02T20:00:00.000Z',
    });

  test('deletes trigger then account, clears the inventory via CAS, returns to invited', async () => {
    const db = dbStubs();
    const { client, calls } = clientStub();
    await unpair(paired(), pairingDeps(db, client));
    expect(calls.map((c) => c.method)).toEqual(['triggers.delete', 'accounts.delete']); // trigger FIRST
    // CAS from pending_verification: a deactivation landing mid-teardown wins
    // and its state is left alone.
    expect(db.casCalls[0]).toMatchObject({
      from: 'pending_verification',
      patch: {
        composio_connected_account_id: null,
        composio_trigger_id: null,
        connected_email: null,
        link_issued_at: null,
        state: 'invited',
      },
    });
  });

  test('swallows only REAL API 404s; network errors and lying 500s rethrow', async () => {
    const db = dbStubs();
    // Status-attached API 404 (the client's real already-deleted shape) â€” swallowed.
    const apiNotFound = clientStub({
      deleteThrows: () => Object.assign(new Error('boom'), { status: 404 }),
    });
    await unpair(paired(), pairingDeps(db, apiNotFound.client));
    expect(db.casCalls).toHaveLength(1); // teardown completed despite the 404s

    // A DNS failure whose message happens to contain "NOTFOUND" must RETHROW â€”
    // swallowing it would let a network outage masquerade as already-deleted
    // (review finding: /not[ _-]?found/i matched ENOTFOUND).
    const dnsDown = clientStub({
      deleteThrows: () => new Error('getaddrinfo ENOTFOUND backend.composio.dev'),
    });
    await expect(unpair(paired(), pairingDeps(db, dnsDown.client))).rejects.toThrow('ENOTFOUND');

    const broken = clientStub({ deleteThrows: () => new Error('500 internal error') });
    await expect(unpair(paired(), pairingDeps(db, broken.client))).rejects.toThrow('500');
    // A 500 whose BODY mentions "not found" must NOT be swallowed (status wins).
    const lying = clientStub({
      deleteThrows: () => Object.assign(new Error('upstream said not found'), { status: 500 }),
    });
    await expect(unpair(paired(), pairingDeps(db, lying.client))).rejects.toThrow('not found');
    expect(db.casCalls).toHaveLength(1); // no extra writes â€” inventory NOT cleared on failure
  });
});
