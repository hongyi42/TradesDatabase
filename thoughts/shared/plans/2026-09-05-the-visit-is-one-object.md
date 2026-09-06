---
date: 2026-09-05
task: Rung 9b — the visit is one object: rename assignments→visits, drop the per-note visits table, moves in place, notes attach through visit_notes, four derived stages
research: thoughts/shared/research/2026-09-05-the-visit-is-one-object.md
status: draft
supersedes: thoughts/shared/plans/2026-07-03-scheduling-foundation.md
---

**`supersedes:`** overturns ONE decision there — *"Reschedule = cancel + insert, never edit times"* (:56-57,
:174). Everything else in it stands; the 2026-09-03 plan was already superseded by the remodel.

## Overview
Two tables both mean "visit" and nothing joins them: `assignments` (the schedule, written by every `*_visit`
tool) and `visits` (one row PER FIELD NOTE, never scheduled). This plan makes ONE record per trip with a derived
lifecycle **committed → placed → happened → reported**, keeps the name `visits`, and keeps every existing id.
Probed 2026-09-05 (local stack, rolled back): `ON DELETE SET NULL` **trips** `raise_append_only` on both
`raw_captures.visit_id` and `schedule_events.assignment_id`; `DROP TABLE … CASCADE` does not; `RENAME` keeps the
FK and fires nothing; an in-place `UPDATE` of the schedule row works. Pilot rows the migration carries: 467
schedule rows (303 live), 321 schedule_events (288 linked), 20 per-note visit rows, 0 L1 rows pointing at them.

## Decisions
- **Survivor = rename `assignments` → `visits`** *(settled by the probes)* — deleting or copying the 288
  event-linked rows is impossible under append-only; a rename keeps ids, history, and every `subject_ref`
  (nudges/observations/review_items) untouched. The old `visits` table is dropped with CASCADE.
- **The 20 per-note rows are dropped** *(user, 2026-09-05: "all of the data in the pilot is test and seeded")*
  — their notes stay in L1. No trigger is ever disabled by this plan.
- **A move is an UPDATE in place** *(user, rec. accepted)* — the visit keeps its id across moves/attaches;
  history lives in `schedule_events`; the cancel-first stranding window disappears; `v_cancelled_visits` means
  cancelled; the `created_at`-carry hack goes.
- **Stages are derived, the enum stays** *(user, rec. accepted)* — `visit_status` keeps
  `proposed|confirmed|cancelled|completed`; stage = committed (confirmed, untimed) / placed (confirmed, timed) /
  happened (completed) / reported (any linked note) / cancelled, as `v_schedule.stage` and `stageOf()`.
  `proposed` is written by nothing (`bookVisit` passes `confirmed`, booking.ts:481) — later cleanup.
- **Notes attach by rule** *(user, rec. accepted)* — the job's placed visit on the note's firm-local day (same
  technician if the visit has one; ties → nearest start), else the job's single live visit, else a NEW visit
  created as happened (untimed, `completed_at` = note time).
- **A note marks a placed visit happened** *(user, rec. accepted)* — first note with time ≥ visit start sets
  `completed`/`completed_at`; a note before the start attaches but does not.
- **Multi-technician is rung 9c** *(user, rec. accepted)* — `technician_id` stays single and nullable.
- **Rename all the way** *(user, rec. accepted)* — `visitId` in every tool arg/result, `v_schedule.visit_id`,
  the board API and `web/board/board.js`; then re-wire the fleet. (One exception below: the append-only
  `schedule_events` column.)
- **Note→visit link is a table** *(mine)* — L1 is inserted BEFORE the visit is resolved (every
  `recordFieldNote` caller passes `captureId`) and cannot be updated, so `raw_captures.visit_id` can never carry
  it. `visit_notes(visit_id, capture_id)` is append-only. The column stays (retractions copy it), FK re-pointed.
- **A compat view named `assignments` bridges the deploy** *(mine)* — a plain `select … from visits` view is
  auto-updatable, so the five Render services keep working between migration and deploy; dropped by a second
  migration once all five are live. **`schedule_events.assignment_id` keeps its NAME this rung** *(reviewer)* —
  that table is append-only and a column has no bridge, so renaming it would 400 every schedule write in the
  window; the TS input is `visitId` mapped onto the column. Code-first rename later.
- **Overdue-gap subject = `${visitId}@${starts_at}`** *(reviewer finding)* — `uq_observations_subject_ever` is
  once-ever per subject; with ids surviving moves, a visit flagged, moved and overdue again would never be
  re-detected. Bare-id rows already on file still parse (no `@` → the whole string).
