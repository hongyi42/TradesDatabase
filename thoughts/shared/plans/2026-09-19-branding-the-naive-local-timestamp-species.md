---
date: 2026-09-19
task: Brand the naive-local timestamp species so the compiler refuses a wrong-zone conversion and a cross-species write
research: thoughts/shared/research/2026-09-19-branding-the-two-timestamp-species.md
status: approved
supersedes: nothing
---

## Overview

`visits.starts_at`, `ends_at` and `completed_at` hold the firm's wall clock stamped as if it were
UTC — the `Z` is deliberately false. Every other timestamp in the schema is a real instant. Both
are `string`, so only comments keep them apart, and mixing them is a silent 7-hour error (8 in
winter) on a customer's calendar. This plan gives the naive-local species a compile-time brand so
that converting one with a real timezone, or writing a real instant into a visit time, is a type
error. It lands **after** access plan B.

Every claim below was checked against the real compiler (an adversarial review built an isolated
tree and applied phases 1–3); the counts and line numbers are measured, not estimated.

## Decisions

- **Tier 1, not Tier 2 (operator, 2026-09-19).** Brand `NaiveLocal` only; leave true-UTC values as
  plain `string`. A plain string still satisfies the wide overload, so the ~24 converter call sites
  compile unchanged and nothing propagates. What Tier 1 does **not** catch: cross-species
  *comparison*. `Date.parse(s: string)` accepts any branded string, so
  `Date.parse(created_at) < Date.parse(starts_at)` compiles under Tier 1 **and Tier 2 alike** — an
  earlier version of this plan said Tier 2 would catch it and was wrong. Closing that needs typed
  comparison helpers plus a lint rule banning raw `Date.parse` on these values; out of scope here.
- **Read side AND write side (operator, 2026-09-20).** `CreateVisitInput` / `MoveVisitRowInput` /
  `updateVisitStatus` take `NaiveLocal`, which costs ~146 mechanical test-fixture edits (phase 5).
  Measured breakdown of the 239 compiler errors: **80 are `null`** (already assignable, zero work),
  **~55 go through 6 fixture helpers** (6 edits), **119 raw string literals** and **27 template
  literals** (two regex passes), **~9 variables** (type the variable).
- **The brand lives in a new zero-dependency `src/db/time.ts`** (my call). It cannot live in
  `src/db/database.types.ts` — `gen:types:local` overwrites that file wholesale. Follows the
  existing `PlacedVisit` precedent (`src/db/visits.ts:216`), already an intersection refinement of
  a generated Row, commented "A type, not a comment, so the property is compiler-checked."
  *(Correction to the draft: the justifying claim "`src/db/` is the bottom layer, `schedule/` may
  not import from it" is false — `db/context.ts:22` imports `schedule/availability.js` today. The
  real requirement is narrower and is met: `time.ts` imports nothing, and availability.ts's new
  import is type-only, so it erases.)*
- **`naiveLocalISO` moves to `src/db/time.ts`, re-exported from `booking.ts`.** Required because
  `db/visits.ts:1137` needs a producer. **Four** importers keep working unchanged, not three:
  `plannerSim.ts:52`, `watchers.ts:35`, `attachNote.ts:43`, and `booking.test.ts:26`.
- **Option A overloads, verified compiling.** A `NaiveLocal` is accepted by the three converters
  **only** with the literal timezone `'UTC'`; the wide overload rejects a `NaiveLocal` via
  `T & (T extends NaiveLocal ? never : unknown)`. Probed: the legitimate `'UTC'` callers compile,
  ordinary plain-string callers compile, and `localDateISO(visit.starts_at, firmTz)` errors naming
  both overloads. A `tz` widened to `string` also fails the narrow overload — the door needs the
  **literal**, which is what makes it tight.
- **Overloads go only where a NaiveLocal can actually arrive.** The draft said "same overload pair"
  for every forwarder. Two corrections: `watchers.ts:366` is a **`const` arrow**, where overload
  syntax is `TS1005: '=>' expected` — and it needs none, since every caller passes a real instant;
  only its **return type** changes. Same for `firmStamp` (`planner.ts:922`) and `departureDate`
  (`planner.ts:1243`), which take instants exclusively and return `string | null`.
