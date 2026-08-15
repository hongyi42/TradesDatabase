import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Client as PgClient } from 'pg';
import {
  MODEL_SKUS,
  appendCostEvents,
  backfillBraveCostEvents,
  isMissingCostLedger,
  listCurrentRates,
  readRollup,
  recordModelUsage,
  recordComposioCall,
  readTenantCostDetail,
  rollupCosts,
  upsertInfraCost,
  recordVendorInvoiceAmount,
  type CostEventInput,
} from './costs.js';

// Most of what Phase 1 ships is enforced by the DATABASE, not by TypeScript —
// the overlap exclusion, the one-current-rate index, the method enum, the
// idempotency key. So these tests drive the real local stack and assert on
// Postgres error codes; a passing typecheck proves none of it.
const pg = new PgClient({ connectionString: process.env.DATABASE_URL });

// Everything this file writes is prefixed so cleanup can never touch the seeded
// price book (which the rollup and the provider plan both depend on).
const P = 'test-costs';
let tenantA: string;
let tenantB: string;

// Postgres SQLSTATEs — asserting the CODE, not the message, so a wording change
// upstream doesn't silently turn a real rejection into a passing test.
const UNIQUE_VIOLATION = '23505';
const EXCLUSION_VIOLATION = '23P01';
const CHECK_VIOLATION = '23514';

const codeOf = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

const insertRate = (sku: string, from: string, to: string | null) =>
  pg.query(
    `insert into cost_rates (provider, sku, unit, unit_cost_usd, effective_from, effective_to)
     values ($1, $2, 'token', 0.000001, $3, $4)`,
    [P, sku, from, to],
  );

const cleanup = async () => {
  // The backfill test seeds real web_requests and produces provider='brave'
  // events, so cleanup can't key on the P prefix alone — but it stays scoped to
  // this file's own 'bf-%' technician refs so a real Brave row would survive.
  await pg.query("delete from web_requests where technician_ref like 'bf-%'");
  // ALL cost_events, not an allow-list of providers. The rollup tests write real
  // vendor names (brave, anthropic, deepinfra, spine) and an enumerated list goes
  // stale the moment a test adds another — which it did: 'deepinfra' was missing,
  // so netting-test events survived into the next test and doubled its totals.
  // Every row in this local stack is a test artifact, and vitest runs files
  // sequentially (fileParallelism:false), so a blanket delete is safe.
  await pg.query('delete from cost_events');
  await pg.query('delete from cost_rates where provider like $1', [`${P}%`]);
  // ALL of it, not just the P-prefixed rows: the netting and allocation tests
  // write real vendor names ('deepinfra'), and rollup_costs is GLOBAL — one
  // leaked invoice allocates across every tenant and poisons the next test's
  // absolute totals. infra_costs is empty on a fresh stack, so a blanket delete
  // is safe and makes the file order-independent.
  await pg.query('delete from infra_costs');
  await pg.query('delete from cost_rollup_monthly'); // fully derived — always safe to drop
};

beforeAll(async () => {
  await pg.connect();
  const seeded = await pg.query<{ id: string }>(
    `select id from tenants where name = 'Default Tenant'`,
  );
  if (seeded.rowCount === 0) throw new Error('could not load seed tenant');
  tenantA = seeded.rows[0].id;
  const other = await pg.query<{ id: string }>(
    `insert into tenants (name) values ($1) returning id`,
    [`${P}-tenant-b`],
  );
  tenantB = other.rows[0].id;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await pg.query('delete from tenants where name = $1', [`${P}-tenant-b`]);
  await pg.end();
});

beforeEach(cleanup);

