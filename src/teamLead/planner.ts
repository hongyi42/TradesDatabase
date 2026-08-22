import {
  getTenant,
  listDecisionsForNudges,
  listJobEvidenceSince,
  listJobIdsWithCostEvents,
  listLiveMoneyEventsForJobsSince,
  listNudgesByStatus,
  listTenantIdsWithTelegramBindings,
  markNudgeOutcome,
  OPEN_NUDGE_STATUSES,
  recordNudgeDecisions,
  setNudgeSchedule,
  type JobEvidenceRow,
  type MoneyEvent,
  type Nudge,
  type NudgeDecision,
  type NudgeDecisionInput,
} from '../db/index.js';
import { runToolLoop, ToolLoopLimitError, type ToolLoopLimit } from '../model/toolLoop.js';
import type { ForcedToolSpec } from '../model/forcedTool.js';
import { NUDGE_KIND_SPECS, specFor, type NudgeKindSpec } from '../jobs/nudgeKinds.js';
import { insideAskWindow } from './compose.js';
// A plain const, read only inside functions — never at module-evaluation time.
// watchers.ts and nudgeKinds.ts are a documented import cycle; this module sits
// outside it, so there is no temporal-dead-zone hazard here.
import { NUDGE_DELIVERY_DEADLINE_HOURS } from '../jobs/watchers.js';
import { localDateISO, localTimeHHMM } from '../schedule/availability.js';
import { PLANNER_SYSTEM, SUBMIT_PLAN_TOOL } from './plannerPrompt.js';
import { TEAM_LEAD_REF } from './identity.js';

// The team-lead planner (plan 2026-08-19, Phase 3).
//
// ONE call per firm per half-hour that sees every open gap at once and decides
// timing and closure for all of them together. That "at once" is the whole
// point: pacing is a judgment about a QUEUE, and the per-gap compose call — one
// gap, one sentence, no memory of the others — structurally cannot make it.
//
// The division of labour, and it is deliberate:
//   code   owns the guarantees — the ask window, the delivery deadline, the
//          orphan doctrine, dedup, the runaway brakes, and the validation below
//   model  owns the judgment inside them — when, how patient, is that an answer
//
// The planner NEVER acts. It returns decisions; the sweep performs them, and
// every decision is re-checked in code first. In 'shadow' it does not even
// return decisions to a writer — it logs them, which is how the cost and the
// judgment get measured before anything depends on either.

export type PlannerMode = 'off' | 'shadow' | 'live';

export const PLANNER_ACTIONS = ['send', 'hold', 'close', 'escalate'] as const;
export type PlannerAction = (typeof PLANNER_ACTIONS)[number];

export interface PlannerDecision {
  nudgeId: string;
  action: PlannerAction;
  notBefore?: string | null;
  escalateAfter?: string | null;
  // WHY this close is allowed to stand. 'evidence' = somebody answered, and
  // `citation` quotes their words. 'record' = the hole the gap names is filled,
  // whoever filled it — authorised ONLY by the code-computed fact on the gap
  // view, never by the model asserting it.
  basis?: 'evidence' | 'record';
  citation?: string | null;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
}

// A decision the code rails refused, kept so a shadow run reports what the model
// got wrong rather than quietly showing a shorter plan.
export interface DroppedDecision {
  nudgeId: string;
  action: string;
  why: string;
  // Carried so a refused decision can be RECORDED with the model's own
  // confidence and reasoning, not just counted. A refusal is the most
  // informative row in the log — it is the one place we learn what the model
  // wanted to do and could not.
  confidence?: 'low' | 'medium' | 'high';
  reason?: string;
}

export interface PlannerTenantPlan {
  tenantId: string;
  gaps: number;
  decisions: PlannerDecision[];
  dropped: DroppedDecision[];
  applied: number;
  refusedAtApply: number;
  recorded: number;
  turns: number;
  toolCalls: number;
  ms: number;
}

export interface PlannerSummary {
  mode: PlannerMode;
  tenants: number; // tenants considered
  planned: number; // tenants the model actually ran for
  skippedNoGaps: number;
  skippedWindow: number; // outside the firm's ask window — nothing could be sent anyway
  decisions: number;
  dropped: number;
  applied: number; // decisions the code actually performed — always 0 in shadow
  refusedAtApply: number; // accepted by the rails, then refused by the write
  recorded: number; // rows written to nudge_decisions
  tenantErrors: number;
  // Tenants whose call died on the LOOP's own limits rather than on the model
  // or the provider. Counted apart because the two need opposite responses: a
  // provider error is waited out, a limit hit means the work stopped fitting —
  // twenty gaps in a firm that used to have two — and the ceiling or the
  // batching has to change. Rolled into tenantErrors as well, so the existing
  // ok=false alarm still fires.
  limitHits: Record<ToolLoopLimit, number>;
  byAction: Record<string, number>;
  plans: PlannerTenantPlan[];
}

// How much of one capture the model sees. Evidence is model INPUT: it is billed,
// it displaces the prompt, and the planner needs enough to recognise an answer,
// not the whole conversation. A quote must still be findable in what we showed —
// so the citation check runs against exactly this truncated text, never the full
// row, or a valid-looking quote from unseen text would pass.
export const EVIDENCE_TEXT_CHARS = 600;
// Per gap, newest last. A technician who replied did so in the first message or
// two; forty of them is a different problem than this one.
export const EVIDENCE_PER_GAP = 6;

