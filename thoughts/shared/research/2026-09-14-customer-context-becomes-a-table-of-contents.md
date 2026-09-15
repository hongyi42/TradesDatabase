---
date: 2026-09-14
branch: work/customer-context-becomes-a-table-of-cont
commit: 7c2370c
topic: Customer context becomes a table of contents + search — how a customer's record reaches a model today, what reads and drills into it, and what search infrastructure exists
supersedes: nothing
---

## Summary

A **customer's record** in this system is a tree. It starts with the customer row, which carries
standing facts in its `attributes`. Under the customer are their **jobs**. Under each job are its
**visits** (trips). **Raw captures** hang off all three levels: every verbatim note, call, email or
agent action, stored append-only in L1 (`raw_captures`). Six mechanisms connect a capture to the
tree:

- two **stamps** on the capture row itself (`customer_id`, `job_id`), written only when identity was
  known at insert time;
- a `source_capture_id` on a job or visit the capture *created*;
- three append-only **link tables**: `customer_captures`, `job_captures`, `visit_notes`.

The storage is already shaped like a filesystem. The **read** flattens it. `getCustomerContext`
(`src/db/context.ts:81`) returns the customer, every job, every upcoming visit, every completed
visit and every capture's full text. There is no cap and no paging. Three MCP tools (the Model
Context Protocol, the tool interface the seat agents call) use that one bundle:

- `get_customer_context` returns it to the seat agent as one JSON blob;
- `brief_customer` and `answer_customer_question` paste all of it into a single forced-JSON model
  call (`src/synthesis/grounding.ts:25`).

The operator ruled on 2026-09-14 that a model should never be handed a customer's raw captures in
bulk. Instead the model should get a table of contents, then open the parts it needs, "like how a
human would go through a dictionary". This document records six things:

