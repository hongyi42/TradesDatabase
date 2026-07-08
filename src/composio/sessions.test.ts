import { describe, expect, test } from 'vitest';
import type { Technician, TechnicianPatch } from '../db/technicians.js';
import type { PairingClient } from './pairing.js';
import {
  TECHNICIAN_GMAIL_TOOLS,
  ensurePersonSession,
  getSessionMcpUrl,
  sessionConfigForTier,
  teardownPersonSession,
} from './sessions.js';

// Pure unit tests â€” client + db seams stubbed (pairing.test.ts pattern).

function tech(over: Partial<Technician> = {}): Technician {
  return {
    id: 'tech-1',
    tenant_id: '11111111-1111-1111-1111-111111111111',
    ref: 'jane-doe',
    display_name: 'Jane Doe',
    tier: 'technician',
    state: 'active',
    sandbox_ref: null,
    composio_connected_account_id: 'ca_abc',
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
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

function sessionClientStub(opts: {
  createResult?: Record<string, unknown>;
  useResult?: Record<string, unknown>;
  deleteThrows?: Error;
} = {}) {
  const creates: Array<{ userId: string; config: Record<string, unknown> | undefined }> = [];
  const uses: Array<{ id: string; opts?: Record<string, unknown> }> = [];
  const deletes: string[] = [];
  const boom = (what: string) => async () => {
    throw new Error(`sessions module must not call ${what}`);
  };
  const client: PairingClient = {
    connectedAccounts: {
      list: boom('accounts.list'),
      link: boom('accounts.link'),
      delete: boom('accounts.delete'),
      disable: boom('accounts.disable'),
      enable: boom('accounts.enable'),
    },
    triggers: {
      listActive: boom('triggers.listActive'),
      create: boom('triggers.create'),
      delete: boom('triggers.delete'),
      disable: boom('triggers.disable'),
      enable: boom('triggers.enable'),
    },
    tools: { execute: boom('tools.execute') },
    sessions: {
      create: async (userId, config) => {
        creates.push({ userId, config });
        return opts.createResult ?? { id: 'trs_new1' };
      },
      use: async (id, o) => {
        uses.push({ id, opts: o });
        return opts.useResult ?? { mcp: { url: 'https://mcp.composio.example/trs_new1' } };
      },
      delete: async (id: string) => {
        deletes.push(id);
        if (opts.deleteThrows) throw opts.deleteThrows;
        return {};
      },
    },
  };
  return { client, creates, uses, deletes };
}

function updateStub() {
  const patches: Array<{ id: string; patch: TechnicianPatch }> = [];
  const update = async (id: string, patch: TechnicianPatch) => {
    patches.push({ id, patch });
    return tech({ id, ...patch } as Partial<Technician>);
  };
  return { patches, update };
}

describe('sessionConfigForTier â€” the hard rule', () => {
  test('BOTH tiers produce an explicit, non-empty config object (never bare)', () => {
    for (const tier of ['manager', 'technician'] as const) {
      const config = sessionConfigForTier(tier);
      expect(config).toBeTruthy();
      expect(Object.keys(config).length).toBeGreaterThan(0);
    }
  });

  test('technician: direct_tools preset, pinned gmail list, NO connection management', () => {
    const config = sessionConfigForTier('technician');
    expect(config).toEqual({
      sessionPreset: 'direct_tools',
      toolkits: ['gmail'],
      tools: { gmail: TECHNICIAN_GMAIL_TOOLS },
      manageConnections: false,
      mcp: true,
    });
  });

  test('technician list can NEVER contain send tools', () => {
    expect(TECHNICIAN_GMAIL_TOOLS).not.toContain('GMAIL_SEND_EMAIL');
    expect(TECHNICIAN_GMAIL_TOOLS).not.toContain('GMAIL_REPLY_TO_THREAD');
    expect(TECHNICIAN_GMAIL_TOOLS.length).toBeGreaterThan(0);
  });

  test('manager: entire catalog (no toolkit restriction) + self-serve pairing, explicitly', () => {
    const config = sessionConfigForTier('manager');
    expect(config).toEqual({ manageConnections: true, mcp: true });
    expect(config).not.toHaveProperty('toolkits'); // full catalog is intentional
  });
});

describe('ensurePersonSession', () => {
  test('creates with the composite user id and an explicit tier config, persists the id', async () => {
    const { client, creates } = sessionClientStub();
    const { patches, update } = updateStub();
    const result = await ensurePersonSession(tech(), { client, update });
    expect(result).toEqual({ status: 'created', sessionId: 'trs_new1' });
    expect(creates).toHaveLength(1);
    expect(creates[0].userId).toBe('11111111-1111-1111-1111-111111111111:jane-doe');
    expect(creates[0].config).toEqual(sessionConfigForTier('technician')); // never bare/undefined
    expect(patches).toEqual([{ id: 'tech-1', patch: { composio_session_id: 'trs_new1' } }]);
  });

  test('manager rows get the manager config', async () => {
    const { client, creates } = sessionClientStub();
    const { update } = updateStub();
    await ensurePersonSession(tech({ tier: 'manager' }), { client, update });
    expect(creates[0].config).toEqual({ manageConnections: true, mcp: true });
  });

  test('idempotent: an existing session id means NO create call', async () => {
    const { client, creates } = sessionClientStub();
    const { patches, update } = updateStub();
    const result = await ensurePersonSession(tech({ composio_session_id: 'trs_old' }), {
      client,
      update,
    });
    expect(result).toEqual({ status: 'exists', sessionId: 'trs_old' });
    expect(creates).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  test('non-active states are skipped, no Composio call', async () => {
    const { client, creates } = sessionClientStub();
    const { update } = updateStub();
    for (const state of ['invited', 'pending_verification', 'offboarding', 'offboarded'] as const) {
      const result = await ensurePersonSession(tech({ state }), { client, update });
      expect(result).toEqual({ status: 'skipped', reason: `state is ${state}` });
    }
    expect(creates).toHaveLength(0);
  });

  test('tolerant id parse (session_id snake_case) and no-id error', async () => {
    const snake = sessionClientStub({ createResult: { session_id: 'trs_snake' } });
    const { update } = updateStub();
    const r = await ensurePersonSession(tech(), { client: snake.client, update });
    expect(r).toEqual({ status: 'created', sessionId: 'trs_snake' });

    const empty = sessionClientStub({ createResult: { ok: true } });
    await expect(ensurePersonSession(tech(), { client: empty.client, update })).rejects.toThrow(
      'no session id',
    );
  });
});

describe('getSessionMcpUrl', () => {
  test('uses the stored session id with mcp:true and returns mcp.url', async () => {
    const { client, uses } = sessionClientStub();
    const url = await getSessionMcpUrl(tech({ composio_session_id: 'trs_x' }), { client });
    expect(url).toBe('https://mcp.composio.example/trs_new1');
    expect(uses).toEqual([{ id: 'trs_x', opts: { mcp: true } }]);
  });

  test('no session on the row â†’ clean error naming the sweep', async () => {
    const { client } = sessionClientStub();
    await expect(getSessionMcpUrl(tech(), { client })).rejects.toThrow('has no session');
  });

  test('no url in the response â†’ clean error', async () => {
    const { client } = sessionClientStub({ useResult: { mcp: {} } });
    await expect(
      getSessionMcpUrl(tech({ composio_session_id: 'trs_x' }), { client }),
    ).rejects.toThrow('no mcp.url');
  });
});

describe('ensurePersonSession â€” orphan compensation', () => {
  test('a failed roster persist deletes the just-created session (no orphan)', async () => {
    const { client, creates, deletes } = sessionClientStub();
    const failingUpdate = async () => {
      throw new Error('db unreachable');
    };
    await expect(
      ensurePersonSession(tech(), { client, update: failingUpdate as never }),
    ).rejects.toThrow('db unreachable');
    expect(creates).toHaveLength(1);
    expect(deletes).toEqual(['trs_new1']); // compensating delete
  });
});

describe('teardownPersonSession', () => {
  test('deletes the session and NULLS the column (reactivation re-mints at current tier)', async () => {
    const { client, deletes } = sessionClientStub();
    const { patches, update } = updateStub();
    const r = await teardownPersonSession(tech({ composio_session_id: 'trs_x' }), {
      client,
      update,
    });
    expect(r).toEqual({ status: 'deleted' });
    expect(deletes).toEqual(['trs_x']);
    expect(patches).toEqual([{ id: 'tech-1', patch: { composio_session_id: null } }]);
  });

  test('no session on the row â†’ none, no Composio call', async () => {
    const { client, deletes } = sessionClientStub();
    const { patches, update } = updateStub();
    const r = await teardownPersonSession(tech(), { client, update });
    expect(r).toEqual({ status: 'none' });
    expect(deletes).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  test('an already-gone session (404) still clears the column; other errors keep it for retry', async () => {
    const gone = sessionClientStub({
      deleteThrows: Object.assign(new Error('not found'), { status: 404 }),
    });
    const g = updateStub();
    const r404 = await teardownPersonSession(tech({ composio_session_id: 'trs_x' }), {
      client: gone.client,
      update: g.update,
    });
    expect(r404).toEqual({ status: 'deleted' });
    expect(g.patches).toEqual([{ id: 'tech-1', patch: { composio_session_id: null } }]);

    const err = sessionClientStub({ deleteThrows: new Error('503') });
    const e = updateStub();
    await expect(
      teardownPersonSession(tech({ composio_session_id: 'trs_x' }), {
        client: err.client,
        update: e.update,
      }),
    ).rejects.toThrow('503');
    expect(e.patches).toHaveLength(0); // column kept â€” expiry retry pass owns it
  });
});
