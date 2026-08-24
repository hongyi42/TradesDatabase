// The agentic planner eval — runner (plan 2026-08-24). THIS STEP SPENDS MONEY
// (except --dry).
//
//   node scripts/agentic-eval/run.mjs --arm glm --dry
//   node scripts/agentic-eval/run.mjs --arm glm --only SMOKE-1,SMOKE-2 --yes
//   node scripts/agentic-eval/run.mjs --arm opus --yes
//
// One scenario = seed a world into the LOCAL stack, then run its timeline of
// production-faithful ticks (sweep → planner with the real four read tools) at
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
  // The GLM arm mirrors PRODUCTION, deliberately: Fireworks fast router, the
  // provider the planner actually ran on. NOT lib/env.mjs's modelConfig() —
  // its EVAL_INFERENCE_* values point at DeepInfra, retired 2026-08-18, whose
  // host no longer maps to any ledger vendor (costs would be refused, and the
  // arm would measure a provider nothing runs on).
  const key = process.env.FIREWORKS_API_KEY || process.env.INFERENCE_API_KEY;
  if (!key) {
    console.error('FIREWORKS_API_KEY (or INFERENCE_API_KEY) is not set (.env) — the glm arm cannot run.');
    process.exit(2);
  }
  process.env.MODEL_PROVIDER = 'openai';
  process.env.INFERENCE_API_KEY = key;
  process.env.INFERENCE_BASE_URL = 'https://api.fireworks.ai/inference/v1';
  process.env.INFERENCE_MODEL = 'accounts/fireworks/routers/glm-5p2-fast';
  // Cache affinity: without a stable key, Fireworks prefix-cache hits are
  // replica routing luck (measured 2026-08-15).
  process.env.INFERENCE_CACHE_KEY ??= 'agentic-eval';
  modelLabel = process.env.INFERENCE_MODEL;
}

const { SMOKE_SCENARIOS, ALL_SCENARIOS } = await import(`${DIST}/eval/plannerCorpus.js`);
const { runArc, simStartIso, clearSimClock } = await import(`${DIST}/eval/plannerSim.js`);

const only = argOf('only', null);
const scenarios = (only ? ALL_SCENARIOS.filter((s) => only.split(',').includes(s.id)) : ALL_SCENARIOS);
if (only && scenarios.length !== only.split(',').length) {
  const found = new Set(scenarios.map((s) => s.id));
  console.error(`--only names unknown scenario(s): ${only.split(',').filter((id) => !found.has(id)).join(', ')}`);
  process.exit(2);
}
void SMOKE_SCENARIOS;

const totalTicks = scenarios.reduce(
  (n, s) => n + s.timeline.filter((t) => t.kind === 'tick').length,
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
    row.seeded = { nudgeIds: arc.seeded.nudgeIds, jobId: arc.seeded.jobId };
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
