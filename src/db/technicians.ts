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
  // Seat-exempt = a schedulable NAME only (no seat occupied, and the identity
  // verbs — bind_telegram / get_connect_link — refuse the row). Implies state
  // 'active': the row skips the pairing lifecycle entirely, and an 'invited'
  // it could never leave would read as stuck. Derived HERE so no caller can
  // mint the stuck combination.
  seatExempt?: boolean;
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

// Tenant-AGNOSTIC Telegram-id lookup for the global board bot (Plan 2): a Mini
// App's verified initData proves which Telegram ACCOUNT launched the page but
// carries no tenant — the roster is what says which firm that account belongs
// to. v1 rule: one firm per Telegram account; an id live (non-inactive) in more
// than one tenant is ambiguous and the caller must refuse rather than guess
// (a firm picker is a later layer). Same JS-side isInactiveState filter as the
// tenant-scoped lookup above — no DB uniqueness exists on telegram_user_id.
export type GlobalRosterMatch =
  | { technician: Technician }
  | { ambiguous: true; tenantIds: string[] }
  | null;

export async function findRosterByTelegramUserIdGlobal(
  telegramUserId: string,
): Promise<GlobalRosterMatch> {
  const { data, error } = await getClient()
    .from('technicians')
    .select()
    .eq('telegram_user_id', telegramUserId);
  if (error) throw new Error(`findRosterByTelegramUserIdGlobal failed: ${error.message}`);
  const live = (data ?? []).filter((t) => !isInactiveState(t.state));
  if (live.length === 0) return null;
  // ANY multiplicity refuses — same-tenant duplicates included, not just the
  // multi-firm case. Two live rows can share an id inside one tenant via the
  // deactivate → re-bind → reactivate sequence (deactivation keeps
  // telegram_user_id; bind_telegram's guard sees only live rows; reactivation
  // re-checks nothing), and this select is unordered, so picking live[0]
  // would make board identity/tier flap per request. Refuse, don't guess.
  const tenantIds = [...new Set(live.map((t) => t.tenant_id))];
  if (live.length > 1) return { ambiguous: true, tenantIds };
  return { technician: live[0] };
}

// The board notification worker's tenant set: every tenant with at least one
// live Telegram-bound roster row — the only tenants whose schedule_events can
// reach anyone. Kept here so both Telegram-roster helpers live together.
//
// Paged: PostgREST caps every response at db-max-rows (1000 locally and on
// hosted projects) and the cap is a SILENT fetch limit, not an error —
// https://docs.postgrest.org/en/v12/references/configuration.html#db-max-rows
// — and this is the repo's only cross-tenant scan of a growth table (the
// foldImpact.ts precedent). An unpaged read would silently drop whole tenants
// from the notification worker once total bound rows pass the cap.
export async function listTenantIdsWithTelegramBindings(): Promise<string[]> {
  const PAGE = 1000;
  const tenantIds = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getClient()
      .from('technicians')
      .select('tenant_id, state')
      .not('telegram_user_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listTenantIdsWithTelegramBindings failed: ${error.message}`);
    for (const t of data ?? []) {
      if (!isInactiveState(t.state)) tenantIds.add(t.tenant_id);
    }
    if (!data || data.length < PAGE) return [...tenantIds];
  }
}

// Point read by row id (FK joins from assignments etc.). Tenant-guarded: a
// cross-tenant or unknown id reads as null.
export async function getTechnicianById(
  id: string,
  tenantId: string,
): Promise<Technician | null> {
  const { data, error } = await getClient()
    .from('technicians')
    .select()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`getTechnicianById failed: ${error.message}`);
  return data;
}

