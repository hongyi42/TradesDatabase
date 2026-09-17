---
date: 2026-09-15
task: retrieval layer 4: schedule contents + pages, list_pending_reviews paged, array results wrapped, the Composio relay through the size cap, visit time indexes
status: complete
origin: 20260915-customer-context-becomes-a-table-of-cont
files: src/mcp/tools/schedule.ts, src/mcp/tools/reviews.ts, src/db/reviewItems.ts, src/db/visits.ts, src/composio/relayHandler.ts, src/mcp/server.ts, src/mcp/resultCap.ts, thoughts/shared/plans/2026-09-15-the-retrieval-layer-4-schedule-reviews-relay.md, supabase/migrations/20260917140000_retrieval_layer_schedule.sql, src/db/reviewQueue.test.ts, src/db/schema.test.ts, src/db/rowCap.ts, src/db/index.ts, src/db/scheduleWindow.test.ts
supersedes: nothing
---

## Files

- src/mcp/tools/schedule.ts
- src/mcp/tools/reviews.ts
- src/db/reviewItems.ts
- src/db/visits.ts
- src/composio/relayHandler.ts
- src/mcp/server.ts
- src/mcp/resultCap.ts
- thoughts/shared/plans/2026-09-15-the-retrieval-layer-4-schedule-reviews-relay.md
- supabase/migrations/20260917140000_retrieval_layer_schedule.sql
- src/db/reviewQueue.test.ts
- src/db/schema.test.ts
- src/db/rowCap.ts
- src/db/index.ts
- src/db/scheduleWindow.test.ts

## Notes

Plan 4 of the retrieval-layer ladder (runs in parallel with plans 2 and 3; build order ruling 2026-09-15).
Rulings that bind (task 20260915-customer-context-becomes-a-table-of-cont, full set 3 and 7): get_team_schedule DROPS the week text dump (the scheduling UI carries the week view) and gets the contents treatment — counts per technician per day, untimed/unassigned/unscheduled counts, version — plus pages of stops on request; find_slots/book_visit/move_visit read the same bounded window. Composio results ROUTE THROUGH the same cap and filters (relayHandler.ts stops piping unchanged). Indexes: visits time/status, visit_notes time, money_events.corrects_event_id.
Carried defects: v_schedule.local_day = (v.starts_at at time zone tn.timezone)::date over NAIVE-local starts_at (supabase/migrations/20260907100100_drop_visits_technician_id.sql:91) — UNVERIFIED, test on the local stack. A visit report merged from a since-retracted note (recordVisitReport adds labor_hours/attributes onto an existing visit) is not folded; plan 1 renders only lastVisitAt and left it to this plan's visit page to decide how such a report shows.
Start with /plan against thoughts/shared/research/2026-09-15-the-retrieval-and-delivery-layer.md.

## Handoff 2026-09-15T21:00:29.263Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/retrieval-layer-4-schedule-contents-page on work/retrieval-layer-4-schedule-contents-page, from origin/main 2ca4f71.

Overlap check: 3 overlaps with active tasks — the operator read them and proceeded (--proceed):

  MED   calls what it names src/db/visits.ts › recordVisitReport
        20260915-retrieval-layer-4-schedule-contents-page names this file and mentions `recordVisitReport`; called at 1 site in 1 file 20260912-the-model-names-the-job-on-the-ambiguous lists (src/writePath/recordFieldNote.ts); 2 modules import it repo-wide
  LOW   same file only      src/db/visits.ts
        20260915-retrieval-layer-2-the-technician-limited lists it but has not changed it; 20260915-retrieval-layer-4-schedule-contents-page names it
  LOW   same file only      src/mcp/server.ts
        20260915-retrieval-layer-2-the-technician-limited lists it but has not changed it; 20260915-retrieval-layer-4-schedule-contents-page names it

## Handoff 2026-09-15T23:19:14.196Z

**What changed** — `get_team_schedule` is a counts page (days × technicians, completed/unassigned/untimed/unscheduled-jobs counts, every date in range) with the visit list only on `stops: true`, 25 per page on a value cursor, `technicianRef` matching any crew member; `unassignedOnly:true` is now the board tray's own read (`readLooseBucket`), so overdue parked visits appear flagged, paged 15/25 per queue. The tenant window readers page (a firm past 1000 visits no longer reads later days as empty, so `find_slots` cannot offer booked time), and `find_slots`/displacement moved onto the embedded reader, off the chunk-500 job-id list. `list_pending_reviews` pages 20 at a time in SQL (`review_queue_page`) with counts and a withheld oversized `detail` opened by `reviewItemId`; `find_customer`→`{customers}`, `list_team`→`{team}`, and the hub wraps any stray array. Composio `tools/call` results go through the same 20k cap, transformed as a STREAM (JSON and SSE). Migration: visit/visit_notes/money_events/review_items indexes, and `v_schedule`/`v_cancelled_visits.local_day` fixed — it converted naive-local `starts_at` with the firm tz, putting a 06:00 Pacific visit on the previous day (verified on the local stack, both directions pinned). In-place fixes named in their own commits: eval G01 compared against a literal 43 (failing on main since plan 1 took the manager surface to 42) → now `MANAGER_TOOLS_EXPECTED.length`; a stale `booking.ts` comment pointing at a ref cache `findDisplacementCandidates` no longer has.

