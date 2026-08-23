# HANDOFF — per-tenant cost dashboard (CLOSED)

**Shipped 2026-07-27.** This file previously described work awaiting a deploy. That deploy is done
and verified; what follows is the closing record. The durable design rationale lives in the plan —
[thoughts/shared/plans/2026-07-24-per-tenant-cost-dashboard.md](thoughts/shared/plans/2026-07-24-per-tenant-cost-dashboard.md)
— and the operational facts in [docs/engineering-memory.md](docs/engineering-memory.md).

---

## Status

| | |
|---|---|
| PR | **#87, merged** |
| Migrations | 4 applied to the pilot (`daqapdlkgxfrhquacprv`) + recorded in `schema_migrations` |
| Deploy | live on Render |
| Gates | typecheck · lint · build clean; **811 tests pass on merged `main`** (96 of them cost-feature) |

## What it does

Records what every tenant costs in outside-vendor spend (DeepInfra, Anthropic, Brave, Composio,
plus flat monthly infra bills) and shows it on an operator-only page at `/admin`.

**The load-bearing rule: `cost_events` stores UNITS, never dollars.** Prices live in `cost_rates`,
versioned by effective date, joined at read time. That is what lets history re-price when a vendor
moves — DeepInfra changed $0.95 → $0.93 *during the three days this was being planned*. Do not
"simplify" by storing a dollar figure on the event.

```
cost_events   (units, never $)      cost_rates (prices, versioned by date)
 tenant · provider · sku · qty  ──join at READ time──►  dollars
 method: measured | allocated                              │
infra_costs (monthly bills + allocation rule) ─────────────┘
                       │
                       ▼
              cost_rollup_monthly   ← the ONLY thing /admin reads
```

## Verified live on the pilot (2026-07-27)

- `GET /admin/api/costs` → **200** with the token, **401** without (401 rather than 503 also proves
  `ADMIN_DASHBOARD_TOKEN` is set on Render). Wrong token → 401; `period=2026-13` → 400; POST → 405;
  non-uuid tenant → 400; unknown tenant → 404; `/admin/static/../.env` → 404.
- **Dashboard figure == database.** API reported `brave $0.015`; SQL returned
  `brave / measured / 0.01500000 / qty 3`, and NO `spine` row — the unpriced counter correctly
  drops out of the rollup while still rendering as `—` (not `$0.00`) in the tenant detail.
- **The cron is live, not merely green:** `cost_rollup_monthly.computed_at` was **8 seconds old**
  when read, so `braveBackfill` + `costRollup` are running on the heartbeat.
- `cost_rates` holds exactly the 7 seeded rows, prices matching the seed.

## Still open — operational, not code

1. **Inference reads $0 until monthly invoices are hand-entered** into `infra_costs` (no UI — SQL
   or `upsertInfraCost`). There is no bill to allocate, so the *largest* cost line is currently
   absent by design. The spine counters accumulate regardless, so the split is ready the moment an
   amount is entered. Lightsail / Render / Supabase are the same.
2. **Two things have therefore never run against real data:** the DeepInfra double-count net-out
   and the `est.` markers. Both are unit-tested and the SQL is reviewed, but the first month with a
   real invoice is the one to watch closely.
3. **The phone check for `est.` legibility is blocked on (1)** — with no allocated spend the page
   renders no `est.` markers to judge. That judgment is the whole disclosure decision; do it on the
   first month that has a bill.
4. **The sibling plan is unstarted:**
   `thoughts/shared/plans/2026-07-24-inference-provider-registry-and-switch-readiness.md`
   (provider registry + acceptance suite + switching runbook).

## Traps this shipped with

- **Deploy topology.** Render deploys a **separate repo**, not a GitHub-fork of the `hongyi42` dev
  repo — merging to the dev repo's `main` does **not** move it. Someone must sync that repo first,
  *then* Render → "deploy latest commit" (never "Redeploy", which re-runs the old commit). Missing
  this put an 18-commit-stale build live on the first attempt.
- **Non-monotonic migrations.** The `cost_*` migrations timestamp *before*
  `20260726120000_customers_geocoding`, so a fresh local stack needs
  `npx supabase migration up --include-all` — plain `migration up` refuses out-of-order inserts.
  Production is unaffected (the rows were applied and recorded explicitly). Already bit a teammate;
  recorded in `engineering-memory` §4.
- **Pilot DDL was applied by hand** through the Supabase SQL editor, because the available MCP
  connection is a different account. The `schema_migrations` rows were inserted to match the repo
  filenames, so `db push` will not try to re-run them.

## Local dev notes (still current)

- **Tests only ever run against the local stack** — `testEnvGuard.ts` refuses anything else.
  `npx supabase start`, then `npm test`.
- Use **`npm run gen:types:local`**, NOT `npm run gen:types` — the latter uses `--linked`, which
  points at the **pilot**.
- With `MODEL_PROVIDER=openai` + `INFERENCE_API_KEY` set in `.env`, the 5 live-model tests run
  rather than skip; they use a 120s timeout because **GLM is slower than the Sonnet they were
  written for** and flaked at 30s. A fresh worktree has no `.env`, so they skip there.
- To see the dashboard locally: seed some `cost_events` + an `infra_costs` row, run
  `rollupCosts('YYYY-MM-01')`, start `createHttpServer()` on a port, open `/admin`, paste the token
  from `.env`.
- Test cleanup is **unconditional** (`delete from cost_events`, `delete from infra_costs`) in
  `beforeEach`/`afterEach`. An enumerated provider list went stale once and caused order-dependent
  failures; don't reintroduce one.

## Artifacts

| | |
|---|---|
| Plan (this feature) | `thoughts/shared/plans/2026-07-24-per-tenant-cost-dashboard.md` |
| Research (this feature) | `thoughts/shared/research/2026-07-24-per-tenant-api-cost-tracking.md` |
| Plan (provider switching) | `thoughts/shared/plans/2026-07-24-inference-provider-registry-and-switch-readiness.md` |
| Research (provider switching) | `thoughts/shared/research/2026-07-24-inference-provider-switching.md` |
