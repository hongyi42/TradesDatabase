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