**Decisions** — Operator, this session: (1) the schedule's rules stay in the one shared TS reader (`boardRead`), a deliberate exception to "rules live in the database" — a SQL copy would make two definitions while the board and console keep theirs; (2) stops only when asked (`stops:true`), not auto-listed on small days; (3) labor hours: nothing here, already ruled deleted 2026-09-09 (rung 10d), which also closes the retracted-note defect the task carried; (4) the remaining unpaged readers are TOLD, not paged — `get_job`/`record_money_event` ledger reads and `record_caller`'s job list say "only the first 1000 were read". Mine: Composio gets the cap and no filters (tier/retraction mean nothing for Gmail data; the session already scopes apps); past days read `['confirmed','completed']` (console parity, so a finished day is not "free"); windowed counts use narrow reads rather than the tray, which scans every confirmed visit since 1970; the cap measures the TEXT a model reads, not the serialized result — escaping alone (15-35% on JSON-in-text) is not a reason to rewrite, and a small result keeps its `structuredContent`, which a tool with an `outputSchema` MUST send.

**Assumptions** — The hosted pilot's PostgREST `max_rows` is the Supabase default 1000 (local config says 1000); the row-limit note fires at exactly that number either way. `GROUNDING_LEAN` no longer strips `get_team_schedule` counts (they are the page now), which changes date-eval Arm B's meaning — README updated, not re-measured. OpenClaw's handling of a capped Composio result was not observed live; only the relay's own output is pinned. The stop `stage` says `happened` for a completed visit without checking for notes (the pre-existing `stageOf(row,false)` behaviour), so it never says `reported`.

**Open** — Three deploy-time items, all in the plan: apply `20260917140000` to the pilot BEFORE the PR merges (Calls-worker auto-deploys at merge and the web deploy calls `review_queue_page`); then restart the s2 gateway (`tools/list` is cached) and judge in Telegram "what's on today?" / "how's this week looking?" / "what still needs assigning?"; and one ordinary and one wide Gmail read from the s2 manager seat. A live-model eval already passed 3/3 with the model calling `stops:true` only when it needed names — but in one answer it called a 0-visit Sunday "completely open", which the tool now says means "nothing booked", not "free": worth watching in the Telegram check. Not fixed, flagged by review as deliberate: a JSON-RPC *error* response and a Composio reply that echoes the id with a different type both escape the relay cap.

**Downstream** — `src/db/index.ts` gains one export line, which plan 2 also edits (trivial conflict at integrate). Plan 3 owns the planner/watcher readers and `v_captures`; this branch touched `v_schedule`/`v_cancelled_visits` only, with `create or replace`. `database.types.ts` must be regenerated with `gen:types:local` after this merges. Migration timestamps may need re-ordering at integrate if plans 2/3 land first. `LooseBucket` gained `jobId`, `createdAt`, `unassigned` and `unscheduledJobsRowCapHit` — additive, the board and console ignore them.

## Handoff 2026-09-16T19:24:29.481Z

**Merge order settled with plan 2 (cross-session, 2026-09-16)** — plan 2 → plan 3 → plan 4; migration versions 120000 → 130000/130100 → 140000; each branch applies its OWN migration to the pilot by hand immediately before its OWN merge, nobody applies anyone else's. Plan 2 confirmed by grep that its migration creates no views, so this branch's `local_day` fix cannot be copied over by it.

**What I owe at integrate (I land last, so these are mine, not theirs)** — After merging main: (1) plan 2's `find_customer` returns a RESTRICTED row for an out-of-view match, exactly `{id, name, inView: false, note}` and nothing else — it is the access-request flow's hook. My `{customers}` wrapper must not widen it, and the retraction fold in `handleFindCustomer` is the specific risk: `rows.map((c) => ({ ...c, attributes: foldRetractedFacts(...) }))` runs over ALL rows whenever ANY row has retracted evidence, so on a row with no `attributes` key it would add one. Guard the map, and pin the four-key shape in its wrapped form. (2) Their assertions at server.test.ts ~:9877, :9880-9883, :9919 move to `.data.customers`. (3) `src/eval/toolCases.ts` G01: we made the same fix independently — keep theirs, mine is the duplicate; I also changed R07 (stops:true + asserts `out.json.stops` is an array), which they did not touch. (4) `src/db/index.ts`: my `rowCap.js` line against their `technicianView.js` line — take both. (5) Regenerate `database.types.ts` with `gen:types:local`, never by hand.

