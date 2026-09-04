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
  // THE DEDUP KEY FOR A DETECTOR ROW, AND A LABEL FOR A PLANNER ROW (build 7).
  // uq_observations_subject_ever is partial on author='detector', so only a
  // detector's subject is unique-per-kind; a planner row's names what the
  // observation is about (the job id when there is one) and constrains nothing.
  subjectRef: string;
  // ADVISORY — who the detector thinks could answer, when it knows. Null is a
  // normal value, not a defect: an observation carries no obligation to ask.
  technicianId: string | null;
  // WHO IS WRITING (build 7, migration 20260904110000). Defaults to 'detector'
  // so every existing call site means exactly what it always did.
  author?: 'detector' | 'planner';
  context?: Json;
}

// Record a noticing — or learn this subject was already noticed, ever.
// Insert-catch-23505 (the createPendingNudge idiom): uq_observations_subject_ever
// IS the dedup, so a concurrent tick converges to null instead of a second row.
//
// THE 23505 PATH IS DETECTOR-ONLY since build 7. The index is partial on
// author='detector', so a planner row cannot collide and this function always
// returns a row for one (or throws). A null return therefore means exactly one
// thing to a caller: "the detector had already noticed this subject".
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
      author: input.author ?? 'detector',
      context: input.context ?? {},
    })
    .select()
    .single();
  if (!error && data) return data;
  if (isUniqueViolation(error)) return null; // already noticed, ever
  throw new Error(`createObservation failed: ${error?.message ?? 'no row returned'}`);
}

// PAGED past PostgREST's silent 1000-row cap (code-review): the open set is
// unbounded BY DESIGN (the record grows; the planner curates), so an unpaged
// read would silently show the planner only the oldest 1000 and hide every
// newer observation with no error anywhere. The nudgeDecisions .range() idiom.
const PAGE = 1000;

export async function listObservationsByStatus(
  tenantId: string,
  statuses: ObservationStatus[],
): Promise<Observation[]> {
  if (statuses.length === 0) return []; // PostgREST `in.()` with zero values errors
  const out: Observation[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getClient()
      .from('observations')
      .select()
      .eq('tenant_id', tenantId)
      .in('status', statuses)
      .order('noticed_at', { ascending: true })
      .order('id', { ascending: true }) // deterministic paging tiebreak
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listObservationsByStatus failed: ${error.message}`);
    out.push(...((data ?? []) as Observation[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// The detector's third dedup store (the listNudgedSubjectRefs twin): which of
// these subjects were ever noticed, ANY status?
//
// CORRECTED IN BUILD 7, because the original wording here — and the migration
// header at 20260901130000:66 — described TWO mechanisms as one. It said a
// dismissed observation must keep blocking re-notice "or dismiss stops meaning
// stop showing me this". Those are different things:
//
//   this read + uq_observations_subject_ever  = the DETECTOR'S MEMORY. The
//     sweep is stateless and runs every five minutes; without a record of what
//     it already noticed it would re-notice the same visit forever. That is why
//     the status is deliberately not filtered.
//   status='dismissed'                        = what hides a row from every
//     ['open'] reader — the PLANNER's gap read (runPlanner) and also the
//     sweep's neglect counter (watchers.ts, the build-5 alarm pass), so a
//     dismissal stops the row being counted as stale too. Revisable via
//     `recover`.
//
// The planner never needed the first: it is shown its open set every tick, and
// doctrine — not a database rule — is what brakes a duplicate open (the plan's
// explicit choice; a DB rail and a per-tick cap were both considered and
// rejected). Build 7 made that split explicit by narrowing the index to
// author='detector'.
//
// AND THIS READ MUST NAME THE AUTHOR TOO, which is not cosmetic. A partial
// index is only usable when the query IMPLIES its predicate, so once the index
// gained `where author = 'detector'` a read that did not mention `author` could
// no longer use it — measured on the local stack at 20k rows: Index Only Scan
// (cost 33) became a Seq Scan (cost 770), twice per tenant per five-minute
// sweep tick, on a table with NO DELETE PATH that therefore only grows.
// The filter changes no RESULT — a planner row carries kind
// 'planner_observation' and this read already filters on kind — it states the
// invariant the paragraph above describes, and restores the index. That is a
// CONVENTION, not a guarantee: the column permits author='planner' on a
// detector kind, and what keeps them apart is that `observe` hardcodes the
// kind, nothing enforced here.
//
// Still any-status, deliberately: the detector's memory does not care what
// later became of the row.
//
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
    .eq('author', 'detector') // implies the partial index's predicate — see above
    .in('subject_ref', subjectRefs);
  if (error) throw new Error(`listObservedSubjectRefs failed: ${error.message}`);
  return (data ?? []).map((r) => r.subject_ref);
}

// The recover-validation read: ids only, deliberately — dismissed rows are
// permanent (no delete path) and monotonic, and pulling full rows (context
// jsonb included) for every tick would grow forever. The planner needs only
// "may this id be recovered", which is the id set (phase-3 review F3).
export async function listDismissedObservationIds(tenantId: string): Promise<string[]> {
  // Paged and ORDERED (code-review): dismissed rows are permanent, so >1000 is
  // the designed steady state — unpaged, an arbitrary subset would decide which
  // recovers silently drop (the F4 path leaves no record row).
  const out: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getClient()
      .from('observations')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('status', 'dismissed')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listDismissedObservationIds failed: ${error.message}`);
    out.push(...(data ?? []).map((r) => r.id));
    if (!data || data.length < PAGE) break;
  }
  return out;
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
