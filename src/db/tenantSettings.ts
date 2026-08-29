import type { Database } from './database.types.js';
import { getClient } from './client.js';
import { wrapDbError } from './rawCaptures.js';

export type TenantSettings = Database['public']['Tables']['tenant_settings']['Row'];
type TenantSettingsUpdate = Database['public']['Tables']['tenant_settings']['Update'];

// Per-firm operating settings (plan 2026-08-29 "the firm is data"). The table's
// header carries the design; this file carries the DEFAULTS and the one function
// that applies them.
//
// WHY THE DEFAULTS LIVE HERE and not beside their call-sites in jobs/watchers.ts,
// where they were declared until this build: `src/db/` is a LEAF — no production
// module under it imports from `src/jobs/`, `src/teamLead/` or `src/control/`
// (only db tests reach upward). Importing the constants from watchers.ts to build
// the fallbacks would have made the database layer depend on a job, and closed a
// cycle through db/index.ts. So the declarations moved down here and watchers.ts
// re-exports them: ONE definition, every existing importer unchanged.

// ── The defaults. Absent column = "use this", which is what makes an empty
// tenant_settings table byte-for-byte today's behaviour. ───────────────────────

// Tune at the shadow-volume review (user decision 2026-08-16: 3h/72h/5 stand).
export const OVERDUE_HOURS = 3;
export const LOOKBACK_HOURS = 72;
// The per-tenant surge brake. There is NO per-person ask cap (user ruling
// 2026-08-18, reversing the 2-asks/person/24h budget): pace by urgency, earn the
// ask by self-serving first, batch the unimportant — none of which a counter can
// express. Volume is bounded instead by uq_nudges_subject_ever (a subject is
// asked about once, EVER) and by this.
//
// The deleted counter was ALSO, incidentally, the brake on a misfiring detector.
// That backstop must return per-detector: today's margin comes from having
// exactly ONE well-tested detector, not from the design, so detector #2 must land
// with its own brake. See
// thoughts/shared/research/2026-08-19-nudge-pacing-replacement-design.md (§5).
export const MAX_NEW_ITEMS_PER_TENANT_TICK = 5;

/**
 * A firm's settings with every default applied — the ONLY shape callers should
 * read. Hours stay NULLABLE on purpose (see resolveSettings).
 */
export interface ResolvedTenantSettings {
  /** Firm-local hour the working day approximately starts, or null if unknown. */
  approxWorkStartHour: number | null;
  /** Firm-local hour it approximately ends (exclusive), or null if unknown. */
  approxWorkEndHour: number | null;
  overdueHours: number;
  lookbackHours: number;
  maxNewPerTick: number;
}

/**
 * Partial-patch input: only supplied fields change; an explicit null CLEARS one,
 * restoring that field's default. All optional — a firm may set one number and
 * leave the rest global.
 */
export interface TenantSettingsPatch {
  approxWorkStartHour?: number | null;
  approxWorkEndHour?: number | null;
  overdueHours?: number | null;
  lookbackHours?: number | null;
  maxNewPerTick?: number | null;
}

// camelCase arg name → snake_case column. `satisfies` pins every column name to
// the generated Update type, so a typo'd column fails tsc instead of surfacing as
// a runtime PGRST204 — the tenantProfiles rule, and the reason this is typed
// columns rather than one JSONB blob. This map is THE roster: any future tool
// surface derives its accepted args from SETTINGS_NUMBER_FIELDS below, so a field
// added here is accepted, patched and echoed in one edit.
const NUMBER_COLUMNS = {
  approxWorkStartHour: 'approx_work_start_hour',
  approxWorkEndHour: 'approx_work_end_hour',
  overdueHours: 'overdue_hours',
  lookbackHours: 'lookback_hours',
  maxNewPerTick: 'max_new_per_tick',
} as const satisfies Record<string, keyof TenantSettingsUpdate>;

/** The camelCase field names — the arg roster, ONE definition. */
export const SETTINGS_NUMBER_FIELDS = Object.keys(NUMBER_COLUMNS) as Array<
  keyof typeof NUMBER_COLUMNS
>;

