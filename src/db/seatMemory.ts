import type { Database } from './database.types.js';
import { getClient } from './client.js';
import { MEMORY_VERSIONS_KEPT } from './plannerMemory.js';
import { wrapDbError } from './rawCaptures.js';

// A manager seat's own memory (plan 2026-09-24 step 2a): markdown files per
// PERSON, the shape of planner_memory one level deeper. RAW ACCESSORS ONLY —
// the path and size rails are validateMemoryPath / validateMemoryContent in
// src/teamLead/memory.ts, applied by the tool handlers (src/mcp/tools/memory.ts),
// because src/db/ is an import leaf.
//
// The one invariant code owns here, as in plannerMemory.ts: every overwrite and
// every delete keeps the previous content, pruned to the last
// MEMORY_VERSIONS_KEPT — per (tenant, person, path), never per (tenant, path),
// so one manager's rewrites never evict another's history.

export type SeatMemoryFile = Database['public']['Tables']['seat_memory']['Row'];

/** Every path this person has, ordered by path. */
export async function listSeatMemoryPaths(tenantId: string, technicianRef: string): Promise<string[]> {
  const { data, error } = await getClient()
    .from('seat_memory')
    .select('path')
    .eq('tenant_id', tenantId)
    .eq('technician_ref', technicianRef)
    .order('path', { ascending: true });
  if (error) throw new Error(`listSeatMemoryPaths failed: ${error.message}`, { cause: error });
  return (data ?? []).map((r) => r.path);
}

/** One file, or null if this person has never written that path. */
export async function readSeatMemoryFile(
  tenantId: string,
  technicianRef: string,
  path: string,
): Promise<SeatMemoryFile | null> {
  const { data, error } = await getClient()
    .from('seat_memory')
    .select()
    .eq('tenant_id', tenantId)
    .eq('technician_ref', technicianRef)
    .eq('path', path)
    .maybeSingle();
  if (error) throw new Error(`readSeatMemoryFile failed: ${error.message}`, { cause: error });
  return data;
}

async function archive(tenantId: string, technicianRef: string, path: string, content: string): Promise<void> {
  const { error } = await getClient()
    .from('seat_memory_versions')
    .insert({ tenant_id: tenantId, technician_ref: technicianRef, path, content });
  if (error) throw wrapDbError('archiving the previous seat memory version failed', error);
}

/** Best-effort, never throws: it runs after the real write landed (plannerMemory.ts prune). */
async function prune(tenantId: string, technicianRef: string, path: string): Promise<void> {
  try {
    const { data, error } = await getClient()
      .from('seat_memory_versions')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('technician_ref', technicianRef)
      .eq('path', path)
      .order('replaced_at', { ascending: false })
      .order('id', { ascending: false })
      .range(MEMORY_VERSIONS_KEPT, MEMORY_VERSIONS_KEPT + 999);
    if (error) throw error;
    const excess = (data ?? []).map((r) => r.id);
    if (excess.length === 0) return;
    const del = await getClient().from('seat_memory_versions').delete().in('id', excess);
    if (del.error) throw del.error;
  } catch (err) {
    console.error(`[seatMemory] pruning versions of ${path} failed`, err);
  }
}

/** Create or replace one file; the previous content (if it changed) is archived FIRST. */
export async function writeSeatMemoryFile(
  tenantId: string,
  technicianRef: string,
  path: string,
  content: string,
): Promise<SeatMemoryFile> {
  const prior = await readSeatMemoryFile(tenantId, technicianRef, path);
  // An unchanged rewrite keeps no version (plannerMemory.ts: ten identical
  // copies are not a history).
  const changed = !prior || prior.content !== content;
  if (prior && changed) await archive(tenantId, technicianRef, path, prior.content);
  const { data, error } = await getClient()
    .from('seat_memory')
    .upsert({ tenant_id: tenantId, technician_ref: technicianRef, path, content }, { onConflict: 'tenant_id,technician_ref,path' })
    .select()
    .single();
  if (error || !data) throw wrapDbError('writeSeatMemoryFile failed', error);
  if (prior && changed) await prune(tenantId, technicianRef, path);
  return data;
}

/** Remove one file, keeping its last content as a version. Answers whether there was one. */
export async function deleteSeatMemoryFile(tenantId: string, technicianRef: string, path: string): Promise<boolean> {
  const prior = await readSeatMemoryFile(tenantId, technicianRef, path);
  if (!prior) return false;
  await archive(tenantId, technicianRef, path, prior.content);
  const { error } = await getClient()
    .from('seat_memory')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('technician_ref', technicianRef)
    .eq('path', path);
  if (error) throw wrapDbError('deleteSeatMemoryFile failed', error);
  await prune(tenantId, technicianRef, path);
  return true;
}
