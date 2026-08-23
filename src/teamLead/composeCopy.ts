import { localDateISO } from '../schedule/availability.js';
import type { ForcedToolSpec } from '../model/forcedTool.js';
import type { Nudge } from '../db/nudges.js';

// The COPY and the prompt machinery for the team-lead's questions (plan
// 2026-08-19, Phase 2). Split out of compose.ts for one structural reason: the
// kind registry (jobs/nudgeKinds.ts) needs the prompt text, and compose.ts
// imports the registry back. Reading a `const` out of a half-evaluated
// compose.ts would throw at module-init (temporal dead zone) on any import of
// compose.js — so the text lives HERE, which imports neither of them.
//
// Everything below moved verbatim; the wording is user-ratified and a human
// reads it. Change it only deliberately.

export const COMPOSE_TOOL: ForcedToolSpec = {
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
export const COMPOSE_SYSTEM =
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
// Every string that crosses a trust boundary here — DB context into the model
// prompt, model output into the deliverable — is flattened first (Phase-3
// review F2): control characters and newlines collapse to single spaces so no
// customer name, job title, or model sentence can forge the message's OWN
// structure (the footer's "Note for the assistant" register rides on
// newlines), and lengths are capped. Customer names and job titles ultimately
// derive from external input (inbound mail, extracted notes) — code owns the
// frame, so code must also own the frame's delimiters.
export const flatten = (s: string, max: number): string =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

// The RETIRED footer's seam (④b Phase 5, 2026-08-23): assemble no longer
// writes a footer — stored is shown — but the outbox (control/nudgeQueue.ts)
// still strips on exactly this string so LEGACY queued rows, composed before
// the retirement deploy, serve clean. Compose's guard and cleanQuestionDraft
// still refuse model text containing the phrase (the register stays
// code-owned even though code no longer uses it), and `flatten` still
// collapses newlines in every embedded field, so the delimiter can never
// occur in a post-retirement deliverable at all.
export const FOOTER_DELIMITER = '\n\nNote for the assistant:';

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

// The full deliverable: model question + code-printed evidence line. Stored
// whole in nudges.question so the transport stays dumb and the audit shows
// exactly what was delivered — and since ④b Phase 5 (2026-08-23), what is
// stored IS what the person sees: runner v2 sends this text verbatim with
// `openclaw message send`, no agent turn on the delivery leg.
//
// The agent-facing FOOTER that used to follow the evidence line is RETIRED.
// Its duties moved to standing doctrine (bootstrap-box.sh §0k "Questions and
// items from the office": record the answer with record_field_note; never
// surface internal detail). Preserve its hard-won lesson for any future
// message that DOES address an agent: state the receiving agent's IDENTITY
// first — the 2026-08-18 live E2E proved "pass the question on" reads as
// RELAY (the agent went hunting for a session that does not exist and told
// the human about the failure); name who the agent IS and who it is TALKING
// TO, and make the no-jargon ban travel WITH the message.
export function assembleNudgeMessage(question: string, ctx: ComposeContext): string {
  const bareDate = ctx.endsAtLocal.slice(0, 10);
  return (
    `${question.trim()}\n\n` +
    `(re: ${ctx.customerName} — ${ctx.jobTitle}, visit on ${bareDate})`
  );
}

// ── Detector #2: job cost (plan 2026-08-19, Phase 4) ────────────────────────
//
// Same doctrine as the visit question: warm, about the JOB, no operator jargon,
// and "nothing to report" must feel fine. Two rules are specific to money and
// both matter — the technician is NOT asked to total anything up (they are
// standing in a van, not doing bookkeeping), and the ban on inventing prices
// stays exactly as it is: a price the model makes up would become a number the
// firm reasons about.
export const COST_COMPOSE_SYSTEM =
  'You write ONE short, warm, colleague-tone question from a trades company\'s office ' +
  'assistant to a field technician, asking what a finished job cost in PARTS AND MATERIALS — ' +
  'nothing has been recorded about its cost yet, and the office needs it for the job\'s ' +
  'record. Rules: plain everyday language; never the word "spine" or any internal jargon; ask ' +
  'about the JOB, never imply the person overspent or is in trouble; "nothing — no parts" must ' +
  'feel like a perfectly fine answer; ask only what THEY paid or picked up, never ask them to ' +
  'add anything up or work out a total; do NOT invent any fact, name, price, link, or detail ' +
  'beyond the evidence given, and never suggest an amount yourself; use NO dates or day words ' +
  'at all; one or two sentences at most. If the evidence is too thin or looks contradictory, ' +
  'decline with ask=false and explain in reason.';

export const COST_COMPOSE_TOOL: ForcedToolSpec = {
  name: 'compose_cost_nudge',
  description: 'Decide whether to ask the technician what this job cost, and write the one question.',
  inputSchema: {
    type: 'object',
    properties: {
      ask: { type: 'boolean', description: 'false = decline to ask (explain in reason)' },
      question: {
        type: 'string',
        description: 'ONE short, warm question about parts/materials cost. Empty when ask=false.',
      },
      reason: { type: 'string', description: 'One line: why ask, or why decline.' },
    },
    required: ['ask', 'question', 'reason'],
    additionalProperties: false,
  },
};

export interface CostComposeContext {
  customerName: string;
  jobTitle: string;
  technicianName: string;
  jobId: string;
}

// Fail-closed, like readComposeContext: a thin or tampered row is declined and
// handed to the manager, never guessed around. NOTE there is no endsAtLocal —
// a cost question is about the JOB, not a visit, which is exactly why this kind
// needs its own context type rather than widening ComposeContext.
export function readCostComposeContext(n: Nudge): CostComposeContext | null {
  const c = (n.context ?? {}) as Record<string, unknown>;
  const s = (k: string): string | null =>
    typeof c[k] === 'string' && (c[k] as string).length > 0 ? (c[k] as string) : null;
  const customerName = s('customerName');
  const jobTitle = s('jobTitle');
  const technicianName = s('technicianName');
  const jobId = s('jobId');
  if (!customerName || !jobTitle || !technicianName || !jobId) return null;
  return {
    customerName: flatten(customerName, 80),
    jobTitle: flatten(jobTitle, 120),
    technicianName: flatten(technicianName, 60),
    jobId,
  };
}

// The cost deliverable — footer retired like the visit one (④b Phase 5).
// The money-specific duty its footer carried lives in doctrine now: the
// technician's agent CANNOT write money (record_money_event is manager-only),
// so the answer lands as a record_field_note on the job and a manager turns
// it into a ledger entry.
export function assembleCostNudgeMessage(question: string, ctx: CostComposeContext): string {
  return (
    `${question.trim()}\n\n` +
    `(re: ${ctx.customerName} — ${ctx.jobTitle})`
  );
}
