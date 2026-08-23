#!/usr/bin/env node
// run-direct.mjs — the PLANNER-SHAPED date run (Arm D, 2026-08-23).
//
// Tier 2: this machine → the Anthropic API directly, the way the PLANNER
// consumes the world — code-supplied context, no seat, no gateway, no box.
// The system prompt is the experiment: ONE clock line + the RAW schedule
// rows (uncrutched — the model does its own counting and calendar math).
// No date doctrine, no resolve_date, no derived counts. The transport is
// planner-eval's cached one, so the shared prefix (clock + schedule) is
// written once and read at 0.1x for every question after the first.
//
// Reuses an existing run dir's manifest (questions + truth). Writes
// results.jsonl in run.mjs's row shape so analyze.mjs grades it unchanged;
// there are no trajectory files (analyze tolerates their absence — every
// question shows as "bypassed resolve_date", which is the point).
//
//   set -a; . ./.env; set +a   # DATABASE_URL (pilot, read-only) + ANTHROPIC_API_KEY
//   node scripts/date-eval/run-direct.mjs --dir date-eval-runs/opus5-armD-direct [--limit 2]

import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { callPlanner } from '../planner-eval/anthropic.mjs';

const require = createRequire(import.meta.url);
const pg = require('pg');

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const DIR = argOf('dir', null);
const LIMIT = Number(argOf('limit', '0'));
const MODEL = argOf('model', 'claude-opus-5');
if (!DIR) { console.error('need --dir <run dir containing manifest.json>'); process.exit(1); }
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('ANTHROPIC_API_KEY missing from env'); process.exit(1); }

const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const RESULTS = join(DIR, 'results.jsonl');
const already = new Set(
  existsSync(RESULTS)
    ? readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id)
    : [],
);

// ── the raw record, straight from the DB (plan.mjs's exact queries — the
// naive-local wall-clock discipline included: render the stored slices,
// never convert by the firm timezone) ──
const TEST_REF = 'daqapdlkgxfrhquacprv';
const dbUrl = process.env.DATABASE_URL ?? '';
if (!dbUrl.includes(TEST_REF) && !/127\.0\.0\.1|localhost/.test(dbUrl)) {
  console.error('REFUSING: DATABASE_URL must be the hosted pilot ref or the local stack.');
  process.exit(1);
}
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const one = async (sql, params) => (await client.query(sql, params)).rows;
const [{ id: tenantId }] = await one('select id from tenants where name = $1', [manifest.tenant]);
const visits = await one(
  `select (a.starts_at at time zone 'UTC')::date::text as day,
          coalesce(t.ref, 'UNASSIGNED') as tech,
          c.name as customer, j.title as title,
          to_char(a.starts_at at time zone 'UTC', 'HH24:MI') as start_local
   from assignments a
   join jobs j on j.id = a.job_id
   join customers c on c.id = j.customer_id
   left join technicians t on t.id = a.technician_id
   where a.tenant_id = $1 and a.status in ('confirmed', 'completed') and a.starts_at is not null
   order by a.starts_at`,
  [tenantId],
);
const timeOff = await one(
  `select t.ref as tech, tt.starts_on::text as "startsOn", tt.ends_on::text as "endsOn"
   from technician_time_off tt join technicians t on t.id = tt.technician_id
   where tt.tenant_id = $1 and tt.ends_on >= $2::date order by tt.starts_on`,
  [tenantId, manifest.today],
);
const windows = await one(
  `select c.name as customer, j.title as title, coalesce(t.ref, null) as tech,
          a.earliest_date::text as earliest, a.latest_date::text as latest
   from assignments a
   join jobs j on j.id = a.job_id
   join customers c on c.id = j.customer_id
   left join technicians t on t.id = a.technician_id
   where a.tenant_id = $1 and a.starts_at is null and a.status = 'confirmed'
   order by a.earliest_date`,
  [tenantId],
);
await client.end();

