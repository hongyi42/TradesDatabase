// Spine-eval TIER 1 — the tool layer. Free, deterministic, no model.
//
//   npm run spine-eval:tools
//   npm run spine-eval:tools -- --with-external     # also the model/network/Composio/Maps cases
//   npm run spine-eval:tools -- --only R,G          # families or case ids by prefix
//
// Runs every case against the REAL spine MCP server over HTTP with a signed
// identity header, then the deterministic date matrix, and writes a report.
//
// SERIAL BY DESIGN. Concurrency would make the latency numbers meaningless —
// parallel calls inflate each other's round trips, and per-tool latency is half
// the reason this tier exists. It is fast enough serial (no model in the loop).
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { requireLocalStack, productionLikeEnv, assertWorldPresent, argOf, hasFlag } from './lib/env.mjs';
import { startSpineServer, makeCaller } from './lib/mcp.mjs';
import { buildToolCases } from '../../dist/eval/toolCases.js';
import { buildDateMatrix, gradeDateCase, todayFor } from '../../dist/eval/dateMatrix.js';
import { resolveDate } from '../../dist/schedule/dateResolve.js';
import { ms, rate, summarise } from '../../dist/eval/metrics.js';
import { tenantOf } from '../../dist/eval/worldManifest.js';
import { titleWeekday } from '../../dist/eval/clock.js';

console.log('\n=== SPINE EVAL — TIER 1 (tool layer) ===');
const { dbUrl } = requireLocalStack();
productionLikeEnv();

