---
date: 2026-09-05
branch: main
commit: f5b786d
topic: "Rung 9 — the visit is one object: the full footprint of retiring `assignments` into `visits`, collapsing the promise ladder into the window, and absorbing the multi-technician visit"
supersedes: nothing
---

**`supersedes:` is `nothing`.** This document does not overturn a decision. It is the research for a
rung whose *direction* was already settled by the user on 2026-09-03, and it BUILDS ON two documents
rather than replacing them: `thoughts/shared/research/2026-09-02-a-visit-is-not-a-person.md` (whose
probed facts still hold and are cited, not re-derived) and the already-superseded
`thoughts/shared/plans/2026-09-03-a-visit-is-not-a-person.md` (marked superseded by the remodel, and
left that way).

## Summary

The word **visit** names two different tables in this codebase, and they have never been linked.

- **`assignments`** is *the schedule*. Every tool called `*_visit` — `book_visit`, `move_visit`,
  `unschedule_visit` — writes here. It has a real technician foreign key, a lifecycle enum, two
  window shapes (a placed time, or an earliest/latest date range), and a database exclusion
  constraint stopping one person being double-booked.
- **`visits`** is *the L2 object from the original spine design*. It is written **once per field
  note** by `recordFieldNote` — never by any scheduling tool. Its `scheduled_at` column exists and
  **nothing in the codebase ever sets it**.

So today a job that was booked and then reported on produces rows in *both* tables that no column
connects. Rung 9 collapses them into one object with a lifecycle **committed → placed → happened →
reported**, keeps the name `visits`, and retires `assignments`.

**The single most consequential finding for the migration:** `visits` rows are **not one per trip —
they are one per NOTE**. `recordFieldNote:267` mints a `createVisit` on every matched field note from
all three inbound routes (email, phone, MCP tool), with no dedup against an existing visit. Two
technicians filing notes about the same trip produce two `visits` rows; one technician filing twice
produces two. Any migration that treats existing `visits` rows as trips will multiply the schedule.

The other finding worth stating plainly: **the confusion is already in the doctrine the model
reads.** `SPINE_VIEW_CATALOG` (`src/mcp/server.ts:737`) describes `v_schedule` as *"confirmed and
completed **visits** only"* and, forty lines later, `v_visits` as *"the trips notes belong to; the
note-to-job bridge"* — and instructs the model to join `v_visits.source_capture_id` to bridge notes
to jobs. The model is told both tables are visits, in one prompt.

## Entry Points

