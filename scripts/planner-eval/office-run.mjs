// THE OFFICE, LIVE — the scripted check for plan 2026-09-22 ("the office: one
// agent, three doors"), phases 3 and 4.
//
//   npm run build
//   OPENROUTER_API_KEY=… node scripts/planner-eval/office-run.mjs [--only access|question|hangup|call]
//
// It ends with each door's input tokens per model call, read from cost_events.
//
// It drives the REAL door code (dist/) against the REAL model and THIS
// WORKTREE'S LOCAL STACK, and prints the evidence — the rows written, the texts
// queued, the office's own words — read back over direct pg, a channel the code
// under test never touches.
//
// SAFETY, by construction rather than care:
//   * the environment is .env.test ONLY — never .env, whose SUPABASE_URL is the
//     pilot's live database — and assertLocalTestEnv refuses anything but
//     127.0.0.1 before a single import that could open a client;
//   * the model key is the ONE variable passed on the command line.
//
// It seeds its own rows under a RUN suffix in the seed tenant, and removes them.

import { config } from 'dotenv';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env.test'), override: true });
const { assertLocalTestEnv } = await import(`${ROOT}dist/testEnvGuard.js`);
assertLocalTestEnv(process.env);
if (!process.env.OPENROUTER_API_KEY && !process.env.INFERENCE_API_KEY) {
  console.error('set OPENROUTER_API_KEY for this one command — the check needs the real model');
  process.exit(2);
}

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const want = (name) => !only || only === name;

const pg = new (await import('pg')).default.Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();
const db = await import(`${ROOT}dist/db/index.js`);
const { writeMemoryFile, readMemoryFile } = await import(`${ROOT}dist/db/plannerMemory.js`);
const { routeAccessAsOffice, answerAsOffice } = await import(`${ROOT}dist/teamLead/office.js`);
const { TEAM_LEAD_TOOL_SCHEMAS, dispatchForIdentity } = await import(`${ROOT}dist/mcp/server.js`);

const RUN = `ofr${Date.now().toString(36)}`;
// Cost rows this run wrote are found by time and lane (recordModelUsage labels
// every row with the door's lane), so the per-door token line below is read back
// from the ledger rather than trusted from the loop.
const STARTED_ISO = new Date().toISOString();
const { rows: [tenant] } = await pg.query("select id from tenants where name = 'Default Tenant'");
const tenantId = tenant.id;
const officeDeps = {
  toolSchemas: TEAM_LEAD_TOOL_SCHEMAS,
  dispatch: (n, a, id) => dispatchForIdentity(n, a, id),
};

// ── seed ──────────────────────────────────────────────────────────────────────
// A box for the seeded people: the planner counts somebody as reachable by chat
// only with a host, a sandbox and a Telegram id (planner.ts buildRoster).
const { createHost } = await import(`${ROOT}dist/db/hosts.js`);
const host = await createHost(`host-${RUN}`, `hash-${RUN}`);
async function person(ref, name, tier, reachable) {
  const t = await db.insertTechnician({ tenantId, ref: `${RUN}-${ref}`, displayName: name, tier });
  await db.setTechnicianState(t.id, 'active');
  if (reachable) {
    await pg.query('update technicians set telegram_user_id = $2, sandbox_ref = $3, host_id = $4 where id = $1', [
      t.id,
      String(900000000 + Math.floor(Math.random() * 99999)),
      `sbx-${RUN}-${ref}`,
      host.id,
    ]);
  }
  return t;
}
const ben = await person('ben', `Ben ${RUN}`, 'technician', true);
const sam = await person('sam', `Sam ${RUN}`, 'manager', true);
const dana = await person('dana', `Dana ${RUN}`, 'manager', true);
const customer = await db.createCustomer({ tenantId, name: `Marina ${RUN}`, phone: '555-0100' });
const job = await db.createJob({ tenantId, customerId: customer.id, title: `Mold remediation ${RUN}` });

// The office's note: who looks after Ben. Restored afterwards.
const priorIndex = await readMemoryFile(tenantId, 'MEMORY.md');
await writeMemoryFile(
  tenantId,
  'MEMORY.md',
  `${priorIndex?.content ?? ''}\n- Team: ${ben.display_name} is looked after by ${sam.display_name}.`,
);
// The firm at its DEFAULT width, so the job is outside Ben's view.
const priorRule = await pg.query('select * from technician_view_rules where tenant_id = $1', [tenantId]);
await db.setTechnicianViewRule(tenantId, null, 'office-run');

