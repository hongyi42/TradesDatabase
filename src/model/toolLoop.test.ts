import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The Anthropic path is the documented MODEL_PROVIDER rollback and is otherwise
// exercised by NOTHING — every other test here runs the openai-compatible
// transport. Stubbing the SDK is the only way to prove the message shapes before
// a live provider flip discovers them.
const { anthropicCreate } = vi.hoisted(() => ({ anthropicCreate: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));
import {
  MAX_STALLED_TURNS,
  MAX_TOOL_CALL_MS,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_LOOP_BUDGET_MS,
  MAX_TOOL_LOOP_TURNS,
  MAX_TOOL_RESULT_CHARS,
  runToolLoop,
  type ToolExecutor,
  ToolLoopLimitError,
  ToolLoopCancelledError,
} from './toolLoop.js';
import type { ForcedToolSpec } from './forcedTool.js';
import type { recordModelUsage } from '../db/index.js';

// The multi-turn transport, driven entirely through a stubbed fetch — the loop's
// caps and bookkeeping are what can silently drift, not the network.

const READ_TOOL: ForcedToolSpec = {
  name: 'spine_read',
  description: 'read',
  inputSchema: {
    type: 'object',
    properties: { sql: { type: 'string' }, maxRows: { type: 'number' } },
    required: ['sql'],
  },
};

// One OpenAI-compatible reply that calls a tool.
const toolCallBody = (name: string, args: unknown, id = 'call_1', usage = 10) => ({
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [
          { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: usage, completion_tokens: usage },
});

// One reply carrying MANY tool calls in a single assistant message.
const manyCallsBody = (name: string, count: number) => ({
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: null,
        tool_calls: Array.from({ length: count }, (_, i) => ({
          id: `call_${i}`,
          type: 'function',
          function: { name, arguments: JSON.stringify({ sql: `select ${i}` }) },
        })),
      },
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

// One reply that answers without calling anything — the loop's only clean exit.
const finalBody = (text: string, usage = 5) => ({
  choices: [{ finish_reason: 'stop', message: { content: text } }],
  usage: { prompt_tokens: usage, completion_tokens: usage },
});

describe('runToolLoop', () => {
  const saved = { key: process.env.INFERENCE_API_KEY, provider: process.env.MODEL_PROVIDER };
  const realFetch = globalThis.fetch;
  let bodies: unknown[];
  let sent: Array<Record<string, unknown>>;

  // Serve `bodies` in order; the LAST one repeats forever, so a runaway loop is
  // driven by the model's shape rather than by running out of fixtures.
  const serve = (...queue: unknown[]) => {
    bodies = queue;
    sent = [];
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as Record<string, unknown>);
      const body = bodies.length > 1 ? bodies.shift() : bodies[0];
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    process.env.INFERENCE_API_KEY = 'test-key';
    delete process.env.MODEL_PROVIDER; // default 'openai'
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (saved.key === undefined) delete process.env.INFERENCE_API_KEY;
    else process.env.INFERENCE_API_KEY = saved.key;
    if (saved.provider === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = saved.provider;
  });

  test('an empty tool list omits tools AND tool_choice from the wire (build 5.5 F3)', async () => {
    // The desk's technician path is the first legitimate tool-less caller:
    // `tools: []` is a provider 400 on some OpenAI-compatible endpoints, and
    // `tool_choice` without `tools` is its own 400 — both keys must vanish
    // together.
    serve(finalBody('you are square with the office'));
    const res = await runToolLoop(
      { system: 'sys', user: 'am I square?', maxTokens: 256, label: 'desk-test' },
      [],
      async () => null,
      { tenantId: 't', technicianRef: 'spine:team-lead' },
      { recordUsage: vi.fn(async () => {}) },
    );
    expect(res.text).toBe('you are square with the office');
    expect(sent[0]).not.toHaveProperty('tools');
    expect(sent[0]).not.toHaveProperty('tool_choice');
  });

  test('looks something up, then answers — the whole point of the loop', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' }), finalBody('4 jobs'));
    const execute = vi.fn(async () => [{ n: 4 }]);
    const recordUsage = vi.fn(async () => {});

    const res = await runToolLoop(
      { system: 'sys', user: 'how many jobs?', maxTokens: 512, label: 'test' },
      [READ_TOOL],
      execute,
      { tenantId: 't', technicianRef: 'spine:team-lead' },
      { recordUsage },
    );

    expect(res.text).toBe('4 jobs');
    expect(res.turns).toBe(2);
    expect(execute).toHaveBeenCalledWith('spine_read', { sql: 'select 1' });
    expect(res.calls).toHaveLength(1);
    expect(res.calls[0]).toMatchObject({ turn: 1, name: 'spine_read', ok: true });
    expect(res.calls[0].result).toBe('[{"n":4}]');
    // The tool the caller offered must actually be ON the wire. `tools: []` is
    // the quiet failure: the real API answers in prose, the loop returns that as
    // the plan, and the planner has silently stopped reading the spine.
    expect(sent[0].tools).toMatchObject([
      { type: 'function', function: { name: 'spine_read' } },
    ]);
    expect(sent[0].tool_choice).toBe('auto');
    expect(sent[0].max_tokens).toBe(512);
    // The second request must carry the first turn's assistant message AND the
    // tool result, or the model is answering with no memory of what it read.
    const second = sent[1].messages as Array<Record<string, unknown>>;
    expect(second).toHaveLength(4); // system, user, assistant(tool_calls), tool
    expect(second[2]).toMatchObject({ role: 'assistant' });
    expect(second[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: '[{"n":4}]' });
  });

  test('bills EVERY turn, not the loop — under-reporting a loop is silent overspend', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' }), finalBody('done'));
    // Typed off recordModelUsage so the recorded calls carry its argument types
    // — an argless vi.fn() types mock.calls as an empty tuple, and the
    // assertions below read arguments.
    const recordUsage = vi.fn<typeof recordModelUsage>(async () => {});
    await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test' },
      [READ_TOOL],
      async () => [],
      { tenantId: 't', technicianRef: 'spine:team-lead' },
      { recordUsage },
    );
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage.mock.calls[0][0]).toBe('openrouter'); // ledgerVendor, default base URL
    expect(recordUsage.mock.calls[0][1]).toMatchObject({ inputTokens: 10, outputTokens: 10 });
    expect(recordUsage.mock.calls[1][1]).toMatchObject({ inputTokens: 5, outputTokens: 5 });
  });

  test('carries the cache split through — OpenRouter reports reads AND writes', async () => {
    // The ledger prices cached reads at $0.26/M against $1.40/M fresh, so a
    // dropped split is a ~5x over-report on ~90% of the planner's input. The
    // write tier is reported too; GLM 5.3 does not charge for it today, which is
    // why its rate is seeded at $0 rather than omitted (an unpriced SKU is
    // DROPPED by the rollup's inner join, not shown as zero).
    serve({
      choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 100 },
      },
    });
    const recordUsage = vi.fn<typeof recordModelUsage>(async () => {});
    await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test' },
      [READ_TOOL],
      async () => [],
      { tenantId: 't', technicianRef: 'spine:team-lead' },
      { recordUsage },
    );
    expect(recordUsage.mock.calls[0][1]).toMatchObject({
      inputTokens: 1000, // TOTAL incl. cached — the ledger convention
      cachedInputTokens: 900,
      cacheWriteTokens: 100,
    });
  });

  test('always names a reasoning effort, and never \'none\'', async () => {
    // MEASURED 2026-08-28: z-ai/glm-5.3 on OpenRouter 400s on
    // reasoning_effort 'none' — "Reasoning is mandatory for this endpoint and
    // cannot be disabled." A request that omitted the field entirely would take
    // the provider's own default, which is not a decision anybody made.
    serve(finalBody('ok'));
    await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test' },
      [READ_TOOL],
      async () => [],
      { tenantId: 't', technicianRef: 'spine:team-lead' },
      { recordUsage: vi.fn(async () => {}) },
    );
    expect(sent[0].reasoning_effort).toBe('medium');
  });

  test('stops at the turn ceiling and THROWS — a cut-off loop is not an answer', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' })); // repeats forever
    const execute = vi.fn(async () => []);
    const recordUsage = vi.fn(async () => {});

    await expect(
      runToolLoop(
        { system: 's', user: 'u', maxTokens: 128, label: 'planner' },
        [READ_TOOL],
        execute,
        undefined,
        { recordUsage },
      ),
    ).rejects.toThrow(/planner: tool loop hit the 8-turn ceiling/);

    expect(MAX_TOOL_LOOP_TURNS).toBe(8);
    expect(execute).toHaveBeenCalledTimes(8);
    expect(recordUsage).toHaveBeenCalledTimes(8);
  });

  // The budget is the ONLY rail for an opted-out caller (build 1b), and nothing
  // else in the suite would notice it moving: every budget-sensitive test passes
  // an explicit budgetMs, so a silent revert to the old 90_000 — the headline
  // change of this build — would leave the whole suite green. Pinned for the same
  // reason MAX_TOOL_LOOP_TURNS is pinned above.
  //
  // The VALUE only, deliberately. The clamp that keeps it a ceiling is the same
  // Math.min as the turn clamp, which 'a caller may ask for LESS than the
  // ceiling, never more' already exercises — and observing the budget clamp
  // behaviourally would mean waiting out the resolved budget, i.e. a
  // fifteen-minute test.
  test('the budget rail is fifteen minutes', () => {
    expect(MAX_TOOL_LOOP_BUDGET_MS).toBe(900_000);
  });

  // The TYPE is the contract, not the message text. A caller has to tell "the
  // work stopped fitting" from "the provider fell over" — they need opposite
  // responses — and matching on a message string breaks the moment somebody
  // rewords it.
  test('both self-imposed limits throw a TYPED error carrying which limit it was', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' })); // repeats forever
    const run = (over: Record<string, unknown>) =>
      runToolLoop(
        { system: 's', user: 'u', maxTokens: 128, label: 'planner', ...over },
        [READ_TOOL],
        vi.fn(async () => []),
        undefined,
        { recordUsage: vi.fn(async () => {}) },
      );

    await expect(run({ maxTurns: 1 })).rejects.toMatchObject({
      name: 'ToolLoopLimitError',
      limit: 'turns',
    });
    await expect(run({ maxTurns: 1 })).rejects.toBeInstanceOf(ToolLoopLimitError);

    // budgetMs 1 with a tool that outlives it: the between-turn check fires.
    await expect(
      runToolLoop(
        { system: 's', user: 'u', maxTokens: 128, label: 'planner', budgetMs: 1 },
        [READ_TOOL],
        vi.fn(async () => {
          await new Promise((r) => setTimeout(r, 10));
          return [];
        }),
        undefined,
        { recordUsage: vi.fn(async () => {}) },
      ),
    ).rejects.toMatchObject({ name: 'ToolLoopLimitError', limit: 'budget' });
  });

  test('maxTurns is caller-overridable and still throws rather than returning partial work', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' }));
    const execute = vi.fn(async () => []);
    await expect(
      runToolLoop(
        { system: 's', user: 'u', maxTokens: 128, label: 'planner', maxTurns: 2 },
        [READ_TOOL],
        execute,
        undefined,
        { recordUsage: async () => {} },
      ),
    ).rejects.toThrow(/2-turn ceiling/);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test('a tool the caller did not offer is NEVER executed — deny-by-default', async () => {
    serve(toolCallBody('record_field_note', { text: 'x' }), finalBody('ok'));
    const execute = vi.fn(async () => 'should not run');
    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test' },
      [READ_TOOL],
      execute,
      undefined,
      { recordUsage: async () => {} },
    );
    expect(execute).not.toHaveBeenCalled();
    expect(res.calls[0].ok).toBe(false);
    expect(res.calls[0].result).toContain("'record_field_note' is not an available tool");
    expect(res.calls[0].result).toContain('spine_read');
  });

  test('a failing tool is reported back to the model, not thrown — it can correct itself', async () => {
    serve(toolCallBody('spine_read', { sql: 'select nope' }), finalBody('recovered'));
    const execute: ToolExecutor = async () => {
      throw new Error('permission denied for table customers');
    };
    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test' },
      [READ_TOOL],
      execute,
      undefined,
      { recordUsage: async () => {} },
    );
    expect(res.text).toBe('recovered');
    expect(res.calls[0].ok).toBe(false);
    expect(res.calls[0].result).toContain('permission denied for table customers');
  });

  test('unparseable arguments come back as a correctable error, not a crash', async () => {
    serve(
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [{ id: 'c1', function: { name: 'spine_read', arguments: '{"sql":' } }],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      finalBody('ok'),
    );
    const execute = vi.fn(async () => 'nope');
    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test' },
      [READ_TOOL],
      execute,
      undefined,
      { recordUsage: async () => {} },
    );
    expect(execute).not.toHaveBeenCalled();
    expect(res.calls[0].result).toContain('not valid JSON');
  });

  test('quoted numbers are schema-coerced before the tool sees them (GLM emits "200")', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1', maxRows: '200' }), finalBody('ok'));
    const execute = vi.fn(async () => []);
    await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test' },
      [READ_TOOL],
      execute,
      undefined,
      { recordUsage: async () => {} },
    );
    expect(execute).toHaveBeenCalledWith('spine_read', { sql: 'select 1', maxRows: 200 });
  });

  test('an oversized tool result is cut AND says so — silent truncation is the failure mode', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' }), finalBody('ok'));
    const huge = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 5_000);
    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test' },
      [READ_TOOL],
      async () => huge,
      undefined,
      { recordUsage: async () => {} },
    );
    expect(res.calls[0].result.length).toBeLessThan(huge.length);
    expect(res.calls[0].result).toContain('[TRUNCATED:');
    expect(res.calls[0].result).toContain('It is INCOMPLETE');
  });

  // ── build 6 Phase 4: onResult, the same string one turn earlier ───────────
  test('onResult receives EXACTLY what the model was shown, truncation included', async () => {
    // The whole reason this hook exists rather than the caller stringifying the
    // executor's return value itself. The executor hands back the RAW result;
    // the model is shown the truncated copy. A caller checking "did the model
    // see these words" against the raw value would accept a quote from text
    // that was cut off before it ever reached the model — which is precisely
    // what the planner's citation rail must never do.
    serve(toolCallBody('spine_read', { sql: 'select 1' }), finalBody('ok'));
    const buried = 'the customer settled up in cash on the day';
    const huge = 'x'.repeat(MAX_TOOL_RESULT_CHARS) + buried;
    const seen: string[] = [];
    await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test',
        onResult: (call) => { seen.push(call.result); } },
      [READ_TOOL],
      async () => huge,
      undefined,
      { recordUsage: async () => {} },
    );
    expect(seen).toHaveLength(1);
    // The buried words are NOT in it, because the model never saw them — this
    // is the raw-vs-shown distinction the hook exists for.
    expect(huge).toContain(buried);
    expect(seen[0]).not.toContain(buried);
    expect(seen[0]).toContain('[TRUNCATED:');
  });

  test('onResult fires for a FAILED call — the error string, not silence', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' }), finalBody('ok'));
    const seen: Array<{ name: string; ok: boolean; result: string }> = [];
    await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test',
        onResult: (c) => { seen.push({ name: c.name, ok: c.ok, result: c.result }); } },
      [READ_TOOL],
      async () => { throw new Error('bad sql'); },
      undefined,
      { recordUsage: async () => {} },
    );
    // A failed tool is information for the model, so it is shown one — and the
    // caller must be given the same string, so it can decide what to do with it.
    // (The planner drops these: an error from the machinery is not evidence.)
    expect(seen).toEqual([{ name: 'spine_read', ok: false, result: 'error: bad sql' }]);
  });

  test('onResult fires for EVERY call in a turn, in the order they ran', async () => {
    // The previous version of this test served ONE call and asserted a
    // one-element array — it proved the failure case and nothing about "every"
    // or "in order", both of which the planner depends on: a read listed before
    // submit_plan must reach the citation check before the plan is validated.
    const asked = MAX_TOOL_CALLS_PER_TURN;
    serve(manyCallsBody('spine_read', asked), finalBody('ok'));
    const seen: string[] = [];
    let n = 0;
    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test',
        onResult: (c) => { seen.push(c.result); } },
      [READ_TOOL],
      async () => `result ${++n}`,
      undefined,
      { recordUsage: async () => {} },
    );
    expect(seen).toHaveLength(asked);
    expect(seen).toEqual(res.calls.slice(0, asked).map((c) => c.result));
    expect(seen[0]).toBe('result 1'); // order, not just count
  });

  test('onResult fires for the TERMINAL tool too, before the loop returns', async () => {
    // The planner validates its plan INSIDE the terminal tool's executor, so
    // this fires after that validation — harmless, and asserted because
    // planner.ts reasons about it explicitly when deciding what may be cited.
    serve(toolCallBody('submit_plan', { decisions: [] }));
    const seen: string[] = [];
    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test', terminalTool: 'submit_plan',
        onResult: (c) => { seen.push(c.name); } },
      [{ name: 'submit_plan', description: 'end', inputSchema: { type: 'object', properties: {} } }],
      async () => ({ status: 'ok' }),
      undefined,
      { recordUsage: async () => {} },
    );
    expect(seen).toEqual(['submit_plan']);
    expect(res.turns).toBe(1);
  });

  test('a THROWING onResult never costs the plan', async () => {
    // It is an observation channel. A caller's bookkeeping bug must not lose a
    // plan the model has already produced.
    serve(toolCallBody('spine_read', { sql: 'select 1' }), finalBody('done'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'planner',
        onResult: () => { throw new Error('caller bug'); } },
      [READ_TOOL],
      async () => [],
      undefined,
      { recordUsage: async () => {} },
    );
    expect(res.text).toBe('done');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('onResult threw'))).toBe(true);
    spy.mockRestore();
  });

  test('a truncated TURN throws — the same guard runForcedTool carries', async () => {
    serve({
      choices: [{ finish_reason: 'length', message: { content: 'half an ans' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await expect(
      runToolLoop(
        { system: 's', user: 'u', maxTokens: 16, label: 'planner' },
        [READ_TOOL],
        async () => [],
        undefined,
        { recordUsage: async () => {} },
      ),
    ).rejects.toThrow(/truncated at maxTokens=16 \(finish_reason=length\)/);
  });

  test('an ERROR result is capped too — a database error can echo the whole statement', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' }), finalBody('ok'));
    const huge = 'y'.repeat(MAX_TOOL_RESULT_CHARS + 5_000);
    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test' },
      [READ_TOOL],
      async () => {
        throw new Error(huge);
      },
      undefined,
      { recordUsage: async () => {} },
    );
    expect(res.calls[0].ok).toBe(false);
    expect(res.calls[0].result.length).toBeLessThan(huge.length);
    expect(res.calls[0].result).toContain('[TRUNCATED:');
  });

  test('a turn asking for many tools at once runs only the ceiling — but answers every call', async () => {
    const asked = MAX_TOOL_CALLS_PER_TURN + 4;
    serve(manyCallsBody('spine_read', asked), finalBody('ok'));
    const execute = vi.fn(async () => []);
    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'test' },
      [READ_TOOL],
      execute,
      undefined,
      { recordUsage: async () => {} },
    );
    expect(execute).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_TURN);
    expect(res.calls).toHaveLength(asked);
    expect(res.calls.filter((c) => c.ok)).toHaveLength(MAX_TOOL_CALLS_PER_TURN);
    expect(res.calls[asked - 1].result).toContain(`only the first ${MAX_TOOL_CALLS_PER_TURN}`);
    // EVERY call needs a result, in order, keyed by its own id — a missing one
    // makes the next request malformed rather than merely incomplete.
    const followUp = (sent[1].messages as Array<Record<string, unknown>>).filter(
      (m) => m.role === 'tool',
    );
    expect(followUp).toHaveLength(asked);
    expect(followUp.map((m) => m.tool_call_id)).toEqual(
      Array.from({ length: asked }, (_, i) => `call_${i}`),
    );
  });

  test('a caller may ask for LESS than the ceiling, never more', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' }));
    const execute = vi.fn(async () => []);
    await expect(
      runToolLoop(
        { system: 's', user: 'u', maxTokens: 128, label: 'planner', maxTurns: 100 },
        [READ_TOOL],
        execute,
        undefined,
        { recordUsage: async () => {} },
      ),
    ).rejects.toThrow(new RegExp(`${MAX_TOOL_LOOP_TURNS}-turn ceiling`));
    expect(execute).toHaveBeenCalledTimes(MAX_TOOL_LOOP_TURNS);
  });

  // Build 1b. `maxTurns: null` is the planner's opt-out. Eleven turns alone would
  // not prove the ceiling is gone (a ceiling of twelve would pass it too) — what
  // proves it is this test TOGETHER with 'a caller may ask for LESS than the
  // ceiling, never more' below, which pins that no NUMBER can ever exceed
  // MAX_TOOL_LOOP_TURNS. Something that runs past 8 therefore cannot be a number
  // at all, which is exactly the categorical difference `null` encodes.
  test('maxTurns: null removes the turn ceiling entirely — the clock is the only rail', async () => {
    const calls = Array.from({ length: 10 }, () =>
      toolCallBody('spine_read', { sql: 'select 1' }),
    );
    serve(...calls, finalBody('done'));
    const execute = vi.fn(async () => []);

    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'planner', maxTurns: null },
      [READ_TOOL],
      execute,
      undefined,
      { recordUsage: async () => {} },
    );

    expect(res.text).toBe('done');
    expect(res.turns).toBe(11);
    expect(res.turns).toBeGreaterThan(MAX_TOOL_LOOP_TURNS);
    expect(execute).toHaveBeenCalledTimes(10);
  });

  // THE NO-PROGRESS BREAKER (2026-09-11). The live failure: 602 turns of the
  // same call and the same answer, ~1.5s apart, until the 15-minute clock killed
  // the tick — $8.67, and the month's key limit with it. These four tests pin
  // the four things that make the rail safe to have: it fires on repetition, it
  // TELLS before it stops, it recognises a cycle, and it leaves a model that is
  // actually learning something completely alone.
  test('a model repeating itself is TOLD, and the note rides beside the results', async () => {
    // One new call, then MAX_STALLED_TURNS that learn nothing: the warning lands
    // on that last turn, and the model gets to finish.
    const repeats = Array.from({ length: MAX_STALLED_TURNS + 1 }, () =>
      toolCallBody('spine_read', { sql: 'select 1' }),
    );
    serve(...repeats, finalBody('done'));
    const execute = vi.fn(async () => []);

    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'planner', maxTurns: null },
      [READ_TOOL],
      execute,
      undefined,
      { recordUsage: async () => {} },
    );

    expect(res.text).toBe('done');
    expect(res.stalledWarnings).toBe(1);

    // The note is a USER message of its own, naming what was repeated. NEVER a
    // tool result: the planner feeds citable tool results into its quote check,
    // and machinery's words must not become quotable evidence.
    const last = sent[sent.length - 1] as { messages: Array<{ role: string; content: unknown }> };
    const notes = last.messages.filter(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('NO NEW INFORMATION'),
    );
    expect(notes).toHaveLength(1);
    expect(String(notes[0].content)).toContain('spine_read');
    // The user's clause (2026-09-11): point it somewhere else BEFORE offering the
    // exits. Pinned because it is a ruling, not phrasing — a later tidy-up that
    // drops it would quietly turn the note back into "finish or give up", which
    // closes doors without opening one.
    expect(String(notes[0].content)).toContain('a different angle');
    expect(
      last.messages.some(
        (m) => m.role === 'tool' && String(m.content).includes('NO NEW INFORMATION'),
      ),
    ).toBe(false);
  });

  test('a model that keeps repeating AFTER being told is stopped, typed as `stalled`', async () => {
    // The last body repeats forever, so nothing but the breaker can end this.
    serve(toolCallBody('spine_read', { sql: 'select 1' }));
    const execute = vi.fn(async () => []);

    await expect(
      runToolLoop(
        { system: 's', user: 'u', maxTokens: 128, label: 'planner', maxTurns: null },
        [READ_TOOL],
        execute,
        undefined,
        { recordUsage: async () => {} },
      ),
    ).rejects.toMatchObject({ name: 'ToolLoopLimitError', limit: 'stalled' });

    // One turn of progress, MAX_STALLED_TURNS to the warning, MAX_STALLED_TURNS
    // more to the stop. Pinned as arithmetic, not a literal: this is the whole
    // cost of a runaway now, against 620 turns on 2026-09-11.
    expect(execute).toHaveBeenCalledTimes(2 * MAX_STALLED_TURNS + 1);
  });

  test('an A→B→A→B cycle is no progress either — the whole call is remembered', async () => {
    // Neither turn repeats the one BEFORE it, so a previous-turn comparison
    // would never fire. Both calls were already made, which is what counts.
    const cycle = Array.from({ length: 2 * (MAX_STALLED_TURNS + 1) }, (_, i) =>
      toolCallBody('spine_read', { sql: i % 2 === 0 ? 'select 1' : 'select 2' }),
    );
    serve(...cycle);
    const execute = vi.fn(async (_name: string, args: Record<string, unknown>) => [args.sql]);

    await expect(
      runToolLoop(
        { system: 's', user: 'u', maxTokens: 128, label: 'planner', maxTurns: null },
        [READ_TOOL],
        execute as unknown as ToolExecutor,
        undefined,
        { recordUsage: async () => {} },
      ),
    ).rejects.toMatchObject({ name: 'ToolLoopLimitError', limit: 'stalled' });
  });

  test('the same call with a CHANGING answer is progress, never a stall', async () => {
    // A read re-run after something moved returns something new, and that is a
    // model working. If this ever fails, the breaker has started policing how
    // long the planner may think — which build 1b's ruling forbids.
    const repeats = Array.from({ length: 2 * MAX_STALLED_TURNS + 2 }, () =>
      toolCallBody('spine_read', { sql: 'select 1' }),
    );
    serve(...repeats, finalBody('done'));
    let n = 0;
    const execute = vi.fn(async () => [n++]);

    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'planner', maxTurns: null },
      [READ_TOOL],
      execute,
      undefined,
      { recordUsage: async () => {} },
    );

    expect(res.text).toBe('done');
    expect(res.stalledWarnings).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2 * MAX_STALLED_TURNS + 2);
  });

  // The failure the floor exists for, and the reason it is not cosmetic: WITHOUT
  // it, an opted-out caller's normal ending is a mid-request abort — a plain
  // Error reading "the provider did not respond" — so a CAPACITY exhaustion gets
  // booked as a provider OUTAGE, the exact pair ToolLoopLimitError exists to keep
  // apart. This test discriminates: the pre-floor code reaches the abort and
  // throws an untyped Error, so it fails on `name`, not merely on a message.
  test('a turn the clock cannot pay for is a BUDGET hit, never a provider outage', async () => {
    // Each model call costs 30ms against a 100ms budget, so the loop cannot
    // finish a second turn — and with a real (slow) provider the pre-floor code
    // would issue it anyway and abort mid-request.
    //
    // The stub HONOURS the abort signal, the way undici does. That is the whole
    // experiment: a stub that ignores it never aborts, so the loop coasts to
    // remaining <= 0 and throws a typed budget error either way — which is
    // exactly how the first version of this test passed against the very code it
    // was meant to catch.
    globalThis.fetch = ((_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
        );
        setTimeout(
          () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => toolCallBody('spine_read', { sql: 'select 1' }),
            } as Response),
          30,
        );
      })) as unknown as typeof fetch;

    await expect(
      runToolLoop(
        {
          system: 's',
          user: 'u',
          maxTokens: 128,
          label: 'planner',
          maxTurns: null,
          budgetMs: 100,
        },
        [READ_TOOL],
        vi.fn(async () => []),
        undefined,
        { recordUsage: vi.fn(async () => {}) },
      ),
    ).rejects.toMatchObject({ name: 'ToolLoopLimitError', limit: 'budget' });
  });

  // One hung I/O must not inherit the whole fifteen minutes. Pinned as a value:
  // observing it would mean waiting out the deadline.
  test('a single tool call has its own ceiling, not the loop’s', () => {
    expect(MAX_TOOL_CALL_MS).toBe(90_000);
    expect(MAX_TOOL_CALL_MS).toBeLessThan(MAX_TOOL_LOOP_BUDGET_MS);
  });

  // The other half of the same contract: opting out of the turn ceiling must not
  // opt out of the budget. With no turn ceiling the clock is the ONLY thing that
  // can stop a model that loops, so a regression here is unbounded, not merely
  // wrong.
  test('an opted-out loop still stops on the CLOCK, and still says which limit it was', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' })); // repeats forever
    await expect(
      runToolLoop(
        {
          system: 's',
          user: 'u',
          maxTokens: 128,
          label: 'planner',
          maxTurns: null,
          budgetMs: 1,
        },
        [READ_TOOL],
        vi.fn(async () => {
          await new Promise((r) => setTimeout(r, 10));
          return [];
        }),
        undefined,
        { recordUsage: vi.fn(async () => {}) },
      ),
    ).rejects.toMatchObject({ name: 'ToolLoopLimitError', limit: 'budget' });
  });

  test('a provider that never responds is ABORTED — the budget rides into the request', async () => {
    // Honours the abort signal the way undici does. Without the signal reaching
    // fetch, this test hangs until vitest kills it — which is the bug.
    globalThis.fetch = ((_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;

    await expect(
      runToolLoop(
        { system: 's', user: 'u', maxTokens: 128, label: 'planner', budgetMs: 60 },
        [READ_TOOL],
        async () => [],
        undefined,
        { recordUsage: async () => {} },
      ),
      // Labelled: an abort is the failure hardest to attribute in a cron log, so
      // it must name its caller like every other throw from this module.
    ).rejects.toThrow(/^planner: the provider did not respond within/);
  });

  test('a tool that never returns is bounded by the same budget', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' }));
    await expect(
      runToolLoop(
        { system: 's', user: 'u', maxTokens: 128, label: 'planner', budgetMs: 60 },
        [READ_TOOL],
        () => new Promise(() => {}), // never settles
        undefined,
        { recordUsage: async () => {} },
      ),
    ).rejects.toThrow(/exceeded its 60ms budget/);
  });

  test('a terminal tool ends the loop on the turn it runs — no extra round-trip for "done"', async () => {
    const SUBMIT: ForcedToolSpec = {
      name: 'submit_plan',
      description: 'deliver the plan',
      inputSchema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
    };
    // A second body is queued and must never be requested.
    serve(toolCallBody('submit_plan', { plan: 'hold n1' }), finalBody('should not be reached'));
    const submitted: unknown[] = [];
    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'planner', terminalTool: 'submit_plan' },
      [READ_TOOL, SUBMIT],
      async (_name, args) => {
        submitted.push(args);
        return { ok: true };
      },
      undefined,
      { recordUsage: async () => {} },
    );
    expect(res.turns).toBe(1);
    expect(sent).toHaveLength(1); // ONE model call, not two
    expect(submitted).toEqual([{ plan: 'hold n1' }]);
  });

  test('a REJECTED terminal call does not end the loop — the model gets to correct it', async () => {
    const SUBMIT: ForcedToolSpec = {
      name: 'submit_plan',
      description: 'deliver the plan',
      inputSchema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
    };
    serve(toolCallBody('submit_plan', { plan: '' }), finalBody('gave up'));
    let attempts = 0;
    const res = await runToolLoop(
      { system: 's', user: 'u', maxTokens: 128, label: 'planner', terminalTool: 'submit_plan' },
      [READ_TOOL, SUBMIT],
      async () => {
        attempts += 1;
        throw new Error('plan was empty');
      },
      undefined,
      { recordUsage: async () => {} },
    );
    expect(attempts).toBe(1);
    expect(res.turns).toBe(2); // the loop went on
    expect(res.calls[0].result).toContain('plan was empty');
  });

  // The clock is the test's, not the machine's. Against a real 1ms budget this
  // raced the millisecond boundary and lost whenever the machine was loaded —
  // "after 0 turns", once in a full run and once in three isolated reruns
  // (2026-09-11). Here time moves only when the tool spends it.
  test('the wall-clock budget throws rather than letting a cron tick run long', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' }));
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    // The budget is checked BEFORE each turn, never mid-flight: one full turn
    // always completes, and the loop stops at the next boundary. A slow tool
    // is what actually burns a cron tick, so that is what this spends.
    const execute = vi.fn(async () => {
      now += 10;
      return [];
    });
    try {
      await expect(
        runToolLoop(
          { system: 's', user: 'u', maxTokens: 128, label: 'planner', budgetMs: 1 },
          [READ_TOOL],
          execute,
          undefined,
          { recordUsage: async () => {} },
        ),
      ).rejects.toThrow(/exceeded its 1ms budget after 1 turns/);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  // What the flake above was really reporting: the loop promises a tiny budget
  // ONE attempt (MIN_TURN_BUDGET_MS's header), and the promise broke whenever
  // the clock ticked between the loop reading its start time and checking it.
  // Forced here on every read, so a regression is red on every run.
  test('the first turn is never pre-empted, even when the clock moves before it starts', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' }));
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 5));
    try {
      await expect(
        runToolLoop(
          { system: 's', user: 'u', maxTokens: 128, label: 'planner', budgetMs: 1 },
          [READ_TOOL],
          async () => [],
          undefined,
          { recordUsage: async () => {} },
        ),
      ).rejects.toThrow(/exceeded its 1ms budget after 1 turns/);
      expect(sent).toHaveLength(1); // the one attempt really reached the provider
    } finally {
      clock.mockRestore();
    }
  });
});

