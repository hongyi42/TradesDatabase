---
date: 2026-08-26
task: Give every lifecycle tick a durable record, name every firm it considered, and label which lane spent the money
research: thoughts/shared/research/2026-08-25-planner-tick-observability.md
status: complete
supersedes: nothing
---

## Overview

The lifecycle cron produces one line of JSON on stdout and throws it away. A tick with nothing to
do writes nothing anywhere, so "quiet" and "dead" are indistinguishable in SQL — the shape that hid
the dead manager-push for 30 days. This plan gives each tick a durable row, makes every firm the
planner considered nameable (not just countable), and tags model spend with the lane that caused it.

**Split from this plan:** checking our derived spend against Anthropic's actual bill is
`thoughts/shared/plans/2026-08-26-check-the-bill.md`. It depends on Phase 3's `lane` label and daily
view, and it is blocked on credentials this plan does not need — so it ships separately.

## Decisions

- **Where the run record lives** — options were `ops_events` (ruled out by the `reflector_runs`
  migration header: `host_id` FK + one-open-per-(host,service) partial index), a tenant-scoped
  table, or a new tenant-agnostic table. **Chosen: a new tenant-agnostic `lifecycle_runs`**, because
  one tick spans every tenant; there is no single firm it belongs to.
- **How much of the summary is stored** (user choice, "A+") — counts only, **plus one named entry
  per firm considered**. Per-decision free text (`reason`, `citation`, `questionDraft`,
  `handoffNote`, `agentContext` — `planner.ts:91`–`:121`) is **stripped**: one tick's row has no
  `tenant_id`, so customer-derived text in it would sit outside the isolation boundary and survive a
  tenant delete. That text is already stored correctly in `nudge_decisions`, keyed to its firm.
- **Retention** (user choice) — prune `lifecycle_runs` older than 90 days on the quarter-hour tick.
  Outlives Render's ~30-day log horizon; bounds the table at ~25k rows. Env-overridable.
