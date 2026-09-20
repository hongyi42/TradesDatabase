---
date: 2026-09-19
task: Brand the naive-local timestamp species so the compiler refuses a wrong-zone conversion and a cross-species write
research: thoughts/shared/research/2026-09-19-branding-the-two-timestamp-species.md
status: draft
supersedes: nothing
---

## Overview

`visits.starts_at`, `ends_at` and `completed_at` hold the firm's wall clock stamped as if it were
UTC — the `Z` is deliberately false. Every other timestamp in the schema is a real instant. Both
are `string`, so only comments keep them apart, and mixing them is a silent 7-hour error (8 in
winter) on a customer's calendar. This plan gives the naive-local species a compile-time brand so
that converting one with a real timezone, or writing a real instant into a visit time, is a
type error. It lands **after** access plan B.

## Decisions

- **Tier 1, not Tier 2 (operator, 2026-09-19).** Brand `NaiveLocal` only; leave true-UTC values as
  plain `string`. Verified against the real compiler: a plain string still satisfies the wide
  overload, so the ~24 converter call sites compile unchanged and nothing propagates. Rejected
  Tier 2 (brand both species) because its cost is a transitive closure over every function that
  forwards a timestamp toward a converter, unmeasurable until it compiles. What Tier 1 does **not**
  catch, stated plainly: `Date.parse(created_at) < Date.parse(starts_at)` — cross-species
  *comparison*. The six audited comparison sites are correct today and heavily commented. Tier 2
  remains available as a later task, sizeable from real compiler output once this lands.
- **The brand lives in a new zero-dependency `src/db/time.ts`** (my call). It cannot live in
  `src/db/database.types.ts` — `npm run gen:types:local` overwrites that file wholesale. `src/db/`
  because the brand is about what a DB column means, and because `src/db/` is the bottom layer:
  `schedule/` and `writePath/` may import from it, not the reverse. Follows the existing
  `PlacedVisit` precedent (`src/db/visits.ts:216`), which already refines a generated Row with an
  intersection type and is commented "A type, not a comment, so the property is compiler-checked."
- **`naiveLocalISO` moves to `src/db/time.ts`, re-exported from `booking.ts`** (my call). The three
  importers (`plannerSim.ts:52`, `watchers.ts:35`, `attachNote.ts:43`) stay unchanged. The move is
  required because `src/db/visits.ts:1137` needs a producer and `db/` must not import `schedule/`.
- **Option A overloads, verified compiling (operator, 2026-09-19).** A `NaiveLocal` is accepted by
  `localDateISO` / `localDayOfWeek` / `localTimeHHMM` **only** with the literal timezone `'UTC'`;
  the wide overload rejects a `NaiveLocal` via `T & (T extends NaiveLocal ? never : unknown)`.
  Probed against tsc: the three legitimate `'UTC'` callers compile, ordinary plain-string callers
  compile, and `localDateISO(visit.starts_at, firmTz)` is an error naming both overloads.
- **The eight hand-built literals route through named producers (operator, 2026-09-19).**
  `dayStartNaive(localDate)` / `dayEndNaive(localDate)` replace eight hand-written
  `` `${day}T00:00:00.000Z` `` strings and collapse the two clashing day-end conventions
  (`daySource.ts:54` is inclusive `T23:59:59.999Z`; every other site is exclusive next-day
  midnight) onto the exclusive one. Behaviour-neutral: bookings are minute-granular, so no row
  starts in the final millisecond of a day.
- **`visits.started_at` is dropped (operator, 2026-09-19).** Born 2026-06-20, its only writer
  deleted by rung 9b (`c7d69f8`, 2026-09-06) in the same commit that re-created the column. Zero
  readers since. `schema.test.ts:157` asserts it exists; it will assert absence instead, matching
  how `scheduled_at` — the old table's *other* dead column, deliberately not carried over — is
  already pinned at `schema.test.ts:163`.
- **`isTechnicianAvailableOn` keeps its `timezone` parameter** (my call). It gains the same
  overload pair rather than being narrowed to `'UTC'`. Its tests pass plain string literals with a
  real zone, which the wide overload accepts — so `availability.test.ts` needs no changes.
- **No `weekdayOfLocalDate` helper** (my call). `fit.ts:65` and `:75` promote a calendar date to a
  timestamp only to reuse the weekday machinery; once they call `dayStartNaive(dateISO)` they are
  already going through a producer, and a third function would be redundant.
- **The JSONB re-entry points get a named cast, `asNaiveLocal()`** (my call). A value that
  round-trips through a JSONB `detail` blob re-enters as plain `string`
  (`watchers.ts:404-407`, `booking.ts:953-956`). One greppable helper marks every place the species
  is asserted rather than proven. The other two escape channels need nothing: `visitSubjectRef`
  (`nudgeKinds.ts:92`) takes a branded input and emits an opaque key, and the ten `as unknown as`
  casts in `db/visits.ts` land on the branded override by construction.

