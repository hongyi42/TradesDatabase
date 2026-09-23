import {
  listTenantIdsWithTelegramBindings,
  type Observation,
  type OfficeMessage,
} from '../db/index.js';
import {
  runPlanner,
  type PlannerDeps,
  type PlannerMode,
  type PlannerSummary,
} from '../teamLead/planner.js';
import { TEAM_LEAD_TOOL_SCHEMAS, dispatchForIdentity } from '../mcp/server.js';
import { TEAM_LEAD_REF } from '../teamLead/identity.js';
import { hasModelCredentials, assertSpineModelAllowed } from '../model/forcedTool.js';

// HOW THE PLANNER IS CALLED, in one place (rung 10).
//
// The half-hourly heartbeat and the Calls-worker's ping loop are two different
// processes running the SAME planner, and before this the wiring — the tool
// schemas and the per-tenant executor — lived only inside lifecycle.ts. A second
// caller copying those four lines is how the two drift: one gains a tool the
// other does not have, and the difference shows up as a model that can do a
// thing at :00 and cannot do it ten seconds after a call.
//
// The IDENTITY IS MINTED PER TENANT, never bound once for the process: the
// planner walks every firm in one call, and an executor closed over the wrong
// tenant would read another firm's records into this firm's prompt.
export async function runPlannerPass(
  nowIso: string,
  mode: PlannerMode,
  extra: Partial<PlannerDeps> = {},
  // Injected so lifecycle.ts can keep passing its own `deps.runPlanner` through
  // — that seam is what its unit tests stub, and routing it through here must
  // not quietly reach the real planner.
  impl: typeof runPlanner = runPlanner,
): Promise<PlannerSummary> {
  return await impl(nowIso, mode, {
    tools: [...TEAM_LEAD_TOOL_SCHEMAS],
    execute: (tenantId, name, args) =>
      dispatchForIdentity(name, args, { tenantId, technicianRef: TEAM_LEAD_REF }),
    ...extra,
  });
}

// The mode the environment says, or null when the planner must not run at all.
// Same three values lifecycle.ts parses, and the same tolerance: an UNSET
// PLANNER_MODE is a valid 'off' (a worker deployed before the var is chosen
// must not start planning), and a typo is 'off' here rather than a loud error —
// the heartbeat is where a bad value turns the run red, and two processes
// shouting about one misconfiguration is one too many.
function plannerModeFromEnv(): PlannerMode | null {
  const raw = process.env.PLANNER_MODE;
  if (!raw || raw === 'off') return null;
  return raw === 'shadow' || raw === 'live' ? raw : null;
}

/**
 * Why a focused pass cannot run right now, or null when it can.
 *
 * SEPARATE FROM THE PASS ITSELF, and that separation is load-bearing: the ping
 * loop claims a row by stamping `pinged_at`, and NOTHING releases a claim. So
 * every reason the pass would refuse to run has to be known BEFORE the claim,
 * or the loop drains the queue marking calls "the planner was called about it"
 * while calling nobody — and those rows never return to the fast path, because
 * both readers require `pinged_at is null`. A worker deployed before its env
 * lands would silently downgrade every inbound call to the half-hourly cadence,
 * permanently, and setting the variable later would not recover them.
 *
 * The spine-model rail is checked here for the same reason the heartbeat checks
 * it: the Calls-worker carries its own INFERENCE_MODEL now, and a seat model
 * set there would otherwise run the planner with nothing to catch it.
 */
