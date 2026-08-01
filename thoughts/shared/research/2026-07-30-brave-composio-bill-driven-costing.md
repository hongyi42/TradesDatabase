---
date: 2026-07-30
branch: feature/fixed-infra-costs
commit: 99fb582
topic: Moving Brave and Composio from per-unit list-rate pricing to the bill-driven pattern
---

## Summary

The cost ledger prices metered vendors by multiplying a counted quantity (tokens, requests, tool
calls) by a per-unit rate held in the `cost_rates` table. That model assumes every unit costs money
from the first one. Two vendors currently priced this way do not work like that: **Brave** grants
$5 of free credit every month (about 1,000 searches) before charging $5 per 1,000, and **Composio**
includes 20,000 tool calls per month on its free tier and 200,000 on the $29 tier — the
`$0.299/1,000` figure seeded in our price book is Composio's *overage* rate, charged only after the
included allowance is exhausted. Because the ledger has no concept of an included allowance, it
bills both vendors from unit one. This document records how the affected code works today, what a
"bill-driven" alternative would touch (the pattern already used for DeepInfra: count units for
attribution, take dollars from the monthly invoice), and what is externally possible — in
particular, that **neither vendor exposes an API returning dollar amounts**, unlike DeepInfra.

## Entry Points

Where the two vendors' units enter the ledger:

- **Brave** — `src/db/costs.ts:243` `backfillBraveCostEvents(sinceIso)`. Not live-instrumented:
  it replays rows from the `web_requests` table. Called from the cron at
  `src/jobs/lifecycle.ts:190` (step 5).
- **Brave unit source** — `src/mcp/server.ts:2126`, which writes a `web_requests` row with
  `kind: 'search'` via `logWebRequests` (`src/db/webRequests.ts:15`) *before* the network call.
- **Composio** — `recordComposioCall` (`src/db/costs.ts:203`), called at three sites:
  - `src/composio/relayHandler.ts:207` — the doorman relay forward (gated on
    `req.method === 'POST' && isToolCall(parsed)`)
  - `src/composio/outbound.ts:60` — the technician `send_email` path, which never traverses the relay
  - `src/composio/pairing.ts:183` — the cron's pairing probe, the only site that bills with no
    human action
- **Pricing** — both vendors' rates are seeded in
  `supabase/migrations/20260725120000_cost_ledger.sql:169-172`.
- **Aggregation** — `rollup_costs` (`supabase/migrations/20260725130000_cost_rollup_fn.sql`).
- **Read surfaces** — `src/admin/adminApi.ts` (`buildCostReport`, `buildTenantReport`) and
  `web/admin/admin.js`.

## Key Files

| Path | Role | Key exports / points |
|---|---|---|
| `src/db/costs.ts` | The ledger's typed layer | `appendCostEvents:48`, `recordComposioCall:203`, `backfillBraveCostEvents:243`, `listCurrentRates:284`, `upsertInfraCost:309`, `recordVendorInvoiceAmount` (added for the DeepInfra collector), `rollupCosts:355`, `readTenantCostDetail`, `readRollup` |
| `src/model/deepinfraUsage.ts` | **The bill-driven precedent** | `fetchDeepinfraUsage`, `collectDeepinfraUsage`, `billingApiKey`, `ratesLookLikeCents`. Writes dollars into `infra_costs` via `recordVendorInvoiceAmount` |
| `src/web/braveSearch.ts` | Brave HTTP client | `braveWebSearch(query, count)`. Reads `BRAVE_API_KEY`. **Contains no cost or usage logic at all** |
| `src/db/webRequests.ts` | The Brave unit source | `logWebRequests:15`, kinds `'search' \| 'search_result' \| 'fetch'` |
| `src/composio/relayHandler.ts` | Doorman relay | records at `:207`, after auth and immediately before forwarding |
| `src/composio/outbound.ts` | Technician send path | records at `:60`, **billed even when `successful === false`** |
| `src/composio/pairing.ts` | Cron pairing probe | records at `:183`, gated on a local `billed` flag |
| `supabase/migrations/20260725120000_cost_ledger.sql` | Schema + seeded price book | `cost_rates:20`, `cost_events:52`, `infra_costs:102`, `cost_rollup_monthly:127` |
| `supabase/migrations/20260725130000_cost_rollup_fn.sql` | The aggregation | measured pass `:88`, unpriced count `:114`, allocation pass `:130` |
| `supabase/migrations/20260725150000_tenant_cost_detail_fn.sql` | Per-tenant detail | LEFT join `:43`, null-cost rule `:40` |
| `web/admin/admin.js` | Dashboard rendering | unpriced footnote `:228-230`, `—` for null cost `:218` |

