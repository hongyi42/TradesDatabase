import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';

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
// ⚠ Future address editors: NO address-column updater exists in the app today
// (audited 2026-07-26 — createCustomer only inserts; trySetCustomerAttribute
// touches attributes only). Whichever change first UPDATES address_line1/2,
// city, state, or postal_code MUST also null lat/lng/geocoded_at in the same
// update, or the solver keeps routing to the old location.
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

// Exact phone match within a tenant. Used by deterministic identity matching —
// the caller decides what a unique (length === 1) result means.
export async function findCustomersByPhone(tenantId: string, phone: string): Promise<Customer[]> {
  const { data, error } = await getClient()
    .from('customers')
    .select()
    .eq('tenant_id', tenantId)
    .eq('phone', phone);
  if (error) throw new Error(`findCustomersByPhone failed: ${error.message}`);
  return data ?? [];
}

// Case-insensitive exact match on the first address line within a tenant (no
// wildcards in the value → ilike behaves as case-insensitive equality).
export async function findCustomersByAddress(
  tenantId: string,
  addressLine1: string,
): Promise<Customer[]> {
  const { data, error } = await getClient()
    .from('customers')
    .select()
    .eq('tenant_id', tenantId)
    .ilike('address_line1', addressLine1);
  if (error) throw new Error(`findCustomersByAddress failed: ${error.message}`);
  return data ?? [];
}

// Loose search across name/phone/address for the agent's find_customer tool.
// Commas/parens are stripped because they're PostgREST `.or()` syntax characters.
export async function searchCustomers(tenantId: string, query: string): Promise<Customer[]> {
  const like = `%${query.trim().replace(/[,()]/g, ' ')}%`;
  const { data, error } = await getClient()
    .from('customers')
    .select()
    .eq('tenant_id', tenantId)
    .or(`name.ilike.${like},phone.ilike.${like},address_line1.ilike.${like}`)
    .limit(20);
  if (error) throw new Error(`searchCustomers failed: ${error.message}`);
  return data ?? [];
}
