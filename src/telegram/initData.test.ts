import { describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyInitData } from './initData.js';

// Pure unit tests: hand-built slips signed with a fixed token, no network/DB.
const TOKEN = '7000000001:TEST-token-for-initdata-suite';

// Mirror of Telegram's signing scheme so the suite can mint valid slips.
function signSlip(fields: Record<string, string>, token = TOKEN): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

const nowSec = () => Math.floor(Date.now() / 1000);

const validFields = () => ({
  auth_date: String(nowSec()),
  query_id: 'AAtest',
  user: JSON.stringify({ id: 777000111, first_name: 'Board', username: 'board_probe' }),
});

describe('verifyInitData', () => {
  test('a validly signed slip verifies and returns the user id as a string', () => {
    const out = verifyInitData(signSlip(validFields()), TOKEN);
    expect(out.userId).toBe('777000111');
    expect(out.user.username).toBe('board_probe');
    expect(out.authDate).toBeGreaterThan(0);
  });

  test('tampered hash is rejected (including a truncated one — no timingSafeEqual crash)', () => {
    const slip = signSlip(validFields());
    const params = new URLSearchParams(slip);
    const good = params.get('hash')!;
    params.set('hash', good.slice(0, -1) + (good.endsWith('0') ? '1' : '0'));
    expect(() => verifyInitData(params.toString(), TOKEN)).toThrow(/bad initData signature/);
    params.set('hash', 'deadbeef'); // wrong length — must reject, not throw RangeError
    expect(() => verifyInitData(params.toString(), TOKEN)).toThrow(/bad initData signature/);
  });

  test('a slip signed with a different bot token is rejected', () => {
    const slip = signSlip(validFields(), '7000000002:OTHER-token');
    expect(() => verifyInitData(slip, TOKEN)).toThrow(/bad initData signature/);
  });

  test('tampering a signed field (user id swap) is rejected', () => {
    const params = new URLSearchParams(signSlip(validFields()));
    params.set('user', JSON.stringify({ id: 999, first_name: 'Mallory' }));
    expect(() => verifyInitData(params.toString(), TOKEN)).toThrow(/bad initData signature/);
  });

  test('missing hash / missing user are rejected', () => {
    expect(() => verifyInitData('auth_date=1', TOKEN)).toThrow(/missing hash/);
    const noUser = signSlip({ auth_date: String(nowSec()), query_id: 'AAtest' });
    expect(() => verifyInitData(noUser, TOKEN)).toThrow(/missing user/);
  });

  test('auth_date older than maxAgeSec is rejected; a fresh one passes a tight window', () => {
    const stale = signSlip({ ...validFields(), auth_date: String(nowSec() - 90_000) });
    expect(() => verifyInitData(stale, TOKEN)).toThrow(/stale/);
    // The same slip is fine under a wider window — the ceiling is ours, not Telegram's.
    expect(verifyInitData(stale, TOKEN, 100_000).userId).toBe('777000111');
    const fresh = signSlip(validFields());
    expect(verifyInitData(fresh, TOKEN, 60).userId).toBe('777000111');
  });

  test('empty bot token is refused outright', () => {
    expect(() => verifyInitData(signSlip(validFields()), '')).toThrow(/not configured/);
  });
});
