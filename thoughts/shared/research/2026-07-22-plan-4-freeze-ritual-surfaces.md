---
date: 2026-07-22
branch: main
commit: e42a201
topic: Plan 4 of the Telegram-schedule series (the freeze ritual — whole-day/week solve of the loose far-out bucket, customer window announcements, confirm-the-night-before automation) — every surface it would build on, as the code stands after Plans 1, 2, 3a, 3b shipped
---

## Summary

Plan 4 is the last chapter of the Telegram-schedule series. Its recorded definition
([2026-07-14-schedule-core-on-assignments.md](../plans/2026-07-14-schedule-core-on-assignments.md#L24-L26)):
"weekly freeze ritual + customer window announcements (notification-sender fork: OPEN, decide
in Plan 4's brief)", elaborated by the toolset research
([2026-07-20-flexible-scheduling-agent-toolset.md](2026-07-20-flexible-scheduling-agent-toolset.md#L171-L174))
as: an **ROI-API whole-day/week solve of the loose far-out bucket** (ROI = Google's Route
Optimization API, a "vehicle routing problem" solver that assigns and orders many visits across
many technicians at once — as opposed to `find_slots`, which measures one insertion at a time),
**customer window announcements** (telling each customer their arrival window once the plan
firms up), and **confirm-the-night-before automation** (contacting tomorrow's customers the
evening before). The continuous auto-reshuffle mode (ServiceTitan Dispatch Pro style) is
recorded out of scope. This document maps what exists for that work. The short version: the
**write path, promise ladder, event feed, and one-visit measuring tape are all live**
(booking verbs, `set_promise`, `schedule_events` versioning, `find_slots` + bounded
`computeRoutes` deltas), but the three things Plan 4 is actually made of are all absent: **no
fleet-level optimizer integration exists** (no ROI client, no geocoding, no third-party
optimizer), **no path can message a customer** except a human-confirmed one-at-a-time
`send_email` — and on the pilot only 1 of 9 customers even has an email address — and **no
scheduled job runs at a "ritual" cadence** (the only cron is a 15-minute lifecycle sweep; the
only worker is the 30-second board-notify poll). One more structural fact shapes everything:
every manual placement writes `locked=true`, so today **100% of the pilot's booked visits are
locked** — the "loose far-out bucket" as data is currently 5 unscheduled open jobs + 1
unassigned visit, not a pool of movable bookings.

## Entry Points

- [src/schedule/booking.ts:1-6](../../src/schedule/booking.ts#L1-L6) — the deterministic verbs
  every scheduler surface calls (`bookVisit`/`moveVisit`/`cancelVisit` + previews); a batch
  freeze commit would execute through these (the reflow_day precedent in the toolset research).
- [src/schedule/fit.ts:320](../../src/schedule/fit.ts#L320) — `assembleFitContext`: the
  existing one-read assembly of patterns + time off + day stops per technician (the exact
  input set a whole-plan solver also needs, minus geocoding).
- [src/mcp/server.ts:4024](../../src/mcp/server.ts#L4024) — `find_slots` handler: the
  per-insertion measuring core Plan 3b shipped; its recorded split
  ([plan 3b Decisions](../plans/2026-07-20-plan-3b-find-slots.md#L36-L38)): "the Routes client
  is the gap-fill measuring tape; whole-plan optimization (ROI API) is Plan 4's freeze."
- [src/jobs/lifecycle.ts:44](../../src/jobs/lifecycle.ts#L44) — `runLifecycle`: the ONE
  scheduled entrypoint (Render Cron Job, `*/15 * * * *`); any time-triggered ritual/night-before
  sweep either joins this pattern or adds a second scheduled entrypoint.
- [src/telegram/boardWorker.ts:13](../../src/telegram/boardWorker.ts#L13) — the only
  long-lived background process (30 s `schedule_events` poll → Telegram pushes to TEAM members
  only, never customers).
- [src/mcp/server.ts:1853](../../src/mcp/server.ts#L1853) — `send_email` handler: the only
  customer-reaching sender in the codebase (two-step human confirm, at-most-once, per send).

## Key Files

**The solve's input side (all live):**
- [src/schedule/fit.ts](../../src/schedule/fit.ts) — pure gap math (`freeGaps`, `dayWindows`),
  density-mode candidate generation + scoring (weights at :163-171), `clampRowToDay` (:294,
  instant-comparison trap already solved), `assembleFitContext` (:320 — patterns, time off,
  visits/cities/stops per tech-day, skills three-state), `findDisplacementCandidates` (:411),
  `measureDriveDeltas` (:497, top-5 cap, day-level cache, new-stop-as-intermediate rule),
  `weekdayLabel` (:69 — every emitted date carries a server-computed weekday; the agent must
  never do calendar math).
- [src/db/assignments.ts](../../src/db/assignments.ts) — status machine (:14-19,
  proposed/confirmed/cancelled/completed; times immutable, reschedule = cancel+insert :143);
  `updateAssignmentPromise` (:201, CAS promise editor behind `set_promise`);
  `listUnassignedAssignments` (:389 — "Plan 3's future work queue", pilot count: 1);
  `listUnassignedOpenJobs` (:408 — "the scheduler's work queue", pilot count: 5); the embedded
  board reads (:249-350) with the tenant-recheck security note. Stale comment worth knowing:
  :141-142 says a crash-stranded booking is "visible in Plan 4's proposal queue" — that
  references the *superseded 2026-07-03 series'* Plan 4, not this one; no proposal queue exists.
- [src/db/technicians.ts](../../src/db/technicians.ts) — `WeeklyPattern` (:332), setters (all
  Telegram-reachable since Plan 3a), `telegram_user_id` (board push address),
  `listTenantIdsWithTelegramBindings` (:96).
- [src/db/timeOff.ts](../../src/db/timeOff.ts), [src/db/jobTypeDurations.ts](../../src/db/jobTypeDurations.ts)
  — whole-day time off; `findJobTypeDurationMinutes` (null when unconfigured — duration is
  fail-closed, never 120, user decision 2026-07-20).

**The write path + confirmation envelope (all live):**
- [src/schedule/booking.ts](../../src/schedule/booking.ts) — `bookingRequiresConfirmation`
  (:146, single-sourced doctrine: promises gate, everything else one-shots);
  promise-break predicate (:432-439: 'day' breaks on day change; 'time' also on same-day start
  change); overlap PRE-check + DB guard backstop; move stranding path (:512-537 →
  `move_failed` event); every manual book AND move writes `locked: true` (:327, :510).
- [src/db/reviewItems.ts:10-27](../../src/db/reviewItems.ts#L10-L27) — the confirm-token
  vocabulary (staged kinds incl. `pending_booking`/`pending_visit_move`/`pending_visit_cancel`;
  15-min expiry; consume-first commit). No kind stores a pinned `scheduleVersion` yet.
- [src/mcp/server.ts:3947](../../src/mcp/server.ts#L3947) — `set_promise` (one-shot promise
  editor; server-derives `promisedDay` from the row; live-verified 2026-07-22).

**The version feed + notification machinery (live, team-only):**
- [src/db/scheduleEvents.ts](../../src/db/scheduleEvents.ts) — append-only log;
  `latestScheduleVersion` (:40) = the version token; `listScheduleEventsSince` (:54). Kinds
  with writers today: `booked`, `moved`, `move_failed`, `cancelled`
  ([booking.ts:350](../../src/schedule/booking.ts#L350), :524, :540, :612), `job_updated`
  ([server.ts:3905](../../src/mcp/server.ts#L3905)), `promise_updated`
  ([server.ts:3989](../../src/mcp/server.ts#L3989)), `backfilled` (script). `completed` is
  reserved with NO writer — nothing records that a visit actually happened.
- [src/telegram/boardNotify.ts](../../src/telegram/boardNotify.ts) — event → canned push copy
  for exactly 4 kinds (:59-121; unknown kinds silently produce no push); inactive-technician
  and unassigned-row filters; `pollOnce` (:130) with per-tenant in-memory cursors.
- [src/telegram/boardWorker.ts](../../src/telegram/boardWorker.ts) — the Render Background
  Worker; in-memory cursor = restart skips downtime events (documented v1 trade at :9-11).

**The only customer-reaching sender:**
- [src/mcp/server.ts:383-400](../../src/mcp/server.ts#L383-L400) (tool), :1853-1981 (handler)
  — `send_email`: stage → human sees exact to/subject/body → confirm → consume-first →
  [src/composio/outbound.ts:41](../../src/composio/outbound.ts#L41) `sendGmailEmail` (Composio
  `GMAIL_SEND_EMAIL`, sent AS the person from their own paired mailbox) → advisory L1 capture.
  Requires the sender be an active, mailbox-paired person. No system/tenant-level sender
  exists; no SMS path exists (no Twilio anywhere; `sms` appears only as a capture-channel enum
  value); the board bot pushes only to roster `telegram_user_id`s, never customers.

**Drive time / optimization substrate:**
- [src/routes/googleRoutes.ts](../../src/routes/googleRoutes.ts) — the ONLY routing
  integration: `computeRoutes` with `optimizeWaypointOrder`, free-text addresses, 25-waypoint
  cap, <3-stop short-circuit, single-intermediate sentinel workaround (:76-90). Key:
  `GOOGLE_MAPS_API_KEY` (in `.env`, NOT in `.env.example`; Render presence still unverified —
  open question carried since the 07-20 research).
- **No Google Route Optimization API client, no OptimoRoute/Routific client, no geocoding, no
  lat/lng column anywhere** — customers carry free-text address parts only
  ([formatAddress](../../src/routes/deepLink.ts), null when `address_line1` missing).

**Scheduled execution:**
- [src/jobs/lifecycle.ts](../../src/jobs/lifecycle.ts) — Render Cron Job every 15 min; four
  isolated sweeps (pairing, offboarding expiry, Composio sessions, log ingest); the
  sweep-over-durable-state idiom ("a missed or doubled tick is safe", :8-10). No render.yaml —
  Render services are hand-configured (three targets: web, cron, background worker).

## Data Flows

**What Plan 4's three pieces would traverse, against what exists (✅) and what doesn't (✗):**

```
          THE FREEZE (weekly solve of the loose bucket)
 loose bucket ──► solver ──► proposed plan ──► human gate ──► batch commit ──► inform
 ─────────────    ──────     ─────────────     ──────────     ────────────     ──────
 ✅ listUnassignedOpenJobs   ✗ no fleet       ✗ no batch      ✅ booking verbs  ✅ schedule_events
 ✅ listUnassignedAssignments  solver client    preview/token    (each guard      → boardWorker
 ✅ patterns/timeoff/durations ✗ no geocoding   ✗ no version-    still fires)     → tech pushes
    (assembleFitContext)     ✅ per-insertion    pinned write   ✅ promiseBroken  ✗ nothing tells
 ⚠ every booked row is        deltas only       machinery        gates per row     the CUSTOMER
    locked=true today         (find_slots)      (deferred w/3c)
```

```
          WINDOW ANNOUNCEMENTS + NIGHT-BEFORE CONFIRM
 tomorrow's visits ──► compose message ──► send to customer ──► record outcome
 ──────────────────    ────────────────    ─────────────────    ──────────────
 ✅ listAssignmentsFor  ✗ no window         ✗ only send_email    ✅ L1 capture path
    Tenant(day window)    concept (rows      (per-send human      exists for sends
 ✗ no nightly trigger     have exact         confirm, sender =   ✗ no reply-intake
    (cron is */15 sweep    times; promise     a person's own      for "yes that
    style, no time-of-day  ladder is day/     mailbox)             works" → nothing
    step)                  time, no range)   ⚠ pilot: 1/9 emails,  updates promise
                                               2/9 phones
```

**Pilot data state (hosted pilot DB read-back, 2026-07-22):** Default Tenant: 12 future
confirmed visits — 2 day-promised, 10 promise-'none', ALL 12 `locked=true`, 1 unassigned;
5 open jobs with no live assignment; 9 customers of which 1 has an email and 2 have a phone;
3 active people, 2 with patterns; 1 job-type duration row. Judy Testing: 1 active person, no
schedule data. The solvable "loose bucket" is therefore today the two queues (5 jobs + 1
unassigned visit); the 10 promise-free booked visits are loose in the *promise* sense but
locked in the *placement* sense.

**Version pinning, current state:** every schedule read returns `scheduleVersion` (read before
snapshot); `listScheduleEventsSince` answers "what changed since N"; **nothing stores a version
to compare at commit time** — the pin machinery was explicitly deferred with reflow_day (3c).
A batch freeze commit is exactly the "version-pinned batch write" the CoAgent rule (toolset
research finding 3.7) prescribes.

**Promise hardening over the horizon (the ladder Plan 4 would ride):** book far out with
`promiseLevel 'day'` ("we'll come Tuesday") → freeze/announce converts to a firmer commitment
→ `set_promise` can now record level changes one-shot (`promise_updated` events) → night-before
confirm is the final hardening step. The ladder columns and the editor exist; nothing models an
arrival *window* ("8–12") — only exact `starts_at/ends_at` plus day/time promise levels.

## External Dependencies

- **Google Routes API `computeRoutes`** (`GOOGLE_MAPS_API_KEY`) — live, per-call Pro SKU,
  the one-day/one-tech measuring tape. NOT a fleet solver.
- **Google Route Optimization API ("ROI")** — *not integrated*. Surveyed 2026-07-04
  ([2026-07-04-third-party-automated-scheduling-software.md](2026-07-04-third-party-automated-scheduling-software.md#L111-L125)):
  strongest constraint model (time windows, breaks, load limits, precedence), per-*shipment*
  billing, 2+ vehicles = Enterprise "Fleet Routing" SKU ~$30/1k shipments, ~1k free/mo likely
  covering weekly pilot runs. **That survey also formally recommended OptimoRoute
  (~$35-49/driver/mo, weekly planning tier-gated) over ROI** — the later series shorthand
  "ROI API" for Plan 4 was written before any engine decision was made; no artifact records
  choosing between them. ALL pricing/capability claims are as of 2026-07-04 and the CLAUDE.md
  external-services rule requires re-verification against live vendor docs at plan time —
  including whether ROI accepts free-text addresses or requires lat/lng (this repo has no
  geocoder; the answer materially changes the build).
- **Composio Gmail** (`GMAIL_SEND_EMAIL` via a person's paired mailbox) — the only
  customer-messaging transport; manager tier also has the full catalog agent-side (sends
  outside repo code, captured via log ingestion).
- **Telegram Bot API** (board bot, Render-owned token) — team pushes only; one-way (no reply
  path on the board bot; it is deliberately non-AI).
- **Supabase/PostgREST** via `src/db/` only; Render cron/worker/web are hand-configured.

## Constraints and Invariants

- **Every manual placement locks** ([booking.ts:327](../../src/schedule/booking.ts#L327),
  :510): `locked` was defined as "manual manager placement — Plan-3 optimizer routes around it"
  ([assignments.ts:33](../../src/db/assignments.ts#L33)). No code path writes `locked: false`
  today, so "route around locks" currently means "place only the queues, reshuffle nothing" —
  unless Plan 4 defines what may unlock (or writes auto-placed rows unlocked, the first ever).
- **Confirmation doctrine is single-sourced and input-derived**: promises gate; everything
  else one-shots and reports ([bookingRequiresConfirmation](../../src/schedule/booking.ts#L146),
  previews carry `requiresConfirmation`). A batch commit that moves a promised visit hits the
  same per-row gates through the verbs — nothing about the envelope is batch-aware.
- **Duration is fail-closed** (user, 2026-07-20): job-type table or explicit statement, never
  a default. A solver run over untyped jobs (chat-minted shells carry no `job_type`;
  pilot: 1 duration row) has no durations to solve with until asked-and-stored per type.
- **Availability is fail-closed**: pattern-less people are invisible to the scheduler
  (surfaced via `skippedNoPattern`, never silent). Pilot: 2 of 3 active have patterns.
- **Naive-local time everywhere**: wall clock stored as if UTC; HH:MM slices are the emission
  idiom (PR #72 closed the last raw-timestamptz leak — the wire's `+00:00` is a lie; an
  integration exchanging times with an external solver must translate at the boundary and
  emit slices back).
- **Times on a row are immutable** — every move is cancel+insert, not atomic; a batch of N
  moves is N stranding windows, each already handled honestly (`move_failed` event +
  UNSCHEDULED error + boardNotify copy), but a mid-batch failure has no rollback concept.
- **L1 is append-only, and outbound agent sends are classifier-free by recorded exception**
  (CLAUDE.md): every `send_email` is captured; a system-sender path, if built, would need its
  own capture story decided BEFORE the first send (no delete later).
- **Event kinds are push-gated**: boardNotify knows 4 kinds; new kinds (e.g. a freeze commit,
  an announcement record) produce no push until copy is added; reusing `booked` with
  `actor_ref:'system'` inherits today's copy.
- **The board worker's cursor is in-memory** — a freeze's event burst enlarges the
  restart-loss window (the persistent-cursor upgrade is the recorded deferred fix).
- **The `proposed` status tier is designed but unused**: overlap-legal "alternative proposals"
  have been structurally available since Plan 1 — a natural staging home for an un-committed
  solver plan, but zero code exercises it (readers filter `['confirmed']`).
- **Mechanism over instruction** (recorded lesson, repeatedly re-proven live): behavioral
  contracts must ride IN result payloads; description-only guidance does not steer the live
  GLM model. Any "relay this announcement/question verbatim" flow inherits this.
- **Telegram-only surface** (product doctrine): manager-facing controls must be
  Telegram-reachable tools; operators appear only at setup/breakage. A "freeze" the manager
  cannot trigger/see from chat (or the board) contradicts the doctrine.
- **Pilot-DB safety**: tests only against the local stack; pilot migrations need explicit
  user authorization; deploy order is migration-first (PR #58 incident).

## Decision Points

Factual forks the current code creates for Plan 4 (no recommendations):

1. **The solver engine.** Options as the substrate stands: (a) Google Route Optimization API —
   new client + billing + address-vs-latlng question (no geocoder exists); (b) OptimoRoute (the
   2026-07-04 survey's actual recommendation) — vendor subscription, custom-tool/HTTP wrap,
   weekly-planning tier gate; (c) build on what exists — `assembleFitContext` + `freeGaps` +
   greedy placement with `measureDriveDeltas` (no new vendor; not a true joint optimizer);
   (d) heuristic-only v1 (no drive term). The series shorthand says "ROI API" but no decision
   artifact exists, and all vendor claims are stale by rule.
2. **What the freeze may touch.** The loose bucket today = unassigned visits + unscheduled
   open jobs (6 rows total on the pilot). Whether the solve may also *re-place* promise-'none'
   booked visits requires deciding what `locked` means going forward (all booked rows are
   locked; nothing unlocks), and whether auto-placed rows land unlocked (the first ever).
3. **The staging/commit shape.** A whole-plan proposal needs a home between solve and commit:
   the unused `proposed` assignment tier (overlap-legal by design) vs a staged review-item
   token (house confirm machinery, 15-min expiry, no version pin yet) vs plain
   preview-in-chat. Version-pinning a batch commit (`scheduleVersion` at solve time, typed
   conflict on drift) exists as halves that were deliberately not joined in 3b.
4. **The notification-sender fork (recorded OPEN since Plan 1).** Announcing windows to many
   customers with what exists means N human-confirmed `send_email`s from a person's own
   mailbox. Alternatives are a new system-sender path (no precedent; L1 capture + disclosure
   decisions attach) or declaring announcements out of channel (manager calls customers,
   the spine only tells the manager WHO to tell WHAT — the board/agent already carry that
   pattern). The pilot's contact data (1 email, 2 phones of 9 customers) bounds what any
   channel can reach today.
5. **The window concept.** Nothing models "8–12": visits carry exact times; the ladder carries
   day/time. An announced window needs either a convention (derive window = booked time ±
   slack at announcement time) or schema (window columns / a new promise level), and
   interacts with the promise-break predicate (a move inside an announced window ≠ a broken
   promise?).
6. **The trigger and cadence.** "Weekly freeze" and "night-before confirm" are time-anchored;
   the infra has a 15-min sweep cron (idempotent-sweep idiom could carry
   run-once-per-day/week steps) vs the worker-process pattern vs manager-invoked MCP tools
   ("run the freeze now") per the Telegram-only doctrine — the ritual could be human-triggered
   with automation only reminding.
7. **The reply intake for night-before confirms.** A customer's "yes/no/can we do 10?" has no
   inbound home: inbound email ingestion exists (per-person Gmail webhook → L1), but nothing
   routes a customer reply into a schedule action; the board bot has no reply path. Deciding
   whether night-before is fire-and-forget vs closes-the-loop determines whether Plan 4
   touches the inbound pipeline at all.
8. **`completed` has no writer.** The night-before sweep reads "tomorrow's visits"; nothing
   records visit completion, so "tomorrow's visits" includes rows whose work already happened
   only if past-dated (the queries are date-bounded — adequate until a visit spans days or a
   completion-aware feature needs the signal; actual-duration learning was tagged "far
   future" in the toolset research).

## Open Questions

- Google ROI API current pricing, free tier, and input model (address strings vs lat/lng —
  load-bearing given no geocoder); OptimoRoute current pricing + weekly-planning activation on
  Pro (both stale from 2026-07-04; re-verify against live vendor docs at plan time per
  CLAUDE.md).
- Is `GOOGLE_MAPS_API_KEY` set on the Render web service (open since the 07-20 research;
  find_slots degrades cleanly without it, so the live E2Es don't settle it)?
- Does the pilot manager actually want a *weekly* ritual, or is "freeze" better matched to
  their real rhythm (e.g. Friday afternoon for next week)? Cadence is a product question no
  artifact records.
- How many customers will ever have contact details on file (intake captures name/address
  first; email/phone arrive via field notes) — does announcement-by-agent have an audience,
  or is manager-relays-it the realistic v1?
- Whether the freeze's event burst forces the board worker's persistent-cursor upgrade
  (deferred v1 trade) before batch commits are safe to notify on.
- Whether Judy's tenant participates (her data is empty; her phone E2E is still owed) — the
  freeze is per-tenant machinery hitting a one-real-tenant pilot.

## Addendum — user scope input (2026-07-22)

The loose bucket needs a **persistent visual home on the board** (user request, form
undecided): the day view already renders an "Unassigned" lane with drag-to-assign
([web/board/board.js:193-214](../../web/board/board.js#L193-L214)), but (a) visits parked
beyond the viewed window never cross the screen — their only surface is the chat recall view
(`unassignedOnly`), which requires remembering to ask — and (b) unscheduled open jobs (the
bucket's larger half; 5 on the pilot) have **no board presence at all**. Plan 4 should include
an always-visible bucket indicator/tray (e.g. "Parked: 1 · Unscheduled: 5"), which is also the
natural UI anchor for the freeze itself (what it will consume / its all-clear state).

**Freeze timing must accommodate firm variability** (user, 2026-07-22: fast-filling firms
outgrow a weekly cadence; slow firms don't need one). Candidate resolution discussed (for the
plan brief to decide): the freeze as a manager-invoked verb with a per-invocation HORIZON
argument ("freeze through next Friday" — the find_slots date-range pattern) rather than a
stored per-tenant cadence; automation enters as a bucket-size reminder nudge inside the
existing 15-min sweep, not a scheduler. Stored cadence/threshold config deferred until a firm
asks for hands-off runs. The night-before confirm hour is the one inherently clock-anchored
piece (small tenant setting, or manager-triggered v1). Consistent with: the human approval
gate the freeze needs anyway, the Telegram-only doctrine, the absence of time-of-day infra,
and the explicit-statement-over-silent-default product rule (endTime/duration precedents).
