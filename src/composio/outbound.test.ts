import { describe, expect, test } from 'vitest';
import type { Technician } from '../db/technicians.js';
import type { PairingClient } from './pairing.js';
import { requireOutboundCapable, sendGmailEmail } from './outbound.js';

// Pure unit tests — the Composio client is stubbed (pairing.test.ts pattern);
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
  test('null row → clean no-roster error', () => {
    expect(() => requireOutboundCapable(null)).toThrow('no roster row for this badge');
  });

  test('every non-active state is refused', () => {
    for (const state of ['invited', 'pending_verification', 'offboarding', 'offboarded'] as const) {
      expect(() => requireOutboundCapable(tech({ state }))).toThrow(`not active (state: ${state})`);
    }
  });

  test('active but unpaired → no-mailbox error (ids persisting after offboarding never reach here)', () => {
    expect(() => requireOutboundCapable(tech({ composio_connected_account_id: null }))).toThrow(
      'no paired mailbox',
    );
  });

  test('active + paired passes', () => {
    expect(() => requireOutboundCapable(tech())).not.toThrow();
  });
});

describe('sendGmailEmail', () => {
  test('correct slug, skip flag, and roster-derived ids (never from args)', async () => {
    const { client, calls } = clientStub({ successful: true, data: { id: 'msg-1' } });
    await sendGmailEmail(tech(), MSG, { client });
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
    await expect(sendGmailEmail(tech({ state: 'offboarding' }), MSG, { client })).rejects.toThrow(
      'not active',
    );
    await expect(
      sendGmailEmail(tech({ composio_connected_account_id: null }), MSG, { client }),
    ).rejects.toThrow('no paired mailbox');
    expect(calls).toHaveLength(0);
  });

  test('successful:false → throws with Composio error text', async () => {
    const { client } = clientStub({ successful: false, error: 'quota exceeded' });
    await expect(sendGmailEmail(tech(), MSG, { client })).rejects.toThrow(
      'Composio send failed: quota exceeded',
    );
  });

  test('parses the flat envelope (data.id / data.threadId)', async () => {
    const { client } = clientStub({ successful: true, data: { id: 'm-flat', threadId: 't-flat' } });
    const r = await sendGmailEmail(tech(), MSG, { client });
    expect(r).toEqual({ messageId: 'm-flat', threadId: 't-flat' });
  });

  test('parses the nested envelope (data.response_data.*, snake_case keys)', async () => {
    const { client } = clientStub({
      successful: true,
      data: { response_data: { message_id: 'm-nested', thread_id: 't-nested' } },
    });
    const r = await sendGmailEmail(tech(), MSG, { client });
    expect(r).toEqual({ messageId: 'm-nested', threadId: 't-nested' });
  });

  test('no parseable ids → nulls (caller falls back to the confirm-id external id)', async () => {
    const { client } = clientStub({ successful: true, data: { ok: true } });
    const r = await sendGmailEmail(tech(), MSG, { client });
    expect(r).toEqual({ messageId: null, threadId: null });
  });
});
