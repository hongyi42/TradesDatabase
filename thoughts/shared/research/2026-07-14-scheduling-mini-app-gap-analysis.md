---
date: 2026-07-14
branch: feature-cd-followups
commit: 368dbda
topic: Scheduling flow today vs the Telegram Mini App dispatch board — inventory of the two shipped scheduling PRs and gap map for the S_1/S_2/S_3 commitment-ladder design
---

## Summary

Scheduling in this codebase today is two shipped pieces sitting side by side. **Piece one** (the
"scheduling foundation", Plan 1 of a five-plan series) is pure data groundwork: tables for
technician working hours, time off, service cities, per-job-type durations, the firm's timezone,
and an `assignments` booking table with a database-enforced double-booking guard — but **nothing
writes to `assignments` yet**; it has DB helper functions and no live caller. **Piece two** (the
day-route tool) is a read-only MCP tool, `get_schedule`, that answers "what's my day/week": it
reads the schedule, asks Google for the best driving order, and returns a tappable Google Maps
link. The schedule it reads is, by default, **`schedule_entries` — a one-way mirror of the
manager's Google Sheet**, refreshed every 15 minutes by the Render cron. There is no scheduler
core (no fit-check, no insertion, no booking flow), no commitment/promise status, no schedule
version, no lock concept, no sheet write-back, no customer-notification path, and no web UI
surface of any kind — the Render web service is a bare Node HTTP server that speaks MCP,
webhooks, and host endpoints only. The Mini App design decided in conversation (2026-07-13/14)
would therefore consume mostly pieces that do not exist yet; this document maps exactly what is
present, how it flows, and where the forks are.

## Entry Points