// The per-turn output budget, and the think that has to fit inside it.
//
// MEASURED, not guessed (2026-08-20, local stack, GLM-5.2 via Fireworks): at
// maxTokens 4096 with reasoning left at the provider default, the FIRST turn
// came back finish_reason=length on a two-gap firm — the truncation guard caught
// it and the whole plan was lost. GLM-5.2 thinks by default and an unbounded
// think is not bounded by the prompt.
//
// Unlike the synthesis callers, this one must NOT set reasoning to 'none': the
// planner's entire job is the judgment, and a forced-JSON extraction is what
// 'none' was chosen for. 'low' keeps the think and bounds it; the larger budget
// leaves room for a plan covering many gaps at once.
export const PLANNER_MAX_TOKENS = 8192;
export const PLANNER_REASONING = 'low' as const;

export interface PlannerDeps {
  listTenants?: typeof listTenantIdsWithTelegramBindings;
  getTenant?: typeof getTenant;
  listNudges?: typeof listNudgesByStatus;
  listEvidence?: typeof listJobEvidenceSince;
  // The record-level test for cost gaps. Same reader the item sweep uses, so
  // "the ledger says this is filled" means one thing across the whole ladder.
  listCostEvents?: typeof listJobIdsWithCostEvents;
  // Money that landed on a gap's job after the ask (plan 2026-08-21 ①). A
  // separate read from listCostEvents, deliberately: that one answers "does
  // this job have a live material_cost" for the cost gap's record test, and is
  // kind-scoped. This one is every kind, because the PLANNER decides which
  // kinds answer which question — code states the fact, the model judges it.
  listMoneySince?: typeof listLiveMoneyEventsForJobsSince;
  runLoop?: typeof runToolLoop;
  // Phase 4: the memory, and the two writers. Injected like everything else so
  // a test never touches the database — and so `shadow` can be proven to call
  // NEITHER writer.
  listDecisions?: typeof listDecisionsForNudges;
  recordDecisions?: typeof recordNudgeDecisions;
  setSchedule?: typeof setNudgeSchedule;
  markOutcome?: typeof markNudgeOutcome;
  // The team lead's read tools and the door they dispatch through. Injected so a
  // test never needs the MCP server — and so the planner cannot reach any tool
  // its caller did not hand it.
  tools?: ForcedToolSpec[];
  // tenantId is a PARAMETER, not a closure the caller binds once: the planner
  // walks every tenant in one process, and an executor bound to the wrong one
  // would read another firm's records into this firm's prompt.
  execute?: (
    tenantId: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  specs?: NudgeKindSpec[];
  // Will the SWEEP run this deployment? Not a seam for tests — a fact the
  // caller owns and the planner cannot see, because `escalate` does not
  // escalate: it brings the deadline forward and lets watchers.ts perform the
  // handoff. The sweep reads open nudges only when WATCHERS_MODE is 'live'
  // (watchers.ts:361), and step 8 is skipped entirely when it is unset — so
  // with the watcher rolled back and PLANNER_MODE on, every escalate would
  // write a real row, report `applied`, and reach nobody. Recording an
  // escalation that never happened is worse than not escalating: the one place
  // a manager would check says the handover was made.
  //
  // Defaults TRUE — the old behaviour — because the alternative fails in the
  // worse direction: a caller that forgets to pass it would silently stop
  // escalating in a healthy deployment. lifecycle.ts always passes it, and a
  // test pins that wiring.
  sweepLive?: boolean;
}

const ctxStr = (n: Nudge, k: string): string | null => {
  const c = (n.context ?? {}) as Record<string, unknown>;
  return typeof c[k] === 'string' && (c[k] as string).length > 0 ? (c[k] as string) : null;
};

function hoursBetween(fromIso: string, toMs: number): number {
  const ms = toMs - Date.parse(fromIso);
  return Number.isNaN(ms) ? 0 : Math.round((ms / 3_600_000) * 10) / 10;
}

// "Wednesday, August 19, 2026 at 6:50 PM in the firm's timezone (America/Los_Angeles)".
// Weekday and date come from ONE derivation so they cannot disagree, and the
// zone is named so the reader can tell this is not UTC.
function firmClockLine(nowIso: string, tz: string): string {
  try {
    const day = localDateISO(nowIso, tz);
    const hhmm = localTimeHHMM(nowIso, tz);
    const human = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    return `${human} at ${hhmm} in this firm's own timezone (${tz})`;
  } catch {
    // An unknown zone must not take the tenant's whole plan down; say plainly
    // that this is UTC rather than printing a wrong local time.
    return `${nowIso}, in UTC (this firm's timezone '${tz}' could not be read)`;
  }
}

// Collapse to one line so a multi-line note cannot fake structure in the prompt.
function flat(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

/** What the model is shown about ONE gap, and what its citation is checked against. */
interface GapView {
  nudge: Nudge;
  jobId: string | null;
  evidenceText: string[]; // exactly the strings rendered into the prompt
  // Whether the HOLE this gap names is closed in the record, as CODE sees it —
  // independent of whether anybody replied. Null when the kind has no
  // record-level test (a visit gap's hole is "no note", and the sweep already
  // auto-closes those before the planner ever sees them). This is the only thing
  // that may authorise a `record`-basis close, which is why it is computed here
  // and never taken from the model.
  recordFilled: string | null;
  // Money that landed on this job after the ask, stated as a FACT (plan
  // 2026-08-21 ①). Null when none did. It authorises a `record`-basis close the
  // same way recordFilled does — and for the same reason it is computed here
  // rather than taken from the model. It is deliberately NOT part of
  // evidenceText: `evidence` means somebody's own words, and a money-close must
  // never write `answered — "..."` about a row no person spoke.
  moneyOnRecord: string | null;
  // Every decision already made about this gap, oldest first. Only its SHAPE
  // reaches the prompt (a count and the last action); the detail is pulled with
  // recall_decisions. Kept on the view so tests can assert both halves.
  history: NudgeDecision[];
  block: string;
}

// The ONE thing about the history that is PUSHED rather than left to a lookup.
//
// Everything else is fetched with recall_decisions, because injecting a growing
// history into every prompt does not scale and raw trajectories are the wrong
// memory unit anyway. But "you have decided about this before, and here is the
// last thing you did" has to be present whether or not the model thinks to ask —
// the failure it prevents (re-deciding from zero every 30 minutes, escalating
// something already escalated) IS the failure of not knowing there was anything
// to look up. Push the keys and the existence; pull the content.
function historyLine(history: NudgeDecision[], nowMs: number): string | null {
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  const mark =
    last.outcome === 'applied'
      ? ''
      : last.outcome === 'refused'
        ? ' — REFUSED'
        : ' — shadow, not applied';
  return (
    `  prior decisions: ${history.length} (last: ${last.action}${mark}, ` +
    `${hoursBetween(last.decided_at, nowMs)}h ago). Use recall_decisions for the detail.`
  );
}

// The evidence bound is CODE's, not the model's: only what landed after the ask,
// on that gap's job. A planner that could decide for itself what counted as
// evidence could mark a gap answered by something that predates the question.
function buildGapView(
  n: Nudge,
  nowMs: number,
  evidence: JobEvidenceRow[],
  sharesJob: boolean,
  jobsWithCostEvents: Set<string>,
  history: NudgeDecision[] = [],
  money: MoneyEvent[] = [],
): GapView {
  const jobId = ctxStr(n, 'jobId');
  const askedAtMs = n.asked_at ? Date.parse(n.asked_at) : NaN;
  const relevant = Number.isNaN(askedAtMs)
    ? []
    : evidence
        .filter((e) => e.jobId === jobId && Date.parse(e.capture.captured_at) > askedAtMs)
        .slice(-EVIDENCE_PER_GAP);

  const evidenceText = relevant.map((e) => flat(e.capture.raw_text ?? '', EVIDENCE_TEXT_CHARS));

  // The record-level test, per kind. A cost gap names a hole in the LEDGER, and
  // the ledger is the only thing that can say the hole is closed — a note cannot,
  // and neither can silence. Code owns this because it is a fact, not a judgment.
  const recordFilled =
    n.kind === 'job_cost_gap' && jobId && jobsWithCostEvents.has(jobId)
      ? 'a cost is recorded against this job on the money ledger'
      : null;

  // Money on THIS gap's job, bounded the same way the captures are: only what
  // landed after the question went out, and nothing at all if it was never
  // asked. `created_at`, not `occurred_at` — see the reader's own comment.
  const moneyHere = Number.isNaN(askedAtMs)
    ? []
    : money.filter((m) => m.job_id === jobId && Date.parse(m.created_at) > askedAtMs);
  // Cents to dollars, and NEVER summed and never signed: direction comes from
  // `kind` (moneyEvents.ts), and the standing rule is to aggregate the
  // summaries, never the rows. An amountless kind renders without a figure.
  const moneyAmount = (m: MoneyEvent): string =>
    `${m.kind}${m.amount_cents == null ? '' : ` $${(m.amount_cents / 100).toFixed(2)}`}`;
  const moneyLine = (m: MoneyEvent): string =>
    `${moneyAmount(m)}, recorded ${m.created_at.slice(0, 10)}`;
  // Capped like the notes are, and for the same reason: one job can carry a very
  // large number of ledger rows (the reader's own test writes 1005), and an
  // uncapped block would be both an enormous prompt and — through
  // `moneyOnRecord` below — a multi-kilobyte line written PERMANENTLY into
  // nudges.resolution. Most recent wins, matching the notes' `.slice(-N)`.
  const moneyShown = moneyHere.slice(-EVIDENCE_PER_GAP);
  const latest = moneyHere[moneyHere.length - 1];
  const others = moneyHere.length - 1;
  const moneyOnRecord = latest
    ? `the money ledger records ${moneyAmount(latest)} against this job, recorded ` +
      `${latest.created_at.slice(0, 10)} after the question went out` +
      (others > 0 ? ` (and ${others} other ledger ${others === 1 ? 'entry' : 'entries'})` : '')
    : null;

  const lines = [
    `gap ${n.id}`,
    `  kind: ${n.kind}`,
    `  about: ${ctxStr(n, 'jobTitle') ?? 'a job'} for ${ctxStr(n, 'customerName') ?? 'unknown customer'}`,
    // The ID, not just the name. Without it the planner searched with
    // `customer_name LIKE '%Okafor%'` and burned turns on queries that returned
    // nothing — it had the words but not the key.
    ...(jobId ? [`  job id: ${jobId}   (filter by this id, never by name)`] : []),
    `  person: ${ctxStr(n, 'technicianName') ?? 'unknown'}`,
    `  state: ${n.status}`,
    `  noticed: ${hoursBetween(n.created_at, nowMs)}h ago`,
  ];
  if (n.asked_at) lines.push(`  asked: ${hoursBetween(n.asked_at, nowMs)}h ago`);
  else lines.push('  asked: not yet');
  if (n.question) lines.push(`  the question asked: ${flat(n.question, 400)}`);
  if (n.kind === 'job_cost_gap') {
    lines.push(
      recordFilled
        ? `  THE RECORD: ${recordFilled}. The hole this gap names is CLOSED — whoever filled it. ` +
          'Close this gap with basis "record".'
        : '  THE RECORD: no cost is recorded against this job yet. The hole is still open.',
    );
  }
  if (n.not_before) lines.push(`  currently held until: ${n.not_before}`);
  if (n.escalate_after) lines.push(`  currently escalates at: ${n.escalate_after}`);
  const hist = historyLine(history, nowMs);
  if (hist) lines.push(hist);
  if (!n.asked_at) {
    lines.push('  evidence since the ask: (nothing was asked yet, so there is none)');
  } else {
    // The warning sits ABOVE both blocks and outside the has-notes branch: two
    // gaps on one job share their money as well as their notes, and a job with
    // money but no notes used to fall straight past this.
    if (sharesJob) {
      // Code-computed, because code KNOWS this and the model would have to infer
      // it. Two gaps on one job see the same notes, and nothing below can tell
      // which question a given sentence answers.
      lines.push(
        '  NOTE: this job has more than one open gap, so everything below is SHARED between ' +
          'them. Make sure it answers THIS question, not the other one.',
      );
    }
    if (relevant.length === 0) {
      // "notes", not "nothing has landed": money may be printed directly below,
      // and a blanket nothing-landed claim would contradict it on the next line.
      lines.push('  notes since the ask: NO notes have landed on this job since the question went out');
    } else {
      lines.push('  evidence since the ask:');
      relevant.forEach((e, i) => {
        lines.push(
          `    [${i + 1}] ${e.capture.captured_at} via ${e.capture.channel}` +
            `${e.capture.technician_ref ? ` (${e.capture.technician_ref})` : ''}: ${evidenceText[i]}`,
        );
      });
    }
    // AFTER the capture loop, always: that loop indexes evidenceText by
    // `relevant`'s own index, so anything spliced in ahead of it silently
    // mislabels every note line.
    if (moneyShown.length > 0) {
      lines.push('  money on this job since the question went out:');
      moneyShown.forEach((m, i) => lines.push(`    [${i + 1}] ${moneyLine(m)}`));
      lines.push(
        '  That is a fact from the ledger, not a quote from a person — weigh whether it answers ' +
          'THIS question. If it does, close with basis "record".',
      );
    }
  }
  return {
    nudge: n,
    jobId,
    evidenceText,
    recordFilled,
    moneyOnRecord,
    history,
    block: lines.join('\n'),
  };
}

// Normalised for the citation check ONLY — a model that changes spacing or case
// is quoting; a model that changes words is not.
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

// A quote has to be worth something. `includes()` alone accepts "the", which
// appears in almost any note — probed, and it closed a gap whose evidence said
// "the van broke down, nothing to report on this job yet". In Phase 4 that would
// close a real gap and write "the" into `resolution` as the evidence for it.
//
// Two words and twelve characters keeps genuinely short answers ("forty
// dollars", "no parts needed") and rejects the ones that are only technically
// present. A too-short quote refuses the close and the gap stays open — the
// cheap failure, on purpose.
export const MIN_CITATION_CHARS = 12;
export const MIN_CITATION_WORDS = 2;

// How far ahead a hold may reach. Past its delivery deadline a pending row
// is handed to the manager as NEVER DELIVERED — so a longer hold does not hold
// anything, it silently converts the gap into a manager item with copy saying
// the ask never landed. This is the clamp nudges.not_before's column comment
// names, and it belongs here because the planner is the writer.
function holdCeilingMs(n: Nudge): number {
  return Date.parse(n.created_at) + NUDGE_DELIVERY_DEADLINE_HOURS * 3_600_000;
}

/**
 * The code rails, applied to every decision before it can reach a writer. These
 * run in shadow too: a shadow run that reported an invalid plan as valid would
 * measure the wrong thing.
 */
export function validateDecisions(
  raw: unknown,
  views: Map<string, GapView>,
  nowMs: number = Date.now(),
  sweepLive: boolean = true,
): { decisions: PlannerDecision[]; dropped: DroppedDecision[] } {
  const decisions: PlannerDecision[] = [];
  const dropped: DroppedDecision[] = [];
  const usedQuotes = new Set<string>();
  const list = Array.isArray((raw as { decisions?: unknown })?.decisions)
    ? ((raw as { decisions: unknown[] }).decisions as Record<string, unknown>[])
    : [];
  const seen = new Set<string>();

  for (const entry of list) {
    // Everything below reads model-supplied JSON, so the boundary is fail-closed
    // start to finish: a non-object entry (a provider that returns [null], a
    // schema the model ignored) is dropped, never dereferenced.
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      dropped.push({ nudgeId: '', action: '', why: 'not a decision object' });
      continue;
    }
    const d = entry as Record<string, unknown>;
    const nudgeId = typeof d.nudgeId === 'string' ? d.nudgeId : '';
    const action = String(d.action ?? '');
    // Read up here so a REFUSED decision is recorded with the model's own
    // confidence and words, not just a counter. Unreadable confidence is not
    // high confidence.
    const confidence: 'low' | 'medium' | 'high' =
      d.confidence === 'low' || d.confidence === 'medium' || d.confidence === 'high'
        ? d.confidence
        : 'low';
    const reason = typeof d.reason === 'string' ? flat(d.reason, 300) : '';
    const push = (why: string) => dropped.push({ nudgeId, action, why, confidence, reason });

    const view = views.get(nudgeId);
    if (!view) {
      push('names a gap that was not in this plan');
      continue;
    }
    if (seen.has(nudgeId)) {
      push('a second decision for the same gap');
      continue;
    }
    if (!(PLANNER_ACTIONS as readonly string[]).includes(action)) {
      push(`unknown action '${action}'`);
      continue;
    }

    // `send` and `hold` only MEAN something on a row that has not gone out yet.
    // Both write `not_before`, and `not_before` gates COMPOSE and nothing else
    // (compose.ts:190) — the delivery pull does not read it and an asked row has
    // no compose left to gate. Applying either to a queued or asked row would
    // return the row happily and change nothing anybody could observe: the
    // silent no-op this phase exists to make impossible. Observed live
    // 2026-08-20, when the planner chose `send` on a row that had been asked
    // hours earlier.
    //
    // Refused rather than translated. "Give them more time" IS expressible —
    // by not naming the gap at all — and the prompt says so; inventing a
    // mapping from `hold` to `escalate_after` would be code doing the model's
    // judgment for it, which is the one thing this design does not do.
    // Escalation is for silence AFTER a question went out: the sweep's handoff
    // requires `status === 'asked' && asked_at` (watchers.ts:576), so bringing
    // escalate_after forward on a pending row moves nothing. A gap nobody can
    // even be asked already has its own path — the delivery deadline hands it
    // to the manager as never-delivered.
    // The SWEEP performs every escalation; this rail is the same principle as
    // the send/hold ones below, one level up. There, an action is refused
    // because the ROW cannot observe it; here, because the DEPLOYMENT cannot.
    // Both are the silent no-op this phase exists to make impossible — and this
    // one is the more dangerous of the two, since the write succeeds and the
    // decision log would read `applied` for a handover nobody ever received.
    //
    // Refused, not skipped: the model's judgment was sound, so it is recorded
    // with its own words and confidence. What failed is the machinery, and the
    // reason says so rather than blaming the decision.
    if (action === 'escalate' && !sweepLive) {
      push(
        'escalate while the watcher is not live — escalation is performed by the sweep, which ' +
          'only runs when WATCHERS_MODE is live, so nothing would reach the manager. This is a ' +
          'deployment state, not a fault in the decision.',
      );
      continue;
    }
    if (action === 'escalate' && view.nudge.status !== 'asked') {
      push(
        'escalate on a gap that has not been asked yet — escalation is for silence after a ' +
          'question went out, and a gap that cannot be delivered reaches the manager on its own.',
      );
      continue;
    }

    if (action === 'send' || action === 'hold') {
      const st = view.nudge.status;
      if (st !== 'pending') {
        push(
          st === 'asked'
            ? `${action} on a gap that has ALREADY been asked — the question is with the person ` +
                'now, so only close or escalate mean anything. To give them more time, leave the ' +
                'gap out of your plan.'
            : `${action} on a gap that is already composed and waiting to be delivered — there ` +
                'is nothing to release. Leave it out of your plan.',
        );
        continue;
      }
    }

    // ASSERT-ONLY-CITED, in code. The prompt asks for a verbatim quote; this is
    // what makes it true. A close whose quote is absent from what we actually
    // SHOWED the model is refused — ambiguity defaults to open, because a
    // false-open is loud and cheap and a false-close is silent.
    let citation: string | null = null;
    let basis: 'evidence' | 'record' | undefined;
    if (action === 'close') {
      // A gap names a HOLE IN THE RECORD, and a hole can close two ways: somebody
      // answered, or the record simply got filled. The second route exists
      // because the first cannot express it — a parts cost the MANAGER entered
      // has no technician quote to point at, and demanding one meant the planner
      // chased people for figures the books already had (observed live,
      // 2026-08-20). The authority is the code-computed fact on the view: the
      // model chooses the basis, code decides whether that basis holds.
      if (d.basis === 'record') {
        // EITHER code-computed fact authorises it. recordFilled wins where both
        // exist: on a cost gap the ledger's cost IS the hole, and it is the more
        // specific statement of the two.
        const fact = view.recordFilled ?? view.moneyOnRecord;
        if (!fact) {
          push('close on the record when the record is not filled');
          continue;
        }
        basis = 'record';
        seen.add(nudgeId);
        decisions.push({
          nudgeId,
          action: 'close',
          basis,
          citation: fact, // code's words, not the model's
          confidence,
          reason,
        });
        continue;
      }
      basis = 'evidence';
      const quote = typeof d.citation === 'string' ? d.citation.trim() : '';
      if (quote.length === 0) {
        push('close without a citation');
        continue;
      }
      const wanted = norm(quote);
      if (wanted.length < MIN_CITATION_CHARS || wanted.split(' ').length < MIN_CITATION_WORDS) {
        push(`close whose citation is too short to be evidence ('${quote}')`);
        continue;
      }
      const shown = view.evidenceText.map(norm);
      if (!shown.some((text) => text.includes(wanted))) {
        push('close whose citation does not appear in the evidence');
        continue;
      }
      // ONE quote may close ONE gap. Two gaps on the same job share one evidence
      // pool — the two shipped detectors do exactly that — and nothing in code
      // can tell which QUESTION a given sentence answers. This does not make a
      // single wrong close impossible, but it stops one note from closing every
      // open gap on a job, which is the shape that would actually happen. The
      // real fix is a nudge-session stamp on the capture, which does not exist.
      if (usedQuotes.has(wanted)) {
        push('close reusing a quote that already closed another gap in this plan');
        continue;
      }
      usedQuotes.add(wanted);
      citation = quote;
    }

    let notBefore: string | null = null;
    if (action === 'hold') {
      const at = typeof d.notBefore === 'string' ? Date.parse(d.notBefore) : NaN;
      if (Number.isNaN(at)) {
        push('hold without a usable notBefore');
        continue;
      }
      if (at <= nowMs) {
        push('hold until a moment that has already passed');
        continue;
      }
      const ceiling = holdCeilingMs(view.nudge);
      if (at > ceiling) {
        push(
          `hold past the ${NUDGE_DELIVERY_DEADLINE_HOURS}h delivery deadline ` +
            `(${new Date(ceiling).toISOString()}), ` +
            'which would hand the gap to the manager as never-asked instead of holding it',
        );
        continue;
      }
      notBefore = new Date(at).toISOString();
    }

    seen.add(nudgeId);
    decisions.push({
      nudgeId,
      action: action as PlannerAction,
      ...(notBefore ? { notBefore } : {}),
      ...(basis ? { basis } : {}),
      ...(citation ? { citation } : {}),
      confidence,
      reason,
    });
  }
  return { decisions, dropped };
}

/**
 * Perform ONE decision and report what ACTUALLY happened (plan Phase 4).
 *
 * Every path returns an outcome the log can trust. `applied` is claimed only
 * when a row really moved: these are status-guarded conditional updates, so a
 * null return means the row changed between the model's read and this write —
 * a delivery ack, an auto-resolve, another sweep — which is a real event, not a
 * failure, and must not be recorded as success.
 *
 * The planner never escalates, resolves or cancels a row by hand. `escalate`
 * brings the deadline forward and lets the SWEEP perform the handoff, so the
 * rung-2 flag, the orphan doctrine and the flag-then-close ordering stay in one
 * place (watchers.ts) instead of being re-implemented beside it.
 */
async function applyDecision(
  tenantId: string,
  d: PlannerDecision,
  nowIso: string,
  setSchedule: typeof setNudgeSchedule,
  markOutcome: typeof markNudgeOutcome,
): Promise<{ outcome: 'applied' | 'refused'; detail?: string }> {
  const moved = 'the gap changed state between the plan and the write — nothing was applied';
  const done = (row: Nudge | null): { outcome: 'applied' | 'refused'; detail?: string } =>
    row ? { outcome: 'applied' } : { outcome: 'refused', detail: moved };
  switch (d.action) {
    case 'send':
      // `null` CLEARS the hold — the deliberate other half of setNudgeSchedule's
      // undefined/null distinction ("forget what I said last tick"). Pending-only
      // guard repeats the rail, because the row can move in between.
      return done(await setSchedule(d.nudgeId, tenantId, { notBefore: null }, ['pending']));
    case 'hold':
      return done(
        await setSchedule(d.nudgeId, tenantId, { notBefore: d.notBefore ?? null }, ['pending']),
      );
    case 'escalate':
      return done(await setSchedule(d.nudgeId, tenantId, { escalateAfter: nowIso }, ['asked']));
    case 'close': {
      // The resolution is the durable audit line a manager may later read, so it
      // says WHERE the answer came from. A record-basis close quotes code's own
      // words (validateDecisions overwrote the model's citation with them).
      const resolution =
        d.basis === 'record'
          ? `closed on the record — ${d.citation}`
          : `answered — "${d.citation}"`;
      return done(await markOutcome(d.nudgeId, tenantId, 'answered', resolution));
    }
  }
}

export async function runPlanner(
  nowIso: string,
  mode: PlannerMode,
  deps: PlannerDeps = {},
): Promise<PlannerSummary> {
  const listTenants = deps.listTenants ?? listTenantIdsWithTelegramBindings;
  const get = deps.getTenant ?? getTenant;
  const listNudges = deps.listNudges ?? listNudgesByStatus;
  const listEvidence = deps.listEvidence ?? listJobEvidenceSince;
  const listCostEvents = deps.listCostEvents ?? listJobIdsWithCostEvents;
  const listMoneySince = deps.listMoneySince ?? listLiveMoneyEventsForJobsSince;
  const runLoop = deps.runLoop ?? runToolLoop;
  const listDecisions = deps.listDecisions ?? listDecisionsForNudges;
  const recordDecisions = deps.recordDecisions ?? recordNudgeDecisions;
  const setSchedule = deps.setSchedule ?? setNudgeSchedule;
  const markOutcome = deps.markOutcome ?? markNudgeOutcome;
  const specs = deps.specs ?? NUDGE_KIND_SPECS;
  const sweepLive = deps.sweepLive ?? true;
  const tools = deps.tools ?? [];
  const execute = deps.execute;

  const nowMs = Date.parse(nowIso);
  const summary: PlannerSummary = {
    mode,
    tenants: 0,
    planned: 0,
    skippedNoGaps: 0,
    skippedWindow: 0,
    decisions: 0,
    dropped: 0,
    applied: 0,
    refusedAtApply: 0,
    recorded: 0,
    tenantErrors: 0,
    limitHits: { budget: 0, turns: 0 },
    byAction: {},
    plans: [],
  };
  if (mode === 'off') return summary;

  const tenantIds = await listTenants();
  summary.tenants = tenantIds.length;

  for (const tenantId of tenantIds) {
    try {
      // Registry-gated like every other ladder path: a kind with no spec is not
      // composed, not swept, and not planned for either.
      const open = (await listNudges(tenantId, [...OPEN_NUDGE_STATUSES])).filter(
        (n) => !!specFor(n.kind, specs),
      );
      if (open.length === 0) {
        summary.skippedNoGaps += 1;
        continue;
      }
      // Outside the ask window nothing can go out, and closure can wait for the
      // morning — so the call is skipped ENTIRELY rather than made and ignored.
      // This is the single largest lever on what the planner costs.
      const tz = (await get(tenantId))?.timezone ?? 'UTC';
      if (!insideAskWindow(nowIso, tz)) {
        summary.skippedWindow += 1;
        continue;
      }

      // ONE batched evidence read for the tenant, floored at the EARLIEST ask
      // among its asked gaps — the per-gap bound is then applied in code.
      const askedAt = open
        .map((n) => (n.asked_at ? Date.parse(n.asked_at) : NaN))
        .filter((ms) => !Number.isNaN(ms));
      const jobIds = [
        ...new Set(open.map((n) => ctxStr(n, 'jobId')).filter((v): v is string => !!v)),
      ];
      // ONE derivation of the floor, shared by the evidence and money reads: two
      // copies of a bound that must stay identical is a defect waiting to happen.
      const sinceIso =
        askedAt.length > 0 && jobIds.length > 0
          ? new Date(Math.min(...askedAt)).toISOString()
          : null;
      const evidence = sinceIso ? await listEvidence(tenantId, jobIds, sinceIso) : [];

      // ONE ledger read per tenant, over the cost gaps' jobs only — the same
      // batched discipline as the evidence read. Skipped entirely when the firm
      // has no open cost gaps this tick.
      const costJobIds = [
        ...new Set(
          open
            .filter((n) => n.kind === 'job_cost_gap')
            .map((n) => ctxStr(n, 'jobId'))
            .filter((v): v is string => !!v),
        ),
      ];
      const jobsWithCostEvents = new Set(
        costJobIds.length > 0 ? await listCostEvents(tenantId, costJobIds) : [],
      );

      // ONE batched money read for the whole tick, bounded by the EARLIEST ask
      // among these gaps; buildGapView narrows it per gap. Skipped entirely when
      // nothing has been asked yet — an unasked gap can have no answer, so there
      // is no window to read.
      const money = sinceIso ? await listMoneySince(tenantId, jobIds, sinceIso) : [];

      // ONE batched read of the planner's own history for this tick's gaps —
      // the same discipline as the evidence and ledger reads above. Only its
      // shape reaches the prompt; the detail is pulled with recall_decisions.
      const historyByNudge = await listDecisions(
        tenantId,
        open.map((n) => n.id),
      );

      const gapsPerJob = new Map<string, number>();
      for (const n of open) {
        const j = ctxStr(n, 'jobId');
        if (j) gapsPerJob.set(j, (gapsPerJob.get(j) ?? 0) + 1);
      }
      const views = new Map<string, GapView>();
      for (const n of open) {
        const j = ctxStr(n, 'jobId');
        views.set(
          n.id,
          buildGapView(
            n,
            nowMs,
            evidence,
            !!j && (gapsPerJob.get(j) ?? 0) > 1,
            jobsWithCostEvents,
            historyByNudge.get(n.id) ?? [],
            money,
          ),
        );
      }

      // GROUNDING, code-computed. The first live run reasoned "it is the middle
      // of the night" at 18:50 in the firm's own timezone, because it was handed
      // UTC and nothing else — and pacing is exactly a judgment about whether
      // this is a reasonable hour to bother somebody. Same doctrine as the tool
      // results' `now` rider and the weekday guard: the model is never the thing
      // that converts a clock.
      const user = [
        `Right now it is ${firmClockLine(nowIso, tz)}.`,
        `In UTC that instant is ${nowIso} — use UTC for any notBefore you write.`,
        '',
        `This firm has ${open.length} open gap(s).`,
        '',
        [...views.values()].map((v) => v.block).join('\n\n'),
      ].join('\n');

      const started = Date.now();
      // Validated INSIDE the executor on purpose. Validating after the loop
      // returns means a plan the rails refuse is simply gone — the model never
      // learns its citation was unusable, and the gap stays open with nobody the
      // wiser. Here a wholly-refused submission comes back as a tool error, and
      // the model gets to fix it within the turn ceiling.
      let outcome: { decisions: PlannerDecision[]; dropped: DroppedDecision[] } = {
        decisions: [],
        dropped: [],
      };
      const result = await runLoop(
        {
          system: PLANNER_SYSTEM,
          user,
          maxTokens: PLANNER_MAX_TOKENS,
          label: 'teamLeadPlanner',
          reasoningEffort: PLANNER_REASONING,
          terminalTool: SUBMIT_PLAN_TOOL.name,
        },
        [...tools, SUBMIT_PLAN_TOOL],
        async (name, args) => {
          if (name === SUBMIT_PLAN_TOOL.name) {
            const checked = validateDecisions(args, views, nowMs, sweepLive);
            outcome = checked; // the LAST submission stands, refusals included
            // A submission where EVERY decision was refused is a correctable
            // mistake, not an answer. An EMPTY plan is a legitimate choice
            // ("leave them all alone") and is accepted as it is.
            if (checked.decisions.length === 0 && checked.dropped.length > 0) {
              throw new Error(
                'every decision was refused: ' +
                  checked.dropped
                    .map((d) => `${d.action || '?'} ${d.nudgeId || '?'} — ${d.why}`)
                    .join('; ') +
                  '. Fix these and call submit_plan again.',
              );
            }
            return {
              status: 'ok',
              accepted: checked.decisions.length,
              refused: checked.dropped.length,
            };
          }
          if (!execute) throw new Error(`no executor for '${name}'`);
          return execute(tenantId, name, args);
        },
        { tenantId, technicianRef: TEAM_LEAD_REF },
      );

      const { decisions, dropped } = outcome;
      summary.planned += 1;
      summary.decisions += decisions.length;
      summary.dropped += dropped.length;
      for (const d of decisions) summary.byAction[d.action] = (summary.byAction[d.action] ?? 0) + 1;

      // APPLY (live only), THEN RECORD what actually happened. This order is the
      // point: recording first would log an intention as an outcome, and the
      // whole reason this table exists is that "the planner decided X" and "X
      // happened" had become indistinguishable.
      const records: NudgeDecisionInput[] = [];
      let applied = 0;
      let refusedAtApply = 0;
      for (const d of decisions) {
        const jobId = views.get(d.nudgeId)?.jobId ?? null;
        const base = {
          tenantId,
          nudgeId: d.nudgeId,
          jobId,
          mode,
          action: d.action,
          notBefore: d.notBefore ?? null,
          basis: d.basis ?? null,
          citation: d.citation ?? null,
          confidence: d.confidence,
          reason: d.reason,
        };
        if (mode !== 'live') {
          records.push({ ...base, mode: 'shadow', outcome: 'shadow' });
          continue;
        }
        let res: { outcome: 'applied' | 'refused'; detail?: string };
        try {
          res = await applyDecision(tenantId, d, nowIso, setSchedule, markOutcome);
        } catch (err) {
          // One failed write must not abandon the rest of the firm's plan, and
          // it must not be silent either — it becomes a refusal WITH the reason.
          res = {
            outcome: 'refused',
            detail: `write failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (res.outcome === 'applied') applied += 1;
        else refusedAtApply += 1;
        records.push({ ...base, mode: 'live', outcome: res.outcome, outcomeDetail: res.detail });
      }
      // Rail-refused decisions are recorded too — a refusal is the most
      // informative row in the log, being the one place we learn what the model
      // wanted to do and could not. Only entries naming a real gap and a real
      // action: a malformed submission is a parse failure, not a decision. The
      // model's citation is deliberately NOT stored on a refused close, or a
      // quote the rails rejected as unfindable would be preserved as evidence.
      for (const d of dropped) {
        if (!views.has(d.nudgeId)) continue;
        if (!(PLANNER_ACTIONS as readonly string[]).includes(d.action)) continue;
        records.push({
          tenantId,
          nudgeId: d.nudgeId,
          jobId: views.get(d.nudgeId)?.jobId ?? null,
          mode,
          action: d.action,
          confidence: d.confidence ?? 'low',
          reason: d.reason ?? '',
          outcome: 'refused',
          outcomeDetail: d.why,
        });
      }

      let recorded = 0;
      try {
        recorded = await recordDecisions(records);
      } catch (err) {
        // Be LOUD but do not take the tick down (the recordModelUsage posture).
        // In live the nudges rows still carry the state, so what is lost here is
        // the memory and the corpus — bad, not dangerous.
        console.error(`[planner] tenant ${tenantId}: recording ${records.length} decisions failed`, err);
      }
      summary.applied += applied;
      summary.refusedAtApply += refusedAtApply;
      summary.recorded += recorded;

      summary.plans.push({
        tenantId,
        gaps: open.length,
        decisions,
        dropped,
        applied,
        refusedAtApply,
        recorded,
        turns: result.turns,
        toolCalls: result.calls.length,
        ms: Date.now() - started,
      });

      // SHADOW TOUCHES NO NUDGE — not a schedule, not a resolution. It DOES
      // write nudge_decisions, which is the point: the corpus and the planner's
      // own memory start accumulating before anything is applied, so the effect
      // of having a memory can be watched in shadow rather than discovered live.
      if (mode === 'shadow') {
        console.log(
          `[planner:shadow] tenant ${tenantId}: ${open.length} gaps → ` +
            `${decisions.length} decisions (${dropped.length} refused), ` +
            `${recorded} recorded, ` +
            `${result.turns} turns, ${result.calls.length} tool calls, ${Date.now() - started}ms`,
        );
        for (const d of decisions) {
          console.log(
            `[planner:shadow]   ${d.action} ${d.nudgeId} (${d.confidence})` +
              `${d.notBefore ? ` until ${d.notBefore}` : ''} — ${d.reason}`,
          );
        }
        for (const d of dropped) {
          console.log(`[planner:shadow]   REFUSED ${d.action} ${d.nudgeId} — ${d.why}`);
        }
      }
    } catch (err) {
      // Per-tenant isolation, and a whole-call failure leaves every row
      // untouched: the sweep's constants still apply, so a dead planner degrades
      // to exactly the behaviour that shipped before it existed.
      summary.tenantErrors += 1;
      if (err instanceof ToolLoopLimitError) {
        summary.limitHits[err.limit] += 1;
        // Said loudly and in different words on purpose: this firm's plan did
        // not fit, which is a CAPACITY fact about the queue, not an outage.
        console.error(
          `[planner] tenant ${tenantId} hit the loop's ${err.limit} limit — the work no longer ` +
            `fits, this is NOT a model or provider failure: ${err.message}`,
        );
      } else {
        console.error(`[planner] tenant ${tenantId} failed`, err);
      }
    }
  }
  return summary;
}
