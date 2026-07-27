# HANDOFF — per-tenant cost dashboard

**Written 2026-07-27.** Everything a fresh session needs to finish this. Read this
file, then the plan at
[thoughts/shared/plans/2026-07-24-per-tenant-cost-dashboard.md](thoughts/shared/plans/2026-07-24-per-tenant-cost-dashboard.md).

---

## 1. Where things stand in one line

**The feature is built, tested, committed, and pushed. It is NOT deployed.** The
remaining work is a deploy the assistant could not perform (no pilot DB access, no
`gh` CLI, no Render access) — see §6.

```
branch  feature/cost-dashboard
commit  eaff739  "Per-tenant cost ledger + operator dashboard"
pushed  yes, origin/feature/cost-dashboard == eaff739
base    d383f79 (origin/main at time of rebase)
tree    clean
gates   typecheck · lint · build clean · 52 files / 748 tests, 4 consecutive green runs
PR      NOT OPENED — no gh CLI on this machine
```

Open the PR at:
`https://github.com/hongyi42/TradesDatabase/pull/new/feature/cost-dashboard`

---

## 2. What the feature is

Records what every tenant costs in outside-vendor spend (DeepInfra, Anthropic,
Brave, Composio, plus flat monthly infra bills) and shows it on an operator-only
page at `/admin`. Due 2026-08-01.

**The load-bearing rule: `cost_events` stores UNITS, never dollars.** Prices live
in `cost_rates`, versioned by effective date, joined at read time. This is what
lets history re-price when a vendor moves — DeepInfra changed $0.95 → $0.93
*during the three days this was being planned*. Do not "simplify" by storing a
dollar figure on the event.

### Files

| Path | What |
|---|---|
| `supabase/migrations/20260725120000_cost_ledger.sql` | 4 tables + 7 seeded rates |
| `supabase/migrations/20260725130000_cost_rollup_fn.sql` | `rollup_costs(period_start)` |
| `supabase/migrations/20260725140000_cost_tables_rls.sql` | RLS + revoke on the 4 tables |
| `supabase/migrations/20260725150000_tenant_cost_detail_fn.sql` | `tenant_cost_detail(tenant, period)` |
| `src/db/costs.ts` | all accessors + the recorders |
| `src/db/tenants.ts` | `listTenantSeats()` (added) |
| `src/admin/adminApi.ts` | the `/admin` HTTP surface |
| `web/admin/{index.html,admin.css,admin.js}` | the UI, no build step |
| `src/model/forcedTool.ts` | **instrumentation point** — `ledgerVendor()` + usage capture |
| `src/jobs/lifecycle.ts` | two new cron steps (Brave backfill, rollup) |

### Data model

```
cost_events   (units, never $)      cost_rates (prices, versioned by date)
 tenant · provider · sku · qty  ──join at READ time──►  dollars
 method: measured | allocated                              │
infra_costs (monthly bills + allocation rule) ─────────────┘
                       │
                       ▼
              cost_rollup_monthly   ← the ONLY thing /admin reads
```

---

## 3. Decisions already made — do not re-litigate

- **Units, not dollars** (above).
- **Inference cost is ALLOCATED, not measured** (user decision). Agent inference
  runs on trades-box-1 through one gateway with one API key shared by all
  tenants — there is no per-tenant boundary to read. It is split by each
  tenant's MCP tool-call count (`provider='spine'`).
- **Instrument SEAMS, not call sites.** One recorder inside `runForcedTool`
  covers all four spine model calls (classify/extract/brief/answer) and reads the
  *active vendor*. Instrumenting the four callers would bill whatever vendor each
  assumed — which stops being true the moment `MODEL_PROVIDER` or
  `INFERENCE_BASE_URL` changes.
- **Seat tiers are a MIX, never a blended `$/seat`** (user decision). Manager
  seats price higher AND cost more to serve (`engineering-memory` §2), so one
  denominator over their sum describes neither product. `$/seat` was removed.
- **Every figure discloses how it was derived.** `allocated` renders with a
  hatched bar + `est.` tag on the headline total, per-tenant cost, and each line.
  Hatching, not colour alone — colour fails a colour-blind reader.
- **RLS on the four cost tables, no policy.** `/admin` is the system's first
  cross-tenant surface. Without RLS the publishable anon key reads the same data
  straight from PostgREST and the bearer token is decorative.
- **Google Routes is NOT collected in v1.** `optimizeStopOrder`'s deps carry no
  `tenantId` and `cost_events.tenant_id` is `not null`. No `google` seed row
  either — an unseeded vendor is honest; a $0 line reads as "no spend".
- **`spine` gets no rate row.** It is an allocation *counter*, not a vendor. The
  rollup's measured pass INNER joins `cost_rates`, so it drops out naturally.

