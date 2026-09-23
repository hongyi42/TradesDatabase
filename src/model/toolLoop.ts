import { createHash } from 'node:crypto';
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
// NOT A TURN CEILING — the one rail that counts turns without capping them.
//
// Build 1b took the turn ceiling off the planner (user: "I would not try to put
// a maximum number over the planner's head to constrain it"), leaving the clock
// alone against a model that loops. MEASURED, 2026-09-11 19:30Z, pilot firm
// 82bbc6f8: turns 1-13 varied, then 602 turns emitted EXACTLY 73 output tokens
// each, ~1.5s apart, until the 15-minute clock killed the tick at turn 620. The
// same call, the same answer, six hundred times. $8.67 — and it ended by
// exhausting the OpenRouter key's MONTHLY limit, so every tick for the next
// hours died on `inference 403: Key limit exceeded`. Cost is QUADRATIC in turns
// because each one resends the whole history; caching (99.8% hit) is all that
// kept it off ~$45.
//
// The ruling still stands and this does not touch it: a turn that learned
// something is never counted. Only a turn whose every call was one the loop had
// already made and been given the IDENTICAL answer to counts. A planner thinking
// for fifty turns is untouched; a planner asking the same question five times in
// a row has stopped thinking.
//
// AND THE FIRST ANSWER IS TO TELL IT, NOT TO KILL IT (user, 2026-09-11): "I
// think we should tell the model and let it decide. We can give it the option to
// give up on something, close it, or what not." At five wasted turns the loop
// says so, in a note beside the results, and the model decides what to do with
// that — finish, leave something unsettled, give it up. Only if it repeats
// another five turns after being told does the loop stop it.
//
// Why telling comes first, beyond it being the kinder read: a stall is
// DETERMINISTIC. Same firm, same rows, same prompt, so a tick killed for
// stalling would stall again at the next tick, and the next — red every half
// hour, planning nothing, until a human intervenes (user: "it might hit the same
// thing and might run over and over again on the same loop issue"). A tick that
// is told can still finish, and a firm that keeps needing to be told shows up as
// `stalledWarnings` in its tick record rather than as a dead planner.
//
// Five, not the previous turn alone: fingerprints are remembered for the whole
// call, so an A→B→A→B cycle is caught too — it learns nothing new either, and
// comparing against only the last turn would never see it.
export const MAX_STALLED_TURNS = 5;

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
/**
 * `budget` — the clock ran out: the work stopped fitting.
 * `turns`  — the turn ceiling: too many model calls for a caller that kept it.
 * `stalled` — the loop stopped LEARNING and kept at it AFTER BEING TOLD:
 *   MAX_STALLED_TURNS turns of repeats, a note saying so, then another
 *   MAX_STALLED_TURNS turns of the same. Opposite meaning to `budget` and it
 *   wants an opposite response: a budget hit says the queue outgrew the clock
 *   (raise the ceiling, or batch the work), a stall says the model is repeating
 *   itself and did not take the exit it was offered — read the tick's tool
 *   tally, then look at the prompt; no clock or ceiling would have made it
 *   finish. A tick that was told and then RECOVERED never reaches this: it
 *   shows up as `stalledWarnings` on an otherwise successful plan.
 */
