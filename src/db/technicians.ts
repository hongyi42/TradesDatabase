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

// Reverse lookup for bind_telegram's duplicate guard: the first NON-inactive
// row in the tenant already bound to this Telegram id, or null. No DB uniqueness
// on telegram_user_id (it is only ever compared), so we filter in JS via the
// single isInactiveState definition and take the first match rather than
// .maybeSingle() — which would throw if a legacy duplicate ever existed.
export async function findTechnicianByTelegramUserId(
  tenantId: string,
  telegramUserId: string,
): Promise<Technician | null> {
  const { data, error } = await getClient()
    .from('technicians')
    .select()
    .eq('tenant_id', tenantId)
    .eq('telegram_user_id', telegramUserId);
  if (error) throw new Error(`findTechnicianByTelegramUserId failed: ${error.message}`);
  return (data ?? []).find((t) => !isInactiveState(t.state)) ?? null;
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
  telegram_user_id?: string | null;
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

// Recycle-completion residue clear: null the roster's sandbox pointers ONLY
// while they still reference the destroyed sandbox — guarded on BOTH ref and
// host, because refs are per-host sequences ("s4" can exist on two hosts). A
// person reactivated and re-bound to a fresh blank between destroy and a
// retried completion report must keep their new assignment — these guards are
// what prevent that overwrite. 'cleared' = this call nulled them; 'no_op' =
// they already point elsewhere (or nowhere) — the goal state holds either way.
export async function clearSandboxAssignmentIfRef(
  technicianId: string,
  sandboxRef: string,
  hostId: string,
): Promise<'cleared' | 'no_op'> {
  const { data, error } = await getClient()
    .from('technicians')
    .update({ sandbox_ref: null, host_id: null })
    .eq('id', technicianId)
    .eq('sandbox_ref', sandboxRef)
    .eq('host_id', hostId)
    .select()
    .maybeSingle();
  if (error) {
    throw Object.assign(new Error(`clearSandboxAssignmentIfRef failed: ${error.message}`), {
      code: error.code,
    });
  }
  return data ? 'cleared' : 'no_op';
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

// Weekly working pattern, firm-local times. All 7 keys required; each window is
// ["HH:MM","HH:MM"] start<end. Kept as a type ALIAS (not an interface): aliases
// carry the implicit index signature the generated Json column type needs, so
// the update({ availability }) write below typechecks under strict mode.
export type WeeklyPattern = {
  mon: [string, string][];
  tue: [string, string][];
  wed: [string, string][];
  thu: [string, string][];
  fri: [string, string][];
  sat: [string, string][];
  sun: [string, string][];
};

export const WEEK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = (typeof WEEK_DAYS)[number];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// A window END may additionally be '24:00' = end-of-day, so until-midnight
// shifts are representable ('16:00'–'24:00'); string compare still orders it
// after every valid start. An overnight shift is TWO windows across two days
// ('20:00'–'24:00' + next day '00:00'–'02:00'). (Review finding, 2026-07-04.)
const isValidEnd = (end: string) => HHMM.test(end) || end === '24:00';

// Throw on any malformed pattern — junk must never reach the column (the
// scheduler trusts stored patterns without re-validating). Zero-padded HH:MM
// makes plain string comparison a correct start<end check.
function assertValidPattern(pattern: WeeklyPattern): void {
  const keys = Object.keys(pattern);
  for (const day of WEEK_DAYS) {
    if (!keys.includes(day)) throw new Error(`availability pattern missing day '${day}'`);
  }
  for (const key of keys) {
    if (!(WEEK_DAYS as readonly string[]).includes(key)) {
      throw new Error(`availability pattern has unknown key '${key}'`);
    }
    const windows = pattern[key as DayKey];
    if (!Array.isArray(windows)) throw new Error(`availability '${key}' must be an array`);
    for (const win of windows) {
      if (!Array.isArray(win) || win.length !== 2) {
        throw new Error(`availability '${key}' window must be ["HH:MM","HH:MM"]`);
      }
      const [start, end] = win;
      if (!HHMM.test(start) || !isValidEnd(end)) {
        throw new Error(
          `availability '${key}' window has invalid time (want HH:MM; end may be 24:00): ${start}–${end}`,
        );
      }
      if (start >= end) {
        throw new Error(`availability '${key}' window start must be before end: ${start}–${end}`);
      }
    }
  }
}

export async function setTechnicianAvailability(
  id: string,
  pattern: WeeklyPattern,
): Promise<Technician> {
  assertValidPattern(pattern);
  const { data, error } = await getClient()
    .from('technicians')
    .update({ availability: pattern })
    .eq('id', id)
    .select()
    .single();
  if (error || !data) {
    throw new Error(`setTechnicianAvailability failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

// Cities are stored trimmed + lowercased (empties dropped): the Plan-3 scoring
// match is case-insensitive, so normalization happens once at write time.
export async function setTechnicianServiceCities(
  id: string,
  cities: string[],
): Promise<Technician> {
  const normalized = cities.map((c) => c.trim().toLowerCase()).filter((c) => c.length > 0);
  const { data, error } = await getClient()
    .from('technicians')
    .update({ service_cities: normalized })
    .eq('id', id)
    .select()
    .single();
  if (error || !data) {
    throw new Error(`setTechnicianServiceCities failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

// The single definition of "this roster row no longer participates" — mirrors
// the DB seat-cap trigger's occupancy set. Every surface (webhook drop, sheet
// validation, deactivate guard) consults this, so adding a lifecycle state is
// a one-place decision.
export function isInactiveState(state: TechnicianState): boolean {
  return state === 'offboarding' || state === 'offboarded';
}
