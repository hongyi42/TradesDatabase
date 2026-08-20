import Anthropic from '@anthropic-ai/sdk';
import { recordModelUsage, type CostContext } from '../db/index.js';

// One transport for every "forced single tool" model call in the spine.
//
// All four callers (classify, extract, brief, answer) have the same shape: a
// system prompt, ONE tool schema, a forced tool_choice, one user turn — the tool
// is a return-SHAPE contract, not a capability the model may choose to invoke.
// Only the wire format differs between vendors, so that difference lives here and
// nowhere else:
//
//   anthropic  → POST /v1/messages          reply: content[] block {type:'tool_use', input: object}
//   openai     → POST /chat/completions     reply: choices[0].message.tool_calls[0]
//                                                  {function:{arguments: JSON STRING}}
//
// Active provider is MODEL_PROVIDER (default 'openai' → GLM-5.2 via Fireworks).
// The anthropic path is kept whole so reverting is an env var, not a code change.

export type ModelProvider = 'anthropic' | 'openai';

// A JSON Schema object describing the tool's arguments — the same literal both
// wire formats need, under different key names (input_schema vs parameters).
export interface JsonSchemaObject {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ForcedToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

export interface ForcedToolRequest {
  system: string;
  user: string;
  maxTokens: number;
  // Prefixes the thrown error so a failure names the caller, not this module.
  label: string;
  /**
   * Cap or disable the model's thinking on the OpenAI-compatible path
   * (GLM-5.2 thinks BY DEFAULT; probed 2026-08-04: reasoning_effort 'none'
   * collapses it to ~7 tokens). Opt-in PER CALLER: the synthesis tools set
   * 'none' — a forced-JSON extraction gains nothing from a long think, and an
   * unbounded one ran brief/full_history past the 90s tool timeout the same
   * day the token ceiling stopped truncating it (2026-08-14, Q03). Ignored on
   * the Anthropic path.
   */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.fireworks.ai/inference/v1';
const DEFAULT_OPENAI_MODEL = 'accounts/fireworks/routers/glm-5p2-fast';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// Endpoint resolution, exported so the MULTI-TURN transport (toolLoop.ts) reads
// exactly the same env vars, defaults and cache-key fields as this one. Both
// transports speak to the same account, and a constant copied into the second
// file is how they drift — the same failure the truncation guard's comment
// names, where a fix landed on one path and not the other.
export function resolveOpenAiEndpoint(): { baseUrl: string; model: string; apiKey: string } {
  const apiKey = process.env.INFERENCE_API_KEY;
  if (!apiKey) throw new Error('INFERENCE_API_KEY is not set');
  return {
    apiKey,
    baseUrl: (process.env.INFERENCE_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, ''),
    model: process.env.INFERENCE_MODEL || DEFAULT_OPENAI_MODEL,
  };
}

export function resolveAnthropicEndpoint(): { model: string; apiKey: string } {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  return { apiKey, model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL };
}

// Cache-affinity key (set INFERENCE_CACHE_KEY to enable). Fireworks caches per
// replica: without a stable key, prefix-cache hits — and the $0.21/M cached-input
// billing — are routing luck (probed 2026-08-15: byte-identical repeats missed
// keyless; 21,014/21,017 tokens cached with a key). Sent as BOTH prompt_cache_key
// and user, matching what the provider's routing reads. Harmless on providers that
// ignore both (DeepInfra did, verified in the GLM cache-key trial), so the var is
// safe to leave set if the endpoint is ever repointed.
export function cacheKeyFields(): Record<string, string> {
  const key = process.env.INFERENCE_CACHE_KEY;
  return key ? { prompt_cache_key: key, user: key } : {};
}

export function activeProvider(): ModelProvider {
  return process.env.MODEL_PROVIDER === 'anthropic' ? 'anthropic' : 'openai';
}

// WHO BILLS US — which is not the same question as which wire format we speak.
// 'openai' is a protocol; INFERENCE_BASE_URL decides the company. Deriving the
// ledger vendor from the resolved host keeps a repointed endpoint from being
// priced against an invoice that never arrives. Unknown hosts return the host
// itself, so recordModelUsage reports an unmapped vendor LOUDLY instead of
// quietly billing the wrong one — which is exactly what a leftover DeepInfra
// base URL now does (retired 2026-08-19: `api.deepinfra.com` no longer maps to
// 'deepinfra', it returns the raw host and the write is refused with a logged
// error rather than mis-attributed).
export function ledgerVendor(): string {
  if (activeProvider() === 'anthropic') return 'anthropic';
  const raw = process.env.INFERENCE_BASE_URL || DEFAULT_OPENAI_BASE_URL;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  if (host.endsWith('nvidia.com')) return 'nvidia';
  if (host.endsWith('fireworks.ai')) return 'fireworks';
  return host;
}

// True when the ACTIVE provider's key is present. Live-model tests gate on this
// rather than on ANTHROPIC_API_KEY, so they follow the provider switch instead of
// silently skipping (or silently failing) after a flip.
export function hasModelCredentials(): boolean {
  return activeProvider() === 'anthropic'
    ? !!process.env.ANTHROPIC_API_KEY
    : !!process.env.INFERENCE_API_KEY;
}

// Models on OpenAI-compatible endpoints — GLM in particular — emit numbers and
// booleans as quoted strings ("0", "true"). The live MCP server already coerces
// this for tool args (intArg in src/mcp/server.ts) and the date eval documents it
// (scripts/eval-date-reliability.mjs:88-92). Here the tool's own JSON Schema says
// which fields are declared numeric/boolean, so the coercion is driven by the
// schema rather than by a hand-maintained field list: a new numeric field in any
// tool is covered the day it is added.
//
// Only DECLARED types are touched. `attributes` is additionalProperties:true with
// no declared property types, so free-form L3 facts pass through verbatim — a gate
// code of "0412" must never become the number 412.
export function coerceBySchema(value: unknown, schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return value;
  const s = schema as Record<string, unknown>;

  if (s.type === 'number' || s.type === 'integer') {
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
      const n = Number(value);
      // integer-typed field given "1.5" stays a string — better a schema
      // violation the caller can see than a silently truncated number.
      if (s.type === 'integer' && !Number.isInteger(n)) return value;
      return n;
    }
    return value;
  }

