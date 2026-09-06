---
date: 2026-09-06
branch: main
commit: e6b7cc4
topic: "Rung 9c — a visit carries a crew: what it takes for ONE visit row to name SEVERAL technicians, and where the double-booking guard can live once the person leaves the row"
supersedes: thoughts/shared/research/2026-09-02-a-visit-is-not-a-person.md (Constraints 1 and 4 and Decision Points (a) and (h) only — rung 9b answered them; every other finding there stands and is CITED below rather than repeated)
---

**`supersedes:`** The 2026-09-02 research was written against two unlinked tables and a visit id that
changed on every move. Rung 9b (`c7d69f8`) merged the tables and made the id survive a move, which
retires four of its findings: *"Nothing names a visit"* (Constraint 1 — `visits.id` now does), *"A
visit id is not stable across a move"* (Constraint 4), the `visit_group_id`-vs-derived-key choice
(Decision (a) — moot, the id is the key), and the dormant-`visits`-table question (Decision (h) — the
table is gone). Its **singular-column audit** of `nudges.technician_id` / `observations.technician_id`
(§"What `technician_id` is actually used for"), its dedup-store table, and Constraints 5–14 were
re-verified on this branch and stand; they are referenced by section rather than copied.

## Summary

A **visit** is now one row per trip, with a stable id, a derived lifecycle, and its field notes linked
through `visit_notes` (rung 9b). The one thing still stuck in the old shape is **who is on it**:
`visits.technician_id` is a single nullable foreign key, so a crew of two on one trip is still two rows
that nothing joins. This document maps everything that reads, writes, or is guarded by that column, so
that a rung moving it into a list can see the whole blast radius. The load-bearing finding is not a
count of call sites. It is that the database's double-booking guard, `no_confirmed_overlap`, is an
**exclusion constraint** — a rule Postgres checks between rows of *one* table — and it works today only
because the person and the times sit on the same row. Move the person to a side table and the guard has
nowhere to stand: the visit no longer knows who, and the participant table does not know when. Rung 9b
built its move primitive on that guard firing (an UPDATE that trips it changes nothing, so the caller
can say "that slot is taken" without a race), so the guard's new home is the first thing 9c has to
decide, ahead of any table.

## Entry Points

| Where | What | File:line |
|---|---|---|
| The guard itself | `EXCLUDE USING gist (technician_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE status='confirmed' AND starts_at IS NOT NULL` | created `supabase/migrations/20260704210155_scheduling_foundation.sql:70-72`; narrowed to exclude untimed rows later (2026-09-02 research cites `20260724130000_unplaced_visits.sql:27-31`); live DDL confirmed on the local stack |
| Its detector | `isOverlapViolation` — SQLSTATE `23P01` | `src/db/visits.ts:145-149` |
| The move that relies on it | `moveVisitRow` — "if the exclusion constraint fires (23P01), NOTHING changed" | `src/db/visits.ts:170-172`, caught at `src/schedule/booking.ts:720-725` |
| The book that relies on it | `bookVisit` catch → "already has a confirmed visit overlapping" | `src/schedule/booking.ts:489-499` |
| The app-side PRE-check | `overlappingConfirmed` → "PRE-check only: the DB exclusion constraint remains the authority under races" | `src/schedule/booking.ts:125-135` |
| The person column's writers | `createVisit`, `moveVisitRow`, `attachVisitTechnician` | `src/db/visits.ts:67`, `:210`, `:250` |
| The attach rule that splits a crew | `resolveVisitForNote` step 1: `v.technician_id === null \|\| v.technician_id === input.technicianId` | `src/writePath/attachNote.ts:78-83` |
| The gap's person | `watchers.ts` writes `observations.technician_id` from `g.technician_id` | `src/jobs/watchers.ts:612-622` |
| The board's lanes | keyed by `technicianRef` — "the UNIQUE roster handle" | `web/board/board.js:158-206` |

