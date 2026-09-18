---
date: 2026-09-12
task: the model names the job: on the ambiguous branch a chooser picks one of the customer's jobs, or says none, and records why
status: complete
origin: 20260911-a-new-promise-to-a-known-customer-is-fil
files: src/writePath/recordFieldNote.ts, src/writePath/recordFieldNote.test.ts, src/db/jobs.ts, src/db/database.types.ts, docs/onboarding.md, thoughts/shared/plans/2026-09-11-the-model-names-the-job.md, thoughts/shared/plans/2026-09-14-a-reply-keeps-the-models-doubt.md, scripts/extract-eval/corpus.mjs, scripts/extract-eval/run.mjs
supersedes: nothing
---

## Files

- src/writePath/recordFieldNote.ts
- src/writePath/recordFieldNote.test.ts
- src/db/jobs.ts
- src/db/database.types.ts
- docs/onboarding.md
- thoughts/shared/plans/2026-09-11-the-model-names-the-job.md
- thoughts/shared/plans/2026-09-14-a-reply-keeps-the-models-doubt.md
- scripts/extract-eval/corpus.mjs
- scripts/extract-eval/run.mjs

## Notes

JOB. The spec is the plan: thoughts/shared/plans/2026-09-11-the-model-names-the-job.md (status: draft
— it is the human review gate, so approve it before /implement). To be CLAIMED in the new-promise
worktree (user, 2026-09-12), not spawned.

WHAT. The door-stops-guessing work (#235) made the door give up when a known customer has several
non-terminal jobs and nothing names which one a message is about: it files under the customer and
asks only if a promise was made. This adds one bounded model call on that branch alone: shown the
message and the candidate jobs, it names one or says none. Customer identity stays deterministic
code; only the JOB dimension crosses the model line (user decision 2026-09-11), so
docs/onboarding.md:129 ("never a model guess") must be amended in the same commit.

TWO REVIEW DECISIONS added to the plan 2026-09-12 — resolve both before Phase 2:
  1. RECORD THE BASIS. A chooser-picked link must not look identical to a thread-named one: write
     `basis = 'chooser'` plus the model's own `reason` (JobChooser already returns it; the original
     Phase 2 discarded it). job_captures has no room today — (tenant_id, job_id, capture_id,
     created_at) — so this needs a NEW migration adding two nullable columns, appended to
     v_job_captures. Recommended, not yet approved.
  2. THE STATUS FLIP — verified on main, not inferred. The ambiguous branch RETURNS EARLY at
     recordFieldNote.ts:632-636, and that return is how the 2026-09-12 "leave it to the planner"
     ruling removed the statusSignal write; statusSignal is applied only at :901-906. The plan's
     "fall through to the normal path" would land a chooser pick straight on it. (a) allow the flip,
     with the basis recorded; or (b) skip statusSignal for a chooser pick. (b) matches the ruling.

