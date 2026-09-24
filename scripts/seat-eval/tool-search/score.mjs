// Offline scoring of Jev as the tool search, on the REAL search requests the
// reference seat wrote. Ground truth for a search = the tools the seat called
// after it (until its next search) that the search had loaded — what it
// actually needed. Jev answers each search REPS times per criteria variant;
// policies are applied to the saved probabilities (no extra calls).
//
//   node score.mjs [--reps 3]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { CATALOG, CORE } from './seat.mjs';
import { jevRaw, jevCriteria, jevStats, NONE } from './retrievers.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const REPS = Number(arg('reps', '3'));
const ref = readFileSync('ref.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.crash);
const corpus = Object.fromEntries(readFileSync('corpus.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => { const c = JSON.parse(l); return [c.id, c]; }));

// ── 1. search requests + ground truth ──
const searches = [];
for (const r of ref) {
  const L = r.log.filter((x) => x.phase === 'test');
  for (let i = 0; i < L.length; i++) {
    if (!L[i].search) continue;
    const used = new Set();
    for (let j = i + 1; j < L.length && !L[j].search; j++) if (L[j].call && L[i].returned.includes(L[j].call)) used.add(L[j].call);
    searches.push({ id: r.id, category: corpus[r.id]?.category, hard: corpus[r.id]?.hard, q: L[i].search, returned: L[i].returned, used: [...used] });
  }
}
const scored = searches.filter((s) => s.used.length);
console.log(`${ref.length} messages, ${searches.length} searches, ${scored.length} with a tool used afterwards (scored); ${searches.length - scored.length} led to no call from their results`);

// ── 2. Jev answers (cached on disk so re-scoring is free) ──
const firstN = (s, n) => (s ?? '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s/).slice(0, n).join(' ');
const VARIANTS = {
  short: jevCriteria((t) => firstN(t.description, 2).slice(0, 400)),
  full: jevCriteria((t) => (t.description ?? '').replace(/\s+/g, ' ').slice(0, 1500)),
};
const cacheFile = 'jev-cache.json';
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
let fresh = 0;
for (const [v, criteria] of Object.entries(VARIANTS)) {
  for (const s of scored) {
    for (let k = 0; k < REPS; k++) {
      const key = `${v}|${k}|${s.q}`;
      if (cache[key]) continue;
      try { cache[key] = await jevRaw(s.q, { criteria }); fresh++; } catch (e) { cache[key] = { error: e.message, probs: {} }; }
      if (fresh % 25 === 0) writeFileSync(cacheFile, JSON.stringify(cache));
    }
  }
}
writeFileSync(cacheFile, JSON.stringify(cache));

// ── 3. policies over the saved probabilities ──
const rank = (raw) => Object.entries(raw.probs ?? {}).filter(([n]) => n !== NONE).sort((a, b) => b[1] - a[1]);
const POLICIES = {
  'top1': (raw) => rank(raw).slice(0, 1).map(([n]) => n),
  'top3': (raw) => rank(raw).slice(0, 3).map(([n]) => n),
  'top5': (raw) => rank(raw).slice(0, 5).map(([n]) => n),
  'confident1-else5 (hi .6)': (raw) => { const r = rank(raw); const ok = raw.choice !== NONE && (r[0]?.[1] ?? 0) >= 0.6; return r.slice(0, ok ? 1 : 5).map(([n]) => n); },
  'confident1-else5 (hi .8)': (raw) => { const r = rank(raw); const ok = raw.choice !== NONE && (r[0]?.[1] ?? 0) >= 0.8; return r.slice(0, ok ? 1 : 5).map(([n]) => n); },
  'confident2-else5 (hi .6)': (raw) => { const r = rank(raw); const ok = raw.choice !== NONE && (r[0]?.[1] ?? 0) >= 0.6; return r.slice(0, ok ? 2 : 5).map(([n]) => n); },
  'cumulative 0.9 (max 8)': (raw) => { const out = []; let c = 0; for (const [n, p] of rank(raw)) { out.push(n); c += p; if (c >= 0.9 || out.length >= 8) break; } return out; },
};
const withCore = (names) => new Set([...names, ...CORE]);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
const rows = [];
for (const v of Object.keys(VARIANTS)) {
  for (const [pname, pol] of Object.entries(POLICIES)) {
    let all = 0, any = 0, n = 0, tools = 0, noneWins = 0, flat = 0;
    const misses = [];
    for (const s of scored) {
      for (let k = 0; k < REPS; k++) {
        const raw = cache[`${v}|${k}|${s.q}`];
        if (!raw || raw.error) continue;
        const got = withCore(pol(raw));
        n++; tools += pol(raw).length;
        if (raw.choice === NONE) noneWins++;
        if ((rank(raw)[0]?.[1] ?? 0) < 0.6) flat++;
        const hitAll = s.used.every((u) => got.has(u));
        if (hitAll) all++;
        if (s.used.some((u) => got.has(u))) any++;
        if (!hitAll && k === 0) misses.push({ q: s.q, used: s.used, got: pol(raw), top: rank(raw).slice(0, 3).map(([a, p]) => `${a} ${p.toFixed(2)}`) });
      }
    }
    rows.push({ variant: v, policy: pname, n, allNeededFound: pct(all, n), anyFound: pct(any, n), avgToolsLoaded: (tools / n).toFixed(2), noneWins: pct(noneWins, n), unsure: pct(flat, n), missesSample: misses.slice(0, 12) });
  }
}
// stability: same top-1 across reps
const stab = {};
for (const v of Object.keys(VARIANTS)) {
  let same = 0, m = 0;
  for (const s of scored) { const tops = [...Array(REPS).keys()].map((k) => rank(cache[`${v}|${k}|${s.q}`] ?? {})[0]?.[0]); if (tops.every(Boolean)) { m++; if (new Set(tops).size === 1) same++; } }
  stab[v] = pct(same, m);
}
// reference retriever itself (the LLM) on the same yardstick
const llmAll = scored.filter((s) => s.used.every((u) => withCore(s.returned).has(u))).length;
const ms = jevStats.ms.sort((a, b) => a - b);
const summary = {
  messages: ref.length, searches: searches.length, scored: scored.length,
  referenceLLM: { allNeededFound: pct(llmAll, scored.length), avgToolsLoaded: (scored.reduce((a, s) => a + s.returned.length, 0) / scored.length).toFixed(2) },
  jevStability_top1_same_across_reps: stab,
  jevNewCalls: fresh, jevCost: jevStats.cost, jevLatency: ms.length ? { p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.floor(ms.length * 0.95)] } : null,
  table: rows.map(({ missesSample, ...r }) => r),
};
writeFileSync('score.json', JSON.stringify({ summary, rows, searches }, null, 1));
console.log(JSON.stringify(summary, null, 1));
