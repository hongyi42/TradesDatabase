import { runForcedTool, type ForcedToolSpec } from '../model/forcedTool.js';
import type { CostContext, Json } from '../db/index.js';
import type { ThreadMessage } from '../email/format.js';

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
  // RUNG 10, AMENDED 2026-09-07 (user): IS THERE ANYTHING HERE FOR THE
  // OPERATIONS LAYER? The gate used to be a database lookup — "has this customer
  // a non-terminal job?" — which woke the planner for a thank-you arriving after
  // the invoice was paid. This call is already an inference read of the same
  // text, so it is the better judge.
  //
  // The QUESTION was reframed the same day, and the wording is the point. It
  // first asked "does anyone need to act on this?", which is a judgment about
  // people and their priorities — something this call cannot see, having no
  // customer, no history and no schedule. It now asks whether the message
  // carries or concerns an L2 object: a job, a visit, a schedule change, parts,
  // money. That is a property of the TEXT, which is the only thing this call
  // has. (User: L2 is the operations layer — the firm's structured objects of
  // interest — and the planner regulates it; money counts, 2026-09-07.)
  //
  // FALSE IS THE ONLY VALUE THAT SKIPS. Absent, null and true all raise the ask,
  // so a truncated response, an older stub, or a model that ignores the field
  // behaves exactly as the code did before it existed — the failure direction is
  // toward a manager hearing about it, never away. (`visitCommitted` outranks
  // this: the firm agreeing to come out IS attention, whatever this says.)
  touchesOperations?: boolean | null;
  // L3 long-tail facts that don't deserve a column: gate codes, pets, access
  // notes, spotted replacement opportunities, etc.
  attributes?: Json;
}

// Injected into the write-path so tests can supply a deterministic stub instead
// of calling the live model.
// `ctx` is optional so every existing 1-arg stub stays assignable; when present
// the live implementation bills the call against that tenant.
// RUNG 10B: the third argument is the CONVERSATION this message belongs to,
// oldest first, excluding the message itself. Optional so every existing 1- and
// 2-arg stub stays assignable, and absent for every channel that has no thread.
export type Extractor = (
  rawText: string,
  ctx?: CostContext,
  context?: { earlier: ThreadMessage[] },
) => Promise<ExtractedFields>;

// HOW MUCH OF THE CONVERSATION THE MODEL SEES. Bounded twice: the last 8
// messages, each cut to 600 characters. A long thread is mostly quoted history
// of itself, so the cap costs little — and an unbounded one would put a whole
// exchange, and its price, inside a webhook request.
const THREAD_SHOWN = 8;
const THREAD_MESSAGE_CHARS = 600;

// Oldest first, because that is the order a person reads a thread in and the
// order the facts arrive in: the name and the address are usually at the top and
// the request is at the bottom.
export function renderThreadContext(earlier: ThreadMessage[]): string {
  const shown = earlier.slice(-THREAD_SHOWN);
  if (shown.length === 0) return '';
  const lines = shown.map((m) => {
    const head = [
      m.from ? `From: ${m.from}` : null,
      m.subject ? `Subject: ${m.subject}` : null,
      m.at,
    ]
      .filter(Boolean)
      .join(' \u00b7 ');
    const body =
      m.body.length > THREAD_MESSAGE_CHARS
        ? `${m.body.slice(0, THREAD_MESSAGE_CHARS)}\u2026`
        : m.body;
    return `${head}\n${body}`;
  });
  return `EARLIER IN THIS CONVERSATION (context only):\n${lines.join('\n---\n')}`;
}

// EXPORTED so a test pins the one sentence that tells the model what the
// conversation may and may not answer.
export const EXTRACTION_SYSTEM =
  'You extract structured fields from a trades technician field note, an inbound ' +
  'phone-call transcript, or a customer email (HVAC/plumbing/electrical/etc.). ' +
  'Map only what the text actually says — leave a field absent if ' +
  'the text does not support it; never invent customers, addresses, or prices. ' +
  'Put durable long-tail facts (gate codes, pets, access notes, spotted ' +
  'replacement opportunities) in `attributes`. Set `statusSignal` only if the text ' +
  'clearly indicates the job is finished (completed) or actively underway (in_progress). ' +
  'Set `visitCommitted` true ONLY when the BUSINESS agreed to send someone out — ' +
  'never because the caller asked, requested a quote, or it is undecided. ' +
  'Set `touchesOperations` false ONLY when the message carries nothing about the firm\'s ' +
  'operating record — no job, visit, schedule change, parts or money — such as a thank-you, ' +
  'an acknowledgement, an auto-reply, or a wrong number. When in any doubt, leave it true. ' +
  'You may be shown EARLIER MESSAGES from the same conversation. Take ONLY identity details out ' +
  'of them — a name, a phone number, an address, an email. EVERYTHING ELSE describes the LATEST ' +
  'MESSAGE alone: jobTitle, statusSignal, visitCommitted, touchesOperations, followUp and ' +
  'attributes. The earlier messages say what was true then, and they include your own firm\'s ' +
  'replies: a visit the firm agreed to in an earlier message is already handled, so it must NOT ' +
  'set visitCommitted, and work reported done earlier must NOT set statusSignal. A follow-up or ' +
  'a fact that was stated earlier and is not restated now is not a follow-up or a fact of this ' +
  'message.';

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
      touchesOperations: {
        type: 'boolean',
        description:
          "Does this message carry or concern the firm's operating record — a job, a visit, a " +
          'schedule change, parts, or money owed or paid? False ONLY for a message that carries ' +
          'none of it and closes itself: a thank-you, an acknowledgement of something already ' +
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
export const defaultExtractor: Extractor = async (rawText, ctx, context) => {
  const thread = context?.earlier?.length ? renderThreadContext(context.earlier) : '';
  const args = await runForcedTool(EXTRACTION_TOOL, {
    system: EXTRACTION_SYSTEM,
    // The conversation FIRST and the message LAST, with the latest one labelled.
    // Its judgments must come from the bottom of what it is shown, and ending on
    // the message being judged is what makes that the natural reading.
    user: thread ? `${thread}\n\nLATEST MESSAGE \u2014 extract from this:\n${rawText}` : rawText,
    maxTokens: 1024,
    label: 'defaultExtractor',
  }, ctx);
  return args as unknown as ExtractedFields;
};