- **Cost attribution** (user choice, "C1") — add an optional `lane` to `CostContext`, written into
  the **existing, unused** `cost_events.metadata` JSONB. **No migration needed.** Rejected: new
  `technicianRef` sentinels (rewrites an existing column's meaning going forward) and a new column
  (leaves all history un-tagged for no gain over metadata).
- **Per-tick cost is joined by interval, not by a threaded run id** — Render guarantees at most one
  concurrent lifecycle run (`lifecycle.ts:21`), so `[started_at, finished_at]` windows are disjoint
  and every model call falls strictly inside its own tick. Threading a run id through
  `runLifecycle` → `runPlanner` → `CostContext` would change signatures and every test that calls
  them, to buy precision the timestamps already give.
- **Daily pricing gets a view, not a hand-written join** — the research's trap 6 is that the rate
  join silently drops unpriced events. One view, two readers (`npm run ticks` here, `costs:reconcile`
  in the sibling plan), so the two can never disagree. `cost_rollup_monthly` is unchanged.
- **Per-firm API keys were considered and rejected** — Anthropic cannot create keys programmatically
  ("No. You create API keys in the Claude Console"), and prompt caches are isolated per workspace
  while our cached prefix (`toolLoop.ts:226`–`:241`, the tenant-invariant system block) is shared
  across firms today. Splitting would multiply 2x cache writes by the number of customers.
  Recorded here so it is not re-proposed. Splitting by **lane** into ~3 workspaces stays a
  follow-up, not a dependency.
- **`isMissingCostLedger` is reused for the new table** — it matches PostgREST/Postgres
  missing-table codes generically (`costs.ts:521`), not anything ledger-specific. Name is now
  broader than its module; renaming is out of scope here.

## Plain-language walkthrough

**Phase 1 — every round leaves a mark.** A new table gets one row each time the five-minute program
runs: when it started, when it finished, whether it succeeded, and a stripped-down copy of what it
reported. Rows older than 90 days are deleted automatically. You'd notice it working by counting
rows: 288 a day, every day. A gap in that count is a gap in the program's life.

```
   round ──▶ one line of JSON ──▶ server log  (rotates, ~30 days)
         └─▶ one ROW  ──────────▶ database    (queryable, 90 days)   ← new
```

**Phase 2 — name every firm, not just count them.** Today the report says "2 firms skipped" without
saying which. Each firm gets its own entry every round, stamped with what happened to it: planned,
no work to do, outside its asking hours, or errored. You'd notice it working when the number of
entries equals the number of firms, always.

**Phase 3 — say who spent the money.** Two parts of the system record their AI spending under the
same name, so the total can't be split. Each spending record gains a label naming the lane. A
companion view turns token counts into dollars **per day** and carries the count of anything it
couldn't price, so a dollar figure never quietly leaves things out.

```
lifecycle_runs   │◀── started_at ─────────────── finished_at ──▶│
cost_events      │   ●        ●   ●             ●               │
                 │  lane='planner' …            lane='reflector'│
```

**Phase 4 — read it back.** `npm run ticks` prints the last day of rounds: how many ran, where the
gaps are, what each step skipped and why, which firms went untouched, and what it cost.

Checking those numbers against Anthropic's real bill is the sibling plan, and it starts where this
one ends.

## Secrets & env preflight

- **Phase 1:** none new. `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — *already required*.
  Optional `LIFECYCLE_RUN_RETENTION_DAYS` (default `90`).
- **Phase 2:** none. **Phase 3:** none.
- **Phase 4:** `DATABASE_URL` in `.env` — *already required* by `npm run metrics:planner`.

Nothing here is blocking. (The sibling bill-check plan needs credentials this one does not.)

---

## Phase 1: Every tick leaves a row

### What this phase does
Adds `lifecycle_runs`, a typed accessor, a redaction step that strips per-decision free text, a
write from `main()` that can never fail the cron, and a 90-day prune on the quarter-hour tick.

### Changes required

**`supabase/migrations/20260826120000_lifecycle_runs.sql`** (new)
- Header must state: tenant-agnostic **by design** (a tick spans every tenant), so it is deliberately
  absent from the tenant cleanup lists and survives a tenant delete — and it holds **no**
  customer-derived text, which is what makes that safe.
```sql
create table lifecycle_runs (
  id           uuid primary key default gen_random_uuid(),
  started_at   timestamptz not null,          -- the nowIso the cadence gates read
  finished_at  timestamptz not null default now(),
  ok           boolean not null,
  summary      jsonb not null,
  created_at   timestamptz not null default now(),
  check (finished_at >= started_at)
);
create index idx_lifecycle_runs_started on lifecycle_runs (started_at desc);
alter table lifecycle_runs enable row level security;
revoke all on lifecycle_runs from anon, authenticated;
```

**`src/db/lifecycleRuns.ts`** (new — CLAUDE.md: all DB access through the typed layer)
- `insertLifecycleRun({ startedAt, ok, summary }): Promise<void>` — `finished_at` left to the column
  default so the DB clock stamps it.
- `listLifecycleRuns(sinceIso, limit = 500): Promise<LifecycleRun[]>` — `started_at` ascending.
- `pruneLifecycleRuns(beforeIso): Promise<number>` — delete + count.
- `findTickGaps(rows, expectedMs = 5*60*1000, toleranceMs = 3*60*1000)` — **pure**, exported,
  returns `{ after, before, missedTicks }[]` for consecutive rows further apart than
  `expectedMs + toleranceMs`. Kept pure so Phase 4's report is a thin printer over a tested function.
  Safe for the script to import: `getClient()` is lazy (`client.ts:9` — it throws on call, not on
  import), so `scripts/ticks/report.mjs` can import this module without `SUPABASE_URL` set.

**`src/jobs/lifecycle.ts`**
- Export `redactForRecord(summary: LifecycleSummary): Json` — deep-copies, and where
  `teamLeadPlanner` has `plans`, replaces each entry's `decisions` / `dropped` arrays with their
  lengths. Everything else passes through. Cap any `stepError` string at 500 chars.
- Add the prune **inside the existing `if (heavyTick)` block** (steps 1–7), following that block's
  own idiom: declare `let lifecycleRuns: LifecycleSummary['lifecycleRuns'] = OFF_CADENCE` alongside
  the other six defaults at `:152`–`:158`, overwritten in the block. Do **not** renumber any step —
  `lifecycle.ts:38`–`:40` records that the JSON field names are the stable reference and renumbering
  invalidates every runbook citing a step number. Missing table → `skipped`, never `ok = false`
  (`isMissingCostLedger` idiom). Add `lifecycleRuns` to `LifecycleSummary`.
- `main()`: capture `const startedAt = new Date().toISOString()`, pass it to `runLifecycle`, write
  stdout **first**, then `await insertLifecycleRun(...)` inside a `try/catch` that logs to stderr and
  never changes the exit code. Order matters — the diagnostic line must survive a DB failure.

**`src/db/database.types.ts`** — regenerate (`npm run gen:types:local`) after the migration.

**`scripts/seed.mjs`, `scripts/agentic-eval/run.mjs`, `scripts/spine-eval/world.mjs`** — no deletes
added; one comment each naming `lifecycle_runs` as **deliberately excluded** (tenant-agnostic ops
log), so eng-memory §1 is satisfied by a decision, not an omission.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass
- [x] new test: `redactForRecord` strips `decisions`/`dropped` to counts and leaves `turns`,
      `toolCalls`, `ms`, `applied`, `recorded` intact — asserted on a fixture containing a
      `questionDraft` and a `citation`, proving neither survives
- [x] new test: insert → `listLifecycleRuns` round-trips against the local stack
- [x] new test: `pruneLifecycleRuns` deletes only rows before the cutoff
- [x] new test: `findTickGaps` finds a 20-minute hole and reports `missedTicks: 3`; returns `[]` for
      an evenly-spaced series
- [x] new test: `runLifecycle` reports `lifecycleRuns: {skipped}` — not `ok:false` — when the prune
      throws a missing-table code

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test` (the pilot DB, **read-back only**); the migration applied by
  hand first — deploys do not migrate (eng-memory)
- [x] Apply the migration to the pilot via `apply_migration`, then confirm with `execute_sql` against
      `information_schema.columns` — never `list_migrations` (the pilot ledger is drifted)
      — **DONE 2026-08-26**: all 6 columns present with the expected types/defaults; `relrowsecurity
      = true` and no grants to `anon`/`authenticated` (checked because this project still has
      `auto_expose_new_tables` on until its 2026-10-30 retirement).
- [ ] **DEFERRED — needs a deploy.** After the next deploy, `select count(*), min(started_at),
      max(started_at) from lifecycle_runs` ~30 min later: expect ~6 rows, evenly spaced.
- [ ] **DEFERRED — needs a deploy.** `select summary from lifecycle_runs order by started_at desc
      limit 1` and confirm **no** `questionDraft` / `citation` / `reason` key appears in it.
      (The redaction itself is locked in by a codified test above; this confirms it end to end.)

### Manual verification
- [ ] none

## Phase 2: Name every firm (A+)

### What this phase does
Makes `plans[]` cover every tenant considered, not only the ones the model ran for, so a skipped or
errored firm is identifiable rather than an anonymous counter.

### Changes required

**`src/teamLead/planner.ts`**
- `PlannerTenantPlan` (`:150`): add `outcome: 'planned' | 'no_gaps' | 'out_of_window' | 'error'`.
  **Every other field stays REQUIRED** — non-planned entries carry `decisions: []`, `dropped: []`,
  `turns: 0`, `toolCalls: 0`, `ms: 0`. Making them optional would break ~30 existing assertions that
  read `summary.plans[0].dropped[0].why` / `.decisions[0]` (`planner.test.ts:229`–`:791`) on
  `possibly undefined`, turning an additive change into mechanical churn across the suite.
- Push an entry at each early return: `:1572` (`no_gaps`, `gaps: 0`) and `:1580` (`out_of_window`,
  `gaps: open.length`), and in the `catch` (`error`, `gaps: views.size` — `views` is declared outside
  the try at `:1563` precisely so the failure path can see it). The existing push at `:1934` gains
  `outcome: 'planned'`.
- **Positional hazard:** `plans[0]` is no longer guaranteed to be a planned tenant. Verified safe in
  the current suite — the shared fixture is single-tenant (`listTenants: async () => ['t1']`,
  `:117`) and the one two-tenant test (`:560`) asserts only counters — but confirm this before
  editing, and index the NEW tests by `outcome`, never by position.
- The existing `skippedNoGaps` / `skippedWindow` / `tenantErrors` counters are **unchanged** —
  additive only, so no existing reader breaks. The research's decision point 4 (evaluating the two
  gates independently) is deliberately **not** taken here: it changes ladder control flow, and
  `plans[].outcome` makes the states distinguishable in the record without touching the hot path.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass
