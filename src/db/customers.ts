import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import { phoneKey } from './phone.js';

export type Customer = Database['public']['Tables']['customers']['Row'];

export interface CreateCustomerInput {
  tenantId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  attributes?: Json; // L3
  sourceCaptureId?: string | null; // the capture this record was created from
}

export async function createCustomer(input: CreateCustomerInput): Promise<Customer> {
  const { data, error } = await getClient()
    .from('customers')
    .insert({
      tenant_id: input.tenantId,
      name: input.name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address_line1: input.addressLine1 ?? null,
      address_line2: input.addressLine2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postal_code: input.postalCode ?? null,
      attributes: input.attributes ?? {},
      source_capture_id: input.sourceCaptureId ?? null,
    })
    .select()
    .single();
  if (error || !data) throw new Error(`createCustomer failed: ${error?.message ?? 'no row returned'}`);
  return data;
}

// One CAS attempt at merging a standing-fact bundle under `key`: write back the
// merged attributes only if the row still carries the updated_at we read (a
// concurrent writer bumps it via the DB trigger, so the guarded update matches
// no row and we return null instead of clobbering their key — supabase-js
// update REPLACES the whole JSONB object). Exported single-attempt so tests can
// force the CAS miss with a deliberately stale row.
export async function trySetCustomerAttribute(
  row: Customer,
  key: string,
  bundle: Json,
): Promise<Customer | null> {
  const base =
    row.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes)
      ? (row.attributes as Record<string, Json>)
      : null;
  // Refuse, never coerce: silently replacing a non-object attributes value
  // (an array/scalar from an import or external writer) with { [key]: bundle }
  // would destroy it with no error and no L1 trail (review finding).
  if (!base) {
    throw new Error(
      `trySetCustomerAttribute: attributes on customer ${row.id} is not a JSON object — refusing to replace it`,
    );
  }
  const { data, error } = await getClient()
    .from('customers')
    .update({ attributes: { ...base, [key]: bundle } })
    .eq('id', row.id)
    .eq('updated_at', row.updated_at)
    .select()
    .maybeSingle();
  if (error) throw new Error(`trySetCustomerAttribute failed: ${error.message}`);
  return data;
}

// Upsert one standing-fact key onto a customer's L3 attributes: read → guarded
// merge, retried on a CAS miss. Tenant guarding stays the caller's job (module
// convention — the MCP dispatch verifies the parent row's tenant).
export async function setCustomerAttribute(id: string, key: string, bundle: Json): Promise<Customer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getCustomer(id);
    if (!row) throw new Error(`setCustomerAttribute: customer ${id} not found`);
    const updated = await trySetCustomerAttribute(row, key, bundle);
    if (updated) return updated;
  }
  throw new Error(`setCustomerAttribute: customer ${id} changed concurrently; write not applied`);
}

