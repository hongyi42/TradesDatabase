---
date: 2026-09-19
branch: work/brand-the-two-timestamp-species-so-the-c
commit: 3a006ed
topic: The two timestamp species (naive-local vs true UTC) as the code holds them today — producers, converters, call sites, escape channels, and what a compile-time brand could and could not reach
supersedes: nothing
---

## Summary

The database stores two different kinds of timestamp in one column type. **True UTC** values
(`created_at`, `captured_at`, `noticed_at`, `expires_at`, `now()`) are real instants — a moment
that happened. **Naive-local** values (`visits.starts_at`, `visits.ends_at`,
`visits.completed_at`) are the firm's wall clock written *as if* it were UTC: a 9 AM appointment
in Los Angeles is stored as `2026-09-19T09:00:00.000Z`, and the `Z` is deliberately false. The
convention exists so that anything grouping by UTC calendar day gets the firm's local day for
free, with no timezone arithmetic anywhere.

Both are typed `string` in TypeScript. Nothing but a comment distinguishes them, and mixing them
is a silent 7-hour error for a Pacific firm in summer, 8 in winter. This document records how the
code keeps them apart today: which values carry which species, every function that produces or
converts one, every place the distinction is load-bearing, and the three channels through which a
value leaves the type system entirely. It also records the one time this bug class actually fired
in production code (2026-09-17, in a SQL view) and the archaeology of `visits.started_at`, a
fourth timestamp column that has no species because nothing has written it since 2026-09-06.

## Entry Points

The species boundary is crossed at exactly these places:

| Direction | Function | Location |
|---|---|---|
| **Produce naive-local** | `naiveLocalISO(date, hhmm)` | `src/schedule/booking.ts:59` |
| **Instant → naive-local** | `noteLocalOf(capturedAt, tz)` | `src/writePath/attachNote.ts:73` |
| **Instant → naive-local** | `naiveLocal(iso)` (closure over `tz`) | `src/jobs/watchers.ts:366-367` |
| **Instant → naive-local** | `plannerSim`'s local helper | `src/eval/plannerSim.ts:96` |
| **Instant → local date** | `localDateISO(iso, tz)` | `src/schedule/availability.ts:50` |
| **Instant → local HH:MM** | `localTimeHHMM(iso, tz)` | `src/schedule/availability.ts:62` |
| **Shape guard on any input** | `parseAsUtc(stamp)` | `src/schedule/availability.ts:31` |
| **Naive-local → display** | `wallClock(ts)` | `src/schedule/booking.ts:1337` |

The generated row types both species live in: `src/db/database.types.ts` (`visits` Row at
line 2874).

## Key Files

**`src/schedule/availability.ts`** (160 lines) — the zone helpers and the shape guard. Exports
`parseAsUtc`, `localDayOfWeek`, `localDateISO`, `localTimeHHMM`, `isTechnicianAvailableOn`,
`summarizeWeeklyPattern`. Its 20-line header (lines 8-27) is the repo's canonical statement of why
every timestamp carries an offset: per ECMA-262 an offset-less date-time is parsed on the *host's*
clock, so `2026-08-24T07:00:00` means a different instant on a Tokyo laptop than on a UTC server.
`parseAsUtc` makes the rule explicit — an offset-less date-time is read as UTC, everything else
goes to `Date.parse` untouched. All three zone helpers route through it.

**`src/schedule/booking.ts`** (1530 lines) — owns the naive-local storage format. `naiveLocalISO`
(line 59) is pure string concatenation with zero timezone math. Its header (lines 9-12) states the
convention and the `'UTC'` trick. Also exports `visitDay`, `wallClock`, `spanMinutes`,
`addMinutesClamped`, `cancelRequiresConfirmation`. `availabilityWarning` (line 169) contains the
dual-use call described below.

**`src/db/visits.ts`** (1521 lines, 46 timestamp references) — the typed accessor layer. `Visit` is
`Database['public']['Tables']['visits']['Row']` (line 8). Contains the existing type-refinement
precedent: `PlacedVisit = Visit & { starts_at: string; ends_at: string }` (line 216), commented
"A type, not a comment, so the property is compiler-checked." Ten `as unknown as` casts sit at the
PostgREST boundary where embedded selects are re-typed.

