import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  billingApiKey,
  collectDeepinfraUsage,
  fetchDeepinfraUsage,
  toDeepinfraPeriod,
} from './deepinfraUsage.js';

// A trimmed copy of the REAL 2026-07 payload from the live account. Keeping the
// verbatim shape (cents, 'INVALID' invoice id, the /payment/ field names) is the
// point: these tests fail if the vendor's contract drifts from what the
// conversion below assumes.
const liveJulyPayload = {
  months: [
    {
      period: '2026.07',
      interval: { fr: 1782000000000, to: 1784600000000 },
      items: [
        { model: { provider: 'di', model_name: 'zai-org/GLM-5.2' }, units: 35234992, rate: 9.3e-5, cost: 3277 },
        { model: { provider: 'di', model_name: 'zai-org/GLM-5.2' }, units: 353773, rate: 0.0003, cost: 106 },
        { model: { provider: 'di', model_name: 'zai-org/GLM-5.2' }, units: 19270720, rate: 1.8e-5, cost: 347 },
      ],
      total_cost: 3731,
      invoice_id: 'INVALID',
    },
  ],
  initial_month: '2026.07',
};

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

const stubFetch = (body: unknown) => (async () => okResponse(body)) as unknown as typeof fetch;

describe('toDeepinfraPeriod', () => {
  it('converts an ISO date to the API period format', () => {
    expect(toDeepinfraPeriod('2026-07-01')).toBe('2026.07');
    expect(toDeepinfraPeriod('2026-12-31T23:59:59.000Z')).toBe('2026.12');
  });
});

describe('fetchDeepinfraUsage', () => {
  it('converts CENTS to dollars — the live July bill is $37.31, not $3,731', async () => {
    const [july] = await fetchDeepinfraUsage('2026.07', '2026.07', {
      apiKey: 'k',
      fetchImpl: stubFetch(liveJulyPayload),
    });
    expect(july.totalUsd).toBeCloseTo(37.31, 2);
  });

  it("treats the open month's 'INVALID' invoice id as unsettled", async () => {
    const [july] = await fetchDeepinfraUsage('2026.07', '2026.07', {
      apiKey: 'k',
      fetchImpl: stubFetch(liveJulyPayload),
    });
    expect(july.settled).toBe(false);
  });

  it('treats a real invoice id as settled', async () => {
    const settled = {
      months: [{ ...liveJulyPayload.months[0], invoice_id: 'in_1TvQVtAfqHmFttwVA9qlZMUi' }],
    };
    const [m] = await fetchDeepinfraUsage('2026.07', '2026.07', {
      apiKey: 'k',
      fetchImpl: stubFetch(settled),
    });
    expect(m.settled).toBe(true);
  });

  it('records a genuine zero month but SKIPS one whose total is missing', async () => {
    const mixed = {
      months: [
        { period: '2026.06', total_cost: 0, invoice_id: 'in_x' },
        { period: '2026.07', invoice_id: 'INVALID' }, // shape change / no total
      ],
    };
    const out = await fetchDeepinfraUsage('2026.06', '2026.07', {
      apiKey: 'k',
      fetchImpl: stubFetch(mixed),
    });
    // A real $0 month is data; a month with no total is not, and writing 0 for it
    // would erase a bill already in the ledger.
    expect(out.map((m) => m.period)).toEqual(['2026.06']);
    expect(out[0].totalUsd).toBe(0);
  });

  it('throws with a truncated body on a non-2xx', async () => {
    const bad = (async () =>
      ({ ok: false, status: 401, text: async () => 'x'.repeat(500) }) as Response) as unknown as typeof fetch;
    await expect(fetchDeepinfraUsage('2026.07', '2026.07', { apiKey: 'k', fetchImpl: bad })).rejects.toThrow(
      /deepinfra usage 401/,
    );
  });

  it('refuses to call without a key', async () => {
    await expect(
      fetchDeepinfraUsage('2026.07', '2026.07', { apiKey: '', fetchImpl: stubFetch(liveJulyPayload) }),
    ).rejects.toThrow(/no DeepInfra billing key/);
  });
});