const DIR = argOf('dir', join(process.cwd(), 'spine-eval-runs'));
const ONLY = (argOf('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(argOf('timeout', '30000'));

// Which external dependencies the caller has enabled. Anything not enabled is
// SKIPPED AND NAMED — never silently counted as a pass, and never reported as a
// failure that is really an absent capability.
const enabled = new Set(
  hasFlag('with-external')
    ? ['model', 'network', 'composio', 'maps']
    : ['model', 'network', 'composio', 'maps'].filter((r) => hasFlag(`with-${r}`)),
);

const worldPath = join(DIR, 'world.json');
if (!existsSync(worldPath)) {
  console.error(`\nNo world at ${worldPath}. Run:  npm run spine-eval:world\n`);
  process.exit(1);
}
const world = JSON.parse(readFileSync(worldPath, 'utf8'));
console.log(`  world:  ${titleWeekday(world.anchor)} ${world.anchor}   built ${world.builtAt}`);

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const sql = async (text, params = []) => (await client.query(text, params)).rows;

await assertWorldPresent(sql, world);

const server = await startSpineServer();
const spine = makeCaller(server);
console.log(`  spine:  in-process MCP server on 127.0.0.1:${server.port} (signed identity, per-run secret)`);

const allCases = buildToolCases();
const selected = ONLY.length
  ? allCases.filter((c) => ONLY.some((p) => c.id.startsWith(p) || c.family === p))
  : allCases;
console.log(`  cases:  ${selected.length}${ONLY.length ? ` (filtered by ${ONLY.join(',')})` : ''}`);
console.log(`  external: ${enabled.size ? [...enabled].join(', ') : 'none enabled — those cases will be SKIPPED'}\n`);

const results = [];
const latencyByTool = new Map();
const record = (tool, milliseconds) => {
  if (!latencyByTool.has(tool)) latencyByTool.set(tool, []);
  latencyByTool.get(tool).push(milliseconds);
};

for (const c of selected) {
  if (c.requires && !enabled.has(c.requires)) {
    results.push({ ...meta(c), status: 'skipped', reason: `needs ${c.requires}`, ms: 0, steps: [] });
    console.log(`  ${c.id.padEnd(4)} SKIP  ${c.title}  (needs ${c.requires})`);
    continue;
  }

  const tenant = tenantOf(world, c.tenant);
  const prior = [];
  const stepReports = [];
  let failure = null;
  let totalMs = 0;

  for (const step of c.steps) {
    const ctx = { world, tenant, anchor: world.anchor, prior, sql };
    if (step.when && !step.when(ctx)) {
      stepReports.push({ label: step.label, status: 'skipped', ms: 0 });
      continue;
    }
    const tool = step.tool ?? c.tool;
    const badge = step.badge ?? c.badge;
    const identity = { tenantId: tenant.id, badge, timeoutMs: TIMEOUT_MS };

    let out;
    try {
      if (step.listTools) {
        const listed = await spine.listTools(identity);
        // Normalised into the same outcome shape so checks are uniform.
        out = {
          ok: listed.ok,
          isError: !listed.ok,
          timedOut: false,
          httpStatus: listed.ok ? 200 : 0,
          text: listed.ok ? listed.names.join(' ') : listed.text,
          json: listed.names,
          ms: listed.ms,
        };
      } else {
        out = await spine.call(tool, step.args(ctx), identity);
      }
    } catch (err) {
      // A THROW is a harness bug (a missing fixture, a bad arg builder) — never a
      // silent pass. It is reported as such, distinctly from a tool refusal.
      out = { ok: false, isError: true, timedOut: false, httpStatus: 0, text: `harness error: ${err.message}`, json: null, ms: 0 };
    }

    prior.push(out);
    totalMs += out.ms;
    record(tool, out.ms);

    let stepFailure = null;
    if (out.timedOut) stepFailure = `TIMED OUT after ${TIMEOUT_MS}ms`;
    else if (!out.ok && !step.check) stepFailure = out.text;
    else if (step.check) {
      try {
        stepFailure = await step.check(out, ctx);
      } catch (err) {
        stepFailure = `check threw: ${err.message}`;
      }
    }

    stepReports.push({
      label: step.label,
      tool,
      badge,
      status: stepFailure ? 'failed' : 'passed',
      ms: out.ms,
      ...(stepFailure ? { reason: stepFailure, sample: out.text.slice(0, 400) } : {}),
    });
    if (stepFailure) {
      failure = `step '${step.label}': ${stepFailure}`;
      break; // later steps assume this one worked
    }
  }

  const status = failure ? 'failed' : 'passed';
  results.push({ ...meta(c), status, ...(failure ? { reason: failure } : {}), ms: totalMs, steps: stepReports });
  console.log(
    `  ${c.id.padEnd(4)} ${status === 'passed' ? 'ok  ' : 'FAIL'}  ${String(Math.round(totalMs)).padStart(5)}ms  ${c.title}`,
  );
  if (failure) console.log(`       └─ ${failure.slice(0, 200)}`);
}

function meta(c) {
  return { id: c.id, family: c.family, title: c.title, tool: c.tool, tenant: c.tenant, badge: c.badge, requires: c.requires ?? null };
}

// ── the date matrix: pure, free, every calendar trap ──────────────────────────
console.log('\n  date matrix (deterministic — injected todayLocal, every weekday):');
const dateCases = buildDateMatrix();
const dateResults = [];
for (const dc of dateCases) {
  const started = performance.now();
  let actual;
  try {
    actual = resolveDate({ todayLocal: todayFor(dc), ...dc.params });
  } catch (err) {
    actual = { status: 'threw', reason: err.message };
  }
  const elapsed = performance.now() - started;
  const reason = gradeDateCase(dc, actual);
  dateResults.push({ id: dc.id, group: dc.group, phrase: dc.phrase, status: reason ? 'failed' : 'passed', reason, ms: elapsed });
}
const byGroup = {};
for (const r of dateResults) {
  byGroup[r.group] ??= { passed: 0, total: 0 };
  byGroup[r.group].total++;
  if (r.status === 'passed') byGroup[r.group].passed++;
}
for (const [group, g] of Object.entries(byGroup)) {
  const failed = g.total - g.passed;
  console.log(`    ${group.padEnd(9)} ${String(g.passed).padStart(3)}/${String(g.total).padEnd(3)} ${failed ? `— ${failed} FAILED` : ''}`);
}

await server.close();
await client.end();

// ── report ───────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.status === 'passed');
const failed = results.filter((r) => r.status === 'failed');
const skipped = results.filter((r) => r.status === 'skipped');
const dateFailed = dateResults.filter((r) => r.status === 'failed');
const ran = passed.length + failed.length;

const latency = [...latencyByTool.entries()]
  .map(([tool, values]) => ({ tool, ...summarise(values) }))
  .sort((a, b) => b.p95 - a.p95);

console.log(`\n  ── tier 1 ──`);
console.log(`  cases     ${passed.length}/${ran} passed (${rate(passed.length, ran)}%)   ${skipped.length} skipped`);
console.log(`  dates     ${dateResults.length - dateFailed.length}/${dateResults.length} passed (${rate(dateResults.length - dateFailed.length, dateResults.length)}%)`);
console.log(`\n  slowest tools by p95:`);
for (const l of latency.slice(0, 12)) {
  console.log(`    ${l.tool.padEnd(28)} n=${String(l.n).padStart(2)}  p50 ${ms(l.p50).padStart(7)}  p95 ${ms(l.p95).padStart(7)}  max ${ms(l.max).padStart(7)}`);
}

const lines = [];
lines.push(`# Spine eval — tier 1 (tool layer)`, '');
lines.push(`- world anchor: **${titleWeekday(world.anchor)} ${world.anchor}** (seed ${world.seed}), built ${world.builtAt}`);
lines.push(`- run at: ${new Date().toISOString()}`);
lines.push(`- external dependencies enabled: ${enabled.size ? [...enabled].join(', ') : '_none_'}`);
lines.push('');
lines.push(`## Verdict`, '');
lines.push(`| | passed | total | rate |`, `|---|---|---|---|`);
lines.push(`| cases | ${passed.length} | ${ran} | ${rate(passed.length, ran)}% |`);
lines.push(`| date matrix | ${dateResults.length - dateFailed.length} | ${dateResults.length} | ${rate(dateResults.length - dateFailed.length, dateResults.length)}% |`);
lines.push('');
if (skipped.length) {
  lines.push(`${skipped.length} case(s) skipped for absent capability — **not** counted as passes:`, '');
  for (const s of skipped) lines.push(`- \`${s.id}\` ${s.title} — ${s.reason}`);
  lines.push('');
}
if (failed.length) {
  lines.push(`## Failures`, '');
  for (const f of failed) {
    lines.push(`### \`${f.id}\` ${f.title}`);
    lines.push(`- tool: \`${f.tool}\`  tenant: \`${f.tenant}\`  badge: \`${f.badge}\``);
    lines.push(`- ${f.reason}`);
    const bad = f.steps.find((s) => s.status === 'failed');
    if (bad?.sample) lines.push('', '```', bad.sample, '```');
    lines.push('');
  }
}
if (dateFailed.length) {
  lines.push(`## Date-matrix failures`, '');
  for (const d of dateFailed.slice(0, 40)) lines.push(`- \`${d.id}\` (${d.phrase}) — ${d.reason}`);
  lines.push('');
}
lines.push(`## Latency by tool`, '');
lines.push(`Serial calls, in-process server over loopback HTTP. This is the tool's own cost —`);
lines.push(`handler plus database — with no model and no network hop in it.`, '');
lines.push(`| tool | n | p50 | p95 | max |`, `|---|---|---|---|---|`);
for (const l of latency) lines.push(`| \`${l.tool}\` | ${l.n} | ${ms(l.p50)} | ${ms(l.p95)} | ${ms(l.max)} |`);
lines.push('');
lines.push(`## Date matrix by mode`, '');
lines.push(`| mode | passed | total |`, `|---|---|---|`);
for (const [group, g] of Object.entries(byGroup)) lines.push(`| ${group} | ${g.passed} | ${g.total} |`);

mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'tier1-results.json'), JSON.stringify({ world: { anchor: world.anchor, seed: world.seed, builtAt: world.builtAt }, ranAt: new Date().toISOString(), enabled: [...enabled], results, dateResults, latency }, null, 2));
writeFileSync(join(DIR, 'tier1-report.md'), lines.join('\n'));
console.log(`\n  report → ${join(DIR, 'tier1-report.md')}`);

if (failed.length || dateFailed.length) {
  console.error(`\n  ${failed.length} case failure(s), ${dateFailed.length} date failure(s).\n`);
  process.exit(1);
}
console.log(`\n  tier 1 green.\n`);