## Plain-language walkthrough

A "brand" is an invisible label on a type. At runtime `NaiveLocal` is just a string — the label
exists only while the compiler is checking. So `starts_at.slice(11, 16)` keeps working exactly as
it does today; what changes is that handing a visit time to a function expecting a real moment
becomes a red squiggle instead of a wrong appointment.

```
        BEFORE                                   AFTER

  visits.starts_at : string              visits.starts_at : NaiveLocal
  created_at       : string              created_at       : string  (unchanged)
         │                                        │
         ▼                                        ▼
  localDateISO(starts_at, firmTz)        localDateISO(starts_at, firmTz)
         │                                        │
     compiles.                              COMPILE ERROR
     Silently wrong by 7h.                  "No overload matches this call."
```

**Phase 1 — the label and where it comes from.** A new file defines `NaiveLocal` and the only
three functions allowed to make one: `naiveLocalISO` (moved here), plus `dayStartNaive` and
`dayEndNaive` for day boundaries. The `visits` row type is then overridden so its three time
columns carry the label. You would notice this working by the compiler rejecting a plain string
written into a visit time.

**Phase 2 — the doors.** The three timezone converters get a second, stricter signature: they will
take a labelled value only when the timezone is literally `'UTC'` (which makes the conversion do
nothing, and is why the three existing callers are correct). Any other timezone with a labelled
value stops compiling. The six functions that *forward* a timestamp into a converter get the same
treatment, so the label is not quietly erased on the way through.

**Phase 3 — the hand-built day bounds.** Eight places build a day boundary by gluing
`T00:00:00.000Z` onto a date. They become calls to the Phase 1 producers. One of them
(`daySource.ts`) has always used a slightly different day end than the other seven; this is where
that gets settled.

**Phase 4 — the dead column.** `visits.started_at` has had no reader and no writer since
2026-09-06. It is dropped, and the schema test flips from asserting it exists to asserting it does
not — matching the column beside it that was already retired this way.

## Secrets & env preflight

- **Phase 1–3:** none. Pure TypeScript; no service is contacted.
- **Phase 4:** a running local Supabase stack for this worktree (`scripts/second-stack.sh`,
  already provisioned — `supabase/config.toml` carries
  `project_id = "TradesDatabase-brand-the-two-time-8a71e8"`). Values in `.env.test`, written by
  that script. `npm run gen:types:local` regenerates `src/db/database.types.ts` against it. No
  hosted credentials; **the pilot is not touched by this plan.**

## Phase 1: the brand and its producers

### What this phase does
Creates the `NaiveLocal` type and the only functions that may produce one, and puts the brand on
the three `visits` columns that carry the species.

### Changes required

**`src/db/time.ts`** (new — must import nothing, so `db/` stays the bottom layer)
```ts
declare const NAIVE_LOCAL: unique symbol;
/** The firm's wall clock written as if UTC. The trailing `Z` is deliberately false. */
export type NaiveLocal = string & { readonly [NAIVE_LOCAL]: 'naive-local' };

/** THE storage form. Moved from schedule/booking.ts:59, unchanged. */
export function naiveLocalISO(date: string, hhmm: string): NaiveLocal {
  return `${date}T${hhmm}:00.000Z` as NaiveLocal;
}
/** Inclusive start of a firm-local calendar day. */
export const dayStartNaive = (localDate: string): NaiveLocal => naiveLocalISO(localDate, '00:00');
/** EXCLUSIVE end — the next day's 00:00. The one day-end convention. */
export const dayEndNaive = (localDate: string): NaiveLocal =>
  new Date(Date.parse(dayStartNaive(localDate)) + 86_400_000).toISOString() as NaiveLocal;

/** Re-assert the species on a value that round-tripped through JSONB and lost its type. */
export const asNaiveLocal = (s: string): NaiveLocal => s as NaiveLocal;
```

**`src/db/index.ts`** — add `export * from './time.js';` beside line 9.

**`src/db/visits.ts`**
- Import `NaiveLocal` from `./time.js`.
- Replace line 8 with the override:
```ts
type VisitRow = Database['public']['Tables']['visits']['Row'];
export type Visit = Omit<VisitRow, 'starts_at' | 'ends_at' | 'completed_at'> & {
  starts_at: NaiveLocal | null;
  ends_at: NaiveLocal | null;
  completed_at: NaiveLocal | null;
};
```
- `PlacedVisit` (line 216) needs no change — verified: `(NaiveLocal | null) & string` narrows to
  `NaiveLocal`.
