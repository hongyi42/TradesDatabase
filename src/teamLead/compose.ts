import {
  flagNudgeGap,
  reviewItemExistsFor,
  type Nudge,
} from '../db/index.js';
import { localTimeHHMM } from '../schedule/availability.js';
import { NUDGE_KIND_SPECS, specFor, type NudgeKindSpec } from '../jobs/nudgeKinds.js';

// What survived the compose turn (the collapse, plan 2026-08-24).
//
// Compose used to be the ladder's ONLY model call: it wrote the technician's
// question for every pending gap and assembled the delivered message around it.
// The planner now writes that message itself and queues it verbatim inside its
// own apply step, so the sweep, its per-kind prompts and its assembly templates
// are gone. There is no model call anywhere in the ladder any more.
//
// Two things outlived it, both code, both still imported elsewhere: the ASK
// WINDOW (the planner's own gate — it skips whole tenants outside it) and
// `handToManager`, the rung-2 fallback for a gap that dies without its ask ever
// landing (the delivery queue still needs it). The file keeps its name so those
// importers do not churn.

// The ask window (user ruling 2026-08-17): questions go out only between
// 7 AM and 7 PM in the FIRM's timezone, seven days a week. Since the collapse
// (plan 2026-08-24) the gate sits on the PLANNER, which skips whole tenants
// outside the window (planner.ts) — nothing is written, so nothing can be
// queued, and a gap noticed at 9 PM simply waits for the morning tick with its
// question still unwritten. Detection is NOT gated (the watcher still notices
// at 9 PM). The longest hold is one night (12h; 13h on a DST fall-back night),
// safely inside NUDGE_DELIVERY_DEADLINE_HOURS (18h, watchers.ts) — a window
// that ever excludes whole DAYS must move that deadline with it.
export const ASK_WINDOW_START_HOUR = 7; // inclusive, firm-local
export const ASK_WINDOW_END_HOUR = 19; // exclusive, firm-local

export function insideAskWindow(nowIso: string, tz: string): boolean {
  let hour: number;
  try {
    hour = Number(localTimeHHMM(nowIso, tz).slice(0, 2));
  } catch (err) {
    // An unknown zone must not block every OTHER tenant's sweep (the tenant
    // loop has no per-tenant isolation). Judge by UTC; the per-row day-phrase
    // call fails loudly on the same zone, so this never hides quietly.
    console.error(`[teamLeadCompose] bad timezone '${tz}', judging ask window by UTC`, err);
    hour = new Date(nowIso).getUTCHours();
  }
  return hour >= ASK_WINDOW_START_HOUR && hour < ASK_WINDOW_END_HOUR;
}

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
