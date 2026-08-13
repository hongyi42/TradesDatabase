// Turn an openclaw session transcript into the SAME `Trajectory` shape the
// graders already consume.
//
// This is the whole trick behind tier 3: the corpus and the graders don't change,
// only where the trajectory comes from. Tier 2 builds one by being the agent loop;
// tier 3 reads one the gateway wrote to
// /sandbox/.openclaw/agents/main/sessions/<session-id>.jsonl. Same scenarios, same
// pass/fail rules, so `tier3 − tier2` is a difference in the TRANSPORT rather than
// a difference in what was asked or how it was judged.
//
// Every field name here was read off a real transcript rather than inferred, after
// guessing wrong twice in one session. Two would have silently broken grading:
//   * the arguments key is `arguments`, NOT `args`
//   * tool names are MCP-PREFIXED — `trades-spine__resolve_date` — and no grader
//     matches that, so every tool-choice check would have reported "never called"
//
// Event shape (from a live s6 run, openclaw 2026.6.34):
//   {type:'session'|'model_change'|'thinking_level_change'|'custom'|'message', ...}
//   message.role 'user'      → {content:[{type:'text',text}], timestamp}
//   message.role 'assistant' → {content:[{type:'thinking'}|{type:'text'}|
//                                        {type:'toolCall',id,name,arguments}],
//                               model, provider, stopReason, usage, timestamp}
//   message.role 'toolResult'→ {content:[{type:'text',text}], toolName, toolCallId,
//                               isError, details, timestamp}
//
// TWO TIMESTAMPS PER EVENT, AND THEY MEAN DIFFERENT THINGS. This cost a debugging
// round: `message.timestamp` is EPOCH MILLISECONDS (a number) marking when the
// request STARTED, while the top-level `timestamp` is an ISO string marking when
// the event was RECORDED — i.e. when it completed. `Date.parse(1786573495732)` is
// NaN, so treating the inner one as ISO silently skips every message and yields an
// empty trajectory that grades as "the agent said nothing".
//
// The distinction is a gift once you see it: for an assistant message,
// completed − started IS the model leg, measured rather than inferred. On the run
// this was found on, the legs reconcile to the wall clock within 10ms:
//   model 6.758s + 8.704s = 15.46s, tools 1.878s, wall 17.35s.
//
// `thinking` content blocks are normal (GLM-5.2 thinks by default) and are not
// part of the visible reply.

import type { RecordedCall, RecordedTurn, Trajectory } from './graders.js';

/**
 * MCP server prefixes to strip so tool names match what the graders expect.
 *
 * Deliberately an explicit list rather than a generic `/^\w+__/`: openclaw's own
 * native tools are unprefixed, so stripping anything that merely LOOKS prefixed
 * would erase the distinction between "the agent used a spine tool" and "the agent
 * used a built-in". That distinction is a finding in its own right.
 */
export const MCP_PREFIXES = ['trades-spine__', 'composio__'];

export function stripMcpPrefix(name: string): string {
  for (const p of MCP_PREFIXES) if (name.startsWith(p)) return name.slice(p.length);
  return name;
}

export interface TrajectoryTokens {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ParsedTrajectory extends Trajectory {
  models: string[];
  tokens: TrajectoryTokens;
  /** Assistant `stopReason`s in order — a truncated turn is not a wrong answer. */
  stopReasons: string[];
  /** Tool calls the model issued that never came back with a result. */
  danglingCalls: number;
  /**
   * True when modelMs was MEASURED per assistant message (completed − started),
   * false when it had to be derived as wall − tools. Reported so a comparison
   * never silently mixes a measurement with an inference.
   */
  modelMsMeasured: boolean;
}

interface RawEvent {
  type?: string;
  timestamp?: string;
  modelId?: string;
  message?: {
    role?: string;
    /** EPOCH MILLISECONDS — when the request started. Not an ISO string. */
    timestamp?: number | string;
    model?: string;
    stopReason?: string;
    usage?: { input?: number; output?: number; cacheRead?: number };
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    details?: { mcpTool?: string };
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      arguments?: Record<string, unknown>;
    }>;
  };
}

