---
date: 2026-07-24
task: Plan 4b-2 — unplaced visits: a visit may hold a day (or a range of days) with no time yet
research: thoughts/shared/research/2026-07-24-plan-4b-freeze-autonomy-time-tbd.md
status: draft
---

## Overview

Today a visit must carry exact start and end times, so "we're coming Thursday, time not settled"
is unrepresentable — it gets forced into invented times the whole system then treats as real.
That also starves the optimizer: a solver earns its cost by *choosing* when and who, and it can
only choose when the window is wider than the job is long.

This plan makes a visit able to exist **unplaced**: it holds a day or a range of days plus (from
4b-1) a duration, and gets real times only when a manager or the freeze places it. Second of
four: **4b-1 duration → 4b-2 unplaced visits (here) → 4b-3 the freeze → 4b-4 autonomy toggle.**

**Stacks on 4b-1** (`jobs.duration_minutes`) — land that first; Phase 2 reads it.

## Decisions

- **Times become nullable; a new `earliest_date`/`latest_date` pair carries the day** (user,
  2026-07-24). Chosen over placeholder-times-plus-a-flag, which stores a time nobody agreed to
  and breaks the moment any surface forgets the flag.
- **A day OR a range** (user) — `earliest_date = latest_date` means "Thursday"; different means
  "sometime that week". One extra column, and it is what gives the optimizer room.
- **Named `earliest_date` / `latest_date`, not `window_*`** — implementer's call: it matches
  `find_slots`' existing `earliestDate`/`latestDate` vocabulary, and "window" is reserved for the
  customer *arrival window* Plan 4c introduces. One word, one meaning.
- **The double-booking guard is narrowed to placed rows**, not weakened. `tstzrange(null,null)`
  is unbounded and overlaps everything, so leaving unplaced rows inside would block a
  technician's whole calendar. An unplaced visit is **demand, not schedule**. Verified against
  the local stack during plan review: after the change, two overlapping *placed* confirmed rows
  still raise 23P01, and two unplaced confirmed rows for the same technician both insert.
- **Most time-range readers are safe for free** — `listAssignmentsForTenant`,
  `listAssignmentsWithRefsForTenant` and `listAssignmentsForTechnician` filter with
  `starts_at < X` / `ends_at > Y`, and a SQL comparison against NULL is never true. Phase 1
  encodes this as `PlacedAssignment` so it is compiler-checked, not a comment. **The exception
  is `listUnassignedAssignments`**, which Phase 2 deliberately widens — so both its callers are
  named there.
- **Unplaced visits appear in a "no time yet" strip on their day, and in the loose-bucket tray
  when nobody is attached** (user). The visit *has* a day; tray-only would throw that away.
- **Technicians do not see unplaced visits** (user) — a technician's day view is an operational
  document, and timeless work is not actionable for a read-only viewer.
- **`book_visit` gains an explicit `timeTbd` flag** (user) rather than a separate verb. Times
  stay required unless the manager explicitly says the time is unsettled, so omitting them is
  never an accident.
- **An unplaced visit may hold promise level `none` or `day` only** — plan-review finding.
  `time`/`time_only` on a timeless row is incoherent, and worse: with no start time the
  time-axis break test can never fire, so `promiseBroken` would be permanently false and moving
  the visit would never ask for confirmation. Both `book_visit` and `set_promise` refuse them
  with a message saying to place the visit first.
- **Assigned-and-unplaced work counts toward a technician's day LOAD but not day DENSITY** —
  load is per-person, so team size is irrelevant. Density (`DENSE_DAY_STOPS`) decides whether
  `find_slots` offers concrete times or says "quote the day"; it asks whether the route has
  *shape*, and timeless visits give weight without shape.
