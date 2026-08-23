// Date-eval STEP 2 of 3 — run. THIS IS THE STEP THAT SPENDS MONEY.
//
// Drives trades-box-1 over ssh: one embedded-agent turn per question, each in
// a fresh throwaway session id, and pulls the session trajectory back after
// every turn. The trajectory — tool calls, their arguments, their results,
// per-message timestamps — is what makes phase attribution possible; the final
// text alone can only ever say "wrong", never "wrong where".
//
//   node scripts/date-eval/run.mjs --dir <run-dir> --yes
//   node scripts/date-eval/run.mjs --dir <run-dir> --yes --deliver   # phase 4 LIVE
//
// --deliver (opt-in, off by default) makes phase 4 OBSERVED instead of replayed.
// Without it the CLI never sends a reply, so no outbound hook fires and
// analyze.mjs can only re-run the guard's scanMessage offline — that measures
// the DETECTOR but can never tell you the hook is wired up. With it, the real
// `message_sending` hook runs inside the sandbox and writes its verdict to
// /sandbox/.openclaw/logs/weekday-guard.jsonl, which this script pulls per
// question into `guardLive`.
//
// It delivers to a DEAD Telegram target (chat id 1) on purpose. The hook fires
// BEFORE the send, so the guard scans the real reply text and logs a real
// verdict, and the send then fails with `chat not found` — nobody is messaged.
// Verified 2026-08-12: a failed send still produced
// {"hook":"message_sending","v":"0.3.0",...}. This matters because the default
// eval sandbox is s2 (manager-sam = the operator's own Telegram): a 94-question
// corpus delivering for real would fire 94 messages at a person. Override with
// --reply-to <chatId> only if you actually want them sent somewhere.
//
// The reply is read from the session TRAJECTORY, not stdout (stdout is kept as
// `stdoutReply` for diagnostics). A failed delivery replaces stdout with the
// error, and separately the sandbox CLI now prints a `◇ Config warnings` box
// that the old line-filter did not strip — either one silently becomes "the
// model's answer" if stdout is graded. The trajectory carries the assistant's
// text and nothing else.
//
// GATES, both deliberate:
//   1. --yes is required. A full corpus is ~40 minutes of live model calls
//      against the pilot; it should never start because a command was
//      pasted twice.
//   2. The model is checked BEFORE the first question and again after EVERY
//      question. If the route changes mid-run (a balance-out or suspension —
//      since 2026-08-19 the ops notifier DOES alert on this, see
//      docs/inference-recovery-runbook.md), the run STOPS on the spot and says so. A run spanning two providers measures neither: the
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
const DELIVER = has('deliver');
// Dead by default — see the header. A real chat id here MESSAGES A REAL PERSON,
// once per question.
const REPLY_TO = argOf('reply-to', '1');
const GUARD_LOG = '/sandbox/.openclaw/logs/weekday-guard.jsonl';
const manifestPath = join(DIR, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`No manifest at ${manifestPath}. Run:  npm run date-eval:plan`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const questions = LIMIT > 0 ? manifest.questions.slice(0, LIMIT) : manifest.questions;

const ssh = (cmd, timeout = 300_000) =>
  spawnSync('ssh', [HOST, cmd], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });

// Session ids must be unique PER RUN, not per day (found 2026-08-13): with
// sid = dateval-<today>-<qid>, a same-day re-run resumed the morning's
// sessions and every reply came back "same answer as before" — a continuation
// of the OLD conversation (old question phrasing included), not a fresh ask.
// The nonce persists in the run dir so an aborted run RESUMES the same id
// space while a new dir always gets fresh sessions.
const RUNID_FILE = join(DIR, '.runid');
if (!existsSync(RUNID_FILE)) {
  writeFileSync(RUNID_FILE, Math.random().toString(16).slice(2, 8));
}
const RUNID = readFileSync(RUNID_FILE, 'utf8').trim();

const RESULTS = join(DIR, 'results.jsonl');
const TRAJ_DIR = join(DIR, 'trajectories');
mkdirSync(TRAJ_DIR, { recursive: true });
const done = new Set();
if (existsSync(RESULTS)) {
  for (const line of readFileSync(RESULTS, 'utf8').split('\n')) {
    if (line.trim()) try { done.add(JSON.parse(line).id); } catch {}
  }
}

/**
 * Last assistant text in a session trajectory. In --deliver mode a failed send
 * means the CLI prints the delivery error instead of the reply, so stdout cannot
 * be the answer source; the trajectory still carries what the model actually
 * said.
 */
function replyFromTrajectory(traj) {
  let last = null;
  for (const line of traj.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o?.message?.role !== 'assistant') continue;
      const txt = (o.message.content ?? [])
        .filter((c) => c?.type === 'text')
        .map((c) => c.text)
        .join('')
        .trim();
      if (txt) last = txt;
    } catch {
      /* a partial trailing line is normal while the agent is still writing */
    }
  }
  return last;
}

