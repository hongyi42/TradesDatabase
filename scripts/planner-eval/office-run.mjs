// THE OFFICE, LIVE — the scripted check for plan 2026-09-22 ("the office: one
// agent, three doors"), phases 3 and 4.
//
//   npm run build
//   OPENROUTER_API_KEY=… node scripts/planner-eval/office-run.mjs [--only access|question|hangup|call]
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
const { rows: [tenant] } = await pg.query("select id from tenants where name = 'Default Tenant'");
const tenantId = tenant.id;
const officeDeps = {
  toolSchemas: TEAM_LEAD_TOOL_SCHEMAS,
  dispatch: (n, a, id) => dispatchForIdentity(n, a, id),
};

// ── seed ──────────────────────────────────────────────────────────────────────
async function person(ref, name, tier, reachable) {
  const t = await db.insertTechnician({ tenantId, ref: `${RUN}-${ref}`, displayName: name, tier });
  await db.setTechnicianState(t.id, 'active');
  if (reachable) {
    await pg.query('update technicians set telegram_user_id = $2, sandbox_ref = $3 where id = $1', [
      t.id,
      String(900000000 + Math.floor(Math.random() * 99999)),
      `sbx-${RUN}-${ref}`,
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
} finally {
  await pg.query("delete from person_pushes where tenant_id = $1 and technician_id in (select id from technicians where ref like $2)", [tenantId, `${RUN}-%`]);
  await pg.query("delete from observations where kind = 'access_request' and technician_id = $1", [ben.id]);
  await pg.query('delete from office_messages where tenant_id = $1 and (from_ref like $2 or to_ref like $2)', [tenantId, `${RUN}-%`]);
  await pg.query('delete from access_grants where tenant_id = $1 and technician_id = $2', [tenantId, ben.id]).catch(() => {});
  await pg.query('delete from jobs where id = $1', [job.id]);
  await pg.query('delete from customers where id = $1', [customer.id]);
  await pg.query('delete from technicians where ref like $1', [`${RUN}-%`]);
  if (priorIndex) await writeMemoryFile(tenantId, 'MEMORY.md', priorIndex.content);
  else await pg.query("delete from planner_memory where tenant_id = $1 and path = 'MEMORY.md'", [tenantId]);
  if (priorRule.rows[0]) {
    const r = priorRule.rows[0];
    await db.setTechnicianViewRule(tenantId, { jobScope: r.job_scope, money: r.money }, 'office-run');
  }
  await pg.end();
}
