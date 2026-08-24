// The two code-owned string guards that outlived compose (the collapse, plan
// 2026-08-24). Compose's prompts, its context readers and its message-assembly
// templates all retired with its model call: the PLANNER now writes the whole
// delivered message and queues it verbatim. What remains here is trust-boundary
// hygiene that other callers still need.
//
// The file keeps its name and path deliberately — reflector.ts, lessons.ts and
// control/nudgeQueue.ts import from it, and a rename would churn them for
// nothing.

export const flatten = (s: string, max: number): string =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

// The RETIRED footer's seam (④b Phase 5, 2026-08-23): assemble no longer
// writes a footer — stored is shown — but the outbox (control/nudgeQueue.ts)
// still strips on exactly this string so LEGACY queued rows, composed before
// the retirement deploy, serve clean. Compose's guard and cleanQuestionDraft
// still refuse model text containing the phrase (the register stays
// code-owned even though code no longer uses it), and `flatten` still
// collapses newlines in every embedded field, so the delimiter can never
// occur in a post-retirement deliverable at all.
export const FOOTER_DELIMITER = '\n\nNote for the assistant:';
