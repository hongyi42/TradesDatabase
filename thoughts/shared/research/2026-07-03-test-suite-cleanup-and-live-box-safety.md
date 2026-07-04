---
date: 2026-07-03
branch: main
commit: dfc899d
topic: Test suite — how tests use the shared test database, the TRUNCATE cleanup pattern, and the live-box roster seam it collides with
---

## Summary

The repo has 25 vitest test files. Fourteen are pure unit tests (no database, everything stubbed), three call the live Anthropic model (skipped automatically when no API key is set), and eleven connect to the **live test Supabase project** (`daqapdlkgxfrhquacprv`). The database-backed tests clean up by running `TRUNCATE` — a SQL command that empties an *entire table* in one shot — rather than deleting only the rows they created. That was harmless when the test project held only fake data. But since Plan 2 went live (2026-07-03), the deployed stack — the Render web service, the Render cron heartbeat, and the nemoclaw-box's badge-pull timer (a systemd job on the live box that re-downloads its door-lock file every 5 minutes) — runs off **the same test project**. So running the test suite now empties the real roster out from under the live box: this happened on 2026-07-03 (incident recorded at [thoughts/shared/plans/2026-07-02-control-plane-lifecycle.md:434-442](../plans/2026-07-02-control-plane-lifecycle.md)) — `server.test.ts` truncated `technicians`, the next 5-minute pull shipped an empty `badges.json`, and technician Jane was locked out (HTTP 403) for ~8 minutes. This document maps exactly which tests touch which tables, how each cleans up, and every hop of the collision path, as input to planning the cleanup fix.

## Entry Points

- [vitest.config.ts:1-12](../../../vitest.config.ts) — test runner config. `include: ['src/**/*.test.ts']`, setup file `src/test.setup.ts`, and `fileParallelism: false` (lines 8-10) with an in-code comment: DB-backed files share one live test project, so files run sequentially to keep one file's TRUNCATE from racing another file's in-flight transaction.
- [src/test.setup.ts:1-3](../../../src/test.setup.ts) — the entire setup is `import 'dotenv/config'`: every test inherits `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` from the repo's `.env`.
- `npm test` → `vitest run` ([package.json:9](../../../package.json)). There is **no CI workflow** (`.github/workflows/` does not exist) — tests only ever run locally, always against whatever `.env` points at.
- [scripts/seed.mjs](../../../scripts/seed.mjs) — not a test, but part of the same lifecycle: `npm run seed` truncates the same tables (including the roster) before re-seeding.

## Key Files

### Test infrastructure
| File | Role |
|---|---|
| [vitest.config.ts](../../../vitest.config.ts) | Sequential file execution; setup file wiring |
| [src/test.setup.ts](../../../src/test.setup.ts) | Loads `.env` into every test process |
| [src/synthesis/fixtures.ts](../../../src/synthesis/fixtures.ts) | In-memory fixture builders (`sampleContext()`, `capture()`, …) used by the three synthesis test files — no DB |
| [scripts/seed.mjs](../../../scripts/seed.mjs) | `truncateSpine()` (lines 55-67) truncates `customers, jobs, visits, raw_captures, schedule_entries, dropped_audit, technicians, review_items cascade`, then re-seeds roster + spine data. Guard at lines 35-45: refuses to run unless both `DATABASE_URL` and `SUPABASE_URL` contain the test ref `daqapdlkgxfrhquacprv` |

### The 11 database-backed test files