## Key Files

- **`supabase/migrations/20260704210155_scheduling_foundation.sql`** — birth of `assignments` (now
  `visits`), `no_confirmed_overlap` (:70-72), and `idx_assignments_technician on (technician_id,
  starts_at)` (:76). Both survive the 9b rename as `no_confirmed_overlap` and `idx_visits_technician`.
- **`supabase/migrations/20260717120000_technician_optional_bookings.sql`** — made `technician_id`
  nullable; its header (:5-13) records why the guard tolerates NULL: *"`technician_id WITH =` never
  matches NULL against anything, so two unassigned visits at the same time do NOT collide."*
- **`supabase/migrations/20260906140000_the_visit_is_one_object.sql`** — the 9b migration: the rename
  precedent, the `visit_notes` link table, `v_schedule`/`v_cancelled_visits` selecting `t.ref as
  technician_ref, t.display_name as technician_name` from `left join technicians t on t.id =
  v.technician_id` (:162-163, :188-189). These two are the ONLY views that project the visit's person
  (verified via `pg_views` on the local stack).
- **`src/db/visits.ts`** (981 lines) — the typed layer. Every production read of `visits` goes through
  it. Classified below.
- **`src/schedule/booking.ts`** (1111 lines) — book / move / attach / unschedule / cancel_job. One
  `technicianRef` per call on every verb.
- **`src/schedule/fit.ts`** (605 lines) — `find_slots`. Occupancy is computed PER PERSON (:406) and
  the route measurement is keyed per person-day (:507 `techDateKey`).
- **`src/writePath/attachNote.ts`** (116 lines) — the note→visit rule (rung 9b phase 3).
- **`src/jobs/watchers.ts`** (894 lines) — overdue detection; the job-scoped freshness test (:468-471)
  and the observation mint (:600-635).
- **`src/jobs/nudgeKinds.ts`** (163 lines) — the visit-scoped subject `${visitId}@${starts_at}`
  (:87-100) and `visitSubjectCandidates` (:101-104).
- **`src/telegram/boardNotify.ts`** (245 lines) — who gets pushed on `booked`/`moved`/`cancelled`:
  `row.technician_id` (:101) plus `detail.previousTechnicianId` (:128).
- **`src/schedule/boardRead.ts`** (464 lines) — the board's day grid and detail sheet; two security
  gates on `technician_id` (:140, :422).
- **`src/db/jobs.ts:205-282`** — `listCostGapCandidates`, the one reader that already collapses
  per-job and picks a person.
- **`src/teamLead/planner.ts`** — reads `nudges.technician_id` / `observations.technician_id` (19
  sites), NOT `visits.technician_id`. The gap's person, not the visit's. See the 2026-09-02 audit.
- **`src/routes/daySource.ts:40-90`** and **`src/writePath/identityMatch.ts:85-110`** — the two
  callers of `listVisitsForTechnician` outside booking: a technician's own route, and
  schedule-assisted note matching.
- **`web/board/board.js`** (29 `technician` references) and **`src/telegram/boardApi.ts`** (13
  `technicianRef` sites) — the board, which must keep WORKING but is being rebuilt after the
  schedule story (user, 2026-09-06).

## Data Flows

### The person column, classified — every production site that touches `visits.technician_id`

**W** = writes it · **F** = filters or gates on it · **D** = displays/projects it (via the
`visits_technician_id_fkey` embed `technicians(id,ref,display_name,tenant_id)` or a roster map) ·
**L** = copies it into the ledger or a gap.

