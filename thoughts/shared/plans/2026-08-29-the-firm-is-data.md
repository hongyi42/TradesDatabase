---
date: 2026-08-29
task: Build 2 — a per-firm settings table, the send window deleted, and planner cadence informed by the firm's approximate hours
research: thoughts/shared/research/2026-08-29-the-firm-is-data.md
status: draft
supersedes: nothing
---

Overturns no document, but it **retires a user decision**: the 7am-7pm ask window
(user, 2026-08-17) is deleted as a send gate by a later user ruling (2026-08-29). The window's
own rationale lives in `src/teamLead/compose.ts:24-31`; this plan removes it.

## Overview

Sixteen-odd numbers encode "how a trades firm works", globally, for every firm. This build creates
somewhere per-firm values can live, moves the cheap ones there, and **deletes the ask window
outright** — the planner decides when a message goes out, period.

The research changed the shape of this build twice, both times making it smaller. Read the
Decisions before the phases.

## Decisions

- **A separate `tenant_settings` table** (user, 2026-08-29), not an extension of `tenant_profiles`
  — that table is letterhead identity (address, license numbers, disclosure footer), read rarely
  and rendered into human copy. Settings are read by code on every tick.
- **Typed columns, not one JSONB blob** (mine). `tenantProfiles.ts` closes its column map with
  `satisfies Record<string, keyof TenantProfileUpdate>` so a typo'd column fails `tsc` instead of
  surfacing as a runtime PGRST204. A blob loses that. The usual argument for a blob — "a migration
  per field is friction" — does not bite yet, because nothing writes settings dynamically in this
  build.
- **THE SEND WINDOW IS DELETED, not made per-firm** (user, 2026-08-29): *"I think the planner
  should just be able to choose when a message is sent, period."* Verified consequence:
  `nudgeQueue.ts` has **no time gate of any kind**, so `insideAskWindow` is the only send-timing
  control in the system. Removing it makes the planner's `send` the send time, with nothing else to
  unpick.
