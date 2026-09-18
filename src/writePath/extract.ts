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
// RUNG 10B.3: `fromTheFirm` says the LATEST message is our OWN outbound mail,
// not the customer's. It changes nothing structural — the same fields come back
// — but the identity rule below reverses on it, and the model cannot know it
// from the text.
export type Extractor = (
  rawText: string,
  ctx?: CostContext,
  context?: { earlier: ThreadMessage[]; fromTheFirm?: boolean },
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
  // Measured 2026-09-17 (scripts/extract-eval, corpus v3): the model returned `in_progress`
  // for the firm agreeing a date — and `open` → `in_progress` is a permitted transition, so
  // that flips a job to work-underway before anybody has been out. The other direction too:
  // a casual "your engineer finished the repair" produced no signal in 3 runs of 10.
  'ARRANGING A VISIT IS NOT WORK UNDERWAY: a date agreed, a slot accepted or a technician ' +
  'promised sets NO statusSignal at all — `in_progress` means somebody has actually started ' +
  'the work. ' +
  // NOT FIXED HERE, deliberately (operator, 2026-09-17: "we don't have to get perfect
  // numbers"). Step 2 below made the model see an agreed visit, and "work underway" came
  // partly back with it: on a thread about sourcing parts it answered `in_progress` in 3 then
  // 7 runs of 10, against an aggregate `status` of 110-117/120. Two sentences were tried and
  // BOTH reverted:
  //   "read the signal from the LATEST message alone — work discussed as upcoming earlier in
  //   a conversation is not work underway now" — true of statusSignal, fixed the parts thread
  //   outright, and BLED into visitCommitted: every fixture carrying quoted or earlier context
  //   collapsed (the firm's own promise with the customer's request quoted beneath went 10/10
  //   to 2/10; `committed` overall 120/120 to 93/120, below the pre-Phase-5 baseline). The
  //   commitment rule DEPENDS on reading an earlier offer and accepting it now, so a clause
  //   about one field is not local to that field — the prompt is read whole.
  //   "neither is preparing to do it: quoting, planning, ordering or waiting on parts" —
  //   reverted unmeasured with the first, rather than keep a sentence added only to chase a
  //   one-fixture wobble. Try it alone if this is revisited; scripts/extract-eval is the loop.
  'And a customer reporting the work done IS `completed`, however casually they say it. ' +
  // OPERATOR RULING 2026-09-17 (option B): the question is whether a visit is AGREED, not
  // whether this message is the firm agreeing. The old reading had a hole in the commonest
  // booking flow there is — the firm offers a slot (not agreement) and the customer accepts
  // it (not the firm speaking), so a visit exists on the customer's calendar and neither
  // message ever raised an ask. That is the live specimen's failure by another route.
  'Set `visitCommitted` true when A VISIT IS NOW AGREED as of this message: the firm saying ' +
  'it will attend, or the customer accepting a time the firm offered. An offer alone is not ' +
  'agreement and a request alone is not — never set it because the caller asked, requested ' +
  'a quote, or it is undecided. ' +
  'Set `touchesOperations` false ONLY when the message carries nothing about the firm\'s ' +
  'operating record — no job, visit, schedule change, parts or money — such as a bare ' +
  'thank-you, an auto-reply, or a wrong number. ' +
  // "an acknowledgement" used to head that list and was matching on FORM: measured
  // 2026-09-17, "Thursday works." came back `touchesOperations: false` in 9 runs of 10 and
  // "just to let you know your engineer finished the repair" in 5 of 10. Both are
  // acknowledgements in shape and a schedule or a job state in content. A false here is
  // what stops anybody being asked about the message at all.
  'LENGTH AND TONE ARE NOT THE TEST. A short, polite or acknowledging message that names a ' +
  'day, accepts or declines a time, or reports work started or finished DOES touch the ' +
  'record — "Thursday works", "that suits, see you then", "all done now, thanks" are each ' +
  'true. When in any doubt, leave it true. ' +
  'You may be shown EARLIER MESSAGES from the same conversation. Take ONLY identity details out ' +
  'of them, and ONLY the CUSTOMER\'s: a name, a phone number, an address, an email that belongs ' +
  'to the person writing in. NEVER take them from your own firm\'s replies or from a signature ' +
  'block, letterhead or footer — the firm\'s own number and address identify the firm, and ' +
  'reporting them as the customer\'s files the message against the wrong person. If you cannot ' +
  'tell whose a detail is, leave it out. EVERYTHING ELSE describes the LATEST ' +
  'MESSAGE alone: jobTitle, statusSignal, visitCommitted, touchesOperations, followUp and ' +
  'attributes. The earlier messages say what was true then, and they include your own firm\'s ' +
  'replies: a visit the firm agreed to in an earlier message is already handled, so it must NOT ' +
  'set visitCommitted, and work reported done earlier must NOT set statusSignal. ' +
  // The half that was missing, and it is the one that cost an appointment: an OFFER is not an
  // agreement, so a message accepting one agrees the visit NOW. Measured 2026-09-17 —
  // "Thursday works." answered committed 3/3 as a bare line and 0/10 once the firm's quoted
  // offer was appended beneath it, the way a real reply carries it. The model was reading its
  // own quoted history as "already handled".
  'BUT AN OFFER MADE EARLIER IS NOT AN AGREEMENT: if the latest message accepts one, the ' +
  'visit is agreed NOW and visitCommitted IS true. Text from an earlier message quoted ' +
  'inside the latest one (under "On <date>, <person> wrote:") is earlier context in the same ' +
  'way — read it for what was offered, never as this message already being handled. ' +
  'A follow-up or ' +
  'a fact that was stated earlier and is not restated now is not a follow-up or a fact of this ' +
  'message. ' +
  // Rung 10b.3: the firm's own SENT mail now reaches this extractor. The rule
  // above covers the firm's replies only when they are EARLIER context; when
  // OUR reply is the message being judged, the same rule has to be restated or
  // the model reads our signature block as the customer's identity.
  'THE LATEST MESSAGE IS SOMETIMES YOUR OWN FIRM\'S REPLY, and it is labelled as such when it ' +
  'is. Then the identity rule applies to IT: its sender address, signature block, letterhead, ' +
  'phone number and address are the FIRM\'s and must not be reported as the customer\'s — take ' +
  'identity only from what the customer wrote. What your firm SAYS still counts in full: a ' +
  'visit your own firm agrees to there IS a commitment (your firm is the one agreeing), and ' +
  'jobTitle, statusSignal, followUp and attributes are read from it exactly as from any other ' +
  'latest message.';

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
// WHAT THE MODEL IS ACTUALLY SHOWN. The conversation FIRST and the message
// LAST, with the latest one labelled: its judgments must come from the bottom of
// what it is shown, and ending on the message being judged is what makes that
// the natural reading.
//
// The label is also what the system prompt's firm's-own-reply rule keys on
// (rung 10b.3) — the model cannot tell from the text that a From line is our own
// mailbox. An ordinary inbound message with no thread keeps the BARE rawText it
// has always had: the labelling appears only where it says something new, so
// nothing about the existing prompt shifts under this change.
//
// EXPORTED so a test pins it — the labelling is the whole mechanism, and a
// silent edit to it would leave the firm's own signature block readable as the
// customer's identity with every test still green.
export function renderExtractionUser(
  rawText: string,
  context?: { earlier?: ThreadMessage[]; fromTheFirm?: boolean },
): string {
  const thread = context?.earlier?.length ? renderThreadContext(context.earlier) : '';
  const label = context?.fromTheFirm
    ? "LATEST MESSAGE \u2014 YOUR OWN FIRM'S REPLY, extract from this:"
    : 'LATEST MESSAGE \u2014 extract from this:';
  if (thread) return `${thread}\n\n${label}\n${rawText}`;
  return context?.fromTheFirm ? `${label}\n${rawText}` : rawText;
}

export const defaultExtractor: Extractor = async (rawText, ctx, context) => {
  const args = await runForcedTool(EXTRACTION_TOOL, {
    system: EXTRACTION_SYSTEM,
    user: renderExtractionUser(rawText, context),
    maxTokens: 1024,
    label: 'defaultExtractor',
  }, ctx);
  return args as unknown as ExtractedFields;
};
