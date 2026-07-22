---
date: 2026-07-22
branch: fix/telegram-board-latency
commit: cdab4ff
topic: Telegram dispatch-board Mini App UI latency — fix surface for P2/P3/P4/P6 (+P7 investigation)
---

## Summary

The dispatch board is a **Telegram Mini App** — a web page (`web/board/`) that opens
inside Telegram's in-app browser and shows a firm's schedule as day columns of visit
cards. A manager can drag cards to move/reassign visits and tap ✕ to cancel; anyone can
tap a card for contact/logistics detail. The page talks to the same Node process that
hosts the MCP server, through a small HTTP surface (`/board/api/*`) added to
`src/mcp/httpServer.ts`.

Every button press feels slow (~1–2s). The cause is **many serial database round-trips
per press**, not slow SQL — measured DB execution on the pilot is sub-millisecond
(auth query 0.11ms, the day read 0.7ms). Each `/board/api/*` request re-authenticates
with a database lookup and then reads the schedule as a chain of single-table queries
(an "N+1" pattern: one query per related table instead of one query that joins them).
This document maps the read path, the auth path, and the exact code each proposed fix
(P2 auth cache, P3 one joined read, P4 drop the unused version query, P6 index the
lookup column) would touch, plus the P7 network-transit question. **P1 (client-side
anchor cache) is already implemented on this branch and is out of scope here.**

## Entry Points

- **HTTP routing:** `src/mcp/httpServer.ts:260` — `if (isBoardPath(req.url))` routes all
  board traffic *before* the IP allowlist (board traffic is public browsers, not the
  gateway). Body is capped for POSTs; then `handleBoardRequest(req, res, boardBody)` at
  `:293`.
- **Board HTTP handler:** `src/telegram/boardApi.ts:136` — `handleBoardRequest`. Dispatches:
  - `GET /board`, `/board/static/*` — unauthenticated static shell + assets.
  - `GET /board/api/day` (`:156`) — the **day view** (tab / pager / refresh). → `readBoardDays`.
  - `GET /board/api/visit` (`:196`) — the **card-tap detail sheet**. → `readVisitDetail`.
  - `POST /board/api/move`, `/board/api/cancel` (`:233`) — manager writes (preview→commit).
- **Auth (every API request):** `src/telegram/boardApi.ts:51` — `authBoard(req)`.
- **Client:** `web/board/board.js` — the Mini App page script (P1 already patched here).

## Key Files

| File | Role | Key exports / functions |
|---|---|---|
| `src/telegram/boardApi.ts` | Board HTTP surface + auth | `handleBoardRequest`, `authBoard`, `isBoardPath` |
| `src/telegram/initData.ts` | Telegram signature check (local HMAC, no DB) | `verifyInitData` → `{ userId, user, authDate }` |
| `src/schedule/boardRead.ts` | Board read shape (the N+1 lives here) | `readBoardDays`, `readVisitDetail`, `BoardDays`, `VisitDetail`, `InvalidRangeError` |
| `src/db/technicians.ts` | Roster reads | `findRosterByTelegramUserIdGlobal`, `listTeam`, `getTechnicianById` |
| `src/db/assignments.ts` | Visit rows | `listAssignmentsForTenant` (`:192`), `getAssignmentForTenant` (`:175`) |
| `src/db/jobs.ts` | Jobs | `getJob` (`:101`, id-only), `listJobsWithCustomerByIds` (`:122`, already embeds customers) |
| `src/db/customers.ts` | Customers | `getCustomer` (`:89`, id-only) |
| `src/db/scheduleEvents.ts` | Version stamp | `latestScheduleVersion` (`:40`) |
| `src/db/tenants.ts` | Tenant row | `getTenant` (`:24`) — board uses `.timezone` only |
| `src/db/client.ts` | Supabase client | `getClient()` — **module-cached singleton** |
| `web/board/board.js` | Mini App page | `load`, `refresh`, `apiGet`, `apiPost`, `openDetail` |
| `src/telegram/boardApi.test.ts` | Board HTTP tests | `DayResponse` iface carries `scheduleVersion` at `:125` |

## Data Flows

### Auth — runs on every `/board/api/*` request (`authBoard`, boardApi.ts:51)

```
req.headers.authorization = "tma <raw initData>"
        │
        ├─ verifyInitData(raw, BOARD_BOT_TOKEN)      ← LOCAL HMAC-SHA256, no DB, no network
        │     • rejects: missing/garbled header, bad signature, missing/stale auth_date
        │       (maxAgeSec default 86_400 = 24h), missing/non-numeric user id
        │     • returns { userId: String(user.id), user, authDate }
        │
        └─ findRosterByTelegramUserIdGlobal(userId)  ← DB QUERY (technicians by telegram_user_id)
              • null            → 401 (unknown id)
              • { ambiguous }   → 409 (multi-firm or duplicate binding)
              • { technician }  → { ok, tenantId, technician }
```