- [x] new test: three tenants — one with gaps in-window, one with none, one out-of-window — yield
      `plans.length === 3` with outcomes `planned` / `no_gaps` / `out_of_window`, and the counters
      keep their existing values
- [x] new test: a tenant whose loop throws yields `outcome: 'error'` **and** still increments
      `tenantErrors`
- [x] existing planner tests pass unchanged (proves the addition is additive) — 183 pass in
      `planner.test.ts`, of which 5 are new; no existing assertion was edited
- [x] added in review: `plans.length === tenants` asserted as an invariant, and a `named` guard so a
      throw AFTER the planned push cannot add a second entry for the same firm

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test`
- [ ] **DEFERRED — needs a deploy.** `select summary->'teamLeadPlanner' from lifecycle_runs` on a
      half-hour tick: `jsonb_array_length(plans)` equals `tenants`. (Locked in by the codified
      invariant test above; this confirms it against real firms.)

### Manual verification
- [ ] none

## Phase 3: Label the spend, and price it by day

### What this phase does
Tags each model-usage row with the lane that caused it, and adds the daily priced view both later
phases read.

### Changes required

**`src/db/costs.ts`**
- `CostContext` (`:85`): add `lane?: string | null`.
- `recordModelUsage` (`:182`): in `base`, add `metadata: ctx.lane ? { lane: ctx.lane } : null`.
  `appendCostEvents` (`:70`) already always emits the `metadata` key, so the mixed-batch NULL hazard
  documented at `:61`–`:68` does not apply.

**`src/teamLead/planner.ts:1720`** → `{ tenantId, technicianRef: TEAM_LEAD_REF, lane: 'planner' }`
**`src/teamLead/reflector.ts:214`** → `{ tenantId, technicianRef: TEAM_LEAD_REF, lane: 'reflector' }`
(These are the only two `CostContext` sites using `TEAM_LEAD_REF`; verified by grep.)

**`supabase/migrations/20260826130000_priced_cost_events_daily.sql`** (new)
- `priced_cost_events_daily` — `day`, `tenant_id`, `provider`, `sku`, `method`, `lane`
  (`metadata->>'lane'`), `quantity`, `cost_usd`. Join predicate **copied verbatim** from
  `rollup_costs` (`20260725130000_cost_rollup_fn.sql:96`–`:100`): half-open rate window, explicit
  `at time zone 'utc'` on every cast. Header states the duplication is deliberate and the two change
  together.
- `unpriced_cost_events_daily` — same grouping, rows with **no** matching rate, excluding
  `provider = 'spine'`. Existing history has `lane` NULL; correct, do not backfill.
- `revoke all … from anon, authenticated` on both.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass
- [x] new test: `recordModelUsage` with `lane: 'planner'` writes `metadata.lane = 'planner'` on
      **every** row it emits (input, cached-input, cache-write, output), via the `RecorderDeps.append`
      seam — no API key needed
- [x] new test: omitting `lane` writes `metadata: null` (existing callers unaffected)
- [x] new test (local stack): seed two events with different lanes + a rate row →
      `priced_cost_events_daily` returns one row per lane with the right `cost_usd`; an event whose
      sku has no rate appears in `unpriced_cost_events_daily` and **not** in the priced view
- [x] added in review: same-lane/same-day rows collapse to one; a day covered by two adjoining rates
      prices ONCE (the half-open window, the reason the predicate is copied not rewritten); the
      `spine` counter is not reported as unpriced; an unlabelled event still prices with `lane: null`
- [x] added in review: confirmed on the local stack that neither view is granted to
      `anon`/`authenticated` despite `auto_expose_new_tables` still being on

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test`
- [x] Apply both view definitions to the pilot, confirm via `information_schema.views`
      — **DONE 2026-08-26**: both present; `exposed` to anon/authenticated = `none`.
