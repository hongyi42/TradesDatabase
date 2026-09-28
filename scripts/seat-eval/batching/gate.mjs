// Step 2c gate scorer (plan 2026-09-28-step-2c-batching, phase 4). Reads one
// driver run's session file and scores it against the seed:
//
//   node scripts/seat-eval/batching/gate.mjs <session events.jsonl> <seed.json> [resume]
//
// Every run: all batches done, no DONE batch begun again, how many of the seed's
// urgent households the final answer names.
// resume: after the "carry on" message, no fresh export, and none of the emails
// of the batches finished BEFORE the Stop appear in any tool result (their
// `ref E-###` tokens) — the resume read only what was left.
import { readFileSync } from 'node:fs';

const [eventsPath, seedPath, mode] = process.argv.slice(2);
if (!eventsPath || !seedPath) throw new Error('usage: gate.mjs <events.jsonl> <seed.json> [resume]');
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
const events = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const starts = new Map(); // toolCallId → {name, args}
const calls = []; // {i, name, args, result}
let carryOnAt = -1;
let final = '';
events.forEach((e, i) => {
  const d = e.data ?? {};
  if (e.type === 'user.message' && /carry on|keep going|continue/i.test(d.content ?? '') && carryOnAt < 0) carryOnAt = i;
  if (e.type === 'tool.execution_start') starts.set(d.toolCallId, { i, name: d.toolName, args: d.arguments ?? {} });
  if (e.type === 'tool.execution_complete' && starts.has(d.toolCallId)) {
    const s = starts.get(d.toolCallId);
    calls.push({ ...s, result: JSON.stringify(d.result ?? '') });
  }
  if (e.type === 'assistant.message' && !e.agentId && !(d.toolRequests?.length) && d.content) final = d.content;
});

const bp = calls.filter((c) => c.name === 'batch_progress');
const started = bp.find((c) => c.args.action === 'start' && /Started/.test(c.result));
const labels = started?.args.batches ?? [];
const doneAt = new Map(); // n → index of its successful done
const redone = [];
for (const c of bp) {
  const n = Number(c.args.n);
  if (c.args.action === 'done' && /done\./.test(c.result) && !doneAt.has(n)) doneAt.set(n, c.i);
  if (c.args.action === 'begin' && doneAt.has(n) && doneAt.get(n) < c.i) redone.push(n);
}
const allDone = labels.length > 0 && labels.every((_, k) => doneAt.has(k + 1));
const named = seed.urgent.filter((u) => final.includes(u.name));
const score = {
  batches: labels.length,
  allDone,
  redoneDoneBatches: redone,
  urgentNamed: `${named.length}/${seed.urgent.length}`,
  missed: seed.urgent.filter((u) => !final.includes(u.name)).map((u) => `${u.name} ${u.ref}`),
  cleared: bp.some((c) => c.args.action === 'clear' && c.result.includes('Cleared ')),
  toolCalls: calls.length,
};

if (mode === 'resume') {
  if (carryOnAt < 0) throw new Error('resume: no "carry on" message in this session');
  // Rows of the batches done before the Stop → their refs (the seed numbers
  // refs ascending, and the export is newest first: row r ↔ E-(count+1-r)).
  const beforeStop = [...doneAt.entries()].filter(([, i]) => i < carryOnAt).map(([n]) => n);
  const refs = [];
  for (const n of beforeStop) {
    const m = /(\d+)\D+(\d+)/.exec(labels[n - 1] ?? '');
    if (!m) continue;
    for (let r = Number(m[1]); r <= Number(m[2]); r += 1) refs.push(`E-${String(seed.count + 1 - r).padStart(3, '0')}`);
  }
  // Reading the job's own batch NOTES at the end is the procedure (they name
  // what earlier batches found); only a read of the SOURCE emails is a re-read.
  const readsNotes = (c) => /\/?batches\//.test(JSON.stringify(c.args)) && !/\.csv/.test(JSON.stringify(c.args));
  const after = calls.filter((c) => c.i > carryOnAt && !readsNotes(c));
  score.resume = {
    batchesDoneBeforeStop: beforeStop,
    reExported: after.some((c) => c.name === 'export_query'),
    reReadRefs: [...new Set(refs.filter((ref) => after.some((c) => c.result.includes(ref))))],
  };
}
console.log(JSON.stringify(score, null, 2));