- **Firm hours are APPROXIMATE and drive planner CADENCE ONLY** (user, 2026-08-29: *"who said a
  firm would have fixed working hours at all?"*). I had argued hours should be code-derived from
  the assignment histogram because they are a fact; the user pointed out a histogram is also an
  inference, just a more confident one. Withdrawn. Getting them wrong costs wasted ticks, not
  messages.
- **The working-hours METRIC keeps a fixed 7-19 convention and is NOT TOUCHED** (mine, and it is
  what makes this build small). `workingHoursBetween`, the SQL twin `working_hours_between` (which
  hardcodes `interval '7/19 hours'`), the pinned TS/SQL equality test, and the **stored**
  `gap_summaries.working_hours_open` column all stay exactly as they are. It is a yardstick — like
  "business days" — not a claim about any firm. This drops the Tier D migration AND the
  stored-column-changes-meaning hazard out of the build entirely.
- **TWO CONSTANTS ARE HELD BACK BECAUSE THEY ARE READ ON BOTH SIDES OF A MIRRORED RULE** (mine,
  caught while writing the summary). `NUDGE_ESCALATE_HOURS` (watchers ×3, planner ×2) and
  `NUDGE_DELIVERY_DEADLINE_HOURS` (watchers ×2, planner ×3) are read by the sweep — Tier A, which
  moves — AND by `currentDeadlineMs`/`holdCeilingMs`, which are Tier B and deferred. Moving only
  the sweep's side manufactures precisely the failure `planner.ts:762-766` warns about: *"If the
  two disagreed, `extend` could report success while the sweep escalated on a different clock."*
  So this build moves ONLY constants whose call-sites are entirely tenant-scoped —
  `OVERDUE_HOURS`, `LOOKBACK_HOURS`, `MAX_NEW_ITEMS_PER_TENANT_TICK`, `PLANNER_SILENCE_HOURS` —
  and the other two move in build 6 **together with their planner mirrors**, as one edit.
- **Only Tier A constants move** (mine, from the research's reachability tiers). Tier B (pure
  functions needing a threaded parameter) and Tier C (`PLANNER_SYSTEM`, a module-scope string built
  at import time, which would have to become a function of the firm) are **deferred to build 6**,
  which already rewrites `validateDecisions` and the doctrine.
- **The planner does not WRITE settings in this build.** It gets write ability in build 3 alongside
  its memory. Build 2 creates the place and the readers; population is manual until then. The
  dependency order already says 2 before 3 for exactly this reason.
- **Deferred, recorded so it does not drift:** the planner asking a manager about a firm setting
  (user, 2026-08-29: *"fold that into something we can add in the future"*).
- **THE WINDOW DELETION AND THE CADENCE LAND IN ONE PHASE** (review finding 9). The window is
  called *"the single largest lever on what the planner costs"* (`planner.ts:1628`) — it skips the
  model call ~12h/day per firm. Deleting it in one phase and mitigating in the next would leave
  every firm on half-hourly model calls 24h/day across a stop-and-ask gate. They are one unit.
- **Cadence arithmetic is minutes-since-midnight, NOT `getUTCMinutes() % N`** (review finding 5).
  `getUTCMinutes()` returns 0-59, so `% 120` fires on exactly the minutes `% 60` does — verified.
  Any off-hours rate at or above 60 minutes is silently identical to 60. The existing gate
  (`lifecycle.ts:461`) is correct only because 30 < 60.
- **`NUDGE_DELIVERY_DEADLINE_HOURS` keeps its value but LOSES its derivation.** Its 18h was computed
  from the window (12h overnight hold + 5h margin + a DST hour). With no window nothing holds a gap
  overnight. The number stays put in this build and its comment is corrected to say it is now a
  plain broken-pipe timeout; re-tuning it is a separate decision.

## Plain-language walkthrough

Today every firm is treated identically, and one of those shared assumptions is that nobody works
outside 7am–7pm. That assumption does not just delay messages — it stops the planner **thinking**
at all, which is why we could not test it last night.

```
BEFORE                                      AFTER
──────                                      ─────
        ┌── planner THINKS ──┐                      planner thinks on a cadence
7-19 ───┤                    │  one gate            informed by the firm's own
        └── message GOES OUT ┘                      approximate hours
                                            message goes out WHEN THE PLANNER SAYS
```

**Phase 1** creates a `tenant_settings` table — one row per firm, every column nullable. Nothing
reads it yet, so nothing changes. You would notice it working only by it existing.

**Phase 2** points the cheap constants at it, each falling back to today's value when unset. With
an empty table the system behaves **byte for byte as it does now** — that is the test.

**Phase 3** deletes the ask window and the pre-ask carve-out, and replaces the global
half-hour cadence with a per-firm one. The planner starts thinking on every
tick, and it decides when messages go out. The carve-out goes with it because its only stated
justification was the window: *"its ask window holds an evening gap till 7am, so removing it means
asking a technician at 7am about a job they reported at 8pm."* With no window the planner sees the
note at 8:05pm and closes the gap itself.

**Phase 3** also gives the cadence a brain in the same breath — full-rate ticks inside the firm's
approximate hours, reduced outside — because deleting the window without that would put every firm
on half-hourly model calls around the clock. Wake-on-event stays ruled out; this is a timer.

## Secrets & env preflight

- **Phases 1-3:** none. No new secret, no new env var. `INFERENCE_*` are already set from build 1.

---

## Phase 1: Somewhere for a firm's own numbers to live

### What this phase does
Adds `tenant_settings` and its typed layer. Nothing reads it — the build stays inert.

### Changes required

**New migration `supabase/migrations/<ts>_tenant_settings.sql`**
```sql
create table tenant_settings (
  tenant_id            uuid primary key references tenants(id) on delete cascade,
  -- APPROXIMATE, and named so nobody mistakes it for a guarantee. Drives planner
  -- CADENCE ONLY (user ruling 2026-08-29). It is NOT a send gate — there is none —
  -- and NOT the working-hours METRIC, which keeps its own fixed 7-19 convention.
  approx_work_start_hour  int check (approx_work_start_hour between 0 and 23),
  approx_work_end_hour    int check (approx_work_end_hour   between 1 and 24),
  -- ONLY constants whose call-sites are ALL tenant-scoped. See the Decisions:
  -- escalate_hours and delivery_deadline_hours are deliberately ABSENT.
  overdue_hours           int check (overdue_hours          > 0),
  lookback_hours          int check (lookback_hours          > 0),
  max_new_per_tick        int check (max_new_per_tick        > 0),
  planner_silence_hours   int check (planner_silence_hours   > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger tenant_settings_set_updated_at
  before update on tenant_settings for each row execute function set_updated_at();
alter table tenant_settings enable row level security;
revoke all on tenant_settings from anon, authenticated;
```
Every column nullable: absent means "use the code default", which is what keeps Phase 2 a no-op.

**New `src/db/tenantSettings.ts`** — follows `tenantProfiles.ts` exactly:
- `export type TenantSettings = Database['public']['Tables']['tenant_settings']['Row']`
- `NUMBER_COLUMNS` (camelCase → snake_case) closed with
  `satisfies Record<string, keyof TenantSettingsUpdate>` — the typo-becomes-a-tsc-error pin.
- `SETTINGS_NUMBER_FIELDS = Object.keys(NUMBER_COLUMNS)` — the single roster, per that file's own
  "THE ROSTER" comment.
- `getTenantSettings(tenantId): Promise<TenantSettings | null>`
- `patchTenantSettings(tenantId, patch)` — supplied fields only; explicit `null` clears.
- **`resolveSettings(row | null)`** returning every value with its constant fallback applied. ONE
  place the defaults live, so Phase 2 has nothing to duplicate.

**`npm run gen:types:local`** to regenerate `database.types.ts` (NOT `gen:types`, which is
`--linked` and points at the pilot).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] New test: `patchTenantSettings` writes only supplied fields; explicit `null` clears one
      without touching its neighbours.