// ── the MODEL_PROVIDER=anthropic rollback path ───────────────────────────────
// Not a hypothetical: flipping the env var is the documented way back off a
// suspended provider (Fireworks, 2026-08-15). These pin the message shapes the
// Messages API requires, so the flip is not the first execution.
describe('runToolLoop — the caller hangs up (plan 2026-09-22, the office)', () => {
  const saved = process.env.INFERENCE_API_KEY;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.INFERENCE_API_KEY = 'test-key';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.INFERENCE_API_KEY;
    else process.env.INFERENCE_API_KEY = saved;
  });
  const req = (signal: AbortSignal) => ({
    system: 's',
    user: 'u',
    maxTokens: 64,
    label: 'office',
    maxTurns: null,
    budgetMs: 60_000,
    signal,
  });

  test('already hung up: no model call is made at all', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const ac = new AbortController();
    ac.abort();
    await expect(
      runToolLoop(req(ac.signal), [READ_TOOL], vi.fn(), undefined, { recordUsage: vi.fn(async () => {}) }),
    ).rejects.toBeInstanceOf(ToolLoopCancelledError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('hung up mid-request: the request is aborted and the error names the hang-up', async () => {
    const ac = new AbortController();
    globalThis.fetch = ((_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
        );
        setTimeout(() => ac.abort(), 5);
      })) as unknown as typeof fetch;
    await expect(
      runToolLoop(req(ac.signal), [READ_TOOL], vi.fn(), undefined, { recordUsage: vi.fn(async () => {}) }),
    ).rejects.toBeInstanceOf(ToolLoopCancelledError);
  });
});

