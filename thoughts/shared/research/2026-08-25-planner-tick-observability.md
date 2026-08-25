---
date: 2026-08-25
branch: feat/the-ask-shape
commit: 71354c5
topic: The planner/cron observability gap — every surface that records a lifecycle tick, what each one cannot record, and what a caller must join to answer "did the planner run, when, in which window, and what did it cost"
supersedes: nothing
---

## Summary

The lifecycle cron ("the heartbeat that runs every five minutes") produces exactly one record of
itself: a single line of JSON printed to standard output and then thrown away. Everything else the
system stores — nudges, decisions, review items, gap summaries, cost events, and the four planner
metrics views — is anchored on a **gap** (a piece of work) rather than on a **run** (an execution).
The consequence is structural, not a bug: **a tick that had nothing to do leaves no trace anywhere
in the database**, so "no rows" and "never ran" are indistinguishable from SQL alone. The one
counter-example is `reflector_runs`, a per-run table added 2026-08-24 — and it exists because the
reflector needed a "have I already run today" gate for *control flow*, not because anyone was
trying to make runs observable. This document maps every surface, what it records, what it cannot,
how long it survives, and the four traps (spend-vs-execution, shared cost identity, tenant scoping,
timezone) that make a naive read produce a confident wrong answer.

## Entry Points

- **`src/jobs/lifecycle.ts:502`** — `main()`, the only scheduled entrypoint. Render cron
  `crn-d93iq7a8qa3s73ap6260`, schedule `*/5 * * * *`, start command `npm run job:lifecycle`.
- **`src/jobs/lifecycle.ts:508`** — `process.stdout.write(JSON.stringify(summary) + '\n', …)`,
  immediately followed by `process.exit(summary.ok ? 0 : 1)`. This is the entire persistence story
  for a tick's execution record.
- **`src/jobs/lifecycle.ts:146`** — `heavyTick`, the quarter-hour gate for steps 1–7
  (`getUTCMinutes() % 15 < 5`).
- **`src/jobs/lifecycle.ts:364`** — `plannerTick`, the half-hour gate
  (`getUTCMinutes() % 30 < 5`). Stateless by design: the minute *is* the state, so no run record is
  needed for the cadence to work.
- **`src/teamLead/planner.ts:1572`** and **`:1580`** — the two in-planner gates, in this order:
  empty gap queue, then ask window.

## Key Files

| Path | Role in observability |
|---|---|
| `src/jobs/lifecycle.ts` | Builds `LifecycleSummary` (shape at `:82`–`:108`), prints it, exits. Owns both cadence gates and the `ladderMute` warning field (`:100`–`:104`). |
| `src/teamLead/planner.ts` | `PlannerSummary` (`:164`–`:185`) — the richest per-tick record that exists, including `plans: PlannerTenantPlan[]` carrying per-tenant `turns`, `toolCalls`, `ms`, and every decision's reason. Never persisted. |
| `src/jobs/watchers.ts` | `WatchersSummary` (`:271` area) — `gapsFound`, `freshGaps`, `nudgesWouldCreate`, `itemsOpened`. Same fate: stdout only. |
| `src/db/costs.ts` | `recordModelUsage` (`:182`), `MODEL_SKUS` (`:127`), `rollupCosts` (`:472`), `readTenantCostDetail` (`:556`), `readRollup` (`:587`). The billing ledger. |
| `src/db/nudgeDecisions.ts` | `recordNudgeDecisions` (`:70`) — insert-only decision corpus. One row per decision, zero rows when there were no decisions. |
| `src/db/nudges.ts` | The gap rows themselves; `asked_at`, `queued_at`, `resolved_at`, `escalate_after` are the ladder's clocks. |
| `src/db/reviewItems.ts` | The manager queue (rung 2). |
| `src/jobs/summarize.ts` | `runGapSummaries` — one row per **closed** gap into `gap_summaries`; `heldBack` counts gaps not yet closed. |
| `src/teamLead/reflector.ts:127`–`:170` | `ranToday`, `newSinceLastRun`, `writeMarker` — the only per-run table in the system. Note these four call sites use `getClient()` directly rather than going through `src/db/` (CLAUDE.md convention). |
| `supabase/migrations/20260823230000_planner_metrics_views.sql` | `working_hours_between()`, `mv_gap_outcomes`, `mv_escalation_fates`, `mv_whiplash`, `mv_extend_effectiveness`. |
| `supabase/migrations/20260824020000_planner_metrics_v2.sql` | Revises all four views. |
| `supabase/migrations/20260824030000_reflector_runs.sql` + `…040000_reflector_runs_ok.sql` | `reflector_runs (id, tenant_id, ran_at, proposed, ok)`. |
| `supabase/migrations/20260725120000_cost_ledger.sql:127` | `cost_rollup_monthly` — PK `(tenant_id, period_start, provider, method)`. |
| `supabase/migrations/20260813000000_ops_events.sql:31` | `ops_events` — incident log, host-scoped. |
| `src/db/technicians.ts:96` | `listTenantIdsWithTelegramBindings` — decides which tenants exist as far as the sweep is concerned. |

