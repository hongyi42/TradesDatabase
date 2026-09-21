import type { Database } from './database.types.js';
import { getClient } from './client.js';

export type Tenant = Database['public']['Tables']['tenants']['Row'];

// Does this tenant id exist? The inbound webhook validates the tenant prefix of
// Composio's composite "<tenant>:<technicianRef>" user_id BEFORE writing, so an
// unknown/misprovisioned tenant is rejected cleanly (no retry storm) instead of
// failing the L1 insert's FK deep in the write-path. The FK constraint remains
// the backstop (defense in depth).
export async function tenantExists(tenantId: string): Promise<boolean> {
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`tenantExists failed: ${error.message}`);
  return !!data;
}

// The tenant row by id, or null. First consumer: get_schedule's default-date
// computation, which needs tenants.timezone to answer "today" in the firm's
// local day rather than UTC.
export async function getTenant(tenantId: string): Promise<Tenant | null> {
  const { data, error } = await getClient()
    .from('tenants')
    .select()
    .eq('id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`getTenant failed: ${error.message}`);
  return data;
}

// Look a tenant up by name. Exists for callers that must work on any
// environment — e.g. scripts/seed.mjs: the migration-seeded 'Default Tenant'
// has a different generated id on every fresh database (local stack vs hosted),
// so hardcoding an id is wrong by construction. NOTE: tenants.name has no
// unique constraint — if the name is ever ambiguous, .maybeSingle() errors
// loudly rather than silently picking a row; that's a data bug to fix, not
// something this helper resolves.
export async function getTenantByName(name: string): Promise<Tenant> {
  const { data, error } = await getClient().from('tenants').select().eq('name', name).maybeSingle();
  if (error) throw new Error(`getTenantByName failed: ${error.message}`);
  if (!data) throw new Error(`getTenantByName: no tenant named '${name}'`);
  return data;
}

export interface TenantSeats {
  id: string;
  name: string;
  // Kept SEPARATE, never summed. The two tiers are different products: manager
  // seats price higher AND cost more to serve (full Composio catalog + self-serve
  // pairing), so a blended per-seat figure divides two different things by their
  // total and means neither. See docs/engineering-memory.md §2.
  managerSeats: number;
  technicianSeats: number;
}

// Every tenant with its purchased seats, split by tier.
//
// Paginated: PostgREST silently caps responses at db-max-rows (1000), and a
// truncated read here would not error — tenants past the cap would simply render
// as "(unknown tenant)" with no seats, so their cost-per-seat would read as
// unknown rather than wrong. Quiet either way, hence the paging.
export async function listTenantSeats(): Promise<TenantSeats[]> {
  const PAGE = 1000;
  const client = getClient();
  const out: TenantSeats[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('tenants')
      .select('id, name, manager_seats, technician_seats')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listTenantSeats failed: ${error.message}`);
    const rows = data ?? [];
    out.push(
      ...rows.map((t) => ({
        id: t.id,
        name: t.name,
        managerSeats: t.manager_seats ?? 0,
        technicianSeats: t.technician_seats ?? 0,
      })),
    );
    if (rows.length < PAGE) return out;
  }
}

export async function createTenant(
  name: string,
  seats: { managerSeats?: number; technicianSeats?: number } = {},
): Promise<Tenant> {
  const { data, error } = await getClient()
    .from('tenants')
    .insert({
      name,
      ...(seats.managerSeats !== undefined && { manager_seats: seats.managerSeats }),
      ...(seats.technicianSeats !== undefined && { technician_seats: seats.technicianSeats }),
    })
    .select()
    .single();
  if (error || !data) throw new Error(`createTenant failed: ${error?.message ?? 'no row returned'}`);
  return data;
}

// Technician visibility horizon in days (Plan 4a): how far ahead
// technician-tier schedule reads may see. Plain update, no CAS — a settings
// row is effectively single-writer (the setTenantSeats precedent); the DB
// CHECK (7-84) backstops range.
export async function setTechnicianHorizonDays(
  tenantId: string,
  days: number,
): Promise<Tenant> {
  const { data, error } = await getClient()
    .from('tenants')
    .update({ technician_horizon_days: days })
    .eq('id', tenantId)
    .select()
    .single();
  if (error || !data) {
    throw new Error(`setTechnicianHorizonDays failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

// The firm's IANA timezone. Until this existed there was NO writer for the
// column at all — it was set once by createTenant's default
// ('America/Los_Angeles') and never again, so every firm outside that zone read
// every date an hour or more wrong with nothing erroring. Plain update, no CAS,
// for the same reason as the two neighbours: a settings row is effectively
// single-writer.
//
// VALIDATION LIVES AT THE TOOL, NOT HERE, but the column has no CHECK to
// backstop it (unlike technician_horizon_days 7-84), so an unvalidated caller
// can still write nonsense. isValidTimezone below is the shared guard; call it
// before this.
export async function setTenantTimezone(tenantId: string, timezone: string): Promise<Tenant> {
  const { data, error } = await getClient()
    .from('tenants')
    .update({ timezone })
    .eq('id', tenantId)
    .select()
    .single();
  if (error || !data) {
    throw new Error(`setTenantTimezone failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

// The CANONICAL IANA zones, and nothing else — 418 of them on Node 24.
//
// A try/catch around `new Intl.DateTimeFormat({timeZone})` is the obvious check
// and it is WRONG HERE. Measured 2026-09-20, Node 24.16: it accepts 'CST',
// 'EST', 'MST', 'HST', 'PST', 'US/Central', 'CST6CDT', 'Etc/GMT+6' and
// lowercase 'america/chicago'. Three of those are a silent hour of error half
// the year, because they are FIXED-OFFSET zones that never observe DST:
//
//   'EST' formats as EST in September, when New York is on EDT.
//   'MST' and 'HST' likewise.
//   ('CST' and 'PST' happen to be DST-observing aliases — so the abbreviation
//    family cannot even be reasoned about as a group. Refuse all of it.)
//
// `Intl.supportedValuesOf('timeZone')` returns canonical ids only, which
// excludes every abbreviation, every legacy alias and the whole Etc/* family.
// That is exactly the bar we want, and it is also the safest string to hand
// POSTGRES: `working_hours_between(from, to, tz)` passes this value into
// `at time zone tz`, where 'CST' resolves via pg_timezone_abbrevs and means
// something different from what Node did with it.
//
// Deliberately strict about two more: comparison is CASE-SENSITIVE (Intl would
// take 'america/chicago'), and 'UTC' is refused — no trades firm is in UTC, and
// admitting it reopens the argument for 'EST'. Read-side fallbacks elsewhere in
// the codebase still default to 'UTC' for a missing tenant; that is a different
// thing from a manager choosing it.
const CANONICAL_TIMEZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));

export function isValidTimezone(value: string): boolean {
  return CANONICAL_TIMEZONES.has(value);
}

// Purchased seat capacity per tier (the DB seat-cap trigger reads these).
export async function setTenantSeats(
  tenantId: string,
  seats: { managerSeats: number; technicianSeats: number },
): Promise<Tenant> {
  const { data, error } = await getClient()
    .from('tenants')
    .update({ manager_seats: seats.managerSeats, technician_seats: seats.technicianSeats })
    .eq('id', tenantId)
    .select()
    .single();
  if (error || !data) {
    throw new Error(`setTenantSeats failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}