**`src/jobs/watchers.ts`** (910 lines) — the overdue-visit sweep, and the densest concentration of
cross-species work. Defines `naiveLocal` and `minuteFloor` as tz-closed local helpers (lines
366-373), converts `created_at` through `naiveLocal` before comparison (line 418), and computes
`floorUtcIso` (line 451) — a naive floor widened by `MAX_UTC_OFFSET_MS` (14h, line 162) so a
DB-side true-UTC filter over-fetches and the precise comparison happens in JS.

**`src/writePath/attachNote.ts`** (145 lines) — `noteLocalOf` (line 73) is the documented boundary
door. Header lines 68-72 name the trap directly: comparing a real `capturedAt` against a
naive-local `starts_at` makes an 08:00 note look like it came after a 09:00 visit.

**`src/writePath/identityMatch.ts`** (279 lines) — lines 208-226 convert `capturedAt` to a local
day, then hand-build naive-local day bounds for a `listVisitsForTechnician` call.

**`src/schedule/fit.ts`** (624 lines) — `clampRowToDay` (line 322) compares instants rather than
strings, with a reproduced review finding in its comment explaining why (PostgREST renders
`+00:00`, local literals end `.000Z`, and ASCII `'+' < '.'` misclassified midnight-aligned rows).

**`src/routes/daySource.ts`** (92 lines) — hand-builds naive-local bounds with an *inclusive*
`T23:59:59.999Z` day end (line 54).

**`src/schedule/boardRead.ts`** (571 lines) — hand-builds naive-local bounds with an *exclusive*
next-day `T00:00:00.000Z` end (lines 166-167), and a `1970-01-01T00:00:00.000Z` epoch sentinel
(line 371).

**`src/jobs/nudgeKinds.ts`** (163 lines) — `visitSubjectRef(visitId, startsAt)` (line 92) embeds a
naive-local value inside a composite string key.

**`supabase/migrations/20260906140000_the_visit_is_one_object.sql`** — the only SQL that declares a
species: `comment on column visits.completed_at` (lines 76-77). Also the migration that re-added
`started_at` (line 71).

**`supabase/migrations/20260917140000_retrieval_layer_schedule.sql`** — records the one live
occurrence of this bug class (header lines 14-23).

## Data Flows

### The three shapes that actually flow

The task framing names two species. The code carries four distinct string shapes:

```
  Instant          "2026-09-19T16:00:00.000Z"   a real moment. created_at, captured_at,
                   or "...+00:00" from PostgREST  noticed_at, expires_at, revoked_at, now()

  NaiveLocal       "2026-09-19T09:00:00.000Z"   the firm's wall clock, Z is a lie.
                   or "...+00:00" from PostgREST  visits.starts_at / ends_at / completed_at

  LocalDate        "2026-09-19"                  a calendar day. time-off ranges, local_day,
                                                 servedDayPhrase input, board from/to

  WallClockText    "2026-09-19 09:00"            display only; wallClock(). Deliberately has
                                                 no T and no Z so a model cannot read an offset
```

Both `Instant` and `NaiveLocal` have **two renderings each** — PostgREST returns `+00:00`,
locally-built literals end `.000Z`. That is why comparisons parse rather than string-compare, and
it is documented at three separate sites (`fit.ts:323-328`, `watchers.ts:465-467`,
`recordFieldNote.ts:849-850`).

### Producing a naive-local value

```
  manager states a day + time
        │
        ▼
  naiveLocalISO(date, hhmm) ──▶ `${date}T${hhmm}:00.000Z` ──▶ visits.starts_at / ends_at
   booking.ts:59                  pure concatenation, no tz math
   (4 call sites, all in booking.ts: 408, 409, 734, 735)

  a real capture instant
        │
        ▼
  localDateISO(iso, tz) + localTimeHHMM(iso, tz)
        │                         the two tz-aware doors, both require an explicit tz
        ▼
  naiveLocalISO(day, hhmm) ──▶ noteLocal ──▶ visits.completed_at
   3 composition sites: attachNote.ts:74, watchers.ts:367, plannerSim.ts:96
```

### The dual-use converter — `localDateISO` has two callers of different species

`localDateISO(iso, tz)` is documented as taking a real instant. Twenty-three of its twenty-four
non-test call sites do exactly that. One does not:

```
  booking.ts:408   startISO = naiveLocalISO(date, startTime)     ← a NaiveLocal
        │
        ▼
  booking.ts:445   availabilityWarning(t, input.date, startISO)
        │
        ▼
  booking.ts:175   isTechnicianAvailableOn(startISO, …, 'UTC')   ← tz is LITERALLY 'UTC'
        │
        ▼
  availability.ts:152   localDateISO(isoTimestamp, 'UTC')        ← conversion is a NO-OP,
                                                                   so the lie reads as truth
```

