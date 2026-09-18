---
date: 2026-09-15
task: The retrieval layer, plan 4 of 4 — the team schedule becomes a counts page with pages of stops on request, the schedule readers stop cutting at 1000 rows, list_pending_reviews pages, array results wrapped, Composio results go through the size cap, visit time indexes, and v_schedule's early-morning day bug
research: thoughts/shared/research/2026-09-15-the-retrieval-and-delivery-layer.md
status: complete
supersedes: nothing
---

## Overview

Tools must never dump data into an agent's context window (operator, 2026-09-15). Plan 1 (PR #242)
did the customer read and capped every dispatched result at 20,000 chars. This plan does ladder item
4: `get_team_schedule` (ruling 7), `list_pending_reviews`, bare arrays, the Composio relay (ruling 3),
schedule indexes (ruling 11). Base `origin/main` 2ca4f71; parallel with plans 2 and 3.

## Decisions

- **Schedule rules stay in the one shared TypeScript reader** (operator, 2026-09-15; a deliberate
  exception to ruling 1 for the schedule only). `readBoardDays` / `readLooseBucket`
  (`src/schedule/boardRead.ts`) are the single definition the board, the console and the tool share
  (a past final review demanded that parity); a SQL copy would make two. Their silent 1000-row cut is fixed.
- **Stops only when asked** (operator, 2026-09-15): the counts page by default; `stops: true`
  (optionally `technicianRef`) adds 25 trips per page in the same call.
- **Labor hours: nothing here** (operator, 2026-09-15): already ruled DELETED (2026-09-09, rung 10d
  task `20260912-rung-10d-the-planner-writes-l2-and-the-d`), which also closes the retracted-note defect.
- **Other readers: tell the agent, do not page** (operator, 2026-09-15). When an unpaged read that
  feeds an agent returns 1000 rows, the agent is told "only the first 1000 were read": `get_job` and
  `record_money_event` money entries, `record_caller`'s job list (in its refusals, where a cut shows),
  the unscheduled-jobs queue. No agent reads `listExpiredAudio` (drains nightly),
  `listQueuedNudgesForHost` or the watcher's `findOpenReviewItemsByKind` (plan 3), so they are left.
  Assumption: the hosted pilot's `max_rows` is the Supabase default 1000 (local `config.toml:18`).
- **Composio: cap only, no filters** (mine, stated in the brief): tier and retraction filters mean
  nothing for Gmail/Sheets data; the session already scopes apps (`src/composio/sessions.ts`). Only
  `tools/call` responses are transformed, as a STREAM (never held to upstream end: a server SHOULD,
  not MUST, close after the response, and older revisions may send requests mid-stream); the rest
  stay a pipe. JSON and SSE responses are both allowed
  (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http, fetched
  2026-09-15); a cut drops `structuredContent`, which a tool SHOULD also send as text
  (https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
- **Past days read as history** (mine): `['confirmed','completed']`, the console's set (user
  decision 2026-09-07, `boardRead.ts:102-108`; defect 5a). "0 = free" becomes "0 = nothing booked".
- **The recall view reads the board tray** (mine): `unassignedOnly:true` → `readLooseBucket`, so
  overdue parked visits appear flagged as on the board (defect 5b). It is itself the request for the
  list: counts + first 15 of each queue; `queue` + `after` for more, keyed on values, not positions.
- **Windowed counts use narrow reads** (mine, reviewer finding): the tray reads every confirmed visit
  since 1970, so the windowed page does not call it. `counts.untimed` is a head count;
  `counts.unscheduledJobs` reads open jobs only; parked visits outside the window are counted in the
  recall view. Untimed visits are no longer listed in the windowed result. `GROUNDING_LEAN` keeps
  the counts (they are the page). `get_schedule` is unchanged (one person); its reader gains paging.
- **`find_slots` and displacement read the embedded window reader** (mine): `listVisitsWithRefsForTenant`
  carries city, name and crew refs, so `listJobsWithCustomerByIds` (CHUNK 500, above the URL wall)
  and the per-row `getTechnicianById` loop leave those paths. `book_visit`/`move_visit` keep their
  per-person span read (`booking.ts:192-201`, now paged); the exclusion constraint stays the authority.
