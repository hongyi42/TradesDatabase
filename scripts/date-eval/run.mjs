// Date-eval STEP 2 of 3 — run. THIS IS THE STEP THAT SPENDS MONEY.
//
// Drives trades-box-1 over ssh: one embedded-agent turn per question, each in
// a fresh throwaway session id, and pulls the session trajectory back after
// every turn. The trajectory — tool calls, their arguments, their results,
// per-message timestamps — is what makes phase attribution possible; the final
// text alone can only ever say "wrong", never "wrong where".
//
//   node scripts/date-eval/run.mjs --dir <run-dir> --yes
//
// GATES, both deliberate:
//   1. --yes is required. A full corpus is ~40 minutes of live model calls
//      against the pilot; it should never start because a command was
//      pasted twice.
//   2. The model is checked BEFORE the first question and again after EVERY
//      question. If the fleet fails over mid-run (DeepInfra runs out of
//      balance roughly monthly and NOTHING alerts on it), the run STOPS on the
//      spot and says so. A run spanning two providers measures neither: the
//      2026-07-31 latency A/B was ruined exactly this way.
//
// Resumable: answered ids are skipped, so an aborted run continues with
// --yes after the provider is fixed. Read-only by construction — every
// question is phrased as a question, and any write tool that shows up in a
// trajectory is reported as a finding by analyze.mjs.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const DIR = argOf('dir', join(process.cwd(), 'date-eval-runs', 'pending'));
const HOST = argOf('host', 'tradesbox');
const LIMIT = Number(argOf('limit', '0')); // 0 = all; a small number smoke-tests the wiring
const manifestPath = join(DIR, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`No manifest at ${manifestPath}. Run:  npm run date-eval:plan`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const questions = LIMIT > 0 ? manifest.questions.slice(0, LIMIT) : manifest.questions;

const ssh = (cmd, timeout = 300_000) =>
  spawnSync('ssh', [HOST, cmd], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });

const RESULTS = join(DIR, 'results.jsonl');
const TRAJ_DIR = join(DIR, 'trajectories');
mkdirSync(TRAJ_DIR, { recursive: true });
const done = new Set();
if (existsSync(RESULTS)) {
  for (const line of readFileSync(RESULTS, 'utf8').split('\n')) {
    if (line.trim()) try { done.add(JSON.parse(line).id); } catch {}
  }
}

/** Fleet inference route, as the gateway reports it right now. */
function currentRoute() {
  const r = ssh('export PATH=$HOME/.local/bin:$PATH; openshell inference get 2>&1', 30_000);
  const txt = r.stdout ?? '';
  return {
    provider: (txt.match(/Provider:\s*(\S+)/) || [])[1] ?? 'unknown',
    model: (txt.match(/Model:\s*(\S+)/) || [])[1] ?? 'unknown',
  };
}

const remaining = questions.filter((q) => !done.has(q.id));
console.log(`\n=== DATE EVAL — RUN ===`);
console.log(`  ${remaining.length} questions to ask (${done.size} already answered)   host: ${HOST}   sandbox: ${manifest.sandbox}`);
console.log(`  today baked into the truth: ${manifest.today}`);

// ── gate 1: explicit confirmation ──
if (!has('yes')) {
  console.log(`\n  This run makes ${remaining.length} live model calls (~${Math.round((remaining.length * 25) / 60)} min, ~$${(remaining.length * 0.012).toFixed(2)}).`);
  console.log(`  Nothing has run. Re-run with --yes to start:\n`);
  console.log(`    npm run date-eval:run -- --dir ${DIR} --yes\n`);
  process.exit(0);
}

// ── gate 2: the model must be the one we mean to measure ──
const startRoute = currentRoute();
console.log(`  route at start: ${startRoute.provider} / ${startRoute.model}`);
if (manifest.expectedModel && startRoute.model !== manifest.expectedModel) {
  console.error(`\nREFUSING TO RUN: fleet is on ${startRoute.model}, manifest expects ${manifest.expectedModel}.`);
  console.error(`Either point the fleet at the intended model, or re-plan with DATE_EVAL_EXPECT_MODEL=${startRoute.model}.`);
  process.exit(1);
}
if (manifest.today !== ssh(`date -u +%F`).stdout?.trim() && !has('allow-stale')) {
  // Not fatal on its own — the box clock is UTC and the firm is not — but a
  // manifest built on a different DAY grades against yesterday's schedule.
  const planned = new Date(`${manifest.today}T12:00:00Z`).getTime();
  const drift = Math.abs(Date.now() - planned) / 86_400_000;
  if (drift > 1.5) {
    console.error(`\nREFUSING TO RUN: manifest was planned for ${manifest.today}, which is ${drift.toFixed(1)} days off. Re-plan.`);
    process.exit(1);
  }
}

