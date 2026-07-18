import { createHmac, timingSafeEqual } from 'node:crypto';

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

  // Signature checked — the remaining fields are authentic. auth_date bounds
  // replay: a leaked slip is a bearer credential until it ages out, so stale
  // launches are rejected (24h default; Telegram's docs mandate no window).
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
