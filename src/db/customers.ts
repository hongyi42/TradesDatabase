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
