import {
  flagNudgeGap,
  reviewItemExistsFor,
  type Nudge,
} from '../db/index.js';
import { NUDGE_KIND_SPECS, specFor, type NudgeKindSpec } from '../jobs/nudgeKinds.js';

// What survived the compose turn (the collapse, plan 2026-08-24).
//
// Compose used to be the ladder's ONLY model call: it wrote the technician's
// question for every pending gap and assembled the delivered message around it.
// The planner now writes that message itself and queues it verbatim inside its
// own apply step, so the sweep, its per-kind prompts and its assembly templates
// are gone. There is no model call anywhere in the ladder any more.
//
// ONE thing outlived it: `handToManager`, the rung-2 fallback for a gap that dies
// without its ask ever landing (the delivery queue still needs it). The file
// keeps its name so that importer does not churn.
//
// THE ASK WINDOW IS GONE (plan 2026-08-29 "the firm is data", Phase 3; user
// ruling the same day). It lived here — 7am-7pm firm-local, seven days a week
// (user, 2026-08-17) — and since the collapse it gated the PLANNER, skipping
// whole tenants outside it. There is no send-timing gate anywhere now:
//
//   "if a message goes out outside of working hour, then the human gets a tick.
//    Not the end of the world… And if the message doesn't get answered, then the
//    planner will learn that messaging at that time is bad, and message at a
//    different time. Of course there's going to be a learning process. But we
//    don't want to constrain what the planner can do."
//
// What replaced it is NOT another gate: the planner now runs on a per-firm
// CADENCE (planner.ts), which decides how often it THINKS, never whether it may
// send. Two things that used to lean on the window and no longer can:
//   - NUDGE_DELIVERY_DEADLINE_HOURS's 18h was derived from a 12h overnight hold.
//     Nothing holds a gap overnight now; see its comment in watchers.ts.
//   - the working-hours METRIC keeps a fixed 7-19 convention of its OWN, in
//     jobs/workingHours.ts. It is a yardstick, not a claim about any firm, and it
//     is pinned to a SQL twin and to stored gap_summaries rows.

// The rung-2 fallback for a nudge that dies WITHOUT the ask ever landing
// (model declined, compose gave up — review F1): the gap must still reach the
// manager, because the fresh pre-filter excludes ever-nudged assignments in
// every mode and the once-ever index blocks a second nudge — without this,
// the gap would reach NEITHER surface, ever. Same copy the Stage-0 fallback
// uses (the manager sees the familiar shape); the once-ever review dedup
// makes retries converge. Flag FIRST, then close the nudge — the safe order
// (a blip re-runs compose next tick; the reverse order orphans the gap).
export async function handToManager(
  n: Nudge,
  flagNudge: typeof flagNudgeGap,
  exists: typeof reviewItemExistsFor = reviewItemExistsFor,
  specs: NudgeKindSpec[] = NUDGE_KIND_SPECS,
): Promise<boolean> {
  // KIND-AWARE (plan 2026-08-19, Phase 4). This used to read visit-shaped
  // fields directly, which meant a job-scoped gap — no startsAtLocal, no
  // endsAtLocal — could never be handed over, so it closed with NO manager
  // surface at all: the exact orphan the terminal-failure doctrine forbids.
  // The spec owns its own copy and its own required fields, and builds the
  // plan from the RAW context (so a DISPLAY-thin row can still flag, the
  // final-review #1 property).
  //
  // 'expired' mode is always right here: every caller reaches this because the
  // ask never landed (compose declined/failed, or delivery gave up), and the
  // manager must never be told a question was asked when it wasn't.
  const spec = specFor(n.kind, specs);
  if (!spec) {
    console.error(`[teamLeadCompose] nudge ${n.id} has unregistered kind '${n.kind}' — cannot hand over`);
    return false;
  }
  const plan = spec.handoff(n, 'expired');
  if (!plan) {
    // Not enough evidence even to flag coherently — the row is tampered
    // beyond use. Loud log; callers must FREEZE the row (never cancel it),
    // so the status-change sweep remains its only exit.
    console.error(`[teamLeadCompose] nudge ${n.id} unfit for manager handoff (thin context)`);
    return false;
  }
  const item = await flagNudge({
    tenantId: n.tenant_id,
    kind: spec.kind,
    subjectRef: plan.subjectRef,
    jobId: plan.jobId,
    technicianRef: plan.technicianRef,
    startsAtLocal: plan.startsAtLocal,
    endsAtLocal: plan.endsAtLocal,
    escalatedFromNudge: n.id,
    suggestion: plan.suggestion,
  });
  if (item) return true;
  // null has TWO opposite meanings and the doctrine needs them apart: the
  // once-ever dedup found an existing item (the manager HAS this gap — safe to
  // close the nudge), or nothing landed (not safe). Only read on this path.
  return exists(n.tenant_id, spec.kind, plan.subjectRef);
}
