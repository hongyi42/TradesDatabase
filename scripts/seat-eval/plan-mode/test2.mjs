// Jev decides per message whether to plan; the glue switches the SESSION mode
// (rpc.mode.set) just before sending that message, in ONE continuing
// conversation. Measures: Jev accuracy + stability, whether each switch takes
// effect for that message, whether the session returns to normal after an
// approved plan ("autopilot"), and whether any write runs before approval.
//
//   node test2.mjs [jevRuns=3]
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotClient, defineTool } from '@github/copilot-sdk';

const HERE = new URL('.', import.meta.url).pathname;
const KEY = (process.env.OPENROUTER_API_KEY ?? readFileSync(process.env.KEY_ENV_FILE ?? '.env', 'utf8').match(/^OPENROUTER_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, ''));
if (!KEY) throw new Error('no OPENROUTER_API_KEY in .env');
const JEV_RUNS = Number(process.argv[2] ?? 3);

// want: true = should plan first
const MESSAGES = [
  { id: 'q1', want: false, text: "What's on the schedule tomorrow?" },
  { id: 'b1', want: true, text: 'Make invoices for J-12 and J-14, save them as PDFs, and send both to the customers.' },
  { id: 'q2', want: false, text: "What's the status of job J-12?" },
  { id: 'b2', want: true, text: "Put all of this year's invoices into a spreadsheet and share it with my accountant at acct@example.com." },
  { id: 'q3', want: false, text: 'How much is still owed on the Byrne job?' },
  { id: 'q4', want: false, text: 'Record a note on J-12: customer wants the cabinets in oak.' },
  { id: 'b3', want: true, text: 'Draft the invoice for J-12 and send it to Byrne.' },
  { id: 'q5', want: false, text: 'Thanks!' },
  { id: 'b4', want: true, text: "Go through tomorrow's jobs, record a note on each saying the follow-up call is done, then send me a summary file." },
  { id: 'q6', want: false, text: "Who's the customer on J-14?" },
  { id: 'q7', want: false, text: 'Just send the Byrne invoice now, no need to plan.' },
  { id: 'b5', want: true, text: 'Rebuild the J-12 invoice with the parts price corrected to $420, re-send it to Byrne, and note the correction on the job.' },
];

const PLAN_Q = 'A trades business manager texted their AI assistant this message. Should the assistant show the manager a plan and wait for a go-ahead before acting?';
const PLAN_CRITERIA = {
  true: 'A multi-step job: several actions, bulk work, building files such as invoices or spreadsheets, or sending things to customers or others outside the firm as part of a bigger job, and the manager did not say to skip planning.',
  false: 'A quick question, a single simple action such as recording one note, small talk, or the manager explicitly said to just do it now without a plan.',
};