| File | Sites | Classification |
|---|---|---|
| `src/db/visits.ts` | :67 createVisit · :210 moveVisitRow · :250 attachVisitTechnician | **W** ×3 |
| | :517 `listVisitsForTechnician` `.eq` · :562 `listUnassignedVisits` `.is null` · :671 `listIdenticalUnassignedVisits` `.is null` · :740 `listUntimedVisitsForJob` `.is/.eq` · :790 `listUnassignedVisitsWithRefs` `.or(technician_id.is.null…)` | **F** ×5 |
| | `DETAIL_SELECT` :442 · `DAY_SELECT` :481 · `CUSTOMER_UPCOMING_SELECT` :618 · `UNPLACED_STRIP_SELECT` :692 · `CUSTOMER_VISITS_SELECT` :957 — each embeds `technicians(…)` through the FK | **D** ×5 (embed) |
| `src/schedule/booking.ts` | :127-135 pre-check via `listVisitsForTechnician` · :249-251 resolve `technicianRef` · :479 `technicianId` into createVisit · :584-589 resolveMove reads `old.technician_id` to pick the target · :712-714 moveVisitRow technicianId · :861 attach guard `old.technician_id === null` · :904 attachVisitTechnician technicianId | **F** ×3, **W** ×3, read ×1 |
| | :401, :517 preview `technicianRef` · :1037-1042 cancel preview refCache | **D** ×3 |
| | :697 `previousTechnicianId = r.old.technician_id` · :898 same for attach · :921 `attachedTechnicianRef` — into `schedule_events.detail` | **L** ×3 |
| `src/schedule/fit.ts` | :388-389 drop person-less rows · :406 `mine = rows.filter(r => r.technician_id === t.id)` — the per-person occupancy model | **F** ×2 |
| | :474-479 displacement refCache · :507 `techDateKey(technicianRef, date)` | **D** ×2 |
| `src/schedule/boardRead.ts` | :140 day-grid viewer filter · :422 detail viewer gate — a technician sees only rows whose `technician_id` equals theirs | **F** ×2 (security) |
| | :166-168, :437-438 `technicianRef`/`unassigned` | **D** ×2 |
| `src/writePath/attachNote.ts` | :82 step 1: same day AND (`technician_id` null OR = the filer) | **F** ×1 |
| `src/jobs/watchers.ts` | :612 `g.technician_id` → `techById` → `obs.technicianId` and `context.technicianRef` | **L** ×1 — the person the GAP names |
| `src/db/jobs.ts` | :230 select · :248 `.not('technician_id','is',null)` · :267 drop · :278 `technicianId` into the cost candidate | **F**/**L** |
| `src/telegram/boardNotify.ts` | :101 `technicianOf(row)` · :128 `previousTechnicianId` from detail | read ×2 — who is pushed |
| `src/db/context.ts` | :111, :113 `technicianRef`/`unassigned` on `upcomingVisits` | **D** ×2 |
| `src/db/foldImpact.ts` | :92 embed select · :132 `technicianId` on the fold preview | **D** ×2 |
| `src/mcp/server.ts` | :4183, :4193 (get_team_schedule stops) · :4232-4233 (untimed list) · :4410 (book result `unassigned`) · :6307-6308 (find_slots: the subject visit's technician, for drive measurement) | **D** ×4, read ×1 |
| `src/routes/daySource.ts` | :51 `listVisitsForTechnician` — the technician's own route (`get_schedule`) | **F** ×1 |
| `src/writePath/identityMatch.ts` | :90 `listVisitsForTechnician` — schedule-assisted matching of a technician's note | **F** ×1 |

**Total on the visit column: 53 production sites** (3 W in the typed layer + 3 W in booking; 16 F; 22
D; 4 L; 5 plain reads). The earlier estimate of ~38 across eight files undercounted `visits.ts` itself.
`server.ts:5279-5280` (`p.technician_id`) is the pairings table, not visits — a false positive on the
grep. Tests: **119** `technician_id` sites across 15 test files (`boardApi.test.ts` 22,
`planner.test.ts` 20, `server.test.ts` 18, `booking.test.ts` 14, `watchers.test.ts` 8, …).

**A second, separate column: `technician_id` on the gap tables.** `nudges.technician_id`,
`observations.technician_id` and `office_messages.technician_id` are all nullable (verified:
`pg_attribute.attnotnull = f` on all three), and `office_messages_addressee_check` is `CHECK (direction
= 'to_planner' OR technician_id IS NOT NULL)`. These are NOT the visit's person — they are the person a
gap or message is ABOUT/TO, copied once at mint time (`watchers.ts:622`, `nudges.ts:56,99`,
`observations.ts:55`). The 2026-09-02 audit's table of what that column drives is unchanged on this
branch and was spot-checked: `gapNames` (`planner.ts:2349`, `v.nudge.technician_id === id`), the
`send` fallback (`:3046`), the group-send rail (`:2436`, `:2488` — "the same person on the same job"),
attribution (`nudges.ts:631`), the delivery join `technicians!inner(id,ref,state,sandbox_ref,
telegram_user_id,host_id,tenant_id)` (`nudges.ts:185`, `officeMessages.ts:236`), and the desk view
(`desk.ts:117`). Moving `visits.technician_id` into a participant table does not touch any of these;
what it changes is **which single person the mint at `watchers.ts:612` copies in** when the visit has
two.

### One crew visit through the machine today (post-9b)

```
book_visit(ben)  ──► visits row A  (technician_id=ben,  14:00–15:30, confirmed)
book_visit(joy)  ──► visits row B  (technician_id=joy,  14:00–15:30, confirmed)
                         │ guard: (ben,[14:00,15:30)) vs (joy,[14:00,15:30)) — technician_id differs → no collision
                         │ schedule_events: two `booked` rows, detail.technicianRef = ben / joy
                         ▼
Ben files a note (technician_note, capturedAt on the visit's day)
  resolveVisitForNote step 1: sameDay = rows placed that day where technician_id ∈ {null, ben}
                            → row A only (row B has technician_id=joy)      attachNote.ts:78-83
  visit_notes(A, capture); status A → completed; completed_at = note time     recordFieldNote
  row B: untouched — confirmed, no note, forever
                         ▼
overdue detector (row B's end passes, no report on the JOB since its start?)
  hasActivitySince(job_id, starts_at): latestByJob is keyed by JOB           watchers.ts:456-471
    → Ben's note counts for the job → row B is NOT a gap                      (Constraint 5 of 09-02 stands)
  If NOBODY had filed: two candidates → two subjects `A@t`, `B@t` → two observations,
    technician_id = ben / joy → two people asked about one trip
                         ▼
v_schedule: two rows for the slot; count(*) = 2                               (Constraint 14 of 09-02 stands)
board Team tab: row A in Ben's lane, row B in Joy's lane                      board.js:196-206
get_customer_context.upcomingVisits: listed twice                              context.ts:100-125
```

**The pilot specimen, read back 2026-09-06:** Henderson Family job `f8240fc1…` carries rows
`658c2fc4…` (ben-shelton) and `93893207…` (manager-joy), both `2026-09-02 14:00–15:30`, both still
`confirmed`, zero `visit_notes`, one `booked` event each, minted two seconds apart on 2026-09-01. It is
the only crew-shaped slot on the pilot (one slot, two rows; the tiers involved are `manager` and
`technician`). The same job also carries a third `confirmed` row from 2026-08-18 (manager-sam, seed
data, no events) — so a note against this job today would find THREE live visits, fall through the
attach rule's step 2 (which requires exactly one), and mint a fourth.

### Where the guard fires, and what depends on it firing

The guard is evaluated by Postgres on INSERT and UPDATE of a `visits` row against every other
`visits` row, using `technician_id` and `tstzrange(starts_at, ends_at)` **from the same row**. An
exclusion constraint compares rows of the table it is declared on and cannot reference another
table — see the `EXCLUDE` clause in
<https://www.postgresql.org/docs/current/sql-createtable.html#SQL-CREATETABLE-EXCLUDE>. Three places
depend on it raising `23P01`:

1. **Booking** (`booking.ts:478-499`): `createVisit` with `status:'confirmed'` → catch
   `isOverlapViolation` → cancel a just-minted job shell → *"already has a confirmed visit overlapping"*.
2. **Moving** (`booking.ts:700-725`): one UPDATE via `moveVisitRow`; on `23P01` *"the visit has NOT
   moved"*. The primitive's own header (`visits.ts:161-181`) states the reliance: *"It is atomic by
   construction: if the exclusion constraint fires (23P01), NOTHING changed."* The 2026-09-05 pilot
   E2E exercised exactly this path.
3. **Confirming a proposed row** (`updateVisitStatus`, `visits.ts:101-103` comment).

The app-side pre-check (`overlappingConfirmed`, `booking.ts:127-135`) is explicitly advisory:
*"PRE-check only: the DB exclusion constraint remains the authority under races."* Tests pin the
guard at `src/db/scheduling.test.ts:292` (insert), `:414` (*"a move onto a taken slot raises 23P01 and
leaves the visit EXACTLY where it was"*), and `:706` (*"placed overlaps still raise 23P01; untimed
twins both insert"*).

### What already collapses a crew for free

- **Gap subject.** `visitSubjectRef(visitId, starts_at)` (`nudgeKinds.ts:89-91`) is keyed on the
  visit id. With one row per trip there is one subject; `uq_observations_subject_ever` (UNIQUE
  `(tenant_id, kind, subject_ref) WHERE author='detector'`) and `uq_nudges_subject_ever` (UNIQUE, not
  partial) then hold one observation and one nudge per visit-at-a-time. `visitSubjectCandidates`
  (:101-104) returns `[id, id@t]`, so historical bare-id rows still match. **Nothing here reads
  `technician_id`.** The candidate list (`listOverdueConfirmedVisits`, `visits.ts:580-596`) is a plain
  `status='confirmed'` window read with no person filter — its row count IS the gap count.
- **Freshness.** `latestByJob` (`watchers.ts:456-462`) is keyed by `job_id` from both activity homes,
  and `listNoteTimesForJobs` (`visits.ts:923-955`) was re-sourced by 9b to walk `visit_notes` →
  `visits!inner(job_id)`. Still job-scoped. Either crew-mate's note suppresses the other's gap.
- **`cancel_job`.** `liveRowsForJob` (`booking.ts:1020-1023`) cancels every live row on the job.
- **`recordVisitReport`** (`visits.ts:280-311`) ACCUMULATES `labor_hours` and shallow-merges
  `attributes`, and its comment already anticipates a crew: *"two technicians on one crew each report
  their own, and a trip's cost is the sum."*
- **Cost gap.** `listCostGapCandidates` (`jobs.ts:222-282`) keeps one candidate per JOB, ordering by
  `ends_at` DESC and taking the first. For a crew both rows share `ends_at` exactly; which person it
  names is whichever Postgres returns first. Constraint 9 of the 2026-09-02 research still holds.

### The ledger

`schedule_events.detail` is untyped JSONB (`scheduleEvents.ts:15,30`) and append-only
(`20260714120000:46-48`). Today booking writes `technicianRef` on `booked` (`booking.ts:508-517`),
`previousTechnicianId` on `moved` (`:697`, `:922`), and `attachedTechnicianRef` on an attach's `moved`
(`:921`). `boardNotify.ts:126-137` reads `previousTechnicianId` and falls back to
`previousAssignmentId` for pre-9b rows. Every one of the pilot's 326 events names at most ONE person.

## External Dependencies

- **PostgreSQL exclusion constraints** (`btree_gist` for `uuid WITH =` alongside `tstzrange WITH &&`).
  Per-table by definition; see the citation above.
- **PostgREST embeds through foreign keys** (`@supabase/supabase-js`). Every **D** site in
  `visits.ts` resolves `technicians(…)` via `visits_technician_id_fkey`; a participant table would be
  a different embed shape (`visit_participants(technicians(…))`) and, as the 9b deploy proved,
  supabase-js type-checks `.select()` strings against `database.types.ts`.
- **Telegram** — the board's per-person lanes and the notify pushes are one-person-per-message by
  construction (2026-09-02 Constraint 12).

## Constraints and Invariants

1. **The guard cannot follow the person to another table.** An `EXCLUDE` constraint is declared on one
   table and compares that table's rows. If `technician_id` leaves `visits`, `no_confirmed_overlap` as
   written has no `technician_id` to compare. A participant table has no `starts_at`/`ends_at` to
   range over unless they are copied onto it.
2. **Rung 9b made the move primitive depend on the guard raising.** `moveVisitRow` is one UPDATE whose
   safety argument is *"an UPDATE that trips the exclusion constraint changes nothing at all"*
   (`visits.ts:170-172`, `booking.ts:700-706`). The app pre-check is advisory (`booking.ts:125`).
3. **The guard deliberately allows a crew.** `technician_id WITH =` means two different people in one
   slot never collide (`20260717120000:7-10`). Crew booking works today because of this, not despite it.
4. **`idx_visits_technician` is composite `(technician_id, starts_at)`** — it backs
   `listVisitsForTechnician`'s `.eq(technician_id) + time range` shape (`visits.ts:508-527`), which
   has five callers: the booking pre-check, `daySource.listDayStops`, `identityMatch`, and two more in
   booking. Any participant design changes what this index indexes.
5. **The attach rule splits a crew by construction.** Step 1 admits `technician_id IN (null, filer)`
   (`attachNote.ts:78-83`); the partner's row is excluded and stays `confirmed`. Step 2 requires
   exactly one live visit on the job (`:96`), which a crew (two) never satisfies. Verified on the pilot
   specimen: both Henderson rows are still `confirmed` four days after the slot.
6. **A partner row left `confirmed` is indistinguishable from any other stale confirmed visit.** It
   sits in `v_schedule` as `placed`, is a candidate for `listOverdueConfirmedVisits` until the job-scoped
   freshness test clears it, and counts against step 2 of the attach rule for every later note on the
   job. This is one of the mechanisms behind the "stale confirmed visits" observation recorded in the
   9b deploy notes (`docs/engineering-memory.md` §9b).
7. **A gap names exactly one person, and that person is machinery.** `observations.technician_id` is
   set once from `g.technician_id` at mint (`watchers.ts:612-622`). Downstream it is the ask-of-record
   key, the send fallback, the attribution key, the group-send rail key, and the delivery join (the
   2026-09-02 audit, re-verified). With one row per crew visit, the mint has ONE `technician_id` to copy
   from, and the visit will have several.
8. **The board's Team tab keys lanes on `technicianRef`** (`board.js:196-206`): one stop → one lane.
   A stop with two people has no lane today. The technician self-view gates on equality
   (`boardRead.ts:140`, `:422`; `boardApi.ts:233-236`): *"a crafted visitId for anyone else's (or an
   unassigned) visit 404s."*
9. **`find_slots` models capacity per person** (`fit.ts:406`, one `mine` filter per technician; `:507`
   `techDateKey`). A crew visit occupies each participant's day separately, which is correct for
   occupancy and is what the per-row model gives for free.
10. **`v_schedule` and `v_cancelled_visits` are the only views projecting the person**, as scalars
    `technician_ref`/`technician_name` via `left join technicians` (`20260906140000:162-163,
    188-189`). The planner writes SQL against them and the catalog's worked example is `select
    technician_name, count(*) … from v_schedule group by 1` (`server.ts:1200`).
11. **Append-only surfaces that hold a single person, permanently:** `schedule_events.detail`
    (`technicianRef`, `previousTechnicianId`, `attachedTechnicianRef`), `raw_captures.technician_ref`,
    and — with no FK and no update path — `observations`/`nudges` `technician_id` and `subject_ref`.
    `raise_append_only` (`20260819140000:19-26`) is on `raw_captures`, `schedule_events`,
    `money_events` (UPDATE OR DELETE) and `visit_notes` (UPDATE only). **`visits` carries no
    append-only trigger** — only `visits_set_updated_at`. An UPDATE to `visits` rows is ordinary.
12. **`ON DELETE SET NULL` is an UPDATE and trips `raise_append_only`** (9b migration header, proven
    by probe). `raw_captures.visit_id` and `schedule_events.assignment_id` both reference `visits(id)
    ON DELETE SET NULL`, so **a `visits` row that any capture or event points at cannot be deleted** —
    which rules out "delete the partner row" as a backfill move for the pilot's crew pair (both rows
    have a `booked` event).
13. **The eval world cannot express a crew** — `plannerSim.ts:159-161` still has `technician: {ref,
    name}` and `visit?: {…}`, both singular (2026-09-02 Constraint 13 stands).
14. **Two same-slot rows on one job are ambiguous by prior decision.** `listUntimedVisitsForJob`'s
    header (`visits.ts:720-726`) and the 2026-09-02 research's Constraint 1 both record that two rows
    sharing a job and window may legitimately be *two trades at one address*, and the duplicate-guard
    keys on `technician_id` for that reason. Nothing in the data distinguishes "a crew" from "two
    trades" — the pilot specimen reads as a crew only because a human says so.
15. **The 9b "no lead" ruling is already partly encoded.** There is no primary-technician column, no
    rank field, and `answered_by_capture_id` on `nudges` (`database.types.ts:1066`) records the
    answering capture, not a role. What contradicts the ruling in practice is Constraint 7: a
    single-`technician_id` gap picks one crew-mate as the person of record by accident of row order.

## Decision Points

**(A) Where the double-booking guard lives.** Given Constraints 1–3, the code today leaves three
shapes, stated without preference:
- *Copy the times onto the participant row and declare the EXCLUDE there.* A `visit_participants(visit_id,
  technician_id, starts_at, ends_at, status)` table with `EXCLUDE (technician_id WITH =,
  tstzrange(starts_at, ends_at) WITH &&) WHERE status='confirmed' AND starts_at IS NOT NULL`, kept in
  step with `visits` by a trigger on `visits` UPDATE. The guard stays a database rule and `23P01` keeps
  firing on the same statements — but the statement that fires it changes: a move would UPDATE
  `visits`, the trigger would UPDATE N participant rows, and the exclusion would raise from inside the
  trigger. `isOverlapViolation` reads `error.code` (`visits.ts:145-149`); whether PostgREST surfaces a
  trigger-raised `23P01` with that code intact is an Open Question. Costs a duplicated pair of
  timestamps per participant and a trigger.
- *Enforce in application code.* `overlappingConfirmed` (`booking.ts:127-135`) already exists as the
  pre-check; the DB rule would be dropped. Constraint 2 names what is given up: two managers moving the
  same person into one slot in the same second both succeed, and `moveVisitRow`'s "nothing changed"
  argument no longer holds.
- *Keep `technician_id` on `visits` as one of the participants and add a table for the rest.* The
  guard stays exactly where it is and keeps protecting that one person; additional participants are
  unguarded unless the participant table gets its own copy. This is a lead column by another name
  (Constraint 15).

**(B) What a gap's `technician_id` holds when the visit has two.** The mint at `watchers.ts:612` copies
one id. With a participant list the choices the code presents are: null (Constraint 7 lists what null
switches off — the 2026-09-02 audit, seven mechanisms); one of the participants (which one, and by
what rule — the cost detector's tie is the precedent, Constraint 9 of 09-02); or a gap that names
several people, which touches the `office_messages_addressee_check` CHECK, the `technicians!inner`
delivery joins, and `gapNames`.

**(C) Whether a participant's note closes the visit, or only their own participation.** Today step 1
admits `technician_id ∈ {null, filer}`. With a list, "the visit has this technician on it" is the
natural rewrite and one note completes the whole trip — which is what the "no lead" ruling says
("one person's note satisfies the visit for EVERYONE"). The alternative, per-participant completion,
would need a status per participant row, which the participant table from (A) would carry anyway.

**(D) `technician_id` on `visits`: drop, derive, or keep.** Drop means every **D** site's embed changes
shape (`technicians(…)` → `visit_participants(technicians(…))`) and both views need `string_agg` or
one row per participant. Keep-as-first-participant is option (A3). A generated column cannot reference
another table, so "derive" would be a trigger-maintained denormalisation in the other direction.

**(E) The views the planner queries.** `v_schedule.technician_ref` is a scalar today. One row per
participant makes `count(*)` count people again (the 2026-09-02 Constraint 14 defect, reintroduced);
one row per visit with an aggregated name column changes the catalog prose (`server.ts:742-752`) and
the worked example (`:1200`).

**(F) The board, kept working.** Lanes are keyed by one ref per stop (`board.js:196-206`). A stop with
two participants either appears in two lanes (one stop, two lanes, one `visitId`) or in a merged lane.
The self-view gates (`boardRead.ts:140,422`; `boardApi.ts:233-236`) become "is a participant". The
user has ruled the board is rebuilt after the schedule story; what must survive is that these three
places do not break.

**(G) The pilot's existing crew pair.** Rows `658c2fc4…` and `93893207…` are separate visits with
separate `booked` events. Constraint 12 forbids deleting either. A migration can (i) leave them as two
visits with one participant each, (ii) pick one as the surviving visit and add the other's person as a
participant, leaving the second row to be cancelled (an UPDATE, permitted) — its `booked` event then
points at a cancelled visit, which is a state the ledger already tolerates. Constraint 14 means the
migration cannot tell this pair from two trades without a human saying so.

**(H) Booking a crew.** `book_visit` takes one `technicianRef` (`server.ts:1044`) and returns one
`assignment` (`booking.ts:440-445`). The code presents: N calls that each add a participant to an
existing visit (a second call would need to FIND the first, which is Constraint 14's ambiguity again),
or a verb taking `technicianRefs: string[]` that mints one visit with N participants atomically.

## Open Questions

1. **Does PostgREST surface a `23P01` raised from inside a trigger with `error.code === '23P01'`?**
   `isOverlapViolation` depends on it. Option (A1) fires the exclusion from a trigger on `visits`
   UPDATE rather than from the statement itself. Needs a probe on the local stack; cannot be settled by
   reading.
2. **Is a "crew" ever booked deliberately today, or only by two independent calls?** The pilot
   specimen was two `book_visit` calls two seconds apart by the same actor (events 2026-09-01
   19:40:25 and 19:40:27). No doctrine text in `Box_Setup_Stuff/bootstrap-box.sh` mentions crews
   (grep: zero hits for `crew`, `two technicians`, `second technician`).
3. **How often do real firms send two people?** Not answerable from this codebase or the pilot
   (`never-size-from-the-pilot-box`); one crew-shaped slot exists on the pilot and it is seed-shaped.
4. **What does a technician's own route (`get_schedule`, `daySource.ts:51`) show for a crew visit
   today?** Their own row only — they cannot see that a colleague is coming (2026-09-02 Constraint 8).
   Whether 9c should change that is a product question, not a code one.
5. **Is the `updated_at` tiebreak in `listVisitsForJob` (`visits.ts:533-540`) still needed?** Its
   comment describes the pre-9b cancel-plus-insert carry. The 9b final review noted the comment is
   stale and the ordering is harmless; a 9c that adds a participant table may touch this reader.