## Data Flows

### What one tick produces

```
Render cron */5
      │
      ▼
 runLifecycle(nowIso)
      │
      ├─ steps 1–7   (heavyTick: minute % 15 < 5)
      ├─ watchers    (every tick)   ──▶ nudges / review_items  ── only when a gap is FRESH
      ├─ planner     (minute % 30 < 5)
      │     ├─ open nudges == 0? ──▶ skippedNoGaps ──▶ ✗ nothing written, no model call
      │     ├─ outside 7am–7pm?  ──▶ skippedWindow  ──▶ ✗ nothing written, no model call
      │     └─ else ──▶ Opus call ──▶ cost_events (per model call, via runToolLoop)
      │                          └──▶ nudge_decisions (per decision)
      ├─ gapSummaries ──▶ gap_summaries  ── only for CLOSED gaps
      └─ reflector    ──▶ reflector_runs ── one row PER RUN  ◀── the lone exception
      │
      ▼
 JSON.stringify(summary) ──▶ stdout ──▶ Render log stream ──▶ (rotates)
      │
      ▼
 process.exit(ok ? 0 : 1)
```

Every arrow marked `✗` is a tick that executed and left nothing behind. On 2026-08-24 that was 22
of the day's 24 in-window planner ticks.

### The cost path

`runToolLoop` (`src/model/toolLoop.ts:423`) calls `recordUsage` — defaulting to `recordModelUsage`
— **once per model call**, with the `CostContext` its caller supplied. The planner supplies
`{ tenantId, technicianRef: TEAM_LEAD_REF }` at `src/teamLead/planner.ts:1720`.

`recordModelUsage` (`src/db/costs.ts:182`) resolves `MODEL_SKUS[vendor]` — keyed on the **ledger
vendor derived from the resolved endpoint**, not on a configured name — and appends up to four
rows per call: fresh input, cached input, cache write, output. Quantities are **units (tokens),
never dollars**; dollars are derived at read time by joining `cost_rates` on
`(provider, sku, effective_from <= the event's date)`.

There are exactly two consumers of that join:

1. `rollup_costs` (RPC) → `cost_rollup_monthly`, whose primary key is
   `(tenant_id, period_start, provider, method)`. **It aggregates away the sku and the day.**
2. `readTenantCostDetail` / `readRollup` — reads of that same monthly table.

Any per-day or per-sku figure therefore requires a hand-written lateral join against `cost_rates`.
There is no view for it.

## External Dependencies

- **Render** — cron scheduling, and the *sole* store of the tick summary. The logs API constrains
  queries to start times "within the last 30 days"; actual retention is a plan property
  (`lifecycle-heart` is on `starter`) and is not knowable from this repo.
- **Anthropic / Fireworks** — the inference endpoint. Which one served the call is what stamps the
  SKU, so the ledger records the *vendor that billed*, not the model that was configured.
