import Anthropic from '@anthropic-ai/sdk';
import type { CustomerContext } from '../db/index.js';
import { serializeContextForPrompt, validateCitations, type Citation } from './grounding.js';

// next_visit = a pre-visit cheat-sheet (the open job, access notes, what the last
// tech flagged); full_history = the relationship over time (recurring issues,
// past quotes). Same record, different angle — one tool covers both overview §2
// goals (pre-visit briefing + customer-history summary).
export type BriefFocus = 'next_visit' | 'full_history';

export interface CustomerBriefing {
  briefing: string;
  citations: Citation[];
}

// Injected so tests can supply a deterministic stub instead of the live model.
export type Briefer = (context: CustomerContext, focus: BriefFocus) => Promise<CustomerBriefing>;

const BRIEFING_SYSTEM =
  'You brief a trades technician (HVAC/plumbing/electrical/etc.) on a customer before a visit. ' +
  'Use ONLY the provided customer record — never invent customers, facts, history, or numbers. ' +
  'Ground every claim in a specific capture and record its captureId in `citations`. ' +
  'If the record is too thin to brief, say so plainly rather than padding. ' +
  'Focus next_visit: what the tech needs for the upcoming visit (open job, access notes, last ' +
  "tech's flags). Focus full_history: the customer's history over time (recurring issues, prior quotes).";

// Single forced tool — the model's only move is to return this structured object.
const BRIEFING_TOOL: Anthropic.Tool = {
  name: 'record_briefing',
  description: 'Record the grounded customer briefing and the captures backing each claim.',
  input_schema: {
    type: 'object',
    properties: {
      briefing: { type: 'string', description: 'The briefing prose for the technician.' },
      citations: {
        type: 'array',
        description: 'One entry per grounded claim.',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string', description: 'The claim made in the briefing.' },
            captureId: { type: 'string', description: 'The capture id this claim is sourced from.' },
          },
          required: ['claim', 'captureId'],
          additionalProperties: false,
        },
      },
    },
    required: ['briefing', 'citations'],
    additionalProperties: false,
  },
};

// Default briefer: Claude Sonnet, forced through the briefing tool. Citations are
// validated against the real capture set before returning — a hallucinated id is
// dropped here, not trusted from the model.
export const sonnetBriefer: Briefer = async (context, focus) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: BRIEFING_SYSTEM,
    tools: [BRIEFING_TOOL],
    tool_choice: { type: 'tool', name: BRIEFING_TOOL.name },
    messages: [
      { role: 'user', content: `Focus: ${focus}\n\n${serializeContextForPrompt(context)}` },
    ],
  });
  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === BRIEFING_TOOL.name,
  );
  if (!toolUse) throw new Error('sonnetBriefer: model returned no record_briefing tool_use block');
  const { briefing, citations } = toolUse.input as {
    briefing: string;
    citations?: Citation[];
  };
  return { briefing, citations: validateCitations(citations, context) };
};
