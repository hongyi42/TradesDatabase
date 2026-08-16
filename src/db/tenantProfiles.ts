import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import { wrapDbError } from './rawCaptures.js';

export type TenantProfile = Database['public']['Tables']['tenant_profiles']['Row'];
type TenantProfileUpdate = Database['public']['Tables']['tenant_profiles']['Update'];

// One license entry. A LIST because firms hold several (trade + state
// variants) — a single scalar column would be the one-number mistake again
// (plan decision).
export interface LicenseNumber {
  label: string;
  number: string;
}

/**
 * Partial-patch input: only supplied fields change; an explicit null CLEARS a
 * field (licenseNumbers clears to [] — the column is not null). All fields
 * optional by design — display requirements are state-specific, so gaps warn
 * (profileGaps) and never block.
 */
export interface TenantProfilePatch {
  displayName?: string | null;
  legalName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  email?: string | null;
  /** FULL replacement of the list, never a merge. null (or []) clears. */
  licenseNumbers?: LicenseNumber[] | null;
  disclosureFooter?: string | null;
}

// camelCase arg name → snake_case column. `satisfies` pins every column name
// to the generated Update type, so a typo'd column fails tsc instead of
// surfacing as a runtime PGRST204 (review finding). This map is THE roster:
// the MCP handler derives its accepted-args set and its reply echo from the
// exports below, so a field added here is accepted, patched, and echoed
// everywhere in one edit — a second hand-kept list is exactly the silent
// coerced-to-absent drift the find_slots rule forbids (review finding).
const STRING_COLUMNS = {
  displayName: 'display_name',
  legalName: 'legal_name',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  state: 'state',
  postalCode: 'postal_code',
  phone: 'phone',
  email: 'email',
  disclosureFooter: 'disclosure_footer',
} as const satisfies Record<string, keyof TenantProfileUpdate>;

/** The camelCase string-field names — the tool-arg roster, ONE definition. */
export const PROFILE_STRING_FIELDS = Object.keys(STRING_COLUMNS) as Array<
  keyof typeof STRING_COLUMNS
>;

// Validate + normalize a licenseNumbers value. Strict on shape: an entry with
// a missing/blank part, or with EXTRA keys, is rejected rather than silently
// truncated to {label, number} — this text prints on customer documents, so a
// dropped field is a wrong document, not a cosmetic loss.
function normalizeLicenseNumbers(value: LicenseNumber[] | null): Json {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('licenseNumbers must be an array of {label, number} (or null to clear)');
  }
  return value.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`licenseNumbers[${i}] must be an object {label, number}`);
    }
    const keys = Object.keys(entry);
    const extra = keys.filter((k) => k !== 'label' && k !== 'number');
    if (extra.length > 0) {
      throw new Error(
        `licenseNumbers[${i}] has unknown key(s) ${extra.join(', ')} — each entry is exactly ` +
          `{label, number}, e.g. {label: 'TX TACL', number: 'TACLA12345E'}`,
      );
    }
    const { label, number } = entry as unknown as Record<string, unknown>;
    if (typeof label !== 'string' || label.trim() === '' || typeof number !== 'string' || number.trim() === '') {
      throw new Error(
        `licenseNumbers[${i}] must have non-empty string label and number, ` +
          `e.g. {label: 'TX TACL', number: 'TACLA12345E'}`,
      );
    }
    return { label: label.trim(), number: number.trim() };
  });
}

// camelCase patch → snake_case columns, validating as it goes. Empty strings
// are rejected, not stored and not treated as clears — '' is almost always a
// caller mistake, and the two real intents both have a spelling (a value, or
// null to clear).
// `state` is the KEY every future state-keyed rule hangs on (disclosure
// templates, license display) AND the form that prints on documents — so it
// is stored as the uppercase 2-letter code, never free text. 'Texas' is
// refused with the fix in the error rather than silently stored as a spelling
// no state-keyed consumer would ever match (review finding — retrofitting
// later means a data cleanup across tenants).
function normalizeState(value: string): string {
  const trimmed = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(trimmed)) {
    throw new Error(`state must be the 2-letter code (e.g. TX), got '${value.trim()}'`);
  }
  return trimmed;
}

