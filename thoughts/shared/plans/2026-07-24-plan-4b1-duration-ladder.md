---
date: 2026-07-24
task: Plan 4b-1 — job-level duration from a fixed ladder, required at creation, never defaulted
research: thoughts/shared/research/2026-07-24-plan-4b-freeze-autonomy-time-tbd.md
status: draft
---

## Overview

The freeze (4b-3) places work by asking "how long does this take, and who is free?" — and the
pilot cannot answer the first half. Measured 2026-07-24: **18 open jobs, 0 with a known
duration**, because duration lives only in `job_type_durations` keyed by job type, 15 of the 18
jobs have no type at all, and the one stored duration (`drainage replacement`) matches nothing.
A freeze run today would correctly place zero jobs.

This plan moves duration onto the **job itself**, offered as a **ladder of common lengths** —
with free minutes available when reality demands it — rather than a job-type table the manager
must maintain. It is the first of four: **4b-1 duration (here) → 4b-2 unplaced visits →
4b-3 the freeze → 4b-4 autonomy toggle.**

## Decisions

- **A ladder of common lengths, with a free-minutes escape hatch** (user, 2026-07-24, revised
  after the off-ladder-booking question) — the usual answer is a pick from
  `15m · 30m · 45m · 1h · 1.5h · 2h · 3h · 4h · 6h · 8h`, denser at the short end where a fixed
  error costs proportionally more. The ladder is what makes the common case one tap in chat,
  which is what removes the coverage bottleneck; **any whole number of minutes is also
  accepted**, so a firm whose standard callout is 20 minutes is never forced to round. The
  ladder is a default path, not a vocabulary.
- **`DURATION_LADDER` is presentation, not validation** — `src/db/jobs.ts` exports it so every
  surface offers the SAME rungs (the `JOB_PRIORITIES` single-list idiom, :173), but the gate is
  `Number.isInteger(m) && m > 0 && m <= MAX_DURATION_MINUTES`. Changing a rung stays a one-line
  edit and never a migration, because the database only checks `> 0`.
- **Upper bound `MAX_DURATION_MINUTES = 1440` (24h)** — implementer's call, recorded here:
  with free text there is nothing to catch `6000` typed for `600`, and a job estimate longer
  than a day is multi-visit work, not a bigger number. Chosen over no bound so one slip cannot
  poison the freeze's capacity math.
- **Booked spans are recorded verbatim** — `bookVisit` writes `end − start` onto the job shell
  it mints, whatever the value; an 08:00–09:20 booking stores 80. This is what the free-minutes
  decision buys. The earlier "rungs only" rule would have discarded a measured fact, and the
  loss surfaced on cancellation: the job returns to the loose bucket
  (`listUnscheduledOpenJobsWithCustomer` counts it unscheduled once no proposed/confirmed
  assignment remains) and the freeze would have to re-ask a length the system already knew.
- **Column is NULLABLE** — "we have never been told" must stay representable and visible.
  `not null` is impossible anyway (18 existing rows, and `src/writePath/recordFieldNote.ts:203`
  mints jobs from inbound mail with nobody to ask). "Required at creation" is enforced at the
  **manager-facing** write paths; readers stay fail-closed on null exactly as today.
- **`job_type_durations` demoted, not deleted** (user) — a stored type duration becomes a
  *suggestion*; the job's own value is authoritative. Chosen over retiring the table to avoid
  ~150 lines of `find_slots` churn plus tests in a plan whose point is unblocking inputs.
- **Precedence in `find_slots`** — explicit `durationMinutes` arg → the subject visit's booked
  length → **the job's own duration** → the job type's stored duration → fail-closed error. The
  subject visit stays first because re-placing a visit is a question about the calendar, not
  about the job in the abstract.
- **The pilot migration lands in Phase 1, not at the end** (plan-review finding) — Phase 2's
  live check writes the column and Phase 3 deploys code that selects it, so an additive,
  nullable migration must reach the pilot before either. Migration-first, then deploy.
- **Pilot jobs get generated durations** (user: "the pilot is just seed data") — no backfill
  ritual. Phase 4 is a plain data write, shown before it runs.
- **OPEN — deferred to 4b-2:** whether a job's duration should also become the default length of
  a visit booked against it. Unanswerable until unplaced visits exist.

## Plain-language walkthrough

**Today**, the only place the system knows how long work takes is a small table mapping a job
*type* ("install") to minutes. Nobody has filled it in, and most jobs have no type, so the
scheduler almost always has to stop and ask. That is correct — it must never invent a length —
but it means the automatic weekly placement we're building would have nothing to place.

