---
date: 2026-07-30
task: Move Brave and Composio off per-unit list-rate pricing to counter + invoice
research: thoughts/shared/research/2026-07-30-brave-composio-bill-driven-costing.md
status: draft
---

## Overview

Brave and Composio are priced in `cost_rates` as if every unit costs money from the first one.
Neither vendor bills that way — Brave grants $5 of credit every month (~1,000 searches) and
Composio includes 20,000 tool calls/month on its free tier. The ledger therefore reports spend that
the vendors do not charge. This converts both to the pattern already proven for DeepInfra: **count
units for attribution, take dollars from the bill.**

Measured, not assumed:

| | Real July usage | Vendor's allowance | Ledger says | Truth |
|---|---|---|---|---|
| Brave | 3 searches | $5/mo credit (~1,000 calls) | **$0.015** | **$0** |
| Composio | 389 tool calls | 20,000/mo free tier | $0 (no events yet) | **$0**, or $29 flat if on the paid tier |

## Decisions

- **Dollars come from `infra_costs`, not an API** — neither vendor exposes a dollar-returning
  endpoint. Brave has no billing API at all; Composio's Usage API
  (`POST /api/v3.1/project/usage/summary`) returns `{unit, total_quantity, event_count}` with **no
  cost fields** (verified live: 389 tool calls for July). Same mechanism as `lightsail`.
- **DELETE the two `cost_rates` rows rather than close them with `effective_to`** — chosen over
  closing. Closing is the documented mechanism for a *price change*; this is a *correction* — the
  rates never described how these vendors bill. Deleting also removes July's phantom $0.015, which
  is a fix, not a loss. Critically, it is what makes the next decision possible.
- **The unpriced-event signal becomes data-driven instead of a hardcoded name list** — chosen over
  extending `e.provider <> 'spine'` to `not in ('spine','brave','composio')`. With the rates
  deleted, "unpriced by design" and "price-book gap" become distinguishable from the data: a
  provider with **no rows at all** in `cost_rates` is a counter; a provider that **has** rates but
  none covering an event has a genuine gap. Self-maintaining — google and telephony need no code
  change when they arrive.
- **Brave's units keep flowing** — `backfillBraveCostEvents` is unchanged. The units are the
  attribution basis; only the pricing goes away.
- **Existing tests migrate off Brave as their priced vehicle** (owner chose option A, 2026-07-30).
  Found during implementation, NOT anticipated in the first draft of this plan: `costs.test.ts`
  uses `brave` as the canonical priced vendor in **7 tests**, most testing something unrelated to
  Brave (idempotency `:524`, rate versioning `:541`, partial coverage `:690`, month boundaries
  `:725`). Deleting the rate breaks all of them. They move to `deepinfra`, which is genuinely
  per-unit priced and will stay that way. Rejected alternative: closing the rates at `2026-08-01`
  so July still prices and the tests pass untouched — it preserves July's phantom $0.015 and forces
  the unpriced predicate back to a hardcoded name list, reintroducing the exact maintenance trap
  this plan exists to remove. Side benefit of migrating: testing month boundaries via Brave meant
  any Brave price change broke unrelated tests.
- **Composio is on the FREE tier** (owner-confirmed 2026-07-30) — RESOLVED. 20,000 tool calls are
  included and July used **389**, so Composio spend is genuinely **$0**. The `$0.299/1K` seeded
  rate is the $29 tier's *overage* rate and never applied to this account at all. The existing
  `composio / tool calls / $0 / unallocated` placeholder row is already correct, so **Phase 2 needs
  no Composio data change** — the vendor simply becomes an unpriced counter like Brave.

## Plain-language walkthrough

**The problem in one line:** we are charging ourselves list price for things the vendors give us
free.

**Phase 1 — stop pricing them.** Delete the two price-book entries. Their usage still gets counted
per tenant; it just stops being multiplied by a price. On the dashboard they behave exactly like
`spine` already does — a line showing units with a dash instead of a dollar figure.

The catch is that the cron reports a number called "unpriced events", meant to warn you when a
price is *missing by accident*. Today it treats `spine` as the one legitimate exception, by name.
Add two more unpriced vendors and every 15-minute run would shout about hundreds of "unpriced
events" that are perfectly intentional — and people would learn to ignore the one alarm that
catches a real pricing hole. So the check gets smarter: it stops asking *"is this spine?"* and
starts asking *"does this vendor have prices at all?"*

```
  BEFORE                                AFTER
  is the provider named 'spine'?        does this provider have ANY rate rows?
      yes → fine                            no  → a counter by design, fine
      no  → warn                            yes → but none covers this event → real gap, warn
```