function patchToColumns(patch: TenantProfilePatch): TenantProfileUpdate {
  const cols: TenantProfileUpdate = {};
  for (const key of PROFILE_STRING_FIELDS) {
    const value = patch[key];
    if (value === undefined) continue;
    const column = STRING_COLUMNS[key];
    if (value === null) {
      cols[column] = null;
      continue;
    }
    // Runtime, not just tsc: this layer is the single write-side guard for
    // EVERY surface (MCP today, document render later), so an untyped caller
    // gets the instructive error, never `value.trim is not a function`
    // (review finding).
    if (typeof value !== 'string') {
      throw new Error(`${key} must be a string (or null to clear it)`);
    }
    if (value.trim() === '') {
      throw new Error(`${key} is empty — pass a value, or null to clear the field`);
    }
    cols[column] = key === 'state' ? normalizeState(value) : value.trim();
  }
  if (patch.licenseNumbers !== undefined) {
    cols.license_numbers = normalizeLicenseNumbers(patch.licenseNumbers);
  }
  return cols;
}

/** The firm's profile row, or null if none has been recorded yet. */
export async function getTenantProfile(tenantId: string): Promise<TenantProfile | null> {
  const { data, error } = await getClient()
    .from('tenant_profiles')
    .select()
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`getTenantProfile failed: ${error.message}`);
  return data;
}

/**
 * Create-or-patch the firm profile. Partial semantics: only supplied fields
 * change; explicit null clears. ONE atomic statement: PostgREST
 * merge-duplicates generates INSERT ... ON CONFLICT (tenant_id) DO UPDATE SET
 * <payload columns only>, which IS the partial patch — unsupplied columns
 * untouched, concurrent first writes converge on the PK. Insert-catch-23505
 * is the idiom for PARTIAL-index conflict targets (callIngest); a plain-PK
 * target uses .upsert (the jobTypeDurations rule — review finding: the
 * two-statement form paid a guaranteed-failing insert on every patch).
 */
export async function upsertTenantProfile(
  tenantId: string,
  patch: TenantProfilePatch,
): Promise<TenantProfile> {
  const cols = patchToColumns(patch);
  if (Object.keys(cols).length === 0) {
    throw new Error('upsertTenantProfile: nothing to change — supply at least one field');
  }
  const { data, error } = await getClient()
    .from('tenant_profiles')
    .upsert({ tenant_id: tenantId, ...cols }, { onConflict: 'tenant_id' })
    .select()
    .single();
  if (error || !data) {
    // FK violation (unknown tenant) and everything else, SQLSTATE intact.
    throw wrapDbError('upsertTenantProfile failed', error);
  }
  return data;
}

/**
 * The camelCase projection of a profile row — the tool-reply shape, derived
 * from STRING_COLUMNS so a field added there is echoed automatically (review
 * finding: a hand-kept echo map is where a saved field silently vanishes from
 * the reply the manager is read back).
 */
export function profileEcho(p: TenantProfile): Record<string, Json> {
  return {
    ...Object.fromEntries(PROFILE_STRING_FIELDS.map((k) => [k, p[STRING_COLUMNS[k]]])),
    licenseNumbers: p.license_numbers,
  };
}

/**
 * Which likely-required invoice-header fields are still missing. Pure; null =
 * no profile at all. Names are the TOOL ARG names so the agent can relay a gap
 * straight into the fix ("set phone"). Advisory only — consumers decide what a
 * gap means (workflow-agnostic: requirements are state-specific).
 */
export function profileGaps(profile: TenantProfile | null): string[] {
  const gaps: string[] = [];
  if (!profile?.display_name && !profile?.legal_name) {
    gaps.push('business name — set displayName (and legalName if the registered name differs)');
  }
  if (!profile?.address_line1) gaps.push('street address (addressLine1)');
  if (!profile?.city) gaps.push('city');
  if (!profile?.state) gaps.push('state');
  if (!profile?.postal_code) gaps.push('postal code (postalCode)');
  if (!profile?.phone) gaps.push('business phone (phone)');
  if (!profile?.email) gaps.push('business email (email)');
  const licenses = profile?.license_numbers;
  if (!Array.isArray(licenses) || licenses.length === 0) {
    // Deliberately state-NEUTRAL phrasing: this function is state-blind, so it
    // must not assert any specific state's law at every firm (review finding);
    // state-keyed rules belong to the future disclosure-template layer.
    gaps.push(
      'contractor license number(s) (licenseNumbers) — many states require the license ' +
        'number on customer-facing documents',
    );
  }
  if (!profile?.disclosure_footer) {
    gaps.push(
      'disclosure footer (disclosureFooter) — state-mandated invoice wording goes here ' +
        '(some states require a specific paragraph)',
    );
  }
  return gaps;
}
