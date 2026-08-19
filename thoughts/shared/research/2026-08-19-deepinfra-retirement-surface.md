---
date: 2026-08-19
branch: claude/new-session-tjwcgt
commit: 9ca98e3
topic: Retiring DeepInfra as the fleet's inference provider — full surface area, removal depth, and what a no-fallback recovery procedure must cover
---

## Summary

"Inference provider" means the outside company whose computers actually run the AI model
(GLM-5.2) that every technician's and manager's assistant thinks with. Until 2026-08-15 that
company was **DeepInfra**. On that date the project switched to **Fireworks**, which serves the
same model roughly 2.4x faster. The switch was done in the two places that matter *most* — the
Render web service and the Render cron job (together "the spine", the server that holds the
customer database) — but the **box** (`trades-box-1`, the Lightsail machine that runs one chat
sandbox per person) is still routed to DeepInfra. So today the product is split: the spine
talks to Fireworks, the agents talk to DeepInfra.

DeepInfra is therefore not merely "still referenced in some files" — it is **still load-bearing
for every live agent turn**. Retirement is thus two different jobs wearing one name:

1. a **live fleet cutover** (repoint the box from DeepInfra to Fireworks), which is the risky
   part and is the only part that can take agents down; and
2. a **cleanup** of code, price book, billing collector, and documentation, which is nearly all
   low-risk and can happen on either side of the cutover.

The single most important structural finding is that **the fleet's route is not set by hand.** A
script called the *medic* (`nemoclaw-inference-medic.sh`) runs every five minutes on the box and
re-asserts a hardcoded provider/model pair. The deployed copy is pinned to DeepInfra; the copy in
this repo is already pinned to Fireworks. Nothing else needs to change to flip the fleet — the
two files differ **only** in those two lines (repo copy md5 `0921ab1e21d88a4ef38a1da4c044fc0f`,
verified locally today). Installing the repo copy *is* the cutover, and reverting those two lines
*is* the rollback. Any `openshell inference set` typed by hand is undone within five minutes.

The second most important finding is a **live bug in the retirement's own safety net**: the
medic's failure messages tell the operator to "Check the Fireworks account balance (402)".
Fireworks does not fail that way. Its documented suspension mode is **HTTP 412
`PRECONDITION_FAILED`** on hitting a monthly spend cap — which is exactly what took the fleet
down for ~35 minutes on 2026-08-15. The medic's advice is inherited DeepInfra wording pointing
the operator at the wrong symptom, in the one message a person reads while under pressure with
no fallback available.

## Entry Points

| Where the area begins | Path | Line |
|---|---|---|
| The fleet's route, re-asserted every 5 min | `Box_Setup_Stuff/nemoclaw-inference-medic.sh` | 98–99 (`WANT_PROVIDER` / `WANT_MODEL`) |
| The 5-minute cadence | `Box_Setup_Stuff/nemoclaw-inference-medic.timer` | 11–13 (`OnBootSec=3min`, `OnUnitActiveSec=5min`) |
| Failure/success alerting off the box | `Box_Setup_Stuff/nemoclaw-inference-medic.service` | 15–16 (`OnFailure=` / `OnSuccess=`) |
| Provider route at box provision time | `Box_Setup_Stuff/bootstrap-box.sh` | 285–287 (post-onboard route flip) |
| The spine's own model calls | `src/model/forcedTool.ts` | 54–55 (endpoint/model defaults), 239–241 |
| Ledger vendor attribution | `src/model/forcedTool.ts` | 68–81 (`ledgerVendor()`) |
| The DeepInfra bill collector | `src/model/deepinfraUsage.ts` | 96–108 (`billingApiKey()`), 209–262 (`collectDeepinfraUsage`) |
| The cron step that calls it | `src/jobs/lifecycle.ts` | 273–290 (step 6, summary field `deepinfraUsage`) |
| Price book / SKU vocabulary | `src/db/costs.ts` | 124–157 (`MODEL_SKUS`) |
| Seeded rates | `supabase/migrations/20260725120000_cost_ledger.sql` | 162–164 (deepinfra), `20260815120000_fireworks_rates.sql` 20–22 (fireworks) |
| Bill-vs-metered net-out | `supabase/migrations/20260725130000_cost_rollup_fn.sql` | 137–156 (`where e.provider = v_bill.vendor`) |

