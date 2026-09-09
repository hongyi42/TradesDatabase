import { createHmac, createPublicKey, timingSafeEqual, verify as verifySig } from 'node:crypto';

// Server-side verification of Telegram Mini App `initData` — the signed slip the
// Telegram client hands a Mini App page, proving which Telegram account tapped
// the launch button. The board's whole identity story starts here: the page
// forwards the raw slip, we check Telegram's signature, and only then is the
// user id trusted for the roster lookup.
//
// Scheme (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
//   secret = HMAC_SHA256(bot_token)           keyed with the literal "WebAppData"
//   hash   = hex(HMAC_SHA256(data_check_string, secret))
// where data_check_string = all fields except `hash`, sorted by key, joined as
// `key=value` lines. Pure module — no HTTP, no DB — so the auth math is
// unit-testable in isolation.
//
// TWO schemes live here, and which one a caller uses decides which secrets
// the service must hold:
//   verifyInitData        — the HMAC above. Needs THE BOT'S TOKEN, so only
//                           whoever owns that bot can check it.
//   verifyInitDataSigned  — Telegram's Ed25519 `signature` (Bot API 7.10,
//                           'Validating data for Third-Party Use'). Needs
//                           only Telegram's PUBLIC key and the bot's numeric
//                           id, neither of which is a secret.
// The second exists for the one-bot-per-person merge: the console must take
// slips from every person's own assistant bot, and copying every bot token
// to Render to check HMACs would concentrate exactly the secrets the box
// design keeps off it. Bot ids are the allowlist instead — see the note on
// verifyInitDataSigned for why an id list is as strong as a token here.

export interface TelegramWebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface VerifiedInitData {
  // The numeric user id AS A STRING — technicians.telegram_user_id stores the
  // digits as text, so this is directly comparable to the roster column.
  userId: string;
  user: TelegramWebAppUser;
  authDate: number; // unix seconds, from the (signature-covered) auth_date field
}

// Telegram's Ed25519 public keys, from the Bot API docs (fetched 2026-09-09,
// core.telegram.org/bots/webapps -> 'Validating data for Third-Party Use').
// Pinned as constants the way a root certificate is: a key that changed
// without us noticing must fail closed, not be re-fetched at runtime over the
// same network an attacker would already have to control.
export const TELEGRAM_PUBLIC_KEYS = {
  production: 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d',
  test: '40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec',
} as const;

// Node cannot import a RAW Ed25519 public key: wrap the 32 bytes in the fixed
// SPKI header and let createPublicKey parse the DER. Cached — the parse is
// pure and every request would otherwise redo it.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const keyCache = new Map<string, ReturnType<typeof createPublicKey>>();
function publicKeyFor(hex: string): ReturnType<typeof createPublicKey> {
  const hit = keyCache.get(hex);
  if (hit) return hit;
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new Error('telegram public key must be 32 bytes');
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  keyCache.set(hex, key);
  return key;
}

// The key THIS process verifies with. Production by default; Telegram's test
// environment has its own key, and a suite that stands in for Telegram needs
// its own too. An override is accepted only if it is 32 bytes of hex, so a
// truncated or empty value falls back to production rather than to nothing.
export function configuredPublicKeyHex(): string {
  const override = process.env.TELEGRAM_INITDATA_PUBLIC_KEY;
  if (override && /^[0-9a-fA-F]{64}$/.test(override)) return override.toLowerCase();
  return process.env.TELEGRAM_ENV === 'test'
    ? TELEGRAM_PUBLIC_KEYS.test
    : TELEGRAM_PUBLIC_KEYS.production;
}

export interface VerifiedSignedInitData extends VerifiedInitData {
  // WHICH door this slip came through — the bot id the signature verified
  // against. Callers that pair a person with a bot (notifications,
  // offboarding) read it; the auth decision itself does not need it.
  botId: string;
}

