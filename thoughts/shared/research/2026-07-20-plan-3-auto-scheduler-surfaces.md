---
date: 2026-07-20
branch: board-sheet-animation
commit: 46e95c2
topic: Plan 3 of the Telegram-schedule series (the auto-scheduler) — every surface it would build on, as the code stands after Plans 1–2 + seat-exempt + board UX shipped
---

## Summary

Plan 3 is the auto-scheduler: the series definition (recorded in the Plan-1 plan,
[2026-07-14-schedule-core-on-assignments.md](../plans/2026-07-14-schedule-core-on-assignments.md#L21-L26))
scopes it as "window-level fit-check, auto-insert with pinned promised days, version-pinned
day-move questions, later-day fallback." In plain terms: today a manager places every visit by
hand (chat or board drag); Plan 3 is the software placing visits itself — checking whether a job
*fits* into a technician's day (working hours + existing visits + drive time), inserting it and
*telling* people rather than asking, and asking exactly one question (pinned to a schedule
version number so a stale answer is detectable) only when the insertion would move a day a
customer was promised. This document maps what exists for that work. The short version: the
**write path is fully built and shared** (the `booking.ts` verbs, the promise ladder, the lock
flag, the event log/version feed, and Telegram pushes all exist and are live on the pilot), but
the **decision inputs are empty shells** — the availability calculator is day-level only, the
duration table and availability setters have *zero* production callers and *zero* rows on the
pilot, no chat tool can populate them, and no code anywhere computes "does this job fit into
this gap" or "what would this insertion cost in drive time."

## Entry Points

- [src/mcp/server.ts:581](../../src/mcp/server.ts#L581) — `get_team_schedule` tool definition
  (handler at [src/mcp/server.ts:2247](../../src/mcp/server.ts#L2247)): the manager's whole-team
  read, 14-day cap, `unassignedOnly` recall view, returns `scheduleVersion`.
- [src/mcp/server.ts:611](../../src/mcp/server.ts#L611) / [:647](../../src/mcp/server.ts#L647) /
  [:674](../../src/mcp/server.ts#L674) — `book_visit` / `move_visit` / `cancel_visit` tool
  definitions; handlers at [:2356](../../src/mcp/server.ts#L2356),
  [:2559](../../src/mcp/server.ts#L2559), [:2723](../../src/mcp/server.ts#L2723).
- [src/schedule/booking.ts](../../src/schedule/booking.ts) — the deterministic verbs every
  surface calls; its header names the auto-scheduler as an intended caller: "The MCP tools
  (Phase 3), the Mini App (Plan 2), and the auto-scheduler (Plan 3) all call THESE"
  ([booking.ts:1-6](../../src/schedule/booking.ts#L1-L6)).
- [src/telegram/boardApi.ts:234](../../src/telegram/boardApi.ts#L234) — the board's
  manager-only write path (`POST /board/api/move` / `/cancel`), same verbs, preview-then-commit.
- [src/telegram/boardWorker.ts](../../src/telegram/boardWorker.ts) — long-lived Render worker
  polling `schedule_events` every 30s and pushing Telegram notifications
  ([boardNotify.ts:130](../../src/telegram/boardNotify.ts#L130) `pollOnce`).
- [src/mcp/server.ts:1411](../../src/mcp/server.ts#L1411) — `get_schedule` handler (technician
  self-view): the only current consumer of Google drive-time
  (`optimizeStopOrder` per day, concurrent).
- [src/mcp/server.ts:213](../../src/mcp/server.ts#L213) / [:1304](../../src/mcp/server.ts#L1304)
  — `resolve_date`: model picks structured fields, server does calendar math with its own clock.

## Key Files

**Booking core (the write path Plan 3 reuses):**
- [src/schedule/booking.ts](../../src/schedule/booking.ts) — `bookVisit`/`moveVisit`/`cancelVisit`
  + `previewBookVisit`/`previewMoveVisit`/`previewCancelVisit`; shared resolution front-half so
  preview == commit; `bookingRequiresConfirmation(promiseLevel)` = the single-sourced
  confirmation doctrine ([:141-143](../../src/schedule/booking.ts#L141-L143));
  `naiveLocalISO(date, hhmm)` = the storage convention; overlap PRE-check + DB guard backstop;
  availability *warning* (never blocks, [:74-93](../../src/schedule/booking.ts#L74-L93));
  move stranding path (cancel-first → `move_failed` event + "UNSCHEDULED" error,
  [:501-527](../../src/schedule/booking.ts#L501-L527)).
- [src/db/assignments.ts](../../src/db/assignments.ts) — row types + `PromiseLevel`; hardcoded
  status machine ([:12-17](../../src/db/assignments.ts#L12-L17)); `createAssignment` (SQLSTATE
  preserved for `isOverlapViolation`, 23P01); `rescheduleAssignment` = cancel + insert, not
  atomic ([:141-171](../../src/db/assignments.ts#L141-L171)); `listAssignmentsForTenant`
  (confirmed default) / `listAssignmentsForTechnician` (proposed+confirmed default — "what
  claims or may claim time"); `listUnassignedAssignments` (confirmed, technician NULL — "Plan
  3's future work queue" per its own comment [:242-246](../../src/db/assignments.ts#L242-L246));
  `listUnassignedOpenJobs` (open jobs with NO live assignment — "the scheduler's work queue"
  [:263-266](../../src/db/assignments.ts#L263-L266)).

**Decision inputs (all present, all unwired):**
- [src/schedule/availability.ts](../../src/schedule/availability.ts) — pure day-level calculator
  `isTechnicianAvailableOn`; header: "window-level fit within a day is Plan 3"; null/malformed
  pattern → fail closed (unschedulable); `localDateISO`/`localDayOfWeek` (Intl-based).
- [src/db/technicians.ts:332-417](../../src/db/technicians.ts#L332-L417) — `WeeklyPattern` type
  (7 required keys, `[["HH:MM","HH:MM"], …]` windows, `24:00` end allowed, overnight = two
  windows across two days), `setTechnicianAvailability` (validates hard — "the scheduler trusts
  stored patterns without re-validating"), `setTechnicianServiceCities` (lowercased; comment:
  "the Plan-3 scoring match is case-insensitive"). **No MCP tool calls either setter.**
- [src/db/timeOff.ts](../../src/db/timeOff.ts) — whole-day ranges; `addTimeOff`/`deleteTimeOff`/
  `listTimeOffForTechnician` (overlap semantics). **No MCP tool calls the writers.**
- [src/db/jobTypeDurations.ts](../../src/db/jobTypeDurations.ts) — `getJobDurationMinutes`
  (normalized `job_type` row, else `tenants.default_job_minutes`, migration default 120);
  `upsertJobTypeDuration`. **Zero production callers for both** — the read lost its only caller
  when server-side endTime defaults were removed (user decision 2026-07-18; both times are now
  required on `book_visit`).

**Version feed + notifications (the "inform, never ask" delivery channel):**
- [src/db/scheduleEvents.ts](../../src/db/scheduleEvents.ts) — append-only log;
  `latestScheduleVersion(tenantId)` = max event id (0 if none; per-tenant monotonic — "pin a
  question / detect changed-since-I-looked" is a named intended use,
  [:36-39](../../src/db/scheduleEvents.ts#L36-L39)); `listScheduleEventsSince`.
  Kinds written today: `booked`, `moved`, `move_failed`, `cancelled` (booking.ts),
  `backfilled` (backfill script). `completed` is reserved with no writer.
- [src/telegram/boardNotify.ts](../../src/telegram/boardNotify.ts) — event → canned push copy
  for exactly those four kinds ("completed/backfilled and future kinds: no push",
  [:121](../../src/telegram/boardNotify.ts#L121)); skips unassigned rows and inactive
  technicians; reassignment notifies both sides via `detail.previousAssignmentId`.
- [src/telegram/boardWorker.ts](../../src/telegram/boardWorker.ts) — 30s poll loop
  (`BOARD_POLL_MS`), **in-memory cursor**: a restart re-seeds at current version, so events
  during downtime never push (documented v1 trade).

**Drive time (what exists vs what Plan 3 needs):**
- [src/routes/googleRoutes.ts](../../src/routes/googleRoutes.ts) — `optimizeStopOrder`: Google
  Routes API `computeRoutes` with `optimizeWaypointOrder`; free-text addresses; 25-waypoint cap;
  <3 stops = no API call and `totalMinutes: null`; response validated as a true permutation.
  Header: "Fleet assignment (which tech gets which job) is deliberately NOT here — that's the
  Plan-3 fork." Billing: Compute Routes Pro SKU per call (5k free/month noted in-file).
- [src/routes/daySource.ts](../../src/routes/daySource.ts) — `listDayStops`: confirmed
  assignments → per-UTC-day stop lists (sheet-mirror source fully retired).
- [src/routes/deepLink.ts](../../src/routes/deepLink.ts) — `formatAddress` (null when
  `address_line1` missing = unroutable) + Maps deep link (10-stop URL cap).
- **No geocoding anywhere** — customers carry free-text address parts only; no lat/lng column.

**Reads (staleness detection surfaces):**
- [src/schedule/boardRead.ts](../../src/schedule/boardRead.ts) — `readBoardDays` (board day
  view; version read BEFORE snapshot, fail-safe ordering) + `readVisitDetail`.
- `get_team_schedule` handler ([server.ts:2247-2355](../../src/mcp/server.ts#L2247-L2355)) —
  same shape for chat; `boardNote` decoration seam at
  [server.ts:3505-3525](../../src/mcp/server.ts#L3505-L3525) (one seam, committed results only).

**Date math:** [src/schedule/dateResolve.ts](../../src/schedule/dateResolve.ts) — deterministic
`resolveDate` (weekday+weeksAhead / dayShift / explicitDate, exactly one mode; server-supplied
"today").

**Schema:** [supabase/migrations/20260704210155_scheduling_foundation.sql](../../supabase/migrations/20260704210155_scheduling_foundation.sql)
(assignments + `no_confirmed_overlap` btree_gist exclusion on
`(technician_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE status='confirmed'`;
availability/service_cities columns; time-off; durations; tenant timezone + default 120 min),
[20260714120000_schedule_core_promise_ladder.sql](../../supabase/migrations/20260714120000_schedule_core_promise_ladder.sql)
(promise_level/promised_day/locked + schedule_events),
[20260717120000_technician_optional_bookings.sql](../../supabase/migrations/20260717120000_technician_optional_bookings.sql)
(technician_id nullable; NULL rows exempt from the exclusion guard),
[20260719120000_seat_exempt_roster.sql](../../supabase/migrations/20260719120000_seat_exempt_roster.sql)
(seat-exempt schedulable people).

## Data Flows

**1. Manual placement today (chat), the path auto-insert would join:**

```
manager chat → agent → book_visit(args)
  promiseLevel 'none' (default) ──────────────► ONE-SHOT: bookVisit() → row + event
  promiseLevel 'day'/'time' ──► needs_confirmation + staged review_item (15-min expiry,
                                consume-first) ──"yes"──► bookVisit() → row + event
row: status 'confirmed', locked TRUE, promise fields; naive-local timestamps
event: schedule_events kind 'booked' → version bumps
  ├─► boardWorker poll (≤30s) → Telegram push to the technician ("New visit on your schedule…")
  └─► every schedule tool result gains boardNote → "[See it on the board](…)" link
```

**2. Board write path (same verbs, in-UI confirm):** drag → `POST /board/api/move?preview=1` →
`previewMoveVisit` → `requiresConfirmation` (= `promiseBroken`) branches the UI (one-shot vs
dialog) → `POST /board/api/move` → `moveVisit` ([boardApi.ts:228-321](../../src/telegram/boardApi.ts#L228-L321)).

**3. Promise-break computation** ([booking.ts:418-428](../../src/schedule/booking.ts#L418-L428)):
`'day'` promise breaks only when the *day* changes; `'time'` promise breaks when the day OR the
start time changes; `'none'` never. `promised_day` is stored, compared as a date string.

**4. Version pinning surfaces:** every schedule read (`get_team_schedule`, `readBoardDays`)
returns `scheduleVersion` read *before* the snapshot; `listScheduleEventsSince(tenantId,
afterId)` answers "what changed since N". Nothing today *stores* a version to compare later —
the two halves of a version-pinned question exist, the pin itself does not.

**5. Drive time today** (per-technician, ex-post): `get_schedule` → `listDayStops` →
`optimizeStopOrder(routable)` per day (concurrent) → ordered stops + `driveMinutes` + Maps
link. It orders stops *already booked*; nothing computes the marginal drive cost of a
*candidate* insertion, and nothing runs it across technicians.

**6. Duration intent** (dormant): jobs carry `job_type` only via the field-note extractor
([src/writePath/extract.ts](../../src/writePath/extract.ts)); `bookVisit`'s job-shell mint
passes `title` but **no `job_type`** ([booking.ts:293-300](../../src/schedule/booking.ts#L293-L300)),
so chat-minted jobs are untyped and `getJobDurationMinutes` would return the tenant default.

## External Dependencies

- **Google Routes API `computeRoutes`** (`GOOGLE_MAPS_API_KEY`) — the only live drive-time
  source; per-call billing, 25-waypoint cap, pinned first/last stop.
- **Google Route Optimization API** — *not integrated*; the fleet-level buy option surveyed in
  [2026-07-04-third-party-automated-scheduling-software.md](2026-07-04-third-party-automated-scheduling-software.md)
  (strongest constraint model; ~$30/1k shipments Enterprise SKU for 2+ vehicles; pricing as of
  2026-07-04 — re-verify per the CLAUDE.md live-docs rule before deciding).
- **OptimoRoute / Routific** — surveyed third-party optimizers (same doc; OptimoRoute was the
  2026-07-04 recommendation, ~$35-49/driver/mo, weekly planning tier-gated). None integrated;
  Composio catalog had none of them (custom-tool path would bypass per-person sessions — tier
  enforcement would fall to our gateway, noted in that doc's architecture note).
- **Telegram Bot API** (board bot on Render) — push channel via `sendBoardMessage`; one-way
  (no reply path exists on the board bot; it is deliberately non-AI).
- **Supabase/PostgREST** via `src/db/` only.

## Constraints and Invariants

- **Fail-closed availability**: `availability` NULL or malformed → `isTechnicianAvailableOn`
  returns false. Manual booking only *warns* on this; an auto-scheduler that respects the rule
  literally sees a pattern-less person as unschedulable. On the pilot **today that is everyone**
  (see pilot-state note below). Seat-exempt people (e.g. the live "Hman" row) are schedulable
  manually but pattern-less, hence invisible to a fail-closed Plan-3 pass.
- **Pilot data state (read-back 2026-07-20, hosted pilot DB):** technicians with availability:
  **0** (3 active technicians, all NULL); `job_type_durations` rows: **0**; time-off rows:
  **0**; future confirmed assignments: 3 (1 of them unassigned); jobs with `job_type`: 3;
  open jobs: 10; one tenant with assignments. The fit-check's entire input side is empty, and
  **no Telegram-reachable tool can populate any of it** (setters exist only in `src/db/`).
- **Every manual placement writes `locked=true`** — both chat verbs and both board verbs, book
  AND move ([booking.ts:316](../../src/schedule/booking.ts#L316),
  [:499](../../src/schedule/booking.ts#L499)). Locked was defined as "manual manager placement —
  Plan-3 optimizer routes around it" ([assignments.ts:31](../../src/db/assignments.ts#L31)).
  Consequence: as of today **every confirmed row on the pilot is locked**; until auto-inserted
  rows (presumably unlocked) exist, "route around locks" means "fill gaps only, reshuffle
  nothing."
- **Naive-local time**: wall-clock stored as if UTC; availability checks pass timezone `'UTC'`;
  UTC-day slicing (`starts_at.slice(0,10)`) is the day-bucketing idiom everywhere; pattern
  windows are firm-local wall clock — so window-level fit math is pure HH:MM string/minute
  arithmetic against stored times, no timezone conversion needed.
- **The DB overlap guard is confirmed-only and per-technician**; NULL technician rows never
  collide (code-level identical-duplicate refusal for unassigned bookings instead,
  [booking.ts:200-222](../../src/schedule/booking.ts#L200-L222)); `proposed` rows may overlap
  by design (alternative proposals — unused since Plan 1 but structurally available to a
  scheduler that wants to stage candidates).
- **Move is cancel + insert, not atomic**: a failed re-insert leaves the visit UNSCHEDULED with
  a `move_failed` event and an honest error. An auto-scheduler that moves things inherits this
  stranding mode and its notification copy (already handled in boardNotify).
- **Confirmation doctrine is single-sourced** in `bookingRequiresConfirmation` + the previews'
  `requiresConfirmation` field; book/cancel gate on promise existence, move gates on
  `promiseBroken`. Note the asymmetry against Plan 3's stated doctrine ("ask only when a
  promised DAY moves"): the code's `promiseBroken` for a `'time'`-promise also fires on a
  same-day time change. Reusing `promiseBroken` as auto-insert's ask-gate is stricter than the
  series wording; day-only gating would need a different predicate.
- **Confirm-token machinery** (review_items): per-kind + per-subjectRef staging, re-stage
  supersedes, 15-min expiry, consume-first commit, `stagedAt` in detail. A "version-pinned
  question" fits this shape (stage detail could carry `scheduleVersion`) but no existing kind
  stores one.
- **Event kinds are push-gated**: boardNotify only has copy for `booked`/`moved`/`cancelled`/
  `move_failed`. A new kind (e.g. an auto-inserted booking) produces **no push** until copy is
  added; reusing `booked` with `actor_ref:'system'` would push with today's copy.
- **The worker's cursor is in-memory** — restarts skip downtime events. Acceptable for
  drip-rate manual changes; a batch auto-scheduling pass creates event bursts whose loss
  windows are correspondingly larger.
- **Model-instruction reality** (recorded lesson, boardNote at
  [server.ts:3519-3524](../../src/mcp/server.ts#L3519-L3524)): tool-description-only wording
  is too weak for the live GLM model — behavioral contracts must ride IN results (instruction
  fused with payload). Any Plan-3 flow that needs the agent to relay a question verbatim has
  this precedent to follow.
- **14-day cap** on windowed schedule reads; `unassignedOnly` recall view is unbounded.
- **`get_schedule` is self-only; `get_team_schedule` is manager-only** (removed from manager
  duplicate-read confusion by PR #54; booking verbs are manager-only, enforced by tool tier).
- **Two distinct "needs scheduling" queues** exist: `listUnassignedOpenJobs` (open jobs, no
  live assignment — no tool or UI surfaces it today) and `listUnassignedAssignments`
  (confirmed calendar rows with nobody attached — surfaced via `unassignedOnly`).
- **`resolve_date` division of labour**: model extracts structured fields, server owns "today"
  and the arithmetic. (Recorded backlog item, not in code: the Sunday "next week" boundary
  quirk.)

## Decision Points

Factual forks the current code creates for Plan 3 (no recommendations):

1. **Empty inputs vs input verbs.** The fit-check's three inputs (weekly patterns, per-type
   durations, time off) have validated DB setters but zero tools, zero production callers, and
   zero pilot rows. Plan 3 either ships manager chat verbs to populate them (new MCP tools
   wrapping `setTechnicianAvailability` / `upsertJobTypeDuration` / `addTimeOff`), or the
   scheduler must define behavior over missing data (fail-closed = nobody schedulable today;
   any softer default contradicts the recorded fail-closed rule in availability.ts).
2. **Drive-time engine: reuse, buy, or defer.** Options given what exists: (a) repeated
   `computeRoutes` calls per candidate slot (works with free-text addresses; N billed Pro-SKU
   calls per fit-check; 25-stop cap; pinned endpoints); (b) Google Route Optimization API
   (fleet-level solve, not integrated, per-shipment billing, all state ours); (c) a third-party
   optimizer (OptimoRoute per the 2026-07-04 survey; needs a custom-tool/gateway path and
   re-verified pricing); (d) v1 without drive time (hours-plus-existing-visits fit only —
   nothing in the recorded series definition mandates drive time in the first cut). No
   geocoding exists in any option's substrate.
3. **Where the scheduler runs and is invoked from.** The Telegram-only doctrine requires a
   Telegram-reachable surface. Candidates the code supports: a manager-agent MCP tool
   ("schedule this job" → one synchronous fit-and-insert), a background batch pass (the
   boardWorker process pattern), or both over one shared module (the booking.ts precedent).
4. **The ask-gate predicate.** Reuse `promiseBroken` (asks on same-day time changes of
   time-promises too) vs a day-only predicate matching the series wording ("version-pinned
   day-move questions"). Both are one-line computations over existing columns; they differ in
   which auto-moves need a human.
5. **The question channel and its pin.** The version-pinned question needs a reply path.
   Existing machinery: staged review_items through the manager's agent (two-way, expiry,
   supersede semantics — but agent-mediated wording) vs the board bot (push exists,
   no reply path today) vs board UI dialog (exists for drag-moves, but only fires when the
   manager is looking). `scheduleVersion` + `listScheduleEventsSince` provide the staleness
   check; storing the pinned version in the staged detail is new but shape-compatible.
6. **What auto-inserts write.** Kind (`booked` + `actor_ref:'system'` inherits pushes and
   board-link decoration; a new kind is silent until boardNotify learns it), lock state
   (locked=false preserves "optimizer routes around manual placements" but means the first
   unlocked rows ever), and promise level (auto-inserts presumably 'none' under the
   record-only-real-promises rule — which also makes them one-shot under the existing
   confirmation doctrine).
7. **Which queue feeds it.** Unassigned *visits* (calendar rows, `listUnassignedAssignments`)
   vs unscheduled *jobs* (`listUnassignedOpenJobs`, currently surfaced nowhere) vs a new
   "schedule this" verb taking a job/customer directly. The two existing queues have different
   shapes (timed rows vs untimed jobs) and different emptiness on the pilot (1 vs 10).
8. **Duration for untyped jobs.** Chat-minted job shells carry no `job_type`, so
   `getJobDurationMinutes` falls to the tenant-wide 120-minute default for most real jobs.
   Forks: booking verbs learn a jobType arg; a set-duration/classify step; or accept the
   default as the fit-check's estimate.

## Open Questions

- Is `GOOGLE_MAPS_API_KEY` set on the Render web service (does the pilot's `get_schedule`
  return real `driveMinutes` or `optimizeFailed` fallbacks)? Determines whether option 2(a)
  is already exercised in production.
- Will the pilot manager actually maintain weekly patterns/durations via chat once verbs
  exist (adoption question — the fail-closed rule makes the whole feature inert if not)?
- Do the 3 active pilot technicians include the seat-exempt row (pattern-less by
  construction), i.e. how many *seated* people would the scheduler actually plan for?
- Is the boardWorker's restart-drops-events limitation acceptable once an auto-scheduler
  emits event bursts, or does Plan 3 force the persistent-cursor upgrade the worker comment
  defers?
- Third-party optimizer pricing/capability claims are as of 2026-07-04 — the CLAUDE.md
  external-services rule requires re-verification against live vendor docs at plan time.
- The `proposed` status tier (overlap-legal alternative proposals) has been unused since
  Plan 1 — whether Plan 3's staging wants it or the review_items pattern instead is a design
  choice with no current code pressure either way.
