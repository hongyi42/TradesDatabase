import { listCurrentRates, recordVendorInvoiceAmount, type InfraAllocation } from '../db/index.js';

// Pull the DeepInfra bill from DeepInfra, instead of retyping it by hand.
//
// WHY THIS EXISTS. Agent inference is the largest line on the cost dashboard and
// it is ALLOCATED, not measured — the box runs one gateway on one shared API key,
// so there is no per-tenant boundary to meter. Allocation needs the invoice
// amount, and until this collector the only way to get it was an operator
// reading the DeepInfra dashboard and writing SQL. That is a step nobody
// performs reliably every month, and the failure mode is silent: with no
// infra_costs row the dashboard reports inference as $0, which reads as
// "no spend" rather than "nobody entered the bill". A cost ledger whose biggest
// number defaults to zero is worse than no ledger.
//
// Docs: https://docs.deepinfra.com/api-reference/billing/usage.md
//       https://docs.deepinfra.com/api-reference/billing/list-invoices.md
// Note the path prefix is /payment/, NOT /v1/ — the inference API and the
// billing API live on different roots on the same host.

const USAGE_URL = 'https://api.deepinfra.com/payment/usage';

// ⚠ MONETARY AMOUNTS FROM THIS API ARE IN CENTS. Getting this wrong is a 100x
// error in a financial record, so it is not assumed — it was confirmed three
// independent ways on 2026-07-27 against the live account:
//
//   1. The API's per-token `rate` for GLM-5.2 input is 9.3e-05. The published
//      price is $0.93 per 1M tokens = 9.3e-07 $/token. The ratio is exactly 100.
//      The same holds for output (0.0003 vs $3.00/M) and cached input
//      (1.8e-05 vs $0.18/M) — all three of our seeded cost_rates.
//   2. sum(items[].units * items[].rate) reproduces `total_cost` (3730.50 vs
//      3731), so `total_cost` carries the same unit as `rate`.
//   3. Decisive: /payment/invoices returns STRIPE invoice objects
//      (id `in_…`, hosted_invoice_url on stripe.com) whose `total` is 1000 for a
//      prepayment. Stripe amounts are always in the currency's minor unit, so
//      that is a $10.00 top-up — the standard DeepInfra credit purchase.
//
// If DeepInfra ever switches to major units this converts a $37 bill into
// $3,731. The guard below catches the shape of that change rather than trusting
// this constant forever.
const CENTS_PER_USD = 100;

// HOW WE DETECT THE UNIT CHANGING UNDER US.
//
// An absolute "this total looks too big" ceiling was tried first and is the
// WRONG guard, in both directions:
//   * too large to catch the realistic case — a 100x error on a $37 bill is
//     $3,731, which any ceiling loose enough not to block real growth permits;
//   * blind to the dangerous direction — if DeepInfra switches to major units
//     they send 37.31 where they used to send 3731, and dividing by 100 yields
//     $0.37. That is a 100x UNDER-report, and a cost figure that is quietly low
//     is the precise failure this ledger exists to prevent. No ceiling sees it.
//
// The unit lives in `rate` (per-token price), not in the total — and `rate` is
// independent of volume, so it is a stable thing to check. We already hold the
// dollar truth for DeepInfra's SKUs in cost_rates ($0.93/$3.00/$0.18 per 1M,
// verified against the vendor's own `estimated_cost` to ten decimal places), so
// the assertion is simply: at least one line item must price at a known rate x100.
//
// "At least one", not "all": DeepInfra adding a model we have not seeded is
// normal and must not block collection, whereas a unit change moves EVERY rate
// at once and so leaves nothing matching.
const RATE_MATCH_TOLERANCE = 0.02; // 2% — absorbs rounding in the published rate

export interface DeepinfraMonthUsage {
  period: string; // 'YYYY.MM' as DeepInfra returns it
  totalUsd: number;
  // DeepInfra reports an invoice id only once the month settles. While the month
  // is open it is absent or the literal string 'INVALID' — which is exactly the
  // distinction the ledger's source column already models, so it maps straight
  // through and the dashboard marks an open month's figure as an estimate.
  settled: boolean;
  // Per-unit rates as the API stated them, carried through purely so the caller
  // can verify the currency unit against the price book (see RATE_MATCH_TOLERANCE).
  rates: number[];
}

