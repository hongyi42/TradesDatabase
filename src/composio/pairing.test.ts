import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Technician, TechnicianPatch } from '../db/technicians.js';
import type { ReviewItem, UpsertOpenReviewItemInput } from '../db/index.js';
import { checkPairing, createConnectLink, unpair, type PairingClient } from './pairing.js';

// Pure unit tests — the Composio client and both db writes are stubbed, so
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
    created_at: '2026-07-02T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    ...over,
  };
}

// Recording stubs for the two db seams.
function dbStubs() {
  const patches: Array<{ id: string; patch: TechnicianPatch }> = [];
  const items: UpsertOpenReviewItemInput[] = [];
  return {
    patches,
    items,
    update: async (id: string, patch: TechnicianPatch) => {
      patches.push({ id, patch });
      return tech({ id, ...patch } as Partial<Technician>);
    },
    openReviewItem: async (input: UpsertOpenReviewItemInput) => {
      items.push(input);
      return { id: 'item-1' } as ReviewItem;
    },
  };
}

// Configurable Composio client stub; records every call.
function clientStub(opts: {
  accounts?: Array<Record<string, unknown>>;
  activeTriggers?: Array<Record<string, unknown>>;
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
    },
    triggers: {
      listActive: async (q) => {
        rec('triggers.listActive', q);
        return { items: opts.activeTriggers ?? [] };
      },
      create: async (userId, slug, o) => {
        rec('triggers.create', userId, slug, o);
        return { triggerId: 'ti_new123' };
      },
      delete: async (id) => {
        rec('triggers.delete', id);
        const err = opts.deleteThrows?.(id);
        if (err) throw err;
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
      const r = await checkPairing(tech({ state }), {
        client,
        update: db.update,
        openReviewItem: db.openReviewItem,
      });
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
    const r = await checkPairing(tech(), { client, update: db.update, openReviewItem: db.openReviewItem });
    expect(r).toEqual({ status: 'not_connected' });
    expect(db.patches).toHaveLength(0);
  });

  test('paired: ensures trigger, fetches email, persists inventory, advances state, opens the item', async () => {
    const db = dbStubs();
    const { client, calls } = clientStub({ accounts: [ACTIVE_GMAIL] });
    const r = await checkPairing(tech(), { client, update: db.update, openReviewItem: db.openReviewItem });
    expect(r).toEqual({ status: 'paired', connectedAccountId: 'ca_abc123', email: 'jane.doe@gmail.com' });

    // Trigger created (none existed), PINNED to the verified account, and the
    // adoption list filtered to our trigger type.
    const listCall = calls.find((c) => c.method === 'triggers.listActive')!;
    expect(listCall.args[0]).toMatchObject({
      connectedAccountIds: ['ca_abc123'],
      triggerNames: ['GMAIL_NEW_GMAIL_MESSAGE'],
    });
    const create = calls.find((c) => c.method === 'triggers.create')!;
    expect(create.args[2]).toMatchObject({ connectedAccountId: 'ca_abc123' });
    const exec = calls.find((c) => c.method === 'tools.execute')!;
    expect(exec.args[0]).toBe('GMAIL_GET_PROFILE');
    expect(exec.args[1]).toMatchObject({
      connectedAccountId: 'ca_abc123',
      dangerouslySkipVersionCheck: true,
    });

    expect(db.patches[0].patch).toMatchObject({
      composio_connected_account_id: 'ca_abc123',
      composio_trigger_id: 'ti_new123',
      connected_email: 'jane.doe@gmail.com',
      state: 'pending_verification',
    });
    expect(db.items[0]).toMatchObject({
      kind: 'pairing_verification',
      subjectRef: 'jane-doe',
      detail: { email: 'jane.doe@gmail.com', connectedAccountId: 'ca_abc123' },
    });
  });

  test('idempotent on an existing trigger: adopts it, never calls create', async () => {
    const db = dbStubs();
    const { client, calls } = clientStub({
      accounts: [ACTIVE_GMAIL],
      activeTriggers: [{ id: 'ti_existing' }],
    });
    await checkPairing(tech(), { client, update: db.update, openReviewItem: db.openReviewItem });
    expect(calls.map((c) => c.method)).not.toContain('triggers.create');
    expect(db.patches[0].patch.composio_trigger_id).toBe('ti_existing');
  });

  test('profile fetch failure is advisory: still paired, email null in row and item', async () => {
    const db = dbStubs();
    const { client } = clientStub({ accounts: [ACTIVE_GMAIL], profileThrows: true });
    const r = await checkPairing(tech(), { client, update: db.update, openReviewItem: db.openReviewItem });
    expect(r).toEqual({ status: 'paired', connectedAccountId: 'ca_abc123', email: null });
    expect(db.patches[0].patch.connected_email).toBeNull();
    expect(db.items[0].detail).toMatchObject({ email: null });
  });

  test('reads a nested response_data profile shape too', async () => {
    const db = dbStubs();
    const { client } = clientStub({
      accounts: [ACTIVE_GMAIL],
      profileData: { response_data: { emailAddress: 'nested@gmail.com' } },
    });
    const r = await checkPairing(tech(), { client, update: db.update, openReviewItem: db.openReviewItem });
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

  test('deletes trigger then account, clears the inventory, returns to invited', async () => {
    const db = dbStubs();
    const { client, calls } = clientStub();
    await unpair(paired(), { client, update: db.update });
    expect(calls.map((c) => c.method)).toEqual(['triggers.delete', 'accounts.delete']); // trigger FIRST
    expect(db.patches[0].patch).toEqual({
      composio_connected_account_id: null,
      composio_trigger_id: null,
      connected_email: null,
      link_issued_at: null,
      state: 'invited',
    });
  });

  test('swallows 404s (already deleted); rethrows anything else', async () => {
    const db = dbStubs();
    // Status-attached API error (the client's real shape) — swallowed.
    const apiNotFound = clientStub({
      deleteThrows: () => Object.assign(new Error('boom'), { status: 404 }),
    });
    await unpair(paired(), { client: apiNotFound.client, update: db.update });
    // Message-only fallback for non-API error shapes — also swallowed.
    const notFound = clientStub({ deleteThrows: () => new Error('404 not found') });
    await unpair(paired(), { client: notFound.client, update: db.update });
    expect(db.patches).toHaveLength(2); // teardown completed despite the 404s

    const broken = clientStub({ deleteThrows: () => new Error('500 internal error') });
    await expect(unpair(paired(), { client: broken.client, update: db.update })).rejects.toThrow(
      '500',
    );
    // A 500 whose BODY mentions "not found" must NOT be swallowed (status wins).
    const lying = clientStub({
      deleteThrows: () => Object.assign(new Error('upstream said not found'), { status: 500 }),
    });
    await expect(unpair(paired(), { client: lying.client, update: db.update })).rejects.toThrow(
      'not found',
    );
    expect(db.patches).toHaveLength(2); // no extra patches — inventory NOT cleared on failure
  });
});
