import { runForcedTool, type ForcedToolSpec } from '../model/forcedTool.js';
import type { CostContext, CustomerContext } from '../db/index.js';
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
// `ctx` is optional so existing 2-arg stubs stay assignable.
export type Briefer = (
  context: CustomerContext,
  focus: BriefFocus,
  ctx?: CostContext,
) => Promise<CustomerBriefing>;

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
export const defaultBriefer: Briefer = async (context, focus, ctx) => {
  const args = await runForcedTool(BRIEFING_TOOL, {
    system: BRIEFING_SYSTEM,
    user: `Focus: ${focus}\n\n${serializeContextForPrompt(context)}`,
    // 1024 was too small and failed SILENTLY. Measured on GLM-5.2 (2026-07-30):
    // a 6-capture customer used 831-892 tokens (87% of the old ceiling), and 12+
    // captures hit finish_reason='length' every time — truncating `citations`
    // away while still returning parseable JSON, so the briefing rendered
    // complete and cited nothing. A 20-capture history needs ~1432.
    //
    // Raising the ceiling does NOT raise the bill for calls that already fit:
    // completion_tokens bills what was emitted, not what was allowed. It only
    // costs more where the call was previously truncated — and those were paying
    // the full 1024 for an unusable result.
    // 2048 was the same silent-truncation bug one size up (2026-08-14, spine-eval
    // Q01/Q03): GLM-5.2 THINKS by default and its reasoning tokens spend from
    // this same budget, so a long enough think starved the visible output and
    // finish_reason='length' killed the tool intermittently — rich histories
    // and chatty thinking days made it flaky, not rare. 8192 leaves the think
    // plus the largest measured brief comfortable headroom; completion billing
    // is still per token EMITTED, so calls that already fit cost the same.
    maxTokens: 8192,
    label: 'defaultBriefer',
  }, ctx);
  const { briefing, citations } = args as unknown as {
    briefing: string;
    citations?: Citation[];
  };
  return { briefing, citations: validateCitations(citations, context) };
};