function patchToColumns(patch: TenantSettingsPatch): TenantSettingsUpdate {
  const cols: TenantSettingsUpdate = {};
  for (const key of SETTINGS_NUMBER_FIELDS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) {
      cols[NUMBER_COLUMNS[key]] = null;
      continue;
    }
    // Runtime, not just tsc: this layer is the single write-side guard for every
    // surface, so an untyped caller gets the instructive error rather than a
    // Postgres type error. RANGE is deliberately NOT checked here — the CHECK
    // constraints own it, and duplicating them in TS would leave two rules to
    // drift. Shape is ours; bounds are the table's.
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(`${key} must be a whole number of hours (or null to clear it)`);
    }
    cols[NUMBER_COLUMNS[key]] = value;
  }
  // The one rule spanning two columns, so no CHECK constraint can hold it: an
  // hours pair must describe a forward daytime span. Only enforced when ONE call
  // names both — this layer must not read-modify-write to police a pair assembled
  // across two calls (racy, and the caller's second write may be seconds away).
  // resolveSettings stays the backstop for whatever does get stored; this exists
  // so an obviously-wrong write is REFUSED rather than accepted, echoed back as
  // saved, and then silently ignored by every reader.
  const { approx_work_start_hour: start, approx_work_end_hour: end } = cols;
  if (typeof start === 'number' && typeof end === 'number' && start >= end) {
    throw new Error(
      `approxWorkStartHour (${start}) must be before approxWorkEndHour (${end}) — ` +
        'an overnight span is not representable',
    );
  }
  return cols;
}

/** The firm's settings row, or null if none has been recorded. */
export async function getTenantSettings(tenantId: string): Promise<TenantSettings | null> {
  const { data, error } = await getClient()
    .from('tenant_settings')
    .select()
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`getTenantSettings failed: ${error.message}`);
  return data;
}

/**
 * Create-or-patch a firm's settings. Partial semantics: only supplied fields
 * change; explicit null clears one back to its default. ONE atomic statement —
 * PostgREST merge-duplicates generates INSERT ... ON CONFLICT (tenant_id) DO
 * UPDATE SET <payload columns only>, which IS the partial patch (the
 * tenantProfiles rule: .upsert for a plain-PK conflict target, never
 * insert-catch-23505, which pays a guaranteed-failing insert on every patch).
 */
export async function patchTenantSettings(
  tenantId: string,
  patch: TenantSettingsPatch,
): Promise<TenantSettings> {
  const cols = patchToColumns(patch);
  if (Object.keys(cols).length === 0) {
    throw new Error('patchTenantSettings: nothing to change — supply at least one field');
  }
  const { data, error } = await getClient()
    .from('tenant_settings')
    .upsert({ tenant_id: tenantId, ...cols }, { onConflict: 'tenant_id' })
    .select()
    .single();
  if (error || !data) {
    // FK violation (unknown tenant), CHECK violation (out-of-range hour) and
    // everything else, SQLSTATE intact.
    throw wrapDbError('patchTenantSettings failed', error);
  }
  return data;
}

/**
 * A row (or its absence) with every default applied. THE one place the fallbacks
 * are chosen — callers read the resolved shape and never the raw columns, so
 * "what happens when a firm has not set this?" has exactly one answer.
 *
 * HOURS ARE NOT DEFAULTED, and that is deliberate: unset must never mean "think
 * less about this firm". A null pair means the cadence runs at its full rate
 * always. Consequently a HALF-set pair (one bound recorded, the other not) and a
 * pair that does not describe a forward daytime span (start >= end, which the
 * table's per-column CHECKs cannot catch) both normalise to null here rather than
 * silently defining a broken window somewhere downstream.
 */
export function resolveSettings(row: TenantSettings | null): ResolvedTenantSettings {
  const start = row?.approx_work_start_hour ?? null;
  const end = row?.approx_work_end_hour ?? null;
  const usable = start !== null && end !== null && start < end;
  return {
    approxWorkStartHour: usable ? start : null,
    approxWorkEndHour: usable ? end : null,
    overdueHours: row?.overdue_hours ?? OVERDUE_HOURS,
    lookbackHours: row?.lookback_hours ?? LOOKBACK_HOURS,
    maxNewPerTick: row?.max_new_per_tick ?? MAX_NEW_ITEMS_PER_TENANT_TICK,
  };
}