```
  TODAY                                  AFTER THIS PLAN
  job ──has type?──▶ job_type_durations   job ──▶ duration_minutes  ◀── the answer
        │  (usually no)      │  (1 row)       (a rung 15m…8h, or any minutes)
        ▼                    ▼                          ▲
      "ask the manager"   "ask the manager"     job_type_durations
                                                (now just pre-selects a rung)
```

**Phase 1** adds the box to put the answer in: one new column on the job, plus a shared list of
allowed lengths every screen and tool checks against. Nothing changes for a user yet — you'd
notice it only in the tests. It ends by adding the column to the live pilot database, which
needs your go-ahead.

**Phase 2** teaches the chat assistant about it. `update_job` gains a duration you can set
("that one's a two-hour job"), and when the scheduler asks how long something takes it now
offers the ladder instead of talking about job types. You'd notice it by telling the assistant a
job's length and having it stick — the next slot request doesn't ask again.

**Phase 3** puts it on the board. The tray shows each unscheduled job's length, or **"length not
set"** in plain sight, and the job-edit sheet gains a length picker. You'd notice it as a third
field where there were two, and as the tray finally telling you which work is ready to place.

**Phase 4** fills in the pilot's 18 jobs so the freeze has something to chew on.

## Secrets & env preflight

- **Phase 1:** none. Needs the `supabase-test` MCP connected (hosted pilot) for the migration.
- **Phase 2:** none
- **Phase 3:** none
- **Phase 4:** none

`npx supabase start` must be running for every phase's tests (`.env.test`, per CLAUDE.md).

---

## Phase 1: The column, the ladder, the typed layer

### What this phase does

Adds `jobs.duration_minutes`, publishes the ladder as one exported constant, threads it through
the typed-layer writers, and lands the migration on the pilot. No behaviour changes at any
surface.

### Changes required

**`supabase/migrations/20260724120000_job_duration_ladder.sql`** (new)
```sql
-- Job-level duration (Plan 4b-1). Duration moves OFF the job_type lookup and
-- onto the job itself: the freeze places jobs that have no visit yet, so the
-- value must exist at the job level or the freeze's own inputs are empty.
-- NULLABLE on purpose: "never been told" must stay representable (inbound
-- capture mints jobs with nobody to ask). Readers stay fail-closed on null.
-- The LADDER is enforced in the typed layer (src/db/jobs.ts DURATION_LADDER),
-- not here, so changing a rung is an edit, not a pilot migration.
alter table jobs add column duration_minutes integer
  check (duration_minutes is null or duration_minutes > 0);
```

**`src/db/database.types.ts`**
- Regenerate **from the LOCAL stack**: `npx supabase gen types typescript --local >
  src/db/database.types.ts`. `npm run gen:types` uses `--linked` (the hosted pilot) and would
  emit types missing this column until the migration lands there.

**`src/db/jobs.ts`**
- Export the ladder beside `JOB_PRIORITIES` (:173):
  ```ts
  // The OFFERED job lengths (user decision 2026-07-24) — denser at the short
  // end: a 15-minute error on a 30-minute call matters, on a 6-hour install it
  // does not. Every surface offers THIS list (JOB_PRIORITIES precedent), but it
  // is presentation, not validation: free minutes are accepted so a firm whose
  // standard callout is 20 minutes is never forced to round.
  export const DURATION_LADDER = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480] as const;
  // The bound catches typos (6000 for 600). A job estimate longer than a day is
  // multi-visit work, not a bigger number.
  export const MAX_DURATION_MINUTES = 1440;
  export const isValidDuration = (m: unknown): m is number =>
    typeof m === 'number' && Number.isInteger(m) && m > 0 && m <= MAX_DURATION_MINUTES;
  // '1h 30m' — one label composer, so chat and board agree verbatim.
  export const formatDuration = (m: number): string =>
    m % 60 === 0 ? `${m / 60}h` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  ```
- `CreateJobInput` (:29) gains `durationMinutes?: number | null`; `createJob` (:43) writes
  `duration_minutes: input.durationMinutes ?? null`.
