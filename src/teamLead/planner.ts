import {
  getTenant,
  listJobEvidenceSince,
  listNudgesByStatus,
  listTenantIdsWithTelegramBindings,
  OPEN_NUDGE_STATUSES,
  type JobEvidenceRow,
  type Nudge,
} from '../db/index.js';
import { runToolLoop } from '../model/toolLoop.js';
import type { ForcedToolSpec } from '../model/forcedTool.js';
import { NUDGE_KIND_SPECS, specFor, type NudgeKindSpec } from '../jobs/nudgeKinds.js';
import { insideAskWindow } from './compose.js';
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
}

export interface PlannerTenantPlan {
  tenantId: string;
  gaps: number;
  decisions: PlannerDecision[];
  dropped: DroppedDecision[];
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
  applied: number; // Phase 4 — always 0 in shadow
  tenantErrors: number;
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
  runLoop?: typeof runToolLoop;
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
  block: string;
}

// The evidence bound is CODE's, not the model's: only what landed after the ask,
// on that gap's job. A planner that could decide for itself what counted as
// evidence could mark a gap answered by something that predates the question.
function buildGapView(n: Nudge, nowMs: number, evidence: JobEvidenceRow[]): GapView {
  const jobId = ctxStr(n, 'jobId');
  const askedAtMs = n.asked_at ? Date.parse(n.asked_at) : NaN;
  const relevant = Number.isNaN(askedAtMs)
    ? []
    : evidence
        .filter((e) => e.jobId === jobId && Date.parse(e.capture.captured_at) > askedAtMs)
        .slice(-EVIDENCE_PER_GAP);

  const evidenceText = relevant.map((e) => flat(e.capture.raw_text ?? '', EVIDENCE_TEXT_CHARS));
  const lines = [
    `gap ${n.id}`,
    `  kind: ${n.kind}`,
    `  about: ${ctxStr(n, 'jobTitle') ?? 'a job'} for ${ctxStr(n, 'customerName') ?? 'unknown customer'}`,
    `  person: ${ctxStr(n, 'technicianName') ?? 'unknown'}`,
    `  state: ${n.status}`,
    `  noticed: ${hoursBetween(n.created_at, nowMs)}h ago`,
  ];
  if (n.asked_at) lines.push(`  asked: ${hoursBetween(n.asked_at, nowMs)}h ago`);
  else lines.push('  asked: not yet');
  if (n.question) lines.push(`  the question asked: ${flat(n.question, 400)}`);
  if (n.not_before) lines.push(`  currently held until: ${n.not_before}`);
  if (n.escalate_after) lines.push(`  currently escalates at: ${n.escalate_after}`);
  if (!n.asked_at) {
    lines.push('  evidence since the ask: (nothing was asked yet, so there is none)');
  } else if (relevant.length === 0) {
    lines.push('  evidence since the ask: NOTHING has landed on this job since the question went out');
  } else {
    lines.push('  evidence since the ask:');
    relevant.forEach((e, i) => {
      lines.push(
        `    [${i + 1}] ${e.capture.captured_at} via ${e.capture.channel}` +
          `${e.capture.technician_ref ? ` (${e.capture.technician_ref})` : ''}: ${evidenceText[i]}`,
      );
    });
  }
  return { nudge: n, jobId, evidenceText, block: lines.join('\n') };
}

// Normalised for the citation check ONLY — a model that changes spacing or case
// is quoting; a model that changes words is not.
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The code rails, applied to every decision before it can reach a writer. These
 * run in shadow too: a shadow run that reported an invalid plan as valid would
 * measure the wrong thing.
 */
export function validateDecisions(
  raw: unknown,
  views: Map<string, GapView>,
): { decisions: PlannerDecision[]; dropped: DroppedDecision[] } {
  const decisions: PlannerDecision[] = [];
  const dropped: DroppedDecision[] = [];
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
    const push = (why: string) => dropped.push({ nudgeId, action, why });

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

    // ASSERT-ONLY-CITED, in code. The prompt asks for a verbatim quote; this is
    // what makes it true. A close whose quote is absent from what we actually
    // SHOWED the model is refused — ambiguity defaults to open, because a
    // false-open is loud and cheap and a false-close is silent.
    let citation: string | null = null;
    if (action === 'close') {
      const quote = typeof d.citation === 'string' ? d.citation.trim() : '';
      if (quote.length === 0) {
        push('close without a citation');
        continue;
      }
      const shown = view.evidenceText.map(norm);
      if (!shown.some((text) => text.includes(norm(quote)))) {
        push('close whose citation does not appear in the evidence');
        continue;
      }
      citation = quote;
    }

    let notBefore: string | null = null;
    if (action === 'hold') {
      const at = typeof d.notBefore === 'string' ? Date.parse(d.notBefore) : NaN;
      if (Number.isNaN(at)) {
        push('hold without a usable notBefore');
        continue;
      }
      notBefore = new Date(at).toISOString();
    }

    const confidence =
      d.confidence === 'low' || d.confidence === 'medium' || d.confidence === 'high'
        ? d.confidence
        : 'low'; // unreadable confidence is not high confidence
    seen.add(nudgeId);
    decisions.push({
      nudgeId,
      action: action as PlannerAction,
      ...(notBefore ? { notBefore } : {}),
      ...(citation ? { citation } : {}),
      confidence,
      reason: typeof d.reason === 'string' ? flat(d.reason, 300) : '',
    });
  }
  return { decisions, dropped };
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
  const runLoop = deps.runLoop ?? runToolLoop;
  const specs = deps.specs ?? NUDGE_KIND_SPECS;
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
    tenantErrors: 0,
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
      const evidence =
        askedAt.length > 0 && jobIds.length > 0
          ? await listEvidence(tenantId, jobIds, new Date(Math.min(...askedAt)).toISOString())
          : [];

      const views = new Map<string, GapView>();
      for (const n of open) views.set(n.id, buildGapView(n, nowMs, evidence));

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
      let submitted: unknown;
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
            submitted = args;
            return { status: 'ok', received: true };
          }
          if (!execute) throw new Error(`no executor for '${name}'`);
          return execute(tenantId, name, args);
        },
        { tenantId, technicianRef: TEAM_LEAD_REF },
      );

      const { decisions, dropped } = validateDecisions(submitted, views);
      summary.planned += 1;
      summary.decisions += decisions.length;
      summary.dropped += dropped.length;
      for (const d of decisions) summary.byAction[d.action] = (summary.byAction[d.action] ?? 0) + 1;
      summary.plans.push({
        tenantId,
        gaps: open.length,
        decisions,
        dropped,
        turns: result.turns,
        toolCalls: result.calls.length,
        ms: Date.now() - started,
      });

      // SHADOW WRITES NOTHING — not a nudge, not a schedule, not a resolution.
      // The plan is logged and that is all, which is what makes the cost and the
      // judgment measurable before anything depends on either.
      if (mode === 'shadow') {
        console.log(
          `[planner:shadow] tenant ${tenantId}: ${open.length} gaps → ` +
            `${decisions.length} decisions (${dropped.length} refused), ` +
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
      console.error(`[planner] tenant ${tenantId} failed`, err);
    }
  }
  return summary;
}