## Key Files

### The box (the live fleet — the risky half)

- **`Box_Setup_Stuff/nemoclaw-inference-medic.sh`** (252 lines). The route holder and health
  prober. Two gates per tick: a *registration* gate (`openshell inference set`, which
  live-validates endpoint+key and doubles as the switch) and a *completion* gate (a real,
  streamed, tool-carrying chat completion curl'd from inside a running sandbox container as the
  `sandbox` user through `https://inference.local/v1`). Success requires the stream to close
  cleanly **and** come back `finish_reason:"tool_calls"`. **No failover by design (v5,
  2026-08-12)** — on failure it re-asserts the route anyway and exits 1 loudly.
  - Repo copy: `WANT_PROVIDER="fireworks-prod"`, `WANT_MODEL="accounts/fireworks/routers/glm-5p2-fast"`.
  - md5 of the repo copy today: `0921ab1e21d88a4ef38a1da4c044fc0f`.
  - Lines 245 and 247 name **402** as the failure code to check — DeepInfra's shape, not Fireworks'.
  - Lines 100–107 describe `deepinfra-prod` as the deliberate manual rollback and state the
    rollback is "a two-line change".
- **`Box_Setup_Stuff/nemoclaw-inference-medic.{service,timer}`**. `Type=oneshot`, runs as
  `ubuntu`, `ExecStart=/usr/local/sbin/nemoclaw-inference-medic.sh`. The service carries
  `OnFailure=ops-report-medic-down.service` and `OnSuccess=ops-report-medic-ok.service`.
- **`Box_Setup_Stuff/ops-report.sh`** + `ops-report-medic-{down,ok}.service`. Carries the medic's
  verdict off the box to `POST /control/ops` on Render, using the badge-pull host token from
  `/etc/doorman/badge-pull.env`. Always exits 0; stateless. Server side:
  `src/mcp/httpServer.ts:425,480` → `recordOpsEvent` (`src/db/opsEvents.ts:62`), which folds
  repeat reports into a single incident. **Neither file names any provider** — this path is
  provider-agnostic and needs no change.
- **`Box_Setup_Stuff/bootstrap-box.sh`**. Already flips to Fireworks after onboard (lines
  285–287) because `nemoclaw onboard`/`rebuild` resets the gateway to NVIDIA's free tier. Line
  177 is the only DeepInfra mention left: a comment naming `deepinfra-prod / zai-org/GLM-5.2`
  as the rollback.
- **`src/control/inferenceMedicScript.test.ts`**. Executes the real medic script against PATH
  shims for `openshell`/`docker`. Already expects `fireworks-prod` throughout; line 241 asserts
  the medic's output must **not** contain `deepinfra` (a regression guard that the deleted
  failover has not crept back).

### The spine (Render web + cron)

- **`src/model/forcedTool.ts`**. Every spine model call funnels through `runForcedTool`.
  - `DEFAULT_OPENAI_BASE_URL = 'https://api.deepinfra.com/v1/openai'` (line 54) and
    `DEFAULT_OPENAI_MODEL = 'zai-org/GLM-5.2'` (line 55). **These are the live trap**: any
    environment that sets `INFERENCE_API_KEY` (a Fireworks key) but omits `INFERENCE_BASE_URL`
    sends that key to DeepInfra and fails auth.
  - `ledgerVendor()` (68–81) resolves who bills us from the base-URL host:
    `deepinfra.com`→`deepinfra`, `nvidia.com`→`nvidia`, `fireworks.ai`→`fireworks`, anything
    else → the host itself (so an unmapped vendor is reported loudly rather than mis-billed).
    With `INFERENCE_BASE_URL` unset the default makes this return `deepinfra`.
  - `hasModelCredentials()` (86–90) is a **presence** check on `INFERENCE_API_KEY`, not a
    liveness check — a dead key does not skip a step, it makes every call throw.
  - `INFERENCE_CACHE_KEY` (250–259) sends both `prompt_cache_key` and `user`. Comment records
    DeepInfra ignores both, so the var is safe across a rollback.