export type ToolLoopLimit = 'budget' | 'turns' | 'stalled';

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
  /**
   * Called when the loop has just TOLD the model it is repeating itself (see
   * MAX_STALLED_TURNS) — not when it gives up, which is the thrown
   * ToolLoopLimitError('stalled') instead.
   *
   * Exists for the same reason `onResult` does: a caller that must know BEFORE
   * the loop returns, because the loop may never return normally. A tick that
   * was told and then recovered looks identical to a healthy tick in every
   * other record, and "this firm has to be told every time" is the signal that
   * its prompt, not its clock, is what needs fixing.
   *
   * Never allowed to break the loop: a throwing hook is caught and logged.
   */
  onStall?: () => void;
  /**
   * The CALLER's cancel switch (plan 2026-09-22, the office): aborted when the
   * person waiting on this loop has hung up. Checked before every turn and
   * carried into the model request beside the budget, so a loop nobody is
   * waiting for stops at its next turn instead of running out its clock. The
   * error it throws names the hang-up, so a caller can tell it from a failure.
   */
  signal?: AbortSignal;
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
  /**
   * How many times this loop had to tell the model it was repeating itself
   * (MAX_STALLED_TURNS). Zero on a healthy call; 1 means it wobbled and
   * RECOVERED — the answer below was produced after being told. It cannot
   * exceed 1 today, because a second stall throws instead; it is a count rather
   * than a flag so that stays true by construction if the rule ever changes.
   */
  stalledWarnings: number;
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
  /**
   * `note` is the loop speaking to the model IN ITS OWN VOICE — see
   * MAX_STALLED_TURNS. It rides BESIDE the results, never inside one: a tool
   * result is evidence the caller may let the model quote (the planner feeds
   * CITABLE_TOOLS results into its quote check), and machinery's words must
   * never become quotable as something a customer or a record said.
   *
   * Anthropic wants tool_result blocks at the START of the user turn, so the
   * note is a text block after them in that same message. The OpenAI wire has
   * no such container — the results are their own `role:'tool'` messages — so
   * it gets a plain user message after them (consecutive same-role messages
   * are permitted and are combined into one turn).
   */
  toolResults(results: ToolResult[], note?: string): unknown[];
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
    toolResults: (results, note) => [
      {
        role: 'user',
        content: [
          ...results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: r.content,
            is_error: r.isError,
          })),
          ...(note ? [{ type: 'text', text: note }] : []),
        ],
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
    toolResults: (results, note) => [
      ...results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content })),
      ...(note ? [{ role: 'user', content: note }] : []),
    ],
  };
}

// Key order is the model's, not ours: the same call re-emitted with `{sql, max}`
// one turn and `{max, sql}` the next is the SAME call, and a plain JSON.stringify
// would read it as progress. Sorted, recursively, so the fingerprint is about
// content alone.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

// HASHED, never the strings themselves. A result runs to MAX_TOOL_RESULT_CHARS
// (20k) and the loop that needs this most is the one making hundreds of turns ×
// up to 8 calls — holding those verbatim is ~96MB of retained strings on a box
// whose per-turn hazard is already memory, not CPU. sha1 is a fingerprint here,
// not a security claim: the inputs are this process's own tool results.
function fingerprint(name: string, args: Record<string, unknown>, result: string): string {
  // LENGTH-PREFIXED, never separated. A separator has to be a character that
  // cannot occur in any part, and reaching for one is how a literal NUL got into
  // this file (2026-09-12): typed as a \u0000 escape, saved as the raw byte by an
  // editing tool, and thereafter invisible — `grep` answers "Binary file matches"
  // and shows none of this file's lines, while tsc, eslint, the suite and the
  // build all pass. Framing each part with its own length needs no such
  // character, and no two parts can run together into a third reading.
  const parts = [name, canonical(args), result];
  return createHash('sha1').update(parts.map((p) => `${p.length}:${p}`).join('')).digest('hex');
}