interface UsageResponseMonth {
  period?: unknown;
  total_cost?: unknown;
  invoice_id?: unknown;
  items?: unknown;
}

export interface UsageDeps {
  // Injected so tests never touch the network and never need a billing key.
  fetchImpl?: typeof fetch;
  apiKey?: string;
}

// Resolve the key that can read THIS account's billing.
//
// DEEPINFRA_BILLING_API_KEY wins when set. Otherwise fall back to
// INFERENCE_API_KEY — but only when the spine is actually pointed at DeepInfra,
// because that variable holds whatever the ACTIVE provider's key is. After a
// failover to NVIDIA (the documented standby) it is an NVIDIA key, and sending
// it to api.deepinfra.com would 401 every 15 minutes for a condition that is not
// an error. Returning undefined makes the step skip cleanly instead.
export function billingApiKey(): string | undefined {
  const explicit = process.env.DEEPINFRA_BILLING_API_KEY?.trim();
  if (explicit) return explicit;
  const base = process.env.INFERENCE_BASE_URL || '';
  const pointedAtDeepinfra =
    process.env.MODEL_PROVIDER !== 'anthropic' &&
    (base === '' || /(^|\.)deepinfra\.com/i.test(safeHost(base)));
  const inference = process.env.INFERENCE_API_KEY?.trim();
  return pointedAtDeepinfra && inference ? inference : undefined;
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// 'YYYY-MM-DD' (or any ISO instant) -> 'YYYY.MM', the API's period format.
export const toDeepinfraPeriod = (iso: string): string => iso.slice(0, 7).replace('-', '.');

// Fetch one or more months of usage. `from`/`to` are 'YYYY.MM'.
export async function fetchDeepinfraUsage(
  from: string,
  to: string,
  deps: UsageDeps = {},
): Promise<DeepinfraMonthUsage[]> {
  const key = deps.apiKey ?? billingApiKey();
  if (!key) throw new Error('no DeepInfra billing key available');
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${USAGE_URL}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await doFetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    // Truncated: an upstream error body can be an entire HTML page.
    throw new Error(`deepinfra usage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { months?: unknown };
  const months = Array.isArray(body.months) ? (body.months as UsageResponseMonth[]) : [];
  const out: DeepinfraMonthUsage[] = [];
  for (const m of months) {
    const cents = m.total_cost;
    // A month with no spend is a legitimate 0; a month whose total is missing or
    // non-numeric is a shape change, and writing 0 for it would silently erase a
    // real bill that is already in the ledger. Skip it and let the caller report.
    if (typeof cents !== 'number' || !Number.isFinite(cents)) continue;
    const rates = (Array.isArray(m.items) ? m.items : [])
      .map((i) => (i as { rate?: unknown }).rate)
      .filter((r): r is number => typeof r === 'number' && Number.isFinite(r) && r > 0);
    out.push({
      period: typeof m.period === 'string' ? m.period : from,
      totalUsd: cents / CENTS_PER_USD,
      settled: typeof m.invoice_id === 'string' && m.invoice_id !== '' && m.invoice_id !== 'INVALID',
      rates,
    });
  }
  return out;
}

export interface CollectResult {
  months: Array<{
    period: string;
    amountUsd: number;
    source: 'invoice' | 'estimate';
    created: boolean;
    allocation: InfraAllocation;
  }>;
  // Months the API returned that were NOT written, with the reason. Surfaced in
  // the cron summary rather than thrown: one implausible month must not stop the
  // other from being recorded.
  rejected: Array<{ period: string; reason: string }>;
}

export interface CollectDeps extends UsageDeps {
  record?: typeof recordVendorInvoiceAmount;
  // The DeepInfra dollar rates we believe in — cost_rates, by default. Injected
  // so the unit check is testable without a database.
  knownRatesUsd?: () => Promise<number[]>;
}

// Does at least one line item price at a rate we recognise, once converted to
// the API's cents unit? See RATE_MATCH_TOLERANCE for why this is the check.
//
// Returns true when we have nothing to compare against (an empty price book or a
// month with no itemised rates): the check is a tripwire for a unit change, and
// a tripwire that fires when it simply cannot see is worse than one that abstains
// — it would block collection of a real bill, which is the silent under-report
// from the other direction.
export function ratesLookLikeCents(apiRates: number[], knownUsdRates: number[]): boolean {
  if (apiRates.length === 0 || knownUsdRates.length === 0) return true;
  const expectedCents = knownUsdRates.map((r) => r * CENTS_PER_USD);
  return apiRates.some((api) =>
    expectedCents.some((exp) => exp > 0 && Math.abs(api - exp) / exp <= RATE_MATCH_TOLERANCE),
  );
}

// The ledger row this collector owns. Matches what an operator would have typed,
// so a hand-entered row is UPDATED rather than duplicated (the key is
// vendor+item+period_start).
const VENDOR = 'deepinfra';
const ITEM = 'agent inference';

// Default only — an existing row keeps the operator's chosen rule. per_sandbox
// because each sandbox is one running agent, which is the closest available
// proxy for who consumed the inference. The design's per_spine_tool_call is a
// better proxy once the spine counter has a full month behind it; switching is
// an operator decision, and this collector will not overwrite it.
const DEFAULT_ALLOCATION: InfraAllocation = 'per_sandbox';

const monthEnd = (firstOfMonth: string): string => {
  const d = new Date(`${firstOfMonth}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0); // day 0 of the next month = last day of this one
  return d.toISOString().slice(0, 10);
};

const periodToMonthStart = (period: string): string => `${period.replace('.', '-')}-01`;

// The DeepInfra rates currently in force, in dollars — the price book is the
// only place that already knows what a DeepInfra token is supposed to cost.
async function defaultKnownRatesUsd(): Promise<number[]> {
  const rates = await listCurrentRates();
  return rates.filter((r) => r.provider === VENDOR).map((r) => Number(r.unit_cost_usd));
}

// Collect the current month and the previous one.
//
// Both, for the same reason costRollup recomputes both: a month's figure is not
// final when the month ends. An open month's estimate is refreshed every tick,
// and once DeepInfra settles it the invoice_id appears and the row flips from
// 'estimate' to 'invoice' — which the dashboard shows, because an estimate must
// never render as a metered fact.
export async function collectDeepinfraUsage(
  nowIso: string,
  deps: CollectDeps = {},
): Promise<CollectResult> {
  const currentStart = `${nowIso.slice(0, 7)}-01`;
  const prev = new Date(`${currentStart}T00:00:00.000Z`);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const previousStart = prev.toISOString().slice(0, 10);

  const usage = await fetchDeepinfraUsage(
    toDeepinfraPeriod(previousStart),
    toDeepinfraPeriod(currentStart),
    deps,
  );

  const record = deps.record ?? recordVendorInvoiceAmount;
  const knownRates = await (deps.knownRatesUsd ?? defaultKnownRatesUsd)();
  const result: CollectResult = { months: [], rejected: [] };
  for (const m of usage) {
    const periodStart = periodToMonthStart(m.period);
    if (m.totalUsd < 0) {
      result.rejected.push({ period: m.period, reason: `negative total $${m.totalUsd}` });
      continue;
    }
    if (!ratesLookLikeCents(m.rates, knownRates)) {
      // Report, never guess. Writing the figure anyway risks a 100x error in
      // either direction; writing nothing leaves the last good value in place and
      // puts the reason in the cron summary where an operator will see it.
      result.rejected.push({
        period: m.period,
        reason:
          `line-item rates [${m.rates.join(', ')}] match no known DeepInfra rate x100 ` +
          `— the API may have changed currency units; NOT written`,
      });
      continue;
    }
    const source = m.settled ? ('invoice' as const) : ('estimate' as const);
    const { created, allocation } = await record({
      vendor: VENDOR,
      item: ITEM,
      periodStart,
      periodEnd: monthEnd(periodStart),
      amountUsd: m.totalUsd,
      source,
      defaultAllocation: DEFAULT_ALLOCATION,
    });
    result.months.push({ period: m.period, amountUsd: m.totalUsd, source, created, allocation });
  }
  return result;
}
