---
date: 2026-07-20
task: Plan 3a — schedule-input verbs (availability, time off, durations, skills, priority home) so the fit-check has data; Telegram-reachable, fail-closed, no defaults
research: thoughts/shared/research/2026-07-20-plan-3-auto-scheduler-surfaces.md + thoughts/shared/research/2026-07-20-flexible-scheduling-agent-toolset.md
status: draft
---

## Overview

The scheduler's decision inputs are empty shells: the pilot has zero working patterns, zero
per-job-type durations, zero time-off rows, and no chat command can set any of them
(read-back 2026-07-20). This plan ships the manager verbs that populate them, plus the two
data homes the toolset research flagged as cheap-now/painful-later: technician skills (the
assignment gate) and job priority (the triage tier). Plan 3b (`find_slots`) consumes all of
it and is stacked on this plan.

## Decisions

- **All three input verb groups ship** (user, 2026-07-20): working pattern, time off, per-job-
  type durations.
- **No duration default, ever** (user, 2026-07-20): "duration of a job has to be provided by
  the manager." `tenants.default_job_minutes` stays dead — nothing new reads it; Plan 3b's
  duration resolution is job-type table or explicit statement, else ask.
- **Skills home = `technicians.skills text[]`** mirroring `service_cities` (normalized
  lowercase, validated non-empty strings) — typed column over JSONB for the same reasons
  cities got one; free vocabulary (no enum). **Semantics: empty list = "unknown", NOT
  "unqualified"** (user decision 2026-07-20) — Plan 3b's matching may only exclude a person
  on a non-empty list that lacks the skill (an explicit manager statement); unconfigured
  people stay candidates with a confirm-first flag. Configuration is optional per tenant,
  never a prerequisite. Typo risk is mitigated by echoing skills in `list_team` so the
  agent reads before it filters.
