---
date: 2026-09-14
task: fix the small board findings: listJobsForCustomer tiebreak, retract_capture customer-link test, decision-index finding rank, getCustomerContext batched fetch
status: complete
origin: 20260914-the-task-board-is-the-operator-s-a-sessi
files: src/db/jobs.ts, src/writePath/recordFieldNote.ts, src/mcp/tools/captures.ts, src/mcp/server.test.ts, scripts/decision-index.mjs, thoughts/by-file.json, src/db/context.ts, src/db/rawCaptures.ts, docs/engineering-memory.md, thoughts/shared/plans/2026-09-14-fix-the-small-board-findings.md, src/db/spine.test.ts, src/db/retractions.test.ts, src/work/decision-index.test.ts, src/db/visits.ts, thoughts/shared/plans/2026-09-15-fix-the-small-board-findings-part-2.md, src/mcp/tools/schedule.ts, src/mcp/tools/roster.ts, src/db/querySpine.test.ts, supabase/migrations/20260916130000_desk_answers_not_citable.sql, src/mcp/server.ts, src/mcp/tools/customers.ts, src/schedule/booking.ts, src/teamLead/planner.ts, src/teamLead/plannerPrompt.ts, src/writePath/recordFieldNote.test.ts, src/writePath/identityMatch.test.ts, src/db/phone.test.ts, supabase/migrations/20260916130100_customers_phone_key.sql, src/db/phone.ts, src/db/customers.ts, src/db/index.ts, src/console/consoleApi.ts, Box_Setup_Stuff/bootstrap-box.sh, Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md, docs/nemoclaw-tech-agent.md, src/schedule/booking.test.ts, supabase/migrations/20260916130200_v_customers_phone_key.sql
supersedes: nothing
---

## Files

- src/db/jobs.ts
- src/writePath/recordFieldNote.ts
- src/mcp/tools/captures.ts
- src/mcp/server.test.ts
- scripts/decision-index.mjs
- thoughts/by-file.json
- src/db/context.ts
- src/db/rawCaptures.ts
- docs/engineering-memory.md
- thoughts/shared/plans/2026-09-14-fix-the-small-board-findings.md
- src/db/spine.test.ts
- src/db/retractions.test.ts
- src/work/decision-index.test.ts
- src/db/visits.ts
- thoughts/shared/plans/2026-09-15-fix-the-small-board-findings-part-2.md
- src/mcp/tools/schedule.ts
- src/mcp/tools/roster.ts
- src/db/querySpine.test.ts
- supabase/migrations/20260916130000_desk_answers_not_citable.sql
- src/mcp/server.ts
- src/mcp/tools/customers.ts
- src/schedule/booking.ts
- src/teamLead/planner.ts
- src/teamLead/plannerPrompt.ts
- src/writePath/recordFieldNote.test.ts
- src/writePath/identityMatch.test.ts
- src/db/phone.test.ts
- supabase/migrations/20260916130100_customers_phone_key.sql
- src/db/phone.ts
- src/db/customers.ts
- src/db/index.ts
- src/console/consoleApi.ts
- Box_Setup_Stuff/bootstrap-box.sh
- Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md
- docs/nemoclaw-tech-agent.md
- src/schedule/booking.test.ts
- supabase/migrations/20260916130200_v_customers_phone_key.sql

## Notes

A JOB, approved onto the board by the operator 2026-09-14 in the board triage of plan
thoughts/shared/plans/2026-09-14-the-task-board-is-the-operators.md (Phase 3). Four small findings the
operator chose to FIX, folded into one task and one PR (precedent: PR #223,
20260910-harden-the-work-record-the-small-finding). The four findings are dropped + archived; their
notes are copied below word for word. Each was re-verified on origin/main 2026-09-14: still no id
tiebreak at src/db/jobs.ts:149; no customer_captures assertion in any src/mcp test; RANK doc = finding = 2
at scripts/decision-index.mjs:581 with prose mentions: 100 at :556, and src/mcp/server.ts's by-file slots
still hold two prose mentions; still one getRawCapture per id at src/db/context.ts:158.

Open small decision, for the operator when this is implemented: the size of the recentCaptures cap.
Overlap to size at spawn: the active task 20260912-the-model-names-the-job-on-the-ambiguous touches
src/db/jobs.ts and src/writePath/recordFieldNote.ts, and its plan pins the list it shows the model
because of the missing tiebreak.

### 20260914-listjobsforcustomer-orders-on-created-at

Found in plan review of 2026-09-11-the-model-names-the-job, 2026-09-14.

