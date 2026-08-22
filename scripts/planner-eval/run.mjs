// Planner-copy eval STEP 1 of 2 — run. THIS IS THE STEP THAT SPENDS MONEY.
//
//   node scripts/planner-eval/run.mjs --yes
//   node scripts/planner-eval/run.mjs --yes --ttl 1h --model claude-opus-5
//
// Renders each scenario through the REAL buildGapView + buildPlannerUserMessage
// out of dist/, sends it with the REAL PLANNER_SYSTEM and submit_plan schema,
// and writes one JSONL row per scenario. analyze.mjs grades the rows; nothing
// here judges anything, so a grading change never needs to re-spend.
//
// TTL, and why the eval's answer is NOT production's answer:
//   * here, calls fire back to back and a cache READ refreshes the TTL, so the
//     default 5m holds for the whole run at a 1.25x write. Correct and cheapest.
//   * production runs the planner every 30 MINUTES. A 5m cache is always cold,
//     so every call pays 1.25x and never reads — strictly worse than no cache.
//     Only ttl:'1h' helps there. analyze.mjs prints both from the same tokens.
//   * this run CANNOT settle that: seconds-apart calls would pass whether or
//     not refresh-on-read works across a 30-minute gap. Measure it on the pilot.

import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callPlanner } from './anthropic.mjs';
import { SCENARIOS, NOW, TZ } from './scenarios.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? true) : d;
};
if (!args.includes('--yes')) {
  console.error(
    'This step CALLS THE API AND SPENDS MONEY. Re-run with --yes.\n' +
      `  scenarios: ${SCENARIOS.length}   model: ${flag('model', 'claude-opus-5')}   ttl: ${flag('ttl', '5m')}`,
  );
  process.exit(2);
}

// The key is read from .env by name only and never printed.
const env = readFileSync(join(ROOT, '.env'), 'utf8');
const apiKey = (env.match(/^ANTHROPIC_API_KEY=(.*)$/m) ?? [])[1]?.trim();
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY is not in .env — nothing was sent.');
  process.exit(2);
}

const model = flag('model', 'claude-opus-5');
const ttl = flag('ttl', '5m');
const limit = Number(flag('limit', SCENARIOS.length));

const { PLANNER_SYSTEM, SUBMIT_PLAN_TOOL } = await import(`${DIST}/teamLead/plannerPrompt.js`);
const { buildGapView, buildPlannerUserMessage } = await import(`${DIST}/teamLead/planner.js`);

const stamp = NOW.replace(/[:.]/g, '-');
const dir = join(ROOT, 'thoughts/shared/evals', `planner-copy-${stamp}`);
mkdirSync(dir, { recursive: true });
const out = join(dir, 'run.jsonl');
writeFileSync(out, '');

const nowMs = Date.parse(NOW);
let spent = 0;

for (const s of SCENARIOS.slice(0, limit)) {
  // Real views, real assembly. A scenario that cannot render is a LOUD error:
  // a silently-skipped scenario is a hole in the measurement that looks like a
  // pass rate.
  const jobs = s.nudges.map((n) => n.context?.jobId);
  const views = s.nudges.map((n) =>
    buildGapView(
      n,
      nowMs,
      s.evidence ?? [],
      jobs.filter((j) => j === n.context?.jobId).length > 1,
      new Set(),
      [],
      s.money ?? [],
      TZ,
    ),
  );
  if (views.some((v) => !v.block)) throw new Error(`${s.id}: rendered no block`);
  const user = buildPlannerUserMessage(NOW, TZ, views);

  process.stdout.write(`${s.id} … `);
  const res = await callPlanner({
    system: PLANNER_SYSTEM,
    tool: SUBMIT_PLAN_TOOL,
    user,
    model,
    ttl,
    apiKey,
  });
  spent += res.cost.usd;
  console.log(
    `${res.plan ? `${(res.plan.decisions ?? []).length} decision(s)` : 'NO PLAN'} ` +
      `· ${res.cost.cacheHit ? 'cache HIT' : 'cache write'} · $${res.cost.usd.toFixed(4)}`,
  );
  appendFileSync(
    out,
    JSON.stringify({
      id: s.id, why: s.why, expect: s.expect, model, ttl,
      user, plan: res.plan, stopReason: res.stopReason,
      usage: res.usage, cost: res.cost,
    }) + '\n',
  );
}

writeFileSync(join(dir, 'meta.json'), JSON.stringify({ model, ttl, now: NOW, tz: TZ, spentUsd: spent }, null, 2));
console.log(`\n${dir}\n  spent: $${spent.toFixed(4)}   →  node scripts/planner-eval/analyze.mjs --dir ${dir}`);