- **Supabase / PostgREST** — every table read. PostgREST caps responses at 1000 rows, which is why
  `rollupCosts` aggregates in Postgres rather than in the app (`src/db/costs.ts:466`–`:468`).
- **Composio** — writes `sku = 'tool_call'` events that are **deliberately unpriced**
  (`supabase/migrations/20260730120000_unprice_brave_composio.sql`: the rates were deleted, not
  closed, because neither Brave nor Composio bills per unit from the first one).

## Constraints and Invariants

1. **The execution record is stdout-only and unkeyed.** `LifecycleSummary` has no run id, no
   timestamp field, and no writer. Its timestamp exists only as the log line's own clock. Nothing
   in the database can be joined to a specific tick.

2. **Every persisted surface is keyed to a business object, never to a run.** `nudges`,
   `nudge_decisions`, `review_items`, `gap_summaries` and all four `mv_*` views hang off a nudge or
   a decision. `mv_gap_outcomes`, `mv_escalation_fates`, `mv_whiplash` and
   `mv_extend_effectiveness` all begin `from nudges` or `from nudge_decisions`. **None of the
   purpose-built planner telemetry can answer "did the planner run."**

3. **`reflector_runs` is the only per-run table, and it exists for control flow.** Its migration
   header states the reason — without a marker the reflector "re-fires a billed model call daily on
   unchanged input" — and explicitly records why `ops_events` could not be reused: `ops_events` has
   a `host_id` FK to `hosts` and a one-open-per-(host, service) partial index, neither of which fits
   a tenant-scoped run marker.

4. **Counting ticks from `cost_events` counts SPEND, not EXECUTION.** A tick that returns at
   `planner.ts:1572` makes no model call, so it writes no cost rows. Two further distortions in the
   same measurement:
   - Grouping by `date_trunc('minute', occurred_at)` **overcounts**: one tick's turns can straddle
     a minute boundary. Grouping into 30-minute buckets matches the cadence gate.
   - Each model call writes up to four rows (one per SKU tier), so a raw row count is neither
     ticks nor calls.

5. **The cost identity is shared between the planner and the reflector.** `planner.ts:1720` and
   `reflector.ts:237` both pass `technicianRef: TEAM_LEAD_REF` (`'spine:team-lead'`). Nothing in a
   `cost_events` row names the lane, the service, or the caller. A figure filtered on
   `technician_ref = 'spine:team-lead'` is *team-lead-identity spend*, and equals planner spend only
   on days the reflector did not run.

6. **The rate join drops unpriced events silently.** Pricing requires a matching `cost_rates` row;
   an event whose sku has no rate simply disappears from any priced total rather than appearing as
   zero. `RollupResult.unpricedEvents` (`src/db/costs.ts:459`–`:461`) is the only signal, and it is
   reported per rollup call — a hand-written day query has no equivalent. `tool_call` rows fall out
   this way **by design**.

7. **Gate ordering makes one skip reason nearly unobservable.** The empty-queue check
   (`:1572`) precedes the ask-window check (`:1580`), so `skippedWindow` can only ever be non-zero
   when there are open nudges. An out-of-hours tick on an empty queue reports `skippedNoGaps`. This
   is why `skippedWindow: 0` appears on 10pm ticks.

8. **Cadence and window are different clocks.** The lane gate is `getUTCMinutes() % 30 < 5` — UTC,
   unconditional, 48 entries/day. The window is `insideAskWindow`, firm-local, 7 inclusive to 19
   exclusive (`src/teamLead/compose.ts:32`–`:33`), evaluated per tenant against `tenants.timezone`.
   "The planner runs 24 times a day" and "the planner is entered 48 times a day" are both true and
   describe different things.

9. **Timezone: every stored timestamp is `timestamptz` (UTC); every meaningful boundary is
   firm-local.** A "day" of planner activity only means something under
   `at time zone tenants.timezone`. `working_hours_between()` in the metrics migration is the only
   place in the codebase that does this arithmetic, and its header pins the reason: compute from
   real-UTC columns plus `tenants.timezone`, "never from naive-local context values."