`listJobsForCustomer` (src/db/jobs.ts:149) is `.order('created_at', { ascending: true })` and nothing
else. Postgres gives no order guarantee between rows with equal sort keys, so two jobs created in the
same transaction or the same millisecond can come back in either order, and in a different order on
the next call.

Two things already rest on that order:
- PR #235's `mayGuess` arm takes `candidates[candidates.length - 1]` as the NEWEST non-terminal job for
  technician notes and manager decisions. On a tie that choice is arbitrary and can change between two
  deliveries of the same note.
- The `:600` closes-itself arm takes `priorJobs[priorJobs.length - 1]` as the most recent job of any
  status, with the same exposure.

The model-names-the-job plan does NOT rely on it: it pins the exact list it showed the model and maps
by id. That is why this was parked rather than folded in.

Fix is one line — a stable tiebreak, `.order('id', { ascending: true })` after `created_at` — but it
changes which job a tie resolves to, so it wants its own test pinning the new order rather than riding
along with unrelated work.

### 20260914-retract-capture-s-customer-captures-loop

A JOB. #235 added a loop to retract_capture so a retraction follows its target onto customer_captures links (now src/mcp/tools/captures.ts, the loop after listJobCapturesForCapture). No test drives retract_capture through the MCP server and asserts the retraction row lands on the customer link: #235's new tests call src/db and src/writePath directly (observed by grep + the combination review, 2026-09-14).
Evidence it matters: in the #239 merge this exact loop sat in an empty-HEAD conflict hunk. The suite passed 3,123/3,123 with the loop carried, and nothing in it would have failed had it been dropped; only a byte comparison against origin/main proved it survived.
Fix: a server.test.ts case — retract a capture that has a customer_captures link (no job), confirm, assert a customer_captures row for the retraction id. Out of scope for #239 (a pure move); parked from 20260911-split-src-mcp-server-ts-s-tool-registry.

### 20260914-decision-index-max-per-file-lets-prose-m

