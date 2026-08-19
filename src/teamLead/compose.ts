import {
  flagOverdueVisitGap,
  getTenant,
  listNudgesByStatus,
  listTenantIdsWithTelegramBindings,
  markNudgeOutcome,
  markNudgeQueued,
  setNudgeAttempts,
  type Nudge,
} from '../db/index.js';
import { localTimeHHMM } from '../schedule/availability.js';
import { runForcedTool } from '../model/forcedTool.js';
import {
  flatten,
  readComposeContext,
  type ComposeContext,
} from './composeCopy.js';
import { NUDGE_KIND_SPECS, specFor, stage0Suggestion, type NudgeKindSpec } from '../jobs/nudgeKinds.js';
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
  ctx: ComposeContext | null,
  flagGap: typeof flagOverdueVisitGap,
): Promise<boolean> {
  // Read the FLAG-coherent fields from the raw context even when the compose
  // reader returned null (final-review #1: readComposeContext fails on any
  // missing DISPLAY field — an empty customer name — but the flag needs only
  // jobId + the two timestamps; without this fallback a display-thin row was
  // cancelled with no surface, the exact orphan the doctrine forbids).
  const raw = (n.context ?? {}) as Record<string, unknown>;
  const rs = (k: string): string | null =>
    typeof raw[k] === 'string' && (raw[k] as string).length > 0 ? (raw[k] as string) : null;
  const jobId = ctx?.jobId ?? rs('jobId');
  const startsAtLocal = ctx?.startsAtLocal ?? rs('startsAtLocal');
  const endsAtLocal = ctx?.endsAtLocal ?? rs('endsAtLocal');
  if (!jobId || !startsAtLocal || !endsAtLocal || Number.isNaN(Date.parse(endsAtLocal))) {
    // Not enough evidence even to flag coherently — the row is tampered
    // beyond use. Loud log; callers must FREEZE the row (never cancel it),
    // so the status-change sweep remains its only exit.
    console.error(`[teamLeadCompose] nudge ${n.id} unfit for manager handoff (thin context)`);
    return false;
  }
  const title = ctx?.jobTitle ?? flatten(rs('jobTitle') ?? 'a job', 120);
  const customer = ctx?.customerName ?? flatten(rs('customerName') ?? 'unknown customer', 80);
  const item = await flagGap({
    tenantId: n.tenant_id,
    assignmentId: n.subject_ref,
    jobId,
    technicianRef: ctx?.technicianRef ?? null,
    startsAtLocal,
    endsAtLocal,
    escalatedFromNudge: n.id,
    // ONE definition of this copy (it was duplicated byte-for-byte here and in
    // watchers.ts — copy that says the same thing in two places drifts).
    suggestion: stage0Suggestion(title, customer, endsAtLocal),
  });
  return item !== null;
}

export interface ComposeDeps {
  listTenants?: typeof listTenantIdsWithTelegramBindings;
  getTenant?: typeof getTenant;
  listNudges?: typeof listNudgesByStatus;
  run?: typeof runForcedTool;
  markQueued?: typeof markNudgeQueued;
  markOutcome?: typeof markNudgeOutcome;
  setAttempts?: typeof setNudgeAttempts;
  flagGap?: typeof flagOverdueVisitGap;
  specs?: NudgeKindSpec[];
}

export interface ComposeSummary {
  composed: number;
  cancelled: number;
  failed: number;
  rowErrors: number;
  handoffs: number; // nudges that died unasked and became manager items (F1)
  held: number; // pending rows left for the next in-window tick (ask window)
}

export async function runTeamLeadCompose(
  nowIso: string,
  deps: ComposeDeps = {},
): Promise<ComposeSummary> {
  const listTenants = deps.listTenants ?? listTenantIdsWithTelegramBindings;
  const get = deps.getTenant ?? getTenant;
  const listNudges = deps.listNudges ?? listNudgesByStatus;
  const run = deps.run ?? runForcedTool;
  const markQueued = deps.markQueued ?? markNudgeQueued;
  const markOutcome = deps.markOutcome ?? markNudgeOutcome;
  const setAttempts = deps.setAttempts ?? setNudgeAttempts;
  const flagGap = deps.flagGap ?? flagOverdueVisitGap;
  const specs = deps.specs ?? NUDGE_KIND_SPECS;

  const summary: ComposeSummary = {
    composed: 0,
    cancelled: 0,
    failed: 0,
    rowErrors: 0,
    handoffs: 0,
    held: 0,
  };

  for (const tenantId of await listTenants()) {
    // Kind-scoped on purpose: this prompt knows how to ask about ONE gap
    // archetype. A future second detector brings its own prompt and widens
    // this filter deliberately, not by accident.
    // Registry-driven: a kind with no spec has no prompt, so it must not be
    // composed. It is also invisible to the watcher's sweep, so it should never
    // have been created — the watcher gates creation on the same registry.
    const pending = (await listNudges(tenantId, ['pending'])).filter((n) => !!specFor(n.kind, specs));
    if (pending.length === 0) continue;
    const tz = (await get(tenantId))?.timezone ?? 'UTC';
    if (!insideAskWindow(nowIso, tz)) {
      // Overnight hold: no model call, no attempts, no state change — the
      // rows must reach the morning tick EXACTLY as they are.
      summary.held += pending.length;
      continue;
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
          if (await handToManager(n, null, flagGap)) {
            summary.handoffs += 1;
            const moved = await markOutcome(n.id, tenantId, 'cancelled', 'context incomplete');
            if (moved) summary.cancelled += 1;
          }
          continue;
        }
        const args = await run(
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
          // NOT gated on the handoff landing, deliberately. Gating it here
          // freezes the row AFTER the model call, so an unflaggable row would
          // be re-composed — a fresh paid call — every tick forever, with no
          // exit (the 24h expiry sweep refuses the same row for the same
          // missing fields). Phase 4 owns the gate, together with the two
          // things that make it safe: a flagger that distinguishes "already
          // flagged" from "flag failed", and a bounded exit for a row no
          // surface can accept.
          if (await handToManager(n, readComposeContext(n), flagGap)) summary.handoffs += 1;
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
        if (queued) summary.composed += 1; // null = the row moved under us — drop the write
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
            if (await handToManager(n, readComposeContext(n), flagGap)) summary.handoffs += 1;
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
