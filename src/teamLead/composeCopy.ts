// What survived compose (the collapse, plan 2026-08-24): ONE constant. Compose's
// prompts, its context readers and its message-assembly templates all retired
// with its model call — the PLANNER now writes the whole delivered message and
// queues it verbatim.
//
// `flatten` lived here too until build 3 (plan 2026-08-30). Its last two
// production callers were lessons.ts and reflector.ts, both deleted with the
// lesson machinery, and it is NOT the successor for the planner's memory:
// `escapeForPrompt` in src/teamLead/memory.ts is, and it deliberately PRESERVES
// newlines, which is the one thing flatten existed to destroy. A shared helper
// with no callers and a comment naming three is worse than no helper.
//
// The file keeps its name and path deliberately — control/nudgeQueue.ts imports
// the delimiter below, and a rename would churn it for nothing.

// The RETIRED footer's seam (④b Phase 5, 2026-08-23): assemble no longer
// writes a footer — stored is shown — but the outbox (control/nudgeQueue.ts)
// still strips on exactly this string so LEGACY queued rows, composed before
// the retirement deploy, serve clean. Compose's guard and cleanQuestionDraft
// still refuse model text containing the phrase (the register stays
// code-owned even though code no longer uses it).
//
// The old sentence here credited `flatten` with collapsing newlines in every
// embedded field, "so the delimiter can never occur in a post-retirement
// deliverable at all". The GUARANTEE still holds; the guard moved. `flatten`
// was deleted in build 3, and the rail that actually crosses every planner-
// written string is `cleanPlannerText` (src/teamLead/planner.ts) — which strips
// C0 controls and collapses whitespace runs exactly as flatten did, and which
// `cleanQuestionDraft` layers the footer-phrase refusal on top of.
export const FOOTER_DELIMITER = '\n\nNote for the assistant:';