- **Only a technician channel CREATES a visit from a note** *(reviewer finding)* — and this is a rule about
  the NOTE door, not about people. Managers create visits all day through `book_visit`, which is admin-gated
  and untouched by this rung; `record_field_note`'s schema only accepts `technician_voice|technician_photo|
  technician_note`, so a manager filing a note still creates one. What the gate excludes is inbound
  CORRESPONDENCE — `email`/`phone_call`/`web_form` — which builds customer + job only. A customer's email is
  not a trip, and now that `visits` IS the schedule such a row would show on the board as work nobody did.
  **INTERIM, not permanent** *(user, 2026-09-05)*: rung 10 is where inbound starts creating a COMMITTED
  (unplaced) visit, and it covers **email as well as calls** — *"it's just an extra input path similar to
  phone calls anyways."*
- **`completed_at` is naive-local**, the same convention as `starts_at`/`ends_at` *(reviewer finding)*.
- **Freshness keeps two homes, one re-sourced** *(mine)* — "visit rows minted since the floor" becomes "notes
  linked since the floor" (`visit_notes`); job-stamped captures unchanged. Same for `listJobActivity`,
  `mv_whiplash`'s visit arm, `foldImpact`. **`listVisitsForJob` is deleted** — zero callers.
- **Build in a worktree** *(mine)* — `scripts/date-eval/*` and `docs/engineering-memory.md` are being edited
  uncommitted by the OpenRouter session and the rename touches both; `scripts/second-stack.sh`, rebase after.

## Plain-language walkthrough
```
BEFORE                                            AFTER
book_visit ─► assignments ──move = cancel+insert   book_visit ─► visits (one row per trip, same id for life)
                 │ (new id every move)                committed ─move (update)─► placed ─► happened ─► reported
   schedule_events.assignment_id                                                   ▲              ▲
field note ─► visits (ONE ROW PER NOTE,             schedule_events (history,    a note lands   visit_notes
              never scheduled, no link)             column name kept)           here          (note ↔ visit)
```

**Phase 1 — the schema and the rename.** One migration renames the schedule table to `visits`, adds the four
"what happened" columns (started, completed, labor hours, attributes), drops the per-note table, creates the
`visit_notes` link table, and rebuilds the four views that read either table. TypeScript, scripts, seeds and
eval fixtures follow. You notice nothing yet: one table called visits, none called assignments.

**Phase 2 — one object.** Moving or attaching a person edits the row instead of cancelling it and making a new
one, so a visit keeps its id for life. Every tool, the board and its web page say `visitId`. The schedule view
gains a `stage` column, so "which visits are committed but not placed" is plain SQL.

**Phase 3 — notes land on the trip.** A technician's note attaches to the visit it belongs to (same job, same
day) instead of minting a row; a note about a calendar trip marks it happened, and the overdue detector stops.

**Phase 4 — doctrine, docs, deploy.** Catalog and docs describe one visit; the migration goes to the pilot with
the bridge view in place; five Render services deploy from the synced fork; the bridge view is dropped; six seats
re-wired s2 first; the rung 9a seat checks re-run plus a technician note that lands on the visit.

## Secrets & env preflight
- **Phase 1–3:** none new (`.env.test` local stack, `already required`).
- **Phase 4:** Render MCP on workspace `tea-d69903h5pdvs738dm81g` (`already required`); `supabase-test` MCP
  (`already required`); `ssh tradesbox` (`already required`); **GitHub write access to the fork
  `Yu-C1/TradesDatabase`** — Render deploys from it, merging to `hongyi42` does nothing; owner: Yutao. Surface
  this at review: if nobody in the session can sync the fork, Phase 4 blocks on a human.

## Phase 1: The schema and the rename
### What this phase does
Lands `supabase/migrations/20260906140000_the_visit_is_one_object.sql` and its companion
`20260906140100_drop_assignments_compat_view.sql`, regenerates types from the LOCAL stack, merges
`src/db/assignments.ts` into `src/db/visits.ts` under visit names, and repoints the four readers of the old
per-note table at `visit_notes`. Per-note behaviour is preserved verbatim for this phase (one visit + one link
per note) so test shapes hold; Phase 3 replaces it.

### Changes required
**`supabase/migrations/20260906140000_the_visit_is_one_object.sql`** — in this order:
1. `drop view mv_whiplash; drop view v_visits; drop view v_schedule; drop view v_cancelled_visits;` (DROP+CREATE
   precedent `20260906120000_the_rails_come_out.sql`; grants re-asserted as its :140-146).
2. `drop table visits cascade;` — the 20 rows and `raw_captures_visit_id_fkey` go; the column stays.
3. `alter table assignments rename to visits; alter type assignment_status rename to visit_status;` then rename
   every object still carrying the old name (`\d assignments` first: pkey, the job/tenant/`(technician_id,
   starts_at)` indexes, `assignments_check`, trigger `assignments_set_updated_at`). `no_confirmed_overlap` keeps its name.
4. `alter table visits add column started_at timestamptz, add column completed_at timestamptz, add column
   labor_hours numeric, add column attributes jsonb not null default '{}';` then `update visits v set completed_at
   = coalesce(v.ends_at, (v.updated_at at time zone tn.timezone) at time zone 'UTC') from tenants tn where tn.id =
   v.tenant_id and v.status='completed';` (naive-local, like `ends_at`) then `check (status <> 'completed' or
   completed_at is not null)`. `schedule_events` is NOT touched (Decisions).
5. `alter table raw_captures add constraint raw_captures_visit_id_fkey foreign key (visit_id) references visits(id) on delete set null;`
6. `create table visit_notes (tenant_id uuid not null references tenants(id), visit_id uuid not null references
   visits(id), capture_id uuid not null references raw_captures(id), created_at timestamptz not null default now(),
   primary key (visit_id, capture_id));` indexes `(capture_id)`, `(tenant_id, visit_id)`; trigger
   `visit_notes_append_only … raise_append_only()`; `revoke all on visit_notes from anon, authenticated;`
7. Recreate `v_schedule` as `20260906120000` :1-40 with `a.id as visit_id`, `a.completed_at`, and `case when
   a.status='cancelled' then 'cancelled' when a.status='completed' then (case when exists (select 1 from
   visit_notes n where n.visit_id=a.id) then 'reported' else 'happened' end) when a.starts_at is null then
   'committed' else 'placed' end as stage`; `v_cancelled_visits` with `visit_id`; new `v_visit_notes(visit_id,
   capture_id, job_id, created_at)` tenant-scoped via `current_setting('spine.tenant_id')`; `mv_whiplash`
   verbatim from `20260903120000_decisions_without_a_gap.sql:66-108` with its second `not exists` reading
   `visit_notes n join raw_captures vc on vc.id=n.capture_id join visits v on v.id=n.visit_id`, windowed on
   `n.created_at`. `grant select on v_schedule, v_cancelled_visits, v_visit_notes to spine_reader; revoke all on
   … from anon, authenticated;` plus the `mv_whiplash` revoke from `20260824020000_planner_metrics_v2.sql:130`.
8. `create view assignments as select id, tenant_id, job_id, technician_id, starts_at, ends_at, status,
   source_capture_id, reason, created_at, updated_at from visits; revoke all on assignments from anon, authenticated;`

**`supabase/migrations/20260906140100_drop_assignments_compat_view.sql`** — `drop view if exists assignments;`
Both apply locally on `db reset`; on the pilot the second is applied only at Phase 4 step 5.

**`src/db/database.types.ts`** — `npx supabase gen types typescript --local > src/db/database.types.ts`
(never `npm run gen:types`: it is `--linked` = the pilot's older schema).

**`src/db/visits.ts`** — the merged module: every export of `src/db/assignments.ts` moves here under visit names
(`Assignment`→`Visit`, `AssignmentStatus`→`VisitStatus`, `PlacedAssignment`→`PlacedVisit`,
`ASSIGNMENT_TRANSITIONS`→`VISIT_TRANSITIONS`, `createAssignment`→`createVisit` (input gains `completedAt?`,
`laborHours?`, `attributes?`; keeps `createdAt?` until Phase 2), `updateAssignmentStatus`→`updateVisitStatus`,
`getAssignmentForTenant`→`getVisitForTenant`, `listAssignments*`→`listVisits*`, `Assignment{Detail,Day,Bucket}Row`
→`Visit*`, `.from('assignments')`→`.from('visits')`). Delete the old `createVisit`, `listVisitsForJob`,
`listVisitTimesForJobs`; `listVisitsForCustomer` (:79-87) becomes the past-work read: embed
`visits(*, technicians(ref, display_name))` filtered `visits.status = 'completed'` (it feeds `recentVisits`,
documented at server.ts:330 as evidence, not the schedule — unfiltered it would list every future booking).
Add `insertVisitNote({tenantId, visitId, captureId})` as an upsert with `ignoreDuplicates` on the PK (a
redelivered capture must not 23505) and `listNoteTimesForJobs(tenantId, jobIds, sinceUtcIso)` → `{job_id,
created_at}[]` over `visit_notes` embedding `visits(job_id)`, paged like the old reader. Delete
`src/db/assignments.ts` and `src/db/index.ts:17`.

**Readers of the old per-note table** — `src/db/rawCaptures.ts:205-214` `captureHasLinkedVisit` → exists in
`visit_notes`; `:136-149` `captureHasLinkedL2` (the dedup/heal probe at recordFieldNote.ts:128,167) gains a
`visit_notes` arm keyed on `capture_id` — without it a redelivered capture re-runs extraction; `:288-330` the
`viaVisit` map → `visit_notes` embedding `visits(job_id)`, `created_at ≥ floor`;
`src/db/foldImpact.ts:72-78` and :105-106 → `visit_notes` by `capture_id` embedding `visits(id, job_id,
starts_at, technician_id)` (`scheduled_at`/`technician_name` are gone); `src/db/context.ts:4,83` keeps
`listVisitsForCustomer` and the renamed upcoming read; `src/synthesis/grounding.ts:78` prints
`v.technicians?.display_name` from the embed above; `src/synthesis/fixtures.ts:45-52` (in `tsconfig` include)
loses `technician_name`/`scheduled_at`; `src/jobs/watchers.ts:19,198,280` → `listNoteTimesForJobs` (dep `listNoteTimes`).

**`src/writePath/recordFieldNote.ts:266-275`** (interim; Phase 3 rewrites it): ONLY when `input.channel` is a
`technician_*` channel (every caller passes `channel` — webhook.ts:260, worker.ts:130 `phone_call`, ingest.ts,
server.ts:2150) — otherwise skip the visit step and return no `visitId`; resolve `technicianRef` → id via
`getTechnician(tenantId, ref)` (the lookup `resolve_review` uses), then `createVisit({…, technicianId,
startsAt:null, endsAt:null, status:'completed', completedAt: capturedAt, laborHours, attributes:
buildVisitAttributes(extracted), sourceCaptureId: captureId})` and `insertVisitNote(...)`. Return unchanged.

**Mechanical rename** (`assignment` → visit vocabulary; `.from('assignments')` reaches 0; tool-facing
`assignmentId` may wait for Phase 2): `src/schedule/{booking,boardRead,fit}.ts`, `src/mcp/{server,httpServer}.ts`,
`src/telegram/{boardApi,boardNotify}.ts`, `src/writePath/identityMatch.ts`, `src/eval/{corpus,plannerSim,
toolCases,worldSpec,worldManifest}.ts`, `src/teamLead/planner.ts`, `src/routes/daySource.ts`, `src/db/{context,
technicians,jobs,scheduleEvents,reviewItems,nudges,sandboxPool}.ts` (`appendScheduleEvent` input
`assignmentId`→`visitId`), `src/jobs/nudgeKinds.ts`. Scripts: `scripts/seed.mjs:140-141` (truncate list →
`visits, visit_notes`, no `assignments`), `scripts/spine-eval/world.mjs:107,111`, `scripts/spine-eval/
verify-world.mjs` (every `from assignments`), `scripts/backfill-schedule.mjs`, `scripts/date-eval/{plan,
run-direct,adjudicate-db}.mjs`, `scripts/agentic-eval/run.mjs:163,273`, `scripts/smoke-http.mjs`.
`scripts/seed.mjs:369-378` (old `createVisit({technicianName…})` → the new shape, or drop the demo note rows).
Tests that pin the old shapes: `src/db/spine.test.ts:7,70,149-179`, `src/db/spineViews.test.ts:153-166,228-245,
280` (`v_visits` → `v_visit_notes`), `src/mcp/server.test.ts:1527,6971`, `src/db/context.test.ts:39`,
`src/db/retractions.test.ts:133-136`, `src/db/rawCaptures.test.ts:107-172`.

**`src/db/schema.test.ts`** — :38-50 `visits` = the merged column set; :100-103, :134-157 and :160-168 →
`visits`; add: no TABLE `assignments` (relkind `r`), `visit_notes` + trigger `visit_notes_append_only`,
`v_schedule` has `visit_id` and `stage`.

### Automated verification — ✅ 2026-09-05, worktree `.claude/worktrees/rung-9b`, stack `TradesDatabase-rung-9b` (545xx)
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` — suite **2539 passed / 12 skipped
      (2551)**; baseline before the phase was 2533 / 12 (2545). +6 tests, **0 deleted** (the count is the
      audit: 4 new schema tests, 1 visit_notes behaviour test, 1 redelivery test)
- [x] `npx supabase db reset` applies both migrations from scratch (`project_id = "TradesDatabase-rung-9b"`
      checked first), twice — once after the CHECK was dropped, once after the `v_visit_notes` tenant fix
- [x] `grep -rn "assignments" src scripts` (non-test) → **2**, both a DIFFERENT concept (sandbox-to-host
      assignments: `src/mcp/server.ts:5168`, `scripts/assign-host.mjs:4`). Gate refined to that, honestly:
      the intent was "no references to the old TABLE". `\bAssignment\b` → 0 · `.from('assignments')` → 0 ·
      SQL `from|into|update|join assignments` anywhere incl. tests → 0
- [x] `npm run seed:local` rebuilds the playground on the merged schema; read-back through the new view:
      `stage` = 2 `placed` (confirmed + timed) and 1 `reported` (completed + a `visit_notes` link), and
      `v_visit_notes` resolves that link to its job. (`verify-world.mjs` needs a spine-eval world, which this
      stack has none of — not run.)
- [x] new/updated tests: `src/db/schema.test.ts` (no `assignments` relation; `visits` absorbed the four
      happened columns and did NOT resurrect `scheduled_at`/`technician_name`; `visit_notes` + its trigger;
      `v_schedule` has `visit_id`+`stage` and no `assignment_id`), `src/jobs/watchers.test.ts` (dep renamed
      `listNoteTimes`), and a `visit_notes` behaviour test in `src/db/scheduling.test.ts` — UPDATE raises
      `is append-only`, a repeat link is a no-op not a 23505, DELETE cascades with the visit, and the L1
      capture survives it

**Three divergences from this plan's text, all deliberate, all found by building it:**
1. **`schedule_events.assignment_id` keeps its NAME** (reviewer, pre-implementation) — already in Decisions.
2. **`visit_notes` is append-only on UPDATE only, and cascades on DELETE.** Blocking DELETE would have made
   an L2 row undeletable the moment one note touched it — the exact "L1 pins L2" trap that forced the rename
   instead of a copy. A link is derived data; the evidence stays in L1 either way.
3. **The `visits_completed_has_stamp` CHECK was dropped.** It blocked the legal status walk: `cancel_job`'s
   cascade, `updateVisitStatus(id,'completed')` and every eval seeder complete a visit knowing only THAT it
   finished, and `completed_at` is naive-local so they cannot compute one without the tenant's timezone. The
   stage derives from `status`; the stamp is detail filled when a note says when.

**Reviewer findings, fixed:** `v_visit_notes` joined `visits` across an id-only FK with no tenant re-check —
its consumer is the planner writing raw SQL and cannot re-check, so the wall is now in the view. A
cross-tenant test in `rawCaptures.test.ts` had gone vacuous (its fixture used `source_capture_id`, which the
reader no longer walks) and now inserts a real link. A duplicate `export * from './visits.js'` was removed.
**Accepted, pinned, not fixed:** a non-technician capture that resolves to an EXISTING customer AND job now
leaves no link, so a redelivery re-runs the extractor — one repeat model call, writing nothing twice
(pinned by a new test; the same acceptance the unmatched-email path already carried).
**Carried into Phase 2 as entry criteria:** `SPINE_VIEW_CATALOG` (`src/mcp/server.ts:771,777`) and
`plannerPrompt.ts` still advertise `v_visits` and `v_schedule.assignment_id`, and two tests PIN those stale
strings — so no gate fails while the doctrine is wrong. It must be true before Phase 4 deploys.

### Live verification (agent-executable) — none until Phase 4. ### Manual verification — none.
*Continue to Phase 2 once automated checks pass.*

## Phase 2: One object — moves in place, stages, one name everywhere
### What this phase does
Replaces cancel-plus-insert with an in-place update for moves and attaches, derives the stage, and finishes the
rename on every tool-facing, board-facing, and event-facing name.

### Changes required
**Overdue subject** — `src/jobs/nudgeKinds.ts:87` builds `subject_ref` as `${visit.id}@${visit.starts_at}`;
add `visitIdOfSubject(ref)` (split on `@`, bare ids pass through) and use it at `src/jobs/watchers.ts:495-498`,
`src/teamLead/planner.ts:3800` (`listVisitsByIds` over parsed ids), `src/eval/plannerSim.ts:255`; comments at
`src/db/nudges.ts:39`, `src/db/reviewItems.ts:46`, `nudgeKinds.ts:29,61`. Test: flagged → moved → overdue again
mints a second observation.

**`src/db/visits.ts`** — replace `rescheduleAssignment` (old assignments.ts:157-190) with
`moveVisitRow(id, {startsAt, endsAt, technicianId?, reason, status?})`: one `.update({starts_at, ends_at,
…technician_id when !== undefined, reason})…eq('id').eq('status', current.status).select().maybeSingle()`;
23P01 surfaces via `isOverlapViolation` and the row is UNCHANGED (atomic). Delete `createdAt` from
`CreateVisitInput` (:44) and the "Times on a row are immutable" comment (:18-20). Add
`stageOf(v: Visit, hasNotes: boolean): 'committed'|'placed'|'happened'|'reported'|'cancelled'` mirroring the
SQL `case` in Phase 1 step 8, and `updateVisitStatus(id, next, reason?, completedAt?)`.

**`src/schedule/booking.ts`** — `moveVisit` (:689-760): call `moveVisitRow`; result becomes
`{ visit: Visit; previousTechnicianId: string | null; warning? }`; delete the `move_failed` stranding branch
(:705-735) — a failed UPDATE changes nothing; the `'moved'` event detail (:737-748) carries
`previousTechnicianId` instead of `previousAssignmentId`. `attachUnplacedVisit` (:891-950): same — update
`technician_id` in place, result `{ visit, previousTechnicianId }`, its event detail likewise.
`unscheduleVisit`/`cancelJob` unchanged (status flips).

**`src/mcp/server.ts`** — tool schemas :1063, :1090, :1550 and descriptions `assignmentId`→`visitId`; handlers
book :4342, move :4431-4432 (`visitId: moved.visit.id`, no `previousAssignmentId`), unschedule :4471/:4537/:4556,
get_team_schedule rows :4140/:4177 (`visitId`, add `stage`), :4658, the two `assignment_id`, `suggestion` :1906.
SPINE_VIEW_CATALOG :732-800: `v_schedule(visit_id, …, stage, completed_at)`, `v_cancelled_visits(visit_id, …)`,
and the `v_visits` entry (:771-778) becomes `v_visit_notes(visit_id, capture_id, job_id, created_at) — the
note-to-visit bridge: join v_visit_notes on capture_id = v_captures.id`.

**Board and friends** — `src/telegram/boardApi.ts` :243-258, :392, :486-565, :603 (param/result `visitId`);
`web/board/board.js` (15 sites); `src/schedule/boardRead.ts:43`; `src/telegram/boardNotify.ts` :89 unchanged
(`ev.assignment_id` — the column keeps its name), :106-110 read `previousTechnicianId` from detail and look the person up by id (the row IS the moved visit);
`src/writePath/identityMatch.ts` :43/:86/:106/:130; `src/db/context.ts` :29/:108; `src/schedule/fit.ts` :345
`excludeVisitId`, :439/:454/:482; `src/eval/toolCases.ts` :690/:730 and every grader keyed on `assignmentId`.

**Tests** — `booking.test.ts`: a move returns the SAME id with new times; an overlapping move throws and the row
is unchanged (read back); attach keeps id. `scheduling.test.ts`: `moveVisitRow` CAS on status; SQL `stage` and
`stageOf` agree for one row per stage. `server.test.ts`: keys `visitId`/`stage`, no `previousAssignmentId`; the
:189 length pin unchanged. `boardApi.test.ts`: param names. `boardNotify` moved-between-people from
`previousTechnicianId`. Table-driven `stageOf`.

### Automated verification — ✅ 2026-09-05
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` — **2544 passed / 12 skipped
      (2556)**; Phase 1 ended at 2539 / 12 (2551). +5 tests, **0 deleted**: the three reschedule cases were
      INVERTED into move cases (net 0), and five were added — overlap-leaves-the-visit-put, cannot-move-a-
      cancelled-visit, the CAS loser, `stageOf` vs `v_schedule.stage`, and the DB guard firing mid-move
      through `moveVisit` itself. Full suite run twice more to confirm no flake.
- [x] old identifiers (non-test) → **1**, and it is deliberate: `boardNotify.ts:128` reads
      `previousAssignmentId` as the FALLBACK for `moved` events already on file (schedule_events is
      append-only, so those rows are permanent) and for any written during the deploy window by a service
      still on the old commit. `assignment_id` survives only in `scheduleEvents.ts` (the kept column) and
      `boardNotify.ts:100` (reading it).
- [x] `npx supabase db reset && npm test` — both migrations apply from scratch, suite green after

**Beyond the plan's text, and why.** The plan's "Overdue subject" bullet named the mint site and three
readers but missed the DEDUP PROBE (`watchers.ts:479-487`), which asks the three stores for exact
`subject_ref` values. Changing the mint alone would have made every historical gap read as never-surfaced
and re-flagged the entire backlog on the first tick after deploy — 100 open overdue items on the pilot. The
probe now asks for BOTH spellings and matches either, so legacy bare-id rows still suppress and a moved
visit still re-detects. Also `moveVisitRow` refuses a cancelled/completed visit: the old cancel-then-insert
got that for free from the status machine (`cancelled → cancelled` is not a legal edge), and an UPDATE has
to say it.

**Reviewer findings, fixed.** (1) `plannerSim` built the subject from a hand-formatted time string
(`…T09:00:00.000Z`) while the watcher mints from the row PostgREST returns (`…T09:00:00+00:00`) — the keys
never matched, so every sim tick minted a duplicate observation; it now uses the row's own value. (2)
`boardNotify` read only the new `previousTechnicianId`, so the person who LOST a visit would have stopped
being notified for every event already on file — a fallback restores it. (3) `attachUnplacedVisit`
hand-wrote a Supabase query inside `src/schedule/` (CLAUDE.md forbids it) and dropped the explicit
`status:'confirmed'` the old create carried, which would have left an attached `proposed` row invisible to
every confirmed-filtered reader; it is now `attachVisitTechnician` in the typed layer. (4) The 23P01 path
through `moveVisit` was untested — the existing test only reached `resolveMove`'s pre-check. (5) The CAS
branch was untested and its scope undocumented; the new test uses a ROW LOCK rather than a sleep, because
the first version raced and failed intermittently. (6) `v_schedule`'s `cancelled` arm was unreachable (the
view is confirmed + completed by construction) and has been removed, so no reader is told to query a value
that returns nothing. (7) The two comments the plan named were updated.

### Live verification (agent-executable) — none until Phase 4. ### Manual verification — none.
*Continue to Phase 3.*

## Phase 3: Notes land on the trip
### What this phase does
Replaces the interim per-note write with the attach rule, marks a placed visit happened on its first
on-or-after-start note, and makes retractions follow the link.

### Entry criteria — carried in from Phase 1's review, MUST be done in this phase
1. **ANY channel may ATTACH; only a technician channel may CREATE.** Phase 1 gated the whole visit step on
   `technician_*`, which is right for CREATING but left a hole: an inbound email or call that matched an
   EXISTING customer AND job now links nothing, so the capture is invisible to BOTH activity homes
   (`listJobStampedCaptureTimes` finds no job stamp, `listNoteTimesForJobs` finds no link). Consequences:
   a customer's emailed answer to a gap cannot be cited (cite-or-don't-close), and the overdue watcher reads
   the job as SILENT and keeps nudging. Pre-9b the minted visit carried both links by accident.
   Fix: `resolveVisitForNote` runs for every channel; step (3) — create as happened — is technician-only,
   and a non-technician note with no visit to attach to simply links nothing, as today. The split to hold
   onto: **ATTACH is channel-blind, CREATE is not.** Rung 10 then gives inbound (call AND email) its own
   creation path — a COMMITTED unplaced visit, never a completed one — so this gate expires there rather
   than hardening into a rule.
2. **That also closes the redelivery hole** Phase 1 accepted: with a link present, `captureHasLinkedL2`
   short-circuits again. Until it does, a redelivered inbound note re-runs the extractor, and a stale
   forward status signal can land late — an email whose `completed` signal was SKIPPED on pass 1 (job was
   `open`) becomes legal on a redelivery once the job reached `in_progress`. Add a test for that edge.

### Changes required
**`src/writePath/attachNote.ts`** (new) — `resolveVisitForNote({tenantId, jobId, technicianId, capturedAt})`:
candidates = `listVisitsForJob`-style read of live rows (`status in ('confirmed','completed')`); (1) placed rows
whose firm-local day (tenant `timezone`; `starts_at` is naive-local — compare its date part to `capturedAt`
converted with the same helper `boardRead.ts` uses) equals the note's day, filtered to `technician_id is null or
= technicianId`, nearest `|starts_at − capturedAt|` wins; (2) else exactly one live row → it; (3) else
`createVisit({status:'completed', startsAt:null, endsAt:null, completedAt: capturedAt, technicianId,
sourceCaptureId: captureId})`. Returns `{ visit, created: boolean }`.

**`src/writePath/recordFieldNote.ts:266-275`** — (technician channels only, as Phase 1) use
`resolveVisitForNote`, then `insertVisitNote`; compare in ONE convention: `noteLocal = naiveLocalISO(
localDateISO(capturedAt, tz), localHHMM(capturedAt, tz))` (`availability.ts:50`, `booking.ts:52`; `starts_at` is
already naive-local, identityMatch.ts:73-85 documents the trap); if the visit is `confirmed` and `starts_at ≤
noteLocal` → `updateVisitStatus(id,'completed', null, noteLocal)` and
`appendScheduleEvent({kind:'happened'})` (plain-text kind, no push — the `'job_cancelled'` precedent,
booking.ts:1131); merge `buildVisitAttributes(extracted)` into `visits.attributes` (shallow merge, latest wins)
and add `laborHours` to `labor_hours`. Return adds `stage`.

**Readers that assumed `confirmed` means "the visit"** — `src/db/jobs.ts:229-235` `listCostGapCandidates` and
`src/writePath/identityMatch.ts:89-95` both filter `status = 'confirmed'`; a reported visit is now `completed`,
so both go `.in('status', ['confirmed','completed'])` or the cost detector goes blind on exactly the reported
visits and a technician's second note of the day loses its schedule suggestion.

**`src/mcp/server.ts`** — record_field_note result (:2204) adds `stage`; the retraction insert (:3590-3602)
also `insertVisitNote` for the retraction capture when the target capture has a `visit_notes` row, so the
bridge follows the retraction. `src/jobs/watchers.ts` comment at the freshness call updated (notes, not rows).

**Tests** — `recordFieldNote.test.ts` (+ pg-backed cases in `scheduling.test.ts`): same-day placed visit →
attached, no new row; two notes → one visit, two `visit_notes`; other-day note, one live visit → attached; no
live visit → created as happened; note before start → attached, still `placed`; technician mismatch on a
two-visit day → the matching one; retraction linked; `mv_whiplash` suppressed by a linked note in the window;
`watchers.test.ts`: a linked note counts as freshness.

### Automated verification — ✅ 2026-09-05
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` — **2556 passed / 12 skipped
      (2568)**; Phase 2 ended at 2544 / 12 (2556). +12 tests, **0 deleted** (11 new attach/edge cases, one
      `mv_whiplash` case; the retraction-link assertion joined an existing test).
- [x] `npx supabase db reset && npm test` — green from a clean database. (One unrelated flake seen once:
      `src/model/toolLoop.test.ts`'s wall-clock-budget test is timing-sensitive and untouched by this
      branch.)

**The rule, stated once:** ATTACH is channel-blind; CREATE and REPORT are technician-only. Any channel may
link a capture to a trip that already exists — that is the evidence citation, and it is what makes a
customer's own answer visible to the planner and the watcher again. Only a technician channel may create a
trip, fold labor hours and L3 onto one, or mark one happened.

**Reviewer findings, fixed.** (1) The happened flip was channel-blind, so a customer emailing *"nobody ever
showed up"* at 10am for a 9am visit would have marked it completed — deleting it from
`listOverdueConfirmedVisits` (confirmed-only) FOREVER, silencing the detector with the complaint. Gated to
technician channels, with a test named for that failure. The same gate now covers `recordVisitReport`, so an
inbound extractor cannot edit a job's billing hours. (2) The flip is ADVISORY: L1, the link and the report
have all landed by then, so a visit cancelled mid-flight must not turn a recorded note into "note NOT
recorded" and invite a re-file. (3) `record_field_note` now returns `stage`. (4) Step 2 of the attach rule
(the job's ONE live visit, on any day) had no test — the write-up-the-next-morning case, which a same-day
rule alone gets wrong by minting a second trip. (5) The before-the-start fixture booked the last two minutes
of the day and would have failed if the suite ran inside them; it books tomorrow instead, which also covers
step 2. (6) The redelivery gap is NARROWED, not closed, and now says so in `rawCaptures.ts` and in a test
that documents it: an inbound capture on a job with no live visit still links nothing, so a redelivery
re-runs the extractor and a stale forward status signal can land late. **Rung 10 closes it** by giving
inbound (call AND email) its own committed visit.

### Live verification (agent-executable) — none until Phase 4. ### Manual verification — none.
*Continue to Phase 4.*

## Phase 4: Doctrine, docs, and the deploy
### What this phase does
Teaches one visit everywhere a human or model reads about it, applies the migration to the pilot in the only
order that keeps five services alive, re-wires the fleet, and proves the object end to end through the seats.

### Changes required
**Docs** — `docs/Three-Layer-Context-Spine-Overview.md` ("one trip by one technician" + the L2 diagram: one
`visits` object, four stages, `visit_notes`), `docs/onboarding.md`, `docs/control-plane.md`,
`docs/nemoclaw-tech-agent.md` (every `assignments`/`assignment_id`/`v_visits`), `docs/engineering-memory.md`
(ladder ~:3546 `9b BUILT`, a §9b record, the §8 `created_at`-carry trap retired). `Box_Setup_Stuff/bootstrap-box.sh`
§0c :694-742 names tools only — verify, leave. `2026-07-03-scheduling-foundation.md` :56 gets a superseded note.

**Deploy order** (the 9a lessons: fork, five services, three `autoDeploy: no`):
1. Dismiss open `pending_visit_cancel` / `pending_job_cancel` items on the pilot (15-min tokens).
2. `supabase-test` `apply_migration` `20260906140000` — the compat view keeps the running code alive. Read back
   `information_schema.columns` for `visits` (merged columns), `visit_notes`, `schedule_events.visit_id`; and
   `pg_class` shows `assignments` as relkind `v`. **Evidence is the query result.**
3. Sync `Yu-C1/TradesDatabase` (owner action), deploy ALL FIVE services, verify each `live` on the commit.
4. One `lifecycle-heart` tick: `ok:true`, `tenantErrors:0`.
5. `apply_migration` `20260906140100` (drop the compat view); read back `pg_class` → no `assignments`.
6. Wire all six seats, **s2 first**, over `bash -lc`; confirm the gateway's cached tools/list carries `visitId`
   (a seat turn that calls `move_visit` with `visitId` and gets `moved`).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` (docs-only changes still run the gates)

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP, Render MCP, `ssh tradesbox` (all connected today); fork access (above)
- [ ] Steps 2–5 above with their read-backs; schema md5 over `information_schema.columns` local == pilot
- [ ] Seat loop on s8 (rung 9a's recipe: `nemoclaw s8 exec … openclaw agent --session-id <fresh>`, no
      `--local`/`--deliver`), Marcus Ellery / job `9b014ad9…`: book untimed → `visitId`, row `confirmed, starts_at
      NULL`; move → **same `visitId`**, one row updated, `schedule_events` `moved` with `previousTechnicianId:
      null`; move again → same id; `record_field_note` from s5 dated the visit day → `visit_notes` row,
      `completed`, `v_schedule.stage='reported'`; unschedule placed → `needs_confirmation`. Read back every turn.
- [ ] Both `anon`/`authenticated` false on `v_schedule`, `v_cancelled_visits`, `v_visit_notes`, `visit_notes`

### Manual verification
- [ ] Telegram board: a moved visit's detail link still opens (`visitId`), the tray shows committed visits, a
      reported visit shows as done. *Manual list is non-empty — pause for the user after Phase 4.*

**Recorded, not built:** rung 9c multi-technician (participant table; `technician_id` stays the lead); **rung 10
— INBOUND commits a visit: CALL AND EMAIL** (user, 2026-09-05), extractor creates it untimed via `createVisit`,
web form to be settled with them; drop `proposed` from `visit_status` once a test pins that nothing writes it.