- `CreateVisitInput.startsAt/endsAt/completedAt` (lines 241, 242, 250) → `NaiveLocal | null`.
- `MoveVisitRowInput.startsAt/endsAt` (lines 392-393) → `NaiveLocal`.
- `updateVisitStatus`'s `completedAt` (line 335) and `expectedTimes` (line 339) → `NaiveLocal`.
- The nine functions returning `Promise<Visit…>` (lines 258, 313, 340, 439, 529, 589, 649, 693,
  769) return PostgREST's generated Row; add `as unknown as Visit` at each, matching the ten casts
  already in this file. Writes need nothing — `NaiveLocal` is assignable to the generated Insert's
  `string` (verified).

**`src/schedule/booking.ts`**
- Delete the local `naiveLocalISO` (lines 58-61); add `export { naiveLocalISO } from '../db/time.js';`
  so `plannerSim.ts:52`, `watchers.ts:35` and `attachNote.ts:43` are untouched.
- `ResolvedBooking.startISO/endISO` (lines 285-286) and `ResolvedMove.startISO/endISO`
  (lines 675-676) → `NaiveLocal | null` / `NaiveLocal`.

**`src/db/time.test.ts`** (new) — lock the brand in with negative compile assertions. `tsconfig`
includes `src`, so `@ts-expect-error` **fails `npm run typecheck` if the line stops erroring**,
which is exactly the regression guard this task exists to install:
```ts
declare const anyVisit: Visit;
// @ts-expect-error a real instant may not be written into a visit time
const bad: NaiveLocal = new Date().toISOString();
expect(naiveLocalISO('2026-09-19', '09:00')).toBe('2026-09-19T09:00:00.000Z');
expect(dayEndNaive('2026-09-19')).toBe('2026-09-20T00:00:00.000Z');
```

### Automated verification
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `src/db/time.test.ts` passes, including its `@ts-expect-error` assertions
- [ ] `grep -rn "naiveLocalISO" src/ --include="*.ts"` shows the three original importers unchanged

### Live verification (agent-executable)
- None. This phase contacts no service; the compiler is the verification.

### Manual verification
- None.

---
*Manual list empty — continue.*

## Phase 2: the doors

### What this phase does
Gives the three timezone converters, and the six functions that forward a timestamp into them, a
signature that accepts a branded value only with the literal timezone `'UTC'`.

### Changes required

**`src/schedule/availability.ts`** — overload each of `localDayOfWeek` (line 39), `localDateISO`
(line 50) and `localTimeHHMM` (line 62). Verified against tsc:
```ts
export function localDateISO(iso: NaiveLocal, tz: 'UTC'): string;
export function localDateISO<T extends string>(
  iso: T & (T extends NaiveLocal ? never : unknown),
  tz: string,
): string;
export function localDateISO(isoTimestamp: string, timezone: string): string {
  /* body unchanged */
}
```
- `isTechnicianAvailableOn` (line 145) gets the same overload pair on its first and fourth
  parameters. Its body is unchanged; `availability.test.ts` needs no changes (its literals are
  plain strings, which the wide overload accepts).

**The five remaining forwarding functions** — same overload pair, bodies unchanged:
- `src/writePath/attachNote.ts:73` `noteLocalOf(capturedAt, timezone)` → returns `NaiveLocal`
- `src/jobs/watchers.ts:366` the `naiveLocal` closure → returns `NaiveLocal`
- `src/teamLead/planner.ts:922` `firmStamp(iso, tz)`
- `src/teamLead/planner.ts:1243` `departureDate(iso, tz)`
- `src/eval/plannerSim.ts:96` and `:109` the local helpers

**`src/db/time.test.ts`** — add the door's negative assertions:
```ts
declare const naive: NaiveLocal;
localDateISO(naive, 'UTC');            // legal: the conversion is a no-op
// @ts-expect-error a wall clock may not be converted with a real zone
localDateISO(naive, 'America/Los_Angeles');
// @ts-expect-error same door, weekday form
localDayOfWeek(naive, 'America/Los_Angeles');
```

### Automated verification
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes — `availability.test.ts`, `fit.test.ts`, `booking.test.ts`,
      `watchers.test.ts` and `recordFieldNote.test.ts` unchanged and green
- [ ] the three `@ts-expect-error` assertions in `src/db/time.test.ts` still error

### Live verification (agent-executable)
- None. No behaviour changes; every overload erases at runtime.

### Manual verification
- None.

---
*Manual list empty — continue.*

## Phase 3: the hand-built day bounds

### What this phase does
Replaces eight hand-written day-boundary literals with the Phase 1 producers, settling the two
clashing day-end conventions onto the exclusive one.

### Changes required