- **Unassigned-and-unplaced work stays invisible to `find_slots`; over-commitment is 4b-3's
  job** (user challenge). A row-count warning would fire on the healthy steady state — far-out
  routine work is *supposed* to sit loose between freezes. Real over-commitment means comparing
  committed to available minutes across a *window*, which is the freeze's capacity math; a cheap
  copy here would be worse arithmetic done twice. **Residual risk, recorded:** a firm that never
  freezes accumulates over-commitment silently — Plan 4c's freeze-due nudge is the backstop.
- **Every phase leaves the build green** — plan-review finding. The first draft told the
  implementer to "expect compile errors"; that is not a gate. Phase 1 now carries the mechanical
  null-guards for every site the type change breaks, including a temporary explicit refusal in
  `find_slots` that Phase 2 replaces with real support.

## Plain-language walkthrough

A visit today is a box with a start and end time in it. This plan lets the box hold *"Thursday,
2 hours, time to be decided"* instead — and lets the freeze fill in the time later.

```
  PLACED (today, unchanged)          UNPLACED (new)
  ┌─────────────────────┐            ┌─────────────────────┐
  │ Thu 09:00 – 11:00   │            │ Thu ── Fri          │  earliest/latest
  │ Ben                 │            │ nobody yet          │
  └─────────────────────┘            │ 2h (from 4b-1)      │
   counts against the                └─────────────────────┘
   double-booking guard               claims no slot → guard doesn't apply
```

**Phase 1** changes the shape of the box, narrows the double-booking guard so it still covers
every *placed* visit exactly as before, and fixes every place the code assumed times always
exist. Nothing visible changes; you'd notice it only in the tests.

**Phase 2** lets one get created. In chat you say the time isn't settled and the assistant books
a day-only visit; placing it later is just a move. It also shows up in the board tray and in the
assistant's "what's parked?" view. This is the first point the work is safe to deploy.

**Phase 3** shows them properly: a small **"no time yet"** strip above each day's grid. You'd
notice it by booking a time-TBD visit and seeing it appear on Thursday without landing anywhere
on the clock.

**Phase 4** stops the scheduler calling a committed day empty. If Ben already has three time-TBD
visits on Thursday, Thursday drops down the suggestions.

**Phase 5** is the rollout: pilot migration first, then deploy, then live checks.

## Secrets & env preflight

- **Phases 1–4:** none
- **Phase 5:** none. Needs `supabase-test` MCP (hosted pilot) + the deployed board.

`npx supabase start` must be running for every phase's tests (`.env.test`, per CLAUDE.md).

---

## Phase 1: Schema, types, and every site that assumed times exist

### What this phase does

Makes the time columns nullable, adds the day-range columns, narrows the double-booking guard to
placed rows, introduces `PlacedAssignment`, and fixes every resulting compile site. **Behaviour
is unchanged and the build is green at the end.**

### Changes required

**`supabase/migrations/20260724130000_unplaced_visits.sql`** (new)
```sql
-- Unplaced visits (Plan 4b-2): a visit may hold a DAY (or a range of days)
-- with no time yet. Times arrive when a manager or the freeze places it.
alter table assignments alter column starts_at drop not null;
alter table assignments alter column ends_at   drop not null;
alter table assignments add column earliest_date date;
alter table assignments add column latest_date   date;

-- A row is PLACED (both times, no range) or UNPLACED (range, no times).
-- Never half of each: a half-filled row would read as placed to some surfaces
-- and unplaced to others. The pre-existing `assignments_check
-- CHECK ((ends_at > starts_at))` needs no change — a CHECK is satisfied when
-- it evaluates to NULL (verified against the local stack, plan review).
alter table assignments add constraint assignment_placed_or_windowed check (
  (starts_at is not null and ends_at is not null
     and earliest_date is null and latest_date is null)
  or
  (starts_at is null and ends_at is null
     and earliest_date is not null and latest_date is not null
     and latest_date >= earliest_date)
);

-- Narrow the double-booking guard to PLACED rows: tstzrange(null,null) is
-- unbounded and overlaps everything, so an unplaced row left inside would
-- block that technician's entire calendar. Placed rows keep today's
-- protection EXACTLY — the only change is the `starts_at is not null`
-- predicate. The constraint was created inline but NAMED, so drop resolves.
alter table assignments drop constraint no_confirmed_overlap;
alter table assignments add constraint no_confirmed_overlap exclude using gist
  (technician_id with =, tstzrange(starts_at, ends_at) with &&)
  where (status = 'confirmed' and starts_at is not null);
```

