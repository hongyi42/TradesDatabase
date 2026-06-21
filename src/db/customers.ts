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

export async function getCustomer(id: string): Promise<Customer | null> {
  const { data, error } = await getClient().from('customers').select().eq('id', id).maybeSingle();
  if (error) throw new Error(`getCustomer failed: ${error.message}`);
  return data;
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
