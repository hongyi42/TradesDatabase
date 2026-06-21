import Anthropic from '@anthropic-ai/sdk';

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

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'classify_email',
  description: 'Record whether the email is work-related to the trades business.',
  input_schema: {
    type: 'object',
    properties: {
      isWork: { type: 'boolean', description: 'True only if work-related to the trades business.' },
      reason: { type: 'string', description: 'One short sentence explaining the decision.' },
    },
    required: ['isWork', 'reason'],
    additionalProperties: false,
  },
};

// Default classifier: Claude Sonnet, forced through the classify tool. Verified by
// a live spot-check (not in the always-run suite); ingestEmail tests stub it.
export const sonnetClassifier: WorkClassifier = async (email) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: CLASSIFY_SYSTEM,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'tool', name: CLASSIFY_TOOL.name },
    messages: [
      { role: 'user', content: `From: ${email.from}\nSubject: ${email.subject}\n\n${email.body}` },
    ],
  });
  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === CLASSIFY_TOOL.name,
  );
  if (!toolUse) throw new Error('sonnetClassifier: model returned no classify_email tool_use block');
  return toolUse.input as Classification;
};