- **`v_schedule.local_day` fixed** (verified on this stack 2026-09-15: a naive 06:00 visit for an LA
  firm reads 2026-09-14; `starts_at` is naive-local, `20260714120000:11`, so use `at time zone 'UTC'`).
- **`list_pending_reviews` pages in SQL** (mine; ruling 1 applies): `review_queue_page`; a `detail`
  over 1,500 chars is withheld and opened by id. **Arrays wrapped by name** (mine): `find_customer`
  → `{customers, note?}`, `list_team` → `{team}`; the hub wraps any future array as `{items, count}`.

## Plain-language walkthrough

```
manager: "how's this week?"      ► get_team_schedule ► counts: per day, per person, unassigned, untimed, jobs
manager: "who's on today?"       ► get_team_schedule(stops:true) ► counts + 25 trips, "next" for more
manager: "what needs assigning?" ► get_team_schedule(unassignedOnly) ► counts + 15 parked + 15 jobs
manager: "anything to review?"   ► list_pending_reviews ► counts by kind + 20 items, "next"
Gmail/Sheets via Composio        ► relay on Render ► over 20k chars? cut + say so
```

**Phase 1**: database indexes so visit time lookups stay fast as history grows, a function that
hands out the review queue a page at a time, and the fix for 6am visits landing on the previous day.
**Phase 2**: the schedule readers stop silently cutting at 1,000 visits (today later days come back
empty and `find_slots` can offer booked time), and agents are told when a list hit 1,000.
**Phase 3**: `get_team_schedule` gives numbers by default and names only when asked, 25 at a time.
**Phase 4**: the review list pages; `find_customer` and `list_team` return named objects.
**Phase 5**: Composio results get the size cap, the one path that skipped it.

## Secrets & env preflight

- **Phase 1:** this worktree's stack (`TradesDatabase-retrieval-layer-4-ed3d70`, `.env.test` present);
  the `supabase-test` MCP for the pilot apply. **Phases 2–5:** none new (`SPINE_RESULT_CAP_CHARS`
  optional). **Phases 3–4 eval:** a seeded local world for `npm run spine-eval:tools`; `EVAL_INFERENCE_API_KEY`
  in `.env` (an OpenRouter key, `scripts/spine-eval/lib/env.mjs:125`) only for the optional agent run.

## Phase 1: the migration

**`supabase/migrations/20260917140000_retrieval_layer_schedule.sql`** (re-ordered at integrate if needed):
- Indexes (`if not exists`): `visits (tenant_id, status, starts_at)`, `visits (tenant_id, status, ends_at)`,
  `visit_notes (tenant_id, created_at)`, `money_events (corrects_event_id) where corrects_event_id is not null`,
  `review_items (tenant_id, created_at, id) where status = 'open'`.
- `create or replace view v_schedule` / `v_cancelled_visits`: bodies verbatim from
  `20260907100100_drop_visits_technician_id.sql:45-87` / `:89-121`, with `local_day = (v.starts_at at
  time zone 'UTC')::date`, `local_weekday = to_char(v.starts_at at time zone 'UTC', 'FMDay')`, the
  unused `join tenants tn` dropped (columns and types unchanged; nothing depends on either view).
- `review_queue_page(p_tenant uuid, p_kind text default null, p_after_created timestamptz default null,
  p_after_id uuid default null, p_limit int default 20, p_detail_chars int default 1500) returns jsonb`,
  `plpgsql security definer stable set search_path = public`. Open items of `p_tenant`; order
  `(created_at, id)`; keyset `p_after_created is null or (created_at, id) > (p_after_created, p_after_id)`;
  limit clamped 1..50, fetch +1 → `has_more`. Returns `{total, by_kind, items: [{id, kind, subject_ref,
  suggestion, created_at, detail | null, detail_chars, detail_withheld}], has_more, next_after_created,
  next_after_id}` with every aggregate `coalesce`d (`'[]'`, `'{}'`, 0) so an empty queue is not null;
  `next_after_created` as the exact text of the timestamp (microseconds kept). `total` honours `p_kind`,
  `by_kind` counts all open. Grants: the `tenant_cost_detail` template (`20260725150000:56`).
