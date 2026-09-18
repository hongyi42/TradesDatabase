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
// Active provider is MODEL_PROVIDER (default 'openai'). 'openai' is a PROTOCOL,
// not a company: the endpoint comes from INFERENCE_BASE_URL / INFERENCE_MODEL,
// defaulting to OpenRouter on z-ai/glm-5.3 (migration 2026-08-28). Read the live
// Render env before asserting what is serving — the constants below are only the
// fallback. This comment said 'GLM-5.2 via Fireworks' until 2026-09-06, having
// outlived two provider migrations while contradicting the constants 70 lines
// down; that account is out of credits and serves nothing.
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

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// User ruling 2026-08-28. Applied whenever a caller names nothing.
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';

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
   * How hard the model may think. OpenRouter's ladder, minus the bottom rung:
   * `minimal | low | medium | high | xhigh | max`.
   *
   * `'none'` IS DELIBERATELY NOT IN THIS UNION. GLM 5.3 rejects it outright —
   * `400 "Reasoning is mandatory for this endpoint and cannot be disabled."`
   * (measured 2026-08-28 against z-ai/glm-5.3 on OpenRouter; `minimal`, `low`
   * and `medium` all succeeded, `none` alone 400'd). Removing it from the type
   * rather than mapping it silently means every caller that used to say
   * "do not think" had to CHOOSE its replacement, at compile time.
   *
   * `minimal` is that replacement, and it is a true one: the same probe
   * returned 0 reasoning tokens on `minimal`. The four forced-JSON callers use
   * it — a schema-shaped extraction gains nothing from a long think, and an
   * unbounded one ran brief/full_history past the 90s tool timeout (2026-08-14,
   * Q03).
   *
   * DEFAULT IS `medium` (user ruling 2026-08-28: "default to medium with
   * adjustable reasoning"), applied when a caller names nothing — which is why
   * this is now always sent rather than conditionally spread.
   */
  reasoningEffort?: ReasoningEffort;
}

// OpenRouter (migration 2026-08-28, plan thoughts/shared/plans/2026-08-28-openrouter-migration.md).
// The point is not the vendor, it is that ONE model id resolves to MANY upstream
// providers — `z-ai/glm-5.3` is served by 10 — and OpenRouter falls through to
// the next on any error. That is the failover this codebase never had: a
// property of the request rather than a retry loop we maintain.
//
// NO `provider` block is sent, deliberately. OpenRouter keeps a cache warm by
// STICKY ROUTING to the same upstream for ~10 min, and its docs state sticky
// routing is not used when a manual provider order is given. The planner's
// input is ~90% stable doctrine prefix, so cache hits are worth more than
// marginal throughput. Failover is unaffected — it is on by default.
// https://openrouter.ai/docs/features/prompt-caching
// https://openrouter.ai/docs/features/provider-routing
const DEFAULT_OPENAI_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENAI_MODEL = 'z-ai/glm-5.3';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// OpenRouter attributes usage to an app by these headers. Harmless on any other
// OpenAI-compatible host (unknown headers are ignored), so they ride
// unconditionally rather than being gated on the resolved base URL.
export const ATTRIBUTION_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://github.com/hongyi42/TradesDatabase',
  'X-Title': 'TradesDatabase spine',
};

// Endpoint resolution, exported so the MULTI-TURN transport (toolLoop.ts) reads
// exactly the same env vars, defaults and cache-key fields as this one. Both
// transports speak to the same account, and a constant copied into the second
// file is how they drift — the same failure the truncation guard's comment
// names, where a fix landed on one path and not the other.
export function resolveOpenAiEndpoint(): { baseUrl: string; model: string; apiKey: string } {
  // INFERENCE_API_KEY stays THE variable — it is what Render carries and it is
  // provider-agnostic by design. OPENROUTER_API_KEY is accepted as a second
  // source so the same secret need not be duplicated under two names locally.
  // One-directional and vendor-NAMED, which is why it does not repeat the trap
  // scripts/agentic-eval/run.mjs guards against: that one refused a fallback to
  // a GENERIC key that might still hold a RETIRED provider's secret. A key
  // called OPENROUTER_API_KEY cannot be a stale Fireworks key.
  const apiKey = process.env.INFERENCE_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('INFERENCE_API_KEY is not set');
  const model = process.env.INFERENCE_MODEL || DEFAULT_OPENAI_MODEL;
  assertSpineModelAllowed(model);
  return {
    apiKey,
    baseUrl: (process.env.INFERENCE_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, ''),
    model,
  };
}

