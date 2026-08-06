---
date: 2026-08-04
task: query_spine — a read-only, tenant-scoped fallback for the long tail of read questions
research: (inline; read-surface audit + s2 latency measurements, 2026-08-04)
status: design — open decisions RESOLVED 2026-08-04; ready to implement on approval
---

## What this is for, and what it is not for

**For:** questions no tool answers. `get_availability` closed one such gap; there will always be
another ("how many jobs did we do in July?", "which customers have we not visited since May?").
Shipping a bespoke tool per question does not scale.

**Not for:** replacing the specific read tools. That was the original hypothesis and **the
measurement killed it**:

| | tokens |
|---|---|
| all 8 read tools' schemas, combined | **1,414** |
| the one pathological tool we already denied (`message`) | ~4,000 |
| a cold turn | ~35,600 |

The entire read surface is **4% of a cold turn**. Pruning it saves nothing worth the risk. The
only tools that failed the four-property test outright (`get_job`, `list_recent_captures`, both
0 recorded calls) are worth **175 tokens** together, and deleting them would cut `update_job` and
`retract_capture` off from their id source. Recommendation stands: **delete nothing.**

So `query_spine` is **additive coverage**, judged on whether it answers new questions — not on
tool count.

## The hard constraint

From the `data-security` skill and verified in the code:

- **RLS is off** (`relrowsecurity = 0` on `visits`, checked live) and the app connects as
  `service_role`, which bypasses RLS even where it exists.
- Isolation today rests **entirely** on hand-written `.eq('tenant_id', …)` — 44 of them in
  `src/db/assignments.ts` alone.
- Identity must come from the **verified HMAC header**, never a tool argument.

A general query tool would be the first path where the tenant filter is not written by a reviewed
accessor. **If the model writes the filter, a prompt is the only thing between tenants.** That is
not acceptable, and it is the whole reason for the design below.

## Design — the filter is never in the model's SQL

```
agent ──SQL──> query_spine tool
                    │  identity from verified HMAC header (NOT from args)
                    ▼
              BEGIN; set_config('spine.tenant_id', <verified>, true)
                    │
                    ▼
              connection as spine_reader          ← layer 1: cannot write, at all
                    │
                    ▼
              SELECT ... FROM v_*                 ← layer 2: views filter by the GUC
                    │                                        base tables not granted
                    ▼
              statement_timeout + row cap         ← layer 3: blast radius
```

### Layer 1 — a role that cannot write

A dedicated `spine_reader` Postgres role with **no** INSERT/UPDATE/DELETE/TRUNCATE/DDL grant
anywhere. Not "we validate that the SQL is a SELECT" — the connection is structurally incapable of
writing. This must not be the same connection the rest of the app uses.

### Layer 2 — views only, filtered by a transaction-local setting

`REVOKE SELECT ON ALL TABLES` from `spine_reader`; `GRANT SELECT` only on purpose-built views:

```sql
create view v_schedule as
  select a.id as assignment_id, a.starts_at, a.ends_at, a.status,
         t.ref as technician_ref, c.name as customer_name, ...
    from assignments a
    join jobs j on j.id = a.job_id
    join customers c on c.id = j.customer_id
    left join technicians t on t.id = a.technician_id
   where a.tenant_id = current_setting('spine.tenant_id')::uuid;
```

The tool sets `spine.tenant_id` from the verified identity inside the transaction
(`set_config(..., true)` = transaction-local). The model never sees it and cannot set it.
Unset → `current_setting` **throws** → fail closed, loudly.

**Why views and not "we append a WHERE clause".** String-injecting a tenant filter into
model-written SQL is right in theory and wrong in practice: every subquery, CTE, UNION arm and
join needs its own filter. This repo already has the lesson recorded one level up — *"PostgREST
embeds don't inherit tenancy: a nested read can cross tenants even when the top-level filter is
right."* A view is enforced by the planner. Our string handling is not.

### Layer 3 — blast radius

`statement_timeout` (~5s), a hard row cap, single-statement only, reject anything that is not one
`SELECT`. These are **belt**. Layers 1 and 2 are the braces: if the parser is fooled, the role
still cannot write and the views still filter.

## Decisions — RESOLVED 2026-08-04 (owner)

### A. Schema exposure → **static, in the tool description**

A compact schema of the views ships in the description (~400-800 input tokens per turn) rather
than behind a `describe` round trip.

Rationale: wall-clock on this stack is **output tokens ÷ ~34 tok/s**, so a ~7s discovery hop costs
far more than 800 tokens of input, and search→describe→call is structurally the shape that made
tool search slow. **Caveat carried forward:** input-vs-latency is the exact trade that was got
wrong with tool search, so phase 3 must measure a real turn before this is treated as settled. If
the description cost turns out to dominate, the fallback is the hybrid (hot views inline, rare
ones on demand) — not a full round trip.

### B. L1 (`raw_captures`) → **excluded**

`raw_captures` is verbatim customer email: the densest PII in the system and append-only, so
anything it leaks cannot be un-leaked. `list_recent_captures` already exposes a shaped view with
its own rules. Not needed to answer "when does Joy work". Revisit only when a real question
requires it, and treat that as its own decision.

### C. Audit → **dedicated `query_audit` table**

Every execution records the SQL, the resolved tenant, the caller ref, row count and duration.

A table, not logs: this is the one tool where the agent composes its own data access, so "did
anyone query customer X?" must be answerable later, under our retention rather than the log
provider's. **Explicitly NOT L1** — a read is not a state-changing agent action under the recorded
classifier-free carve-out, and L1 is undeletable, so a query log there could never be pruned.

## The risk I would watch

**`query_spine` becomes the path of least resistance.** One tool always in view beats recalling
which specific tool fits, and prompt-level routing is precisely what failed this week — §0f *said*
"call `resolve_date`" and was ignored the moment the surface shifted.

Concretely: the schedule question starts arriving as hand-written SQL, with no `scheduleVersion`,
no board link, and a timezone bug that returns clean, plausible, wrong numbers. **I hit that exact
bug myself today** — I queried `visits.scheduled_at`, got zeros, and reported "the pilot DB has
zero scheduled visits". The schedule lives in `assignments.starts_at` and needs
`at time zone 'America/Los_Angeles'` to bucket by local day. Full schema access, superuser, no
time pressure — and a confident wrong answer.

Mitigations: name views for questions rather than tables; route away in the description; and
**re-run the tool census two weeks after launch** — if `get_team_schedule` usage collapses into
`query_spine`, that is a regression, not adoption.

## Phasing

1. `spine_reader` role + first views (`v_schedule`, `v_team`, `v_customers`) + the GUC plumbing,
   with a 2-tenant leak test per view — the filter must fail a test, not reach prod.
2. The tool: single SELECT, timeout, row cap, audit, `now` rider.
3. Live measurement on s2: does one `query_spine` call answer a question that previously had none,
   and what does it cost in seconds and tokens?
4. Census after two weeks → decide whether anything is genuinely unused before deleting a tool.