A JOB. After promoting 2026-09-11-split-src-mcp-server-ts-s-tool-registry (whose files: include src/mcp/server.ts), thoughts/by-file.json attaches it to src/mcp/tools/captures.ts and src/mcp/server.test.ts but NOT src/mcp/server.ts. server.ts's four slots (MAX_PER_FILE=4, scripts/decision-index.mjs:29) hold 2 engineering-memory entries (rank 1) + 2 generic prose mentions from docs/nemoclaw-tech-agent.md:4 and docs/onboarding.md:149 (statusClass 'doc', mentions: 100).
Cause (read from the code, observed 2026-09-14): RANK gives doc and finding the same rank 2 (:581), the tiebreak is mentions, and prose rules are hard-coded mentions: 100 (:556) while a finding carries its real, low count — so the comment at :531-538, which says a finding is ranked to survive the cap on busy files, does not hold whenever two prose mentions exist.
Consequence: the pre-edit hook never shows that finding to someone editing server.ts, the file where its trap (a pre-#239 branch's empty-HEAD conflict) actually bites. Likely true of other busy files (the comment says 52 of 96 are at the cap) — inferred, not counted. Out of scope for a doc-only promotion commit.

### 20260912-getcustomercontext-fetches-customer-link

Found during the Phase 1 review of plan 2026-09-11-the-door-stops-guessing (2026-09-12).

`getCustomerContext` (src/db/context.ts) fetches every id in `sourceIds` with ONE `getRawCapture`
round trip each:

    const fetched = await Promise.all([...new Set(sourceIds)].map((id) => getRawCapture(id)));

Today that list is bounded by the customer's jobs + visits, so it is small. Phase 1 added
customer-linked capture ids to the same list, and once Phase 2 lands, that source becomes "every
ambiguous inbound message this customer ever sent" — unbounded, and growing fastest for exactly the
chatty customers whose context gets read most. `listRawCapturesForCustomer` does the equivalent job
in a single query, so the shape is already available; a batched `.in('id', ids)` reader would keep
it flat. There is no `listRawCapturesByIds` today — adding one is why this was parked rather than
folded into Phase 1.

Relatedly: `recentCaptures` has no cap at all. That is pre-existing, but Phase 2 is what makes this
particular source grow without bound, so the two want deciding together.

Not urgent before Phase 2 lands in testing; it is a pilot-scale question, not a correctness one.

### Added by the operator 2026-09-15 — four more small fixes from the retrieval-layer audit

Found in thoughts/shared/research/2026-09-15-the-retrieval-and-delivery-layer.md (Findings, correctness
defects). Each is independent of the retrieval redesign, needs no design decision, and matches this
task's shape (small, tested, one PR). Line numbers are from origin/main 7c2370c.

**(5) unschedule_visit's confirm never checks what was approved.** The stage call writes a preview
(visitId, customerName, day) into the review item; the confirm call cancels by `d.visitId` alone
(src/mcp/tools/schedule.ts:1340-1366) and never compares the visit's current day/time against the staged
preview. Since rung 9b moves keep the visit id, a visit moved during the 15-minute window is cancelled at
its NEW time after the manager approved the OLD day. Fix: on confirm, re-read the visit and refuse
("the visit moved since you approved — restage") when starts_at differs from the staged preview's day;
test drives stage → move_visit → confirm and expects the refusal.

**(6) The planner can quote its own desk answers as evidence.** v_office_messages excludes
direction='to_agent' precisely so the planner's own words are never citable
(supabase/migrations/20260904120000_office_messages_read_surface.sql:60-74), but the desk writes its
answers as direction 'to_planner', kind 'desk' (src/teamLead/desk.ts:228-237), so spine_read (in
CITABLE_TOOLS, src/teamLead/planner.ts:1986) returns them. Fix is a decision between two one-liners:
exclude kind='desk' from the view (migration, applied by hand before merge — Calls-worker auto-deploys),
or write desk answers as 'to_agent' (check what reads them by direction first: the next tick's desk
appendix uses listDeskTranscriptsSince by kind, officeMessages.ts:202-220). Test: a desk answer row is
absent from a spine_read over v_office_messages.

**(7) add_technician_seat's confirm returns the whole technicians row.** insertTechnician does
`.select().single()` (src/db/technicians.ts:172) and the handler spreads `...created` into the result
(src/mcp/tools/roster.ts:422-430), so badge_hash, composio_* and telegram_user_id go into the model's
context. list_team deliberately projects those out (roster.ts:846). Fix: return the same projection
list_team uses; test asserts the confirm result has no badge_hash / composio keys.

**(8) Drifted model-facing text.** Four descriptions say things the code no longer does:
SPINE_VIEW_CATALOG says "sixteen views" (src/mcp/server.ts:143) but lists 18, and describes
v_office_messages as "BOTH ways … 'to_agent' is what you sent" (:235-239) while the view is to_planner
only; a handler comment says "SELECT on five views only" (:749-750); cancel_job promises a preview "with
any customer promise" (src/mcp/tools/customers.ts:221-222) but CancelJobVisit has no promise field (the
ladder was deleted, src/schedule/booking.ts:65-66, 1277-1283); get_connect_link is Gmail-only
(src/composio/pairing.ts:63-66, roster.ts:134) while AGENTS.md routes Sheets/Excel/Drive to it
(Box_Setup_Stuff/bootstrap-box.sh:784-789). Fix the text; the AGENTS.md line is a bootstrap-box.sh edit
(md5 rule: seven copies, memory bootstrap-copy-drift-trap) and needs a re-wire to reach the seats.

**(9) Phone numbers are matched as raw text (added 2026-09-15).** findCustomersByPhone is an exact
`.eq('phone', phone)` (src/db/customers.ts:137-145) on whatever the extractor or the inbound metadata
produced, and no normaliser exists in src, so "(555) 220-0100", "555-220-0100" and "+15552200100" are
three different people to the matcher — a known customer becomes a stranger and the planner gets an
inbound_unmatched ask. Fix: one small function (digits only, default country code +1 → E.164) applied at
BOTH ends — on write (createCustomer callers: src/writePath/recordFieldNote.ts createFrom, record_caller's
newCustomer in src/mcp/tools/customers.ts; the extractor's `phone`; `fallbackPhone` from
metadata.fromNumber; call_numbers if it stores raw) and on compare (findCustomersByPhone). Existing rows:
customers is not append-only, so one hand-applied data migration rewrites `customers.phone` to the same
form (pilot writes are OK per-path; prod stays read-only); until it is applied, the lookup will miss old
rows stored in another format, so apply it BEFORE merging (Calls-worker auto-deploys at merge). Tests: the
normaliser's cases; a match across two spellings of one number through recordFieldNote. Asking the
extractor for one format is worth adding to its prompt but is not the fix — a model instruction is a
request, and Twilio/Gmail metadata never went through the extractor.

