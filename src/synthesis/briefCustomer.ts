import { runForcedTool, type ForcedToolSpec } from '../model/forcedTool.js';
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
const BRIEFING_TOOL: ForcedToolSpec = {
  name: 'record_briefing',
  description: 'Record the grounded customer briefing and the captures backing each claim.',
  inputSchema: {
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

// Default briefer: whichever provider MODEL_PROVIDER selects (GLM-5.2 by default),
// forced through the briefing tool. Citations are validated against the real
// capture set before returning — a hallucinated id is dropped here, not trusted
// from the model.
//
// NOTE: validateCitations drops unmatched ids SILENTLY. A model that copies capture
// UUIDs less accurately therefore degrades into briefings that read complete but
// cite nothing, with no error and no failing test. Unmeasured on every provider —
// this is the metric a synthesis eval needs to cover first.
export const defaultBriefer: Briefer = async (context, focus) => {
  const args = await runForcedTool(BRIEFING_TOOL, {
    system: BRIEFING_SYSTEM,
    user: `Focus: ${focus}\n\n${serializeContextForPrompt(context)}`,
    maxTokens: 1024,
    label: 'defaultBriefer',
  });
  const { briefing, citations } = args as unknown as {
    briefing: string;
    citations?: Citation[];
  };
  return { briefing, citations: validateCitations(citations, context) };
};
