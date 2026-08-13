// Spine-eval GATE — the one screen a /goal loop reads, and an exit code.
//
//   npm run spine-eval:gate                # judge the latest run artifacts
//   npm run spine-eval:gate -- --baseline  # record the current state as the baseline
//
// The /goal evaluator is a small model that sees ONLY the conversation — it cannot
// run commands or read files. So the verdict has to be PRINTED, compactly, with
// every number it needs to judge the condition. That is this file's whole job.
//
// It also prints a SEAL: a hash of the corpus, the graders, the date matrix and the
// thresholds. A loop told "get p95 under budget" can satisfy that by deleting the
// slow scenario or raising the budget; naming the expected seal in the goal
// condition makes either move visible in the same transcript.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { argOf, hasFlag } from './lib/env.mjs';
import { seal, ms, rate, summarise } from '../../dist/eval/metrics.js';
import { THRESHOLDS, HARD_FAILURES } from '../../dist/eval/thresholds.js';

const DIR = argOf('dir', join(process.cwd(), 'spine-eval-runs'));
const BASELINE = argOf('baseline-file', join(process.cwd(), 'src', 'eval', 'baseline.json'));

// The seal covers everything that DEFINES the eval — read from source, so an edit
// moves it whether or not anyone rebuilt.
const SEALED_FILES = [
  'src/eval/corpus.ts',
  'src/eval/toolCases.ts',
  'src/eval/graders.ts',
  'src/eval/dateMatrix.ts',
  'src/eval/thresholds.ts',
];
const sealValue = seal(SEALED_FILES.map((f) => readFileSync(f, 'utf8')));