describe('cost_events attribution', () => {
  // Named for what it actually proves: appendCostEvents maps each row to the
  // tenant it was given. It is NOT a test of read isolation — no tenant-scoped
  // cost reader exists yet, and the dashboard's read is deliberately
  // cross-tenant (see readRollup), which is why that surface needs its own auth.
  test('appendCostEvents attributes each row to its own tenant', async () => {
    await appendCostEvents([
      { tenantId: tenantA, provider: P, sku: 'a-only', quantity: 10, unit: 'token', method: 'measured' },
      { tenantId: tenantB, provider: P, sku: 'b-only', quantity: 20, unit: 'token', method: 'measured' },
    ]);
    const a = await pg.query('select sku from cost_events where tenant_id = $1 and provider = $2', [tenantA, P]);
    const b = await pg.query('select sku from cost_events where tenant_id = $1 and provider = $2', [tenantB, P]);
    expect(a.rows.map((r) => r.sku)).toEqual(['a-only']);
    expect(b.rows.map((r) => r.sku)).toEqual(['b-only']);
  });

  // Regression: supabase-js derives PostgREST's ?columns= from the UNION of keys
  // across the batch and PostgREST writes NULL (not DEFAULT) for absentees, so
  // omitting occurred_at on SOME rows used to fail the not-null constraint and
  // throw away the whole batch. Phase 2 batches a dated backfill row alongside
  // live counters, so this mix is the normal case, not an exotic one.
  test('a batch mixing dated and undated rows inserts every row', async () => {
    await appendCostEvents([
      { tenantId: tenantA, provider: P, sku: 'backfilled', quantity: 1, unit: 'request', method: 'measured', occurredAt: '2026-07-02T09:00:00.000Z' },
      { tenantId: tenantA, provider: P, sku: 'live', quantity: 1, unit: 'call', method: 'measured' },
    ]);
    const { rows } = await pg.query(
      'select sku, occurred_at from cost_events where provider = $1 order by sku',
      [P],
    );
    expect(rows.map((r) => r.sku)).toEqual(['backfilled', 'live']);
    expect(new Date(rows[0].occurred_at).toISOString()).toBe('2026-07-02T09:00:00.000Z');
    // The undated row is stamped by the CLIENT clock now (the fix moved it off
    // the DB default), so pin that it lands at "now" rather than merely non-null
    // — non-null is guaranteed by the constraint and would prove nothing.
    expect(Date.now() - new Date(rows[1].occurred_at).getTime()).toBeLessThan(60_000);
  });

  test('method outside the enum is rejected by the database', async () => {
    const code = await codeOf(() =>
      pg.query(
        `insert into cost_events (tenant_id, provider, sku, quantity, unit, method)
         values ($1, $2, 'bad-method', 1, 'token', 'guessed')`,
        [tenantA, P],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('cost_events idempotency key', () => {
  // The Anthropic recorder writes TWO rows per message id (input + output), so
  // the key MUST include sku — keyed on source_ref alone, the second row would
  // be silently dropped and every Anthropic cost would be halved.
  test('same source_ref with different sku both insert; either replayed is ignored', async () => {
    const shared = 'msg_01SHARED';
    const rows = [
      { tenantId: tenantA, provider: P, sku: 'in', quantity: 100, unit: 'token', method: 'measured' as const, sourceRef: shared },
      { tenantId: tenantA, provider: P, sku: 'out', quantity: 20, unit: 'token', method: 'measured' as const, sourceRef: shared },
    ];
    await appendCostEvents(rows);
    await appendCostEvents(rows); // replay — must be a no-op, not an error
    const { rows: found } = await pg.query(
      'select sku from cost_events where provider = $1 and source_ref = $2 order by sku',
      [P, shared],
    );
    expect(found.map((r) => r.sku)).toEqual(['in', 'out']);
  });

  // The per-call spine and relay counters have no vendor id. Postgres treats
  // NULLs as DISTINCT, so every one of them must still insert.
  test('source_ref-less rows are never deduplicated', async () => {
    const row = { tenantId: tenantA, provider: P, sku: 'tool_call', quantity: 1, unit: 'call', method: 'measured' as const };
    await appendCostEvents([row]);
    await appendCostEvents([row]);
    await appendCostEvents([row]);
    const { rows: found } = await pg.query(
      'select count(*)::int as n from cost_events where provider = $1 and sku = $2',
      [P, 'tool_call'],
    );
    expect(found[0].n).toBe(3);
  });
});

describe('cost_rates versioning', () => {
  test('only one open-ended rate per SKU', async () => {
    await insertRate('dup', '2026-07-01', null);
    const code = await codeOf(() => insertRate('dup', '2026-08-01', null));
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  test('two rates covering the same day are rejected', async () => {
    await insertRate('overlap', '2026-07-01', '2026-08-01');
    const code = await codeOf(() => insertRate('overlap', '2026-07-15', '2026-09-01'));
    expect(code).toBe(EXCLUSION_VIOLATION);
  });

  // THE BOUNDARY CASE. daterange is half-open '[)', so a rate ending 08-01 and
  // its successor starting 08-01 do NOT overlap — 08-01 belongs to the new rate
  // alone. This is what lets Phase 3's rollup join with `< effective_to` and
  // price that day exactly once instead of twice.
  test('a rate closed on its successor\'s opening date is accepted', async () => {
    await insertRate('adjacent', '2026-07-01', '2026-08-01');
    const code = await codeOf(() => insertRate('adjacent', '2026-08-01', null));
    expect(code).toBeUndefined();
  });

  test('listCurrentRates returns the seeded book and excludes closed rates', async () => {
    await insertRate('closed', '2026-01-01', '2026-02-01');
    const current = await listCurrentRates();
    // The seeded vocabulary AND its prices. Pinning the (provider, sku) strings
    // alone would let a one-digit typo — 0.0000093 for 0.00000093 — ship green
    // and overstate the DeepInfra line 10x. These numbers are the whole point of
    // the price book, and they have already moved once mid-project.
    const seeded = current.filter((r) => !r.provider.startsWith(P));
    expect(
      seeded.map((r) => `${r.provider}/${r.sku} ${Number(r.unit_cost_usd)}/${r.unit}`).sort(),
    ).toEqual([
      'anthropic/claude-sonnet-4-6-input 0.000003/token',
      'anthropic/claude-sonnet-4-6-output 0.000015/token',
      'deepinfra/glm-5.2-cached-input 1.8e-7/token',
      'deepinfra/glm-5.2-input 9.3e-7/token',
      'deepinfra/glm-5.2-output 0.000003/token',
      // The 2026-08-15 switch target (migration 20260815120000): Fireworks'
      // fast router. The cached-input rate is 1/10th of fresh — real money at
      // our ~90%+ prefix-cache hit rate, and the reason INFERENCE_CACHE_KEY
      // must ride every call.
      'fireworks/glm-5.2-fast-cached-input 2.1e-7/token',
      'fireworks/glm-5.2-fast-input 0.0000021/token',
      'fireworks/glm-5.2-fast-output 0.0000066/token',
      // The NVIDIA failover, $0 by tier not by omission (migration
      // 20260806230000): the rows exist so failover traffic is attributed and
      // counted — "zero dollars with a token count" is data, absence is not.
      'nvidia/glm-5.2-input 0/token',
      'nvidia/glm-5.2-output 0/token',
    ]);
    // Every rate must cite its vendor doc — CLAUDE.md's rule, and the only way a
    // future reader can re-verify a price that has gone stale.
    expect(seeded.every((r) => (r.source_url ?? '').startsWith('https://'))).toBe(true);
    // COUNTERS, deliberately absent from the price book: 'spine' always was;
    // 'brave' and 'composio' joined it (migration 20260730120000) because neither
    // bills per unit from the first one — Brave grants $5/month of credit and
    // Composio's $0.299/1K is an OVERAGE rate past 20,000 included calls. Their
    // units are still recorded for attribution; their dollars come from a bill.
    // 'google' never had a collector in v1.
    expect(
      seeded.some((r) => ['spine', 'google', 'brave', 'composio'].includes(r.provider)),
    ).toBe(false);
    expect(current.some((r) => r.sku === 'closed')).toBe(false);
  });
});

describe('infra_costs', () => {
  // Hand-entered bills: re-entering a month must CORRECT it, never add a second
  // row — a duplicate would inflate every tenant's allocated share.
  test('re-entering a period corrects the amount instead of duplicating', async () => {
    const base = {
      vendor: P,
      item: 'lightsail',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      allocation: 'per_spine_tool_call' as const,
    };
    await upsertInfraCost({ ...base, amountUsd: 40 });
    const corrected = await upsertInfraCost({ ...base, amountUsd: 44 });
    expect(Number(corrected.amount_usd)).toBe(44);
    const { rows } = await pg.query(
      'select count(*)::int as n from infra_costs where vendor = $1 and item = $2',
      [P, 'lightsail'],
    );
    expect(rows[0].n).toBe(1);
  });

  // PostgREST's DO UPDATE only writes columns present in ?columns=, so omitting
  // `source` on a correction used to PRESERVE the old value — a month entered as
  // an estimate then corrected with the real invoice would keep source='estimate'
  // and carry an "est." badge on the dashboard forever.
  test('a correction without an explicit source resets it to invoice', async () => {
    const base = {
      vendor: P,
      item: 'render',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      allocation: 'per_tenant_equal' as const,
    };
    await upsertInfraCost({ ...base, amountUsd: 25, source: 'estimate' });
    const corrected = await upsertInfraCost({ ...base, amountUsd: 31 });
    expect(corrected.source).toBe('invoice');
    expect(Number(corrected.amount_usd)).toBe(31);
  });

  test('an unknown allocation rule is rejected by the database', async () => {
    const code = await codeOf(() =>
      pg.query(
        `insert into infra_costs (vendor, item, period_start, period_end, amount_usd, allocation)
         values ($1, 'bad', '2026-07-01', '2026-07-31', 1, 'per_vibes')`,
        [P],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});

// The automated collector's writer. Its whole reason for existing is the
// allocation-preservation rule below, which cannot be proved with a stub — it is
// a property of the SQL, so it is tested against the real stack.
describe('recordVendorInvoiceAmount', () => {
  const base = {
    vendor: P,
    item: 'agent inference',
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    defaultAllocation: 'per_sandbox' as const,
  };

  test('creates the row with the default allocation when none exists', async () => {
    const r = await recordVendorInvoiceAmount({
      ...base,
      amountUsd: 37.31,
      source: 'estimate',
    });
    expect(r).toEqual({ created: true, allocation: 'per_sandbox' });
    const { rows } = await pg.query(
      'select amount_usd, allocation, source from infra_costs where vendor = $1 and item = $2',
      [P, base.item],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount_usd)).toBeCloseTo(37.31, 2);
    expect(rows[0].source).toBe('estimate');
  });

  // THE point of this accessor. A plain upsert re-sends `allocation` on every
  // write, so a collector running every 15 minutes would silently undo an
  // operator who chose a different split — and the per-tenant figures would move
  // under them with no error anywhere.
  test('PRESERVES an operator-chosen allocation across collector runs', async () => {
    await recordVendorInvoiceAmount({ ...base, amountUsd: 30, source: 'estimate' });
    // The operator decides this month should split by seat instead.
    await pg.query(
      "update infra_costs set allocation = 'per_active_seat' where vendor = $1 and item = $2",
      [P, base.item],
    );
    // ...and the collector ticks again with a refreshed figure.
    const r = await recordVendorInvoiceAmount({ ...base, amountUsd: 37.31, source: 'estimate' });
    expect(r).toEqual({ created: false, allocation: 'per_active_seat' });
    const { rows } = await pg.query(
      'select amount_usd, allocation from infra_costs where vendor = $1 and item = $2',
      [P, base.item],
    );
    expect(rows[0].allocation).toBe('per_active_seat');
    expect(Number(rows[0].amount_usd)).toBeCloseTo(37.31, 2);
  });

  test('flips source estimate -> invoice when the month settles, without duplicating', async () => {
    await recordVendorInvoiceAmount({ ...base, amountUsd: 37.31, source: 'estimate' });
    await recordVendorInvoiceAmount({ ...base, amountUsd: 37.5, source: 'invoice' });
    const { rows } = await pg.query(
      'select count(*)::int as n, max(source) as source from infra_costs where vendor = $1 and item = $2',
      [P, base.item],
    );
    expect(rows[0].n).toBe(1);
    expect(rows[0].source).toBe('invoice');
  });
});

// These drive the recorders through an INJECTED appender, so they need no
// ANTHROPIC_API_KEY and cannot silently skip on CI. That matters: all four live
// Anthropic callers require the key and their sibling tests are
// describe.skipIf(!ANTHROPIC_API_KEY) — a key-gated recorder test would pass by
// skipping while the recorder was broken.
describe('recordModelUsage', () => {
  const capture = () => {
    const seen: CostEventInput[][] = [];
    return { seen, append: async (rows: CostEventInput[]) => void seen.push(rows) };
  };

  test('bills the DEFAULT vendor (GLM on DeepInfra) as two token events', async () => {
    const { seen, append } = capture();
    await recordModelUsage(
      'deepinfra',
      { inputTokens: 4182, outputTokens: 97 },
      { tenantId: tenantA, technicianRef: 'tech-1' },
      { append },
    );
    expect(seen[0].map((r) => [r.provider, r.sku, r.quantity, r.unit, r.method])).toEqual([
      ['deepinfra', 'glm-5.2-input', 4182, 'token', 'measured'],
      ['deepinfra', 'glm-5.2-output', 97, 'token', 'measured'],
    ]);
  });

  // MODEL_PROVIDER=anthropic is the documented env-var rollback, so its SKUs must
  // stay priced too — a flip that billed the wrong vendor would be invisible.
  // prompt_tokens INCLUDES the cached portion, and DeepInfra prices cached input
  // at $0.18/M against $0.93/M fresh. Billing the whole lot at the input rate
  // would over-report the largest measured line by the cache-hit share (~25%).
  test('splits cached input onto its own cheaper SKU', async () => {
    const { seen, append } = capture();
    await recordModelUsage(
      'deepinfra',
      { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 },
      { tenantId: tenantA },
      { append },
    );
    expect(seen[0].map((r) => [r.sku, r.quantity])).toEqual([
      ['glm-5.2-input', 600], // 1000 total - 400 cached
      ['glm-5.2-cached-input', 400],
      ['glm-5.2-output', 50],
    ]);
  });

  test('with no cache figure reported, everything stays on the input line', async () => {
    const { seen, append } = capture();
    await recordModelUsage('deepinfra', { inputTokens: 1000, outputTokens: 50 }, { tenantId: tenantA }, { append });
    expect(seen[0].map((r) => [r.sku, r.quantity])).toEqual([
      ['glm-5.2-input', 1000],
      ['glm-5.2-output', 50],
    ]);
  });

  // 'openai' is a WIRE FORMAT, not a company. Keying the ledger on it would bill
  // an NVIDIA failover against a DeepInfra invoice that never arrives.
  test('an unmapped vendor records nothing and says so', async () => {
    const { seen, append } = capture();
    await recordModelUsage('openai', { inputTokens: 1, outputTokens: 1 }, { tenantId: tenantA }, { append });
    expect(seen).toHaveLength(0);
  });

  test('bills the anthropic rollback under its own SKUs', async () => {
    const { seen, append } = capture();
    await recordModelUsage('anthropic', { inputTokens: 10, outputTokens: 2 }, { tenantId: tenantA }, { append });
    expect(seen[0].map((r) => `${r.provider}/${r.sku}`)).toEqual([
      'anthropic/claude-sonnet-4-6-input',
      'anthropic/claude-sonnet-4-6-output',
    ]);
  });

  test('bills an NVIDIA failover under provider nvidia — not dropped, not deepinfra', async () => {
    // The gap found 2026-08-06: ledgerVendor() was BUILT to return 'nvidia' on
    // a failover host, but MODEL_SKUS had no entry, so recordModelUsage threw
    // into its swallowed catch and failover spend never existed anywhere.
    // "Zero spend" was ambiguous between idle and failed-over.
    const { seen, append } = capture();
    await recordModelUsage('nvidia', { inputTokens: 10, outputTokens: 2 }, { tenantId: tenantA }, { append });
    expect(seen[0].map((r) => `${r.provider}/${r.sku}`)).toEqual([
      'nvidia/glm-5.2-input',
      'nvidia/glm-5.2-output',
    ]);
  });

  test('bills the fireworks switch target under fast-tier SKUs, with the cached split', async () => {
    // The 2026-08-15 provider switch. The cached split is the load-bearing
    // part: at ~90%+ prefix-hit rates the cached line carries most input
    // tokens at 1/10th the fresh rate — billing them as fresh would overstate
    // the Fireworks line ~5x.
    const { seen, append } = capture();
    await recordModelUsage(
      'fireworks',
      { inputTokens: 100, outputTokens: 7, cachedInputTokens: 90 },
      { tenantId: tenantA },
      { append },
    );
    expect(seen[0].map((r) => `${r.provider}/${r.sku}:${r.quantity}`)).toEqual([
      'fireworks/glm-5.2-fast-input:10',
      'fireworks/glm-5.2-fast-cached-input:90',
      'fireworks/glm-5.2-fast-output:7',
    ]);
  });

  test('a cached-token split from a provider without a cachedInput SKU stays on the input line', async () => {
    // NVIDIA's endpoint reports no cached split today; if it ever starts to,
    // the honest fallback is billing everything as fresh input, never a guess
    // against a SKU that does not exist.
    const { seen, append } = capture();
    await recordModelUsage(
      'nvidia',
      { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
      { tenantId: tenantA },
      { append },
    );
    const input = seen[0].find((r) => r.sku === 'glm-5.2-input');
    expect(input?.quantity).toBe(10); // undivided — no cached SKU to split into
  });

  // The rollup INNER joins cost_rates, so an unmapped sku is dropped from the
  // dashboard SILENTLY. Both providers' SKUs must exist in the price book.
  test('every mapped SKU matches a seeded cost_rates row', async () => {
    const current = await listCurrentRates();
    const seeded = new Set(current.map((r) => `${r.provider}/${r.sku}`));
    for (const skus of Object.values(MODEL_SKUS)) {
      expect(seeded.has(`${skus.provider}/${skus.input}`)).toBe(true);
      expect(seeded.has(`${skus.provider}/${skus.output}`)).toBe(true);
    }
  });

  test('a reply with no usage block is reported, not silently skipped', async () => {
    const { seen, append } = capture();
    const errs: unknown[] = [];
    const spy = console.error;
    console.error = (m: unknown) => void errs.push(m);
    try {
      await recordModelUsage('deepinfra', undefined, { tenantId: tenantA }, { append });
    } finally {
      console.error = spy;
    }
    expect(seen).toHaveLength(0);
    expect(String(errs[0])).toContain('usage absent');
  });

  test('no context means no attribution and no write', async () => {
    const { seen, append } = capture();
    await recordModelUsage('deepinfra', { inputTokens: 5, outputTokens: 5 }, undefined, { append });
    expect(seen).toHaveLength(0);
  });

  test('a failing appender is swallowed, not propagated', async () => {
    await expect(
      recordModelUsage('deepinfra', { inputTokens: 1, outputTokens: 1 }, { tenantId: tenantA }, {
        append: async () => { throw new Error('db down'); },
      }),
    ).resolves.toBeUndefined();
  });

  test('recordComposioCall swallows a failing appender too', async () => {
    await expect(
      recordComposioCall({ tenantId: tenantA }, { append: async () => { throw new Error('db down'); } }),
    ).resolves.toBeUndefined();
  });
});

describe('backfillBraveCostEvents', () => {
  const seedSearches = (n: number, ref: string) =>
    pg.query(
      `insert into web_requests (tenant_id, technician_ref, kind, value)
       select $1, $2, 'search', 'q' || g from generate_series(1, $3) g`,
      [tenantA, ref, n],
    );

  test('counts only kind=search, is idempotent, and pages past 1000 rows', async () => {
    // 1050 searches forces a second page — an unpaginated scan would silently
    // stop at PostgREST's 1000-row cap and under-bill by 50.
    await seedSearches(1050, 'bf-search');
    // Neither of these is a Brave charge: search_result is one row per returned
    // URL, and fetch never touches Brave at all.
    await pg.query(
      `insert into web_requests (tenant_id, technician_ref, kind, value)
       values ($1, 'bf-other', 'search_result', 'https://x.example/'),
              ($1, 'bf-other', 'fetch', 'https://y.example/')`,
      [tenantA],
    );
    const first = await backfillBraveCostEvents('2000-01-01T00:00:00.000Z');
    expect(first).toEqual({ scanned: 1050 });
    const after = async () =>
      (await pg.query(`select count(*)::int n from cost_events where provider = 'brave'`)).rows[0].n;
    expect(await after()).toBe(1050);
    // Replayed every cron tick — the web_requests id is the idempotency key, so
    // the second pass scans the same 1050 and inserts none of them.
    expect(await backfillBraveCostEvents('2000-01-01T00:00:00.000Z')).toEqual({ scanned: 1050 });
    expect(await after()).toBe(1050);
  }, 60_000);
});

// The rollup is where units become dollars, so these assert HAND-COMPUTED
// totals rather than shapes: an off-by-one-decimal rate or a double-counted day
// would sail past a structural assertion.
describe('rollupCosts', () => {
  const JULY = '2026-07-01';
  const at = (day: string) => `2026-07-${day}T12:00:00.000Z`;

  const rollupFor = async (tenant: string) =>
    (await readRollup(JULY)).filter((r) => r.tenant_id === tenant);

  test('prices metered events at the seeded rates (hand-computed dollars)', async () => {
    await appendCostEvents([
      // Sonnet input is $3.00 per 1M tokens -> 1,000,000 x 0.000003 = $3.00
      { tenantId: tenantA, provider: 'anthropic', sku: 'claude-sonnet-4-6-input', quantity: 1_000_000, unit: 'token', method: 'measured', occurredAt: at('05'), sourceRef: 'r1' },
      // Sonnet output is $15.00 per 1M -> 100,000 x 0.000015 = $1.50
      { tenantId: tenantA, provider: 'anthropic', sku: 'claude-sonnet-4-6-output', quantity: 100_000, unit: 'token', method: 'measured', occurredAt: at('06'), sourceRef: 'r2' },
      // DeepInfra GLM input is $0.93 per 1M tokens -> 1,000,000 x 0.00000093 = $0.93
      { tenantId: tenantB, provider: 'deepinfra', sku: 'glm-5.2-input', quantity: 1_000_000, unit: 'token', method: 'measured', occurredAt: at('07'), sourceRef: 'r3' },
    ]);
    await rollupCosts(JULY);

    const a = await rollupFor(tenantA);
    expect(a).toHaveLength(1); // both anthropic rows collapse into one provider row
    expect(Number(a[0].cost_usd)).toBeCloseTo(3.0 + 1.5, 6);
    expect(Number(a[0].quantity)).toBe(1_100_000);
    const b = await rollupFor(tenantB);
    expect(Number(b[0].cost_usd)).toBeCloseTo(0.93, 6);
  });

  test('is idempotent — a second run recomputes rather than doubling', async () => {
    await appendCostEvents([
      { tenantId: tenantA, provider: 'deepinfra', sku: 'glm-5.2-input', quantity: 1_000_000, unit: 'token', method: 'measured', occurredAt: at('05'), sourceRef: 'idem' },
    ]);
    await rollupCosts(JULY);
    await rollupCosts(JULY);
    const a = await rollupFor(tenantA);
    expect(a).toHaveLength(1);
    expect(Number(a[0].cost_usd)).toBeCloseTo(0.93, 6);
  });

  // A rate closed on exactly its successor's opening date must price that day
  // ONCE. With an inclusive `between` both rows would match and the day would
  // cost double — the reason the join and the exclusion constraint both use the
  // half-open form.
  test('a rate boundary day is priced once, by the incoming rate', async () => {
    await pg.query(
      `update cost_rates set effective_to = '2026-07-10' where provider = 'deepinfra' and sku = 'glm-5.2-input'`,
    );
    await pg.query(
      `insert into cost_rates (provider, sku, unit, unit_cost_usd, effective_from)
       values ('deepinfra', 'glm-5.2-input', 'token', 0.000002, '2026-07-10')`,
    );
    await appendCostEvents([
      // ON the boundary: belongs to the NEW rate only. 1,000,000 x 0.000002 = $2.00
      { tenantId: tenantA, provider: 'deepinfra', sku: 'glm-5.2-input', quantity: 1_000_000, unit: 'token', method: 'measured', occurredAt: at('10'), sourceRef: 'b1' },
      // Before it: old rate. 1,000,000 x 0.00000093 = $0.93
      { tenantId: tenantA, provider: 'deepinfra', sku: 'glm-5.2-input', quantity: 1_000_000, unit: 'token', method: 'measured', occurredAt: at('09'), sourceRef: 'b2' },
    ]);
    await rollupCosts(JULY);
    const a = await rollupFor(tenantA);
    expect(Number(a[0].cost_usd)).toBeCloseTo(2.93, 6);
    // Restore the seeded book for the other tests in this file.
    await pg.query(`delete from cost_rates where provider = 'deepinfra' and effective_from = '2026-07-10'`);
    await pg.query(`update cost_rates set effective_to = null where provider = 'deepinfra' and sku = 'glm-5.2-input'`);
  });

  // 'spine' is a COUNTER, not a billed vendor: it has no rate, so the measured
  // pass's inner join drops it — while it still drives the allocation split.
  test('spine events cost nothing but do split the infra bill', async () => {
    await appendCostEvents([
      { tenantId: tenantA, provider: 'spine', sku: 'tool_call', quantity: 75, unit: 'call', method: 'measured', occurredAt: at('05'), sourceRef: 's1' },
      { tenantId: tenantB, provider: 'spine', sku: 'tool_call', quantity: 25, unit: 'call', method: 'measured', occurredAt: at('05'), sourceRef: 's2' },
    ]);
    await upsertInfraCost({
      vendor: `${P}-deepinfra`,
      item: 'inference',
      periodStart: JULY,
      periodEnd: '2026-07-31',
      amountUsd: 100,
      allocation: 'per_spine_tool_call',
    });
    await rollupCosts(JULY);

    // No measured row for spine anywhere — it is unpriced by design.
    expect((await readRollup(JULY)).some((r) => r.provider === 'spine')).toBe(false);
    // …but the $100 invoice splits 75/25 by those same counts.
    const a = (await rollupFor(tenantA)).find((r) => r.provider === `${P}-deepinfra`);
    const b = (await rollupFor(tenantB)).find((r) => r.provider === `${P}-deepinfra`);
    expect(a?.method).toBe('allocated');
    expect(Number(a?.cost_usd)).toBeCloseTo(75, 6);
    expect(Number(b?.cost_usd)).toBeCloseTo(25, 6);
  });

  // Zero denominator: a brand-new month with no spine calls yet must not divide
  // by zero, and must not silently attribute the whole bill to nobody.
  // ONE DeepInfra account: its invoice already CONTAINS the spine's own token
  // spend, so allocating the bill whole on top of measuring those tokens counts
  // the same dollars twice. Reproduced before the guard: $9.30 measured + $100
  // invoice = $109.30 reported for $100 of real spend.
  test('a vendor invoice is netted of what we already measured for it', async () => {
    await appendCostEvents([
      { tenantId: tenantA, provider: 'deepinfra', sku: 'glm-5.2-input', quantity: 10_000_000, unit: 'token', method: 'measured', occurredAt: at('05'), sourceRef: 'n1' },
      { tenantId: tenantA, provider: 'spine', sku: 'tool_call', quantity: 100, unit: 'call', method: 'measured', occurredAt: at('05'), sourceRef: 'n2' },
    ]);
    await upsertInfraCost({
      vendor: 'deepinfra', item: 'inference', periodStart: JULY, periodEnd: '2026-07-31',
      amountUsd: 100, allocation: 'per_spine_tool_call',
    });
    await rollupCosts(JULY);
    const rows = (await readRollup(JULY)).filter((r) => r.provider === 'deepinfra');
    const measured = rows.filter((r) => r.method === 'measured').reduce((s, r) => s + Number(r.cost_usd), 0);
    const allocated = rows.filter((r) => r.method === 'allocated').reduce((s, r) => s + Number(r.cost_usd), 0);
    expect(measured).toBeCloseTo(9.3, 6); // 10M x $0.00000093
    expect(allocated).toBeCloseTo(100 - 9.3, 6); // the REMAINDER, not the whole bill
    // The whole point: the two together equal the actual invoice.
    expect(measured + allocated).toBeCloseTo(100, 6);
  });

  test('measurement exceeding the invoice allocates nothing, never a negative', async () => {
    await appendCostEvents([
      { tenantId: tenantA, provider: 'deepinfra', sku: 'glm-5.2-input', quantity: 10_000_000, unit: 'token', method: 'measured', occurredAt: at('05'), sourceRef: 'x1' },
      { tenantId: tenantA, provider: 'spine', sku: 'tool_call', quantity: 5, unit: 'call', method: 'measured', occurredAt: at('05'), sourceRef: 'x2' },
    ]);
    await upsertInfraCost({
      vendor: 'deepinfra', item: 'inference', periodStart: JULY, periodEnd: '2026-07-31',
      amountUsd: 2, allocation: 'per_spine_tool_call', // less than the $9.30 measured
    });
    await rollupCosts(JULY);
    const alloc = (await readRollup(JULY)).filter((r) => r.provider === 'deepinfra' && r.method === 'allocated');
    expect(alloc.every((r) => Number(r.cost_usd) === 0) || alloc.length === 0).toBe(true);
  });

  test('with no spine events the split falls back to equal shares', async () => {
    await upsertInfraCost({
      vendor: `${P}-lightsail`,
      item: 'box',
      periodStart: JULY,
      periodEnd: '2026-07-31',
      amountUsd: 40,
      allocation: 'per_spine_tool_call',
    });
    await rollupCosts(JULY);
    const rows = (await readRollup(JULY)).filter((r) => r.provider === `${P}-lightsail`);
    // The fallback population is tenants we ACTUALLY SERVE — an unfiltered
    // count(*) over `tenants` sweeps in seeded demo rows and abandoned test
    // tenants, diluting the paying customer's share and putting phantom spend on
    // the dashboard. This fires on the first tick after migration and on every
    // previous-month rollup that predates the collectors.
    // Same population the function uses: tenants we actually serve, falling back
    // to ALL tenants when none qualify (so a bill is never allocated to nobody).
    const { rows: [{ n }] } = await pg.query(`select case when q.n > 0 then q.n else (select count(*) from tenants) end::int n
      from (select count(*) n from tenants t
             where exists (select 1 from technicians x where x.tenant_id = t.id and x.state = 'active')
                or exists (select 1 from cost_events e where e.tenant_id = t.id
                             and (e.occurred_at at time zone 'utc')::date >= $1
                             and (e.occurred_at at time zone 'utc')::date < ($1::date + interval '1 month')::date)) q`, [JULY]);
    expect(rows).toHaveLength(n);
    for (const r of rows) expect(Number(r.cost_usd)).toBeCloseTo(40 / n, 6);
    // And the shares still sum to the whole bill.
    expect(rows.reduce((s, r) => s + Number(r.cost_usd), 0)).toBeCloseTo(40, 6);
  });

  test('two bills from one vendor in a month sum rather than overwrite', async () => {
    for (const [item, amount] of [['a', 10], ['b', 30]] as const) {
      await upsertInfraCost({
        vendor: `${P}-render`, item, periodStart: JULY, periodEnd: '2026-07-31',
        amountUsd: amount, allocation: 'per_tenant_equal',
      });
    }
    await rollupCosts(JULY);
    const rows = (await readRollup(JULY)).filter((r) => r.provider === `${P}-render`);
    // Same served-tenant population the allocator uses (see the sibling test
    // above) — an unfiltered count(*) sweeps in abandoned eval-world tenants,
    // which accumulate on a long-lived local stack (world rebuilds recreate
    // active technicians only for the NEWEST world) and made this assertion
    // stack-age-dependent.
    const { rows: [{ n }] } = await pg.query(`select case when q.n > 0 then q.n else (select count(*) from tenants) end::int n
      from (select count(*) n from tenants t
             where exists (select 1 from technicians x where x.tenant_id = t.id and x.state = 'active')
                or exists (select 1 from cost_events e where e.tenant_id = t.id
                             and (e.occurred_at at time zone 'utc')::date >= $1
                             and (e.occurred_at at time zone 'utc')::date < ($1::date + interval '1 month')::date)) q`, [JULY]);
    expect(rows.reduce((s, r) => s + Number(r.cost_usd), 0)).toBeCloseTo(40, 6);
    expect(rows).toHaveLength(n);
  });

  // An unpriced event drops out of the INNER join with no error — the dashboard
  // then reads "no spend" when the truth is "no rate". Nothing forces cost_rates
  // to cover every day, so closing a rate without opening its successor does
  // exactly this. The count is the operator's only signal.
  test('reports events that fell out of the join unpriced', async () => {
    await appendCostEvents([
      { tenantId: tenantA, provider: 'deepinfra', sku: 'glm-5.2-input', quantity: 1_000, unit: 'token', method: 'measured', occurredAt: at('05'), sourceRef: 'p1' },
      // A GAP: 'anthropic' IS a priced provider, but no rate was ever seeded for
      // this sku. Exactly what the signal exists to catch.
      { tenantId: tenantA, provider: 'anthropic', sku: 'claude-sonnet-9-input', quantity: 500, unit: 'token', method: 'measured', occurredAt: at('05'), sourceRef: 'p2' },
      // spine is unpriced BY DESIGN and must never be counted as a gap.
      { tenantId: tenantA, provider: 'spine', sku: 'tool_call', quantity: 4, unit: 'call', method: 'measured', occurredAt: at('05'), sourceRef: 'p3' },
    ]);
    const result = await rollupCosts(JULY);
    expect(result.unpricedEvents).toBe(1);
  });

  // The predicate is derived from the price book, not a hardcoded name list: a
  // provider with NO rate rows at all is a counter by design. Without this,
  // unpricing Brave and Composio would report every one of their events as a
  // price-book gap on every 15-minute tick — training operators to ignore the
  // one signal that catches a real hole (migration 20260730120000).
  test('a provider with NO rates is a counter, not a gap', async () => {
    await appendCostEvents([
      { tenantId: tenantA, provider: 'brave', sku: 'search', quantity: 10, unit: 'request', method: 'measured', occurredAt: at('05'), sourceRef: 'c1' },
      { tenantId: tenantA, provider: 'composio', sku: 'tool_call', quantity: 5, unit: 'call', method: 'measured', occurredAt: at('05'), sourceRef: 'c2' },
      { tenantId: tenantA, provider: 'spine', sku: 'tool_call', quantity: 3, unit: 'call', method: 'measured', occurredAt: at('05'), sourceRef: 'c3' },
    ]);
    const result = await rollupCosts(JULY);
    expect(result.unpricedEvents).toBe(0);
  });

  // The other half of the same predicate: having SOME rate is what makes a
  // missing one a fault. An event outside every window for a priced provider is
  // a real gap and must still fire.
  test('a priced provider with an event outside every rate window IS a gap', async () => {
    await pg.query(
      `update cost_rates set effective_to = '2026-07-15' where provider = 'deepinfra' and sku = 'glm-5.2-output'`,
    );
    await appendCostEvents([
      { tenantId: tenantA, provider: 'deepinfra', sku: 'glm-5.2-output', quantity: 100, unit: 'token', method: 'measured', occurredAt: at('20'), sourceRef: 'g1' },
    ]);
    const result = await rollupCosts(JULY);
    expect(result.unpricedEvents).toBe(1);
    await pg.query(
      `update cost_rates set effective_to = null where provider = 'deepinfra' and sku = 'glm-5.2-output'`,
    );
  });

  // Unpricing removes a vendor from the DOLLAR surface but not from the ledger:
  // the measured pass INNER joins cost_rates, so brave produces no rollup row —
  // while its cost_events rows survive as the per-tenant attribution basis.
  test('an unpriced vendor keeps its units but produces no rollup row', async () => {
    await appendCostEvents([
      { tenantId: tenantA, provider: 'brave', sku: 'search', quantity: 12, unit: 'request', method: 'measured', occurredAt: at('05'), sourceRef: 'u1' },
    ]);
    await rollupCosts(JULY);
    expect((await rollupFor(tenantA)).filter((r) => r.provider === 'brave')).toHaveLength(0);
    const detail = await readTenantCostDetail(tenantA, JULY);
    const line = detail.find((d) => d.provider === 'brave' && d.sku === 'search');
    expect(line?.quantity).toBe(12);  // units survive
    expect(line?.costUsd).toBeNull(); // rendered as '—' on the tenant page
  });

  // A rate covering PART of the month must not render as a priced fact that is
  // silently low: the unmatched events would each contribute quantity * 0.
  test('a partially-priced sku reports as NOT PRICED, not as a low number', async () => {
    await pg.query(`update cost_rates set effective_to = '2026-07-15' where provider = 'deepinfra' and sku = 'glm-5.2-input'`);
    await appendCostEvents([
      { tenantId: tenantA, provider: 'deepinfra', sku: 'glm-5.2-input', quantity: 1, unit: 'token', method: 'measured', occurredAt: at('10'), sourceRef: 'pp1' },
      { tenantId: tenantA, provider: 'deepinfra', sku: 'glm-5.2-input', quantity: 1, unit: 'token', method: 'measured', occurredAt: at('20'), sourceRef: 'pp2' },
    ]);
    const detail = await readTenantCostDetail(tenantA, JULY);
    const line = detail.find((d) => d.sku === 'glm-5.2-input');
    expect(line?.quantity).toBe(2);   // both events counted
    expect(line?.costUsd).toBeNull(); // but NOT priced — half the month has no rate
    await pg.query(`update cost_rates set effective_to = null where provider = 'deepinfra' and sku = 'glm-5.2-input'`);
  });

  test('a mid-month period_start is refused, not silently double-counted', async () => {
    // The DELETE only clears the exact period_start it is given, so a mid-month
    // argument would write a SECOND set of rows for events already rolled up
    // under the 1st — invisible per-month, but doubling any cross-period sum.
    await expect(rollupCosts('2026-07-15')).rejects.toThrow(/first of a month/i);
  });

  test('an idle tenant gets no $0.00 allocated row', async () => {
    await appendCostEvents([
      { tenantId: tenantA, provider: 'spine', sku: 'tool_call', quantity: 10, unit: 'call', method: 'measured', occurredAt: at('05'), sourceRef: 'z1' },
    ]);
    await upsertInfraCost({
      vendor: `${P}-box`, item: 'host', periodStart: JULY, periodEnd: '2026-07-31',
      amountUsd: 50, allocation: 'per_spine_tool_call',
    });
    await rollupCosts(JULY);
    const rows = (await readRollup(JULY)).filter((r) => r.provider === `${P}-box`);
    expect(rows).toHaveLength(1); // only the tenant that actually used anything
    expect(Number(rows[0].cost_usd)).toBeCloseTo(50, 6);
  });

  test('events outside the month are excluded', async () => {
    await appendCostEvents([
      { tenantId: tenantA, provider: 'deepinfra', sku: 'glm-5.2-input', quantity: 1_000_000, unit: 'token', method: 'measured', occurredAt: '2026-06-30T23:00:00.000Z', sourceRef: 'out1' },
      { tenantId: tenantA, provider: 'deepinfra', sku: 'glm-5.2-input', quantity: 1_000_000, unit: 'token', method: 'measured', occurredAt: '2026-08-01T00:00:00.000Z', sourceRef: 'out2' },
      { tenantId: tenantA, provider: 'deepinfra', sku: 'glm-5.2-input', quantity: 1_000_000, unit: 'token', method: 'measured', occurredAt: at('31'), sourceRef: 'in1' },
    ]);
    await rollupCosts(JULY);
    expect(Number((await rollupFor(tenantA))[0].cost_usd)).toBeCloseTo(0.93, 6);
  });
});

// This predicate decides SKIP vs FAIL for the cron. Too narrow and the
// heartbeat goes red every 15 minutes until the pilot migration lands; too broad
// and a genuine outage is silently reported as "not migrated yet" and nobody is
// paged. Both directions are pinned.
describe('isMissingCostLedger', () => {
  // Recognised only when the STRUCTURED CODE is present — as a delimited token in
  // the message, or on the wrapped cause. The accessors attach the PostgrestError
  // as `cause` precisely so this predicate has a code to read.
  test('recognises the not-yet-migrated shapes by code', () => {
    for (const m of [
      'Could not find the function public.rollup_costs(p_period_start) in the schema cache (PGRST202)',
      'ERROR: 42P01: relation "cost_rollup_monthly" does not exist',
      'function rollup_costs(date) does not exist (42883)',
      "Could not find the table 'public.cost_rates' in the schema cache (PGRST205)",
    ]) {
      expect(isMissingCostLedger(new Error(m))).toBe(true);
    }
    // The real PostgREST shape the cron actually sees: code on the cause.
    for (const code of ['42883', '42P01', 'PGRST202', 'PGRST205']) {
      const err = new Error('rollupCosts failed: something', { cause: { code } });
      expect(isMissingCostLedger(err)).toBe(true);
    }
  });

  test('does NOT swallow real faults', () => {
    for (const m of [
      'connection terminated unexpectedly',
      'timeout expired',
      'permission denied for table cost_events',
      'duplicate key value violates unique constraint',
      'JWT expired',
      // The dangerous class: a HALF-APPLIED migration or a botched rename says
      // "does not exist" too. Swallowing these would leave a green cron and an
      // empty ledger forever, which reads as "no spend" — the silent
      // under-report this whole design exists to avoid.
      'column cost_events.occurred_at does not exist',
      'relation "technicians" does not exist',
      'column "unpriced_events" does not exist',
    ]) {
      expect(isMissingCostLedger(new Error(m))).toBe(false);
    }
  });

  test('recognises a structured PostgrestError code on the cause', () => {
    const err = Object.assign(new Error('wrapped'), { cause: { code: '42P01' } });
    expect(isMissingCostLedger(err)).toBe(true);
  });
});

describe('readRollup', () => {
  // The operator dashboard is deliberately CROSS-tenant — this read returns every
  // tenant for the period, which is exactly why its HTTP surface needs its own
  // auth rather than the board's one-roster-row model.
  test('returns every tenant for the period, and nothing from other periods', async () => {
    for (const [tenant, cost] of [[tenantA, 12.5], [tenantB, 7.25]] as const) {
      await pg.query(
        `insert into cost_rollup_monthly (tenant_id, period_start, provider, method, cost_usd, quantity)
         values ($1, '2026-07-01', $2, 'measured', $3, 1)`,
        [tenant, P, cost],
      );
    }
    await pg.query(
      `insert into cost_rollup_monthly (tenant_id, period_start, provider, method, cost_usd, quantity)
       values ($1, '2026-06-01', $2, 'measured', 99, 1)`,
      [tenantA, P],
    );
    const july = (await readRollup('2026-07-01')).filter((r) => r.provider === P);
    expect(july).toHaveLength(2);
    expect(july.map((r) => Number(r.cost_usd)).sort((a, b) => a - b)).toEqual([7.25, 12.5]);
  });
});