// Persist lazily-geocoded solver coordinates (plan 4b-3 Phase 2).
// DORMANT SINCE RUNG 8 (2026-09-03): the freeze's geocoder was the only writer
// of lat/lng/geocoded_at and the solver the only reader, and both are deleted.
// The columns and this writer are KEPT for rung 10's advisory route optimizer —
// re-deriving coordinates for every customer is the expensive part, and the data
// is still correct.
//
// ⚠ Still true, and the reason this note survives: NO address-column updater
// exists in the app (audited 2026-07-26 — createCustomer only inserts;
// trySetCustomerAttribute touches attributes only). Whichever change first
// UPDATES address_line1/2, city, state, or postal_code MUST also null
// lat/lng/geocoded_at in the same update, or a future router reads a stale
// location for a customer who moved.
export async function updateCustomerCoords(
  id: string,
  lat: number,
  lng: number,
): Promise<Customer> {
  const { data, error } = await getClient()
    .from('customers')
    .update({ lat, lng, geocoded_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(`updateCustomerCoords failed: ${error.message}`);
  if (!data) throw new Error('updateCustomerCoords: customer not found');
  return data;
}

export async function getCustomer(id: string): Promise<Customer | null> {
  const { data, error } = await getClient().from('customers').select().eq('id', id).maybeSingle();
  if (error) throw new Error(`getCustomer failed: ${error.message}`);
  return data;
}

// Batch point-read (plan 4b-3 final review): the freeze geocodes every
// customer a solve touches — one query instead of N serial getCustomer round
// trips. Id-only like getCustomer; tenant guarding stays the caller's job
// (module convention above).
export async function listCustomersByIds(ids: string[]): Promise<Customer[]> {
  if (ids.length === 0) return [];
  const { data, error } = await getClient().from('customers').select().in('id', ids);
  if (error) throw new Error(`listCustomersByIds failed: ${error.message}`);
  return data ?? [];
}

// Phone match within a tenant, on the NUMBER, not its spelling: "(206) 555-0170",
// "206-555-0170" and "+12065550170" share one phone_key (the generated column,
// 20260916130100). Used by deterministic identity matching — the caller decides
// what a unique (length === 1) result means. Fewer than 7 digits is no number,
// so it matches nobody rather than every short fragment.
export async function findCustomersByPhone(tenantId: string, phone: string): Promise<Customer[]> {
  const key = phoneKey(phone);
  if (!key) return [];
  const { data, error } = await getClient()
    .from('customers')
    .select()
    .eq('tenant_id', tenantId)
    .eq('phone_key', key);
  if (error) throw new Error(`findCustomersByPhone failed: ${error.message}`);
  return data ?? [];
}

// `_` and `%` are LIKE wildcards, and `_` is COMMON in real addresses and email
// local parts: an unescaped `a_b@x.com` also matches `axb@x.com`, and
// unique-or-refuse would read that as a confident WRONG customer — worse than no
// match at all. Both exact-match readers below escape with this and then compare
// in code, so a wildcard that survives the escape can only widen the candidate
// set, never the answer. (Belt and braces on purpose: the escape depends on how
// PostgREST passes a backslash through to ILIKE.)
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

// Case-insensitive exact match on the first address line within a tenant.
//
// It used to say "no wildcards in the value → ilike behaves as case-insensitive
// equality", which was an ASSUMPTION about model-supplied text, not a fact: the
// value comes from the extractor reading a customer's own words. Rung 10b proved
// the hazard for email and it is identical here — this is the matcher's fourth
// unique-or-refuse key, so a leaked `%` or `_` either widens the candidate set or
// matches a different customer at a different address, silently and confidently.
// Escaped for LIKE, then compared exactly in code, so a wildcard that survives
// the escape can only widen the candidates and never the answer.
export async function findCustomersByAddress(
  tenantId: string,
  addressLine1: string,
): Promise<Customer[]> {
  const wanted = addressLine1.trim().toLowerCase();
  if (!wanted) return [];
  const { data, error } = await getClient()
    .from('customers')
    .select()
    .eq('tenant_id', tenantId)
    .ilike('address_line1', escapeLike(wanted));
  if (error) throw new Error(`findCustomersByAddress failed: ${error.message}`);
  return (data ?? []).filter((row) => (row.address_line1 ?? '').trim().toLowerCase() === wanted);
}

// Case-insensitive exact match on email within a tenant — rung 10b's second
// identity key, for the reply that carries neither a phone number nor an
// address. Used by deterministic identity matching; the caller decides what a
// unique (length === 1) result means.
export async function findCustomersByEmail(tenantId: string, email: string): Promise<Customer[]> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return [];
  const { data, error } = await getClient()
    .from('customers')
    .select()
    .eq('tenant_id', tenantId)
    .ilike('email', escapeLike(wanted));
  if (error) throw new Error(`findCustomersByEmail failed: ${error.message}`);
  return (data ?? []).filter((row) => (row.email ?? '').trim().toLowerCase() === wanted);
}

// THE CUSTOMER-LEVEL LINK — the job_captures twin, one rung up
// (20260912100000_customer_captures.sql). It records the one thing the door is
// always sure of and previously had nowhere to put: WHO a capture belongs to,
// when it cannot say WHICH job. Idempotent by primary key — a redelivery is a
// NO-OP, not an error (the insertJobCapture idiom). `ignoreDuplicates` is what
// makes that `ON CONFLICT DO NOTHING`, and it must never become DO UPDATE: the
// customer_captures_append_only trigger would raise on it.
export interface InsertCustomerCaptureInput {
  tenantId: string;
  customerId: string;
  captureId: string;
}

export async function insertCustomerCapture(input: InsertCustomerCaptureInput): Promise<void> {
  const { error } = await getClient()
    .from('customer_captures')
    .upsert(
      { tenant_id: input.tenantId, customer_id: input.customerId, capture_id: input.captureId },
      { onConflict: 'customer_id,capture_id', ignoreDuplicates: true },
    );
  if (error) throw new Error(`insertCustomerCapture failed: ${error.message}`);
}

// True if this capture is linked to any customer — the fourth "already
// processed" marker captureHasLinkedL2 reads, so a capture held ONLY at customer
// level is not re-extracted on every redelivery. Fleet-wide by capture id,
// exactly like captureHasJobCapture: holding the id is proof enough of tenancy.
export async function captureHasCustomerCapture(captureId: string): Promise<boolean> {
  const { data, error } = await getClient()
    .from('customer_captures')
    .select('capture_id')
    .eq('capture_id', captureId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`captureHasCustomerCapture failed: ${error.message}`);
  return !!data;
}

// Which customers a capture is linked to — the listJobCapturesForCapture twin,
// and for the same reason: a retraction has to follow its target onto every
// link, or it lands on the record with no connection to what it neutralizes.
export async function listCustomerCapturesForCapture(
  captureId: string,
): Promise<{ customer_id: string; tenant_id: string }[]> {
  const { data, error } = await getClient()
    .from('customer_captures')
    .select('customer_id, tenant_id')
    .eq('capture_id', captureId);
  if (error) throw new Error(`listCustomerCapturesForCapture failed: ${error.message}`);
  return data ?? [];
}

// Loose search across name/phone/address for the agent's find_customer tool.
// Commas/parens are stripped because they're PostgREST `.or()` syntax characters.
// A query that LOOKS LIKE a phone number (only digits and + - . ( ) spaces, 4+
// digits) also searches phone_key, so "206 555 0199" and "+1 206 555 0199" find
// a number stored as "206-555-0199". Only then: "2065 Elm St" would otherwise
// glue its digits into a phone search that returns every 206-5xx customer and,
// under the 20-row cap, can bury the address it was actually after. The key
// form strips a leading US 1; the fragment is digits only — no `.or()` syntax.
export async function searchCustomers(tenantId: string, query: string): Promise<Customer[]> {
  const like = `%${query.trim().replace(/[,()]/g, ' ')}%`;
  const digits = query.replace(/[^0-9]/g, '');
  const looksLikePhone = /^[0-9\s+().-]+$/.test(query.trim()) && digits.length >= 4;
  // A PARTIAL number typed with its +1 ("+1 206 555 01") is not 11 digits, so
  // phoneKey keeps it whole and "120655501" is in no key; drop an explicit +1 first.
  const fragment = /^\s*\+\s*1/.test(query) ? digits.slice(1) : (phoneKey(query) ?? digits);
  const byKey = looksLikePhone ? `,phone_key.ilike.%${fragment}%` : '';
  const { data, error } = await getClient()
    .from('customers')
    .select()
    .eq('tenant_id', tenantId)
    .or(`name.ilike.${like},phone.ilike.${like},address_line1.ilike.${like}${byKey}`)
    .limit(20);
  if (error) throw new Error(`searchCustomers failed: ${error.message}`);
  return data ?? [];
}