**Size check (2026-09-15), on the operator's ask that everything here is actually small.** Originals
1–4: DONE on the branch (c41d1db, f2aace1, b9898d9 + a63d8fd, 9ffaac3, and 316d4d5's two extra
tiebreaks). (5) ~15 lines + 1 test — store starts_at in the staged preview, not just the day, or a
same-day time move slips through. (7) a projection, ~5 lines + 1 assertion. (8) text edits; the AGENTS.md
line needs a bootstrap-box.sh re-wire to reach seats (an ops step, not code). (6) two one-liners, but the
view route is a migration applied by hand before merge, and the write route ('to_agent') puts desk
answers into the planner's WHAT YOU SENT block (listRecentOutboundMessages reads to_agent from
TEAM_LEAD_REF) — pick before implementing. (9) ~30 lines + tests + one data migration. Nothing here needs
a design decision beyond (6)'s pick. The plan (thoughts/shared/plans/2026-09-14-fix-the-small-board-findings.md,
in the sibling worktree) covers phases 1–4 only; the resuming session adds phases 5–9 to it BEFORE
/implement continues — the plan is the review gate.

**(10) OpenClaw can switch tool search back on by itself (added 2026-09-15, ops-shaped).** Current
OpenClaw docs (https://docs.openclaw.ai/tools/tool-search, fetched 2026-09-15): "Local inference routes use
structured Tool Search automatically when `tools.toolSearch` is unset"; explicit `false` wins. Tool search
is OFF on every seat today by an explicit `false` (memory tool-search-hides-mandated-tools, verified
in-container 2026-08-12), but a rebuild wipes top-level `tools.*` (docs/engineering-memory.md:2831 — only
`agents.*` survives the merge), so a rebuild without a re-wire could leave the key unset — and if
`inference.local` counts as a local route, every spine tool goes behind tool_search/tool_describe with
no way to pin it: the 2026-08-04 resolve_date failure again, silently. Fix, small: (a) a guard in
Box_Setup_Stuff/bootstrap-box.sh that reads the in-container config after `wire`/rebuild and FAILS
loudly unless `tools.toolSearch === false` (~10 lines; seven-copies md5 rule applies); (b) one
engineering-memory entry stating the auto-on rule, the wipe, and that MCP tools cannot be kept
direct-visible under OpenClaw search. Verification is on the box, not in the suite: re-wire s2 (the
canary), read the config back, then the rest. Never `config patch` (memory
openclaw-config-patch-breaks-gateway). Open, cheap to settle while there: whether `inference.local` is
classified as local (grep the installed dist for the route-classification check).

NOT here: everything retrieval-shaped (folds, clamps, URL walls past the chunking already on this branch,
ordering, result size) stays with 20260915-customer-context-becomes-a-table-of-cont. Nothing is left
unplaced.

## Decisions

OPERATOR, 2026-09-15: four small fixes ADDED (above); still PAUSED — resume only on the operator's word.

OPERATOR, 2026-09-14: PAUSED. The operator paused this task the same day it widened 20260915-customer-context-becomes-a-table-of-cont into a redesign of the whole retrieval-and-delivery layer (tools for technicians, managers and the planner). Its committed work on the branch (id tiebreaks on four readers, chunked findRetractionsFor, the customer-link retraction test, the finding-rank fix) is untouched; whether it lands as-is or is reshaped by that redesign is the operator's call. Do not resume or open a PR without asking.

NOTE, 2026-09-14 (from the parking task 20260914-the-task-board-is-the-operator-s-a-sessi): its commit
4c1ae5d adds an `emit()` helper near the top of scripts/decision-index.mjs, so once that branch merges
the line numbers quoted above for that file move +11: mentions: 100 at :567 (was :556), RANK at :592
(was :581), the ranking comment at :542-549 (was :531-538). MAX_PER_FILE stays at :29. The code is
unchanged; `--check` now exits 1 on a stale index, which this task can use to verify its rank fix.

## Handoff 2026-09-15T04:33:55.413Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/fix-the-small-board-findings-listjobsfor on work/fix-the-small-board-findings-listjobsfor, from origin/main 7c2370c.

Overlap check: 5 overlaps with active tasks — the operator read them and proceeded (--proceed):

  MED   calls what it names src/db/jobs.ts › listJobsForCustomer
        20260914-fix-the-small-board-findings-listjobsfor names this file and mentions `listJobsForCustomer`; called at 1 site in 1 file 20260912-the-model-names-the-job-on-the-ambiguous lists (src/writePath/recordFieldNote.ts); 4 modules import it repo-wide
  MED   calls what it names src/db/rawCaptures.ts › getRawCapture
        20260914-fix-the-small-board-findings-listjobsfor names this file and mentions `getRawCapture`; called at 1 site in 1 file 20260912-the-model-names-the-job-on-the-ambiguous lists (src/writePath/recordFieldNote.ts); 6 modules import it repo-wide
  LOW   same file only      src/db/jobs.ts
        20260912-the-model-names-the-job-on-the-ambiguous lists it but has not changed it; 20260914-fix-the-small-board-findings-listjobsfor names it
  LOW   same file only      src/writePath/recordFieldNote.ts
        20260912-the-model-names-the-job-on-the-ambiguous lists it but has not changed it; 20260914-fix-the-small-board-findings-listjobsfor names it
  LOW   generated file      thoughts/by-file.json
        20260912-the-model-names-the-job-on-the-ambiguous changes it; 20260914-fix-the-small-board-findings-listjobsfor names it — regenerate it after merging (npm run decisions:index); never merge it by hand

## Handoff 2026-09-15T20:55:51.757Z

**What changed** — Two PRs, both merged and live. #243 (items 1–4): `listJobsForCustomer`/`listOpenJobsForCustomer` break a created_at tie on id; a retract_capture customer_captures test driven through the MCP server; `findRetractionsFor` chunks at 150 deduped ids in parallel (it 414'd past ~205 ids); decision-index ranks a finding above a docs/ prose mention. In-place from its review: id tiebreaks on the unscheduled queue and `listVisitsForCustomer`'s comparator. #244 (items 5–10 + the final review): the unschedule_visit and cancel_job yes refuses unless the visit/visits are still exactly what the preview showed (wall-clock snapshot in the review item; the cancel UPDATE is a compare-and-set on starts_at/ends_at); add_technician_seat returns an allowlist; desk answers (to_planner, kind 'desk') leave v_office_messages; drifted catalog/prompt text corrected; `customers.phone_key` (generated: digits, leading US 1 dropped, null <7) is what every phone lookup compares, exposed to the planner via v_customers and stripped from find_customer / get_customer_context; `bootstrap-box.sh wire` fails unless tools.toolSearch reads back false and `verify` reports it; AGENTS.md rule 8 routes only Gmail to get_connect_link. Live: pilot migrations 20260916130000/130100/130200 applied before merge (80/80 phones keyed, no shared key in a firm); all six seats wired (s2 canary first, then s3 s5 s6 s7 s8), verify 31/0; Calls-worker live on cb53234.
**Decisions** — (operator) getCustomerContext batch+cap DROPPED, redesign parked as 20260915-customer-context-becomes-a-table-of-cont (since shipped as #242); the ~16 other readers past the URL wall and 5 unpaged readers belong to that retrieval task, not here. (operator) 1–4 and 5–10 as separate PRs. (operator) phone: a generated match key, not an E.164 rewrite of stored phones; 11-digit-starting-with-1 = US +1 accepted as a known limit. (operator) cancel_job folded in; phone_key exposed to the planner, hidden from seats; box rollout done in this task. (mine) tiebreak on id, not a sequence column (no migration); desk view filter, because a to_agent desk row violates the table CHECK; board/console cancel buttons left out (one dialog, seconds apart); snapshots are wall-clock text because list_pending_reviews shows the detail to the model; rule 8 corrected twice at review (managers CAN connect other accounts via Composio; technicians have no get_connect_link).
**Assumptions** — The hosted gateway's URL limit is at least the local one: the hosted key check accepted a 23 KB URL, but fetching a publishable key for a full-path read was refused by the permission classifier, so the full hosted path is unmeasured. Crew changes after a cancel preview don't matter (snapshot ignores technicianRefs).
**Open** — None for this task. Not done here, owned elsewhere: the retrieval task should project phone_key out of customer_contents in SQL (note left in its record); six stale bootstrap-box.sh copies remain on trades-box-1 (~/bootstrap-box.sh, ~/bss-repo, ~/stage-deepinfra-retire, ~/deploy-recycler, two .prev dirs) — reported, not deleted.
**Downstream** — Lessons, not fixes: (1) MEASURED: through the local gateway a PostgREST `in.()` fails with 414 at ~205 uuids (8192 bytes; postgrest-js percent-encodes `( , )`), so the repo's CHUNK=500 loops are wrong. (2) TRAP: JSONB reorders object keys — `JSON.stringify` equality on a value round-tripped through a jsonb column silently reports "changed"; compare field by field. (3) TRAP: `nemoclaw` is not on PATH in a non-login ssh shell on trades-box-1 — `wire` dies at "egress policy: nemoclaw: command not found"; run it inside `bash -lc`. (4) MEASURED in OpenClaw 2026.6.34: `inference.local` is classified local, but tool search only auto-enables with `experimental.localModelLean`, which no seat sets. (5) A new column on `customers` rides into every `customers%rowtype` / `to_jsonb(row)` payload a model sees. The sibling 20260912-the-model-names-the-job-on-the-ambiguous touches recordFieldNote.ts; nothing here changed that file beyond a test fixture.
