// Two ways to answer a tool search.
//  - llmRetriever: a strong language model reads the WHOLE catalog and picks up
//    to 5 tools (the reference: generous, so the seat gets what it needs).
//  - jevRetriever: Jev picks from the catalog with a calibrated probability per
//    tool, with a "none of these" option and fallbacks when unsure.
import { CATALOG, KEY } from './seat.mjs';

const firstSentences = (s, n = 2) => (s ?? '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s/).slice(0, n).join(' ').slice(0, 400);

async function post(url, body, tries = 4) {
  for (let a = 1; ; a++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const t = await r.text();
      if (r.ok) return JSON.parse(t);
      if (!(r.status === 429 || r.status >= 500) || a >= tries) throw new Error(`${r.status}: ${t.slice(0, 200)}`);
    } catch (e) { if (a >= tries) throw e; }
    await new Promise((res) => setTimeout(res, a * 2000));
  }
}

export const llmStats = { calls: 0, cost: 0 };
export async function llmRetriever(query) {
  const list = CATALOG.map((t) => `- ${t.name}: ${firstSentences(t.description)}`).join('\n');
  const j = await post('https://openrouter.ai/api/v1/chat/completions', {
    model: '@preset/trades-seats',
    usage: { include: true },
    messages: [
      { role: 'system', content: 'You pick tools for an AI assistant. Given a capability request and a tool catalog, return JSON {"tools":[...]} with the names (exactly as listed) of the tools that provide it, best first, up to 5. Include every tool plausibly needed for that capability; never invent names.' },
      { role: 'user', content: `Catalog:\n${list}\n\nRequest: ${query}` },
    ],
    response_format: { type: 'json_object' },
  });
  llmStats.calls++; llmStats.cost += j.usage?.cost ?? 0;
  const text = j.choices?.[0]?.message?.content ?? '{}';
  try { return (JSON.parse(text.replace(/^```json|```$/g, '')).tools ?? []).slice(0, 5); } catch { return []; }
}

// ── Jev ────────────────────────────────────────────────────────────────────
export const NONE = 'none_of_these';
export function jevCriteria(describe = (t) => firstSentences(t.description, 2)) {
  const c = Object.fromEntries(CATALOG.map((t) => [t.name, describe(t)]));
  c[NONE] = 'None of the listed tools provides this capability.';
  return c;
}
export const jevStats = { calls: 0, cost: 0, ms: [] };
/** Raw Jev answer: probabilities over every tool (+ none_of_these). */
export async function jevRaw(query, { criteria = jevCriteria(), model = 'typesafe/jev-1.13' } = {}) {
  const t0 = Date.now();
  const j = await post('https://openrouter.ai/api/alpha/decisions', {
    model,
    state: { request: query },
    questions: { tool: { type: 'choice', instructions: 'An AI assistant for a trades business needs a tool. Which tool provides the capability it describes?', criteria } },
  });
  jevStats.calls++; jevStats.cost += j.usage?.cost ?? 0; jevStats.ms.push(Date.now() - t0);
  const a = j.answers?.tool ?? {};
  return { choice: a.choice ?? null, probs: a.probabilities ?? {}, confidence: a.confidence ?? null };
}
/**
 * Policy on top of Jev's probabilities:
 *  - one clear winner (top p >= hi): return the top `k1` (default 1) — usually one tool
 *  - otherwise (spread out, or "none of these" wins): return the top `kUnsure` tools
 */
export function jevPolicy(raw, { hi = 0.6, k1 = 1, kUnsure = 5 } = {}) {
  const ranked = Object.entries(raw.probs).filter(([n]) => n !== NONE).sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1] ?? 0;
  const noneWins = raw.choice === NONE;
  const confident = !noneWins && top >= hi;
  return { names: ranked.slice(0, confident ? k1 : kUnsure).map(([n]) => n), confident, noneWins, top };
}
