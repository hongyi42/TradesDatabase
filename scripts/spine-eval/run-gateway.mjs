// Spine-eval TIER 3 — the agent as production actually runs it.
//
//   npm run spine-eval:gateway -- --pilot --yes            # manager scenarios on s6
//   npm run spine-eval:gateway -- --pilot --yes --only D01,B01
//   npm run spine-eval:gateway -- --pilot --yes --deliver  # also exercise reply hooks
//
// WHAT MAKES THIS DIFFERENT FROM TIER 2, and it is only one thing: who runs the
// agent. Tier 2 IS the agent loop — it assembles the doctrine, hands the model a
// tool list, and executes tool calls itself. Tier 3 asks the openclaw GATEWAY to
// run the turn, so the doctrine, the cached tools/list, the tool policy, the
// doorman round trip and the plugin hooks are all the real ones. Same corpus, same
// graders, same metrics — so `tier3 − tier2` per scenario is the cost of the
// machinery tier 2 skips, attributed rather than guessed.
//
// HOW A TURN IS DRIVEN
//   ssh box → nemoclaw s6 exec → openclaw agent --session-id <sid> -m "<text>"
//
// Three things about that line are load-bearing:
//   1. `nemoclaw exec`, NOT `docker exec`. The gateway listens inside a NESTED
//      network namespace; from a plain docker exec nothing is listening at all.
//   2. NO `--local`. That flag selects the embedded agent, which truncates
//      AGENTS.md at 12,000 chars against our 18,477 — measuring a different prompt
//      than production. Verify per run: the gateway log must show
//      `[ws] ⇄ res ✓ agent`, and stdout must NOT contain `[agent/embedded]`.
//   3. `--session-id`, so the transcript has a path we can read back.
//
// NOT `/hooks/agent`: it admits the request and then skips the run. Hook runs go
// through the cron runner, which preflights any provider whose baseUrl is
// loopback/private/`.local` — OpenShell's is `https://inference.local/v1` — with a
// direct DNS lookup, in a namespace that has no public DNS. Tested with
// deliver:false and deliver:true; identical skip. See docs/engineering-memory.md.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { requirePilotStack, argOf, hasFlag } from './lib/env.mjs';
import { buildCorpus, BASELINE_GRADERS, calendarCoverageNote } from '../../dist/eval/corpus.js';
import { runGraders } from '../../dist/eval/graders.js';
import { parseSessionJsonl } from '../../dist/eval/trajectory.js';
import { tenantOf } from '../../dist/eval/worldManifest.js';
import { percentile, summarise, ms as fmtMs } from '../../dist/eval/metrics.js';
import { titleWeekday } from '../../dist/eval/clock.js';

