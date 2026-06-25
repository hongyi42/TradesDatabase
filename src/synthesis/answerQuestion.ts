import Anthropic from '@anthropic-ai/sdk';
import type { CustomerContext } from '../db/index.js';
import { serializeContextForPrompt, validateCitations, type Citation } from './grounding.js';

export interface CustomerAnswer {
  answer: string;
  citations: Citation[];
}

// Injected so tests can supply a deterministic stub instead of the live model.
export type Answerer = (context: CustomerContext, question: string) => Promise<CustomerAnswer>;

const ANSWER_SYSTEM =
  'You answer a question about a trades customer using ONLY the provided customer record. ' +
  'Never invent customers, facts, history, or numbers. If the record does not contain the answer, ' +
  "say you don't know — do not guess or fabricate. " +
  'Ground every claim in a specific capture and record its captureId in `citations`.';

// Single forced tool — the model's only move is to return this structured object.
const ANSWER_TOOL: Anthropic.Tool = {
  name: 'record_answer',
  description: 'Record the grounded answer and the captures backing each claim.',
  input_schema: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: 'The answer for the technician (or that it is unknown).' },
      citations: {
        type: 'array',
        description: 'One entry per grounded claim.',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string', description: 'The claim made in the answer.' },
            captureId: { type: 'string', description: 'The capture id this claim is sourced from.' },
          },
          required: ['claim', 'captureId'],
          additionalProperties: false,
        },
      },
    },
    required: ['answer', 'citations'],
    additionalProperties: false,
  },
};

// Default answerer: Claude Sonnet, forced through the answer tool. Citations are
// validated against the real capture set before returning — a hallucinated id is
// dropped here, not trusted from the model.
export const sonnetAnswerer: Answerer = async (context, question) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: ANSWER_SYSTEM,
    tools: [ANSWER_TOOL],
    tool_choice: { type: 'tool', name: ANSWER_TOOL.name },
    messages: [
      { role: 'user', content: `Question: ${question}\n\n${serializeContextForPrompt(context)}` },
    ],
  });
  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === ANSWER_TOOL.name,
  );
  if (!toolUse) throw new Error('sonnetAnswerer: model returned no record_answer tool_use block');
  const { answer, citations } = toolUse.input as { answer: string; citations?: Citation[] };
  return { answer, citations: validateCitations(citations, context) };
};
