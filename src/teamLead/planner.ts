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
import { renderLessonsBlock } from './lessons.js';
// A plain const, read only inside functions — never at module-evaluation time.
// watchers.ts and nudgeKinds.ts are a documented import cycle; this module sits
// outside it, so there is no temporal-dead-zone hazard here.
import {
  NUDGE_DELIVERY_DEADLINE_HOURS,
  NUDGE_ESCALATE_HOURS,
  NUDGE_ESCALATE_MAX_HOURS,
} from '../jobs/watchers.js';
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

// Everything the MODEL may submit. `leave` joined 2026-08-22 (Phase 3): it means
// "I looked at this and I am waiting", takes a reason, and changes nothing.
// Without it the only way to say "deliberately nothing" was to omit the gap, and
// an omission is indistinguishable from never having looked at it.
//
// Adding a verb here means adding it to PLANNER_JUDGMENT_ACTIONS in watchers.ts
// too, or the sweep's fail-safe stops counting it as liveness and starts firing
// under a planner that is working. A test pins that pair.
export const PLANNER_ACTIONS = ['send', 'hold', 'close', 'escalate', 'extend', 'leave'] as const;
export type PlannerAction = (typeof PLANNER_ACTIONS)[number];

// CODE'S OWN verb, and deliberately NOT in PLANNER_ACTIONS: the model must never
// be able to submit it, because it is the record of the model having said
// NOTHING. If it were submittable, "I chose silence" and "silence was observed"
// would collapse into one value and the corpus would stop being able to tell
// them apart. validateDecisions refuses it by construction (it is not a known
// action), and a test pins that.
//
// It is also invisible to `recall_decisions` — a planner reading its own history
// wants the decisions, not the tick marks — while the per-tick read that feeds
// historyLine keeps them, because the COUNT is the whole point.
export const UNMENTIONED = 'unmentioned';

// How many decisions a single gap may accumulate before the tick-mark filler
// stops being appended to it. Real decisions are never capped.
//
// Normally unreachable: a gap cannot outlive its 18h delivery deadline or its
// 48h escalation ceiling, so at ~24 in-window ticks a day it collects a few
// dozen rows at most. The configuration that escapes that is NUDGES_MODE
// off/shadow with PLANNER_MODE live — the sweep stops closing gaps while the
// planner keeps running — and there the filler would grow forever.
export const UNMENTIONED_CAP = 200;

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
  // Diagnostic, for the log and for continual learning. NEVER shown to a
  // manager — it is written for refusals too, where it reads as machinery.
  reason: string;
  // Manager-facing copy, escalate only. Survives the rails or is dropped
  // whole; a bad note never blocks the handover.
  handoffNote?: string | null;
  // Technician-facing question, send only. Compose uses it in place of its own
  // model call; a dropped draft costs the draft, never the send.
  questionDraft?: string | null;
  // Machine-facing briefing for the manager's ASSISTANT, escalate only (the
  // fourth audience, fourth rail — plan 2026-08-23). Rides the review item's
  // detail and is pulled via list_pending_reviews; NEVER rendered to a human.
  // Dropped whole by its rail; a bad briefing never blocks the handover.
  agentContext?: string | null;
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
  lessons?: typeof renderLessonsBlock;
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

// "Thursday, Aug 13 at 12:00 AM" — byte-identical in shape to watchers.ts's
// wallClockLabel, so a planner-written note and the template that replaces it
// when there is none read as the same voice.
//
// `tz` is the firm's zone for a REAL-UTC instant (asked_at), and 'UTC' for a
// naive-local string that is already in the firm's clock (endsAtLocal, written
// that way by the watcher). Getting that backwards shifts every printed time,
// so the two call sites below name which they are passing.
function clockLabel(iso: string | null | undefined, tz: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    }).format(d);
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d);
    return `${day} at ${time}`;
  } catch {
    return null; // unknown zone — supply no label rather than a wrong one
  }
}

