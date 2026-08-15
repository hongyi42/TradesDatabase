import { runForcedTool, type ForcedToolSpec } from '../model/forcedTool.js';
import type { CostContext, CustomerContext } from '../db/index.js';
import { serializeContextForPrompt, validateCitations, type Citation } from './grounding.js';

export interface CustomerAnswer {
  answer: string;
  citations: Citation[];
}

// Injected so tests can supply a deterministic stub instead of the live model.
// `ctx` is optional so existing 2-arg stubs stay assignable.
export type Answerer = (
  context: CustomerContext,
  question: string,
  ctx?: CostContext,
) => Promise<CustomerAnswer>;

const ANSWER_SYSTEM =
  'You answer a question about a trades customer using ONLY the provided customer record. ' +
  'Never invent customers, facts, history, or numbers. If the record does not contain the answer, ' +
  "say you don't know — do not guess or fabricate. " +
  'Ground every claim in a specific capture and record its captureId in `citations`.';

// Single forced tool — the model's only move is to return this structured object.
const ANSWER_TOOL: ForcedToolSpec = {
  name: 'record_answer',
  description: 'Record the grounded answer and the captures backing each claim.',
  inputSchema: {
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

// Default answerer: whichever provider MODEL_PROVIDER selects (GLM-5.2 by default),
// forced through the answer tool. Citations are validated against the real capture
// set before returning — a hallucinated id is dropped here, not trusted from the
// model. Same silent-degradation caveat as defaultBriefer.
export const defaultAnswerer: Answerer = async (context, question, ctx) => {
  const args = await runForcedTool(ANSWER_TOOL, {
    system: ANSWER_SYSTEM,
    user: `Question: ${question}\n\n${serializeContextForPrompt(context)}`,
    // Raised with defaultBriefer's for the same measured reason: this caller has
    // the same prose+citations output shape over the same serialized context, so
    // it truncates the same way — dropping `citations` while still returning
    // parseable JSON. See the note in briefCustomer.ts for the measurements.
    // 2048 was the same silent-truncation bug one size up (2026-08-14, spine-eval
    // Q01/Q03): GLM-5.2 THINKS by default and its reasoning tokens spend from
    // this same budget, so a long enough think starved the visible output and
    // finish_reason='length' killed the tool intermittently — rich histories
    // and chatty thinking days made it flaky, not rare. 8192 leaves the think
    // plus the largest measured brief comfortable headroom; completion billing
    // is still per token EMITTED, so calls that already fit cost the same.
    maxTokens: 8192,
    // Forced-JSON extraction: a long think adds nothing here (probed
    // 2026-08-04) and an unbounded one blew the 90s tool timeout (Q03,
    // 2026-08-14) once the raised ceiling stopped truncating it.
    reasoningEffort: 'none',
    label: 'defaultAnswerer',
  }, ctx);
  const { answer, citations } = args as unknown as { answer: string; citations?: Citation[] };
  return { answer, citations: validateCitations(citations, context) };
};