const benAsks = (over = {}) => ({
  tenantId,
  askerRef: ben.ref,
  askerName: ben.display_name,
  askerTier: 'technician',
  askerTechnicianId: ben.id,
  activeManager: false,
  why: 'I am at the gate and need the code',
  customerId: customer.id,
  wants: 'record',
  ...over,
});
const requests = () =>
  pg.query(
    "select id, status, context, dismiss_reason from observations where kind = 'access_request' and technician_id = $1 order by noticed_at",
    [ben.id],
  );
const pushes = () =>
  pg.query(
    "select p.body, t.display_name from person_pushes p join technicians t on t.id = p.technician_id where p.tenant_id = $1 and p.kind = 'access' and t.ref like $2 order by p.created_at",
    [tenantId, `${RUN}-%`],
  );
// THIS RUN'S texts only — never the rest of the seed tenant's (verification note).
const clearRunPushes = () =>
  pg.query(
    'delete from person_pushes where tenant_id = $1 and technician_id in (select id from technicians where ref like $2)',
    [tenantId, `${RUN}-%`],
  );
const callObs = [];
const show = (label, v) => console.log(`\n── ${label}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`);

try {
  if (want('access')) {
    // 1. A customer-wide ask; the customer has ONE unfinished job outside Ben's view.
    const first = await routeAccessAsOffice(benAsks(), officeDeps);
    show('1. customer-wide ask → reply', first);
    const r1 = (await requests()).rows;
    show('1. request rows (context.jobId should be the one job)', r1.map((r) => ({ status: r.status, jobId: r.context.jobId, texted: r.context.managersTexted })));
    console.log(`   expected jobId ${job.id}: ${r1[0]?.context.jobId === job.id ? 'YES' : 'NO'}`);
    show('1. texts queued', (await pushes()).rows);

    // 2. Sam says no (by accident); Ben asks again.
    if (r1[0]) {
      const no = await dispatchForIdentity(
        'decline_access',
        { requestId: r1[0].id, reason: 'wrong button, sorry' },
        { tenantId, technicianRef: sam.ref },
      );
      show('2. Sam declines', no);
    }
    await clearRunPushes();
    const second = await routeAccessAsOffice(benAsks(), officeDeps);
    show('2. Ben asks again → reply', second);
    show('2. texts queued (should go back to Sam, mentioning the no)', (await pushes()).rows);
  }

  if (want('question')) {
    // 3. A question about a job outside his view: no title, no detail.
    const q = await answerAsOffice(
      {
        tenantId,
        askerRef: ben.ref,
        askerTier: 'technician',
        managerDesk: false,
        askerTechnicianId: ben.id,
        question: `What is going on with the job at ${customer.name}? What is the job about?`,
      },
      officeDeps,
    );
    show('3. question about an out-of-view job → answer', q);
    const leaked = (q.answer ?? '').includes('Mold') ;
    console.log(`   job title in the answer: ${leaked ? 'YES — LEAK' : 'no'}`);
  }

  if (want('hangup')) {
    // 4. The seat hangs up two seconds into the office.
    await pg.query("delete from observations where kind = 'access_request' and technician_id = $1", [ben.id]);
    await clearRunPushes();
    const hang = new AbortController();
    setTimeout(() => hang.abort(), 2000);
    const started = Date.now();
    const out = await routeAccessAsOffice(benAsks({ wants: 'money' }), { ...officeDeps, signal: hang.signal });
    show(`4. hung up at 2s → returned after ${Date.now() - started}ms`, out);
    show('4. request rows (should be none)', (await requests()).rows.length);
    show('4. texts (should be none)', (await pushes()).rows.length);
  }
  if (want('call')) {
    // 5. THE CALL DOOR (phase 4): a pass woken by an inbound call now runs on the
    //    office's prompt. Two calls from nobody on file: a real request (expect
    //    the manager text + quiet note pair, rung 10b's shape) and a thank-you
    //    (expect a dismiss with a reason).
    process.env.PLANNER_MODE = 'live';
    const { runFocusedObservationPass } = await import(`${ROOT}dist/jobs/plannerPass.js`);
    const call = async (label, words, asked) => {
      const obs = await db.createObservation({
        tenantId,
        kind: 'inbound_unmatched',
        subjectRef: `${RUN}-${label}`,
        technicianId: null,
        context: {
          captureId: crypto.randomUUID(),
          capturedAt: new Date().toISOString(),
          channel: 'phone_call',
          from: '+15550199',
          matchReason: 'no customer on file has this number',
          visitCommitted: false,
          asked,
          words,
        },
      });
      callObs.push(obs.id);
      const started = Date.now();
      const summary = await runFocusedObservationPass(obs);
      const after = await pg.query('select status, dismiss_reason, asked_at from observations where id = $1', [obs.id]);
      const sent = await pg.query(
        'select direction, via, to_ref, body from office_messages where nudge_id = $1 order by created_at',
        [obs.id],
      );
      const decided = await pg.query(
        'select action, outcome, reason from nudge_decisions where observation_id = $1 or nudge_id = $1 order by decided_at',
        [obs.id],
      );
      show(`5. ${label} — pass took ${Date.now() - started}ms`, {
        skipped: summary.skipped ?? null,
        planned: summary.planned,
        applied: summary.applied,
        decisions: decided.rows,
        observation: after.rows[0],
        messages: sent.rows,
      });
    };
    await call('request', 'Hi, this is Priya Nair, my water heater is leaking all over the garage floor at 40 Pier Road. Can someone come out today?', {
      customerName: 'Priya Nair', phone: '+15550199', email: null, address: '40 Pier Road', jobTitle: 'water heater leaking', followUp: 'send someone today',
    });
    await call('thanks', 'Hey, just calling to say thanks for fixing the boiler yesterday, all working great. Bye!', {
      customerName: null, phone: '+15550199', email: null, address: null, jobTitle: null, followUp: null,
    });
  }

  // PER-DOOR COST (rung 10c phase 2): each door now loads only its own
  // doctrine, so a waiting door's input per model call is the number to watch.
  // The call door runs as lane 'planner' (the focused pass).
  const cost = await pg.query(
    `select coalesce(e.metadata->>'lane', '?') as lane, e.sku,
            count(*)::int as calls, sum(e.quantity)::bigint as qty,
            round(sum(e.quantity * coalesce(r.unit_cost_usd, 0))::numeric, 4) as usd
       from cost_events e
       left join cost_rates r on r.provider = e.provider and r.sku = e.sku and r.effective_to is null
      where e.tenant_id = $1 and e.occurred_at >= $2 and e.unit = 'token'
      group by 1, 2 order by 1, 2`,
    [tenantId, STARTED_ISO],
  );
  show('per-door tokens (calls = model calls; qty = tokens; input includes the system prompt every call)', cost.rows);
  for (const lane of [...new Set(cost.rows.map((r) => r.lane))]) {
    const rows = cost.rows.filter((r) => r.lane === lane);
    const input = rows.filter((r) => !/output/.test(r.sku));
    const calls = Math.max(...input.map((r) => r.calls), 0);
    const tokens = input.reduce((n, r) => n + Number(r.qty), 0);
    const usd = rows.reduce((n, r) => n + Number(r.usd), 0);
    console.log(`   ${lane}: ${calls} model calls, ${calls ? Math.round(tokens / calls) : 0} input tokens per call, $${usd.toFixed(4)}`);
  }
} finally {
  if (callObs.length > 0) {
    await pg.query('delete from office_messages where nudge_id = any($1::uuid[])', [callObs]);
    await pg.query('delete from nudges where id = any($1::uuid[])', [callObs]);
    await pg.query('delete from observations where id = any($1::uuid[])', [callObs]);
  }
  await pg.query("delete from person_pushes where tenant_id = $1 and technician_id in (select id from technicians where ref like $2)", [tenantId, `${RUN}-%`]);
  await pg.query("delete from observations where kind = 'access_request' and technician_id = $1", [ben.id]);
  await pg.query('delete from office_messages where tenant_id = $1 and (from_ref like $2 or to_ref like $2)', [tenantId, `${RUN}-%`]);
  await pg.query('delete from access_grants where tenant_id = $1 and technician_id = $2', [tenantId, ben.id]).catch(() => {});
  await pg.query('delete from jobs where id = $1', [job.id]);
  await pg.query('delete from customers where id = $1', [customer.id]);
  await pg.query('delete from technicians where ref like $1', [`${RUN}-%`]);
  await pg.query('delete from hosts where id = $1', [host.id]);
  if (priorIndex) await writeMemoryFile(tenantId, 'MEMORY.md', priorIndex.content);
  else await pg.query("delete from planner_memory where tenant_id = $1 and path = 'MEMORY.md'", [tenantId]);
  if (priorRule.rows[0]) {
    const r = priorRule.rows[0];
    await db.setTechnicianViewRule(tenantId, { jobScope: r.job_scope, money: r.money }, 'office-run');
  }
  await pg.end();
}
