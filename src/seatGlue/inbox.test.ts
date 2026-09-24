import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpInit } from './http.js';
import { fetchInbox, InboxRefused, reportInbox } from './inbox.js';

const TOKEN = `st_${'a'.repeat(64)}`;
const ID = '11111111-2222-4333-8444-555555555555';

function fake(status: number, body: unknown = {}): { fetch: FetchLike; calls: Array<{ url: string; init?: HttpInit }> } {
  const calls: Array<{ url: string; init?: HttpInit }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    },
  };
}

describe('fetchInbox', () => {
  it('pulls /seat/inbox with the seat token and returns the seat and its items', async () => {
    const f = fake(200, {
      seat: { telegramUserId: '5801703167', timezone: 'America/Vancouver' },
      items: [
        { id: ID, leg: 'phone', text: 'How did the Smith visit go?' },
        { id: ID.replace('1111', '9999'), leg: 'note', text: 'OFFICE NOTE (…): the Smith job is open to them' },
      ],
    });
    const got = await fetchInbox('https://spine.example/mcp', TOKEN, f.fetch);
    expect(f.calls[0].url).toBe('https://spine.example/seat/inbox');
    expect(f.calls[0].init?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(got.seat).toEqual({ telegramUserId: '5801703167', timezone: 'America/Vancouver' });
    expect(got.items.map((i) => i.leg)).toEqual(['phone', 'note']);
  });

  it('keeps a null Telegram id (unbound) as null', async () => {
    const got = await fetchInbox('https://s/', TOKEN, fake(200, { seat: { telegramUserId: null, timezone: 'UTC' }, items: [] }).fetch);
    expect(got.seat.telegramUserId).toBeNull();
  });

  it('skips a malformed item and keeps the rest', async () => {
    const got = await fetchInbox(
      'https://s/',
      TOKEN,
      fake(200, {
        seat: { telegramUserId: '1', timezone: 'UTC' },
        items: [{ id: 'nope', leg: 'phone', text: 'x' }, { id: ID, leg: 'sms', text: 'x' }, { id: ID, leg: 'note', text: '' }, { id: ID, leg: 'phone', text: 'ok' }],
      }).fetch,
    );
    expect(got.items).toEqual([{ id: ID, leg: 'phone', text: 'ok' }]);
  });

  it('throws on a body with no seat or no items', async () => {
    await expect(fetchInbox('https://s/', TOKEN, fake(200, { items: [] }).fetch)).rejects.toThrow(/no seat/);
    await expect(fetchInbox('https://s/', TOKEN, fake(200, { seat: { telegramUserId: '1', timezone: 'UTC' } }).fetch)).rejects.toThrow(/no items/);
  });

  it.each([401, 403] as const)('HTTP %i → InboxRefused with that status', async (status) => {
    const err = await fetchInbox('https://s/', TOKEN, fake(status).fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InboxRefused);
    expect((err as InboxRefused).status).toBe(status);
  });

  it('a 5xx is a plain error (retry next tick), not a refusal', async () => {
    const err = await fetchInbox('https://s/', TOKEN, fake(500).fetch).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(InboxRefused);
  });
});

describe('reportInbox', () => {
  it('POSTs the item, leg and outcome with the seat token', async () => {
    const f = fake(200, { result: 'asked' });
    await reportInbox('https://s/', TOKEN, { id: ID, leg: 'phone', outcome: 'delivered' }, f.fetch);
    expect(f.calls[0].init?.method).toBe('POST');
    expect(JSON.parse(f.calls[0].init?.body as string)).toEqual({ id: ID, leg: 'phone', outcome: 'delivered' });
  });

  it('throws on a refusal so the caller logs it', async () => {
    await expect(reportInbox('https://s/', TOKEN, { id: ID, leg: 'note', outcome: 'failed' }, fake(500).fetch)).rejects.toThrow();
  });
});