const CID_CMD = `docker ps --format '{{.Names}}' | grep '^openshell-${manifest.sandbox}-'`;
const cid = ssh(CID_CMD, 30_000).stdout?.trim();
if (!cid) { console.error(`Could not find the ${manifest.sandbox} container on ${HOST}.`); process.exit(1); }
console.log(`  container: ${cid}\n`);

writeFileSync(join(DIR, 'run-context.json'), JSON.stringify({ startedAt: new Date().toISOString(), startRoute, cid, host: HOST }, null, 2));

let asked = 0;
for (const item of remaining) {
  const sid = `dateval-${manifest.today}-${item.id}`;
  const b64 = Buffer.from(item.q, 'utf8').toString('base64');
  // base64 in, so no question text can ever be mangled by two layers of shell
  // quoting; </dev/null because `nemoclaw exec` eats stdin in heredocs.
  const cmd = `export PATH=$HOME/.local/bin:$PATH; MSG=$(echo '${b64}' | base64 -d); nemoclaw ${manifest.sandbox} agent --agent main --session-id ${sid} -m "$MSG" </dev/null 2>&1`;
  const t0 = Date.now();
  const r = ssh(cmd);
  const wallMs = Date.now() - t0;
  const raw = r.stdout ?? '';
  const reply = raw
    .split('\n')
    .filter((l) => !/^\(node:|^\(Use `node|^\[plugins\]|UNDICI-EHPA|^\[agent\/embedded\]/.test(l))
    .join('\n')
    .trim();
  // The recorded CLI trap: the embedded agent truncates AGENTS.md. If it says
  // so, the run is measuring a DIFFERENT prompt than production and the report
  // must say that rather than quietly compare the two.
  const truncated = /truncat/i.test(raw);

  // Pull the trajectory — the evidence phase attribution is computed from.
  const traj = ssh(`docker exec ${cid} sh -c "cat /sandbox/.openclaw/agents/main/sessions/${sid}.jsonl" 2>/dev/null`, 60_000).stdout ?? '';
  if (traj.trim()) writeFileSync(join(TRAJ_DIR, `${item.id}.jsonl`), traj);

  appendFileSync(RESULTS, JSON.stringify({
    id: item.id, cat: item.cat, phases: item.phases, q: item.q,
    reply, wallMs, exit: r.status, sessionId: sid,
    agentsMdTruncated: truncated, hasTrajectory: !!traj.trim(),
    at: new Date().toISOString(),
  }) + '\n');

  asked++;
  console.log(`  ${item.id.padEnd(5)} ${String(wallMs).padStart(6)}ms  ${reply.slice(0, 72).replaceAll('\n', ' ')}`);

  // ── failover watch: stop the moment the route moves ──
  const route = currentRoute();
  if (route.provider !== startRoute.provider || route.model !== startRoute.model) {
    console.error(`\n╔══════════════════════════════════════════════════════════════════╗`);
    console.error(`║  STOPPED — THE FLEET FAILED OVER MID-RUN                         ║`);
    console.error(`╚══════════════════════════════════════════════════════════════════╝`);
    console.error(`  was: ${startRoute.provider} / ${startRoute.model}`);
    console.error(`  now: ${route.provider} / ${route.model}`);
    console.error(`  after ${asked} question(s); last completed: ${item.id}`);
    console.error(`\n  Results so far are kept and are still valid — they were all asked`);
    console.error(`  on ${startRoute.model}. Nothing after this point would be.`);
    console.error(`\n  Most likely cause: the DeepInfra balance ran out (HTTP 402). Check it`);
    console.error(`  first — the medic fails the fleet over silently and nothing alerts.`);
    console.error(`  Once the route is back, resume with the SAME command (answered`);
    console.error(`  questions are skipped):`);
    console.error(`    npm run date-eval:run -- --dir ${DIR} --yes\n`);
    appendFileSync(RESULTS, JSON.stringify({ id: 'ABORT-FAILOVER', was: startRoute, now: route, afterQuestion: item.id, at: new Date().toISOString() }) + '\n');
    process.exit(2);
  }
}

const endRoute = currentRoute();
console.log(`\n  route at end: ${endRoute.provider} / ${endRoute.model}   (unchanged)`);
console.log(`  ${asked} questions asked. Artifacts in ${DIR}`);
console.log(`\n  NEXT:  npm run date-eval:report -- --dir ${DIR}\n`);
