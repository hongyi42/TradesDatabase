// ⑤ Phase 5: the operator's lesson console — pilot-stage scaffolding whose
// interface (list proposals with evidence, accept/retire verdicts) is
// deliberately the future adversarial judge's interface, so the judge later
// replaces the human without reshaping the store.
//
//   npm run lessons:planner -- list --tenant <uuid>
//   npm run lessons:planner -- activate --tenant <uuid> --id <lesson-uuid>
//   npm run lessons:planner -- strike --tenant <uuid> --id <lesson-uuid> --why "reason"
//
// Uses the COMPILED Curator (dist/) so every guard — evidence check, budget
// refusal, two-strike retirement, tenant scoping — is the production code,
// never a parallel implementation.
import { activateLesson, listLessons, strikeLesson } from '../../dist/teamLead/lessons.js';
import pg from 'pg';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
};
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const cmd = process.argv[2];
const tenantId = arg('tenant');
if (!cmd || !tenantId) {
  console.error('usage: lessons.mjs <list|activate|strike> --tenant <uuid> [--id <uuid>] [--why "..."]');
  process.exit(1);
}

if (cmd === 'list') {
  const rows = await listLessons(tenantId, ['proposed', 'active', 'retired', 'stale']);
  if (rows.length === 0) console.log('no lessons for this tenant');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const l of rows) {
      console.log(`\n[${l.id}] ${l.status.toUpperCase()} (strikes ${l.strikes})`);
      console.log(`  ${l.text}`);
      const ev = Array.isArray(l.evidence) ? l.evidence : [];
      const { rows: summaries } = await client.query(
        `select id, subject, status, manager_fate from gap_summaries where id = any($1)`,
        [ev],
      );
      for (const s of summaries) {
        console.log(`  evidence: ${s.id.slice(0, 8)} · ${s.subject} · ${s.status} · manager:${s.manager_fate}`);
      }
    }
  } finally {
    await client.end();
  }
} else if (cmd === 'activate') {
  const id = arg('id');
  if (!id) { console.error('--id required'); process.exit(1); }
  const l = await activateLesson(tenantId, id);
  console.log(`ACTIVE: [${l.id}] ${l.text}`);
} else if (cmd === 'strike') {
  const id = arg('id');
  const why = arg('why');
  if (!id || !why) { console.error('--id and --why required'); process.exit(1); }
  const l = await strikeLesson(tenantId, id, why);
  console.log(`${l.status.toUpperCase()} (strikes ${l.strikes}): [${l.id}] ${l.text}`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(1);
}