10. **Tenant scoping: only tenants with an active Telegram-bound technician are swept.**
    `listTenantIdsWithTelegramBindings` (`src/db/technicians.ts:96`–`:110`) filters
    `telegram_user_id is not null` and drops inactive states. The pilot database holds four tenants;
    one is swept. An unscoped query over `assignments`, `nudges`, or `cost_events` silently mixes in
    the eval tenants and reads as pilot activity.

11. **Retention is asymmetric.** Database rows are permanent (`raw_captures` is append-only and
    undeletable by trigger). The tick summary — the only record that a tick *happened* — lives only
    as long as Render keeps the log line. The richest data in the system (`plans[]` with `turns`,
    `toolCalls`, `ms`, and each decision's reason) is the most perishable.

12. **`ok` is the only cross-tick alarm, and it is an exit code.** `runLifecycle` sets `ok = false`
    on step errors; `main()` maps it to the process exit status. Render's `notifyOnFail` is the
    consumer. Nothing records *which* step failed beyond the same perishable JSON.

## Decision Points

1. **Where a per-tick record would live, if one existed.** Three shapes are already precedented in
   this codebase: a dedicated tenant-scoped table following `reflector_runs` (references only
   `tenants`, named in both cleanup lists, RLS enabled, revoked from `anon`/`authenticated`);
   `ops_events`, which the `reflector_runs` migration header documents as unusable for tenant-scoped
   run markers because of its `host_id` FK and one-open partial index; or persisting the whole
   `LifecycleSummary` as a JSONB row, which would capture `plans[]` verbatim but store a shape with
   no schema.

2. **Whether the planner and reflector keep sharing `TEAM_LEAD_REF` in the cost ledger.** Today one
   filter returns both lanes' spend. Separating them means either distinct `technicianRef` sentinels
   at the two call sites (`planner.ts:1720`, `reflector.ts:237`) or a new column on `cost_events`
   naming the lane. The first changes the meaning of existing rows' `technician_ref` going forward
   but leaves history intact; the second leaves all history un-tagged.

3. **Whether cost stays monthly-only in derived form.** `cost_rollup_monthly` drops the sku and the
   day. Any daily or per-lane figure is currently a hand-written lateral join, which is also the
   join that silently drops unpriced events. A day/sku rollup or a priced view would change that;
   keeping it as-is means every such answer is re-derived by hand each time.

4. **Whether the two planner skip reasons stay ordered.** With the empty-queue check first,
   `skippedWindow` is only reachable when nudges are open, so the summary cannot currently
   distinguish "idle because out of hours" from "idle because nothing to do." Evaluating both
   independently would make the two states separable in the record.

5. **Whether `plans[]` is persisted.** It already contains per-tick `turns`, `toolCalls`, `ms` and
   every decision's `reason` — the exact data an eval or a cost-per-decision analysis would want —
   and today it exists only in a rotating log stream.

## Open Questions

- **Render's actual log retention for the `starter` plan.** The logs API accepts start times within
  30 days; whether the plan retains that long is not determinable from this repo. This bounds how
  far back any execution question can be answered at all.
- **Has `unpricedEvents` ever been non-zero in the pilot?** Every tick summary observed on
  2026-08-24/25 reports `unpricedEvents: 0`, but that is the rollup's count for the months it
  recomputed, not a standing property. A non-zero value would mean priced totals have been
  under-reporting.
- **Has reflector spend ever overlapped a day used to quote "planner cost"?** The reflector reported
  `ran: 0, skippedGate: 1` on every tick observed, so recent figures are planner-only in practice —
  but nothing in the schema enforces that, and past figures have not been checked.
- **Does `mv_*` telemetry get read by anything?** No caller in `src/` references the four views by
  name; they were created for operator queries. Whether anything consumes them is not answerable by
  reading the repo.
- **Whether `getClient()` use in `reflector.ts` (4 sites) is a deliberate exception** to the
  CLAUDE.md rule that all database access goes through `src/db/`, or an oversight. The migration and
  code comments do not say.