---

## 4. The five findings that shaped the final code

These were each **reproduced before being fixed**. If you find yourself
"simplifying" one of these, re-read this section first.

**① Double-counting DeepInfra (the big one).** Reproduced:
`$9.30 measured + $100 invoice = $109.30 reported for $100 of real spend.`
There is ONE DeepInfra account. Since PR #81 the spine's model calls bill
DeepInfra *and* the agent invoice is a DeepInfra bill — so the invoice already
**contains** the spine's tokens. `rollup_costs` now nets measured spend out of a
vendor's bill before allocating the remainder, with a `greatest(...,0)` floor.

**② Partial rate coverage under-priced silently.** `count(r.id) = 0` only caught
a *wholly* unpriced SKU. With a rate covering half the month, unmatched events
each contributed `quantity * 0` — full unit count, half the cost, rendered as a
metered fact. Now `count(r.id) <> count(*)` → reports "not priced".

**③ The skip predicate swallowed real faults.** A bare `/does not exist/` also
matches `column cost_events.occurred_at does not exist`. A half-applied migration
would have produced **a green cron and an empty ledger forever** — reading as "no
spend". `isMissingCostLedger` now matches structured codes only
(`42883`/`42P01`/`PGRST202`/`PGRST205`), and the accessors attach the
`PostgrestError` as `cause` so the code survives wrapping.

**④ Allocation hit demo tenants.** 19 tenants each took $7.89 of a $150 bill.
Now restricted to tenants with an active technician or events in the period —
**with a fallback to all tenants when none qualify**, because allocating to
nobody loses the invoice entirely, which is the same silent under-report from the
other direction.

**⑤ `MODEL_SKUS` keyed on wire format.** `openai` is a protocol, not a company.
An NVIDIA failover would have billed as DeepInfra. `ledgerVendor()` in
`forcedTool.ts` now resolves the vendor from the endpoint host.

---

## 5. Verified facts (don't re-derive these)

- **DeepInfra rates are correct and the account is on the STANDARD tier.** The
  API returns its own `estimated_cost` on every reply; it matched the seeded
  rates to **ten decimal places** (`0.00034116` both ways). Priority (1.5×) and
  Flex (0.8×) are both ruled out. This closed the plan's "confirm before Phase 1"
  question.
- **The GLM path works end to end.** Verified live 2026-07-25:
  `prompt_tokens`/`completion_tokens` come back as the collector expects; the
  classifier returned a real boolean `false` (not the string `"false"` — this
  matters, it gates an APPEND-ONLY L1 insert); `laborHours` coerced `2.5` to a
  number; gate code `"0412"` preserved as a string.
- **RLS holds both directions.** `set local role anon`/`authenticated` → `42501`
  on all four cost tables; control assertion proves the probe isn't vacuous;
  service-role unaffected.
- **Migrations apply to a POPULATED database**, not just a fresh `db reset` —
  tested by dropping and re-applying against seeded spine data.
- **`INFERENCE_API_KEY` is set on Render**, so PR #81 is live *provided the
  service redeployed after it merged* — see §7.

---

## 6. WHAT'S LEFT — the deploy

Nothing else. In order:

**1. Open + merge the PR** (link in §1). Standing rule: PR before `main`.

**2. Apply four migrations to the PILOT** (`daqapdlkgxfrhquacprv`), in order,
each as one atomic batch, verifying between:

```
20260725120000_cost_ledger.sql
20260725130000_cost_rollup_fn.sql
20260725140000_cost_tables_rls.sql
20260725150000_tenant_cost_detail_fn.sql
```

then `NOTIFY pgrst, 'reload schema';`

> ⚠ **The assistant could not do this.** The connected Supabase MCP is a
> different account (`bipjpavabqckbauftnrp`, "junyiicc's Project", INACTIVE);
> `daqapdlkgxfrhquacprv` returns *"You do not have permission"*. Either connect
> an MCP with pilot access, or apply via the Supabase dashboard SQL editor.
>
> `.env` DOES hold live pilot credentials (`SUPABASE_URL` →
> `daqapdlkgxfrhquacprv`), so applying over `pg` is technically possible — but it
> bypasses `supabase_migrations.schema_migrations` and worsens the pilot's
> already-drifted ledger (`engineering-memory` §3). If you go that route, insert
> matching `schema_migrations` rows.

**3. Set `ADMIN_DASHBOARD_TOKEN` in the Render WEB service env** — *before*
deploying, or `/admin` answers 503 (fails closed by design). The value is in
local `.env`:

```bash
grep '^ADMIN_DASHBOARD_TOKEN=' .env | cut -d= -f2
```

The cron job does **not** need it.