- [x] Views read correctly against REAL pilot data (pre-deploy, so every `lane` is NULL — the
      expected state). Last 4 days: `2026-08-26 anthropic $2.3059 / 659,127 tok`,
      `2026-08-26 fireworks $0.0089 / 2,873 tok`, `2026-08-25 anthropic $1.5352 / 566,814 tok`,
      `2026-08-25 fireworks $0.0103 / 3,082 tok`, `2026-08-24 fireworks $0.1794`,
      `2026-08-23 fireworks $0.5972`. **`unpriced_cost_events_daily` returned ZERO rows** for the
      window — answering the research's standing open question for these days: priced totals have
      not been under-reporting.
- [ ] **DEFERRED — needs a deploy.** After a planner tick on the new code:
      `select lane, sum(cost_usd) from priced_cost_events_daily where day = current_date group by 1`
      returns a `planner` row (and a `reflector` row on a day it runs).

### Manual verification
- [ ] none

## Phase 4: `npm run ticks`

### What this phase does
An operator report over `lifecycle_runs` — the thing that makes the table worth having.

### Changes required

**`scripts/ticks/report.mjs`** (new) — `pg` + `DATABASE_URL`, modelled on
`scripts/planner-metrics/report.mjs`. Imports `findTickGaps` from `../../dist/db/lifecycleRuns.js`
(the `scripts/seed.mjs` idiom — build first). Prints, for a `--since` window defaulting to 24h:
- **Ran:** rows seen vs expected (`window / 5 min`), and every gap from `findTickGaps` with its
  wall-clock span — the missing-cron signal.
