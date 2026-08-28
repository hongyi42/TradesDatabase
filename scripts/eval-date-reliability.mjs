// Date-reliability eval — measures how often the AGENT lands on the correct
// calendar date for a spoken day reference, under three conditions:
//
//   A  bare date      — system prompt has "Current date: YYYY-MM-DD" only
//                       (what the frontier labs inject by default; the model
//                        still computes the weekday + arithmetic itself)
//   B  rich grounding — "Right now it is <Weekday>, <Month D, YYYY> (<tz>)"
//                       (Option 1: hands the model the weekday, no tool)
//   C  grounding+tool — B plus the resolve_date tool the model must call
//                       (Options 1+2: the model parses, code does the math)
//   D  tool ONLY       — A plus the tool: no weekday handed over, no "you are
//                       unreliable" guard. Isolates what the TOOL is worth from
//                       what the SCAFFOLDING around it is worth (added
//                       2026-08-28: C bundles three interventions and cannot
//                       attribute a win to any one of them).
//
// Ground truth is computed INDEPENDENTLY of src/schedule/dateResolve.ts (plain
// JS Date here), so condition C is a real cross-check, not a tautology.
//
// Providers: OpenAI-compatible (the live bot: NVIDIA integrate / DeepInfra,
// model z-ai/glm-5.3 via OpenRouter) or Anthropic. Select with EVAL_PROVIDER.
//
//   node -r dotenv/config scripts/eval-date-reliability.mjs
//   EVAL_PROVIDER=openai EVAL_INFERENCE_API_KEY=… EVAL_MODEL=z-ai/glm-5.3 \
//     EVAL_INFERENCE_BASE_URL=https://openrouter.ai/api/v1 \
//     node -r dotenv/config scripts/eval-date-reliability.mjs

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─────────────────────────────────────────────── independent date truth ──
const WDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WIDX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dowOf = (iso) => new Date(`${iso}T00:00:00.000Z`).getUTCDay();
const wnameOf = (iso) => WDAYS[dowOf(iso)];
const comingOcc = (refDate, weekday) => addDays(refDate, (WIDX[weekday] - dowOf(refDate) + 7) % 7);
function humanDay(iso) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return `${WDAYS[d.getUTCDay()][0].toUpperCase() + WDAYS[d.getUTCDay()].slice(1)}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// ─────────────────────────────────────────────────────── the test corpus ──
// Reference "today"s chosen to stress the math: a mid-month Wednesday, a
// Friday, a Sunday, a month-end, a year-end, near a leap day, a Monday.
const REF_DATES = ['2026-07-15', '2026-07-17', '2026-07-19', '2026-07-31', '2026-12-31', '2028-02-27', '2026-11-02'];

// Each template: how it's phrased, and the TRUE date given a reference day.
const TEMPLATES = [
  { id: 'today', phrase: () => 'today', truth: (r) => r },
  { id: 'tomorrow', phrase: () => 'tomorrow', truth: (r) => addDays(r, 1) },
  { id: 'day-after-tomorrow', phrase: () => 'the day after tomorrow', truth: (r) => addDays(r, 2) },
  { id: 'in-3-days', phrase: () => 'in 3 days', truth: (r) => addDays(r, 3) },
  { id: 'a-week-from-today', phrase: () => 'a week from today', truth: (r) => addDays(r, 7) },
];
// Weekday-parameterised templates (Friday and Monday to vary the arithmetic).
for (const wd of ['friday', 'monday']) {
  TEMPLATES.push({ id: `this-${wd}`, phrase: () => `this ${wd}`, truth: (r) => comingOcc(r, wd) });
  TEMPLATES.push({ id: `next-${wd}`, phrase: () => `next ${wd}`, truth: (r) => addDays(comingOcc(r, wd), 7) });
  TEMPLATES.push({ id: `coming-${wd}`, phrase: () => `this coming ${wd}`, truth: (r) => comingOcc(r, wd) });
  TEMPLATES.push({ id: `two-weeks-${wd}`, phrase: () => `two weeks from this ${wd}`, truth: (r) => addDays(comingOcc(r, wd), 14) });
}
// An explicit date stated outright (20 days past each reference) — passthrough.
TEMPLATES.push({ id: 'explicit', phrase: (r) => `on ${addDays(r, 20)}`, truth: (r) => addDays(r, 20) });

const CASES = [];
for (const ref of REF_DATES) {
  for (const t of TEMPLATES) {
    CASES.push({ template: t.id, refDate: ref, phrase: t.phrase(ref), expected: t.truth(ref) });
  }
}

// ─────────────────────────────────────────────────── resolve_date (tool) ──
// A trimmed copy of the real tool's contract + resolver, so condition C runs
// the SAME logic the MCP server would when the model calls resolve_date.
const RESOLVE_TOOL_DESC =
  'Turn a spoken day (today, tomorrow, this Friday, next Tuesday, the Friday after next week, in 3 days) into a real calendar date. Pass weekday+weeksAhead (0=this coming, 1=next week, 2=the week after), OR dayShift (0=today,1=tomorrow), OR explicitDate (YYYY-MM-DD).';
const RESOLVE_PARAMS = {
  type: 'object',
  properties: {
    weekday: { type: 'string', enum: WDAYS.slice(1).concat('sunday'), description: 'Named day, lowercase. Pair with weeksAhead.' },
    weeksAhead: { type: 'integer', description: '0 = this coming <day>, 1 = next week, 2 = the week after.' },
    dayShift: { type: 'integer', description: '0 = today, 1 = tomorrow, 7 = a week out.' },
    explicitDate: { type: 'string', description: 'YYYY-MM-DD when an exact date was stated.' },
  },
  required: [],
};
function runResolve(refDate, a0) {
  // Mirror the real server's intArg coercion (src/mcp/server.ts): models —
  // GLM in particular — often emit zero-valued integer args as quoted strings
  // ("0"). The live tool coerces them; the harness must too, or it under-counts
  // the tool's real accuracy.
  const toInt = (v) => (typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v);
  const a = { ...a0 };
  if (a.weeksAhead !== undefined) a.weeksAhead = toInt(a.weeksAhead);
  if (a.dayShift !== undefined) a.dayShift = toInt(a.dayShift);
  const modes = [a.explicitDate !== undefined, a.weekday !== undefined, a.dayShift !== undefined].filter(Boolean).length;
  if (a.weeksAhead !== undefined && a.weekday === undefined) return null;
  if (modes !== 1) return null;
  if (a.explicitDate !== undefined) return /^\d{4}-\d{2}-\d{2}$/.test(a.explicitDate) ? a.explicitDate : null;
  if (a.weekday !== undefined) {
    const w = a.weeksAhead ?? 0;
    if (!Number.isInteger(w) || w < 0) return null;
    return addDays(comingOcc(refDate, a.weekday), w * 7);
  }
  if (!Number.isInteger(a.dayShift)) return null;
  return addDays(refDate, a.dayShift);
}

// ───────────────────────────────────────────────────────── prompts ──
const SYS_BASE =
  'You are the scheduling assistant for a home-services company. The user names a day; you must determine the exact calendar date.';
function systemFor(condition, refDate) {
  const bare = `${SYS_BASE}\nCurrent date: ${refDate}.`;
  if (condition === 'A') return `${bare}\nReply with ONLY the date as YYYY-MM-DD, nothing else.`;
  // D isolates THE TOOL. C bundles three separate interventions — rich
  // grounding, the "you are UNRELIABLE" guard, and the tool — so a C-beats-A
  // result cannot say which of the three earned it. D is the bare prompt plus
  // the tool and nothing else: no weekday handed over, no warning about the
  // model's own arithmetic. C minus D is what the SCAFFOLDING is worth once the
  // tool is present; D minus A is what the TOOL is worth on its own.
  if (condition === 'D') {
    return `${bare}\nCall resolve_date to convert the day into a date, then reply with ONLY that date as YYYY-MM-DD.`;
  }
  const rich = `${SYS_BASE}\nRight now it is ${humanDay(refDate)}, in the America/Los_Angeles timezone.`;
  if (condition === 'B') return `${rich}\nReply with ONLY the date as YYYY-MM-DD, nothing else.`;
  return `${rich}\nYou are UNRELIABLE at date arithmetic — do not work dates out yourself. Call resolve_date to convert the day into a date, then reply with ONLY that date as YYYY-MM-DD.`;
}
const userFor = (phrase) => `The customer wants their visit ${phrase}. What is the exact date?`;

// ─────────────────────────────────────────────────── provider adapters ──
const PROVIDER = process.env.EVAL_PROVIDER || (process.env.EVAL_INFERENCE_API_KEY ? 'openai' : 'anthropic');
const MODEL = process.env.EVAL_MODEL || (PROVIDER === 'openai' ? 'z-ai/glm-5.3' : 'claude-haiku-4-5-20251001');
const OPENAI_BASE = process.env.EVAL_INFERENCE_BASE_URL || 'https://openrouter.ai/api/v1';

// Reasoning is ON BY DEFAULT for GLM-5.2 on DeepInfra — a bare request (no
// reasoning field) returns a thinking trace and ~255 output tokens on a trivial
// date question. Probed 2026-08-04; `reasoning_effort: "none"` drops that to 7.
// That matters historically: the 2026-07 runs of this eval sent no reasoning
// field and capped max_tokens at 300, so the thinking trace was eating the
// answer budget. Set EVAL_REASONING_EFFORT to none|low|medium|high to control
// it, and EVAL_MAX_TOKENS to give thinking room (300 kept as the default so old
// invocations reproduce exactly).
const REASONING_EFFORT = process.env.EVAL_REASONING_EFFORT || null;
const MAX_TOKENS = Number(process.env.EVAL_MAX_TOKENS || 300);

async function callOpenAI({ system, user, tools }) {
  const body = {
    model: MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    max_tokens: MAX_TOKENS,
    ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
    ...(tools ? { tools: [{ type: 'function', function: { name: 'resolve_date', description: RESOLVE_TOOL_DESC, parameters: RESOLVE_PARAMS } }] } : {}),
  };
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.EVAL_INFERENCE_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const choice = j.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const tc = msg.tool_calls?.[0];
  return {
    text: msg.content ?? '',
    toolCall: tc ? { name: tc.function.name, args: safeJSON(tc.function.arguments) } : null,
    // finish_reason "length" means the cap was hit — with thinking on, that is
    // the answer being cut off by the trace rather than a reasoning failure.
    truncated: choice.finish_reason === 'length',
    outTokens: j.usage?.completion_tokens ?? null,
    reasoningChars: (msg.reasoning_content ?? msg.reasoning ?? '').length || 0,
  };
}
async function callAnthropic({ system, user, tools }) {
  const body = {
    model: MODEL,
    max_tokens: 300,
    system,
    messages: [{ role: 'user', content: user }],
    ...(tools ? { tools: [{ name: 'resolve_date', description: RESOLVE_TOOL_DESC, input_schema: RESOLVE_PARAMS }] } : {}),
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  let text = '';
  let toolCall = null;
  for (const block of j.content ?? []) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') toolCall = { name: block.name, args: block.input ?? {} };
  }
  return { text, toolCall };
}
const callModel = PROVIDER === 'openai' ? callOpenAI : callAnthropic;
function safeJSON(s) { try { return JSON.parse(s); } catch { return {}; } }
const extractDate = (t) => (t.match(/\d{4}-\d{2}-\d{2}/) || [null])[0];

// ─────────────────────────────────────────────────── run one case ──
async function runCase(condition, c) {
  const system = systemFor(condition, c.refDate);
  const user = userFor(c.phrase);
  let answer = null;
  let usedTool = false;
  let meta = {};
  try {
    const toolArm = condition === 'C' || condition === 'D';
    const r = await callModel({ system, user, tools: toolArm });
    meta = { truncated: !!r.truncated, outTokens: r.outTokens ?? null, reasoningChars: r.reasoningChars ?? 0 };
    if (toolArm && r.toolCall?.name === 'resolve_date') {
      usedTool = true;
      answer = runResolve(c.refDate, r.toolCall.args); // the tool does the math
    }
    if (!answer) answer = extractDate(r.text); // fell back to (or only gave) text
  } catch (e) {
    return { ...c, condition, answer: null, correct: false, usedTool, error: String(e.message || e) };
  }
  return { ...c, condition, answer, correct: answer === c.expected, usedTool, ...meta };
}

// simple concurrency pool
// RATE-LIMITED pool. OpenRouter applies a per-model `new-account-rpm` cap that
// a plain concurrency pool walks straight through: the first unpaced run here
// lost 372 of 392 calls to 429s and reported 0% on three conditions, which
// looks exactly like a catastrophic model result and is not one. Pacing is
// therefore part of the harness, not a courtesy — an eval that can silently
// report rate limiting as model failure is worse than no eval.
//
// EVAL_RPM caps the START rate (default 18, just under the observed 20).
async function pool(items, n, fn) {
  const out = new Array(items.length);
  const rpm = Number(process.env.EVAL_RPM || 18);
  const minGapMs = rpm > 0 ? Math.ceil(60_000 / rpm) : 0;
  let i = 0;
  let nextSlot = 0;
  const takeSlot = async () => {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + minGapMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      await takeSlot();
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

// ─────────────────────────────────────────────────────────── main ──
const CONDITIONS = {
  A: 'bare date only — no tool, no guard',
  B: 'rich grounding, no tool',
  C: 'grounding + guard + resolve_date',
  D: 'bare date + resolve_date ONLY — the tool isolated',
};
const jobs = [];
// EVAL_CONDITIONS=A,D runs a subset — the rate cap makes a full 4-condition
// sweep a ~20 minute job, and the two-arm question (bare prompt vs the tool
// isolated) is usually the one being asked.
const WANT = (process.env.EVAL_CONDITIONS || Object.keys(CONDITIONS).join(','))
  .split(',').map((x) => x.trim()).filter(Boolean);
for (const bad of WANT.filter((c) => !CONDITIONS[c])) {
  console.error(`unknown condition '${bad}' — known: ${Object.keys(CONDITIONS).join(', ')}`);
  process.exit(2);
}
for (const cond of WANT) for (const c of CASES) jobs.push({ cond, c });

console.log(`Provider: ${PROVIDER}  Model: ${MODEL}`);
console.log(`reasoning_effort: ${REASONING_EFFORT ?? '(unset — GLM-5.2 on DeepInfra thinks by DEFAULT)'}   max_tokens: ${MAX_TOKENS}`);
console.log(`${CASES.length} cases × ${WANT.length} condition(s) [${WANT.join(',')}] = ${jobs.length} model calls, paced at ${process.env.EVAL_RPM || 18} rpm\n`);

const results = await pool(jobs, 6, ({ cond, c }) => runCase(cond, c));

const byCond = {};
for (const cond of WANT) {
  const rs = results.filter((r) => r.condition === cond);
  const correct = rs.filter((r) => r.correct).length;
  const errored = rs.filter((r) => r.error).length;
  byCond[cond] = { n: rs.length, correct, pct: ((correct / rs.length) * 100).toFixed(1), errored, results: rs };
}

console.log('=== ACCURACY BY CONDITION ===');
for (const [cond, label] of Object.entries(CONDITIONS).filter(([k]) => WANT.includes(k))) {
  const s = byCond[cond];
  console.log(`  ${cond}  ${s.correct}/${s.n}  (${s.pct}%)  — ${label}${s.errored ? `  [${s.errored} API errors]` : ''}`);
}
const toolUse = byCond.C.results.filter((r) => r.usedTool).length;
console.log(`\n  Condition C called resolve_date on ${toolUse}/${byCond.C.n} cases.`);

// Truncation is the confound to watch: with thinking on, a hit cap means the
// answer was cut off by the trace, which reads as a wrong answer but isn't one.
console.log('\n=== TRUNCATION / OUTPUT SIZE (hit max_tokens = answer cut off) ===');
for (const cond of WANT) {
  const rs = byCond[cond].results.filter((r) => !r.error);
  const trunc = rs.filter((r) => r.truncated).length;
  const outs = rs.map((r) => r.outTokens).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  const med = outs.length ? outs[Math.floor(outs.length / 2)] : null;
  const reas = rs.filter((r) => (r.reasoningChars ?? 0) > 0).length;
  console.log(`  ${cond}  truncated ${trunc}/${rs.length}   median out=${med ?? '-'} tok   with-reasoning-trace ${reas}/${rs.length}`);
}

console.log(`\n=== PER-TEMPLATE (${WANT.join(' → ')} correct counts) ===`);
for (const t of [...new Set(CASES.map((c) => c.template))]) {
  const cell = (cond) => byCond[cond].results.filter((r) => r.template === t && r.correct).length;
  const n = REF_DATES.length;
  console.log(
    `  ${t.padEnd(22)} ` +
      WANT.map((k) => `${k} ${cell(k)}/${n}`).join('   '),
  );
}

console.log('\n=== SAMPLE FAILURES (up to 20) ===');
for (const r of results.filter((r) => !r.correct && !r.error).slice(0, 20)) {
  console.log(`  [${r.condition}] today=${r.refDate} "${r.phrase}" → got ${r.answer ?? 'none'}, expected ${r.expected} (${wnameOf(r.expected)})`);
}

const outPath = process.env.EVAL_OUT || join(tmpdir(), 'date-eval-results.json');
writeFileSync(outPath, JSON.stringify({ provider: PROVIDER, model: MODEL, byCond: Object.fromEntries(Object.entries(byCond).map(([k, v]) => [k, { n: v.n, correct: v.correct, pct: v.pct, errored: v.errored }])), results }, null, 2));
console.log(`\nFull results → ${outPath}`);
