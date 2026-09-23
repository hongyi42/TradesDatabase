import { describe, expect, it } from 'vitest';
import type { FetchLike } from './http.js';
import { fetchWhoami } from './whoami.js';

const TOKEN = `st_${'cd'.repeat(32)}`;
const GOOD = {
  seatRef: 's5',
  tenantId: 'tenant-1',
  technicianRef: 'ben-shelton',
  telegramUserId: '5801703167',
  timezone: 'America/Los_Angeles',
};

function fake(status: number, body: unknown, seen: { url?: string; auth?: string } = {}): FetchLike {
  return async (url, init) => {
    seen.url = url;
    seen.auth = init?.headers?.authorization;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

describe('fetchWhoami', () => {
  it('asks /seat/whoami with the seat token and returns who the seat is', async () => {
    const seen: { url?: string; auth?: string } = {};
    const who = await fetchWhoami('https://spine.example/', TOKEN, fake(200, GOOD, seen));
    expect(seen).toEqual({ url: 'https://spine.example/seat/whoami', auth: `Bearer ${TOKEN}` });
    expect(who).toEqual({
      seatRef: 's5',
      tenantId: 'tenant-1',
      technicianRef: 'ben-shelton',
      telegramUserId: 5801703167,
      tz: 'America/Los_Angeles',
    });
  });

  it('a refused token (401) or a deactivated person (403) stops the seat, never guessing', async () => {
    await expect(fetchWhoami('https://spine.example/', TOKEN, fake(401, {}))).rejects.toThrow('HTTP 401');
    await expect(fetchWhoami('https://spine.example/', TOKEN, fake(403, {}))).rejects.toThrow('HTTP 403');
  });

  it('refuses an unbound Telegram account, a bad timezone and a missing field', async () => {
    await expect(
      fetchWhoami('https://spine.example/', TOKEN, fake(200, { ...GOOD, telegramUserId: null })),
    ).rejects.toThrow('Telegram');
    await expect(
      fetchWhoami('https://spine.example/', TOKEN, fake(200, { ...GOOD, timezone: 'Mars/Olympus' })),
    ).rejects.toThrow('IANA');
    await expect(
      fetchWhoami('https://spine.example/', TOKEN, fake(200, { ...GOOD, technicianRef: '' })),
    ).rejects.toThrow('technicianRef');
  });
});
