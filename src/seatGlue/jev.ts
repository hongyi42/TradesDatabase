import { defaultFetch, type FetchLike } from './http.js';

// Jev (TypeSafe's calibrated classifier, typesafe/jev-1.13 through OpenRouter's
// decisions endpoint) answers two yes/no questions for a manager seat (step 2a
// phase 4; operator 2026-09-23: "plan mode ON, chosen by Jev"):
//
//   needsPlan    — should this message get a plan the manager approves first?
//   approvesPlan — does a TYPED reply to a plan approve it as it stands?
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

/** Should this manager message get a plan first? Threshold 0.5 (measured). Failure → no plan. */
export async function needsPlan(
  opts: JevOptions,
  message: string,
  previous?: { user: string; assistant: string } | null,
): Promise<{ plan: boolean; p: number | null }> {
  try {
    const p = await noul(opts, { message, ...(previous ? { previous } : {}) }, PLAN_Q, PLAN_CRITERIA);
    return { plan: p !== null && p >= 0.5, p };
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
