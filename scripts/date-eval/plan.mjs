// Date-eval STEP 1 of 3 — plan.
//
// Reads the schedule facts out of the pilot DB (SELECT only), builds the
// corpus with truth baked in, writes a manifest, and prints the confirmation
// brief. Writes nothing anywhere and spends nothing — a plan can always be
// re-run to see what a run would cost before agreeing to it.
//
//   node -r dotenv/config scripts/date-eval/plan.mjs [--out <dir>]
//
// The manifest it writes is what run.mjs executes; run.mjs will not run
// without one, so the truth a run is graded against is always fixed BEFORE the
// model is asked anything.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildCorpus, addDays, weekStart, weekEnd, titleWeekday } from './corpus.mjs';

const require = createRequire(import.meta.url);
const pg = require('pg');

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const OUT_DIR = argOf('out', join(process.cwd(), 'date-eval-runs', 'pending'));
const TENANT = argOf('tenant', 'Default Tenant');

// Same two-URL agreement as seed.mjs. Read-only here, but a corpus built from
// the wrong database would grade every answer against fiction, so the target
// still has to be one we recognise.
const TEST_REF = 'daqapdlkgxfrhquacprv';
const dbUrl = process.env.DATABASE_URL ?? '';
const isHosted = dbUrl.includes(TEST_REF);
const isLocal = /127\.0\.0\.1|localhost/.test(dbUrl);
if (!isHosted && !isLocal) {
  console.error('REFUSING TO PLAN: DATABASE_URL must be the hosted pilot ref or the local stack.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const one = async (sql, params) => (await client.query(sql, params)).rows;

try {
  const [{ id: tenantId, timezone: tz }] = await one('select id, timezone from tenants where name = $1', [TENANT]);
  const [{ today }] = await one(`select (now() at time zone $1)::date::text as today`, [tz]);

  // Confirmed, timed visits only — the schedule a person means by "visits".
  // Cancelled rows stay out (they retain stale flags, per the seeding note).
  const rows = await one(
    `select (a.starts_at at time zone $2)::date::text as day,
            coalesce(t.ref, 'UNASSIGNED') as tech,
            c.name as customer, j.title as title,
            to_char(a.starts_at at time zone $2, 'HH24:MI') as start_local
     from assignments a
     join jobs j on j.id = a.job_id
     join customers c on c.id = j.customer_id
     left join technicians t on t.id = a.technician_id
     where a.tenant_id = $1 and a.status = 'confirmed' and a.starts_at is not null
     order by a.starts_at`,
    [tenantId, tz],
  );

  const dayCounts = {};
  const techDayCounts = {};
  const firstOfDay = {};
  for (const r of rows) {
    dayCounts[r.day] = (dayCounts[r.day] ?? 0) + 1;
    (techDayCounts[r.day] ??= {})[r.tech] = (techDayCounts[r.day]?.[r.tech] ?? 0) + 1;
    const slot = (firstOfDay[r.day] ??= {});
    if (!slot[r.tech]) slot[r.tech] = { customer: r.customer, title: r.title, startLocal: r.start_local };
  }

  const timeOff = (
    await one(
      `select t.ref as tech, tt.starts_on::text as "startsOn", tt.ends_on::text as "endsOn"
       from technician_time_off tt join technicians t on t.id = tt.technician_id
       where tt.tenant_id = $1 and tt.ends_on >= $2::date order by tt.starts_on`,
      [tenantId, today],
    )
  );

  const windowJobs = await one(
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

  // One customer → one next visit. Customers with several upcoming visits are
  // skipped: "next visit" is unambiguous only when there is exactly one soon,
  // and an ambiguous question grades badly for reasons that are not the model's.
  const nextRows = await one(
    `select distinct on (c.id) c.name as customer, (a.starts_at at time zone $2)::date::text as date,
            coalesce(t.ref, 'unassigned') as tech, j.title as title
     from assignments a
     join jobs j on j.id = a.job_id
     join customers c on c.id = j.customer_id
     left join technicians t on t.id = a.technician_id
     where a.tenant_id = $1 and a.status = 'confirmed' and a.starts_at > now()
     order by c.id, a.starts_at`,
    [tenantId, tz],
  );
  const nextVisit = Object.fromEntries(nextRows.map((r) => [r.customer, { date: r.date, tech: r.tech, title: r.title }]));

  const facts = { today, tz, dayCounts, techDayCounts, firstOfDay, timeOff, windowJobs, nextVisit };
  const corpus = buildCorpus(facts);

  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = {
    builtAt: new Date().toISOString(),
    tenant: TENANT,
    today,
    timezone: tz,
    expectedModel: process.env.DATE_EVAL_EXPECT_MODEL || 'z-ai/glm-5.2',
    sandbox: process.env.DATE_EVAL_SANDBOX || 's2',
    facts: { dayCounts, techDayCounts, timeOff, windowJobs },
    questions: corpus,
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // ── the confirmation brief ──
  const byPhase = { resolve: 0, use: 0, speak: 0, guard: 0 };
  for (const c of corpus) for (const p of c.phases) byPhase[p]++;
  const byCat = {};
  for (const c of corpus) byCat[c.cat] = (byCat[c.cat] ?? 0) + 1;
  const n = corpus.length;
  const secsEach = 25; // measured: 18-23s per embedded-agent turn on s2
  const mins = Math.round((n * secsEach) / 60);

  console.log(`\n=== DATE EVAL — PLAN (nothing has run yet) ===`);
  console.log(`  today (firm-local ${tz}):  ${titleWeekday(today)} ${today}`);
  console.log(`  this week:  ${weekStart(today)} → ${weekEnd(today)}     next week: ${weekStart(today, 1)} → ${weekEnd(today, 1)}`);
  console.log(`  tenant:     ${TENANT}    sandbox: ${manifest.sandbox}    expected model: ${manifest.expectedModel}`);
  console.log(`\n  ${n} questions   ${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join('   ')}`);
  console.log(`  phase coverage:  ${Object.entries(byPhase).map(([k, v]) => `${k} ${v}`).join('   ')}`);
  console.log(`\n  estimated wall clock: ~${mins} min   (~${secsEach}s per turn, run serially)`);
  console.log(`  estimated spend:      ~${(n * 0.012).toFixed(2)} USD at GLM-5.2 DeepInfra rates (~35k cached-heavy tokens/turn)`);
  console.log(`\n  manifest → ${join(OUT_DIR, 'manifest.json')}`);
  console.log(`\n  TO RUN (this is the step that spends money):`);
  console.log(`    npm run date-eval:run -- --dir ${OUT_DIR} --yes\n`);
} finally {
  await client.end();
}