describe('collectDeepinfraUsage', () => {
  it('writes the month as an estimate while it is open', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const res = await collectDeepinfraUsage('2026-07-28T03:00:00.000Z', {
      apiKey: 'k',
      fetchImpl: stubFetch(liveJulyPayload),
      record: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return { created: true, allocation: 'per_sandbox' as const };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      vendor: 'deepinfra',
      item: 'agent inference',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      source: 'estimate',
      defaultAllocation: 'per_sandbox',
    });
    expect(calls[0].amountUsd).toBeCloseTo(37.31, 2);
    expect(res.rejected).toEqual([]);
  });

  it('reports the allocation the row actually kept, not the default it proposed', async () => {
    // The operator switched July to per_active_seat; the collector must not
    // silently reset it, and the summary must show what really stands.
    const res = await collectDeepinfraUsage('2026-07-28T03:00:00.000Z', {
      apiKey: 'k',
      fetchImpl: stubFetch(liveJulyPayload),
      record: async () => ({ created: false, allocation: 'per_active_seat' as const }),
    });
    expect(res.months[0].allocation).toBe('per_active_seat');
    expect(res.months[0].created).toBe(false);
  });

  it('REFUSES to write when the API switches to DOLLARS — the 100x UNDER-report', async () => {
    // The dangerous direction, and the one an amount-ceiling can never catch:
    // the same $37.31 bill sent in major units. Naive /100 would record $0.37 and
    // the dashboard would under-report by 100x while looking perfectly normal.
    const asDollars = {
      months: [
        {
          period: '2026.07',
          total_cost: 37.31,
          invoice_id: 'INVALID',
          items: [{ units: 35234992, rate: 9.3e-7 }], // every rate moved by 1/100
        },
      ],
    };
    let wrote = false;
    const res = await collectDeepinfraUsage('2026-07-28T03:00:00.000Z', {
      apiKey: 'k',
      fetchImpl: stubFetch(asDollars),
      knownRatesUsd: async () => [0.00000093, 0.000003, 0.00000018],
      record: async () => {
        wrote = true;
        return { created: true, allocation: 'per_sandbox' as const };
      },
    });
    expect(wrote).toBe(false);
    expect(res.months).toEqual([]);
    expect(res.rejected[0].reason).toMatch(/currency units/);
  });

  it('accepts the real payload, whose rates match the price book x100', async () => {
    const res = await collectDeepinfraUsage('2026-07-28T03:00:00.000Z', {
      apiKey: 'k',
      fetchImpl: stubFetch(liveJulyPayload),
      knownRatesUsd: async () => [0.00000093, 0.000003, 0.00000018],
      record: async () => ({ created: true, allocation: 'per_sandbox' as const }),
    });
    expect(res.rejected).toEqual([]);
    expect(res.months[0].amountUsd).toBeCloseTo(37.31, 2);
  });

  it('still collects when DeepInfra adds a model we have not seeded', async () => {
    // Only SOME rates need to match: a new model is routine, a unit change moves
    // every rate at once. Blocking on an unseeded model would stop a real bill.
    const withNewModel = {
      months: [
        {
          period: '2026.07',
          total_cost: 5000,
          invoice_id: 'INVALID',
          items: [
            { units: 100, rate: 9.3e-5 }, // known GLM input
            { units: 200, rate: 0.00777 }, // some new model we never seeded
          ],
        },
      ],
    };
    const res = await collectDeepinfraUsage('2026-07-28T03:00:00.000Z', {
      apiKey: 'k',
      fetchImpl: stubFetch(withNewModel),
      knownRatesUsd: async () => [0.00000093],
      record: async () => ({ created: true, allocation: 'per_sandbox' as const }),
    });
    expect(res.rejected).toEqual([]);
    expect(res.months[0].amountUsd).toBeCloseTo(50, 2);
  });

  it('records one month even when a sibling month is rejected', async () => {
    const mixed = {
      months: [
        { period: '2026.06', total_cost: 1200, invoice_id: 'in_ok', items: [{ units: 1, rate: 9.3e-5 }] },
        { period: '2026.07', total_cost: 50, invoice_id: 'INVALID', items: [{ units: 1, rate: 9.3e-7 }] },
      ],
    };
    const res = await collectDeepinfraUsage('2026-07-28T03:00:00.000Z', {
      apiKey: 'k',
      fetchImpl: stubFetch(mixed),
      knownRatesUsd: async () => [0.00000093],
      record: async () => ({ created: true, allocation: 'per_sandbox' as const }),
    });
    expect(res.months.map((m) => m.period)).toEqual(['2026.06']);
    expect(res.months[0].source).toBe('invoice');
    expect(res.rejected.map((r) => r.period)).toEqual(['2026.07']);
  });

  it('abstains from the unit check when the price book is empty', async () => {
    // A tripwire that fires when it cannot see would block a real bill.
    const res = await collectDeepinfraUsage('2026-07-28T03:00:00.000Z', {
      apiKey: 'k',
      fetchImpl: stubFetch(liveJulyPayload),
      knownRatesUsd: async () => [],
      record: async () => ({ created: true, allocation: 'per_sandbox' as const }),
    });
    expect(res.rejected).toEqual([]);
    expect(res.months).toHaveLength(1);
  });

  it('asks for the previous month as well as the current one', async () => {
    let seen = '';
    await collectDeepinfraUsage('2026-01-15T00:00:00.000Z', {
      apiKey: 'k',
      fetchImpl: (async (url: string) => {
        seen = url;
        return okResponse({ months: [] });
      }) as unknown as typeof fetch,
      record: async () => ({ created: true, allocation: 'per_sandbox' as const }),
    });
    // January's previous month is the prior YEAR — the boundary a naive
    // month-minus-one gets wrong.
    expect(seen).toContain('from=2025.12');
    expect(seen).toContain('to=2026.01');
  });
});

describe('billingApiKey', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.DEEPINFRA_BILLING_API_KEY;
    delete process.env.INFERENCE_API_KEY;
    delete process.env.INFERENCE_BASE_URL;
    delete process.env.MODEL_PROVIDER;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('prefers the explicit billing key', () => {
    process.env.DEEPINFRA_BILLING_API_KEY = 'explicit';
    process.env.INFERENCE_API_KEY = 'inference';
    expect(billingApiKey()).toBe('explicit');
  });

  it('falls back to INFERENCE_API_KEY when the spine points at DeepInfra', () => {
    process.env.INFERENCE_API_KEY = 'inference';
    process.env.INFERENCE_BASE_URL = 'https://api.deepinfra.com/v1/openai';
    expect(billingApiKey()).toBe('inference');
  });

  it('DECLINES the fallback after a failover to NVIDIA', () => {
    // The whole point of the gate: an NVIDIA key cannot read a DeepInfra account,
    // so using it would 401 the cron every 15 minutes for a normal condition.
    process.env.INFERENCE_API_KEY = 'nvidia-key';
    process.env.INFERENCE_BASE_URL = 'https://integrate.api.nvidia.com/v1';
    expect(billingApiKey()).toBeUndefined();
  });

  it('declines the fallback when the provider is anthropic', () => {
    process.env.MODEL_PROVIDER = 'anthropic';
    process.env.INFERENCE_API_KEY = 'inference';
    expect(billingApiKey()).toBeUndefined();
  });

  it('returns undefined when nothing is configured', () => {
    expect(billingApiKey()).toBeUndefined();
  });
});
