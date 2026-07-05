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

// All roster rows wired to one host — the badge-pull endpoint's working set.
export async function listTechniciansForHost(hostId: string): Promise<Technician[]> {
  const { data, error } = await getClient()
    .from('technicians')
    .select()
    .eq('host_id', hostId)
    .order('ref', { ascending: true });
  if (error) throw new Error(`listTechniciansForHost failed: ${error.message}`);
  return data ?? [];
}

// Cross-tenant control-plane read: the lifecycle job sweeps every tenant's
// rows in the given states (pairing checks, grace-period expiry). Not for
// tenant-scoped surfaces — those go through getTechnician/listTeam.
export async function listTechniciansInStates(
  states: TechnicianState[],
): Promise<Technician[]> {
  const { data, error } = await getClient()
    .from('technicians')
    .select()
    .in('state', states)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listTechniciansInStates failed: ${error.message}`);
  return data ?? [];
}

// Control-plane fields a lifecycle step may set. One typed setter so callers
// stay explicit about what they change; state transitions that need the
// seat-cap trigger's semantics still read clearer through setTechnicianState.
export interface TechnicianPatch {
  badge_hash?: string | null;
  host_id?: string | null;
  sandbox_ref?: string | null;
  offboarding_started_at?: string | null;
  link_issued_at?: string | null;
  composio_connected_account_id?: string | null;
  composio_trigger_id?: string | null;
  composio_session_id?: string | null;
  connected_email?: string | null;
  state?: TechnicianState;
}

export async function updateTechnician(id: string, patch: TechnicianPatch): Promise<Technician> {
  const { data, error } = await getClient()
    .from('technicians')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error || !data) {
    // Preserve the SQLSTATE (badge_hash unique 23505, seat-cap trigger on a
    // state patch) — same idiom as insertTechnician.
    throw Object.assign(
      new Error(`updateTechnician failed: ${error?.message ?? 'no row returned'}`),
      { code: error?.code },
    );
  }
  return data;
}

// Compare-and-swap state transition: the patch lands ONLY if the row is still
// in fromState — null means another writer got there first and the caller must
// treat its snapshot as stale. Every lifecycle transition goes through this:
// the deactivate/reactivate tools and the cron's pairing/expiry sweeps all
// read-then-write with seconds of Composio I/O in between, and an unguarded
// UPDATE-by-id lets the slower writer silently reverse the faster one
// (observed candidates: expiry permanently offboarding a just-reactivated
// person; a pairing sweep resurrecting a just-deactivated one).
export async function casTechnician(
  id: string,
  fromState: TechnicianState,
  patch: TechnicianPatch,
): Promise<Technician | null> {
  const { data, error } = await getClient()
    .from('technicians')
    .update(patch)
    .eq('id', id)
    .eq('state', fromState)
    .select()
    .maybeSingle();
  if (error) {
    throw Object.assign(new Error(`casTechnician failed: ${error.message}`), {
      code: error.code,
    });
  }
  return data;
}

// Mint-claim for a badge fingerprint: writes ONLY if no badge exists yet, so
// two overlapping pulls can't each mint and overwrite the other's hash (the
// installed plaintext would then match nothing — a dead credential with no
// error signal). Loser gets null and ships the winner's entry instead.
export async function claimBadgeHash(id: string, hash: string): Promise<Technician | null> {
  const { data, error } = await getClient()
    .from('technicians')
    .update({ badge_hash: hash })
    .eq('id', id)
    .is('badge_hash', null)
    .select()
    .maybeSingle();
  if (error) {
    throw Object.assign(new Error(`claimBadgeHash failed: ${error.message}`), {
      code: error.code,
    });
  }
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
