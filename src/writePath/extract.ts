import { runForcedTool, type ForcedToolSpec } from '../model/forcedTool.js';
import type { CostContext, Json } from '../db/index.js';

// Candidate structured fields the model proposes from a raw note. Every field is
// optional — extraction is best-effort interpretation (overview §5: the model
// interprets, code decides). Identity/status are *suggestions* here; the
// deterministic write-path (identityMatch / recordFieldNote) makes the calls.
export interface ExtractedFields {
  customerName?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  jobTitle?: string | null;
  jobType?: string | null;
  workPerformed?: string | null;
  laborHours?: number | null;
  statusSignal?: 'completed' | 'in_progress' | null;
  followUp?: string | null;
  // RUNG 10 — the one judgment call the planner's eye needs from the model:
  // did the BUSINESS agree to send someone out? True is the trigger for an
  // `inbound_commitment` observation (a manager is asked whether to book it),
  // so a caller merely ASKING must never set it — that is the difference
  // between "they want us" and "we said yes".
  visitCommitted?: boolean | null;
  // RUNG 10, AMENDED 2026-09-07 (user): does the OFFICE need to see this at all?
  // The gate used to be a database lookup — "has this customer a non-terminal
  // job?" — which woke the planner for a thank-you arriving after the invoice
  // was paid. This call is already an inference read of the same text, so it is
  // the better judge of whether a manager's attention is worth spending.
  //
  // FALSE IS THE ONLY VALUE THAT SKIPS. Absent, null and true all raise the ask,
  // so a truncated response, an older stub, or a model that ignores the field
  // behaves exactly as the code did before it existed — the failure direction is
  // toward a manager hearing about it, never away. (`visitCommitted` outranks
  // this: the firm agreeing to come out IS attention, whatever this says.)
  needsAttention?: boolean | null;
  // L3 long-tail facts that don't deserve a column: gate codes, pets, access
  // notes, spotted replacement opportunities, etc.
  attributes?: Json;
}

// Injected into the write-path so tests can supply a deterministic stub instead
// of calling the live model.
// `ctx` is optional so every existing 1-arg stub stays assignable; when present
// the live implementation bills the call against that tenant.
export type Extractor = (rawText: string, ctx?: CostContext) => Promise<ExtractedFields>;

const EXTRACTION_SYSTEM =
  'You extract structured fields from a trades technician field note, an inbound ' +
  'phone-call transcript, or a customer email (HVAC/plumbing/electrical/etc.). ' +
  'Map only what the text actually says — leave a field absent if ' +
  'the text does not support it; never invent customers, addresses, or prices. ' +
  'Put durable long-tail facts (gate codes, pets, access notes, spotted ' +
  'replacement opportunities) in `attributes`. Set `statusSignal` only if the text ' +
  'clearly indicates the job is finished (completed) or actively underway (in_progress). ' +
  'Set `visitCommitted` true ONLY when the BUSINESS agreed to send someone out — ' +
  'never because the caller asked, requested a quote, or it is undecided. ' +
  'Set `needsAttention` false ONLY when nobody at the business needs to read, decide, or act ' +
  'on the message — a thank-you, an acknowledgement, an auto-reply, a wrong number. ' +
  'When in any doubt, leave it true.';

// Single forced tool — the model's only move is to return this structured object.
// EXPORTED so a test pins the schema: `visitCommitted` is what decides whether a
// call raises an ask, and a field silently dropped from here fails open (absent
// reads as "not committed") with nothing to notice it.
export const EXTRACTION_TOOL: ForcedToolSpec = {
  name: 'record_extraction',
  description: 'Record the structured fields extracted from this note, call transcript, or email.',
  inputSchema: {
    type: 'object',
    properties: {
      customerName: { type: 'string', description: 'Customer / household / site name if stated.' },
      phone: { type: 'string', description: 'Customer phone if stated.' },
      address: { type: 'string', description: 'Street address line if stated.' },
      city: { type: 'string' },
      state: { type: 'string' },
      postalCode: { type: 'string' },
      jobTitle: { type: 'string', description: 'Short title for the work, e.g. "AC repair".' },
      jobType: { type: 'string', description: 'Trade/category, e.g. "hvac", "plumbing".' },
      workPerformed: { type: 'string', description: 'What the technician did or observed.' },
      laborHours: { type: 'number', description: 'Hours of labor if stated.' },
      statusSignal: {
        type: 'string',
        enum: ['completed', 'in_progress'],
        description: 'Only if the note clearly signals job completion or active work.',
      },
      followUp: { type: 'string', description: 'Any follow-up needed (return visit, quote, part).' },
      visitCommitted: {
        type: 'boolean',
        description:
          'True ONLY if the business agreed to send someone out. Never true because the ' +
          'customer asked for a visit, requested a quote, or it is still undecided.',
      },
      needsAttention: {
        type: 'boolean',
        description:
          'Does anyone at the business need to read, decide, or act on this? False ONLY for a ' +
          'message that closes itself — a thank-you, an acknowledgement of something already ' +
          'agreed, an auto-reply, a wrong number. If there is ANY doubt, true.',
      },
      attributes: {
        type: 'object',
        description: 'Long-tail L3 facts as key/value pairs (gate code, pets, lead opportunity).',
        additionalProperties: true,
      },
    },
    additionalProperties: false,
  },
};

// Default extractor: whichever provider MODEL_PROVIDER selects (GLM-5.2 by
// default), forced through the extraction tool so the reply is always a structured
// object (or an error we can surface).
//
// laborHours is declared `number` in the schema, so runForcedTool coerces a quoted
// "4" back to 4 — an OpenAI-compatible model emitting numbers as strings would
// otherwise write a string into a numeric L2 column. `attributes` has no declared
// property types, so free-form L3 facts (gate code "0412") pass through untouched.
//
// `ctx` only carries the tenant for cost attribution; runForcedTool bills the
// call against whichever provider is actually active.
export const defaultExtractor: Extractor = async (rawText, ctx) => {
  const args = await runForcedTool(EXTRACTION_TOOL, {
    system: EXTRACTION_SYSTEM,
    user: rawText,
    maxTokens: 1024,
    label: 'defaultExtractor',
  }, ctx);
  return args as unknown as ExtractedFields;
};
