import Anthropic from '@anthropic-ai/sdk';
import { recordModelUsage, type CostContext } from '../db/index.js';
import {
  activeProvider,
  cacheKeyFields,
  coerceBySchema,
  ledgerVendor,
  resolveAnthropicEndpoint,
  resolveOpenAiEndpoint,
  type ForcedToolSpec,
} from './forcedTool.js';

// The spine's MULTI-TURN model transport (plan 2026-08-19, Phase 1).
//
// runForcedTool is one question, one answer, done: the tool there is a
// return-SHAPE contract the model is FORCED into, never a capability it may
// choose. That shape cannot express "look something up, then decide" — which is
// exactly what a planner does. This module adds the loop beside it rather than
// inside it: every existing caller keeps the single-shot guarantee (no
// unbounded turn count, no tool execution) and only new callers opt in.
//
// The wire difference is the same one runForcedTool documents, extended to the
// conversation:
//
//   anthropic  → messages[]; assistant content[] carries {type:'tool_use'};
//                results go back as a USER message of {type:'tool_result'} blocks
//   openai     → messages[]; assistant message carries tool_calls[];
//                results go back as {role:'tool', tool_call_id}
//
// Endpoint/key/model/cache-key resolution is IMPORTED from forcedTool.ts, never
// re-derived here — one account, one set of defaults.

// Every rail in this module is a CEILING, not a target. The planner is a model
// deciding when to bother people; a loop that can spin is a loop that can spend.
export const MAX_TOOL_LOOP_TURNS = 8;
// Named MAX, not DEFAULT: since callers are clamped rather than defaulted, no
// caller can raise it — only this constant can. Sized against the fleet's
// measured turn medians (Fireworks 6.3s, Nebius 7.8s, DeepInfra 14.1s in the
// date-eval trajectories), so 8 turns leaves ~11s each. If Phase 3's shadow
// latencies say that is tight, raise it HERE, and log a budget throw distinctly
// from a model error — a healthy-but-slow planner that throws reads as a
// silently skipped tick.
export const MAX_TOOL_LOOP_BUDGET_MS = 90_000;
// A tool result is model INPUT — it is billed, and it displaces the prompt. The
// cap is generous enough for a 200-row spine read and small enough that a
// runaway query cannot blow the context; overflow is announced IN the result
// (silent truncation is the failure this repo keeps re-learning: a briefing that
// read complete and cited nothing, 2026-07-30).
export const MAX_TOOL_RESULT_CHARS = 20_000;
// The turn ceiling bounds MODEL calls, not tool calls — one assistant message may
// carry many. Without this, a model that emits 30 parallel reads turns one turn
// into 30 database round-trips and 30 × MAX_TOOL_RESULT_CHARS of prompt, on a
// cron tick. Calls past the ceiling still get a RESULT (both wire formats require
// one per call, or the next request is malformed) — it just says no.
export const MAX_TOOL_CALLS_PER_TURN = 8;

export interface ToolLoopRequest {
  system: string;
  user: string;
  /** Per-TURN output budget, not a budget for the whole loop. */
  maxTokens: number;
  /** Prefixes every thrown error so a failure names the caller, not this module. */
  label: string;
  maxTurns?: number;
  budgetMs?: number;
  /** Same meaning as ForcedToolRequest.reasoningEffort; ignored on the Anthropic path. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}

/** One tool the model actually invoked, with what came back. Returned for the
 *  caller's log: a planner's decision is only reviewable if you can see what it
 *  looked at. */
export interface ToolLoopCall {
  turn: number;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** The exact string handed back to the model (truncation note included). */
  result: string;
}

export interface ToolLoopResult {
  /** The final assistant text — the turn on which it stopped calling tools. */
  text: string;
  /** Model calls made (≤ maxTurns). */
  turns: number;
  calls: ToolLoopCall[];
}

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface ToolLoopDeps {
  /** Cost seam — injected by tests so "usage is recorded per turn" is assertable
   *  without writing cost_events, and so a DB-less unit test stays DB-less. */
  recordUsage?: typeof recordModelUsage;
}

interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

interface PendingCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Set when the model's arguments were not parseable — the loop reports this
   *  back to the model instead of executing anything. */
  parseError?: string;
}

interface ModelStep {
  text: string;
  toolCalls: PendingCall[];
  usage?: ModelUsage;
  /** Appended verbatim to the history so the next turn sees its own tool calls. */
  assistantMessage: unknown;
}

interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

/** The per-provider half. The LOOP itself — caps, execution, bookkeeping — is
 *  shared, so a rail added once applies to both wire formats. */
interface LoopTransport {
  initialHistory(): unknown[];
  /** `signal` carries the loop's REMAINING budget. Without it the budget is only
   *  a between-turn check, and a provider that TCP-stalls mid-request hangs the
   *  tick forever — which is how a 9-second agent turn became a 71-minute one in
   *  the date-eval runner. */
  step(history: unknown[], signal: AbortSignal): Promise<ModelStep>;
  toolResults(results: ToolResult[]): unknown[];
}

