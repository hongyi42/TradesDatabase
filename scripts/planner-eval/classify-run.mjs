// Can a cheap classifier tell what a seat's message to the office is?
// Jev (TypeSafe's "System One" decisions model) against the deployed GLM, on the
// same labelled corpus, with the same label descriptions. SPENDS MONEY (cents).
//
//   node scripts/planner-eval/classify-run.mjs            # prints what it would do
//   node scripts/planner-eval/classify-run.mjs --yes      # both models, 3 runs each
//   node scripts/planner-eval/classify-run.mjs --yes --only jev --runs 1
//
// JEV IS NOT A CHAT MODEL. OpenRouter refuses it on chat/completions ("a
// decisions model … Use the /api/alpha/decisions endpoint"). Its request is a
// `state` plus named `questions` — `choice` (labelled options, a probability
// each) and `noul` (a calibrated yes/no) — and it returns probabilities, never
// text. Shape from OpenRouter's reference, read 2026-09-22:
// https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
//
// PINNED, NOT `~typesafe/jev-latest`. The `~…-latest` id is a router that
// "always redirects to the latest model in the Jev family"; an evaluation that
// can change model between runs measures nothing. The resolved id is recorded
// per call.
//
// GLM IS HANDED THE SAME WORDS. One forced tool whose enum descriptions are the
// corpus's CATEGORIES text verbatim, and the same two instructions — so a
// difference in the result is the model, not the prompt.
//
// NO DATABASE. The key is read out of .env by name and nothing else is loaded
// (the notes-run rail: .env here points SUPABASE_URL at the pilot).

import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES, WAKE_WHEN, CORPUS } from './classify-corpus.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? true) : d;
};
const runs = Number(flag('runs', 3));
const only = flag('only', null); // 'jev' | 'glm'
const JEV_MODEL = flag('jev-model', 'typesafe/jev-1.13');
const GLM_MODEL = flag('glm-model', 'z-ai/glm-5.3');
const MODELS = only ? [only] : ['jev', 'glm'];

if (!args.includes('--yes')) {
  console.error(
    `This CALLS MODELS AND SPENDS MONEY (cents). Re-run with --yes.\n` +
      `  models: ${MODELS.join(', ')}   messages: ${CORPUS.length}   runs each: ${runs}\n` +
      `  jev: ${JEV_MODEL}   glm: ${GLM_MODEL}`,
  );
  process.exit(2);
}

const env = readFileSync(join(ROOT, '.env'), 'utf8');
const pick = (name) => (env.match(new RegExp(`^${name}=(.*)$`, 'm')) ?? [])[1]?.trim();
const KEY = pick('OPENROUTER_API_KEY') || pick('INFERENCE_API_KEY');
if (!KEY) {
  console.error('No OPENROUTER_API_KEY / INFERENCE_API_KEY in .env — nothing was sent.');
  process.exit(2);
}

const CATEGORY_Q = 'What kind of message is this, sent to a trades firm\'s office by a field assistant?';
const WAKE_Q = 'Should the office act on this message now, rather than at its next half-hourly look?';
// THE WAKE QUESTION IS POLICY, and the first run proved it. Its wording said a
// message "only recording something already finished" could wait — which
// contradicted the answer key (a finished job IS the office's to record, promptly:
// operator doctrine 2026-09-22, the office does the timely L2 writes). GLM
// followed the wording and scored 72% on a key the wording disagreed with.
// Reworded to the doctrine; run classify-2026-09-22T18-49-23-644Z keeps the old
// wording's result.
const WAKE_CRITERIA = {
  false: 'Nothing for the office to do: an acknowledgement or pleasantry, or news of a decision that is already fully recorded.',
  true: 'The office has something to do now: record work that was done or changed, file a standing instruction, answer a question, or deal with a problem.',
};

// Transient failures are retried; a 4xx that is not a rate limit is a broken
// request and surfaces at once (the notes-run rule). Jev's API went down under
// launch demand, so the backoff is real, not decoration.
async function post(url, body) {
  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - started;
    const text = await res.text();
    if (res.ok) return { json: JSON.parse(text), ms };
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt >= 4) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, attempt * 5000));
  }
}

async function askJev(m) {
  const { json, ms } = await post('https://openrouter.ai/api/alpha/decisions', {
    model: JEV_MODEL,
    state: { from: m.from, message: m.body },
    questions: {
      category: { type: 'choice', instructions: CATEGORY_Q, criteria: CATEGORIES },
      wake: { type: 'noul', instructions: WAKE_Q, criteria: WAKE_CRITERIA },
    },
  });
  const a = json.answers ?? {};
  return {
    category: a.category?.choice ?? null,
    categoryP: a.category?.probabilities?.[a.category?.choice] ?? null,
    confidence: a.category?.confidence ?? null,
    wakeP: a.wake?.noul ?? null,
    wake: typeof a.wake?.noul === 'number' ? a.wake.noul >= 0.5 : null,
    resolved: json.model ?? null,
    cost: json.usage?.cost ?? null,
    ms,
  };
}

const GLM_TOOL = {
  type: 'function',
  function: {
    name: 'classify',
    description: 'Record your decision about the message.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: Object.keys(CATEGORIES),
          description: `${CATEGORY_Q}\n${Object.entries(CATEGORIES).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`,
        },
        wake: {
          type: 'boolean',
          description: `${WAKE_Q}\n- false: ${WAKE_CRITERIA.false}\n- true: ${WAKE_CRITERIA.true}`,
        },
      },
      required: ['category', 'wake'],
    },
  },
};