- **`availabilityWarning` (`booking.ts:169`) DOES need the pair** — the draft missed it, and it is
  the one production forwarder that carries a NaiveLocal. `resolveBooking` hands it `r.startISO`
  (branded), its `startISO: string` parameter widens the brand away, and it reaches
  `isTechnicianAvailableOn(…, 'UTC')` unbranded. Leaving it is leaving the exact hole this task
  exists to close.
- **`isTechnicianAvailableOn` keeps its `timezone` parameter** and gains the pair. Its tests pass
  plain string literals with a real zone, which the wide overload accepts, so
  `availability.test.ts` needs **no changes**.
- **No `weekdayOfLocalDate` helper.** Once `fit.ts:65`/`:75` call `dayStartNaive(dateISO)` they are
  already going through a producer; a third function would be redundant.
- **The JSONB re-entry points get one named cast, `asNaiveLocal()`** — `watchers.ts:404-407` and
  `booking.ts:953-956`/`:1016`. One greppable helper marks every place the species is asserted
  rather than proven. The other two escape channels need nothing: `visitSubjectRef`
  (`nudgeKinds.ts:92`) takes `string | null` and merely *accepts* a branded value by widening
  (the draft overstated this), and the casts in `db/visits.ts` land on the branded override.
- **`visits.started_at` is dropped (operator, 2026-09-19).** Born 2026-06-20, its only writer
  deleted by rung 9b (`c7d69f8`) in the same commit that re-created the column; zero readers since.
  `schema.test.ts:157` will assert absence, matching how `scheduled_at` is pinned at `:163`.

## Plain-language walkthrough

A "brand" is an invisible label on a type. At runtime `NaiveLocal` is just a string — the label
exists only while the compiler is checking. `starts_at.slice(11, 16)` keeps working exactly as it
does today; what changes is that handing a visit time to something expecting a real moment becomes
a red squiggle instead of a wrong appointment.

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
functions allowed to make one. The `visits` row type and the write-path inputs carry the label.
You would notice it working by the compiler rejecting a plain string written into a visit time.

**Phase 2 — the doors.** The three timezone converters take a labelled value only when the
timezone is literally `'UTC'` (which makes the conversion do nothing — why the existing callers are
correct). Any other timezone with a labelled value stops compiling.

**Phase 3 — the hand-built day bounds.** Eight places glue `T00:00:00.000Z` onto a date by hand.
They become calls to the phase 1 producers, settling `daySource`'s odd day-end onto the common one.

**Phase 4 — the dead column.** `visits.started_at` is dropped and the schema test flips to
asserting its absence.

**Phase 5 — the fixtures.** ~146 test-fixture literals get wrapped so they carry the label.
Mechanical; the compiler names every one.

## Secrets & env preflight

- **Phases 1–3, 5:** none. Pure TypeScript. (`npm ci` first — a fresh worktree has no
  `node_modules`; this one has been installed.)
- **Phase 4:** this worktree's local Supabase stack (already provisioned — `project_id`
  `TradesDatabase-brand-the-two-time-8a71e8`, API 54421 / DB 54422, values in `.env.test`).
  `gen:types:local` regenerates against it. **The pilot is not touched by this plan.**

## Phase 1: the brand and its producers

### What this phase does
Creates `NaiveLocal` and the only functions that may produce one, and puts the brand on the three
`visits` columns and on every write path that sets them.

### Changes required

**`src/db/time.ts`** (new — imports nothing)
```ts
declare const NAIVE_LOCAL: unique symbol;
/** The firm's wall clock written as if UTC. The trailing `Z` is deliberately false. */
export type NaiveLocal = string & { readonly [NAIVE_LOCAL]: 'naive-local' };

/** THE storage form. Moved from schedule/booking.ts:59, body unchanged. */
export function naiveLocalISO(date: string, hhmm: string): NaiveLocal {
  return `${date}T${hhmm}:00.000Z` as NaiveLocal;
}
export const dayStartNaive = (localDate: string): NaiveLocal => naiveLocalISO(localDate, '00:00');
/** EXCLUSIVE end — the next day's 00:00. The one day-end convention. */
export const dayEndNaive = (localDate: string): NaiveLocal =>
  new Date(Date.parse(dayStartNaive(localDate)) + 86_400_000).toISOString() as NaiveLocal;
/** Re-assert the species on a value that round-tripped through JSONB and lost its type. */
export const asNaiveLocal = (s: string): NaiveLocal => s as NaiveLocal;
```

