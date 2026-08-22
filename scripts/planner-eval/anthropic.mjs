// The Anthropic caller for the planner-copy eval (plan 2026-08-22).
//
// NOT a production path. src/model/ speaks the OpenAI dialect (Fireworks,
// DeepInfra, Nebius all do), and wiring Anthropic into the app means migrating
// recordModelUsage's pricing too — a separate decision. This module exists so
// the eval can ask Opus 5 the planner's real question and account for what it
// cost, nothing more.
//
// Mechanics verified against
// https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
// (2026-08-22). Do not adjust the numbers below from memory — re-read the page.

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

// $ per MILLION tokens. `base` is the input rate every cache multiplier is
// taken against; `out` is priced separately and is never cached.
export const PRICES = {
  'claude-opus-5': { base: 5, out: 25 },
  'claude-sonnet-5': { base: 3, out: 15 },
  'claude-haiku-4-5-20251001': { base: 1, out: 5 },
};

// Multipliers ON the base input rate.
export const CACHE_MULT = { read: 0.1, write5m: 1.25, write1h: 2.0 };

/**
 * Dollars for ONE response's usage.
 *
 * Reads the `cache_creation` breakdown when it is present rather than pricing
 * `cache_creation_input_tokens` at a single rate: the two TTLs cost 1.25x and
 * 2x, so a run that mixes them is mispriced by any single-rate formula. The
 * fallback prices the whole write at the TTL we asked for, which is correct
 * for a single-TTL run and is the only thing we can say when the breakdown is
 * absent.
 */
export function costOf(usage, model, ttl = '5m') {
  const p = PRICES[model];
  if (!p) throw new Error(`no price table for ${model} — add it rather than guessing`);
  const M = 1e6;
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const bd = usage.cache_creation ?? null;
  const w5 = bd ? (bd.ephemeral_5m_input_tokens ?? 0) : ttl === '5m' ? (usage.cache_creation_input_tokens ?? 0) : 0;
  const w1 = bd ? (bd.ephemeral_1h_input_tokens ?? 0) : ttl === '1h' ? (usage.cache_creation_input_tokens ?? 0) : 0;
  const usd =
    (inTok * p.base +
      read * p.base * CACHE_MULT.read +
      w5 * p.base * CACHE_MULT.write5m +
      w1 * p.base * CACHE_MULT.write1h +
      outTok * p.out) /
    M;
  return {
    usd,
    inTok,
    outTok,
    read,
    write5m: w5,
    write1h: w1,
    // A read means the prefix was already cached. Reported per call so a run
    // can show "1 write then N-1 reads" instead of asserting it.
    cacheHit: read > 0,
  };
}

/**
 * What the SAME token counts would have cost under the other cache strategies.
 * Printed by analyze.mjs so the production TTL is a number you read rather
 * than a claim I make — see the header of run.mjs for why the eval's answer
 * and production's answer differ.
 */
export function counterfactuals(rows, model) {
  const p = PRICES[model];
  const M = 1e6;
  // The cacheable prefix is whatever was written or read on each call.
  const prefix = (r) => r.read + r.write5m + r.write1h;
  const totalPrefix = rows.reduce((a, r) => a + prefix(r), 0);
  const firstPrefix = rows.length ? prefix(rows[0]) : 0;
  const rest = totalPrefix - firstPrefix;
  return {
    noCache: (totalPrefix * p.base) / M,
    ttl5m: (firstPrefix * p.base * CACHE_MULT.write5m + rest * p.base * CACHE_MULT.read) / M,
    ttl1h: (firstPrefix * p.base * CACHE_MULT.write1h + rest * p.base * CACHE_MULT.read) / M,
    // Every call cold — what production gets from a 5m TTL on a 30-minute
    // cadence. Strictly worse than not caching at all.
    allWrites5m: (totalPrefix * p.base * CACHE_MULT.write5m) / M,
  };
}

/**
 * One planner turn. Forces submit_plan and returns the parsed arguments.
 *
 * The cache breakpoint goes on the LAST system block, which caches `tools`
 * too: prefixes build in the order tools -> system -> messages, so a
 * breakpoint at the end of system covers everything before it. The per-tick
 * gap blocks live in `messages` and are deliberately uncached — they change
 * every call, and a breakpoint after them would cache nothing reusable.
 *
 * tool_choice must NOT vary across a run: the docs list it as invalidating the
 * tools and system caches.
 */
export async function callPlanner({ system, tool, user, model, ttl = '5m', apiKey, fetchImpl = fetch }) {
  const cache = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  const body = {
    model,
    max_tokens: 4096,
    system: [{ type: 'text', text: system, cache_control: cache }],
    tools: [{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: user }],
  };
  const res = await fetchImpl(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`anthropic ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = await res.json();
  const block = (json.content ?? []).find((c) => c.type === 'tool_use' && c.name === tool.name);
  return {
    plan: block?.input ?? null,
    // Null plan is a FINDING, not a crash: a forced tool that did not fire is
    // exactly the kind of thing the eval exists to count.
    stopReason: json.stop_reason ?? null,
    usage: json.usage ?? {},
    cost: costOf(json.usage ?? {}, model, ttl),
    raw: json,
  };
}