// "3 days ago" / "yesterday" / "5 hours ago". Code-computed for exactly the
// reason the labels are: this is arithmetic on a date.
function elapsedLabel(fromIso: string | null, nowMs: number): string | null {
  if (!fromIso) return null;
  const ms = nowMs - Date.parse(fromIso);
  if (Number.isNaN(ms) || ms < 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
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
export interface GapView {
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
  // The ONLY temporal strings a handoff note may contain, pre-rendered in the
  // firm's own clock. Dates are the one class of fact a language model is
  // measurably bad at (docs/engineering-memory.md, the date-eval arc), so they
  // stay code-owned even though the rest of the note is written by the model —
  // and because they are supplied as literals, "did it invent a date" is a
  // string check rather than a judgment.
  dateLabels: string[];
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
function historyLine(history: NudgeDecision[], nowMs: number, tz: string): string | null {
  if (history.length === 0) return null;
  // The last REAL action, scanning backwards — NOT history[length-1]. Since
  // Phase 3 an `unmentioned` tick mark is appended on nearly every tick, so the
  // final row is almost always filler and rendering it would tell the planner
  // "last: unmentioned" about a gap it escalated an hour ago. The filler is what
  // makes the COUNT meaningful; it is not what the model should be reminded of.
  let last: NudgeDecision | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].action !== UNMENTIONED) {
      last = history[i];
      break;
    }
  }
  // "considered", never "ticks" or "times seen": a row now means "this gap was
  // in a plan I was shown". Rows written before this phase under-count, so the
  // word has to be one the data can back either way.
  //
  // `watched since` comes from the FIRST row — the moment this gap entered the
  // planner's world — rendered in the firm's own clock, because every other
  // temporal string in this block is (the date-eval doctrine: the model never
  // converts a clock).
  const since = clockLabel(history[0].decided_at, tz);
  const head =
    `  watched since ${since ?? history[0].decided_at} — considered ${history.length}×`;
  // No real decision yet: the model has looked at this gap and never acted on
  // it. Say exactly that rather than inventing a `last:` out of filler.
  if (!last) return `${head}, no decision yet. Use recall_decisions for the detail.`;
  const mark =
    last.outcome === 'applied'
      ? ''
      : last.outcome === 'refused'
        ? ' — REFUSED'
        : ' — shadow, not applied';
  return (
    `${head}, last: ${last.action}${mark} ${hoursBetween(last.decided_at, nowMs)}h ago. ` +
    'Use recall_decisions for the detail.'
  );
}

