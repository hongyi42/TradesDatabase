---
date: 2026-08-30
task: Retire gap_summaries — the store whose only reader died with the Reflector
research: thoughts/shared/research/2026-08-30-per-object-notepads-on-the-spine.md
status: complete
supersedes: nothing
---

**On `supersedes`.** No decision is overturned, but this **retires** the ⑤ Phase-2 gap-summary sweep
(`supabase/migrations/20260824000000_gap_summaries.sql`, plan 2026-08-23) — not a reversal of its
reasoning. That table was built as the Reflector's reading material, and build 3 deleted the
Reflector. Evidence in the research doc: `listRecentSummaries` and `countSummaries` now have **zero
callers** in `src/` or `scripts/`, while the lifecycle keeps writing one row per closed gap every
tick.

**Split from `thoughts/shared/plans/2026-08-30-job-notepads.md`**, which was over the 300-line
guidance. The two changes are independent — dropping this table does not depend on notepads existing
— so they are separate plans and separate PRs.

## Overview

Delete a write path with no reader: the `gap_summaries` table, the sweep that fills it, its lifecycle
step, and the eval epilogue that graded it.

## Decisions

- **Dropped rather than given a reader** — user, 2026-08-30, over the two costs named at decision
  time. **What is lost:** `manager_fate` (what the manager actually did with an escalation) and
  `working_hours_open` were pre-computed rollups, and the 7-day holdback that made `manager_fate`
  trustworthy goes with them. **What survives:** the underlying facts. `v_review_items` still exposes
  `status`, `resolution` and `escalated_from_nudge`, and `nudge_decisions` holds every decision — so
  escalation outcomes stay derivable live. Only the rollup goes.
- **`CLOSED_NUDGE_STATUSES` was to move to `src/db/nudges.ts` — it was DELETED instead.** The plan
  moved it because `src/eval/plannerSim.ts:46` needed it; review then pointed out that its only use
  was inside the epilogue **this same change deletes**, leaving it with zero callers. A relocated
  constant whose comment names a caller that no longer exists is exactly the residue this retirement
  exists to remove. `NudgeStatus` already documents all seven statuses.
- **`findItemForNudge` (`src/db/reviewItems.ts`) is deleted too** — collateral the plan did not
  predict. Its only caller was the deleted sweep. `reviewItemExistsFor` survives (compose.ts and
  control/nudgeQueue.ts call it) and **keeps the terminal-failure doctrine paragraph**, which the
  first attempt at this deletion removed by accident — git shows the paragraph predates
  `findItemForNudge` and documents `reviewItemExistsFor`.
- **The epilogue's real cost is an OBSERVATION, not grading** — corrected after the final review
  caught the same false claim repeated in three comments. The deterministic graders are pure
  functions over the results row (`plannerEvalGraders2.ts:1-3`) and read only `decisions`,
  `toolCalls` and `nudgesAfter` — never `review_items`, never a database. So no expectation was
  ever graded from a gap summary and none is ungraded now. What IS lost: `manager_fate` was
  surfaced into the results file by the epilogue and **nowhere else**, so a scenario ending in a
  manager `resolved` now produces the same eval output as one ending `dismissed`. Recorded in
  `plannerSim.ts`, `plannerSim.test.ts` and `plannerCorpus.ts` rather than fixed.
- **The drop must be applied AFTER the code, never before.** The old lifecycle's step 11 reads
  `nudges` with a PostgREST embed on `gap_summaries`; with the table gone that returns PGRST200,
  which is not in `MISSING_LEDGER_CODES`, so `isMissingCostLedger` answers false and the cron goes
  red on every tick forever. The step's own comment promised "missing table → skipped, never red";
  that was never true for an embed. Written into the migration header.
- **`drop table` with NO `cascade`.** Verified: the four planner-metrics views
  (`20260823230000`, `20260824020000`) touch only `nudges`, `nudge_decisions`, `review_items`,
  `raw_captures`, `visits`, `tenants`. If a dependant HAS appeared since, this must fail loudly
  rather than quietly take it along.
- **The pilot is not migrated by this plan** — standing ruling: nothing reaches production until the
  whole harness-rebuild build order is done and evaluated. The drop is applied locally only; the
  pilot still carries the table.

## Plain-language walkthrough

When a gap finished, a background sweep wrote one row recording how it went — what it was about, how
long it stayed open, how many times the planner considered it, and what the manager did with any
escalation. Those rows existed to be read by the Reflector, which distilled them into lessons. Build
3 deleted the Reflector. Nothing has read them since, and the sweep still runs every tick.

This removes the sweep, the table, and the eval's end-of-scenario grading that leaned on it.

## Secrets & env preflight

- **Phase 1:** none. `REFLECTOR_MODE` is already gone (build 3); no deployed service variable
  changes.

## Phase 1: Delete the sweep and its store

### What this phase does
Removes the table, its typed layer, the sweep, the lifecycle step and the eval epilogue.

