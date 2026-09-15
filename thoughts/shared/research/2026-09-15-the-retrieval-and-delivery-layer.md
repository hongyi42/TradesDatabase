---
date: 2026-09-15
branch: work/customer-context-becomes-a-table-of-cont
commit: 5479718
topic: The retrieval-and-delivery layer — how every tool (technician, manager, planner) and every pushed prompt block gets data out of the spine, audited against nine retrieval goals; how the tool catalog itself reaches the models and what tool-retrieval approaches this stack can reach; and where the infrastructure degrades as data grows
supersedes: nothing
---

**Builds on** `thoughts/shared/research/2026-09-14-customer-context-becomes-a-table-of-contents.md`,
which covers `get_customer_context` in depth and is not repeated here. The operator widened the task
on 2026-09-14 (decisions in `.claude/work/tasks/20260915-customer-context-becomes-a-table-of-cont.md`):
the read moves into the database, keyword search is enough for technicians, and scope is now the
whole layer.

**Method.** The evidence comes from six read-only sweeps, run in parallel and each checked against
the same nine goals:
1. customers, captures, money and review tools;
2. schedule tools;
3. roster, office and comms tools, the hub's own tools, free-SQL views, delivery path and catalog
   size;
4. planner and desk pushed blocks and pulled tools, plus write-path lookups;
5. tool-retrieval approaches, from live vendor docs;
6. scale readiness.

Every high-severity claim below was re-read by hand against the code, or re-fetched from the vendor
page, before it went into this document. Claims that could only be inferred (not executed) are
marked **(unverified)**. Nothing was run, no database was queried, and no size here comes from the
pilot database.

## Summary

The **spine** is a database: customers → jobs → visits, plus verbatim "captures" of every note,
call and email. Three kinds of AI caller read it:

- **technician seats** (17 tools);
- **manager seats** (43 tools, plus the Composio app catalog);
- **the planner** (7 tools, plus large blocks of data *pushed* into its prompt each tick).

Every one of those reads is a small TypeScript function in `src/db/` that asks Supabase's web API
(PostgREST) for rows and then applies the business rules in code. The rules are: which captures
belong to a job, drop what was retracted, hide `manager_only` rows, check the firm, sort, page. The
exceptions are four database functions, and a set of SQL views for free-form SQL that apply *some*
of the rules and leave the rest to the model.

**The central finding is that there is no retrieval layer as such.** Each of about 90 readers
re-applies the rules for itself, and they disagree:

- six different definitions of "a job's or customer's captures";
- four different visibility rules for captures;
- a retraction fold hand-written at least five times.

On top of that sit PostgREST's two hard limits, which the code handles inconsistently:

- **The silent 1000-row cap.** Many list readers never page, so large results come back quietly
  truncated.
- **The ~8,192-byte URL limit.** Id lists sent in URLs fail at about 205–215 UUIDs. Several readers
  split lists into chunks of 500, which is *above* that wall, and several do not split them at all.

Nothing on the delivery path (hub, doorman relay, Composio relay) bounds result size.

The same pattern produces correctness bugs found along the way:
- a staged visit cancellation that can cancel the wrong time;
- the planner able to quote its own desk answers as evidence;
- a retracted note whose labor hours stay on the trip;
- planner ticks and watcher passes that will fail deterministically once one firm has about 200 open
  items.

**On tool retrieval,** three facts from live vendor docs change what the repo says. OpenRouter now
offers server-side tool search for any model, but only on APIs our stack does not call. OpenClaw's
tool search treats MCP tools (every spine tool) worst of all. OpenClaw also turns tool search on
automatically for local model routes when the setting is unset. Independent benchmarks show that
retrieving a subset of tools can *lower* accuracy when a needed helper tool is not named by the
question. That is the failure this repo already hit with `resolve_date`.

## Entry Points

```
             ┌──────── technician seat ────────┐   ┌──────── manager seat ──────────┐
Telegram ──► │ OpenClaw gateway (Lightsail box)│   │ same + Composio MCP server     │
             └───────────────┬─────────────────┘   └───────────────┬───────────────┘
                             │ MCP over HTTPS via doorman.mjs      │ /composio relay
                             ▼                                     ▼
             Render: src/mcp/httpServer.ts → server.ts dispatch     src/composio/relayHandler.ts
                    tools/list (17 or 43) · gates · dropSensitive   (pipes Composio results through)
                    DOMAIN_HANDLERS → src/mcp/tools/*.ts
                    switch: ask_team_lead · query_spine/spine_read
                             │
                             ▼
                    src/db/*.ts (supabase-js → PostgREST → Postgres)  ·  query_spine() RPC → v_* views

 Render cron lifecycle-heart (every 5 min): watchers.ts → planner.ts (per firm, serial)
   planner: pushes blocks into the prompt → src/model/toolLoop.ts → OpenRouter /chat/completions (GLM 5.3)
            pulls with 7 tool schemas dispatched through the same server.ts dispatch
```

| Entry | Where |
|---|---|
| Seat tool listing | `src/mcp/server.ts:828-843` (`tools/list` serves `MANAGER_TOOLS` or `TOOLS` by the active-manager check); pinned lists `src/mcp/tools/surface.expected.ts:26-44` (technician 17), `:47-74` + `:112-116` (manager 43), `:81-89` (planner 7) |
| Seat tool dispatch | `src/mcp/server.ts:560-786`: roster read `:567`, cost row `:581-596`, tier gates `:613-664`, `dropSensitive` `:671-672`, `DOMAIN_HANDLERS` `:676-692`, switch `:694-786` |
| Result delivery | `src/mcp/server.ts:860-902`: board link, `now` rider on object results only (arrays keep their shape, `:886-892`), `JSON.stringify` with no size cap (`:902`) |
| Doorman relay | `Box_Setup_Stuff/doorman.mjs`: buffers the request, streams the response (`:76`), no size cap or timeout |
| Composio relay | `src/composio/relayHandler.ts:94-122`, `:217`: results piped through unchanged, never through dispatch |
| Planner tick | `src/jobs/lifecycle.ts:466` (watchers) → `src/teamLead/planner.ts:4153` (firms in series) → prompt assembly `:3379-3445` → `runToolLoop` with `maxTurns: null` (`:4914`) |
| Desk | `ask_team_lead`, `src/mcp/server.ts:695-737` → `src/teamLead/desk.ts:141` |
| Free SQL | `query_spine` / `spine_read`, `src/mcp/server.ts:744-783` → `src/db/querySpine.ts:26-74` → `supabase/migrations/20260806120000_query_spine_reader.sql:179-214` |

## Key Files

