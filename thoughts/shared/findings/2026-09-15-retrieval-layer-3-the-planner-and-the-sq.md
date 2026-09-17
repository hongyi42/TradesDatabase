---
date: 2026-09-15
task: retrieval layer 3: the planner and the SQL views — v_captures folds retractions + labels, evidence lines carry capture ids, the gap list is capped and says so, planner/watcher readers move onto capture_membership
status: complete
origin: 20260915-customer-context-becomes-a-table-of-cont
files: src/db/querySpine.ts, src/teamLead/planner.ts, src/model/toolLoop.ts, src/db/observations.ts, src/calls/observationPing.ts, src/jobs/lifecycle.ts, thoughts/shared/plans/2026-09-15-the-retrieval-layer-3-the-planner-and-the-sql-views.md, supabase/migrations/20260917120000_the_sql_views_fold.sql, src/mcp/server.ts, src/teamLead/plannerPrompt.ts, docs/engineering-memory.md, supabase/migrations/20260917120100_planner_capture_readers.sql, src/db/captureMembership.ts, src/db/captureMembership.test.ts
supersedes: nothing
---

## Files

- src/db/querySpine.ts
- src/teamLead/planner.ts
- src/model/toolLoop.ts
- src/db/observations.ts
- src/calls/observationPing.ts
- src/jobs/lifecycle.ts
- thoughts/shared/plans/2026-09-15-the-retrieval-layer-3-the-planner-and-the-sql-views.md
- supabase/migrations/20260917120000_the_sql_views_fold.sql
- src/mcp/server.ts
- src/teamLead/plannerPrompt.ts
- docs/engineering-memory.md
- supabase/migrations/20260917120100_planner_capture_readers.sql
- src/db/captureMembership.ts
- src/db/captureMembership.test.ts

## Notes

Plan 3 of the retrieval-layer ladder (runs in parallel with plans 2 and 4; build order ruling 2026-09-15). Plan 1 (PR #242) put the membership + retraction + tier rules in the database; the planner still reads captures through its own paths and v_captures does not fold retractions.
Rulings that bind (task 20260915-customer-context-becomes-a-table-of-cont): retracted notes REMOVED everywhere including the planner's SQL views (the manager-only includeRetracted trail is the one labelled exception); the planner's gap list gets a CAP and the planner is TOLD ("N more not shown"); get_customer_context stays on CITABLE_TOOLS; money never folds.
Carried defects to test on the local stack while reworking: query_spine's statement_timeout is set_config'd INSIDE the running function (20260806120000_query_spine_reader.sql:204) and probably does not bound the query — UNVERIFIED. Planner dispatch does NOT pass through plan 1's hub cap (src/mcp/resultCap.ts); toolLoop keeps its own 20000-char cap.
Start with /plan against thoughts/shared/research/2026-09-15-the-retrieval-and-delivery-layer.md.

## Handoff 2026-09-15T20:58:10.784Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/retrieval-layer-3-the-planner-and-the-sq on work/retrieval-layer-3-the-planner-and-the-sq, from origin/main 2ca4f71.

Overlap check: none with any active task.

## Handoff 2026-09-16T00:27:50.899Z

**What changed** — Plan 3 is implemented end to end on this branch (nothing merged, pilot untouched). (1) SQL: `v_captures` is live-only (retracted notes, retraction rows and the labelled-trail columns gone) and one `v_capture_links` replaces `v_visit_notes` / `v_job_captures` / `v_customer_captures` and the misleading `v_captures.job_id/customer_id`; `query_spine` lost a `statement_timeout` line that never bounded anything. (2) Three DB functions over `capture_membership` (`gap_evidence`, `job_activity_since`, `capture_records`) replace eleven hand-written readers in the planner, the watcher and `record_caller`; ids ride in RPC bodies, results come back as one jsonb, and the remaining `in.()` readers on that path chunk at 150. (3) The planner sees at most 100 gaps (not on hold first, then held), is always told the ceiling and a suggested target under 30, gets capture ids and "N earlier not shown" on evidence lines, event ids on money lines, a retraction instead of a retracted call's words, and a citation check that also reads decoded JSON strings; `listNudgesByStatus` pages. (4) A money rule in the planner's send doctrine and the desk's narrowed disclosure. In place along the way: `pg_temp` named last on the three new functions (owed on plan 1's eight), a `visit_note` catalog line that wrongly implied "a technician reported this trip", supersession notes on three stale engineering-memory entries, and a refused `send` now carries the specific reason to the model instead of a four-way menu.

