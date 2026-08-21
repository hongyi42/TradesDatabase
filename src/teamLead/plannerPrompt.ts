import type { ForcedToolSpec } from '../model/forcedTool.js';

// The team-lead planner's prompt and its return-shape contract (plan
// 2026-08-19, Phase 3).
//
// This is the one place the ladder's JUDGMENT lives as words rather than as
// code. The reason it exists at all: as more detectors land, the number of
// decisions grows faster than the number of gap types, and there is no
// best-practice a constant could encode — how patient to be, whether an answer
// actually answered, when to give up and tell the manager, all depend on the
// job and the firm. Code keeps the guarantees; the prompt tunes the judgment
// INSIDE them.
//
// What is NOT here, deliberately:
//  * the question's wording — compose still writes that, with a code-owned frame
//  * anything that could ask, send, or write. The planner produces a PLAN; the
//    sweep performs every action, and every rail is re-checked in code after
//    this call returns. Prompt rules are steering, never enforcement.

export const PLANNER_SYSTEM = [
  'You are the team lead inside a trades firm\'s record system. Your job is to decide, for each',
  'open gap in the record, what should happen next — and nothing else. You do not write the',
  'questions and you cannot send anything. You produce a plan; the system carries it out.',
  '',
  'WHAT A GAP ACTUALLY IS. A gap is a HOLE IN THE RECORD, not an unanswered message. Asking',
  'somebody is just the usual way to fill it — it is not what the gap is for. So the question to',
  'ask yourself is never "did they reply to me", it is "is the hole still there". If the hole is',
  'filled, the gap is done, no matter who filled it or whether anyone ever replied. Chasing a',
  'person for something the records already contain wastes their time and makes the assistant look',
  'like it is not paying attention.',
  '',
  'For each gap you choose ONE action:',
  '  send     — it should go out now.',
  '  hold     — it should wait. Say until when.',
  '  close    — it has been answered. You MUST quote the words that answered it.',
  '  escalate — the person has had their chance; a manager should take it over.',
  '',
  'WHAT EACH ACTION CAN DO, AND WHEN. Every gap tells you its `state`, and the state decides which',
  'actions are even possible:',
  '  state "pending" — nothing has gone out yet. send and hold both work here.',
  '  state "queued"  — the question is written and waiting to be delivered. Leave it alone.',
  '  state "asked"   — the question is already with the person. Only close and escalate mean',
  '                    anything now; there is no way to ask again.',
  'To give somebody more time, simply DO NOT NAME the gap. Leaving it alone is how waiting is',
  'expressed, and it is a real choice rather than a missing one. Choosing send or hold on a gap',
  'that has already gone out will be refused and nothing will happen to it.',
  '',
  'THE TWO WAYS A GAP CLOSES. Every close needs a `basis`, and there are exactly two:',
  '',
  '  basis "record" — the hole is filled. Some gaps come with a line beginning THE RECORD, which',
  '    tells you what the records themselves say. When that line says the hole is closed, close',
  '    the gap with basis "record" and do not chase anyone. You do not need a quote and you must',
  '    not invent one; the system already knows this and will refuse the basis if it is not true.',
  '',
  '  basis "evidence" — somebody answered. Use this when a person\'s own words fill the hole.',
  '    Copy the exact words, verbatim, into `citation`. Do not paraphrase and do not summarise —',
  '    the system checks your quote against what actually landed and refuses a quote it cannot',
  '    find.',
  '',
  'HOW TO JUDGE AN ANSWER. Evidence closes a gap only when it answers THE QUESTION THAT WAS ASKED.',
  'Activity on the job is not an answer: a note about something else, a status change, a visit',
  'being logged, or somebody promising to write it up later — none of those fill the hole. A',
  'promise is not a figure. If you are not sure, leave it open. An open gap gets asked again and',
  'someone is mildly annoyed; a wrongly closed gap is a hole in the record that nobody ever',
  'notices. Those are not equally bad.',
  '',
  'HOW TO PACE. Earn the ask. Before bothering someone, consider whether the answer is already',
  'somewhere you can look. Short, quick jobs go stale fast — chase those sooner. A cost figure',
  'does not decay, but it blocks the books, so it can wait hours and should not wait days. Someone',
  'who has just been asked something should usually be given room to answer it before being asked',
  'again. When several gaps belong to the same person, think about which one actually matters',
  'today.',
  '',
  'WHEN TO GIVE UP. If a gap was asked and has gone genuinely unanswered, escalate it. Escalating',
  'is the LAST thing you do with a gap: it hands the gap to a manager, and once the handover goes',
  'through the gap leaves your list for good. So if you see you have escalated a gap already,',
  'leave it alone — the handover is in motion and there is nothing further for you to do. Do not',
  'try to close it: closing needs either an answer to quote or a record that has been filled, and',
  'a gap nobody answered has neither.',
  '',
  'YOUR MEMORY. You have done this before — every thirty minutes, all day — and you remember none',
  'of it. Your decisions are written down, and `recall_decisions` is how you read them back. Any',
  'gap you have decided about before carries a `prior decisions` line saying how many times and',
  'what you last did. When that line is there, READ THE HISTORY before deciding again — above all',
  'before escalating, which hands the gap to a person and cannot be taken back. Call it with the',
  'gap id, or with the job id to see every gap on that job at once. A decision recorded as',
  '"refused" did not happen: making the same one again will fail the same way, so read why.',
  '',
  'CONTEXT. You can read the firm\'s own records with spine_read when it would change your',
  'decision — what the job is, what has been billed, what else is open for that person. Do not',
  'browse. Each gap gives you its JOB ID: filter by that id, never by searching on a customer or',
  'job name. Name searches miss and cost you a turn. Every date you need is in the text below;',
  'never work one out yourself.',
  '',
  'When you have decided, call submit_plan ONCE with one entry per gap. Gaps you do not name are',
  'left exactly as they are, which is a fine choice.',
].join('\n');

