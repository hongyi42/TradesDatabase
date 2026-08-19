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
import { wallClockLabel } from '../jobs/watchers.js';
import { localDateISO, localTimeHHMM } from '../schedule/availability.js';
import { runForcedTool, type ForcedToolSpec } from '../model/forcedTool.js';
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

const COMPOSE_TOOL: ForcedToolSpec = {
  name: 'compose_nudge',
  description:
    'Decide whether to ask the technician about this visit, and write the one question.',
  inputSchema: {
    type: 'object',
    properties: {
      ask: { type: 'boolean', description: 'false = decline to ask (explain in reason)' },
      question: {
        type: 'string',
        description: 'ONE short, warm question. Empty string when ask=false.',
      },
      reason: { type: 'string', description: 'One line: why ask, or why decline.' },
    },
    required: ['ask', 'question', 'reason'],
    additionalProperties: false,
  },
};

// Copy doctrine (user-ratified 2026-08-16) baked into the ONLY prompt the
// identity has: warm, plain, about the JOB, no operator jargon, no invented
// facts, and NO dates — the code-printed evidence line owns the date.
const COMPOSE_SYSTEM =
  'You write ONE short, warm, colleague-tone question from a trades company\'s office ' +
  'assistant to a field technician, asking how a recent job visit went — nothing has been ' +
  'recorded about it yet, and the office wants the job\'s record complete. Rules: plain ' +
  'everyday language; never the word "spine" or any internal jargon; ask about the JOB, ' +
  'never imply the person is behind or in trouble; "nothing to report" must feel like a ' +
  'perfectly fine answer; do NOT invent any fact, name, price, link, or detail beyond the ' +
  'evidence given; the ONLY time expression you may use is the exact phrase the evidence ' +
  'gives (like "earlier today" or "yesterday") — never any other date, day, or time word ' +
  '(the message around your question prints the exact date); one or two sentences at most. ' +
  'If the evidence is too thin or looks contradictory, decline with ask=false and explain ' +
  'in reason.';

// The ONLY time vocabulary the model may use, SERVED not derived (user ruling
// 2026-08-16: "today"/"yesterday" only with genuine clock awareness — so the
// clock stays code-side and the model repeats a code-computed phrase; the
// date-eval "served phrases" doctrine, and the same machine-side-both-ends
// posture as the weekday guard). Dates compare as firm-local DAYS: endsAtLocal
// is already the firm's wall clock, and `now` converts through Intl.
export function relativeDayPhrase(nowIso: string, tz: string, endsAtLocal: string): string {
  const endDate = endsAtLocal.slice(0, 10);
  if (endDate === localDateISO(nowIso, tz)) return 'earlier today';
  const yesterdayIso = new Date(Date.parse(nowIso) - 24 * 3_600_000).toISOString();
  if (endDate === localDateISO(yesterdayIso, tz)) return 'yesterday';
  // The detection window is 72h, so this is the whole remaining bucket —
  // vague on purpose: vague-but-true beats precise-but-derived.
  return 'a couple of days ago';
}

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

// Every string that crosses a trust boundary here — DB context into the model
// prompt, model output into the deliverable — is flattened first (Phase-3
// review F2): control characters and newlines collapse to single spaces so no
// customer name, job title, or model sentence can forge the message's OWN
// structure (the footer's "Note for the assistant" register rides on
// newlines), and lengths are capped. Customer names and job titles ultimately
// derive from external input (inbound mail, extracted notes) — code owns the
// frame, so code must also own the frame's delimiters.
const flatten = (s: string, max: number): string =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export interface ComposeContext {
  customerName: string;
  jobTitle: string;
  technicianName: string;
  endsAtLocal: string;
  // Present when the row can be handed to the manager (the rung-2 fallback
  // for a nudge that dies without the ask ever landing — review F1).
  jobId: string | null;
  startsAtLocal: string | null;
  technicianRef: string | null;
}