| File | Tables written | Cleanup (exact statements) |
|---|---|---|
| [src/db/context.test.ts](../../../src/db/context.test.ts) | customers, jobs, visits, raw_captures | `afterAll` line 21: `truncate table schedule_entries, customers, jobs, visits, raw_captures cascade` |
| [src/db/hosts.test.ts](../../../src/db/hosts.test.ts) | hosts | **Row-scoped**: `DELETE FROM hosts WHERE name = $1` in `beforeAll` (line 14) and `afterAll` (line 18) — the one file that deletes exactly what it creates |
| [src/db/schema.test.ts](../../../src/db/schema.test.ts) | none (reads `information_schema`; append-only probe runs in a rolled-back transaction, lines 89-104) | connection close only |
| [src/db/spine.test.ts](../../../src/db/spine.test.ts) | customers, jobs, visits, raw_captures | `afterAll` line 27: `truncate table customers, jobs, visits, raw_captures cascade` |
| [src/db/technicians.test.ts](../../../src/db/technicians.test.ts) | **technicians, review_items** | `truncate table technicians, review_items cascade` in **both** `beforeAll` (line 41) and `afterAll` (line 46); restores seed seat capacity after |
| [src/email/ingest.test.ts](../../../src/email/ingest.test.ts) | raw_captures, dropped_audit, customers, jobs, visits | `afterAll` line 24: `truncate table schedule_entries, customers, jobs, visits, raw_captures, dropped_audit cascade` |
| [src/mcp/httpServer.test.ts](../../../src/mcp/httpServer.test.ts) | hosts, **technicians, review_items** | `truncate table technicians, review_items cascade` in `beforeAll` (line 32) and `afterAll` (line 50); hosts row deleted by name; capacity restored |
| [src/mcp/server.test.ts](../../../src/mcp/server.test.ts) | **technicians, review_items**, schedule_entries, customers, jobs, visits, raw_captures | `beforeAll` line 39: `truncate table technicians, review_items cascade`; `afterAll` line 71: `truncate table schedule_entries, customers, jobs, visits, raw_captures, technicians, review_items cascade`; capacity restored (line 74). **This is the file that caused the 2026-07-03 outage** |
| [src/schedule/sheetSync.test.ts](../../../src/schedule/sheetSync.test.ts) | schedule_entries, review_items (+ spine rows via matches) | `afterAll` line 48: `truncate table schedule_entries, customers, jobs, visits, raw_captures, review_items cascade` |
| [src/writePath/identityMatch.test.ts](../../../src/writePath/identityMatch.test.ts) | customers, schedule_entries (+ spine) | `afterAll` line 30: `truncate table schedule_entries, customers, jobs, visits, raw_captures cascade` |
| [src/writePath/recordFieldNote.test.ts](../../../src/writePath/recordFieldNote.test.ts) | raw_captures, customers, jobs, visits | `afterAll` line 23: `truncate table schedule_entries, customers, jobs, visits, raw_captures cascade` |

All eleven open a **direct Postgres connection** (`new Client({ connectionString: process.env.DATABASE_URL })` from the `pg` package) alongside the supabase-js client, because cleanup and schema inspection need raw SQL that PostgREST can't do. `tenants` and `hosts` are never truncated by any test.

### The 14 non-database test files

Pure unit tests with all seams injected (no DB, no network): [src/composio/offboarding.test.ts](../../../src/composio/offboarding.test.ts), [src/composio/pairing.test.ts](../../../src/composio/pairing.test.ts), [src/control/badgeFile.test.ts](../../../src/control/badgeFile.test.ts), [src/db/droppedAudit.test.ts](../../../src/db/droppedAudit.test.ts), [src/email/classify.test.ts](../../../src/email/classify.test.ts)*, [src/inbound/normalize.test.ts](../../../src/inbound/normalize.test.ts), [src/inbound/webhook.test.ts](../../../src/inbound/webhook.test.ts) (613 lines — the largest suite, fully stubbed), [src/jobs/lifecycle.test.ts](../../../src/jobs/lifecycle.test.ts), [src/mcp/identity.test.ts](../../../src/mcp/identity.test.ts), [src/sanity.test.ts](../../../src/sanity.test.ts), [src/schedule/refSuggest.test.ts](../../../src/schedule/refSuggest.test.ts), [src/synthesis/answerQuestion.test.ts](../../../src/synthesis/answerQuestion.test.ts)*, [src/synthesis/briefCustomer.test.ts](../../../src/synthesis/briefCustomer.test.ts)*, [src/synthesis/grounding.test.ts](../../../src/synthesis/grounding.test.ts).

\* The three starred files call the live Anthropic model (claude-sonnet-4-6) and are gated with `describe.skipIf(!process.env.ANTHROPIC_API_KEY)` so they skip rather than fail when no key is present. They touch no database.

