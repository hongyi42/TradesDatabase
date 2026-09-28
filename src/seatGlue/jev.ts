import { defaultFetch, type FetchLike } from './http.js';

// Jev (TypeSafe's calibrated classifier, typesafe/jev-1.13 through OpenRouter's
// decisions endpoint) answers three yes/no questions for a manager seat (step 2a
// phase 4; operator 2026-09-23: "plan mode ON, chosen by Jev"; 2026-09-24):
//
//   needsPlan     — should this message get a plan the manager approves first?
//   approvesPlan  — does a TYPED reply to a plan approve it as it stands?
//   answersPrompt — does a reply while a question waits answer it, or start something new?
//
// Measured before it was built (thoughts/shared/research/2026-09-23-plan-mode-
// and-jev-tool-search-tests.md): 48/48 right and stable on 12 manager messages,
// ~0.4 s, ~$0.00002 a call. The needsPlan wording below IS the measured one
// (scripts/seat-eval/plan-mode/test2.mjs) — reword it and the number is void.
//
// NEVER BLOCKS A REPLY: a timeout (3 s) or any error answers the safe default
// (no plan / not approved), and the caller logs it.

export const JEV_MODEL = 'typesafe/jev-1.13';
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const JEV_TIMEOUT_MS = 3_000;

export const PLAN_Q =
  'A trades business manager texted their AI assistant this message. Should the assistant show the manager a plan and wait for a go-ahead before acting?';
export const PLAN_CRITERIA = {
  true: 'A multi-step job: several actions, bulk work, building files such as invoices or spreadsheets, or sending things to customers or others outside the firm as part of a bigger job, and the manager did not say to skip planning.',
  false: 'A quick question, a single simple action such as recording one note, small talk, or the manager explicitly said to just do it now without a plan.',
};

export const APPROVE_Q =
  'The AI assistant showed a trades business manager a plan and asked them to tap Go or Change. Instead they typed a reply. Is the reply approving the plan exactly as it stands?';
export const APPROVE_CRITERIA = {
  true: 'The reply approves going ahead as planned (yes, go, do it, sounds good, ok, go ahead) and asks for no change.',
  false: 'The reply asks for any change, adds a condition, asks a question, says no, or says to wait.',
};

export interface JevOptions {
  openrouterKey: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

async function noul(opts: JevOptions, state: Record<string, unknown>, instructions: string, criteria: Record<string, string>): Promise<number | null> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const res = await fetchFn(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.openrouterKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: JEV_MODEL, state, questions: { q: { type: 'noul', instructions, criteria } } }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? JEV_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`jev: HTTP ${res.status}`);
  const body = (await res.json()) as { answers?: { q?: { noul?: unknown } } };
  const p = body?.answers?.q?.noul;
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
}

/**
 * How sure Jev must be before a message gets a plan (operator 2026-09-28: the
 * bot planned "even for seemingly easy tasks" at 0.5 — only a confident call
 * plans now). The 48/48 measurement was taken at 0.5.
 */
export const PLAN_THRESHOLD = 0.8;

/** Should this manager message get a plan first? Only at p ≥ PLAN_THRESHOLD. Failure → no plan. */
export async function needsPlan(
  opts: JevOptions,
  message: string,
  previous?: { user: string; assistant: string } | null,
): Promise<{ plan: boolean; p: number | null }> {
  try {
    const p = await noul(opts, { message, ...(previous ? { previous } : {}) }, PLAN_Q, PLAN_CRITERIA);
    return { plan: p !== null && p >= PLAN_THRESHOLD, p };
  } catch (err) {
    opts.log?.(`jev needsPlan failed (${err instanceof Error ? err.message : String(err)}) — no plan`);
    return { plan: false, p: null };
  }
}

/** Does a typed reply approve the plan as it stands? Threshold 0.6 (sure, or it goes back as a change). Failure → not approved. */
export async function approvesPlan(opts: JevOptions, reply: string, planSummary: string): Promise<boolean> {
  try {
    const p = await noul(opts, { plan: planSummary, reply }, APPROVE_Q, APPROVE_CRITERIA);
    return p !== null && p >= 0.6;
  } catch (err) {
    opts.log?.(`jev approvesPlan failed (${err instanceof Error ? err.message : String(err)}) — treated as a change request`);
    return false;
  }
}

export const ANSWER_Q =
  'An AI assistant asked a trades business manager a question and is waiting for the answer. Then the manager sent this message. Is the message an answer to that question?';
export const ANSWER_CRITERIA = {
  true: 'It answers the question: it picks or names one of the options, says yes or no, gives the detail that was asked for, or corrects the question (even a short reply like "the second one", "Furnace", "yes", "not that one").',
  false: 'It is a new, unrelated request or topic that does not respond to the question at all (for example asking for something else to be done).',
};

/**
 * A typed or spoken reply while a question or plan waits (operator 2026-09-24:
 * "just put jev in then"): does it answer the waiting prompt, or is it a NEW
 * request that should start its own turn — with its own plan check? Threshold
 * 0.5. Failure → it counts as the answer (the behaviour before this check).
 */
export async function answersPrompt(opts: JevOptions, reply: string, question: string, choices: string[]): Promise<boolean> {
  try {
    const p = await noul(opts, { question, ...(choices.length ? { options: choices } : {}), reply }, ANSWER_Q, ANSWER_CRITERIA);
    return p === null || p >= 0.5;
  } catch (err) {
    opts.log?.(`jev answersPrompt failed (${err instanceof Error ? err.message : String(err)}) — treated as the answer`);
    return true;
  }
}