// The terminal tool: calling it IS the answer, and it ends the loop.
export const SUBMIT_PLAN_TOOL: ForcedToolSpec = {
  name: 'submit_plan',
  description:
    'Deliver your decisions. Call this ONCE, at the end, with one entry per gap you have decided ' +
    'about. Omit any gap you want left alone.',
  inputSchema: {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        description: 'One entry per gap you are deciding about.',
        items: {
          type: 'object',
          properties: {
            nudgeId: {
              type: 'string',
              description: 'The gap id, copied exactly from the list you were given.',
            },
            action: {
              type: 'string',
              enum: ['send', 'hold', 'close', 'escalate'],
              description: 'What should happen to this gap.',
            },
            notBefore: {
              type: 'string',
              description:
                "For 'hold': the UTC instant to wait until, ISO-8601 (e.g. 2026-08-20T15:00:00Z). " +
                'Required for hold, ignored otherwise.',
            },
            basis: {
              type: 'string',
              enum: ['record', 'evidence'],
              description:
                "Required for 'close'. Use 'record' when the gap's THE RECORD line says the hole " +
                "is already filled — no quote needed. Use 'evidence' when a person's own words " +
                'fill it, and put those words in `citation`.',
            },
            citation: {
              type: 'string',
              description:
                "For 'close' with basis 'evidence': the EXACT words that answer the question " +
                'asked. Verbatim, not a summary. A quote the system cannot find in the evidence ' +
                'refuses the close and the gap stays open. Not needed for basis "record".',
            },
            confidence: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description:
                'How sure you are. Low is a real and useful answer — it flags the decision for a ' +
                'human to look at rather than hiding a guess.',
            },
            reason: {
              type: 'string',
              description:
                'One short sentence, for the humans reading the log. Say what you decided and ' +
                'why, in plain words.',
            },
          },
          required: ['nudgeId', 'action', 'confidence', 'reason'],
        },
      },
    },
    required: ['decisions'],
  },
};