- [ ] New test: `resolveSettings(null)` returns exactly today's constants — asserted against the
      imported constants themselves, not copied literals, so a constant change cannot drift.
- [ ] New test: a CHECK constraint rejects `approx_work_end_hour = 0` and a negative `overdue_hours`.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [ ] Apply the migration locally, insert a partial row, read it back — evidence is the row.

### Manual verification
- [ ] None.

---
*No manual items — continue.*

## Phase 2: The cheap constants read from the firm

### What this phase does
Points every Tier A call-site at `resolveSettings`. **Behaviour is unchanged with an empty table** —
that is the whole test.

### Changes required

**`src/jobs/watchers.ts`** — one `getTenantSettings` per tenant per tick, beside the existing
`getTenant` call, then:
- `:378-379` `LOOKBACK_HOURS` / `OVERDUE_HOURS` → `s.lookbackHours` / `s.overdueHours`
- `:1106`, `:1206` → `s.maxNewPerTick`
- `:680`, `:818` → `s.plannerSilenceHours`
- **NOT `:632` (`NUDGE_ESCALATE_HOURS`) and NOT `:841`
  (`NUDGE_DELIVERY_DEADLINE_HOURS`)** — see the Decisions. They stay global here.
- Add `getSettings` to `WatcherDeps` so tests inject it, matching every other collaborator there.

**`src/teamLead/reflector.ts`** — `MIN_SUMMARIES`, `MIN_NEW_SINCE_LAST_RUN`, `REFLECT_FROM_HOUR`
stay global in this build. They gate a shadow-mode distiller and are not firm behaviour in the
sense this build is about. Recorded here so the omission is deliberate, not forgotten.

**Constants stay exported and keep their comments** — they are the fallbacks, and the comments carry
the reasoning (the 48→24 retune, the 18h derivation). Deleting them would delete the record.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] **`watchers.test.ts:91` `baseDeps()` MUST gain a `getSettings` stub.** It stubs every
      collaborator and its fixture tenant id is the literal `'t1'` — a real uuid-keyed read throws
      `22P02`, the per-tenant catch swallows it, and every `expect(tenantErrors).toBe(0)` fails.
      **Measured by review: 76 of 92 watcher tests fail without the stub.** Adding it is the
      injection seam, NOT moved behaviour — do not read the edit as a regression. (A previous draft
      of this plan said "the suite passes UNCHANGED", which is unsatisfiable and would have trained
      the implementer to ignore the check.)
- [ ] The real no-op check, stated correctly: **with the stub returning `null`, every existing
      watcher assertion holds with its original expected values.** Only the deps literal changes.
- [ ] New test: a tenant with `overdue_hours = 1` detects a visit 1h past its end that a
      default-tenant run does not — same fixture, two tenants, different outcomes.
- [ ] New test: settings are read ONCE per tenant per tick, not per gap (spy on the injected dep).
- [ ] `src/eval/plannerSim.ts:431-442` also builds `WatcherDeps` inline, with REAL uuid tenants —
      confirm it needs no stub.

### Live verification (agent-executable)
- Prerequisites: local stack.
- [ ] Seed two tenants, one with settings, one without; run one sweep; confirm they diverge only
      where the settings differ. Evidence is both summaries.

### Manual verification
- [ ] None.

---
*No manual items — continue.*

## Phase 3: Delete the window and the carve-out, and give the cadence a brain