  if (s.type === 'boolean') {
    if (typeof value === 'string') {
      const t = value.trim().toLowerCase();
      if (t === 'true') return true;
      if (t === 'false') return false;
    }
    return value;
  }

  if (s.type === 'array' && Array.isArray(value)) {
    return value.map((item) => coerceBySchema(item, s.items));
  }

  if (s.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in out) out[key] = coerceBySchema(out[key], propSchema);
    }
    return out;
  }

  return value;
}

// Pull the forced tool's arguments out of an OpenAI-compatible reply. Exported for
// tests — the parsing, not the network call, is what can silently drift.
export function parseOpenAiToolArgs(
  body: unknown,
  toolName: string,
  label: string,
): Record<string, unknown> {
  const choices = (body as { choices?: unknown[] } | null)?.choices;
  const message = (choices?.[0] as { message?: unknown } | undefined)?.message as
    | { tool_calls?: unknown[] }
    | undefined;
  const calls = message?.tool_calls ?? [];
  const call = calls.find(
    (c) => (c as { function?: { name?: string } })?.function?.name === toolName,
  ) as { function?: { arguments?: unknown } } | undefined;

  if (!call) throw new Error(`${label}: model returned no ${toolName} tool call`);

  const raw = call.function?.arguments;
  // Spec says a JSON string; some OpenAI-compatible providers hand back an object
  // already. Accept both rather than depending on which one this gateway does.
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') {
    throw new Error(`${label}: ${toolName} tool call had no arguments`);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label}: ${toolName} tool call arguments were not valid JSON`);
  }
}

// Args plus what the call cost us. Usage is optional: a provider that stops
// returning it must not break the call — it is reported by the recorder instead.
export interface ForcedToolReply {
  args: Record<string, unknown>;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
}

async function callAnthropic(
  tool: ForcedToolSpec,
  req: ForcedToolRequest,
): Promise<ForcedToolReply> {
  const { apiKey, model } = resolveAnthropicEndpoint();
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    tools: [
      {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
      },
    ],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: req.user }],
  });
  // Same truncation guard as the OpenAI path, kept in step deliberately: this
  // transport is the documented env-var rollback, so a bug fixed on one side and
  // not the other would reappear the moment MODEL_PROVIDER flips. Anthropic
  // spells it stop_reason='max_tokens'.
  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      `${req.label}: model output was truncated at maxTokens=${req.maxTokens} ` +
        `(stop_reason=max_tokens) — the tool arguments are incomplete, so the result is not usable. ` +
        `Raise maxTokens for this caller.`,
    );
  }
  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === tool.name,
  );
  if (!toolUse) throw new Error(`${req.label}: model returned no ${tool.name} tool_use block`);
  return {
    args: toolUse.input as Record<string, unknown>,
    usage: {
      inputTokens: message.usage?.input_tokens,
      outputTokens: message.usage?.output_tokens,
      // Anthropic reports cache reads separately; folded in so the ledger sees
      // the same shape from both transports.
      cachedInputTokens: message.usage?.cache_read_input_tokens ?? undefined,
    },
  };
}

async function callOpenAiCompatible(
  tool: ForcedToolSpec,
  req: ForcedToolRequest,
): Promise<ForcedToolReply> {
  const { apiKey, baseUrl, model } = resolveOpenAiEndpoint();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens,
      temperature: 0,
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
      ...cacheKeyFields(),
      // No top-level `system` in this format — it is the first message.
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: tool.name } },
    }),
  });
  if (!res.ok) {
    // Truncated: a gateway error body can be an entire HTML page.
    throw new Error(`${req.label}: inference ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  // Read the body ONCE: parse the tool args and the usage block from the same
  // object (res.json() cannot be called twice).
  const body = (await res.json()) as {
    choices?: Array<{ finish_reason?: string }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number } | null;
    };
  };
  // TRUNCATION IS NOT A PARSE ERROR — check it before parsing, or it degrades
  // SILENTLY. Measured on GLM-5.2 (2026-07-30): a briefing whose output exceeded
  // maxTokens came back with finish_reason 'length', a well-formed tool_call, and
  // arguments that still parsed as valid JSON — but with the required `citations`
  // field simply absent. parseOpenAiToolArgs validates SHAPE (a call exists, the
  // JSON parses), never COMPLETENESS, so that response sailed through and
  // validateCitations turned the missing field into an empty array. The result was
  // a briefing that read complete and cited nothing, with no error anywhere.
  //
  // finish_reason is the provider's own ground truth: 'length' means the
  // generation was cut at the budget, whether or not the fragment happens to
  // parse. Trusting it costs one comparison and closes the whole class for all
  // four callers at any budget — the alternative is hoping every maxTokens stays
  // ahead of every future prompt, which is what failed here.
  //
  // A truncated reply is a caller-fixable fault, so the message names the budget.
  const finish = body.choices?.[0]?.finish_reason;
  if (finish === 'length') {
    throw new Error(
      `${req.label}: model output was truncated at maxTokens=${req.maxTokens} ` +
        `(finish_reason=length) — the tool arguments are incomplete, so the result is not usable. ` +
        `Raise maxTokens for this caller.`,
    );
  }
  return {
    args: parseOpenAiToolArgs(body, tool.name, req.label),
    // OpenAI-compatible naming differs from Anthropic's. prompt_tokens is the
    // TOTAL input including any cached portion, which the ledger prices at a
    // different (much lower) rate — so hand the cache figure along when the
    // endpoint reports one. DeepInfra returned prompt_tokens_details:null on a
    // live probe (2026-07-25), in which case everything stays on the input line.
    usage: {
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
      cachedInputTokens: body.usage?.prompt_tokens_details?.cached_tokens,
    },
  };
}

// The single entry point. Returns the tool's arguments, schema-coerced; throws
// (never returns partial) when the model did not produce the forced tool call.
export async function runForcedTool(
  tool: ForcedToolSpec,
  req: ForcedToolRequest,
  ctx?: CostContext,
): Promise<Record<string, unknown>> {
  const reply =
    activeProvider() === 'anthropic'
      ? await callAnthropic(tool, req)
      : await callOpenAiCompatible(tool, req);
  // ONE billing site for all four spine model calls. It lives here rather than in
  // each caller because this is also the only place that knows which provider
  // actually served the request — the SKUs differ, and MODEL_PROVIDER can flip
  // under the callers without them noticing. Failure-isolated inside the
  // recorder: cost accounting must never break the call it measures.
  await recordModelUsage(ledgerVendor(), reply.usage, ctx);
  return coerceBySchema(reply.args, tool.inputSchema) as Record<string, unknown>;
}