| Where the area begins | File:line |
|---|---|
| The schedule's typed layer (~30 exports, 20 query sites) | [src/db/assignments.ts](src/db/assignments.ts) |
| The L2 visit's typed layer (5 exports, 3 query sites) | [src/db/visits.ts](src/db/visits.ts) |
| The **only** `createVisit` caller | [src/writePath/recordFieldNote.ts:267](src/writePath/recordFieldNote.ts#L267) |
| Booking/move/cancel resolution | [src/schedule/booking.ts](src/schedule/booking.ts) |
| Slot search (NOT the solver; survived rung 8) | [src/schedule/fit.ts](src/schedule/fit.ts) |
| Detector sweep + gap minting | [src/jobs/watchers.ts](src/jobs/watchers.ts) |
| The two detector specs | [src/jobs/nudgeKinds.ts](src/jobs/nudgeKinds.ts) |
| Tool schemas + dispatch + the view catalog | [src/mcp/server.ts:737](src/mcp/server.ts#L737) |
| Board read/write | [src/schedule/boardRead.ts](src/schedule/boardRead.ts), [src/telegram/boardApi.ts](src/telegram/boardApi.ts) |

## Key Files

**`src/db/assignments.ts`** — the schedule's whole API. `createAssignment`, `updateAssignmentStatus`,
`rescheduleAssignment`, `updateAssignmentPromise`, plus ~20 list/read shapes
(`listUnplacedForRange`, `listOverdueConfirmedAssignments`, `listIdenticalUnplacedVisits`,
`listUnassignedAssignmentsWithRefs`, `listUnscheduledOpenJobsWithCustomer`, …). Exports
`ASSIGNMENT_TRANSITIONS` (the legal status graph) and `isOverlapViolation`.

**`src/db/visits.ts`** — 87 lines, five exports. `createVisit` (one caller),
`listVisitTimesForJobs` (the detector's freshness half), `listVisitsForCustomer` (context read via
the `jobs` relation — visits carry no `customer_id`), and **`listVisitsForJob`, which has no callers
at all**.

**`src/writePath/recordFieldNote.ts`** — resolves customer → job → *mints a visit* → maybe transitions
job status. The comment at :266 reads *"The visit is this note's trip."* It sets `technicianName`
(a TEXT ref, not an FK), `laborHours`, `attributes` (L3), `sourceCaptureId`. It never sets
`scheduled_at`, `started_at` or `completed_at`.

**`src/jobs/nudgeKinds.ts`** — the kind registry, only **two** detectors:
`OVERDUE_VISIT_GAP_SPEC` (`subjectIsVisit: true`, subject_ref = an **assignment id**) and
`JOB_COST_GAP_SPEC` (`subjectIsVisit: false`, subject_ref = a **job id**).

## Data Flows

### The two lineages, today — never joined

```
BOOKING                                    REPORTING
  manager / agent                            email · phone · record_field_note
        │                                            │
   book_visit ─────► resolveBooking            recordFieldNote
        │            (src/schedule/booking.ts)        │  resolves customer → job
        ▼                                            ▼
   assignments ◄── move/unschedule/cancel        createVisit  (ONE PER NOTE)
   (job, technician_id, window, status)              │
        │                                            ▼
        │                                        visits (technician_name TEXT,
        │                                               scheduled_at NEVER set,
        │                                               source_capture_id → L1)
        ▼                                            │
   schedule_events (append-only, FK assignment_id)   ▼
                                              raw_captures.visit_id → visits
                                                   (ON DELETE SET NULL)

        ▲                                            ▲
        └──────── NO COLUMN LINKS THESE ─────────────┘
```

### What the detector already does across both

`runWatchers` ([src/jobs/watchers.ts](src/jobs/watchers.ts)) is the one place both lineages are read
in a single pass — but as two *independent* facts, not as one object:

1. Scans `listOverdueConfirmedAssignments` → mints `overdue_visit_gap` with
   `subject_ref = <assignment id>` and `detail.startsAtLocal/endsAtLocal`.
2. Freshness test calls **`listVisitTimesForJobs`** (the `visits` table) *job-scoped* — so if
   **either** person on a crew files a note, **neither** gap is minted. This is the behaviour the
   old rung-8 research flagged as "already mitigating, keep it".

### The four target states vs what exists

| Target state | What represents it today | Gap |
|---|---|---|
| **committed** | `assignments.status = 'proposed'` **or** a windowed row (`earliest_date`/`latest_date` set, `starts_at` NULL) | No state means "we promised, nothing scheduled" *distinctly* from a proposal |
| **placed** | `status='confirmed'` **and** `starts_at IS NOT NULL` — enforced by `assignment_placed_or_windowed` | Exists cleanly |
| **happened** | `assignments.status='completed'` — **or** `visits.completed_at`, in the other table | Two homes, no link. `visits.started_at`/`completed_at` are **never written** by any caller |
| **reported** | The existence of a `visits` row (one per note) | Not a state; it is a row count in a different table |

`assignment_status` = `proposed | confirmed | cancelled | completed`. `ASSIGNMENT_TRANSITIONS`
(assignments.ts:22) is the legal graph. **`rescheduleAssignment` is cancel + insert with a NEW id**,
so an assignment id cannot name a visit across a move — recorded in §8 and re-confirmed here; it is
the reason `subject_ref` cannot survive a reschedule today.

## The nine areas

### (1) The two tables

`assignments` — 16 columns. FKs: `job_id → jobs ON DELETE CASCADE`, `technician_id → technicians`
(no cascade), `tenant_id → tenants`, `source_capture_id → raw_captures ON DELETE SET NULL`.
Constraints: `no_confirmed_overlap` (GiST EXCLUDE on `technician_id WITH =` + `tstzrange` overlap,
`WHERE status='confirmed' AND starts_at IS NOT NULL`), `assignment_placed_or_windowed`,
`assignments_check (ends_at > starts_at)`, `promised_day_when_promised`. Indexes on job, tenant, and
`(technician_id, starts_at)`. Trigger `assignments_set_updated_at`. **Referenced by exactly one
table:** `schedule_events.assignment_id ON DELETE SET NULL`.

`visits` — 11 columns. FKs: `job_id → jobs CASCADE`, `tenant_id`, `source_capture_id → raw_captures
ON DELETE SET NULL`. **No status column, no constraints beyond the PK, no update trigger.**
Referenced by `raw_captures.visit_id ON DELETE SET NULL`. Has what `assignments` lacks:
`attributes jsonb` (the L3 slot), `labor_hours`, `started_at`, `completed_at`.

**Local-stack data: both tables are EMPTY (0 rows).** The stack was reset earlier in this session,
so no row-shape evidence is available from it, and this research was scoped away from the pilot. The
migration's real sizing is therefore an open question (below), not a finding.

### (2) State model — see the table above.

### (3) The promise ladder — measured, and bigger than recorded

Prior record said "133 refs / 14 files". Measured today on `main @ f5b786d`:

| | refs | files |
|---|---|---|
| Promise ladder (`promise_level`, `promised_day`, `set_promise`) | **333** | **23** (16 non-test) |
| Window (`earliest_date`, `latest_date`) | **308** | **26** |

`promise_level` = `none | day | time | time_only`. Heaviest non-test carriers:
`src/schedule/booking.ts` (87 combined refs), `src/mcp/server.ts` (92), `src/schedule/boardRead.ts`
(26), `src/telegram/boardApi.ts` (25), `src/db/assignments.ts` (33).

`promised_day_when_promised` is a live CHECK: any level except `none`/`time_only` requires
`promised_day`. "Collapses into the window" would have to replace: the enum, `promised_day`, the
CHECK, `set_promise` (tool + `updateAssignmentPromise`), every formatter that prints a promise, and
the `worldSpec`/`corpus`/`toolCases` fixtures that set it.

**Dead-code check post-rung-8:** `partitionMovable`'s promise-graded movement freedom was
solver-only. `src/schedule/fit.ts` retains only 5 promise refs; the displacement tiebreak that used
promise grading was touched in rung 8's Phase 2. Whether any promise-reading branch is now
*unreachable* is listed as an open question — it needs a call-graph pass, not a grep.

### (4) Multi-technician

`assignments.technician_id` is still **single-valued and nullable** (confirmed against the live local
schema, not the old research). **Seven tables carry a `technician_id`:** `assignments`, `nudges`,
`observations`, `office_messages`, `roster_events`, `sandbox_pool`, `technician_time_off` — the last
four of which did not exist or were not in scope when the old research was written.

**172 non-test references across 21 files.** All the mechanisms the old research named still exist:
`gapNames` ([src/teamLead/planner.ts:2348](src/teamLead/planner.ts#L2348) — `v.nudge.technician_id === id`),
`countsAsTheAsk` ([src/teamLead/plannerPrompt.ts:91](src/teamLead/plannerPrompt.ts#L91)),
`openQuestionsFor` ([src/mcp/server.ts:2146](src/mcp/server.ts#L2146)), `closed_by_technician`
(`mv_gap_outcomes`), plus the build-6.5/7 additions `office_messages.technician_id` and
`observations.technician_id`.

`visits.technician_name` is **TEXT with no FK** — `recordFieldNote` passes `technicianRef`. As the
survivor's person column it would be a downgrade from `assignments`' real FK, and it holds one name.

`no_confirmed_overlap` keys on `technician_id`, so it already permits two people in one slot and
forbids one person twice ([probed 2026-09-01, do not re-derive](thoughts/shared/research/2026-09-02-a-visit-is-not-a-person.md)).
**If one visit row carries several people, this constraint cannot express itself** — a GiST EXCLUDE
cannot range over an array element or a child table, so per-person overlap becomes application logic
or a separate participant table with its own exclusion constraint.

### (5) Tools and surfaces

Forty tool names are defined; `expect(names).toHaveLength(17)`
([src/mcp/server.test.ts:189](src/mcp/server.test.ts#L189)) pins the technician-tier list. Pins that
would move on a rename: that `toHaveLength`, `ADMIN_TOOLS` (server.ts:843), `MANAGER_TOOLS`
(:1873), `BOARD_LINK_TOOL_NAMES` (:1882), `SPINE_VIEW_CATALOG` (:737), and
`src/eval/toolCases.ts` (11 assignment refs).

Writers of `assignments`: `book_visit`, `move_visit`, `unschedule_visit`, `cancel_job`, `set_promise`,
`set_job_duration` (indirect), the board's place/assign actions. Readers: `get_schedule`,
`get_team_schedule`, `find_slots`, `query_spine`/`spine_read` via `v_schedule`, the board.
**No tool reads or writes `visits`** — only `record_field_note` does, transitively.

### (6) Detectors and gap subjects

Two kinds only. `overdue_visit_gap.subject_ref` is a **raw assignment uuid** (no prefix, no scheme);
`job_cost_gap.subject_ref` is a **job uuid**. Both are bare ids in the same TEXT column, told apart
only by `spec.subjectIsVisit`.

`uq_observations_subject_ever` is a **partial unique index on `(tenant_id, kind, subject_ref) WHERE
author='detector'`** (build 7). Because it is once-ever, changing what `subject_ref` names is an
**identity change**: existing detector observations keyed to an assignment id would not collide with
new visit-id rows, so **the same real gap could be observed twice** — once under each identity —
unless the migration rewrites them. Existing `nudges.subject_ref` rows have the same exposure.

### (7) Views

Three views touch either table: `v_schedule`, `v_cancelled_visits`, `v_visits`. `v_schedule` was
rebuilt by rung 8 (`20260905100000`) and no longer carries `locked`; its current column list is in
`SPINE_VIEW_CATALOG` verbatim. `v_visits` is six columns and, notably, **omits `scheduled_at`,
`started_at` and `completed_at`** — the model cannot see the happened-stage fields at all.

Repo precedent for changing a view's column list: **DROP + CREATE, not `CREATE OR REPLACE`** —
42P16 bites on removals. Precedents: `20260806200000_v_schedule_local_weekday.sql:29` (add) and
`20260905100000_drop_assignment_locks.sql:33` (remove). A dropped view **loses its grants**, so
`grant select … to spine_reader` and the `revoke … from anon, authenticated` must be re-asserted
(`auto_expose_new_tables` is still true, and is deprecated 2026-10-30).

### (8) The data migration

Column-by-column, `assignments` → `visits`: `job_id`, `tenant_id`, `source_capture_id`, `created_at`
map directly. `technician_id` has **no FK-shaped home** (`visits.technician_name` is TEXT).
`status`, `starts_at`, `ends_at`, `earliest_date`, `latest_date`, `promise_level`, `promised_day`,
`reason`, `updated_at` have **no column at all** in `visits`.

Referential exposure if `assignments` is dropped:

| Table | Link | Blocking? |
|---|---|---|
| `schedule_events.assignment_id` | FK `ON DELETE SET NULL`, table has `schedule_events_append_only` trigger | The FK nulls on delete — but the trigger blocks UPDATE, so **whether `ON DELETE SET NULL` counts as an update the trigger refuses is the open question that decides this migration's shape** |
| `raw_captures.visit_id` | FK → `visits`, `raw_captures_append_only` | Same question, opposite direction |
| `nudges` / `observations` / `review_items` | `subject_ref` **TEXT, no FK** | Not blocking; silently stale instead |
| `office_messages`, `money_events` | job-scoped, no assignment link | Unaffected |

**User waiver (2026-09-03):** *"nothing is in production yet… even deleting L1 data is possible."*
So a destructive migration is permitted. Its cost is L1 rows and their `visit_id` links, on a pilot
that includes the Ben/Joy/Judy specimens.

### (9) Tests and evals

Heaviest coupling: `src/mcp/server.test.ts` (125 promise/window refs), `src/schedule/booking.test.ts`
(58), `src/telegram/boardApi.test.ts` (43), `src/db/scheduling.test.ts` (32),
`src/schedule/fit.db.test.ts` (8), `src/jobs/watchers.test.ts`. World builders:
`src/eval/worldSpec.ts` (14), `src/eval/corpus.ts` (8), `src/eval/toolCases.ts` (9),
`scripts/spine-eval/world.mjs`, `scripts/seed.mjs`, `scripts/backfill-schedule.mjs`.

**The fixture divergence is still real.** `makeNudge` in
[src/teamLead/planner.test.ts:45-75](src/teamLead/planner.test.ts#L45) hardcodes
`context.startsAtLocal`/`endsAtLocal` on its base object, and tests override `kind` to
`'job_cost_gap'` via `...over` while keeping that context. Production does the opposite:
`watchers.ts:400` reads `startsAtLocal` as **nullable**, and the comment at :392 says demanding it
*"is exactly what excluded cost items from every path below."* So cost-gap fixtures carry a window
that production cost gaps never have.

## External Dependencies

None new. `find_slots` still reaches Google Routes API (`GOOGLE_MAPS_API_KEY`) for drive deltas via
`optimizeStopOrder`; that is advisory and unaffected by the table remodel. Supabase/PostgREST
constrain the shape: no array-element foreign keys, and resource embedding is generated from real
FKs (so a `uuid[]` of technicians loses `technicians!inner(...)` embedding everywhere).

## Constraints and Invariants

1. **`visits` rows are per-NOTE, not per-trip.** No dedup exists in `recordFieldNote`.
2. **A reschedule mints a new assignment id** — an assignment id cannot name a visit over time.
3. **`no_confirmed_overlap` blocks one person twice, never two people in one slot** — already
   multi-person-friendly, and not portable to a single row holding several people.
4. **`assignment_placed_or_windowed`** enforces exactly one of {placed, windowed} — this is the
   existing skeleton of committed-vs-placed.
5. **Naive-local timestamps.** Assignment times are stamped `+00` but mean firm-local; `at time zone`
   on them yields a wrong answer. Read `starts_at` raw.
6. **`uq_observations_subject_ever` is once-ever per `(tenant, kind, subject_ref)`, detector rows
   only** — subject identity is load-bearing.
7. **Append-only triggers** on `raw_captures` and `schedule_events`.
8. **The doctrine already teaches both meanings of "visit"** (`SPINE_VIEW_CATALOG`).

## Decision Points

**(a) Which table survives, mechanically.** The user has ruled the *name* `visits` survives. Three
mechanics reach that: rename `assignments` → `visits` after dropping today's `visits` (keeps the FK,
the enum, both window shapes and the exclusion constraint; loses `attributes`/`labor_hours` unless
re-added, and destroys note-linkage under the waiver); add the missing ~9 columns to today's `visits`
and migrate assignment rows in (keeps L1 links; must rebuild the FK, enum, CHECKs and the exclusion
constraint from scratch, and must de-duplicate the per-note rows); or keep both and make `visits`
authoritative (no migration, but the two-table confusion the rung exists to remove survives).

**(b) Multi-technician representation.** A participant child table preserves a per-person exclusion
constraint and PostgREST embedding, at the cost of a join everywhere and a second table. `uuid[]`
keeps one row per visit but **loses `no_confirmed_overlap` entirely** and loses FK embedding.
N columns (`technician_id_1..n`) keeps FKs but caps the crew and multiplies every matcher by N.

**(c) The four states: enum column vs derived.** An enum is explicit and greppable but must be kept
consistent with the timestamps. Deriving from `(starts_at, started_at, completed_at, note count)`
cannot drift, but "committed but unplaced" and "cancelled" have no timestamp to derive from, so at
least those need storage.

**(d) subject_ref identity.** Either accept that old assignment-keyed observations/nudges are orphans
(risking the same gap observed twice under two identities), or rewrite existing `subject_ref` values
in the migration — which requires a mapping from assignment id to the new visit id, and `nudges`/
`observations`/`review_items` all carry the column with no FK to validate against.

**(e) `schedule_events.assignment_id` under append-only.** Whether `ON DELETE SET NULL` fires the
`schedule_events_append_only` trigger decides whether the old schedule's history can survive the
retirement at all, or must be dropped under the waiver.

**(f) Promise columns: dropped or retained-inert.** Rung 8's precedent is instructive — `locked` was
dropped, and the drop had to go **code-first** because running code still wrote it. The same ordering
question applies to `promise_level`, which has a NOT NULL default and a CHECK.

**(g) Destructive vs additive migration.** The waiver permits destruction. Additive keeps L1 intact
but leaves per-note `visits` rows to reconcile against schedule rows with no key to join on.

## Open Questions

1. **Does `ON DELETE SET NULL` trip `raise_append_only`?** This is the single question that most
   changes the migration's shape (decision e). Needs a probe on the local stack, not reading.
2. **How many rows are actually involved?** The local stack is empty and the pilot was out of scope.
   Sizing needs a read-only count on the pilot at plan time.
3. **How does a note attach to a visit once visits are schedulable?** `recordFieldNote` currently
   always creates. Attach-to-existing needs a matching rule (which visit?) that does not exist.
4. **Is any promise-reading branch now unreachable** after rung 8 deleted the solver? Needs a
   call-graph pass.
5. **What happens to a note with no scheduled visit** (walk-in, emergency)? Both "create as happened"
   and "attach when one exists" must survive.
6. **`listVisitsForJob` has no callers** — dead export, or an intended seam?
