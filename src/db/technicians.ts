import type { Database } from './database.types.js';
import { getClient } from './client.js';

export type Technician = Database['public']['Tables']['technicians']['Row'];
export type TechnicianTier = Database['public']['Enums']['technician_tier'];
export type TechnicianState = Database['public']['Enums']['technician_state'];

export interface InsertTechnicianInput {
  tenantId: string;
  ref: string; // the vocabulary-contract string (badge = Composio user_id ref = sheet column)
  displayName: string;
  tier?: TechnicianTier;
}

// The roster row for one (tenant, ref), or null. Refs are unique per tenant
// across ALL rows (offboarded included) — a ref is never reused across humans,
// because L1 attribution is append-only and would merge two people's history.
export async function getTechnician(tenantId: string, ref: string): Promise<Technician | null> {
  const { data, error } = await getClient()
    .from('technicians')
    .select()
    .eq('tenant_id', tenantId)
    .eq('ref', ref)
    .maybeSingle();
  if (error) throw new Error(`getTechnician failed: ${error.message}`);
  return data;
}

export async function listTeam(tenantId: string): Promise<Technician[]> {
  const { data, error } = await getClient()
    .from('technicians')
    .select()
    .eq('tenant_id', tenantId)
    .order('ref', { ascending: true });
  if (error) throw new Error(`listTeam failed: ${error.message}`);
  return data ?? [];
}

// Insert a roster row (state starts 'invited'). The DB enforces both guards:
// unique (tenant_id, ref) → 23505, and the seat-cap trigger → 'seat_cap_exceeded'.
// Callers translate those into actionable errors; this layer just surfaces them.
export async function insertTechnician(input: InsertTechnicianInput): Promise<Technician> {
  const { data, error } = await getClient()
    .from('technicians')
    .insert({
      tenant_id: input.tenantId,
      ref: input.ref,
      display_name: input.displayName,
      tier: input.tier ?? 'technician',
    })
    .select()
    .single();
  if (error) {
    // Preserve the SQLSTATE so callers can distinguish 23505 (ref taken) from
    // the seat-cap trigger's message — same idiom as appendRawCapture.
    throw Object.assign(new Error(`insertTechnician failed: ${error.message}`), {
      code: error.code,
    });
  }
  if (!data) throw new Error('insertTechnician failed: no row returned');
  return data;
}

export async function setTechnicianState(
  id: string,
  state: TechnicianState,
): Promise<Technician> {
  const { data, error } = await getClient()
    .from('technicians')
    .update({ state })
    .eq('id', id)
    .select()
    .single();
  if (error || !data) {
    throw new Error(`setTechnicianState failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

// The seat-cap trigger raises 'seat_cap_exceeded'; PostgREST surfaces it in the
// error message. Distinguishable from the 23505 unique-ref violation.
export function isSeatCapError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('seat_cap_exceeded');
}

// The single definition of "this roster row no longer participates" — mirrors
// the DB seat-cap trigger's occupancy set. Every surface (webhook drop, sheet
// validation, deactivate guard) consults this, so adding a lifecycle state is
// a one-place decision.
export function isInactiveState(state: TechnicianState): boolean {
  return state === 'offboarding' || state === 'offboarded';
}
