// Three arms on the same ~30 messages: reference (LLM search), Jev search, all tools.
// Scored against the corpus labels: did the seat call every tool the label NEEDS?
import { readFileSync, writeFileSync } from 'node:fs';
const load = (f) => Object.fromEntries(readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.id, r]; }));
const corpus = load('corpus.jsonl');
const ids = readFileSync('sample30.txt', 'utf8').trim().split(',');
const arms = { reference_llm: load('ref.jsonl'), jev: load('cmp-jev.jsonl'), all_tools: load('cmp-all2.jsonl') };
const LACK = /(don'?t|do not|can'?t|cannot|unable to)[^.]{0,60}(tool|access|capabilit|able to)/i;
const out = {};
const per = [];
for (const [arm, R] of Object.entries(arms)) {
  let n = 0, full = 0, needSum = 0, needHit = 0, searches = 0, empty = 0, lack = 0, cost = 0, secs = 0, calls = 0, input = 0, timeouts = 0;
  for (const id of ids) {
    const r = R[id];
    if (!r || r.crash) continue;
    n++;
    const L = r.log.filter((x) => x.phase === 'test');
    const called = new Set(L.filter((x) => x.call).map((x) => x.call));
    const needs = corpus[id].needs;
    const hit = needs.filter((t) => called.has(t)).length;
    needSum += needs.length; needHit += hit;
    if (hit === needs.length) full++;
    searches += L.filter((x) => x.search).length;
    empty += L.filter((x) => x.search && !x.returned.length).length;
    const lastReply = r.replies.filter((x) => x.phase === 'test').at(-1)?.text ?? '';
    if (LACK.test(lastReply)) lack++;
    cost += r.seatCost ?? 0; secs += r.secs ?? 0; calls += r.usage?.calls ?? 0; input += r.usage?.input ?? 0;
    if (r.timedOut) timeouts++;
    per.push({ arm, id, category: corpus[id].category, needs, called: [...called], missing: needs.filter((t) => !called.has(t)), searches: L.filter((x) => x.search).map((x) => `${x.search} -> ${x.returned.join('|')}`), lastReply: lastReply.slice(0, 160) });
  }
  out[arm] = { messages: n, allNeedsCalled: `${full}/${n}`, needsCovered: `${((100 * needHit) / needSum).toFixed(1)}%`, searchesPerMsg: (searches / n).toFixed(2), emptySearches: empty, saidItLackedATool: lack, costPerMsg: `$${(cost / n).toFixed(4)}`, secsPerMsg: (secs / n).toFixed(1), inputTokensPerCall: Math.round(input / Math.max(1, calls)), modelCallsPerMsg: (calls / n).toFixed(2), timeouts };
}
writeFileSync('compare.json', JSON.stringify({ summary: out, per }, null, 1));
console.log(JSON.stringify(out, null, 1));
// Where Jev differs from all-tools on label coverage
const byArm = (a) => Object.fromEntries(per.filter((p) => p.arm === a).map((p) => [p.id, p]));
const J = byArm('jev'), A = byArm('all_tools');
console.log('\nJev missed a needed tool that all-tools called:');
for (const id of ids) { const j = J[id], a = A[id]; if (!j || !a) continue; const m = j.missing.filter((t) => !a.missing.includes(t)); if (m.length) console.log(`  ${id} [${j.category}] missing ${m.join(',')} | searches: ${j.searches.join(' ; ')}`); }
console.log('\nAll-tools missed a needed tool that Jev called:');
for (const id of ids) { const j = J[id], a = A[id]; if (!j || !a) continue; const m = a.missing.filter((t) => !j.missing.includes(t)); if (m.length) console.log(`  ${id} [${a.category}] missing ${m.join(',')}`); }
