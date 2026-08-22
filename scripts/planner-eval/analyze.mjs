// Planner-copy eval STEP 2 of 2 — grade and report. Spends money ONLY with
// --judge (one cheap call per note).
//
//   node scripts/planner-eval/analyze.mjs --dir <run-dir>
//   node scripts/planner-eval/analyze.mjs --dir <run-dir> --judge
//
// Reads run.jsonl, applies the deterministic checks, optionally asks the judge,
// and prints: what the planner DECIDED per scenario, every failed check with
// the note quoted, and the money — including what the same tokens would have
// cost under each cache strategy, so the production TTL is a number you read.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deterministicChecks, summarise } from './graders.mjs';
import { judgeNote } from './judge.mjs';
import { callPlanner, counterfactuals } from './anthropic.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? (args[i + 1] ?? true) : d; };
const dir = flag('dir');
if (!dir) { console.error('--dir <run-dir> required'); process.exit(2); }

const { cleanHandoffNote } = await import(`${join(ROOT, 'dist')}/teamLead/planner.js`);
const rows = readFileSync(join(dir, 'run.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const results = [];
let judgeSpend = 0;

for (const r of rows) {
  const decisions = r.plan?.decisions ?? [];
  // The block the model saw, per gap, so the judge reads the same evidence.
  const blocks = r.user.split('\n\n').filter((b) => b.startsWith('gap '));
  const perGap = [];
  for (const d of decisions) {
    const note = d.handoffNote ?? null;
    const block = blocks.find((b) => b.includes(d.nudgeId)) ?? r.user;
    // The labels the block actually offered — parsed out of the rendered block
    // rather than recomputed, so the grader rails against what the model saw.
    const dateLabels = [...block.matchAll(/^\s{4}[a-z][^:]*: (.+)$/gm)].map((m) => m[1].trim());
    // The ACTION is a check, not decoration. The first run printed
    // "expected NOT to: escalate" directly above a green tick, because the tick
    // only ever described the copy — a scenario could fail its whole point and
    // still read as a pass.
    const actionChecks = [];
    if (r.expect?.action) {
      actionChecks.push({
        name: 'action-as-expected', pass: d.action === r.expect.action,
        detail: d.action === r.expect.action ? undefined : `got ${d.action}, wanted ${r.expect.action}`,
      });
    }
    if (r.expect?.actionNot) {
      actionChecks.push({
        name: 'action-avoided', pass: d.action !== r.expect.actionNot,
        detail: d.action !== r.expect.actionNot ? undefined : `did ${d.action}, which the scenario says it should not`,
      });
    }
    const checks = note
      ? deterministicChecks(note, {
          dateLabels,
          mustName: r.expect?.mustName ?? [],
          mustNotClaim: r.expect?.mustNotClaim ?? [],
          cleanHandoffNote,
        }).concat(actionChecks)
      : actionChecks;
    let verdict = null;
    if (note && flag('judge')) {
      const j = await judgeNote({
        block, note, model: flag('judge-model', 'claude-sonnet-5'),
        apiKey: (readFileSync(join(ROOT, '.env'), 'utf8').match(/^ANTHROPIC_API_KEY=(.*)$/m) ?? [])[1]?.trim(),
        callPlanner,
      });
      verdict = j.verdict;
      judgeSpend += j.cost.usd;
    }
    perGap.push({ nudgeId: d.nudgeId, action: d.action, note, checks, verdict });
  }
  results.push({ id: r.id, expect: r.expect, decisions: decisions.length, perGap, cost: r.cost });
}

console.log(B('\n═══ WHAT THE PLANNER DECIDED ═══'));
for (const r of results) {
  console.log(`\n${B(r.id)}`);
  if (r.expect?.action) console.log(`  expected action: ${r.expect.action}`);
  if (r.expect?.actionNot) console.log(`  expected NOT to: ${r.expect.actionNot}`);
  if (r.perGap.length === 0) console.log('  (no decisions — the planner left it alone)');
  for (const g of r.perGap) {
    const bad = g.checks.filter((c) => !c.pass);
    const mark = bad.length === 0 ? '✓' : '✗';
    console.log(`  ${mark} ${g.action} ${g.nudgeId}`);
    if (g.note) console.log(`      "${g.note}"`);
    for (const b of bad) console.log(`      FAILED ${b.name}${b.detail ? `: ${b.detail}` : ''}`);
    if (g.verdict) {
      if (g.verdict.blamesPerson) console.log(`      JUDGE: blames the person — ${g.verdict.note}`);
      for (const c of g.verdict.unsupportedClaims ?? []) console.log(`      JUDGE: unsupported — "${c}"`);
      if (!g.verdict.wouldActOnIt) console.log(`      JUDGE: a manager could not act on it`);
    }
  }
}

const all = results.flatMap((r) => r.perGap.flatMap((g) => g.checks));
const byName = new Map();
for (const c of all) {
  const e = byName.get(c.name) ?? { pass: 0, total: 0 };
  e.total += 1; if (c.pass) e.pass += 1;
  byName.set(c.name, e);
}
console.log(B('\n═══ CHECKS ═══'));
for (const [name, e] of byName) console.log(`  ${e.pass === e.total ? '✓' : '✗'} ${name.padEnd(22)} ${e.pass}/${e.total}`);

const costs = rows.map((r) => r.cost);
const cf = counterfactuals(costs, meta.model);
const spent = costs.reduce((a, c) => a + c.usd, 0);
const hits = costs.filter((c) => c.cacheHit).length;
console.log(B('\n═══ MONEY ═══'));
console.log(`  run: $${spent.toFixed(4)} over ${rows.length} calls   cache hits ${hits}/${rows.length}   ttl ${meta.ttl}`);
console.log(`  judge: $${judgeSpend.toFixed(4)}`);

// WHERE THE MONEY GOES, before any talk of caching. The first version of this
// report led with the cacheable prefix priced four ways, which put the emphasis
// on the smallest slice: the planner's system prompt is short and its output is
// a whole plan, so OUTPUT dominates and caching cannot touch it. A caching
// number quoted without this breakdown reads as a bigger win than it is.
const P = (await import('./anthropic.mjs')).PRICES[meta.model];
const M = 1e6;
const tot = costs.reduce(
  (a, c) => ({
    inTok: a.inTok + c.inTok, read: a.read + c.read,
    write: a.write + c.write5m + c.write1h, outTok: a.outTok + c.outTok,
  }),
  { inTok: 0, read: 0, write: 0, outTok: 0 },
);
const part = {
  'uncached input (the gap blocks)': (tot.inTok * P.base) / M,
  'cache reads (the prefix)': (tot.read * P.base * 0.1) / M,
  'cache writes (the prefix)': (tot.write * P.base * 1.25) / M,
  'OUTPUT (the plan itself)': (tot.outTok * P.out) / M,
};
const sum = Object.values(part).reduce((a, b) => a + b, 0) || 1;
console.log(B('\n  where it went:'));
for (const [k, v] of Object.entries(part)) {
  console.log(`    ${k.padEnd(32)} $${v.toFixed(4)}   ${((100 * v) / sum).toFixed(1).padStart(5)}%`);
}
console.log(
  `    ${'— caching can only touch'.padEnd(32)} $${(part['cache reads (the prefix)'] + part['cache writes (the prefix)']).toFixed(4)}   ` +
    `${((100 * (part['cache reads (the prefix)'] + part['cache writes (the prefix)'])) / sum).toFixed(1).padStart(5)}%`,
);
console.log(`    ${'output tokens'.padEnd(32)} ${tot.outTok} at $${P.out}/MTok — never cacheable`);

console.log(B('\n  the cacheable prefix, priced four ways (same tokens):'));
console.log(`    no cache at all            $${cf.noCache.toFixed(4)}`);
console.log(`    5m TTL, warm  (this run)   $${cf.ttl5m.toFixed(4)}`);
console.log(`    1h TTL, warm               $${cf.ttl1h.toFixed(4)}`);
console.log(`    5m TTL, always cold        $${cf.allWrites5m.toFixed(4)}   ← what PRODUCTION gets`);
console.log(
  '\n  Production runs the planner every 30 MINUTES, so a 5m cache is cold on\n' +
    '  every call: it pays the 1.25x write and never reads, which is worse than\n' +
    "  not caching. Only ttl:'1h' wins there. This run cannot prove that — its\n" +
    '  calls are seconds apart — so measure it on the pilot before trusting it.',
);

writeFileSync(join(dir, 'analysis.json'), JSON.stringify({ results, spent, judgeSpend, counterfactuals: cf }, null, 2));
console.log(`\n  ${join(dir, 'analysis.json')}`);
