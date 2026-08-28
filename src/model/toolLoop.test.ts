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
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_LOOP_TURNS,
  MAX_TOOL_RESULT_CHARS,
  runToolLoop,
  type ToolExecutor,
  ToolLoopLimitError,} from './toolLoop.js';
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

  test('the wall-clock budget throws rather than letting a cron tick run long', async () => {
    serve(toolCallBody('spine_read', { sql: 'select 1' }));
    await expect(
      runToolLoop(
        { system: 's', user: 'u', maxTokens: 128, label: 'planner', budgetMs: 1 },
        [READ_TOOL],
        // The budget is checked BEFORE each turn, never mid-flight: one full turn
        // always completes, and the loop stops at the next boundary. A slow tool
        // is what actually burns a cron tick, so that is what this spends.
        async () => new Promise((r) => setTimeout(() => r([]), 10)),
        undefined,
        { recordUsage: async () => {} },
      ),
    ).rejects.toThrow(/exceeded its 1ms budget after 1 turns/);
  });
});

// ── the MODEL_PROVIDER=anthropic rollback path ───────────────────────────────
// Not a hypothetical: flipping the env var is the documented way back off a
// suspended provider (Fireworks, 2026-08-15). These pin the message shapes the
// Messages API requires, so the flip is not the first execution.
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
