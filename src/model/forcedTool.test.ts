import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  coerceBySchema,
  parseOpenAiToolArgs,
  runForcedTool,
  type ForcedToolSpec,
  type JsonSchemaObject,
} from './forcedTool.js';

// Pure tests — no network. These cover the two things that differ between the
// Anthropic and OpenAI-compatible wire formats and can therefore break silently:
// where the tool arguments live in the reply, and what TYPE they arrive as.

const okReply = (name: string, args: unknown) => ({
  choices: [{ message: { content: null, tool_calls: [{ function: { name, arguments: args } }] } }],
});

describe('parseOpenAiToolArgs', () => {
  test('parses the arguments JSON string into an object', () => {
    const body = okReply('classify_email', '{"isWork":true,"reason":"quote request"}');
    expect(parseOpenAiToolArgs(body, 'classify_email', 'test')).toEqual({
      isWork: true,
      reason: 'quote request',
    });
  });

  test('accepts arguments already given as an object', () => {
    // Not all OpenAI-compatible gateways stringify; both shapes must work.
    const body = okReply('classify_email', { isWork: false, reason: 'newsletter' });
    expect(parseOpenAiToolArgs(body, 'classify_email', 'test')).toEqual({
      isWork: false,
      reason: 'newsletter',
    });
  });

  test('picks the call matching the tool name, ignoring others', () => {
    const body = {
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: 'something_else', arguments: '{"x":1}' } },
              { function: { name: 'record_answer', arguments: '{"answer":"yes"}' } },
            ],
          },
        },
      ],
    };
    expect(parseOpenAiToolArgs(body, 'record_answer', 'test')).toEqual({ answer: 'yes' });
  });

  test('throws when the model answered with prose instead of the forced tool call', () => {
    const body = { choices: [{ message: { content: 'Sure, that email looks work related.' } }] };
    expect(() => parseOpenAiToolArgs(body, 'classify_email', 'defaultClassifier')).toThrow(
      'defaultClassifier: model returned no classify_email tool call',
    );
  });

  test('throws on a malformed arguments string rather than returning a partial object', () => {
    const body = okReply('classify_email', '{"isWork":true,');
    expect(() => parseOpenAiToolArgs(body, 'classify_email', 'defaultClassifier')).toThrow(
      'not valid JSON',
    );
  });

  test('throws when arguments decode to a non-object', () => {
    const body = okReply('classify_email', '"just a string"');
    expect(() => parseOpenAiToolArgs(body, 'classify_email', 'defaultClassifier')).toThrow(
      'not valid JSON',
    );
  });

  test('throws on an empty reply body', () => {
    expect(() => parseOpenAiToolArgs({}, 'classify_email', 'defaultClassifier')).toThrow(
      'no classify_email tool call',
    );
  });
});

