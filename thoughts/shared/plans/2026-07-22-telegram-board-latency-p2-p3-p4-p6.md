---
date: 2026-07-22
task: Telegram dispatch-board latency — P2 auth cache, P3 join, P4 drop version, P6 index
research: thoughts/shared/research/2026-07-22-telegram-board-latency-fix-surface.md
status: complete
---

## Completion (2026-07-22)
All phases implemented on `fix/telegram-board-latency`. Final combined review:
**APPROVE WITH NITS** (no blocking findings; cross-phase checks clean — P1/P4 response-shape
compatibility, P2/P3 cache-vs-self-filter independence, no orphaned db exports, complete test
cleanup). Gates: `tsc` 0, `lint` 0, `build` 0, `npm test` 533 passed with the 1 documented
pre-existing `server.test.ts` seat-replay baseline failure.

**Open, not acted on (non-blocking, surfaced for the author):**
- *Suggestion:* the 3-line tenant re-check is duplicated verbatim between `readVisitDetail`
  and `readBoardDays`. Extracting a shared `tenantScoped(row, tenantId)` helper would make
  future hardening apply to both at once — notably, this duplication is exactly why the L3
  customer check existed in one read and not the other.
- *Nit:* `jobs` projections select `id`/`customer_id`, which nothing downstream reads.
- *Follow-up ticket:* `src/writePath/recordFieldNote.ts:197` calls `getJob(match.jobId)` — an
  id-only read with no tenant filter — so a matcher-supplied cross-tenant job id would attach
  this tenant's work to another firm's job. Same bug family as P3, write side, out of scope here.

## Overview
Cut per-button latency on the Telegram dispatch board by removing DB round-trips.
P1 (client anchor cache) is already on branch `fix/telegram-board-latency`. This plan adds,
in order: **P4** drop the unused version query, **P3** collapse the per-button N+1 into one
embedded read, **P2** memoize the auth roster lookup, **P6** index the auth column. Target:
card tap 5→~2 DB queries, tab/pager 5→~2 (per call), auth 1→~0 on cache hit.

## Decisions
- **D1 — P3 nested-tenant enforcement → JS re-check post-embed (not nested filters).** The
  embed fetches assignment+job+customer+technician in one query; tenant safety is then
  re-checked in JS exactly as today (`job.tenant_id === tenantId`, `customer.tenant_id ===
  tenantId`, technician via tenant match). Chosen over PostgREST `!inner` + nested
  `tenant_id=eq` filters because inner-filtering would DROP an assignment whose job is
  cross-tenant entirely, changing today's behavior (visit still shows, customer/title null).
  JS re-check reproduces current behavior byte-for-byte while still saving the round-trips.
- **D2 — P3 self-filter → keep post-fetch.** `viewerTechnicianId` filtering stays a JS
  `filter`/`if` (boardRead.ts:90-93,174). Preserves the unassigned-row rule (null
  technician_id never equals a viewer id) with no query-shape change.