- `UpdateJobDetailsInput` (:175) gains `durationMinutes?: number | null` (null = clear back to
  unknown, mirroring `jobType`'s clear arm — a wrong length needs a real undo).
  `updateJobDetails` (:186) validates non-null values with `isValidDuration`; the error names
  the bound and offers the ladder as suggestions, never as the allowed set. **This type is what
  `updateJobIdentity` (`src/schedule/booking.ts:740`) already takes**, so no separate signature
  change there.

**`src/synthesis/fixtures.ts`** (plan-review finding — missed footprint)
- The `job()` fixture at :25 builds a complete `Job` Row literal; every generated column is
  required, so add `duration_minutes: null`. Without this, Phase 1's own `typecheck` gate fails.

### Automated verification
- [x] `npx supabase db reset` applies the migration locally without error
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass — **49 files / 627 tests**
- [x] new tests in `src/db/scheduling.test.ts`: `createJob` persists a duration and defaults to
      null; `updateJobDetails` accepts every rung, **accepts an off-ladder `20` and `80`**,
      rejects `45.5` / `0` / `-30` / `6000`, and accepts `null` as a clear
- [x] new test in `src/db/schema.test.ts` asserting `jobs.duration_minutes` exists and is
      nullable (the column-presence idiom at :100-110, not the table check at :90)
- [x] *(added)* `formatDuration` labels every rung + boundaries — it is the one composer chat
      and the board share, so drift would desynchronise copy silently

Phase-1 review (fresh context) found **no correctness defects**. It independently regenerated
`database.types.ts` from `--local` and confirmed the committed file is byte-identical (proving
it did not come from `--linked`), and mutation-tested the new guards: removing them fails 2
tests, and removing *only* the `<= MAX_DURATION_MINUTES` clause still fails on 1441, so the
bound is independently pinned rather than riding on the integer/positive checks.

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP (hosted pilot project).
- [ ] Apply the migration to the pilot **before** any later phase deploys. It is additive and
      nullable, so no code reads it yet. **Evidence:** the pilot's migration registry plus an
      `information_schema.columns` read-back.
      *Note (review finding): the pilot registry stamps its OWN versions, not repo filenames
      (repo `20260723090000_promise_time_only_value` ↔ pilot `20260723103350`). Match on the
      migration NAME, not the `20260724120000` version.*

### Manual verification
- [ ] User go-ahead before the pilot migration runs (pilot writes require authorization).

---
*Pause for the migration authorization, then continue.*

## Phase 2: The chat surface

### What this phase does

Makes duration settable and readable from chat: `update_job` gains it, `find_slots` prefers it
over the type lookup and names the ladder when it is missing, and `set_job_duration` is
re-described as a per-type suggestion rather than the source of truth.

### Changes required

**`src/mcp/server.ts`**
- `update_job` tool schema (:886-904): add
  ```ts
  durationMinutes: {
    type: ['integer', 'null'],
    // NO enum — free minutes are allowed. The rungs are OFFERED in the text so
    // the agent proposes them as choices; a manager who says "20 minutes" gets
    // 20, not a rounded lie.
    minimum: 1,
    maximum: 1440,
    description:
      'How long this job takes, in whole minutes. Offer these first: 15, 30, 45, 60, 90, 120, ' +
      '180, 240, 360, 480. Any other whole number is fine if the manager states one. ASK the ' +
      'manager; NEVER pick a length yourself. Pass null to clear it back to unknown.',
  }
  ```
  and extend the tool description: setting it is what makes the job placeable.
- `update_job` handler (:4011): reject non-integers, `<= 0`, and `> 1440` via `isValidDuration`
  (copy the `JOB_PRIORITIES` guard shape at :4026 — the message states the bound and lists the
  rungs as suggestions), pass through to `updateJobIdentity`, echo in `changes` old → new.
- `find_slots` duration resolution (:4243-4274): insert the job-level branch between the
  subject-visit branch and the type lookup —
  ```ts
  } else if (job?.duration_minutes) {
    durationMin = job.duration_minutes;
    durationAssumption = `using this job's recorded length (${formatDuration(durationMin)})`;
  } else {
  ```
- `vocabularyGuidance` (:4215): **add** the duration remedy as the primary one — "ask the
  manager how long it takes and set it on the job with `update_job`; offer 15/30/45/60/90/120/
  180/240/360/480 as choices, but take whatever whole number they state". Existing assertions
  are pinned and must survive verbatim:
  `src/mcp/server.test.ts:4217-4219` requires the untyped arm to still contain
  `'no recorded type'`, the configured-type list (`'drainage (300m)'`) **and** `'assumedType'`;
  `:4838-4840` requires the typed arm to contain `'update_job'` and **not** contain
  `'assumedType'` (the recorded two-error-loop finding). Extend, never substitute.
- `typeWarning` (:4045): extend to say the job's own `durationMinutes` is the direct fix.
- `set_job_duration` description (:818): re-word to "a DEFAULT length for new jobs of this type
  — a suggestion; each job's own duration wins."
- Replace the local `fmtMin` (:4205) with the imported `formatDuration`.

**`src/schedule/booking.ts`**
- `bookVisit`'s job-shell mint (:318-326): record the booked span **verbatim** —
  ```ts
  // A MEASURED value, not an invented one, so the never-guess rule holds. Kept
  // even when off-ladder (08:00-09:20 → 80): free minutes are allowed, and
  // discarding it would leave the job duration-less if the visit is later
  // cancelled — the freeze would re-ask a length we already knew.
  durationMinutes: Math.round((Date.parse(r.endISO) - Date.parse(r.startISO)) / 60_000),
  ```
  Spans over `MAX_DURATION_MINUTES` (a genuine multi-day booking) store `null` rather than
  breaching the bound — a booking that long is not a per-job estimate.
- `BookVisitPreview` (:264-302) states it carries "EXACTLY what commit will write". Add the
  derived `jobDurationMinutes: number | null` to the preview on the `customerId` (shell-minting)
  path so that invariant still holds (plan-review finding).
- `updateJobIdentity` (:737): include `durationMinutes` in the `job_updated` ledger event detail
  (:753-762) alongside title/type/priority. Its input type needs no change (see Phase 1).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass
- [ ] new tests in `src/mcp/server.test.ts`: `update_job` sets a rung and echoes old → new;
      **accepts an off-ladder `20`**; rejects `45.5` / `0` / `6000` naming the bound; accepts
      `null` to clear
- [ ] new test: `find_slots` on a job with `duration_minutes` set and **no** `job_type` returns
      candidates (today this throws "no recorded type"); `durationAssumption` names the job's
      recorded length
- [ ] new test: `find_slots` on a job with neither duration nor type still throws, and the
      message contains the ladder values — with `src/mcp/server.test.ts:4217-4219` and
      `:4838-4840` still passing unmodified
- [ ] new tests in `src/schedule/booking.test.ts`: booking 09:00–11:00 on the `customerId` path
      mints a job with `duration_minutes = 120`; booking **08:00–09:20 stores 80** (pins that
      an off-ladder measurement is kept, the whole point of the free-minutes decision)

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP; a sandbox with a working spine MCP (s2 = manager-sam)
  reachable via `nemoclaw <sandbox> agent`; Phase 1's pilot migration applied.
- [ ] Restart the gateway across the live fleet first — `docs/engineering-memory.md` records
      that the gateway caches `tools/list`, so the new `update_job` schema is invisible to live
      chat until it does.
- [ ] Ask the agent in chat to set a pilot job's length, then read `duration_minutes` back for
      that `job_id` over `supabase-test`. **Evidence:** the chat reply and the SQL row. Restore
      the prior value (null) afterwards.
- [ ] Ask for slots on that job (which has no `job_type`) and confirm candidates come back
      instead of the no-type error. **Evidence:** the returned candidates.

### Manual verification
None.

---
*No Manual items — continue straight to Phase 3.*

## Phase 3: The board surface

### What this phase does

Surfaces duration where the manager already edits jobs: the tray shows each unscheduled job's
length or says it is unset, and the job-edit sheet gains a length picker.

### Changes required

**`src/db/assignments.ts`** (plan-review finding — missed footprint; without it Phase 3 does
not compile). Both select strings **must stay single string literals** — see the note at :293.
- `UNSCHEDULED_JOBS_SELECT` (:485): add `duration_minutes` to the named column list.
- `UnscheduledJobRow` (:488): add `'duration_minutes'` to the `Pick`.
- `DETAIL_SELECT` (:297): add `duration_minutes` inside `jobs(...)`.
- `AssignmentDetailRow.jobs` (:271): add `'duration_minutes'` to the `Pick`.

**`src/schedule/boardRead.ts`**
- `UnscheduledJob` (via `readUnscheduledJobs` :242) gains `durationMinutes: number | null` from
  `job.duration_minutes`. This projection is shared with `get_team_schedule`'s recall view
  (`src/mcp/server.ts:2612`) by design, so both surfaces gain it together.
- `VisitDetail` (:312) gains `jobDurationMinutes: number | null`, read in `readVisitDetail`
  (:406-408).

**`src/telegram/boardApi.ts`**
- `/board/api/job` (:404-458): accept `durationMinutes` — `null` clears, a number must pass
  `isValidDuration` else `400` stating the bound. The "nothing to update" guard (:434) must
  test **`'durationMinutes' in body`**, not truthiness, or a clear-to-null reads as absent. Add
  it to the `changes` echo (:449).

**`web/board/board.js`**
- `bucketJobRow` (:522-523): add `data-duration` alongside `data-title`/`data-priority`, and
  append the length (or `length not set`) to the sub-line. Without the attribute the tray's Edit
  handler (:614-620) opens the picker showing "not set" and a title-only edit **wipes a real
  stored value**.
- `openJobForm`: add a `<select>` of the ladder (labels via a JS mirror of `formatDuration`)
  with a leading `— length not set —` option and a trailing `Custom…` option that reveals a
  `<input type="number" min="1" max="1440">`. **Off-ladder values are normal**, not an edge
  case: whenever the current value is not a rung (an 80-minute booking, a manager's typed 20),
  render it as its own selected option so it is displayed correctly and never silently lost.
- `openJobForm` submit (:1241-1249): the guard `if (!body.title && !body.priority)` must become
  a presence test that includes duration — a duration-only edit currently sends nothing, and
  `null` is falsy so a clear would no-op too.
- Visit sheet: show the job's length beside Purpose, editable through the same form.

**`web/board/board.css`**
- Style the select to match the existing priority control; no new colour tokens.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass
- [ ] new tests in `src/telegram/boardApi.test.ts`: POST `/board/api/job` with a rung updates
      `duration_minutes` and echoes the change; **an off-ladder `20` is accepted**; `0` and
      `6000` return 400 stating the bound; `durationMinutes: null` **clears** it (pins the
      `in`-guard, not truthiness); a duration-only POST is accepted
- [ ] new test: `/board/api/bucket` returns `durationMinutes` on unscheduled jobs (null when
      unset); `/board/api/visit` returns `jobDurationMinutes`

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP; the deployed board reachable over HTTPS.
- [ ] After deploy, byte-compare the served `/board/static/board.js` against `main` to prove the
      deploy is fresh (Render "Redeploy" reuses the OLD commit — recorded trap). **Evidence:**
      the hash comparison.

### Manual verification
There is no automated coverage of `board.js` (`src/telegram/boardApi.test.ts:207-223` only
asserts the file is served), so these are the only checks on it:
- [ ] The tray shows "length not set" on the pilot's unscheduled jobs
- [ ] Setting a length from the tray Edit button survives a board reload
- [ ] **Editing only the title on a job that already has a length leaves the length intact**
- [ ] Editing only the length (no title/priority change) actually saves
- [ ] `Custom…` accepts a typed 20 minutes, and re-opening the sheet shows **20**, not the
      nearest rung and not "not set"
- [ ] The control is reachable and legible at phone width, and the number keypad appears for
      the custom input

---
*Manual items present — pause for the user's device pass before Phase 4.*

## Phase 4: Give the pilot's jobs durations

### What this phase does

Fills in `duration_minutes` for the pilot's 18 open jobs so 4b-3 has real inputs. The user has
recorded that this is seed data, so a plausible generated value is acceptable — this is not a
backfill ritual and no manager is asked.

### Changes required

**Pilot database (hosted "test" project) — no source files.**
- Read the 18 open jobs' titles, then assign each a rung **deterministically from its title** via
  an explicit `values (job_id, minutes)` list, so the result is reviewable rather than random.
- **Show the user the exact statement and the 18 title→minutes pairs, and run only on an
  explicit go-ahead** (pilot writes require authorization).

### Automated verification
Queries are scoped to the pilot tenant **and to the specific job ids written** — the pilot DB is
multi-tenant, and `src/writePath/recordFieldNote.ts:203` mints duration-less open jobs on the
live ingest path, so an unscoped "all open jobs" count is never stably zero (plan-review
finding):
- [ ] `select count(*) from jobs where id in (<the 18 ids>) and duration_minutes is null`
      returns 0
- [ ] `select count(*) from jobs where id in (<the 18 ids>) and (duration_minutes <= 0 or
      duration_minutes > 1440)` returns 0. **Not** an `in (<ladder>)` check — free minutes are
      valid, so a rung-membership gate would fail on correct data.

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP.
- [ ] `find_slots` from live chat on a previously untyped pilot job now returns candidates.
      **Evidence:** the chat reply plus the job's `duration_minutes` read back over SQL.

### Manual verification
- [ ] User go-ahead on the 18 title→minutes pairs before the write runs.
