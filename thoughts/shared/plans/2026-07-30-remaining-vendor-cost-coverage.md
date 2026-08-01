# Plan — remaining vendor cost coverage

**Status:** AWAITING APPROVAL to write to the pilot. No code changes; data entry only.
**Date:** 2026-07-30
**Follows:** [2026-07-24-per-tenant-cost-dashboard.md](2026-07-24-per-tenant-cost-dashboard.md) (PR #87),
DeepInfra auto-collector (PR #90).

**Decisions taken (owner, 2026-07-30):**
1. **Lightsail is a static figure — $86/month, the FULL AWS bill.** No AWS integration of any kind.
2. **Google Maps, Composio, telephony: placeholder rows at $0.** Not in use yet; nothing built.
3. Keep it simple — this is a dashboard, not an accounting system.

---

## 1. The problem

| Vendor | Real / month | On the dashboard now |
|---|---|---|
| **Lightsail** (trades-box-1, full AWS bill) | **$86.00** | **$0** ← the whole problem |
| DeepInfra (inference) | $37.31 | $37.31 ✅ auto-collected (PR #90) |
| Brave | $0.015 | $0.015 ✅ measured |
| Google Maps | $0 (inside free tier) | $0 |
| Composio | $0 (no calls yet) | $0 |
| Render / Supabase | $0 (free plans) | $0 |

**The dashboard shows about 30% of real spend**, and the entire gap is one missing row.

## 2. Approach

### 2.1 Lightsail — twelve rows, entered once

`infra_costs` is keyed on `(vendor, item, period_start)`, so a July row covers July only. A
July-only entry means the dashboard **silently drops back to ~30% of spend on 1 August** — the same
"$0 reads as *no spend*" failure that justified PR #90.

An earlier draft of this plan proposed a carry-forward cron step. **That was over-built for a fixed
$86 line.** Since the amount is known and constant, the simple fix is to insert **July 2026 through
June 2027 in one statement** and be done for a year.

Future-dated rows are inert: `rollup_costs` only ever computes the month it is handed, and the cron
only asks for the current and previous month. An August row does nothing until August.

**Allocation: `per_sandbox`.** The box exists to host sandboxes, so that is the causal driver — and
it matches how inference already splits, keeping the two largest lines consistent.

**If the box is resized**, update the rows from that month onward. Same effort as any other approach.

### 2.2 Google / Composio / telephony — placeholders at `unallocated`

Entered at `$0` as requested, with **`allocation='unallocated'`** rather than a real rule.

**Why that matters:** `rollup_costs` skips `unallocated` rows entirely
(`20260725130000_cost_rollup_fn.sql:135`). A $0 row with a real allocation rule would instead
produce a `$0.00 est.` line for every tenant — a figure that says nothing, on a dashboard whose
whole discipline is that every number means something. The original migration made this exact call
for `google`: *"an unseeded vendor is honest; a seeded one with no events renders a $0 line that
reads as 'no spend' rather than 'not measured'."*

So the placeholders **exist in `infra_costs`** — anyone entering costs later finds them, with the
right vendor and item names already chosen — but they **stay off the dashboard** until they carry a
real amount. Switching one on is a two-field update: set the amount, set the allocation.

### 2.3 When these vendors do start costing money

Recorded so it is not re-litigated. The pattern is the one PR #90 proved:

```
  MEASURE UNITS  ────►  attribution   (which tenant used what)
                              │
  DOLLARS FROM THE BILL ────►  allocation   (split the invoice by those units)
       free tiers, volume discounts, price changes — already baked in
```

- **Google Maps has free monthly caps** — 10,000 geocoding, 5,000 Compute Routes Pro
  ([pricing](https://developers.google.com/maps/billing-and-pricing/pricing)). Current volume is 37
  customers (coordinates cached on the customer row, so geocoding is ~37 calls *ever*) plus a few
  hundred route calls: two orders of magnitude inside the caps. Pricing per call at list rate would
  invent ~$1–2/month of spend Google does not charge. **Phantom cost is as dishonest as a silent
  under-report.** The cap is also per *account*, not per tenant, so an allowance has no correct
  per-tenant split.
- **Composio is already instrumented** — `recordComposioCall` is wired at all three sites (relay,
  outbound send, cron pairing probe) and `$0.299/1,000` is seeded. Zero events means zero calls
  since the 2026-07-27 deploy, not a missing collector. Caveat: premium tools bill at 3× and the
  call sites cannot tell them apart.
- **Telephony** bills per minute with carrier and international variation.

**Trap for that day:** `rollup_costs` hardcodes `e.provider <> 'spine'` when counting unpriced
events. Adding a second unpriced counter without extending that predicate would make every cron tick
report hundreds of false "unpriced events" — training everyone to ignore the one signal that catches
a genuine price-book hole.

## 3. The change

One statement against the pilot. No code, no migration, no dependencies, no UI change.

```sql
insert into infra_costs (vendor, item, period_start, period_end, amount_usd, allocation, source)
select v.vendor, v.item, m.period_start,
       (m.period_start + interval '1 month' - interval '1 day')::date,
       v.amount, v.allocation, v.source
  from (values
    ('lightsail', 'trades-box-1',    86.00, 'per_sandbox', 'invoice'),
    ('google',    'maps api',         0.00, 'unallocated', 'estimate'),
    ('composio',  'tool calls',       0.00, 'unallocated', 'estimate'),
    ('telephony', 'phone calls',      0.00, 'unallocated', 'estimate')
  ) as v(vendor, item, amount, allocation, source)
 cross join generate_series('2026-07-01'::date, '2027-06-01'::date, interval '1 month') as m(period_start)
 on conflict (vendor, item, period_start) do nothing;

select * from rollup_costs('2026-07-01');
```

`do nothing` on conflict: re-running is safe, and it can never overwrite a real figure entered later.

## 4. Expected result

Sandboxes are 4 (Default: s2/s5/s7/s8) and 1 (Judy: s3) → an 80/20 split.

| | Lightsail | DeepInfra | Brave | Total |
|---|---|---|---|---|
| Default Tenant | $68.80 | $29.85 | $0.015 | **$98.66** |
| Judy Testing | $17.20 | $7.46 | — | **$24.66** |
| **Total** | **$86.00** | **$37.31** | **$0.015** | **$123.33** |

Google / Composio / telephony appear **nowhere** on the dashboard — by design (§2.2).

## 5. Verification

- [ ] Dashboard total = **$123.33**; per-tenant rows sum to it exactly.
- [ ] `lightsail` renders hatched + `est.` (allocated) and splits 80/20.
- [ ] `rollup_costs` reports `unpricedEvents: 0` — non-zero would mean the new rows broke
      price-book matching.
- [ ] **No `$0.00` lines appear** for google / composio / telephony.
- [ ] `infra_costs` holds 48 rows (4 vendors × 12 months), with July's `lightsail` at `invoice`.
- [ ] August still shows $86 when August arrives — the point of pre-populating.

## 6. Open question

**Does Supabase stay on the free plan?** A Pro upgrade ($25/mo) becomes the third-largest line
overnight and wants the same treatment as Lightsail.
