---
date: 2026-09-15
task: the retrieval-and-delivery layer for technicians, managers and the planner: every tool meets the retrieval goals, tool selection scales, the infra holds at high data volume (widened 2026-09-14 from: customer context becomes a table of contents + search)
status: complete
origin: 20260914-fix-the-small-board-findings-listjobsfor
files: src/db/context.ts, src/mcp/tools/customers.ts, src/synthesis/grounding.ts, src/db/rawCaptures.ts, src/db/customers.ts, thoughts/shared/research/2026-09-14-customer-context-becomes-a-table-of-contents.md, thoughts/shared/research/2026-09-15-the-retrieval-and-delivery-layer.md, thoughts/shared/plans/2026-09-15-the-retrieval-layer-1-captures-and-the-customer-read.md, supabase/migrations/20260916120000_retrieval_layer_core.sql, src/db/retrievalLayer.test.ts, src/mcp/tools/shared.ts, src/mcp/server.ts, src/mcp/tools/surface.expected.ts, src/db/context.test.ts, src/db/customerCaptures.test.ts, src/db/retractions.test.ts, src/mcp/server.test.ts, src/eval/toolCases.ts, src/eval/toolCases.test.ts, src/eval/corpus.ts, src/db/foldImpact.ts, src/db/visits.ts, docs/onboarding.md, docs/nemoclaw-tech-agent.md, docs/doorman-runbook.md, .claude/skills/growth/product/tradesdatabase.md, scripts/spine-eval/lib/env.mjs, scripts/spine-eval/world.mjs, src/mcp/tools/captures.ts, src/mcp/resultCap.ts, src/mcp/resultCap.test.ts
supersedes: nothing
---

## Files

- src/db/context.ts
- src/mcp/tools/customers.ts
- src/synthesis/grounding.ts
- src/db/rawCaptures.ts
- src/db/customers.ts
- thoughts/shared/research/2026-09-14-customer-context-becomes-a-table-of-contents.md
- thoughts/shared/research/2026-09-15-the-retrieval-and-delivery-layer.md
- thoughts/shared/plans/2026-09-15-the-retrieval-layer-1-captures-and-the-customer-read.md
- supabase/migrations/20260916120000_retrieval_layer_core.sql
- src/db/retrievalLayer.test.ts
- src/mcp/tools/shared.ts
- src/mcp/server.ts
- src/mcp/tools/surface.expected.ts
- src/db/context.test.ts
- src/db/customerCaptures.test.ts
- src/db/retractions.test.ts
- src/mcp/server.test.ts
- src/eval/toolCases.ts
- src/eval/toolCases.test.ts
- src/eval/corpus.ts
- src/db/foldImpact.ts
- src/db/visits.ts
- docs/onboarding.md
- docs/nemoclaw-tech-agent.md
- docs/doorman-runbook.md
- .claude/skills/growth/product/tradesdatabase.md
- scripts/spine-eval/lib/env.mjs
- scripts/spine-eval/world.mjs
- src/mcp/tools/captures.ts
- src/mcp/resultCap.ts
- src/mcp/resultCap.test.ts

## Notes

Operator direction 2026-09-14 (approved parking in the planning session of 20260914-fix-the-small-board-findings-listjobsfor): a model is never handed a customer's raw captures in bulk. Observed: getCustomerContext (src/db/context.ts) returns every capture's full text; get_customer_context gives it whole to the seat agent, and brief_customer / answer_customer_question (src/mcp/tools/customers.ts) paste it whole into one model call (src/synthesis/grounding.ts serializeContextForPrompt).
Target shape: get_customer_context returns CONTENTS (profile, standing facts, jobs with status, next visit, per-job capture counts); the seat agent drills in with get_job / list_recent_captures / a new search verb. Storage already has the tree (customers -> jobs -> visits; customer_captures / job_captures / visit_notes links into L1); only the read flattens it.
Research must settle: keyword (Postgres full-text) vs embedding search, and retraction fold + tenant filter on search results; recap questions ("summarize this job") that search does not shrink; latency (seats make tool calls one at a time); the no-job customer_captures pile; a big job being the dump one level down; what brief_customer / answer_customer_question become (agent loop, retrieval step, or retired); how contents make absence visible so the agent does not stop at them.
Carries the dropped finding 20260912-getcustomercontext-fetches-customer-link: one getRawCapture round trip per id (src/db/context.ts:158) and recentCaptures uncapped. The retraction-check URL wall (findRetractionsFor, ~215 ids vs the 8192-byte limit measured at src/db/rawCaptures.ts:710) is being fixed in 20260914-fix-the-small-board-findings-listjobsfor, not here.