- **`src/model/deepinfraUsage.ts`** (262 lines). Pulls the monthly bill from
  `https://api.deepinfra.com/payment/usage` into `infra_costs` so the cost dashboard's largest
  line is not silently $0. Notable internals:
  - Amounts arrive in **cents** (`CENTS_PER_USD = 100`), confirmed three ways on 2026-07-27.
  - `ratesLookLikeCents()` is a tripwire against a currency-unit change: at least one line-item
    rate must match a seeded `cost_rates` dollar rate × 100, within 2%.
  - `billingApiKey()` (96–108) returns `DEEPINFRA_BILLING_API_KEY` if set; otherwise falls back
    to `INFERENCE_API_KEY` **only when `INFERENCE_BASE_URL` is empty or a deepinfra.com host**.
    **Consequence: since the cron's `INFERENCE_BASE_URL` was set to Fireworks on 2026-08-17,
    this returns `undefined` unless `DEEPINFRA_BILLING_API_KEY` is separately set — meaning the
    collector is very likely already skipping in production.**
  - Writes vendor `deepinfra`, item `agent inference`, default allocation `per_sandbox`; keyed
    `(vendor, item, period_start)` so an operator's hand-entered row is corrected, not duplicated,
    and an operator's chosen allocation on an existing row is preserved.
- **`src/jobs/lifecycle.ts`**. Step 6 (273–290) gates on `hasBillingKey`, reporting
  `{skipped: 'no DeepInfra billing key configured'}` when absent — a *green* outcome. Runs
  before the rollup so a newly collected figure allocates on the same tick. Summary field name
  `deepinfraUsage` (line 98, 383) is part of the cron's stable JSON contract.
- **`src/db/costs.ts`**. `MODEL_SKUS` (124–157) maps ledger vendor → seeded `(provider, sku)`
  triples: `deepinfra` → `glm-5.2-{input,output,cached-input}`; `nvidia` → the same input/output
  skus at $0; `fireworks` → `glm-5.2-fast-{input,output,cached-input}`; `anthropic` → Sonnet.
  `costs.test.ts` pins this map against the seed. `upsertInfraCost` (327+) is the flat-bill
  writer.
- **`src/admin/adminApi.ts`** (135–137) and **`web/admin/admin.js`** (71–73). Both carry comments
  explaining that `deepinfra` is the vendor that carries *both* metered spine spend and the
  allocated agent invoice, which is why measured and allocated are rendered as two bar segments.
  Neither hardcodes the vendor name — the split is data-driven off `cost_rollup_monthly`.
- **`src/mcp/server.ts:1876`**. The spine tool-call counter that `per_spine_tool_call` allocation
  divides the invoice by; comment names DeepInfra.

### Database

- `supabase/migrations/20260725120000_cost_ledger.sql:162-164` — deepinfra rates
  ($0.93/$3.00/$0.18 per 1M), `effective_from '2026-07-01'`.
- `supabase/migrations/20260806230000_nvidia_failover_rates.sql:29+` — nvidia rows at $0.
- `supabase/migrations/20260815120000_fireworks_rates.sql:20-22` — fireworks fast rates
  ($2.10/$6.60/$0.21 per 1M), `effective_from '2026-08-15'`.
- `supabase/migrations/20260725130000_cost_rollup_fn.sql:137-156` — the net-out: an `infra_costs`
  bill for a vendor has that vendor's already-measured `cost_events` subtracted before allocation
  (`where e.provider = v_bill.vendor`), so one account's invoice is not double-counted. Line 219:
  two bills from one vendor in a month **sum**.
- Stated price-book convention (fireworks migration, line 18): **never edit a rate in place —
  close it with `effective_to` and open a new row.**