- **D3 — P3 helper shape → new typed helpers in `src/db`.** Add
  `getAssignmentWithRefsForTenant` and `listAssignmentsWithRefsForTenant` to
  `src/db/assignments.ts` (keeps CLAUDE.md's "all DB access via the typed layer"). boardRead
  stays pure shaping.
- **D4 — P2 cache → small `src/telegram/rosterCache.ts` module, injectable clock, success-only,
  60s TTL, size cap.** A separate module (not an inline Map) so the TTL/cap logic is
  unit-testable deterministically. Cache only the resolved `{ tenantId, technician }` on
  success; do NOT cache `null`/`ambiguous` (keeps onboarding responsive; deny path never goes
  stale). `verifyInitData` still runs every request. Staleness window: a deactivated/retiered
  tech keeps board access up to 60s.
- **D5 — P4 → remove `scheduleVersion` entirely** (query + `BoardDays` field + response +
  test type). Dead field, no consumer. `get_team_schedule` and `boardNotify` call
  `latestScheduleVersion` themselves — unaffected.
- **D6 — P6 → new migration; local `db reset`, hosted `apply_migration` (MCP), never `db push`.**
- **Agent-coupling note.** `readBoardDays` is board-only at runtime (sole caller boardApi.ts);
  `get_team_schedule` has its own body in server.ts. P3/P4 do NOT change the per-stop output
  shape (`BoardStop`), only the internal query and the top-level `scheduleVersion` field, so
  there is **no runtime risk to the agent**. Update the "mirrors get_team_schedule" comment
  (boardRead.ts:16-21) to note the intentional divergence.

## Plain-language walkthrough
**Phase A (P4):** the board read computes a "version number" nobody on the page uses. Delete
it. You'd notice nothing change on screen — one fewer database query per button.

**Phase B (P3):** today, showing one visit's detail asks the database four separate questions
in a row (the visit, its job, that job's customer, the technician). We replace those with
**one** question that brings back everything joined together — like asking for a record *with*
its related rows attached instead of chasing links one at a time. Same for the day grid.
Crucially, the database's foreign keys link rows by id only, not by firm — so after the join
we still verify every attached row belongs to the caller's firm, exactly as the code does now.
You'd notice buttons responding roughly twice as fast.

```
Card tap — before:              Card tap — after:
 assignment ─▶ job ─▶ customer   ┌ assignment
             └▶ technician       ├── job ── customer   (one embedded query)
 (4 serial round-trips)          └── technician
                                 + JS re-check each nested row's tenant_id
```

**Phase C (P2):** every button re-asks the database "who is this Telegram user?" — an answer
that barely changes. Remember it in memory for 60 seconds (the signature is still checked every
time). You'd notice the second and later taps feeling snappier than the first.

**Phase D (P6):** the column we look users up by has no index, so the database scans every
roster row. Add the index. Invisible today (8 rows) — insurance as the roster grows.

## Secrets & env preflight
- **Phase A/B/C:** `BOARD_BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `DATABASE_URL` — all `already required`. No new secrets.
- **Phase D:** hosted apply uses the `supabase-test` MCP connection (already available). No new
  secrets. Local apply needs the running local stack (`npx supabase start`).

## Phase A: P4 — drop the unused version query

### What this phase does
Remove `scheduleVersion` from the board day read and its response shape.

### Changes required
**`src/schedule/boardRead.ts`**
- Delete the `latestScheduleVersion` import (line 7) and the call at :83.
- Remove `scheduleVersion: number;` from `BoardDays` (:46); change the return (:136) to
  `{ from, to: toDay, days }`.
- Update the header comment (:80-82) — the "version BEFORE the snapshot" note is now moot.

**`src/telegram/boardApi.test.ts`**
- Remove `scheduleVersion: number;` from the `DayResponse` interface (:125).

### Automated verification
- [x] `npx tsc --noEmit` passes (exit 0)
- [x] `npm run lint` passes (exit 0)
- [x] `npm test` — 522 passed / 1 failed; the single failure
  (`server.test.ts` "a confirmed seat token cannot be replayed", :4146) is **pre-existing**:
  reproduced identically with this phase's changes stashed (baseline = 1 failed / 522 passed).
  Not caused by Phase A; out of scope. `boardApi.test.ts` 19/19 green.
- [x] repo-wide `scheduleVersion` grep: no remaining hits on the board read path (only
  `get_team_schedule`, `boardNotify`, `scheduleEvents`, their tests, and the new comment)
- [x] adversarial phase review: COMPLETE verdict, no gaps

### Manual verification
- none

**STATUS: Phase A complete (2026-07-22). Phases B/C/D not started.**

---
*No pause — automated checks suffice.*

## Phase B: P3 — one embedded read (SECURITY-CRITICAL)

### What this phase does
Replace the 4-query `readVisitDetail` chain and the 3-query `readBoardDays` chain with single
PostgREST embedded selects via new typed helpers, preserving tenant/self-filter/404 behavior.

### Changes required
**`src/db/assignments.ts`** — add two helpers + their row types:
```ts
// visit detail: needs job.title/tenant_id, full customer contact + tenant_id, tech + tenant_id
export type AssignmentDetailRow = Assignment & {
  jobs: (Pick<Job,'id'|'tenant_id'|'title'|'customer_id'> &
    { customers: Pick<Customer,'name'|'phone'|'email'|'address_line1'|'address_line2'|'city'|'state'|'postal_code'|'tenant_id'> | null }) | null;
  technicians: Pick<Technician,'id'|'ref'|'display_name'|'tenant_id'> | null;
};
export async function getAssignmentWithRefsForTenant(id, tenantId): Promise<AssignmentDetailRow | null>
  // .from('assignments').select('*, jobs(id,tenant_id,title,customer_id,
  //   customers(name,phone,email,address_line1,address_line2,city,state,postal_code,tenant_id)),
  //   technicians(id,ref,display_name,tenant_id)').eq('id',id).eq('tenant_id',tenantId).maybeSingle()

// day view: customer name+address only (mirrors listJobsWithCustomerByIds projection)
export type AssignmentDayRow = Assignment & {
  jobs: (Pick<Job,'id'|'tenant_id'|'customer_id'> & { customers: JobCustomerAddress | null }) | null;
  technicians: Pick<Technician,'id'|'ref'|'display_name'|'tenant_id'> | null;
};
export async function listAssignmentsWithRefsForTenant(tenantId, fromISO, toISO, statuses): Promise<AssignmentDayRow[]>
  // same filters as listAssignmentsForTenant (:198-205) + the jobs/technicians embed
```
Day view guards job-tenant only (customer surfaced under the tenant-checked job), matching
current behavior (boardRead.ts:105 trusts the customer under a tenant-filtered job) — so the
day customer projection carries NO `tenant_id` (mirrors `listJobsWithCustomerByIds`). If tsc
rejects the two-level embed cast, use `as unknown as AssignmentDetailRow[]` (the one-level
`as` idiom is jobs.ts:133).

Import `Customer` type + `JobCustomerAddress` (from jobs.ts) as needed.

**`src/schedule/boardRead.ts`**
- `readVisitDetail`: replace the `getAssignmentForTenant`→`getJob`→`getCustomer`→
  `getTechnicianById` chain with one `getAssignmentWithRefsForTenant(assignmentId, tenantId)`.
  Keep the guards verbatim in JS against the embedded rows:
  - `if (!row) return null` (unchanged tenant-scoped root)
  - `if (viewerTechnicianId != null && row.technician_id !== viewerTechnicianId) return null`
  - `const job = row.jobs && row.jobs.tenant_id === tenantId ? row.jobs : null`
  - `const customer = job && job.customers && job.customers.tenant_id === tenantId ? job.customers : null`
  - `const technician = row.technicians && row.technicians.tenant_id === tenantId ? row.technicians : null`
  - `jobTitle: job ? job.title : null` (already gated by the job tenant check)
- `readBoardDays`: replace `listAssignmentsForTenant` + `listJobsWithCustomerByIds` +
  `listTeam` with one `listAssignmentsWithRefsForTenant(...)`. Drop the `jobById`/`techById`
  Maps; read `row.jobs?.tenant_id === tenantId ? row.jobs.customers : null` and
  `row.technicians?.tenant_id === tenantId ? row.technicians : null` inline. Keep the
  post-fetch `viewerTechnicianId` filter (:90-93) and the day-clamp (:104).
- Remove now-unused imports (`getAssignmentForTenant`, `getJob`, `getCustomer`,
  `getTechnicianById`, `listJobsWithCustomerByIds`, `listTeam`) if no longer referenced.

### Automated verification
- [x] `npx tsc --noEmit` (0), `npm run lint` (0), `npm test` — **526 passed** (+4 new);
  the 1 failure is the same pre-existing `server.test.ts` seat-replay baseline as Phase A
- [x] **MUTATION-PROVEN**: removing the job/customer tenant check made the new tests fail with
  the other tenant's `jobTitle`, customer name, phone, email and address in the response;
  removing the technician check leaked `technicianRef`/`technicianName`. Guards restored,
  gates re-run green. The tests are real, not decorative.
- [x] **New tests in `boardApi.test.ts`** (or a `boardRead.test.ts`) covering:
  - cross-tenant nested row → `readVisitDetail` returns the visit with `customer: null`,
    `jobTitle: null`; `readBoardDays` stop shows `customer: null`. Build via the raw `pg`
    client: insert an assignment in tenant A whose `job_id` points to a **second tenant's**
    job (bypasses the tenant-scoped `bookVisit`), then assert the null nesting.
  - technician self-view: `t1`'s slip sees only `t1` stops; `t2`'s and the unassigned stop
    are absent (day view) / `readVisitDetail` on `t2`'s visit → 404.
  - 404-uniformity: unknown UUID, other-tenant visit, and unassigned visit for a technician
    viewer all return the identical 404 body.
  - shape-equivalence: the `BoardStop`/`VisitDetail` JSON for the seeded data is byte-identical
    to a snapshot captured before the refactor (guards against embed field drift).

### Live verification (agent-executable)
- Prerequisites: local Supabase stack running; `supabase-test` MCP (schema/EXPLAIN only —
  never the hosted pilot for writes).
- [ ] Run the new embedded select through the client on the LOCAL stack (or `EXPLAIN` the
  equivalent hand-written SQL — you cannot `EXPLAIN` a PostgREST select string); confirm one
  statement returns the joined shape (proves the embed resolves via the FKs).

### Manual verification
- [x] Security review (`rpikit:security-reviewer`) — verdict **REQUEST CHANGES**, 2 findings,
  both fixed:
  - **M1 (confirmed live leak)** `BoardStop.jobId` emitted the raw `row.job_id`, disclosing a
    cross-tenant job's UUID even while customer/technician were withheld. **Pre-existing**
    (identical in the pre-refactor code, `git show HEAD` confirms) — closed here:
    `jobId: job ? row.job_id : null`, type widened to `string | null`. No consumers exist
    (`board.js`/`boardApi.ts` never read it).
  - **M2 (coverage gap)** the technician tenant guard had NO test — mutation showed it could be
    deleted with all tests still green. Added a second hostile fixture (our job + customer,
    THEIR technician) asserting `technicianRef`/`technicianName` null in both reads.
  - **L3 — DONE (user approved hardening, overriding D1's byte-identical rule).** `DAY_SELECT`
    now carries the customer's `tenant_id` and `readBoardDays` re-checks it, matching
    `readVisitDetail`. **Escalated during implementation:** the hostile fixture was created
    through plain `createJob({tenantId, customerId})` — NO raw SQL — because that function takes
    the two ids as independent arguments and validates no relationship between them. So the gap
    was reachable through the normal typed API, not merely via ops/migrations as first assessed.
    Mutation-proven: without the check the day view returned
    `"customer":"SECRET Rival Customer","address":"99 Secret Ave…"` for a job that WAS ours.
- [x] Added a `BoardStop` shape test pinning the full key set + values (guards embed field drift)

---
*Pause after this phase (security review is non-empty).*

**STATUS: Phase B complete (2026-07-22), pending user call on L3. Phases C/D not started.**

## Phase C: P2 — auth roster cache

### What this phase does
Memoize the successful roster lookup per verified Telegram userId for 60s.

### Changes required
**`src/telegram/rosterCache.ts`** (new)
- `Map<string, { value: {tenantId: string; technician: Technician}; expiresAt: number }>`.
- `get(userId, now)` → value if unexpired else `undefined` (lazy-delete on expiry).
- `set(userId, value, now)` → store `expiresAt = now + TTL_MS` (TTL 60_000); if `size > MAX`
  (e.g. 5000) delete the oldest inserted key first (insertion-order Map).
- Export `TTL_MS`, `MAX`, and a `clear()` for tests. Clock passed in (`now`) — no `Date.now`
  inside, so tests are deterministic.

**`src/telegram/boardApi.ts`** — in `authBoard` (:51):
- After `verifyInitData` yields `userId`, check `rosterCache.get(userId, Date.now())`; on hit,
  return `{ ok: true, tenantId, technician }` WITHOUT the DB call.
- On miss, run `findRosterByTelegramUserIdGlobal` as today; on the success branch (:74),
  `rosterCache.set(userId, { tenantId, technician }, Date.now())` before returning. Do NOT
  cache the 401/409 branches.
- `verifyInitData` stays before the cache check (every request).

**`src/telegram/boardApi.test.ts`** (REQUIRED — caught in plan review)
- Import `rosterCache` and add `beforeEach(() => rosterCache.clear())`. The module-level cache
  persists across tests in the file (vitest isolates per-file, not per-test), so without this
  the "two firms → 409" test (:252-268) reuses the SUCCESS cached by an earlier test for
  userId `900000001` and wrongly returns 200. A per-test clear restores independence and does
  not affect the "same user twice → cache path" case (both calls live inside one `test()`).

### Automated verification
- [x] `npx tsc --noEmit` (0), `npm run lint` (0), `npm test` — **533 passed** (+11 vs baseline);
  same 1 pre-existing `server.test.ts` seat-replay failure
- [x] **New `rosterCache.test.ts`** — 6 tests: hit within TTL; expiry at the inclusive boundary
  with lazy eviction; unknown id miss; re-set refreshes expiry; size cap evicts oldest and never
  exceeds MAX_ENTRIES; `clear()` empties
- [x] Existing `boardApi.test.ts` auth tests still pass (401 / 409 / success)
- [x] **MUTATION-PROVEN**: disabling `beforeEach(rosterCache.clear())` made the "two firms → 409"
  test return **200** from a stale cached ALLOW — exactly the blocker the plan review predicted.
  Restored; suite green.

### Manual verification
- [x] Security review (`rpikit:security-reviewer`) — **APPROVE, zero findings**. Confirmed:
  `verifyInitData` runs before the cache on every request so a hit is never an auth bypass and
  cannot extend a stale slip's life; the ambiguous (409) branch is never cached, closing
  multi-tenant key collision; no refresh-on-read, so 60s is the true worst-case staleness;
  cache growth requires a Telegram-signed slip, and the eviction loop is bounded. One
  informational note: a demoted manager keeps manager-tier writes for ≤60s — documented and
  accepted; revisit only if instant revocation becomes a requirement.

**STATUS: Phase C complete (2026-07-22). Phase D not started.**

---
*Pause after this phase (security review is non-empty).*

## Phase D: P6 — index telegram_user_id

### What this phase does
Add the missing index on the auth lookup column.

### Changes required
**`supabase/migrations/<ts>_index_telegram_user_id.sql`** (new; `<ts>` = a timestamp strictly
after the latest existing migration `20260720120000_scheduling_inputs.sql`, e.g.
`20260722120000` — never ≤ `20260720120000` or the apply order drifts)
```sql
create index if not exists idx_technicians_telegram_user_id
  on technicians (telegram_user_id);
```

### Automated verification
- [x] `npx supabase db reset` (LOCAL) applied `20260722120000_index_telegram_user_id.sql` cleanly
- [x] `npm test` — 533 passed against the local stack (index transparent to behavior)
- [x] `npx tsc --noEmit` (0), `npm run lint` (0), `npm run build` (0)
- [x] Index verified present locally:
  `psql -c "select indexname from pg_indexes where tablename='technicians'"` →
  `idx_technicians_telegram_user_id` listed

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP (hosted pilot). **Note: this MCP dropped and reconnected
  mid-session — re-confirm it is live before applying.**
- [x] **Applied to the live pilot** (2026-07-22, user-approved) via MCP `apply_migration`
  as `index_telegram_user_id`. Pre-check confirmed the index was absent; post-check confirmed:
  `CREATE INDEX idx_technicians_telegram_user_id ON public.technicians USING btree (telegram_user_id)`
- [x] **Planner note (expected):** `EXPLAIN` on the pilot still shows a **Seq Scan** — the table
  is 8 rows on one page, so Postgres correctly prefers scanning it. The index changes nothing
  today and starts paying off as the roster grows. Confirms the "future-proofing, not a
  today-win" assessment rather than contradicting it.
- [x] Noted: hosted ledger versions differ from local filenames (hosted `20260720220633
  scheduling_inputs` vs local `20260720120000_scheduling_inputs`) — the known drift that makes
  `db push` unsafe. `apply_migration` was the correct path and adds its own version stamp.

### Manual verification
- none

### Manual verification
- none

---
*No pause — automated + live checks suffice.*

## Follow-up (out of scope)
- **P7 network transit (~180ms/hop).** DB exec is sub-ms and `getClient()` is a reused
  singleton, so the per-hop cost is Render↔Supabase network. Needs the Render service region
  vs the Supabase project region (dashboards) and/or a server-side timing log around a
  PostgREST call to confirm undici keep-alive. Infra, not code — separate ticket.
- **`boardNotify` 30s poller** — constant background DB load seen in the pilot api logs;
  unrelated to UI latency. Flag for a future efficiency pass.