// Gemini is a SEAT model, never the spine's (user ruling 2026-08-28).
//
// The spine's INFERENCE_MODEL feeds the planner AND all four forced-tool
// callers, so one env typo would put a seat model on the planner. Enforced in
// code rather than documented, because the doc would be read after the fact.
//
// Called from TWO places on purpose. Here it is per-REQUEST, which is too late
// to be the whole answer: a throw inside runPlanner lands in its per-tenant
// catch (planner.ts) and presents as `tenantErrors` — a misconfiguration
// wearing a provider outage's clothes. The lifecycle calls it too, where it
// becomes a stepError and turns the heartbeat red, which is what a config
// mistake should look like.
export function assertSpineModelAllowed(model: string): void {
  if (/^google\/gemini/i.test(model)) {
    throw new Error(
      `INFERENCE_MODEL '${model}' is a SEAT model and must never serve the spine — ` +
        'the planner and the forced-tool callers share this variable',
    );
  }
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
  // Kept alongside the retired vendors above, not replacing them: this map is
  // the WRITE path, but history is priced by joining cost_events to cost_rates,
  // so a vendor that no longer serves must still resolve for its own old rows.
  if (host.endsWith('openrouter.ai')) return 'openrouter';
  return host;
}

// True when the ACTIVE provider's key is present. Live-model tests gate on this
// rather than on ANTHROPIC_API_KEY, so they follow the provider switch instead of
// silently skipping (or silently failing) after a flip.
export function hasModelCredentials(): boolean {
  return activeProvider() === 'anthropic'
    ? !!process.env.ANTHROPIC_API_KEY
    : !!(process.env.INFERENCE_API_KEY || process.env.OPENROUTER_API_KEY);
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
  usage?: {
    inputTokens?: number; // TOTAL incl. cached reads (the ledger convention)
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  };
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
    // Same breakpoint as toolLoop's transport: tools+system cached as one
    // prefix, read at 0.1x within the TTL window. NOTE: compose's prompts
    // (~350 tokens with the tool schema) sit UNDER Opus-class models'
    // 512-token cache minimum, so for them this is a silent no-op today —
    // deliberate: harmless there, and any caller with a bigger prompt starts
    // caching without a second edit.
    system: [
      {
        type: 'text' as const,
        text: req.system,
        cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
      },
    ],
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
      // Anthropic input_tokens excludes cache activity — normalize to the
      // includes-cached ledger convention (see toolLoop's twin comment).
      inputTokens:
        typeof message.usage?.input_tokens === 'number'
          ? message.usage.input_tokens + (message.usage?.cache_read_input_tokens ?? 0)
          : undefined,
      outputTokens: message.usage?.output_tokens,
      // Anthropic reports cache reads separately; folded in so the ledger sees
      // the same shape from both transports.
      cachedInputTokens: message.usage?.cache_read_input_tokens ?? undefined,
      cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? undefined,
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
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...ATTRIBUTION_HEADERS },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens,
      temperature: 0,
      reasoning_effort: req.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
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
      prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
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
      // OpenRouter reports cache WRITES here too; Fireworks did not. Absent
      // reads as undefined, which recordModelUsage already folds into input.
      cacheWriteTokens: body.usage?.prompt_tokens_details?.cache_write_tokens,
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