`verifyInitData` (initData.ts:31) is a pure module — `createHmac`/`timingSafeEqual`, no
IO. The **only** database cost in auth is `findRosterByTelegramUserIdGlobal`
(technicians.ts:65): `select * from technicians where telegram_user_id = ?`, then
filters out inactive states and refuses on any multiplicity. **This is the P2 target.**

### Day view — `GET /board/api/day` → `readBoardDays` (boardRead.ts:63)

```
authBoard ............................ 1 DB query (auth)
readBoardDays:
  getTenant(tenantId) ................ 1 DB query  — ONLY when `from` omitted (anchor call)
  latestScheduleVersion(tenantId) .... 1 DB query  — result UNUSED by the board (P4)
  listAssignmentsForTenant(...) ...... 1 DB query  — the visits  ┐
  listJobsWithCustomerByIds(jobIds) .. 1 DB query  — customer     │ N+1 chain (P3)
  listTeam(tenantId) ................. 1 DB query  — tech names   ┘
```

`listJobsWithCustomerByIds` (jobs.ts:122) already uses a PostgREST embed
(`select('*, customers(name, address_line1, …)')`). `listTeam` (technicians.ts:130)
returns the whole roster; the loop maps `technician_id → ref/display_name` via `techById`.
The **technician self-filter** is a post-fetch `rows.filter(r => r.technician_id === viewerTechnicianId)`
at boardRead.ts:90-93.

### Card tap — `GET /board/api/visit` → `readVisitDetail` (boardRead.ts:167)

```
authBoard ................................... 1 DB query (auth)
readVisitDetail:
  getAssignmentForTenant(id, tenantId) ...... 1 DB query — tenant-scoped ✓ (returns null if wrong tenant)
  if viewerTechnicianId set & != row.tech → return null   (self-filter / 404-uniformity)
  getJob(row.job_id) ........................ 1 DB query — ID-ONLY (no tenant filter)
  getCustomer(job.customer_id) .............. 1 DB query — ID-ONLY; gated by `job.tenant_id === tenantId`
  getTechnicianById(row.technician_id) ...... 1 DB query — tenant-scoped ✓
```

The chain is genuinely serial: `getJob` needs the assignment's `job_id`, `getCustomer`
needs the job's `customer_id`. **This is the P3 target.**

### Client double-call (context for P1, already fixed)

`web/board/board.js` `load()` previously fired two sequential `apiGet('/board/api/day')`
calls per tab/pager press — the first with no `from`/`to` purely to learn the firm-local
"today" (`first.from`), the second for the real week. P1 (this branch) caches that anchor
in `state.today` and skips the first call except on initial load; `visibilitychange`
clears `state.today` to force a midnight re-anchor. **Do not re-plan.**

## External Dependencies

- **`@supabase/supabase-js`** (`src/db/client.ts`) — PostgREST over HTTPS to the hosted
  Supabase project. `getClient()` builds the client from `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` (service-role, bypasses RLS — server-only) and **caches it
  in a module-level `cached` variable** (client.ts:4,10,15). One client instance is
  reused for the process lifetime.
- **Telegram Bot API / Mini App initData** — `verifyInitData` implements the documented
  `WebAppData`-keyed HMAC scheme (initData.ts:9 cites the Telegram docs URL).
- **Hosted Supabase pilot** `daqapdlkgxfrhquacprv` — the LIVE deployed DB (Render web +
  cron + badge-pull read it). Tests must NOT point here.

## Constraints and Invariants

1. **L1/tenant security posture on the read path (critical for P3).** The FK constraints
   are **id-only** — `assignments.job_id→jobs`, `jobs.customer_id→customers`,
   `assignments.technician_id→technicians` — **none carries `tenant_id`**. So a raw embed
   rooted at a tenant-filtered `assignments` row does NOT, by FK alone, guarantee the
   nested job/customer/technician belong to the same tenant. Today's code defends against
   this explicitly:
   - `readVisitDetail` re-checks `job.tenant_id === tenantId` (boardRead.ts:179,194,196)
     before using job or customer, and uses tenant-scoped `getAssignmentForTenant` /
     `getTechnicianById`.
   - `readBoardDays` roots at tenant-scoped `listAssignmentsForTenant` and
     `listJobsWithCustomerByIds(tenantId, …)` (jobs.ts:130 filters `tenant_id`).
   Any P3 embed MUST preserve this — either an **explicit tenant filter on the nested
   resource** (PostgREST `jobs!inner(...)` + `tenant_id=eq`) or a **post-embed JS
   re-check** mirroring the current guards.
2. **Self-filter + 404-uniformity (P3).** Technicians see only their own visits; a
   crafted / other-tenant / unassigned `assignmentId` must read as `null`
   indistinguishably (boardRead.ts:162-166,173-174). The day-view self-filter is
   post-fetch (`:90-93`). Whatever P3 does, both must survive byte-for-byte in behavior.
3. **`readBoardDays` is board-only but shape-mirrors `get_team_schedule`.** Sole runtime
   caller is `boardApi.ts:170` (grep-confirmed). The header comment (boardRead.ts:16-21)
   states it deliberately mirrors `get_team_schedule`'s body; the `scheduleVersion` field
   is an artifact of that mirroring.
