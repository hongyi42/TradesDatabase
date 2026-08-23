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
// --anchor pins the eval to a chosen "now" instead of the wall clock, so the
// adversarial regime (box UTC day != firm-local day) is available at ANY hour
// and the anchor can sit inside the seed world's data window on a WEEKDAY.
// Accepts a bare day (YYYY-MM-DD -> pinned at 18:30 firm-local, the evening
// regime) or a full ISO instant. The spine must serve the same anchor via
// EVAL_FAKE_NOW=<tenantId>:<instant> (tenant-scoped; src/evalClock.ts) — the
// plan prints the exact line to set on Render.
const ANCHOR = argOf('anchor', null);

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
  let today;
  let anchorIso = null;
  if (ANCHOR && /^\d{4}-\d{2}-\d{2}$/.test(ANCHOR)) {
    // Bare day: pin the instant at 18:30 firm-local (the evening regime). The
    // DB does the tz math — node has no tz database worth trusting here.
    const [{ instant }] = await one(
      `select (($1::date + time '18:30') at time zone $2)::text as instant`,
      [ANCHOR, tz],
    );
    anchorIso = new Date(instant).toISOString();
    today = ANCHOR;
  } else if (ANCHOR) {
    const t = Date.parse(ANCHOR);
    if (Number.isNaN(t)) {
      console.error(`REFUSING TO PLAN: --anchor '${ANCHOR}' is neither YYYY-MM-DD nor an ISO instant.`);
      process.exit(1);
    }
    anchorIso = new Date(t).toISOString();
    const [{ d }] = await one(`select ($1::timestamptz at time zone $2)::date::text as d`, [anchorIso, tz]);
    today = d;
  } else {
    [{ today }] = await one(`select (now() at time zone $1)::date::text as today`, [tz]);
  }

  // Timed visits that stand or were done — the schedule a person means by
  // "visits". Cancelled rows stay out (they retain stale flags, per the
  // seeding note); 'completed' is included so past-tense questions stay true
  // once completions start being recorded. Matches v_schedule's filter since
  // the 2026-08-12 migration — the eval found v_schedule counting cancelled
  // rows as scheduled work (+90 in August), and truth/view must mean the
  // same thing or every count question grades wrong.
  // Times are stored NAIVE-LOCAL with a lying '+00' marker (see the startTime
  // note in src/mcp/server.ts, live incident 2026-07-22) — so the truth must
  // render the raw wall-clock slices the product displays, never convert by
  // the firm timezone. The 08-13 run graded "first job at 01:30" against an
  // agent (and board) that correctly show 08:30 — the truth was the wrong side.
  const rows = await one(
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
    `select distinct on (c.id) c.name as customer, (a.starts_at at time zone 'UTC')::date::text as date,
            coalesce(t.ref, 'unassigned') as tech, j.title as title
     from assignments a
     join jobs j on j.id = a.job_id
     join customers c on c.id = j.customer_id
     left join technicians t on t.id = a.technician_id
     where a.tenant_id = $1 and a.status = 'confirmed'
       and a.starts_at >= ($2::date)::timestamp
     order by c.id, a.starts_at`,
    [tenantId, today],
  );
  const nextVisit = Object.fromEntries(nextRows.map((r) => [r.customer, { date: r.date, tech: r.tech, title: r.title }]));

  const facts = { today, tz, dayCounts, techDayCounts, firstOfDay, timeOff, windowJobs, nextVisit };
  const corpus = buildCorpus(facts);

  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = {
    builtAt: new Date().toISOString(),
    tenant: TENANT,
    tenantId,
    today,
    // Non-null = anchored run: the spine must be serving EVAL_FAKE_NOW with
    // exactly this instant for this tenant, or every question mis-grades.
    anchor: anchorIso,
    timezone: tz,
    // Fireworks' id spelling, because that is what production routes to
    // (since 2026-08-15). The old default here was `z-ai/glm-5.2` — NVIDIA's
    // spelling of the SAME model — so run.mjs's expected-model gate refused
    // every run until someone set DATE_EVAL_EXPECT_MODEL, and the refusal
    // looked like a fleet problem rather than a stale default. nvidia-prod was
    // retired as a fallback on 2026-08-12; its id spelling should not be the
    // default anywhere.
    // The 2026-08-15 switch: Fireworks' fast router is the fleet's canonical
    // route. Override with DATE_EVAL_EXPECT_MODEL for trial runs on other
    // providers — the gate compares EXACT strings, and every provider spells
    // the same model differently (DeepInfra 'zai-org/GLM-5.2', NVIDIA
    // 'z-ai/glm-5.2' — both have bitten us).
    expectedModel: process.env.DATE_EVAL_EXPECT_MODEL || 'accounts/fireworks/routers/glm-5p2-fast',
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
  if (anchorIso) {
    console.log(`  ANCHORED RUN — before running, set on the spine (Render env, no deploy needed):`);
    console.log(`      EVAL_FAKE_NOW=${tenantId}:${anchorIso}`);
    console.log(`  and REMOVE it the moment the run ends. Real UTC now: ${new Date().toISOString()}`);
  }
  console.log(`  today (firm-local ${tz}):  ${titleWeekday(today)} ${today}`);
  console.log(`  this week:  ${weekStart(today)} → ${weekEnd(today)}     next week: ${weekStart(today, 1)} → ${weekEnd(today, 1)}`);
  console.log(`  tenant:     ${TENANT}    sandbox: ${manifest.sandbox}    expected model: ${manifest.expectedModel}`);
  console.log(`\n  ${n} questions   ${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join('   ')}`);
  console.log(`  phase coverage:  ${Object.entries(byPhase).map(([k, v]) => `${k} ${v}`).join('   ')}`);
  console.log(`\n  estimated wall clock: ~${mins} min   (~${secsEach}s per turn, run serially)`);
  // A RANGE, not a point estimate. At ~35k tokens/turn on Fireworks-fast
  // ($2.10/M input, $0.21/M cached, $6.60/M output) the bill is dominated by how
  // much of the doctrine prefix hits cache — and FLEET-side that is replica luck,
  // because the gateway cannot inject prompt_cache_key. ~$0.013/turn at a 95% hit
  // rate, ~$0.076 at zero. Quoting only the optimistic figure would understate a
  // full run by 6x, which is how an eval quietly becomes expensive.
  console.log(`  estimated spend:      ~${(n * 0.013).toFixed(2)}–${(n * 0.076).toFixed(2)} USD at GLM-5.2 Fireworks-fast rates`);
  console.log(`                        (~35k tokens/turn; the spread is cache-hit luck — see engineering-memory)`);
  console.log(`\n  manifest → ${join(OUT_DIR, 'manifest.json')}`);
  console.log(`\n  TO RUN (this is the step that spends money):`);
  console.log(`    npm run date-eval:run -- --dir ${OUT_DIR} --yes\n`);
} finally {
  await client.end();
}
