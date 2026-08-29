---
date: 2026-08-29
branch: feat/openrouter-migration
commit: 6edff40
topic: Build 2 — every constant that encodes firm behaviour, whether a per-tenant value can reach its call-site, and everything coupled to the 7am-7pm window
supersedes: nothing
---

**`supersedes:` — nothing.** This refines §3 of
`thoughts/shared/research/2026-08-28-the-harness-audit.md` (which inventoried the constants) by
answering the question that document did not ask: *can a per-firm value physically reach the place
that reads it?* No decision is overturned.

## Summary

Build 2 wants the ~20 numbers that encode "how a trades firm works" to become per-firm data instead
of global constants. Reading the code, **that is three separate jobs, not one**, and they differ by
an order of magnitude in cost.

Most constants are read **inside a loop that already knows which firm it is** — those are a lookup
away. A handful are read by **pure functions that take no tenant**, so the value has to be threaded
in. And three are read somewhere a lookup cannot go at all: **a module-scope string built once when
the file is imported**, and **a SQL function with the hours written into it as literals**.

The second finding is about the window specifically: `gap_summaries.working_hours_open` is a
**stored column**, computed under 7am-7pm for every row ever written. Changing the window does not
just change future behaviour — it silently makes old rows and new rows mean different things, in
the exact table the Reflector reads as its corpus.

## Entry points

| Where | File:line | Role |
|---|---|---|
| Watcher constants | `src/jobs/watchers.ts:94-174` | the detector/sweep tuning surface |
| Ask window | `src/teamLead/compose.ts:32-47` | `ASK_WINDOW_*` + `insideAskWindow` |
| Window gate | `src/teamLead/planner.ts:1631` | skips the whole tenant iteration |
| Cadence gate | `src/jobs/lifecycle.ts:462` | `getUTCMinutes() % 30 < 5` |
| TS working-hours | `src/jobs/workingHours.ts:44` | the metric twin |
| SQL working-hours | `supabase/migrations/20260823230000_planner_metrics_views.sql:17` | the DB twin |
| Pre-ask carve-out | `src/jobs/watchers.ts:727-735` | closes an unasked gap |
| Profile pattern | `src/db/tenantProfiles.ts` | the template to copy |

## The constants, tiered by whether a per-firm value can reach them

### Tier A — the tenant is already in scope (a lookup away)

Every one of these is read inside `runWatchers`/`runReflector`'s per-tenant loop or a
tenant-scoped function.

| Constant | Declared | Read at | Tenant in scope |
|---|---|---|---|
| `OVERDUE_HOURS` 3 | watchers.ts:94 | watchers.ts:379 | ✅ tenant loop |
| `LOOKBACK_HOURS` 72 | watchers.ts:95 | watchers.ts:378 | ✅ |
| `MAX_NEW_ITEMS_PER_TENANT_TICK` 5 | watchers.ts:96 | watchers.ts:1106, 1206 | ✅ |
| `NUDGE_ESCALATE_HOURS` 24 | watchers.ts:120 | watchers.ts:632 | ✅ |
| `NUDGE_DELIVERY_DEADLINE_HOURS` 18 | watchers.ts:158 | watchers.ts:841 | ✅ |
| `PLANNER_SILENCE_HOURS` 24 | watchers.ts:174 | watchers.ts:680, 818 | ✅ |
| `MIN_SUMMARIES` 15 · `MIN_NEW_SINCE_LAST_RUN` 5 · `REFLECT_FROM_HOUR` 2 | reflector.ts:27-29 | reflector.ts tenant loop | ✅ |
| `LESSONS_BLOCK_BUDGET` 2000 · `LESSON_TEXT_MAX` 300 · `PROPOSAL_STALE_DAYS` 60 · `RETIRE_STRIKES` 2 | lessons.ts:15-21 | tenant-scoped fns | ✅ |
| `MAX_SERVE_COUNT` 10 · `MAX_DELIVERY_ATTEMPTS` 3 | nudgeQueue.ts:32,35 | delivery path | ✅ via the nudge row's `tenant_id` |

**One that is tenant-reachable but not tenant-SHAPED:** `maxNewPerTenantTick`
(`nudgeKinds.ts:145`, values at :259 and :381) is a property of a **kind**, not of a firm. A
per-firm override is a two-key lookup (firm × kind), not a one-key one.

### Tier B — pure functions with no tenant parameter (threading required)