**Tool modules** (declare tools per tier and their handlers; tier membership is declarative,
`src/mcp/tools/types.ts:63-74`):
- `src/mcp/tools/customers.ts`: find_customer, get_customer_context, get_job, brief_customer,
  answer_customer_question (base); open_job, cancel_job, update_job (admin); record_caller
  (team lead plus manager seat).
- `src/mcp/tools/captures.ts`: record_field_note, list_recent_captures, retract_capture,
  record_standing_fact (base); read_job_note, write_job_note (team lead).
- `src/mcp/tools/schedule.ts`: resolve_date, get_schedule (base); get_team_schedule, book_visit,
  move_visit, unschedule_visit, find_slots, get_availability, set_availability, add_time_off,
  remove_time_off, set_job_duration, set_technician_horizon (admin).
- `src/mcp/tools/roster.ts`: add/deactivate/reactivate_technician_seat, get_connect_link,
  bind_telegram, list_team, set_technician_skills, set_firm_profile (admin).
- `src/mcp/tools/office.ts`: inform_team_lead, inform_teammate (base); recall_decisions,
  read_memory, write_memory (team lead).
- `src/mcp/tools/comms.ts`: send_email, web_search, read_webpage (base).
- `src/mcp/tools/money.ts`: record_money_event. `src/mcp/tools/reviews.ts`: list_pending_reviews,
  resolve_review (admin).
- `src/mcp/tools/shared.ts`: `inboundAskFor` (`:616-680`), `commitNote` (`:400-492`),
  `currentFactValue` (`:507-517`), `leanGrounding` (`:753`).

**Readers** (`src/db/`):
- `rawCaptures.ts`: every capture reader, `findRetractionsFor` `:316-324`, `listJobEvidenceSince`
  `:357-496`, `listL2CitingCapture` `:555-673`, `findCustomersByThread` `:737-896`,
  `listCapturesByThread` `:917-992`.
- `context.ts`: the customer bundle.
- `visits.ts`: visit readers, including `listVisitsForTenant` `:791-808`, `listUnplaced`
  `:1179-1189`, `listUnassignedVisitsWithRefs` `:1249-1292`.
- `jobs.ts`: `listJobsWithCustomerByIds` `:179-210`, CHUNK 500 at `:193`.
- `moneyEvents.ts`: `listMoneyEventsForJob(s)` `:222-247`, `summarizeMoney` `:446`.
- `nudges.ts`: `listNudgesByStatus` `:114-127`.
- `observations.ts`, `nudgeDecisions.ts` (CHUNK 500 at `:70`), `officeMessages.ts`,
  `reviewItems.ts`.
- `foldImpact.ts`: the retraction preview scan, `:72-214`.
- `querySpine.ts`: the free-SQL RPC wrapper.

**Planner, desk, write path:**
- `src/teamLead/planner.ts`: gap views `:1349-1860`, evidence bounds `:626-648`, tick reads
  `:4214-4843`.
- `src/teamLead/plannerPrompt.ts`, `desk.ts`, `deskPrompt.ts`, `memory.ts`.
- `src/model/toolLoop.ts`: limits `:46-105`, truncation `:656-665`, serial calls `:765-838`.
- `src/jobs/watchers.ts`: detection, alarm pass `:744-833`.
- `src/writePath/identityMatch.ts`, `recordFieldNote.ts`, `attachNote.ts`.
- `src/schedule/booking.ts`, `boardRead.ts`, `fit.ts`, `routes/daySource.ts`.

**SQL surface:**
- `supabase/migrations/20260806120000_query_spine_reader.sql`: `spine_reader` role, function,
  original views.
- Later `v_*` views: `20260823120000`, `20260904120000`, `20260906140000`, `20260907100100`,
  `20260908100000`, `20260912100000`.
- `supabase/config.toml:18`: `max_rows = 1000`.

**Seat configuration:**
- `Box_Setup_Stuff/bootstrap-box.sh`: tools.deny `:1319`; context windows `:557-571`; seat model
  API `openai-completions` `:1466`; AGENTS.md doctrine.
- `src/composio/sessions.ts:20-42`: manager session is the full catalog with meta-tools;
  technician session is three Gmail tools.

## Data Flows

### 1. The nine goals, and the audit scorecard

| Code | Goal | What it means |
|---|---|---|
| G1 | Complete | Every row that belongs is found |
| G2 | Nothing cut silently | Any limit or clamp is announced to the caller |
| G3 | Only what the caller may see, by construction | Tenant check on every hop, tier/sensitivity, retraction fold |
| G4 | Same answer every time | Total, stable ordering |
| G5 | Small regardless of history | Rows *and* text bounded |
| G6 | Fast | Few round trips; the common question ends in one call |
| G7 | Points to evidence | Returns ids the model can cite or act on |
| G8 | Says when something is empty | In words, not a bare `[]` or `null` |
| G9 | One shared definition | Uses a shared reader or rule, not a local copy |

Legend: ✓ holds · ~ partial or by convention · ✗ does not hold · · not applicable. The line
citations behind each cell are the audit reports' evidence. The worst cells are expanded under
Findings below.

**Technician-tier (base) tools**, which managers also get except `get_schedule`:

| Tool | G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 | G9 | Handler |
|---|---|---|---|---|---|---|---|---|---|---|
| find_customer | ~ | ✗ | ✓ | ✗ | ~ | ✓ | ✓ | ✗ | ✗ | customers.ts:360 |
| get_customer_context | ✗ | ✗ | ~ | ✗ | ✗ | ~ | ✓ | ✗ | ~ | customers.ts:379 |
| get_job | ~ | ✗ | ✓ | ✓ | ✗ | ✓ | ~ | ✗ | ✗ | customers.ts:434 |
| brief_customer / answer_customer_question | ✗ | ✗ | ~ | ✗ | ~ | ~ | ✓ | ✓ | ~ | customers.ts:499 / :522 |
| list_recent_captures | ✗ | ✗ | ~ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | captures.ts:593 |
| record_field_note | ~ | ~ | ~ | ~ | ~ | ~ | ~ | ~ | ✓ | captures.ts:284 |
| retract_capture | ~ | ~ | ~ | ✗ | ~ | ✗ | ✓ | ~ | ~ | captures.ts:640 |
| record_standing_fact | ✓ | ✓ | ~ | ✓ | ✓ | ~ | ~ | ~ | ~ | captures.ts:860 |
| resolve_date | · | · | ✓ | ✓ | · | ✓ | · | ✓ | ~ | schedule.ts:578 |
| get_schedule | ~ | ✓ | ~ | ~ | ✓ | ✓ | ✗ | ~ | ✗ | schedule.ts:614 |
| inform_team_lead | · | ~ | ✓ | ✓ | ✓ | ✓ | ✗ | ~ | · | office.ts:184 |
| inform_teammate | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | · | office.ts:258 |
| send_email | · | ✗ | ~ | ✓ | ~ | ~ | ~ | · | ~ | comms.ts:200 |
| web_search | ~ | ~ | · | ✗ | ~ | ✓ | ✓ | ✗ | · | comms.ts:112 |
| read_webpage | ✓ | ~ | · | ✓ | ~ | ✓ | ✓ | ✗ | · | comms.ts:157 |
| ask_team_lead | ~ | ✗ | ~ | ✗ | ✓ | ~ | ✗ | ✓ | ~ | server.ts:695 |