// The evidence bound is CODE's, not the model's: only what landed after the ask,
// on that gap's job. A planner that could decide for itself what counted as
// evidence could mark a gap answered by something that predates the question.
// Exported for the planner-copy eval (plan 2026-08-22). The eval MUST render
// the real block: `src/eval/doctrine.ts` exists because measuring a copy of a
// prompt measures a paraphrase and reports the difference as a regression.
export function buildGapView(
  n: Nudge,
  nowMs: number,
  evidence: JobEvidenceRow[],
  sharesJob: boolean,
  jobsWithCostEvents: Set<string>,
  history: NudgeDecision[] = [],
  money: MoneyEvent[] = [],
  tz: string = 'UTC',
): GapView {
  const jobId = ctxStr(n, 'jobId');
  const askedAtMs = n.asked_at ? Date.parse(n.asked_at) : NaN;
  const relevant = Number.isNaN(askedAtMs)
    ? []
    : evidence
        .filter((e) => e.jobId === jobId && Date.parse(e.capture.captured_at) > askedAtMs)
        .slice(-EVIDENCE_PER_GAP);

  const evidenceText = relevant.map((e) => flat(e.capture.raw_text ?? '', EVIDENCE_TEXT_CHARS));

  // Spine-side attribution (plan 2026-08-22, Phase 1). No new read and no new
  // parameter: the stamp is a column on the Nudge this function already holds.
  // It says the spine matched this capture to THIS gap at record time, because
  // it was the only gap open for that person on that job — a fact code knows and
  // the model cannot infer from the words.
  const answeredBy = n.answered_by_capture_id;
  const attributedHere = !!answeredBy && relevant.some((e) => e.capture.id === answeredBy);

  // The temporal vocabulary a handoff note is allowed. asked_at is a REAL UTC
  // instant → the firm's zone; endsAtLocal was written naive-local by the
  // watcher → 'UTC' formats it as-is (see clockLabel's header).
  const askedLabel = clockLabel(n.asked_at, tz);
  const dueLabel = clockLabel(ctxStr(n, 'endsAtLocal'), 'UTC');
  const agoLabel = elapsedLabel(n.asked_at, nowMs);
  const dateLabels = [askedLabel, dueLabel, agoLabel].filter((v): v is string => !!v);

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
  // The deadline is stated for EVERY asked gap, not only a stamped one. It is
  // the clock `extend` has to beat, and on a first extend there is no stamp — so
  // printing only the stamp told the model the number exactly when it already
  // knew it and withheld it when it did not.
  if (!Number.isNaN(askedAtMs)) {
    lines.push(
      `  escalates automatically at: ${new Date(currentDeadlineMs(n, askedAtMs)).toISOString()}` +
        `${n.escalate_after ? '' : ' (the default — nothing has moved it)'}`,
    );
  }
  if (dateLabels.length > 0) {
    lines.push(
      '  dates you may use in a handover note, VERBATIM and only these:' +
        (askedLabel ? `\n    the ask went out: ${askedLabel}` : '') +
        (dueLabel ? `\n    the visit was due: ${dueLabel}` : '') +
        (agoLabel ? `\n    how long ago the ask went out: ${agoLabel}` : ''),
    );
  }
  const hist = historyLine(history, nowMs, tz);
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
      //
      // NARROWED by an attributed capture, never switched off (review finding):
      // the stamp ties exactly ONE note to this gap, and everything else in the
      // block — the other notes AND the shared money below — is still shared and
      // still unattributed. Dropping the whole warning on the strength of one
      // marked line would clear the guardrail off a sibling's note and let a
      // Phase-2 close cite words that answered somebody else's question.
      lines.push(
        attributedHere
          ? '  NOTE: this job has more than one open gap. The marked note is linked to THIS one; ' +
            'everything else below is SHARED between them, so make sure it answers THIS ' +
            'question, not the other one.'
          : '  NOTE: this job has more than one open gap, so everything below is SHARED between ' +
            'them. Make sure it answers THIS question, not the other one.',
      );
    }
    if (relevant.length === 0) {
      // "notes", not "nothing has landed": money may be printed directly below,
      // and a blanket nothing-landed claim would contradict it on the next line.
      lines.push('  notes since the ask: NO notes have landed on this job since the question went out');
    } else {
      lines.push('  evidence since the ask:');
      if (attributedHere) {
        // Say what the marker MEANS. An unexplained arrow is a machine artifact;
        // this states the fact behind it, in the same voice as THE RECORD line.
        lines.push(
          '    (the marked note was recorded by this person on this job while THIS was the only ' +
            'question open for them here, so the spine linked the two. That is WHO and WHEN, ' +
            'not WHAT: whether it actually answers the question is still yours to judge.)',
        );
      }
      relevant.forEach((e, i) => {
        lines.push(
          `    [${i + 1}] ${e.capture.captured_at} via ${e.capture.channel}` +
            `${e.capture.technician_ref ? ` (${e.capture.technician_ref})` : ''}` +
            `${e.capture.id === answeredBy ? '  <-- LINKED TO THIS GAP' : ''}: ${evidenceText[i]}`,
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
    dateLabels,
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

// The deadline a row is ACTUALLY on right now — the sweep's own rule, mirrored:
// a stamped escalate_after wins, and an UNPARSEABLE stamp falls back to the
// constant rather than being treated as stamped (watchers.ts, the fail-closed
// read). If the two disagreed, `extend` could report success while the sweep
// escalated on a different clock.
function currentDeadlineMs(n: Nudge, askedAtMs: number): number {
  const stamped = n.escalate_after ? Date.parse(n.escalate_after) : NaN;
  return Number.isNaN(stamped) ? askedAtMs + NUDGE_ESCALATE_HOURS * 3_600_000 : stamped;
}

/**
 * The code rails, applied to every decision before it can reach a writer. These
 * run in shadow too: a shadow run that reported an invalid plan as valid would
 * measure the wrong thing.
 */
// Anything that reads as a point in time. Deliberately broad: a false positive
// costs a note (the template takes over), a false negative puts a date the firm
// never stated in front of a manager, and the whole reason dates stayed
// code-owned is that this is the one thing the model is known to get wrong.
const TEMPORAL_RE = new RegExp(
  [
    '\\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\\b',
    '\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s*\\d{1,2}\\b',
    '\\b\\d{1,2}\\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\b',
    '\\b\\d{4}-\\d{2}-\\d{2}\\b',
    '\\b\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?\\b',
    '\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b',
    '\\b(?:today|tonight|yesterday|tomorrow|this morning|this afternoon)\\b',
    '\\b\\d+\\s*(?:minute|hour|day|week|month)s?\\b',
  ].join('|'),
  'gi',
);

/**
 * A handoff note the manager may safely read, or null.
 *
 * The note is written by the model and replaces a code-owned template wholesale
 * (user, 2026-08-22), so the only guarantee left is this one — and it is a
 * guarantee precisely because the labels were SUPPLIED as literals: "did it
 * invent a date" reduces to a substring check.
 *
 * Fail-soft on purpose. A rejected note is dropped and the template takes over;
 * it never blocks the escalation, because handing the gap to a person is the
 * point and the sentence is decoration.
 */
export function cleanHandoffNote(
  raw: unknown,
  dateLabels: string[],
): { note: string | null; why?: string } {
  const base = cleanPlannerText(raw, dateLabels, { label: 'handoff note', maxLen: 400 });
  return base;
}

/**
 * The briefing for the manager's ASSISTANT, or null. Same rail as the handoff
 * note — model-written, date-checked against the supplied labels — sized for a
 * briefing (ids and next steps; uuid hex never matches TEMPORAL_RE, so ids
 * pass the date rail untouched). Never shown to a human: the receiving agent
 * uses it, it does not quote it.
 */
export function cleanAgentContext(
  raw: unknown,
  dateLabels: string[],
): { note: string | null; why?: string } {
  return cleanPlannerText(raw, dateLabels, { label: 'agent context', maxLen: 700 });
}

/**
 * The shared shape of every string the planner writes for a HUMAN.
 *
 * One function because the date rule is the one guarantee that survived making
 * this copy model-written, and a second copy of it would drift from the first.
 * The label is threaded through so a refusal names which surface it came from —
 * "handoff note used a date it was not given" and "question used a date it was
 * not given" are different findings.
 */
function cleanPlannerText(
  raw: unknown,
  dateLabels: string[],
  opts: { label: string; maxLen: number },
): { note: string | null; why?: string } {
  if (raw === undefined || raw === null) return { note: null };
  if (typeof raw !== 'string') return { note: null, why: `${opts.label} was not a string` };
  const note = raw.replace(/\s+/g, ' ').trim();
  if (!note) return { note: null };
  if (note.length > opts.maxLen) {
    return { note: null, why: `${opts.label} over ${opts.maxLen} characters` };
  }
  if (/https?:\/\//i.test(note)) return { note: null, why: `${opts.label} contained a link` };
  const haystack = dateLabels.join(' | ').toLowerCase();
  for (const m of note.match(TEMPORAL_RE) ?? []) {
    if (!haystack.includes(m.toLowerCase())) {
      return { note: null, why: `${opts.label} used a date it was not given: "${m}"` };
    }
  }
  return { note };
}

/**
 * The technician-facing question, or null.
 *
 * Same date rail as the handoff note, and higher stakes: this reaches a person
 * OUTSIDE the office, in their own assistant's voice. The 500-char cap and the
 * footer-impersonation check mirror compose's own guards exactly
 * (`compose.ts:263-268`) — a planner-written question is not more trusted than
 * a compose-written one, only cheaper.
 */
export function cleanQuestionDraft(
  raw: unknown,
  dateLabels: string[],
): { note: string | null; why?: string } {
  const base = cleanPlannerText(raw, dateLabels, { label: 'question', maxLen: 500 });
  if (!base.note) return base;
  if (/note for the assistant/i.test(base.note)) {
    return { note: null, why: 'question tried to impersonate the assistant footer' };
  }
  return base;
}

export function validateDecisions(
  raw: unknown,
  views: Map<string, GapView>,
  nowMs: number = Date.now(),
  sweepLive: boolean = true,
): { decisions: PlannerDecision[]; dropped: DroppedDecision[]; noteDrops: string[] } {
  const decisions: PlannerDecision[] = [];
  const dropped: DroppedDecision[] = [];
  // Notes the rails rejected, surfaced on the return so the caller can log them
  // and an eval can count them. Separate from `dropped`, which means a whole
  // DECISION was refused — a rejected note refuses nothing.
  const noteDrops: string[] = [];
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
    // with `extend` on an asked row, or by leaving a PENDING one alone (where
    // not_before is what waits); it is `extend` that the prompt now names,
    // because leaving an asked gap alone does not stop its clock. Inventing a
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
                'now, so only close, escalate or extend mean anything. To give them more time, ' +
                'use extend — leaving the gap out of your plan does NOT stop its escalation ' +
                'clock.'
            : `${action} on a gap that is already composed and waiting to be delivered — there ` +
                'is nothing to release. Leave it out of your plan.',
        );
        continue;
      }
    }

    // `leave` GETS A STATUS RAIL TOO (final-review finding). On a PENDING row it
    // is a silent no-op with the opposite of its stated effect: it writes
    // nothing, so `not_before` stays null, and compose — which runs at the next
    // lifecycle step of the SAME tick and gates on `not_before` alone — sends the
    // question immediately. The model would have said "I am waiting" and caused
    // an ask, with `leave / applied` in the log. That is exactly the silent-no-op
    // class the send/hold rail above exists to make impossible.
    //
    // Queued and asked are both fine: nothing composes a queued row, and an asked
    // row has already gone out, so "I looked and I am waiting" is true of both.
    if (action === 'leave' && view.nudge.status === 'pending') {
      push(
        'leave on a gap that has NOT gone out yet — it would not hold anything, because a ' +
          'pending question is sent as soon as it is composed. Use hold (with a time) to wait, ' +
          'or send to release it now.',
      );
      continue;
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
      // open gap on a job, which is the shape that would actually happen.
      //
      // Spine-side attribution (plan 2026-08-22, Phase 1) narrows this but does
      // not retire it: a stamp exists only when exactly ONE question was open
      // for that person on that job, which is precisely NOT the case this rail
      // guards. Unstamped shared evidence is still unattributable.
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

    // `extend` — the only way to move a deadline OUTWARD. Before it existed the
    // planner's whole vocabulary for an already-asked gap was close, escalate
    // now, or leave alone; and leaving alone does not stop the 24h clock, which
    // runs on a sweep that ticks 288 times a day while the planner wakes at most
    // 24. So "give them more time" was a thing the prompt claimed and the code
    // could not do.
    let escalateAfter: string | null = null;
    if (action === 'extend') {
      const askedAtMs = view.nudge.asked_at ? Date.parse(view.nudge.asked_at) : NaN;
      // FIRST, and fail-closed. Every comparison below is against a number
      // derived from asked_at, and NaN makes both `>` and `<=` false — so an
      // unparseable asked_at would sail through every rail beneath this one and
      // land an UNBOUNDED extend.
      if (Number.isNaN(askedAtMs)) {
        push('extend on a gap with no usable ask time — there is no clock to move');
        continue;
      }
      if (view.nudge.status !== 'asked') {
        push(
          'extend on a gap that has not been asked yet — there is no silence to wait through, ' +
            'and an undelivered gap reaches the manager on its own deadline.',
        );
        continue;
      }
      const at = typeof d.escalateAfter === 'string' ? Date.parse(d.escalateAfter) : NaN;
      if (Number.isNaN(at)) {
        push('extend without a usable escalateAfter');
        continue;
      }
      // In the future, mirroring the hold rail. NOT redundant with the
      // later-than check below: a deadline that has ALREADY passed (the sweep
      // in shadow, or an escalate stamp not yet swept) makes "later than the
      // current deadline" satisfiable by an instant that is still in the past —
      // an extend that shortens, reported as applied.
      if (at <= nowMs) {
        push('extend to a moment that has already passed');
        continue;
      }
      const current = currentDeadlineMs(view.nudge, askedAtMs);
      if (at <= current) {
        push(
          `extend to ${new Date(at).toISOString()}, which is not LATER than the deadline this gap ` +
            `is already on (${new Date(current).toISOString()}) — that would either change ` +
            'nothing or escalate it sooner, wearing the wrong name for it.',
        );
        continue;
      }
      const ceiling = askedAtMs + NUDGE_ESCALATE_MAX_HOURS * 3_600_000;
      if (at > ceiling) {
        push(
          `extend past the ${NUDGE_ESCALATE_MAX_HOURS}h limit on how long a gap may wait ` +
            `(${new Date(ceiling).toISOString()}). A manager takes it from there.`,
        );
        continue;
      }
      escalateAfter = new Date(at).toISOString();
    }

    seen.add(nudgeId);
    // Escalate only. A note on any other action would never be read: nothing
    // else in the ladder puts a sentence in front of a manager.
    // Send only. A question on any other action would be written, stored and
    // never read — compose only ever looks at an applied `send`.
    let questionDraft: string | null = null;
    if (action === 'send') {
      const q = cleanQuestionDraft(d.question, view.dateLabels);
      questionDraft = q.note;
      if (q.why) noteDrops.push(`${nudgeId}: ${q.why}`);
    }
    let handoffNote: string | null = null;
    let agentContext: string | null = null;
    if (action === 'escalate') {
      const cleaned = cleanHandoffNote(d.handoffNote, view.dateLabels);
      handoffNote = cleaned.note;
      // Recorded as a NOTE on an applied decision, not a refusal: the escalate
      // itself is fine and is going ahead. Without this line a dropped note is
      // indistinguishable from one the model never wrote, and no eval could
      // ever measure how often the date rail fires.
      if (cleaned.why) noteDrops.push(`${nudgeId}: ${cleaned.why}`);
      // The briefing rides the same boundary: railed alone, dropped alone —
      // its loss never blocks the escalate or the manager's sentence.
      const briefing = cleanAgentContext(d.agentContext, view.dateLabels);
      agentContext = briefing.note;
      if (briefing.why) noteDrops.push(`${nudgeId}: ${briefing.why}`);
    }
    decisions.push({
      nudgeId,
      action: action as PlannerAction,
      ...(notBefore ? { notBefore } : {}),
      ...(escalateAfter ? { escalateAfter } : {}),
      ...(basis ? { basis } : {}),
      ...(citation ? { citation } : {}),
      ...(handoffNote ? { handoffNote } : {}),
      ...(agentContext ? { agentContext } : {}),
      ...(questionDraft ? { questionDraft } : {}),
      confidence,
      reason,
    });
  }
  return { decisions, dropped, noteDrops };
}

/**
 * The per-tick user message, byte for byte.
 *
 * Extracted from runPlanner so the eval can render EXACTLY what production
 * sends rather than a reconstruction of it (plan 2026-08-22). Both callers go
 * through here, and a test asserts runPlanner's recorded call equals this
 * function's output, so the two cannot drift apart silently.
 */
export function buildPlannerUserMessage(
  nowIso: string,
  tz: string,
  views: GapView[],
  lessonsBlock = '',
): string {
  return [
    `Right now it is ${firmClockLine(nowIso, tz)}.`,
    `In UTC that instant is ${nowIso} — use UTC for any notBefore you write.`,
    '',
    `This firm has ${views.length} open gap(s).`,
    '',
    views.map((v) => v.block).join('\n\n'),
    // ⑤ Phase 5: the firm's own distilled history, pushed (the briefing-probe
    // finding: pull-only content goes unread). Empty until a human activates
    // a lesson — zero cost until then. Bounded by LESSONS_BLOCK_BUDGET at
    // activation time.
    ...(lessonsBlock ? ['', "LESSONS (from this firm's own history):", lessonsBlock] : []),
  ].join('\n');
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
    case 'extend':
      // The mirror image of escalate: the same column, pushed OUT instead of
      // pulled in. Status-guarded identically, so a row that got answered
      // between the plan and the write refuses rather than silently moving.
      //
      // The explicit guard is not dead code being defensive. `?? null` here
      // would CLEAR the stamp — reverting the row to the 24h default — and then
      // report `applied`, which is the silent-no-op class these rails exist to
      // make impossible. validateDecisions cannot emit this today; the guard is
      // what keeps that true if it ever can.
      if (!d.escalateAfter) {
        return { outcome: 'refused', detail: 'extend carried no instant to move the deadline to' };
      }
      return done(
        await setSchedule(d.nudgeId, tenantId, { escalateAfter: d.escalateAfter }, ['asked']),
      );
    case 'leave':
      // Deliberately a no-op WRITE-side, and `applied` rather than some third
      // outcome: the planner really did decide this, and the decision really was
      // carried out — what it asked for was that nothing change. Recording it as
      // refused would make the corpus read as if a rail rejected it.
      //
      // It counts as liveness for the sweep's fail-safe (PLANNER_JUDGMENT_ACTIONS),
      // which is correct: a planner saying "I am waiting on this one" is awake
      // and has an opinion, and the fail-safe exists for a planner that is dead.
      return { outcome: 'applied' };
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
    // DECLARED OUTSIDE the try on purpose (plan 2026-08-22, Phase 3). The catch
    // below has to write one `unmentioned` row per gap the tick was ABOUT, and a
    // views map scoped to the try would be invisible there — leaving the tick
    // that failed as the one tick with no trace, which is precisely the tick
    // worth knowing about. Empty when the failure happened before the views were
    // built, which correctly records nothing.
    //
    // `const`, not `let`: it is MUTATED (`.set`) and never reassigned. It is still
    // per-tenant — the declaration is inside this loop body, not above it — so a
    // tenant never sees the previous one's views.
    const views = new Map<string, GapView>();
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
            tz,
          ),
        );
      }

      // GROUNDING, code-computed. The first live run reasoned "it is the middle
      // of the night" at 18:50 in the firm's own timezone, because it was handed
      // UTC and nothing else — and pacing is exactly a judgment about whether
      // this is a reasonable hour to bother somebody. Same doctrine as the tool
      // results' `now` rider and the weekday guard: the model is never the thing
      // that converts a clock.
      // A lessons-read failure must never cost the tick — the block is an
      // enhancement, the gaps are the job.
      let lessonsBlock = '';
      try {
        lessonsBlock = await (deps.lessons ?? renderLessonsBlock)(tenantId);
      } catch (err) {
        console.error(`[planner] tenant ${tenantId}: lessons read failed — running without`, err);
      }
      const user = buildPlannerUserMessage(nowIso, tz, [...views.values()], lessonsBlock);

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
            // A dropped note is not a refused decision, so it would otherwise
            // leave no trace anywhere — and "how often does the date rail fire"
            // is the number that says whether the model can be trusted with
            // this copy at all.
            for (const d of checked.noteDrops) {
              console.error(`[planner] ${tenantId} ${d}`);
            }
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
      // The light lesson-usage rail (⑤ Phase 5): a reason naming a bracketed
      // 8-hex id that is not an active lesson is LOGGED, never refused — the
      // stamp exists for measurement, and refusing would teach the model to
      // stop citing.
      const knownShortIds = new Set(
        [...lessonsBlock.matchAll(/\[([0-9a-f]{8})\]/g)].map((m) => m[1]),
      );
      for (const d of decisions) {
        for (const m of d.reason.matchAll(/\[([0-9a-f]{8})\]/g)) {
          if (!knownShortIds.has(m[1])) {
            console.error(
              `[planner] tenant ${tenantId}: decision on ${d.nudgeId} cites unknown lesson [${m[1]}]`,
            );
          }
        }
      }
      const records: NudgeDecisionInput[] = [];
      let cappedWarned = false; // one line per tenant per tick, not one per gap
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
          escalateAfter: d.escalateAfter ?? null,
          basis: d.basis ?? null,
          citation: d.citation ?? null,
          confidence: d.confidence,
          reason: d.reason,
          handoffNote: d.handoffNote ?? null,
          agentContext: d.agentContext ?? null,
          questionDraft: d.questionDraft ?? null,
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

      // THE THIRD SOURCE: every gap that was in the view and in NEITHER list.
      //
      // This is the phase's whole point. Before it, a tick where the model
      // mentioned two of five gaps wrote two rows, and a tick where it mentioned
      // none wrote zero — so "considered 40 times and left alone" and "never
      // seen" were the same empty history, and the planner had no way to know it
      // had been here before. `unmentioned` is silence, RECORDED.
      //
      // Distinguishable from `leave` by design: `leave` carries the model's own
      // reason and is a decision it made; this carries none and is an observation
      // code made. Both say "nothing changed"; only one says anybody thought
      // about it.
      // Built from the rows ACTUALLY PUSHED, not from `decisions`/`dropped`.
      // Those two lists are not the same thing as "a row was written": the
      // dropped loop deliberately skips entries whose action is not a known verb
      // (a malformed submission is a parse failure, not a decision). Keying off
      // `dropped` therefore marked such a gap as spoken for while recording
      // nothing for it — leaving it with NO row at all, which is precisely the
      // hole this phase exists to close. Caught by the test that submits
      // `unmentioned` as if it were a verb.
      const spokenFor = new Set(records.map((r) => r.nudgeId));
      for (const [nudgeId, view] of views) {
        if (spokenFor.has(nudgeId)) continue;
        // GROWTH CAP. Rows accrue per open gap per in-window tick (~24/day),
        // normally bounded by the gap's own lifetime (18h delivery deadline, 48h
        // absolute escalation ceiling). One configuration escapes that bound:
        // NUDGES_MODE off/shadow with PLANNER_MODE live, where the sweep does not
        // close gaps but the planner still runs (deliberately — see
        // lifecycle.ts). Filler must not grow without limit there.
        //
        // The cap deliberately does NOT stop `leave`, `close` or any real
        // decision — only the tick marks. A gap this old is a stuck ladder
        // showing through, and that is the bug to fix, not this write.
        if (view.history.length >= UNMENTIONED_CAP) {
          if (!cappedWarned) {
            cappedWarned = true;
            console.error(
              `[planner] tenant ${tenantId}: gap ${nudgeId} has ${view.history.length} decisions — ` +
                `no longer appending '${UNMENTIONED}' filler past ${UNMENTIONED_CAP}. A gap this ` +
                'old means the ladder is not closing it; fix that, not this cap.',
            );
          }
          continue;
        }
        records.push({
          tenantId,
          nudgeId,
          jobId: view.jobId ?? null,
          mode,
          action: UNMENTIONED,
          confidence: 'low',
          reason: '',
          outcome: mode === 'live' ? 'applied' : 'shadow',
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
      // …but it no longer leaves NO TRACE. This catch sits after runLoop, so a
      // ToolLoopLimitError or a provider outage used to write nothing at all —
      // making the failed tick indistinguishable from a tick that never ran, in
      // exactly the history the planner reads to orient itself. Without this the
      // phase's own goal fails in the one case most worth knowing about.
      //
      // `refused`, never `applied`: nothing was carried out, and the outcome
      // column has to stay honest about that. It therefore does NOT count as
      // liveness for the sweep's fail-safe, which is correct — a planner that
      // cannot complete a tick IS the outage the fail-safe exists for.
      const why = err instanceof Error ? err.message : String(err);
      if (views.size > 0) {
        try {
          await recordDecisions(
            [...views].map(([nudgeId, view]) => ({
              tenantId,
              nudgeId,
              jobId: view.jobId ?? null,
              mode,
              action: UNMENTIONED,
              confidence: 'low' as const,
              reason: '',
              outcome: 'refused' as const,
              outcomeDetail: flat(`tick failed: ${why}`, 300),
            })),
          );
        } catch (recErr) {
          // Loud, and never allowed to replace the real error below.
          console.error(`[planner] tenant ${tenantId}: could not record the failed tick`, recErr);
        }
      }
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
