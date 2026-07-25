import Anthropic from '@anthropic-ai/sdk';

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
// Active provider is MODEL_PROVIDER (default 'openai' → GLM-5.2 via DeepInfra).
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
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.deepinfra.com/v1/openai';
const DEFAULT_OPENAI_MODEL = 'zai-org/GLM-5.2';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

export function activeProvider(): ModelProvider {
  return process.env.MODEL_PROVIDER === 'anthropic' ? 'anthropic' : 'openai';
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

async function callAnthropic(
  tool: ForcedToolSpec,
  req: ForcedToolRequest,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
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
  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === tool.name,
  );
  if (!toolUse) throw new Error(`${req.label}: model returned no ${tool.name} tool_use block`);
  return toolUse.input as Record<string, unknown>;
}

async function callOpenAiCompatible(
  tool: ForcedToolSpec,
  req: ForcedToolRequest,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.INFERENCE_API_KEY;
  if (!apiKey) throw new Error('INFERENCE_API_KEY is not set');
  const baseUrl = (process.env.INFERENCE_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.INFERENCE_MODEL || DEFAULT_OPENAI_MODEL,
      max_tokens: req.maxTokens,
      temperature: 0,
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
  return parseOpenAiToolArgs(await res.json(), tool.name, req.label);
}

// The single entry point. Returns the tool's arguments, schema-coerced; throws
// (never returns partial) when the model did not produce the forced tool call.
export async function runForcedTool(
  tool: ForcedToolSpec,
  req: ForcedToolRequest,
): Promise<Record<string, unknown>> {
  const args =
    activeProvider() === 'anthropic'
      ? await callAnthropic(tool, req)
      : await callOpenAiCompatible(tool, req);
  return coerceBySchema(args, tool.inputSchema) as Record<string, unknown>;
}
