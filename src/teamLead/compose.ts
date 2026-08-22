import {
  flagNudgeGap,
  reviewItemExistsFor,
  getTenant,
  listDecisionsForNudges,
  listNudgesByStatus,
  listTenantIdsWithTelegramBindings,
  markNudgeOutcome,
  markNudgeQueued,
  setNudgeAttempts,
  type Nudge,
} from '../db/index.js';
import { localTimeHHMM } from '../schedule/availability.js';
import { runForcedTool } from '../model/forcedTool.js';
import { flatten } from './composeCopy.js';
import { NUDGE_KIND_SPECS, specFor, type NudgeKindSpec } from '../jobs/nudgeKinds.js';
import { TEAM_LEAD_REF } from './identity.js';

// The compose turn (plan 2026-08-15 feature B, Phase 3): the ONLY model call
// in the ladder. The watcher already decided a gap exists and who to ask; the
// model's whole job is to write ONE colleague-tone question — or decline. It
// sees NOTHING but the code-built context on the nudge row (fabrication
// guard, direction constraint 8), and code assembles the delivered message
// around its sentence: the evidence line's date is CODE-printed (bare date,
// no weekday, so the weekday guard has nothing to mismatch) and the standing
// footer directs the receiving agent (result-embedded directive — prompt
// rules are steering, not enforcement).

export const MAX_COMPOSE_ATTEMPTS = 3;

// The copy machinery moved to composeCopy.ts so the kind registry can read it
// without a module-init cycle. Re-exported so every existing importer
// (nudgeQueue.ts, the tests) keeps its import path.
export {
  assembleNudgeMessage,
  readComposeContext,
  relativeDayPhrase,
  type ComposeContext,
} from './composeCopy.js';

// The ask window (user ruling 2026-08-17): questions go out only between
// 7 AM and 7 PM in the FIRM's timezone, seven days a week. The gate sits on
// COMPOSE, not the outbox: the day phrase above is baked into the question
// when it is written, so a message held overnight and sent at 7 AM would say
// "earlier today" about yesterday's visit — the exact fabrication the served-
// phrase rule exists to prevent. Out-of-window rows stay pending, untouched;
// the first in-window tick composes them fresh. Detection is NOT gated (the
// watcher still notices at 9 PM). The longest hold is one night (12h; 13h on
// a DST fall-back night), safely inside the watcher's 24h never-asked
// deadline — a window that ever excludes whole DAYS must move that deadline
// with it.
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

export interface ComposeDeps {
  listTenants?: typeof listTenantIdsWithTelegramBindings;
  getTenant?: typeof getTenant;
  listNudges?: typeof listNudgesByStatus;
  // The planner's drafts (plan 2026-08-22). Injected like every other
  // collaborator; un-injected it would make the existing compose tests hit the
  // database.
  listDecisions?: typeof listDecisionsForNudges;
  run?: typeof runForcedTool;
  markQueued?: typeof markNudgeQueued;
  markOutcome?: typeof markNudgeOutcome;
  setAttempts?: typeof setNudgeAttempts;
  flagNudge?: typeof flagNudgeGap;
  reviewItemExists?: typeof reviewItemExistsFor;
  specs?: NudgeKindSpec[];
}

export interface ComposeSummary {
  composed: number;
  cancelled: number;
  failed: number;
  rowErrors: number;
  handoffs: number; // nudges that died unasked and became manager items (F1)
  // Questions the PLANNER wrote, so no model call was made for them. Counted
  // separately because a silent substitution would make it impossible to tell
  // whether the planner is writing anything at all — "composed" would look
  // identical either way.
  draftedByPlanner: number;
  held: number; // pending rows left for the next in-window tick (ask window)
  heldNotBefore: number; // pending rows the PLANNER asked us to hold (not_before)
}

