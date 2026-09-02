import Anthropic from '@anthropic-ai/sdk';
import { recordModelUsage, type CostContext } from '../db/index.js';
import {
  activeProvider,
  ATTRIBUTION_HEADERS,
  DEFAULT_REASONING_EFFORT,
  cacheKeyFields,
  type ReasoningEffort,
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
//
// A DEFAULT since build 1b, no longer a ceiling nobody can raise. It still binds
// every caller that says nothing, and a numeric override may still only ask for
// LESS — but `maxTurns: null` opts out of it entirely, and the planner does
// (planner.ts). Kept at 8 for everyone else: a caller that suddenly makes eight
// model calls where it used to make one is a defect, and this is what surfaces
// it.
export const MAX_TOOL_LOOP_TURNS = 8;
// THE ONLY RAIL (build 1b, plan 2026-08-29). Hard-clamped, unlike the turn
// ceiling above: no caller may raise this one, because for a caller that has
// opted out of the turn ceiling it is the sole thing between a looping model and
// a cron process that never returns.
//
// 15 minutes, per the user's ruling of 2026-08-29: "Planner model calls occur 30
// minutes at a time, so it's ok if it does something truly long horizon. I would
// not try to put a maximum number over the planner's head to constrain it.
// Though I would try to keep it within 15 minutes or so for now." A SAFETY
// BOUND, not a design target — sized so normal operation never reaches it.
//
// Why the old 90_000 was dead code. It was sized "8 turns leaves ~11s each"
// against the fleet's turn medians, but the TURN ceiling always fired first.
// MEASURED on the pilot, GLM 5.3, its first two real ticks (2026-08-29T17:30:48Z
// and 18:00:37Z): 16.2s and 12.2s wall clock, 2 turns each, 5-9s per model call.
// At ~8s a turn the 8-turn ceiling stopped the loop around 64s — so this clock
// never once fired in production, and raising it alone would have changed
// nothing. Do NOT re-size it against figures collected before 2026-08-29T17:16Z:
// those are all Opus 5, whatever their date suggests.
//
// The platform is nowhere near binding: Render stops a cron run only after
// TWELVE HOURS, and an overrunning run DELAYS the next firing rather than
// dropping it (https://render.com/docs/cronjobs, verified 2026-08-29).
export const MAX_TOOL_LOOP_BUDGET_MS = 900_000;
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
// The loop must not START a turn the clock cannot pay for. Without this floor,
// the NORMAL way an opted-out caller ends is not a budget throw at all: with the
// turn ceiling gone, some turn eventually begins with a few hundred ms left, the
// model call is issued against an AbortSignal that fires almost immediately, and
// the loop reports "the provider did not respond" — a plain Error, not
// ToolLoopLimitError('budget'). The caller then books a CAPACITY exhaustion as a
// provider OUTAGE, which are the two things the typed error exists to separate.
//
// With the floor, the two are cleanly split: below it the loop stops and says
// `budget`; above it an abort really does mean the provider failed to answer in
// a workable amount of time. 15s is comfortably above the measured GLM 5.3 turn
// (5-9s, pilot 2026-08-29), so a turn started above the floor has a real chance
// to finish.
//
// NEVER pre-empts the FIRST turn: a caller that deliberately sets a tiny budget
// (the tests, and any future probe) must still get one attempt, and the abort
// path is what it is exercising.
export const MIN_TURN_BUDGET_MS = 15_000;
// A single TOOL call's ceiling, independent of the loop's. Before build 1b the
// loop budget was 90s, so this was implicitly 90s too; deriving it from the loop
// budget alone would have silently handed one hung spine read the full fifteen
// minutes. The extra allowance is for long-horizon THINKING, not for one I/O.
export const MAX_TOOL_CALL_MS = 90_000;

/**
 * The loop gave up on ITS OWN limits — not the model, not the provider.
 *
 * Phase-3 finding, paid in Phase 4: at two gaps the planner took 28.6s of a
 * 90s budget, and a firm with twenty gaps has no comfortable headroom. When
 * that lands it will look exactly like a provider outage in the logs unless
 * something separates them — and the two need opposite responses. A provider
 * error is waited out; a limit hit means the work no longer fits and the
 * ceiling (or the batching) has to change.
 *
 * Thrown rather than returned because both cases end the call with no plan:
 * the caller's job is to tell them apart, not to recover.
 */
export type ToolLoopLimit = 'budget' | 'turns';

export class ToolLoopLimitError extends Error {
  readonly limit: ToolLoopLimit;
  constructor(limit: ToolLoopLimit, message: string) {
    super(message);
    this.name = 'ToolLoopLimitError';
    this.limit = limit;
  }
}

export interface ToolLoopRequest {
  system: string;
  user: string;
  /** Per-TURN output budget, not a budget for the whole loop. */
  maxTokens: number;
  /** Prefixes every thrown error so a failure names the caller, not this module. */
  label: string;
  /**
   * `undefined` — the default ceiling, MAX_TOOL_LOOP_TURNS.
   * a NUMBER    — a lower ceiling; still clamped, so it can only ask for LESS.
   * `null`      — NO turn ceiling: the budget is the only rail.
   *
   * The null case is build 1b's opt-out, and the planner is its only user (user
   * ruling 2026-08-29: no maximum over the planner's head, and whether it needs
   * a ceiling at all is a question for the evaluation phase rather than an
   * assumption baked in now). A caller taking it inherits what the ceiling used
   * to discharge: the CLOCK is then the only thing that stops a model which
   * loops, and a `budget` limit hit stops being distinguishable from a `turns`
   * one because the latter can no longer occur.
   */
  maxTurns?: number | null;
  budgetMs?: number;
  /**
   * Name of a tool that ENDS the loop the moment the model calls it.
   *
   * For a caller whose answer is structured, the tool IS the answer — the same
   * return-SHAPE contract runForcedTool uses, reached after the model has read
   * whatever it needed. Without this the loop would have to wait for a further
   * text-only turn, which costs a full billed round-trip to hear "done", and
   * which the model may simply not produce — burning the whole plan on the turn
   * ceiling when a perfectly good answer had already arrived.
   *
   * The terminal tool still EXECUTES (that is how its arguments reach the
   * caller); the loop returns immediately after, with `text` from that same turn.
   */
  terminalTool?: string;
  /** Same meaning as ForcedToolRequest.reasoningEffort; ignored on the Anthropic path. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Called as each tool result is handed to the model, with EXACTLY the string
   * the model receives (build 6 Phase 4).
   *
   * The same `ToolLoopCall` objects come back in `result.calls`, so this exists
   * for one reason: a caller that needs them BEFORE the loop returns. The
   * planner is that caller — it validates a submitted plan inside the executor,
   * on the same turn, and part of that validation is checking a quote against
   * what the model was actually shown. Reading `result.calls` afterwards would
   * be too late by one turn.
   *
   * WHY THE STRING AND NOT THE RAW VALUE. `stringifyResult` truncates at
   * MAX_TOOL_RESULT_CHARS and appends a note saying so, so what the model saw
   * and what the executor returned are DIFFERENT for any large result. A caller
   * verifying "did the model see these words" has to be given the model's copy,
   * or it would accept a quote from past the cut — text no model ever read.
   *
   * Never allowed to break the loop: a throwing hook is caught and logged. This
   * is an observation channel, and a caller's bookkeeping bug must not lose a
   * plan the model has already produced.
   */
  onResult?: (call: ToolLoopCall) => void;
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
  /** TOTAL prompt tokens INCLUDING cached reads (the OpenAI convention —
   *  recordModelUsage subtracts the cached share). Transports whose native
   *  usage EXCLUDES cache activity (Anthropic) normalize to this here. */
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  /** Cache WRITES (Anthropic cache_creation_input_tokens) — their own price
   *  tier (2x base on the 1h TTL), never folded into reads or fresh. */
  cacheWriteTokens?: number;
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
      () => reject(new Error(`${what} exceeded its ${ms}ms deadline`)),
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
          // cache_control on the LAST system block caches tools+system as one
          // prefix (cache order: tools -> system -> messages), so every loop
          // turn after the first — and every same-window call sharing the
          // prefix — reads it at 0.1x instead of full price. Measured
          // 2026-08-23: this path ran UNCACHED in production while
          // scripts/planner-eval/anthropic.mjs cached the identical shape.
          // The 5-min default TTL outlives a planner tick's loop.
          system: [
            {
              type: 'text' as const,
              text: req.system,
              // 1h TTL (docs: ttl '1h', writes 2x, reads 0.1x, TTL refreshes
              // free on every read) — the planner ticks every 30 minutes, so
              // the 5-minute default was stone cold between ticks.
              cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
            },
          ],
          // Omitted when empty, matching the OpenAI transport (final review):
          // the Anthropic API tolerates `tools: []`, but the desk's tool-less
          // path runs on THIS transport in production (the web service's
          // MODEL_PROVIDER) — omit on both wires so neither can regress.
          ...(tools.length > 0
            ? {
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
                })),
              }
            : {}),
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
          // Anthropic's input_tokens EXCLUDES cache activity (docs: "tokens
          // after the last cache breakpoint"); normalize to the ledger's
          // includes-cached convention so the fresh split stays correct.
          inputTokens:
            typeof message.usage?.input_tokens === 'number'
              ? message.usage.input_tokens + (message.usage?.cache_read_input_tokens ?? 0)
              : undefined,
          outputTokens: message.usage?.output_tokens,
          cachedInputTokens: message.usage?.cache_read_input_tokens ?? undefined,
          cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? undefined,
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
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...ATTRIBUTION_HEADERS,
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          temperature: 0,
          reasoning_effort: req.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
          ...cacheKeyFields(),
          messages: history,
          // OMITTED ENTIRELY when the caller brought no tools (build 5.5 review
          // F3): serializing `tools: []` is a provider 400 on some OpenAI-
          // compatible endpoints, and the desk's technician path is the first
          // caller that legitimately runs tool-less. Both keys go together —
          // `tool_choice` without `tools` is its own 400.
          ...(tools.length > 0
            ? {
                tools: tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.inputSchema },
                })),
                // 'auto', never forced: the loop ENDS when the model stops
                // calling tools, so forcing a call here would make termination
                // impossible.
                tool_choice: 'auto',
              }
            : {}),
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
          prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
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
          // See forcedTool's twin: OpenRouter reports cache writes here.
          cacheWriteTokens: body.usage?.prompt_tokens_details?.cache_write_tokens,
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
  // `null` is the explicit opt-out (build 1b): time is the only rail, and the
  // turn count becomes the caller's business. A NUMBER is still clamped — a
  // caller may only ever ask for LESS than the default — so the opt-out has to
  // be its own value rather than a large number, which the clamp would eat.
  const maxTurns =
    req.maxTurns === null
      ? Number.POSITIVE_INFINITY
      : Math.min(req.maxTurns ?? MAX_TOOL_LOOP_TURNS, MAX_TOOL_LOOP_TURNS);
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
      throw new ToolLoopLimitError(
        'turns',
        `${req.label}: tool loop hit the ${maxTurns}-turn ceiling without a final answer ` +
          `(${calls.length} tool calls made)`,
      );
    }
    const remaining = budgetMs - (Date.now() - started);
    // `turns > 0`: always attempt one turn, however small the budget.
    const floor = turns > 0 ? Math.min(MIN_TURN_BUDGET_MS, budgetMs) : 0;
    if (remaining <= 0 || remaining < floor) {
      throw new ToolLoopLimitError(
        'budget',
        `${req.label}: tool loop exceeded its ${budgetMs}ms budget after ${turns} turns ` +
          `(${remaining}ms left, too little for another turn)`,
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
        // CAPPED independently of the loop (build 1b): see MAX_TOOL_CALL_MS.
        const left = Math.min(budgetMs - (Date.now() - started), MAX_TOOL_CALL_MS);
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
      const record: ToolLoopCall = { turn: turns, name: call.name, args: call.args, ok, result: content };
      calls.push(record);
      // Handed over the moment it exists, because the caller may need it before
      // this loop returns — see onResult's own header. Wrapped: a caller's
      // bookkeeping must never cost a plan the model already produced.
      if (req.onResult) {
        try {
          req.onResult(record);
        } catch (err) {
          console.error(`[toolLoop] ${req.label}: onResult threw — continuing`, err);
        }
      }
      // The terminal tool ends the loop as soon as it RUNS — only on success, so
      // a rejected submission still gets its error relayed and the model gets to
      // try again on a later turn — within whichever rail the caller kept: the
      // turn ceiling, or, for a `maxTurns: null` caller, the clock alone.
      if (ok && call.name === req.terminalTool) {
        return { text: step.text, turns, calls };
      }
    }
    history.push(...transport.toolResults(results));
  }
}