| Function | File:line | Signature | Note |
|---|---|---|---|
| `holdCeilingMs` | planner.ts:758 | `(n: Nudge): number` | `Nudge` carries `tenant_id`, but the function is synchronous and pure — it cannot await a lookup. The value must be passed in. |
| `currentDeadlineMs` | planner.ts:769 | `(n: Nudge, askedAtMs: number): number` | same |
| `validateDecisions` | planner.ts:938 | `(raw, views, nowMs, sweepLive)` | **exported**. Called from inside `runPlanner` (which has `tenantId`), so a 5th parameter reaches it — but it is also called directly by tests and by the eval harness, so every caller moves. |

`validateDecisions` reads `NUDGE_ESCALATE_MAX_HOURS` (:1311, :1314) and
`NUDGE_DELIVERY_DEADLINE_HOURS` (:1255) to build **refusal messages the model reads**, so a
per-firm value changes prompt-visible text, not just arithmetic.

### Tier C — module-scope strings built at import time (the expensive one)

```
src/teamLead/plannerPrompt.ts:28   export const PLANNER_SYSTEM = [
                              :57     `...no more than ${NUDGE_ESCALATE_MAX_HOURS} hours after...`
                             :220   ].join('\n');
                             :294   SUBMIT_PLAN_TOOL — same constant, inside a JSON-schema description
```

`PLANNER_SYSTEM` is a **`const` evaluated once when the module is first imported**. There is no
tenant, no request, and no opportunity for a lookup — the string exists before any firm is known.

Making `NUDGE_ESCALATE_MAX_HOURS` per-firm therefore means `PLANNER_SYSTEM` and `SUBMIT_PLAN_TOOL`
stop being constants and become **functions of the firm's settings**. Consequences visible in the
code today:

- every importer changes (`planner.ts:1720` passes `PLANNER_SYSTEM` into `runToolLoop`);
- `src/eval/doctrine.ts` exists precisely so the eval renders the REAL prompt rather than a
  paraphrase — it would need the same settings to keep doing that;
- `plannerPrompt.ts`'s own header (:1-8) records that this import is read **at module scope** and
  explains why that is currently safe against the `watchers`/`nudgeKinds` cycle. A function-shaped
  prompt changes when that read happens.

### Tier D — SQL, outside TypeScript entirely

```sql
-- supabase/migrations/20260823230000_planner_metrics_views.sql:17
create function working_hours_between(from_ts timestamptz, to_ts timestamptz, tz text)
...
  least(d + interval '19 hours', to_ts at time zone tz)
  - greatest(d + interval '7 hours', from_ts at time zone tz)
```

The function accepts `tz` but **the window hours are SQL literals**. It is called at
`:48` inside `mv_gap_outcomes`, which **already joins `tenants t`** — so the firm is available at
the call site; only the signature is not.

A per-firm window requires: a signature change, every calling view updated, and the TS twin kept in
lockstep — which is asserted by `src/db/plannerMetrics.test.ts:89`
(*"working_hours_between — SQL and TS agree (the pinned definition)"*), executing both and comparing.

## The ask window: what it gates, and what quietly depends on it

```
runPlanner (planner.ts:1631)
  └─ if (!insideAskWindow(nowIso, tz)) { skippedWindow++; name(idlePlan('out_of_window')); continue }
        ▲
        └── gates the ENTIRE tenant iteration — evidence reads, money reads, history reads,
            prompt build and the model call all sit BELOW it.
```

Everything that reads the same boundary:

1. **`insideAskWindow`** — `compose.ts:35`, signature `(nowIso, tz)`. Takes a timezone, not hours.
2. **The eval harness** — `plannerSim.ts:392` calls the same function; `expectWindowSkip`
   (`plannerCorpus.ts:904`, `plannerSim.ts:366`) lets a scenario declare a tick that records
   nothing. The **`window-edges` family is 6 scenarios** (`plannerCorpus.ts:1056`).
3. **`workingHours.ts:44`** — the TS metric imports `ASK_WINDOW_*` directly from `compose.ts:1`.
4. **The SQL twin** — Tier D above.
5. **`NUDGE_DELIVERY_DEADLINE_HOURS`** — its header (watchers.ts:147-157) states the coupling
   outright: *"A window that ever excludes whole DAYS (a weekend rule, say) must lengthen this
   deadline with it, or weekend-held rows expire to the manager without the technician ever being
   asked… move this number FIRST if the window ever grows."* The current 18h is justified against a
   12h overnight hold (13h on a DST fall-back night).

### The finding that is not a code change: a stored column changes meaning

`gap_summaries.working_hours_open` is **written once, at summarize time**:

```
src/jobs/summarize.ts:154   working_hours_open: workingHoursBetween(n.asked_at, closedAt, tz),
```

Every row already in that table was computed against 7am-7pm. If the window becomes per-firm and a
firm's hours change, **old rows and new rows are measured on different scales with nothing marking
the boundary**. The column is consumed by the Reflector as corpus text
(`reflector.ts:92` — `· open {N}wh`), so the mixed population lands directly in what the model is
asked to generalise from.

## The planner cadence

```
src/jobs/lifecycle.ts:462   const plannerTick = new Date(nowIso).getUTCMinutes() % 30 < 5;
Render cron schedule         */5 * * * *   (UTC)
```

Two facts that shape any "reduced overnight cadence":

- **The cadence gate is computed ONCE per tick, in `lifecycle.ts`, OUTSIDE the tenant loop.** The
  window gate is computed **inside** `runPlanner`, per tenant. So today one decision is global and
  the other is per-firm, and a firm-local cadence would have to move the first one inward — either
  into `runPlanner`, or by passing a per-tenant predicate down.
- **The gate is UTC-based** (`getUTCMinutes()`), while "overnight" is firm-local. Any firm-local
  cadence needs the tenant's timezone at the point of the decision, which `lifecycle.ts` does not
  read today (it never loads tenants; `runWatchers`/`runPlanner` do).

Wake-on-event is ruled out by the user, so the shape is a timer predicate; the question is only
where it is evaluated and what it reads.

## The pre-ask carve-out — blast radius of deletion

```
src/jobs/watchers.ts:727   if (!x.n.asked_at) {
                    :728     const filledBeforeAsking = spec.filled(x.n, facts);
                    :729     if (filledBeforeAsking) {
                    :730       const closed = await resolveNudge(x.n.id, tenantId, 'answered', filledBeforeAsking);
                    :731       if (closed) summary.nudgesResolved += 1;
                    :732       closedThisTick.add(x.n.id);
                    :733       continue;
```

Tests that pin it:

| File:line | What it pins |
|---|---|
| `watchers.test.ts:483, 522` | a QUEUED row closed by the carve-out; `nudgesResolved === 1` |
| `watchers.test.ts:633, 673` | *"live ladder sweep: pre-ask activity closes…"* + the exact resolution string |
| `watchers.test.ts:1408` | the inverse — *"pre-ask activity must not count as an answer"* on an ASKED row |
| `nudgeQueue.test.ts:500` | the carve-out and `moot` each close one queued row |
| `summarize.test.ts:82` | the literal resolution `'a field report arrived — the gap filled itself'` |
| `planner.test.ts:460` | *"a never-asked gap is shown no evidence at all"* — the other half of the same premise |

`closedThisTick` (watchers.ts:619) exists to stop the group-expansion below from handing a manager a
row the carve-out just closed; removing the carve-out changes what that set can contain.

## The `tenant_profiles` pattern

**Table** (`supabase/migrations/20260815180000_tenant_profiles.sql:10-27`): `tenant_id` as primary
key referencing `tenants`, every field nullable text, one `jsonb not null default '[]'`, plus an
`updated_at` trigger.

**Typed layer** (`src/db/tenantProfiles.ts`):
- `STRING_COLUMNS` maps camelCase arg → snake_case column, closed with
  `satisfies Record<string, keyof TenantProfileUpdate>` — a typo'd column fails `tsc` instead of
  surfacing as a runtime PGRST204.
- `PROFILE_STRING_FIELDS = Object.keys(STRING_COLUMNS)` is described in its own comment as
  **"THE ROSTER"**: the MCP handler derives its accepted-args set *and* its reply echo from this
  export, so a field added here is accepted, patched and echoed in one edit. The comment names the
  alternative — a second hand-kept list — as *"exactly the silent coerced-to-absent drift the
  find_slots rule forbids"*.
- Patch semantics: only supplied fields change; explicit `null` clears; `licenseNumbers` is a FULL
  replacement, never a merge.

**Where a settings table would differ, from what the code shows:**
- Every profile field is a **string or a jsonb list**; settings are numbers and booleans, so
  `STRING_COLUMNS`'s single map does not carry over unchanged.
- The profile is **rendered into human copy** (`v_firm_profile`, invoice letterhead) and read
  rarely. Settings would be read by **code, on every tick, per tenant** — `runWatchers` and
  `runPlanner` both already do one `getTenant` per tenant per tick, so there is an existing read to
  join or a second one to add.
