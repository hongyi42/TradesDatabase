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
            -- ONE ROW PER TRIP (rung 9c): a crew is a LIST on the row, never
            -- extra rows. Joining participants out would make dayCounts count
            -- PEOPLE while the agent answers from v_schedule, which counts
            -- trips — every count question on a crew day would grade false.
            coalesce(
              (select min(t.ref) from visit_participants vp
                 join technicians t on t.id = vp.technician_id
                where vp.visit_id = a.id),
              'UNASSIGNED') as tech,
            coalesce(
              (select array_agg(t.ref order by vp.created_at, vp.technician_id)
                 from visit_participants vp
                 join technicians t on t.id = vp.technician_id
                where vp.visit_id = a.id),
              '{}') as crew,
            c.name as customer, j.title as title,
            to_char(a.starts_at at time zone 'UTC', 'HH24:MI') as start_local
     from visits a
     join jobs j on j.id = a.job_id
     join customers c on c.id = j.customer_id
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

  const untimedJobs = await one(
    `select c.name as customer, j.title as title,
            (select min(t.ref) from visit_participants vp
               join technicians t on t.id = vp.technician_id
              where vp.visit_id = a.id) as tech
     from visits a
     join jobs j on j.id = a.job_id
     join customers c on c.id = j.customer_id
     where a.tenant_id = $1 and a.starts_at is null and a.status = 'confirmed'
     order by a.created_at`,
    [tenantId],
  );

  // One customer → one next visit. Customers with several upcoming visits are
  // skipped: "next visit" is unambiguous only when there is exactly one soon,
  // and an ambiguous question grades badly for reasons that are not the model's.
  const nextRows = await one(
    `select distinct on (c.id) c.name as customer, (a.starts_at at time zone 'UTC')::date::text as date,
            coalesce(
              (select min(t.ref) from visit_participants vp
                 join technicians t on t.id = vp.technician_id
                where vp.visit_id = a.id),
              'unassigned') as tech, j.title as title
     from visits a
     join jobs j on j.id = a.job_id
     join customers c on c.id = j.customer_id
     where a.tenant_id = $1 and a.status = 'confirmed'
       and a.starts_at >= ($2::date)::timestamp
     order by c.id, a.starts_at`,
    [tenantId, today],
  );
  const nextVisit = Object.fromEntries(nextRows.map((r) => [r.customer, { date: r.date, tech: r.tech, title: r.title }]));

  const facts = { today, tz, dayCounts, techDayCounts, firstOfDay, timeOff, untimedJobs, nextVisit };
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
    // History of this default: NVIDIA's `z-ai/glm-5.2` (stale after the
    // 2026-08-15 Fireworks switch — run.mjs's exact-string gate then refused
    // every run, and the refusal looked like a fleet problem), then Fireworks'
    // `accounts/fireworks/routers/glm-5p2-fast` (2026-08-15 → 2026-09-05).
    // Every provider spells the same model differently (DeepInfra
    // 'zai-org/GLM-5.2', NVIDIA 'z-ai/glm-5.2'), and the gate compares EXACT
    // strings — override with DATE_EVAL_EXPECT_MODEL for trial runs.
    // 2026-09-05: the fleet moved to OpenRouter (thoughts/shared/plans/
    // 2026-09-05-fleet-to-openrouter-muse-spark.md). Its everyday route is the
    // PRESET `@preset/trades-seats` — Gemini 3.8 Flash → Muse Spark 1.3 since the
    // 2026-09-05 evening flip (Muse → Gemini that morning), chained by
    // OpenRouter per request — under which a fallback event is INVISIBLE to this
    // harness: the route string never changes and trajectories record the
    // declared id, not the served one. So the eval runs on a SINGLE-MODEL route
    // with the medic timer stopped (plan Phase 5), and this default names that
    // model. Change it WITH the boxes: a stale value refuses every run, and the
    // refusal looks like a fleet problem.
    expectedModel: process.env.DATE_EVAL_EXPECT_MODEL || 'google/gemini-3.8-flash',
    sandbox: process.env.DATE_EVAL_SANDBOX || 's2',
    facts: { dayCounts, techDayCounts, timeOff, untimedJobs },
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
  // A RANGE, not a point estimate — and MEASURED, not modelled (2026-09-05, both
  // runs summed from OpenRouter's generation records): Gemini 3.8 Flash
  // $3.40 / 82 questions = median $0.038, min $0.013, max $0.105 per question
  // (3.6 calls/question, 61% of prompt tokens cached — Gemini's implicit cache
  // is session-sticky, so every fresh session's first call is uncached);
  // Muse Spark 1.3 was $5.33 = median $0.064 (3.1 calls, 68% cached). Unit
  // costs of a driven run — never multiply by this suite's volume.
  console.log(`  estimated spend:      ~${(n * 0.02).toFixed(2)}–${(n * 0.06).toFixed(2)} USD at Gemini 3.8 Flash OpenRouter rates (measured median $0.038/question)`);
  console.log(`                        (Muse Spark 1.3, the fallback lane: ~${(n * 0.04).toFixed(2)}–${(n * 0.10).toFixed(2)}, measured median $0.064)`);
  console.log(`\n  manifest → ${join(OUT_DIR, 'manifest.json')}`);
  console.log(`\n  TO RUN (this is the step that spends money):`);
  console.log(`    npm run date-eval:run -- --dir ${OUT_DIR} --yes\n`);
} finally {
  await client.end();
}
