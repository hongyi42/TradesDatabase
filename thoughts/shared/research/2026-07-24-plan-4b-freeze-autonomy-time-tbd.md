---
date: 2026-07-24
branch: research-4b-freeze
commit: 4c7ade9
topic: Plan 4b — the weekly freeze (engine + staging + trigger), the per-tenant autonomy toggle, and time-TBD visits (day known, time unknown)
---

## Summary

Plan 4b is three things the user bundled deliberately, because they constrain each other:

1. **The freeze** — a recurring moment where the *loose bucket* (visits with nobody attached +
   jobs with no visit at all) gets placed onto the calendar, and the affected customers get
   told. Today a manager places every visit by hand.
2. **The autonomy toggle** — a per-firm switch for whether the assistant may act on its own
   (run the freeze, place work) or only ever recommend and wait to be asked.
3. **Time-TBD visits** — the ability to record "we're coming Thursday, time not settled yet".
   Right now that is *unrepresentable*: a visit must carry exact start and end times, so a
   day-only commitment is forced into invented times the whole system then treats as real.

This document extends [the 2026-07-22 freeze-surfaces
research](2026-07-22-plan-4-freeze-ritual-surfaces.md) rather than repeating it — that
document's map of the commit path, the staging options, the sender fork, and the announcement
window still stands. What is **new** here: the engine question is now settled by evidence
(see [the ROI verification](2026-07-24-roi-engine-live-pricing-verification.md) and the
`fit.ts` finding below), plus the two areas that document never covered (autonomy, time-TBD).

**The headline finding: the freeze may not need a new solver at all.** `src/schedule/fit.ts`
— built for Plan 3b's `find_slots` and live-verified 2026-07-21 — already contains a
drive-aware placement engine: it reads each technician's working pattern and time off, computes
the genuinely free gaps in a day, scores candidate slots by priority/earliness/day-load, and
clusters by city *without a geocoder*, then optionally measures real drive-time deltas through
Google Routes. It scores **one job at a time**. A freeze is that same machinery run over the
bucket. Adopting Google's Route Optimization API instead would mean building address→coordinate
geocoding first (it rejects free-text addresses), to solve a bucket that currently holds
**five items**.

**The second finding kills one of the two time-TBD designs outright.** Making the time columns
nullable looks like the honest modelling choice, but the double-booking guard is a Postgres
exclusion constraint over `tstzrange(starts_at, ends_at)`, and a range with NULL bounds is
*unbounded*. Verified directly:

```sql
select tstzrange(null,null) as r,
       tstzrange(null,null) && tstzrange(now(), now()+interval '1 hour') as overlaps_any;
--  r  | overlaps_any
-- (,) |     true
```

So one timeless visit would collide with **every** other confirmed visit for that technician —
the guard would reject the whole day. Excluding TBD rows from the guard instead makes them
invisible to double-booking protection *and* to the gap arithmetic in `fit.ts`, which is what
stops the scheduler handing out a slot that is already taken.

**The third finding reframes the whole plan: the pilot cannot feed a freeze today.** Measured
2026-07-24 — 18 open jobs, **15 with no job type at all**, one stored duration
(`drainage replacement`) that **no open job matches**, and **2 of 4** active technicians with
a working-hours pattern. Duration and availability are both fail-closed by deliberate user
decision (never guess a job length), so a freeze run right now would correctly place
**nothing**. The bottleneck for this feature is not the solver — it is that the firm has never
been asked how long its work takes or when its people work. Any 4b plan that starts with an
engine builds the roof before the walls.

## Entry Points

- **The engine that already exists**: [`src/schedule/fit.ts`](../../src/schedule/fit.ts) —
  `generateCandidates` (:179), `sortCandidates` (:225), `assembleFitContext` (:320),
  `findDisplacementCandidates` (:411), `measureDriveDeltas` (:497).
- **The commit path any freeze must use**:
  [`src/schedule/booking.ts`](../../src/schedule/booking.ts) — `bookVisit`, `moveVisit`,
  `resolveMove`, plus the shared cores `setVisitPromise` / `updateJobIdentity` added in 4a.5.