### Scripts (developer tooling, not production)

- `scripts/spine-eval/lib/env.mjs:126-127` — still defaults `EVAL_INFERENCE_BASE_URL` to
  DeepInfra and `EVAL_MODEL` to `zai-org/GLM-5.2`.
- `scripts/date-eval/plan.mjs:143` — already defaults `expectedModel` to the Fireworks router id;
  line 166 still estimates spend "at GLM-5.2 DeepInfra rates".
- `scripts/date-eval/run.mjs:149` — parses `Provider: deepinfra-prod`-shaped labels out of agent
  output; line 305 prints "the DeepInfra balance ran out (HTTP 402)" as the most-likely cause.
- `scripts/spine-eval/run-gateway.mjs:290` — same 402/DeepInfra advice.
- `scripts/eval-date-reliability.mjs` — already Fireworks-defaulted (lines 120–121).
- `scripts/spine-eval/run-agent.mjs:87` — DeepInfra rates used for the eval's own cost estimate.
- `scripts/provider-trial/{nebius-bench,provider-bench}.mjs` — DeepInfra is the hardcoded
  *baseline arm* of a benchmark harness; these are historical trial tools.

### Documentation

`docs/engineering-memory.md` (§2 agent model, §3 environments diagram, medic v2/v4/v5 entries),
`docs/control-plane.md` (Render cron inference vars), `docs/onboarding.md:154` (**stale** — still
shows "DeepInfra GLM-5.2 (automatic failover: NVIDIA)", two design generations out of date),
`docs/onboarding.md:309,585`, `docs/customer-onboarding-runbook.md:71` (**DPA named with
DeepInfra as the model provider** — a contractual/privacy artefact, not just prose) and `:264`
(DeepInfra balance advice), `docs/nemoclaw-tech-agent.md:53`, `docs/long-running-task-batching.md:27,30`,
`docs/Physical-Data-Exchange-Direction.md:393,871` (per-seat cost derived off the DeepInfra
dashboard), `HANDOFF.md:21,26,57`, `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:510-527`,
`Box_Setup_Stuff/doorman-architecture-memory.md:134,146,149,185`, `.env.example:13-15,35-36`
(defaults still DeepInfra).

## Data Flows

### Flow 1 — how an agent turn reaches a provider today

```
technician's phone (Telegram DM)
        │
        ▼
 trades-box-1 ── per-person OpenClaw sandbox (s2, s3, s5 …)
        │  agent calls https://inference.local/v1/chat/completions
        ▼
 OpenShell gateway  ── holds the GLOBAL route + the provider credential store
        │  route = (provider, model), set by `openshell inference set -g nemoclaw`
        │  the gateway INJECTS the key; no provider key ever enters a sandbox
        ▼
 DeepInfra  ← TODAY (deployed medic pins deepinfra-prod / zai-org/GLM-5.2)
 Fireworks  ← TARGET (repo medic pins fireworks-prod / accounts/fireworks/routers/glm-5p2-fast)

        ▲
        │ every 5 minutes
 nemoclaw-inference-medic.timer ──► medic.sh
        ├─ gate 1: `openshell inference set` (validates endpoint+key, AND sets the route)
        ├─ gate 2: real streamed tool-call completion from inside a sandbox container
        └─ verdict ──► ops-report.sh ──► POST /control/ops ──► recordOpsEvent (Render/Supabase)
```

The medic is why hand-flipping the route does nothing: it re-asserts `WANT_*` on the next tick.

### Flow 2 — how a spine model call is billed

