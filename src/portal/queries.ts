import { listTeam, type Technician, type TechnicianState, type TechnicianTier } from '../db/technicians.js';
import { listPoolRows } from '../db/sandboxPool.js';
import { getTenant } from '../db/tenants.js';

// THE PORTAL'S ONLY DOOR TO THE DATABASE.
//
// Plan: thoughts/shared/plans/2026-08-12-portal-real-data.md (D3).
//
// WHY THIS FILE EXISTS. Per the `data-security` skill, tenant isolation in this
// repo rests entirely on a hand-written `.eq('tenant_id', …)` in each accessor:
// RLS is off on the business tables and the server runs as `service_role`, which
// bypasses RLS anyway. That has been survivable because every existing surface is
// machine-to-machine (doorman badges) or operator-only (/admin bearer token).
// **The portal is the first surface outsiders use**, so one forgotten filter stops
// being a latent bug and becomes a customer reading another firm's roster.
//
// THE RULES, which are the whole point:
//   1. Every exported function takes `tenantId` as its FIRST parameter.
//   2. `/portal/api/*` handlers import from HERE and never from `src/db/`
//      directly. One door is auditable; twenty call sites are not.
//   3. `tenantId` always comes from the verified session — never from a query
//      parameter, path segment, or request body. A handler that reads a tenant id
//      off the request has defeated everything below.
//
// WHY IN-MEMORY JOINS RATHER THAN PostgREST EMBEDS. The skill is explicit that
// **embeds do not inherit tenancy** — a nested read can cross tenants even when
// the top-level filter is right. Composing two separately tenant-scoped accessors
// and joining in memory removes that entire failure mode by construction, at the
// cost of one extra round trip on a page that loads once. Worth it.

/** Portal-shaped roster row. Mirrors the UI's `Seat` in web/portal/src/data/model.ts. */
export interface PortalSeat {
  ref: string;
  name: string;
  trade: string;
  tier: TechnicianTier;
  state: TechnicianState;
  seatExempt: boolean;
  telegramUserId: string | null;
  botUsername: string | null;
  sandboxRef: string | null;
  /** ISO timestamp. Formatting is a view concern; the API does not pre-format. */
  seatSince: string;
}

export interface TierCount {
  purchased: number;
  used: number;
}

export interface PortalSummary {
  tenantId: string;
  tenantName: string;
  manager: TierCount;
  technician: TierCount;
}

/**
 * Does this roster row occupy a purchased seat?
 *
 * MIRRORS THE DATABASE EXACTLY. `enforce_seat_cap()` in
 * supabase/migrations/20260719120000_seat_exempt_roster.sql counts:
 *
 *     state not in ('offboarding','offboarded') and not seat_exempt
 *
 * The trigger is the source of truth — it is what actually refuses an over-cap
 * insert. This function exists so the portal AGREES with it by construction
 * rather than by coincidence. If the trigger's predicate ever changes, change it
 * here in the same commit, or the portal will quietly report a different number
 * of used seats than the database will let anyone create.
 */
export function occupiesSeat(row: Pick<Technician, 'state' | 'seat_exempt'>): boolean {
  return !row.seat_exempt && row.state !== 'offboarding' && row.state !== 'offboarded';
}

function toPortalSeat(t: Technician, botUsername: string | null): PortalSeat {
  return {
    ref: t.ref,
    name: t.display_name,
    // The UI shows a single trade; the roster carries a skills array. First skill
    // is the display trade, empty string when a row has none (seat-exempt rows
    // routinely do) — never null, so the UI needs no special case.
    trade: t.skills[0] ?? '',
    tier: t.tier,
    state: t.state,
    seatExempt: t.seat_exempt,
    telegramUserId: t.telegram_user_id,
    botUsername,
    sandboxRef: t.sandbox_ref,
    seatSince: t.created_at,
  };
}

/**
 * Build the technician-id → bot handle map for ONE tenant.
 *
 * TWO INDEPENDENT GUARDS, and it is worth being precise about which does the
 * work, because a mutation test (2026-08-12) showed the obvious answer is wrong:
 *
 *   1. `listPoolRows` is tenant-scoped. Defence in depth.
 *   2. The map is keyed by `technician_id` and only ever read with ids from THIS
 *      tenant's roster. This is the STRUCTURAL guard: another firm's sandbox row
 *      is keyed by a technician id that never appears in our team list, so it is
 *      unreachable even if (1) were removed.
 *
 * Deliberately removing (1) did not fail the leak test — (2) held it closed. Both
 * stay: (1) is what keeps this correct if anyone ever re-keys the map by
 * something less tenant-bound (a sandbox_ref, say), which would delete (2)
 * without looking like it had.
 */
async function botHandlesByTechnicianId(tenantId: string): Promise<Map<string, string>> {
  const pool = await listPoolRows(tenantId);
  const map = new Map<string, string>();
  for (const row of pool) {
    // A retired row keeps its bot_username for forensics; it must not be shown as
    // a live handle, so retired rows are skipped rather than overwriting a good one.
    if (row.retired_at) continue;
    if (row.technician_id && row.bot_username) map.set(row.technician_id, row.bot_username);
  }
  return map;
}

/** Every roster row for this tenant, portal-shaped. */
export async function listSeats(tenantId: string): Promise<PortalSeat[]> {
  const [team, handles] = await Promise.all([
    listTeam(tenantId),
    botHandlesByTechnicianId(tenantId),
  ]);
  return team.map((t) => toPortalSeat(t, handles.get(t.id) ?? null));
}

/**
 * One roster row by its ref, or null.
 *
 * Scoped by tenant AND ref. Returning null for a ref that exists on ANOTHER
 * tenant is the point: the caller cannot distinguish "no such seat" from "not
 * yours", so a ref harvested elsewhere reveals nothing.
 */
export async function getSeat(tenantId: string, ref: string): Promise<PortalSeat | null> {
  const seats = await listSeats(tenantId);
  return seats.find((s) => s.ref === ref) ?? null;
}

/** Seats purchased vs occupied, per tier, for the account summary. */
export async function getSummary(tenantId: string): Promise<PortalSummary | null> {
  const [tenant, team] = await Promise.all([getTenant(tenantId), listTeam(tenantId)]);
  if (!tenant) return null;
  const used = (tier: TechnicianTier): number =>
    team.filter((t) => t.tier === tier && occupiesSeat(t)).length;
  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    manager: { purchased: tenant.manager_seats, used: used('manager') },
    technician: { purchased: tenant.technician_seats, used: used('technician') },
  };
}
