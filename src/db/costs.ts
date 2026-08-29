import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';

export type CostRate = Database['public']['Tables']['cost_rates']['Row'];
export type CostEvent = Database['public']['Tables']['cost_events']['Row'];
export type InfraCost = Database['public']['Tables']['infra_costs']['Row'];
export type CostRollupRow = Database['public']['Tables']['cost_rollup_monthly']['Row'];

// 'measured' = we counted the units. 'allocated' = we split a bill by a proxy
// metric. Every read surface must show which, so an estimate never renders like
// a metered fact (the durationAssumption / driveMeasured:false precedent).
export type CostMethod = 'measured' | 'allocated';

export type InfraAllocation =
  | 'per_active_seat'
  | 'per_sandbox'
  | 'per_tenant_equal'
  | 'per_spine_tool_call'
  | 'unallocated';

// UNITS, never dollars: quantity is the raw measured count in `unit` (4182
// tokens, 1 request). Dollars are derived at read time against cost_rates, so
// history re-prices when a vendor changes its rates — which they do, faster than
// you would expect (DeepInfra moved $0.95 -> $0.93 inside three days).
export interface CostEventInput {
  tenantId: string;
  technicianRef?: string | null;
  provider: string;
  sku: string;
  quantity: number;
  unit: string;
  method: CostMethod;
  // Defaults to now(). Pass it when back-filling from an existing ledger so the
  // event prices against the rate in force on the day it really happened.
  occurredAt?: string;
  // The vendor's own id for this unit of work. Present = the write is REPLAYABLE:
  // the (provider, sku, source_ref) constraint makes a re-run a no-op, which is
  // what lets the Brave backfill re-read the same web_requests rows every tick.
  // Absent = every call inserts (Postgres treats NULLs as distinct), which is
  // what the per-call spine and relay counters want.
  sourceRef?: string | null;
  metadata?: Json;
}

// One batched insert per collector call. ignoreDuplicates makes this an
// ON CONFLICT DO NOTHING, so a replayed collector is a no-op rather than an
// error — collectors run on a cron and MUST be safe to re-run.
export async function appendCostEvents(rows: CostEventInput[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await getClient()
    .from('cost_events')
    .upsert(
      rows.map((r) => ({
        tenant_id: r.tenantId,
        technician_ref: r.technicianRef ?? null,
        provider: r.provider,
        sku: r.sku,
        quantity: r.quantity,
        unit: r.unit,
        method: r.method,
        // ALWAYS emit this key, never a conditional spread. supabase-js builds
        // PostgREST's ?columns= from the UNION of keys across the batch, and
        // PostgREST then writes NULL — not DEFAULT — for any row missing one of
        // them. A batch mixing rows with and without occurredAt would therefore
        // violate the not-null constraint and, because we throw on error, lose
        // EVERY row in the batch. That is exactly the shape Phase 2 creates when
        // a dated backfill row shares a batch with a live counter.
        occurred_at: r.occurredAt ?? new Date().toISOString(),
        source_ref: r.sourceRef ?? null,
        metadata: r.metadata ?? null,
      })),
      { onConflict: 'tenant_id,provider,sku,source_ref', ignoreDuplicates: true },
    );
  if (error) throw new Error(`appendCostEvents failed: ${error.message}`);
}

// ── Collectors ──────────────────────────────────────────────────────────────
// Every recorder below is FAILURE-ISOLATED: cost accounting must never break the
// thing it measures. A vendor call that succeeded but whose cost we failed to
// write is a missing row; a vendor call we broke while trying to bill it is an
// outage. The `driveMeasured:false` precedent — degrade, never propagate.

// Who this spend belongs to. Optional at every seam, so an uninstrumented caller
// (or a test stub) simply records nothing rather than failing.
export interface CostContext {
  tenantId: string;
  technicianRef?: string | null;
  // WHICH part of the system caused this spend. The planner and the reflector
  // both bill as TEAM_LEAD_REF — one is the ladder's model call, the other the
  // nightly distiller — so `technician_ref = 'spine:team-lead'` returns the two
  // added together and no filter could separate them. Written into
  // cost_events.metadata (a column that already existed and was never used on
  // model rows), so no migration and no change to what any existing column
  // means. Optional: an unlabelled caller records exactly what it does today.
  lane?: string | null;
}

// Injectable appender so the recorders are unit-testable with NO API key. The
// four Anthropic callers all require ANTHROPIC_API_KEY and their sibling tests
// are describe.skipIf(!ANTHROPIC_API_KEY) — without this seam a recorder test
// would silently skip on CI and pass while broken.
export interface RecorderDeps {
  append?: typeof appendCostEvents;
}

// What one model call consumed. Optional throughout: a provider that stops
// returning a usage block must not break the call — the recorder reports it.
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Cache WRITES (Anthropic cache_creation_input_tokens): a separate price
   *  tier — 2x base on the 1h TTL — never a read, never fresh. */
  cacheWriteTokens?: number;
  // Cached prompt tokens, when the provider reports them. Fireworks prices these
  // at $0.21/M against $2.10/M fresh — a 10x difference on the line that
  // dominates the bill (recorded input:output ratio ~230:1). Billing them at the
  // full input rate would over-report the largest measured figure by roughly the
  // cache-hit share, which on our doctrine-prefix call shape is most of it.
  cachedInputTokens?: number;
}

