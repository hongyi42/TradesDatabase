import type { Database } from './database.types.js';
import { getClient } from './client.js';

export type CallNumber = Database['public']['Tables']['call_numbers']['Row'];

// Resolve the tenant (and its forward-to line) for a dialed SignalWire number.
// The phone webhook's tenant entry point: an unknown number returns null so the
// caller fails closed (reject the call), never guesses a tenant. Global-unique
// on phone_number (uq_call_numbers_phone) — at most one row can match.
export async function resolveTenantByNumber(
  phoneNumber: string,
): Promise<{ tenantId: string; forwardTo: string | null } | null> {
  const { data, error } = await getClient()
    .from('call_numbers')
    .select('tenant_id, forward_to')
    .eq('phone_number', phoneNumber)
    .maybeSingle();
  if (error) throw new Error(`resolveTenantByNumber failed: ${error.message}`);
  if (!data) return null;
  return { tenantId: data.tenant_id, forwardTo: data.forward_to };
}
