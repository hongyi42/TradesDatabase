import { describe, expect, test } from 'vitest';
import type { Technician } from '../db/technicians.js';
import type { PairingClient } from './pairing.js';
import { requireOutboundCapable, sendGmailEmail } from './outbound.js';

// Pure unit tests â€” the Composio client is stubbed (pairing.test.ts pattern);
// nothing here needs COMPOSIO_API_KEY or a database.

function tech(over: Partial<Technician> = {}): Technician {
  return {
    id: 'tech-1',
    tenant_id: '11111111-1111-1111-1111-111111111111',
    ref: 'jane-doe',
    display_name: 'Jane Doe',
    tier: 'technician',
    state: 'active',
    sandbox_ref: null,
    composio_connected_account_id: 'ca_abc123',
    composio_trigger_id: 'ti_abc123',
    connected_email: 'jane.doe@gmail.com',
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
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

// Minimal recording client: only tools.execute matters here; everything else
// throws so a stray call is loud.
function clientStub(result: Record<string, unknown>) {
  const calls: Array<{ slug: string; body: Record<string, unknown> }> = [];
  const boom = (what: string) => async () => {
    throw new Error(`outbound must not call ${what}`);
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
    tools: {
      execute: async (slug, body) => {
        calls.push({ slug, body });
        return result;
      },
    },
    sessions: {
      create: boom('sessions.create'),
      use: boom('sessions.use'),
      delete: boom('sessions.delete'),
    },
  };
  return { client, calls };
}

const MSG = { to: 'customer@example.com', subject: 'Quote', body: 'Hi there' };

describe('requireOutboundCapable', () => {
  test('null row â†’ clean no-roster error', () => {
    expect(() => requireOutboundCapable(null)).toThrow('no roster row for this badge');
  });

  test('every non-active state is refused', () => {
    for (const state of ['invited', 'pending_verification', 'offboarding', 'offboarded'] as const) {
      expect(() => requireOutboundCapable(tech({ state }))).toThrow(`not active (state: ${state})`);
    }
  });

  test('active but unpaired â†’ no-mailbox error (ids persisting after offboarding never reach here)', () => {
    expect(() => requireOutboundCapable(tech({ composio_connected_account_id: null }))).toThrow(
      'no paired mailbox',
    );
  });

  test('active + paired passes', () => {
    expect(() => requireOutboundCapable(tech())).not.toThrow();
  });
});

// Stubbed in every call below. Left unstubbed, `deps.recordCost ??
// recordComposioCall` falls through to the real DB accessor, and this file's
// "nothing here needs a database" claim quietly stops being true — the writes
// fail the tenant FK and get swallowed, so the only symptom is a round-trip per
// send on every suite run.
const noCost = async () => {};

describe('sendGmailEmail', () => {
  test('correct slug, skip flag, and roster-derived ids (never from args)', async () => {
    const { client, calls } = clientStub({ successful: true, data: { id: 'msg-1' } });
    await sendGmailEmail(tech(), MSG, { client, recordCost: noCost });
    expect(calls).toHaveLength(1);
    expect(calls[0].slug).toBe('GMAIL_SEND_EMAIL');
    expect(calls[0].body).toMatchObject({
      connectedAccountId: 'ca_abc123', // from the roster row
      userId: '11111111-1111-1111-1111-111111111111:jane-doe', // composite, from the row
      dangerouslySkipVersionCheck: true,
      arguments: { recipient_email: MSG.to, subject: MSG.subject, body: MSG.body },
    });
  });

  test('gate runs inside send too: non-active / unpaired rows never reach Composio', async () => {
    const { client, calls } = clientStub({ successful: true, data: {} });
    await expect(sendGmailEmail(tech({ state: 'offboarding' }), MSG, { client, recordCost: noCost })).rejects.toThrow(
      'not active',
    );
    await expect(
      sendGmailEmail(tech({ composio_connected_account_id: null }), MSG, { client, recordCost: noCost }),
    ).rejects.toThrow('no paired mailbox');
    expect(calls).toHaveLength(0);
  });

  test('successful:false â†’ throws with Composio error text', async () => {
    const { client } = clientStub({ successful: false, error: 'quota exceeded' });
    await expect(sendGmailEmail(tech(), MSG, { client, recordCost: noCost })).rejects.toThrow(
      'Composio send failed: quota exceeded',
    );
  });

  test('parses the flat envelope (data.id / data.threadId)', async () => {
    const { client } = clientStub({ successful: true, data: { id: 'm-flat', threadId: 't-flat' } });
    const r = await sendGmailEmail(tech(), MSG, { client, recordCost: noCost });
    expect(r).toEqual({ messageId: 'm-flat', threadId: 't-flat' });
  });

  test('parses the nested envelope (data.response_data.*, snake_case keys)', async () => {
    const { client } = clientStub({
      successful: true,
      data: { response_data: { message_id: 'm-nested', thread_id: 't-nested' } },
    });
    const r = await sendGmailEmail(tech(), MSG, { client, recordCost: noCost });
    expect(r).toEqual({ messageId: 'm-nested', threadId: 't-nested' });
  });

  test('no parseable ids â†’ nulls (caller falls back to the confirm-id external id)', async () => {
    const { client } = clientStub({ successful: true, data: { ok: true } });
    const r = await sendGmailEmail(tech(), MSG, { client, recordCost: noCost });
    expect(r).toEqual({ messageId: null, threadId: null });
  });

  // GMAIL_SEND_EMAIL is a billed Composio execution that never crosses the
  // doorman relay — the relay's collector cannot see this path, so it is
  // counted here or not at all.
  describe('cost metering', () => {
    const capture = () => {
      const calls: Array<{ tenantId: string; technicianRef?: string | null }> = [];
      return {
        calls,
        recordCost: async (ctx?: { tenantId: string; technicianRef?: string | null }) => {
          if (ctx) calls.push(ctx);
        },
      };
    };

    test('bills one call per send, tagged with the roster row', async () => {
      const { client } = clientStub({ successful: true, data: { id: 'm' } });
      const { calls, recordCost } = capture();
      await sendGmailEmail(tech(), MSG, { client, recordCost });
      expect(calls).toEqual([{ tenantId: tech().tenant_id, technicianRef: tech().ref }]);
    });

    test('bills a rejected send too — Composio charged for the attempt', async () => {
      const { client } = clientStub({ successful: false, error: 'quota exceeded' });
      const { calls, recordCost } = capture();
      await expect(sendGmailEmail(tech(), MSG, { client, recordCost })).rejects.toThrow('quota exceeded');
      expect(calls).toHaveLength(1);
    });

    test('bills nothing when the gate stops the send before Composio', async () => {
      const { client } = clientStub({ successful: true, data: {} });
      const { calls, recordCost } = capture();
      await expect(
        sendGmailEmail(tech({ composio_connected_account_id: null }), MSG, { client, recordCost }),
      ).rejects.toThrow('no paired mailbox');
      expect(calls).toEqual([]);
    });

    test('a failing cost write still delivers the send result', async () => {
      const { client } = clientStub({ successful: true, data: { id: 'm-ok', threadId: 't-ok' } });
      const r = await sendGmailEmail(tech(), MSG, {
        client,
        recordCost: async () => { throw new Error('cost ledger is down'); },
      });
      expect(r).toEqual({ messageId: 'm-ok', threadId: 't-ok' });
    });
  });
});
