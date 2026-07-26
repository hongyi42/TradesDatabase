---
date: 2026-07-24
task: Per-tenant API cost ledger + internal operator dashboard (due 2026-08-01)
research: thoughts/shared/research/2026-07-24-per-tenant-api-cost-tracking.md
status: draft (revised after adversarial review)
note: re-derived at HEAD 5bb7981 after main advanced 29 commits from the e03eb12 baseline the first pass used; the superseded 2026-07-21 drafts were discarded uncommitted.
---

## Overview

Record what every tenant costs us in outside-vendor spend, and show it on an operator-only web
page. Ships the ledger, the price book, the collectors, a cron-computed rollup, and the UI. Lands
**and deploys** before the provider-switching plan, which joins the `cost_rates` vocabulary pinned
in Phase 1.

## Decisions

- **Units, not dollars** — `cost_events` stores quantities; `cost_rates` holds prices versioned by
  effective date, joined at read time. **Vindicated during research:** DeepInfra's input price moved
  $0.95 → $0.93 in three days and a third tier appeared. A stored dollar figure goes stale faster
  than this project's own planning cycle.
- **Inference cost = allocated, not measured** (user decision) — split the DeepInfra invoice ∝ MCP
  tool calls. Routing is gateway-scoped, so no per-tenant provider split exists to read.
- **Proxy metric = MCP tool calls** (user decision), counted in `dispatch` — now 35 tools.
  Disclosed limitation: counts invocations, not tokens; misses turns that call no tool.
- **Instrument Anthropic at the SEAM, not at call sites** *(review finding 1)*. All four
  `messages.create` callers share one shape, so `recordAnthropicUsage` inside each `sonnet*`
  function catches **every** caller automatically. This matters because the billing paths are not
  what the first draft assumed: `recordFieldNote` bills via the **inbound email webhook**
  (`webhook.ts:252`) and `email/ingest.ts:111`, not only the MCP staging call.
- **Composio has FOUR billable sites, not one** *(review finding 2)* — the relay
  (`relayHandler.ts:185`), **`outbound.ts:48` (`GMAIL_SEND_EMAIL`)**, and **`pairing.ts:155`
  (`GMAIL_GET_PROFILE`, on the cron)**. The last two are `client.tools.execute` calls that **never
  traverse the doorman relay**, so a relay-only collector would miss real billed units entirely.
- **`logIngest`'s own API reads are NOT collected** *(review finding 3, decided)* — `logIngest.ts:81`
  and `:106` fetch Composio's execution-log endpoint. Composio bills *tool calls*; log reads are
  plain API traffic against the plan's quota, not tool executions. Recording the decision rather
  than leaving it silent.
- **Google Routes is NOT collected in v1** *(reverted — review findings 4 + 8)*. The earlier
  reversal ("the seam exists, so it's cheap") was wrong: `optimizeStopOrder`'s deps carry no
  `tenantId` (`fit.ts:498`, `googleRoutes.ts:59`), and `cost_events.tenant_id` is `not null`, so the
  collector literally cannot write without threading tenant context through the `find_slots` hot
  path. There is also no cited per-request price. **No `google` seed row** — an unseeded vendor is
  honest; a $0 line reads as "no spend" rather than "not measured".
- **`spine` gets no `cost_rates` row** *(review finding 9)* — it is an allocation *counter*, not a
  vendor. The rollup's measured pass INNER joins `cost_rates` (so spine drops out naturally) and the
  allocation pass reads spine counts directly.
- **`method` on every row** — `measured` | `allocated`, surfaced in the UI.
- **Rollup computed in Postgres** — PostgREST silently caps reads at 1000 rows.
- **`/admin` on the existing web service** (user decision) — mounted before the IP allowlist
  (`httpServer.ts:290`), bearer token + constant-time compare. First cross-tenant surface.
