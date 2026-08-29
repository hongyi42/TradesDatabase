// The agentic planner eval — runner (plan 2026-08-24). THIS STEP SPENDS MONEY
// (except --dry).
//
//   node scripts/agentic-eval/run.mjs --arm glm --dry
//   node scripts/agentic-eval/run.mjs --arm glm --only SMOKE-1,SMOKE-2 --yes
//   node scripts/agentic-eval/run.mjs --arm opus --yes
//
// One scenario = seed a world into the LOCAL stack, then run its timeline of
// production-faithful ticks (sweep → planner with its real TWO read tools —
// spine_read + recall_decisions, the only schemas production hands it) at
// simulated instants. Results land as one JSONL row per scenario;
// analyze.mjs (Phase 4) grades them — nothing here judges anything.
//
// The ARM pins the provider for the whole process, which is exactly how
// production routes (one env, one provider — see the per-call model routing
// research): opus → MODEL_PROVIDER=anthropic + claude-opus-5; glm → the
// production Fireworks fast router via FIREWORKS_API_KEY. Every model call
// bills the local stack's cost_events through the real ledger, so the report
// prices itself off cost_rates rather than a private price table.

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { requireLocalStack, argOf, hasFlag } from '../spine-eval/lib/env.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');

// ── env + arm (BEFORE any dist import) ───────────────────────────────────────
requireLocalStack();

const arm = argOf('arm', null);
if (arm !== 'opus' && arm !== 'glm') {
  console.error('--arm opus|glm is required');
  process.exit(2);
}
let modelLabel;
if (arm === 'opus') {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (.env) — the opus arm cannot run.');
    process.exit(2);
  }
  process.env.MODEL_PROVIDER = 'anthropic';
  // Unconditional: the arm SETS the model. A stray ANTHROPIC_MODEL in .env or
  // the shell must not silently retarget the "opus" arm (review finding) —
  // MODEL_SKUS.anthropic prices this exact model, so a drift also mis-bills.
  process.env.ANTHROPIC_MODEL = 'claude-opus-5';
  modelLabel = process.env.ANTHROPIC_MODEL;
} else {
  // The GLM arm mirrors PRODUCTION, deliberately — and production moved to
  // OpenRouter + GLM 5.3 on 2026-08-28 (plan
  // thoughts/shared/plans/2026-08-28-openrouter-migration.md). Repointed WITH
  // production rather than left on Fireworks/GLM-5.2: an eval that measures the
  // model production no longer runs reports a false pass, which is worse than
  // no eval, because this arm IS the regression check for that switch.
  //
  // NOT lib/env.mjs's modelConfig() — its EVAL_INFERENCE_* values point at
  // DeepInfra, retired 2026-08-18, whose host maps to no ledger vendor.
  //
  // OPENROUTER_API_KEY ONLY — no INFERENCE_API_KEY fallback (review finding,
  // preserved through the repoint): a lingering retired-provider key would pass
  // the gate here and then 401 on every tick, after the world was already
  // reset. The variable is vendor-NAMED for exactly that reason.
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.error('OPENROUTER_API_KEY is not set (.env) — the glm arm cannot run.');
    process.exit(2);
  }
  process.env.MODEL_PROVIDER = 'openai';
  process.env.INFERENCE_API_KEY = key;
  process.env.INFERENCE_BASE_URL = 'https://openrouter.ai/api/v1';
  process.env.INFERENCE_MODEL = 'z-ai/glm-5.3';
  // NO INFERENCE_CACHE_KEY: `prompt_cache_key` is an OpenAI-specific field and
  // OpenRouter ignores it. Caching there comes from STICKY ROUTING instead
  // (measured 2026-08-28: 5824/5879 prompt tokens cached on the second
  // identical call, 5x cheaper), which needs no key and would be DISABLED by a
  // manual provider order — which is why no provider block is sent.
  modelLabel = process.env.INFERENCE_MODEL;
}

const { SMOKE_SCENARIOS, ALL_SCENARIOS } = await import(`${DIST}/eval/plannerCorpus.js`);
const { runArc, simStartIso, clearSimClock } = await import(`${DIST}/eval/plannerSim.js`);

const only = argOf('only', null);
const wanted = only ? [...new Set(only.split(',').map((id) => id.trim()).filter(Boolean))] : null;
const scenarios = wanted ? ALL_SCENARIOS.filter((s) => wanted.includes(s.id)) : ALL_SCENARIOS;
if (wanted) {
  const found = new Set(scenarios.map((s) => s.id));
  const unknown = wanted.filter((id) => !found.has(id));
  if (unknown.length > 0) {
    console.error(`--only names unknown scenario(s): ${unknown.join(', ')}`);
    process.exit(2);
  }
}
void SMOKE_SCENARIOS;