**`src/db/index.ts`** — add `export * from './time.js';` beside line 9.

**`src/db/visits.ts`** — `Visit` becomes an override (verified: `PlacedVisit` at :216 still narrows
to `NaiveLocal`, reads and writes both unaffected):
```ts
type VisitRow = Database['public']['Tables']['visits']['Row'];
export type Visit = Omit<VisitRow, 'starts_at' | 'ends_at' | 'completed_at'> & {
  starts_at: NaiveLocal | null; ends_at: NaiveLocal | null; completed_at: NaiveLocal | null;
};
```
- `CreateVisitInput.startsAt/endsAt/completedAt` (:241, :242, :250) → `NaiveLocal | null`
- `MoveVisitRowInput.startsAt/endsAt` (:392-393) → `NaiveLocal`
- `updateVisitStatus`'s `completedAt` (:335) and `expectedTimes` (:339) → `NaiveLocal`
- Add `as unknown as Visit` at the nine `Promise<Visit…>` returns — **exactly** :258, :313, :340,
  :439, :529, :589, :649, :693, :769 (compiler-confirmed complete; every other Visit-shaped return
  already carries a cast).

**`src/schedule/booking.ts`** — delete the local `naiveLocalISO` (:58-61), add
`export { naiveLocalISO } from '../db/time.js';`. `ResolvedBooking.startISO/endISO` (:285-286) and
`ResolvedMove.startISO/endISO` (:675-676) → `NaiveLocal | null` / `NaiveLocal`.
`UnscheduleVisitInput.expectedTimes` (:953-956) and its use at :1016 → `asNaiveLocal` at the JSONB
re-entry.

**Pulled forward from phase 2 — without these, phase 1 does not compile:**
- `src/writePath/attachNote.ts:73` — `noteLocalOf` returns `NaiveLocal`; **and `:65`
  `ResolvedVisitForNote.noteLocal` → `NaiveLocal`**, or the brand is erased one line after it is
  made (fixes the `completedAt: noteLocal` write at `:126`).
- `src/writePath/recordFieldNote.ts:865` — `updateVisitStatus(…, resolved.noteLocal)`.
- `src/eval/plannerSim.ts:232-233, 240-241` — `startsAtLocal` typing, and `toNaiveLocal`'s (`:96`)
  declared return.

**`src/db/time.test.ts`** (new) — `tsconfig` includes `src`, so `@ts-expect-error` **fails
`npm run typecheck` when it stops erroring** (verified: yields `TS2578: Unused '@ts-expect-error'`).
Assert `naiveLocalISO`/`dayStartNaive`/`dayEndNaive` values, plus a negative for a plain instant
written into a visit time. Reference every declared binding (`void x`) — `no-unused-vars` is a gate.

### Automated verification
- [ ] `npm run typecheck` passes — **phase 1 must compile standalone**
- [ ] `npm run lint` passes
- [ ] `npm test` passes *(expect phase-5 fixture errors until phase 5; run typecheck on `src/db`,
      `src/schedule`, `src/writePath` non-test files to confirm production is clean meanwhile)*
- [ ] `src/db/time.test.ts` passes, `@ts-expect-error` assertions still error
- [ ] `grep -rn "naiveLocalISO" src/` shows the **four** importers unchanged

### Live verification (agent-executable)
- None — the compiler is the verification; no service is contacted.

### Manual verification
- None.

---
*Manual list empty — continue.*

## Phase 2: the doors

### What this phase does
Gives the three converters, and the two forwarders that can actually carry a `NaiveLocal`, a
signature that accepts a branded value only with the literal timezone `'UTC'`.

