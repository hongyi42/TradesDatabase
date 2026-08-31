import type { ReviewKind } from '../db/reviewItems.js';

// The ladder's kind registry — SLIMMED TO THE ITEM SWEEP'S HALF (build 5,
// plan 2026-08-31 "the sweep stops deciding").
//
// What this used to be: five per-kind members binding detection to judgment —
// `filled` (is the gap answerable), `moot` (is the subject gone), `handoff`
// (the manager copy), `stage0Suggestion` and a per-kind mint brake. Every one
// of those judgments moved to the planner or died with the acting sweep:
// moot facts are computed spec-free in planner.ts and printed into the gap
// view; the manager line is the planner's own handoffNote; nothing is capped
// at mint; nothing auto-closes.
//
// What remains is the ONE judgment the sweep kept (user ruling 5): the
// manager-queue self-clean. `itemResolved` answers "has the thing this REVIEW
// ITEM asked the manager for been done?" — a different question per kind (a
// visit item closes on a field report or a status change; a cost item closes
// only when the LEDGER gains the cost), which is why a registry survives at
// all. `subjectIsVisit` routes each kind's subjects into the right batched
// status read.
//
// The predicates are PURE functions over facts the sweep has already fetched
// (SweepFacts) — never a DB client. That is deliberate: the sweep does ONE
// batched activity/status read per tenant per tick, and a spec that could
// query would quietly turn it into a per-row read.

// Everything a spec may know about the world this tick, pre-fetched by the
// sweep. Keyed the way the batched reads already key: activity by job,
// assignment status by the item's subject_ref, job status by job id.
export interface SweepFacts {
  hasActivitySince: (jobId: string, sinceLocal: string) => boolean;
  visitStatusById: Map<string, string>;
  // The cost item's closure test reads the job's status (a cancelled job has
  // nothing left to record). Populated from the same batched pre-fetch.
  jobStatusById: Map<string, string>;
  // Jobs that HAVE a live (non-negated) cost on the money ledger — what says
  // a manager has done the thing their cost item asked for.
  jobsWithCostEvents: Set<string>;
}

// The manager-queue view of ONE open review item, parsed fail-closed at the
// boundary. `jobId` is required (every gap is about a job); the visit bounds
// are null for a job-scoped kind, and a spec that needs them returns null.
export interface OpenItemView {
  subjectRef: string;
  jobId: string;
  startsAtLocal: string | null;
  // When the item was FLAGGED, firm wall clock — the anchor for "arrived
  // after this was flagged". Null when the stamp cannot be parsed, and the
  // activity path declines (fail-closed).
  flaggedAtLocal: string | null;
  // True for a planner-escalated item (detail.escalatedFromNudge). The visit
  // STATUS path must not self-clean these: the archetype escalation is a
  // completed visit with no report, and status-resolving it would eat the
  // handover the moment it opened (build-5 final review).
  escalated: boolean;
}

export interface NudgeKindSpec {
  kind: ReviewKind;
  // Does subject_ref name a VISIT (an assignment id), or something else? The
  // sweep uses this to decide which batched status read a kind's subjects
  // belong in — a job-scoped kind's subject is a job id, and looking it up in
  // the assignments table is both wasted work and a lie about what the id
  // means.
  subjectIsVisit: boolean;
  // How an open MANAGER REVIEW ITEM of this kind closes itself → resolution
  // text, or null to leave it open. The one judgment the sweep kept (build 5):
  // an item asks the MANAGER for something, and this says whether they did it.
  itemResolved(item: OpenItemView, f: SweepFacts): string | null;
}

export const OVERDUE_VISIT_GAP_SPEC: NudgeKindSpec = {
  kind: 'overdue_visit_gap',
  subjectIsVisit: true,

  // The two closure paths, their resolution copy carried through every
  // refactor VERBATIM — these strings are manager-visible history.
  itemResolved(item, f) {
    // AFTER THE FLAG, literally (build-5 final review): the copy says so, and
    // comparing against the visit start let pre-flag activity — which a
    // planner escalates DESPITE — close a just-opened handover.
    if (item.flaggedAtLocal && f.hasActivitySince(item.jobId, item.flaggedAtLocal)) {
      return 'field report arrived after this was flagged';
    }
    if (!item.escalated) {
      const status = f.visitStatusById.get(item.subjectRef);
      if (status === 'cancelled' || status === 'completed') {
        return `visit was ${status} after this was flagged`;
      }
    }
    return null;
  },
};

// A cost item asks the MANAGER to record what the job cost, so the ledger is
// the only thing that can say it is done — not a note, and not any other
// activity on the job.
export const JOB_COST_GAP_SPEC: NudgeKindSpec = {
  kind: 'job_cost_gap',
  // The only kind whose subject is a JOB.
  subjectIsVisit: false,

  itemResolved(item, f) {
    if (f.jobsWithCostEvents.has(item.jobId)) {
      return 'a cost was recorded for this job after it was flagged';
    }
    if (f.jobStatusById.get(item.jobId) === 'cancelled') {
      return 'the job was cancelled after this was flagged';
    }
    return null;
  },
};

// Every kind whose review items self-clean, and whose detector may mint.
// Adding one here is what makes it detected and its items swept — there is no
// second place to edit.
export const NUDGE_KIND_SPECS: NudgeKindSpec[] = [OVERDUE_VISIT_GAP_SPEC, JOB_COST_GAP_SPEC];

export function specFor(
  kind: string,
  specs: NudgeKindSpec[] = NUDGE_KIND_SPECS,
): NudgeKindSpec | undefined {
  return specs.find((s) => s.kind === kind);
}
