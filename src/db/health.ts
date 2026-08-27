import { getClient } from './client.js';

// Cheap liveness probe for the /health route: a REAL round-trip to Postgres via
// PostgREST (reachability + service-role auth + a query actually executing), not
// just "the process is up". system-design Tier 4 warns that reachability != function
// — /health owns the shallow-but-real DB check; the deep model-completion check is
// the scheduled canary (prod-migration-checklist B3 · Fix #3), never this hot path.
// A trivial indexed select on the seed tenants table; returns false on any error
// (network, auth, PostgREST) so the caller can answer 503 instead of a false 200.
export async function pingDb(): Promise<boolean> {
  try {
    const { error } = await getClient().from('tenants').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}