**Manager-only tools:**

| Tool | G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 | G9 | Handler |
|---|---|---|---|---|---|---|---|---|---|---|
| get_team_schedule | ✗ | ✗ | ✗ | ~ | ✗ | ~ | ✓ | ~ | ✗ | schedule.ts:707 |
| find_slots | ✗ | ✗ | ~ | ~ | ~ | ✗ | ✓ | ✓ | ~ | schedule.ts:1608 |
| book_visit | ✓ | ✓ | ✗ | ~ | ~ | ~ | ✓ | · | ~ | schedule.ts:968 |
| move_visit | ✓ | · | ✓ | · | ✓ | ✗ | ~ | ✓ | ~ | schedule.ts:1166 |
| unschedule_visit | · | · | ✗ | · | ✓ | ✓ | ~ | · | ~ | schedule.ts:1272 |
| get_availability | ~ | ~ | ✓ | ~ | ✓ | ~ | ~ | ~ | ~ | schedule.ts:1432 |
| set_availability · add_time_off · remove_time_off · set_job_duration · set_technician_horizon | mostly · / ✓; add_time_off reads no existing visits; remove_time_off deletes serially | | | | | | | | | schedule.ts:1388-1606 |
| open_job | ✓ | ~ | ~ | ✗ | ~ | ~ | ~ | ✓ | ✓ | customers.ts:539 |
| cancel_job | ~ | ~ | ~ | ~ | ~ | ✗ | ✓ | ~ | ✓ | customers.ts:616 |
| update_job | · | · | ✓ | · | ✓ | ✓ | ✓ | ✓ | ✓ | customers.ts:1032 |
| record_caller | ✓ | ✓ | ~ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | customers.ts:731 |
| record_money_event | ~ | ✗ | ~ | ✓ | ✓ | ~ | ~ | ✓ | ~ | money.ts:111 |
| list_pending_reviews | ~ | ✗ | ~ | ✗ | ✗ | ✓ | ✓ | ✗ | · | reviews.ts:62 |
| resolve_review | · | · | ✓ | · | ~ | ✓ | ✓ | ✓ | ~ | reviews.ts:73 |
| add_technician_seat | ✓ | ~ | ~ | ✓ | ✓ | ~ | ✓ | · | · | roster.ts:284 |
| deactivate_technician_seat | ✓ | ✗ | ✓ | ✓ | ✓ | ~ | ✓ | · | · | roster.ts:454 |
| reactivate_technician_seat | ✓ | ~ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | roster.ts:577 |
| get_connect_link | ~ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | roster.ts:686 |
| bind_telegram | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | ✓ | ✓ | ✓ | roster.ts:742 |
| list_team | ✓ | ~ | ✓ | ✓ | ~ | ✓ | ✓ | · | ~ | roster.ts:844 |
| set_technician_skills · set_firm_profile | ✓ throughout; set_firm_profile has a parallel `v_firm_profile` projection (G9 ~) | | | | | | | | | roster.ts:867, :889 |
| query_spine | ~ | ~ | ~ | ✗ | ~ | ~ | ~ | ✗ | ~ | server.ts:744 |

**Planner tools:**

| Tool | G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 | G9 |
|---|---|---|---|---|---|---|---|---|---|
| spine_read | ~ | ~ | ~ | ✗ | ~ | ~ | ✓ | ✓ | ✓ |
| recall_decisions | ~ | ✗ | ✓ | ✓ | ~ | ✓ | · | ✗ | ~ |
| read_memory / write_memory | ✓ | ✓ | ✓ | · | ~ | ✓ | · | ✓ | ✓ |
| read_job_note / write_job_note | ✓ | · | ✓ | · | ✓ | ✓ | ✓ | ✓ | ✓ |
| record_caller | see manager table | | | | | | | | |

**Planner pushed blocks** (built each due tick, `planner.ts:3379-3445`):

| Block | Builder | Bound | Main gaps |
|---|---|---|---|
| Memory index | `memory.ts:180-221` | ≤3000 chars (enforced only when written); 10 orphan paths plus "(+N more)" | Empty and failed reads both render `''` (`planner.ts:4726-4732`); no path-listing tool |
| THE TEAM | `listTeam` (unpaged) → `buildReachableBlock` `:1307-1341` | one line per active person | A failed read silently omits the block, and then every `to` is refused as "nobody by that name" (`:4661-4663`, `:2284-2289`) |
| Gap list + count | `listNudgesByStatus` (**unpaged**, `created_at` only, `nudges.ts:114-127`) + `listObservationsByStatus` (paged) | **unbounded count** | Silent 1000 clamp on nudges; unbounded `asked` attributes, `matchReason`, candidate lists (`:1560-1595`, `:1901-1916`) |
| – evidence lines | `listJobEvidenceSince`, once per firm (`:4434`) | ≤6 per gap × 600 chars (`:626-629`) | Lines carry **no capture id** (`:1828-1832`); the cut is unannounced; one firm-wide floor = oldest gap, up to 365 days (`:4428-4434`, `:637`) |
| – money lines | `listLiveMoneyEventsForJobsSince` | ≤6 | No event ids, no hidden count |
| – moot fact | `listL2CitingCapture` + visits-since | 1 line | No tenant filter; "created from this capture" gives no row id; `source_capture_id` is in no `v_*` view, so it cannot be checked |
| OFFICE MESSAGES | `listOfficeMessagesByStatus` (paged) | 30 shown × ≤2000 chars | Announces "N more unread"; ids shown |
| – desk appendix | `listDeskTranscriptsSince` (`limit(1000)`, `created_at` only) | 5 pairs, 200/300 chars | No hidden count, no ids |
| WHAT YOU SENT | `listRecentOutboundMessages` | 12 shown, 14 days | Announces "(N older)"; ids shown |
| Recover sets (not rendered) | `listDismissedObservationIds`, `listDismissedNudgeIds` | every dismissed id ever, read in series (`:4365-4382`) | Grows forever |

### 2. Where the rules live today