- `npm run gen:types:local` (never `gen:types`).

### Automated verification
- [x] `npx supabase db reset` applies; `review_queue_page` in `database.types.ts`.
- [x] `src/db/querySpine.test.ts`: tenant timezone set by `pg` update (`createTenant` takes none):
      America/Los_Angeles, naive 06:00 on 2027-03-09 → `local_day` 2027-03-09, `local_weekday`
      Tuesday (fails on the old view); Asia/Tokyo, naive 22:00 → same day (the other direction);
      one cancelled visit through `v_cancelled_visits`.
- [x] New `src/db/reviewQueue.test.ts` (own tenant): empty queue → `items: []`, `by_kind: {}`; 25
      items → 20 + 5, no repeat or gap, including two items sharing a `created_at`; `p_kind`; a
      3,000-char detail withheld; resolved items and another tenant's never appear.
- [x] `src/db/schema.test.ts`: the five index names exist. `npm run typecheck`, `lint`, `test`.

### Live verification (agent-executable; `supabase-test` MCP)
- [ ] **At PR time, before merge** (Calls-worker and Calls-purge auto-deploy at merge):
      `apply_migration`, `NOTIFY pgrst, 'reload schema'`, read back `pg_proc` + `pg_indexes`.
- [ ] **IMMEDIATELY after the merge, TRIGGER THE WEB DEPLOY BY HAND — before any checking.**
      `TradesDatabase` (srv-d8uqmdegvqtc73bfn83g), the seat-facing MCP server, has
      `autoDeploy: "no"` / `autoDeployTrigger: "off"` (read from the Render API 2026-09-16).
      Merging ships NOTHING to the seats, so between the migration apply and this trigger the
      pilot runs NEW SCHEMA ON OLD CODE — keep that window to the length of one API call and do
      the read-backs after it, not inside it. Use the API trigger, never the dashboard "Redeploy"
      button, which repeats the OLD commit. The estate is recorded in `docs/engineering-memory.md`
      under *"There are FIVE services, and three have `autoDeploy: no`"* — cited by QUOTE because
      the line number moves (it sat 16 lines apart in two worktrees of the same file on one day).
      The §4 diagram and the estate table were both wrong (the table had `lifecycle-heart` as
      auto-deploy *yes*); plan 2 corrected both in 037f58a — TAKE THEIRS at merge, do not
      re-edit. `docs/engineering-memory.md` is edited on both sides, so expect a small conflict
      there and keep both.

---

## Phase 2: complete readers, and the row-limit note

**`src/db/visits.ts`** — page (PAGE 1000 loop, `.order('starts_at').order('id')`, the
`listUnassignedVisits` idiom `:1007-1027`): `listVisitsForTenant` (`:798`), `listVisitsWithRefsForTenant`
(`:912`), `listVisitsForTechnician` (`:941`, tiebreak `visit_id`). Add
`listUnscheduledOpenJobsCapped(tenantId): Promise<{ rows; rowCapHit }>` holding the body of
`listUnscheduledOpenJobsWithCustomer` (`:1324-1346`), `rowCapHit = hitRowCap(data.length)` before the JS
filter; the old name returns `.rows`. Add `countUntimedVisits(tenantId)`: `select('id', {count:'exact',
head:true})`, confirmed, `starts_at is null`.