const HOST = argOf('host', 'tradesbox');
const AGENT = argOf('sandbox', 's6');
const OUT_DIR = argOf('out', join(process.cwd(), 'spine-eval-runs'));
const TURN_TIMEOUT = Number(argOf('turn-timeout', '600')) * 1000;
const ONLY = (argOf('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const DELIVER = hasFlag('deliver');
const REPLY_TO = argOf('reply-to', '');

// --deliver without a target fails BEFORE the run, per scenario, with
// `GatewayClientRequestError: Delivering to Telegram requires target <chatId>`
// — which the driver can only report as "no transcript", i.e. 38 harness
// failures that look like the agent broke. Refuse up front instead: the whole
// point of --deliver is the channel leg, and there is no channel leg without a
// recipient.
if (DELIVER && !REPLY_TO) {
  console.error(
    `\nREFUSING TO RUN: --deliver needs --reply-to <chatId>.\n\n` +
      `  --deliver exercises the CHANNEL leg (and with it the outbound plugin hooks —\n` +
      `  this is the only way the weekday guard can fire). openclaw rejects a delivery\n` +
      `  with a channel but no target before the turn even starts, so every scenario\n` +
      `  would fail with an empty transcript.\n\n` +
      `  Get a chat id by starting the ${AGENT} bot from Telegram, or by adding it to a\n` +
      `  group (group ids look like -100…), then:\n\n` +
      `    npm run spine-eval:gateway -- --pilot --yes --deliver --reply-to <chatId>\n`,
  );
  process.exit(1);
}

console.log('\n=== SPINE EVAL — TIER 3 (the real gateway) ===');
const { dbUrl } = requirePilotStack();

if (!hasFlag('yes')) {
  console.error(
    `\nREFUSING TO RUN: tier 3 spends real model budget on the live box and appends\n` +
      `  permanent L1 rows to the pilot. Add --yes when you mean it.\n`,
  );
  process.exit(1);
}

// ── the world ─────────────────────────────────────────────────────────────────
const worldPath = join(OUT_DIR, 'world.pilot.json');
if (!existsSync(worldPath)) {
  console.error(`\nREFUSING TO RUN: no pilot world at ${worldPath}.\n  Build it:  npm run spine-eval:world -- --pilot --yes\n`);
  process.exit(1);
}
const world = JSON.parse(readFileSync(worldPath, 'utf8'));
console.log(`  world:    ${titleWeekday(world.anchor)} ${world.anchor} (seed ${world.seed})`);
console.log(`  sandbox:  ${AGENT} on ${HOST}${DELIVER ? '  (--deliver: replies go out through the channel)' : ''}`);

// ── the identity the sandbox actually holds ───────────────────────────────────
// s6's badge is minted for ONE (tenant, ref) pair, so tier 3 can only act as that
// person. Scenarios written for anyone else are SKIPPED BY NAME — never silently
// counted as passes, which would turn missing coverage into a green number.
const BADGE_TENANT = argOf('tenant-key', 'main');
const BADGE_REF = argOf('badge', 'manager-sam');
const tenant = tenantOf(world, BADGE_TENANT);
console.log(`  identity: ${BADGE_REF} @ ${tenant.name} (${tenant.id})`);

const ssh = (cmd, timeout = TURN_TIMEOUT) =>
  spawnSync('ssh', [HOST, cmd], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });

/**
 * Single-quote a string for ONE level of shell.
 *
 * There are three shells between here and the agent (the remote login shell, then
 * `nemoclaw exec`, then `bash -lc`), and getting this wrong is silent: the first
 * attempt used JSON.stringify, so the REMOTE shell expanded `$MSG` before nemoclaw
 * ever saw it and the agent was asked an empty question. It did not error — it
 * just produced no transcript, which read as "the run was skipped".
 */
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** openshell prints colour; a regex over raw bytes matches the escape, not the value. */
const stripAnsi = (s) => String(s).replace(/\[[0-9;]*m/g, '');

/** The fleet's live inference route. A flip mid-run invalidates every latency. */
function currentRoute() {
  const r = ssh(`export PATH=$HOME/.local/bin:$PATH; openshell inference get -g nemoclaw 2>&1`, 60_000);
  const out = stripAnsi(r.stdout ?? '');
  const provider = /Provider:\s*(\S+)/.exec(out)?.[1] ?? 'unknown';
  const model = /Model:\s*(\S+)/.exec(out)?.[1] ?? 'unknown';
  return { provider, model };
}

const startRoute = currentRoute();
console.log(`  model:    ${startRoute.model} @ ${startRoute.provider}`);

// ── scenario selection ────────────────────────────────────────────────────────
const all = buildCorpus();
const runnable = [];
const skipped = [];
for (const s of all) {
  if (ONLY.length && !ONLY.includes(s.id)) continue;
  if (s.tenant !== BADGE_TENANT) {
    skipped.push({ id: s.id, why: `needs tenant '${s.tenant}', s6 holds '${BADGE_TENANT}'` });
  } else if (s.badge !== BADGE_REF) {
    skipped.push({ id: s.id, why: `needs badge '${s.badge}' (${s.tier}), s6 holds '${BADGE_REF}'` });
  } else {
    runnable.push(s);
  }
}
console.log(`  corpus:   ${runnable.length} runnable, ${skipped.length} skipped for identity`);
console.log(`  ${calendarCoverageNote(world.anchor)}`);
if (!runnable.length) {
  console.error('\n  Nothing to run.\n');
  process.exit(1);
}

// ── db (reads only; end-state checks) ─────────────────────────────────────────
const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
const sql = async (text, params) => (await pool.query(text, params)).rows;

// ── one scenario ──────────────────────────────────────────────────────────────
const TRAJ_DIR = join(OUT_DIR, 'tier3-trajectories');
mkdirSync(TRAJ_DIR, { recursive: true });

async function runScenario(scenario) {
  const ctx = { world, tenant, anchor: world.anchor };
  const turnTexts = scenario.turns(ctx);
  // Fresh session id per scenario per run: a reused id would carry the previous
  // run's context and quietly make scenario 12 depend on scenario 11.
  const sid = `spineval-${world.anchor}-${scenario.id}-${Date.now().toString(36)}`;

  const wallStart = performance.now();
  const turnWalls = [];
  let fatal = null;
  let embedded = false;

  let lastOut = '';
  for (const text of turnTexts) {
    // base64 through, so no scenario text can be mangled by three layers of shell,
    // and the decode happens in the INNERMOST shell — `sq` keeps the outer ones
    // from touching it.
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const inner =
      `export PATH=$HOME/.local/bin:$PATH; ` +
      `openclaw agent --agent main --session-id ${sid} ` +
      (DELIVER ? `--deliver --reply-channel telegram --reply-to ${sq(REPLY_TO)} ` : '') +
      `-m "$(echo ${b64} | base64 -d)"`;
    const cmd = `export PATH=$HOME/.local/bin:$PATH; nemoclaw ${AGENT} exec --no-tty -- bash -lc ${sq(inner)} </dev/null 2>&1`;

    const t0 = performance.now();
    const r = ssh(cmd);
    turnWalls.push(performance.now() - t0);
    const out = r.stdout ?? '';
    lastOut = out;

    // The recorded trap: if the gateway connection fails, the CLI falls back to the
    // EMBEDDED agent, which truncates AGENTS.md. That measures a different prompt,
    // so it is a harness failure, not an agent result.
    if (/\[agent\/embedded\]/.test(out) || /truncating/i.test(out)) embedded = true;
    if (r.status !== 0 && !out.trim()) {
      fatal = `openclaw agent exited ${r.status}${r.error ? ` (${r.error.message})` : ''}`;
      break;
    }
  }

  // ── read the transcript back ──
  const catCmd =
    `export PATH=$HOME/.local/bin:$PATH; nemoclaw ${AGENT} exec --no-tty -- ` +
    `bash -lc ${sq(`cat /sandbox/.openclaw/agents/main/sessions/${sid}.jsonl`)} </dev/null 2>/dev/null`;
  const raw = (ssh(catCmd, 120_000).stdout ?? '')
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .join('\n');

  if (raw.trim()) writeFileSync(join(TRAJ_DIR, `${scenario.id}.jsonl`), raw);
  else if (!fatal) {
    // Include what the CLI actually said. Without it this reads as "the run was
    // skipped" for any cause at all — including an empty message caused by the
    // harness's own quoting, which is exactly what happened the first time.
    const tail = lastOut.split('\n').filter((l) => l.trim() && !/UNDICI|trace-warnings/.test(l)).slice(-4).join(' | ');
    fatal = `no transcript at sessions/${sid}.jsonl — CLI said: ${tail.slice(0, 400) || '(nothing)'}`;
  }

  const traj = parseSessionJsonl(raw);
  // The driver knows the real turn boundaries; the parser only sees timestamps.
  traj.turns.forEach((t, i) => {
    t.wallMs = turnWalls[i] ?? 0;
  });
  if (embedded && !fatal) fatal = 'the CLI fell back to the EMBEDDED agent (AGENTS.md truncated) — not a gateway measurement';

  const findings = fatal
    ? [{ kind: 'harness-or-provider-failure', detail: fatal }]
    : runGraders(traj, [...BASELINE_GRADERS, ...(scenario.graders?.(ctx) ?? [])]);

  let endState = null;
  if (scenario.endState && !fatal) {
    const { text, params } = scenario.endState.query(ctx);
    try {
      const rows = await sql(text, params);
      const passed = scenario.endState.predicate(rows);
      endState = { describe: scenario.endState.describe, passed, rows: JSON.stringify(rows).slice(0, 300) };
      if (!passed) findings.push({ kind: 'end-state', detail: `${scenario.endState.describe} — database says ${endState.rows}` });
    } catch (err) {
      endState = { describe: scenario.endState.describe, passed: false, rows: `query failed: ${err.message}` };
      findings.push({ kind: 'end-state-query', detail: `end-state query failed: ${err.message}` });
    }
  }

  return {
    id: scenario.id,
    family: scenario.family,
    title: scenario.title,
    sessionId: sid,
    status: findings.length === 0 ? 'passed' : 'failed',
    findings,
    endState,
    metrics: {
      turns: traj.turns.length,
      calls: traj.calls.length,
      // Wall as the DRIVER saw it (includes ssh + CLI boot) and as the TRANSCRIPT
      // saw it (the turn itself). The difference is harness overhead and must not
      // be reported as the gateway's cost.
      driverWallMs: performance.now() - wallStart,
      turnWallMs: traj.wallMs,
      modelMs: traj.modelMs,
      toolMs: traj.toolMs,
      tokens: traj.tokens,
      stopReasons: traj.stopReasons,
      danglingCalls: traj.danglingCalls,
    },
    tools: traj.calls.map((c) => ({ tool: c.tool, ms: c.ms, isError: c.isError })),
    reply: traj.finalText.slice(0, 4000),
  };
}

// ── run, serially ─────────────────────────────────────────────────────────────
// Serial by design: parallel runs would share one gateway and one inference
// budget, so their latencies would measure contention rather than the agent.
const results = [];
console.log('');
for (const scenario of runnable) {
  const r = await runScenario(scenario);
  results.push(r);
  const flag = r.status === 'passed' ? 'ok  ' : 'FAIL';
  console.log(
    `  ${r.id.padEnd(6)} ${flag} ${fmtMs(r.metrics.turnWallMs).padStart(7)} ` +
      `(model ${fmtMs(r.metrics.modelMs)}, tools ${fmtMs(r.metrics.toolMs)}, ${r.metrics.calls} calls)  ${r.title}`,
  );
  for (const f of r.findings) console.log(`          └─ ${f.kind}: ${f.detail.slice(0, 150)}`);

  const route = currentRoute();
  if (route.provider !== startRoute.provider || route.model !== startRoute.model) {
    console.error(`\n  STOPPED — the fleet failed over mid-run (${startRoute.provider}/${startRoute.model} → ${route.provider}/${route.model}).`);
    console.error(`  Results so far are valid; nothing after this point would be. Check the Fireworks balance first (docs/inference-recovery-runbook.md).\n`);
    break;
  }
}

// ── report ────────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.status === 'passed');
const wall = summarise(results.map((r) => r.metrics.turnWallMs));
const model = summarise(results.map((r) => r.metrics.modelMs));
const tool = summarise(results.map((r) => r.metrics.toolMs));
const overhead = summarise(results.map((r) => r.metrics.driverWallMs - r.metrics.turnWallMs));
const totalModel = results.reduce((n, r) => n + r.metrics.modelMs, 0);
const totalTool = results.reduce((n, r) => n + r.metrics.toolMs, 0);

console.log(`\n  ── tier 3 ──`);
console.log(`  scenarios  ${passed.length}/${results.length} passed (${((passed.length / Math.max(1, results.length)) * 100).toFixed(1)}%)`);
console.log(`  latency    turn p50 ${fmtMs(wall.p50)}  p95 ${fmtMs(wall.p95)}`);
console.log(`             model p50 ${fmtMs(model.p50)}  tools p50 ${fmtMs(tool.p50)}`);
if (totalModel + totalTool > 0) {
  console.log(`             the model is ${((totalModel / (totalModel + totalTool)) * 100).toFixed(1)}% of a turn; the spine tools are the rest`);
}
console.log(`  harness    ssh + CLI boot p50 ${fmtMs(overhead.p50)} (EXCLUDED from the numbers above)`);

const perTool = new Map();
for (const r of results) for (const t of r.tools) {
  if (!perTool.has(t.tool)) perTool.set(t.tool, []);
  perTool.get(t.tool).push(t.ms);
}
if (perTool.size) {
  console.log(`\n  per-tool latency THROUGH the doorman (tier 1 measures these in-process):`);
  const rows = [...perTool.entries()].map(([tool, xs]) => ({ tool, n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95) }));
  rows.sort((a, b) => b.p95 - a.p95);
  for (const row of rows.slice(0, 12)) {
    console.log(`    ${row.tool.padEnd(28)} n=${String(row.n).padStart(2)}  p50 ${fmtMs(row.p50).padStart(7)}  p95 ${fmtMs(row.p95).padStart(7)}`);
  }
}

const byKind = {};
for (const r of results) if (r.status !== 'passed') for (const f of r.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
if (Object.keys(byKind).length) {
  console.log(`\n  findings by kind:`);
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(32)} ${n}`);
}

if (skipped.length) {
  console.log(`\n  skipped for identity (${skipped.length}) — s6 holds ONE badge, so one tier:`);
  for (const s of skipped.slice(0, 8)) console.log(`    ${s.id.padEnd(6)} ${s.why}`);
  if (skipped.length > 8) console.log(`    … and ${skipped.length - 8} more`);
}

const out = {
  ranAt: new Date().toISOString(),
  tier: 3,
  sandbox: AGENT,
  identity: { ref: BADGE_REF, tenant: tenant.name, tenantId: tenant.id },
  anchor: world.anchor,
  seed: world.seed,
  route: startRoute,
  deliver: DELIVER,
  passRate: Number(((passed.length / Math.max(1, results.length)) * 100).toFixed(1)),
  latency: { wall, model, tool, harnessOverhead: overhead },
  findingKinds: byKind,
  skippedForIdentity: skipped,
  results,
};
writeFileSync(join(OUT_DIR, 'tier3-report.json'), JSON.stringify(out, null, 2));
console.log(`\n  report → ${join(OUT_DIR, 'tier3-report.json')}`);
console.log(`  trajectories → ${TRAJ_DIR}\n`);

await pool.end();
process.exit(results.length && passed.length === results.length ? 0 : 1);