## Data Flows

### Brave today (replay, not instrumentation)

```
  agent calls web_search
        │
        ▼
  server.ts:2126  logWebRequests({kind:'search'})   ← written BEFORE the network call
        │                                             (a 429 still logs a row)
        ▼
  web_requests table  ──────────────┐
                                    │  cron step 5, every 15 min
                                    ▼
              backfillBraveCostEvents(since)   costs.ts:243
                 paginated 1000/page, ordered by created_at,id
                 sourceRef = web_requests.id   ← idempotency key
                                    │
                                    ▼
              cost_events(provider='brave', sku='search', quantity=1, unit='request')
```

The watermark comes from `latestBraveCostEventAt` (`costs.ts:375`) minus a 1-hour overlap
(`lifecycle.ts:63`), falling back to `BRAVE_BACKFILL_EPOCH = '2026-07-01T00:00:00.000Z'`
(`lifecycle.ts:67`) when the ledger holds no Brave events.

### Composio today (live, three sites)

```
  relay forward ─┐
  outbound send ─┼──► recordComposioCall({tenantId, technicianRef})   costs.ts:203
  pairing probe ─┘         │
                           ▼
        cost_events(provider='composio', sku='tool_call', quantity=1, unit='call')
                 NO sourceRef → every call inserts (NULLs are DISTINCT in the
                 unique constraint, cost_ledger.sql:94)
```

Each call site wraps the recorder in its own `.catch()` at the call site rather than trusting the
recorder's internal isolation — `relayHandler.ts:210`, `outbound.ts:63`, `pairing.ts:186`. The
comment at `relayHandler.ts:204-206` states the reason: isolation must be a property of the handler
or it evaporates when someone injects a different recorder.

### From events to dollars

```
  cost_events ──INNER JOIN cost_rates──► cost_rollup_monthly ──► /admin/api/costs
   (units)      on provider+sku+date       (dollars)              byProvider, tenants[].lines
       │
       └────LEFT JOIN cost_rates────────► tenant_cost_detail ──► /admin/api/tenant
                                           (cost_usd may be NULL)   usage[]
```

Two different joins, and the difference is what determines what an unpriced vendor looks like:

- **`rollup_costs` measured pass** (`cost_rollup_fn.sql:88-103`) uses an **INNER** join, so an
  event whose `(provider, sku)` has no covering rate is **dropped entirely**. This is how `spine`
  stays out of the totals.
- **`tenant_cost_detail`** (`tenant_cost_detail_fn.sql:43`) uses a **LEFT** join and returns
  `cost_usd = null` unless *every* event on the line matched a rate (`:40`,
  `case when count(r.id) <> count(*) then null`).

### The DeepInfra bill-driven precedent (PR #90)

```
  spine tool calls ──► cost_events(provider='spine', unpriced)  ← attribution basis only
  DeepInfra /payment/usage ──► collectDeepinfraUsage ──► recordVendorInvoiceAmount
                                                              │
                                                              ▼
                                        infra_costs(vendor='deepinfra', amount_usd, allocation)
                                                              │
                                        rollup_costs allocation pass (cost_fn.sql:130-225)
                                          nets out measured spend for that vendor (:149-158)
                                          splits the remainder by the allocation weight
```

## External Dependencies

### Brave

- Client: `fetch` against `https://api.search.brave.com/res/v1/web/search`
  (`braveSearch.ts:21`), header `X-Subscription-Token`, 10s timeout.