**`src/db/database.types.ts`** — regenerate **from the LOCAL stack**
(`npx supabase gen types typescript --local > src/db/database.types.ts`; `npm run gen:types`
uses `--linked`, the hosted pilot, which lacks the columns until Phase 5).

**`src/db/assignments.ts`**
- Add beside `Assignment` (:7):
  ```ts
  // Rows that HAVE times. Every reader whose query filters on starts_at/ends_at
  // returns these by construction: a SQL comparison against NULL is never true,
  // so unplaced rows cannot appear in a time-range result. A type, not a
  // comment, so the property is compiler-checked.
  export type PlacedAssignment = Assignment & { starts_at: string; ends_at: string };
  export const isPlaced = (a: Assignment): a is PlacedAssignment =>
    a.starts_at !== null && a.ends_at !== null;
  ```
  (`src/db/index.ts:16` is `export *` — no plumbing needed.)
- Narrow the range-filtered readers to `PlacedAssignment[]` (cast at the return, justified by
  the comment above): `listAssignmentsForTenant` (:233), `listAssignmentsWithRefsForTenant`
  (:340, as `AssignmentDayRow & {starts_at: string; ends_at: string}`),
  `listAssignmentsForTechnician` (:360), **and `listUnassignedAssignments` (:395) /
  `listUnassignedAssignmentsWithRefs` (:465)** — still true here, because their `.gte` filter
  excludes nulls until Phase 2 widens them.
  **`listAssignmentsForJob` (:380) keeps `Assignment[]`** — no time filter, and it has no
  production caller (tests only).
- `CreateAssignmentInput` (:21): `startsAt`/`endsAt` become `string | null`; add
  `earliestDate?: string | null` / `latestDate?: string | null`. `createAssignment` (:39) throws
  unless exactly one shape is supplied (times XOR range); the DB check backstops.

**Mechanical null-guards — the sites the type change breaks** (each verified in plan review):
- **`src/schedule/fit.ts:294`** — `clampRowToDay(row: Assignment, …)` dereferences
  `row.starts_at` (:303-307). Change the parameter to `PlacedAssignment`; every caller already
  passes range-filtered rows. Update the exported test helper at `src/schedule/fit.test.ts:120-121`.
- **`src/mcp/server.ts:4173-4175`** — `find_slots`' `subjectRow` literal declares
  `starts_at: string`. Widen to `string | null` and, **for this phase only**, refuse an unplaced
  subject with a clear error before the duration branch at :4255-4257. Without the refusal,
  `Date.parse(null) - Date.parse(null)` yields `NaN`, `freeGaps(…, NaN)` matches no gap, and the
  tool silently returns zero candidates while reporting `using this visit's booked length
  (NaNm)`. **Phase 2 replaces the refusal with real support.**
- **`src/mcp/server.ts:4098`** (`set_promise` reply), **`:3189`** and **`:3272`** (cancel replies,
  one-shot and confirmed) each do `row.starts_at.slice(0,10)` on a row returned from
  `booking.ts`. Use the placed day, else `earliest_date`. Note :3189/:3272 run **after** the DB
  write, so an unguarded throw cancels the visit and then reports failure.