- **Injectable recorder everywhere** — including inside `recordAnthropicUsage` itself, so it is
  unit-testable **without a live API key** *(review finding 6)*: the four `sonnet*` functions all
  require `ANTHROPIC_API_KEY` and their sibling tests are `describe.skipIf(!ANTHROPIC_API_KEY)`, so
  a key-gated test would silently skip and pass on CI while broken.
- **Migration numbered `20260724120000`** — four migrations dated 07-22/07-23 are already applied to
  the pilot (commit 4656866); an earlier number lands out of order in an already-drifted ledger.

## Plain-language walkthrough

**Phase 1 — the ledger.** Four tables. `cost_events` records *what happened* in units, tagged with
the tenant. `cost_rates` records *what a unit costs*, with start and end dates, so a price change is
a new row rather than an edit. `infra_costs` holds flat monthly bills — including the DeepInfra
invoice — plus a rule for splitting them. `cost_rollup_monthly` is what the dashboard reads.

```
 cost_events (units, never $)          cost_rates (prices, versioned)
 tenant · provider · sku · quantity ──join at READ time──► dollars
 method: measured | allocated                                │
 infra_costs (monthly $ + allocation rule) ──────────────────┘
```

**Phase 2 — the collectors.** One shared helper instruments all four Anthropic features (note
extraction, email classification, briefings, Q&A) by wrapping the model response where it is
produced — so every path that reaches them is counted, including the inbound-email one. Composio
gets counters at all three of its billed sites. Brave backfills from `web_requests`. Spine tool
calls get a counter that becomes the inference allocation basis. Every write is failure-isolated.

**Phase 3 — the rollup.** A Postgres function prices each event at the rate in force *on the day it
happened*, splits the monthly bills, and writes per-tenant totals — called from the existing
15-minute cron.

**Phase 4 — the page.** Plain HTML/CSS/JS at `/admin/costs`, same no-build-step pattern as the
board. Total burn, split by vendor, per-tenant cost with a **cost-per-seat** column. Estimates
visibly marked.

## Facts to confirm before Phase 1

- **Which DeepInfra tier is the pilot on?** Standard / Priority (1.5×) / Flex (0.8×). On the
  DeepInfra dashboard; recorded nowhere in this repo. Changes every inference figure by up to 1.9×.
  Phase 1 seeds Standard — correct the seed if it differs.

## Secrets & env preflight

- **Phase 1:** none
- **Phase 2:** `ANTHROPIC_API_KEY` (`.env.example:22`, already required), `COMPOSIO_API_KEY`
  (`.env.example:58`, already required), `BRAVE_API_KEY` — **absent from `.env.example`**; add the
  name. Note: `engineering-memory` §4 lists Render's `ANTHROPIC_API_KEY` as possibly invalid since
  2026-07-04 — if still invalid, all four Anthropic surfaces error rather than bill.
- **Phase 3:** none
- **Phase 4:** `ADMIN_DASHBOARD_TOKEN` — **new**; `openssl rand -hex 32`, set in `.env` and in the
  Render web env **before** deploy or the route answers 503. Optional `ADMIN_STATIC_DIR`.

---

## Phase 1: Cost ledger schema + typed DB layer

### What this phase does
Adds four tables, seeds the price book, exposes typed accessors.

### Changes required

**`supabase/migrations/20260725120000_cost_ledger.sql`** (new)
- `cost_rates(id, provider, sku, unit, unit_cost_usd numeric not null check >= 0, effective_from
  date not null, effective_to date, source_url, created_at)`. Partial unique index on
  `(provider, sku) where effective_to is null`, plus a **`daterange` exclusion constraint** on
  `(provider, sku)` so two rates cannot cover the same day (`btree_gist` already installed by
  `20260704210155`).