**Decisions** — Gap order is unheld-oldest-then-held (operator chose it over inbound-first, accepting that a brand-new call is hidden first when a firm is over 100; the Calls-worker's uncapped focused pass is the primary path). The ceiling is 100 with a suggested target of 30, both always stated. `manager_only` notes STAY in pushed evidence: `logIngest` is the only writer of that stamp and it stores argument KEY NAMES, never values, so the worst a technician learns is that a manager mailed about their job — the condition is wired as a comment at the redaction-policy site rather than left in a plan. A send-side money rail was BUILT AND WITHDRAWN the same day on the operator's ruling ("just use prompt engineering"); measured through `runPlanner`, it passed 8 of 8 ordinary ways to state an amount and refused 5 of 5 harmless messages, and its own refusal text named the bypass. Views inline the live predicate rather than calling `capture_is_live`, because a function in a view is EXECUTE-checked as the querying role and `spine_reader` holds no base-table grant. The planner keeps `toolLoop`'s own 20,000-char cap rather than the hub's, which would escape quotes twice and break citations.

**Assumptions** — That `capture_visible(…, 'planner')` stays unconditionally true for the planner tier (plan 2 is rewriting the 3-arg form; it returns true for manager and planner, so the three new functions are unaffected). That widening the watcher's activity probe to every job arm and to `captured_at` (from visit-note link time) changes no detection outcome in practice; only tests pin it. That a technician-addressed gap's money lines are acceptable in the PROMPT, since the same gap is discussed with managers — only the outgoing message is doctrine-gated.

**Open** — Nothing is merged: the two migrations are not applied to the pilot, no PR exists, and the s2-first gateway restart is owed (manager seats cache `tools/list`, so they still describe `v_visit_notes`). Live checks owed: the post-merge heartbeat read (no new `tenantErrors`, no `gap_evidence`/`capture_records`/`job_activity_since` failures) and, for the doctrine-only money rule, a pilot desk question ("has the Lee job been paid?") read back for figures. MIGRATION COLLISION: plan 2's `20260917120000_technician_view.sql` shares a version with `20260917120000_the_sql_views_fold.sql` — whoever lands second re-dates (I move to 130000/130100).

**Downstream** — Plan 2 owns the technician money rule and has built it (`viewShowsMoney`, firm rule `money: status|amounts`, per-grant `opens_money`); with plan 3's rail withdrawn, that is the only ENFORCED money gate, so a firm setting `amounts` will have tools that open while the planner's doctrine stays conservative — their call whether the doctrine learns to read the firm rule. Plan 2 also rewrites `capture_visible` and recreates plan 1's four readers, so whoever lands second merges main and regenerates `database.types.ts` with `gen:types:local`. The `pg_temp` hardening is still owed on `20260916120000_retrieval_layer_core.sql`'s eight functions. The operator's ruling that technicians see money STATUS ONLY (no invoice, no balance; a manager may widen through the firm rule or a grant) is recorded in that task's Decisions, in `docs/engineering-memory.md` and in session memory.

## Handoff 2026-09-17T16:17:44.905Z

**CLOSING HANDOFF — written by the plan-2 session on the operator's instruction (2026-09-17), because this branch's own session had gone idle. Everything below is read off the live systems, not recalled.**

**What changed since the last handoff** — Merged as PR #248 (`afa2320`), then `#249` (`2726941`) to fix the fallout (below). Both migrations, re-dated `20260917130000` / `20260917130100`, were applied to the pilot by hand before the merge. `lifecycle-heart` (crn-d93iq7a8qa3s73ap6260) and the web service (srv-d8uqmdegvqtc73bfn83g) were both hand-deployed and are live on `142fbee`, the tip carrying plans 2, 3 and 4 — confirmed against the Render API 2026-09-17, not assumed. Seat gateways were restarted, so `tools/list` no longer describes the deleted `v_visit_notes`.

**The owed live check is DONE, and it passed.** Twenty hours of ticks read (deploy 2026-09-16T20:23Z → 2026-09-17T16:11Z, one every ~5 min): **zero ticks with `tenantErrors` above 0** — searched for explicitly. `gap_evidence` is proven live (planner gap blocks rendered, `gaps: 3`) and `job_activity_since` is proven live (watchers ran every tick, `gapsFound: 2`); `capture_records` is on the planner path with no failure, but nothing in the logs proves it fired. Four error-level lines in the window, none of them this plan's: (1) two planner self-refusals at 22:01Z, one of them the date rail correctly catching `"today"` as a date it was not given; (2) at 06:46Z the only `ok: false` tick — Composio's own API returned a 500, `APIKey_InternalServerError` code 809, with their own retry advice; next tick clean; (3) at 13:30Z the planner tried `hold` with no gap id twice and made no decisions that tick; (4) at 15:01Z `spine_read rejected that query: column "created_at" does not exist`. I chased (4) because this plan reshaped those views: **the catalog is correct** — `SPINE_VIEW_CATALOG` documents `v_captures(id, captured_at, …)` and `v_capture_links` carries no timestamp at all — so the model guessed a column, plausibly out of habit from the `v_visit_notes` view this plan deleted. It retried and the tick still sent its nudge. No action taken.

**Assumptions** — That `capture_records` is sound because it shares its shape and its test coverage with the two functions that are proven live, and because any failure would have surfaced as a `tenantError`. That the one `created_at` refusal is model habit rather than a catalog defect, on the evidence that the catalog names the right column.

**Open, and it outlives this task** — `pg_temp` is still owed: nine `security definer` functions declare `set search_path = public` without it — **four** in plan 1's `20260916120000_retrieval_layer_core.sql` and **five** in plan 2's `20260917120000_technician_view.sql` (counted 2026-09-17; this plan's own three have it). Without `pg_temp` named last, a temporary table can shadow a real one inside a function body. One migration fixes all nine; it has no home now that this task closes, and the operator has been told. Also still open, in `20260915-the-technician-access-request-flow-tech`: whether the planner's doctrine should learn to read a firm's money rule, since the withdrawn rail left `viewShowsMoney` as the only enforced money gate.

**Downstream** — Nothing is waiting on this task. Plans 2 and 4 are merged and deployed alongside it; plan 2's task is already archived and promoted.