### Automated verification
- [ ] `npx supabase db reset` applies cleanly
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` **all pass** — no
      expected-failure carve-out; if something does not compile, it is a site this plan missed
- [ ] new tests in `src/db/scheduling.test.ts`: an unplaced row inserts; a half-filled row
      (times + range, or neither) is rejected by `assignment_placed_or_windowed`
- [ ] **new test pinning the narrowed guard**: two *placed* overlapping confirmed rows for one
      technician still raise the exclusion violation, **and** two unplaced confirmed rows for
      that technician on the same day both insert
- [ ] new test in `src/db/schema.test.ts`: `starts_at` nullable; `earliest_date`/`latest_date`
      exist

### Live verification (agent-executable)
None — no live surface changes yet.

### Manual verification
None.

---
*No Manual items — continue straight to Phase 2.*

## Phase 2: Creating one, placing it, and finding it

### What this phase does

Adds the write path, teaches `find_slots` to place an unplaced visit, and widens the two
recall/tray readers so a time-TBD visit is visible somewhere the moment it exists. **This is the
first point the work is coherent enough to deploy.**

### Changes required

**`src/schedule/booking.ts`**
- `BookVisitInput` (:137): add `timeTbd?: boolean`, `earliestDate?: string`, `latestDate?: string`.
  `startTime`/`endTime` optional **only** under `timeTbd: true`. Update the "both times are
  REQUIRED" block (:144-150) to record the explicit exception.
- `resolveBooking` (:185): branch on `timeTbd`. The unplaced arm validates the range (`DATE_RE`,
  `earliest <= latest`, `latestDate` defaulting to `earliestDate`), skips `naiveLocalISO`, skips
  `overlappingConfirmed`, and skips `availabilityWarning` — but **keeps** the date-based time-off
  check, which is still meaningful. **Refuse `promiseLevel` `'time'`/`'time_only'`** here.
- Duplicate guard: add a sibling to `listIdenticalUnassignedVisits`
  (`src/db/assignments.ts:424`) keyed on `earliest_date`/`latest_date`, so a retried one-shot
  unplaced booking cannot duplicate silently (the hazard the placed arm guards at :234).
- `resolveMove` (:417): `old` may be unplaced. `oldDurationMin` (:446) cannot come from null
  times — fall back to the job's `duration_minutes` (4b-1), and require an explicit `endTime`
  when that is null too. `timeChanged` (:459) must be guarded with `isPlaced(old)`: an unplaced
  row has no old time, so a move is never a *time* break.
- `setVisitPromise` (:692): `promisedDay` (:703) derives from `starts_at`. For an unplaced row
  use `earliest_date` **only when `earliest_date === latest_date`**; refuse a multi-day range,
  and refuse `'time'`/`'time_only'` outright (see Decisions).
- `unscheduleVisit` ledger detail, `previewUnscheduleVisit`,
  `MoveVisitPreview.fromDay` (:526, :600) and `:643` all use
  `promised_day ?? starts_at.slice(0,10)` — extend the fallback chain to `earliest_date`.
  (Names updated 2026-07-25: PR #80 renamed `cancelVisit`/`previewCancelVisit` to the
  unschedule pair and added terminal `cancelJob` — its cascade also touches these lines, and
  the :649/:629/:671 line anchors have shifted; re-locate by symbol when implementing.)
- `BookVisitPreview` (:264): `startTime`/`endTime` become nullable; add the date range.

**`src/mcp/server.ts`**
- `book_visit` tool (:651): add `timeTbd`, `earliestDate`, `latestDate`. The description must
  state that times remain required unless the manager explicitly says the time is unsettled, and
  that `timeTbd` is **never** the agent's own choice when a time was stated.
- `book_visit` handler (:2739): reject `timeTbd` together with `startTime`/`endTime`; the
  one-shot result copy (:2824-2825) reports the day/range instead of a time span.
- **The staged-booking path — the severe plan-review finding.** A time-TBD booking that carries
  a promise routes through staging (`bookingRequiresConfirmation`, `booking.ts:166`), and
  `promiseLevel: 'day'` is exactly the headline case. The stage detail (:2863-2864) writes
  `startTime: preview.startTime` — now possibly undefined — and the confirm guard (:2916-2922)
  throws `'staged booking is malformed'` on `!d.startTime`. Because staging already dismissed
  any prior pending token, the manager is left with a dead confirm and nothing booked. **Both
  the stage detail and the confirm guard must carry the unplaced shape** (range present, times
  absent) and validate it as valid rather than corrupt.
- `find_slots` (:4131): replace Phase 1's refusal with real support — an unplaced subject takes
  its duration from the job's `duration_minutes` (4b-1) and defaults `earliestDate`/`latestDate`
  to the visit's own range. Also guard `:4399`
  (`stops.filter(s => s.scheduledStart !== subjectRow.starts_at)`), which is a no-op for an
  unplaced subject.

**`src/db/assignments.ts`** — the deliberate widening
- `listUnassignedAssignments` (:395) and `listUnassignedAssignmentsWithRefs` (:465): replace
  `.gte('starts_at', fromISO)` with `.or('starts_at.gte.<fromISO>,starts_at.is.null')`, ordering
  NULLs last. Return type widens back to `Assignment[]` / `AssignmentBucketRow[]`.
  (Syntax verified against the local PostgREST during plan review: it ANDs correctly with the
  `eq` filters and the reserved-character rule does not bite.)

**Both callers of the widened reader — neither may be left unguarded:**
- **`src/mcp/server.ts:2657`** — `get_team_schedule { unassignedOnly: true }`, the manager's
  chat-side "what's parked?" view. Its shared loop does `row.starts_at.slice(0,10)` (:2674) and
  `.slice(11,16)` (:2701-2702). Add the unplaced arm: day from `earliest_date`, times reported
  as not set.
- **`src/schedule/boardRead.ts:252`** — `readLooseBucket`'s parked-visit mapper (:268-286).
  Branch on `isPlaced`: unplaced rows report their range with null times, and `overdue` compares
  `latest_date < today`.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass
- [ ] `src/schedule/booking.test.ts`: a `timeTbd` booking creates null times + the range;
      `timeTbd` + `startTime` is rejected; `promiseLevel: 'time'` on a `timeTbd` booking is
      rejected; moving an unplaced visit to a real time places it (times set, range cleared);
      moving one **without** `endTime` uses the job's `duration_minutes` and errors when null;
      two identical unplaced bookings for one customer are refused
- [ ] **`src/mcp/server.test.ts`: a `timeTbd` booking with `promiseLevel: 'day'` stages AND
      confirms successfully** — the regression for the malformed-stage finding; assert the
      committed row has null times and the range set
- [ ] `src/mcp/server.test.ts`: `get_team_schedule { unassignedOnly: true }` lists an unplaced
      visit with its day and no time, and does not throw
- [ ] `src/mcp/server.test.ts`: `find_slots` on an unplaced visit returns candidates sized by the
      job's `duration_minutes`, defaulting its search range to the visit's own
- [ ] `src/mcp/server.test.ts`: `set_promise 'day'` on a single-day unplaced visit stamps
      `promised_day`; on a multi-day range it is refused; `'time'`/`'time_only'` refused on any
      unplaced visit
- [ ] `src/telegram/boardApi.test.ts`: `/board/api/bucket` lists an unassigned unplaced visit
      (assert this fails before the `.or()` change and passes after)

### Live verification (agent-executable)
Deferred to Phase 5 — the pilot has no migration until then.

### Manual verification
None.

---
*No Manual items — continue straight to Phase 3.*

## Phase 3: The "no time yet" strip

### What this phase does

Puts unplaced visits on their own day above the time grid, and makes every board surface that
touches a visit's times survive their absence.

### Changes required

**`src/db/assignments.ts`**
- New reader `listUnplacedAssignedForRange(tenantId, fromDate, toDate)` — confirmed rows with
  `technician_id is not null`, `starts_at is null`, and `earliest_date <= toDate and latest_date
  >= fromDate`, embedding the `DAY_SELECT` shape. Single string literal (see the note at :293).

**`src/schedule/boardRead.ts`**
- `readBoardDays` (:~128-198): call the new reader and attach `unplaced: UnplacedStop[]` per day.
  **A day whose ONLY work is unplaced must still appear** — `byDay` entries are currently created
  only inside the placed-row loop (:159, :187), and `days` is built from `byDay` (:189-191), so
  a time-TBD visit on an otherwise empty Thursday would vanish entirely. Seed the map from the
  union of both reads.
  A visit whose range spans Tue–Thu appears on each of those days, labelled with its full range
  so it does not read as three visits. **Manager-only:** skip when `input.viewerTechnicianId != null`.
- `readVisitDetail` (:~395): `start`/`end` become nullable; add `earliestDate`/`latestDate`.

**`src/telegram/boardApi.ts`**
- `/board/api/book` (:329): accept `timeTbd` + the range, forwarding to `bookVisit`.
- `/board/api/day` (:188): payload gains each day's `unplaced` list.
- `/board/api/move` result copy (:575-576): a move always produces a placed row — assert with
  `isPlaced` rather than widening the payload.
- `/board/api/cancel` (:519): same fallback chain as Phase 2.

**`src/telegram/boardNotify.ts`**
- `day()` (:30) falls back to `earliest_date`; `span()` (:31-32) returns `'time not set'`.
  Without this a push renders `undefined–undefined`.

**`web/board/board.js` / `board.css`** — **no automated coverage exists** here
(`src/telegram/boardApi.test.ts:206-218` only asserts the file is served), so every item below is
manual-verified in Phase 5:
- Render the `no time yet` strip above each day's grid (customer, technician, duration, and the
  range when it spans more than one day). Tapping opens the existing detail sheet.
- **The detail sheet dereferences `d.start`/`d.end` unconditionally** at :654, :661, :685,
  :698-699, :745, :1092, :1107-1108, :1118, :1133-1134, :1168 — `canEdit`'s date floor (:685),
  the When row (:698-699), the promise-break copy (:654/661) and the quick-edit `<input
  type="time">` prefills (:1133-1134) each throw on null. All need an unplaced path; the sheet
  should show the range and offer **Place** rather than a time editor.
- **The tray's Assign button** (:507-509, :594-603) reads `data-date`/`data-start`/`data-end`
  into `postMove`; for an unplaced row these are empty and `/board/api/move` 400s
  (`boardApi.ts:526-528`). Assigning a person is the obvious action on a parked unplaced visit —
  it must post an attach that preserves the range instead of inventing a time.
- Booking form: a "time not settled yet" toggle that hides the time inputs and posts `timeTbd`.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass
- [ ] `src/telegram/boardApi.test.ts`: `/board/api/book` with `timeTbd` creates an unplaced
      visit; `/board/api/day` returns it under `unplaced` for **every** day its range covers and
      **never** on the time grid; **a day whose only work is unplaced still appears in `days`**;
      a **technician-tier** request gets no `unplaced` at all
- [ ] `src/telegram/boardNotify.test.ts`: a push about an unplaced visit renders the day and
      "time not set", never `undefined`

### Live verification (agent-executable)
Deferred to Phase 5.

### Manual verification
Deferred to Phase 5 (nothing is deployed yet).

---
*No Manual items — continue straight to Phase 4.*

## Phase 4: Stop calling a committed day empty

### What this phase does

Makes `find_slots` count a technician's unplaced visits toward how loaded their day is, without
letting timeless work pretend the day has a shaped route.

### Changes required

**`src/schedule/fit.ts`**
- `FitTechnician` (:120) gains `commitmentsByDate: Map<string, number>` alongside `stopsByDate`.
  **`stopsByDate` stays placed-only** — it feeds `DENSE_DAY_STOPS` (:151), which asks whether the
  route has *shape*.
- `assembleFitContext` (:320): its row read (:348-355) is range-filtered and cannot see unplaced
  rows. Add a second read (Phase 3's `listUnplacedAssignedForRange`) and fold each row into
  `commitmentsByDate` for every day of its range.
- `buildCandidate` (:231): the light-day term at :249 switches to the commitment count
  (placed + unplaced); the `stops >= DENSE_DAY_STOPS` branch (:203) keeps using `stops`. The
  `stops === 0 ? 'their day is empty'` reason (:258) must key on commitments, or it will claim
  an empty day that already holds three time-TBD visits.

**`src/schedule/fit.test.ts:36-45`** — the `tech()` factory builds a complete `FitTechnician`
literal, so the new required field breaks Phase 4's own typecheck before any new test runs (same
class as 4b-1's fixtures finding). Add `commitmentsByDate: new Map()`.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass
- [ ] `src/schedule/fit.test.ts`: a day with 3 unplaced assigned visits scores **below** an
      otherwise identical empty day; that same day still emits a **day-level** candidate
      (density unchanged — weight, not shape); "their day is empty" does not appear on it
- [ ] `src/schedule/fit.db.test.ts`: `assembleFitContext` populates `commitmentsByDate` from
      unplaced rows across a multi-day range
- [ ] existing `find_slots` tests in `src/mcp/server.test.ts` pass unchanged — no unplaced rows
      in those fixtures, so no score may move

### Live verification (agent-executable)
Deferred to Phase 5.

### Manual verification
None.

---
*No Manual items — continue straight to Phase 5.*

## Phase 5: Pilot rollout

### What this phase does

Lands the migration on the pilot, deploys, and proves the whole path against real data.

### Changes required

**No source files.** Order is load-bearing (recorded trap): **migration first, then deploy.**

- Apply `20260724130000_unplaced_visits.sql` to the pilot on explicit user go-ahead.
- Deploy, then confirm freshness by byte-comparing the served `/board/static/board.js` against
  `main` (Render "Redeploy" reuses the OLD commit).
- Restart the gateway across the live fleet — the cached `tools/list` hides the new `book_visit`
  schema from chat until it does (`docs/engineering-memory.md`).

### Automated verification
- [ ] `npx supabase migration list --linked` shows `20260724130000` applied
- [ ] on the pilot: `select pg_get_constraintdef(oid) from pg_constraint where conname =
      'no_confirmed_overlap'` shows the `starts_at is not null` predicate

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP; a sandbox with a working spine MCP (s2 = manager-sam) via
  `nemoclaw <sandbox> agent`; the deployed board.
- [ ] From live chat, book a visit for a real pilot customer with the time unsettled **and a day
      promised** (the staging path). Confirm it. Read the row back: `starts_at is null`,
      `earliest_date` set, `promise_level = 'day'`. **Evidence:** the chat exchange and the row.
- [ ] Confirm it appears in `/board/api/bucket` and in `get_team_schedule { unassignedOnly:
      true }`. **Evidence:** both payloads.
- [ ] Place it from chat (a move with real times); read back `starts_at` set, `earliest_date`
      null. **Evidence:** both SQL reads.
- [ ] **Restore the pilot to its pre-probe state** (cancel the probe visit) with a read-back
      proving it.

### Manual verification
- [ ] The "no time yet" strip appears on the right day(s) on the manager's phone, above the grid
- [ ] A visit whose range spans three days reads as **one** visit on each, not three visits
- [ ] A day whose only work is unplaced still renders
- [ ] Tapping an unplaced visit opens the sheet without error, shows the range, and offers Place
- [ ] Assign on an unplaced tray row attaches a person and keeps it unplaced
- [ ] On Ben's technician phone: the strip is **absent** and his day view is unchanged
- [ ] The booking form's "time not settled yet" toggle hides the time inputs and books cleanly
