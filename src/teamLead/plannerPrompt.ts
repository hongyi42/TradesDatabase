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
  'For each gap you choose ONE action:',
  '  send     — it should go out now.',
  '  hold     — it should wait. Say until when.',
  '  close    — it has been answered. You MUST quote the words that answered it.',
  '  escalate — the person has had their chance; a manager should take it over.',
  '',
  'HOW TO JUDGE AN ANSWER. A gap is answered only by evidence that answers THE QUESTION THAT WAS',
  'ASKED. Activity on the job is not an answer: a note about something else, a status change, a',
  'visit being logged — none of those close a gap about parts costs. If you are not sure, leave it',
  'open. An open gap gets asked again and someone is mildly annoyed; a wrongly closed gap is a',
  'hole in the record that nobody ever notices. Those are not equally bad.',
  '',
  'CITE OR DO NOT CLOSE. To close a gap, copy the exact words from the evidence that answer it,',
  'verbatim, into `citation`. Do not paraphrase and do not summarise — the system checks your',
  'quote against what actually landed, and a quote it cannot find refuses the close. If nothing',
  'in the evidence answers the question, do not choose close, however obvious it seems.',
  '',
  'HOW TO PACE. Earn the ask. Before bothering someone, consider whether the answer is already',
  'somewhere you can look. Short, quick jobs go stale fast — chase those sooner. A cost figure',
  'does not decay, but it blocks the books, so it can wait hours and should not wait days. Someone',
  'who has just been asked something should usually be given room to answer it before being asked',
  'again. When several gaps belong to the same person, think about which one actually matters',
  'today.',
  '',
  'WHEN TO GIVE UP. If a gap was asked and has gone genuinely unanswered, escalate it. If it has',
  'already been escalated and is still unanswered, close it — the record will stay incomplete, and',
  'that is the honest outcome; say so in `reason` and mark your confidence low. Job records stay',
  'editable afterwards, so a closed gap is not a lost one.',
  '',
  'CONTEXT. You can read the firm\'s own records with spine_read when it would change your',
  'decision — what the job is, what has been billed, what else is open for that person. Do not',
  'browse. Every date you need is in the text below; never work one out yourself.',
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
            citation: {
              type: 'string',
              description:
                "For 'close': the EXACT words from the evidence that answer the question asked. " +
                'Verbatim, not a summary. A quote the system cannot find in the evidence refuses ' +
                'the close and the gap stays open.',
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