- **Failures:** rows with `ok = false`, naming each step whose value has a `stepError`.
- **Steps:** per step, a count of each distinct `skipped` reason — a step silently off shows here.
- **Planner:** per firm, its `outcome` tally from `plans[]`, plus `turns` / `toolCalls` / `ms`
  totals — Phase 2's payoff.
- **Mute:** any tick carrying `ladderMute`, verbatim.
- **Cost:** `priced_cost_events_daily` per lane per day, **always** with the matching
  `unpriced_cost_events_daily` count beside it — never a bare dollar figure (research trap 6).

**`package.json`** — `"ticks": "npm run build && node -r dotenv/config scripts/ticks/report.mjs"`

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass
- [x] `findTickGaps` tests from Phase 1 still pass (the report's only real logic)
- [x] `npm run ticks -- --since 24h` runs clean on the **local** stack, printing "expected N, saw 0"
      rather than crashing on an empty table
- [x] added in review: the report's populated path was exercised end to end against the local stack
      with seven synthetic ticks (a healthy run, a 25-minute hole, a failing tick, two firms with
      four different outcomes, a ladderMute). Every section rendered; the gap scan reported
      `19:58 → 20:23 (4 missed, 25 min dark)`. Synthetic rows deleted afterwards.
- [x] added in review: a young table no longer reads as an outage — when records do not yet cover
      the window, the report prints the honest denominator beside the window's

### Live verification (agent-executable)
- Prerequisites: `DATABASE_URL` pointed at the pilot (**read-only queries**; the script issues no
  writes — confirm by reading it before running)
- [x] Confirmed read-only before running: zero `insert`/`update`/`delete`/`truncate` in the script.
- [x] `npm run ticks` against the pilot — runs clean. Cost section reads real spend
      (`2026-08-26 anthropic $2.5031 / 706,141 units`; `2026-08-25 anthropic $1.5352`), unpriced 0.
- [ ] **DEFERRED — needs a deploy.** The "Ran" line currently reads `saw 0`, which is correct: the
      run-record code is not deployed. After deploy it must show ~288/day with no gaps, and the
      Steps section must be cross-checked against the live Render env — any step the report calls
      silently skipped is a real finding, not a report bug.

### Manual verification
- [x] Read the report once and confirm it answers "did it run, what did it skip, what did it cost"
      without needing a follow-up query. **Approved by the user 2026-08-26** against the live 72h
      pilot run.

*Phases 1–3 have no manual checks — the implementer continues through them. Pause after
Phase 4: its manual check is non-empty.*

---

## Closing notes — final review (2026-08-26)

`/code-review high` over the full staged diff found **7 issues, all fixed and each re-verified by
reproducing the failure first**:

1. **`report.mjs` — an outage IN PROGRESS was invisible.** `findTickGaps` walks *between* rows, so a
   cron dead for ten hours left no gap to find and the report said "did not miss a beat". This
   defeated the report's stated purpose. Added a trailing `now - last tick` check, which now leads
   the section. Reproduced (24 ticks ending 10h ago) → now prints
   `🚨 NOT RUNNING: last tick was 600 min ago (~119 ticks missed and counting)`.
2. **`report.mjs` — the young-table denominator hid the same outage.** It measured to the *last row*,
   so a trailing outage shrank the expectation to exactly what was seen. Now measured to `now`: the
   same fixture reports `~259 expected` instead of `~24`. A denominator must not be defined by the
   thing it exists to expose.
3. **`report.mjs` — red ticks with no `stepError` printed a header and nothing else.** The systemic
   detectors (`lifecycle.ts:248`, `:291`, `:422`) set `ok = false` while the step still reports an
   ordinary summary — i.e. revoked key / vendor down / DB down, the classes most worth naming. Now
   falls back to `rowErrors`/`tenantErrors`, with a raw-summary hint if even that is silent.
4. **`report.mjs` — every cost line was misdated by a day on UTC+ hosts.** node-postgres parses a
   `date` column to LOCAL midnight; `toISOString()` then shifts it back. Fixed by taking `day::text`
   from Postgres. Verified identical output under `TZ=America/Los_Angeles` and `TZ=Asia/Tokyo`.
5. **`lifecycle.ts` — the record write could manufacture the gap it exists to find.** `await` with no
   timeout meant a *hanging* Supabase held the process open for undici's 300s = five ticks, and
   Render skips overlapping cron runs. Now raced against a 10s ceiling (`.unref()`ed): losing one
   observation beats losing five ticks of work.
6. **`lifecycle.ts` + migration header — the security claim was stronger than the code.** The header
   said the row holds no customer-derived text, but `stepError` is a vendor/Postgres message capped
   at 500 chars, not rewritten, and such a message can incidentally echo a value (a 23505 quotes the
   conflicting key). Kept the text — an unreadable error is an unfixable step, and it already goes
   to stdout — and made the guarantee precise instead: *no planner- or customer-authored free text*.
7. **`lifecycleRuns.test.ts` — an exact-count assertion on an unscoped DELETE.** `pruneLifecycleRuns`
   deletes by cutoff, not by marker, and `seed.mjs` deliberately never truncates this table, so any
   local cron run would have failed the test for a non-defect. Relaxed to `>= 1`; which rows survive
   is still asserted exactly.

**Gates after the fixes:** `typecheck` ✓ · `lint` ✓ · `npm test` ✓ 2331 passed | 8 skipped ·
`build` ✓.

### Still open — needs a deploy

Six live checks are marked `DEFERRED`, not passed. Both migrations were applied to the pilot during
verification (the safe order — deploys do not migrate), so the pilot holds the table and the two
views but not yet the code that writes to them. Until a deploy:

- `npm run ticks` correctly reports `saw 0` ticks;
- every `lane` in the cost views is `NULL`, which is the honest pre-deploy state and must not be
  backfilled.

### Measured along the way

`unpriced_cost_events_daily` returned **zero rows** for 2026-08-23 → 08-26 on the pilot — answering
the research's standing open question for that window: priced totals have not been under-reporting.
Pilot spend over those days: anthropic `$1.5352` (08-25) → `$2.5410` (08-26), fireworks `$0.5972`
(08-23) → under a cent (08-26). Which lane drove the Anthropic rise is exactly what the deployed
label will answer.

