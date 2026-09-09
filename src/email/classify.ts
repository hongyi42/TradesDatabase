import { runForcedTool, type ForcedToolSpec } from '../model/forcedTool.js';
import type { CostContext } from '../db/index.js';

export interface EmailInput {
  subject: string;
  body: string;
  from: string;
  // RUNG 10B.3 — the firm's OWN outbound mail is classified too, and the
  // triage question reverses on it. Both present-only, so every existing
  // caller and stub is unchanged.
  to?: string;
  outbound?: boolean;
}

export interface Classification {
  isWork: boolean;
  reason: string;
}

// Injected into the inbound webhook so the pipeline is testable without the live model.
// `ctx` is optional so existing 1-arg stubs stay assignable; when present the
// live implementation bills the call. This classifier runs on EVERY inbound
// email — including the personal ones it then drops — so it is a real cost line
// even when nothing reaches the customer record.
export type WorkClassifier = (email: EmailInput, ctx?: CostContext) => Promise<Classification>;

const CLASSIFY_SYSTEM =
  'You triage a trades technician\'s email. Decide if it is WORK-RELATED to the trades business ' +
  '(a customer, a job, a quote, a supplier/parts order, scheduling) versus personal or noise ' +
  '(newsletters, marketing, receipts unrelated to jobs, personal mail). Only work email should ' +
  'enter the customer/job record. When unsure, prefer isWork=false. ' +
  // RUNG 10B.3. Without this the tie-break above lands on exactly the wrong
  // side of the case this rung exists for: "Thursday works — we'll come out
  // then." is nine words, from the firm's own address, on a Re: subject, with
  // no customer name and no trade vocabulary. That reads as "unsure", and
  // "unsure → not work" drops the firm's own promise before it can be recorded.
  'SOME MESSAGES ARE THE FIRM\'S OWN OUTBOUND MAIL, and they are labelled SENT BY THE FIRM when ' +
  'they are. Judge those by WHO THEY WENT TO and what they are about, not by the sender — the ' +
  'sender is always the firm. A short reply to a customer or a supplier IS work even when it ' +
  'says little ("Thursday works", "sending it over", "confirmed"): brevity is not a signal here, ' +
  'and the firm answering somebody about a job is the record this exists to keep. Personal mail ' +
  'from the same mailbox — a doctor, a school, a friend, a purchase of the person\'s own — is ' +
  'NOT work and must be dropped.';

const CLASSIFY_TOOL: ForcedToolSpec = {
  name: 'classify_email',
  description: 'Record whether the email is work-related to the trades business.',
  inputSchema: {
    type: 'object',
    properties: {
      isWork: { type: 'boolean', description: 'True only if work-related to the trades business.' },
      reason: { type: 'string', description: 'One short sentence explaining the decision.' },
    },
    required: ['isWork', 'reason'],
    additionalProperties: false,
  },
};

// Default classifier: whichever provider MODEL_PROVIDER selects (GLM-5.2 by
// default), forced through the classify tool. Verified by a live spot-check (not
// in the always-run suite); the webhook's tests stub it.
//
// isWork is declared boolean in the schema, so runForcedTool coerces a quoted
// "true"/"false" — the classify-before-L1 gate must never read a truthy STRING
// "false" as work mail and append a personal email to the append-only L1 log.
export const defaultClassifier: WorkClassifier = async (email, ctx) => {
  const args = await runForcedTool(CLASSIFY_TOOL, {
    system: CLASSIFY_SYSTEM,
    // The direction is stated OUTRIGHT, not left to be inferred from the
    // address: the model has no idea which mailbox is ours. `To:` is shown for
    // outbound mail because on an outbound message the recipient is the whole
    // signal — it is what says customer-or-dentist.
    user: email.outbound
      ? `SENT BY THE FIRM\nTo: ${email.to ?? '(unknown)'}\nSubject: ${email.subject}\n\n${email.body}`
      : `From: ${email.from}\nSubject: ${email.subject}\n\n${email.body}`,
    maxTokens: 256,
    label: 'defaultClassifier',
  }, ctx);
  return args as unknown as Classification;
};