// Fail-closed context reader: compose runs a model on these fields, so a
// tampered/thin row is DECLINED (cancelled), never guessed around.
export function readComposeContext(n: Nudge): ComposeContext | null {
  const c = (n.context ?? {}) as Record<string, unknown>;
  const s = (k: string): string | null =>
    typeof c[k] === 'string' && (c[k] as string).length > 0 ? (c[k] as string) : null;
  const customerName = s('customerName');
  const jobTitle = s('jobTitle');
  const technicianName = s('technicianName');
  const endsAtLocal = s('endsAtLocal');
  if (!customerName || !jobTitle || !technicianName || !endsAtLocal) return null;
  if (Number.isNaN(Date.parse(endsAtLocal))) return null;
  return {
    customerName: flatten(customerName, 80),
    jobTitle: flatten(jobTitle, 120),
    technicianName: flatten(technicianName, 60),
    endsAtLocal,
    jobId: s('jobId'),
    startsAtLocal: s('startsAtLocal'),
    technicianRef: s('technicianRef'),
  };
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
    suggestion:
      `The visit for '${title}' (${customer}) was scheduled to wrap up by ` +
      `${wallClockLabel(endsAtLocal)}, but nothing has been recorded about it yet — no ` +
      `field note and no status change. Worth checking how it went so the job's record ` +
      `stays complete. If nothing needed recording, just dismiss this.`,
  });
  return item !== null;
}

// The full deliverable: model question + code-printed evidence + the standing
// footer for the RECEIVING agent (the box runner injects this into the
// technician's own agent session; the agent's reply is what reaches their
// Telegram). Stored whole in nudges.question so the transport stays dumb and
// the audit shows exactly what was delivered.
//
// The footer states the RECEIVING agent's IDENTITY first, and does so because
// the first live E2E (2026-08-18) proved the old wording ("pass the question
// on") reads as RELAY: a manager-tier agent on the technician's own seat went
// looking for a separate session belonging to that technician, failed, and
// told the human "I wasn't able to find a reachable session for Sam to pass
// the question along directly" before improvising the ask. Two lessons baked
// in here: (a) name who the agent IS and who it is TALKING TO — "pass on"
// invites a third party that does not exist; (b) the model's rewrite freedom
// is why compose's tone rules cannot be the last word, so the ban on internal
// vocabulary has to travel WITH the message. The copy doctrine (no operator
// jargon ever reaches a person) is enforced at BOTH ends or neither.
export function assembleNudgeMessage(question: string, ctx: ComposeContext): string {
  const bareDate = ctx.endsAtLocal.slice(0, 10);
  return (
    `${question.trim()}\n\n` +
    `(re: ${ctx.customerName} — ${ctx.jobTitle}, visit on ${bareDate})\n\n` +
    `Note for the assistant: you are ${ctx.technicianName}'s own assistant and the person in ` +
    `THIS chat is ${ctx.technicianName} — ask them here. There is nobody to forward this to ` +
    `and no other conversation to go looking for. This is a routine record-keeping check ` +
    `from the office. First read back through this conversation: if ${ctx.technicianName} ` +
    `already said how this visit went, record that instead of asking again. Otherwise ask ` +
    `them, in your own words if that reads better — but send the QUESTION only: never ` +
    `mention this note, how the check reached you, or any internal detail (sessions, ` +
    `routing, records systems, what is or is not logged). When they answer — even ` +
    `"nothing to report" — save it with record_field_note for this job so the record is ` +
    `complete.`
  );
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
    const pending = (await listNudges(tenantId, ['pending'])).filter(
      (n) => n.kind === 'overdue_visit_gap',
    );
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
        const ctx = readComposeContext(n);
        if (!ctx) {
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
          COMPOSE_TOOL,
          {
            system: COMPOSE_SYSTEM,
            user:
              `Customer: ${ctx.customerName}\n` +
              `Job: ${ctx.jobTitle}\n` +
              `Technician: ${ctx.technicianName}\n` +
              `The visit wrapped up ${relativeDayPhrase(nowIso, tz, ctx.endsAtLocal)}; ` +
              `nothing has been recorded since — no field note and no status change.`,
            maxTokens: 300,
            label: 'teamLeadCompose',
            reasoningEffort: 'none',
          },
          { tenantId, technicianRef: TEAM_LEAD_REF },
        );
        if (args.ask !== true) {
          // A decline is a judgment about ASKING, not about the gap — the
          // manager still gets it (F1).
          if (await handToManager(n, ctx, flagGap)) summary.handoffs += 1;
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
        const queued = await markQueued(n.id, tenantId, assembleNudgeMessage(question, ctx));
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