**Phase 2 — put the real dollars in, and fix the note under the table.** The dashboard currently
tells the reader that any unpriced line other than `spine` means a gap in the price book. That
sentence becomes false the moment Brave is a counter, so it gets reworded. Then the actual money:
Brave is $0 (inside its free credit), and Composio is either $0 or a flat $29 depending on the plan
tier — one row either way.

**How you'd notice it working:** the dashboard total drops by exactly $0.015, Brave vanishes from
the vendor bars but still appears under a tenant's Usage with a `—`, and the cron keeps reporting
`unpricedEvents: 0`.

## Secrets & env preflight

- **Phase 1:** none. Migration applied by hand via the Supabase SQL editor (the available Supabase
  MCP is a different account — see `HANDOFF.md`).
- **Phase 2:** none. `COMPOSIO_API_KEY` is `already required` and was used only to read usage
  during research; no new key.

## Phase 1: unprice both vendors, make the unpriced signal data-driven

### What this phase does
Removes the two rate rows and replaces the hardcoded `spine` exemption with a rule derived from the
price book itself, so the "unpriced events" alarm keeps meaning "something is wrong".

### Changes required

**`supabase/migrations/20260730120000_unprice_brave_composio.sql`** (new)
```sql
-- Brave bills $5/1,000 AFTER $5 of monthly credit (~1,000 calls); Composio's
-- $0.299/1K is an OVERAGE rate that applies only past 20,000 included calls.
-- Pricing per unit from the first one reports spend neither vendor charges.
-- Deleted, not closed with effective_to: closing is for a price CHANGE, and
-- these rates never described how the vendors bill.
delete from cost_rates where provider in ('brave', 'composio');
```
Then `create or replace function rollup_costs(...)` — the whole function body re-stated with **one
predicate changed** at `supabase/migrations/20260725130000_cost_rollup_fn.sql:118`:
```sql
--     and e.provider <> 'spine'            -- a counter, unpriced BY DESIGN
     -- A provider with NO rate rows at all is a counter by design (spine, brave,
     -- composio, and google/telephony when they arrive). A provider that HAS
     -- rates but none covering this event has a real gap — that is the alarm.
     and exists (select 1 from cost_rates r2 where r2.provider = e.provider)
```
- Everything else in the function is copied verbatim. `create or replace` preserves existing
  privileges, but **restate the revoke anyway** as cheap insurance — this function reads every
  tenant's spend:
```sql
revoke all on function rollup_costs(date) from public, anon, authenticated;
```
- Verified: no foreign key references `cost_rates`, so the `delete` is safe; and
  `20260730120000` sorts after the current newest migration (`20260726120000_customers_geocoding`).

**`src/db/costs.test.ts`**
- New tests in the `rollupCosts` describe block:
  - a provider with no rate rows produces `unpricedEvents: 0` (the counter case)
  - a provider **with** a rate row but an event outside its date window still produces
    `unpricedEvents: 1` (the real-gap case must survive)
  - `brave` events after the migration land in `cost_events` but produce **no**
    `cost_rollup_monthly` row (the INNER join at `cost_rollup_fn.sql:96` drops them)

### Automated verification
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm test` — **899/900**. The single failure is `briefCustomer.test.ts` (live GLM), which
      fails **identically with my changes stashed** and errors differently each run ("model returned
      no record_briefing tool call", then "briefing undefined", one run taking 173s). It is the
      DeepInfra completion-stall incident recorded in `engineering-memory` on `40a1cf9` the same
      day — environmental, not a regression.
- [x] `npm run build` passes
- [x] `npx supabase db reset` replays all migrations cleanly; verified afterwards that
      `cost_rates` holds only the 5 anthropic/deepinfra rows and that the deployed `rollup_costs`
      body contains the `exists (select 1 from cost_rates r2 ...)` predicate with no live
      `provider <> 'spine'` (the old form survives only inside an explanatory comment).
- [x] **Scope-widened during implementation (owner-approved, option A):** 7 existing tests used
      `brave` as their priced vehicle and 3 more in `adminApi.test.ts` — all migrated to
      `deepinfra`. Final sweep confirms no test asserts a brave/composio dollar figure anywhere.

### Live verification (agent-executable)
- Prerequisites: pilot `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (in `.env`, read-only reads
  plus this one DDL applied by the owner in the SQL editor); the deployed `/admin` URL +
  `ADMIN_DASHBOARD_TOKEN`.
- [x] Migration applied to the pilot by the owner 2026-07-30 (SQL editor, ledger row recorded as
      `20260730120000 / unprice_brave_composio`). `cost_rates` went 7 → **5 rows**; brave and
      composio gone.
