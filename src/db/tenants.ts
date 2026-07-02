import { getClient } from './client.js';

// Does this tenant id exist? The inbound webhook validates the tenant part of
// Composio's user_id (bare uuid, or the "<tenant>:<technicianRef>" composite's
// prefix) BEFORE writing, so an unknown/misprovisioned tenant is rejected cleanly
// (no retry storm) instead of failing the L1 insert's FK deep in the write-path.
// The FK constraint remains the backstop (defense in depth).
export async function tenantExists(tenantId: string): Promise<boolean> {
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`tenantExists failed: ${error.message}`);
  return !!data;
}