- The profile has **no default row**; `profileGaps` warns rather than blocking. Settings that gate
  behaviour cannot be absent in the same way — every read site currently has a constant fallback.

## Who could write it today

| Surface | Membership | Can set a firm-level value? |
|---|---|---|
| `set_firm_profile` | `ADMIN_TOOLS` (`server.ts:733`, folded into `MANAGER_TOOLS` at :1790) | **Yes — manager tier only.** The only firm-scoped write that exists. |
| `TEAM_LEAD_TOOL_NAMES` | `identity.ts:22` — `spine_read`, `recall_decisions`, `get_customer_context`, `resolve_date` | **No. The planner cannot write anything at all today.** Its identity is read/ask only, deny-by-default at the dispatch gate. |

There is no firm-level setting surface of any kind: `tenants` carries `timezone`,
`default_job_minutes`, `technician_horizon_days` and two seat counts, and nothing else about
operating behaviour.

## Constraints and invariants

- **The TS/SQL working-hours pair is pinned equal by test** (`plannerMetrics.test.ts:89`). They must
  move together or the corpus contradicts the baseline — the pinned-one-way rule the file's own
  header states.
- **`workingHours.ts` imports from `compose.ts`**, so the metric and the gate share one definition
  today. Splitting them (per-firm gate, global metric, or vice versa) breaks that shared source.
- **`plannerPrompt.ts` imports `NUDGE_ESCALATE_MAX_HOURS` at module scope**, and its header
  (:1-8) records that this was checked safe against the `watchers ↔ nudgeKinds` import cycle.
- **The rail must not state a different ceiling from the prompt** — `plannerPrompt.ts:1-4` exists
  because a stale literal would have the model name instants the rail then refuses, *and the
  refusal only reaches the model when EVERY decision was refused*.
- **`gap_summaries` rows are append-only in practice** (unique `nudge_id`, insert-ignore) — a
  recomputation of `working_hours_open` under new hours is not something the current writer can do.

## Decision points

1. **Where the per-firm values live.** A separate table (user decision, 2026-08-29: *"we can have a
   separate tenant_Table"*) rather than extending `tenant_profiles`. What remains open is whether
   settings are **columns** (typed, migration per field, `satisfies`-checkable like
   `STRING_COLUMNS`) or **one JSONB blob** (no migration per field, no type pin, and the
   `unwrapAttributes`/`isFactBundle` shape-guard problem `standingFacts.ts` already solves for L3).

2. **How Tier C is resolved.** `PLANNER_SYSTEM` cannot read a firm. Either it becomes a function of
   settings (every importer and the eval's `doctrine.ts` change), or the ceiling it names stays
   global while the *rail* becomes per-firm — which the prompt's own header says is the exact drift
   it was written to prevent.

3. **Whether the window's METRIC moves with its GATE.** The gate (`insideAskWindow`) and the metric
   (`workingHoursBetween` + its SQL twin + the stored `working_hours_open` column) share one
   definition. Making the gate per-firm without the metric leaves them disagreeing; making both
   per-firm changes the meaning of a stored column with no marker on existing rows.

4. **Where the cadence decision is evaluated.** Today it is one UTC-based boolean in `lifecycle.ts`,
   computed before any tenant is loaded. A firm-local overnight cadence needs the tenant timezone at
   that point — either move the decision into `runPlanner`, or give `lifecycle.ts` a tenant read it
   does not currently have.

5. **What happens to the per-KIND brakes.** `maxNewPerTenantTick` is a property of a nudge kind, not
   of a firm. A per-firm override is a firm × kind lookup, which is a different shape from every
   other constant here.

6. **Whether deleting the pre-ask carve-out is in this build or its own.** Six test sites pin it,
   one of them (`planner.test.ts:460`) pinning the complementary premise that an unasked gap is
   shown no evidence — which is a statement about the PROMPT, not the sweep.

## Open questions

- Does any firm actually want different hours? Unknown from code. The pilot is a test surface and
  cannot answer it (standing user rule).
- If a firm's window changes, is the intent that historical `working_hours_open` be recomputed,
  left as-is, or marked? Nothing in the schema records which window a row was measured under.
- `REFLECT_FROM_HOUR = 2` is firm-local and currently outside every firm's ask window. If the window
  becomes 24h for some firm, does the Reflector's gate still mean "overnight"?
- The delivery deadline's justification is arithmetic over the window (12h hold + 5h margin +
  DST hour). Is that recomputed per firm, or does 18h stay global while the window varies — in which
  case a firm with a narrow window silently loses its margin?