**Agreed boundary, so neither side assumes the other did it** — nothing on either branch gates a schedule read, and nothing needs to: `get_schedule` is participant-rooted (inside the technician's own view by construction) and `get_team_schedule` plus the board tray are manager-only. If a technician-facing schedule read is ever added it must pass her roster id through plan 2's `technician_view_of`, whose default is fail-closed.

## Handoff 2026-09-16T19:25:04.179Z

**CORRECTION to the integrate note above (plan 2, 2026-09-16)** — item (1) was wrong in its diagnosis, right in its remedy. Plan 2's `handleFindCustomer` ALREADY guards this: one map with the view test first (out-of-view → the four-key row; in-view → `c`, or the fold only when `retracted.size > 0`), and the evidence gather above it is `found.filter(shown).flatMap(...)`, so an out-of-view customer's facts are never loaded. The unguarded `rows.map((c) => ({ ...c, attributes: … }))` I quoted is PLAN 1's shape — the code plan 2 replaces, and the code my branch currently sits on.

So the hazard at integrate is CONFLICT RESOLUTION DIRECTION, not a missing guard: that hunk conflicts, and resolving it toward "mine" (or toward the familiar pre-plan-2 shape) silently restores the unguarded map and widens the four-key row to five. Resolve toward plan 2's ternary, keep `.filter(shown)` on the gather, and add only the `{customers}` wrapper around the result. The pinned `toEqual([{id, name, inView: false, note}])` in its wrapped form stays the belt that catches a later drift back.

## Handoff 2026-09-16T19:40:20.780Z

**Deploy-path correction, verified 2026-09-16** — my plan said the web deploy would carry the new code at merge. It does not. `TradesDatabase` (srv-d8uqmdegvqtc73bfn83g), the seat-facing MCP server, has `autoDeploy: "no"` / `autoDeployTrigger: "off"` — read from the Render API, not taken on trust, and already recorded at `docs/engineering-memory.md:5994` (three of the services have auto-deploy off; only Calls-worker and Calls-purge deploy on commit). So the sequence for this branch is: apply `20260917140000` to the pilot by hand → merge → **trigger the web deploy by hand** (API trigger, never the dashboard "Redeploy" button, which repeats the old commit) → then the two Telegram checks. Plan 2 hit this on its own merge and had a technician-blind window until it triggered the deploy.

**Main moved while the three branches were talking** — `origin/main` is now 0e62673 (plan 2, #247), behind it a83f9aa (#246, notifications leave the board bot) and f487032/89f2ab4. This branch is 7 commits behind; the merge brings considerably more than plan 2's diff, so re-run the gates after merging main, not just the find_customer hunks.

## Handoff 2026-09-16T19:42:42.172Z

**Two refinements from plan 2 on the deploy correction (2026-09-16)** — (1) Cite the estate fact by QUOTE, not line: *"There are FIVE services, and three have `autoDeploy: no`"*. My worktree and plan 2's sat 16 lines apart on the same file the same day, so a number in a plan is wrong the moment anyone inserts an entry above it. The §4 diagram's *"six services, two with autoDeploy OFF"* is stale on both counts — check whether 3bc4afa fixed it when merging main, and fix it if not. (2) Order the cutover so the deploy trigger follows the merge IMMEDIATELY, with read-backs after: the dangerous window is migration-applied-but-code-old, and it should be one API call long, not however long checking takes.

**Why neither of us caught it, worth carrying** — we both held a TRUE half ("Calls-worker and Calls-purge auto-deploy at merge", which is exactly why the migration goes on before the merge) and generalised it into "merging deploys the code". A half-memory that is true reads like a whole one, so nothing prompted either of us to look. Rule: read `autoDeploy` from the API for the service that actually serves the thing you changed, at the moment you plan the cutover; never infer it from another service's behaviour.

## Handoff 2026-09-16T19:44:08.775Z

**Docs corrected on main by plan 2 (037f58a, 2026-09-16) — do not duplicate at merge.** The §4 diagram ("six services, two with autoDeploy OFF") and the estate TABLE (which listed `lifecycle-heart` as auto-deploy *yes*, wrong, and had been flagged-but-not-fixed by a later entry in the same file) are both corrected there with API read-dates. `docs/engineering-memory.md` is edited on this branch too (two new entries), so expect a conflict there at merge and KEEP BOTH SIDES. Main now carries 0e62673 → 3bc4afa → 037f58a; plan 3 has PR #248 open, so the merge slot is theirs when their operator clears it.

## Handoff 2026-09-16T20:21:15.590Z

**MERGED AND DEPLOYED 2026-09-16.** PR #251 merged as 142fbee; `20260917140000` applied to the pilot by hand BEFORE the merge (ledger version 20260916…, the recorded filename-vs-version drift); web service deployed by hand straight after — `dep-dalfjj142hec73cao0f0`, live 20:20:37Z, ~73s, so the new-schema-old-code window was about that long. `/health` 200.

**Pilot read-backs, not assumed** — five indexes and `review_queue_page` present with the right signature; both views now compute `local_day` from the stored wall clock (pg_get_viewdef renders it `AT TIME ZONE 'UTC'::text`, so a LIKE for lowercase "time zone 'UTC'" reads as NOT FIXED — check case when verifying a view body). **27 early-morning visits on the pilot were on the wrong day before this and are now right.** A real `review_queue_page` call on the pilot's first firm: **106 open review items**, served 3 with by_kind counts and a microsecond cursor — that firm's `list_pending_reviews` used to return all 106 with full detail in one result, which is the dump this plan removes, larger in life than in any test.

**STILL ON THE OLD COMMIT: `lifecycle-heart` (crn-d93iq7a8qa3s73ap6260, live on 2726941) and `Board_Worker` (srv-d9dr8iurnols73d1tjq0).** Both have auto-deploy off. Nothing breaks — the migration only adds indexes, fixes two views and adds a function, so old code runs against it fine — but until lifecycle-heart is deployed the planner and watchers keep the OLD unpaged visit readers, so the silent 1000-row cut this branch fixed is still live on that path. Asked the operator; not deployed without a yes.

**Owed (post-deploy, unchanged)** — restart the s2 gateway (it caches `tools/list`), then judge in Telegram: "what's on today?", "how's this week looking?", "what still needs assigning?" — watching whether the model calls a 0-visit day "open" when the tool now means "nothing booked". Then one ordinary and one wide Gmail read from the s2 manager seat for the Composio cap.

## Handoff 2026-09-17T16:18:06.201Z

**CLOSING HANDOFF — written by the plan-2 session on the operator's instruction (2026-09-17), because this branch's own session had gone idle. Read off the live systems, not recalled.**

**Correction to the previous handoff, which is now stale on its most important line.** It says `lifecycle-heart` is STILL on the old commit (2726941) and was not deployed without the operator's yes. That yes came, and it was deployed: `crn-d93iq7a8qa3s73ap6260` is live on `142fbee` since 2026-09-16T20:23:03Z, deploy `dep-dalfkvajnfac739dk4mg` — read from the Render API 2026-09-17. So the old unpaged visit readers are no longer running anywhere, and the silent 1000-row cut this plan fixed is gone from the planner/watcher path too, not just the web path. `Board_Worker` remains deliberately stale, which main now says out loud at the estate table (`0cc23e3`).

**What else closed** — The s2 gateway was restarted and the three Telegram checks were run and judged (today / this week / what still needs assigning), along with five more across both tiers. The watched risk — the model calling a 0-visit day "completely open" when the tool now means "nothing booked", not "free" — did not recur in the live checks.

**The Composio relay cap is implemented and unit-tested but NEVER FIRED LIVE.** The largest real result in the session was about 15.8k characters against the 20,000 limit, so nothing was ever cut. Say it that way to anyone who asks; do not describe it as proven. Related and worth keeping straight: the truncated 100-email list the operator saw was NOT this cap — it was Telegram's 4,096-character message limit on the seat's reply, which is parked separately as `20260916-a-seat-reply-must-fit-the-channel-8-023`. The two deliberate escapes from the previous handoff still stand: a JSON-RPC *error* response, and a Composio reply that echoes the request id with a different type.

**Lesson worth carrying, and it is why this promotes** — **a view-body check can read as NOT FIXED when it is fixed.** Postgres renders `pg_get_viewdef` with `AT TIME ZONE 'UTC'::text`, so a `LIKE` for lowercase `time zone 'UTC'` matches nothing and the verification reports failure on a view that is correct. Check case when verifying a view body. The same read-back confirmed the real prize: **27 early-morning visits on the pilot were on the wrong day before this plan and are right now**, because both views compute `local_day` from the stored wall clock.

**Open** — Nothing blocking. The relay cap stays unproven live until something genuinely exceeds 20k. `pg_temp` is owed on nine `security definer` functions from plans 1 and 2 (four in `20260916120000_retrieval_layer_core.sql`, five in `20260917120000_technician_view.sql`) — not this plan's code, recorded here only so it is not lost when these tasks close; the operator has been told. The measurement this plan produced — one pilot firm's `review_queue_page` returning **106 open review items**, where `list_pending_reviews` used to serve all 106 in one result — is what the parked `20260916-retire-the-manager-review-queue-keep-rev` rests on.

**Downstream** — Nothing waits on this task. Plans 2 and 3 are merged and deployed alongside it.