// Ledger vendor -> the (provider, sku) triple seeded in cost_rates.
//
// Phase 3's rollup INNER joins cost_rates, so an event whose sku is not seeded
// is dropped from the dashboard SILENTLY — this map is what keeps the collector
// and the price book speaking the same vocabulary, and costs.test.ts pins it
// against the seed.
//
// Keyed on the LEDGER VENDOR, not the wire format. 'openai' is a protocol, not a
// company: INFERENCE_BASE_URL decides who actually serves (and bills) the
// request. Keying on activeProvider() instead would stamp one vendor's name on
// another vendor's traffic the moment the endpoint is repointed — and the bill
// it was priced against never arrives. (There is no failover lane as of
// 2026-08-19; the map still matters because the ENDPOINT can be repointed.)
export const MODEL_SKUS: Record<string, { provider: string; input: string; output: string; cachedInput?: string; cacheWrite?: string }> = {
  // 'deepinfra' was removed here 2026-08-19 when the provider was retired. Its rows in
  // cost_rates DELIBERATELY REMAIN: this map is the WRITE path (which SKU to stamp on a new
  // event), while the rollup prices HISTORY by joining cost_events to cost_rates in SQL.
  // Dropping the rates would make July/August un-priceable and, worse, break the netting
  // below — the measured spend would stop cancelling against the DeepInfra invoice and the
  // whole $43.13 would be allocated on top of tokens already counted.
  //
  // nvidia — a lingering registration nothing routes to (ledgerVendor derives it from the resolved
  // INFERENCE_BASE_URL host). Missing until 2026-08-06, which made failover
  // spend INVISIBLE: recordModelUsage threw on the unmapped vendor (swallowed),
  // and the rollup's INNER join on cost_rates would have dropped any event
  // anyway. Rates are seeded at $0 (free evaluation tier) — the point is the
  // token counts and the provider attribution, not the dollars. No cachedInput:
  // NVIDIA's OpenAI-compatible endpoint does not report a cached-token split.
  nvidia: {
    provider: 'nvidia',
    input: 'glm-5.2-input',
    output: 'glm-5.2-output',
  },
  // The 2026-08-15 provider switch (Fireworks fast router — same GLM-5.2
  // weights, distinct skus because the fast tier is the priced thing). The
  // cached-input split matters: ~90%+ of spine input is the stable doctrine
  // prefix, billed at 1/10th when the call carries INFERENCE_CACHE_KEY.
  fireworks: {
    provider: 'fireworks',
    input: 'glm-5.2-fast-input',
    output: 'glm-5.2-fast-output',
    cachedInput: 'glm-5.2-fast-cached-input',
  },
  // The 2026-08-24 Opus switch (user ruling: planner on Opus 5, costs
  // recorded honestly incl. the 1h-TTL cache tiers). This map is per-VENDOR:
  // it assumes ANTHROPIC_MODEL=claude-opus-5 — a Sonnet rollback must re-edit
  // these SKUs or Sonnet traffic bills at Opus rates (the sonnet rates stay
  // in cost_rates for history).
  anthropic: {
    provider: 'anthropic',
    input: 'claude-opus-5-input',
    output: 'claude-opus-5-output',
    cachedInput: 'claude-opus-5-cached-input',
    cacheWrite: 'claude-opus-5-cache-write-1h',
  },
  // The 2026-08-28 OpenRouter switch. Per-VENDOR like every entry here, so it
  // assumes INFERENCE_MODEL=z-ai/glm-5.3 — a model change must re-edit these
  // SKUs or the new model's traffic bills at GLM 5.3 rates.
  //
  // One honest imprecision, recorded rather than hidden: OpenRouter routes the
  // SAME model id to any of ~10 upstream providers whose prices differ
  // ($1.25-$1.40/M input on GLM 5.3, ~12%). These SKUs carry the list price. The
  // spread stays small because the spine sends no `provider` block and
  // OpenRouter sticky-routes, so the serving provider is stable in practice —
  // and `usage.cost` on every response is the check if that ever stops holding.
  openrouter: {
    provider: 'openrouter',
    input: 'glm-5.3-input',
    output: 'glm-5.3-output',
    cachedInput: 'glm-5.3-cached-input',
    cacheWrite: 'glm-5.3-cache-write',
  },
};

