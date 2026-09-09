import { describe, expect, test } from 'vitest';
import { createHmac, generateKeyPairSync, sign as signEd } from 'node:crypto';
import {
  botIdFromToken,
  TELEGRAM_PUBLIC_KEYS,
  verifyInitData,
  verifyInitDataSigned,
} from './initData.js';

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

// ── The Ed25519 third-party scheme (Bot API 7.10) ────────────────────────────
// Telegram signs with a key nobody else has, so the suite stands in for it with
// a keypair of its own and hands the public half to the verifier. That is the
// same code path production takes; only the key differs.
const { publicKey: TG_PUB, privateKey: TG_PRIV } = generateKeyPairSync('ed25519');
// Raw 32 bytes = the tail of the SPKI DER, which is how Telegram publishes it.
const TG_PUB_HEX = TG_PUB.export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('hex');

const OUR_BOT = '7000000001'; // an assistant bot we own
const OTHER_BOT = '8100000002'; // somebody else's bot, e.g. a lookalike Mini App

// Mint a slip the way Telegram does for third-party validation: the bot id and
// the constant, a line feed, then the sorted fields.
function signedSlip(
  fields: Record<string, string>,
  botId = OUR_BOT,
  key = TG_PRIV,
): string {
  const params = new URLSearchParams(fields);
  const data = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const sig = signEd(null, Buffer.from(`${botId}:WebAppData\n${data}`, 'utf8'), key);
  params.set('signature', sig.toString('base64url'));
  return params.toString();
}

const opts = { publicKeyHex: TG_PUB_HEX };

describe('verifyInitDataSigned', () => {
  test('a slip signed for one of our bots verifies, and says which one', () => {
    const out = verifyInitDataSigned(signedSlip(validFields()), [OUR_BOT], opts);
    expect(out.userId).toBe('777000111');
    expect(out.botId).toBe(OUR_BOT);
    expect(out.user.username).toBe('board_probe');
  });

  test('finds the right bot in a list of ours', () => {
    const out = verifyInitDataSigned(
      signedSlip(validFields()),
      ['9000000009', OUR_BOT, '9000000010'],
      opts,
    );
    expect(out.botId).toBe(OUR_BOT);
  });

  test('THE PHISHING CASE: a genuine Telegram slip minted for a bot we do not own is refused', () => {
    // Telegram really signed this, for a stranger's Mini App, and it carries a
    // real roster member's user id. Only the bot id keeps it out.
    const slip = signedSlip(validFields(), OTHER_BOT);
    expect(() => verifyInitDataSigned(slip, [OUR_BOT], opts)).toThrow(/bad initData signature/);
  });

  test('a tampered user id is refused (the signature covers every field)', () => {
    const slip = signedSlip(validFields());
    const params = new URLSearchParams(slip);
    params.set('user', JSON.stringify({ id: 999999999, first_name: 'Not', username: 'me' }));
    expect(() => verifyInitDataSigned(params.toString(), [OUR_BOT], opts)).toThrow(
      /bad initData signature/,
    );
  });

  test('a slip signed by some other key is refused', () => {
    const impostor = generateKeyPairSync('ed25519').privateKey;
    const slip = signedSlip(validFields(), OUR_BOT, impostor);
    expect(() => verifyInitDataSigned(slip, [OUR_BOT], opts)).toThrow(/bad initData signature/);
  });

  test('missing, truncated and garbage signatures are refused without crashing', () => {
    const base = new URLSearchParams(signedSlip(validFields()));
    const good = base.get('signature')!;
    base.delete('signature');
    expect(() => verifyInitDataSigned(base.toString(), [OUR_BOT], opts)).toThrow(/missing signature/);
    for (const bad of [good.slice(0, 20), 'not-base64url-!!']) {
      base.set('signature', bad);
      expect(() => verifyInitDataSigned(base.toString(), [OUR_BOT], opts)).toThrow(
        /bad initData signature/,
      );
    }
    // An empty value is the missing case, not a forgery — same refusal either way.
    base.set('signature', '');
    expect(() => verifyInitDataSigned(base.toString(), [OUR_BOT], opts)).toThrow(/signature/);
  });

  test('a stale slip is refused even though its signature is perfect', () => {
    const old = { ...validFields(), auth_date: String(nowSec() - 90_000) };
    expect(() => verifyInitDataSigned(signedSlip(old), [OUR_BOT], opts)).toThrow(/stale/);
  });

  test('an empty or junk allowlist refuses rather than accepting anything', () => {
    const slip = signedSlip(validFields());
    expect(() => verifyInitDataSigned(slip, [], opts)).toThrow(/no bot ids/);
    expect(() => verifyInitDataSigned(slip, ['', 'not-an-id'], opts)).toThrow(/no bot ids/);
  });

  test('the hash field is irrelevant to this scheme (it is not signed)', () => {
    const params = new URLSearchParams(signedSlip(validFields()));
    params.set('hash', 'deadbeef');
    const out = verifyInitDataSigned(params.toString(), [OUR_BOT], opts);
    expect(out.userId).toBe('777000111');
  });

  test('the pinned production key is 32 bytes of hex', () => {
    for (const key of Object.values(TELEGRAM_PUBLIC_KEYS)) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('botIdFromToken', () => {
  test('reads the public id out of a token, and refuses nonsense', () => {
    expect(botIdFromToken('8857079866:AAHt12yz')).toBe('8857079866');
    expect(botIdFromToken('no-colon')).toBeNull();
    expect(botIdFromToken(undefined)).toBeNull();
  });
});