// Bound anything that could hang on the loop's remaining budget. Promise.race
// attaches a handler to `p`, so a late rejection is never unhandled; the work
// itself may still be in flight, but the LOOP is bounded, which is what a cron
// tick needs.
async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} exceeded the loop's remaining ${ms}ms budget`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

function truncationError(label: string, maxTokens: number, marker: string): Error {
  // Kept in step with runForcedTool's guard deliberately: a truncated turn is
  // not a parse error, and a tool call cut mid-arguments can still be valid
  // JSON with a required field simply absent (measured on GLM-5.2, 2026-07-30).
  return new Error(
    `${label}: model output was truncated at maxTokens=${maxTokens} (${marker}) — ` +
      'the turn is incomplete, so the result is not usable. Raise maxTokens for this caller.',
  );
}

function anthropicTransport(req: ToolLoopRequest, tools: ForcedToolSpec[]): LoopTransport {
  const { apiKey, model } = resolveAnthropicEndpoint();
  const client = new Anthropic({ apiKey });
  return {
    initialHistory: () => [{ role: 'user', content: req.user }],
    async step(history, signal) {
      const message = await client.messages.create(
        {
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
          })),
          messages: history as Anthropic.MessageParam[],
        },
        { signal },
      );
      if (message.stop_reason === 'max_tokens') {
        throw truncationError(req.label, req.maxTokens, 'stop_reason=max_tokens');
      }
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const toolCalls = message.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          name: b.name,
          // Anthropic hands back a parsed object — no JSON string to fail on.
          args: (b.input ?? {}) as Record<string, unknown>,
        }));
      return {
        text,
        toolCalls,
        usage: {
          inputTokens: message.usage?.input_tokens,
          outputTokens: message.usage?.output_tokens,
          cachedInputTokens: message.usage?.cache_read_input_tokens ?? undefined,
        },
        assistantMessage: { role: 'assistant', content: message.content },
      };
    },
    toolResults: (results) => [
      {
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
          is_error: r.isError,
        })),
      },
    ],
  };
}

function openAiTransport(req: ToolLoopRequest, tools: ForcedToolSpec[]): LoopTransport {
  const { apiKey, baseUrl, model } = resolveOpenAiEndpoint();
  return {
    initialHistory: () => [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    async step(history, signal) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          temperature: 0,
          ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
          ...cacheKeyFields(),
          messages: history,
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
          // 'auto', never forced: the loop ENDS when the model stops calling
          // tools, so forcing a call here would make termination impossible.
          tool_choice: 'auto',
        }),
      });
      if (!res.ok) {
        // Truncated: a gateway error body can be an entire HTML page.
        throw new Error(`${req.label}: inference ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const body = (await res.json()) as {
        choices?: Array<{
          finish_reason?: string;
          message?: {
            content?: string | null;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
          };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number } | null;
        };
      };
      const choice = body.choices?.[0];
      if (choice?.finish_reason === 'length') {
        throw truncationError(req.label, req.maxTokens, 'finish_reason=length');
      }
      const message = choice?.message;
      const rawCalls = message?.tool_calls ?? [];
      // Ids are synthesized when a provider omits them — and the SAME synthesized
      // id must go back in the echoed assistant message, or the follow-up
      // {role:'tool', tool_call_id} references a call the transcript does not
      // contain and a strict gateway 400s the next turn.
      const withIds = rawCalls.map((c, i) => ({ ...c, id: c.id ?? `call_${i}` }));
      const toolCalls: PendingCall[] = withIds.map((c) => {
        const id = c.id;
        const name = c.function?.name ?? '';
        const raw = c.function?.arguments;
        // Spec says a JSON string; some OpenAI-compatible providers hand back an
        // object already. Accept both, and turn a genuine parse failure into a
        // message the MODEL can act on rather than an exception that kills the
        // whole plan — a malformed call is the model's mistake to correct.
        if (raw && typeof raw === 'object') return { id, name, args: raw as Record<string, unknown> };
        if (typeof raw !== 'string') return { id, name, args: {}, parseError: 'arguments were absent' };
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { id, name, args: {}, parseError: 'arguments were not a JSON object' };
          }
          return { id, name, args: parsed as Record<string, unknown> };
        } catch {
          return { id, name, args: {}, parseError: 'arguments were not valid JSON' };
        }
      });
      return {
        text: (message?.content ?? '').trim(),
        toolCalls,
        usage: {
          inputTokens: body.usage?.prompt_tokens,
          outputTokens: body.usage?.completion_tokens,
          cachedInputTokens: body.usage?.prompt_tokens_details?.cached_tokens,
        },
        // Echoed as a KNOWN shape rather than the raw object: providers attach
        // their own fields (reasoning_content and friends) that no endpoint is
        // obliged to accept back.
        assistantMessage: {
          role: 'assistant',
          content: message?.content ?? null,
          ...(withIds.length ? { tool_calls: withIds } : {}),
        },
      };
    },
    toolResults: (results) =>
      results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content })),
  };
}

function stringifyResult(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (raw.length <= MAX_TOOL_RESULT_CHARS) return raw;
  return (
    raw.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n[TRUNCATED: this result was ${raw.length} characters and was cut to ` +
    `${MAX_TOOL_RESULT_CHARS}. It is INCOMPLETE — narrow the query rather than ` +
    'drawing a conclusion from what you can see.]'
  );
}