function joinText(content: NonNullable<NonNullable<RawEvent['message']>['content']>): string {
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

/**
 * Accept BOTH timestamp encodings openclaw uses in the same file: epoch
 * milliseconds (a number, on `message.timestamp`) and an ISO string (on the event).
 * Returns NaN for anything else so the caller can decide, rather than silently
 * producing 1970.
 */
export function parseTs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const n = Date.parse(value);
    if (Number.isFinite(n)) return n;
    // A numeric string is still epoch ms — openclaw has used both.
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return asNum;
  }
  return NaN;
}

/**
 * Parse a session `.jsonl` into a gradeable trajectory.
 *
 * Timing model, stated because it is a choice and not a measurement:
 *   * per-call `ms` = its toolResult timestamp − the previous boundary in its
 *     batch (the assistant message for the first call, the previous result
 *     thereafter). This assumes a batch runs SEQUENTIALLY, which is what a real
 *     run shows: four find_slots calls issued in one message returned at +3.7s,
 *     +6.6s, +9.6s, +12.6s — even ~2.9s gaps. Measuring each from the shared start
 *     reported 12.6s for a 2.9s call.
 *   * `toolMs` = per assistant message, (latest toolResult − assistant), summed.
 *     Uses the max rather than the sum, so a batch counts once against the turn
 *     however the individual calls are attributed.
 *   * `modelMs` = wallMs − toolMs. Derived rather than measured: everything that
 *     is not waiting on a tool is waiting on the model. Tier 2 measures its model
 *     leg directly; this is the honest equivalent when you only have timestamps.
 */