### Changes required

**`src/schedule/availability.ts`** — overload `localDayOfWeek` (:39), `localDateISO` (:50),
`localTimeHHMM` (:62). Verified against tsc:
```ts
export function localDateISO(iso: NaiveLocal, tz: 'UTC'): string;
export function localDateISO<T extends string>(
  iso: T & (T extends NaiveLocal ? never : unknown), tz: string,
): string;
export function localDateISO(isoTimestamp: string, timezone: string): string { /* unchanged */ }
```
- `isTechnicianAvailableOn` (:145) gets the pair on its first and fourth parameters; body
  unchanged; `availability.test.ts` needs no changes.

**`src/schedule/booking.ts:169`** — `availabilityWarning(technician, date, startISO)` gets the pair
(`startISO: NaiveLocal` with `'UTC'`). **This is the production hole**; without it the brand is
widened away immediately before `isTechnicianAvailableOn`.

**Return type only — no overloads** (all take instants exclusively; `watchers.ts:366` is a `const`
arrow where overload syntax is a syntax error): `watchers.ts:366` `naiveLocal` → `NaiveLocal`;
`planner.ts:922` `firmStamp` and `planner.ts:1243` `departureDate` need **no change at all**.
*(`plannerSim.ts:109` is not a helper — it is a comparison on a real instant; it needs nothing.)*

**`src/db/time.test.ts`** — add the door's negatives: `localDateISO(naive, 'UTC')` legal;
`@ts-expect-error` on `localDateISO(naive, 'America/Los_Angeles')`, on `localDayOfWeek` likewise,
and on a `tz` widened to `string` (proves the door needs the literal).

### Automated verification
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes *(phase-5 caveat as above)*
- [ ] the `@ts-expect-error` assertions still error

### Live verification (agent-executable)
- None — every overload erases at runtime.

### Manual verification
- None.

---
*Manual list empty — continue.*

## Phase 3: the hand-built day bounds

### What this phase does
Replaces eight hand-written day-boundary literals with the phase 1 producers, settling the two
clashing day-end conventions onto the exclusive one.

### Changes required

| File | Line(s) | Becomes |
|---|---|---|
| `src/schedule/boardRead.ts` | 166-167 | `dayStartNaive(from)`, `dayEndNaive(toDay)` |
| `src/schedule/boardRead.ts` | 371 | `dayStartNaive('1970-01-01')` |
| `src/schedule/fit.ts` | 390-391, 478-479 | `dayStartNaive(earliest)`, `dayEndNaive(latest)` |
| `src/schedule/fit.ts` | 65, 75 | `localDayOfWeek(dayStartNaive(dateISO), 'UTC')` |
| `src/db/visits.ts` | 1137 | `` `starts_at.gte.${dayStartNaive(todayLocal)}` `` |
| `src/writePath/identityMatch.ts` | 224-225 | `dayStartNaive(day)`, `dayEndNaive(day)` |
| `src/routes/daySource.ts` | 53-54 | `dayStartNaive(from)`, `dayEndNaive(to)` — **the convention change** |

`listVisitsForTechnician` (`visits.ts:966`) filters `.lt('starts_at', toISO).gt('ends_at', fromISO)`.
Only `starts_at` sees `toISO`, so the `ends_at` side is byte-identical; the upper bound widens by
one millisecond, which `HHMM_RE` (`booking.ts:56`) makes unreachable from the booking layer, and
`daySource.ts:68-71`'s post-filter would include such a row anyway — a widening, never a narrowing.
*(Caveat the draft omitted: that argument covers the booking layer only; `starts_at` can also be
written by seeds and by tests via raw `pg`.)*

**`src/routes/daySource.test.ts`** — the draft asked for a 23:30 case, which is included **both**
before and after and therefore locks nothing. The only discriminating input is a row at exactly
`T23:59:59.999Z`; insert one via the raw `pg` client this suite already uses and assert it is now
included.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] the new `daySource` `23:59:59.999` boundary test passes
- [ ] `grep -rn 'T00:00:00\.000Z' src/ --include="*.ts" | grep -v test | grep -v eval/` returns
      **only these nine legitimate calendar-date sites** (the draft's assertion could not pass —
      `time.ts` never contains the literal, since `naiveLocalISO` builds `` `${date}T${hhmm}:…` ``):
      `dateResolve.ts:83,88,93,357,397`, `fit.ts:192`, `adminApi.ts:155`, `lifecycle.ts:157,242`