// Model ticks only: an expectWindowSkip tick records nothing and spends nothing.
const totalTicks = scenarios.reduce(
  (n, s) => n + s.timeline.filter((t) => t.kind === 'tick' && !t.expectWindowSkip).length,
  0,
);

if (hasFlag('dry')) {
  console.log(`agentic planner eval — DRY listing (arm ${arm}, model ${modelLabel})\n`);
  const byFamily = new Map();
  for (const s of scenarios) {
    byFamily.set(s.family, (byFamily.get(s.family) ?? 0) + 1);
    const ticks = s.timeline.filter((t) => t.kind === 'tick').length;
    console.log(`  ${s.id.padEnd(16)} ${s.family.padEnd(14)} ${ticks} tick(s) — ${s.why.slice(0, 90)}`);
  }
  console.log(`\n  families: ${[...byFamily].map(([f, n]) => `${f}=${n}`).join('  ')}`);
  console.log(`  scenarios: ${scenarios.length}   model ticks: ${totalTicks}`);
  console.log(`  rough cost: ~$${(totalTicks * (arm === 'opus' ? 0.09 : 0.01)).toFixed(2)} (${arm} arm)`);
  process.exit(0);
}

if (!hasFlag('yes')) {
  console.error(
    'This step CALLS THE MODEL AND SPENDS MONEY. Re-run with --yes.\n' +
      `  arm: ${arm} (${modelLabel})   scenarios: ${scenarios.length}   model ticks: ${totalTicks}\n` +
      `  rough cost: ~$${(totalTicks * (arm === 'opus' ? 0.09 : 0.01)).toFixed(2)}`,
  );
  process.exit(2);
}

// ── run-start reset ──────────────────────────────────────────────────────────
// COPIED from scripts/spine-eval/world.mjs's RESET_TABLES (world.mjs exports
// nothing and executes main() on import, so the list cannot be imported), plus
// money_events, which that list clears only via the jobs cascade.
// lifecycle_runs is DELIBERATELY EXCLUDED (eng-memory §1 registration): the
// cron's own tenant-agnostic execution log, with no tenant FK to dangle. An eval
// run must not erase the evidence of whether the heartbeat has been ticking.
const RESET_TABLES = [
  'gap_summaries',
  'nudge_decisions',
  'nudges',
  'reflector_runs',
  'planner_lessons',
  'review_items',
  'cost_events',
  'money_events',
  'query_audit',
  'dropped_audit',
  'schedule_events',
  'schedule_entries',
  'technician_time_off',
  'job_type_durations',
  'raw_captures',
  'visits',
  'assignments',
  'jobs',
  'customers',
  'technicians',
  'tenant_profiles',
  // Registered BY NAME (eng-memory §1). Cascades from tenants, so omitting it
  // fails SILENTLY — a stale row would change this firm's cadence mid-eval.
  'tenant_settings',
  'sandbox_pool',
  'hosts',
];

const sql = new pg.Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const { rows: present } = await sql.query(
  `select table_name from information_schema.tables where table_schema = 'public'`,
);
const have = new Set(present.map((r) => r.table_name));
const toReset = RESET_TABLES.filter((t) => have.has(t));
await sql.query(`truncate ${toReset.map((t) => `"${t}"`).join(', ')} cascade`);
await sql.query(`delete from tenants where name like 'Eval %'`);

const {
  rows: [tenant],
} = await sql.query(
  `insert into tenants (name, timezone) values ('Eval PlannerSim', 'America/Los_Angeles')
   returning id, timezone`,
);
console.log(`  tenant: ${tenant.id} (${tenant.timezone})`);

// ── run ──────────────────────────────────────────────────────────────────────
const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[:.]/g, '-');
const dir = argOf('out', null) ?? join(ROOT, 'spine-eval-runs', `agentic-${arm}-${stamp}`);
mkdirSync(dir, { recursive: true });
const out = join(dir, 'results.jsonl');
writeFileSync(out, '');