One env-hygiene detail worth knowing: [src/jobs/lifecycle.test.ts:12-17](../../../src/jobs/lifecycle.test.ts#L12-L17) clears `SCHEDULE_SHEET_ID`/`DEFAULT_TENANT_ID` **before each** test, because `.env` legitimately carries them and an un-cleared value would route an un-injected code path to the live Google Sheets reader.

### The live-box seam (what the truncation collides with)

| File | Role |
|---|---|
| [src/db/client.ts:9-17](../../../src/db/client.ts#L9-L17) | The single cached supabase-js client. Reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. **No test-vs-prod guard anywhere in application code** — the environment distinction lives entirely in `.env` |
| [src/db/technicians.ts:65-73](../../../src/db/technicians.ts#L65-L73) | `listTechniciansForHost(hostId)` — the roster query the badge endpoint serves from |
| [src/control/badgeFile.ts:33-79](../../../src/control/badgeFile.ts#L33-L79) | `buildBadgeResponse(hostId)` — builds the verbatim `badges.json` content. With zero roster rows it returns `{ badgesFile: {}, newBadges: [] }` — an empty-but-valid response |
| [Box_Setup_Stuff/badge-pull.sh](../../../Box_Setup_Stuff/badge-pull.sh) | Runs as root on the box, systemd timer `OnCalendar=*:0/5` (every 5 minutes). Line 56 fails closed on *malformed* responses (`jq -eS '.badgesFile'`), but an empty `{}` is well-formed — lines 63-73 atomically replace `/etc/doorman/badges.json` with it. There is **no guard against a 0-entry file replacing a non-empty one** |
| [scripts/assign-host.mjs:34-39](../../../scripts/assign-host.mjs#L34-L39) | Operator script; has the same test-ref guard as seed.mjs |
| [docs/control-plane.md](../../../docs/control-plane.md) | Operational model for badges/hosts |

## Data Flows

### How a test run reaches the live box's door lock

```
npm test (local machine, .env → test project daqapdlkgxfrhquacprv)
   │
   ▼
server.test.ts beforeAll/afterAll
   "truncate table technicians, review_items cascade"     ← roster now EMPTY
   │
   │  (same Supabase project — no isolation)
   ▼
Render web service  GET /control/badges  (host pull token auth)
   └─ buildBadgeResponse() → listTechniciansForHost() → 0 rows
      → { badgesFile: {}, newBadges: [] }                 ← valid, empty
   │
   ▼  within ≤5 minutes
nemoclaw-box  badge-pull.sh (systemd timer, */5)
   └─ jq -e '.badgesFile' → {} passes the shape check
      → atomically overwrites /etc/doorman/badges.json with {}
   │
   ▼
doorman: every badge lookup misses → HTTP 403 for every technician
   (observed 2026-07-03: Jane locked out ~8 min, 07:35Z–07:43Z)
```

The incident, recovery, and agreed follow-ups are recorded verbatim in [thoughts/shared/plans/2026-07-02-control-plane-lifecycle.md:434-442](../plans/2026-07-02-control-plane-lifecycle.md): recovery was stop the box timer → re-insert roster rows with the exact preserved `badge_hash` fingerprints → manual pull produced a byte-identical file (`newBadges: 0`, no credential churn) → restart timer. The two recorded follow-ups: (1) scope test cleanup to created rows or move tests to a branch database — until then no test runs against this project without stopping the box timer; (2) `badge-pull.sh` should refuse a 0-entry file when the current file is non-empty.

### The standard DB-backed test lifecycle

```
beforeAll:  pg.connect() ──► load seed tenant ──► (roster files: TRUNCATE to claim
            (DATABASE_URL)   (by name 'Default    empty roster + set known seat caps)
                              Tenant', or limit(1)
                              in older files)
tests:      write real rows via the src/db layer (supabase-js) ─► read back,
            sometimes cross-channel via direct pg (spine.test.ts:68-72)
afterAll:   TRUNCATE <every table the module could have touched> CASCADE
            ─► restore seed seat capacity (roster files) ─► pg.end()
```

Two generations of tenant lookup coexist: newer files ([technicians.test.ts:29-36](../../../src/db/technicians.test.ts#L29-L36), [server.test.ts:24-30](../../../src/mcp/server.test.ts#L24-L30), [sheetSync.test.ts:35-42](../../../src/schedule/sheetSync.test.ts#L35-L42), [httpServer.test.ts:24-28](../../../src/mcp/httpServer.test.ts#L24-L28)) look the tenant up **by name** (`'Default Tenant'`) so a leftover tenant from a crashed run can't be picked silently; older files (context, spine, ingest, identityMatch, recordFieldNote) still use `limit(1)`.

## External Dependencies

- **Supabase test project** `daqapdlkgxfrhquacprv` — reached two ways from tests: supabase-js (`@supabase/supabase-js`, PostgREST) and direct Postgres (`pg` package via `DATABASE_URL`). This same project backs the deployed Render web service, Render cron, and the box's badge pull.
- **Anthropic API** (`@anthropic-ai/sdk`) — three live-model test files, key-gated, skip cleanly.
- **Composio, Google Sheets, Gmail** — never called live from tests; all stubbed (webhook HMAC verification uses a locally-set secret env var).
- **vitest 4** test runner; no CI service.

## Constraints and Invariants

1. **`raw_captures` cannot be row-deleted — by design.** The append-only trigger ([supabase/migrations/20260620005307_context_spine.sql:116-119](../../../supabase/migrations/20260620005307_context_spine.sql), function `raise_append_only()` at lines 24-32) blocks UPDATE and DELETE at the row level. `TRUNCATE` is table-level DDL and does not fire row-level triggers — which is exactly why the tests use it (stated in [spine.test.ts:23-26](../../../src/db/spine.test.ts#L23-L26)). **Consequence: "delete only the rows you created" is impossible for `raw_captures` under the current trigger.** Any row-scoped cleanup design has to either exempt a test path from the trigger, keep truncating that one table, or move tests to a disposable database. ([schema.test.ts:89-104](../../../src/db/schema.test.ts#L89-L104) sidesteps this by testing the trigger inside a rolled-back transaction.)
2. **Several tests assert against a *claimed-empty* table, not just their own rows.** [technicians.test.ts:39-43](../../../src/db/technicians.test.ts#L39-L43) truncates in `beforeAll` because the seat-cap trigger counts *all* active technicians — seeded roster rows would shift every capacity assertion. [server.test.ts:33-40](../../../src/mcp/server.test.ts#L33-L40) does the same to build a known roster (2 manager seats / 3 technician seats, specific rows in specific states). These tests' correctness currently *depends on* emptying shared tables, not merely their cleanup convenience.
3. **No environment guard exists at the application or test layer.** Only the operator scripts (`seed.mjs`, `assign-host.mjs`) check for the test project ref. Tests will run against whatever `DATABASE_URL`/`SUPABASE_URL` say — nothing in the test code verifies it is pointing at the test project (prod safety currently rests on `.env` contents and the prod project being configured read-only).
4. **`fileParallelism: false` is load-bearing** ([vitest.config.ts:8-10](../../../vitest.config.ts#L8-L10)): with a shared live database, parallel test files would truncate each other's in-flight rows.
5. **Seat-capacity restoration is manual bookkeeping**: files that change tenant seat caps restore the seed values (2 managers / 5 technicians) in `afterAll` ([server.test.ts:73-74](../../../src/mcp/server.test.ts#L73-L74), [technicians.test.ts:48-49](../../../src/db/technicians.test.ts#L48-L49), [httpServer.test.ts:52](../../../src/mcp/httpServer.test.ts#L52)) — a crashed run leaves altered caps behind.
6. **A crashed run leaves tables empty, not restored.** Cleanup is `afterAll` truncation; nothing re-seeds. After any DB-backed test run (successful or crashed), the test project's roster and spine tables are empty until `npm run seed` — and the live stack reads them in that state.
7. **`hosts` and `tenants` are the survivors**: no test truncates them; `hosts.test.ts` deletes its own rows by name and says why in its header comment (lines 6-8: hosts are "infrastructure rows (not spine data — seed's truncate leaves them alone)").
8. **`npm run seed` is as dangerous to the roster as the tests**: `truncateSpine()` ([scripts/seed.mjs:55-67](../../../scripts/seed.mjs#L55-L67)) truncates `technicians` and `review_items` too, then re-seeds roster rows — but re-seeded rows have **no `badge_hash`**, so a pull after seed re-mints badges (credential churn on the box) rather than restoring the previous fingerprints.
9. **The box fails closed on malformed responses but open on empty ones**: `badge-pull.sh` line 56 rejects non-JSON/missing-field bodies, and the 30s curl cap means a cold Render start fails the tick harmlessly (header comment, lines 38-41) — but an empty `badgesFile` object is treated as a legitimate roster state.

## Decision Points

These are the forks the current code creates for the upcoming cleanup work, stated factually:

1. **Where should database-backed tests run?** Three shapes exist in the current landscape: (a) keep sharing the test project and re-scope cleanup — but constraints 1 and 2 mean truncation can't simply become row-deletes (the `raw_captures` trigger blocks DELETE, and roster tests assert against claimed-empty tables); (b) a disposable database per run — Supabase has a branching feature (the MCP tools `create_branch`/`delete_branch` are already connected for both projects), which would make TRUNCATE harmless but adds branch lifecycle management and depends on plan availability; (c) a second, dedicated test-only Supabase project, which separates "what the deployed stack reads" from "what tests wipe" while keeping the suite unchanged — the split would be environment-level (.env / secrets), since app code has no environment awareness (constraint 3).
2. **Does the deployed stack stay on a project tests can reach at all?** The root of the collision is that Render + the box read the *test* project. Any cleanup fix that leaves them co-resident keeps some blast-radius; moving the deployed stack (or the tests) to different infrastructure removes the class of failure rather than the instance. This is an infrastructure decision, not a code one — nothing in the repo pins the deployed stack to this project except its environment configuration.
3. **The box-side guard.** The recorded follow-up (2) — `badge-pull.sh` refusing a 0-entry file when the current file is non-empty — is independent of the test-suite fix and lives on the box, not in this repo's deploy path ([Box_Setup_Stuff/badge-pull.sh](../../../Box_Setup_Stuff/badge-pull.sh) is the operator's copy; per the Box_Setup_Stuff sync rule, changes there pair with `docs/nemoclaw-tech-agent.md`). A deliberate full-roster wipe would then need a manual override path, which is a behavior choice.
4. **What "self-clean" means for tests that need empty tables.** If roster tests must keep asserting against a known-empty roster (constraint 2), that requirement itself forces isolation (option b/c in point 1) or test rewrites that tolerate pre-existing rows (e.g. asserting deltas instead of absolutes). The `hosts.test.ts` pattern (create-by-unique-name, delete-by-name) is the in-repo example of row-scoped hygiene, but it works because hosts assertions don't depend on table-wide state.
5. **Whether `npm run seed` needs the same treatment.** Seed truncates the roster and re-seeds it *without* badge hashes (constraint 8), so even after the test suite is fixed, a routine re-seed would still churn the box's credentials. Whether seed keeps its current "wipe everything including roster" scope or splits spine-seeding from roster-seeding is a separate, smaller decision.

## Open Questions

1. **Is Supabase branching available on this project's plan?** The MCP branch tools are wired up, but branching is a paid/plan-gated Supabase feature; whether `create_branch` succeeds on the test project needs a live check (and per CLAUDE.md, current vendor docs — not repo memory — for pricing/mechanics).
2. **What exactly does the Render cron heartbeat write?** The lifecycle job (pairing sweep, grace expiry, sheet sync every 15 min) also runs against this project; whether a mid-test-run heartbeat tick can *write* rows that collide with test assertions (the inverse of the truncation problem) isn't determinable from reading alone — it depends on live sheet content and pairing states.
3. **Timing exposure window**: `server.test.ts` truncates in `beforeAll` and restores nothing until its `afterAll` truncate — the roster is empty for the entire file run (~15 live DB round-trips, 30s timeouts on three tests). Whether other DB-backed files leave comparable windows during their run (vs only after) matters for "stop the timer" runbooks and can only be measured by running.
4. **Whether any deployed component reads `dropped_audit`, `schedule_entries`, or spine tables in a user-visible way** the way the box reads `technicians` — i.e., are there other truncate-to-outage paths beyond the roster? The Render web service serves the MCP gateway from these tables; who queries it live and when is an operational question, not a code one.