- [src/mcp/server.ts:239](../../src/mcp/server.ts#L239) — `get_schedule` tool definition (the
  only scheduling-facing MCP tool); dispatch case at
  [src/mcp/server.ts:1066](../../src/mcp/server.ts#L1066).
- [src/jobs/lifecycle.ts:105-118](../../src/jobs/lifecycle.ts#L105-L118) — cron step 3: the
  sheet→DB mirror sync (`syncScheduleFromSheet`), gated on `SCHEDULE_SHEET_ID` +
  `DEFAULT_TENANT_ID` env (single-tenant interim, recorded limitation).
- [src/mcp/httpServer.ts:224-268](../../src/mcp/httpServer.ts#L224-L268) — the Render web
  service's entire routing table: `/inbound/*` (Composio webhooks), `GET /control/badges`,
  `POST /control/sandboxes`, `/composio*` (doorman relay), and an MCP fallthrough for
  everything else. **No browser-facing route, no static hosting, no CORS handling exists.**
- [src/writePath/identityMatch.ts:66-107](../../src/writePath/identityMatch.ts#L66-L107) — the
  second consumer of the schedule: note identity matching consults the technician's
  schedule-for-today to propose "is this the address: X?".

## Key Files

**Schema (migrations):**
- [supabase/migrations/20260620013000_schedule_entries.sql](../../supabase/migrations/20260620013000_schedule_entries.sql)
  — `schedule_entries`: the Google-Sheet mirror. One row per sheet row, idempotent on
  `(tenant_id, external_row_key)` where the row key is the **1-based sheet row number**.
  Columns are denormalized sheet text (customer_name, address parts, phone, start/end) with
  nullable `customer_id`/`job_id` links ("write-back of resolved ids deferred") and an
  `attributes` JSONB.
- [supabase/migrations/20260704210155_scheduling_foundation.sql](../../supabase/migrations/20260704210155_scheduling_foundation.sql)
  — Plan 1: `tenants.timezone` + `tenants.default_job_minutes`; `technicians.availability`
  (JSONB weekly pattern) + `technicians.service_cities`; `technician_time_off` (whole days);
  `job_type_durations`; `assignments` with enum `assignment_status`
  (`proposed|confirmed|cancelled|completed`) and the `no_confirmed_overlap` btree_gist
  exclusion constraint (no two **confirmed** assignments may overlap per technician;
  `proposed` rows may overlap deliberately — alternative proposals).
  **Applied to the pilot DB** as ledger version `20260707064740` (verified via
  `mcp__supabase-test__list_migrations` on 2026-07-14; the file predates the re-apply, matching
  the plan's DB-state note).

**Schedule modules:**
- [src/schedule/sheetSync.ts](../../src/schedule/sheetSync.ts) — `syncScheduleFromSheet`:
  Google Sheets API read (range `A1:Z10000`, header-substring column detection:
  technician/customer/address/city/state/postal/phone/start/end) → `upsertScheduleEntry` per
  row. Loose ref enforcement: an unknown technician ref still upserts but opens a
  `sheet_ref_mismatch` review item with a did-you-mean suggestion.
- [src/schedule/availability.ts](../../src/schedule/availability.ts) — pure calculator:
  `isTechnicianAvailableOn(timestamp, pattern, timeOff, timezone)`. **Day-level only** — the
  header comment says "window-level fit within a day is Plan 3". Fail-closed: `null` pattern
  or malformed JSONB → unschedulable.
- [src/schedule/refSuggest.ts](../../src/schedule/refSuggest.ts) — Levenshtein ≤2 closest-ref
  suggester for sheet typos (no suggestion on ties).

**Route modules (the day-route PR):**
- [src/routes/daySource.ts](../../src/routes/daySource.ts) — `listDayStops`: one reader, two
  sources behind the `ROUTE_DAY_SOURCE` env flag — `schedule_entries` (default, "the pilot's
  real schedule today. Retires with Plan 5") or `assignments` (confirmed rows only, joined to
  jobs→customers for addresses). Grouping is by **UTC calendar day** in both modes (documented
  v1 simplification).
- [src/routes/googleRoutes.ts](../../src/routes/googleRoutes.ts) — `optimizeStopOrder`: Google
  Routes API `computeRoutes` with `optimizeWaypointOrder`. Free-text addresses; 25-waypoint API
  cap; <3 stops short-circuits (no API call, `totalMinutes: null`); response validated as a true
  permutation. Comment: "Fleet assignment (which tech gets which job) is deliberately NOT here —
  that's the Plan-3 fork."
- [src/routes/deepLink.ts](../../src/routes/deepLink.ts) — `buildMapsDeepLink` (pure string
  assembly, 10-stop Maps URL cap, `linkTruncated` flag) and `formatAddress` (null when
  `address_line1` missing → stop is unroutable but stays visible).

**DB layer:**
- [src/db/scheduleEntries.ts](../../src/db/scheduleEntries.ts) — upsert + two readers
  (`listScheduleForTechnicianInRange`, `listScheduleForTechnicianOnDate`), both UTC-day based.
- [src/db/assignments.ts](../../src/db/assignments.ts) — the DB-owned booking layer:
  `createAssignment`, `updateAssignmentStatus` (hardcoded transition table; CAS-guarded on the
  read state), `rescheduleAssignment` (**cancel + insert — times on a row are immutable**;
  documented non-atomicity accepted), `isOverlapViolation` (SQLSTATE 23P01),
  `listAssignmentsForTechnician` (overlap semantics), `listAssignmentsForJob` (history = the
  rows), `listUnassignedOpenJobs` ("the scheduler's work queue" — open jobs with no live
  assignment). **No production code calls the write functions** — only tests and the seed.
- [src/db/technicians.ts:245-330](../../src/db/technicians.ts#L245-L330) — `WeeklyPattern`
  type + validation (HH:MM windows, `24:00` end allowed), `setTechnicianAvailability`,
  `setTechnicianServiceCities` (normalized lowercase). **No MCP tool exposes these setters** —
  a manager cannot set availability/time-off/durations from chat today.
- [src/db/timeOff.ts](../../src/db/timeOff.ts), [src/db/jobTypeDurations.ts](../../src/db/jobTypeDurations.ts),
  [src/db/tenants.ts](../../src/db/tenants.ts) — typed helpers (same no-tool-surface status).

**Server/auth seam (what a Mini App would touch):**
- [src/mcp/httpServer.ts](../../src/mcp/httpServer.ts) — stateless per-request MCP server;
  three auth models coexist: gateway HMAC identity headers (MCP + relay), Composio webhook HMAC
  (Standard Webhooks/Svix scheme), host bearer-token fingerprint (badge pull / sandbox report).
  Optional `ALLOWED_CLIENT_IPS` allowlist gates only the MCP/relay paths.
- [src/mcp/identity.ts](../../src/mcp/identity.ts) — `resolveIdentityFromHeaders`: HMAC-SHA256
  over `"<tenantId>.<technicianRef>"` with `GATEWAY_IDENTITY_SECRET`. No timestamp/nonce.
  Comment marks this one function as the future Option-B (JWT) swap point. **No Telegram
  initData verification exists anywhere in the repo.**
- [src/mcp/server.ts](../../src/mcp/server.ts) — 13 base tools + 8 manager tools. The staged
  two-step confirm machinery (review_items rows as confirm tokens: `pending_field_note`,
  `pending_outbound_send`, `pending_retraction`, `pending_standing_fact`,
  `pending_deactivation`; 15-minute expiry; staged-copy-is-the-record; commit-first/consume-
  second idempotency via `externalId` stamps) is the codebase's existing analog of the
  conversation's "version-pinned question" concept, and `record_standing_fact`'s `guardedMerge`
  ([src/mcp/server.ts:1717-1748](../../src/mcp/server.ts#L1717-L1748)) is an existing
  preview==commit CAS pattern (drift → `conflict`, never clobber).

**Related but distinct:** `visits.scheduled_at` exists on the spine's `visits` table
([context_spine migration line 80](../../supabase/migrations/20260620005307_context_spine.sql#L80))
but visits are trip records minted by field notes — the Plan-1 decision explicitly rejected
them as the schedule store.

## Data Flows

**1. Manager's sheet → `schedule_entries` mirror (every 15 min, one-way):**

```
manager edits Google Sheet
        │  (no notification to us; no edit capture; no Apps Script anywhere)
        ▼
Render cron (*/15) step 3 ── googleSheetReader (Sheets API, readonly scope,
        │                     ADC via GOOGLE_APPLICATION_CREDENTIALS)
        ▼
rows[] {rowKey = sheet row number, technicianRef, customer/address text, start/end}
        ▼
upsertScheduleEntry per row — idempotent on (tenant_id, external_row_key)
        │
        └─ unknown technicianRef → sheet_ref_mismatch review item (+ closestRef suggestion)
```

Deletion behavior worth noting: a row deleted from the sheet is **not** deleted from the
mirror (the sync only upserts what it reads; a vanished sheet row simply stops being updated).
Renumbering (inserting a row mid-sheet) shifts every subsequent `rowKey`, which rewrites those
mirror rows in place under different keys.

**2. `get_schedule` read path (technician asks "what's my week"):**

```
badge → doorman → HMAC headers → httpServer → dispatch('get_schedule')
   identity = badge only: a caller can ONLY fetch their own days (no arg for "whose")
        │  from/to validated (YYYY-MM-DD, ≤14 days; default = today in tenants.timezone)
        ▼
listDayStops(tenant, ref, from, to)          ROUTE_DAY_SOURCE env flag
        ├─ 'schedule_entries' (default): listScheduleForTechnicianInRange → UTC-day groups
        └─ 'assignments': getTechnician → listAssignmentsForTechnician(confirmed)
                          → listJobsWithCustomerByIds → UTC-day groups
        ▼
per day (concurrent): optimizeStopOrder(routable stops) — Google computeRoutes
        │   <3 stops: no API call; failure: scheduled order + optimizeFailed:true
        ▼
buildMapsDeepLink(ordered) → {date, stops, unroutableStops?, driveMinutes, mapsUrl, linkTruncated}
```

**3. Schedule-assisted note identity matching:** `matchIdentity` calls
`listScheduleForTechnicianOnDate` for the capture's day; exactly one scheduled entry with an
address → `needs_confirmation` with `suggestion: {address, scheduleEntryId}`; a confirmed
address matching a scheduled entry prefills the new-customer draft from the entry's
denormalized fields ([identityMatch.ts:66-107](../../src/writePath/identityMatch.ts#L66-L107)).

**4. `assignments` lifecycle (DB layer only — no live writer, no reader in default config):**

```
proposed ──confirm──► confirmed ──complete──► completed
   │                      │
   └──cancel──► cancelled◄┘   (reason stamped; reschedule = cancel + fresh proposed row;
                               history = the accumulated rows; DB exclusion constraint
                               rejects overlapping CONFIRMED rows per technician)
```

**5. What does NOT flow anywhere today** (verified absences, each checked against the tool
registry, the HTTP routing table, and the migrations list):
- No fit-check / insertion / booking endpoint or tool (nothing computes "does X_N fit").
- No commitment status beyond `assignment_status` (no day-promised vs time-promised
  distinction on any table; `schedule_entries` has no status column at all).
- No schedule version counter anywhere in the schema.
- No lock concept (nothing marks an entry "manager-pinned").
- No write-back to the Google Sheet (readonly OAuth scope; Plan 5 is the recorded future home:
  "recurring-job generation + sheet write-back push").
- No sheet edit capture (no Apps Script, no onEdit webhook route).
- No cross-person schedule read for managers (get_schedule is self-only; no tool lists another
  person's day).
- No manager tools to set availability / time off / durations (DB helpers exist unexposed).
- No customer-notification path (the only outbound is `send_email` from a person's own paired
  mailbox, human-confirmed per send; no system sender for "your window is Tuesday 9–11").
- No web/browser surface: no static hosting, no CORS, no session/cookie handling, no Telegram
  initData verification, no bot token on Render (bot tokens live on the box, per sandbox).

## External Dependencies

- **Google Sheets API** (`googleapis`) — readonly scope, Application Default Credentials
  (`GOOGLE_APPLICATION_CREDENTIALS`); cron-only.
- **Google Routes API** `computeRoutes` — `GOOGLE_MAPS_API_KEY` env; billed Compute Routes Pro
  SKU (5k free calls/month per the plan's cited doc); 25-waypoint hard cap; waypoint-order
  optimization pins first/last stop (recorded known limitation: pinned endpoints cost real
  minutes vs true optimum — "Plan 3 inherits this explicitly").
- **Google Maps URL scheme** — 9 waypoints + destination per deep link.
- **Supabase** (Postgres + PostgREST via supabase-js) — all access through `src/db/`.
- **MCP SDK** (`@modelcontextprotocol/sdk`) — stdio + streamable HTTP transports.
- **Telegram** — only indirectly, through NemoClaw/OpenClaw sandboxes on the box; this repo has
  no Telegram Bot API dependency.

## Constraints and Invariants

- **Two parallel schedule stores with opposite ownership.** `schedule_entries` is
  sheet-owned (mirror; keyed by sheet row number; "the sheet is the manager's ground truth" —
  sync comment) and is the pilot's live data. `assignments` is DB-owned by design ("DB owns the
  schedule" — Plan 1 decision) and is empty of production writers. The Plan-1 decision
  explicitly forbids scheduler writes into `schedule_entries` ("writing scheduler rows there
  collides with sync semantics").
- **Assignment times are immutable per row** — reschedule = cancel + insert; audit history is
  the rows themselves. Any Mini App drag-to-move lands on this primitive if `assignments` is
  the store.
- **Double-booking is blocked structurally** (exclusion constraint), but only for `confirmed`
  rows — `proposed` overlaps are a feature (alternative proposals).
- **Availability is day-granular.** The pure calculator answers "available on this local day",
  not "does a 3-hour job fit between 1pm and 5pm" — window-level fit is explicitly deferred to
  Plan 3. A fit-check as designed in conversation (hours + drive time within a day) has no
  existing computation to call.
- **UTC-day bucketing** in both `schedule_entries` readers and `daySource` grouping, vs
  firm-local-day defaults in `get_schedule`'s "today" — a coexisting, documented v1
  inconsistency (tenant timezone fixes are "new code only").
- **Identity is boundary-established, never argument-supplied** — every tool acts as the badge
  identity; `get_schedule` has no "whose schedule" parameter by design. The HMAC identity
  signature has no timestamp/nonce (never expires); the doorman/badge layer is what makes it
  revocable.
- **The confirm-token pattern is the house style for human gates**: staged copy persisted in
  `review_items`, 15-min expiry, guarded token lookup (id + tenant + kind + subject), commit-
  first/consume-second (or consume-first for at-most-once sends), CAS on the validated state.
  `resolve_review` refuses to "resolve" live tokens ([server.ts:2313-2348](../../src/mcp/server.ts#L2313-L2348)).
- **Sheet sync is single-tenant** (`SCHEDULE_SHEET_ID` + `DEFAULT_TENANT_ID` env on the cron;
  recorded interim limitation).
- **The Telegram-only-surface principle is recorded product doctrine** (memory
  `telegram-only-surface`; the day-route plan's delivery decision lists "mini-app deferred").
  A Mini App is a hosted web front end — the conversation (2026-07-14) treats this as a
  deliberate, decided scope change; no repo doc records that decision yet.
- **Repo state caveat:** the working tree is on branch `feature-cd-followups` (Feature C+D
  standing-facts follow-ups, PR #37 merged to main plus two unmerged commits), not `main`;
  untracked GLM-swap research/plan files from 2026-07-13 are present. The pilot DB's migration
  ledger ends at `web_requests` (2026-07-13) — no scheduling changes are pending in it.

## Decision Points

Choice points the current code creates for the Mini App scheduling work, stated factually:

1. **Which store the Mini App schedule lives in.** Option A: build on `assignments` (designed
   for DB ownership, applied on the pilot, has the double-booking guard and reschedule
   primitive; but every booking requires a `jobs` row — and today's sheet-mirror rows carry no
   job links, so real pilot data doesn't reach it). Option B: extend `schedule_entries` (has
   the live data; but it is sheet-row-keyed, status-less, and the recorded plan retires it).
   The `ROUTE_DAY_SOURCE` flag in `daySource.ts` already models this fork for reads.
2. **Where the commitment ladder (proposed → day_promised → time_promised → done) lives.**
   The existing `assignment_status` enum has four states with a hardcoded transition table and
   a DB constraint keyed on `'confirmed'`; extending the enum, adding a separate
   commitment column, or adding a new table are all schema migrations against the live pilot
   DB, and each interacts differently with the `no_confirmed_overlap` guard's WHERE clause.
3. **How day-level promises coexist with timestamped rows.** `assignments.starts_at/ends_at`
   are NOT NULL timestamps; `schedule_entries.scheduled_start/end` are nullable text-derived
   timestamps. A "day promised, time internal" entry needs either a convention (times present
   but marked non-promised) or schema support (nullable/derived times) — the current shapes
   force that choice.
4. **Where the Mini App is served and how its routes join the server.** The Render web service
   is a bare `node:http` server whose MCP handler serves **every unrouted path**
   ([httpServer.ts:249-260](../../src/mcp/httpServer.ts#L249-L260)); any new browser-facing
   routes (static assets, JSON API, initData verification) must be added before that
   fallthrough, or live in a separate service. No framework, CORS, or session machinery exists
   to inherit.
5. **Which bot token signs the Mini App launch.** Telegram initData verification requires the
   launching bot's token server-side. Today Render holds no bot token — the per-person NemoClaw
   bots' tokens live on the box. The fork: verify against the existing per-person bots' tokens
   (tokens must reach Render) vs a new dedicated schedule-board bot whose token Render owns
   (the conversation's Tier-2 board sketch already assumed a Render-owned board bot).
   `technicians.telegram_user_id` (text, compared-only) exists for mapping a verified Telegram
   user to a roster row and tier.
6. **Manager cross-person reads.** `get_schedule` is structurally self-only. A dispatch board
   needs all-technicians-per-day reads that no tool or endpoint provides; the fork is new MCP
   tool(s) (agent-reachable, consistent with the Telegram-only doctrine) vs Mini-App-only REST
   endpoints (browser-reachable, new auth path) vs both over shared query functions.
7. **The sheet's future direction.** Current sync is one-way sheet→DB with a readonly OAuth
   scope, single-tenant, cron-timed (≤15-min staleness). The conversation design flips the
   sheet to a display/terminal (DB-owned truth, API write-back, human edits captured via Apps
   Script onEdit — verified: API writes don't fire those triggers). Plan 5 ("sheet write-back
   push") is the series' recorded slot for this; nothing of it exists, and the write-back
   requires a scope change plus a decision about the mirror's row-number keying (system-written
   rows have no sheet row number until written).
8. **Optimizer scope for the fit-check.** `optimizeStopOrder` orders one technician's one day
   (25-stop cap, pinned endpoints, no fleet assignment). The conversation's fit-check
   ("which days/techs can absorb X_N, at what marginal drive cost") implies either N
   repeated computeRoutes calls per candidate day (billing: Pro SKU per call) or the Route
   Optimization API — the build-vs-buy question the day-route plan parked "with Plan 3".
9. **Customer notification for the freeze ritual.** The only sender today is person-mailbox
   `send_email` (human-confirmed per send, captured to L1). A freeze that "announces windows"
   to many customers needs either agent-driven sends through that gate, a new system-sender
   path (no precedent in the repo), or an out-of-scope channel.

## Open Questions

- Is the pilot's sheet sync actually live — is `SCHEDULE_SHEET_ID` (and
  `GOOGLE_APPLICATION_CREDENTIALS`) set on the Render cron? The code path skips cleanly when
  unset, and the cron summary would show `{skipped}`; not determinable from the repo.
- Is `GOOGLE_MAPS_API_KEY` set on the Render web service (i.e., does `get_schedule` currently
  return optimized orders or `optimizeFailed` fallbacks in the pilot)?
- What is `ROUTE_DAY_SOURCE` on Render (default `schedule_entries` presumed, but unverifiable
  from code)?
- Does the pilot `assignments` table contain any rows (seed/demo or otherwise)?
- Does OpenClaw/NemoClaw expose Telegram inline keyboards or `web_app` launch buttons for its
  bots (vendor capability, flagged unverified in conversation; nothing in this repo answers it)?
- Whether `schedule_entries` rows on the pilot ever carry `customer_id`/`job_id` links in
  practice (the write-back that would populate them is "deferred to a later phase" per the
  sheetSync comment) — affects how much real data could migrate into `assignments`.
- The branch situation: work is mid-flight on `feature-cd-followups` (2 commits ahead of the
  PR-37 merge) — which baseline the scheduling plan should target.