/** Lines currently in the sandbox's guard log — the offset a per-question delta reads from. */
function guardLogLines(cid) {
  const r = ssh(`docker exec ${cid} sh -c "wc -l < ${GUARD_LOG} 2>/dev/null || echo 0"`, 30_000);
  return Number((r.stdout ?? '0').trim()) || 0;
}

/** Guard records written since `from` — the REAL hook verdict for one question. */
function guardLogSince(cid, from) {
  const r = ssh(`docker exec ${cid} sh -c "tail -n +${from + 1} ${GUARD_LOG} 2>/dev/null"`, 30_000);
  return (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { unparseable: l.slice(0, 200) };
      }
    });
}

// `openshell inference get` colourises even when stdout is not a TTY, so its
// labels arrive as `<esc>[2mProvider:<esc>[0m deepinfra-prod`. `\S+` then
// happily captures the escape sequence and every route reads back as "[0m" —
// which silently defeats BOTH gates below: the expected-model check compares
// garbage to a real id, and the failover watch compares garbage to garbage and
// can never fire. Strip the codes before matching. (Built from charCode 27 so
// there is no control character in this file.)
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Fleet inference route, as the gateway reports it right now. */
function currentRoute() {
  const r = ssh('export PATH=$HOME/.local/bin:$PATH; openshell inference get 2>&1', 30_000);
  const txt = (r.stdout ?? '').replace(ANSI, '');
  return {
    provider: (txt.match(/Provider:\s*(\S+)/) || [])[1] ?? 'unknown',
    model: (txt.match(/Model:\s*(\S+)/) || [])[1] ?? 'unknown',
  };
}

