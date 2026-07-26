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
}

// Provider -> the (provider, sku) pair seeded in cost_rates. Keyed on the value
// `activeProvider()` returns, so a MODEL_PROVIDER flip re-prices automatically
// instead of silently billing the wrong vendor.
//
// Phase 3's rollup INNER joins cost_rates, so an event whose sku is not seeded
// is dropped from the dashboard SILENTLY — this map is what keeps the collector
// and the price book speaking the same vocabulary, and costs.test.ts pins it
// against the seed.
export const MODEL_SKUS: Record<string, { provider: string; input: string; output: string }> = {
  // MODEL_PROVIDER unset/'openai' -> GLM-5.2 on DeepInfra (the default since the
  // spine's model calls moved behind runForcedTool).
  openai: { provider: 'deepinfra', input: 'glm-5.2-input', output: 'glm-5.2-output' },
  // Kept whole as an env-var rollback, so its prices stay in the book too.
  anthropic: {
    provider: 'anthropic',
    input: 'claude-sonnet-4-6-input',
    output: 'claude-sonnet-4-6-output',
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
// box shares the same vendor but has no per-tenant boundary, so it arrives via
// the allocated path instead — both land under provider 'deepinfra', separated
// by `method`.
export async function recordModelUsage(
  provider: string,
  usage: ModelUsage | undefined,
  ctx: CostContext | undefined,
  deps: RecorderDeps = {},
): Promise<void> {
  if (!ctx) return; // uninstrumented caller — nothing to attribute this to
  try {
    const skus = MODEL_SKUS[provider];
    if (!skus) throw new Error(`no cost_rates SKUs are mapped for provider '${provider}'`);
    const base = {
      tenantId: ctx.tenantId,
      technicianRef: ctx.technicianRef,
      provider: skus.provider,
      unit: 'token',
      method: 'measured' as const,
    };
    const rows: CostEventInput[] = [];
    if (typeof usage?.inputTokens === 'number') {
      rows.push({ ...base, sku: skus.input, quantity: usage.inputTokens });
    }
    if (typeof usage?.outputTokens === 'number') {
      rows.push({ ...base, sku: skus.output, quantity: usage.outputTokens });
    }
    // Be LOUD about a missing usage block. Silently recording nothing here — an
    // SDK shape change, a gateway that strips the field — would zero the entire
    // model-spend line with no error anywhere. For a ledger, the quiet
    // under-report is the worst failure there is. The throw lands in this
    // function's own catch, so it logs without breaking the call.
    if (rows.length === 0) throw new Error(`usage absent on a ${provider} model call`);
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
    if (error) throw new Error(`backfillBraveCostEvents failed: ${error.message}`);
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

// Flat monthly bills (Lightsail, Render, Supabase, and the DeepInfra invoice).
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
  if (error) throw new Error(`rollupCosts failed: ${error.message}`);
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
//   42883 = undefined_function, 42P01 = undefined_table.
// PostgREST surfaces these as PGRST202 (no matching function) / PGRST205.
export function isMissingCostLedger(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /42883|42P01|PGRST202|PGRST205|could not find the function|does not exist/i.test(text);
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