- **Priority home = `jobs.priority` enum** (`emergency|urgent|routine|maintenance`, default
  `'routine'`) — house style (assignment_status precedent). Written at booking time via a new
  optional `priority` arg on `book_visit` (job-shell path); **priority alongside `jobId` is
  REJECTED at stage** ("priority applies when a new job is created") — silently ignoring it
  would let the agent report an urgency that was never stored (review finding #2c). Existing
  jobs keep `routine` until a later editor exists (recorded limitation).
- **Five separate one-shot tools, no staging**: `set_availability`, `add_time_off`,
  `remove_time_off`, `set_job_duration`, `set_technician_skills`. All reversible + internal →
  one-shot under the shipped confirmation doctrine (act, then say exactly what changed).
  Separate add/remove over an action flag: narrower typed inputs (research rule).
- **`remove_time_off` takes (ref, date), not an id** — deletes every range overlapping that
  date via existing `listTimeOffForTechnician` + `deleteTimeOff`; natural chat UX, no id
  bookkeeping for the agent, composes existing helpers (no new db code).
- **Seat-exempt rows are first-class here** — Hman must be pattern-settable to become
  schedulable. Tools refuse only inactive states (`isInactiveState`), never seat-exempt.
- **`set_availability` takes the raw WeeklyPattern JSON** ({mon:[["08:00","17:00"]],…}, all 7
  keys) — `assertValidPattern` already yields actionable per-field errors; the tool
  description carries a worked example. An all-empty pattern is valid ("never available").
- **Availability setup is a REQUIRED onboarding step, tracked by mechanism** (user decision,
  2026-07-20): confirming `add_technician_seat` (seat-exempt included — it's their only
  route into the scheduler) opens an `availability_setup` review item for the new ref
  (pairing_verification precedent), and the seat-add result carries the fused next step
  ("REQUIRED: set {name}'s working days now — or record that availability isn't known
  yet"). `set_availability` auto-resolves the open item; the manager saying "not known yet"
  dismisses it with that note (the explicit no-availability-yet state — acknowledged, not
  skipped). **Manual booking stays warn-only** (Plan-1 decision + chaos doctrine both
  reaffirmed; Hman's live warn-and-book behavior is a pinned regression case); the
  scheduler stays fail-closed (structural). Existing pattern-less roster rows get no
  retroactive items — find_slots' skippedNoPattern surfaces them naturally (recorded
  limitation).

## Plain-language walkthrough

**Phase 1 — new shelves.** Two columns: a skills list on each roster row ("what is this
person qualified for") and a priority tag on each job ("emergency / urgent / routine /
maintenance"). Plus the typed helpers to write them.

**Phase 2 — the five chat verbs.** The manager can now say "Jane works Mon–Fri 8 to 5",
"Bob's on vacation July 28–30", "installs take 8 hours", "Sam is licensed for boilers" — and
each becomes one tool call that writes the data and reports back what it stored. `list_team`
now shows each person's skills and whether their working pattern is set, so the agent (and
you) can see at a glance who the future scheduler can plan for.

```
 manager chat ──► agent ──► set_availability(jane, {mon:[["08:00","17:00"]],…})
                              │ validates hard, writes, one-shot
                              ▼
                  "Jane's working pattern is set: Mon–Fri 08:00–17:00.
                   She is now visible to the scheduler."
```

**Phase 3 — ship it.** Migration applied to the pilot (with your explicit go-ahead), Render
deploy, gateway restarts so the sandboxes see the new tools, and a live end-to-end check
with database read-backs as evidence.

## Secrets & env preflight

- **Phase 1:** local Supabase stack running (`.env.test`) — already required.
- **Phase 2:** none new.
- **Phase 3:** `mcp__supabase-test__apply_migration` (connected MCP) — **pilot migration
  requires the user's explicit authorization naming the change** (standing rule); Render
  deploy access ("Deploy latest commit", never "Redeploy"); box SSH for
  `bootstrap-box.sh wire` (run as ubuntu with `export PATH="$HOME/.local/bin:$PATH"`).

## Phase 1: Schema + typed layer

### What this phase does
Adds the two columns and their typed writers; regenerates DB types.

### Changes required

**`supabase/migrations/20260720120000_scheduling_inputs.sql`** (new)
```sql
alter table technicians add column skills text[] not null default '{}';
create type job_priority as enum ('emergency','urgent','routine','maintenance');
alter table jobs add column priority job_priority not null default 'routine';
```
Apply locally (`npx supabase migration up`), regen types with
`npx supabase gen types typescript --local` (NOT `npm run gen:types` — pilot lacks this
migration until Phase 3).

**`src/db/technicians.ts`**
- `setTechnicianSkills(id, skills: string[]): Promise<Technician>` — trim + lowercase +
  drop empties + dedupe, mirroring `setTechnicianServiceCities` (technicians.ts:402-417).

**`src/db/jobs.ts`**
- `CreateJobInput` += `priority?: JobPriority`; `createJob` writes it (default `'routine'`).
- Export `type JobPriority = Database['public']['Enums']['job_priority']`.

**`src/db/index.ts`** — no edit needed: `export *` re-exports flow automatically (review
finding #6).

**Row-factory sweep (review finding #3)** — regenerated types make `skills`/`priority`
required Row fields; every full-Row factory needs the new key (the seat_exempt ripple,
repeated): src/inbound/webhook.test.ts:82, src/composio/{relayHandler:27, outbound:9,
offboarding:16, pairing:18, logIngest:11, sessions:14}.test.ts, src/jobs/lifecycle.test.ts:27,
src/control/badgeFile.test.ts:11 (all `Partial<Technician> => Technician` — add
`skills: []`), and src/synthesis/fixtures.ts:25 (`Partial<Job> => Job` — add
`priority: 'routine'`).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (46 files, 529 passed / 1
      pre-existing skip; phase review: NO FINDINGS)
- [x] new tests in `src/db/technicians.test.ts`: skills round-trip normalized ("  Boilers " →
      "boilers"), dedupe, empty-string dropped, default [], full-replace; in
      `src/db/spine.test.ts` (jobs suite): createJob stores priority, omitted → 'routine'

### Live verification (agent-executable)
- Prerequisites: local stack only.

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 2: The five MCP tools + list_team surfacing

### What this phase does
Exposes the setters as manager-only one-shot tools; surfaces skills + pattern state in
`list_team`; threads `priority` through `book_visit`'s job-shell path.

### Changes required

**`src/mcp/server.ts`** — `ADMIN_TOOLS` (server.ts:461) += five entries, each description
stating the one-shot contract ("done immediately — tell the manager exactly what was
stored") and, for `set_availability`, a worked pattern example + the fail-closed consequence
("no pattern = the scheduler will not book this person"):
- `set_availability {ref, pattern}` — resolve via `getTechnician`, refuse
  `isInactiveState` (message: reactivate first), NO seat-exempt fence;
  `setTechnicianAvailability`; result echoes the stored pattern in words per day.
- `add_time_off {ref, startsOn, endsOn, reason?}` — validate YYYY-MM-DD + startsOn<=endsOn
  (the DB check backstops); result names the person, range, reason.
- `remove_time_off {ref, date}` — `listTimeOffForTechnician(id, date, date)` → each
  `deleteTimeOff(id, tenantId)`; result lists ONLY ranges actually deleted (`deleteTimeOff`
  returning false — concurrent removal — is tolerated, not reported as removed; review
  finding #8); zero matches → honest "no time off overlaps <date>" (not an error).
- `set_job_duration {jobType, minutes}` — positive-integer check AND non-empty trimmed
  jobType (empty string would mint an unmatchable `''` row — review finding #7);
  `upsertJobTypeDuration`; result echoes normalized type + minutes.
- `set_technician_skills {ref, skills}` — full-replace semantics (stated in description);
  `setTechnicianSkills`; result echoes the stored normalized list.

**`list_team` handler** — each row += `skills: t.skills`,
`availabilityConfigured: t.availability !== null`; description sentence added.

**`book_visit`** — optional `priority` arg (enum-validated; rejected alongside jobId, see
Decisions). `BookVisitInput` += `priority?`; `bookVisit`/`previewBookVisit` pass it to
`createJob` on the shell path; **`BookVisitPreview` += `priority`** so the staged preview
shows what commit writes (review finding #2b). Priority threads through **THREE server.ts
edit sites, not one** (review finding #1): the stage/one-shot `bookInput` literal
(~server.ts:2395-2406), the staged-detail literal (~:2444-2461), and the confirm-side typed
detail view + rebuild (~:2482-2492, :2520-2531). The confirm-side malformed guard
(~:2500-2507) must NOT require the `priority` key — a token staged pre-deploy and confirmed
post-deploy defaults to 'routine', never "malformed" (review finding #2a; 15-minute live
window at deploy). Preview==commit test covers a staged 'urgent' landing as 'urgent'.

**`src/db/reviewItems.ts`** — `ReviewKind` union += `'availability_setup'` (task-reminder
kind, resolvable via resolve_review like pairing_verification — NOT a staged token, so no
live-token refusal entry).

**Onboarding hook** — `add_technician_seat` confirm path: after the seat commits,
`upsertOpenReviewItem({kind: 'availability_setup', subjectRef: <new ref>, detail: {ref,
displayName}})` + the result gains the fused REQUIRED-next-step line (see Decisions).
`set_availability` handler: on success, `resolveOpenReviewItemFor(tenantId,
'availability_setup', <ref>, 'resolved', 'pattern configured')` — auto-resolve, tolerant of
no open item (rows predating this feature).

**Docs (review findings #4, #5)** — count strings AND enumerated tool-name lists:
`docs/nemoclaw-tech-agent.md` (count :97's "12 … tools" → 17; §4's enumerated manager-tool
names += the five), `docs/doorman-runbook.md` (:328-331 enumeration += five),
`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` (:24 "sees 25" → 30 + names),
`Box_Setup_Stuff/doorman-architecture-memory.md` (:259 "12 admin/scheduling tools" → 17).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (46 files, 535 passed / 1
      pre-existing skip; phase review: 1 gap + 1 nit, both fixed — list_team description
      gained the skills/availabilityConfigured sentence; seated-confirm onboarding variant
      pinned alongside the exempt one)
- [x] `src/mcp/server.test.ts`: BOTH count assertions 25 → 30 (server.test.ts:1575 AND
      :1978; "12 admin" comments at :1567, :1978 → 17 — review finding #4); technician-tier
      badge → error for each new tool; set_availability invalid pattern → actionable error,
      valid → stored (SQL read-back in test); add/remove time-off round-trip incl. zero-match
      remove; set_job_duration upsert twice → single row updated; skills echo in list_team;
      seat-exempt row accepts set_availability; deactivated row refused
- [ ] book_visit with priority: one-shot path job carries 'urgent'; staged path preview==commit
      carries it; invalid priority rejected at stage
- [ ] onboarding hook: seat confirm opens `availability_setup` (seat-exempt confirm too);
      set_availability auto-resolves it; resolve_review can dismiss it with a "no
      availability yet" note; set_availability with no open item succeeds quietly;
      pattern-less booking still one-shots with the warning (Hman regression pin)

### Live verification (agent-executable)
- Prerequisites: local stack only (deploy is Phase 3).

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 3: Pilot rollout

### What this phase does
Migration to the pilot, deploy, tool-cache refresh, live E2E with evidence.

### Changes required
- Pilot migration via `mcp__supabase-test__apply_migration` — **STOP and get the user's
  explicit authorization naming this migration first** (standing rule). Then
  `NOTIFY pgrst, 'reload schema'`.
- **Order is load-bearing (deploy-before-migration incident, PR #58):** migration FIRST,
  then Render web "Deploy latest commit".
- Box: `bootstrap-box.sh wire` per live sandbox (s2, s3, s5) as ubuntu with PATH export;
  `nemoclaw <s> gateway restart` each — new tools are invisible until the cached tools/list
  refreshes.

### Automated verification
- [ ] `npm run build` passes before deploy

### Live verification (agent-executable)
- Prerequisites: pilot MCP (`mcp__supabase-test__execute_sql`), a manager-bound sandbox.
- [ ] migration in pilot ledger; `technicians.skills` + `jobs.priority` columns present (SQL)
- [ ] E2E via manager chat: set a real technician's pattern + one job-type duration; evidence
      = SQL read-back of `availability` JSON and `job_type_durations` row
- [ ] `list_team` through chat shows skills + availabilityConfigured
- [ ] seat-exempt row (Hman): set_availability succeeds; SQL read-back

### Manual verification
- [ ] Manager-facing wording of the five tool results reads naturally (user judgment, one
      screenshot each is enough)

---
*Pause after Phase 3 for the manual check and the pilot migration authorization.*
