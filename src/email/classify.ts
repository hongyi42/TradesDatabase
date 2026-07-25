import { runForcedTool, type ForcedToolSpec } from '../model/forcedTool.js';

export interface EmailInput {
  subject: string;
  body: string;
  from: string;
}

export interface Classification {
  isWork: boolean;
  reason: string;
}

// Injected into ingestEmail so the pipeline is testable without the live model.
export type WorkClassifier = (email: EmailInput) => Promise<Classification>;

const CLASSIFY_SYSTEM =
  'You triage a trades technician\'s email. Decide if it is WORK-RELATED to the trades business ' +
  '(a customer, a job, a quote, a supplier/parts order, scheduling) versus personal or noise ' +
  '(newsletters, marketing, receipts unrelated to jobs, personal mail). Only work email should ' +
  'enter the customer/job record. When unsure, prefer isWork=false.';

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
// in the always-run suite); ingestEmail tests stub it.
//
// isWork is declared boolean in the schema, so runForcedTool coerces a quoted
// "true"/"false" — the classify-before-L1 gate must never read a truthy STRING
// "false" as work mail and append a personal email to the append-only L1 log.
export const defaultClassifier: WorkClassifier = async (email) => {
  const args = await runForcedTool(CLASSIFY_TOOL, {
    system: CLASSIFY_SYSTEM,
    user: `From: ${email.from}\nSubject: ${email.subject}\n\n${email.body}`,
    maxTokens: 256,
    label: 'defaultClassifier',
  });
  return args as unknown as Classification;
};