### Changes required

**Deleted:** `src/db/gapSummaries.ts`, `src/jobs/summarize.ts`, `src/jobs/summarize.test.ts`.

**`supabase/migrations/20260831130000_drop_gap_summaries.sql`** — `drop table gap_summaries;`, no
`cascade` (see Decisions). Header records what was given up and where the underlying facts still are.

**`src/db/nudges.ts`** — no change in the end (see Decisions: `CLOSED_NUDGE_STATUSES` was deleted
rather than relocated, once review showed it had no remaining caller).

**`src/db/reviewItems.ts`** — delete `findItemForNudge`; its only caller was the deleted sweep.

**`src/jobs/lifecycle.ts`** — remove the import (`:15`), `summarize?` (`:83`), the `gapSummaries`
field (`:119`), step 11 (`:592-600`) and `gapSummaries,` from the return object (`:620`).

**`src/eval/plannerSim.ts`** — remove **both** imports: `runGapSummaries` / `SummarizeSummary` from
`../jobs/summarize.js` (`:45`) and `GapSummary` from `../db/gapSummaries.js` (`:46`), keeping
`CLOSED_NUDGE_STATUSES` from its new home. Remove the whole `epilogue` type block (`:618-622`, both
fields) and the epilogue that builds it (`:770-809`). `ArcRecord.epilogue` goes with it.

**Tests and scripts that break:** `src/eval/plannerSim.test.ts:271-350` (the arc test asserting
`arc.epilogue.summaries`); `scripts/agentic-eval/run.mjs:259` (`row.epilogue = arc.epilogue`) and
`:265` (the `summaries: N` log line).

**`src/jobs/lifecycle.test.ts:996` will NOT break, and that is the hazard.** There is no
summarize-gate describe; the only reference is a `gapSummaries: { skipped: 'x' }` key in a fixture
cast `as unknown as Parameters<typeof redactForRecord>[0]`, so removing the field from
`LifecycleSummary` leaves it typechecking silently. Delete the key by hand — nothing will remind you.

**Two comments go stale and must be corrected:** `src/eval/plannerCorpus.ts:35` cites
`summarize.ts:118-124`, a deleted file; `:75` says an arc is judged "over ALL executed ticks + the
epilogue", and there is no epilogue after this.

**Cleanup lists** — remove `gap_summaries` from `scripts/seed.mjs:173-179`,
`scripts/spine-eval/world.mjs` (both lists, `:137` and `:201`) and `scripts/agentic-eval/run.mjs`
`RESET_TABLES` (`:134`).

**`docs/engineering-memory.md`** — record the retirement, and explicitly what was given up:
`manager_fate` was the only pre-computed answer to "does escalating work at this firm", and the
7-day holdback that made it trustworthy goes with it.

### Automated verification
- [x] `npx supabase db reset`, `npm run gen:types:local`, then `npx tsc --noEmit`, `npm run lint`,
      `npm test`, `npm run build` pass
- [x] `grep -rn "gap_summaries\|GapSummary\|runGapSummaries\|HOLDBACK_DAYS" src scripts supabase`
      returns **no live code**. The deliberate tombstone comments that WILL remain, enumerated so the
      check is unambiguous: `src/db/lifecycleRuns.ts:12`, `src/jobs/workingHours.ts:15`,
      `src/teamLead/compose.ts:38`, `src/teamLead/planner.ts:1849`, three migration headers, and the
      four tombstones this change itself writes (`src/jobs/lifecycle.ts`, `src/eval/plannerSim.ts`,
      `src/eval/plannerSim.test.ts`, `src/eval/plannerCorpus.ts`)
- [x] the planner-metrics report still runs **against the LOCAL stack**, after the reset applies the
      drop: `node -r dotenv/config scripts/planner-metrics/report.mjs dotenv_config_path=.env.test`.
      **Not `npm run metrics:planner`** — that resolves `DATABASE_URL` from `.env`, which is the
      pilot, where the table still exists, so it would prove nothing about the drop
- [x] `npm run decisions:index` regenerated and committed

### Live verification (agent-executable)
- Prerequisites: `.env` (`DATABASE_URL`) — already required by every `scripts/` tool. **Read-only.**
- [x] Confirm read-only against the pilot that nothing depends on `gap_summaries` before the drop is
      ever applied there — query `pg_depend` / `pg_rewrite` / `pg_constraint` for dependants.
      Evidence: the query output showing zero rows. The pilot is NOT migrated by this plan.
      **Run 2026-08-30, read-only against `daqapdlkgxfrhquacprv`:** table present, **0 view/rule
      dependants, 0 inbound foreign keys**. The no-cascade drop will succeed there when it is
      eventually applied. Nothing was written. Locally, after the drop, the planner-metrics report
      runs clean and all four `mv_*` views survive — the check that the drop took nothing with it.

### Manual verification — none

---
*The plan is complete when Phase 1's checks pass.*
