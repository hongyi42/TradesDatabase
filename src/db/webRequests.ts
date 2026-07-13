import type { Database } from './database.types.js';
import { getClient } from './client.js';

export type WebRequest = Database['public']['Tables']['web_requests']['Row'];
export type WebRequestKind = 'search' | 'search_result' | 'fetch';

// How long a search-result URL stays fetchable without the URL-length cap.
const PROVENANCE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h
// Rolling window the daily rate caps count over.
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

// One batched insert per tool call: a search writes 1 'search' row (the query)
// + N 'search_result' rows (the returned URLs); a fetch writes 1 'fetch' row
// for the ATTEMPT (before the network call — rejected probes must count).
export async function logWebRequests(
  rows: Array<{ tenantId: string; technicianRef: string; kind: WebRequestKind; value: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await getClient().from('web_requests').insert(
    rows.map((r) => ({
      tenant_id: r.tenantId,
      technician_ref: r.technicianRef,
      kind: r.kind,
      value: r.value,
    })),
  );
  if (error) throw new Error(`logWebRequests failed: ${error.message}`);
}

// Rows of one kind for one person inside the rolling rate window — the rate
// cap IS this count (no separate counter to reset or drift).
export async function countRecentWebRequests(
  tenantId: string,
  technicianRef: string,
  kind: 'search' | 'fetch',
): Promise<number> {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count, error } = await getClient()
    .from('web_requests')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('technician_ref', technicianRef)
    .eq('kind', kind)
    .gte('created_at', since);
  if (error) throw new Error(`countRecentWebRequests failed: ${error.message}`);
  return count ?? 0;
}

// Fetch provenance: did OUR search return this EXACT url to this person within
// the window? Exact string match on purpose — a composed variant (extra query
// param, different casing, appended data) must NOT inherit the search tier.
export async function isRecentSearchResultUrl(
  tenantId: string,
  technicianRef: string,
  url: string,
): Promise<boolean> {
  const since = new Date(Date.now() - PROVENANCE_WINDOW_MS).toISOString();
  const { data, error } = await getClient()
    .from('web_requests')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('technician_ref', technicianRef)
    .eq('kind', 'search_result')
    .eq('value', url)
    .gte('created_at', since)
    .limit(1);
  if (error) throw new Error(`isRecentSearchResultUrl failed: ${error.message}`);
  return (data ?? []).length > 0;
}
