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
