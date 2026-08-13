import type { Database } from './database.types.js';
import { getClient } from './client.js';

// Typed access to `portal_accounts` — the map from an authenticated email to
// exactly one tenant. See the migration (20260812120000) for why this table
// exists and why `email` is globally unique rather than unique per tenant.
//
// Plan: thoughts/shared/plans/2026-08-12-portal-real-data.md (D2).
//
// EVERY function here is a security boundary, not a convenience wrapper: these
// are the lookups that decide which firm's data a browser session may read.
// Nothing in this file may take a tenant id from a caller and trust it.

export type PortalAccount = Database['public']['Tables']['portal_accounts']['Row'];

/** 'operator' is US, not a customer. It gates the cross-tenant admin queue. */
export type PortalRole = 'owner' | 'operator';

/** Narrowed shape the session layer actually needs. */
export interface ResolvedPortalAccount {
  accountId: string;
  tenantId: string;
  email: string;
  role: PortalRole;
}

// `role` is `text` + a CHECK in the database, so the generated type is `string`.
// Narrow it once, here, and fail loudly on anything else: a row carrying an
// unrecognised role must NOT silently fall through to a permissive branch.
function narrowRole(role: string, email: string): PortalRole {
  if (role === 'owner' || role === 'operator') return role;
  throw new Error(`portal_accounts: unrecognised role '${role}' for ${email}`);
}

function toResolved(row: PortalAccount): ResolvedPortalAccount {
  return {
    accountId: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    role: narrowRole(row.role, row.email),
  };
}

/**
 * Resolve a sign-in email to its account, or null when there is none.
 *
 * Returning null is the INVITE-ONLY gate (owner decision 2026-08-07): an address
 * with no row here is not a customer and must get no session. Callers must treat
 * null as "fail closed", and must NOT tell the caller which case they hit — see
 * the account-enumeration note in the auth handler.
 *
 * `email` is citext in the database, so casing is handled there rather than by
 * lowercasing here; doing both would be harmless but would hide where the real
 * guarantee lives.
 */
export async function findAccountByEmail(email: string): Promise<ResolvedPortalAccount | null> {
  const trimmed = email.trim();
  if (!trimmed) return null;
  const { data, error } = await getClient()
    .from('portal_accounts')
    .select()
    .eq('email', trimmed)
    .maybeSingle();
  // .maybeSingle() errors rather than picking a row if the unique index were ever
  // lost — which is the correct failure for a lookup that decides tenancy.
  if (error) throw new Error(`findAccountByEmail failed: ${error.message}`);
  return data ? toResolved(data) : null;
}

/**
 * Resolve a Supabase Auth user id to its account. This is the lookup the session
 * layer uses on every authenticated request, because the auth user id is what a
 * verified session actually carries — the email in a cookie would be caller-
 * supplied data wearing a trusted costume.
 */
export async function findAccountByAuthUserId(
  authUserId: string,
): Promise<ResolvedPortalAccount | null> {
  if (!authUserId.trim()) return null;
  const { data, error } = await getClient()
    .from('portal_accounts')
    .select()
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (error) throw new Error(`findAccountByAuthUserId failed: ${error.message}`);
  return data ? toResolved(data) : null;
}

/**
 * Bind a Supabase Auth user id to an invited account, on that person's first
 * completed magic link. Idempotent: re-binding the same id is a no-op, so a
 * replayed callback cannot fail the sign-in.
 *
 * Scoped by `id`, never by email, so this cannot be pointed at another row by a
 * caller who controls only the address.
 */
export async function bindAuthUser(accountId: string, authUserId: string): Promise<void> {
  const { error } = await getClient()
    .from('portal_accounts')
    .update({ auth_user_id: authUserId })
    .eq('id', accountId);
  if (error) throw new Error(`bindAuthUser failed: ${error.message}`);
}

/** Sign-in bookkeeping. Best-effort by design: see the caller's note. */
export async function touchLastSeen(accountId: string): Promise<void> {
  const { error } = await getClient()
    .from('portal_accounts')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', accountId);
  if (error) throw new Error(`touchLastSeen failed: ${error.message}`);
}

/**
 * Invite an address to a tenant. Operator-only path — there is no self-serve
 * signup (owner decision 2026-08-07), so nothing reachable from a customer
 * session may call this.
 */
export async function inviteAccount(params: {
  tenantId: string;
  email: string;
  role?: PortalRole;
}): Promise<ResolvedPortalAccount> {
  const { data, error } = await getClient()
    .from('portal_accounts')
    .insert({
      tenant_id: params.tenantId,
      email: params.email.trim(),
      role: params.role ?? 'owner',
    })
    .select()
    .single();
  if (error) throw new Error(`inviteAccount failed: ${error.message}`);
  return toResolved(data);
}

/** Every account on a tenant. Operator/admin listing; tenant-scoped. */
export async function listAccountsForTenant(tenantId: string): Promise<ResolvedPortalAccount[]> {
  const { data, error } = await getClient()
    .from('portal_accounts')
    .select()
    .eq('tenant_id', tenantId)
    .order('invited_at', { ascending: true });
  if (error) throw new Error(`listAccountsForTenant failed: ${error.message}`);
  return (data ?? []).map(toResolved);
}