| File | Line(s) | Today | Becomes |
|---|---|---|---|
| `src/schedule/boardRead.ts` | 166-167 | `` `${from}T00:00:00.000Z` ``, `Date.parse(...) + 86_400_000` | `dayStartNaive(from)`, `dayEndNaive(toDay)` |
| `src/schedule/boardRead.ts` | 371 | `'1970-01-01T00:00:00.000Z'` | `dayStartNaive('1970-01-01')` |
| `src/schedule/fit.ts` | 390-391 | `` `${earliest}T00:00:00.000Z` ``, `addDaysISO(latest,1) + '…'` | `dayStartNaive(earliest)`, `dayEndNaive(latest)` |
| `src/schedule/fit.ts` | 478-479 | same pair | same |
| `src/schedule/fit.ts` | 65, 75 | `localDayOfWeek(\`${dateISO}T00:00:00.000Z\`, 'UTC')` | `localDayOfWeek(dayStartNaive(dateISO), 'UTC')` |
| `src/db/visits.ts` | 1137 | `` `starts_at.gte.${todayLocal}T00:00:00.000Z` `` | `` `starts_at.gte.${dayStartNaive(todayLocal)}` `` |
| `src/writePath/identityMatch.ts` | 224-225 | `` `${day}T00:00:00.000Z` `` + round-trip | `dayStartNaive(day)`, `dayEndNaive(day)` |
| `src/routes/daySource.ts` | 53-54 | `` `…T00:00:00.000Z` ``, **inclusive** `` `…T23:59:59.999Z` `` | `dayStartNaive(from)`, `dayEndNaive(to)` — **the convention change** |

`listVisitsForTechnician` (`src/db/visits.ts:966`) filters `.lt('starts_at', toISO)`, so the
`daySource` change widens the upper bound by one millisecond. No booking starts in the final
millisecond of a day (`HHMM_RE`, `booking.ts:56`, is minute-granular), so the row set is identical.

**`src/routes/daySource.test.ts`** (or `boardApi.test.ts`, whichever covers `listDayStops`) — add a
case pinning a 23:30 visit on the last day of the range as included, so the bound change is
locked by a test rather than by the reasoning above.

### Automated verification
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] the new `listDayStops` last-day boundary test passes
- [ ] `grep -rn 'T00:00:00\.000Z' src/ --include="*.ts" | grep -v test | grep -v eval/` returns
      only `src/db/time.ts`

### Live verification (agent-executable)
- Prerequisites: this worktree's local Supabase stack running (`npx supabase start`), `.env.test`.
- [ ] `npm run seed:local`, then read the board for a seeded date range through `readBoardDays` and
      confirm the same visit set as before the change — capture both row counts as evidence.

### Manual verification
- None.

---
*Manual list empty — continue.*

## Phase 4: drop the dead column

### What this phase does
Removes `visits.started_at`, which has had no reader and no writer since rung 9b re-created it and
deleted its writer in the same commit.

### Changes required

**`supabase/migrations/20260919180000_drop_visits_started_at.sql`** (new — version number must not
collide with a sibling worktree's; the ledger keys on the number, not the filename, and two
branches silently skipping each other's migration is a recorded trap):
```sql
-- started_at came across in 20260906140000 with the old per-note table's column
-- list, in the same commit that deleted its only writer (CreateVisitInput.startedAt).
-- Zero readers and zero writers since. Its sibling dead column, scheduled_at, was
-- deliberately not carried over — this closes the inconsistency.
alter table visits drop column if exists started_at;
```

**`src/db/schema.test.ts`**
- Line 157: `expect(cols.get('started_at')?.data_type).toBe('timestamp with time zone');` becomes
  `expect(cols.get('started_at'), 'started_at was never written after rung 9b').toBeUndefined();`
- Move it beside the `scheduled_at` assertion (line 163) and extend that block's comment to name
  both retired columns.

**`src/db/database.types.ts`** — regenerated by `npm run gen:types:local`; commit the result.

### Automated verification
- [ ] `npx supabase migration up` applies cleanly against this worktree's stack
- [ ] `npm run gen:types:local` produces a diff removing `started_at` from `visits`' Row/Insert/Update
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes, including the flipped `schema.test.ts` assertion
- [ ] `npm run build` passes (pre-PR gate)

### Live verification (agent-executable)
- Prerequisites: this worktree's local stack; `supabase-test` MCP is **not** used — the pilot is
  not touched by this plan.
- [ ] Before applying: query the local stack for `count(started_at) from visits` and record it. A
      non-zero count means the column is not dead here and the phase **stops** for the operator.

### Manual verification
- [ ] Operator confirms the pilot's `visits.started_at` is also all-NULL before this migration is
      rolled out. Deploys run no migrations (`deploy-does-not-migrate`), so the rollout is a
      separate, operator-run step — not part of this task.

---
*Manual list non-empty — pause here for the operator.*