- [x] `rollup_costs('2026-07-01')` → `{rows_written: 4, tenants_touched: 2, unpriced_events: 0}`.
      **This is the load-bearing result**: Brave's 3 events are now recognised as a counter rather
      than a price-book gap, which the old hardcoded `provider <> 'spine'` predicate would have
      reported as 3 gaps on every 15-minute tick.
- [x] `GET /admin/api/costs?period=2026-07` — `brave` absent from `byProvider`; only `lightsail`
      $86.00 and `deepinfra` $39.87 remain, tenants sum == total. (The absolute total moved
      $124.69 → $125.87 rather than down by $0.015 because the DeepInfra auto-collector kept
      tracking real usage between the two reads; the Brave line itself is verifiably gone and
      `cost_rollup_monthly` holds **0** brave rows.)
- [x] `GET /admin/api/tenant` → `brave · search · 3 request · —` alongside `spine · tool_call ·
      8 call · —`. Units survive unpricing; two counters now render identically.

### Manual verification
- none — every check above is mechanical.

---
*No pause needed; automated + live checks suffice.*

## Phase 2: dashboard copy and the real dollars

### What this phase does
Corrects a sentence that becomes false in Phase 1, and enters the actual money.

### Changes required

**`web/admin/admin.js:228-230`**
- The footnote asserts any non-`spine` unpriced line is a price-book gap. Replace:
```js
  const unpriced = r.usage.filter((u) => u.costUsd === null).map((u) => `${u.provider}/${u.sku}`);
  $('t-usage-note').textContent = unpriced.length
    ? `Not priced: ${unpriced.join(', ')} — counted for attribution only. These vendors' dollars come from a monthly bill (or are inside a free allowance), so units are shown without a price.`
    : '';
```
- No other UI change: `—` for a null cost (`:218`) is already correct.

**`supabase/migrations/20260725120000_cost_ledger.sql:168`** — comment only, no DDL
- The comment reads *"free tier removed Feb 2026"*. Brave's current pricing page documents **$5
  free credit renewing monthly**. Correct the comment so the next reader does not re-seed the rate
  on a stale premise. (Historical migration files are not re-run; this edits only the comment.)

**Pilot data — no code**
- Brave: leave the `$0` placeholder absent. Brave has no `infra_costs` row today and needs none
  while it is inside the free credit; the counter alone is the honest state.
- Composio: **nothing to do** — free tier confirmed, so $0 is the truth. The existing
  `composio / tool calls / $0 / unallocated` placeholder row (created 2026-07-30) is already right.
  If the account ever moves to the $29 tier, the change is to update that one row
  (`amount_usd = 29.00`, `allocation = 'per_active_seat'` — a Composio session is provisioned per
  *person*, not per box — and `source = 'invoice'`).

### Automated verification
- [x] `npm run lint` passes
- [x] `npm run typecheck` / `npm run build` pass
- [x] `npx supabase db reset` still replays cleanly — confirms the edit to the historical
      migration `20260725120000` is comment-only and did not change its DDL.
- [x] `npm test` — **895/895 pass** when the three live-model files are excluded (32s). With them
      included the run takes 2142s and 5 fail. Root cause identified and NOT a regression:
      GLM-5.2 spends its token budget on reasoning before emitting content, so a tight
      `max_tokens` returns HTTP 200 with EMPTY content and no error. Probed live:
      `max_tokens=50` → `finish_reason:"length"`, `content:""`, 50 tokens burned;
      `max_tokens=300` → `content:"ok"`, 146 tokens. Flagged as a separate task since
      `src/email/classify.ts:53` requests only 256 — out of scope for this plan.

### Live verification (agent-executable)
- Prerequisites: as Phase 1.
- [ ] `unpricedEvents` remains `0` after the copy change (no data moved, so this is a regression
      guard rather than a new assertion).
- [ ] `GET /admin/api/costs` shows **no** `composio` line — free tier, $0, `unallocated`.

### Manual verification
- [ ] Open a tenant's **Breakdown ›** and confirm the reworded footnote reads correctly next to the
      `spine` and `brave` lines — that it no longer implies something is broken. Judgment call on
      wording, so a human reads it.

---
*Pause after this phase — its Manual verification list is non-empty.*

## Open questions

1. **Which Composio plan is the account on?** Free (20,000 included) or $29 (200,000 included).
   Determines whether Phase 2 enters a row. Composio dashboard → Billing.
2. **Composio pricing changes 2026-08-15.** With no `cost_rates` row after Phase 1, nothing in the
   ledger encodes Composio's prices, so the change needs no code — but if the account is on a paid
   tier, the monthly amount may move and the `infra_costs` row would need updating.
3. **Brave's `$5` credit — per key, per account, or per plan?** Determines whether the allowance is
   shared with anything else using the same key. Not answerable from the code.