### What this phase does
Removes the send gate and the pre-ask carve-out, and replaces the global half-hour tick with a
per-firm cadence — **in one phase**, because the window is what currently stops the planner running
24h/day, and deleting it alone would roughly double planner cost across a stop-and-ask gate.

### Changes required

**`src/teamLead/compose.ts`** — delete `ASK_WINDOW_START_HOUR`, `ASK_WINDOW_END_HOUR`,
`insideAskWindow` (`:32-47`). Keep `handToManager`.

**`src/jobs/workingHours.ts:1,44`** — it is the ONLY external importer of those constants (verified).
Give it its own `METRIC_DAY_START = 7` / `METRIC_DAY_END = 19`, commented as a measurement
convention pinned to the SQL twin, deliberately NOT a firm setting, and noting that changing it
changes the meaning of every stored `gap_summaries.working_hours_open`.

**`src/teamLead/planner.ts`**
- Delete the `insideAskWindow` import (`:25`) and the gate (`:1631-1637`).
- Replace `skippedWindow` (`:205`, `:1578`, `:1632`) with `skippedCadence`; replace the
  `'out_of_window'` outcome (`:159`) with `'off_cadence'`.
- The per-firm gate, **minutes-since-midnight** so a rate ≥ 60 actually works:
  ```ts
  // Approximate hours, and the word is load-bearing: nobody can know a firm's hours
  // exactly, and the only thing riding on this is how often we THINK. Getting it
  // wrong costs ticks, not messages — send timing is the planner's.
  // NOT getUTCMinutes() % everyMin: that returns 0-59, so any rate >= 60 silently
  // behaves as 60. Minutes-since-midnight is the only form that scales.
  const now = new Date(nowIso);
  const minsOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const everyMin = withinApproxHours(nowIso, tz, s)
    ? PLANNER_TICK_MINUTES : PLANNER_TICK_MINUTES_OFF_HOURS;
  if (minsOfDay % everyMin >= 5) {
    summary.skippedCadence += 1;
    name(idlePlan(tenantId, 'off_cadence', open.length)); // NOT a bare `continue` — see below
    continue;
  }
  ```
- **The `name(...)` call is load-bearing.** `planner.ts:1610-1615` documents `plans.length ===
  tenants` as the invariant the tick record and its report lean on, and the `if (!named)` backstop
  at `:2033` is inside the **catch only** — a bare `continue` in the try body leaves no entry.
  `planner.test.ts:2950` asserts it.
- `PLANNER_TICK_MINUTES = 30`, `PLANNER_TICK_MINUTES_OFF_HOURS = 120`. **A tenant with no hours
  recorded gets the full rate always** — unset must never mean "think less".

**`src/jobs/lifecycle.ts:462`** — the gate is computed once per tick, outside the tenant loop, and
is UTC-based, so firm-local cadence cannot live there. Keep a coarse candidate check (`% 5`) so an
off-cadence tick still costs no reads, and move the real decision into `runPlanner`.

**`scripts/ticks/report.mjs:233,238,253`** (review finding 4 — **`.mjs`, so no gate catches this**).
The per-firm accumulator hardcodes `{planned, no_gaps, out_of_window, error}` and `:238` guards
`if (f[p.outcome] !== undefined)`, so a new `'off_cadence'` outcome is **dropped silently** while
`:253` prints `out of hours 0` forever. This is the repo's only planner monitoring surface
(`npm run ticks`). Rename the bucket and make the unknown-outcome branch LOUD instead of silent.

**`src/jobs/watchers.ts:727-735`** — delete the pre-ask carve-out. `closedThisTick` (**`:620`**, not
`:619`) stays: `moot` still populates it.

**`src/jobs/nudgeKinds.ts:150-175`** — the `filled` doc states the carve-out as the one place
`filled` still closes. Correct it.

**`src/teamLead/plannerPrompt.ts`** — *"only during the working day"* becomes false; state that send
timing is now the planner's.

### Every file that breaks — measured, not guessed

The reviewer applied these deletions to a scratch copy and compiled. **Six compile errors and three
runtime failures**, none of which the previous draft named:

