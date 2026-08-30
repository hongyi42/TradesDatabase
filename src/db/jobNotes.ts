import type { Database } from './database.types.js';
import { getClient } from './client.js';
import { wrapDbError } from './rawCaptures.js';

// The planner's per-job notepads (plan 2026-08-30). RAW ACCESSORS ONLY — the
// rails and the rendering live in src/teamLead/jobNotes.ts, because `src/db/` is
// an IMPORT LEAF: no production module under it may reach up into
// src/teamLead/, and putting the rails here would close that cycle (the
// tenantSettings rule, and the same split planner_memory uses).
//
// The table's header carries the design. This file carries three operations and
// the one invariant code owns: every overwrite keeps the previous content,
// pruned to the last JOB_NOTE_VERSIONS_KEPT per job.
//
// NOTE ON TENANT SCOPING: every function here takes a tenantId and filters on
// it, but that is NOT the whole guard. The job_id foreign key proves a job
// EXISTS; it never proves the job belongs to the caller's firm. The tool
// handlers resolve the job and compare `job.tenant_id` before calling in — the
// get_job precedent (src/mcp/server.ts).

export type JobNote = Database['public']['Tables']['job_notes']['Row'];

// How many previous copies of ONE job's note survive. This is what makes the
// write reversible, which is the property the team-lead dispatch gate's rule
// turns on — see src/teamLead/identity.ts.
export const JOB_NOTE_VERSIONS_KEPT = 10;

/** The current note on one job, or null if the planner has never written one. */
export async function readJobNote(tenantId: string, jobId: string): Promise<JobNote | null> {
  const { data, error } = await getClient()
    .from('job_notes')
    .select()
    .eq('tenant_id', tenantId)
    .eq('job_id', jobId)
    .maybeSingle();
  if (error) throw new Error(`readJobNote failed: ${error.message}`, { cause: error });
  return data;
}

/**
 * Which of these jobs have a note, and when it was last written — the per-tick
 * batched read behind the gap block's one-line announcement.
 *
 * METADATA ONLY, NEVER CONTENT, and that is the point rather than an
 * optimisation: this runs for every gap on every tick and renders no prose, so
 * pulling prose here would put the whole firm's notes into a path that shows
 * none of them. Exactly one row per job, which is also what keeps it clear of
 * PostgREST's 1,000-row cap.
 *
 * Jobs with no note are simply absent from the map; the caller reads that as
 * "no note", which is what the gap block needs.
 */
export async function listJobNoteMeta(
  tenantId: string,
  jobIds: string[],
): Promise<Map<string, string>> {
  if (jobIds.length === 0) return new Map();
  const { data, error } = await getClient()
    .from('job_notes')
    .select('job_id, written_at')
    .eq('tenant_id', tenantId)
    .in('job_id', jobIds);
  if (error) throw new Error(`listJobNoteMeta failed: ${error.message}`, { cause: error });
  return new Map((data ?? []).map((r) => [r.job_id, r.written_at]));
}

async function archive(tenantId: string, jobId: string, content: string): Promise<void> {
  const { error } = await getClient()
    .from('job_note_versions')
    .insert({ tenant_id: tenantId, job_id: jobId, content });
  if (error) throw wrapDbError('archiving the previous job note failed', error);
}

/**
 * Drop the oldest versions beyond JOB_NOTE_VERSIONS_KEPT.
 *
 * BEST-EFFORT and never throws: it runs after the caller's real write has
 * already landed, so failing here would report a successful write as a failure —
 * and the cost of not pruning is disk, not correctness.
 */
async function prune(tenantId: string, jobId: string): Promise<void> {
  try {
    const { data, error } = await getClient()
      .from('job_note_versions')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('job_id', jobId)
      .order('replaced_at', { ascending: false })
      // Tiebreaker, so "which version got evicted" is never arbitrary.
      // `replaced_at` defaults to now() = the TRANSACTION timestamp and each
      // insert is its own request, so a tie is effectively unreachable — but an
      // unordered tie would make eviction nondeterministic, which is a flake
      // nobody would diagnose (the planner_memory finding).
      .order('id', { ascending: false })
      .range(JOB_NOTE_VERSIONS_KEPT, JOB_NOTE_VERSIONS_KEPT + 999);
    if (error) throw error;
    const excess = (data ?? []).map((r) => r.id);
    if (excess.length === 0) return;
    const del = await getClient().from('job_note_versions').delete().in('id', excess);
    if (del.error) throw del.error;
  } catch (err) {
    console.error(`[jobNotes] pruning versions of job ${jobId} failed`, err);
  }
}

/**
 * Replace the note on one job. The previous content — if any, and if it
 * actually differs — is archived FIRST, so a failure in the upsert leaves an
 * extra copy of text that is still current (harmless) rather than losing the
 * only copy of text about to be overwritten (not).
 *
 * AN UNCHANGED REWRITE ARCHIVES NOTHING. The planner is told to revisit its
 * notes, so without this ten identical copies fill the history in a few hours
 * and the revision somebody actually wants back is already evicted. The gate
 * admits this verb BECAUSE it is reversible; a history of ten identical rows is
 * not a history.
 */
export async function writeJobNote(
  tenantId: string,
  jobId: string,
  content: string,
): Promise<JobNote> {
  const prior = await readJobNote(tenantId, jobId);
  const changed = !prior || prior.content !== content;
  if (prior && changed) await archive(tenantId, jobId, prior.content);
  const { data, error } = await getClient()
    .from('job_notes')
    .upsert(
      // written_at SET EXPLICITLY, not left to the column default. The default
      // fires on INSERT only, and this is an upsert — on the conflict path it
      // would keep the FIRST write's instant forever, so every note would read
      // as "written 3 days ago" no matter how recently it changed.
      { tenant_id: tenantId, job_id: jobId, content, written_at: new Date().toISOString() },
      { onConflict: 'tenant_id,job_id' },
    )
    .select()
    .single();
  // FK violation (unknown tenant or job) arrives here with its SQLSTATE intact.
  if (error || !data) throw wrapDbError('writeJobNote failed', error);
  if (prior && changed) await prune(tenantId, jobId);
  return data;
}