1. what the current read does;
2. who depends on its shape (seat tool descriptions, evals, tests, the planner's citation set);
3. which drill-down verbs already exist and what each one actually reaches;
4. the search infrastructure: there is none today, no full-text index, no pgvector (the Postgres
   vector-search extension), no embedding calls;
5. the latency and size constraints any redesign runs into;
6. one surprising finding.

The finding: the drill-down verbs and the context read do not agree on which captures belong to a
customer or a job. Neither of them reads the `job_captures` or `visit_notes` links. So a note
attached to an already-booked trip, or a customer email filed on a job with no trip, reaches no
capture reader a seat can call.

## Entry Points

| Entry | Where | Caller |
|---|---|---|
| `get_customer_context` tool | definition `src/mcp/tools/customers.ts:98-123`, handler `:379-432` | seats, both tiers (base catalog) |
| `brief_customer` tool | definition `src/mcp/tools/customers.ts:139-153`, handler `:499-520` | seats, both tiers |
| `answer_customer_question` tool | definition `src/mcp/tools/customers.ts:154-167`, handler `:522-537` | seats, both tiers |
| `getCustomerContext()` | `src/db/context.ts:81-215` | the three handlers above, plus tests only |
| `list_recent_captures` tool (existing drill-down) | definition `src/mcp/tools/captures.ts:127-143`, handler `:593-638` | seats, both tiers |
| `get_job` tool (existing drill-down) | definition `src/mcp/tools/customers.ts:124-138`, handler `:434-497` | seats, both tiers |
| `query_spine` / `spine_read` (free SQL over views) | `src/mcp/server.ts:744-783` → `src/db/querySpine.ts:33` | managers (`query_spine`), planner (`spine_read`) |
| MCP result wrapper | `src/mcp/server.ts:902` — `JSON.stringify(grounded)`, whole result, no size cap | every tool |

## Key Files

- **`src/db/context.ts`** — `getCustomerContext(customerId, {includeRetracted?})`. Exports
  `CustomerContext {customer, jobs, upcomingVisits, recentVisits, recentCaptures}` (`:55-69`) and
  `UpcomingVisit` (`:33-53`, including the server-composed `phrase`). This is the only place the
  flattened customer bundle is built.
- **`src/synthesis/grounding.ts`** — `serializeContextForPrompt(context)` (`:25-136`) renders the
  bundle as labelled text. Every capture becomes one line,
  `- [capture <id>] channel=… at=…: <raw_text>` (`:111-119`). The only bounded element is a job's
  `correspondence` list, which shows the newest 3 plus an "(N earlier)" count (`:45-56`).
  `validateCitations(citations, context)` (`:141-174`) accepts a cited id only if it is in
  `recentCaptures`, a standing fact's evidence id, or a correspondence entry's `captureId`.
- **`src/synthesis/briefCustomer.ts`** / **`src/synthesis/answerQuestion.ts`** — `defaultBriefer`
  (`:68-101`) and `defaultAnswerer` (`:55-79`). One `runForcedTool` call each, with the whole
  serialized context as the user message (`briefCustomer.ts:71`, `answerQuestion.ts:58`),
  `maxTokens: 8192` (`:89` / `:70`) and `reasoningEffort: 'minimal'` (`:93` / `:74`). The comments
  there record that a 12+-capture history truncated at 1024 tokens and a long think blew the 90s
  tool timeout (Q03, 2026-08-14). `src/synthesis/fixtures.ts:98-104` holds `sampleContext()`, the
  one in-memory fixture the live tests use.
- **`src/mcp/tools/customers.ts`** — the three tool definitions and handlers named above, plus
  `find_customer` (`:360-377`) and `get_job` (`:434-497`). Tier membership: all five are in
  `BASE_TOOLS` (`:88-168`).
- **`src/mcp/tools/captures.ts`** — `list_recent_captures` (`:593-638`), `retract_capture`, and
  `record_standing_fact`. It also holds the planner-only `read_job_note` / `write_job_note`
  (`:245-281`, handler `:1312-1358`).
- **`src/db/rawCaptures.ts`** — L1 accessors:
  - `getRawCapture(id)` (`:120-124`): fleet-wide, by id.
  - `listRawCapturesForJob(jobId)` (`:210-218`): job stamp only, no limit.
  - `findRetractionsFor(ids)` (`:316-324`): one `.in()` call.
  - `listJobEvidenceSince` (`:357-496`): the planner's union of job stamp, `visit_notes` and
    `job_captures`, with a tenant re-check, a `manager_only` drop and the retraction fold.
  - `foldRetractions` (`:501-506`).
  - `listRawCapturesForCustomer(customerId)` (`:509-517`): customer stamp only, no limit.
  - `findCustomersByThread` caps (`:708-726`), which document the measured 8192-byte URL wall.
  - `listCapturesByThread` (`:917-992`): a bounded reader, `WANT = 16` at `:929`.
- **`src/db/customers.ts`** — `getCustomer` (`:118-122`), `listLinkedCapturesForCustomer`
  (`:262-271`: ids plus tenant, no limit), `insertCustomerCapture` (`:210-218`), `searchCustomers`
  (`:275-285`: name/phone/address `ilike`, `.limit(20)`; the only text search in `src/db`).
- **`src/db/jobs.ts`** — `listJobsForCustomer` (`:144-152`, ordered by `created_at` with no
  tiebreak; the sibling task adds one), `insertJobCapture` (`:468-476`),
  `JobCorrespondenceEntry {captureId, channel, at, followUp?, facts?}` (`:513-523`),
  `correspondenceEntries` (`:534-541`), `foldRetractedCorrespondence` (`:558-567`),
  `appendJobCorrespondence` (`:575-593`).
- **`src/db/visits.ts`** — `listUpcomingVisitsForCustomer` (`:1072-1098`: confirmed visits from
  today, or untimed ones), `insertVisitNote` (`:1368-1380`), `listVisitsForCustomer`
  (`:1465-1493`: `completed` only, participants sanitised *because* "THESE ROWS ARE RETURNED RAW to
  get_customer_context", `:1475-1480`).
- **`src/db/standingFacts.ts`** — `factSourceIds` (`:55`), `foldRetractedFacts` (`:42`).
- **`src/mcp/server.ts`**:
  - `dropSensitive` (`:671-672`): removes `sensitivity = 'manager_only'` rows for non-managers, in
    memory.
  - The `query_spine`/`spine_read` dispatch (`:744-783`).
  - `SPINE_VIEW_CATALOG` (`:142-249`), which documents `v_captures`, `v_visit_notes`,
    `v_job_captures` and `v_customer_captures` to the model.
  - The result wrapper (`:902`).
- **`src/mcp/tools/shared.ts`** — `leanGrounding()` (`:753-754`): an eval switch that removes
  `upcomingVisits` and `openWorkNote` from `get_customer_context`.
- **`src/mcp/tools/surface.expected.ts`** — pins the technician surface (17 tools, `:26-44`) and the
  manager surface (43). All three context tools plus `get_job` / `list_recent_captures` are in the
  technician set.
- **`src/teamLead/planner.ts`** — `CITABLE_TOOLS = new Set(['spine_read', 'get_customer_context'])`
  (`:1986`). The planner's own bounds: `EVIDENCE_TEXT_CHARS = 600` (`:626`),
  `EVIDENCE_PER_GAP = 6` (`:629`).
- **`src/teamLead/identity.ts:72`** — `get_customer_context` is on `TEAM_LEAD_TOOL_NAMES` with no
  schema. It is pinned as "known unreachable" at `src/mcp/server.test.ts:8427-8442`.
- **`src/model/toolLoop.ts`** — the in-process agent loop the planner and desk use (not the
  seats). Limits: `MAX_TOOL_LOOP_TURNS = 8` (`:46`), `MAX_TOOL_RESULT_CHARS = 20_000` (`:76`, with
  an announced truncation), `MAX_TOOL_CALLS_PER_TURN = 8` (`:82`),
  `MAX_TOOL_CALL_MS = 90_000` (`:101-105`).
- **`src/writePath/recordFieldNote.ts`** — the write path that decides which link a capture gets
  (traced under Data Flows).
- **`supabase/migrations/20260823120000_planner_read_surface.sql:29-51`** — `v_captures`: the
  capture text plus a retraction label, tenant-filtered by `spine.tenant_id`. It deliberately omits
  `metadata`, `blob_path` and `external_id`.

## Data Flows

### 1. The context read, as it is today

```
get_customer_context / brief_customer / answer_customer_question   (src/mcp/tools/customers.ts)
            │ customerId
            ▼
getCustomerContext(customerId)                                        (src/db/context.ts:81)
  ├─ in parallel (:85-97):
  │    getCustomer ─────────────── customers row
  │    listJobsForCustomer ─────── ALL jobs, full attributes (standing facts, correspondence[])
  │    listVisitsForCustomer ───── ALL completed visits, full attributes
  │    listRawCapturesForCustomer ─ captures STAMPED customer_id        (no limit; max_rows 1000)
  │    listLinkedCapturesForCustomer ─ customer_captures link ids       (no limit; max_rows 1000)
  ├─ upcoming visits (:104-138): getTenant → firm-local today → listUpcomingVisitsForCustomer
  ├─ source ids (:152-156): jobs.source_capture_id + visits.source_capture_id + link ids (tenant-checked :148-150)
  ├─ ONE getRawCapture PER ID (:158)                                    (N round trips)
  ├─ sort newest first (:161-163)
  └─ retraction fold (:168-212): ONE findRetractionsFor over every id  (URL wall ~215 ids)
            │ CustomerContext
            ▼
 ┌──────────────────────────────┬───────────────────────────────────────────────┐
 │ get_customer_context (:379)  │ brief_customer (:499) / answer_… (:522)        │
 │ tenant guard → empty (:385)  │ tenant guard → "customer not found" (:511/529) │
 │ + moneyByJob (:401-412)      │ recentCaptures = dropSensitive(...)            │
 │ + recentCaptures dropSensitive│ serializeContextForPrompt → ONE model call    │
 │ + openWorkNote (:417-425)    │ validateCitations → {briefing|answer, citations}│
 │ JSON.stringify(all) (server.ts:902) → seat                                   │
 └──────────────────────────────┴───────────────────────────────────────────────┘
```

Facts about the flow:

- **What the seat receives from `get_customer_context`** is the `CustomerContext` spread verbatim
  (`customers.ts:413-416`). Each `recentCaptures` element is a full `raw_captures` row: `id`,
  `tenant_id`, `customer_id`, `job_id`, `visit_id`, `channel`, `raw_text`, `blob_path`,
  `external_id`, `technician_ref`, `metadata`, `sensitivity`, `retracts_capture_id`, `captured_at`,
  `created_at` (`src/db/database.types.ts:1646-1662`). `v_captures`, the planner and manager view
  of the same table, leaves out `metadata`, `blob_path` and `external_id`. The server wrapper adds
  a `now` rider to the object (`server.ts:878-901`).
- **What a synthesis call receives** is text. The customer line with attributes, every job line
  with attributes, upcoming visits, past visits with `source_capture`, then every capture's full
  `raw_text` (`grounding.ts:121-135`). An email capture's `raw_text` is its storage form, with
  headers prepended (`rawCaptures.ts:906-907`).
- **Ordering and truncation.** Both capture readers have no `.limit()`. PostgREST
  `max_rows = 1000` (`supabase/config.toml:18`) clamps a larger result silently
  (`rawCaptures.ts:716-720`):
  - `listRawCapturesForCustomer` is ordered `captured_at desc`, so past 1000 stamped rows the
    oldest are dropped;
  - `listLinkedCapturesForCustomer` is unordered, so past 1000 links an arbitrary subset is
    dropped.
- **Retraction fold.** "Retracted" is derived: a row is retracted if and only if a `retraction` row
  points at it (`rawCaptures.ts:310-316`). The fold runs over every capture id, fact evidence id and
  correspondence id (`context.ts:173-187`). It removes:
  - the retracted captures and the retraction rows;
  - the visits whose `source_capture_id` is retracted (`:194-196`);
  - the standing facts and correspondence entries whose evidence is retracted (`:199-211`).

  `findRetractionsFor` puts every id into one `.in()` URL. The sibling task
  `20260914-fix-the-small-board-findings-listjobsfor` chunks it at 150 ids
  (its plan Phase 3, not yet merged).

### 2. Where a capture lands — and which reader can find it again

The write path picks the link (`src/writePath/recordFieldNote.ts`). The table crosses each landing
shape with the readers.

| Landing shape (write site) | Link written | Stamped on L1? | `getCustomerContext` | `list_recent_captures` by customer | `list_recent_captures` by job | planner `listJobEvidenceSince` |
|---|---|---|---|---|---|---|
| Staged-confirm note, identity known at insert (`:238-254`) | customer_id (+ job_id) stamp | yes | ✅ stamp | ✅ | ✅ if job stamped | ✅ |
| Capture that **created** a customer/job/visit (`sourceCaptureId`, `:440`, `:698`, `:786`) | `source_capture_id` on L2 | usually no | ✅ source ids | ❌ | ❌ | visit arm only if also `visit_notes` |
| Note/inbound **attached to an existing trip** (`:821-824`, `insertVisitNote`) | `visit_notes` | usually no | ❌ (not read) | ❌ | ❌ | ✅ visit arm |
| Inbound on a job with **no live trip** (`:882-890`), or filed without asking (`:556-569`) | `job_captures` + `correspondence[]` entry on the job | no | ❌ capture row (only the correspondence entry's `followUp`/`facts` via job attributes) | ❌ | ❌ | ✅ job arm |
| Inbound, customer known, **several open jobs** (`:632-636`) | `customer_captures` | no | ✅ link | ❌ | n/a | ❌ |
| First-time sender, no job (`:562`) | none | no | ❌ | ❌ | ❌ | ❌ |

Rows 3 and 4 were read from the code. No test drives a `visit_notes`-only or `job_captures`-only
capture through `getCustomerContext`. The one `visit_notes` case in `src/db/context.test.ts:27-67`
also sets `sourceCaptureId`, so it passes through the source-id arm.

Consequences visible in the code:

- A completed visit whose note attached to a pre-booked trip appears in `recentVisits`, with
  `source_capture=—` and the report's attributes. The note's words do not appear, and
  `validateCitations` cannot accept that capture's id.
- An inbound email on a job appears only as a `correspondence` entry: channel, time, the
  extractor's `followUp` and `facts`. The customer's actual words are absent. The job line's
  comment calls the rest "one spine_read away" (`grounding.ts:43-44`), but `spine_read` is
  planner-only, and a technician seat has no SQL tool at all.
- `list_recent_captures` reaches a strict subset of what `getCustomerContext` reaches. By job it
  reads only the `job_id` stamp (`captures.ts:609`), and that stamp is "usually NULL by design"
  (`20260823120000_planner_read_surface.sql:35-39`). Two schedule-tool descriptions point seats at
  this verb for "the job's own record": `src/mcp/tools/schedule.ts:269-271` (`book_visit`) and
  `:334-336` (`move_visit`).

### 3. What the drill-down verbs return today

| Verb | Tier | Input | Returns | Bounded? |
|---|---|---|---|---|
| `find_customer` | base | `query` | customer rows (attributes fact-folded) | `.limit(20)` |
| `get_customer_context` | base | `customerId` | the whole bundle (flow 1) | no |
| `get_job` | base | `jobId` | job row + folded attributes (incl. full `correspondence[]`) + money (managers: last 10 events) | correspondence unbounded |
| `list_recent_captures` | base | `jobId` or `customerId`, `includeRetracted` (manager) | full capture rows, folded, sensitivity-filtered | no |
| `query_spine` | manager | SQL over `v_*` views | JSON rows | 200 default / 1000 max, 5s timeout |
| `spine_read` | planner | same | same | same |
| `read_job_note` | planner | `jobId` | planner's own prose (≤2000 chars) | yes |

`query_spine` can already search capture text: `v_captures.raw_text` with `ilike` or an
at-query-time `to_tsvector(...) @@ websearch_to_tsquery(...)`. Nothing indexes it, and nothing in the
catalog suggests it. This comes from reading the SQL; it was not run live.

### 4. How a seat's turn spends a tool call

```
Telegram ─► OpenClaw gateway (box) ─► model call ─► tool call ─► doorman ─► Render MCP ─► DB
                ▲                                                                        │
                └────────── tool result JSON rides the session transcript ◄──────────────┘
```

- **One call at a time.** Seats emit zero assistant messages with two or more tool calls, and real
  chains are dependent (`docs/engineering-memory.md:2867-2871`). Parallel tool calls cannot be
  enabled on this gateway: `supportsParallelToolCalls` crash-loops it
  (`Box_Setup_Stuff/bootstrap-box.sh:1388-1390`).
- **Each extra model call costs about 3–5s.** A one-tool Telegram turn measured about 13–15s
  (memory `muse-latency-and-double-texting-handoff`, measured on Muse 2026-09-05; the fleet primary
  is now Gemini 3.8 Flash at about 10.2s per eval question). The standing decision from the
  programmatic-tool-calling investigation: "keep direct tools… fold the lookup into the tool that
  needs it" (`docs/engineering-memory.md:2850-2877`).
- **Per-call timeout on the seat path: 60s** (`DEFAULT_REQUEST_TIMEOUT_MS`,
  `docs/engineering-memory.md:4821-4822`). A synthesis tool's model call runs inside that window.
- **No tool-result size cap on the seat path.** The server returns the whole string
  (`server.ts:902`). The in-repo doorman (`Box_Setup_Stuff/doorman.mjs`) has no size logic. The
  seat context window is 131072 tokens for technicians and 262144 for managers
  (`bootstrap-box.sh:557-571`), and "every call re-sends the session" (`:562`). A large context
  result therefore rides every later model call in that session until compaction.

## External Dependencies

- **Supabase / PostgREST.** Every read goes through `supabase-js`:
  - `max_rows = 1000` clamps silently (`supabase/config.toml:18`);
  - an `.in()` list hits the 8192-byte URL limit at about 215 UUIDs (`rawCaptures.ts:709-716`);
  - an RPC argument travels in a POST body, so it does not hit that limit.

  There are four RPC precedents called from `src/db`:
  - `query_spine` (`src/db/querySpine.ts:33`);
  - `claim_next_call` (`src/db/callIngest.ts:56`);
  - `rollup_costs` and `tenant_cost_detail` (`src/db/costs.ts:505`, `:607`).

  `tenant_cost_detail` (`20260725150000_tenant_cost_detail_fn.sql:14-30`) is a typed
  `returns table … security definer stable` function that takes the tenant as a parameter. Every
  function grant follows the revoke-public, grant-service_role pattern
  (`20260806120000_query_spine_reader.sql:226-248`).
- **Postgres full-text search: built in, no extension needed.** Supabase documents `to_tsvector`,
  `websearch_to_tsquery` and `ts_rank`, recommends a generated `tsvector` column with a GIN index,
  and supports calling it through `.textSearch()` or `.rpc()`
  (https://supabase.com/docs/guides/database/full-text-search, fetched 2026-09-14). The repo
  currently has no `tsvector`, no GIN index and no `pg_trgm` (a trigram-matching extension). The
  only extension any migration creates is `btree_gist` (`20260704210155_scheduling_foundation.sql:54`).
- **pgvector: available on hosted Supabase, not enabled here.** It is enabled with
  `create extension vector with schema extensions;`, and the application must generate the
  embeddings itself; Supabase stores them
  (https://supabase.com/docs/guides/database/extensions/pgvector, fetched 2026-09-14).
  Availability on the local CLI stack is not stated on that page.
  `supabase/config.toml:154-157` enables Storage "vector buckets", which are S3-backed and a
  different feature; nothing uses them.
- **Embedding models: an endpoint exists at the current provider, the repo has no client.** The
  repo's model calls are `/chat/completions` (OpenAI-compatible, OpenRouter by default,
  `src/model/forcedTool.ts:90-91`, `:375`; `src/model/toolLoop.ts:490`) and Anthropic
  `/v1/messages`. OpenRouter exposes `POST https://openrouter.ai/api/v1/embeddings`, OpenAI-shaped,
  with models such as `openai/text-embedding-3-small`
  (https://openrouter.ai/docs/api_reference/embeddings, fetched 2026-09-14). `package.json` has no
  embedding or vector library.
- **OpenClaw gateway.** Seat tool execution, the 60s MCP per-call timeout, session transcripts.
  Vendor-owned. No tool-result size limit is documented in this repo.

## Constraints and Invariants

- **L1 is append-only** (trigger `raw_captures_append_only`,
  `20260620005307_context_spine.sql:117-119`). Any derived search artefact is either:
  - computed at query time;
  - a generated column (Postgres computes it on INSERT, and the trigger blocks only UPDATE and
    DELETE); or
  - a separate table.

  Whether adding a generated column to an existing append-only table rewrites rows the trigger
  would object to has not been tested.
- **The three link tables are append-only on UPDATE** (`visit_notes`
  `20260906140000_the_visit_is_one_object.sql:132-134`, `job_captures`
  `20260908100000_inbound_asks_and_job_captures.sql:74-76`, `customer_captures`
  `20260912100000_customer_captures.sql:46-48`). Each is indexed on `capture_id` and on
  `(tenant_id, parent_id)`.
- **Tenant proof is re-checked in TypeScript on every hop.** `capture_id`, `customer_id` and
  `job_id` are id-only foreign keys, and `getRawCapture` is fleet-wide
  (`context.ts:143-150`, `customers.ts:254-261`, `rawCaptures.ts:444-449`). The handlers guard on
  the parent customer's tenant (`customers.ts:385`, `:511`, `:529`). A test pins that a
  foreign-tenant link never reaches the context (`src/db/customerCaptures.test.ts:109-133`).
- **Retraction fold is app-side only.** No view or SQL function folds; `v_captures` *labels*
  (`retracted`, `retraction_reason`). Any new reader must call `findRetractionsFor` + fold, and also
  fold standing facts and correspondence whose evidence is retracted, or it disagrees with the
  context view. The `get_job` comment states that rule (`customers.ts:443-448`).
- **Sensitivity filter is in-memory**, "deliberately NOT a PostgREST neq filter (NULL-vs-neq trap)"
  (`server.ts:665-672`). Managers see `manager_only` rows; technicians do not. The operator's
  2026-08-23 ruling that sensitivity should become NULL by default is not implemented (memory
  `sensitivity-is-the-managers-call`).
- **Citations must point at what the model was shown.** `validateCitations` drops ids not in the
  context, silently (`grounding.ts:141-174`, caveat `briefCustomer.ts:64-67`). The planner applies
  the same discipline to *truncated* text: "the citation check runs against exactly this truncated
  text, never the full row" (`planner.ts:621-626`).
- **"Push the keys, pull the content"** (`docs/engineering-memory.md:890-895`), ratified
  2026-08-20: "You cannot prompt your way to a UUID." Ids are pushed; content is fetched.
- **Server-composed phrases are eval-load-bearing.** `UpcomingVisit.phrase` (`context.ts:118`)
  produces the strings the date-eval S-cases grade: `"<Weekday> <date>"` and `'no time set yet'`
  (`scripts/date-eval/corpus.mjs:331-346`). `openWorkNote` exists for the B03 flake
  (`customers.ts:388-392`).
- **Money is summary-only in the context** (`moneyByJob`, omitted when a job has no ledger rows,
  `customers.ts:397-412`). The entry list lives on `get_job`.
- **Job notes are planner-private.** No view, team-lead tools only
  (`20260901120000_job_notes.sql:18-23`). They are not a seat-readable summary.
- **Shape pinned by tests and evals** (full list in the consumer sweep):
  - `src/mcp/server.test.ts`: `:835`, `:847`, `:857`, `:869`, `:877`, `:895`, `:1413`, `:1583`,
    `:1681`, `:2860`, `:3782`, `:3995`, `:4059`, `:4203`, `:6801`, `:8427`, `:8895`, `:9016`,
    `:9285`, which assert on `recentCaptures`, `recentVisits`, `upcomingVisits`, `openWorkNote`,
    `moneyByJob` and `jobs[].attributes`;
  - `src/db/context.test.ts`, `src/db/customerCaptures.test.ts:109,135`,
    `src/db/retractions.test.ts:124`, `src/synthesis/grounding.test.ts`;
  - eval corpus: `Q01` *requires* `brief_customer` (`src/eval/corpus.ts:726-735`); `M07` and `M09`
    accept `get_customer_context` among alternatives (`:1193-1216`, `:1255-1279`);
  - tool cases `R02`, `R13`, `W03` (`get_customer_context`) and `X01` / `X02` (synthesis)
    (`src/eval/toolCases.ts:181-190`, `:324-333`, `:607-634`, `:1273-1303`);
  - `src/eval/toolCases.test.ts:67-70` requires a case per spine tool.
- **Seat-facing text that names the current tools:**
  - `schedule.ts:280`: "read get_customer_context FIRST and book by jobId";
  - `schedule.ts:269-271` and `:334-336`: "get_job / list_recent_captures";
  - `docs/nemoclaw-tech-agent.md:323-324`, `:749-750`;
  - `docs/onboarding.md:220-226`;
  - `docs/doorman-runbook.md:371-376` (17-tool count).

  The AGENTS.md blocks in `Box_Setup_Stuff/bootstrap-box.sh` name none of these tools. They say
  "READ THE JOB'S RECORD — the calls, emails and notes on it" (`:701-706`) without naming a tool.
- **Sibling work touching the same symbols** (overlap accepted at spawn):
  - `20260914-fix-the-small-board-findings-listjobsfor` chunks `findRetractionsFor` and adds a
    `listJobsForCustomer` id tiebreak. It explicitly dropped the batched `getRawCapture` fetch and
    the `recentCaptures` cap into *this* task (its plan, lines 12-22).
  - `20260912-the-model-names-the-job-on-the-ambiguous` touches `recordFieldNote.ts`.
- **Do not size from the pilot box.** Real per-customer capture counts are unknown. Only the
  constants above are safe to quote (memory `never-size-from-the-pilot-box`).

## Decision Points

1. **What the table of contents contains.** `getCustomerContext` already fetches everything a
   contents view would summarise. Options:
   - **(a)** keep the full read internally and project a contents shape in the handler;
   - **(b)** add count-only or head-only readers (per-job capture counts, newest capture time per
     job, the customer-level pile's count), so the full text is never fetched for the contents;
   - **(c)** do both, with (b) for the seat tool and the full read kept for the synthesis tools
     while they exist.

   Counts per job need reads across `job_captures`, `visit_notes`, the job stamp and
   `source_capture_id`. None of those readers exists per customer today; the planner's
   `listJobEvidenceSince` is the closest (by job ids and a time floor). Absence has to be stated in
   words for the model not to stop at the contents; the `read_job_note` "exists: false" precedent is
   at `captures.ts:1327-1335`.

2. **Which captures "belong to" a job and to a customer.** Today three different unions exist:
   - `getCustomerContext`: customer stamp + `source_capture_id` + `customer_captures`;
   - `list_recent_captures`: one stamp only;
   - `listJobEvidenceSince`: job stamp + `visit_notes` + `job_captures`.

   Options:
   - **(a)** define one canonical per-job and per-customer union (all six homes) and route the
     contents, the drill-down and search through it;
   - **(b)** keep separate unions per reader.

   Under (a), `list_recent_captures` changes behaviour for existing callers (the `book_visit` and
   `move_visit` steers). The customer-level no-job pile (`customer_captures`, plus stamped captures
   with no job) is a third bucket beside "per job" in either option.

3. **Search mechanism.** Options, given what exists:
   - **(a) No new search.** The seat reads contents and then pages captures per job. Managers
     already hold `query_spine`, which can `ilike` `v_captures`; technicians have nothing.
   - **(b) Keyword, computed at query time.** `ilike`, or `to_tsvector` @@ `websearch_to_tsquery`,
     inside a typed RPC scoped to one customer's capture ids. No migration for the text match
     itself, and no index, so it scans that customer's rows.
   - **(c) Keyword, indexed.** A generated `tsvector` column plus a GIN index on `raw_captures`.
     This is a migration, and migrations do not ride deploys (memory `deploy-does-not-migrate`).
     The append-only interaction is untested. The text-search language configuration (e.g.
     `english`) decides how part numbers and trade words tokenize.
   - **(d) Embedding (semantic) search.** Requires `create extension vector`, an embeddings client
     (none exists; OpenRouter has the endpoint), a separate embeddings table keyed by `capture_id`
     (L1 cannot be updated), a backfill, embedding at ingest (a new call on the write path's hot
     branch), and cost events for it.

   Every option needs the same result post-processing a reader needs today: a tenant re-check, the
   retraction fold, `dropSensitive`, and a way to cite the result's capture ids.

4. **What `brief_customer` and `answer_customer_question` become.** They are one forced-JSON model
   call each, with no tools. Options:
   - **(a) Keep single-call but bounded.** Feed a capped and truncated context; the recap quality
     then depends on what the cap keeps.
   - **(b) An in-process agent loop.** `src/model/toolLoop.ts` exists with 8 turns, 20k-char results
     and a 90s per-call limit, but the seat's gateway gives the whole tool call 60s. A loop of
     several model calls inside one seat tool call runs against that.
   - **(c) A retrieval step before the single call.** Search or select, then synthesize.
   - **(d) Retire both,** and let the seat agent do the browsing and summarising itself.

   (d) touches `surface.expected.ts`, `Q01` (hard-requires `brief_customer`), `X01`, `X02`,
   `toolCases.test.ts:129-140`, `server.test.ts:847-893`, `docs/onboarding.md:220-226`, and the
   doorman runbook's 17-tool count. (a)–(c) keep `validateCitations`' contract, which accepts only
   ids present in the context it was given.

5. **The dump one level down.** A contents-then-open design moves the unbounded read to "open this
   job". Options:
   - **(a)** page captures per job (`limit` plus a cursor on `captured_at`, with a total order,
     which `listJobsForCustomer` currently lacks);
   - **(b)** truncate each capture's text (the planner's 600-char precedent) with "open capture X
     for the full words";
   - **(c)** both;
   - **(d)** no bound, relying on jobs being small.

   Under (b), citations have to be checked against the text actually shown (`planner.ts:621-626`).

6. **Recap questions** ("summarize this job", "what's the history here") are not shrunk by search.
   Options:
   - **(a)** the seat opens pages and summarises in its own context (cost: turns at +3–5s each);
   - **(b)** a server-side per-job synthesis tool over one job's captures (a bounded version of
     flow 1);
   - **(c)** a stored, derived summary. No seat-readable one exists: job notes are planner-private
     and not evidence-cited, and the ratified rule "only accumulate what something can later
     falsify" (`docs/engineering-memory.md:896-897`) governs derived stores.

7. **Latency budget per question.** Seats make one tool call per model call. Options:
   - **(a)** the contents result carries enough (e.g. the newest capture per job, inline and
     truncated) that common questions end in one call;
   - **(b)** a minimal contents result, so every content question costs at least one more model
     call;
   - **(c)** a combined verb that takes a question and returns contents plus matching excerpts.

   The standing precedent is "fold the lookup into the tool that needs it"
   (`docs/engineering-memory.md:2850-2877`).

8. **Which capture fields a seat sees.** `get_customer_context` and `list_recent_captures` return
   full rows including `metadata` (email headers, `threadId`, `sentVia` / `toolSlug`),
   `external_id` and `blob_path`. `v_captures` omits those three. A new contents or search result
   either follows the row shape or the view shape.

9. **What stays on `get_customer_context`'s current payload.** `upcomingVisits` (with its eval-graded
   `phrase`), `openWorkNote`, `moneyByJob` and standing facts are all small and structured, and each
   has a test or eval behind it. Each can stay in the contents, move to a sub-verb, or go.
   `leanGrounding()` already deletes two of them for an eval arm.

10. **The planner's unreachable references.** `get_customer_context` sits in `CITABLE_TOOLS`
    (`planner.ts:1986`) and in `TEAM_LEAD_TOOL_NAMES` (`identity.ts:72`) with no schema, pinned as
    known unreachable (`server.test.ts:8427-8442`). A renamed or reshaped tool can:
    - **(a)** leave both entries as they are;
    - **(b)** remove them, and update the pin test;
    - **(c)** give the planner the new verb.

11. **The batched fetch** (the dropped finding carried here). One `getRawCapture` per id
    (`context.ts:158`). Options:
    - **(a)** a `listRawCapturesByIds` reader, chunked like `findRetractionsFor` will be;
    - **(b)** make it unnecessary by joining through the link tables, the `listJobEvidenceSince` job
      arm's `raw_captures!inner(*)` embed pattern (`rawCaptures.ts:425-438`);
    - **(c)** an RPC that returns a customer's captures in one call.

## Open Questions

- **Confirm by test** that a capture linked only through `visit_notes` (a note attached to a
  pre-booked trip) and one linked only through `job_captures` are absent from
  `getCustomerContext().recentCaptures` and from `list_recent_captures`. This was derived from
  reading the readers, not executed.
- **Real capture volume per customer and per job** is unknown and must not be read off the pilot.
  What cap or page size a real firm needs is not answerable from the code.
- **Does OpenClaw truncate or reject large MCP tool results** before they reach the model? Nothing
  in this repo says. The vendor docs would need checking.
- **Does the seat model follow a contents-then-open protocol** without stopping at the contents?
  Gemini 3.8 Flash is primary, Muse 1.3 the fallback. There is no eval for it. `M07` and the
  date-eval S-cases are the nearest existing probes (S06 "stopped at `get_customer_context` and
  relayed the empty read", `docs/engineering-memory.md:1500`).
- **Does adding a generated `tsvector` column to `raw_captures` interact with the append-only
  trigger** (table rewrite on `ALTER TABLE … ADD COLUMN … GENERATED … STORED`)? Untested; the local
  stack would answer it.
- **Is pgvector available on the local Supabase CLI stack** the tests run on? The fetched docs page
  covers hosted only.
- **Must the `manager_only` filter carry into search results** as it is, given the 2026-08-23 ruling
  (sensitivity NULL by default, the manager decides) that has not been implemented?
- **Ordering with the sibling task.** Search and contents readers that fold retractions over many
  ids depend on `findRetractionsFor` chunking, which lands with
  `20260914-fix-the-small-board-findings-listjobsfor`.
- **What a technician should be able to search** vs a manager. Technicians have no SQL tool today;
  whether the new verb is base-tier or manager-only is not settled anywhere in the record.
