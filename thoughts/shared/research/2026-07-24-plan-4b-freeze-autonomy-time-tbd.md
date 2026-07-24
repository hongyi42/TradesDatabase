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

## Decision Points

1. **The solver engine.** (a) **`fit.ts` batch greedy** — no vendor, no geocoding, reuses a
   live-verified engine, but is a sequential greedy fill, not a joint optimum; (b) **Google
   Route Optimization API** — a true VRP solver at $30/1,000 shipments with 1,000 free monthly
   (so ~$0 at pilot volume), but requires building geocoding + coordinate storage first because
   it rejects free-text addresses; (c) **OptimoRoute** — the 2026-07-04 survey's original
   recommendation, a per-driver subscription (~$35–49/driver/month, pricing now 20 days stale
   and unverified); (d) **heuristic-only, no drive term**. Note the bucket is currently five
   items across two or three technicians.
2. **The time-TBD shape.** (a) **`timesProvisional` boolean** — keep concrete placeholder times
   so the overlap guard and gap arithmetic keep working, badge the visit "time TBD" everywhere,
   and forbid announcing a provisional time to a customer; (b) **nullable times** — honest
   modelling, but requires reworking the exclusion constraint and every reader, and removes the
   row from double-booking protection (see the verified range behaviour); (c) **a day-bucket
   convention** — store the firm's full working day as the span and treat that as "unscheduled
   within the day".
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