```
spine tool (record_field_note / brief_customer / answer_customer_question …)
        │
        ▼
 runForcedTool  (src/model/forcedTool.ts:239)
        │  endpoint = INFERENCE_BASE_URL  ?? https://api.deepinfra.com/v1/openai   ← default
        │  model    = INFERENCE_MODEL     ?? zai-org/GLM-5.2                       ← default
        ▼
 provider responds, usage block attached
        │
        ▼
 recordModelUsage (src/db/costs.ts)
        │  vendor = ledgerVendor()  ← derived from the base-URL HOST, not from a config flag
        │  vendor → MODEL_SKUS → (provider, sku) triple
        ▼
 cost_events rows (tenant known — this is METERED spend)
        │
        ▼
 rollup_costs(period) ── measured pass INNER JOINs cost_rates on (provider, sku, date)
                      ── allocated pass: each infra_costs bill, MINUS that vendor's
                         already-measured cost_events, split by its allocation rule
        ▼
 cost_rollup_monthly ──► /admin dashboard (measured bar segment vs allocated bar segment)
```

### Flow 3 — how the agent invoice reaches the ledger

```
Render cron (*/5, heavy sweeps on quarter-hour ticks)
        │
        ▼ step 6
 billingApiKey()  ──►  DEEPINFRA_BILLING_API_KEY, else INFERENCE_API_KEY
                       BUT ONLY IF INFERENCE_BASE_URL is empty or *.deepinfra.com
        │
        ├─ undefined ──► {skipped: 'no DeepInfra billing key configured'}   ← GREEN
        │                (almost certainly the state today: the cron's base URL is Fireworks)
        │
        └─ present ──► GET https://api.deepinfra.com/payment/usage?from=YYYY.MM&to=YYYY.MM
                          │  amounts in CENTS; unit tripwire = ratesLookLikeCents()
                          ▼
                       recordVendorInvoiceAmount → infra_costs
                          (vendor 'deepinfra', item 'agent inference',
                           source 'estimate' while the month is open, 'invoice' once settled)
                          ▼
                       step 7 rollup_costs → allocated share per tenant
```

## External Dependencies

- **DeepInfra** — inference (`https://api.deepinfra.com/v1/openai`) and billing
  (`https://api.deepinfra.com/payment/usage`, note the `/payment/` root, not `/v1/`).
  Documented failure shape: **HTTP 402**, balance exhausted.