| File:line | Breaks how |
|---|---|
| `src/teamLead/compose.test.ts:3, 11-26` | imports `insideAskWindow`; a whole `describe` block of 4 boundary assertions — **delete outright** |
| `src/eval/plannerSim.ts:51` | imports `insideAskWindow` (backs the `:392` guard) |
| `src/eval/plannerSim.test.ts:216` | reads `skippedWindow` |
| `src/teamLead/planner.test.ts:519, 532` | `describe('runPlanner — when it runs at all')` — subject ceases to exist |
| `src/teamLead/planner.test.ts:2902` | reads `skippedWindow` |
| `src/teamLead/planner.test.ts:2887, 2897, 2907` | **type-checks clean, fails at RUNTIME** — `toBe('out_of_window')` on a 3-tenant fixture whose `'asleep'` tenant (`Asia/Tokyo`, `:2880`) exists only to be out of window |
| `src/eval/plannerCorpus.test.ts:37-53` | asserts a **corpus-wide** invariant — every tick inside 7-19 unless it expects the skip — over `ALL_SCENARIOS`, not just `window-edges` |
| `src/jobs/lifecycle.test.ts:423, 854, 863, 881, 909` | a required `skippedCadence` on `PlannerSummary` breaks two hand-built literals (`:428`, `:835`) feeding five sites |

Asymmetry worth knowing: **removing** `skippedWindow` does *not* error at those literals (excess-property
checking does not fire through the async-arrow return position), so the dead `skippedWindow: 0` keys
sit there until the new field surfaces them.

**`expectWindowSkip`** (`plannerCorpus.ts:37, 904`; `plannerSim.ts:366, 667`;
`scripts/agentic-eval/run.mjs:97-99` uses it to compute billed tick counts). Dropping it from
`WD-02` makes its `+10h` tick hour 20 and `plannerCorpus.test.ts` fails; deleting the field from
`TimelineStep` breaks `plannerCorpus.test.ts:43,60` and `plannerSim.ts:667`. **Decide one and
follow it through all four.**

**Two named tests do NOT break** and the previous draft overstated both: `src/control/nudgeQueue.test.ts:500`
(note: `src/control/`, not `src/jobs/`) is a *comment*, not an assertion; `src/jobs/summarize.test.ts:82`
seeds the resolution string via `insertClosedNudge` and never runs the sweep.

**`src/teamLead/planner.test.ts:460`** — pins that an unasked gap is shown no evidence. That is
about the PROMPT, not the sweep. **Re-examine, do not reflexively delete.**

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] New test: a pending gap whose job gained a note is NOT closed by the sweep — it reaches the
      planner with the note visible. The carve-out's defect, locked shut.
- [ ] New test: the planner runs for a tenant at 03:00 firm-local and produces a plan.
- [ ] **Cadence test that would actually catch finding 5:** a tenant with hours 08-16 must fire at
      02:00 and 04:00 but NOT 03:00 under the 120-minute rate. A 60-minute rate fires at all three,
      so this distinguishes them — the previous draft's "skipped at 03:00, runs at 04:00" passes
      under both and is worthless.
- [ ] New test: `summary.plans.length === summary.tenants` with an off-cadence tenant present.
- [ ] `grep -rn "insideAskWindow\|ASK_WINDOW" src/` returns nothing outside `workingHours.ts`.
- [ ] `grep -rn "out_of_window\|skippedWindow" src/ scripts/` returns nothing.
- [ ] `FAMILY_COUNTS` matches the surviving scenario count.
- [ ] `node scripts/ticks/report.mjs` runs and shows an off-cadence firm — it is `.mjs`, so no
      other gate touches it.

### Live verification (agent-executable)
- Prerequisites: local stack.
- [ ] Drive sweep + planner ticks at simulated 02:00, 03:00 and 10:00 firm-local for two tenants
      (one with hours, one without); confirm the cadence pattern and that every firm gets exactly
      one plan entry per tick. Evidence is the tick records.

### Manual verification
- [ ] Read the amended doctrine paragraph. It now tells the planner it owns send timing — whether
      that reads as permission or as pressure to send at 3am is a judgment about tone, and tone is
      what evals do not catch.

---
*Manual item present — STOP and wait for the user.*

## Registration the repo's standing rules require

Not a phase — a checklist that must be satisfied before Phase 1 is called done (review finding 10):

- [ ] `tenant_settings` added **by name** to `scripts/spine-eval/world.mjs:113-133` `RESET_TABLES`,
      `scripts/agentic-eval/run.mjs:141-157` `RESET_TABLES`, and `scripts/seed.mjs:175-198`. Each
      carries a comment that new tables are registered by name; `world.mjs:126-128` names the
      `tenant_profiles` trap as why incidental cascade coverage is not enough. `on delete cascade`
      prevents a hard `23503`, so the failure here is silent: a stale settings row surviving a world
      rebuild would quietly change planner cadence in an eval run.
