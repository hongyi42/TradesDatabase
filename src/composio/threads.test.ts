import { describe, expect, test, vi } from 'vitest';
import { fetchThreadMessages } from './threads.js';
import type { Technician } from '../db/index.js';
import type { PairingClient } from './pairing.js';

// The thread fetch is ADVISORY by contract: it runs inside the inbound webhook
// request, on the path that lands a customer's message in L1, so every failure
// shape must return null rather than cost the firm the email.
const tech = {
  id: 't1',
  tenant_id: 'ten-1',
  ref: 'manager-sam',
  composio_connected_account_id: 'ca_test',
} as unknown as Technician;

const clientReturning = (result: unknown): PairingClient =>
  ({ tools: { execute: vi.fn(async () => result) } }) as unknown as PairingClient;

describe('fetchThreadMessages', () => {
  test('maps the thread’s messages, tolerating both envelope shapes and both spellings', async () => {
    const costs: unknown[] = [];
    const rows = await fetchThreadMessages(tech, 'thread-1', {
      client: clientReturning({
        successful: true,
        data: {
          response_data: {
            messages: [
              {
                messageId: 'm1',
                sender: 'Jane <jane@home.test>',
                to: 'office@firm.test',
                subject: 'AC repair',
                messageText: 'unit still noisy',
                messageTimestamp: '2026-09-01T10:00:00.000Z',
              },
              // snake_case, and `preview` standing in for the body.
              { message_id: 'm2', from: 'office@firm.test', preview: 'we can come Friday' },
            ],
          },
        },
      }),
      recordCost: (async (input: unknown) => {
        costs.push(input);
      }) as never,
    });
    expect(rows).toEqual([
      {
        messageId: 'm1',
        from: 'Jane <jane@home.test>',
        to: 'office@firm.test',
        subject: 'AC repair',
        body: 'unit still noisy',
        at: '2026-09-01T10:00:00.000Z',
      },
      {
        messageId: 'm2',
        from: 'office@firm.test',
        to: null,
        subject: null,
        body: 'we can come Friday',
        at: null,
      },
    ]);
    // Billed against the mailbox's own person.
    expect(costs).toEqual([{ tenantId: 'ten-1', technicianRef: 'manager-sam' }]);
  });

  test('a FAILED execution is still billed — Composio charged for the attempt', async () => {
    const costs: unknown[] = [];
    const rows = await fetchThreadMessages(tech, 'thread-1', {
      client: clientReturning({ successful: false, error: 'rate limited' }),
      recordCost: (async (input: unknown) => {
        costs.push(input);
      }) as never,
    });
    expect(rows).toBeNull();
    expect(costs).toHaveLength(1);
  });

  test('every failure shape degrades to null, never a throw', async () => {
    const noCost = { recordCost: (async () => {}) as never };
    // A throwing client (network, revoked account, SDK version error).
    expect(
      await fetchThreadMessages(tech, 'thread-1', {
        ...noCost,
        client: {
          tools: {
            execute: vi.fn(async () => {
              throw new Error('connection reset');
            }),
          },
        } as unknown as PairingClient,
      }),
    ).toBeNull();
    // A shape with no messages array at all.
    expect(
      await fetchThreadMessages(tech, 'thread-1', {
        ...noCost,
        client: clientReturning({ successful: true, data: {} }),
      }),
    ).toBeNull();
    // No thread id, and no paired mailbox: neither is even attempted.
    expect(await fetchThreadMessages(tech, '', noCost)).toBeNull();
    expect(
      await fetchThreadMessages(
        { ...tech, composio_connected_account_id: null } as unknown as Technician,
        'thread-1',
        noCost,
      ),
    ).toBeNull();
  });

  test('OLDEST FIRST, sorted rather than assumed — and both timestamp units', async () => {
    // The renderer promises "EARLIER IN THIS CONVERSATION" and shows the LAST
    // eight, so an API answering newest-first would hand the model the eight
    // oldest in reverse and drop the recent exchange, silently.
    const rows = await fetchThreadMessages(tech, 'thread-1', {
      recordCost: (async () => {}) as never,
      client: clientReturning({
        successful: true,
        data: {
          messages: [
            { messageId: 'newest', messageText: 'c', messageTimestamp: '2026-09-03T10:00:00.000Z' },
            // epoch MILLISECONDS, Gmail's other spelling — a string compare
            // would sort this against an ISO string and get nonsense.
            { messageId: 'oldest', messageText: 'a', internalDate: '1788091200000' },
            { messageId: 'middle', messageText: 'b', messageTimestamp: '2026-09-02T10:00:00.000Z' },
          ],
        },
      }),
    });
    expect(rows?.map((r) => r.messageId)).toEqual(['oldest', 'middle', 'newest']);
  });

  test('unknown timestamps keep the order the API gave, never a coin toss', async () => {
    const rows = await fetchThreadMessages(tech, 'thread-1', {
      recordCost: (async () => {}) as never,
      client: clientReturning({
        successful: true,
        data: {
          messages: [
            { messageId: 'first', messageText: 'a' },
            { messageId: 'second', messageText: 'b' },
            { messageId: 'third', messageText: 'c' },
          ],
        },
      }),
    });
    expect(rows?.map((r) => r.messageId)).toEqual(['first', 'second', 'third']);
  });

  test('a STALL is a timeout, not a hung webhook — the delivery must not wait forever', async () => {
    const rows = await fetchThreadMessages(tech, 'thread-1', {
      timeoutMs: 5,
      recordCost: (async () => {}) as never,
      client: {
        tools: {
          execute: vi.fn(
            () => new Promise(() => {}), // never settles
          ),
        },
      } as unknown as PairingClient,
    });
    expect(rows).toBeNull();
  });

  test('a garbage entry in the list is dropped, not dereferenced', async () => {
    const rows = await fetchThreadMessages(tech, 'thread-1', {
      client: clientReturning({
        successful: true,
        data: { messages: [null, 'a string', { messageId: 'm9', messageText: 'real' }] },
      }),
      recordCost: (async () => {}) as never,
    });
    expect(rows).toHaveLength(1);
    expect(rows?.[0].messageId).toBe('m9');
  });
});