// The single entry point. Runs turns until the model answers without calling a
// tool, then returns that answer. Throws — never returns a partial plan — when a
// cap is hit: an answer produced by a loop that was cut off is an answer formed
// on incomplete evidence, and the caller cannot tell the difference from the
// text alone.
export async function runToolLoop(
  req: ToolLoopRequest,
  tools: ForcedToolSpec[],
  execute: ToolExecutor,
  ctx?: CostContext,
  deps: ToolLoopDeps = {},
): Promise<ToolLoopResult> {
  const recordUsage = deps.recordUsage ?? recordModelUsage;
  // CLAMPED, not defaulted: this module's rails are ceilings, and a caller that
  // asks for 100 turns is exactly the caller they exist for. A caller may only
  // ever ask for LESS.
  const maxTurns = Math.min(req.maxTurns ?? MAX_TOOL_LOOP_TURNS, MAX_TOOL_LOOP_TURNS);
  const budgetMs = Math.min(req.budgetMs ?? MAX_TOOL_LOOP_BUDGET_MS, MAX_TOOL_LOOP_BUDGET_MS);
  const transport =
    activeProvider() === 'anthropic' ? anthropicTransport(req, tools) : openAiTransport(req, tools);
  const allowed = new Map(tools.map((t) => [t.name, t]));

  const history = transport.initialHistory();
  const calls: ToolLoopCall[] = [];
  const started = Date.now();
  let turns = 0;

  for (;;) {
    if (turns >= maxTurns) {
      throw new Error(
        `${req.label}: tool loop hit the ${maxTurns}-turn ceiling without a final answer ` +
          `(${calls.length} tool calls made)`,
      );
    }
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) {
      throw new Error(
        `${req.label}: tool loop exceeded its ${budgetMs}ms budget after ${turns} turns`,
      );
    }

    // The budget is not just a between-turn check: it rides INTO the request, so
    // a stalled provider aborts instead of holding the tick open.
    let step: ModelStep;
    try {
      step = await transport.step(history, AbortSignal.timeout(remaining));
    } catch (err) {
      // ForcedToolRequest.label promises that every thrown error names its
      // caller. A DOMException from the abort signal is the one error that
      // arrives from outside this module's own throws — and it is precisely the
      // one a cron log will struggle to attribute, so it gets the label too.
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(
          `${req.label}: the provider did not respond within the loop's remaining ` +
            `${remaining}ms (turn ${turns + 1}, ${Date.now() - started}ms elapsed of ${budgetMs}ms)`,
          { cause: err },
        );
      }
      throw err;
    }
    turns += 1;
    // Per TURN, not per loop: runForcedTool bills once because it makes one
    // call. Billing a loop once would under-report it by up to maxTurns×.
    await recordUsage(ledgerVendor(), step.usage, ctx);

    if (step.toolCalls.length === 0) return { text: step.text, turns, calls };

    history.push(step.assistantMessage);
    const results: ToolResult[] = [];
    for (const [index, call] of step.toolCalls.entries()) {
      // EVERY branch goes through stringifyResult, errors included. A database
      // rejection can echo the offending statement back verbatim, and that is
      // exactly the result a confused model repeats turn after turn — an
      // unbounded error string would blow the prompt as surely as an unbounded
      // success one.
      let raw: unknown;
      let ok = false;
      if (call.parseError) {
        raw = `error: ${call.parseError}`;
      } else if (!allowed.has(call.name)) {
        // Deny-by-default, mirroring the dispatch gate: an unlisted name is
        // never handed to the executor, whatever the executor would have done
        // with it.
        raw = `error: '${call.name}' is not an available tool. Available: ${[...allowed.keys()].join(', ')}`;
      } else if (index >= MAX_TOOL_CALLS_PER_TURN) {
        raw =
          `error: this turn asked for ${step.toolCalls.length} tools at once; only the first ` +
          `${MAX_TOOL_CALLS_PER_TURN} were run. Ask for fewer, or ask again next turn.`;
      } else {
        const left = budgetMs - (Date.now() - started);
        if (left <= 0) {
          raw = `error: the loop's ${budgetMs}ms budget is spent — no tool was run.`;
        } else {
          try {
            const coerced = coerceBySchema(call.args, allowed.get(call.name)!.inputSchema) as Record<
              string,
              unknown
            >;
            call.args = coerced;
            raw = await withDeadline(execute(call.name, coerced), left, `tool '${call.name}'`);
            ok = true;
          } catch (err) {
            // A tool failure is information for the model (bad SQL, wrong
            // column), not a reason to abandon the plan — relay it and let it
            // correct.
            raw = `error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
      const content = stringifyResult(raw);
      results.push({ id: call.id, name: call.name, content, isError: !ok });
      calls.push({ turn: turns, name: call.name, args: call.args, ok, result: content });
    }
    history.push(...transport.toolResults(results));
  }
}