// Bill one spine model call: two events (input + output tokens).
//
// Called from runForcedTool — the SINGLE seam every spine model call passes
// through, and the only place that knows which provider actually served the
// request. Instrumenting the four callers instead would bill whatever vendor
// each one assumed, which stops being true the moment MODEL_PROVIDER flips.
//
// NOTE this is spine spend, where the tenant IS known. Agent inference on the
// box shares the same vendor AND THE SAME ACCOUNT, so its invoice already
// contains these tokens — the rollup nets this measured spend out of the bill
// before allocating the remainder, or the same dollars would be counted twice.
export async function recordModelUsage(
  vendor: string,
  usage: ModelUsage | undefined,
  ctx: CostContext | undefined,
  deps: RecorderDeps = {},
): Promise<void> {
  if (!ctx) return; // uninstrumented caller — nothing to attribute this to
  try {
    const skus = MODEL_SKUS[vendor];
    if (!skus) throw new Error(`no cost_rates SKUs are mapped for vendor '${vendor}'`);
    const base = {
      tenantId: ctx.tenantId,
      technicianRef: ctx.technicianRef,
      provider: skus.provider,
      unit: 'token',
      method: 'measured' as const,
      // On EVERY row this call emits — input, cached-input, cache-write and
      // output are four rows for one model call, and a lane that labelled only
      // some of them would make a per-lane total quietly wrong rather than
      // obviously missing. Safe to spread unconditionally: appendCostEvents
      // always emits the metadata key (see its ?columns= note), so this cannot
      // create the mixed-batch NULL hazard documented there.
      metadata: ctx.lane ? { lane: ctx.lane } : null,
    };
    const rows: CostEventInput[] = [];
    // prompt_tokens INCLUDES cached tokens on OpenAI-compatible endpoints, so
    // the fresh-input count is the difference. Split only when the provider
    // actually reports a cache figure and we have a SKU priced for it —
    // otherwise everything stays on the input line, which is the honest
    // fallback rather than a guess.
    const cached = usage?.cachedInputTokens;
    const splitCache = typeof cached === 'number' && cached > 0 && !!skus.cachedInput;
    if (typeof usage?.inputTokens === 'number') {
      const fresh = splitCache ? Math.max(usage.inputTokens - (cached as number), 0) : usage.inputTokens;
      rows.push({ ...base, sku: skus.input, quantity: fresh });
      if (splitCache) {
        rows.push({ ...base, sku: skus.cachedInput as string, quantity: cached as number });
      }
    }
    // Cache WRITES are their own price tier (2x base on the 1h TTL). A vendor
    // without a cacheWrite SKU folds them into the input line — under-bills
    // 2x→1x, but honest-available beats a guess (the cachedInput doctrine).
    const writes = usage?.cacheWriteTokens;
    if (typeof writes === 'number' && writes > 0) {
      if (skus.cacheWrite) {
        rows.push({ ...base, sku: skus.cacheWrite, quantity: writes });
      } else {
        rows.push({ ...base, sku: skus.input, quantity: writes });
      }
    }
    if (typeof usage?.outputTokens === 'number') {
      rows.push({ ...base, sku: skus.output, quantity: usage.outputTokens });
    }
    // Be LOUD about a missing usage block. Silently recording nothing here — an
    // SDK shape change, a gateway that strips the field — would zero the entire
    // model-spend line with no error anywhere. For a ledger, the quiet
    // under-report is the worst failure there is. The throw lands in this
    // function's own catch, so it logs without breaking the call.
    if (rows.length === 0) throw new Error(`usage absent on a ${vendor} model call`);
    await (deps.append ?? appendCostEvents)(rows);
  } catch (err) {
    console.error(
      `cost: model usage not recorded — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Bill one Composio tool execution. Composio's billed unit is the tool call, so
// this is called at each of the three sites that make one — the doorman relay,
// the outbound send, and the cron's pairing probe. The last two never traverse
// the relay, which is why a relay-only collector would under-report.
export async function recordComposioCall(
  ctx: CostContext | undefined,
  deps: RecorderDeps = {},
): Promise<void> {
  if (!ctx) return;
  try {
    await (deps.append ?? appendCostEvents)([
      {
        tenantId: ctx.tenantId,
        technicianRef: ctx.technicianRef,
        provider: 'composio',
        sku: 'tool_call',
        quantity: 1,
        unit: 'call',
        method: 'measured',
      },
    ]);
  } catch (err) {
    console.error(
      `cost: composio call not recorded — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Brave needs no live instrumentation: web_requests already logs every search
// with its tenant, person, and timestamp. This replays that ledger into
// cost_events, keyed on the web_requests id so re-running each cron tick is a
// no-op rather than a duplicate.
//
// Only kind='search' maps 1:1 to a Brave charge — 'search_result' is one row per
// returned URL and 'fetch' never touches Brave at all. Known over-count, worth
// disclosing rather than hiding: server.ts writes the 'search' row BEFORE the
// network call, so an upstream 429 is counted as a billable search.
//
// Returns rows SCANNED, not rows newly recorded — the upsert ignores duplicates,
// so a steady-state tick re-scans the same window and inserts nothing. Naming it
// `recorded` would have the cron report "1050 recorded" forever. Phase 3 narrows
// the window with a watermark, at which point scanned ≈ newly recorded.
const BACKFILL_PAGE = 1000;

export async function backfillBraveCostEvents(sinceIso: string): Promise<{ scanned: number }> {
  const client = getClient();
  let scanned = 0;
  // Paginate: PostgREST silently caps responses at db-max-rows, so an
  // unpaginated scan would quietly stop billing past the first 1000 searches.
  for (let from = 0; ; from += BACKFILL_PAGE) {
    const { data, error } = await client
      .from('web_requests')
      .select('id, tenant_id, technician_ref, created_at')
      .eq('kind', 'search')
      .gte('created_at', sinceIso)
      .order('created_at')
      .order('id')
      .range(from, from + BACKFILL_PAGE - 1);
    if (error) {
      throw new Error(`backfillBraveCostEvents failed: ${error.message}`, { cause: error });
    }
    const rows = data ?? [];
    if (rows.length > 0) {
      await appendCostEvents(
        rows.map((r) => ({
          tenantId: r.tenant_id,
          technicianRef: r.technician_ref,
          provider: 'brave',
          sku: 'search',
          quantity: 1,
          unit: 'request',
          method: 'measured' as const,
          occurredAt: r.created_at,
          sourceRef: r.id,
        })),
      );
      scanned += rows.length;
    }
    if (rows.length < BACKFILL_PAGE) return { scanned };
  }
}

// The rates in force right now — the open-ended row per SKU. Historical pricing
// is NOT this: the rollup joins by the event's own date, because a rate that has
// been closed still prices the events that happened while it was open.
export async function listCurrentRates(): Promise<CostRate[]> {
  const { data, error } = await getClient()
    .from('cost_rates')
    .select()
    .is('effective_to', null)
    .order('provider')
    .order('sku');
  if (error) throw new Error(`listCurrentRates failed: ${error.message}`);
  return data ?? [];
}

export interface InfraCostInput {
  vendor: string;
  item: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  amountUsd: number;
  allocation: InfraAllocation;
  source?: 'invoice' | 'estimate';
}

// Flat monthly bills (Lightsail, Render, Supabase, and the agent-inference invoice
// — DeepInfra's until 2026-08-19; no Fireworks collector exists yet, see lifecycle.ts).
// Keyed on (vendor, item, period_start) so re-entering a month's bill corrects
// it rather than double-counting — these are hand-entered, and a typo re-entered
// as a second row would inflate every tenant's allocated share.
export async function upsertInfraCost(input: InfraCostInput): Promise<InfraCost> {
  const { data, error } = await getClient()
    .from('infra_costs')
    .upsert(
      {
        vendor: input.vendor,
        item: input.item,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        amount_usd: input.amountUsd,
        allocation: input.allocation,
        // Emitted unconditionally, same rule as occurred_at above. PostgREST's
        // DO UPDATE only sets columns present in ?columns=, so omitting this on
        // a correction PRESERVES the old value: a month first entered as an
        // estimate and later corrected with the real invoice would keep
        // source='estimate' and render with an "est." badge on the dashboard.
        source: input.source ?? 'invoice',
      },
      { onConflict: 'vendor,item,period_start' },
    )
    .select()
    .single();
  if (error || !data) {
    throw new Error(`upsertInfraCost failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

export interface VendorInvoiceInput {
  vendor: string;
  item: string;
  periodStart: string; // YYYY-MM-DD, first of the month
  periodEnd: string; // YYYY-MM-DD
  amountUsd: number;
  source: 'invoice' | 'estimate';
  // Used ONLY when creating the row. An existing row keeps whatever allocation
  // it already has — see below.
  defaultAllocation: InfraAllocation;
}

// Write an automatically-collected vendor bill, WITHOUT clobbering the operator's
// allocation choice.
//
// Why this exists rather than reusing upsertInfraCost: that function emits
// `allocation` unconditionally (it has to — PostgREST's DO UPDATE only touches
// columns present in ?columns=), so an automated collector running every 15
// minutes would reset the rule on every tick. If an operator decided July's
// inference should split `per_active_seat` instead of `per_sandbox`, the next
// cron tick would silently undo them — and the per-tenant figures would change
// under their feet with no error anywhere.
//
// So: UPDATE first, INSERT only if nothing was there. The update deliberately
// omits `allocation`; the insert supplies a default because the column is
// NOT NULL. Amount and source are always refreshed — those ARE the collector's
// job, and a mid-month figure legitimately grows every tick.
export async function recordVendorInvoiceAmount(
  input: VendorInvoiceInput,
): Promise<{ created: boolean; allocation: InfraAllocation }> {
  const client = getClient();
  const { data: updated, error: updateError } = await client
    .from('infra_costs')
    .update({
      amount_usd: input.amountUsd,
      source: input.source,
      period_end: input.periodEnd,
    })
    .eq('vendor', input.vendor)
    .eq('item', input.item)
    .eq('period_start', input.periodStart)
    .select('allocation');
  if (updateError) {
    throw new Error(`recordVendorInvoiceAmount update failed: ${updateError.message}`, {
      cause: updateError,
    });
  }
  if (updated && updated.length > 0) {
    return { created: false, allocation: updated[0].allocation as InfraAllocation };
  }

  const { data: inserted, error: insertError } = await client
    .from('infra_costs')
    .insert({
      vendor: input.vendor,
      item: input.item,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      amount_usd: input.amountUsd,
      allocation: input.defaultAllocation,
      source: input.source,
    })
    .select('allocation')
    .single();
  if (insertError || !inserted) {
    throw new Error(
      `recordVendorInvoiceAmount insert failed: ${insertError?.message ?? 'no row returned'}`,
      { cause: insertError },
    );
  }
  return { created: true, allocation: inserted.allocation as InfraAllocation };
}

export interface RollupResult {
  rowsWritten: number;
  tenantsTouched: number;
  // Events in the period with NO matching rate — spend that silently fell out of
  // the totals. Non-zero means the price book has a gap (a rate closed without a
  // successor, an unseeded sku), which otherwise reads on the dashboard as
  // "no spend" rather than "not priced".
  unpricedEvents: number;
}

// Recompute one month's per-tenant totals. Wraps the RPC so no caller reaches
// for .rpc() directly — all database access goes through src/db/ (CLAUDE.md).
//
// The aggregation deliberately lives in Postgres: PostgREST caps responses at
// 1000 rows, so an app-side sum over cost_events would silently under-report.
//
// Idempotent by construction — it deletes and re-inserts the period, so running
// it every cron tick converges rather than accumulating.
export async function rollupCosts(periodStart: string): Promise<RollupResult> {
  const { data, error } = await getClient().rpc('rollup_costs', { p_period_start: periodStart });
  // `cause` carries the PostgrestError so isMissingCostLedger can read its CODE.
  // Wrapping message-only would leave the predicate with nothing but prose, and
  // prose-matching is exactly what made it swallow real faults.
  if (error) throw new Error(`rollupCosts failed: ${error.message}`, { cause: error });
  const row = (data ?? [])[0];
  return {
    rowsWritten: row?.rows_written ?? 0,
    tenantsTouched: row?.tenants_touched ?? 0,
    unpricedEvents: row?.unpriced_events ?? 0,
  };
}

// Newest Brave event already in the ledger — the backfill's watermark.
//
// Exists because a fixed look-back window silently loses history: on first
// deploy the ledger is empty but `web_requests` has months of searches, and a
// cron outage longer than the window drops everything before it. Returns null
// when nothing has been billed yet, so the caller can sweep from the beginning.
export async function latestBraveCostEventAt(): Promise<string | null> {
  const { data, error } = await getClient()
    .from('cost_events')
    .select('occurred_at')
    .eq('provider', 'brave')
    .order('occurred_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`latestBraveCostEventAt failed: ${error.message}`);
  return data?.[0]?.occurred_at ?? null;
}

// Does this error mean "the cost ledger has not been migrated here yet"?
//
// This exists so the cron can report `{skipped}` instead of `{stepError}` in the
// window between merging this phase and applying the migration to the pilot.
// `main()` exits 1 on ok:false and Render marks the run FAILED, so without this
// the heartbeat would alarm every 15 minutes for a condition that is expected
// and self-resolving. Same shape as the COMPOSIO_API_KEY skip gates.
//
// Matched on the STRUCTURED CODE only, never on message text. A free-text
// `/does not exist/` also swallows `column cost_events.occurred_at does not
// exist` and `relation "technicians" does not exist` — i.e. a half-applied
// migration or a botched rename would report a green cron and an empty ledger
// forever, which reads as "no spend". That silent under-report is the exact
// failure this whole design is built to avoid, and it is likelier than usual
// here: the pilot's ledger is drifted and these migrations are applied by hand,
// one at a time, so a partial apply is a live scenario.
//   42883 = undefined_function · 42P01 = undefined_table
//   PGRST202 = no matching function · PGRST205 = table not in the schema cache
const MISSING_LEDGER_CODES = new Set(['42883', '42P01', 'PGRST202', 'PGRST205']);

export function isMissingCostLedger(err: unknown): boolean {
  // The accessors wrap PostgrestError in an Error, so the code travels on the
  // wrapped cause when present and on the raw object otherwise.
  const candidates = [err, (err as { cause?: unknown })?.cause];
  for (const c of candidates) {
    const code = (c as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && MISSING_LEDGER_CODES.has(code)) return true;
  }
  // Fallback for the wrapped-message case: require the code to appear as a
  // delimited token, so a message merely CONTAINING "does not exist" is not
  // enough — the code must be there.
  const text = err instanceof Error ? err.message : String(err);
  return [...MISSING_LEDGER_CODES].some((code) =>
    new RegExp(`(^|[^0-9A-Za-z])${code}([^0-9A-Za-z]|$)`).test(text),
  );
}

export interface TenantCostDetailRow {
  provider: string;
  sku: string;
  unit: string;
  quantity: number;
  events: number;
  costUsd: number | null; // null = no rate covered this line
}

// Per-sku detail for ONE tenant and month — what the tenant page shows.
//
// Aggregated in Postgres: the spine counter writes one row per tool call, so a
// busy tenant has thousands of cost_events in a month and a client-side rollup
// would silently stop at PostgREST's 1000-row cap. Includes UNPRICED lines
// (cost null) — notably `spine`, which is the inference allocation basis and is
// exactly what an operator opens this page to understand.
export async function readTenantCostDetail(
  tenantId: string,
  periodStart: string,
): Promise<TenantCostDetailRow[]> {
  const { data, error } = await getClient().rpc('tenant_cost_detail', {
    p_tenant_id: tenantId,
    p_period_start: periodStart,
  });
  if (error) throw new Error(`readTenantCostDetail failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    provider: r.provider,
    sku: r.sku,
    unit: r.unit,
    quantity: Number(r.quantity),
    events: r.events,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
  }));
}

// The dashboard's read. Deliberately the ROLLUP table and never raw cost_events:
// PostgREST silently caps responses at db-max-rows (1000, supabase/config.toml)
// — a raw scan would under-report without erroring once a tenant gets busy, and
// a cost figure that is quietly low is worse than no figure at all.
//
// Reading a smaller table SHRINKS that risk but does not remove it: one period
// holds tenants x providers x methods rows, so the cap would bite around a
// hundred tenants — silently, exactly like the scan this function exists to
// avoid. So it pages, using the foldImpact pattern, making the guarantee in the
// paragraph above real rather than aspirational.
const PAGE = 1000;

export async function readRollup(periodStart: string): Promise<CostRollupRow[]> {
  const client = getClient();
  const out: CostRollupRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('cost_rollup_monthly')
      .select()
      .eq('period_start', periodStart)
      .order('tenant_id')
      .order('provider')
      .order('method')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`readRollup failed: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}