const clockLine = `(the firm's clock reads ${new Date(`${manifest.today}T12:00:00Z`).toLocaleDateString(
  'en-US',
  { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' },
)} — timezone ${manifest.timezone})`;

const SYSTEM = [
  `You answer questions about a trades firm's schedule and about dates.`,
  clockLine,
  '',
  'BOOKED VISITS (one per line: date, start time, customer, job, technician):',
  ...visits.map((v) => `${v.day} ${v.start_local} — ${v.customer} — ${v.title} — tech: ${v.tech}`),
  '',
  'UNPLACED WORK (booked into a date window, no day chosen yet — it is not ON any day until placed):',
  ...(windows.length
    ? windows.map((w) => `window ${w.earliest}..${w.latest} — ${w.customer} — ${w.title} — tech: ${w.tech ?? 'UNASSIGNED'}`)
    : ['(none)']),
  '',
  'TIME OFF:',
  ...(timeOff.length ? timeOff.map((o) => `${o.tech} off ${o.startsOn}..${o.endsOn}`) : ['(none)']),
].join('\n');

const TOOL = {
  name: 'answer',
  description: 'Answer the question.',
  inputSchema: {
    type: 'object',
    properties: { reply: { type: 'string', description: 'The answer, as you would tell the office.' } },
    required: ['reply'],
    additionalProperties: false,
  },
};

const remaining = manifest.questions.filter((q) => !already.has(q.id));
const todo = LIMIT > 0 ? remaining.slice(0, LIMIT) : remaining;
console.log(`ARM D (planner-shaped, direct API): model ${MODEL}, system ≈${Math.round(SYSTEM.length / 4)} tokens (${visits.length} visits, ${windows.length} windows, ${timeOff.length} time-off)`);
console.log(`${todo.length} questions to ask (${already.size} already answered)\n`);

const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
for (const item of todo) {
  const t0 = Date.now();
  let reply = '';
  let err = null;
  try {
    const r = await callPlanner({ system: SYSTEM, tool: TOOL, user: item.q, model: MODEL, apiKey });
    reply = typeof r.plan?.reply === 'string' ? r.plan.reply : '';
    const u = r.usage ?? {};
    totals.input += u.input_tokens ?? 0;
    totals.output += u.output_tokens ?? 0;
    totals.cacheRead += u.cache_read_input_tokens ?? 0;
    totals.cacheWrite += u.cache_creation_input_tokens ?? 0;
    totals.usd += r.cost?.total ?? 0;
  } catch (e) {
    err = String(e).slice(0, 200);
  }
  const wallMs = Date.now() - t0;
  appendFileSync(
    RESULTS,
    JSON.stringify({
      id: item.id, cat: item.cat, phases: item.phases, q: item.q,
      reply, wallMs, exit: err ? 1 : 0, sessionId: `direct-${item.id}`,
      agentsMdTruncated: false, hasTrajectory: false,
      replySource: err ? 'dead-turn' : 'direct', stdoutReply: err ?? '',
      at: new Date().toISOString(),
    }) + '\n',
  );
  console.log(`  ${item.id.padEnd(4)} ${String(wallMs).padStart(6)}ms  ${err ? `ERROR ${err.slice(0, 60)}` : reply.slice(0, 70).replace(/\n/g, ' ')}`);
  if (err && /credit|billing|401|403/.test(err)) { console.error('\nSTOPPING: billing/auth error.'); break; }
}
writeFileSync(join(DIR, 'run-context.json'), JSON.stringify({ mode: 'direct-planner-shaped', model: MODEL, systemTokensApprox: Math.round(SYSTEM.length / 4), startedAt: new Date().toISOString(), totals }, null, 2));
console.log(`\ntokens: input ${totals.input} · cacheWrite ${totals.cacheWrite} · cacheRead ${totals.cacheRead} · output ${totals.output}`);
console.log(`cost (per transport's own rate card): $${totals.usd.toFixed(2)}`);
