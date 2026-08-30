import type { Database } from './database.types.js';
import { getClient } from './client.js';
import { wrapDbError } from './rawCaptures.js';

// The planner's own memory store (plan 2026-08-30 "the planner's memory", Build
// 3 of the harness rebuild). RAW ACCESSORS ONLY — no validation, no rendering,
// no budgets. Those live in src/teamLead/memory.ts, because `src/db/` is an
// IMPORT LEAF: no production module under it may reach up into src/teamLead/,
// and putting the rails here would close that cycle (the tenantSettings rule).
//
// The table's header carries the design; this file carries the four operations
// and the ONE invariant code owns: every overwrite and every delete keeps the
// previous content, pruned to the last MEMORY_VERSIONS_KEPT per path.

export type PlannerMemoryFile = Database['public']['Tables']['planner_memory']['Row'];

// How many previous copies of ONE path survive. Bounds the versions table by
// (files x 10) rather than by write frequency, which matters because there is
// deliberately no brake on how often the planner rewrites (user, 2026-08-30:
// "I'm fine with nothing stopping the 48 rewrites a day").
export const MEMORY_VERSIONS_KEPT = 10;

/** Every path this firm has, ordered by path — the raw material for the index. */
export async function listMemoryPaths(tenantId: string): Promise<string[]> {
  const { data, error } = await getClient()
    .from('planner_memory')
    .select('path')
    .eq('tenant_id', tenantId)
    .order('path', { ascending: true });
  if (error) throw new Error(`listMemoryPaths failed: ${error.message}`, { cause: error });
  return (data ?? []).map((r) => r.path);
}

/**
 * One file, or null if this firm has never written that path.
 *
 * Returns the ROW, not just the text: `updated_at` is what the operator console
 * prints, so a second accessor for it would be a second query over the same key.
 */
export async function readMemoryFile(
  tenantId: string,
  path: string,
): Promise<PlannerMemoryFile | null> {
  const { data, error } = await getClient()
    .from('planner_memory')
    .select()
    .eq('tenant_id', tenantId)
    .eq('path', path)
    .maybeSingle();
  if (error) throw new Error(`readMemoryFile failed: ${error.message}`, { cause: error });
  return data;
}

/**
 * Keep the current content of `path` as a version, then drop the oldest beyond
 * MEMORY_VERSIONS_KEPT.
 *
 * Pruning is BEST-EFFORT and never throws: it runs after the caller's real
 * write has already landed, so failing here would report a successful write as
 * a failure — and the cost of not pruning is disk, not correctness.
 */
async function archive(tenantId: string, path: string, content: string): Promise<void> {
  const { error } = await getClient()
    .from('planner_memory_versions')
    .insert({ tenant_id: tenantId, path, content });
  if (error) throw wrapDbError('archiving the previous memory version failed', error);
}

async function prune(tenantId: string, path: string): Promise<void> {
  try {
    const { data, error } = await getClient()
      .from('planner_memory_versions')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('path', path)
      .order('replaced_at', { ascending: false })
      // Tiebreaker, so "which version got evicted" is never arbitrary.
      // `replaced_at` defaults to now() = the TRANSACTION timestamp, and each
      // version insert is its own PostgREST request, so a tie is effectively
      // unreachable — but an unordered tie would make the eviction
      // nondeterministic, which is a flake nobody would diagnose.
      .order('id', { ascending: false })
      .range(MEMORY_VERSIONS_KEPT, MEMORY_VERSIONS_KEPT + 999);
    if (error) throw error;
    const excess = (data ?? []).map((r) => r.id);
    if (excess.length === 0) return;
    const del = await getClient().from('planner_memory_versions').delete().in('id', excess);
    if (del.error) throw del.error;
  } catch (err) {
    console.error(`[plannerMemory] pruning versions of ${path} failed`, err);
  }
}

/**
 * Create or replace one file. The previous content — if any — is archived
 * FIRST, so a failure in the upsert leaves an extra copy of text that is still
 * current (harmless) rather than losing the only copy of text about to be
 * overwritten (not).
 */
export async function writeMemoryFile(
  tenantId: string,
  path: string,
  content: string,
): Promise<PlannerMemoryFile> {
  const prior = await readMemoryFile(tenantId, path);
  // AN UNCHANGED REWRITE KEEPS NO VERSION. Reconcile-first tells the planner to
  // revisit its notes every tick and there is deliberately no brake on how often
  // it rewrites (user, 2026-08-30) — so without this, ten identical copies fill
  // the history in a few hours and the day-old revision somebody actually wants
  // back is already evicted. The dispatch gate admits this write verb precisely
  // BECAUSE it is reversible; a history of ten identical rows is not a history.
  const changed = !prior || prior.content !== content;
  if (prior && changed) await archive(tenantId, path, prior.content);
  const { data, error } = await getClient()
    .from('planner_memory')
    .upsert({ tenant_id: tenantId, path, content }, { onConflict: 'tenant_id,path' })
    .select()
    .single();
  // FK violation (unknown tenant) and CHECK violation (a path the database
  // refuses) both arrive here with their SQLSTATE intact — the caller's
  // instructive message is built from it.
  if (error || !data) throw wrapDbError('writeMemoryFile failed', error);
  if (prior && changed) await prune(tenantId, path);
  return data;
}

/**
 * Remove one file, keeping its last content as a version. Answers whether there
 * was anything there: deleting a path that never existed is not an error, and
 * the tool surface says so rather than inventing a failure.
 */
export async function deleteMemoryFile(tenantId: string, path: string): Promise<boolean> {
  const prior = await readMemoryFile(tenantId, path);
  if (!prior) return false;
  await archive(tenantId, path, prior.content);
  const { error } = await getClient()
    .from('planner_memory')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('path', path);
  if (error) throw wrapDbError('deleteMemoryFile failed', error);
  await prune(tenantId, path);
  return true;
}