4. **`scheduleVersion` is dead on the board path (P4).** `web/board/board.js` never reads
   it; `boardApi.ts:180` spreads it via `...days` but the client ignores it. The agent's
   `get_team_schedule` (server.ts:2416) and `boardNotify.ts:135` call `latestScheduleVersion`
   **directly**, not through `readBoardDays` — removing it from `readBoardDays` does not
   touch them. In tests it appears only as a type field (`boardApi.test.ts:125`), with no
   runtime assertion.
5. **`telegram_user_id` is unindexed (P6).** Migration `20260707000000` adds the column
   (`alter table technicians add column telegram_user_id text`) with no index. The auth
   query is a seq scan. Pilot roster = **8 rows** (4 bound), so the scan is ~0.02ms today
   — this is future-proofing, not a measurable win now.
6. **`getClient()` is a cached singleton (P7).** The Supabase client object is built once
   and reused (client.ts:10). So the ~180ms/hop is NOT per-call client construction. It
   is either Render↔Supabase geographic/region transit or undici keep-alive not engaging
   — neither is decidable from the repo alone.
7. **Test-env safety.** Tests run only against the local Supabase stack (`.env.test`,
   enforced by `src/testEnvGuard.ts`). The hosted project is the live pilot — never
   test/seed against it. P6's migration applies to hosted via MCP `apply_migration`, not
   `db push` (ledger drift — recorded in the shared-test-db memory).

## Decision Points

- **D1 — P3 nested-tenant enforcement.** The embed can guarantee same-tenant nesting two
  ways: (a) PostgREST inner-embed with explicit `tenant_id` filters on the nested `jobs`
  (and re-derive customer through it) + `technicians`; or (b) a plain embed followed by
  the same JS `x.tenant_id === tenantId` guards the code has today. (a) pushes the check
  into one query; (b) keeps the exact current logic. Either must reproduce the current
  null/omit behavior for cross-tenant rows.
- **D2 — P3 self-filter placement.** Keep the post-fetch `rows.filter(...)`/`if` guards
  (viewerTechnicianId) exactly as-is, or push `technician_id=eq.viewer` into the query.
  Post-fetch preserves the unassigned-row semantics already reasoned about
  (null ≠ viewer id); in-query changes the shape of what returns.
- **D3 — P3 helper shape.** Add new typed helper(s) in `src/db` returning the embedded
  rows (keeps the "all DB access via the typed layer" convention), vs. inlining the
  `.select('*, jobs(...), technicians(...)')` in `boardRead.ts`. The former matches the
  convention (CLAUDE.md); the latter is fewer files.
- **D4 — P2 cache design.** A module-level `Map<userId, {match, expiresAt}>` in
  `boardApi.ts`. Open sub-choices for the plan: TTL value (~60s suggested), eviction
  (size cap / lazy expiry), and whether to cache only the success `{technician}` result
  or also the `null`/`ambiguous` outcomes. `verifyInitData` stays on every request
  (cheap, no DB) — only the roster lookup is memoized. Staleness window = up to TTL for
  deactivation/tier/tenant changes.
- **D5 — P4 removal shape.** Drop `scheduleVersion` from `readBoardDays`'s query, the
  `BoardDays` type (boardRead.ts:46), the endpoint response (`...days` spread at
  boardApi.ts:180 loses the field), and the test type (`boardApi.test.ts:125`) — vs.
  keep the field for response-shape stability but stop the query (return a constant).
- **D6 — P6 apply path.** New migration file under `supabase/migrations/` (timestamp
  matching convention) applied locally on `db reset`; applied to hosted via MCP
  `apply_migration`. `create index if not exists idx_technicians_telegram_user_id on
  technicians(telegram_user_id)`.

## Open Questions

- **P7 region/transit (cannot resolve from the repo).** With DB exec sub-ms and the
  client reused as a singleton, the ~180ms/hop must be network. Resolving it needs the
  Render service region and the Supabase project region (dashboards, outside this repo),
  and/or a server-side timing log around a PostgREST call to confirm whether undici
  keep-alive is engaging. This is why P7 is flagged as possibly-separate infra work.
- **Is cross-tenant job/customer nesting actually reachable, or purely defensive?** The
  booking verbs are tenant-scoped, so in practice `job.tenant_id === assignment.tenant_id`.
  The code nonetheless re-checks. The plan should preserve the guard regardless (defense
  in depth), but whether a real cross-tenant row can exist would need a data/constraint
  audit to answer definitively.
- **Incidental (not UI latency).** The pilot `api` logs show a ~30-second poller hitting
  `schedule_events` + `technicians` (the `boardNotify` worker) plus a 5-minute host
  badge-pull — constant background DB load, unrelated to the board buttons. Same
  "unbounded polling" shape noted in the agent-cost-cache-diagnosis memory. Out of scope
  for this fix; flagged for awareness.