export async function runTeamLeadCompose(
  nowIso: string,
  deps: ComposeDeps = {},
): Promise<ComposeSummary> {
  const listTenants = deps.listTenants ?? listTenantIdsWithTelegramBindings;
  const get = deps.getTenant ?? getTenant;
  const listNudges = deps.listNudges ?? listNudgesByStatus;
  const listDecisions = deps.listDecisions ?? listDecisionsForNudges;
  const run = deps.run ?? runForcedTool;
  const markQueued = deps.markQueued ?? markNudgeQueued;
  const markOutcome = deps.markOutcome ?? markNudgeOutcome;
  const setAttempts = deps.setAttempts ?? setNudgeAttempts;
  const flagNudge = deps.flagNudge ?? flagNudgeGap;
  const reviewItemExists = deps.reviewItemExists ?? reviewItemExistsFor;
  const specs = deps.specs ?? NUDGE_KIND_SPECS;

  const summary: ComposeSummary = {
    composed: 0,
    cancelled: 0,
    failed: 0,
    rowErrors: 0,
    handoffs: 0,
    draftedByPlanner: 0,
    held: 0,
    heldNotBefore: 0,
  };

  for (const tenantId of await listTenants()) {
    // Kind-scoped on purpose: this prompt knows how to ask about ONE gap
    // archetype. A future second detector brings its own prompt and widens
    // this filter deliberately, not by accident.
    // Registry-driven: a kind with no spec has no prompt, so it must not be
    // composed. It is also invisible to the watcher's sweep, so it should never
    // have been created — the watcher gates creation on the same registry.
    const registered = (await listNudges(tenantId, ['pending'])).filter(
      (n) => !!specFor(n.kind, specs),
    );
    // The planner's hold (plan 2026-08-19, Phase 2). A row with not_before in
    // the future is left EXACTLY as it is — no model call, no attempts bump, no
    // state change — the same untouched treatment the overnight ask-window hold
    // gives, and for the same reason: the day phrase is baked in at compose
    // time, so a held row must be composed FRESH when its time comes.
    //
    // Counted separately from `held` on purpose: "waiting for morning" and "the
    // planner is pacing this" are different facts about a firm's queue, and a
    // single counter would hide a planner that has quietly frozen everything.
    const nowMs = Date.parse(nowIso);
    const pending = registered.filter((n) => {
      const holdUntil = n.not_before ? Date.parse(n.not_before) : NaN;
      // NaN (absent or unparseable) → no hold. Fail OPEN here, deliberately: a
      // malformed hold must never be able to silence a gap forever, and the 24h
      // delivery deadline is the backstop that would otherwise have to catch it.
      if (Number.isNaN(holdUntil) || holdUntil <= nowMs) return true;
      summary.heldNotBefore += 1;
      return false;
    });
    if (pending.length === 0) continue;
    const tz = (await get(tenantId))?.timezone ?? 'UTC';
    if (!insideAskWindow(nowIso, tz)) {
      // Overnight hold: no model call, no attempts, no state change — the
      // rows must reach the morning tick EXACTLY as they are.
      summary.held += pending.length;
      continue;
    }
    // ONE batched read for the whole pending set, never one per row. Isolated:
    // losing the drafts costs model calls, not questions — compose writes its
    // own exactly as it did before this existed.
    let drafts = new Map<string, string>();
    if (pending.length > 0) {
      try {
        const rows = await listDecisions(
          tenantId,
          pending.map((n) => n.id),
        );
        for (const [id, list] of rows) {
          // Oldest first, so scan backwards for the newest. Only an APPLIED
          // `send` counts: a refused decision did not happen, a shadow one was
          // never carried out, and a hold's draft is for a send that has not
          // been decided yet.
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].action === 'send' && list[i].outcome === 'applied' && list[i].question_draft) {
              drafts.set(id, list[i].question_draft as string);
              break;
            }
          }
        }
      } catch (err) {
        console.error(`[teamLeadCompose] draft read failed for ${tenantId} — composing normally`, err);
        drafts = new Map();
      }
    }

    for (const n of pending) {
      try {
        const spec = specFor(n.kind, specs)!; // present: `pending` was filtered
        const prepared = spec.compose.prepare(n, nowIso, tz);
        if (!prepared) {
          // Thin/tampered evidence: never ask a model to guess around it —
          // but the GAP still exists, so hand it to the manager first (F1).
          // Close the nudge ONLY when the handoff landed (final-review #1):
          // a row too thin even to flag is FROZEN here — logged loudly, left
          // pending — so the status-change sweep stays its only exit; closing
          // it would orphan the gap from every surface forever.
          if (await handToManager(n, flagNudge, reviewItemExists, specs)) {
            summary.handoffs += 1;
            const moved = await markOutcome(n.id, tenantId, 'cancelled', 'context incomplete');
            if (moved) summary.cancelled += 1;
          }
          continue;
        }
        // The planner already wrote this one, so spend nothing. Deciding to
        // send IS the `ask: true` this path would otherwise be asking for, and
        // every guard below still applies — the draft is cheaper, not more
        // trusted.
        const drafted = drafts.get(n.id);
        const args = drafted
          ? { ask: true, question: drafted }
          : await run(
              spec.compose.tool,
              {
                system: spec.compose.system,
                user: prepared.user,
                maxTokens: 300,
                label: 'teamLeadCompose',
                reasoningEffort: 'none',
              },
              { tenantId, technicianRef: TEAM_LEAD_REF },
            );
        if (args.ask !== true) {
          // A decline is a judgment about ASKING, not about the gap — the
          // manager still gets it (F1).
          //
          // Deliberately NOT gated on the handoff landing. With the
          // kind-aware handToManager below, `false` now means only ONE thing:
          // the spec could not build a plan at all, i.e. the row's evidence is
          // incoherent (flagNudgeGap's null path is always "already flagged" —
          // upsertOpenReviewItem throws rather than returning null — and the
          // existence probe converts that to true). For such a row there is no
          // surface to reach, ever; freezing it here would re-compose it — a
          // fresh BILLED call — every tick forever, and the 24h expiry sweep
          // refuses it for the same missing fields. Closing bounded beats
          // looping unbounded.
          if (await handToManager(n, flagNudge, reviewItemExists, specs)) summary.handoffs += 1;
          const reason = typeof args.reason === 'string' ? args.reason : 'model declined';
          const moved = await markOutcome(n.id, tenantId, 'cancelled', `declined: ${reason}`);
          if (moved) summary.cancelled += 1;
          continue;
        }
        const question = flatten(typeof args.question === 'string' ? args.question : '', 500);
        if (question.length === 0) {
          throw new Error('compose returned an empty question');
        }
        // A question that speaks in the footer's register is trying to steer
        // the receiving agent — code owns that frame, never the model (F2).
        if (/note for the assistant/i.test(question)) {
          throw new Error('compose question tried to impersonate the assistant footer');
        }
        const queued = await markQueued(n.id, tenantId, prepared.assemble(question));
        if (queued) {
          summary.composed += 1; // null = the row moved under us — drop the write
          if (drafted) summary.draftedByPlanner += 1;
        }
      } catch (err) {
        // Per-row isolation: one bad row/model blip never blocks the sweep.
        summary.rowErrors += 1;
        console.error(`[teamLeadCompose] nudge ${n.id} failed`, err);
        const attempts = n.attempts + 1;
        try {
          // Gated on the bump LANDING (F3): setNudgeAttempts is pending-only,
          // so if markQueued's UPDATE committed but its response was lost,
          // the row is 'queued' → bump returns null → we must NOT destroy a
          // successfully queued deliverable by failing it.
          const bumped = await setAttempts(n.id, tenantId, attempts);
          if (bumped && attempts >= MAX_COMPOSE_ATTEMPTS) {
            // Terminal without the ask ever landing → the manager takes it
            // (F1; flag first, then close).
            if (await handToManager(n, flagNudge, reviewItemExists, specs)) summary.handoffs += 1;
            const moved = await markOutcome(
              n.id,
              tenantId,
              'failed',
              `compose failed ${attempts}x: ${err instanceof Error ? err.message : String(err)}`,
            );
            if (moved) summary.failed += 1;
          }
        } catch (bookkeepingErr) {
          // Attempts bookkeeping failing must not mask the original error;
          // the row simply retries next tick.
          console.error(`[teamLeadCompose] nudge ${n.id} attempts write failed`, bookkeepingErr);
        }
      }
    }
  }
  return summary;
}