// WHAT, not how (the doctrine rule this repo learned the expensive way): it says
// what is true — these answers will not change — then opens ONE door and names
// the exits. The model decides which, including deciding that something cannot
// be settled today.
//
// "Try a different angle" is deliberately the first option offered (user,
// 2026-09-11: "tell it to look another direction"). An earlier draft said only
// "finish or give up", which closes doors without opening any — a model stuck on
// one approach may simply have a better one available, and being told the
// current line is exhausted is enough for it to find that on its own.
//
// ONE CLAUSE, not a recipe: no worked method, no preferred basis. The 38-turn
// close of PR #226 is what two extra how-to paragraphs cost when they collide
// with rules already in the prompt. It also never names the caller's own verbs —
// a caller whose doctrine has better words for "give up" has taught them in its
// own system prompt already.
function stalledNote(names: string, terminalTool?: string): string {
  return (
    `NO NEW INFORMATION: the last ${MAX_STALLED_TURNS} turns repeated calls you had already ` +
    `made (${names}) and got back exactly what you had already been given. Asking again ` +
    'returns the same answer. Try a different angle, or decide with what you have and finish' +
    `${terminalTool ? ` by calling ${terminalTool}` : ''} — leaving something unsettled, or ` +
    'giving up on it, is a legitimate answer.'
  );
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
/** The caller hung up (ToolLoopRequest.signal) — not a failure of the loop. */
export class ToolLoopCancelledError extends Error {
  constructor(label: string, turns: number) {
    super(`${label}: the caller hung up — stopped after ${turns} turns`);
    this.name = 'ToolLoopCancelledError';
  }
}

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
  // Every (tool, arguments, answer) this call has already seen — the whole call,
  // not the last turn. See MAX_STALLED_TURNS.
  const seen = new Set<string>();
  let stalledTurns = 0;
  let stalledWarnings = 0;

  for (;;) {
    if (req.signal?.aborted) throw new ToolLoopCancelledError(req.label, turns);
    if (turns >= maxTurns) {
      throw new ToolLoopLimitError(
        'turns',
        `${req.label}: tool loop hit the ${maxTurns}-turn ceiling without a final answer ` +
          `(${calls.length} tool calls made)`,
      );
    }
    // The FIRST turn reads no clock. At a 1ms budget the millisecond can tick
    // over between `started` and this line — a loaded machine widens that gap —
    // and a first turn pre-empted by it is a coin toss, not a limit (a flaky
    // test, 2026-09-11). Only a budget that was never positive stops turn one.
    const remaining = turns === 0 ? budgetMs : budgetMs - (Date.now() - started);
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
      const clock = AbortSignal.timeout(remaining);
      step = await transport.step(history, req.signal ? AbortSignal.any([clock, req.signal]) : clock);
    } catch (err) {
      if (req.signal?.aborted) throw new ToolLoopCancelledError(req.label, turns);
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

    if (step.toolCalls.length === 0) return { text: step.text, turns, calls, stalledWarnings };

    history.push(step.assistantMessage);
    const results: ToolResult[] = [];
    // Did this turn learn ANYTHING? One new call-and-answer is enough — a turn
    // that re-reads something it already knows while also asking something new
    // is a model working, not a model stuck.
    let learnedSomething = false;
    // What the loop has to say to the model this turn, if anything. Rides beside
    // the results, never inside one — see LoopTransport.toolResults.
    let note: string | undefined;
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
      // PROGRESS = a call-and-answer this loop has not seen before. The ANSWER
      // is half of it, deliberately: the same read run again after a write that
      // changed the rows returns something new and IS progress, while the same
      // read returning the same rows is not. Errors count the same way — a model
      // re-sending a call that was refused with identical words learned nothing
      // from the refusal.
      const fp = fingerprint(call.name, call.args, content);
      if (!seen.has(fp)) {
        seen.add(fp);
        learnedSomething = true;
      }
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
        return { text: step.text, turns, calls, stalledWarnings };
      }
    }
    // One new thing anywhere in the turn clears the count: this rail is about a
    // loop that has stopped learning, never about how long it is allowed to
    // think (build 1b's ruling is untouched — see MAX_STALLED_TURNS).
    if (learnedSomething) stalledTurns = 0;
    else if ((stalledTurns += 1) >= MAX_STALLED_TURNS) {
      // NAMES ONLY, never arguments — in the note, the log and the error alike.
      // All three reach a cron log or the caller's error record, and a tool's
      // arguments can carry a customer's words; the name is what identifies the
      // repeat anyway.
      const names = [...new Set(results.map((r) => r.name))].join(', ');
      if (stalledWarnings === 0) {
        // TOLD, NOT KILLED — the first answer to a stall (user, 2026-09-11).
        // The counter resets, so the model gets a full further
        // MAX_STALLED_TURNS to act on what it has just been told.
        note = stalledNote(names, req.terminalTool);
        stalledWarnings += 1;
        stalledTurns = 0;
        console.error(
          `[toolLoop] ${req.label}: ${MAX_STALLED_TURNS} turns with no new information ` +
            `(${names}) — telling the model and letting it decide`,
        );
        if (req.onStall) {
          try {
            req.onStall();
          } catch (err) {
            console.error(`[toolLoop] ${req.label}: onStall threw — continuing`, err);
          }
        }
      } else {
        throw new ToolLoopLimitError(
          'stalled',
          `${req.label}: tool loop made no progress for ${MAX_STALLED_TURNS} turns running, was ` +
            `told so, and then repeated itself for ${MAX_STALLED_TURNS} more (turn ` +
            `${turns}, ${calls.length} tool calls made, last turn called: ${names}). Stopped well ` +
            `inside the ${budgetMs}ms clock: it had stopped learning, so more time would not ` +
            'have helped.',
        );
      }
    }
    history.push(...transport.toolResults(results, note));
  }
}