- **Fireworks** — inference (`https://api.fireworks.ai/inference/v1`), model
  `accounts/fireworks/routers/glm-5p2-fast`. Documented failure shape: **HTTP 412
  `PRECONDITION_FAILED`**, monthly spend cap hit → account suspended (engineering-memory,
  2026-08-15). Fireworks **does** publish a billing API — `GET
  /v1/accounts/{account_id}/billingUsage`, bearer-authenticated, ≤31-day windows, with a
  companion `GetBillingSummary` for rated dollar totals
  ([docs.fireworks.ai/api-reference/get-billing-usage](https://docs.fireworks.ai/api-reference/get-billing-usage),
  [docs.fireworks.ai/accounts/exporting-usage-and-costs](https://docs.fireworks.ai/accounts/exporting-usage-and-costs)).
  Note this is a *different shape* from DeepInfra's single `/payment/usage` months array — it is
  not a base-URL swap in `deepinfraUsage.ts`.
- **NVIDIA** (`integrate.api.nvidia.com`) — the deleted failover; still a registered provider on
  the box and still seeded at $0 in the price book. Out of scope but adjacent.
- **Nebius** (`nebius-trial`) — registered on the box from the 2026-08-14 trial. Out of scope.
- **OpenShell / NemoClaw** — the gateway and sandbox runtime; `openshell inference set|get`,
  `openshell provider list|get|update`.
- **Render** — web service and cron job, each with its own Environment tab.
- **Supabase** — `cost_events`, `cost_rates`, `infra_costs`, `cost_rollup_monthly`, `ops_events`.

## Constraints and Invariants

1. **The medic owns the route.** Any hand-run `openshell inference set` is reverted within five
   minutes. To change the route you change the deployed script (or stop the timer) first.
2. **Two files, two lines.** The deployed medic and the repo medic differ only in `WANT_PROVIDER`
   / `WANT_MODEL`. Repo md5 today: `0921ab1e21d88a4ef38a1da4c044fc0f`.
3. **`sudo md5sum` on the exact `ExecStart` path.** The medic files are mode 700 root; a plain
   `md5sum` fails in a way that reads as "not installed", and a sibling copy proves nothing.
4. **No failover exists, deliberately** (medic v5, 2026-08-12). The medic asserts and reports; it
   does not reroute. `src/control/inferenceMedicScript.test.ts:241` actively asserts the medic
   never mentions `deepinfra`, guarding against a failover creeping back.
5. **The route is re-asserted even when the probe fails**, so a provider recovery is picked up by
   live turns immediately rather than at the next tick.
6. **`nemoclaw onboard` / `rebuild` resets the gateway route** to NVIDIA's free tier. The medic
   and `bootstrap-box.sh:285-287` both exist to heal that drift.
7. **`nemoclaw list` shows the onboarding record, not the live route.** Authoritative:
   `openshell inference get`.
8. **Model id spelling differs per provider**: DeepInfra `zai-org/GLM-5.2`, NVIDIA
   `z-ai/glm-5.2`, Fireworks `accounts/fireworks/routers/glm-5p2-fast`.
9. **Failure codes are not portable.** DeepInfra 402 (balance) vs Fireworks 412 (spend-cap
   suspension). The deployed/repo medic's own operator advice (lines 245, 247) still says 402.
10. **`INFERENCE_BASE_URL` is load-bearing in three separate ways**: it selects the endpoint, it
    determines `ledgerVendor()` (and therefore which price rows a call is billed against), and it
    gates `billingApiKey()`'s fallback. Omitting it silently reverts all three to DeepInfra.
11. **`MODEL_PROVIDER` is a selector, not a key field** — only the literal `anthropic` changes
    anything. A key pasted there does nothing.
12. **`hasModelCredentials()` is presence, not liveness.** A suspended key does not skip a step;
    it makes every call fail. Present-but-dead is worse than absent.
13. **Price-book rule: never edit a rate in place** — close with `effective_to`, open a new row.
    Historical rollups price each event at the rate in force on its own day, so deleting
    `deepinfra` rate rows would retroactively change or drop July/August history.
14. **The rollup's measured pass INNER JOINs `cost_rates`** — an event whose `(provider, sku)` is
    not seeded is dropped from the dashboard silently.
15. **Bill net-out keys on vendor equality** (`e.provider = v_bill.vendor`). A Fireworks invoice
    nets against Fireworks-measured events only; it will not net against DeepInfra history, which
    is correct.
16. **A Render cron env change reaches scheduled runs only after a deploy.** Trigger Run uses
    current env, so a manual test passes while the schedule stays stale.
17. **Render deploys from the fork `Yu-C1/TradesDatabase`**, not from origin.
18. **`ops-report.sh` always exits 0** and runs in separate units, so alerting can never break the
    medic. It names no provider.
19. **Tests run only against the local Supabase stack**; the hosted "test" project is the pilot's
    live database.
20. **Never `openclaw config patch`** (downs the gateway); never health-check via
    `nemoclaw <n> agent` (injects into a live person's session).
21. `src/model/deepinfraUsage.ts` is imported by `src/jobs/lifecycle.ts` only; its
    `CollectResult` type is part of the exported `LifecycleSummary` shape
    (`src/jobs/lifecycle.ts:98`).

## Decision Points

Stated factually; each is a genuine fork with different blast radius.

**A. Cutover mechanism for the fleet.** The route can be flipped either by installing the repo's
medic (`sudo install` to `/usr/local/sbin/`, then let the timer tick or run the unit once), or by
stopping the timer and running `openshell inference set` by hand. Installing the script makes the
new route self-healing immediately and makes the rollback "revert two lines + reinstall". Hand-
setting leaves the deployed script still pinned to DeepInfra, so the route reverts on the next
tick unless the timer stays stopped. The 2026-08-15 rollback that worked went the other way
round: stop the timer *first*, then set.

**B. How deep the removal goes on the box.** Three separable levels, ascending in
irreversibility:
- *Route only* — the fleet serves Fireworks; `deepinfra-prod` stays registered in the gateway
  with its credential. Rolling back is one `inference set` plus the two-line revert.
- *Deregister the provider* — `deepinfra-prod` removed from `openshell provider list`. Rolling
  back then requires re-registering the provider **and re-entering a DeepInfra API key**, which
  the operator must still possess. `nvidia-prod` and `nebius-trial` sit in the same registry and
  are explicitly out of scope.
- *Revoke/delete the DeepInfra API key at the vendor* — terminal. Note the billing API (below)
  reads the same account, so revoking the key also ends any ability to pull historical bills.

**C. Whether the spine's DeepInfra defaults stay.** `DEFAULT_OPENAI_BASE_URL` /
`DEFAULT_OPENAI_MODEL` in `src/model/forcedTool.ts:54-55` currently make DeepInfra the
fall-through for any environment missing `INFERENCE_BASE_URL`. Options as the code stands:
leave them (a rollback needs no code change, but a mis-provisioned env silently points a
Fireworks key at DeepInfra); repoint them to Fireworks (a mis-provisioned env then fails
*correctly*, and `ledgerVendor()`'s default becomes `fireworks`, but the DeepInfra rollback then
needs both env vars set explicitly); or remove the defaults so a missing `INFERENCE_BASE_URL`
throws (loudest, and changes behaviour for every local checkout and eval script that relies on
the default today, including `scripts/spine-eval/lib/env.mjs:126`).

**D. What happens to the `deepinfraUsage` cron step.** Four distinct positions, and the choice
interacts with C:
- *Leave it* — it already reports `{skipped: 'no DeepInfra billing key configured'}` because the
  cron's `INFERENCE_BASE_URL` is Fireworks. Costs nothing, but the cron's JSON keeps a field
  named for a retired vendor, and a future `DEEPINFRA_BILLING_API_KEY` would silently re-enable it.
- *Keep it deliberately alive until the final DeepInfra invoice settles* — DeepInfra reports a
  month as `estimate` until `invoice_id` appears, so August's DeepInfra spend (1st→cutover) is
  not final on cutover day. Keeping it requires `DEEPINFRA_BILLING_API_KEY` to be set explicitly
  (the `INFERENCE_API_KEY` fallback no longer resolves) and the DeepInfra key to remain valid.
- *Remove the step and the module* — deletes `src/model/deepinfraUsage.ts`, its test, the
  `deepinfraUsage` field from `LifecycleSummary`, and the step from `lifecycle.ts`. Existing
  `infra_costs` rows are untouched (this is a collector, not the store). The final month's figure
  would then need hand-entry via `upsertInfraCost` if it settles after removal.
- *Replace it with a Fireworks collector* — Fireworks publishes
  `GET /v1/accounts/{account_id}/billingUsage` plus `GetBillingSummary`. This is not a URL swap:
  different response shape, an `account_id` path segment, a ≤31-day window constraint, and a
  different settled/open signal from DeepInfra's `invoice_id`/`INVALID`. Without some collector,
  the largest line on the cost dashboard renders $0 for Fireworks, which reads as "no spend"
  rather than "nobody entered the bill" — the exact failure `deepinfraUsage.ts`'s header says it
  exists to prevent.

**E. What happens to DeepInfra's cost history.** `cost_events` (metered spine spend) and
`infra_costs` (the monthly agent invoice) hold July–August DeepInfra spend; `cost_rates` holds the
prices those rows are joined against. Because the rollup prices each event at the rate in force
on its own day and INNER JOINs `cost_rates`, options are: leave the rate rows open (history
renders unchanged, and the price book claims a DeepInfra price is still current); close them with
`effective_to` at the cutover date (history before that date still prices correctly, and the book
stops asserting a live price); or delete the rows (July/August DeepInfra events drop out of the
dashboard silently — this is the only option that destroys history). `MODEL_SKUS.deepinfra` must
survive in whatever form keeps the rollup and `costs.test.ts` consistent with the seed.

**F. Where the recovery procedure lives.** Candidates that already exist:
`docs/engineering-memory.md` (the institutional-knowledge file, but 2,274 lines and organised by
theme, not by emergency), `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` (box-side, operator-
facing), `docs/doorman-runbook.md` (host-side runbook), `docs/control-plane.md`, or a new
dedicated file. The stated requirement is that it be executable under pressure by someone who is
not the author; the medic's own failure message is the other place an operator will be looking,
and it currently gives DeepInfra-shaped advice (402) for a Fireworks-shaped failure (412).

**G. What "recovery" means once DeepInfra is gone.** The 5-minute escape hatch used on 2026-08-15
was "roll back to a warm second provider". After this task that hatch does not exist, so the
recovery procedure has to be built out of what remains, and the code offers three different
materials: raising the Fireworks spend cap at the vendor (the actual 2026-08-15 fix, and the only
one that addresses a 412); `MODEL_PROVIDER=anthropic` (still fully wired — `MODEL_SKUS.anthropic`
is seeded and `forcedTool.ts` keeps the Anthropic path, but note this covers the **spine only**;
the box's gateway route is a separate mechanism with no Anthropic path in the medic); and
re-registering a provider on the gateway from scratch. These have very different recovery times
and the procedure has to say which applies to which failure.

**H. The eval and provider-trial scripts.** `scripts/spine-eval/lib/env.mjs:126-127` still
defaults to DeepInfra, so a spine-eval run today benchmarks the retired provider unless
`EVAL_INFERENCE_BASE_URL` is passed. `scripts/provider-trial/*` use DeepInfra as a hardcoded
benchmark *baseline arm* — they are historical trial harnesses rather than production paths, so
they are separable from the rest of the cleanup.

## Open Questions

Resolvable only by running something on the box or reading a live log — this container has no
`ssh` client, so each of these needs an operator one-liner.

1. **Is the deployed medic still on DeepInfra?** `sudo md5sum /usr/local/sbin/nemoclaw-inference-medic.sh`
   (expect `43cba3c92910406b54069f6793cc1314` if unchanged; `0921ab1e21d88a4ef38a1da4c044fc0f` would
   mean it is already the repo copy) and `openshell inference get -g nemoclaw`.
2. **Is `deepinfra-prod` still registered, and what else is?** `openshell provider list -g nemoclaw`
   — confirms `fireworks-prod` (1 credential, 1 config key) and what `nvidia-prod` /
   `nebius-trial` / `s*-telegram-bridge` look like today.
3. **Does the box's `fireworks-prod` credential actually work?** It has not been exercised since
   the 2026-08-15 suspension. Only the medic's completion gate proves it, and its first run is a
   live test.
4. **Is the medic timer running and what is it reporting?**
   `systemctl status nemoclaw-inference-medic.timer` and
   `journalctl -u nemoclaw-inference-medic.service -n 30`.
5. **Is `DEEPINFRA_BILLING_API_KEY` set on the Render cron?** Determines whether step 6 is already
   skipping. Diagnose from a **scheduled** run's log line (`"deepinfraUsage":{…}`), never from the
   dashboard field or a Trigger Run.
6. **What does the Render web service's Environment tab hold?** The cron's inference vars are
   documented (control-plane.md); the web service's are asserted to be Fireworks but not recorded
   variable-by-variable anywhere in this repo.
7. **Is there DeepInfra spend in August that has not settled?** Determines whether the bill
   collector still has work to do. `infra_costs` rows for `('deepinfra','agent inference')` with
   `source='estimate'` would show it.
8. **What is the Fireworks account's current monthly spend cap and headroom?** The 412 that took
   the fleet down was a cap, not a balance; with no rollback lane this is now the single most
   likely cause of a total outage.
9. **Does the Fireworks billing API expose the settled/open distinction** that
   `deepinfraUsage.ts` models via `invoice_id`? Needs reading against the live endpoint with the
   real account id before any collector is designed.
10. **Do the pilot's technicians have any live session mid-flight?** Bears on when the flip window
    can be, not on what to change.
