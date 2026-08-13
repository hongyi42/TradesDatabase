import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from './database.types.js';
import { getClient } from './client.js';
import type { PortalRole } from './portalAccounts.js';

// Browser sessions for the customer portal.
//
// Plan: thoughts/shared/plans/2026-08-12-portal-real-data.md.
//
// THE RULE THIS FILE ENFORCES: the plaintext session token exists in exactly two
// places — the customer's cookie jar, and the local variable returned by
// `issueSession` on the one request that mints it. It is never stored, never
// logged, and never returned by any other function. `data-security` §3:
// fingerprints only. The database holds a sha256 and nothing reversible.

export type PortalSession = Database['public']['Tables']['portal_sessions']['Row'];

/** 30 days, sliding (owner decision 2026-08-12). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Renewal is throttled: bumping `last_seen_at` on literally every request would
 * mean a write per page load for no added safety. An hour's granularity keeps
 * the 30-day window honest while making renewal writes rare.
 */
export const SESSION_RENEW_AFTER_MS = 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 256 bits from a CSPRNG. Not derived from the account, so the token carries no
 * information about whose it is and cannot be constructed by someone who knows
 * an email address.
 */
export function mintToken(): string {
  return randomBytes(32).toString('hex');
}

export interface SessionOwner {
  sessionId: string;
  accountId: string;
  tenantId: string;
  email: string;
  role: PortalRole;
  expiresAt: string;
  /** Drives the throttled sliding-window renewal — see `needsRenewal`. */
  lastSeenAt: string;
}

/**
 * Create a session and return the PLAINTEXT token exactly once. The caller sets
 * it as a cookie and then lets it go out of scope; nothing may persist or log it.
 */
export async function issueSession(params: {
  accountId: string;
  userAgent?: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = mintToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const { error } = await getClient()
    .from('portal_sessions')
    .insert({
      account_id: params.accountId,
      token_hash: hashToken(token),
      expires_at: expiresAt.toISOString(),
      // Truncated: a user-agent is attacker-controlled free text, and we only
      // ever read it by eye.
      user_agent: params.userAgent ? params.userAgent.slice(0, 300) : null,
    });
  if (error) throw new Error(`issueSession failed: ${error.message}`);
  return { token, expiresAt };
}

/**
 * Resolve a cookie token to its owner, or null.
 *
 * FAILS CLOSED on every ambiguous case: malformed token, unknown hash, revoked,
 * expired, or an account row that has vanished all return null. The caller must
 * treat null as "not signed in" and must not distinguish the reasons to the
 * client — which of these it was is exactly the information an attacker wants.
 *
 * The lookup is by sha256, so a stolen database gives no usable token, and the
 * comparison happens inside Postgres on a hashed unique index rather than by
 * scanning rows in JS.
 */
export async function resolveSession(token: string): Promise<SessionOwner | null> {
  // Shape check before touching the database: a session token is always 64 hex
  // characters, so anything else is noise and gets no query.
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  const { data, error } = await getClient()
    .from('portal_sessions')
    .select(
      'id, account_id, expires_at, last_seen_at, revoked_at, token_hash, portal_accounts(tenant_id, email, role)',
    )
    .eq('token_hash', hashToken(token))
    .maybeSingle();
  if (error) throw new Error(`resolveSession failed: ${error.message}`);
  if (!data) return null;

  // Defence in depth against a future refactor that widens the filter: confirm
  // the row we got back really is the one this token hashes to, in constant time.
  const presented = Buffer.from(hashToken(token), 'utf8');
  const stored = Buffer.from(data.token_hash, 'utf8');
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;

  if (data.revoked_at) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;

  // The embed is safe here because it is a to-ONE lookup along a foreign key
  // from a row we already proved belongs to this token — not a tenant-scoped
  // list, which is the case `data-security` warns embeds get wrong.
  const account = data.portal_accounts as unknown as
    | { tenant_id: string; email: string; role: string }
    | null;
  if (!account) return null;
  if (account.role !== 'owner' && account.role !== 'operator') {
    throw new Error(`portal_sessions: unrecognised role '${account.role}'`);
  }

  return {
    sessionId: data.id,
    accountId: data.account_id,
    tenantId: account.tenant_id,
    email: account.email,
    role: account.role,
    expiresAt: data.expires_at,
    lastSeenAt: data.last_seen_at,
  };
}

/** Slide the window. Best-effort: see the caller's note on why this never throws upward. */
export async function renewSession(sessionId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const { error } = await getClient()
    .from('portal_sessions')
    .update({ last_seen_at: new Date().toISOString(), expires_at: expiresAt })
    .eq('id', sessionId)
    .is('revoked_at', null);
  if (error) throw new Error(`renewSession failed: ${error.message}`);
}

/** Should this session's window be slid? Throttled — see SESSION_RENEW_AFTER_MS. */
export function needsRenewal(lastSeenAt: string): boolean {
  return Date.now() - new Date(lastSeenAt).getTime() > SESSION_RENEW_AFTER_MS;
}

/** Sign-out. Idempotent: revoking an already-revoked session is a no-op. */
export async function revokeSession(sessionId: string): Promise<void> {
  const { error } = await getClient()
    .from('portal_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', sessionId)
    .is('revoked_at', null);
  if (error) throw new Error(`revokeSession failed: ${error.message}`);
}

/**
 * Kill every live session for an account — the operator's lever for a lost
 * device, and what offboarding must call so a departed person's 30-day cookie
 * does not outlive their access.
 */
export async function revokeAllForAccount(accountId: string): Promise<number> {
  const { data, error } = await getClient()
    .from('portal_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .is('revoked_at', null)
    .select('id');
  if (error) throw new Error(`revokeAllForAccount failed: ${error.message}`);
  return (data ?? []).length;
}

/**
 * Delete sessions that expired more than `graceDays` ago. Expiry already denies
 * access; this is hygiene so the table does not grow without bound. The grace
 * window keeps recent rows readable for "was I signed out or did it lapse?".
 */
export async function purgeExpiredSessions(graceDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await getClient()
    .from('portal_sessions')
    .delete()
    .lt('expires_at', cutoff)
    .select('id');
  if (error) throw new Error(`purgeExpiredSessions failed: ${error.message}`);
  return (data ?? []).length;
}