DELIBERATELY NOT IN files: (not on origin/main yet, so naming them would break a spawn's check):
src/writePath/chooseJob.ts and its test, and supabase/migrations/<timestamp>_job_captures_basis.sql.
Also touched per the plan: docs/engineering-memory.md (the amendment and its bound).

RELATED:
  [[20260912-an-l2-status-flip-reports-to-the-planner]] — its touch-report says "on what evidence,
    how sure"; decision 1 is what gives it something true to say for a chooser-filed capture.
    Same file (recordFieldNote.ts), DIFFERENT REGIONS, so the two CAN run in parallel and git
    merges them. The dependency is a DECISION, not code: settle this plan's two review decisions
    (basis + status flip) BEFORE the flip task designs its report, then run both. (Corrected
    2026-09-12 — an earlier version of this line said never to run them together; that overstated
    it.)
  [[20260912-the-ambiguity-ask-names-candidate-jobs-b]] — the ask that names candidates but no tool
    can act on the manager's pick.
  [[20260912-rung-10c-a-seat-s-inform-wakes-the-plann]] — `overlap` reports NONE; safe in parallel.

OPEN FROM THE PLAN: the latency budget is unmeasured — Phase 1 records p50/p95 before Phase 2 wires
anything in. Live checks need .env with INFERENCE_API_KEY / OPENROUTER_API_KEY (a fresh worktree has
none, and key-gated checks then skip silently).

HOUSEKEEPING OWED: the plan amendment is UNCOMMITTED in the new-promise worktree. Commit it with
`npm run decisions:index` and the regenerated index files, per CLAUDE.md.

## Handoff 2026-09-14T22:13:35.552Z

OPERATOR DECISION, 2026-09-14 (board triage from task 20260914-the-task-board-is-the-operator-s-a-sessi):
the retracted-basis_reason gap is THIS plan's work, not a board item.

FLAG IN THE VIEWS. The `link_basis` migration in thoughts/shared/plans/2026-09-11-the-model-names-the-job.md
must also give `v_job_captures` and `v_visit_notes` a `retracted` column derived from the linked
capture's retraction state (the same state `v_captures` exposes as retracted / retraction_reason), so
a manager's retraction marks the model's `basis_reason` paraphrase on the same row. Flag, not blank:
it matches `v_captures`. REJECTED: only telling the planner in the query_spine catalog to join
v_captures first.

Action for this session: amend the plan's "Parked, not fixed" bullet (plan :68) and add the column,
with a test that a retracted capture's link row reads retracted=true, to the phase that writes the
migration. The finding 20260914-the-link-views-expose-basis-reason-but-c is closed and promoted.

## Handoff 2026-09-14T22:58:20.359Z

CORRECTION + BOARD CHANGES, 2026-09-14 (from task 20260914-the-task-board-is-the-operator-s-a-sessi):
- The previous handoff sends you to "plan :68" for the "Parked, not fixed" bullet. At 5a6881b that
  bullet is at :96 (:68 is "A REPLY CARRIES THE DOUBT FORWARD"). The decision stands: add `retracted`
  to v_job_captures / v_visit_notes in the link_basis migration, with a test.
- That same bullet cites two ids that are now CLOSED:
  * 20260914-the-link-views-expose-basis-reason-but-c — decided (flag in the views, above) and
    promoted; the build is THIS plan's.
  * 20260914-listjobsforcustomer-orders-on-created-at — folded into the approved, unspawned task
    20260914-fix-the-small-board-findings-listjobsfor (it will add an id tiebreak to
    listJobsForCustomer in src/db/jobs.ts). Your plan's pin-the-shown-list design does not depend
    on it, but that task and this one both touch src/db/jobs.ts and src/writePath/recordFieldNote.ts.
- 20260912-the-ambiguity-ask-names-candidate-jobs-b is archived (its "cannot be closed" premise was
  wrong: the planner closes inbound items itself); its leftover, a verb to file a customer-level
  capture onto a job, went to rung 10d. 20260912-an-ambiguous-non-commitment-reply-is-inv went to the
  status-flip task. Neither changes this plan.

## Handoff 2026-09-18T05:30:20.002Z

**What changed** — The extractor reads short operational replies correctly now, and that is the
whole of what shipped (PR #258). Measured on 12 hand-written fixtures x 10 live calls: `committed`
102/120 -> 120/120, `skips` 106/120 -> 120/120, `status` 114/120 -> 110-120/120. Three prompt
clauses moved: `touchesOperations` lost "an acknowledgement" from its exemption list (it matched on
FORM - "Thursday works." was skipped in 9 runs of 10); `statusSignal` gained "arranging a visit is
not work underway" in both directions (the firm agreeing a date was returning `in_progress`, and
`open -> in_progress` is a permitted transition, so it flipped jobs to work-underway before anybody
had been out); `visitCommitted` was rewritten to operator ruling B. New: `scripts/extract-eval`
(corpus v4), a script and deliberately NOT a test - `vitest.config.ts` + `src/test.setup.ts` would
bill ~30 live calls on every `npm test` in a keyed checkout. IN PLACE along the way: the forced-tool
SCHEMA descriptions, which ride in the same request as the system prompt and still asserted the
reading ruling B replaced, with two suite pins enforcing the old wording - so the next person to fix
the description would have gone red and reverted.

**Decisions** — (1) COMMITMENT IS "A VISIT IS NOW AGREED", whoever said so (operator, option B).
Rejected: "is THIS message the firm agreeing", whose hole is the commonest booking flow there is -
the firm offers a slot (not agreement), the customer accepts (not the firm speaking), and neither
message ever raises an ask. B over-tells and the system has rails for over-telling; it has none for
a promise nobody raised. (2) `status` DOES NOT GATE: the planner reads job history before declaring
a flip. (3) PHASE 5 BEFORE PHASE 2, and its target was the SKIP not the commitment (operator: a
firm that accepts a visit "will probably create it through UI or their seat agent anyways", but "if
an L2 change is ignored, that might get picked up much later"). (4) PHASES 2-4 ABANDONED - the
feature this branch was named for. Phase 2 was built, measured and reverted the same day; Phase 3
moved to rung 10d; Phase 4 dropped outright (its premise was that a MODEL's pick masquerades as
grounded evidence on a later reply - a planner's pick is the planner's own decision). Two reasons:
the PREMISE EXPIRED (the retrieval layer, landed one day earlier, ships
`capture_scope_members(tenant,'customer_level',customerId)` surfaced as `customerLevelNotes` on
`get_customer_context`, so the planner can already SEE a capture attached to no job - operator: "it
was just never explicitly asked to. Which is an attention issue"), and the EXTRACTOR CANNOT ANSWER
THE HARD HALF (10/10 where the words name the job, but "your engineer finished the repair this
morning" picked the BOILER 7/10 reasoning "matching the OPEN boiler diagnostic" - it is shown titles
and statuses and deliberately no dates, so that shape is resolvable only from the schedule). The
line: the door links what identity PROVES, the planner links what judgment DECIDES.

**Assumptions** — That `status` 110-120/120 is acceptable: `long-thread-accept` answers
`in_progress` on a thread about sourcing parts, and it drifted 10/10 -> 7/10 -> 3/10 -> 1/10 across
runs as the commitment clause landed. Operator accepted ("we don't have to get perfect numbers").
That one un-tested branch is safe: the pre-match's try/catch throw arm has NO test - both reads are
plain selects with no injection point and manufacturing a throw needs a module mock in a file that
has none. That the eval's model is production's: grounded structurally (`toolLoop.ts` and
`forcedTool.ts` share one `INFERENCE_MODEL`) and empirically (the pilot's no-lane cost rows are
glm-5.3), not assumed.

**Open** — PR #258 awaiting review; integrate clean both sides, gates green on the merge.
UNFIXED, found here and outside this task's files: `src/db/opsEvents.ts:99` computes `openMs` by
subtracting `opened_at` (the DATABASE's `now()` default, `20260813000000_ops_events.sql:37`) from
`closedAt` (`new Date()` on the HOST), so it goes negative when the container clock leads. It
surfaced once as `opsEvents.test.ts` "expected -70 to be greater than or equal to 0" and passed on
re-run; latent in production, where the database and the web service are different machines. The fix
is a choice - have the database stamp `closed_at`, or compute the duration in SQL - so it was asked,
not parked. NOT GRADED by the eval, deliberately: a thank-you whose quoted tail carries the firm's
promise (the prompt's "when in any doubt, leave it true" makes `touchesOperations: true` correct
there, so scoring it would manufacture a failure), and the internal tension it creates - "a visit
agreed in an earlier message is already handled" vs "quoted history is never read as already
handled" - which on a quoted PROMISE yields a DUPLICATE ask. Accepted as ruling B's chosen
direction; recorded beside the clause.

**Downstream** — Rung 10d (`20260912-rung-10d-the-planner-writes-l2-and-the-d`) now carries this
question as a PLACE (the unattached backlog in the planner's tick - never an observation per
capture, or every routine email from a two-job customer becomes an item to dismiss) plus the VERB it
already owned, and inherits Phase 3's `basis`/`basis_reason` provenance columns. Its FOLDED IN
section has the full brief.
`20260915-the-extractor-tags-each-inbound-capture` is sequenced behind 10d and was going to copy
this plan's provenance shape - it should now copy 10d's. It also adds a field to the SAME
`EXTRACTION_TOOL` this task just rewrote: the prompt is read WHOLE, so it must re-run
`scripts/extract-eval` after its edit, and the corpus header says how.
`docs/onboarding.md:129` ("identity is never a model guess") was NEVER amended and no longer needs
to be - nothing crossed the model line in the end.