```
                   which captures belong?        who may see it?                  how many / what order?
seat tools         each reader picks its own     tenant: per handler (parent)     1000 clamp: per reader (many unpaged)
                   union (6 variants)            sensitivity: dropSensitive,      URL wall: per reader (CHUNK 500 / 200 /
                                                   applied per handler              150 / none)
                                                 retraction: fold per reader      order: per reader (many not total)
                                                   (≥5 copies)
planner pushes     listJobEvidenceSince (3 arms) drops manager_only, folds        6 × 600 chars, silent
spine_read / SQL   model joins 3 link views      tenant by GUC; sensitivity NOT   LIMIT ≤1000; no order; text unbounded
                                                 filtered; retractions LABELLED
write path         findCustomersByThread etc.    tenant per hop; retracted and    caps 150/500 with refusal
                                                 manager_only NOT folded
delivery (hub)     —                             —                                no byte cap; arrays get no `now`, no
                                                                                  empty wording
Composio relay     —                             no tier filter, no fold          no cap (engineering-memory.md:1817
                                                                                  "routes around dispatch")
```

**Six capture-membership unions:**
1. `context.ts:85-159`: customer stamp + `source_capture_id` + `customer_captures`.
2. `captures.ts:606-613`: one stamp only.
3. `rawCaptures.ts:357-496`: job stamp + `visit_notes` + `job_captures`.
4. `rawCaptures.ts:555-673`: `source_capture_id` + `job_captures` + `visit_notes` (+ customers).
5. `rawCaptures.ts:169-206`: source ids + four link arms.
6. `captures.ts:786-807`: the retraction's link-follow.

`listJobStampedCaptureTimes` (`rawCaptures.ts:239-295`) is a seventh variant, covering times only.

**Four visibility rules for captures:**
1. Pushed evidence drops `manager_only` and folds retractions (`rawCaptures.ts:486-491`). Its comment
   still says "the team lead holds no manager badge".
2. `v_captures` shows `manager_only` and only *labels* retractions
   (`20260823120000_planner_read_surface.sql:20-27`).
3. Seat tools apply `dropSensitive` per handler (`server.ts:671-672`).
4. The inbound `words` shown on a planner gap are a write-time copy that no later fold reaches
   (`recordFieldNote.ts:409`, `:531`).

Rules 1 and 2 are both citable by the planner (`planner.ts:1986`).

**Retraction fold of facts and correspondence:**
- `context.ts:173-211`
- `customers.ts:368-376`
- `customers.ts:449-495`
- `shared.ts:507-517`
- `schedule.ts:1984-1993`
- `boardRead.ts:464-474`

### 3. PostgREST's two limits, reader by reader

**Silent 1000-row clamp.** These readers have no `.range()` paging, so the result grows with history
and past 1000 rows the caller gets a truncated list without knowing it:

| Reader | What is dropped | Callers |
|---|---|---|
| `listRawCapturesForCustomer` / `ForJob` | oldest | get_customer_context, list_recent_captures |
| `listLinkedCapturesForCustomer` | arbitrary | get_customer_context |
| `listJobsForCustomer` | newest | get_customer_context, recordFieldNote, record_caller |
| `listVisitsForTenant` (`visits.ts:791-808`) | latest days | get_team_schedule, find_slots (so booked time reads free) |
| `listVisitsWithRefsForTenant` | latest days | board (14 days) and console (45 days) |
| `listUnplaced`, `listUnscheduledOpenJobsWithCustomer` | newest | get_team_schedule, board tray |
| `listNudgesByStatus` | newest | planner gap list, desk, watcher alarm pass |
| `listQueuedNudgesForHost` | newest | host nudge delivery |
| `listOpenReviewItems`, `findOpenReviewItemsByKind` | newest | list_pending_reviews, watcher auto-resolve |
| `listMoneyEventsForJob(s)` (`moneyEvents.ts:222-247`, ordered id asc) | **newest events** | money summaries and derived job status |
| `listExpiredAudio` | arbitrary 1000 per night | Calls-purge |

The comment beside `moneyEvents.ts:326-330` already calls `listMoneyEventsForJobs` "exposed to
PostgREST's silent 1000-row cap".

Two readers page but with **no total order**, so rows can repeat or be skipped across pages:
- `findFoldImpact` (`foldImpact.ts:95-104`): no `.order()` at all;
- the evidence arms: `captured_at` only at `rawCaptures.ts:377`, `created_at` only at `:401`.

**URL wall (~205–215 UUIDs).** Measured locally: 150 ids = 5,929 bytes OK, 214 = 8,425 bytes
refused. The sibling task's plan records it; the hosted limit is **(unverified)**.
- **Chunked at 500, above the wall:**
  - `listJobEvidenceSince` (`rawCaptures.ts:364`)
  - `listDecisionsForNudges` (`nudgeDecisions.ts:70`)
  - `listLiveMoneyEventsForJobsSince` and `listJobIdsWithCostEvents` (`moneyEvents.ts:268`, `:352`)
  - `listJobsWithCustomerByIds` (`jobs.ts:193`)
- **Unchunked:**
  - `findRetractionsFor` (`rawCaptures.ts:316-324`)
  - `listJobStampedCaptureTimes` and `listNoteTimesForJobs`, fed by the watcher (`watchers.ts:432-456`)
  - `listMoneyEventsForJobs`
  - `listJobNoteMeta`, `listOfficeMessagesByIds`, `stampObservationsPinged`
  - the three subject-ref probes (composite refs, wider than a UUID)
- **Chunked at 200, just under the wall:** `listL2CitingCapture`, `listVisitsByIds`.
- **Capped at 150 and refusing above it:** `findCustomersByThread`.

The paused sibling task, `20260914-fix-the-small-board-findings-listjobsfor`, has already committed
two changes on its own branch: `findRetractionsFor` chunked at 150, and id tiebreaks on four readers.
Neither is on `main`.

### 4. Round trips per call and per tick

- **Every dispatched tool call** costs a roster read plus a `cost_events` insert before its own work
  (`server.ts:567`, `:581`). `spine_read`/`query_spine` adds a `query_audit` insert. The HTTP server
  builds a fresh MCP server per request, so `tools/list` also reads the roster each time
  (`httpServer.ts:862-865`).
- **Heavy single calls:**

  | Call | Round trips |
  |---|---|
  | `find_slots` | about 9 + T sequential (T = eligible technicians; serial time-off read per person, `fit.ts:402-403`); no_fit adds about T + 8 |
  | `move_visit` | about 19, because `resolveMove` runs twice (`booking.ts:808`, `:847`) |
  | `book_visit` | about 9–12 + 3 per extra crew member, plus a tenant-wide open-observation scan in `inboundAskFor` (`shared.ts:629`) |
  | `record_caller` | about 8 stages + the full note door + an extractor model call |
  | `retract_capture` | two whole-firm customer and job attribute scans (stage and confirm) |
  | `get_customer_context` | 6 sequential stages + one request per linked capture (`context.ts:158`) |

