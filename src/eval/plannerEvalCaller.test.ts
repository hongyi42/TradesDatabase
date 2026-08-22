import { describe, expect, it } from 'vitest';
// The eval's caller is plain .mjs (it runs as a script, like scripts/date-eval).
// Its ARITHMETIC and its REQUEST SHAPE are load-bearing enough to test here:
// a mispriced cache multiplier turns the whole exercise into a wrong number,
// and a misplaced cache_control silently caches nothing while looking fine.
import {
  CACHE_MULT,
  callPlanner,
  costOf,
  counterfactuals,
} from '../../scripts/planner-eval/anthropic.mjs';

const OPUS = 'claude-opus-5';

describe('costOf', () => {
  it('prices a cache READ at 0.1x base, not at base', () => {
    // 1M read tokens on Opus 5: $5 base -> $0.50.
    const c = costOf({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, OPUS);
    expect(c.usd).toBeCloseTo(0.5, 10);
    expect(c.cacheHit).toBe(true);
  });

  it('prices a 5m write at 1.25x and a 1h write at 2x', () => {
    const five = costOf({ cache_creation_input_tokens: 1_000_000 }, OPUS, '5m');
    const hour = costOf({ cache_creation_input_tokens: 1_000_000 }, OPUS, '1h');
    expect(five.usd).toBeCloseTo(6.25, 10);
    expect(hour.usd).toBeCloseTo(10, 10);
    // The whole reason the eval and production want different TTLs.
    expect(CACHE_MULT.write1h / CACHE_MULT.write5m).toBeCloseTo(1.6, 10);
  });

  it('uses the cache_creation BREAKDOWN when both TTLs are present', () => {
    // Any single-rate formula misprices this. 1M at 1.25x + 1M at 2x = $16.25.
    const c = costOf(
      {
        cache_creation_input_tokens: 2_000_000, // the flat total — must be IGNORED
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
      },
      OPUS,
    );
    expect(c.usd).toBeCloseTo(16.25, 10);
    expect(c.write5m).toBe(1_000_000);
    expect(c.write1h).toBe(1_000_000);
  });

  it('prices input and output separately, and output is never cached', () => {
    const c = costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, OPUS);
    expect(c.usd).toBeCloseTo(30, 10); // $5 in + $25 out
    expect(c.cacheHit).toBe(false);
  });

  it('refuses to guess a price for an unknown model', () => {
    expect(() => costOf({}, 'some-new-model')).toThrow(/no price table/);
  });
});

describe('counterfactuals', () => {
  it('shows a 5m TTL on a cold cadence costing MORE than no cache at all', () => {
    // 10 calls, 2744-token prefix each — the production shape: every call cold.
    const rows = Array.from({ length: 10 }, () => ({ read: 0, write5m: 2744, write1h: 0 }));
    const cf = counterfactuals(rows, OPUS);
    expect(cf.allWrites5m).toBeGreaterThan(cf.noCache);
    // …while a warm 1h cache is far cheaper than either.
    expect(cf.ttl1h).toBeLessThan(cf.noCache / 3);
  });
});

describe('callPlanner request shape', () => {
  it('puts cache_control on the LAST system block and forces the tool', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = async (_u: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'tool_use', name: 'submit_plan', input: { decisions: [] } }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'tool_use',
        }),
      };
    };
    const out = await callPlanner({
      system: 'SYS',
      tool: { name: 'submit_plan', description: 'd', inputSchema: { type: 'object' } },
      user: 'USER',
      model: OPUS,
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown,
    });
    const system = sent.system as { text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(1);
    expect(system[system.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    // The per-tick message must NOT be cached — it changes every call, and a
    // breakpoint there caches nothing reusable.
    const messages = sent.messages as { content: unknown }[];
    expect(JSON.stringify(messages)).not.toContain('cache_control');
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'submit_plan' });
    expect(out.plan).toEqual({ decisions: [] });
  });

  it('asks for the 1h TTL explicitly when told to', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = async (_u: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ content: [], usage: {}, stop_reason: 'end_turn' }) };
    };
    await callPlanner({
      system: 'SYS', tool: { name: 'submit_plan', description: 'd', inputSchema: {} },
      user: 'U', model: OPUS, ttl: '1h', apiKey: 'k', fetchImpl: fetchImpl as unknown,
    });
    const system = sent.system as { cache_control?: unknown }[];
    expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('a forced tool that did not fire returns a null plan, not a crash', async () => {
    // Counting these is the point; throwing would hide them.
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'I decline' }], usage: {}, stop_reason: 'end_turn' }),
    });
    const out = await callPlanner({
      system: 'S', tool: { name: 'submit_plan', description: 'd', inputSchema: {} },
      user: 'U', model: OPUS, apiKey: 'k', fetchImpl: fetchImpl as unknown,
    });
    expect(out.plan).toBeNull();
    expect(out.stopReason).toBe('end_turn');
  });
});
