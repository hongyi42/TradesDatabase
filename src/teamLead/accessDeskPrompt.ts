import type { ForcedToolSpec } from '../model/forcedTool.js';

// The desk's ACCESS decision — its prompt and bounds (access plan B,
// thoughts/shared/plans/2026-09-19-access-plan-b-the-request-flow-through-the-office.md).
//
// ONE BOUNDED CALL, AND CODE DOES THE WRITE. The model answers exactly one
// question — open this narrow ask now, or put it to a manager — and returns a
// word. Every field of the grant that follows is fixed by code: that job, the
// record only, no money figures, one day. No model output reaches a grant
// field, so there is no ceiling to check and nothing to sanitise; the worst a
// confused model can do is open one job's record for a day, or send a request
// to a manager that did not need one.
//
// THE CALL IS ONLY REACHED FOR THE NARROW SHAPE. Money, every note, and
// anything customer-wide skip it entirely and go to a manager — so this prompt
// never has to be trusted with the sensitive cases (operator, 2026-09-19:
// "money stays sensitive by default… any money grant ask is always routed to
// the manager"). That is a property of the CALLER (accessDesk.ts), not of these
// words: keep it that way.
//
// WHY IT MAY DECIDE AT ALL. The alternative was "every ask waits for a
// manager", which is what exists today and is why nothing gets opened: a
// technician standing at a gate at 7am needs the code, and a manager asleep is
// not a decision-maker. The narrow shape is the one the operator ruled the
// office may open itself (2026-09-19: "the office should probably open a grant,
// narrow case includes customer info and the job").

export const ACCESS_DECIDE_TOOL: ForcedToolSpec = {
  name: 'decide_access',
  description: 'Open this request now, or put it to a manager.',
  inputSchema: {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        enum: ['open', 'ask_manager'],
        description: 'open = open this one job\'s record to them for a day. ask_manager = text the managers and let one decide.',
      },
      reason: {
        type: 'string',
        description: 'One sentence, for the office\'s own record. Not shown to the technician.',
      },
    },
    required: ['decision', 'reason'],
  },
};

// Short on purpose: one decision, two options, and the standard that separates
// them. Reasoning is `minimal` (the forced-JSON callers' setting) — this is a
// judgment about a job, not a puzzle.
export const ACCESS_DECIDE_SYSTEM = [
  "You are the team lead inside a trades firm's record system. A technician's assistant has",
  'asked you to open part of the record that technician cannot currently see, and you decide',
  'one thing: open it now yourself, or put it to a manager.',
  '',
  'WHAT YOU ARE BEING ASKED TO OPEN is always the same narrow thing: ONE job\'s record — its',
  "title, its customer's name, address and phone, the state of the work — and that customer's",
  'details, for ONE DAY. No money figures. No calls, emails or manager-only notes. You cannot',
  'widen it, shorten it or extend it; those are fixed. So the only question is whether this',
  'person should see this job today.',
  '',
  'OPEN IT when the request makes sense for someone doing the work: they are on their way to',
  'the address, covering for a colleague, finishing something they started, chasing a part, or',
  'the job is plainly connected to work they already have. A technician who needs a gate code',
  'or a phone number to do a job today is the ordinary case, and making them wait for a',
  'manager is the failure this exists to prevent. The record is the firm\'s working record,',
  'not a vault.',
  '',
  'PUT IT TO A MANAGER when something about the ask does not fit the work: the reason is',
  'unrelated to the job, it reads as curiosity about a customer or a colleague, the person has',
  'no plausible connection to it, or it is the kind of thing you would want a human to have',
  'said yes to. When you genuinely cannot tell, put it to a manager — a manager answering an',
  'unnecessary text costs minutes; the other mistake costs trust.',
  '',
  'You are not deciding whether the person is trustworthy in general, and you are not being',
  'asked to punish a vague reason. Judge the ASK against the WORK.',
  '',
  'Your reason is for the office\'s own record. Write one plain sentence. The technician never',
  'sees it, so do not address them in it.',
].join('\n');

export const ACCESS_DECIDE_MAX_TOKENS = 512;
export const ACCESS_DECIDE_REASONING = 'minimal' as const;

// 20 SECONDS, and what happens after it matters more than the number. This call
// sits inside the technician's own tool call, so the seat agent is waiting on
// it and the person is waiting on the seat; past about this long the seat's own
// budget is at risk. On timeout the request goes TO THE MANAGER — the fallback
// always moves towards a human, never towards opening something.
export const ACCESS_DECIDE_TIMEOUT_MS = 20_000;