// ACTIVE manager-tier rows with a Telegram binding (plan 4b-3): the
// freeze_committed run summary is the first MANAGER-directed push — in a
// multi-manager firm, everyone hears what a colleague committed.
export async function listManagersWithTelegram(tenantId: string): Promise<Technician[]> {
  const { data, error } = await getClient()
    .from('technicians')
    .select()
    .eq('tenant_id', tenantId)
    .eq('tier', 'manager')
    .eq('state', 'active')
    .not('telegram_user_id', 'is', null);
  if (error) throw new Error(`listManagersWithTelegram failed: ${error.message}`);
  return data ?? [];
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

// Insert a roster row (state starts 'invited'; a seat-exempt row starts
// 'active' — see InsertTechnicianInput). The DB enforces the guards:
// unique (tenant_id, ref) → 23505, the seat-cap trigger → 'seat_cap_exceeded',
// and the no_seat_exempt_managers CHECK. Callers translate those into
// actionable errors; this layer just surfaces them.
export async function insertTechnician(input: InsertTechnicianInput): Promise<Technician> {
  const { data, error } = await getClient()
    .from('technicians')
    .insert({
      tenant_id: input.tenantId,
      ref: input.ref,
      display_name: input.displayName,
      tier: input.tier ?? 'technician',
      seat_exempt: input.seatExempt ?? false,
      ...(input.seatExempt ? { state: 'active' as const } : {}),
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

// Skills are stored trimmed + lowercased + deduped (empties dropped) — the
// service_cities idiom: find_slots matching is exact-string, so normalization
// happens once at write time. SEMANTICS (user decision 2026-07-20): an empty
// list means "unknown", NOT "unqualified" — matching may only exclude a person
// on a NON-empty list that lacks the skill; unconfigured people stay candidates
// flagged confirm-first. Full-replace, like service_cities.
export async function setTechnicianSkills(id: string, skills: string[]): Promise<Technician> {
  const normalized = [
    ...new Set(skills.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)),
  ];
  const { data, error } = await getClient()
    .from('technicians')
    .update({ skills: normalized })
    .eq('id', id)
    .select()
    .single();
  if (error || !data) {
    throw new Error(`setTechnicianSkills failed: ${error?.message ?? 'no row returned'}`);
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

// The single definition of "this roster row no longer participates" — the
// complement of the DB seat-cap trigger's state set (NOTE: since 2026-07-19
// the trigger's occupancy count ALSO excludes seat_exempt rows, so this alone
// is not a seats-in-use predicate — pair it with !seat_exempt for that).
// Every surface (webhook drop, sheet validation, deactivate guard) consults
// this, so adding a lifecycle state is a one-place decision.
export function isInactiveState(state: TechnicianState): boolean {
  return state === 'offboarding' || state === 'offboarded';
}

export type RosterEvent = Database['public']['Tables']['roster_events']['Row'];

/**
 * The roster trail for these people, newest first (build 6.5 Phase 1).
 *
 * Written ENTIRELY by the `technicians_record_roster_event` trigger
 * (20260903110000) — there is no app-side writer, and adding one would
 * double-count. The trigger is what makes this complete: state changes reach
 * `technicians` through `casTechnician` and `updateTechnician` as well as the
 * test-only `setTechnicianState`, so a hook on any one function would have
 * recorded a fraction of the truth.
 *
 * BOUNDED BY IDS, never a tenant scan: the caller is the planner's per-tick
 * roster read and it already knows which people it cares about. `tenant_id` is
 * still filtered — the ids come from a tenant-scoped read, and a cross-tenant
 * id would otherwise leak one firm's departure dates into another's briefing.
 *
 * THE TRAIL STARTS EMPTY. Nothing here can be backfilled (see the migration
 * header: `technicians.updated_at` is bumped by any edit and is not a
 * departure date), so a person who left before this shipped has NO row and the
 * caller must say "date unknown" rather than reaching for a substitute.
 */
export async function listRosterEvents(
  tenantId: string,
  technicianIds: string[],
): Promise<RosterEvent[]> {
  if (technicianIds.length === 0) return []; // PostgREST `in.()` with zero values errors
  const { data, error } = await getClient()
    .from('roster_events')
    .select()
    .eq('tenant_id', tenantId)
    .in('technician_id', technicianIds)
    .order('occurred_at', { ascending: false });
  if (error) throw new Error(`listRosterEvents failed: ${error.message}`);
  return (data ?? []) as RosterEvent[];
}
