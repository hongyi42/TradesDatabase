// Run the corpus through the seat. Resumable (skips ids already in the output),
// 3 workers, and a HARD budget: priced from OpenRouter's generation records
// (the key's usage figure lags), it stops starting new items at --budget.
//
//   node run.mjs --retriever llm|jev --mode search|all --out ref.jsonl --budget 10 [--ids s001,s002] [--limit N]
import { appendFileSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeClient, runItem, spineClient, KEY } from './seat.mjs';
import { llmRetriever, llmStats, jevRaw, jevPolicy, jevStats, jevCriteria } from './retrievers.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', 'ref.jsonl');
const BUDGET = Number(arg('budget', '10'));
const MODE = arg('mode', 'search');
const RET = arg('retriever', 'llm');
const WORKERS = Number(arg('workers', '3'));
const corpus = readFileSync('corpus.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const done = new Set(existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);
let todo = corpus.filter((c) => !done.has(c.id));
const ids = arg('ids', null);
if (ids) todo = todo.filter((c) => ids.split(',').includes(c.id));
if (arg('limit', null)) todo = todo.slice(0, Number(arg('limit')));

const jevLog = [];
const FULL = jevCriteria((t) => (t.description ?? '').replace(/\s+/g, ' ').slice(0, 1500));
const retrieve = RET === 'llm' ? llmRetriever : async (q) => {
  const raw = await jevRaw(q, { criteria: FULL });
  const p = jevPolicy(raw, { hi: 0.6, k1: 2, kUnsure: 5 });
  jevLog.push({ q, ...p });
  return p.names;
};

async function genCost(id) {
  for (let a = 0; a < 6; a++) {
    await new Promise((r) => setTimeout(r, a === 0 ? 1500 : 4000 * a));
    try {
      const r = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${KEY}` } });
      if (r.ok) { const d = (await r.json()).data; if (d) return { cost: d.total_cost ?? 0, model: d.model }; }
    } catch {}
  }
  return { cost: null, model: null };
}

let spent = 0;
let stop = false;
const t0 = Date.now();
const client = makeClient(mkdtempSync(join(tmpdir(), 'run-')));
await client.start();
let next = 0;
let n = 0;
async function worker() {
  const spine = await spineClient();
  while (!stop && next < todo.length) {
    const item = todo[next++];
    let r;
    try { r = await runItem(client, spine, item, { retrieve, mode: MODE }); } catch (e) { r = { id: item.id, crash: e.message }; }
    const costs = await Promise.all((r.generations ?? []).map(genCost));
    r.seatCost = costs.reduce((s, c) => s + (c.cost ?? 0), 0);
    r.unpriced = costs.filter((c) => c.cost === null).length;
    r.models = [...new Set(costs.map((c) => c.model).filter(Boolean))];
    delete r.generations;
    appendFileSync(OUT, JSON.stringify(r) + '\n');
    spent = r.seatCost + spent;
    n++;
    const total = spent + llmStats.cost + jevStats.cost;
    const s = (r.log ?? []).filter((x) => x.phase === 'test');
    console.log(`${String(n).padStart(3)} ${item.id} ${r.crash ? 'CRASH ' + r.crash : `searches=${s.filter((x) => x.search).length} calls=[${s.filter((x) => x.call).map((x) => x.call).join(',')}] $${r.seatCost.toFixed(4)} ${r.secs}s${r.timedOut ? ' TIMEOUT' : ''}`} | total $${total.toFixed(3)}`);
    if (total >= BUDGET) { stop = true; console.log(`BUDGET $${BUDGET} reached — stopping`); }
  }
  await spine.close().catch(() => {});
}
await Promise.all(Array.from({ length: WORKERS }, worker));
await client.stop();
if (jevLog.length) appendFileSync(OUT.replace('.jsonl', '.jev.jsonl'), jevLog.map((x) => JSON.stringify(x)).join('\n') + '\n');
console.log(`done ${n} items in ${Math.round((Date.now() - t0) / 60000)} min; seat $${spent.toFixed(3)} + retriever $${(llmStats.cost + jevStats.cost).toFixed(4)} (${llmStats.calls + jevStats.calls} calls)`);
process.exit(0);