This is deliberate and documented twice — `booking.ts:12` ("availability checks interpret these
timestamps with timezone 'UTC'") and `booking.ts:167-168`. It is correct: passing `'UTC'` makes
`localDateISO` return the stored digits, which *are* the local day. `isTechnicianAvailableOn` is
called from exactly one production site. Its own test file (`availability.test.ts:50-84`) exercises
it in the *opposite* mode — real UTC instants with a real zone — which no production caller uses.

### Naive-local values not produced by `naiveLocalISO`

The task notes state `naiveLocalISO` is the only producer. It is not. Eight non-test sites
hand-build a naive-local value as a string literal, all of them day boundaries fed into a
`starts_at`/`ends_at` query:

| Site | Value built | Day-end convention |
|---|---|---|
| `src/schedule/boardRead.ts:166` | `` `${from}T00:00:00.000Z` `` | — |
| `src/schedule/boardRead.ts:167` | next-day via `Date.parse(...) + 86_400_000` → `.toISOString()` | exclusive |
| `src/schedule/boardRead.ts:371` | `'1970-01-01T00:00:00.000Z'` | epoch sentinel |
| `src/schedule/fit.ts:390-391` | `` `${earliest}T00:00:00.000Z` ``, `addDaysISO(latest,1) + 'T00:00:00.000Z'` | exclusive |
| `src/schedule/fit.ts:478-479` | same pair | exclusive |
| `src/db/visits.ts:1137` | `` `starts_at.gte.${todayLocal}T00:00:00.000Z` `` | inside a PostgREST `.or()` filter string |
| `src/writePath/identityMatch.ts:224-225` | `` `${day}T00:00:00.000Z` `` + next-day round-trip | exclusive |
| `src/routes/daySource.ts:53-54` | `` `${from}T00:00:00.000Z` ``, `` `${to}T23:59:59.999Z` `` | **inclusive** |

`daySource.ts` is the only one using an inclusive `23:59:59.999` end; every other site uses an
exclusive next-day bound. `src/eval/clock.ts:243` is a verbatim second copy of `naiveLocalISO`'s
body in the eval harness.

### Where a value leaves the type system

Three channels carry a naive-local value out of TypeScript's reach and back:

```
 1. JSONB round-trip
    watchers.ts:404-407   d.startsAtLocal comes out of an observation's `detail` blob as
                          `typeof d.startsAtLocal === 'string'` — re-enters as plain string,
                          asserted into the species by convention alone.
    booking.ts:953-956    UnscheduleVisitInput.expectedTimes carries raw column values
                          through a review-item detail and back for a compare-and-set.

 2. Composite string key
    nudgeKinds.ts:92      visitSubjectRef(visitId, startsAt) → `<uuid>@<naive-local>`
                          Written at watchers.ts:625, read back by visitIdOfSubject.
                          Also observations.ts:99 for the offboarding subject.

 3. PostgREST boundary
    db/visits.ts          10 × `as unknown as` where embedded selects are re-typed.
                          Whatever the Row type claims, the value arrives as parsed JSON.
```

### The typed layer vs the view layer

```
   TypeScript code ──▶ src/db/*.ts ──▶ supabase client ──▶ visits table
                         typed Row                          starts_at (naive-local)
                         ▲
                         └── a brand reaches here

   model-written SQL ──▶ spine_read / query_spine ──▶ v_schedule, v_cancelled_visits,
        (a string)                                    v_visit_participants
                                                      ▲
                                                      └── no TypeScript call site exists
```

There is **no `.from('v_…')` anywhere in `src/`**. The `v_*` views are reached only through
`spine_read` / `query_spine`, where the query is a string composed by a language model at runtime.
The views' generated Row types are never instantiated by any typed call site.

## External Dependencies

- **`Intl.DateTimeFormat`** (Node built-in) — owns all timezone and DST arithmetic in
  `localDateISO`, `localTimeHHMM`, `localDayOfWeek`. The header at `availability.ts:36-38` records
  that hand-rolled offset arithmetic is what broke the predecessor module.
- **PostgREST / `@supabase/supabase-js`** — renders `timestamptz` as `…+00:00` (no milliseconds),
  which is why every cross-shape comparison parses instead of string-comparing.
- **`supabase gen types typescript`** — regenerates `src/db/database.types.ts` wholesale via
  `npm run gen:types` (linked/pilot) or `npm run gen:types:local` (`package.json:21-22`).
- **TypeScript 5.x, `strict: true`** (`tsconfig.json`) — no `strictNullChecks` exemptions; branded
  intersection types are supported and erase at runtime.

## Constraints and Invariants

1. **The `Z`/`+00` on a visit time is false, and the code says so at eight separate sites.**
   `booking.ts:10-12`, `db/visits.ts:241/249`, `attachNote.ts:68-72`, `watchers.ts:164-172`,
   `boardRead.ts:271`, `fit.ts:323-328`, `daySource.ts:8-10`, `mcp/server.ts:4816-4820`.

2. **The model never sees a raw visit timestamp.** Every model-facing surface serves slices
   (`row.starts_at.slice(11,16)`) or `wallClock()` output. This exists because of a live incident
   on 2026-07-22: the agent read the `+00:00`, called a 4 PM visit "4:00 PM UTC" and invented a
   "9 AM Pacific" conversion for the manager (`mcp/server.ts:4816-4820`). The fix was to withhold
   the offset, not to explain timezones.

3. **No SQL anywhere compares a visit time to `now()`.** Verified across all migrations — zero
   hits. This is the easiest and most invisible way to get the species wrong, and it is absent.

4. **`parseAsUtc` is the shape guard, not a species guard.** It ensures an offset-less string is
   read as UTC rather than host-local. It cannot and does not distinguish the two species — both
   arrive offset-stamped.

5. **Both sides of a naive-vs-naive comparison are parsed the same way, so any offset cancels.**
   Recorded explicitly in `docs/engineering-memory.md:4318-4320` as "explicitly not affected, and
   left alone."

6. **`MAX_UTC_OFFSET_MS` (14h) absorbs the species gap at one DB boundary.** `watchers.ts:451`
   widens a naive floor by the maximum legal UTC offset so a true-UTC DB filter over-fetches, and
   the precise comparison happens in JS.

7. **The audit's six parse sites are still correct today.** Re-verified at `fit.ts:329-333`,
   `attachNote.ts:101-104`, `recordFieldNote.ts:857-858`, `watchers.ts:444`, `watchers.ts:457`,
   `watchers.ts:465-470`. Line numbers have drifted from the 2026-09-10 audit; the behaviour has
   not.

8. **`npm run typecheck` is clean at `3a006ed`** — the baseline is green.

9. **This bug class has fired exactly once in recorded history, and it fired in SQL.**
   `20260917140000_retrieval_layer_schedule.sql:14-23` — `v_schedule.local_day` and
   `v_cancelled_visits.local_day` converted naive-local `starts_at` with
   `at time zone <firm tz>`, as if the stored value were a real instant. A 06:00 visit for a
   Pacific firm read as the *previous day*; for a UTC+ firm a late-evening visit read as the next.
   Verified on a local stack 2026-09-15 (`'2026-09-15 06:00+00'` → `2026-09-14`), fixed to
   `at time zone 'UTC'`. It shipped 2026-09-06 and was found 2026-09-15 — nine days live. The
   symptom looked like a model date error, not a view bug. A TypeScript brand has no reach into a
   view definition.

10. **`visits.started_at` has no species and no code.** Archaeology:
    - **2026-06-20** (`20260620005307_context_spine.sql:81`, commit `dbb2abe`) — born on the
      original `visits` table, with a writer: `CreateVisitInput.startedAt` →
      `started_at: input.startedAt ?? null`.
    - **2026-09-06** (`20260906140000_the_visit_is_one_object.sql:47,71`, commit `c7d69f8`,
      PR #206, rung 9b) — old `visits` dropped, `assignments` renamed to `visits`, and the
      happened-stage columns re-added: `started_at, completed_at, labor_hours, attributes`. The
      **same commit** deleted the only writer (`- startedAt?: string | null;`,
      `- started_at: input.startedAt ?? null,`). `completed_at` received a species comment
      (lines 76-77); `started_at` received none, and no backfill.
    - **Today** — zero readers, zero writers in `src/`. The sole reference is
      `src/db/schema.test.ts:157`, asserting the column is `timestamp with time zone`.

11. **Plan B touches no naive-local value.** Every timestamp in
    `src/teamLead/accessDesk.ts`, `src/db/accessRequests.ts` and `src/mcp/tools/access.ts` is a
    true instant: `new Date().toISOString()`, `Date.now()`, `created_at`, `noticed_at`,
    `expires_at`, `revoked_at`. Its only contact with the converter surface is
    `localDateISO(Instant, tz)` — 2 sites on main (`access.ts:183, 349`), 3 more in the sibling
    worktree's uncommitted phase-2 work, 2 in `accessDesk.ts` (lines 310, 337). All feed
    `servedDayPhrase(LocalDate)`.

12. **`access_grants` adds true-UTC columns after the task was written**: `expires_at`,
    `revoked_at`, `created_at` (`database.types.ts:37-54`).

## Decision Points

**1. Where the brand physically lives.** `Visit` derives from `src/db/database.types.ts`, which
`npm run gen:types:local` overwrites wholesale. A brand written into that file is destroyed by the
next regeneration. Options given the code as it stands: an override type in `src/db/visits.ts`
(hand-written, survives regeneration, and follows the existing `PlacedVisit` precedent at
`visits.ts:216` which already refines the generated Row with an intersection); or a
post-processing step wired into the `gen:types` scripts (`package.json:21-22`).

**2. Whether the `v_*` views are in scope.** They carry the same naive-local columns, but no
TypeScript call site instantiates their Row types — the only readers are model-written SQL strings
through `spine_read`. Branding them would add overrides that no compiler check consumes. Leaving
them unbranded leaves them exactly as protected as they are today: by the precomputed `local_day`
/ `local_weekday` columns, the prompt rule at `mcp/server.ts:251-254`, and the withheld offset.
This is also the layer where the bug class actually fired (constraint 9).

**3. What `localDateISO` accepts.** Twenty-three call sites pass an instant; `booking.ts:175`
passes a naive-local with `tz: 'UTC'` on purpose. Options: type the parameter as an instant and
give the wall-clock read its own named door (the value it computes is
`naive.slice(0, 10)`); type the parameter as accepting either species; or leave the signature
unbranded and brand only its return.

**4. Whether `isTechnicianAvailableOn` keeps its `timezone` parameter.** It has one production
caller, which always passes `'UTC'`. Its test file exercises the other mode exclusively.

**5. Whether the eight hand-built naive-local literals route through a producer.** They are
day-boundary values feeding `starts_at`/`ends_at` queries, built as string literals at eight sites
with two different day-end conventions (inclusive at `daySource.ts:54`, exclusive everywhere
else). A brand on the query parameters would require each to go through a producer or a cast.

**6. What happens at the three escape channels.** A JSONB round-trip, a composite `subject_ref`
string, and the PostgREST `as unknown as` casts each return a plain `string` that is asserted into
a species by convention. Each is a point where a brand must be re-applied by hand, and each is a
place where the assertion could be wrong without the compiler noticing.

**7. `visits.started_at`.** The column exists, has no species comment, no reader, no writer, and
one schema-test assertion. Options: drop the column and its assertion (a migration against a table
the pilot uses); give it a species and leave it; or leave it exactly as is.

**8. Ordering against plan B.** Plan B is unmerged, its phase 1 is committed in the sibling
worktree, and its phase 2 is uncommitted work-in-progress that is still adding `localDateISO` call
sites. Every one of those sites passes an instant. The converter signature decision (point 3) is
the only part of this task whose blast radius grows while plan B is in flight.

## Open Questions

- **Does any pilot or local row have a non-null `visits.started_at`?** The column had a writer
  between 2026-06-20 and 2026-09-06, but rung 9b dropped the old table and re-created the column
  on the renamed `assignments` table — so the old values did not carry over. Whether any row
  written since 2026-09-06 has a value cannot be answered by reading code; it needs a query
  against a stack.
- **Does `strict` TypeScript flag the `as unknown as` casts in `db/visits.ts` once the target type
  is branded?** The double cast is precisely the escape hatch that silences brand mismatches, so
  the casts would continue to compile — whether that is acceptable is a judgment the code cannot
  answer.
- **Is `availability.test.ts`'s true-UTC-plus-real-zone mode testing a contract, or a path?**
  Reading alone cannot tell whether those cases were written to pin general behaviour deliberately
  or because the author assumed that mode was in use.
- **How many of the 162 non-test call sites actually change?** Most read a branded value and slice
  or interpolate it, which compiles unchanged. The count that *breaks* is the count of places a
  plain `string` is assigned into a branded position, and that cannot be established by grep — it
  needs the compiler.
