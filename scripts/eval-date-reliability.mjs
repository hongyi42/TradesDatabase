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
//
// Ground truth is computed INDEPENDENTLY of src/schedule/dateResolve.ts (plain
// JS Date here), so condition C is a real cross-check, not a tautology.
//
// Providers: OpenAI-compatible (the live bot: NVIDIA integrate / DeepInfra,
// model z-ai/glm-5.2) or Anthropic. Select with EVAL_PROVIDER.
//
//   node -r dotenv/config scripts/eval-date-reliability.mjs
//   EVAL_PROVIDER=openai EVAL_INFERENCE_API_KEY=… EVAL_MODEL=z-ai/glm-5.2 \
//     EVAL_INFERENCE_BASE_URL=https://integrate.api.nvidia.com/v1 \
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
function runResolve(refDate, a) {
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
  if (condition === 'A') return `${SYS_BASE}\nCurrent date: ${refDate}.\nReply with ONLY the date as YYYY-MM-DD, nothing else.`;
  const rich = `${SYS_BASE}\nRight now it is ${humanDay(refDate)}, in the America/Los_Angeles timezone.`;
  if (condition === 'B') return `${rich}\nReply with ONLY the date as YYYY-MM-DD, nothing else.`;
  return `${rich}\nYou are UNRELIABLE at date arithmetic — do not work dates out yourself. Call resolve_date to convert the day into a date, then reply with ONLY that date as YYYY-MM-DD.`;
}
const userFor = (phrase) => `The customer wants their visit ${phrase}. What is the exact date?`;

// ─────────────────────────────────────────────────── provider adapters ──
const PROVIDER = process.env.EVAL_PROVIDER || (process.env.EVAL_INFERENCE_API_KEY ? 'openai' : 'anthropic');
const MODEL = process.env.EVAL_MODEL || (PROVIDER === 'openai' ? 'z-ai/glm-5.2' : 'claude-haiku-4-5-20251001');
const OPENAI_BASE = process.env.EVAL_INFERENCE_BASE_URL || 'https://integrate.api.nvidia.com/v1';

async function callOpenAI({ system, user, tools }) {
  const body = {
    model: MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    max_tokens: 300,
    ...(tools ? { tools: [{ type: 'function', function: { name: 'resolve_date', description: RESOLVE_TOOL_DESC, parameters: RESOLVE_PARAMS } }] } : {}),
  };
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.EVAL_INFERENCE_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const msg = j.choices?.[0]?.message ?? {};
  const tc = msg.tool_calls?.[0];
  return { text: msg.content ?? '', toolCall: tc ? { name: tc.function.name, args: safeJSON(tc.function.arguments) } : null };
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
  try {
    const r = await callModel({ system, user, tools: condition === 'C' });
    if (condition === 'C' && r.toolCall?.name === 'resolve_date') {
      usedTool = true;
      answer = runResolve(c.refDate, r.toolCall.args); // the tool does the math
    }
    if (!answer) answer = extractDate(r.text); // fell back to (or only gave) text
  } catch (e) {
    return { ...c, condition, answer: null, correct: false, usedTool, error: String(e.message || e) };
  }
  return { ...c, condition, answer, correct: answer === c.expected, usedTool };
}

// simple concurrency pool
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ─────────────────────────────────────────────────────────── main ──
const CONDITIONS = { A: 'bare date only', B: 'rich grounding (Option 1)', C: 'grounding + resolve_date (Options 1+2)' };
const jobs = [];
for (const cond of Object.keys(CONDITIONS)) for (const c of CASES) jobs.push({ cond, c });

console.log(`Provider: ${PROVIDER}  Model: ${MODEL}`);
console.log(`${CASES.length} cases × ${Object.keys(CONDITIONS).length} conditions = ${jobs.length} model calls\n`);

const results = await pool(jobs, 6, ({ cond, c }) => runCase(cond, c));

const byCond = {};
for (const cond of Object.keys(CONDITIONS)) {
  const rs = results.filter((r) => r.condition === cond);
  const correct = rs.filter((r) => r.correct).length;
  const errored = rs.filter((r) => r.error).length;
  byCond[cond] = { n: rs.length, correct, pct: ((correct / rs.length) * 100).toFixed(1), errored, results: rs };
}

console.log('=== ACCURACY BY CONDITION ===');
for (const [cond, label] of Object.entries(CONDITIONS)) {
  const s = byCond[cond];
  console.log(`  ${cond}  ${s.correct}/${s.n}  (${s.pct}%)  — ${label}${s.errored ? `  [${s.errored} API errors]` : ''}`);
}
const toolUse = byCond.C.results.filter((r) => r.usedTool).length;
console.log(`\n  Condition C called resolve_date on ${toolUse}/${byCond.C.n} cases.`);

console.log('\n=== PER-TEMPLATE (condition A → B → C correct counts) ===');
for (const t of [...new Set(CASES.map((c) => c.template))]) {
  const cell = (cond) => byCond[cond].results.filter((r) => r.template === t && r.correct).length;
  const n = REF_DATES.length;
  console.log(`  ${t.padEnd(22)} A ${cell('A')}/${n}   B ${cell('B')}/${n}   C ${cell('C')}/${n}`);
}

console.log('\n=== SAMPLE FAILURES (up to 20) ===');
for (const r of results.filter((r) => !r.correct && !r.error).slice(0, 20)) {
  console.log(`  [${r.condition}] today=${r.refDate} "${r.phrase}" → got ${r.answer ?? 'none'}, expected ${r.expected} (${wnameOf(r.expected)})`);
}

const outPath = process.env.EVAL_OUT || join(tmpdir(), 'date-eval-results.json');
writeFileSync(outPath, JSON.stringify({ provider: PROVIDER, model: MODEL, byCond: Object.fromEntries(Object.entries(byCond).map(([k, v]) => [k, { n: v.n, correct: v.correct, pct: v.pct, errored: v.errored }])), results }, null, 2));
console.log(`\nFull results → ${outPath}`);