- **One planner tick for one firm:** about 22–30 round trips across about 15 sequential stages
  before the model runs. Then 1 provider call + 1 cost insert per turn, and tool calls run one at a
  time (`toolLoop.ts:765-838`). The turn count is unlimited inside the 15-minute budget
  (`planner.ts:4914`). **Firms run in series** (`planner.ts:4153`); watcher tenants also run in
  series first (`watchers.ts:334`).
- **Seats:** zero assistant messages with two or more tool calls (`docs/engineering-memory.md:2867-2871`).
  Each extra model call costs about 3–5 s. The gateway's per-call MCP timeout is 60 s
  (`docs/engineering-memory.md:4821-4822`).

### 5. How the tool catalog reaches the models

Static estimate from the definitions (compact JSON, chars/4, ±10%; excludes MCP envelope and
provider wrapping):

| Caller | Tools | ≈ chars | ≈ tokens | Plus |
|---|---|---|---|---|
| Technician seat | 17 spine | 20,358 | ~5.1k | OpenClaw natives minus 10 denied (`bootstrap-box.sh:1319`) |
| Manager seat | 43 spine | 68,667 | ~17.2k | OpenClaw natives; Composio MCP (six meta-tools in front of the whole app catalog, `src/composio/sessions.ts:26-35`) |
| Planner | 7 | 16,660 | ~4.2k | pushed prompt blocks |

- **Largest definitions:** `query_spine` 10,545 chars, `spine_read` 9,935, `book_visit` 4,649,
  `resolve_date` 3,830, `record_money_event` ~3,562, `find_slots` 3,439.
- **The SQL view catalog** (`SPINE_VIEW_CATALOG`, `server.ts:142-249`) is 8,203 chars. That is 15% of
  the manager catalog and 60% of the planner's.
- **Recorded per-turn costs** (GLM era): a fixed baseline of about 30,500 tokens (system prompt +
  AGENTS.md + schemas), and a cold turn of 33–38k tokens.
- **Muse/OpenRouter era** (`docs/engineering-memory.md:7010-7015`): 40 schemas added about 0 s to
  time-to-first-token, a 33k-token prompt added about 1 s, 67.7% of prompt tokens were cached, and
  the median cost was $0.064 per eval question.