const t0 = simStartIso(10);
const t0Ms = Date.parse(t0);
// DST guard (review finding): corpus offsets are pure milliseconds but the
// window guard is wall-clock — a fall-back inside the corpus horizon moves a
// +21h tick from 07:00 to 06:00 and throws mid-paid-run. Refuse the run day.
{
  const { localTimeHHMM } = await import(`${DIST}/schedule/availability.js`);
  const tz = 'America/Los_Angeles';
  for (const probe of [-48, 24, 36]) {
    const then = new Date(t0Ms + probe * 3_600_000).toISOString();
    const expected = ((10 + probe) % 24 + 24) % 24;
    if (Number(localTimeHHMM(then, tz).slice(0, 2)) !== expected) {
      console.error(
        `A DST transition falls inside the corpus horizon (t0${probe >= 0 ? '+' : ''}${probe}h ` +
          `is not ${expected}:00 firm-local) — offsets and wall clocks disagree today. ` +
          'Run on a non-transition day.',
      );
      process.exit(2);
    }
  }
}
console.log(`  t0: ${t0} (10:00 firm-local)   arm: ${arm} (${modelLabel})\n`);

let harnessErrors = 0;
for (const s of scenarios) {
  // Per-scenario cleanup: anything tenant-listed leaks into the next
  // scenario's plan (the planner and watchers walk the TENANT). Nudges cascade
  // their decisions and summaries. Captures stay — L1 is append-only between
  // the run-start truncates — and never leak: evidence reads are job-keyed and
  // every scenario seeds fresh jobs. cost_events is deliberately KEPT — it is
  // the run's price source, summed since startedAt below.
  await sql.query(`delete from review_items where tenant_id = $1`, [tenant.id]);
  await sql.query(`delete from nudges where tenant_id = $1`, [tenant.id]);
  // money_events is APPEND-ONLY (ledger trigger; caught by the corpus test) —
  // rows persist across scenarios, harmlessly: money reads are JOB-scoped and
  // every scenario seeds fresh jobs. Run-start TRUNCATE still clears them.
  await sql.query(`delete from planner_lessons where tenant_id = $1`, [tenant.id]);
  // Neutralize the PRIOR scenario's world for the live detectors: candidates
  // are CONFIRMED assignments in the 72h window, and every scenario shares one
  // t0 — without this, scenario N's visit re-flags as a fresh gap in every
  // later scenario's tick, opening phantom manager items (review finding; the
  // once-ever stores can't help, the nudges delete just emptied them).
  await sql.query(
    `update assignments set status = 'cancelled' where tenant_id = $1 and status = 'confirmed'`,
    [tenant.id],
  );

  process.stdout.write(`${s.id} … `);
  const row = { id: s.id, family: s.family, why: s.why, expect: s.expect ?? null, arm, model: modelLabel, ticks: [] };
  const wall = Date.now();
  try {
    const arc = await runArc(tenant.id, s, t0Ms);
    row.seeded = {
      nudgeIds: arc.seeded.nudgeIds,
      jobId: arc.seeded.jobId,
      lessonIds: arc.seeded.lessonIds,
    };
    row.ticks = arc.ticks;
    row.steps = arc.steps;
    row.ticksSkipped = arc.ticksSkipped;
    row.finalNowIso = arc.finalNowIso;
    row.epilogue = arc.epilogue;
    const last = row.ticks[row.ticks.length - 1];
    const actions = last ? last.decisions.map((d) => d.action).join(',') : 'none';
    console.log(
      `${row.ticks.length} tick(s)${arc.ticksSkipped ? ` (+${arc.ticksSkipped} skipped)` : ''} · ` +
        `decisions: ${actions || 'none'} · ` +
        `summaries: ${arc.epilogue.summaries.length} · ${Date.now() - wall}ms`,
    );
  } catch (err) {
    harnessErrors += 1;
    row.harnessError = err instanceof Error ? err.message : String(err);
    console.log(`HARNESS ERROR — ${row.harnessError}`);
  }
  row.wallMs = Date.now() - wall;
  appendFileSync(out, JSON.stringify(row) + '\n');
}
clearSimClock();

// ── the money, from the real ledger ──────────────────────────────────────────
const { rows: spend } = await sql.query(
  `select provider, sku, sum(quantity)::bigint as tokens from cost_events
   where tenant_id = $1 and created_at >= $2 group by provider, sku order by provider, sku`,
  [tenant.id, startedAt],
);
console.log('\n  ledger (this run):');
for (const r of spend) console.log(`    ${r.provider.padEnd(10)} ${r.sku.padEnd(32)} ${r.tokens} tokens`);

writeFileSync(
  join(dir, 'meta.json'),
  JSON.stringify(
    { arm, model: modelLabel, startedAt, t0, tenantId: tenant.id, scenarios: scenarios.length, harnessErrors, ledger: spend },
    null,
    2,
  ),
);
await sql.end();
console.log(`\n${dir}`);
process.exit(harnessErrors > 0 ? 1 : 0);