**4. Render → "deploy latest commit"** — never "Redeploy", which re-runs the OLD
commit. Confirm the live hash includes `eaff739`.

**5. Verify.** `GET /admin/api/costs` with the token → 200; cross-check one
tenant's figure against a direct `SELECT` on `cost_rollup_monthly`. Then watch
one cron tick for `braveBackfill` and `costRollup` in the JSON summary line.

**6. Manual check (yours).** Open `/admin` on a phone: are the `est.` markers
unmistakable at a glance? That judgment is the whole disclosure decision.

### Order matters
Migrations **before** the Render deploy. Reversed gives PostgREST "unknown
column" errors (happened live 2026-07-19). Survivable here — both cron steps
report `{skipped}` when the tables are absent and the spine counter swallows its
own failure — but untidy.

### Migration ordering caveat
Upstream has a **planned** `20260724130000_unplaced_visits.sql` that sorts
*below* these, so landing this first makes the ledger non-monotonic. `db push`
copes; `migration repair` / `db diff` will want care.

---

## 7. Open questions / things to watch

- **Did Render actually redeploy after PR #81 merged?** The key being present
  proves only half of `engineering-memory:184` ("NOT live until Render redeploys
  with `INFERENCE_API_KEY` set"). Check the live commit hash includes `b9c24a4`.
  If not, the spine is still on the old Anthropic plumbing and
  `ANTHROPIC_API_KEY` was flagged invalid on 2026-07-04, never re-verified —
  meaning classify/extract/brief/answer are erroring in production. **The cost
  ledger is correct either way** (`recordModelUsage` reads the active vendor at
  call time), but this would be worth knowing on its own.
- **Cached-token pricing is seeded but unreachable.** DeepInfra returned
  `prompt_tokens_details: null` on a live probe, so no cache figure is reported
  and `glm-5.2-cached-input` never gets written. The collector handles it if the
  field ever appears. Note this matters for the s2 prompt-cache experiment: if
  DeepInfra never reports cached tokens on this endpoint, that trial has no
  direct measurement path.
- **Infra invoices are hand-entered.** Until an `infra_costs` row exists for a
  month, inference shows **$0** — there is no invoice to allocate. The spine
  counters accumulate regardless, so the split is ready the moment the amount is
  entered. Lightsail / Render / Supabase are the same.
- **The measured : allocated ratio is lopsided** (~$6 vs ~$208 in the demo).
  Even with spine calls now metered exactly, agent inference dominates and can
  only be an estimate. Making it exact needs **one gateway per tenant** — the
  open path from `thoughts/shared/research/2026-07-24-inference-provider-switching.md`.
- **The sibling plan is unstarted:**
  `thoughts/shared/plans/2026-07-24-inference-provider-registry-and-switch-readiness.md`
  (provider registry + acceptance suite + switching runbook). It was scoped to
  *readiness only*, stacked behind this one, and needs this deployed first
  because its Phase 2 reads `cost_rates` through `.env`.

---

## 8. Local dev notes

- **Tests only ever run against the local stack** — `testEnvGuard.ts` refuses
  anything else. `npx supabase start`, then `npm test`.
- Use **`npm run gen:types:local`** (added by this branch), NOT `npm run
  gen:types` — the latter uses `--linked`, which points at the **pilot**.
- `.env` currently has `MODEL_PROVIDER=openai` + `INFERENCE_API_KEY` set, so the
  5 live-model tests run rather than skip. They were raised from a 30s to a 120s
  timeout — **GLM is slower than the Sonnet they were written for** and flaked
  intermittently at 30s.
- To see the dashboard locally: seed some `cost_events` + an `infra_costs` row,
  run `rollupCosts('YYYY-MM-01')`, start `createHttpServer()` on a port, open
  `/admin`, paste the token from `.env`.
- Test cleanup is **unconditional** (`delete from cost_events`, `delete from
  infra_costs`) in `beforeEach`/`afterEach`. An enumerated provider list went
  stale once and caused order-dependent failures; don't reintroduce one.

---

## 9. Artifacts

| | |
|---|---|
| Plan (this feature) | `thoughts/shared/plans/2026-07-24-per-tenant-cost-dashboard.md` |
| Research (this feature) | `thoughts/shared/research/2026-07-24-per-tenant-api-cost-tracking.md` |
| Plan (provider switching) | `thoughts/shared/plans/2026-07-24-inference-provider-registry-and-switch-readiness.md` |
| Research (provider switching) | `thoughts/shared/research/2026-07-24-inference-provider-switching.md` |

All four are committed. The plan's phase checkboxes are ticked with the evidence
that was captured at the time; Phase 4's live + manual checks remain unticked
because they need the deploy.
