import { getClient } from './client.js';
import type { Database } from './database.types.js';
import type { Nudge } from './nudges.js';

// ⑤ Phase 2: the gap-life summary's typed layer. Append-only by convention —
// there is no update accessor here and there must never be one: a summary is
// a historical record, and the Reflector (Phase 4) reads it as one.

export type GapSummary = Database['public']['Tables']['gap_summaries']['Row'];
export type GapSummaryInsert = Database['public']['Tables']['gap_summaries']['Insert'];

// Statuses a summary can be written for — the nudges CHECK's terminal half.
export const CLOSED_NUDGE_STATUSES = ['answered', 'escalated', 'cancelled', 'failed'] as const;

export async function insertGapSummary(input: GapSummaryInsert): Promise<boolean> {
  // Idempotent under the unique nudge_id: a re-run of the sweep (or two racing
  // ticks) inserts nothing the second time. `ignoreDuplicates` makes upsert a
  // no-op on conflict rather than an update — append-only holds.
  const { error, data } = await getClient()
    .from('gap_summaries')
    .upsert(input, { onConflict: 'nudge_id', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`insertGapSummary failed: ${error.message}`, { cause: error });
  return (data ?? []).length > 0;
}

// Closed nudges with no summary row yet. PostgREST cannot anti-join, so this
// is two reads: a page of closed rows, then the already-summarized ids among
// them, filtered out in code. Oldest first so a backlog drains in order.
export async function listUnsummarizedClosedNudges(limit = 200): Promise<Nudge[]> {
  const { data, error } = await getClient()
    .from('nudges')
    .select()
    .in('status', [...CLOSED_NUDGE_STATUSES])
    .order('resolved_at', { ascending: true, nullsFirst: false })
    .limit(limit);
  if (error) {
    throw new Error(`listUnsummarizedClosedNudges failed: ${error.message}`, { cause: error });
  }
  const rows = (data ?? []) as Nudge[];
  if (rows.length === 0) return [];
  const { data: done, error: doneErr } = await getClient()
    .from('gap_summaries')
    .select('nudge_id')
    .in('nudge_id', rows.map((r) => r.id));
  if (doneErr) {
    throw new Error(`listUnsummarizedClosedNudges failed: ${doneErr.message}`, { cause: doneErr });
  }
  const summarized = new Set((done ?? []).map((r) => r.nudge_id));
  return rows.filter((r) => !summarized.has(r.id));
}

export async function listRecentSummaries(tenantId: string, limit = 40): Promise<GapSummary[]> {
  const { data, error } = await getClient()
    .from('gap_summaries')
    .select()
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRecentSummaries failed: ${error.message}`, { cause: error });
  return (data ?? []) as GapSummary[];
}

export async function countSummaries(tenantId: string): Promise<number> {
  const { count, error } = await getClient()
    .from('gap_summaries')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`countSummaries failed: ${error.message}`, { cause: error });
  return count ?? 0;
}
