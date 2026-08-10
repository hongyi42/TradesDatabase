import { runForcedTool, type ForcedToolSpec } from '../model/forcedTool.js';
import type { CostContext } from '../db/index.js';

// The inbound-call intent ROUTER. The phone line forwards to a receptionist with
// no scheduling tools, so this worker is the ONLY systematic intake for the whole
// phone channel — a missed intent here is a lost request, not a fallback. So the
// classifier is MULTI-LABEL: one call can be `[new_job, cancel]`, and every
// distinct actionable request is returned so nothing is dropped. The worker then
// routes each label (new_job → auto-create; the mutating/enquiry ones → a pushed
// manager review, never auto-executed; other → L1 only).

export type CallIntent =
  | 'new_job'
  | 'reschedule'
  | 'cancel'
  | 'question'
  | 'complaint'
  | 'other';

export const CALL_INTENTS: readonly CallIntent[] = [
  'new_job',
  'reschedule',
  'cancel',
  'question',
  'complaint',
  'other',
] as const;

// The worker validates every label the model returns with this guard: the tool
// schema declares an enum, but coerceBySchema passes array items through
// untouched (no enum coercion), so a model that invents a label would otherwise
// reach the router. An out-of-vocabulary label is treated as "couldn't classify"
// → the fail-safe review, never silently dropped.
export const isCallIntent = (v: unknown): v is CallIntent =>
  typeof v === 'string' && (CALL_INTENTS as readonly string[]).includes(v);

export interface CallClassification {
  intents: CallIntent[];
  reason: string;
}

// Injected into the worker so the pipeline is testable without the live model.
// `ctx` is optional so a 1-arg stub stays assignable; when present the live
// implementation bills the call (this router runs on EVERY inbound call).
export type CallClassifier = (
  transcript: string,
  ctx?: CostContext,
) => Promise<CallClassification>;

export const CLASSIFY_CALL_SYSTEM =
  'You triage a DIARIZED transcript of an inbound phone call to a trades business ' +
  '(HVAC/plumbing/electrical). One speaker is the business receptionist; the other is the ' +
  'caller. Return the list of DISTINCT ACTIONABLE intents the CALLER expresses. Labels:\n' +
  '- new_job: the caller wants new work done (a repair, install, quote, or callout).\n' +
  '- reschedule: the caller wants to move an existing appointment to a different time.\n' +
  '- cancel: the caller wants to cancel an existing appointment or job.\n' +
  '- question: a business enquiry about our service, a job, an appointment, or pricing.\n' +
  '- complaint: the caller is dissatisfied — a dispute, a refund demand, or a legal/again threat. ' +
  'Use this REGARDLESS of the literal words ("I want a refund", "I\'ll sue", "redo it") — the signal ' +
  'is dissatisfaction with work already done, not a request for new work.\n' +
  '- other: none of the above — a supplier, a wrong number, a thank-you, off-topic or personal chatter.\n\n' +
  'Rules:\n' +
  '- List EVERY distinct actionable request. If the caller asks for a new job AND cancels an existing ' +
  'appointment, return BOTH ["new_job","cancel"]. Do not collapse a mixed call to one label.\n' +
  '- Off-topic chatter alongside one real request does NOT add a label — only distinct requests count.\n' +
  '- A question purely about our service/job/appointment/pricing is `question`; a question unrelated ' +
  'to our business is `other`.\n' +
  '- When the call carries no actionable request at all, return exactly ["other"]. Never return an ' +
  'empty list.';

export const CLASSIFY_CALL_TOOL: ForcedToolSpec = {
  name: 'classify_call',
  description: 'Record every distinct actionable intent the caller expresses in the inbound call.',
  inputSchema: {
    type: 'object',
    properties: {
      intents: {
        type: 'array',
        description: 'Every distinct actionable intent in the call; at least one entry.',
        items: { type: 'string', enum: [...CALL_INTENTS] },
      },
      reason: { type: 'string', description: 'One short sentence explaining the labels chosen.' },
    },
    required: ['intents', 'reason'],
    additionalProperties: false,
  },
};

const CLASSIFY_RETRIES = 3;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Default router: whichever provider MODEL_PROVIDER selects (GLM-5.2 by default),
// forced through the classify tool. A classifier throw is NOT a benign event here
// — an unclassified important call (a complaint, a cancel) would otherwise fall to
// L1-only silence — so retry up to 3 times with EXPONENTIAL BACKOFF + FULL JITTER
// (sleep a random span in [0, 2^attempt·500ms]) before giving up. After 3 throws
// the last error is re-thrown; the worker catches it and routes to a pushed human
// review (fail-safe, never silence).
export const defaultCallClassifier: CallClassifier = async (transcript, ctx) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < CLASSIFY_RETRIES; attempt++) {
    try {
      const args = await runForcedTool(
        CLASSIFY_CALL_TOOL,
        {
          system: CLASSIFY_CALL_SYSTEM,
          user: transcript,
          maxTokens: 256,
          label: 'defaultCallClassifier',
        },
        ctx,
      );
      return args as unknown as CallClassification;
    } catch (err) {
      lastErr = err;
      if (attempt < CLASSIFY_RETRIES - 1) {
        const ceilingMs = Math.pow(2, attempt) * 500; // 500, 1000
        await sleep(Math.random() * ceilingMs); // full jitter — no thundering herd
      }
    }
  }
  throw lastErr;
};