export function parseSessionJsonl(raw: string): ParsedTrajectory {
  const events: RawEvent[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t) as RawEvent);
    } catch {
      // A truncated final line is normal when a transcript is read while the
      // agent is still writing; skip it rather than fail the whole scenario.
    }
  }

  const models = new Set<string>();
  const tokens: TrajectoryTokens = { input: 0, output: 0, cacheRead: 0 };
  const stopReasons: string[] = [];
  const turns: RecordedTurn[] = [];
  const allCalls: RecordedCall[] = [];
  const assistantTexts: string[] = [];

  // Pending tool calls, keyed by call id, so a result can find the assistant
  // message that issued it even across interleaved parallel calls.
  const pending = new Map<string, { call: RecordedCall; issuedAt: number }>();
  // Per assistant message: when it was sent, the latest result it received, and a
  // moving boundary used to attribute each call in a BATCH (see below).
  const groups: Array<{ at: number; latest: number; boundary: number }> = [];

  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let turnIndex = -1;
  let measuredModelMs = 0;

  const current = () => (turnIndex >= 0 ? turns[turnIndex] : undefined);

  for (const e of events) {
    if (e.type === 'model_change' && e.modelId) models.add(e.modelId);
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    // `ts` is COMPLETION (top-level ISO); `startedAt` is when the request was sent
    // (message.timestamp, epoch ms). Ordering and the wall clock use completion.
    const ts = parseTs(e.timestamp ?? m.timestamp);
    const startedAt = parseTs(m.timestamp ?? e.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (firstTs === null) firstTs = ts;
    lastTs = ts;

    if (m.role === 'user') {
      turns.push({
        userText: joinText(m.content ?? []),
        assistantText: '',
        calls: [],
        modelMs: 0,
        wallMs: 0,
      });
      turnIndex = turns.length - 1;
      continue;
    }

    if (m.role === 'assistant') {
      if (m.model) models.add(m.model);
      if (m.stopReason) stopReasons.push(m.stopReason);
      if (m.usage) {
        tokens.input += m.usage.input ?? 0;
        tokens.output += m.usage.output ?? 0;
        tokens.cacheRead += m.usage.cacheRead ?? 0;
      }
      const text = joinText(m.content ?? []);
      if (text) {
        assistantTexts.push(text);
        const t = current();
        // The LAST assistant text in a turn is what the person saw as the reply;
        // earlier ones are narration alongside tool calls.
        if (t) t.assistantText = text;
      }
      // Measured model leg: completed − started, for THIS assistant message.
      if (Number.isFinite(startedAt) && ts >= startedAt) measuredModelMs += ts - startedAt;
      const calls = (m.content ?? []).filter((c) => c.type === 'toolCall');
      if (calls.length) groups.push({ at: ts, latest: ts, boundary: ts });
      for (const c of calls) {
        const call: RecordedCall = {
          tool: stripMcpPrefix(c.name ?? ''),
          args: c.arguments ?? {},
          resultText: '',
          isError: false,
          ms: 0,
          turn: Math.max(turnIndex, 0),
        };
        allCalls.push(call);
        current()?.calls.push(call);
        if (c.id) pending.set(c.id, { call, issuedAt: ts });
      }
      continue;
    }

    if (m.role === 'toolResult') {
      const body = joinText(m.content ?? []);
      const id = m.toolCallId ?? '';
      const hit = pending.get(id);
      if (hit) {
        hit.call.resultText = body;
        hit.call.isError = Boolean(m.isError);
        const g = groups.find((x) => x.at === hit.issuedAt);
        // Attribute from the MOVING BOUNDARY, not from the assistant message.
        //
        // The gateway executes a batch SEQUENTIALLY: observed on a real run where
        // one assistant message issued four find_slots calls and the results came
        // back at +3.7s, +6.6s, +9.6s, +12.6s — even ~2.9s gaps. Measuring each
        // from the shared start reported 12.6s for a call that took 2.9s, which
        // would send someone optimising a tool that is four times faster than the
        // number says. The gaps are the per-call cost.
        hit.call.ms = Math.max(0, ts - (g ? g.boundary : hit.issuedAt));
        if (g) {
          g.boundary = ts;
          if (ts > g.latest) g.latest = ts;
        }
        pending.delete(id);
      } else {
        // A result with no matching call — record it so the tool still appears in
        // the report rather than vanishing.
        const name = stripMcpPrefix(m.toolName ?? m.details?.mcpTool ?? 'unknown');
        const call: RecordedCall = {
          tool: name,
          args: {},
          resultText: body,
          isError: Boolean(m.isError),
          ms: 0,
          turn: Math.max(turnIndex, 0),
        };
        allCalls.push(call);
        current()?.calls.push(call);
      }
    }
  }

  const wallMs = firstTs !== null && lastTs !== null ? lastTs - firstTs : 0;
  const toolMs = groups.reduce((n, g) => n + (g.latest - g.at), 0);
  // Prefer the MEASURED model leg (per-message completed − started). Fall back to
  // subtraction only if the transcript lacked start timestamps, and say which was
  // used via `modelMsMeasured` so a report never mixes the two silently.
  const modelMsMeasured = measuredModelMs > 0;
  const modelMs = modelMsMeasured ? measuredModelMs : Math.max(0, wallMs - toolMs);

  // Per-turn wall/model, so a multi-turn scenario can be read turn by turn.
  for (const t of turns) {
    const tToolMs = t.calls.reduce((n, c) => Math.max(n, c.ms), 0);
    t.wallMs = 0; // filled by the driver, which knows the real turn boundaries
    t.modelMs = Math.max(0, t.wallMs - tToolMs);
  }

  return {
    turns,
    calls: allCalls,
    finalText: turns.length ? turns[turns.length - 1].assistantText : (assistantTexts.at(-1) ?? ''),
    assistantTexts,
    modelMs,
    toolMs,
    wallMs,
    models: [...models],
    tokens,
    stopReasons,
    danglingCalls: pending.size,
    modelMsMeasured,
  };
}
