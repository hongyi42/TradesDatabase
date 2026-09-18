---
date: 2026-09-14
task: the link views expose basis_reason but carry no retracted flag, so a retracted message's model reasoning stays visible
status: complete
origin: 20260912-the-model-names-the-job-on-the-ambiguous
files: src/db/jobs.ts, src/db/visits.ts, src/mcp/server.ts, supabase/migrations
supersedes: nothing
---

## Files

- src/db/jobs.ts
- src/db/visits.ts
- src/mcp/server.ts
- supabase/migrations

(`src/db/jobs.ts` and `src/db/visits.ts` added at promotion review, 2026-09-14: the pre-edit hook
matches exact file paths, so `supabase/migrations` (a directory) attaches to nothing, and
`src/mcp/server.ts`'s slots are full. The chooser plan's Phase 3 edits both files to write `basis`.)

## Notes

Found in plan review of 2026-09-11-the-model-names-the-job, 2026-09-14. Does not exist until that
plan's `link_basis` migration lands; parked now so it is decided with it, not after.

That plan adds `basis_reason` to `job_captures` and `visit_notes` and appends it to `v_job_captures` /
`v_visit_notes`. The text is the model's own sentence about a customer's message — e.g. "the message is
about the dripping kitchen tap". `v_captures` carries `retracted` and `retraction_reason`, and the
query_spine catalog tells the planner "retracted=true means a manager withdrew that row — never treat
it as a current fact". The link views have no such flag.

So when a manager retracts a message, the words themselves are correctly marked in `v_captures`, but
the model's paraphrase of them stays readable, unmarked, on the link — a second channel around the
retraction.

Options: add `retracted` to both link views by joining the capture's retraction state; or have the
query_spine catalog tell the planner to join `v_captures` before quoting a `basis_reason`. The first is
the wall-in-the-view posture the tenant checks already use.

## Decisions

OPERATOR, 2026-09-14 (board triage, plan 2026-09-14-the-task-board-is-the-operators Phase 3):
FLAG IN THE VIEWS. `v_job_captures` and `v_visit_notes` each carry a `retracted` column derived from
the linked capture's retraction state, so the warning sits on the same row as `basis_reason` and does
not depend on the planner remembering to join `v_captures`. REJECTED: a query_spine catalog
instruction alone (relies on the model, every time). Flag, not blank, matches `v_captures`, which
keeps a retracted row readable and marked; blanking the reason was named as a stricter variant and
not chosen.
WHERE IT IS BUILT: in the chooser plan (thoughts/shared/plans/2026-09-11-the-model-names-the-job.md),
inside the same `link_basis` migration that adds `basis_reason`. That plan causes the gap, so under the
2026-09-14 doctrine it is that plan's work, not a board item. Recorded in the active task
20260912-the-model-names-the-job-on-the-ambiguous via `work.mjs handoff --cwd`.