- **Vendor guidance:** Anthropic says tool-selection accuracy "degrades once you exceed 30–50
  available tools" (https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).
  Google's Gemini function-calling best practice is "Keep active set to 10-20 tools maximum"
  (https://ai.google.dev/gemini-api/docs/function-calling). Both were fetched 2026-09-14/15.

### 6. Tool-retrieval approaches and what this stack can reach

The three shapes:

```
direct (today)   request = [every schema] + prompt   → model picks
retrieval        request = [pinned core + search]    → model searches → schema loads → model calls
code             request = [exec]                    → model writes a program that searches and calls
```

Wiring today:
- **Seats:** OpenClaw → `inference.local` using the `openai-completions` API
  (`bootstrap-box.sh:1466`) → OpenRouter, with Gemini 3.8 Flash primary and Muse 1.3 as fallback.
- **Planner:** `toolLoop.ts` POSTs to OpenRouter `/chat/completions` with GLM 5.3.

| Approach | How it works | Evidence | Seats | Planner |
|---|---|---|---|---|
| Full catalog + prompt caching | today | above | live | live |
| Static scoping | fixed subset per identity | per-badge `tools/list`; `tools.deny`; OpenClaw documents `mcp.servers.<name>.toolFilter` (https://docs.openclaw.ai/gateway/config-extensions) | live; `toolFilter` unverified on installed version | live |
| Schema slimming | shrink or deny heavy schemas | denying `message` took cold turns 67 s → 3 s on the old grammar route (`engineering-memory.md:2878-2886`) | live | n/a |
| Harness semantic pre-filter (Redis/RAG-MCP) | embed tools; top-k per query | Redis blog, vendor numbers without a named model or dataset: ~23k → 0.4k tokens, 3.4 → 0.4 s, 42% → 85% (https://redis.io/blog/from-reasoning-to-retrieval-solving-the-mcp-tool-overload-problem/). ComplexMCP (315 tools): Gemini-3-flash **55.31% full catalog vs 13.47% top-30, 27.65% top-60, 36.88% iterative**, blamed on "latent" helper tools (https://arxiv.org/html/2605.10787v1). ToolRet: query and tool text share 6.6% ROUGE-L; retrieved vs oracle tools −11.40 pass rate (https://arxiv.org/html/2503.01763) | **not reachable** (no per-turn filter hook; gateways cache `tools/list` per process, `engineering-memory.md:3349-3360`) | code change; 7 tools is below both vendors' 10-tool line |
| OpenClaw Tool Search | model calls `tool_search`/`tool_describe`/`tool_call` (or a code bridge, or a directory) | Docs (https://docs.openclaw.ai/tools/tool-search, fetched 2026-09-15): modes `code` (default), `tools`, `directory`. **MCP tools matched on name and description only, `input: "unknown"`, describe before call**. `catalogMode: "direct-only"` keeps OpenClaw and plugin tools visible, **not MCP tools**. BM25 lexical ranking. **"Local inference routes use structured Tool Search automatically when `tools.toolSearch` is unset."** Measured here 2026-08-04 (GLM-5.2, s2): first cold call 35,617 → 10,085 tokens, but whole turns 32–139 s and $0.060–0.077 vs 4–13 s and $0.025–0.035; reverted (`engineering-memory.md:2709-2735`) | config-reachable; spine tools get the worst treatment | n/a |
| OpenRouter server-side tool search | server tool `openrouter:tool_search`; deferred tools load on match | Docs (https://openrouter.ai/docs/guides/features/server-tools/tool-search, fetched 2026-09-15): **Responses and Messages APIs only; Chat Completions returns 400**; "works on any model and any provider"; regex only; default 5, cap 50 results; "Keep your three to five most frequently used tools loaded"; "prompt caching is preserved across a search"; beta | **not reachable as wired** (seats speak Chat Completions; no documented OpenClaw injection; OpenClaw `defer_loading` request #16076 closed stale) | reachable **with a transport change** to the Responses API |
| Anthropic tool search tool | `defer_loading` + regex/BM25 search tool | Claude models only; up to 10,000 deferred; keep 3–5 non-deferred (tool-search-tool doc above) | not reachable (Gemini/Muse) | only if the planner runs on Claude |
| Programmatic tool calling / code mode | model writes code that calls tools | Anthropic PTC: Claude only, not MCP-connector tools; weak fit for "strictly sequential workflows"; τ²-bench about 8% *more* cost at 1–2 calls per turn (https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling). OpenClaw Code Mode: all tools behind `exec`; gemini-3.8-flash and Muse not on its preferred list (https://docs.openclaw.ai/tools/code-mode/configuration). Cloudflare's shape is an MCP server exposing `search()` + `execute()`, which any client can use (https://blog.cloudflare.com/code-mode-mcp/) | PTC no; OpenClaw Code Mode config-reachable but untested on these models; the spine could expose search+execute itself (needs a sandbox on Render) | same |
| Server-side composition | fold the lookup into the tool that needs it | chosen 2026-09-05 (`engineering-memory.md:2874-2877`) | live | live |
| Allowed-tools masking | keep all definitions, narrow the allowed set per step | OpenRouter `tool_choice: {"type":"allowed_tools"}` on Responses/Messages | not reachable | transport change |
| MCP protocol discovery | spec-level | Spec 2026-07-28 has `tools/list` pagination, `list_changed` notifications, deterministic order for cache hits; progressive discovery is roadmap only (https://modelcontextprotocol.io/specification/2026-07-28/server/tools; https://modelcontextprotocol.io/development/roadmap) | not reachable | not reachable |

**The recorded failure these approaches run into.** Under OpenClaw tool search the model's list was
`[tool_search, tool_describe, tool_call]`. Asked "what's on the schedule this week?", it went to
`get_team_schedule` with dates it computed itself and never called `resolve_date`. With
`resolve_date` directly in the list, the same wording got it called 98/98
(`engineering-memory.md:2774-2788`). No pin existed.

How each approach interacts with that failure:
- **Always see every tool:** direct, slimming, composition. The failure cannot recur.
- **Pin a core:** Anthropic and OpenRouter search let a named core stay loaded.
- **Most exposed:** the harness pre-filter, because the question that failed never mentions dates,
  plus the ToolRet and ComplexMCP findings; and OpenClaw search for MCP tools, which cannot be pinned
  and need a describe step first.

## External Dependencies

- **Supabase / PostgREST.**
  - `max_rows = 1000` (`supabase/config.toml:18`) clamps silently.
  - URL length about 8,192 bytes, measured locally; hosted **(unverified)**.
  - Postgres full-text search is built in (https://supabase.com/docs/guides/database/full-text-search).
  - pgvector is available on hosted Supabase, not enabled here
    (https://supabase.com/docs/guides/database/extensions/pgvector).
  - The only extension in migrations is `btree_gist`.
  - No materialized views exist: all `mv_*` objects are plain views
    (`20260903120000`: "There is no refresh").
  - All production DB access goes over PostgREST HTTP, with no `pg` pool. The supabase-js client has
    no fetch timeout (`src/db/client.ts:15`); `lifecycle.ts:674-676` cites undici's 300 s default.
- **OpenRouter.** Seats and planner call `/chat/completions`; the embeddings endpoint exists
  (https://openrouter.ai/docs/api_reference/embeddings); `openrouter:tool_search` needs
  Responses/Messages.
- **OpenClaw** (installed version recorded as 2026.6.34; the public changelog's latest is v2026.9.4,
  and 2026.6.34 does not appear in the index): tool execution, `tools/list` cache per process, 60 s
  MCP per-call timeout, context windows 131,072 (technician) / 262,144 (manager).
- **Composio** (manager seats): results bypass spine dispatch entirely.
- **Render:** the MCP server and cron services. No repo-side request timeout is configured
  (`src/mcp/httpServer.ts:876`); there is no `render.yaml`.

## Constraints and Invariants

- **L1 is append-only** (trigger, `20260620005307_context_spine.sql:117-119`). Retraction is a new
  row, and "retracted" is derived at read time. Any fold must run on every read path or the paths
  disagree. The link tables are append-only on UPDATE.
- **Id-only foreign keys everywhere.** `customer_id`, `job_id`, `capture_id` and `visit_id` do not
  prove the target row belongs to the caller's firm. Code re-checks tenant on some hops and not
  others:
  - **Re-checked:** `boardRead.ts:190-196`, `booking.ts:1067-1074` and `:1355`, the newer link views.
  - **Not re-checked:**
    - the `listJobsWithCustomerByIds` customers embed (`jobs.ts:200`);
    - `booking.ts:335-336` (book_visit jobId path; the name is returned);
    - `booking.ts:971-972` (unschedule preview; `customerName` returned);
    - `captures.ts:953` (standing-fact preview name);
    - `context.ts:158-159` (source-id captures);
    - `listL2CitingCapture` (fleet-wide);
    - older views `v_jobs`, `v_time_off`, `v_money_events`, `v_roster_events`, and the jobs/customers
      joins in `v_schedule`.
- **Sensitivity.** The operator ruled on 2026-08-23 that sensitivity should be NULL by default,
  managers decide what is hidden, and the planner reads everything. That ruling is not implemented:
  seat tools still drop `manager_only` per handler, and pushed planner evidence drops it too.
- **Deploys do not run migrations**, and some services auto-deploy at merge (memory
  `deploy-does-not-migrate`). Any database-side rule ships as a hand-applied migration before its
  code.
- **Doctrine names tools.** Any change to what a seat sees must keep doctrine-named tools reachable
  (`engineering-memory.md:1220-1232`). A description is the discovery surface, and gateways cache
  `tools/list` until restart (`:3349-3360`).
- **Seats call tools one at a time**, and each model call costs about 3–5 s. A "catalog then open"
  design pays per hop.
- **Citations must point at what the model was shown.**
  - `validateCitations` drops unknown ids silently.
  - The planner checks quotes against the JSON-stringified result (`toolLoop.ts:657`), so quotes
    containing `"` or line breaks appear escaped in that text.
- **Tables with no retention:** `raw_captures` (by design), the link tables, `cost_events` (one row
  per tool call plus rows per model call), `query_audit` (its migration comment says "under our
  retention" at `20260806120000:156-159`, but no job exists), `schedule_events`, `money_events`,
  `nudges`, `observations`, `review_items`, `office_messages`, `web_requests`, `host_metrics`,
  `dropped_audit` (has `expires_at` but no purge).
- **Tables that are pruned:** `lifecycle_runs` (90 days), the two versions tables (10 kept per path
  or job), and call audio blobs.
- **Index coverage on ever-growing tables** (from the full index inventory):
  - **`visits`** has only `(tenant_id)` and `(job_id)`. The `idx_visits_source_capture` index belonged
    to the old `visits` table dropped at `20260906140000:47`; `assignments` was renamed to `visits`
    at `:50`, and `idx_visits_technician` was dropped at `20260907100100:242`. So every time-window
    and status read scans the firm's full visit history, and `captureHasLinkedL2` probes
    `visits.source_capture_id` fleet-wide with no index and no tenant filter
    (`rawCaptures.ts:171-177`) on every inbound pre-check.
  - **`raw_captures`** has no index on `captured_at` or `created_at`.
  - **`visit_notes`** has no `created_at` index.
  - **`cost_events`** date filters are non-sargable expressions (`rollup_costs`, recomputed for two
    months every 15 minutes, `lifecycle.ts:413-420`).
  - **`money_events.corrects_event_id`** is unindexed.
  - **`listQueuedNudgesForHost`** filters on status alone, with no status-leading index.

## Findings

### Correctness defects found during the audit

These are behaviour bugs, not just retrieval shape. Each was re-read by hand unless marked.

1. **A staged cancellation can cancel the wrong time.** `unschedule_visit` confirms by `visitId`
   only and never compares against the staged preview (`schedule.ts:1340-1366`). Moves keep the
   visit id, so a visit moved during the 15-minute window is cancelled at its new time after the
   manager approved the old day.
2. **The planner can quote its own desk answers.** `v_office_messages` excludes `to_agent` precisely
   so the planner's own words are not citable (`20260904120000_office_messages_read_surface.sql:60-74`).
   But the desk writes its answers as `direction: 'to_planner', kind: 'desk'`
   (`src/teamLead/desk.ts:228-237`), which the view exposes and `spine_read` (citable) reads.
3. **A retracted note's report stays on the trip.** `recordVisitReport` *adds* labor hours and merges
   attributes onto an existing visit (`visits.ts:638-660`). The fold drops only visits whose
   `source_capture_id` is retracted (`context.ts:194-196`). `money_events` citing a retracted capture
   are folded nowhere.
4. **Planner ticks fail deterministically at about 200 open items per firm.** The CHUNK-500 readers
   in the tick sit above the URL wall and have no local try, so the whole firm lands in the
   per-tenant catch every tick. The run is marked red only if *every* firm fails
   (`lifecycle.ts:574-580`). The watcher fails the same way on its unchunked job-id lists
   (`watchers.ts:432-456`).
5. **Past days read as free.** `get_team_schedule` reads `['confirmed']` only (`schedule.ts:785`),
   so completed past visits vanish, while the result tells the model "A day with byDay 0 is free"
   (`:958`). Separately, its recall mode floors at today, so overdue parked visits are invisible to
   the agent while the board tray shows them flagged `overdue`.
6. **`find_slots` and `get_team_schedule` read an unpaged visit window** (`visits.ts:791-808`). Past
   1000 confirmed visits in 14 days, later days come back empty: slots are offered on booked time
   and counts are wrong.
7. **Money summaries drop the newest events past 1000** (`moneyEvents.ts:234-247`, ordered id asc,
   unpaged).
8. **The retraction preview pages without an order** (`foldImpact.ts:72-104`), so in a firm with
   more than 1000 customers or jobs it can omit facts that will disappear.
9. **Correspondence citations are accepted for text never shown.** The briefing prompt renders the
   newest 3 entries (`grounding.ts:47`), but `validateCitations` accepts every entry's id
   (`:159-161`).
10. **`add_technician_seat` returns the whole technician row** on confirm, including badge-hash and
    Composio columns (`roster.ts:422-430`; `technicians.ts:172`). `list_team` projects those out
    (`roster.ts:846`).
11. **Failures that are only logged or silently omitted:**
    - `deactivate_technician_seat` swallows pairing and retirement failures (`roster.ts:531-573`).
    - `send_email` on a job/recipient mismatch files the email on neither, logging only
      (`comms.ts:357-360`).
    - `record_money_event` drops an invalid `sourceCaptureId` with a log only
      (`moneyEvents.ts:131-141`).
    - `inform_team_lead` silently cuts the body at 2000 chars.
    - `recall_decisions` silently clamps to 200 rows, and a malformed gap id reads as "you have not
      decided about this before" (`office.ts:357-359`).
12. **Retracted captures still identify a customer.** `findCustomersByThread` does not fold retracted
    or `manager_only` captures.
13. **Phone matching is an exact string compare** on model-extracted text (`customers.ts:137-145`),
    and no phone normaliser exists in `src`.
14. **Doc and description drift that misleads models:**
    - The SQL catalog says "sixteen views" (`server.ts:143`) but lists 18.
    - It describes `v_office_messages` as "BOTH ways" (`:235-239`); the view is `to_planner` only.
    - `cancel_job` promises "any customer promise" (`customers.ts:221-222`); that field no longer
      exists.
    - `get_connect_link` is Gmail-only (`pairing.ts:63-66`), but AGENTS.md routes Sheets, Excel and
      Drive to it (`bootstrap-box.sh:784-789`).
15. **(Unverified)** `v_schedule.local_day` is computed as `(v.starts_at at time zone
    tn.timezone)::date` (`20260907100100_drop_visits_technician_id.sql:91`) over naive-local
    `starts_at`, which would put early-morning visits on the previous day for US firms.
16. **(Unverified)** `query_spine`'s 5-second limit is set with `set_config('statement_timeout', …)`
    *inside* the already-running function (`20260806120000:204`), which probably does not bound that
    query.
17. **(Unverified)** OpenClaw auto-enables tool search for local inference routes when
    `tools.toolSearch` is unset. A rebuild wipes top-level `tools.*` (`engineering-memory.md:2831`).
    Whether `inference.local` counts as local is unknown.

### Scale risks, ranked by consequence

| # | What | Trigger (a rule, not a pilot number) | Who feels it | Loud or silent |
|---|---|---|---|---|
| 1 | `findRetractionsFor` unchunked | ≈200 capture/fact/correspondence ids on one customer or job | seat context tools, `get_job`, `list_recent_captures` | loud (414) |
| 2 | Planner tick readers chunk at 500 | ≈200 open gaps or gap jobs per firm | that firm's planner, every tick | loud per firm; run stays green |
| 3 | Watcher unchunked job-id lists | open items + 72 h candidates ≈200 jobs | detection and auto-resolve | loud per firm |
| 4 | Board tray and console read all confirmed visits since 1970 (`boardRead.ts:341`) with no time index | every confirmed visit a firm ever has | managers on board and console | slow |
| 5 | Unpaged window and queue readers | >1000 matching rows | schedule tools, planner, host delivery, money | silent |
| 6 | `visits` indexes lost in the rename | total visits (fleet-wide on inbound pre-check) | inbound webhook latency, all window reads | slow |
| 7 | `cost_events` (one row per tool call, never pruned) rolled up every 15 min with non-sargable filters | fleet tool calls × time | lifecycle heavy tick delays later ticks | slow |
| 8 | Firms planned in series, 900 s budget each, no turn ceiling; delayed firings skip the cadence grid | number of firms × tick time | planner coverage | silent skips |
| 9 | Synthesis prompts and context fan-out grow with each customer's history | captures per customer | brief/answer, get_customer_context | loud at provider limit |
| 10 | Unordered retraction preview paging | firm >1000 customers or jobs | managers retracting | silent |

## Decision Points

1. **Where the retrieval rules live.**
   - (a) In the database: views or functions that apply membership, tenant, sensitivity,
     retraction and order once, which the operator has already chosen for the customer read;
   - (b) a single shared TypeScript module every reader must call;
   - (c) both: the database for membership and folds, TypeScript for delivery.

   (a) makes the SQL views and seat tools agree by construction, but every change becomes a
   hand-applied migration, and tenant checks and folds move out of TypeScript, which the
   `data-security` gate covers. (b) keeps migrations out, but PostgREST's two limits stay on every
   read.

2. **One definition of "a job's captures" and "a customer's captures"**, covering all six attachment
   paths. Which readers move onto it:
   - seat tools;
   - planner evidence;
   - the watcher activity probe;
   - write-path matchers such as `findCustomersByThread` and `captureHasLinkedL2`.

   Whether "a customer's captures" includes every capture on every one of their jobs.

3. **One visibility rule per caller:**
   - (a) implement the 2026-08-23 sensitivity ruling (NULL by default, the manager decides) as part
     of this layer;
   - (b) keep `manager_only` filtering, but apply it in one place for every seat path, including SQL
     and Composio;
   - (c) per-tier database views or row-level security (RLS).

   And for retractions: fold them everywhere, or label them for the planner and fold them for seats.

4. **A result-size contract:**
   - (a) a hub-level byte cap with an announced truncation, covering every tool and the Composio
     relay;
   - (b) per-tool caps and cursor pagination;
   - (c) both.

   Composio results currently bypass dispatch, so (a) only covers them if the relay also passes
   through the cap.

5. **How id lists travel:**
   - (a) chunk at ≤150 everywhere (the sibling task's branch pattern);
   - (b) database-side joins or RPC bodies, so no list goes into a URL (the operator's choice for the
     customer read);
   - (c) (b) for hot paths and (a) elsewhere.

6. **A delivery convention for every result:**
   - wrap arrays in objects so they get the `now` rider and empty wording;
   - return ids from every write (`inform_*`, `send_email`, `ask_team_lead`'s `askId`);
   - put capture and event ids on planner evidence and money lines.

   Either applied to all tools, or decided per tool.

7. **What seats get for customer and job reads.** Carried from the 2026-09-14 research:
   - contents, then open, then keyword search;
   - search as a tool or as SQL;
   - `brief_customer` and `answer_customer_question` kept bounded, turned into a loop, or retired.

   Plus the equivalents for schedule reads: `get_team_schedule` and board parity, recall-mode floor,
   statuses read.

8. **Tool-catalog strategy for seats:**
   - (a) keep direct tools and shrink the catalog, e.g. move the 8,203-char view catalog out of the
     two SQL tool descriptions, or slim `book_visit`;
   - (b) static scoping per seat shape (`toolFilter`, verification needed);
   - (c) OpenClaw tool search, which cannot pin MCP tools and needs a describe step first;
   - (d) OpenRouter server-side tool search, which needs seats on the Responses API, not configurable
     in OpenClaw as documented;
   - (e) a spine-side `search` + `execute` pair (Cloudflare shape);
   - (f) more server-side composition.

   Manager seats carry 43 spine tools plus Composio, against Gemini's 10–20 guidance and Anthropic's
   30–50.

9. **Planner transport.**
   - (a) stay on Chat Completions;
   - (b) move `toolLoop.ts` to OpenRouter's Responses API, which unlocks `openrouter:tool_search` and
     `allowed_tools` masking. The planner has 7 tools, below both vendors' 10-tool threshold.

10. **Planner and watcher tick at many firms:**
    - (a) firms in series (today);
    - (b) parallel with a concurrency limit;
    - (c) a per-firm work queue.

    Plus: whether the gap list gets a bound with an announced overflow, and whether the evidence
    floor is per gap or firm-wide.

11. **Indexes and retention.**
    - Indexes on `visits` (time, status, `source_capture_id`), `raw_captures` time, `visit_notes`
      time, `money_events.corrects_event_id`.
    - A retention or rollup policy for `cost_events`, `query_audit`, `web_requests`, `host_metrics`
      and `dropped_audit` (`raw_captures` stays append-only by design).
    - Each is a hand-applied migration.

12. **How the correctness defects above are handled.**
    - Fixed in place as small fixes, e.g. the unschedule confirm check, the desk-answer direction, the
      catalog wording, the `add_technician_seat` projection;
    - folded into this task;
    - or raised as separate items.

    And whether the paused sibling task's committed branch (tiebreaks, chunk 150, customer-link test,
    finding rank) lands as-is or is absorbed. These are the operator's call under the board rules.

13. **Stale records to correct.**
    - `docs/engineering-memory.md:2857` ("OpenRouter executes nothing server-side") no longer fully
      holds.
    - The OpenClaw auto-enable trap and "MCP tools cannot be pinned in current OpenClaw" are not yet
      recorded.
    - `docs/nemoclaw-tech-agent.md:92-96` still lists a 14-tool technician surface.

## Open Questions

- **Hosted PostgREST URL limit.** The ~8,192-byte wall was measured through the local stack's
  gateway only.
- **`statement_timeout` inside `query_spine`.** Does it bound the running query? Testable on the
  local stack.
- **`v_schedule.local_day`.** Does it shift early-morning visits to the previous day for a US-timezone
  firm? Testable on the local stack.
- **Real data volumes** (captures per customer, open gaps per firm, visits per window) are unknown.
  They must not be read off the pilot box; every trigger above is stated as a rule.
- **Installed OpenClaw feature set.** Does the installed version (recorded as 2026.6.34) have
  `directory` mode, `catalogMode`, `mcp.servers.*.toolFilter`? Needs a grep inside the container.
- **Is `inference.local` classified as a local inference route** for tool search's auto-enable?
- **Does the `inference.local` proxy forward `/v1/responses`** (needed for OpenRouter tool search)?
  Does OpenRouter's server tool cost an extra billed generation, and does caching hold on Gemini and
  GLM?
- **Parallel tool calls on Gemini 3.8 Flash.** The zero-parallel measurement predates Gemini becoming
  primary.
- **Current per-turn token baseline** on Gemini seats, split by seat shape (manager with Composio vs
  technician spine-only). Recorded figures are GLM-era.
- **Search recall on real phrasing.** Would regex or BM25 over the 43 spine descriptions surface
  `resolve_date` for date-incidental questions? Scorable offline.
- **OpenClaw tool result size.** Does OpenClaw truncate or reject large MCP results before the model
  sees them?
- **Gemini/Vertex function-declaration limit.** A search snippet said 128; not fetched verbatim.
- **What a real firm's Composio results look like in size,** and whether the relay should be inside
  the same result contract.