- `cost_events(id, tenant_id uuid not null references tenants(id) on delete cascade, technician_ref,
  provider not null, sku not null, quantity numeric not null, unit not null, method not null check
  in ('measured','allocated'), occurred_at timestamptz default now(), source_ref, metadata jsonb,
  created_at)`. Index `(tenant_id, provider, occurred_at)`. **Plain (non-partial) unique constraint
  `(provider, sku, source_ref)`** — NOT `where source_ref is not null`: PostgREST's upsert emits
  `ON CONFLICT (cols) DO NOTHING` with no WHERE clause and cannot infer a partial index. Postgres
  treats NULLs as distinct, so source_ref-less rows still insert freely. `sku` is in the key because
  the Anthropic recorder writes two rows per message id.
- `infra_costs(...)` with `allocation in ('per_active_seat','per_sandbox','per_tenant_equal',
  'per_spine_tool_call','unallocated')`, `source in ('invoice','estimate')`, and
  `unique (vendor, item, period_start)` as the upsert conflict target.
- `cost_rollup_monthly(tenant_id, period_start, provider, method, cost_usd, quantity, computed_at,
  primary key (tenant_id, period_start, provider, method))`.
- Seed `cost_rates`, `source_url` on every row, `effective_from '2026-07-01'` (earliest real data is
  `web_requests`, from 2026-07-13). **Seven rows**: deepinfra `glm-5.2-input` **0.00000093** /
  `-output` 0.0000030 / `-cached-input` 0.00000018; anthropic `claude-sonnet-4-6-input` 0.0000030 /
  `-output` 0.000015; brave `search` 0.005; composio `tool_call` 0.000299. Cost of **one** unit —
  numeric is exact-precision. **No `spine` row** (a counter, not a vendor) and **no `google` row**.
  **These literal `(provider, sku)` strings are the vocabulary the provider plan joins to.**

**`src/db/costs.ts`** (new) — `appendCostEvents(rows)` (batched upsert, `onConflict:
'provider,sku,source_ref', ignoreDuplicates: true`), `listCurrentRates()`, `upsertInfraCost(row)`,
`readRollup(periodStart)`. `rollupCosts` and `backfillBraveCostEvents` arrive in Phases 3 and 2 —
each needs something that does not exist yet, and every phase must end in a working state.

**`src/db/index.ts`** — add `export * from './costs.js';` after `webRequests.js` (line 19).

**`package.json`** — add `"gen:types:local": "mkdir -p src/db && npx supabase gen types typescript --local > src/db/database.types.ts"` (keeping the `mkdir -p` the existing script carries). The
existing `gen:types` (:18) uses `--linked`, which targets the **pilot** and would regenerate types
*without* these tables, breaking `typecheck`. Phases 1–3 use the local variant.

### Automated verification
- [x] `npx supabase db reset` applies the migration on the local stack
- [x] `npm run gen:types:local` — diff shows **only** the four new tables added (166 insertions, 0
      deletions: `cost_events`, `cost_rates`, `cost_rollup_monthly`, `infra_costs`)
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (50 files, **632 tests**)
- [x] new `src/db/costs.test.ts` (13 tests): write-side tenant attribution; the partial unique index
      rejects a second open-ended rate for one SKU; the daterange exclusion rejects two overlapping
      rates; a rate closed on its successor's opening date **is accepted** (half-open boundary);
      `method` outside the enum is rejected; two rows sharing a `source_ref` but differing in `sku`
      both insert, and a replay of either is ignored; source_ref-less rows are never deduped; the
      seeded prices and units are pinned by value; `infra_costs` corrections don't duplicate or
      stick to `estimate`; a batch mixing dated and undated rows inserts every row

### Live verification (agent-executable)
- Prerequisites: local Supabase stack only. **No pilot writes.**
- [ ] none — schema-local; pilot DDL is Phase 4

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 2: Collectors

### What this phase does
Writes `cost_events` from every billable surface, each failure-isolated and unit-testable.

### Changes required