const remaining = questions.filter((q) => !done.has(q.id));
console.log(`\n=== DATE EVAL — RUN ===`);
console.log(`  ${remaining.length} questions to ask (${done.size} already answered)   host: ${HOST}   sandbox: ${manifest.sandbox}`);
console.log(`  today baked into the truth: ${manifest.today}`);
if (DELIVER) {
  const live = REPLY_TO !== '1';
  console.log(`  phase 4: LIVE — real outbound hook, delivering to telegram:${REPLY_TO}`);
  console.log(live
    ? `  ** ${REPLY_TO} IS A REAL TARGET: this will send ${remaining.length} Telegram messages to it. **`
    : `  (dead target: the hook fires and the guard scans, then the send fails — nobody is messaged)`);
} else {
  console.log(`  phase 4: replayed offline (pass --deliver to fire the real hook)`);
}

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
if (manifest.anchor) {
  // Anchored run: the manifest's day deliberately differs from the wall
  // clock — the spine serves it via EVAL_FAKE_NOW (tenant-scoped,
  // src/evalClock.ts). The harness cannot see Render's env, so the one check
  // it can make is that the OPERATOR looked: an unanchored spine mis-grades
  // every question, exactly the failure the staleness gate below exists for.
  console.log(`  ANCHORED RUN: graded day is ${manifest.today} (anchor ${manifest.anchor}), wall UTC is ${new Date().toISOString()}.`);
  if (!has('anchored')) {
    console.error(`\nREFUSING TO RUN: this manifest is anchored. Verify the spine env holds`);
    console.error(`    EVAL_FAKE_NOW=${manifest.tenantId}:${manifest.anchor}`);
    console.error(`(read it back from Render — do not trust memory), then re-run with --anchored.`);
    process.exit(1);
  }
} else if (manifest.today !== ssh(`date -u +%F`).stdout?.trim() && !has('allow-stale')) {
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
  // --clock-line (bare-clock arm, 2026-08-23): state the firm's clock IN the
  // question, one neutral factual line, no doctrine. The rider only rides on
  // spine tool results, so a pure date question in the bare arm otherwise
  // reaches the model with NO clock at all — and it resourcefully consults
  // the sandbox's real UTC clock instead (measured: exec `date`), which in an
  // ANCHORED run is a different world. "All we give is the current time"
  // requires actually giving it.
  const clockPrefix = has('clock-line')
    ? `(the firm's clock reads ${new Date(`${manifest.today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} — timezone ${manifest.timezone})  `
    : '';
  const b64 = Buffer.from(clockPrefix + item.q, 'utf8').toString('base64');
  // base64 in, so no question text can ever be mangled by two layers of shell
  // quoting; </dev/null because `nemoclaw exec` eats stdin in heredocs.
  const deliverFlags = DELIVER ? ` --deliver --reply-to ${REPLY_TO}` : '';
  const guardBefore = DELIVER ? guardLogLines(cid) : 0;
  // Dead-turn retry: ONE fresh attempt when a turn produces no assistant text
  // (v6 T05, 2026-08-15: a mid-stream provider blip killed the reply mid-
  // sentence and cost the run; the eval measures the agent, not one stream
  // hiccup — the spine-eval harness retries empty completions for the same
  // reason). Fresh session id so the retry can never resume a poisoned
  // session. A retry that ALSO dies stands as the dead turn it is.
  let sid, r, wallMs, raw, traj, trajReplyAttempt, retried = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    sid = `dateval-${manifest.today}-${RUNID}-${item.id}${attempt > 1 ? '-r2' : ''}`;
    const cmd = `export PATH=$HOME/.local/bin:$PATH; MSG=$(echo '${b64}' | base64 -d); nemoclaw ${manifest.sandbox} agent --agent main --session-id ${sid} -m "$MSG"${deliverFlags} </dev/null 2>&1`;
    const t0 = Date.now();
    r = ssh(cmd);
    wallMs = Date.now() - t0;
    raw = r.stdout ?? '';
    traj = ssh(`docker exec ${cid} sh -c "cat /sandbox/.openclaw/agents/main/sessions/${sid}.jsonl" 2>/dev/null`, 60_000).stdout ?? '';
    trajReplyAttempt = traj.trim() ? replyFromTrajectory(traj) : null;
    if (trajReplyAttempt) break;
    if (attempt === 1) {
      retried = true;
      console.error(`    ! ${item.id}: dead turn (no assistant text) — retrying once with a fresh session`);
    }
  }
  const stdoutReply = raw
    .split('\n')
    .filter((l) => !/^\(node:|^\(Use `node|^\[plugins\]|UNDICI-EHPA|^\[agent\/embedded\]/.test(l))
    .join('\n')
    .trim();
  // The recorded CLI trap: the embedded agent truncates AGENTS.md. If it says
  // so, the run is measuring a DIFFERENT prompt than production and the report
  // must say that rather than quietly compare the two.
  const truncated = /truncat/i.test(raw);

  // The trajectory (pulled inside the attempt loop above) is the ONLY answer
  // source. Two independent reasons, both observed live on 2026-08-12:
  //  - with --deliver, a failed send makes the CLI print the DELIVERY ERROR
  //    instead of the reply, so stdout would be graded as the model's answer;
  //  - even without it, the sandboxes started emitting a `◇ Config warnings`
  //    box that the stdout line-filter above does not strip, and it lands at
  //    the FRONT of the reply. The stdout path silently rots as the CLI's
  //    chrome changes, and a filter list can only ever chase it.
  // The trajectory carries exactly the assistant's text and nothing else.
  if (traj.trim()) writeFileSync(join(TRAJ_DIR, `${item.id}.jsonl`), traj);
  const trajReply = trajReplyAttempt;
  // NEVER grade stdout. The fallback existed for salvage, but v5 (2026-08-15,
  // provider suspension mid-run) proved its failure mode: 14 dead turns were
  // graded against the CLI's config-warning chrome — noise that can even
  // contain a passing number by luck. A turn with no assistant text in its
  // trajectory produced NO reply; record that honestly (empty reply = the
  // grader fails it loudly) and keep stdout in stdoutReply for diagnosis only.
  const reply = trajReply ?? '';
  const guardLive = DELIVER ? guardLogSince(cid, guardBefore) : null;

  appendFileSync(RESULTS, JSON.stringify({
    id: item.id, cat: item.cat, phases: item.phases, q: item.q,
    reply, wallMs, exit: r.status, sessionId: sid,
    agentsMdTruncated: truncated, hasTrajectory: !!traj.trim(),
    replySource: trajReply ? 'trajectory' : 'dead-turn', stdoutReply, ...(retried ? { retried: true } : {}),
    ...(DELIVER ? { delivered: true, replyTo: REPLY_TO, guardLive } : {}),
    at: new Date().toISOString(),
  }) + '\n');

  asked++;
  const guardNote = DELIVER
    ? guardLive.length
      ? `  [guard ${guardLive.length}: ${guardLive.flatMap((g) => g.flags ?? []).length} flag(s)]`
      : '  [guard SILENT]'
    : '';
  console.log(`  ${item.id.padEnd(5)} ${String(wallMs).padStart(6)}ms  ${reply.slice(0, 60).replaceAll('\n', ' ')}${guardNote}`);
  if (!trajReply) {
    console.error(`    ! ${item.id}: DEAD TURN — no assistant text in the trajectory. Recorded as an empty reply (grades as a fail); stdout kept in stdoutReply for diagnosis. Check ${sid}.`);
  }

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
    console.error(`\n  Most likely cause: the Fireworks balance ran out (HTTP 402) or the`);
    console.error(`  account is suspended (412). Check billing FIRST — see`);
    console.error(`  docs/inference-recovery-runbook.md. There is no failover: the medic`);
    console.error(`  holds the route and reports, it does not reroute.`);
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