### Live verification (agent-executable)
- Prerequisites: this worktree's local stack (running), `.env.test`.
- [ ] `npm run seed:local`, then read a seeded range through `readBoardDays` and confirm the same
      visit set as before the change — capture both row counts as evidence.

### Manual verification
- None.

---
*Manual list empty — continue.*

## Phase 4: drop the dead column

### What this phase does
Removes `visits.started_at` — no reader, no writer since rung 9b re-created it and deleted its
writer in the same commit.

### Changes required

**`supabase/migrations/20260920120000_drop_visits_started_at.sql`** (new; version must not collide —
the ledger keys on the number, not the filename, and two branches silently skipping each other's
migration is a recorded trap. Sibling holds `20260919170000`; main's latest is `20260919170000`):
```sql
alter table visits drop column if exists started_at;
```
No `cascade` needed — confirmed nothing references it (only `20260906140000:71` creates it).

**`src/db/schema.test.ts`** — `:157` flips from asserting the column's type to
`expect(cols.get('started_at'), 'never written after rung 9b').toBeUndefined();`, moved beside the
`scheduled_at` assertion at `:163` with that block's comment extended to name both retired columns.

**`src/db/database.types.ts`** — regenerate with `gen:types:local`; commit the result. **Verify the
diff is `started_at`-only** — regeneration rewrites the file wholesale from *this worktree's* stack.

### Automated verification
- [ ] `npx supabase migration up` applies cleanly
- [ ] `gen:types:local` diff removes `started_at` from `visits` Row/Insert/Update and nothing else
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass

### Live verification (agent-executable)
- Prerequisites: this worktree's local stack. **`supabase-test` MCP is NOT used — the pilot is not
  touched by this plan.**
- [ ] Before applying: `select count(started_at) from visits` on the local stack. Non-zero means the
      column is not dead here and the phase **stops** for the operator.

### Manual verification
- [ ] Operator confirms the pilot's `visits.started_at` is all-NULL before this migration is rolled
      out. Deploys run no migrations, so the rollout is a separate operator-run step.

---
*Manual list non-empty — pause here for the operator.*

## Phase 5: the fixtures

### What this phase does
Wraps the test-fixture literals that feed the now-branded write paths. Mechanical; the compiler
names every site.

### Changes required

**Six fixture helpers** — one edit each, covering ~55 call sites: `scheduling.test.ts:261` (`T`),
`:717` (`D`), `:952` (`rel`), `:1148` (`D`), `recordFieldNote.test.ts:113` and `:1020` (`naive`).
Each wraps its template in `nl(...)`.

**A shared `nl` helper** exported from `src/db/time.ts` — `asNaiveLocal` under a short name is
enough; tests import it directly.

**119 raw string literals**, via one regex pass (dry-run confirmed clean, 50 lines in
`scheduling.test.ts`):
```
sed -E "s/((startsAt|endsAt|completedAt): )('[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z')/\1nl(\3)/"
```
**27 template literals** need a second, looser pattern — **eyeball these**, do not trust it blind.
**~9 variable references** — type the variable. **80 `null`s need nothing.**

### Automated verification
- [ ] `npm run typecheck` passes with **zero** errors in test files
- [ ] `npm run lint` passes
- [ ] `npm test` passes — full suite green, including the DB-backed suites
- [ ] `npm run build` passes (pre-PR gate)

### Live verification (agent-executable)
- Prerequisites: this worktree's local stack (the DB-backed suites need it).
- [ ] Full `npm test` against the local stack, reporting the pass count against the pre-change
      baseline (3294 passed / 9 skipped at `977add9`) — a DROP in count means a suite stopped
      running, which a green run would otherwise hide.

### Manual verification
- None.
