---
date: 2026-07-14
task: Schedule core on assignments — promise ladder, locks, versioning, manager chat booking tools; retire the Google Sheet + schedule_entries mirror (Plan 1 of the Telegram-schedule series)
research: thoughts/shared/research/2026-07-14-scheduling-mini-app-gap-analysis.md
status: draft
---

## Overview

Make `assignments` the single source of truth for the schedule and retire the Google Sheet
pipeline. After this plan: managers book/move/cancel visits from chat (staged confirm, house
style), every schedule change appends to a versioned event log, entries carry the commitment
ladder (what the customer was told), all readers (`get_schedule`, note identity matching) run
off `assignments`, the pilot's mirror rows are backfilled, and the sheet sync is deleted.

*Length flag: ~405 lines (>300 guideline). The endeavor is already split into a 4-plan series;
the overage here is the verbatim migration SQL and the adversarial-review fixes (3 blockers,
8 gaps — annotated inline where they changed the spec), kept because they remove implementer
ambiguity — same call as the 2026-07-03 foundation plan.*

**The series this opens (supersedes the 2026-07-03 auto-scheduling series Plans 2–5):**
Plan 2 — Telegram Mini App dispatch board (ONE global non-AI board bot, initData auth against
the roster, managers + technicians). Plan 3 — auto-scheduler (window-level fit-check, auto-insert
with pinned promised days, version-pinned day-move questions, later-day fallback). Plan 4 —
weekly freeze ritual + customer window announcements (notification-sender fork: OPEN, decide in
Plan 4's brief).

## Decisions

- **Retire sheet + mirror in THIS plan** (user, 2026-07-14) — backfill then delete the sync;
  interim manager surface is chat until the Mini App lands.
- **`assignments` is the base store** (user; research Decision Point 1, Option A).
- **Ladder = new columns, not an enum rework** — `promise_level enum('none','day','time')` +
  `promised_day date` + `locked boolean` alongside the untouched `assignment_status`; the
  `no_confirmed_overlap` guard keeps firing on `'confirmed'` unchanged. Booking lifecycle
  (proposed/confirmed/cancelled/completed) is orthogonal to what the customer was told.
- **`promised_day` is stored, not derived** — "did the day move?" must survive time edits;
  comparison is date-string level, no timezone math.
- **Versioning = `schedule_events` append-only log**; the version token is the tenant's latest
  event id. No counter column: concurrent-writer safe, doubles as Plan 2's notification feed and
  the audit trail (house style: history = rows).
- **Manual placement ⇒ `locked=true`** on book and move (user decision: manager placements are
  locks the Plan-3 optimizer routes around).
- **`book_visit` defaults `promise_level='day'`** ("quote days, not times" doctrine); manager
  can pass `'time'` or `'none'` explicitly.
- **Manual move carries the promise and recomputes `promised_day`** — the manager IS the
  promise-keeper; the preview warns when a promised day changes. Plan 3 gates *agent-driven*
  moves instead.
- **Availability warns, never blocks** — day-level `isTechnicianAvailableOn` result rides in the
  stage preview; managers may deliberately book outside the pattern. Window-level fit is Plan 3.
- **Schedule times are stored naive-local (local clock time written as if UTC)** — the exact
  convention the sheet mirror already created on the pilot. Keeps every UTC-day reader
  (daySource, identityMatch, `promised_day` slices) correct for evening bookings and needs no
  DST math; availability checks interpret these timestamps with timezone `'UTC'`. Revisit
  trigger: a tenant whose team spans timezones (recorded limitation, review finding #8).
- **Moves re-create the row as `'confirmed'`** — `rescheduleAssignment` defaults new rows to
  `'proposed'`, which every reader filters out (review BLOCKER #1); `RescheduleInput` gains
  `status?` and `moveVisit` passes `'confirmed'`, with an overlap PRE-check (excluding the moved
  row) before the cancel — the residual race still hits the DB guard and is reported as
  "old booking cancelled, re-book failed — visit is UNSCHEDULED, restage".
- **Customer-only bookings mint an open job shell at confirm** — schedule hangs off `jobs`
  (spine model); `createJob(status:'open')` with optional title.
- **Confirm idempotency = consume-first (at-most-once), overlap guard as backstop** — the
  `send_email` idiom: a crash after consume loses the staged booking (manager restages), never
  double-books. Commit-first would re-create on retry and surface a confusing self-overlap.
- **Backfill: future rows only, `promise_level='time'`, `locked=true`** — sheet rows were firm
  commitments with explicit times; past rows are history the mirror table keeps.
- **`schedule_entries` TABLE stays (no drop migration)** — data is historical evidence; only the
  code paths die. `review_items.kind` is `text` (verified), so new staged kinds need no migration.
- **New tools are manager-only** — booking is dispatch authority; technicians keep `get_schedule`.
- **`MatchResult.suggestion.scheduleEntryId` → `assignmentId`** — internal shape rename; both
  consumers updated in the same phase.

## Plain-language walkthrough

**Phase 1 — new shelves.** The bookings table learns three new facts per row: what the customer
was promised (`nothing / a day / a day+time`), which day was promised, and whether a manager
pinned it. A new append-only `schedule_events` list records every change; "version 47" = the
47th event — the Mini App and the "things changed since you looked" checks read this later.

**Phase 2 — the booking verbs.** Plain functions (no AI): book, move, cancel. Book finds or
creates the customer's job, stores "Tuesday 9:00" exactly as the firm's wall-clock time (the
same convention the sheet always used), writes a confirmed booking the database itself refuses
to double-book, and logs an event.

**Phase 3 — the chat tools.** The manager's agent gets four new tools: `get_team_schedule`
(whole team's days, with promise/lock markers + the version number) and staged two-step
`book_visit` / `move_visit` / `cancel_visit` — same one-preview-one-yes pattern as sending email.

```
manager: "book the Hendersons Tue 9–12 with Bob"
   agent → book_visit(stage) → preview {Henderson, Bob, Tue 9–12, promise: day,
                                        warning: none} + confirmId
   manager: "yes" → book_visit(confirmId) → confirmed booking + event #48
```

**Phase 4 — readers switch stores.** `get_schedule` (the technician day-route tool) and the
note-matching "is this the address X?" helper stop reading the sheet mirror and read real
bookings instead. Behavior looks identical from Telegram.

**Phase 5 — backfill and burn the boat.** A script copies the pilot's upcoming mirror rows into
real bookings (matching or creating customers/jobs), then the sheet-sync code is deleted and the
cron stops reading Google. The sheet file survives as a frozen artifact; the database is now the
only schedule.

## Secrets & env preflight

- **Phase 1:** local Supabase stack running (`npx supabase start`, `.env.test`) — already
  required for tests. No new secrets.
- **Phases 2–4:** none new. (`GOOGLE_MAPS_API_KEY` unchanged for `get_schedule`.)
- **Phase 5:** `mcp__supabase-test__apply_migration` (already-connected MCP) for the pilot
  apply; pilot `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in the shell for the backfill script
  (gated by an explicit `--hosted` flag, seed.mjs idiom). After deploy, `SCHEDULE_SHEET_ID` and
  `GOOGLE_APPLICATION_CREDENTIALS` can be removed from the Render cron env; `ROUTE_DAY_SOURCE`
  (if set) from the web service.

## Phase 1: Schema + typed layer

### What this phase does
Adds the promise/lock columns and the event log; extends the DB layer.

### Changes required

**`supabase/migrations/20260714<HHMMSS>_schedule_core_promise_ladder.sql`** (new)
```sql
create type promise_level as enum ('none','day','time');
alter table assignments
  add column promise_level promise_level not null default 'none',
  add column promised_day date,
  add column locked boolean not null default false,
  add constraint promised_day_when_promised
    check (promise_level = 'none' or promised_day is not null);
create table schedule_events (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references tenants(id),
  assignment_id uuid references assignments(id) on delete set null,
  kind          text not null, -- booked|moved|cancelled|completed|backfilled (Plan 2+: promoted…)
  actor_ref     text,          -- roster ref or 'system'
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index idx_schedule_events_tenant on schedule_events(tenant_id, id desc);
```
Apply locally (`npx supabase migration up` or db reset), regenerate
`src/db/database.types.ts` with `npx supabase gen types typescript --local` — **not**
`npm run gen:types`, which uses `--linked` (the pilot, lacking this migration until Phase 5).

**`src/db/assignments.ts`**
- `CreateAssignmentInput` += `promiseLevel?`, `promisedDay?` (YYYY-MM-DD), `locked?`;
  `createAssignment` writes them (defaults `'none'`/null/false).
- `RescheduleInput` += the same three optional fields **plus `status?: AssignmentStatus`**;
  `rescheduleAssignment` writes them onto the created row — promise fields **default to the old
  row's values** (promise carries over a move); `status` keeps its `'proposed'` default so the
  one existing caller contract is unchanged.
- New `getAssignmentForTenant(id, tenantId): Promise<Assignment | null>` (tenant-guarded point
  read; the existing private `getAssignment` stays for internal use).
- New `listAssignmentsForTenant(tenantId, fromISO, toISO, statuses = ['confirmed'])` — overlap
  semantics like `listAssignmentsForTechnician`, tenant-wide, ordered by `starts_at`.

**`src/db/scheduleEvents.ts`** (new) + export from **`src/db/index.ts`**
- `appendScheduleEvent({tenantId, assignmentId?, kind, actorRef?, detail?}): Promise<ScheduleEvent>`
- `latestScheduleVersion(tenantId): Promise<number>` (max id for tenant, 0 if none)
- `listScheduleEventsSince(tenantId, afterId, limit = 100)`

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (42 files, 427 passed / 1 pre-existing skip)
- [x] tests **extended in the existing** `src/db/scheduling.test.ts` (do not recreate the file —
      it carries the foundation suite and truncate discipline): promise columns round-trip;
      check constraint rejects `promise_level='day'` with null `promised_day`; reschedule
      carries promise fields and honors `status:'confirmed'`; events append +
      `latestScheduleVersion` monotonic; `listAssignmentsForTenant` overlap edges

### Live verification (agent-executable)
- Prerequisites: local stack only — none beyond tests this phase.

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 2: Booking operations module

### What this phase does
The deterministic booking verbs the tools (and later the Mini App/optimizer) call.

### Changes required

**`src/schedule/booking.ts`** (new)
- `naiveLocalISO(date: string, hhmm: string): string` = `` `${date}T${hhmm}:00.000Z` `` — the
  naive-local storage convention (Decisions). No timezone conversion module, no DST cases.
- `bookVisit(input: {tenantId, technicianRef, customerId?, jobId?, title?, date, startTime?,
  endTime?, promiseLevel?, actorRef}): Promise<{assignment, job, customer, warning?}>`
  — exactly one of customerId/jobId; tenant-guard both; resolve technician via
  `getTechnician` (reject unknown/inactive refs). `startTime` default `'08:00'`; `endTime`
  default start + `getJobDurationMinutes(tenantId, job.job_type)`. Order matters (review
  finding #10): (1) overlap PRE-check via `listAssignmentsForTechnician` over the day window;
  (2) only then mint the job shell on the customerId path (`createJob({status:'open',
  title})`); (3) `createAssignment(status:'confirmed', promiseLevel ?? 'day', promisedDay:
  date, locked: true)`. If the insert still races into `isOverlapViolation`, best-effort
  cancel the freshly minted shell (advisory) and throw `'…already has a confirmed visit
  overlapping…'` — no orphaned open job polluting `listUnassignedOpenJobs`. Day-level
  availability via `isTechnicianAvailableOn(…, timezone: 'UTC')` (naive timestamps) +
  `listTimeOffForTechnician` → `warning` string (never blocks).
  `appendScheduleEvent(kind:'booked', detail:{date, startTime, endTime, promiseLevel})`.
- `moveVisit({tenantId, assignmentId, date, startTime, endTime?, technicianRef?, reason,
  actorRef})` — `getAssignmentForTenant`; refuse non-live statuses; compute
  `promiseBroken = old.promise_level !== 'none' && old.promised_day !== date`; overlap
  PRE-check for the target window **excluding the moved row itself**; then
  `rescheduleAssignment` with `status:'confirmed'` (BLOCKER-#1 fix — the default `'proposed'`
  row would vanish from every reader and escape the DB guard), `promisedDay: date`,
  `locked: true`, promise carried. If the guarded insert still races: the old row is already
  cancelled — throw `'old booking cancelled but re-booking failed … the visit is UNSCHEDULED —
  restage it'` and append event `'move_failed'`. Success: event `'moved'` with
  `{fromDay, toDay, promiseBroken}`. Returns both rows + `promiseBroken`.
- `cancelVisit({tenantId, assignmentId, reason, actorRef})` — `getAssignmentForTenant` first
  (tenant guard — review finding #9; this module is Plans 2–3's reuse surface), then
  `updateAssignmentStatus(id,'cancelled',reason)` + event `'cancelled'`.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (438 passed / 1 pre-existing skip)
- [x] new tests (`src/schedule/booking.test.ts`): job-shell creation; duration default; overlap
      pre-check → clean error with NO job shell left behind; availability warning on an off-day;
      **moved row lands `status:'confirmed'` and appears in a `['confirmed']`-filtered
      `listAssignmentsForTechnician` read** (BLOCKER-#1 regression test); move carries promise + flags `promiseBroken`; move pre-check excludes
      the moved row (same-slot no-op move succeeds); cross-tenant assignmentId → 'not found'
      for move AND cancel; cancel appends event.

### Live verification (agent-executable)
- Prerequisites: local stack only.

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 3: MCP tools (manager surface)

### What this phase does
Exposes the verbs to the manager's agent, staged like `send_email`.

### Changes required

**`src/mcp/server.ts`**
- `ADMIN_TOOLS` += four entries:
  `get_team_schedule` `{from?, to?}` — team-wide days (14-day cap, firm-local default "today",
  the `get_schedule` validation block reused), each stop `{technicianRef, customer, address,
  start, end, promiseLevel, promisedDay, locked, status, assignmentId}`, plus top-level
  `scheduleVersion` from `latestScheduleVersion`. Joins: `listAssignmentsForTenant` +
  `listJobsWithCustomerByIds` + `listTeam` (technician_id → ref).
  `book_visit` / `move_visit` / `cancel_visit` — two-step: stage call validates args, runs the
  Phase-2 dry checks it can (tenant guards, technician resolution, promise-break computation for
  moves), and stores the staged copy as a review item (`pending_booking` / `pending_visit_move` /
  `pending_visit_cancel`, subjectRef = caller ref, re-stage supersedes, 15-min expiry); response
  = full preview incl. `warning`/`promiseBroken` + confirmId. Confirm call (`confirmId` alone):
  guarded token lookup → **consume-first** (`resolveReviewItem`) → run the Phase-2 verb → on
  verb failure `annotateResolvedReviewItem` (send_email idiom: "confirmed but booking FAILED —
  nothing was booked; restage").
- `resolve_review`: add the three new kinds to the live-token refusal list (resolved → error,
  dismissed = cancel), mirroring `pending_outbound_send`.

**`src/db/reviewItems.ts`** — extend the closed `ReviewKind` union (`reviewItems.ts:10-19`) with
`'pending_booking' | 'pending_visit_move' | 'pending_visit_cancel'` (review BLOCKER #2 — every
staged call typechecks against this union; the DB column is already plain text).
- Booking preview must show: customer name (or "NEW job for <customer>"), technician display
  name, firm-local day/time, promise level in words ("customer will be told: Tuesday"), and any
  availability warning. One confirmation, no permanence lecturing (recorded UX rule).

**`docs/nemoclaw-tech-agent.md` + `docs/doorman-runbook.md`** — tool-count verification strings
(base 13 unchanged; manager tools 8 → 12): update the counts where asserted.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (442 passed / 1 pre-existing skip)
- [x] new tests (`src/mcp/server.test.ts`): tier gate (technician badge → error); stage returns
      preview + warning; confirm books; forged/expired confirmId; consume-first (second confirm
      → "already confirmed"); move preview carries `promiseBroken:true` when day changes;
      `get_team_schedule` returns other technicians' stops + `scheduleVersion`;
      `resolve_review` refuses `resolved` on the three new kinds
- [x] existing manager tools/list count assertions updated: `server.test.ts:1201` and `:1601`
      `toHaveLength(21)` → `25` (review finding #5 — these fail the phase gate otherwise)

### Live verification (agent-executable)
- Prerequisites: none this phase (deploy happens in Phase 5).

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 4: Readers move off the mirror

### What this phase does
`get_schedule` and note identity-matching read `assignments`; the mirror has no remaining
production readers.

### Changes required

**`src/routes/daySource.ts`** — delete the `ROUTE_DAY_SOURCE` flag, the `schedule_entries`
branch, and the `listScheduleForTechnicianInRange` import; keep the assignments implementation
as the only body (confirmed rows; existing UTC-day clamp comment stays).

**`src/writePath/identityMatch.ts`** — replace the `listScheduleForTechnicianOnDate`
consultation: `getTechnician(tenantId, technicianRef)` (null → skip consultation, roster-less
badges lose nothing); `listAssignmentsForTechnician(tech.id, <UTC day window of capturedAt>,
['confirmed'])`; `listJobsWithCustomerByIds` for addresses. `suggestion` becomes
`{address, assignmentId}`; a confirmed-address hit returns `{status:'matched', customerId,
jobId}` straight from the assignment's job. Delete the schedule-sourced `createFrom` branch
(assignments always link a real customer) — but **keep the `ScheduledCustomerDraft` type and
`MatchResult.createFrom` field**: `server.ts:567,604` (`resolutionFrom`/preview) still read
them for the confirmed-address create path.

**`src/mcp/server.ts`** — `StagedNoteDetail.suggestion` type + `needs_identity` echo:
`scheduleEntryId` → `assignmentId`.

**`src/writePath/recordFieldNote.ts`** — the THIRD rename consumer (review BLOCKER #3):
`RecordFieldNoteResult.suggestion` hardcodes `{address, scheduleEntryId}` at
`recordFieldNote.ts:60` and passes `match.suggestion` through at `:170` — update the shape.

**`scripts/seed.mjs`** — moved up from Phase 5 (review finding #6): the schedule-confirm demo
needs a **TODAY-dated confirmed assignment** for the seeded roster technician (the existing
seeded assignment is next-weekday; `matchIdentity` consults the capture's day, which is always
"now" for a staged note). Add it here; leave the `schedule_entries` seeding in place until
Phase 5 removes it (harmless — nothing reads it after this phase).

**Tests** — `daySource.test.ts` (single-source rewrite), `identityMatch.test.ts`,
`recordFieldNote.test.ts`, `server.test.ts`, `email/ingest.test.ts`: seed `assignments`
(+ jobs/customers) instead of `schedule_entries` wherever matching is exercised. Note the new
fixture requirement (finding #6): assignments need a real `technicians` row (UUID FK) — current
fixtures use roster-less refs like `tech-sched-1`; create roster rows (and respect the tenant
seat cap) in those suites.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (439 passed / 1 pre-existing skip)
- [x] `get_schedule` response-shape tests unchanged and green (proves external behavior held)
- [x] identity-match tests prove: single-assignment day → suggestion; confirmed address →
      matched with jobId; no roster row → no consultation

### Live verification (agent-executable)
- Prerequisites: local stack.
- [x] seeded local run: matchIdentity against the seeded TODAY assignment returned
      `{status:'needs_confirmation', suggestion:{address:'99 Ranch Rd', assignmentId:'5b103d0b-…'}}`;
      SQL read-back confirmed the assignment row (confirmed / day-promised / locked, joins to
      Tom Becker) — verification subagent evidence, 2026-07-15

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 5: Backfill, retirement, deploy gate

### What this phase does
Copies upcoming mirror rows into real bookings, deletes the sheet pipeline, ships to the pilot.

### Changes required

**`scripts/backfill-schedule.mjs`** (new; seed.mjs idioms: `--hosted` required to touch the
pilot, `--dry-run` prints without writing)
- For each `schedule_entries` row with `scheduled_start >= today` (UTC): resolve the
  technician — `getTechnician(tenantId, row.technician_ref)`; unknown or inactive ref →
  **report + skip** (loose sheet enforcement guarantees typo'd refs exist on the pilot —
  review finding #7). Resolve customer — `customer_id` link if present, else exact address
  match (`findCustomersByAddress`), else create from the row's denormalized fields; mint an
  open job shell; `createAssignment` status `'confirmed'`, `starts_at` from the row,
  `ends_at` from the row or (when null) start + `getJobDurationMinutes(tenantId, null)`;
  `promise_level='time'`, `promisedDay = scheduled_start.slice(0,10)` (correct for the
  mirror's local-as-UTC rows), `locked=true`; event `'backfilled'` with `{externalRowKey}`.
  Idempotency: skip any row whose `externalRowKey` already appears in a `'backfilled'` event
  for the tenant; overlap violations report + skip (never abort the run).

**Deletions** — `src/schedule/sheetSync.ts` + `sheetSync.test.ts`; `src/schedule/refSuggest.ts`
(+ its test; only caller was sheetSync — re-grep before deleting); `src/db/scheduleEntries.ts`
and its `src/db/index.ts` export. **`googleapis` STAYS in package.json** —
`src/email/ingest.ts:1` imports it for Gmail inbound ingestion (review finding #4).

**`src/jobs/lifecycle.ts`** — remove step 3 (`syncScheduleFromSheet` import, `sheetSync`
summary field, env reads); renumber comments; update `lifecycle.test.ts`.

**`scripts/seed.mjs`** — remove the `schedule_entries` seeding (the today-assignment
replacement already landed in Phase 4). Truncation list keeps `schedule_entries` (table still
exists) + adds `schedule_events`.

**Docs** — `docs/control-plane.md` (cron step list), `docs/nemoclaw-tech-agent.md` §schedule
mentions: sheet is retired, DB owns the schedule.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` / `npm run build` pass (428 passed —
      the deleted sheet-sync suites took their tests with them)
- [x] `npm run seed:local` then the Phase-4 live check still passes (seed reruns clean; the
      TODAY assignment drives the schedule-confirm demo)
- [x] backfill exercised on the LOCAL stack with hand-inserted mirror rows (seed no longer
      writes any — checklist premise updated): dry-run printed the expected bookings incl. an
      unknown-ref skip; real run booked 2 (null-end → 120-min default, time-promised, locked,
      `backfilled` events); re-run no-op (`alreadyDone: 2`); overlap rows skipped via PRE-check
      with ZERO orphan customers/jobs across two runs (review finding #1 fixed and re-proven).
      Known caveat (documented in the script): a crash between createAssignment and its ledger
      event makes the re-run report that row as an overlap skip instead of alreadyDone — no
      double-booking, no orphans; resolve the reported row by hand.

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test__apply_migration` + pilot service-role env for the script;
  Render deploy access; a manager-bound sandbox (Judy's or the demo tenant) for the E2E.
- [ ] migration applied to the pilot (ledger shows the new version)
- [ ] backfill `--hosted --dry-run` output reviewed, then `--hosted` run; evidence: row counts +
      `select count(*) from assignments` / `schedule_events` via `mcp__supabase-test__execute_sql`
- [ ] Render web + cron redeployed; cron summary line no longer contains `sheetSync`
- [ ] E2E via the manager agent: `book_visit` → confirm → `get_team_schedule` shows it with
      `locked:true`, version bumped; the technician's `get_schedule` shows the stop (cross-channel
      read-back: `execute_sql` select of the assignment row as evidence)

### Manual verification
- [ ] Render cron env: `SCHEDULE_SHEET_ID` / `GOOGLE_APPLICATION_CREDENTIALS` removed (dashboard)
- [ ] Manager (pilot) told: the sheet is now frozen/historical; bookings happen in chat —
      confirm the preview wording reads naturally to a non-engineer

---
*Pause after Phase 5 for the manual checks and the pilot-facing communication.*
