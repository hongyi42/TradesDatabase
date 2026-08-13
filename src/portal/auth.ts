import type http from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { bindAuthUser, findAccountByEmail, touchLastSeen } from '../db/portalAccounts.js';
import {
  issueSession,
  needsRenewal,
  renewSession,
  resolveSession,
  revokeSession,
  type SessionOwner,
} from '../db/portalSessions.js';

// Sign-in for the customer portal.
//
// Plan: thoughts/shared/plans/2026-08-12-portal-real-data.md (D1, D3a).
//
// THE CONSTRAINT THAT SHAPES THIS WHOLE FILE (plan D3a, measured 2026-08-12):
// the publishable "anon" key can already read `technicians`, `customers` and
// `tenants` ACROSS tenants, and an anon insert into `technicians` is refused by a
// foreign key rather than by permissions. That is latent only because the key is
// shipped nowhere. The ordinary way to build magic-link auth — a Supabase client
// in the browser — would require publishing that key and make the exposure live.
//
//   => Every Supabase Auth call here is SERVER-SIDE, with the service-role key
//      that already lives on the server. The browser receives a session cookie
//      and nothing else. No token, no key, no Supabase client.
//
// Verified against the running stack (2026-08-12) rather than assumed:
//   * admin.generateLink({type:'magiclink'}) returns `hashed_token` without
//     sending mail — we send it ourselves, so the link points at OUR callback.
//   * verifyOtp needs `type: 'email'`. `type: 'magiclink'` is accepted by
//     generateLink but REJECTED by verifyOtp — that mismatch cost a debugging
//     round and is the reason this comment names the working value.
//   * The token is single-use: a replay is refused, as is a forged 64-hex token.

const COOKIE_NAME = 'td_portal_session';

/**
 * A THROWAWAY Supabase client, used for auth calls and then discarded.
 *
 * NEVER use `src/db/client.ts`'s shared client for auth. `verifyOtp` SETS THE
 * SESSION on whatever client instance it is called on, and that client then
 * sends the signed-in customer's JWT on every subsequent request. Because the
 * shared client is a process-wide singleton, one sign-in would silently
 * downgrade every later database call in the whole server from `service_role`
 * to that customer — a cross-request identity bleed.
 *
 * Measured 2026-08-12, not theorised:
 *     before verifyOtp -> portal_accounts: OK (service_role)
 *     after  verifyOtp -> portal_accounts: permission denied
 *
 * It only surfaced because `portal_accounts` revokes `authenticated`. On the
 * tables that still grant `authenticated` — technicians, customers, tenants —
 * the downgraded client keeps returning rows, so nothing would have looked
 * broken while every query ran as the wrong principal. `persistSession: false`
 * does NOT prevent this: it stops the session being written to storage, not
 * from being held in memory on the instance.
 *
 * A fresh client per call costs nothing (no connection is opened until a request
 * is made) and makes the bleed structurally impossible.
 */
function authClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** How the magic link reaches the customer. Injected so tests never send mail. */
export interface Mailer {
  sendMagicLink(params: { to: string; url: string }): Promise<void>;
}

let mailer: Mailer | null = null;

/** Wire a real sender at boot, or a fake in tests. */
export function setMailer(next: Mailer | null): void {
  mailer = next;
}

export function hasMailer(): boolean {
  return mailer !== null;
}

// ── Cookies ────────────────────────────────────────────────────────────────

export function readSessionCookie(req: http.IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    return decodeURIComponent(part.slice(eq + 1).trim()) || null;
  }
  return null;
}

/**
 * HttpOnly so page scripts cannot read it (an XSS then cannot exfiltrate the
 * session). SameSite=Lax so it is not sent on cross-site POSTs, which is the
 * CSRF protection for the state-changing endpoints below — but it IS sent on a
 * top-level GET, which is exactly what the emailed magic link is.
 *
 * `Secure` is omitted only when explicitly running insecure locally: a Secure
 * cookie is dropped by the browser over plain http, which would make sign-in
 * silently fail on a dev machine. It defaults to ON, so forgetting to set
 * anything in production yields the safe cookie.
 */
function cookieAttributes(expires: Date): string {
  const insecure = process.env.PORTAL_INSECURE_COOKIES === '1';
  const bits = [
    `Path=/portal`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Expires=${expires.toUTCString()}`,
  ];
  if (!insecure) bits.push('Secure');
  return bits.join('; ');
}

export function setSessionCookie(res: http.ServerResponse, token: string, expires: Date): void {
  res.setHeader(
    'set-cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttributes(expires)}`,
  );
}

