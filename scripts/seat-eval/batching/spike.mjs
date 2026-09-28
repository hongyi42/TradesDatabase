// Step 2c spike (operator 2026-09-28: "run the spike first"): do the Copilot SDK's
// sub-agents (customAgents) work in the glue's mode "empty", and do they help
// a 100-email summary? A fake mailbox served by custom tools — no real mail.
//
//   node scripts/seat-eval/batching/spike.mjs <variant A|B|C> <outdir>
//     A = no sub-agents (baseline: the model pages itself)
//     B = customAgents defined, availableTools custom:* only
//     C = customAgents defined + builtin:task
// Needs `npm run build` and `npm i --no-save @github/copilot-sdk@1.0.14`.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [variant, out] = process.argv.slice(2);
if (!['A', 'B', 'C'].includes(variant) || !out) throw new Error('usage: spike.mjs A|B|C <outdir>');
mkdirSync(out, { recursive: true });
const WT = process.cwd();
const common = execSync('git rev-parse --path-format=absolute --git-common-dir').toString().trim();
const env = readFileSync(join(dirname(common), '.env'), 'utf8');
const key = env.split('\n').find((l) => l.startsWith('OPENROUTER_API_KEY=')).slice(19).trim().replace(/^["']|["']$/g, '');
const { startEngine, sessionConfig } = await import(`${WT}/dist/seatGlue/engine.js`);
const { TurnPolicy } = await import(`${WT}/dist/seatGlue/turnPolicy.js`);

// ── The fake mailbox: 100 emails, 12 urgent from named customers ──
const URGENT = ['Delgado', 'Feltham', 'Okafor', 'Lindqvist', 'Brennan', 'Castellano', 'Yamamoto', 'Petrov', 'Adeyemi', 'Holloway', 'Nakashima', 'Moreau'];
const ROUTINE = ['newsletter', 'invoice receipt', 'supplier price list', 'thank-you note', 'review request', 'parts shipping notice', 'webinar invite', 'warranty registration'];
const emails = Array.from({ length: 100 }, (_, i) => {
  const id = `m${String(i + 1).padStart(3, '0')}`;
  const u = i % 8 === 3 && URGENT[Math.floor(i / 8)];
  if (u) {
    // A BLAND subject: urgency is only in the body, so every email must be read
    // (run 1 with telling subjects: the model opened only the 12 that looked urgent).
    return { id, from: `${u} household <${u.toLowerCase()}@mail.example>`, subject: `Message from the ${u} household`,
      body: `Hi, this is the ${u} family. ${['Water is pooling under the water heater and spreading to the hallway.', 'The furnace stopped overnight and the house is 55 degrees with a newborn.', 'The panel breaker trips every hour and we smell something burning near it.'][i % 3]} Please send someone today — call 555-01${String(i).padStart(2, '0')}. `.repeat(3) };
  }
  const kind = ROUTINE[i % ROUTINE.length];
  const who = ['Ruiz', 'Chen', 'Walsh', 'Patel', 'Novak', 'Ibarra', 'Kowalski', 'Haddad'][i % 8];
  // The same sender shape as the urgent ones (run 2: bare addresses gave the urgent 12 away).
  return { id, from: `${who} household <${who.toLowerCase()}${i}@mail.example>`, subject: `Message from the ${who} household`, body: `Hi, this is the ${who} family writing about our ${kind}. All good here, no action needed, just keeping you posted. `.repeat(8) };
});
const notes = new Map();
const calls = [];
// FOUND in the spike: for a SUB-AGENT's tool call the engine emits external_tool.requested
// TWICE with the same requestId, and the SDK runs the handler each time. DEDUPE=1 answers
// a repeat of the same toolCallId with the first run's result instead of running again.
const DEDUPE = process.env.DEDUPE === '1';
const inflight = new Map();
let dupes = 0;
const tool = (name, description, properties, required, handler) => ({ name, description, parameters: { type: 'object', properties, required }, handler: async (a, inv) => {
  const id = inv?.toolCallId;
  if (DEDUPE && id && inflight.has(id)) { dupes += 1; return inflight.get(id); }
  calls.push({ name, at: Date.now(), args: JSON.stringify(a).slice(0, 120), id });
  const p = Promise.resolve().then(() => handler(a ?? {}));
  if (DEDUPE && id) inflight.set(id, p);
  return p;
} });
const tools = [
  tool('list_emails', "List the manager's recent emails, newest first: id, from, subject only (no bodies). Pages of up to 50.", { offset: { type: 'number' }, limit: { type: 'number' } }, [],
    ({ offset = 0, limit = 50 }) => JSON.stringify({ total: emails.length, emails: emails.slice(offset, offset + Math.min(limit, 50)).map(({ id, from, subject }) => ({ id, from, subject })) })),
  tool('get_email', 'Read one email in full by id.', { id: { type: 'string' } }, ['id'], ({ id }) => JSON.stringify(emails.find((e) => e.id === id) ?? { error: 'no such email' })),
  tool('write_note', 'Save a note (a batch summary) under a name, replacing it.', { name: { type: 'string' }, text: { type: 'string' } }, ['name', 'text'], ({ name, text }) => (notes.set(name, text), `saved ${name}`)),
  tool('read_note', 'Read a saved note by name; with no name, list the names.', { name: { type: 'string' } }, [], ({ name }) => (name ? notes.get(name) ?? 'no such note' : JSON.stringify([...notes.keys()]))),
];

const policy = new TurnPolicy();
const base = sessionConfig({ seatRef: 'spike', stateDir: out, tz: 'America/Los_Angeles', model: '@preset/trades-seats', openrouterKey: key, spineUrl: 'http://127.0.0.1:1/', seatToken: 'st_' + 'a'.repeat(64), tier: 'manager', tools: [] }, policy);
const agents = [{
  name: 'email-reader',
  displayName: 'Email reader',
  description: 'Reads a batch of the manager\'s emails by id (get_email) and saves a short summary note (write_note). Use it for any job that needs more than about 20 emails read, one batch per call.',
  prompt: 'You read the emails whose ids you are given, one get_email each. Then save ONE note with write_note, named as you were told, listing every email that needs the manager\'s action: the sender, what is wrong, how urgent, any phone number. Skip routine mail in one line ("n routine: newsletters, receipts…"). Reply in at most 5 lines.',
  tools: ['get_email', 'write_note'],
  infer: true,
}];
const config = {
  ...base,
  mcpServers: {},
  tools,
  availableTools: variant === 'C' ? ['custom:*', 'builtin:task'] : ['custom:*'],
  ...(variant === 'A' ? {} : { customAgents: agents }),
  systemMessage: { mode: 'replace', content: "You are the AI assistant of a trades business manager. You read their email with list_emails and get_email. When a job is too big to read in one go, split it into batches and keep your progress in notes (write_note / read_note). Reply in plain words." },
  onPermissionRequest: (r) => { calls.push({ perm: r.kind, tool: r.toolName, at: Date.now() }); return { kind: r.kind === 'custom-tool' || r.kind === 'agent' ? 'approve-once' : 'approve-once' }; },
};
const client = await startEngine({ baseDirectory: join(out, 'engine'), tz: 'America/Los_Angeles' });
const session = await client.createSession({ ...config, sessionId: `spike-${variant}-${Date.now()}` });
const events = [];
const t0 = Date.now();
let final = '';
const done = new Promise((resolve) => {
  session.on((e) => {
    // agentId is on the ENVELOPE: set for a sub-agent's events, absent for the main agent.
    events.push({ t: Date.now() - t0, type: e.type, agentId: e.agentId ?? null, data: JSON.stringify(e.data ?? {}).slice(0, 400) });
    // The engine can end a turn with an EMPTY message after the real answer: keep the last non-empty
    // one — and only the MAIN agent's (a sub-agent's reply is not the answer).
    if (e.type === 'assistant.message' && !e.agentId && !(e.data?.toolRequests?.length) && e.data?.content) final = e.data.content;
    if (e.type === 'session.idle') resolve();
  });
});
await session.send({ prompt: 'Summarize my last 100 emails: what needs my attention today? Name every customer who needs someone sent.' });
await Promise.race([done, new Promise((r) => setTimeout(r, 15 * 60_000))]);
const secs = Math.round((Date.now() - t0) / 1000);
const named = URGENT.filter((u) => final.includes(u));
const types = {};
for (const e of events) types[e.type] = (types[e.type] ?? 0) + 1;
let inTok = 0, outTok = 0;
for (const e of events) {
  if (!/usage/.test(e.type)) continue;
  try { const d = JSON.parse(e.data); inTok += d.inputTokens ?? d.input_tokens ?? 0; outTok += d.outputTokens ?? d.output_tokens ?? 0; } catch {}
}
const summary = { variant, dedupe: DEDUPE, dupesAnswered: dupes, secs, inTok, outTok, urgentNamed: `${named.length}/12`, missed: URGENT.filter((u) => !named.includes(u)), toolCalls: calls.filter((c) => c.name).length, getEmail: calls.filter((c) => c.name === 'get_email').length, notes: [...notes.keys()], eventTypes: types, permKinds: [...new Set(calls.filter((c) => c.perm).map((c) => `${c.perm}:${c.tool}`))] };
writeFileSync(join(out, `${variant}.json`), JSON.stringify({ summary, final, events, calls }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log('--- final (first 800 chars) ---\n' + final.slice(0, 800));
await session.disconnect?.().catch(() => {});
await Promise.race([client.stop(), new Promise((r) => setTimeout(r, 5000))]);
process.exit(0);