export function focusedPassBlockedBy(): string | null {
  if (!plannerModeFromEnv()) return "PLANNER_MODE 'off'";
  if (!hasModelCredentials()) return 'no inference credentials';
  try {
    assertSpineModelAllowed(process.env.INFERENCE_MODEL || '');
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

// ONE FOCUSED PASS'S CLOCK, for a call and a message alike. It runs inside the
// Calls worker, the process that also drains the call queue, so it must not
// hold the tick's 15 minutes. OFFICE_CLAIM_LEASE_MS (teamLead/planner.ts) must
// stay above it — a test pins that — or a tick could take back a message from a
// pass still working on it.
export const FOCUSED_PASS_BUDGET_MS = 180_000;

// THE FOCUSED PASS (rung 10). One observation, one firm, called within seconds
// of the capture landing — not the tick.
//
// Every reader is scoped to that one item, and the scoping is the whole design:
// the planner is shown this call and nothing else, so it cannot spend a
// three-minute budget re-reading a firm's whole backlog, and it cannot act on
// work the half-hourly pass is about to look at properly. What it keeps is
// everything that makes it ITSELF — its memory index, its doctrine, its tools.
//
// WHY EVERY OVERRIDE IS A FUNCTION: PlannerDeps fields are `typeof <reader>`,
// so a plain value would not typecheck. The office reader in particular MUST be
// stubbed rather than left to the default — the no-work skip reads it, and an
// unstubbed live read would pull the firm's whole unread inbox into a pass that
// is supposed to be about one call.
//
// `plannerRun` is deliberately NOT overridden: focus mode skips the marker
// write inside runPlanner itself (a focused pass is not the tick).
export async function runFocusedObservationPass(
  observation: Observation,
  impl: typeof runPlanner = runPlanner,
  budgetMs = FOCUSED_PASS_BUDGET_MS,
): Promise<PlannerSummary | { skipped: string }> {
  const blocked = focusedPassBlockedBy();
  const mode = plannerModeFromEnv();
  if (blocked || !mode) return { skipped: blocked ?? "PLANNER_MODE 'off'" };
  return await runPlannerPass(
    new Date().toISOString(),
    mode,
    {
      focus: { observationId: observation.id, budgetMs },
      // ONE FIRM, AND ONLY IF IT IS ONE THE PLANNER SERVES AT ALL. Filtering
      // the real eligibility read rather than naming the tenant outright: a
      // firm with no Telegram binding is one the heartbeat never plans for, and
      // running for it here would queue office rows nothing will ever deliver.
      // An ineligible (or unknown) tenant yields an empty list, and the pass
      // does nothing.
      listTenants: async () =>
        (await listTenantIdsWithTelegramBindings()).filter(
          (id) => id === observation.tenant_id,
        ),
      // ONE ITEM. The nudge reader and the observation reader together are the
      // gap list, so emptying one and pinning the other IS the scoping.
      listObservations: async () => [observation],
      listNudges: async () => [],
      // The inbox and the desk transcript are the firm's other traffic — not
      // this call's business, and consuming them here would mark them read.
      listOfficeMessages: async () => [],
      listDeskTranscripts: async () => [],
      // AND NOTHING THE PASS WAS NOT SHOWN MAY BE MUTATED. `recover` is
      // validated against the dismissed SETS, deliberately not against the
      // gaps on screen — so an unscoped read here would let a pass about one
      // call un-dismiss any gap in the firm. Empty = nothing is recoverable in
      // a focused pass, which is the honest reading of "this is not yours now".
      listDismissedIds: async () => [],
      listDismissedNudges: async () => [],
    },
    impl,
  );
}

// THE MESSAGE PASS (rung 10c) — the office's fourth door. One seat message, one
// firm, called within seconds of the seat sending it, on the office's prompt.
//
// THE CALL PASS'S MIRROR IMAGE: there the one item is a gap and the inbox is
// emptied; here the one item is a MESSAGE and every gap reader is emptied. The
// same blocked/mode preamble, the same eligibility filter, the same "nothing the
// pass was not shown may be mutated" rule for recover. The message is marked
// read by runPlanner itself when the pass succeeds, exactly as the tick marks
// what it showed — a failed pass leaves it unread, for the tick.
export async function runFocusedMessagePass(
  message: OfficeMessage,
  impl: typeof runPlanner = runPlanner,
  budgetMs = FOCUSED_PASS_BUDGET_MS,
): Promise<PlannerSummary | { skipped: string }> {
  const blocked = focusedPassBlockedBy();
  const mode = plannerModeFromEnv();
  if (blocked || !mode) return { skipped: blocked ?? "PLANNER_MODE 'off'" };
  return await runPlannerPass(
    new Date().toISOString(),
    mode,
    {
      focus: { messageId: message.id, budgetMs },
      // ONE FIRM, and only one the planner serves (see the call pass).
      listTenants: async () =>
        (await listTenantIdsWithTelegramBindings()).filter((id) => id === message.tenant_id),
      // ONE MESSAGE, and no gaps at all.
      listOfficeMessages: async () => [message],
      listObservations: async () => [],
      listNudges: async () => [],
      // The firm's other traffic is not this message's business.
      listDeskTranscripts: async () => [],
      listOfficeRead: async () => [],
      // Nothing recoverable in a pass that was shown no gaps.
      listDismissedIds: async () => [],
      listDismissedNudges: async () => [],
    },
    impl,
  );
}