describe('runToolLoop on the Anthropic transport', () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, provider: process.env.MODEL_PROVIDER };

  beforeEach(() => {
    anthropicCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.MODEL_PROVIDER = 'anthropic';
  });
  afterEach(() => {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.provider === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = saved.provider;
  });

  test('carries tool_use out and tool_result back, and bills as anthropic', async () => {
    anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'let me look' },
          { type: 'tool_use', id: 'tu_1', name: 'spine_read', input: { sql: 'select 1' } },
        ],
        usage: { input_tokens: 11, output_tokens: 12, cache_read_input_tokens: 3 },
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'one row' }],
        usage: { input_tokens: 20, output_tokens: 4 },
      });
    const recordUsage = vi.fn<typeof recordModelUsage>(async () => {});

    const res = await runToolLoop(
      { system: 'sys', user: 'ask', maxTokens: 256, label: 'anthropic-test' },
      [READ_TOOL],
      async () => [{ n: 1 }],
      { tenantId: 't', technicianRef: 'spine:team-lead' },
      { recordUsage },
    );

    expect(res.text).toBe('one row');
    expect(res.turns).toBe(2);
    expect(res.calls[0]).toMatchObject({ name: 'spine_read', ok: true });
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage.mock.calls[0][0]).toBe('anthropic');
    // Anthropic input_tokens EXCLUDES cache activity; the transport
    // normalizes to the ledger's includes-cached convention: 11 + 3 = 14.
    expect(recordUsage.mock.calls[0][1]).toMatchObject({
      inputTokens: 14,
      outputTokens: 12,
      cachedInputTokens: 3,
    });

    // Second request: system re-sent, the assistant's own content echoed, and the
    // result carried as a USER message of tool_result blocks keyed by tool_use_id.
    const [first] = anthropicCreate.mock.calls[0];
    expect(first.tools).toMatchObject([{ name: 'spine_read' }]);
    expect(first.max_tokens).toBe(256);

    const [params, options] = anthropicCreate.mock.calls[1];
    // The system prompt rides as ONE text block carrying the cache breakpoint
    // (covers tools+system as a prefix; 2026-08-23 — production ran uncached).
    expect(params.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    expect(first.system).toEqual(params.system);
    expect(params.tools).toMatchObject([{ name: 'spine_read' }]);
    expect(params.messages).toHaveLength(3);
    expect(params.messages[1].role).toBe('assistant');
    expect(params.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: '[{"n":1}]', is_error: false },
      ],
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  test('a max_tokens stop is a truncation, not an answer', async () => {
    anthropicCreate.mockResolvedValueOnce({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'half' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(
      runToolLoop(
        { system: 's', user: 'u', maxTokens: 8, label: 'planner' },
        [READ_TOOL],
        async () => [],
        undefined,
        { recordUsage: async () => {} },
      ),
    ).rejects.toThrow(/truncated at maxTokens=8 \(stop_reason=max_tokens\)/);
  });
});