const read = (name) => {
  const p = join(DIR, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const tier1 = read('tier1-results.json');
const tier2 = read('tier2-results.json');
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;

const problems = [];
const notes = [];

// ── tier 1 ────────────────────────────────────────────────────────────────────
let t1 = null;
if (!tier1) {
  problems.push('tier 1 has never run in this directory — `npm run spine-eval:tools`');
} else {
  const ran = tier1.results.filter((r) => r.status !== 'skipped');
  const passed = ran.filter((r) => r.status === 'passed');
  const dates = tier1.dateResults ?? [];
  const datesPassed = dates.filter((d) => d.status === 'passed');
  const worst = [...(tier1.latency ?? [])].sort((a, b) => b.p95 - a.p95)[0] ?? null;
  t1 = {
    casePassRate: rate(passed.length, ran.length),
    cases: `${passed.length}/${ran.length}`,
    datePassRate: rate(datesPassed.length, dates.length),
    dates: `${datesPassed.length}/${dates.length}`,
    skipped: tier1.results.filter((r) => r.status === 'skipped').length,
    worstTool: worst ? { tool: worst.tool, p95: worst.p95 } : null,
  };
  if (t1.casePassRate < THRESHOLDS.tier1.casePassRate) {
    problems.push(`tier 1 cases ${t1.cases} (${t1.casePassRate}%) — these are deterministic, so anything under ${THRESHOLDS.tier1.casePassRate}% is a real break`);
  }
  if (t1.datePassRate < THRESHOLDS.tier1.datePassRate) {
    problems.push(`date matrix ${t1.dates} (${t1.datePassRate}%) — pure arithmetic, so a miss is a machinery bug`);
  }
  if (worst && worst.p95 > THRESHOLDS.tier1.toolP95Ms) {
    problems.push(`slowest tool ${worst.tool} at p95 ${ms(worst.p95)} exceeds the ${ms(THRESHOLDS.tier1.toolP95Ms)} budget`);
  }
}

// ── tier 2 ────────────────────────────────────────────────────────────────────
let t2 = null;
if (!tier2) {
  notes.push('tier 2 has not run in this directory — the agent-layer numbers below are absent, not zero');
} else {
  const passed = tier2.results.filter((r) => r.status === 'passed');
  const kinds = {};
  for (const r of tier2.results) for (const f of r.findings) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
  const wall = summarise(tier2.results.map((r) => r.metrics.wallMs));
  const model = summarise(tier2.results.map((r) => r.metrics.modelMs));
  const tools = summarise(tier2.results.map((r) => r.metrics.toolMs));
  t2 = {
    passRate: rate(passed.length, tier2.results.length),
    scenarios: `${passed.length}/${tier2.results.length}`,
    kinds,
    wallP95: wall.p95,
    modelP50: model.p50,
    toolP50: tools.p50,
    modelShare: model.mean / (model.mean + tools.mean),
    spendUsd: tier2.spend?.usd ?? 0,
    model: tier2.model?.model ?? 'unknown',
    doctrine: tier2.doctrine?.fingerprint ?? 'unknown',
  };

  // Hard safety rules, independent of any baseline.
  for (const kind of HARD_FAILURES) {
    if (kinds[kind]) {
      problems.push(`${kinds[kind]} × ${kind} — a hard failure: no rate of this is acceptable`);
    }
  }
  if (wall.p95 > THRESHOLDS.tier2.wallP95Ms) {
    problems.push(`a scenario took ${ms(wall.p95)} at p95, past the ${ms(THRESHOLDS.tier2.wallP95Ms)} hang threshold`);
  }
  // Regression against the recorded baseline.
  if (baseline?.tier2?.passRate != null) {
    const drop = baseline.tier2.passRate - t2.passRate;
    if (drop > THRESHOLDS.tier2.passRateDropAllowed) {
      problems.push(
        `tier 2 pass rate fell ${drop.toFixed(1)} points below the baseline ` +
          `(${t2.passRate}% vs ${baseline.tier2.passRate}%), past the ${THRESHOLDS.tier2.passRateDropAllowed}-point tolerance`,
      );
    }
  } else {
    notes.push('no tier-2 baseline recorded yet — regressions cannot be detected until one is (`--baseline`)');
  }
  if (baseline?.seal && baseline.seal !== sealValue) {
    notes.push(`the eval definition has CHANGED since the baseline was recorded (seal ${baseline.seal} → ${sealValue})`);
  }
}

// ── record a baseline ─────────────────────────────────────────────────────────
if (hasFlag('baseline')) {
  const next = {
    recordedAt: new Date().toISOString(),
    seal: sealValue,
    note: 'Measured state, not a target. The gate fails a DROP from this; the hard safety rules fail regardless.',
    ...(t1 ? { tier1: { casePassRate: t1.casePassRate, datePassRate: t1.datePassRate, worstToolP95Ms: t1.worstTool?.p95 ?? null } } : {}),
    ...(t2
      ? {
          tier2: {
            passRate: t2.passRate,
            scenarios: t2.scenarios,
            model: t2.model,
            doctrine: t2.doctrine,
            findingKinds: t2.kinds,
            wallP95Ms: Math.round(t2.wallP95),
          },
        }
      : {}),
  };
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nBaseline written to ${BASELINE} (seal ${sealValue}).`);
  console.log('Commit it: a baseline that is not in git cannot detect a regression across machines.\n');
  process.exit(0);
}

// ── the verdict ───────────────────────────────────────────────────────────────
const green = problems.length === 0;
const line = '─'.repeat(66);
console.log(`\n${line}`);
console.log(`  SPINE EVAL GATE — ${green ? 'PASS' : 'FAIL'}`);
console.log(`  seal ${sealValue}   (corpus + graders + date matrix + thresholds)`);
console.log(line);

if (t1) {
  console.log(`  tier 1   cases ${t1.cases} (${t1.casePassRate}%)   dates ${t1.dates} (${t1.datePassRate}%)   ${t1.skipped} skipped`);
  if (t1.worstTool) console.log(`           slowest tool: ${t1.worstTool.tool} p95 ${ms(t1.worstTool.p95)} (budget ${ms(THRESHOLDS.tier1.toolP95Ms)})`);
} else {
  console.log(`  tier 1   NOT RUN`);
}
if (t2) {
  console.log(`  tier 2   scenarios ${t2.scenarios} (${t2.passRate}%)   model ${t2.model}   doctrine ${t2.doctrine}`);
  console.log(`           wall p95 ${ms(t2.wallP95)}   model p50 ${ms(t2.modelP50)}   tools p50 ${ms(t2.toolP50)}   model = ${(t2.modelShare * 100).toFixed(1)}% of a turn`);
  console.log(`           spend $${t2.spendUsd.toFixed(3)}`);
  const kinds = Object.entries(t2.kinds).sort((a, b) => b[1] - a[1]);
  if (kinds.length) console.log(`           findings: ${kinds.map(([k, n]) => `${k}×${n}`).join('  ')}`);
} else {
  console.log(`  tier 2   NOT RUN`);
}
if (baseline) {
  console.log(`  baseline recorded ${baseline.recordedAt?.slice(0, 10)}` + (baseline.tier2 ? `, tier 2 at ${baseline.tier2.passRate}%` : ''));
}

if (notes.length) {
  console.log(`\n  notes:`);
  for (const n of notes) console.log(`    - ${n}`);
}
if (problems.length) {
  console.log(`\n  BLOCKING:`);
  for (const p of problems) console.log(`    ✗ ${p}`);
}
console.log(`\n  ${green ? 'PASS — every threshold met.' : `FAIL — ${problems.length} blocking problem(s).`}`);
console.log(`${line}\n`);

process.exit(green ? 0 : 1);