- **What the freeze consumes**:
  [`src/schedule/boardRead.ts`](../../src/schedule/boardRead.ts) `readLooseBucket` (:251) —
  shipped in 4a; the tray on the board and the agent's recall view read this one function.
- **The only scheduled entrypoint in the system**:
  [`src/jobs/lifecycle.ts`](../../src/jobs/lifecycle.ts) `runLifecycle` (:44) — a Render cron
  at `*/15 * * * *`, four idempotent sweep steps, one failing step reported but never blocking
  the others. Any automatic freeze lands here or beside it.
- **The per-tenant setting precedent** (what the autonomy toggle should copy):
  [`src/db/tenants.ts`](../../src/db/tenants.ts) `setTechnicianHorizonDays` (:69) +
  [`src/schedule/policy.ts`](../../src/schedule/policy.ts) — one policy home, plain update, DB
  CHECK as backstop, manager-tunable from chat, echoed old→new.
- **The schema that blocks time-TBD**:
  [`supabase/migrations/20260704210155_scheduling_foundation.sql:60-72`](../../supabase/migrations/20260704210155_scheduling_foundation.sql#L60-L72)
  — `starts_at`/`ends_at` `not null`, `check (ends_at > starts_at)`, and the
  `no_confirmed_overlap` GiST exclusion constraint.

## Key Files

| File | Role for 4b |
|---|---|
| `src/schedule/fit.ts` (569 ln) | The candidate engine. `FitContext` holds per-technician patterns, time off, visits-by-date, cities-by-date, stop counts. `DENSE_DAY_STOPS = 2` decides whether a day yields concrete gap candidates or one **day-level** candidate. Scoring: earliness (priority-weighted), morning bonus, light-day bonus, same-city bonus. |
| `src/schedule/booking.ts` (765 ln) | Every write. Promise ladder (`none/day/time/time_only`), `promiseBroken` predicates, overlap pre-check, duplicate guards, ledger events. A freeze commits **through** these, inheriting every gate. |
| `src/schedule/boardRead.ts` (426 ln) | `readLooseBucket` = exactly what a freeze consumes; `readBoardDays` renders it. |
| `src/schedule/policy.ts` (49 ln) | The horizon policy's single home; explicitly anticipates "4b's push gating" calling it rather than re-deriving. |
| `src/jobs/lifecycle.ts` | The 15-minute idempotent sweep — the only automation substrate. |
| `src/db/tenants.ts` | Settings-column precedent for the autonomy flag. |
| `src/telegram/boardNotify.ts` | Push copy, keyed by event kind — a new freeze event kind produces **no push** until copy is added. |
| `src/routes/daySource.ts` | Reads confirmed rows per technician per day; assumes real times. |

## Data Flows

What a freeze would do, built on what exists (no new vendor):

```
readLooseBucket(tenant)              ← 4a, already shipped
   │  unassigned visits + jobs with no visit
   ▼
for each item, priority order:
   assembleFitContext(...)   ← fit.ts: patterns, time off, existing visits, cities
   generateCandidates(...)   ← free gaps, scored; dense day → concrete slots
   measureDriveDeltas(top 5) ← Google Routes computeRoutes (existing key/SKU)
   │  take best candidate, mark that gap consumed IN MEMORY
   ▼
staged proposal (whole plan, version-pinned to scheduleVersion at solve time)
   │  manager reviews in chat / on the board  ← human gate
   ▼
commit → bookVisit / moveVisit per row  ← every promise + overlap gate applies
   │
   ▼
schedule_events → boardNotify pushes → customers told (sender fork still OPEN)
```

The one structural change versus `find_slots`: `assembleFitContext` is a DB read, so placing
N items must **not** re-read N times. The context is assembled once and each accepted placement
updates `visitsByDate` / `stopsByDate` in memory before the next item is scored — otherwise the
solve hands the same gap to two jobs.

## Constraints and Invariants

Beyond those in the 2026-07-22 document (all still true), the ones that bind 4b:

- **A NULL-bounded range overlaps everything** (verified above). This is what makes "just make
  the times nullable" unsafe: with a technician attached, one timeless row would block that
  technician's entire calendar under `no_confirmed_overlap`.
- **`technician_id` IS NULL rows are already exempt from the overlap guard** (an exclusion
  constraint compares with `=`, and NULL is never `=`). So today's unassigned visits are
  *already* invisible to double-booking protection — a time-TBD row that is also unassigned
  changes nothing, but one with a person attached is the dangerous case.
- **`fit.ts` gap arithmetic is only as good as the times it reads.** `freeGaps` subtracts
  existing visit spans from working windows. A visit with no real span does not block anything,
  so the scheduler would happily offer a slot the technician has already promised away.
- **`dayLevel` already exists as a concept** (`fit.ts:112`, `:214`) — on an open day,
  `find_slots` deliberately emits ONE day-level candidate and instructs "quote the DAY, not a
  time", because a precise time on a loose day is false precision. But booking then writes
  concrete times anyway. Time-TBD is the missing half that would make `dayLevel` honest
  end-to-end, and it pairs with the `time_only` promise level shipped in 4a.5 (told a time,
  no day) as its mirror image (know the day, not the time).
- **Duration is fail-closed, and the pilot cannot currently place a single job.** Measured on
  the pilot 2026-07-24: **18 open jobs, 15 of them with no `job_type` at all**, and exactly
  **one** stored duration (`drainage replacement`) which **no open job matches** — so
  `open_jobs_with_known_duration = 0`. A freeze run today would correctly refuse to place
  everything. The binding constraint on this feature is **input coverage, not the solver**.
- **Availability is fail-closed too**: pattern-less technicians are invisible to the scheduler.
  Measured 2026-07-24: **2 of 4 active technicians** have an `availability` pattern, so half
  the team cannot receive placed work either.
- **Every manual placement sets `locked: true`, and nothing ever writes `locked: false`.** The
  4a.5 work removed the misleading "locked" badge from the board but kept the field. A freeze
  must decide what it may touch; if freeze-placed rows land unlocked, that is the first
  unlocked row the system has ever written.
- **The autonomy toggle has no existing enforcement point** — there is no code path today where
  the agent acts unprompted, so the toggle only becomes meaningful when the freeze's automatic
  trigger exists. It gates a capability 4b itself creates.

## How the optimizer actually takes input (verified 2026-07-24)

Researched because of the user's architectural point: **the time-TBD question IS the
optimizer's input question.** An optimizer earns its cost by *choosing* when and who; if every
visit already carries fixed times, there is nothing left to choose and the API degenerates into
a sequence validator. Flexibility is expressed as **time windows wider than the visit's
duration** — so the schedule model must be able to say "2 hours, somewhere on Thursday".

**The model has no concept of days.** Everything is absolute timestamps inside
`globalStartTime`/`globalEndTime` ("no times outside of this range can be considered valid").
"Thursday" is expressed as a time window covering Thursday's working hours. Under this repo's
naive-local storage convention, that translation happens at the API boundary.

| Our concept | ROI representation | Source |
|---|---|---|
| Job to place, no day fixed | `VisitRequest` with **no** `timeWindows` — "the absence of `TimeWindow` means that the vehicle can perform this visit at any time" (within global bounds) | ShipmentModel |
| "Thursday, time TBD" | **one** `TimeWindow` = Thursday's working hours | ShipmentModel |
| "This week, any working day" | **multiple** `timeWindows` — "must be disjoint … and in increasing order" (one per working day) | ShipmentModel |
| Duration (the new ladder) | `VisitRequest.duration` — "time spent by the vehicle between arrival and departure" | ShipmentModel |
| Technician working hours | `Vehicle.startTimeWindows` / `endTimeWindows` | ShipmentModel |
| Lunch / rest | `BreakRule` / `BreakRequest` (`earliestStartTime`, `latestStartTime`, `minDuration`) | ShipmentModel |
| "It must be Ben" | `Shipment.allowedVehicleIndices` — "the set of vehicles that may perform this shipment" | ShipmentModel |
| Soft preference (e.g. prefer mornings) | `softStartTime`/`softEndTime` + `costPerHourBeforeSoftStartTime`/`costPerHourAfterSoftEndTime` | ShipmentModel |
| "Couldn't fit it" — report, don't fail | `Shipment.penaltyCost`: "if the shipment is not completed, this penalty is added to the overall cost"; without it, completion is **mandatory** | ShipmentModel |
| Manual placements are sacred | `injectedSolutionConstraint` — "may be used to freeze portions of routes … which must not be modified"; with `constraintRelaxations` empty, "all non-empty vehicle routes are fully constrained" | InjectedSolutionConstraint |
| Partial freedom (let it re-time but not re-assign) | `ConstraintRelaxation.Level`: `RELAX_VISIT_TIMES_AFTER_THRESHOLD` keeps vehicle + sequence, relaxes times; `..._AND_SEQUENCE_...` keeps vehicle only; `RELAX_ALL_AFTER_THRESHOLD` frees everything and visits "can potentially become unperformed" | InjectedSolutionConstraint |

### The optimizer cannot double-book — by construction

A `ShipmentRoute` is a strictly time-ordered sequence for ONE vehicle: "if there are n visits,
there are n+1 transitions" and "a visit is always surrounded by a transition before it (same
index) and a transition after it (index + 1)". Each `Transition` accounts for every second
between visits — `totalDuration = travelDuration + delayDuration + breakDuration +
waitDuration`. Two visits on one vehicle therefore **cannot** overlap: the solver's output is
conflict-free by construction, and it also refuses to place work that cannot fit (surfacing it
as a skipped shipment when `penaltyCost` is set).

Source: [ShipmentRoute](https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentRoute),
[ShipmentModel](https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentModel),
[InjectedSolutionConstraint](https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/InjectedSolutionConstraint).

### Correction to this document's earlier objection about nullable times

The user's challenge is correct, and it narrows the earlier finding. The `tstzrange(null,null)`
result stands as a fact, but it only bites if timeless rows are left **inside** the exclusion
constraint. A visit that has a day but no time is **not claiming a slot** — it is demand, not
schedule — so it does not belong in a double-booking guard at all. Narrowing the constraint's
predicate (e.g. `where (status = 'confirmed' and starts_at is not null)`) keeps today's
protection exactly as strong for placed visits while letting unplaced ones exist.

Double-booking is then caught where it actually occurs — at **placement**: the optimizer cannot
produce an overlap, and the DB guard re-checks each committed row, catching anything a manual
booking raced in between solve and commit. What genuinely changes is the *failure mode*: a firm
can accept more day-only work than a day can hold, and only discover it at freeze time — which
the API reports as skipped shipments rather than hiding.

## User decisions (2026-07-24)

- **Duration model REPLACED — a fixed ladder, required at creation, never defaulted.** Instead
  of today's `job_type_durations` lookup (which the pilot has effectively never populated: 1
  row, matching 0 open jobs), duration becomes a **choice from a fixed set of levels** — 15
  min, 30 min, 1 h, 2 h, 4 h, … — and it is a **required input when work is created**, exactly
  as a description is. When a duration is missing, the system **asks the manager**; it never
  backs into a default. This preserves the standing fail-closed rule ("never invent a job
  length") while removing the reason coverage stayed at zero: the manager answers a
  one-tap-style question instead of maintaining a job-type table.
  *Wrinkle the plan must handle:* the freeze places jobs that have **no visit yet**, so the
  duration must exist at the **job** level (or be collected for the batch as the freeze's
  opening move) — capturing it only at visit-creation time would leave the freeze's own inputs
  empty. Today `book_visit` already requires explicit start AND end times, so the manual path
  is already fail-closed; the gap is exactly the never-visited jobs.
- **Engine: Google Route Optimization API** (user choice over the `fit.ts` batch option, with
  the geocoding cost stated). Consequences the plan must carry as their own phases:
  address→coordinate geocoding + coordinate storage + a re-geocode rule on address edits + a
  fail path for addresses that do not geocode; and **confirming that the Enterprise-tier Fleet
  Routing SKU can be enabled on the billing account without a sales agreement** — a hard
  prerequisite, since its free tier is what makes the choice ~$0 at pilot volume.
- **Time-TBD storage shape: OPEN** — user asked for a simpler explanation before deciding.

## Decision Points

1. **The solver engine.** (a) **`fit.ts` batch greedy** — no vendor, no geocoding, reuses a
   live-verified engine, but is a sequential greedy fill, not a joint optimum; (b) **Google
   Route Optimization API** — a true VRP solver at $30/1,000 shipments with 1,000 free monthly
   (so ~$0 at pilot volume), but requires building geocoding + coordinate storage first because
   it rejects free-text addresses; (c) **OptimoRoute** — the 2026-07-04 survey's original
   recommendation, a per-driver subscription (~$35–49/driver/month, pricing now 20 days stale
   and unverified); (d) **heuristic-only, no drive term**. Note the bucket is currently five
   items across two or three technicians.
2. **The time-TBD shape — REFRAMED by the optimizer research.** This is not a storage detail;
   it is what the freeze is allowed to decide. (a) **Unplaced visits: times null until placed**
   — the visit carries day (or day range) + duration; the exclusion guard is narrowed to placed
   rows; this is ROI's native input and preserves the optimizer's freedom. Cost: every reader
   of visit times needs an unplaced path (10 non-test files touch `starts_at`), and the board
   must show unplaced work as demand rather than on the time grid. (b) **`timesProvisional`
   flag over placeholder times** — smallest blast radius and no constraint surgery, but the
   placeholder is a fiction the solver would have to be told to ignore, and any code that
   forgets the flag shows a time nobody promised. (c) **Full-day span** — no schema change, but
   a 2-hour job consumes a 9-hour day in every capacity calculation, which is precisely the
   flexibility the optimizer needs.
   *Note:* flexibility comes from the **window being wider than the duration**, so (a) and (b)
   can both feed ROI — the real difference is whether the stored times mean anything.
3. **Autonomy granularity.** One per-tenant boolean ("the assistant may act on its own") versus
   per-capability flags (may it freeze? may it move a promised visit? may it message customers?).
   The horizon setting is the precedent for either.
4. **What the freeze may touch** — the loose bucket only, or also re-place unpromised booked
   visits (which requires deciding what `locked` means).
5. **Staging and commit shape** — the unused `proposed` assignment tier, a staged review-item
   token, or a plain chat preview; and whether the batch commit is version-pinned to
   `scheduleVersion` with a typed conflict on drift.
6. **Trigger and cadence** — manager-invoked verb with a per-run horizon ("freeze through next
   Friday"), an automatic cron run gated by the autonomy toggle, or a nudge that only reminds.
   The 2026-07-22 addendum records the user's constraint that cadence varies by firm.

## Open Questions

- **RESOLVED (and it changes the plan): no, the pilot cannot feed a freeze** — 0 of 18 open
  jobs have a known duration, 2 of 4 technicians have patterns (see Constraints). The open
  question that replaces it is a *product* one: is duration best collected as a standalone
  onboarding chore, or as the first move of the freeze ritual itself ("before I can place
  these 15, tell me how long each type takes")?
- **Is `GOOGLE_MAPS_API_KEY` set on the Render web service?** Open since 2026-07-20;
  `find_slots` degrades silently without it, so no live test has settled it — and the freeze's
  drive term depends on it.
- **Does Fleet Routing require a sales agreement to enable?** The docs label it "Enterprise"
  without saying. If it needs a contract, its free tier is moot (only matters under engine b).
- **What cadence does the pilot manager actually want** — weekly, or "Friday for next week"?
  No artifact records asking.
- **Who can even be told?** Announcements need contact details; the pilot has 1 email and
  2 phones across 9 customers. This bounds the customer-facing half of the ritual regardless of
  the sender fork.