**`src/db/costs.ts`** — add:
- `recordAnthropicUsage(usage, ctx, model, deps?)` — takes a `messages.create` response's `usage`,
  appends two events (`anthropic`/`<model>-input` and `-output`, `method:'measured'`,
  `source_ref = message.id`). `try/catch`-isolated internally. **`deps.append` is injectable** so it
  is unit-testable against a synthetic `usage` object with no API key *(finding 6)*.
- `recordComposioCall(tenantId, technicianRef, deps?)` — one `composio`/`tool_call` event.
- `backfillBraveCostEvents(sinceIso)` — selects `web_requests` rows with `kind='search'` only
  (`search_result` is one row per returned URL, not per charge), **paginated** per
  [foldImpact.ts:35](../../../src/db/foldImpact.ts#L35).

**The four Anthropic seams** — each gains an optional trailing context parameter and calls
`recordAnthropicUsage` after `messages.create`. Verified: every existing stub takes ≤ the declared
arity, so all stay assignable. **`typecheck` is the only real gate on this.**

| File | Seam type | Impl | Reached from |
|---|---|---|---|
| [extract.ts](../../../src/writePath/extract.ts) | `Extractor` :28 | `sonnetExtractor` :73 | `recordFieldNote` :77 **and** `server.ts:1365` |
| [classify.ts](../../../src/email/classify.ts) | `WorkClassifier` :15 | `sonnetClassifier` :39 | `webhook.ts:220`, `email/ingest.ts:81` |
| [briefCustomer.ts](../../../src/synthesis/briefCustomer.ts) | `Briefer` :17 | `sonnetBriefer` :57 | `brief_customer` |
| [answerQuestion.ts](../../../src/synthesis/answerQuestion.ts) | `Answerer` :11 | `sonnetAnswerer` :49 | `answer_customer_question` |

**`src/writePath/recordFieldNote.ts`** *(finding 1 — a real production billing path the first draft
missed)* — pass `{ tenantId, technicianRef }` to `extract(...)` at **:77**. Both are already
destructured from `input` at **:78**. This covers the inbound-email path (`webhook.ts:252`) and
`email/ingest.ts:111`, neither of which passes a `deps.extract`. The MCP commit path at
`server.ts:1543` injects a replay stub that makes no model call and must stay uninstrumented.

**`src/composio/relayHandler.ts`** — record next to `deps.forward(...)` at **:185**, gated on `POST`
with a parsed body whose `method === 'tools/call'`. **`let parsed` is declared at :144 INSIDE the
`if (rawBody.length > 0)` block opened at :143 and is not in scope at :185** *(finding 5)* — hoist
the declaration above the block. Add `recordCost?` to `RelayDeps` (:28).

**`src/composio/outbound.ts:48`** and **`src/composio/pairing.ts:155`** *(finding 2)* — record one
`composio`/`tool_call` event at each `client.tools.execute` call. **Neither traverses the relay**, so
without these the Composio line misses every agent-sent email and every cron pairing check. Tenant
comes from `tech.tenant_id` in scope at both.

**`src/mcp/server.ts`** — in `dispatch` (**:1285**), after `activeManager` (**:1309**), append one
`spine`/`tool_call` event. Add `recordCost?: typeof appendCostEvents` to `ServerDeps` (**:166**).

**`.env.example`** — add `BRAVE_API_KEY`.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (50 files, **654 tests**, +22)
- [x] new test: `recordAnthropicUsage` writes two correctly-shaped events from a **synthetic** usage
      object via an injected appender — **no API key required**, so it cannot silently skip on CI
- [x] new test: an injected rejecting recorder leaves `dispatch`, the relay, `outbound`, and
      `pairing` all returning their normal results (`recordFieldNote` is covered through the
      extractor seam, whose recorder swallows internally and is pinned directly)
- [x] new test: the relay writes **no** event for `initialize`, `tools/list`, or a `GET`, and exactly
      one for a `tools/call` POST — plus none on the early-return paths that never reach Composio
- [x] new test: `backfillBraveCostEvents` is idempotent across two runs and paginates past 1000 rows
      (seed 1050; returns `{scanned}`, since the upsert ignores duplicates)
- [x] new test: `dispatch` writes exactly one spine event per tool call, tagged with the tenant —
      and a **refused** call still counts
- [x] added beyond the plan: the classifier's cost context is pinned in `webhook.test.ts`
      (empirically verified to fail when the ctx argument is removed); `outbound`/`pairing` cost
      metering; a missing `usage` block is reported rather than silently skipped

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; real `ANTHROPIC_API_KEY`.
- [x] Drove both production billing paths (`sonnetClassifier` direct, and `recordFieldNote` with no
      `deps.extract` — exactly how `webhook.ts:252` and `email/ingest.ts:111` call it) and read the
      ledger back over **raw pg**, an independent channel from the typed layer that wrote it:
      ```
      anthropic/claude-sonnet-4-6-input     816 token measured src=msg_011CdNJ2GWvJ4k9t8jqRxjkv
      anthropic/claude-sonnet-4-6-input    1100 token measured src=msg_011CdNJ2RWAYLEseRnaVKUJQ
      anthropic/claude-sonnet-4-6-output     74 token measured src=msg_011CdNJ2GWvJ4k9t8jqRxjkv
      anthropic/claude-sonnet-4-6-output    168 token measured src=msg_011CdNJ2RWAYLEseRnaVKUJQ
      ```
      Two calls, two distinct message ids, four rows, all attributed. **This is the only check that
      proves the live SDK response carries `usage.input_tokens`/`output_tokens` where the code reads
      them** — every unit test uses a synthetic usage object. Measured cost of the probe: ~$0.0094.

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 3: Rollup + cron wiring

### What this phase does
Aggregates events × rates and allocates monthly bills, hung off the existing lifecycle cron.

### Changes required

**`supabase/migrations/20260725130000_cost_rollup_fn.sql`** (new)
- `rollup_costs(period_start date)`: **INNER** joins `cost_events` to `cost_rates` on
  `(occurred_at at time zone 'utc')::date >= effective_from and < coalesce(effective_to,'infinity')`
  — half-open, not `between`, or a rate closed on its successor's opening date double-counts.
  **Cast explicitly, not with a bare `occurred_at::date`** *(Phase 1 review)*: `occurred_at` is
  `timestamptz` while the rate columns are `date`, so a bare cast resolves against the session
  `TimeZone` GUC and would shift both the rate boundary and the monthly bucket by hours if a session
  ever ran non-UTC. The inner join is what
  keeps `spine` (a counter with no rate) out of the measured pass *(finding 9)*. Groups by
  `(tenant_id, provider, method)`, upserts `cost_rollup_monthly`.
- Second pass: every `infra_costs` row in the period distributed by its own `allocation` —
  `per_spine_tool_call` splits ∝ each tenant's `provider='spine'` event count, written as
  `method='allocated'`. **Zero-denominator guard:** no spine events in the period → fall back to
  `per_tenant_equal`.

**`src/db/costs.ts`** — `rollupCosts()` wraps the RPC (all DB access goes through `src/db/`).
Regenerate types with `npm run gen:types:local` so `Functions` is no longer `never`.

**`src/jobs/lifecycle.ts`** — add two isolated steps (Brave backfill; rollup). Extend
`LifecycleSummary` (**:31**) and `LifecycleDeps` (**:23–29**). **Update all 11 `runLifecycle(...)`
call sites in `src/jobs/lifecycle.test.ts` to inject the two new deps** *(finding 7)* — that file's
header declares it pure unit tests, and an uninjected step would fall through to real DB accessors.
**Both steps must report `{ skipped: … }`, not `stepError`, when the relation or function does not
exist**: `main()` exits 1 on `ok:false` and Render marks the run failed, so between this phase's
merge and Phase 4's pilot migration the cron would alarm every 15 minutes.

**`docs/control-plane.md`** — document both new steps in the heartbeat section.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (50 files, **672 tests**, +18)
- [x] new test: two tenants with known counts and rates produce **hand-computed dollar totals**
- [x] new test: a rate closed on exactly the date its successor opens prices each event once
- [x] new test: `spine` events contribute **no** measured cost row (inner join holds) but **do**
      drive the allocation split
- [x] new test: allocation with zero spine events falls back to equal split
- [x] new test: a missing rollup function yields `{skipped}` and `ok:true`; a genuine throw yields
      `stepError` and `ok:false`, with the other four steps' results intact
- [x] existing `lifecycle.test.ts` still makes no network/DB calls (all **14** call sites inject
      `COST_STUBS`; the plan estimated 11 before three gating tests were added)
- [x] added after review: previous-month rollup (incl. a year-boundary case); watermarked backfill
      (empty-ledger and resume cases); `unpricedEvents` surfacing; mid-month `period_start`
      rejection; no `$0.00` rows for idle tenants; `isMissingCostLedger` pinned in **both**
      directions (recognises not-migrated shapes, does **not** swallow real faults)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [x] Seeded a period with measured + allocated events, ran the real RPC, read
      `cost_rollup_monthly` back over **raw pg**:
      ```
      rollupCosts -> {"rowsWritten":4,"tenantsTouched":2,"unpricedEvents":1}
        Default Tenant   anthropic       measured   $  6.0000   (2M x $0.000003)
        Default Tenant   lv2-deepinfra   allocated  $120.0000   (60% of $200)
        lv2-b            brave           measured   $  2.0000   (400 x $0.005)
        lv2-b            lv2-deepinfra   allocated  $ 80.0000   (40% of $200)
      ```
      Every figure matches the hand-computed value; `spine` produced no priced row; the one
      deliberately-unseeded sku was reported rather than vanishing.
- [x] Concurrency: five simultaneous `rollupCosts('2026-07-01')` → **5 ok, 0 failed**, one row,
      $0.2500. Before the advisory lock the reviewer reproduced a `23505` abort here.

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 4: `/admin` surface + dashboard UI + deploy

### What this phase does
Serves the operator page and its JSON, then deploys. First cross-tenant read surface in the system.

### Changes required

**`src/admin/adminApi.ts`** (new) — mirrors [boardApi.ts](../../../src/telegram/boardApi.ts):
- `isAdminPath(url)`; `handleAdminRequest(req, res)`.
- Auth: `Authorization: Bearer <token>` vs `ADMIN_DASHBOARD_TOKEN`; **length-check before
  `crypto.timingSafeEqual`** (unequal lengths throw). Unset token → **503 "not configured"**, never
  open. Auth failure → bare 401, no detail.
- `GET /admin/api/costs?period=YYYY-MM` → `cost_rollup_monthly` joined to tenant names + seat
  counts; `method` present on **every** row.
- Static serving of `web/admin/*` reusing the extension-whitelist + traversal + resolve-and-prefix
  pattern from [boardApi.ts:112](../../../src/telegram/boardApi.ts#L112).

**`src/mcp/httpServer.ts`** — insert the admin block after the board block (closes at **:289**) and
**before `if (!allowed(req))` at :290**. Verified non-shadowing: `isBoardPath` matches only
`/board*`, `isRelayPath` only `/composio*`.

**`supabase/migrations/20260725140000_cost_tables_rls.sql`** (new) — **DECIDED: enable RLS**
(user decision 2026-07-24, "option A").

Bearer auth alone does not protect this data. Verified empirically on the local stack: the
publishable ("anon") key reads `cost_rollup_monthly`, `cost_events`, and `infra_costs` at
**HTTP 200** straight from PostgREST, and `cost_rates` returns real prices — bypassing `/admin`
entirely. All four show `rls: false`, as does `customers`, so this is the project's existing
posture via `auto_expose_new_tables` (`supabase/config.toml`), not a Phase-1 regression. It lands
differently here because every other table holds ONE tenant's business data while
`cost_rollup_monthly` holds **every tenant's spend in one table** — one subtraction from per-customer
margin.

Mitigating fact (also verified): the anon key is **not used anywhere in this project** — absent from
`.env.example`, absent from `web/`, and `src/db/client.ts` uses the service-role key exclusively. So
this is a latent exposure, not a live one. The fix converts "nobody happens to hold the key" into
"the data is protected".

`alter table … enable row level security` on all four cost tables, with **no policy**. The
service-role key bypasses RLS, so the cron, the accessors and `/admin` are unaffected; anon and
authenticated get zero rows. Pays down the slice of the `auto_expose_new_tables` debt (due before
2026-10-30, `engineering-memory` §4) that matters most.

**`web/admin/index.html` · `admin.css` · `admin.js`** (new) — no build step, no framework. Total burn
+ MoM delta; per-provider breakdown; per-tenant table with cost, **$/seat**, and a visible `est.`
marker on any `allocated` row; 90-day trend. `prefers-color-scheme`; phone-readable; token in
`sessionStorage`, never in the URL.

**`.env.example`** — add `ADMIN_DASHBOARD_TOKEN`.

**Deploy** — apply both migrations to the pilot via Supabase MCP `apply_migration`, then
`NOTIFY pgrst, 'reload schema'`, then Render **"deploy latest commit"** (never "Redeploy") and
confirm the live commit hash.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass (51 files, **692
      tests**, +20)
- [x] `src/admin/adminApi.test.ts` (20 tests): no token → 503; missing header → bare 401; wrong
      token same length → 401; **different-length** token → 401 without throwing; correct → 200;
      non-GET → 405
- [x] **server-level** test through the real HTTP handler with `ALLOWED_CLIENT_IPS` set to a
      non-matching address — `/admin` and `/admin/api/costs` serve, `/adminX` gets 403, proving the
      branch sits on the correct side of the allowlist (non-vacuous: `allowed()` reads the env per
      request)
- [x] `/board`, `/board/api/day`, `/control/badges` all still route correctly
- [x] traversal: whitelist + `..`/separator rejection + resolve-prefix check; a **raw socket** test
      sends the literal un-normalized `/admin/static/../../.env` (fetch() would normalize it away
      client-side, making a fetch-only test prove nothing) and asserts no file content ever returns
- [x] **RLS proof, both directions** — `set local role anon` / `authenticated` → **42501
      insufficient_privilege** on all four cost tables, with a control assertion that the same role
      still reads `customers` (so the probe cannot pass vacuously); service-role path still returns
      its own writes through `/admin`. No anon key needed in `.env.test`.
- [x] added after review: an **impossible month** (`2026-00`, `2026-13`, `2026-99`) returns 400 and
      the server survives — verified standalone that no unhandled rejection fires

### Live verification (agent-executable)
- Prerequisites: Supabase MCP read access to the pilot (**SELECT only**); the deployed Render URL.
- [ ] `GET /admin/api/costs` with the real token → 200; cross-check one tenant's figure against a
      direct SQL `SELECT` on `cost_rollup_monthly`. Same number in both channels; capture both.
- [ ] Same request with no Authorization header → 401 against the live URL.

### Manual verification
- [ ] Readable on your phone, and `est.` markers unmistakably distinct from measured figures at a
      glance — the whole disclosure decision rests on this
- [ ] The $/seat column tells you something you didn't already know

---
*Pause after this phase for the manual checks.*

## Extensibility acceptance test (before calling this done)

Add a fake vendor end-to-end and time it. More than one `cost_rates` row plus one collector call
means the abstraction is wrong — fix it now, not in October.