async function askGlm(m) {
  const { json, ms } = await post('https://openrouter.ai/api/v1/chat/completions', {
    model: GLM_MODEL,
    // GLM thinks by default and a small budget truncates turn one (recorded
    // trap), so the ceiling is generous and the effort low — this is a lookup.
    max_tokens: 2048,
    reasoning: { effort: 'low' },
    usage: { include: true },
    tools: [GLM_TOOL],
    tool_choice: { type: 'function', function: { name: 'classify' } },
    messages: [
      { role: 'system', content: 'You classify messages that arrive in a trades firm\'s office inbox. Call classify exactly once.' },
      { role: 'user', content: JSON.stringify({ from: m.from, message: m.body }) },
    ],
  });
  let parsed = {};
  try {
    parsed = JSON.parse(json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments ?? '{}');
  } catch { /* scored as no answer */ }
  return {
    category: parsed.category ?? null,
    categoryP: null, // an LLM hands back a label, not a probability
    confidence: null,
    wakeP: null,
    wake: typeof parsed.wake === 'boolean' ? parsed.wake : null,
    resolved: json.model ?? null,
    cost: json.usage?.cost ?? null,
    ms,
  };
}

// Small concurrency: fast enough to finish in minutes, gentle enough on an
// early-access API. Latency is timed per call, so it is not distorted.
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j]); }
  }));
  return out;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = join(ROOT, 'thoughts/shared/evals', `classify-${stamp}`);
mkdirSync(dir, { recursive: true });
const out = join(dir, 'run.jsonl');
writeFileSync(out, '');

const jobs = [];
for (const model of MODELS) for (let r = 1; r <= runs; r += 1) for (const m of CORPUS) jobs.push({ model, r, m });

const rows = await pool(jobs, 3, async ({ model, r, m }) => {
  let ans; let error = null;
  try { ans = await (model === 'jev' ? askJev(m) : askGlm(m)); }
  catch (e) { error = e instanceof Error ? e.message : String(e); ans = {}; }
  const row = {
    model, run: r, id: m.id, hard: !!m.hard, want: m.cat, wantWake: WAKE_WHEN.has(m.cat),
    ...ans, error,
    ok: error ? null : ans.category === m.cat,
    wakeOk: error || ans.wake === null ? null : ans.wake === WAKE_WHEN.has(m.cat),
  };
  appendFileSync(out, `${JSON.stringify(row)}\n`);
  process.stdout.write(error ? 'E' : row.ok ? '.' : 'x');
  return row;
});
console.log('\n');

// ── the report ────────────────────────────────────────────────────────────────
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : '—');
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
for (const model of MODELS) {
  const mine = rows.filter((r) => r.model === model);
  const done = mine.filter((r) => !r.error);
  const clean = done.filter((r) => !r.hard);
  const hard = done.filter((r) => r.hard);
  const resolved = [...new Set(done.map((r) => r.resolved).filter(Boolean))].join(', ');
  console.log(`── ${model.toUpperCase()}  (${resolved || 'no answers'})`);
  console.log(`  category   clean ${clean.filter((r) => r.ok).length}/${clean.length} ${pct(clean.filter((r) => r.ok).length, clean.length)}` +
    `   hard ${hard.filter((r) => r.ok).length}/${hard.length}`);
  const w = done.filter((r) => r.wakeOk !== null);
  console.log(`  wake       ${w.filter((r) => r.wakeOk).length}/${w.length} ${pct(w.filter((r) => r.wakeOk).length, w.length)}`);
  // STABILITY: the same message, the same answer every run?
  const byId = new Map();
  for (const r of done) byId.set(r.id, [...(byId.get(r.id) ?? []), r.category]);
  const stable = [...byId.values()].filter((v) => new Set(v).size === 1).length;
  console.log(`  stable     ${stable}/${byId.size} messages gave one answer across ${runs} run(s)`);
  console.log(`  latency    p50 ${q(done.map((r) => r.ms), 0.5)}ms   p95 ${q(done.map((r) => r.ms), 0.95)}ms`);
  const cost = done.reduce((s, r) => s + (r.cost ?? 0), 0);
  console.log(`  cost       $${cost.toFixed(5)} total   $${(cost / Math.max(1, done.length)).toFixed(6)} per call`);
  if (model === 'jev') {
    // CALIBRATION, the thing only Jev can offer: is it surer when it is right?
    const conf = (xs) => (xs.length ? (xs.reduce((s, r) => s + (r.categoryP ?? 0), 0) / xs.length).toFixed(2) : '—');
    console.log(`  calibrated p(chosen) when right ${conf(done.filter((r) => r.ok))}   when wrong ${conf(done.filter((r) => r.ok === false))}`);
  }
  const misses = done.filter((r) => r.ok === false);
  for (const r of misses) console.log(`  MISS ${r.id}${r.hard ? ' (hard)' : ''} run ${r.run}: wanted ${r.want}, got ${r.category}${r.categoryP != null ? ` p=${r.categoryP.toFixed(2)}` : ''}`);
  const errs = mine.filter((r) => r.error);
  if (errs.length) console.log(`  ${errs.length} ERRORED — first: ${errs[0].error}`);
  console.log('');
}
console.log(dir);
