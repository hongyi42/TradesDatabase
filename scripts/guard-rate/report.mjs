// Weekday-guard flag-rate report — the phase-4 decision input.
//
//   node scripts/guard-rate/report.mjs [--since 2026-08-12T17:23:00Z] [--host tradesbox]
//
// Reads every sandbox's weekday-guard.jsonl over ssh and computes the numbers
// the act-mode decision needs. Three rules are load-bearing, all learned the
// hard way:
//
//   1. COUNT DUP-LESS LINES ONLY. v0.2.0+ registers both outbound hooks and a
//      reply traversing both writes two lines, the second marked `dup: true`.
//      Counting both would halve the apparent flag rate.
//   2. SPLIT corrected FROM uncorrected. A flag with `corrected: true` is the
//      agent FIXING a wrong pair (T02 class) — logged for telemetry, but
//      act-mode must never fire on it. The uncorrected count is the decision
//      number; the corrected count is its own series (how often the agent
//      self-corrects).
//   3. NEVER TRUST A QUIET LOG. The first "two weeks of data" turned out to be
//      3 lines from one evening — the hook was deaf and nothing said so. The
//      liveness section compares each box's recent outbound Telegram traffic
//      (docker logs) against its recent guard lines: traffic with no lines is
//      a DEAF GUARD and the report says so in capitals, because a rate
//      computed over a deaf window is not a small number, it is no number.
//
// The default --since is the fleet's verified-live epoch (2026-08-12T17:23Z,
// the first streamed-reply line after the 2026.6.34 upgrade). Earlier lines
// predate real coverage and would dilute the denominator with stub-only days.
import { spawnSync } from 'node:child_process';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};

const HOST = argOf('host', 'tradesbox');
const SINCE = new Date(argOf('since', '2026-08-12T17:23:00Z'));
const SANDBOXES = ['s2', 's3', 's5', 's6', 's7', 's8'];

if (Number.isNaN(SINCE.getTime())) {
  console.error(`bad --since; want ISO like 2026-08-12T17:23:00Z`);
  process.exit(1);
}

const ssh = (cmd) =>
  spawnSync('ssh', [HOST, cmd], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });

// One ssh round-trip per box: guard log (+ rotation), plus a 24h outbound
// Telegram count for the liveness check. Delimited so one parse pass splits it.
function collect(agent) {
  const cmd = [
    `CID=$(docker ps --format '{{.Names}}' | grep "^openshell-${agent}-")`,
    `[ -n "$CID" ] || { echo NO-CONTAINER; exit 0; }`,
    `echo "===LOG==="`,
    `docker exec "$CID" sh -c 'cat /sandbox/.openclaw/logs/weekday-guard.jsonl.1 2>/dev/null; cat /sandbox/.openclaw/logs/weekday-guard.jsonl 2>/dev/null'`,
    `echo "===OUTBOUND24H==="`,
    `docker logs --since 24h "$CID" 2>&1 | grep -cE '/bot\\[CREDENTIAL\\]/(sendMessage|editMessageText)' || true`,
  ].join('\n');
  const r = ssh(cmd);
  const raw = r.stdout ?? '';
  if (raw.includes('NO-CONTAINER')) return null;
  const [, logPart = '', outPart = '0'] = raw.split(/===LOG===|===OUTBOUND24H===/);
  const lines = [];
  for (const line of logPart.split('\n')) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch { /* torn line during rotation — skip */ }
  }
  return { lines, outbound24h: Number(outPart.trim()) || 0 };
}

const perBox = [];
for (const agent of SANDBOXES) {
  const got = collect(agent);
  if (!got) { perBox.push({ agent, missing: true }); continue; }
  const inWindow = got.lines.filter((l) => l.ts && new Date(l.ts) >= SINCE);
  const scanned = inWindow.filter((l) => !l.dup && !l.miss);
  const misses = inWindow.filter((l) => l.miss);
  let uncorrected = 0, corrected = 0, flaggedMsgs = 0;
  for (const l of scanned) {
    const flags = Array.isArray(l.flags) ? l.flags : [];
    const bad = flags.filter((f) => !f.corrected);
    if (bad.length > 0) flaggedMsgs += 1;
    uncorrected += bad.length;
    corrected += flags.length - bad.length;
  }
  const lastTs = inWindow.length ? inWindow[inWindow.length - 1].ts : null;
  const lastAgeH = lastTs ? (Date.now() - new Date(lastTs)) / 3_600_000 : null;
  // DEAF = the box talked in the last 24h but the guard heard nothing in 24h.
  // A quiet box (no outbound) is fine — silence with traffic is the alarm.
  const deaf = got.outbound24h > 0 && (lastAgeH === null || lastAgeH > 24);
  perBox.push({ agent, scanned: scanned.length, flaggedMsgs, uncorrected, corrected, misses: misses.length, outbound24h: got.outbound24h, lastTs, deaf });
}

console.log(`\n=== WEEKDAY-GUARD FLAG RATE ===`);
console.log(`  window: ${SINCE.toISOString()} .. now   (verified-live epoch unless overridden)\n`);
console.log(`  box  scanned  flagged-msgs  flags(act)  corrected  miss  outbound24h  last-line`);
let scanned = 0, flaggedMsgs = 0, uncorrected = 0, corrected = 0;
let anyDeaf = false;
for (const b of perBox) {
  if (b.missing) { console.log(`  ${b.agent}   NO CONTAINER`); continue; }
  scanned += b.scanned; flaggedMsgs += b.flaggedMsgs; uncorrected += b.uncorrected; corrected += b.corrected;
  const deafMark = b.deaf ? '  << DEAF: traffic but no guard lines in 24h' : '';
  if (b.deaf) anyDeaf = true;
  console.log(
    `  ${b.agent}   ${String(b.scanned).padStart(7)}  ${String(b.flaggedMsgs).padStart(12)}  ${String(b.uncorrected).padStart(10)}  ${String(b.corrected).padStart(9)}  ${String(b.misses).padStart(4)}  ${String(b.outbound24h).padStart(11)}  ${b.lastTs ?? '—'}${deafMark}`,
  );
}
console.log(`\n  fleet: ${scanned} scanned, ${flaggedMsgs} messages with act-relevant flags (${uncorrected} flags), ${corrected} corrected (self-fixes)`);
if (scanned > 0) {
  const rate = flaggedMsgs / scanned;
  console.log(`  act-relevant flag rate: ${(rate * 100).toFixed(2)}% of scanned messages`);
  console.log(`\n  Decision framing (doctrine, 2026-08-11): act-mode = cancel-and-retry on ANY`);
  console.log(`  uncorrected flag — the rate does not decide WHETHER to intervene, only`);
  console.log(`  whether a ~15s retry round-trip is SUFFICIENT remediation at this volume.`);
}
if (anyDeaf) {
  console.log(`\n  *** A GUARD IS DEAF — the rate above is NOT trustworthy. Fix coverage first`);
  console.log(`  *** (check the box's gateway startup line + perms; see engineering-memory.md).`);
  process.exit(2);
}
if (scanned === 0) {
  console.log(`  No scanned messages in the window yet — rate undefined, not zero.`);
}