export function clearSessionCookie(res: http.ServerResponse): void {
  res.setHeader('set-cookie', `${COOKIE_NAME}=; ${cookieAttributes(new Date(0))}`);
}

// ── Sign-in ────────────────────────────────────────────────────────────────

export type RequestLinkResult =
  | { ok: true; sent: boolean }
  | { ok: false; code: 503 };

/**
 * Step 1: a customer asks for a link.
 *
 * ACCOUNT ENUMERATION IS THE THREAT HERE, so this returns the SAME shape whether
 * or not the address is a customer. An uninvited address gets no mail and no
 * hint. The caller must answer 204 in both cases — never "no such account",
 * never a different status, never a different latency class. Signup is
 * invite-only (owner, 2026-08-07), so "is this firm a customer of yours?" is a
 * question an outsider must not be able to ask.
 *
 * Fails CLOSED with 503 when no mailer is configured — the /admin precedent. A
 * deploy that forgets mail must not look like a working sign-in that silently
 * sends nothing.
 */
export async function requestMagicLink(params: {
  email: string;
  origin: string;
}): Promise<RequestLinkResult> {
  if (!mailer) return { ok: false, code: 503 };

  const email = params.email.trim();
  // Gate on OUR table before touching Supabase Auth. generateLink creates an
  // auth user as a side effect, so calling it first would let an outsider mint
  // auth users for arbitrary addresses.
  const account = await findAccountByEmail(email);
  if (!account) return { ok: true, sent: false };

  const { data, error } = await authClient().auth.admin.generateLink({
    type: 'magiclink',
    email: account.email,
  });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  const hashedToken = data.properties?.hashed_token;
  if (!hashedToken) throw new Error('generateLink returned no hashed_token');

  // Our own callback, not Supabase's — so the token is redeemed server-side and
  // the browser never handles auth material.
  const url = `${params.origin}/portal/api/auth/callback?token=${encodeURIComponent(hashedToken)}`;
  await mailer.sendMagicLink({ to: account.email, url });
  return { ok: true, sent: true };
}

export type CallbackResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: 'invalid' };

/**
 * Step 2: the customer opens the link.
 *
 * Every failure returns the same opaque 'invalid'. A bad token, an expired
 * token, a replayed token, and a token for an address that is no longer a
 * customer are indistinguishable to the caller by design.
 */
export async function completeMagicLink(params: {
  token: string;
  userAgent?: string | null;
}): Promise<CallbackResult> {
  if (!/^[0-9a-f]{6,255}$/i.test(params.token)) return { ok: false, reason: 'invalid' };

  // `type: 'email'` — see the header comment. Single-use is enforced by GoTrue.
  const { data, error } = await authClient().auth.verifyOtp({
    token_hash: params.token,
    type: 'email',
  });
  if (error || !data.user?.email) return { ok: false, reason: 'invalid' };

  // Re-check membership at REDEMPTION time, not just at request time: an account
  // revoked in between must not be able to complete a link already in flight.
  const account = await findAccountByEmail(data.user.email);
  if (!account) return { ok: false, reason: 'invalid' };

  await bindAuthUser(account.accountId, data.user.id);
  const { token, expiresAt } = await issueSession({
    accountId: account.accountId,
    userAgent: params.userAgent ?? null,
  });
  // Bookkeeping only — never allowed to fail a completed sign-in.
  try {
    await touchLastSeen(account.accountId);
  } catch {
    /* non-fatal by design: see system-design Tier 4 */
  }
  return { ok: true, token, expiresAt };
}

// ── Per-request session resolution ─────────────────────────────────────────

/**
 * The function every `/portal/api/*` handler calls first. Returns the signed-in
 * owner or null; null must become a 401 with no detail.
 *
 * Slides the 30-day window as a side effect, throttled to at most hourly.
 */
export async function currentSession(req: http.IncomingMessage): Promise<SessionOwner | null> {
  const token = readSessionCookie(req);
  if (!token) return null;
  const owner = await resolveSession(token);
  if (!owner) return null;

  // Renewal is driven by last_seen_at, NOT expires_at: sliding on "how long
  // since you were last here" is what makes 30 days mean 30 days of inactivity.
  if (needsRenewal(owner.lastSeenAt)) {
    // A renewal failure must not sign a valid user out.
    try {
      await renewSession(owner.sessionId);
    } catch {
      /* non-fatal */
    }
  }
  return owner;
}

export async function signOut(req: http.IncomingMessage): Promise<void> {
  const token = readSessionCookie(req);
  if (!token) return;
  const owner = await resolveSession(token);
  if (owner) await revokeSession(owner.sessionId);
}