// The truncation guard lives in the fetch path, so these drive runForcedTool with
// a stubbed fetch rather than re-implementing the check — the thing that must not
// regress is the PRODUCTION path, including the order the errors fire in.
describe('truncated output is rejected, not silently accepted', () => {
  const TOOL: ForcedToolSpec = {
    name: 'record_briefing',
    description: 'test',
    inputSchema: {
      type: 'object',
      properties: { briefing: { type: 'string' }, citations: { type: 'array' } },
      required: ['briefing', 'citations'],
    },
  };
  const req = { system: 's', user: 'u', maxTokens: 1024, label: 'defaultBriefer' };
  const saved = { key: process.env.INFERENCE_API_KEY, provider: process.env.MODEL_PROVIDER };
  const realFetch = globalThis.fetch;

  const stub = (body: unknown) => {
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, json: async () => body }) as Response) as typeof fetch;
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

  // THE REGRESSION THIS EXISTS FOR. Reproduced live on GLM-5.2 (2026-07-30): a
  // briefing that exceeded maxTokens returned finish_reason 'length' with a
  // well-formed tool_call whose arguments still parsed — but with the required
  // `citations` field truncated away. Every existing guard passed, and the caller
  // turned the missing field into an empty array: a briefing that read complete
  // and cited nothing, with no error anywhere.
  test('a truncated reply whose arguments still parse is REJECTED', async () => {
    stub({
      choices: [
        {
          finish_reason: 'length',
          message: {
            tool_calls: [
              { function: { name: 'record_briefing', arguments: '{"briefing":"Customer reports a leak."}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 1024 },
    });
    await expect(runForcedTool(TOOL, req)).rejects.toThrow(/truncated at maxTokens=1024/);
  });

  // Message quality: when a reply is BOTH truncated and missing the tool call,
  // "truncated" is the actionable diagnosis — "no tool call" would send the
  // reader looking for a prompt bug instead of a budget one.
  test('truncation is reported ahead of the generic no-tool-call error', async () => {
    stub({
      choices: [{ finish_reason: 'length', message: { content: '', tool_calls: [] } }],
      usage: { completion_tokens: 1024 },
    });
    await expect(runForcedTool(TOOL, req)).rejects.toThrow(/truncated/);
  });

  // The guard must not fire on healthy replies — a false positive would turn
  // working calls into 503s.
  test('a complete reply is unaffected', async () => {
    stub({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              { function: { name: 'record_briefing', arguments: '{"briefing":"ok","citations":[]}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    await expect(runForcedTool(TOOL, req)).resolves.toEqual({ briefing: 'ok', citations: [] });
  });

  // 'stop' is the other healthy terminal reason some gateways return for a forced
  // tool call; it must not be mistaken for truncation.
  test("finish_reason 'stop' is not treated as truncation", async () => {
    stub({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            tool_calls: [
              { function: { name: 'record_briefing', arguments: '{"briefing":"ok","citations":[]}' } },
            ],
          },
        },
      ],
    });
    await expect(runForcedTool(TOOL, req)).resolves.toMatchObject({ briefing: 'ok' });
  });
});

describe('coerceBySchema', () => {
  const classifySchema: JsonSchemaObject = {
    type: 'object',
    properties: { isWork: { type: 'boolean' }, reason: { type: 'string' } },
  };

  test('coerces a quoted boolean — the classify-before-L1 gate depends on it', () => {
    // "false" is truthy as a string: without this, a personal email would be
    // appended to the append-only L1 log and could never be removed.
    expect(coerceBySchema({ isWork: 'false', reason: 'newsletter' }, classifySchema)).toEqual({
      isWork: false,
      reason: 'newsletter',
    });
    expect(coerceBySchema({ isWork: 'true', reason: 'quote' }, classifySchema)).toEqual({
      isWork: true,
      reason: 'quote',
    });
  });

  test('leaves correctly-typed values untouched', () => {
    expect(coerceBySchema({ isWork: true, reason: 'quote' }, classifySchema)).toEqual({
      isWork: true,
      reason: 'quote',
    });
  });

  const extractSchema: JsonSchemaObject = {
    type: 'object',
    properties: {
      laborHours: { type: 'number' },
      customerName: { type: 'string' },
      attributes: { type: 'object', additionalProperties: true },
    },
  };

  test('coerces a quoted number into a numeric L2 field', () => {
    // Documented GLM quirk — see scripts/eval-date-reliability.mjs:88-92.
    expect(coerceBySchema({ laborHours: '4', customerName: 'Ada' }, extractSchema)).toEqual({
      laborHours: 4,
      customerName: 'Ada',
    });
    expect(coerceBySchema({ laborHours: '2.5' }, extractSchema)).toEqual({ laborHours: 2.5 });
    expect(coerceBySchema({ laborHours: '0' }, extractSchema)).toEqual({ laborHours: 0 });
  });

  test('does NOT coerce inside a free-form attributes bag', () => {
    // A gate code of "0412" must stay a string — attributes has no declared
    // property types, so nothing inside it is schema-typed.
    const out = coerceBySchema(
      { attributes: { gateCode: '0412', petCount: '2' } },
      extractSchema,
    ) as { attributes: Record<string, unknown> };
    expect(out.attributes.gateCode).toBe('0412');
    expect(out.attributes.petCount).toBe('2');
  });

  test('leaves a non-numeric string alone rather than producing NaN', () => {
    expect(coerceBySchema({ laborHours: 'about four' }, extractSchema)).toEqual({
      laborHours: 'about four',
    });
  });

  test('does not touch keys the schema does not declare', () => {
    expect(coerceBySchema({ unknownField: '7' }, extractSchema)).toEqual({ unknownField: '7' });
  });

  const answerSchema: JsonSchemaObject = {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      citations: {
        type: 'array',
        items: {
          type: 'object',
          properties: { claim: { type: 'string' }, captureId: { type: 'string' } },
        },
      },
    },
  };

  test('recurses into arrays of objects without altering citation ids', () => {
    const input = {
      answer: 'Capacitor was replaced.',
      citations: [{ claim: 'Capacitor replaced', captureId: '0e9c1f2a-1111-2222-3333-444455556666' }],
    };
    expect(coerceBySchema(input, answerSchema)).toEqual(input);
  });

  test('tolerates a missing optional field', () => {
    expect(coerceBySchema({ answer: 'Unknown.' }, answerSchema)).toEqual({ answer: 'Unknown.' });
  });
});

describe('ledgerVendor host mapping', () => {
  // WHO BILLS US derives from the resolved base-URL host. An unmapped host
  // returns itself so recordModelUsage complains loudly (the NVIDIA gap of
  // 2026-08-06: vendor existed, SKUs did not, spend vanished silently).
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.MODEL_PROVIDER = process.env.MODEL_PROVIDER;
    saved.INFERENCE_BASE_URL = process.env.INFERENCE_BASE_URL;
    delete process.env.MODEL_PROVIDER;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test.each([
    // RETIRED 2026-08-19: no longer mapped, so it reports the raw host and
    // recordModelUsage refuses the write loudly instead of mis-attributing it.
    ['https://api.deepinfra.com/v1/openai', 'api.deepinfra.com'],
    ['https://integrate.api.nvidia.com/v1', 'nvidia'],
    ['https://api.fireworks.ai/inference/v1', 'fireworks'],
    // The 2026-08-28 switch target. Fireworks/NVIDIA stay mapped ABOVE it on
    // purpose: this map is the write path, but the rollup prices HISTORY by
    // joining cost_events to cost_rates, so a retired vendor must still resolve
    // for its own old rows.
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://api.tokenfactory.nebius.com/v1', 'api.tokenfactory.nebius.com'],
  ])('%s → %s', async (baseUrl, vendor) => {
    process.env.INFERENCE_BASE_URL = baseUrl;
    const { ledgerVendor } = await import('./forcedTool.js');
    expect(ledgerVendor()).toBe(vendor);
  });
});


describe('the spine model guard — Gemini is a SEAT model, never the planner\'s', () => {
  // User ruling 2026-08-28. INFERENCE_MODEL feeds the planner AND all four
  // forced-tool callers, so one typo would put a seat model on the planner.
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['INFERENCE_MODEL', 'INFERENCE_API_KEY', 'OPENROUTER_API_KEY']) {
      saved[k] = process.env[k];
    }
    process.env.INFERENCE_API_KEY = 'test-key';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('a gemini id is refused, and the message says WHY rather than just "invalid"', async () => {
    const { assertSpineModelAllowed } = await import('./forcedTool.js');
    expect(() => assertSpineModelAllowed('google/gemini-3.7-flash')).toThrow(/SEAT model/);
    // The suffix forms OpenRouter accepts must not slip past a naive equality check.
    expect(() => assertSpineModelAllowed('google/gemini-3.7-flash:nitro')).toThrow(/SEAT model/);
    expect(() => assertSpineModelAllowed('GOOGLE/GEMINI-3.7-FLASH')).toThrow(/SEAT model/);
  });

  test('the planner\'s own model passes', async () => {
    const { assertSpineModelAllowed } = await import('./forcedTool.js');
    expect(() => assertSpineModelAllowed('z-ai/glm-5.3')).not.toThrow();
  });

  test('resolveOpenAiEndpoint enforces it, so no caller can bypass the check', async () => {
    const { resolveOpenAiEndpoint } = await import('./forcedTool.js');
    process.env.INFERENCE_MODEL = 'google/gemini-3.7-flash';
    expect(() => resolveOpenAiEndpoint()).toThrow(/SEAT model/);
    process.env.INFERENCE_MODEL = 'z-ai/glm-5.3';
    expect(resolveOpenAiEndpoint().model).toBe('z-ai/glm-5.3');
  });

  test('OPENROUTER_API_KEY is accepted when INFERENCE_API_KEY is unset', async () => {
    const { resolveOpenAiEndpoint, hasModelCredentials } = await import('./forcedTool.js');
    delete process.env.INFERENCE_API_KEY;
    delete process.env.MODEL_PROVIDER;
    process.env.OPENROUTER_API_KEY = 'or-key';
    // hasModelCredentials must agree with the resolver, or the lifecycle would
    // skip the planner for "no inference credentials" while the call would work.
    expect(hasModelCredentials()).toBe(true);
    expect(resolveOpenAiEndpoint().apiKey).toBe('or-key');
  });
});

describe('reasoning effort — \'none\' is unreachable and medium is the default', () => {
  // MEASURED 2026-08-28 against z-ai/glm-5.3 on OpenRouter: reasoning_effort
  // 'none' returns 400 "Reasoning is mandatory for this endpoint and cannot be
  // disabled"; 'minimal' succeeds with 0 reasoning tokens. The union no longer
  // contains 'none', so this test guards the DEFAULT and the wire field.
  test('a request naming no effort sends medium', async () => {
    const { DEFAULT_REASONING_EFFORT } = await import('./forcedTool.js');
    expect(DEFAULT_REASONING_EFFORT).toBe('medium');
  });
});
