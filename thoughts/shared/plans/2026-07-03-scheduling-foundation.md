---
date: 2026-07-03
task: Scheduling foundation — availability, areas, durations, timezone, assignments (Plan 1 of the auto-scheduling series)
research: thoughts/shared/research/2026-07-03-auto-scheduling-current-surfaces.md
status: complete # code complete + reviewed; DB apply reverted 2026-07-04 (see DB state note) — re-apply to reinstate
---

## Overview

Plan 1 of the auto-scheduling series. Builds the data foundation the scheduler needs and the
codebase lacks entirely (research: "none of its required inputs exist as data"): technician
availability + time-off, service-city lists, per-job-type duration defaults, tenant timezone,
and a first-class `assignments` table (DB owns the schedule — addendum decision 1) with a
database-enforced double-booking guard. Pure schema + typed DB layer + a pure availability
helper; no scheduler logic, no Google APIs, no new secrets.

**The series (later plans):** 2 — geocoding + grid drive-time cache; 3 — scheduler core
(candidate generation, scoring, proposals); 4 — autonomy tiers, approval flow, Telegram
alerts, booking lifecycle; 5 — recurring-job generation + sheet write-back push.

*Length flag: ~350 lines (>300 guideline). Scope already split five ways across the
series; the overage is the verbatim migration SQL and the adversarial-review notes —
kept because both remove implementer ambiguity (same call as the 2026-07-02 plan).*