## Decisions

NOTE, 2026-09-15 (from 20260914-fix-the-small-board-findings-listjobsfor, operator-approved): its
migration 20260916130100_customers_phone_key adds a STORED GENERATED column `customers.phone_key`
(the phone's digits, leading US 1 dropped; a matching key, never something to say). This task's
`customer_contents` SQL function (20260916120000_retrieval_layer_core.sql) emits
`to_jsonb(customers%rowtype)`, so the contents page now carries `phone_key` beside `phone` into a
seat's context, where the accuracy rules could get the bare digits quoted. That task deliberately
did NOT edit your function: `get_customer_context`'s handler and `find_customer` strip it in
TypeScript (`withoutPhoneKey`, src/mcp/tools/customers.ts). Any NEW reader of `customer_contents`
or `customers%rowtype` that reaches a model must do the same — or project it out in SQL
(`to_jsonb(c) - 'phone_key'`) in your next plan. `v_customers` exposes it to the planner on
purpose (20260916130200).

OPERATOR, 2026-09-14 (research session, after thoughts/shared/research/2026-09-14-customer-context-becomes-a-table-of-contents.md): the customer read moves INTO THE DATABASE. One query keyed on the customer (a tenant-scoped SQL function called over RPC, the `tenant_cost_detail` template) does the capture union, the retraction match and the per-job counts inside Postgres, so no id list is shipped back out in a URL. Chosen over chunking `.in()` lists (the sibling task's findRetractionsFor fix, which stands for its other callers) and over moving the list into an RPC body. Resolves research Decision Point 11 (the batched fetch) as option (c), and removes the ~215-id URL wall and the silent 1000-row clamp from this read by construction. Cost accepted: a migration, applied by hand before the code ships (deploy does not migrate).

OPERATOR, 2026-09-14 (same session): for TECHNICIANS, keyword search over the record is sufficient ("as long as they can keyword search it should be fine"). Embedding/semantic search is not required for the technician tier — research Decision Point 3 option (d) is off the table for technicians. Open: whether the keyword search reaches them as a purpose-built tool or as read-only SQL; and whether managers want more than keyword.

OPERATOR, 2026-09-14 — SCOPE WIDENED (large task). No longer "customer context becomes a table of contents"; now: THE RETRIEVAL-AND-DELIVERY LAYER FOR ALL THREE CALLERS (technician seats, manager seats, the planner) AND THE TOOLS EACH GETS. Rationale (operator): tools ARE the ways data is retrieved from the DB, so the retrieval layer and the tool surfaces are one design. Three parts:
 1. Audit how retrieval and delivery work for EVERY tool, against the retrieval-layer goals: complete · nothing cut silently · only what the caller may see (tenant, tier, retractions) by construction · same answer every time (stable order) · small regardless of history size · fast (common questions in one call) · points to evidence (citable ids) · says when something is empty · one definition shared by every reader.
 2. Tool retrieval: agents carry the whole tool catalog every turn today. Evaluate how to make tool selection cheaper/faster at scale — semantic tool filtering (https://redis.io/blog/from-reasoning-to-retrieval-solving-the-mcp-tool-overload-problem/), programmatic tool calling, and whatever else exists now — AGAINST this repo's measured history: OpenClaw tool search hid mandated tools and is OFF on every seat (memory tool-search-hides-mandated-tools); PTC unreachable from OpenClaw/OpenRouter as of 2026-09-05 (memory programmatic-tool-calling-not-an-option); schema-shape grammar cost (agent-turn-latency-tool-schemas). Re-verify all vendor facts live.
 3. Scale: make sure the infrastructure keeps running efficiently when firms have a lot of data.
Carries forward the decisions above (DB-side read via SQL function; keyword search suffices for technicians). The first research doc (2026-09-14-customer-context-becomes-a-table-of-contents) becomes one input.
The small board fixes task (20260914-fix-the-small-board-findings-listjobsfor) is PAUSED by the operator the same day.

OPERATOR, 2026-09-15 — THE PROBLEM STATEMENT (after research thoughts/shared/research/2026-09-15-the-retrieval-and-delivery-layer.md). "Are the tools operating in an efficient way even when data scales?" Two axes judged on every tool: LATENCY and CONTEXT (what lands in the agent's window). The trigger was customer context bloating up and killing a seat's context window; the design rule is that a tool never dumps context into the agent. Tools and the retrieval layer are one design and are redesigned together. DEFERRED by the operator: the tool-catalog question (part 2 of the widened scope — semantic tool filtering, programmatic tool calling, OpenRouter/OpenClaw tool search). Its research stands in the doc (§6, decision points 8–9) for a later task; at 17/43/7 tools it is not the near-term lever. The nine retrieval goals stay the per-tool checklist, with G5 (small regardless of history) and G6 (fast) as the axes the plan is judged on first.

OPERATOR, 2026-09-15 (same session) — FOCUS = CONTEXT MANAGEMENT: "making sure the agents are able to access the database with tools that won't kill its context window." The ~200-id URL walls (open items per firm, emails per job) are judged unlikely in practice and ACCEPTABLE: close them with a stated cap or the sibling branch's chunk-150, not a redesign. The shape to build is the contents → open → search → ask protocol from the 2026-09-14 research, applied as a general tool pattern. Redis was asked about: a cache changes latency, not what enters the window, so it is not the lever for this problem (see the session note in the research doc's decision point 4/7 discussion).

OPERATOR, 2026-09-15 (same session) — ACCESS MODEL DIRECTION, replacing the per-row `manager_only` stamp (research decision point 3): technician seat agents get a LIMITED VIEW by default. When an answer needs information outside that view: (1) the tech seat asks the technician whether to request access from a manager; (2) on yes, the tech seat goes to the PLANNER, which sends the manager a request; (3) the manager says yes or no; on yes the tech seat gets access to that information. Consistent with the 2026-08-23 ruling (the manager decides what is gatekept; the planner reads everything). To be designed under the data-security gate as part of this task's retrieval layer: what the limited view contains, what a grant is (scope, duration, who records it), which verbs carry each hop, and how the answer reaches the technician given the planner's cadence. Decisions listed in the session's brief; not yet ruled.

OPERATOR, 2026-09-15 (same session) — TWO GATES ON EVERY CAPTURE, and where each lives. Scope (their jobs, their customers) comes from the record's structure; sensitivity is a property of CONTENT (an email inside Jane's scope that carries the estimate must still not reach her). A capture is all-or-nothing (L1 text immutable), so the content gate is "may a technician see this capture at all?". THIS TASK ships the coarse default — option A, by channel: technician-channel captures + the extractor's structured summary visible to technicians; verbatim customer email/calls/outbound/agent actions manager-only by default — plus the one rule the layer evaluates per read (scope AND content AND grants), with a per-capture tag table as the hook that rule already consults. PARKED as its own task, 20260915-the-extractor-tags-each-inbound-capture (option B): the extractor tags each inbound capture's content, firm rule maps tags → hidden/visible, manager overrides per item, fail closed; waits for the chooser task (same door) and for this task's rule + hook. Option C (a technician-safe redacted rendering) deferred unless a firm asks. Money figures live twice: money_events (technicians already get door numbers only) and the verbatim capture text — A/B close the second.

OPERATOR RULINGS, 2026-09-15 — THE FULL SET, on the brief "what are the decisions, in plain terms" (numbering = that brief; research decision points in brackets). These are what the plan is written against.
 1. [DP1] Rules live in the DATABASE (views/functions); only delivery (size cap, wording, ids) in TypeScript at the hub.
 2. [DP2] ONE definition of "a job's captures" / "a customer's captures", used by everyone — seat tools, planner evidence, watcher, write-path lookups — phased, seats first.
 3. [DP3] Sensitivity: technicians = LIMITED VIEW + GRANT ACCESS (the access-model rulings below), not the per-row manager_only stamp. Retracted notes: REMOVED EVERYWHERE — every default read including the planner's SQL views (this settles the 2026-08-23 open question "readable ≠ presented as true" in favour of not presenting; the manager-only includeRetracted audit trail on list_recent_captures/retract_capture is assumed to stay as the one labelled exception — flag in plan review if that assumption is wrong). Composio results: ROUTE THEM THROUGH the same cap and filters (a relay change: src/composio/relayHandler.ts stops piping unchanged).
 4. [DP7] Contents page carries the newest note's first ~200 chars per job (the snippet), jobs capped at the 10 most recent with "N older".
 5. [DP7] brief_customer + answer_customer_question: RETIRE. Verification owed: watch how the seat agent answers brief-style questions ("give me a quick brief on X before I go") through contents → open, and tune the answer formatting if it is not up to standard (a live check per the verifying-behavior skill; Q01/X01/X02 and the surface tests are rewritten to the new path).
 6. [DP7] search_captures is a TECHNICIAN tool only; managers keep query_spine, the planner spine_read, over the rebuilt views.
 7. [DP7 schedule] get_team_schedule: DROP the tool's presentation (the text dump of a week; Yutao's scheduling UI carries the week view), KEEP the read in the layer, and give the tool the same treatment — contents page (counts per technician per day, untimed/unassigned/unscheduled counts, version) + pages of stops on request. find_slots/book_visit/move_visit read the same bounded window.
 8. [DP10] The planner's gap list gets a CAP, and the planner is TOLD there is a cap ("N more not shown").
 9./10. [DP12, sibling] The correctness defects are already placed (retrieval-shaped ones here as requirements; the small ones in 20260914-fix-the-small-board-findings-listjobsfor). The sibling is UNPAUSED and FINISHED FIRST; this task's plan starts from a main that includes it.
 11. [DP11] INDEXES yes, in this task where the layer's queries need them (visits time/status/source_capture_id, raw_captures time, visit_notes time, money_events.corrects_event_id). RETENTION deferred.
 12. [DP10 firms] Firms in series: LEAVE IT (parked separately as 20260915-the-planner-and-the-watcher-run-firms-on).
 Deferred earlier the same day: the tool-catalog question [DP8, DP9].

OPERATOR RULINGS, 2026-09-15 — TECHNICIAN VIEW + GRANT ACCESS (numbering = the access brief):
 1. The default view: their own visits; the jobs that belong to the customers they are serving; those customers' contact details and standing facts (gate codes); and the notes on those jobs. OUTSIDE the view: other customers, other technicians' jobs, whole histories, money detail. (Plan question, not a ruling: whether "the jobs of the customers they are serving" means every job of that customer or the current/non-terminal ones — the ruling names "whole histories" as outside, so the plan proposes a reading and the operator confirms.)
 2. A sensible default WE ship; the MANAGER can widen or narrow it for their firm.
 3. A grant is scoped to ONE customer or ONE job, time-boxed, with a STANDING option for managers who do not want to be asked every time.
 4. Hop 2 goes through the DESK: ask_team_lead relays the request to the manager immediately (the desk performs that one write — today it is read-only); the planner records the request and its outcome on its next tick.
 5. The manager says yes through a grant_access verb on the MANAGER'S SEAT (one call, the record_caller precedent), not by waiting for a planner tick.
 6. On a yes, a MESSAGE goes to the technician's seat; the technician re-asks and the layer now returns the information.
 7. Grants are on the permanent record: a ledger row (who asked, who granted, scope, expiry, why).
 8. The coarse content default (option A, by channel) ships in THIS task.
 9. SCOPE SPLIT: the view and the grant CHECK are in THIS task (the layer is being written anyway); the REQUEST FLOW (hops 1–3: the technician-side ask, the desk relay, grant_access, the message back) is a FOLLOWING task once the layer exists — operator 2026-09-15: PARK IT AT THIS TASK'S HANDOFF (do not forget).
 OPERATOR, 2026-09-15 — BUILD ORDER: implement plan 1 (thoughts/shared/plans/2026-09-15-the-retrieval-layer-1-captures-and-the-customer-read.md) NOW in this worktree; it does not depend on the sibling task, which lands whenever it lands (re-merge main before the PR). Once plan 1 is on main, plans 2 (technician view + grants), 3 (planner + SQL views) and 4 (schedule, reviews, relay, arrays) are written and run IN PARALLEL: each its own task on the board (park on this ruling, spawn into its own worktree with its own stack), overlap-checked at spawn, integrated one at a time; migration timestamps re-ordered at integrate if two land out of order; database.types.ts regenerated after every merge, never merged by hand.
 CONFIRMED by the operator 2026-09-15: the three readings in the session's note — (a) "removed everywhere" includes the planner's SQL views, with the manager-only includeRetracted audit trail staying as the one labelled exception; (b) "the jobs of the customers they are serving" is a plan question (proposed reading: current, non-terminal jobs of the customers on their visits; operator confirms in plan review); (c) get_team_schedule = contents page + pages, the week dump retired to the UI.

OPERATOR, 2026-09-15 — DEFECTS SPLIT. The audit's correctness defects that the retrieval layer itself defines the rule for stay IN THIS TASK and are requirements on the layer, not side quests:
 - A retracted note's report stays on the trip: recordVisitReport ADDS labor_hours and merges attributes onto a pre-existing visit (src/db/visits.ts:638-660); the fold drops only visits whose source_capture_id is retracted (src/db/context.ts:194-196). The layer's fold must cover a report merged from a since-retracted note.
 - money_events citing a retracted capture are folded nowhere (summarizeMoney takes no retraction input; findFoldImpact omits them). The layer's fold covers money.
 - Citations accepted for text never shown: validateCitations accepts every correspondence entry id (src/synthesis/grounding.ts:159-161) while the prompt renders the newest 3 (:47). Resolved by the contents/open design (whatever is citable is what was shown).
 - v_schedule.local_day = (v.starts_at at time zone tn.timezone)::date over naive-local starts_at (supabase/migrations/20260907100100_drop_visits_technician_id.sql:91) — UNVERIFIED; test on the local stack while the views are rebuilt.
 - query_spine's statement_timeout is set_config'd INSIDE the running function (20260806120000_query_spine_reader.sql:204) and probably does not bound the query — UNVERIFIED; test while the function is reworked.
 - Silent 1000-row clamps, URL walls, unstable orders, per-row round trips, bare-array delivery: by construction, the layer's job.
The four small non-retrieval defects (stale unschedule confirm, desk answers citable, add_technician_seat row leak, drifted descriptions) went to 20260914-fix-the-small-board-findings-listjobsfor. The phone normaliser and the OpenClaw tool-search auto-enable guard also went to the sibling task (2026-09-15, operator). Nothing is left unplaced. SEQUENCING (operator, 2026-09-15): the sibling task is to be unpaused and finished BEFORE this task's work continues; this task's plan starts from a main that includes its fixes (chunk-150 findRetractionsFor, tiebreaks, the four small defects, the phone normaliser).

OPERATOR, 2026-09-15 — MONEY AND RETRACTIONS (after the final code review of plan 1). Money NEVER folds on a retraction: every reader sums the same ledger (the first draft's contents-page money fold is REVERSED — it made the contents page and get_job disagree, and hid a retracted note's correction). retract_capture lists money entries recorded from the note under alsoLosesEvidence.money / alsoLostEvidence.money with a tier-worded note (manager: record_money_event correctsEventId; technician: tell the manager). Managers SEE retractions: retractedCount per job on the contents page (managers/planner only) + includeRetracted on list_recent_captures / get_capture. The RETRACTION REPORT TO THE PLANNER joins task 20260912-an-l2-status-flip-reports-to-the-planner (the general touch-report), not its own task. The access REQUEST FLOW still parks at this task's handoff.

## Handoff 2026-09-15T05:56:39.090Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/customer-context-becomes-a-table-of-cont on work/customer-context-becomes-a-table-of-cont, from origin/main 7c2370c.

Overlap check: 6 overlaps with active tasks — the operator read them and proceeded (--proceed):

  MED   calls what it names src/db/rawCaptures.ts › findRetractionsFor
        20260915-customer-context-becomes-a-table-of-cont names this file and mentions `findRetractionsFor`; called at 7 sites in 3 files 20260914-fix-the-small-board-findings-listjobsfor lists (src/writePath/recordFieldNote.ts, src/mcp/tools/captures.ts, src/db/context.ts); 8 modules import it repo-wide
  MED   calls what it names src/db/rawCaptures.ts › getRawCapture
        20260915-customer-context-becomes-a-table-of-cont names this file and mentions `getRawCapture`; called at 4 sites in 3 files 20260914-fix-the-small-board-findings-listjobsfor lists (src/writePath/recordFieldNote.ts, src/mcp/tools/captures.ts, src/db/context.ts); 6 modules import it repo-wide
  MED   calls what it names src/db/rawCaptures.ts › findRetractionsFor
        20260915-customer-context-becomes-a-table-of-cont names this file and mentions `findRetractionsFor`; called at 3 sites in 1 file 20260912-the-model-names-the-job-on-the-ambiguous lists (src/writePath/recordFieldNote.ts); 8 modules import it repo-wide
  MED   calls what it names src/db/rawCaptures.ts › getRawCapture
        20260915-customer-context-becomes-a-table-of-cont names this file and mentions `getRawCapture`; called at 1 site in 1 file 20260912-the-model-names-the-job-on-the-ambiguous lists (src/writePath/recordFieldNote.ts); 6 modules import it repo-wide
  LOW   same file only      src/db/context.ts
        20260914-fix-the-small-board-findings-listjobsfor lists it but has not changed it; 20260915-customer-context-becomes-a-table-of-cont names it
  LOW   same file only      src/db/rawCaptures.ts
        20260914-fix-the-small-board-findings-listjobsfor lists it but has not changed it; 20260915-customer-context-becomes-a-table-of-cont names it

## Handoff 2026-09-15T20:51:31.028Z

**What changed** — Plan 1 landed (PR #242, merged e9e58b3; migration 20260916120000_retrieval_layer_core applied to the pilot BEFORE merge, all 8 function bodies md5-matched against the local stack, grants/indexes read back, a real customer_contents call returned a 4.8K manager / 3.9K technician page). The rules "which captures belong here", "is it retracted" and "may this tier see it" now live once in Postgres (capture_membership + capture_is_live + capture_visible). get_customer_context is a fixed-size contents page (live work first, olderJobs, retractedCount for managers/planner); list_recent_captures pages on a (captured_at,id) cursor; get_capture and search_captures (technician-only) are the drill-down verbs; brief_customer, answer_customer_question and src/synthesis/ are gone; every seat result is capped at the door (SPINE_RESULT_CAP_CHARS, 20000) inside a valid JSON envelope that keeps now/boardLink; retract_capture lists the money entries that lose their evidence.
**Decisions** — (1) Money NEVER folds on a retraction. The first draft hid money cited by a retracted note on the contents page only; the final review showed it made the contents page and get_job disagree on a balance and silently revived an entry a retracted CORRECTION had cancelled. Reversed with the operator: the ledger is corrected with record_money_event, and the retraction preview names the entries (manager told to correct, technician told to tell the manager). (2) Live work leads the jobs block (p_terminal_statuses passed in from TERMINAL_JOB_STATUSES, never hand-listed in SQL) — a plain "10 newest" dropped an old unpaid job's openWorkNote and money. (3) The cap binary-searches the head so the ENVELOPE fits the limit (a naive slice overshot after JSON escaping and lost the trailing decorations). (4) search_captures is refused for managers (they have query_spine). (5) Redis/caching rejected for this problem: it changes latency, not what enters the window. All operator rulings are in this task's Decisions block.
**Assumptions** — The planner's in-process dispatch does not go through the hub cap; toolLoop's own 20000-char cap is assumed sufficient until plan 3. Pilot terminal status names in my smoke call were guessed (paid/cancelled/declined), which only affects that read-back, not the code. The #243/#244 sibling merges landed AFTER #242 and I did not re-run the suite on the combined main.
**Open** — (a) The brief-style live check is OWED (ruling 5): restart the gateway (seats cache tools/list), roll s2 first, ask "give me a quick brief on <customer>", judge the answer and tune formatting if weak. (b) Q01/M07/C05 live eval not run (needs OPENROUTER_API_KEY). (c) Plans 2, 3, 4 parked as 20260915-retrieval-layer-2-the-technician-limited, -3-the-planner-and-the-sq, -4-schedule-contents-page — each starts with /plan in its own worktree + stack, run in parallel, integrated one at a time. (d) The access request flow parked as 20260915-the-technician-access-request-flow-tech (waits for plan 2).
**Downstream** — Carried defects went into the parked bodies: query_spine statement_timeout (plan 3), v_schedule.local_day over naive starts_at and the merged visit report from a retracted note (plan 4). The retraction report to the planner joined 20260912-an-l2-status-flip-reports-to-the-planner. Every seat's tool list changed (17 technician tools, 42 manager) — any worktree touching src/mcp/tools/surface.expected.ts or src/eval/corpus.ts must merge main first. database.types.ts must be regenerated with gen:types:local after each of plans 2-4 merges, never hand-merged.