- **Billing/usage API: none found.** Documentation describes credits and a dashboard usage limit
  but no programmatic usage or billing endpoint
  ([pricing](https://api-dashboard.search.brave.com/documentation/pricing),
  [API overview](https://brave.com/search/api/)).
- Allowance: **$5 free credit per month, renewing**, described as good for up to ~1,000 calls/month;
  $5 per 1,000 requests thereafter.

### Composio

- SDK: `@composio/core` (`package.json`), plus a raw HTTP relay in `relayHandler.ts`.
- **Usage API exists, but returns COUNTS ONLY.**
  `POST https://backend.composio.dev/api/v3.1/project/usage/summary`, auth header `x-api-key`,
  body `{from, to}` in Unix epoch **milliseconds** (`from` inclusive, `to` exclusive), optional
  `entity_types` and `filters` (`user_id` / `session_id` arrays). Response:
  `{ entities: { [key]: { unit, total_quantity, event_count } } }` — **no cost or dollar fields**
  ([reference](https://docs.composio.dev/reference/api-reference/projects/postProjectUsageSummary)).
  A breakdown variant exists at `/api/v3.1/project/usage/tool_calls`.
- Allowance: free tier **20,000 tool calls/month**; "Ridiculously Cheap" $29/mo includes
  **200,000** with **$0.299/1K overage**; "Serious Business" $229/mo includes 2,000,000 with
  $0.249/1K overage ([pricing](https://composio.dev/pricing)).
- **The pricing page states pricing changes on 2026-08-15.**

### DeepInfra (for contrast)

- `GET https://api.deepinfra.com/payment/usage` returns `total_cost` **in cents** plus itemised
  `units`/`rate` — i.e. dollars, which is what made the PR #90 collector possible.

## Constraints and Invariants

1. **`e.provider <> 'spine'` is hardcoded** in the unpriced-event count
   (`cost_rollup_fn.sql:118`). Only `spine` is exempt. Any additional unpriced provider would be
   counted as an unpriced event and surface in the cron summary's `unpricedEvents` total, which
   `lifecycle.ts` sums across both rolled months.

2. **The dashboard's unpriced footnote names `spine` explicitly.** `admin.js:230` reads:
   *"Not priced: … — spine is a counter (it drives the inference split), anything else means a gap
   in the price book."* The text asserts that any non-`spine` unpriced line indicates a price-book
   gap.

3. **An unpriced vendor disappears from the rollup entirely.** Because the measured pass INNER
   joins (`:96`), a vendor with no covering rate produces no `cost_rollup_monthly` rows, so it is
   absent from `byProvider` and from every tenant's `lines[]` in `/admin/api/costs`. It remains
   visible only in `/admin/api/tenant`'s `usage[]`, rendered as `—` (`admin.js:218`).

4. **`cost_rates` has two constraints governing how a rate may be retired**
   (`cost_ledger.sql:34-46`): a unique partial index on `(provider, sku) where effective_to is
   null` (at most one open rate per SKU), and a GiST exclusion constraint forbidding two rates for
   the same SKU covering overlapping dates. The header comment at `:18` states a price change is a
   NEW ROW closing the old with `effective_to`, never an in-place edit — because the rollup joins
   on the event's own date (`:99-100`), so historical events re-price against whatever row covered
   their day.

5. **Closing a rate vs deleting it changes history.** The rollup's date-bounded join means a rate
   closed with `effective_to = X` still prices events before X; a deleted rate prices nothing, so
   past months would re-compute to a different (lower) figure on the next rollup — and
   `rollup_costs` recomputes both the current and previous month on every cron tick
   (`lifecycle.ts`, step 7).

6. **Brave events carry a `source_ref`; Composio events do not.** Brave's is the `web_requests.id`
   (`costs.ts:272`), which is what makes the replay idempotent under the
   `(tenant_id, provider, sku, source_ref)` unique constraint (`cost_ledger.sql:94`). Composio
   passes no `sourceRef`, so every call inserts a distinct row — Postgres treats NULLs as distinct
   (`cost_ledger.sql:91-93`).

7. **Brave's counter over-counts by design, and this is documented.** `costs.ts:236-238` notes that
   `server.ts` writes the `search` row *before* the network call, so an upstream 429 is counted as
   a billable search. `braveSearch.ts:28` throws on 429.

8. **`backfillBraveCostEvents` returns rows SCANNED, not recorded** (`costs.ts:239-240`) — the
   upsert ignores duplicates, so a steady-state tick re-scans its window and inserts nothing.

9. **`infra_costs.allocation` accepts a fixed enum** (`cost_ledger.sql:109-111`):
   `per_active_seat`, `per_sandbox`, `per_tenant_equal`, `per_spine_tool_call`, `unallocated`.
   Rows with `unallocated` are skipped by the allocation pass (`cost_rollup_fn.sql:135`). There is
   no per-provider-unit allocation rule other than `per_spine_tool_call`, whose weight subquery
   (`:185-190`) is hardcoded to `provider = 'spine'`.

10. **`recordVendorInvoiceAmount` preserves an operator's allocation** — it UPDATEs amount/source
    only and INSERTs with a default allocation just when no row exists. Any automated dollar
    collector added for another vendor would inherit this behaviour by using it.

11. **Current pilot state (read 2026-07-30):** `cost_rates` holds 7 rows, all open-ended
    (`effective_to` null). `cost_events` holds 3 `brave` rows and 7 `spine` rows for July; zero
    `composio` rows. `infra_costs` now holds 48 rows, among them `composio`/`tool calls` and
    `google`/`maps api` at `$0` with `allocation='unallocated'`.

## Decision Points

**1. Where Brave's and Composio's dollars would come from.** Neither vendor exposes a
dollar-returning API. DeepInfra's collector reads `total_cost` from `/payment/usage`; there is no
equivalent. Options as the code stands: a hand-entered `infra_costs` row per month (the mechanism
already exists and is in use for `lightsail`); or, for Composio only, calling
`/api/v3.1/project/usage/summary` to obtain **counts** and computing dollars locally from a tier
model — which would require encoding the included-allowance and overage-rate structure somewhere,
since the API supplies no prices.

**2. What happens to the existing `cost_rates` rows.** Closing them with `effective_to` leaves past
months priced as they are today (Brave's 3 July events would keep their $0.015). Deleting them
makes those events unpriced retroactively, and because `rollup_costs` recomputes the current and
previous month each tick, July's Brave figure would change on the next run. The unique partial
index and the exclusion constraint permit either, but a closed rate cannot be re-opened for the
same dates without violating `cost_rates_no_overlap`.

**3. Whether the unpriced-event signal stays meaningful.** `cost_rollup_fn.sql:118` exempts only
`spine`. If Brave or Composio becomes unpriced, their events count toward `unpricedEvents` in every
cron summary unless that predicate changes. Separately, `admin.js:230` tells the reader that any
non-`spine` unpriced line means a price-book gap — a statement that would no longer hold.

**4. How an unpriced Brave/Composio would be allocated, if at all.** `infra_costs.allocation`
offers no per-provider-unit rule beyond `per_spine_tool_call`, whose weight subquery is hardcoded
to `provider = 'spine'` (`cost_rollup_fn.sql:185-190`). Splitting a Brave or Composio invoice by
that vendor's own units would require either a new enum value plus weight branch, or reuse of an
existing rule (`per_sandbox`, `per_active_seat`, `per_tenant_equal`) that is not derived from the
vendor's usage.

**5. Whether Brave's over-count matters more once dollars come from an invoice.** Today the
pre-call logging inflates both units and dollars together. Under a bill-driven scheme the invoice
would set the dollars and the units would only set each tenant's *share*, so the 429 over-count
would shift from inflating the total to skewing attribution between tenants.

**6. Composio's 2026-08-15 pricing change.** Whatever encodes Composio's prices — a `cost_rates`
row today, or a tier model under option 1 — has a dated expiry. A `cost_rates` row would be closed
and succeeded per the existing versioning mechanism; an invoice-driven figure would need no change,
since the invoice reflects whatever Composio charged.

## Open Questions

1. **Which Composio plan is this account on?** The seeded `$0.299/1K` is the $29 tier's overage
   rate. Whether the account is on Free (20,000 included), $29 (200,000 included), or another tier
   is not discoverable from the codebase and determines whether any Composio spend exists at all.
   Not established by reading; would need the Composio dashboard.
2. **Does Brave expose usage programmatically anywhere undocumented?** Searching the public
   documentation surfaced credits and a dashboard usage limit, but no endpoint. Confirming absence
   would require checking the authenticated dashboard or asking Brave.
3. **Is the Brave `$5/month` credit per API key, per account, or per plan?** This determines
   whether the allowance is shared with anything else using the same key.
4. **Does the Composio Usage API's `project`-scoped variant align with our tenant boundary?** Our
   per-tenant attribution comes from our own counters; whether Composio's project/user dimensions
   could reconcile against them depends on how `compositeUserId` (`src/composio/pairing.ts`) maps
   onto Composio's `user_id` filter.
5. **Whether `web_requests` rows are retained indefinitely.** `backfillBraveCostEvents` re-reads
   from a watermark, so a retention policy on `web_requests` would silently change what is
   replayable. No retention logic was found in the code read.
