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

// Closed nudges with no summary row yet — a SERVER-SIDE anti-join via a left
// embed filtered to null, so the page always contains only unsummarized rows.
// (The naive shape — page closed rows, filter summarized ones out in code —
// STALLS: once the oldest page is fully summarized it returns [] forever
// while newer closed rows wait behind it.) Oldest first so a backlog drains
// in order; held-back escalations re-enter every tick until written.
export async function listUnsummarizedClosedNudges(limit = 200): Promise<Nudge[]> {
  const { data, error } = await getClient()
    .from('nudges')
    .select('*, gap_summaries!left(nudge_id)')
    .in('status', [...CLOSED_NUDGE_STATUSES])
    .is('gap_summaries', null)
    .order('resolved_at', { ascending: true, nullsFirst: false })
    .limit(limit);
  if (error) {
    throw new Error(`listUnsummarizedClosedNudges failed: ${error.message}`, { cause: error });
  }
  return ((data ?? []) as (Nudge & { gap_summaries: unknown })[]).map((r) => {
    const { gap_summaries, ...row } = r;
    void gap_summaries; // embed marker only — stripped from the returned row
    return row as Nudge;
  });
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

// `sinceIso` bounds the count to summaries that landed AFTER an instant — the
// Reflector's "is there anything new to look at" gate. Omitted, this counts the
// tenant's whole corpus (its other caller, the eligibility floor). A count, not
// a page: PostgREST caps rows at 1000 and this must not silently stop growing.
export async function countSummaries(tenantId: string, sinceIso?: string): Promise<number> {
  let q = getClient()
    .from('gap_summaries')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  if (sinceIso) q = q.gt('created_at', sinceIso);
  const { count, error } = await q;
  if (error) throw new Error(`countSummaries failed: ${error.message}`, { cause: error });
  return count ?? 0;
}