**`src/db/rowCap.ts`** (new, exported from `src/db/index.ts`):
```ts
export const POSTGREST_MAX_ROWS = 1000; // supabase/config.toml [api] max_rows
export const hitRowCap = (n: number): boolean => n >= POSTGREST_MAX_ROWS;
export const rowCapNote = (what: string): string =>
  `Only the first ${POSTGREST_MAX_ROWS} ${what} were read (the database's per-read limit) — there may be more, and anything worked out from them may be incomplete.`;
```

**`src/schedule/fit.ts`** — `assembleFitContext` (`:383-399`) and `findDisplacementCandidates` (`:464-502`)
read `listVisitsWithRefsForTenant`; city and name from the embed with the `boardRead.ts:190-196` tenant
re-check; refs from `participantsOf(row, tenantId)`. Drop now-unused imports.

**`src/schedule/boardRead.ts`**
- `readUnscheduledJobsCapped(tenantId)` → `{ jobs, rowCapHit }`; `readUnscheduledJobs` keeps its signature.
- `readLooseBucket(tenantId, nowIso = new Date().toISOString())`: `today` from `nowIso` (`:334`).
  Parked rows gain, additively (the board ignores them): `jobId` (tenant-gated like `jobTitle`),
  `createdAt` (kept, not stripped at `:391-395`), `unassigned: participantIdsOf(row, tenantId).length === 0`
  (counted, not named). `LooseBucket` gains `unscheduledJobsRowCapHit`.

**Row-limit notes** — `get_job` (`customers.ts:455-486`): `moneyNote: rowCapNote('ledger entries')` when
`hitRowCap(moneyEvents.length)`; `record_money_event` (`money.ts:176-186`): same on `events`;
`record_caller` (`customers.ts:854-873`): append the note to both refusals when `hitRowCap(onFile.length)`.

### Automated verification
- [x] `src/db/scheduleWindow.test.ts` (landed there, not scheduling.test.ts), on its OWN tenant: 1,005 confirmed visits (bulk `insert …
      generate_series` via `pg`) in one window → both window readers return 1,005, ordered, no duplicates.
- [x] `src/schedule/fit.db.test.ts` passes unchanged; `src/db/rowCap.test.ts`: 999 false, 1000 true.
- [x] A `readLooseBucket` test: `nowIso` moves `overdue`; an occupied trip whose technician row is
      another tenant's reads `unassigned: false`. `npm run typecheck`, `lint`, `test`.

---

## Phase 3: `get_team_schedule` becomes a counts page

**`src/mcp/tools/schedule.ts`** — description (`:232-250`) rewritten: what the page holds; "pass
`stops: true` for WHO and WHICH customers (add `technicianRef` for one person); 25 per page, copy `next`
into `after`"; "`unassignedOnly: true` lists parked visits (overdue flagged), untimed visits and jobs
with no visit"; keep the counts-verbatim, `scheduleVersion` and boardNote sentences. Schema adds
`stops`, `technicianRef`, `queue` (`'visits'|'jobs'`), `after`. The handler (`:708-967`) keeps its
validation (`:712-757`) and version-first read (`:762`), then:
- **Windowed:** `Promise.all([readBoardDays({tenantId, from, to: toDay, statuses: ['confirmed','completed']}),
  countUntimedVisits, readUnscheduledJobsCapped])`. Trips = lanes deduped by `visitId`. Result
  `{status, from, to, scheduleVersion, technicianHorizonDays, days: [{date, weekday, visits, completed,
  unassigned, byTechnician: {ref: n}}] for EVERY date (readBoardDays returns only days with stops),
  counts: {byDay, total, completed, unassigned, untimed, unscheduledJobs}, countsNote, note, rowCapNote?}`.
  `stops: true` → trips sorted `(date, startTime, visitId)`; `technicianRef` resolved with
  `getTechnician(tenantId, ref)` (unknown → `invalid_range` naming `list_team`) and matched on
  `technicianRefs.includes(ref)`, never the first lane; keyset `after = "<date>|<HH:MM>|<visitId>"`
  (malformed → `invalid_range`); 25 per page: `{visitId, date, weekday, stage, startTime, endTime,
  status, technicianRef, technicianName, technicianRefs, technicianNames, unassigned, customer,
  address, jobId, jobTitle}` (completed → `happened`, confirmed → `placed`), `hasMore`, `next`.
- **Recall (`unassignedOnly`):** `readLooseBucket(tenantId, spineNowIso(tenantId))` → `{status,
  unassignedOnly: true, scheduleVersion, technicianHorizonDays, counts: {parkedVisits, overdue, untimed,
  unscheduledJobs}, visits, visitsNext, jobs, jobsNext, note, rowCapNote?}`; 15 of each, or 25 of one
  with `queue`. Total order and value cursors: visits dated first by `(date, startTime, visitId)`
  (`"d|<date>|<HH:MM>|<visitId>"`), then untimed by `(createdAt, visitId)` (`"u|<createdAt>|<visitId>"`);
  jobs by `(createdAt, jobId)`. A cursor whose row has left the queue still works (rows strictly after
  the values). `visits[]` = tray rows + `technicianRef: technicianRefs[0] ?? null`.
- Remove this handler's `listUnplaced`, `listUnassignedVisits`, `listVisitsForTenant`,
  `listJobsWithCustomerByIds`, `listTeam` uses; delete `listUnplaced` (no callers left).

**`src/mcp/tools/shared.ts:783-792`** — `leanGrounding` comment: no longer strips these counts.

**Tests (`src/mcp/server.test.ts`)** — a `recallAll(callWith, queue)` helper pages to the end; use it at
EVERY recall site (the shared tenant holds many parked rows and jobs): `:4379-4388`, `:5072-5100`,
`:7023-7048`. `:4462-4592`: `counts.untimed` replaces the `untimed` list, the untimed row's
`technicianRef`/`customer` asserted via `recallAll`, the lean block expects counts present. `:4640`,
`:4679`, `:4721`, `:4751`, `:5011`, `:5026`, `:7087`: `stops: true`, read `stops`. New: no `stops`
key without the flag; 30 trips in a day → 25 + `next` → 5, no repeat; a crew trip found by its second
member's `technicianRef`; a completed past visit in `completed`; an overdue parked visit `overdue: true`;
a `next` cursor still works after its row was booked.

**Evals** — `src/eval/toolCases.ts` R07 (`:270-279`): `args` add `stops: true`.
**Docs** — `docs/nemoclaw-tech-agent.md:357`; one line on the new shape in `docs/engineering-memory.md`.

### Automated verification
- [x] `npm run typecheck`, `lint`, `test`; a 14-day, 10-technician, 5-trips/day window serializes
      under 8,000 chars without `stops`.
- [x] `npm run spine-eval:world` then `npm run spine-eval:tools`: R07, R08 pass (`toolCases.test.ts` is
      static and runs no check).

### Live verification (agent-executable, optional)
- [x] `npm run spine-eval:agent` (`EVAL_INFERENCE_API_KEY`): D01, S08, M04 pass; record whether the agent
      passed `stops: true` when it named customers.

### Manual verification
- [ ] After deploy: restart the s2 gateway (`tools/list` is cached), then as a manager in Telegram:
      "what's on today?", "how's this week looking?", "what still needs assigning?" — judge that
      numbers are quoted, names appear only when asked, every reply ends with the board line.

---
*Pause after this phase: its Manual verification list is non-empty.*

## Phase 4: the review queue pages, arrays wrapped

**`src/db/reviewItems.ts`** — `getReviewQueuePage(tenantId, {kind?, afterCreated?: string, afterId?, limit?})`
over `rpc('review_queue_page')`, hand-narrowed (`readTenantCostDetail` idiom, `src/db/costs.ts:603`);
the timestamp stays a string end to end (never a `Date`).

**`src/mcp/tools/reviews.ts`** — `list_pending_reviews` (`:33-40`): args `kind`, `after`
(`"<created_at>|<id>"` from `next`), `limit` (≤50), `reviewItemId` (one open item, whole detail, via
`getOpenReviewItem`). Description adds paging and "a withheld `detail` opens with `reviewItemId`"; the
agentContext sentence stays verbatim. Result `{items, total, byKind, hasMore, next, note}`; `note`
says "no open review items" when empty.

**`src/mcp/tools/customers.ts:346-363`** — `find_customer` → `{customers, note?}` (note when empty).
**`src/mcp/tools/roster.ts:857-878`** — `list_team` → `{team}`.
**`src/mcp/server.ts:858`** — an array result becomes `{items, count, note?}`; update the comment at `:888-900`.

**Tests** — `server.test.ts`: review sites pass `kind` (`sheet_ref_mismatch` `:1077-1080`,
`overdue_visit_gap` `:1102-1108`, `availability_setup` and the staged kinds at `:5586-5636`) so the
item is on page 1 regardless of the shared tenant's backlog; shape renames at `:345-379` (every result
carries `now`), `:383-389`, `:1065`, `:1293`, `:1389` (`toEqual([])` → `customers: []`), `:2324`,
`:4261`, `:5487`, `:5728`. New: 25 reviews → 20 + `next` → 5; `reviewItemId` opens a withheld
detail; another tenant's id → not found. `docs/nemoclaw-tech-agent.md:292`.

### Automated verification
- [x] `npm run typecheck`, `lint`, `test`; `npm run spine-eval:tools`: R01, R09, R10 (empty queue), G04 pass.

---

## Phase 5: the Composio relay goes through the cap

**`src/mcp/resultCap.ts`** — `capToolResult(text, cap, carry, note?)`: optional `note` replaces the
spine-specific sentence.

**`src/composio/relayHandler.ts`**
- `isToolCall` becomes a type guard (`parsed is { method: 'tools/call'; id: string | number }`).
- `export function capMcpToolResult(result, cap = resultCapChars())`: unchanged when its JSON fits; else
  `{resultType?, content: [{type:'text', text: capToolResult(joinedText, cap, {}, COMPOSIO_CAP_NOTE)}],
  isError?}`: text blocks joined by `\n`, else `JSON.stringify(structuredContent ?? content)`; the note
  counts dropped non-text blocks and says "ask the app for fewer results".
- `export const cappingForward = (requestId): ForwardFn` — `defaultForward`'s shape (`:94-122`), with
  `accept-encoding: identity`, and the `headersSent` guard and client-close teardown kept:
  - **non-2xx**, or a content type that is neither JSON nor SSE: piped unchanged;
  - **`application/json`** (match with `startsWith`, `; charset=` allowed): buffer (over 16 MB →
    destroy upstream, 502), cap the message whose `id` equals `requestId`, and write
    `content-length = Buffer.byteLength(out)`, dropping `transfer-encoding`;
  - **`text/event-stream`**: write the head at once, without `content-length`. Parse events as they
    arrive on `\n\n` or `\r\n\r\n` boundaries and forward each immediately. Only the event carrying the
    response with `id === requestId` has its `data:` replaced with the capped JSON, other lines kept.
    Once it is written, end the client response and destroy the upstream. Unparseable events pass through.
- `handleComposioRelay` (`:217`): `deps.forward ?? (req.method === 'POST' && isToolCall(parsed) ?
  cappingForward(parsed.id) : defaultForward)`.

### Automated verification
- [x] `src/composio/relayHandler.test.ts`, with a local upstream `http.createServer` AND a local front
      server calling `handleComposioRelay` (the existing `fakeRes` lacks `on`/`destroy`),
      `SPINE_RESULT_CAP_CHARS=400`: small JSON → byte-identical; big non-ASCII JSON → valid, same `id`,
      `truncated: true`, no `structuredContent`, correct byte length; SSE (`\r\n` framing) with a
      progress event then a big response, upstream held OPEN afterwards → client receives both and the
      response ends within a second; upstream 500 → unchanged; `initialize`/`tools/list` → piped.
- [x] `src/mcp/resultCap.test.ts`: custom `note`. `npm run typecheck`, `lint`, `test`, `build`.

### Manual verification (needs a paired manager seat)
- [ ] After deploy, from the s2 manager seat: "my last 3 emails" answers normally; "list my last 100
      emails" comes back cut with the note relayed.