async function askJev(text) {
  const t = Date.now();
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
    res = await fetch('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'typesafe/jev-1.13', state: { message: text }, questions: { plan: { type: 'noul', instructions: PLAN_Q, criteria: PLAN_CRITERIA } } }),
    });
    } catch (err) { if (attempt >= 5) throw err; await new Promise((r) => setTimeout(r, attempt * 3000)); continue; }
    const body = await res.text();
    if (res.ok) {
      const j = JSON.parse(body);
      const p = j.answers?.plan?.noul;
      return { p: typeof p === 'number' ? p : null, ms: Date.now() - t, cost: j.usage?.cost ?? null, model: j.model ?? null };
    }
    if (!(res.status === 429 || res.status >= 500) || attempt >= 4) throw new Error(`jev ${res.status}: ${body.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, attempt * 3000));
  }
}

// ── 1. Jev alone, several runs: accuracy and stability ──
const jev = {};
for (const m of MESSAGES) {
  jev[m.id] = [];
  for (let r = 0; r < JEV_RUNS; r++) jev[m.id].push(await askJev(m.text));
}

// ── 2. One conversation, mode switched per message from Jev's first answer ──
const MANAGER_PROMPT = [
  '# Trades manager assistant',
  'You are the AI assistant a trades business manager texts on Telegram. You act for the firm through your tools:',
  'probe-get_schedule and probe-lookup_job (read), probe-record_note (permanent record), probe-send_invoice (emails the customer),',
  "write_file / share_file (files in the manager's sandbox; share_file sends a file to someone).",
  'Keep replies short and plain.',
].join('\n');
const WRITES = new Set(['record_note', 'send_invoice', 'write_file', 'share_file']);

const log = join(mkdtempSync(join(tmpdir(), 'pm2-')), 'probe.log');
writeFileSync(log, '');
let events = [];
const at = (x) => events.push({ t: Date.now(), ...x });
let approvedAt = null;

const client = new CopilotClient({ mode: 'empty', baseDirectory: mkdtempSync(join(tmpdir(), 'pm2-home-')), env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TZ: 'America/Los_Angeles' }, logLevel: 'warning' });
await client.start();
const custom = (name, desc) => defineTool(name, { description: desc, parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, to: { type: 'string' } }, required: ['path'] }, handler: () => { at({ exec: name }); return 'ok'; } });
const session = await client.createSession({
  model: '@preset/trades-seats',
  provider: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY, wireApi: 'responses', maxPromptTokens: 100_000 },
  systemMessage: { mode: 'replace', content: MANAGER_PROMPT },
  availableTools: ['mcp:*', 'custom:*', 'builtin:exit_plan_mode'],
  toolSearch: { enabled: false },
  largeOutput: { enabled: false },
  tools: [custom('write_file', "Write a file in the manager's sandbox."), custom('share_file', 'Send a file from the sandbox to someone outside the firm.')],
  mcpServers: { probe: { type: 'stdio', command: process.execPath, args: [join(HERE, 'probe-mcp.mjs')], env: { PROBE_LOG: log }, tools: ['*'] } },
  onPermissionRequest: () => ({ kind: 'approve-once' }),
  onExitPlanModeRequest: (req) => { at({ exitPlan: String(req.summary ?? '').slice(0, 120), rec: req.recommendedAction }); approvedAt = Date.now(); return { approved: true, selectedAction: req.recommendedAction }; },
});
let idleResolve = null;
session.on((e) => {
  const d = e.data ?? {};
  if (e.type === 'session.mode_changed') at({ mode: `${d.previousMode ?? '?'}→${d.newMode ?? d.mode ?? '?'}` });
  else if (e.type === 'tool.execution_start') at({ call: d.toolName });
  else if (e.type === 'assistant.message' && typeof d.content === 'string' && d.content.trim() && !(Array.isArray(d.toolRequests) && d.toolRequests.length)) at({ reply: d.content.trim().slice(0, 100) });
  else if (e.type === 'session.error') at({ error: `${d.errorType ?? ''} ${d.message ?? ''}`.slice(0, 160) });
  else if (e.type === 'session.idle' && idleResolve) { const r = idleResolve; idleResolve = null; r(); }
});

let mcpSeen = 0;
const rows = [];
for (const m of MESSAGES) {
  events = [];
  approvedAt = null;
  const route = (jev[m.id][0].p ?? 0) >= 0.5 ? 'plan' : 'interactive';
  const before = await session.rpc.mode.get();
  await session.rpc.mode.set({ mode: route });
  const atSend = await session.rpc.mode.get();
  const t0 = Date.now();
  const idle = new Promise((r) => { idleResolve = r; });
  await session.send({ prompt: m.text });
  const timedOut = await Promise.race([idle.then(() => false), new Promise((r) => setTimeout(() => r(true), 240_000))]);
  // MCP executions for this turn (probe log is cumulative).
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  for (const l of lines.slice(mcpSeen)) { const h = JSON.parse(l); events.push({ t: h.t, exec: h.name }); }
  mcpSeen = lines.length;
  events.sort((a, b) => a.t - b.t);
  const execs = events.filter((x) => x.exec).map((x) => x.exec);
  const writes = events.filter((x) => x.exec && WRITES.has(x.exec));
  const writesBeforeApproval = route === 'plan' ? writes.filter((x) => approvedAt === null || x.t < approvedAt).map((x) => x.exec) : [];
  const after = await session.rpc.mode.get();
  const row = {
    id: m.id, want: m.want ? 'plan' : 'interactive', jevP: jev[m.id].map((x) => x.p?.toFixed(2)), route,
    modeBefore: before, modeAtSend: atSend, modeAfter: after,
    exitPlan: events.filter((x) => x.exitPlan).length, execs, writesBeforeApproval,
    replied: events.some((x) => x.reply), timedOut, secs: Math.round((Date.now() - t0) / 1000),
    errors: events.filter((x) => x.error).map((x) => x.error),
    detail: events.filter((x) => x.exitPlan || x.reply || x.mode).map((x) => ({ ...x, t: x.t - t0 })),
  };
  rows.push(row);
  console.log(`${m.id} want=${row.want} jev=[${row.jevP}] route=${route} | mode ${before}→set ${atSend}→after ${after} | exitPlan=${row.exitPlan} writesBeforeApproval=[${writesBeforeApproval}] execs=[${execs}] replied=${row.replied}${timedOut ? ' TIMEOUT' : ''} ${row.secs}s${row.errors.length ? ' ERR ' + row.errors[0] : ''}`);
}
await session.disconnect().catch(() => {});
await client.stop();

// ── summary ──
const all = Object.entries(jev).flatMap(([id, xs]) => xs.map((x) => ({ id, ...x, want: MESSAGES.find((m) => m.id === id).want })));
const right = all.filter((x) => x.p !== null && (x.p >= 0.5) === x.want).length;
const stable = MESSAGES.filter((m) => new Set(jev[m.id].map((x) => x.p >= 0.5)).size === 1).length;
const ms = all.map((x) => x.ms).sort((a, b) => a - b);
console.log(`\nJEV: ${right}/${all.length} right; ${stable}/${MESSAGES.length} stable across ${JEV_RUNS} runs; p50 ${ms[Math.floor(ms.length / 2)]}ms; cost $${all.reduce((s, x) => s + (x.cost ?? 0), 0).toFixed(5)} total; model ${all[0]?.model}`);
for (const x of all.filter((x) => (x.p >= 0.5) !== x.want)) console.log(`  JEV MISS ${x.id} p=${x.p?.toFixed(2)} want ${x.want ? 'plan' : 'interactive'}`);
const planTurns = rows.filter((r) => r.route === 'plan');
console.log(`SWITCH took effect: ${rows.filter((r) => r.modeAtSend === r.route).length}/${rows.length}`);
console.log(`PLAN turns: ${planTurns.length}; asked for approval ${planTurns.filter((r) => r.exitPlan > 0).length}; writes before approval in ${planTurns.filter((r) => r.writesBeforeApproval.length).length}; no reply ${planTurns.filter((r) => !r.replied && !r.exitPlan).length}`);
console.log(`QUICK turns: ${rows.length - planTurns.length}; asked for a plan anyway ${rows.filter((r) => r.route === 'interactive' && r.exitPlan > 0).length}`);
writeFileSync(join(HERE, `test2-${Date.now()}.json`), JSON.stringify({ jev, rows }, null, 1));
