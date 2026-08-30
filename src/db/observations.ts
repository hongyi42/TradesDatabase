import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import { isUniqueViolation } from './rawCaptures.js';
import type { ReviewKind } from './reviewItems.js';

// The observation store (plan 2026-08-31 "a gap is not an ask"). RAW ACCESSORS
// ONLY — the migration header carries the design (one gap, one id, two stages;
// dismissal is the planner's and revisable). `src/db/` is an import LEAF: no
// production module here reaches up into src/jobs/ or src/teamLead/.
//
// TENANT SCOPING: every function filters on tenantId, but that is not the whole
// guard — callers that resolve rows for a model must compare ownership the way
// the tool handlers do (the get_job precedent, src/mcp/server.ts).

export type Observation = Database['public']['Tables']['observations']['Row'];

// The lifecycle, compile-time (the NudgeStatus pattern; the CHECK is the
// runtime twin).
export type ObservationStatus = 'open' | 'dismissed' | 'asked';

export interface CreateObservationInput {
  tenantId: string;
  kind: ReviewKind; // shared vocabulary with nudges/review_items
  subjectRef: string;
  // ADVISORY — who the detector thinks could answer, when it knows. Null is a
  // normal value, not a defect: an observation carries no obligation to ask.
  technicianId: string | null;
  context?: Json;
}

// Record a noticing — or learn this subject was already noticed, ever.
// Insert-catch-23505 (the createPendingNudge idiom): uq_observations_subject_ever
// IS the dedup, so a concurrent tick converges to null instead of a second row.
export async function createObservation(
  input: CreateObservationInput,
): Promise<Observation | null> {
  const { data, error } = await getClient()
    .from('observations')
    .insert({
      tenant_id: input.tenantId,
      kind: input.kind,
      subject_ref: input.subjectRef,
      technician_id: input.technicianId,
      context: input.context ?? {},
    })
    .select()
    .single();
  if (!error && data) return data;
  if (isUniqueViolation(error)) return null; // already noticed, ever
  throw new Error(`createObservation failed: ${error?.message ?? 'no row returned'}`);
}

export async function listObservationsByStatus(
  tenantId: string,
  statuses: ObservationStatus[],
): Promise<Observation[]> {
  if (statuses.length === 0) return []; // PostgREST `in.()` with zero values errors
  const { data, error } = await getClient()
    .from('observations')
    .select()
    .eq('tenant_id', tenantId)
    .in('status', statuses)
    .order('noticed_at', { ascending: true });
  if (error) throw new Error(`listObservationsByStatus failed: ${error.message}`);
  return (data ?? []) as Observation[];
}

// The detector's third dedup store (the listNudgedSubjectRefs twin): which of
// these subjects were ever noticed, ANY status — a dismissed observation must
// keep blocking re-notice, or "dismiss" stops meaning "stop showing me this".
// Bounded: `in()` over the caller's candidate ids, never a tenant scan.
export async function listObservedSubjectRefs(
  tenantId: string,
  kind: ReviewKind,
  subjectRefs: string[],
): Promise<string[]> {
  if (subjectRefs.length === 0) return [];
  const { data, error } = await getClient()
    .from('observations')
    .select('subject_ref')
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .in('subject_ref', subjectRefs);
  if (error) throw new Error(`listObservedSubjectRefs failed: ${error.message}`);
  return (data ?? []).map((r) => r.subject_ref);
}

// One guarded writer for every state move (the setNudgeSchedule idiom): every
// predicate in the WHERE clause, null when the row was not in the expected
// state — the caller treats that as "someone else moved it" and drops the
// write. `undefined` leaves a column alone; `null` CLEARS it (recover clears
// the dismissal, a cleared hold clears not_before) — different instructions,
// distinguished on purpose.
export async function setObservationStatus(
  id: string,
  tenantId: string,
  patch: {
    status?: ObservationStatus;
    dismissReason?: string | null;
    dismissedAt?: string | null;
    notBefore?: string | null;
  },
  fromStatuses: ObservationStatus[],
): Promise<Observation | null> {
  const set: {
    status?: ObservationStatus;
    dismiss_reason?: string | null;
    dismissed_at?: string | null;
    not_before?: string | null;
  } = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.dismissReason !== undefined) set.dismiss_reason = patch.dismissReason;
  if (patch.dismissedAt !== undefined) set.dismissed_at = patch.dismissedAt;
  if (patch.notBefore !== undefined) set.not_before = patch.notBefore;
  if (Object.keys(set).length === 0) {
    throw new Error('setObservationStatus: nothing to set');
  }
  if (fromStatuses.length === 0) {
    throw new Error('setObservationStatus: empty fromStatuses would match nothing');
  }
  const { data, error } = await getClient()
    .from('observations')
    .update(set)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .in('status', fromStatuses)
    .select()
    .maybeSingle();
  if (error) throw new Error(`setObservationStatus failed: ${error.message}`);
  return data as Observation | null;
}