> **DB state note (2026-07-04):** all three phases were implemented and fully verified
> (checked boxes + evidence below are real), then the schema was **rolled back from the TEST
> project at the user's request** — the DB is shared with a partner who is implementing
> concurrently, and two writers colliding on one test DB is worse than redoing the apply.
> The ledger entry `20260704210155` was removed; the partner's orphan
> `control_plane_lifecycle` objects were left untouched. **All code artifacts are kept and
> final** (migration file, typed layer, pure calculator, tests, seed). To reinstate: re-apply
> `supabase/migrations/20260704210155_scheduling_foundation.sql` via
> `mcp__supabase-test__apply_migration` (rename file to the new apply-time ledger version),
> regenerate types, `npm run seed` — no code changes needed. Until then the scheduling tests
> and seed fail against the stripped DB (expected).
>
> **Final review (multi-agent, 2026-07-04) — 5 correctness findings, all fixed in code:**
> (1) `rescheduleAssignment` now validates the new range BEFORE cancelling (bad input could
> destroy a confirmed booking); (2) `job_type` normalized (trim+lowercase) on duration write
> AND read — extractor-cased 'Install' no longer silently falls back to the default;
> (3) window END may be `'24:00'` so until-midnight shifts are representable (overnight =
> two windows across two days); (4) `isTechnicianAvailableOn` fails closed on malformed
> jsonb patterns instead of crashing the scheduling pass; (5) seed books the next WEEKDAY
> (never sat/sun, which jane's own pattern marks empty). Tests added for all five; pure
> tests + typecheck/lint/build re-verified green — the integration tests re-run at re-apply
> time. Cleanup nits surfaced, not acted on: shared transition-walker for jobs/assignments
> (jobs.ts drops error.code today), Intl.DateTimeFormat per-call construction (Plan 3 hot
> path), seed dayOffset duplication, test same-day coupling.

## Decisions

- **Assignments get a NEW table** — not `schedule_entries` (a Google-Sheet mirror keyed by
  sheet row number; writing scheduler rows there collides with sync semantics) and not
  `visits.scheduled_at` (visits are trip records minted by field notes, one per capture).
  User decision "DB owns the schedule" needs a table the scheduler owns outright.
- **Reschedule = cancel + insert, never edit times** — an assignment row's times are
  immutable; changing a booking cancels the row (with `reason`) and inserts a new one. Full
  history falls out of the rows themselves (addendum: every change auditable) — no separate
  events table, no trigger machinery.
- **Double-booking blocked by the database, not app code** — a Postgres exclusion constraint
  (btree_gist) rejects overlapping `confirmed` assignments for the same technician.
  `proposed` rows may overlap deliberately (alternative proposals). Mirrors the seat-cap
  trigger philosophy: structural, never agent-trusted.
- **New tables reference `technicians.id` (uuid FK), not the ref string** — the roster now
  exists; FKs give integrity. Refs remain the cross-system vocabulary (badges/Composio/L1);
  joins recover them.
- **Availability = JSONB weekly pattern on `technicians` + a `technician_time_off` table** —
  user decision (fixed weekly days + vacation/sick/emergency exceptions). Pattern is one
  value read whole → column; exceptions are date-ranged rows you query → table.
  `availability = null` means "never set" → scheduler treats the tech as unschedulable
  until the manager sets it (fail closed).
- **Service areas = `service_cities text[]` on `technicians`** — user decision (city list,
  soft bonus, per-tenant). Scoring uses it in Plan 3; this plan just stores it.
- **Durations = `job_type_durations` table + `tenants.default_job_minutes` fallback** — user
  decision (per-job-type defaults, manager-editable; default 120 min when a type is unset).
- **Timezone = `tenants.timezone` (IANA name, default `America/Los_Angeles`)** — "Monday"
  and "17:00" in availability mean the firm's local day/time. Fixes the research's UTC-day
  caveat for new code; existing `schedule_entries` reads are untouched (sheet mirror
  retires in Plan 5).
- **Availability interpretation is a pure function** (`src/schedule/availability.ts`) — no
  DB, no model; deterministic and unit-testable (overview §5: hardcode what must be correct).

## Plain-language walkthrough

**Phase 1 — new shelves in the database.** Adds the empty structures: a place per technician
for "which days/hours I work" and "my covered cities"; a time-off list (vacation/sick); a
small price-list-style table of "this job type takes N minutes"; the firm's timezone; and the
assignments table — the schedule itself, where "Mike, Tuesday 11:30–1:30, Smith job" lives.
The database itself refuses two confirmed bookings for the same tech at overlapping times.
You'd notice: tables exist, a deliberate double-book attempt errors.

**Phase 2 — the code that reads/writes those shelves.** Typed functions (set availability,
add time off, set durations) plus one pure calculator: "is Jane available on 2026-07-10 in
this firm's timezone?" combining her weekly pattern minus her time-off. You'd notice: tests
prove the calculator right, including timezone edges (an evening UTC timestamp still counts
as the right local day).

**Phase 3 — assignment operations.** Create/confirm/cancel/complete an assignment with the
same legal-transition guard style jobs already use; "reschedule" = cancel+create; and the
scheduler's first question, "which open jobs have no active booking?", gets its query.

```
technicians ──availability/cities──┐
tenants ──timezone/durations──────►│ (Plan 3 scheduler reads all of this)
jobs (open, unassigned) ──────────►│
                                   ▼
                          assignments  ◄── DB guard: no confirmed overlap per tech
                          proposed → confirmed → completed
                                   └→ cancelled (reason kept; history = old rows)
```

## Secrets & env preflight

- **Phase 1:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` — already
  required (test project). `supabase-test` MCP for applying the migration.
- **Phase 2:** none new.
- **Phase 3:** none new.

## Phase 1: Schema — availability, areas, durations, timezone, assignments

### What this phase does
One migration adds every scheduling column/table, applied to the TEST project; regenerate
types; schema tests lock the shapes. No behavior change anywhere (all new, nullable, or
defaulted).

### Changes required

**`supabase/migrations/<timestamp>_scheduling_foundation.sql`** (new; create via
`mcp__supabase-test__apply_migration`, then save the file named with the apply-time ledger
version — same convention as the 2026-07-01/02 plans)
```sql
-- Firm-local time interpretation + duration fallback.
alter table tenants
  add column timezone text not null default 'America/Los_Angeles',
  add column default_job_minutes integer not null default 120
    check (default_job_minutes > 0);

-- Weekly working pattern (firm-local times) + covered cities (soft area signal).
-- availability NULL = never configured -> scheduler treats as unschedulable.
-- Shape: {"mon":[["08:00","17:00"]], ... "sun":[]} — validated in the typed layer.
alter table technicians
  add column availability jsonb,
  add column service_cities text[] not null default '{}';

-- Date-ranged exceptions (vacation/sick/emergency). Whole days (user decision).
create table technician_time_off (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  technician_id uuid not null references technicians(id) on delete cascade,
  starts_on     date not null,
  ends_on       date not null,
  reason        text,
  created_at    timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index idx_time_off_technician on technician_time_off(technician_id, starts_on);
create index idx_time_off_tenant     on technician_time_off(tenant_id);

-- Manager-editable per-type duration defaults ("maintenance 60, install 480").
create table job_type_durations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  job_type   text not null,
  minutes    integer not null check (minutes > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, job_type)
);
create index idx_job_type_durations_tenant on job_type_durations(tenant_id);
create trigger job_type_durations_set_updated_at
  before update on job_type_durations
  for each row execute function set_updated_at();

-- The schedule itself. Times are IMMUTABLE per row (reschedule = cancel + insert);
-- status is the only mutable business field. History = the accumulated rows.
create type assignment_status as enum ('proposed', 'confirmed', 'cancelled', 'completed');
create extension if not exists btree_gist with schema extensions;
create table assignments (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  job_id            uuid not null references jobs(id) on delete cascade,
  technician_id     uuid not null references technicians(id),
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  status            assignment_status not null default 'proposed',
  reason            text,             -- stamped on cancel (why it was undone)
  source_capture_id uuid references raw_captures(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (ends_at > starts_at),
  -- Structural double-booking guard: no two CONFIRMED assignments may overlap
  -- for one technician. proposed rows may overlap (alternative proposals).
  constraint no_confirmed_overlap exclude using gist
    (technician_id with =, tstzrange(starts_at, ends_at) with &&)
    where (status = 'confirmed')
);
create index idx_assignments_tenant     on assignments(tenant_id);
create index idx_assignments_job        on assignments(job_id);
create index idx_assignments_technician on assignments(technician_id, starts_at);
create trigger assignments_set_updated_at
  before update on assignments
  for each row execute function set_updated_at();
```

**`src/db/database.types.ts`** — regenerate via
`mcp__supabase-test__generate_typescript_types` after applying (NOT `npm run gen:types` —
its `mkdir -p` is Unix-shaped and `--linked` state is unverified on this machine; the MCP
path is deterministic and test-project-pinned).

**`src/inbound/webhook.test.ts`** — `techRow()` (`:82-98`) builds a complete `Technician`
Row literal; the regenerated Row type adds two required properties. Add
`availability: null, service_cities: [],` to the literal or `tsc --noEmit` fails (same
fixture-breakage class as the 2026-07-01 plan's `synthesis/fixtures.ts` note).

**`src/db/schema.test.ts`** — extend (pattern of existing cases): assert
`technician_time_off`, `job_type_durations`, `assignments` exist; the exclusion constraint
`no_confirmed_overlap` present (`pg_constraint`, `contype='x'`);
`tenants.timezone` and `technicians.availability` columns exist.

### Automated verification
- [x] Migration applies cleanly to the TEST project (`daqapdlkgxfrhquacprv`) — never prod
      (applied 2026-07-04, ledger version `20260704210155`)
- [x] Types regenerated via MCP; `npm run typecheck` passes (incl. the `techRow()` fixture fix —
      6 new fields, not 2: an orphan `20260703010056_control_plane_lifecycle` migration from a
      prior session lives in the TEST DB with no repo artifacts; its columns ride along in the
      regenerated types)
- [x] `npm run lint` passes
- [x] `npm test`: 109/114 — extended `schema.test.ts` green (3 new tests), nothing regresses.
      The 5 failures are pre-existing and environmental: live Anthropic tests
      (classify/briefCustomer/answerQuestion) fail `401 invalid x-api-key` — the local
      `ANTHROPIC_API_KEY` is dead/rotated; untouched by this phase. Fix the key and re-run
      before commit.

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP.
- [x] `execute_sql` probe in a self-rolling-back DO block: insert two overlapping
      `confirmed` assignments for one technician → second raises exclusion violation
      (SQLSTATE 23P01); two overlapping `proposed` rows → both insert. Capture the raised
      error text as evidence; 0 probe rows left.
      **Evidence (2026-07-04):** `confirmed_overlap=[SQLSTATE=23P01 MSG=conflicting key value
      violates exclusion constraint "no_confirmed_overlap"] proposed_overlap_allowed=[yes
      (2 overlapping proposed rows inserted)]`; post-probe counts: assignments=0,
      probe_techs=0, probe_customers=0. Probe technician used `state='offboarding'` so the
      seat-cap trigger stayed out of the way (adversarial-review fix). Independent re-run by
      the review subagent reproduced the same result. **The probe's throwaway technician row
      must use `state = 'offboarding'`** — the seat-cap trigger's WHEN clause
      (`20260702194603_technicians_and_review_items.sql:49-51`) skips that state while the
      row stays FK-valid; an `invited`/`active` probe insert can spuriously raise
      `seat_cap_exceeded` (`technician_seats` defaults 0; mid-suite caps vary) before the
      exclusion constraint is ever exercised. (Adversarial-review finding.)

### Manual verification
- [ ] None.

---
*No manual items — implementer continues.*

## Phase 2: Typed layer — availability, time-off, durations + the pure day calculator

### What this phase does
Typed read/write functions for the Phase-1 shelves, JSONB pattern validation on write, and
the pure `isTechnicianAvailableOn` helper (pattern + time-off + tenant timezone → boolean).

### Changes required

**`src/db/technicians.ts`** (extend)
- `export type WeeklyPattern = { mon: [string,string][]; tue: ...; sun: [string,string][] }`
  (all 7 keys required; each window `["HH:MM","HH:MM"]`). Must be a **type alias, not an
  interface** — interfaces lack the implicit index signature the generated `Json` column
  type requires, so an interface fails `strict` typecheck at the `update({ availability })`
  write site.
- `setTechnicianAvailability(id, pattern: WeeklyPattern)` — validates keys, `HH:MM` shape,
  start < end per window (throw on invalid; never store junk); updates `availability`.
- `setTechnicianServiceCities(id, cities: string[])` — trims, drops empties, lowercases for
  storage (match is case-insensitive per research constraint 5).

**`src/db/timeOff.ts`** (new) + export from **`src/db/index.ts`**
- `addTimeOff({tenantId, technicianId, startsOn, endsOn, reason?})` → row.
- `deleteTimeOff(id, tenantId)` → boolean (tenant-guarded, mirrors `resolveReviewItem`).
- `listTimeOffForTechnician(technicianId, fromDate, toDate)` — ranges overlapping the window.

**`src/db/jobTypeDurations.ts`** (new) + export from index
- `upsertJobTypeDuration(tenantId, jobType, minutes)` — upsert on `(tenant_id, job_type)`
  (plain unique index → supabase-js `onConflict` works, unlike the partial-index cases).
- `getJobDurationMinutes(tenantId, jobType | null)` — specific row, else the tenant's
  `default_job_minutes` (one `tenants` read).

**`src/schedule/availability.ts`** (new, pure — no DB)
- `localDayOfWeek(isoTimestamp, timezone)` — via `Intl.DateTimeFormat(..., {timeZone, weekday})`.
- `isTechnicianAvailableOn(dateISO, pattern: WeeklyPattern | null, timeOff: {starts_on,ends_on}[], timezone)` —
  `null` pattern → false (fail closed); date inside any time-off range → false; else pattern
  day non-empty. (Window-level fit within a day is Plan 3; day-level is enough here.)

**`scripts/seed.mjs`** — `seedRoster()` returns only refs today (`:86`,
`roster.map((r) => r.ref)`) — change it to return the inserted rows (id keyed by ref);
the writes below and Phase 3's `createAssignment` need the technician **uuid**
(adversarial-review finding). Then after `seedRoster()`: set tech-jane availability
(Mon–Fri 08–17), `service_cities: ['fresno','clovis']`; one time-off range next week;
durations `hvac: 120`. (Seed stays deterministic; use fixed offsets from `TODAY`.)

**New test `src/db/scheduling.test.ts`** (integration, TEST project, self-cleaning — pattern
`technicians.test.ts`, incl. the roster truncate/seat-restore discipline): pattern validation
rejects bad shapes ("25:00", start≥end, missing day key); cities normalized; time-off
overlap query returns ranges straddling the window edges; duration falls back to tenant
default. **Truncate discipline (load-bearing): `beforeAll` AND `afterAll` truncate
`customers, jobs, technicians, technician_time_off, job_type_durations, review_items
cascade`** — Phase 3's `listUnassignedOpenJobs` is tenant-wide, so seeded open jobs
(`npm run seed` leaves two) would pollute its exactly-these assertions without the
`beforeAll` claim, and the customers/jobs this file creates for FK chains must self-clean
(`cascade` sweeps `assignments`). Restore seed seat capacity (2/5) in `afterAll` like
`technicians.test.ts:47`.

**New test `src/schedule/availability.test.ts`** (pure, no DB): timezone edge —
`2026-07-11T02:00:00Z` is Friday evening in `America/Los_Angeles` → counts as **fri**;
time-off day → false; null pattern → false; empty day array → false; one DST-transition
day (`America/Los_Angeles` spring-forward/fall-back date resolves to the correct local
weekday — locks the Intl-based day math; edge-register item, 2026-07-04).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` pass
- [x] `npm test`: 120/125 incl. both new files (11 new tests); the 5 failures are the same
      pre-existing dead-`ANTHROPIC_API_KEY` live-model tests noted in Phase 1 — untouched here
- [x] `npm run seed` completes; output shows `Scheduling seeded: tech-jane Mon–Fri 08–17;
      time off 2026-07-11..2026-07-13; hvac=120min`

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP.
- [x] After `npm run seed`: `execute_sql` reads back tech-jane's `availability` JSONB,
      `service_cities`, one `technician_time_off` row, and the `hvac` duration row —
      cross-channel evidence of the typed-layer writes.
      **Evidence (2026-07-04):** `availability={mon..fri:[["08:00","17:00"]],sat:[],sun:[]}`,
      `service_cities=["fresno","clovis"]` (lowercased by the write path),
      `time_off=[2026-07-11..2026-07-13 vacation]`, `durations=[hvac 120]`,
      `tenant_tz=America/Los_Angeles`. Adversarial review: 0 blocking / 1 minor
      (time-off overlap test only covered the leading edge — fixed: trailing-edge +
      entirely-before cases added, re-run green).

### Manual verification
- [ ] None.

---
*No manual items — implementer continues.*

## Phase 3: Typed layer — assignment operations + the unscheduled-jobs query

### What this phase does
CRUD + legal status transitions for assignments (jobs.ts's hardcoded-map pattern), the
cancel+create reschedule primitive, overlap-violation detection, and
`listUnassignedOpenJobs` — the scheduler's work queue.

### Changes required

**`src/db/assignments.ts`** (new) + export from **`src/db/index.ts`**
- `export const ASSIGNMENT_TRANSITIONS: Record<AssignmentStatus, AssignmentStatus[]> =
  { proposed: ['confirmed','cancelled'], confirmed: ['completed','cancelled'],
    cancelled: [], completed: [] }`.
- `createAssignment({tenantId, jobId, technicianId, startsAt, endsAt, status?, sourceCaptureId?})`
  — insert; preserve SQLSTATE on error (`Object.assign` idiom from `insertTechnician`).
- `updateAssignmentStatus(id, next, reason?)` — read → validate against the map → guarded
  update (`.eq('status', current.status)`, the jobs.ts concurrency idiom); `reason` stored
  on cancel. Confirming may raise the exclusion constraint → preserve code.
- `isOverlapViolation(err)` — SQLSTATE `23P01`.
- `rescheduleAssignment(id, {startsAt, endsAt, technicianId?, reason})` — cancel the old row
  (via `updateAssignmentStatus`) then `createAssignment` copying job/tenant, new times/tech;
  returns `{cancelled, created}`. Not atomic across the two statements — acceptable: worst
  crash case is a cancelled booking with no successor, visible in Plan 4's proposal queue,
  never a double-booking (the DB guard holds regardless).
- `listAssignmentsForTechnician(technicianId, fromISO, toISO, statuses?)` — overlap the
  window, default statuses `['proposed','confirmed']`, ordered by `starts_at`.
- `listAssignmentsForJob(jobId)` — all rows, newest first (the booking's history).
- `listUnassignedOpenJobs(tenantId)` — jobs `status='open'` for the tenant with **no**
  assignment in `('proposed','confirmed')`: one `.select('*, assignments(id,status)')`
  embed, filter in JS (PostgREST anti-joins are awkward; tenant job counts are small —
  research constraint 9 notes no tenant-wide job read existed at all).

**`scripts/seed.mjs`** — assign tech-jane to Tom's furnace job (`confirmed`, tomorrow
09:00–11:00 local ≈ fixed UTC offset) so Acme's open job is the one unassigned job;
add `assignments, technician_time_off, job_type_durations` to the truncate list.

**Extend `src/db/scheduling.test.ts`**: legal transition walk proposed→confirmed→completed;
illegal (`completed→cancelled`) throws; concurrent-change guard surfaces (update after
out-of-band status flip); confirm-overlap → `isOverlapViolation(err)` true; reschedule
leaves old row `cancelled` with reason + new row `proposed`, `listAssignmentsForJob` shows
both; `listUnassignedOpenJobs` excludes jobs with proposed/confirmed rows but includes one
whose only assignment is `cancelled` (truncate discipline already set in Phase 2 covers
`assignments` via cascade).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` pass
- [x] `npm test`: 126/131 — scheduling suite 11/11 green (6 new assignment tests), no
      regressions; same 5 pre-existing dead-`ANTHROPIC_API_KEY` failures as Phases 1–2
- [x] `npm run build` passes (pre-PR gate)

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP.
- [x] After `npm run seed`: `execute_sql` shows exactly one `confirmed` assignment
      (tech-jane × Tom's job) and `listUnassignedOpenJobs`-equivalent SQL returns exactly
      Acme's job — cross-channel read-back of both sides of the work-queue definition.
      **Evidence (2026-07-04):** `all_assignments=[{status:confirmed, tech_ref:tech-jane,
      job_title:"Furnace inspection", 2026-07-05T16:00–18:00Z}]`,
      `unassigned_open_jobs=[{title:"Quarterly maintenance"}]` (Acme). Adversarial review:
      0 blocking / 3 minor — fixed: out-of-band-flip test regex un-masked + race-branch gap
      documented (parity with jobs.ts), walk/overlap same-day coupling commented, reschedule
      asserts exact requested times. Deferred to Plan 4: `sourceCaptureId` on
      `rescheduleAssignment` (evidence linkage for message-triggered reschedules).

### Manual verification
- [ ] None.

---
*No manual items — Plan 1 complete; Plan 2 (geocoding + grid drive-time cache) follows.*
