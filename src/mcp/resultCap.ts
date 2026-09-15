// The size cap at the door (plan 2026-09-15-the-retrieval-layer-1, Phase 4).
//
// A tool result is model INPUT: it lands in the seat's context window and is
// re-sent on every later call in that session. Nothing on the delivery path —
// the hub, the doorman relay, the gateway — bounded it, so one read of a
// long-standing customer could flood a technician's window (the trigger for
// the whole retrieval-layer task). Every reader now returns a fixed-size
// result by construction; this is the backstop for the ones that do not yet,
// and for mistakes. Overflow is ANNOUNCED, never silent (the failure this repo
// keeps re-learning: a result that reads complete and is not).
import { safeEnvInt } from './tools/shared.js';

// The planner's tool loop uses the same figure (src/model/toolLoop.ts
// MAX_TOOL_RESULT_CHARS): generous enough for a full page of notes, small
// enough that a runaway result cannot blow the window.
export const DEFAULT_RESULT_CAP_CHARS = 20_000;

// Read PER CALL, never at module load (the leanGrounding precedent): a test
// toggles it around one call, and an operator can change it without a build.
// A malformed value falls back to the default rather than disabling the cap.
export const resultCapChars = (): number =>
  safeEnvInt(process.env.SPINE_RESULT_CAP_CHARS, DEFAULT_RESULT_CAP_CHARS);

export interface CappedResult {
  truncated: true;
  chars: number;
  limit: number;
  note: string;
  partial: string;
}

// The serialized result, unchanged when it fits; otherwise a small, still-valid
// JSON object that says how big it was, where it was cut, and how to ask for
// less. `partial` is the head of the original text — enough for the model to
// see what it was looking at, not enough to flood it. A cap of 0 disables the
// backstop (an operator's explicit choice, not a default).
export function capToolResult(text: string, cap: number = resultCapChars()): string {
  if (cap <= 0 || text.length <= cap) return text;
  const capped: CappedResult = {
    truncated: true,
    chars: text.length,
    limit: cap,
    note:
      `This result was ${text.length} characters, over the ${cap}-character limit, and was cut. ` +
      'Ask for less: one job, one page (`before`), one note (get_capture), or search_captures.',
    partial: text.slice(0, cap),
  };
  return JSON.stringify(capped);
}
