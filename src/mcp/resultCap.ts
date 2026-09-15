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

// The serialized result, unchanged when it fits; otherwise a small, still-valid
// JSON object that says how big it was, that it was cut, and how to ask for
// less. The object as a whole fits the limit — `partial` is the longest head
// of the original text whose ESCAPED form still fits, because quoting the
// already-serialized text inside a string doubles its quotes and backslashes
// (review finding: a plain slice at `cap` produced ~25k characters against a
// 20k limit).
//
// `carry` holds the hub's decorations — the `now` rider, the board link and
// its instruction — which sit at the END of a serialized result and so would
// be the first thing a cut drops. They ride on the cut object itself instead.
//
// A cap of 0 disables the backstop (an operator's explicit choice, never the
// fallback). A cap too small for even the envelope returns the envelope with an
// empty `partial`: the announcement matters more than the limit at that size.
export function capToolResult(
  text: string,
  cap: number = resultCapChars(),
  carry: Record<string, unknown> = {},
): string {
  if (cap <= 0 || text.length <= cap) return text;
  const envelope = (partial: string): string =>
    JSON.stringify({
      truncated: true,
      chars: text.length,
      limit: cap,
      note:
        `This result was ${text.length} characters, over the ${cap}-character limit, and was cut. ` +
        'Ask for less: one job, one page (`before`), one note (get_capture), or search_captures.',
      ...carry,
      partial,
    });
  // Binary search on the head length: escaping only grows a string, so the
  // envelope's length is monotone in the head's length.
  let lo = 0;
  let hi = Math.min(text.length, cap);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (envelope(text.slice(0, mid)).length <= cap) lo = mid;
    else hi = mid - 1;
  }
  return envelope(text.slice(0, lo));
}