// Verify a slip WITHOUT any bot token, against the ids of bots we own.
//
// Why an id list is enough. The signature proves Telegram issued this record
// for ONE specific bot: the bot id is the first line of the signed text and
// is NOT carried in initData, so the verifier supplies it and a slip minted
// for any other bot cannot match. Every id in this allowlist belongs to a bot
// the operator created, whose token never leaves the box — no user of ours
// owns one. So 'signed for one of our bots' and 'signed for this person's
// bot' are the same statement, and the cheaper one needs no DB read before
// the signature is checked. What a slip never establishes is AUTHORISATION:
// the roster lookup that follows still decides tenant, role, and whether the
// account is live at all (a leaver's slip verifies perfectly and is refused).
export function verifyInitDataSigned(
  initDataRaw: string,
  botIds: readonly string[],
  opts: { maxAgeSec?: number; publicKeyHex?: string } = {},
): VerifiedSignedInitData {
  const { maxAgeSec = 86_400, publicKeyHex = TELEGRAM_PUBLIC_KEYS.production } = opts;
  const ids = botIds.filter((id) => /^[0-9]{1,20}$/.test(id));
  if (!ids.length) throw new Error('no bot ids are configured for signature checks');
  const params = new URLSearchParams(initDataRaw);
  const signature = params.get('signature');
  if (!signature) throw new Error('initData missing signature');
  // Neither stamp is part of what was signed.
  params.delete('hash');
  params.delete('signature');
  const fields = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  let sig: Buffer;
  try {
    sig = Buffer.from(signature, 'base64url');
  } catch {
    throw new Error('bad initData signature');
  }
  // Ed25519 signatures are 64 bytes. Reject any other length here: it is a
  // forgery rather than a key mismatch, and verify() throws on some inputs
  // instead of returning false (the timingSafeEqual length-guard idiom).
  if (sig.length !== 64) throw new Error('bad initData signature');
  const key = publicKeyFor(publicKeyHex);
  const botId = ids.find((id) =>
    verifySig(null, Buffer.from(`${id}:WebAppData\n${fields}`, 'utf8'), key, sig),
  );
  if (!botId) throw new Error('bad initData signature');
  return { ...readClaims(params, maxAgeSec), botId };
}

// The claims both schemes read once a stamp has been checked. Called ONLY
// after a successful verification: every value here is signature-covered, so
// reading it earlier would be trusting unverified input.
function readClaims(params: URLSearchParams, maxAgeSec: number): VerifiedInitData {
  // auth_date bounds replay: a leaked slip is a bearer credential until it
  // ages out, so stale launches are rejected (Telegram mandates no window).
  const authDateRaw = params.get('auth_date');
  const authDate = Number(authDateRaw);
  if (!authDateRaw || !Number.isFinite(authDate)) {
    throw new Error('initData missing auth_date');
  }
  if (Math.floor(Date.now() / 1000) - authDate > maxAgeSec) {
    throw new Error('initData is stale — reopen the board from Telegram');
  }
  const userRaw = params.get('user');
  if (!userRaw) throw new Error('initData missing user');
  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(userRaw) as TelegramWebAppUser;
  } catch {
    throw new Error('initData user is not valid JSON');
  }
  if (typeof user.id !== 'number' || !Number.isInteger(user.id)) {
    throw new Error('initData user has no numeric id');
  }
  return { userId: String(user.id), user, authDate };
}

export function verifyInitData(
  initDataRaw: string,
  botToken: string,
  maxAgeSec = 86_400,
): VerifiedInitData {
  if (!botToken) throw new Error('bot token is not configured');
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  if (!hash) throw new Error('initData missing hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  const provided = Buffer.from(hash, 'hex');
  // Length-guard FIRST: timingSafeEqual throws RangeError on unequal lengths, so
  // a truncated hash must be rejected here, not crash the handler (identity.ts idiom).
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error('bad initData signature');
  }

  // Stamp checked — the remaining fields are authentic.
  return readClaims(params, maxAgeSec);
}

// A bot's numeric id is the part of its token before the colon. Public
// information, and the only thing the Ed25519 check needs about a bot — so
// the box can publish ids for bots whose tokens it never shares.
export function botIdFromToken(token: string | undefined): string | null {
  const m = /^([0-9]{1,20}):/.exec(token ?? '');
  return m ? m[1] : null;
}
