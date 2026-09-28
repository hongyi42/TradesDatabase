// Step 2b's vendor gate, E2B (operator 2026-09-27: "Let's just use E2B for now").
//
// The gate (thoughts/shared/research/2026-09-23-sandbox-vendors-in-depth.md):
// a job starts -> the sandbox sleeps MID-JOB -> hours later the agent reads the
// output. Run it in two halves, hours apart:
//
//   node scripts/sandbox-gate/e2b-gate.mjs start <state.json>
//   node scripts/sandbox-gate/e2b-gate.mjs check <state.json>   (5 min later, then 2 h later)
//   node scripts/sandbox-gate/e2b-gate.mjs kill  <state.json>   (a paused sandbox is kept forever)
//
// `e2b` is not a repo dependency: `npm i --no-save e2b`. The key is read from
// the main checkout's .env (E2B_API_KEY) and never printed. Made-up invoice
// rows only — no customer data goes into the sandbox.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { Sandbox } from 'e2b';

const [mode, statePath] = process.argv.slice(2);
if (!['start', 'check', 'kill'].includes(mode) || !statePath) {
  console.error('usage: e2b-gate.mjs start|check|kill <state.json>');
  process.exit(2);
}

// The main checkout's .env (a worktree has none).
const common = execSync('git rev-parse --path-format=absolute --git-common-dir').toString().trim();
const envLine = readFileSync(join(dirname(common), '.env'), 'utf8').split('\n').find((l) => l.startsWith('E2B_API_KEY='));
if (!envLine) throw new Error('E2B_API_KEY missing from .env');
process.env.E2B_API_KEY = envLine.slice('E2B_API_KEY='.length).trim().replace(/^["']|["']$/g, '');

const TIMEOUT_MS = 60_000; // idle timeout: pauses 60 s after creation / the last setTimeout
const JOB_SECONDS = 180; // the job outlives the timeout, so the sandbox pauses MID-JOB
const sha = (b) => createHash('sha256').update(b).digest('hex');
const now = () => new Date().toISOString();
const ms = async (f) => {
  const t = Date.now();
  const r = await f();
  return [r, Date.now() - t];
};

const INVOICE_PY = `
import json, time
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from openpyxl import Workbook
rows = [("Panel upgrade walkthrough", 1, 185.00), ("Breaker, 20A", 2, 14.50), ("Labor (hours)", 3, 95.00)]
c = canvas.Canvas("/home/user/out/INV-DRAFT.pdf", pagesize=letter)
c.drawString(72, 720, "DRAFT - Invoice for Acme Offices (test data)")
y = 690
for name, qty, price in rows:
    c.drawString(72, y, f"{name}  x{qty}  @ {price:.2f}  = {qty*price:.2f}"); y -= 18
c.drawString(72, y - 12, f"Total: {sum(q*p for _, q, p in rows):.2f}")
c.save()
wb = Workbook(); ws = wb.active; ws.append(["Item", "Qty", "Price"])
for r in rows: ws.append(list(r))
wb.save("/home/user/out/open_jobs.xlsx")
print(json.dumps({"ok": True}))
`;

// A job longer than the idle timeout: one line per second, then a marker.
const JOB_SH = `for i in $(seq 1 ${JOB_SECONDS}); do date -u +%s >> /home/user/out/job.log; sleep 1; done; echo done > /home/user/out/job.done`;

async function start() {
  const [sbx, createMs] = await ms(() =>
    Sandbox.create({
      timeoutMs: TIMEOUT_MS,
      lifecycle: { onTimeout: 'pause', autoResume: true },
      metadata: { purpose: 'step-2b-gate' },
    }),
  );
  console.log(`${now()} created ${sbx.sandboxId} in ${createMs} ms`);
  const [pip, pipMs] = await ms(() =>
    sbx.commands.run('pip install --quiet openpyxl reportlab && mkdir -p /home/user/out', { timeoutMs: 180_000 }),
  );
  console.log(`${now()} pip exit ${pip.exitCode} in ${pipMs} ms`);
  // pip can take most of the 60 s; give the job room before the pause lands.
  await sbx.setTimeout(TIMEOUT_MS);
  await sbx.files.write('/home/user/invoice.py', INVOICE_PY);
  const [run, runMs] = await ms(() => sbx.commands.run('python3 /home/user/invoice.py'));
  console.log(`${now()} invoice script exit ${run.exitCode} in ${runMs} ms: ${run.stdout.trim()}`);
  const pdf = await sbx.files.read('/home/user/out/INV-DRAFT.pdf', { format: 'bytes' });
  const xlsx = await sbx.files.read('/home/user/out/open_jobs.xlsx', { format: 'bytes' });
  const job = await sbx.commands.run(`nohup bash -c '${JOB_SH}' >/dev/null 2>&1 &`, { background: true });
  const startedAt = Math.floor(Date.now() / 1000);
  console.log(`${now()} ${JOB_SECONDS}s job started (pid ${job.pid}); the sandbox pauses ~${TIMEOUT_MS / 1000}s from now, mid-job`);
  const state = {
    sandboxId: sbx.sandboxId,
    createdAt: now(),
    jobStartedAt: startedAt,
    jobSeconds: JOB_SECONDS,
    pdfSha: sha(pdf),
    xlsxSha: sha(xlsx),
    pdfBytes: pdf.length,
    xlsxBytes: xlsx.length,
    timings: { createMs, pipMs, runMs },
    checks: [],
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  // Watch it pause (read-only info calls never resume it).
  for (let i = 0; i < 24; i += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    const info = await Sandbox.getInfo(sbx.sandboxId);
    if (info.state === 'paused') {
      console.log(`${now()} state=paused (${Math.round((Date.now() - startedAt * 1000) / 1000)}s after the job began)`);
      return;
    }
  }
  console.log(`${now()} still running after 2 min: did not pause`);
}

async function check() {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const before = await Sandbox.getInfo(state.sandboxId);
  const [sbx, resumeMs] = await ms(() => Sandbox.connect(state.sandboxId));
  const pdf = await sbx.files.read('/home/user/out/INV-DRAFT.pdf', { format: 'bytes' });
  const xlsx = await sbx.files.read('/home/user/out/open_jobs.xlsx', { format: 'bytes' });
  // Let a resumed job finish its remaining seconds.
  let done = false;
  for (let i = 0; i < 60 && !done; i += 1) {
    done = (await sbx.commands.run('test -f /home/user/out/job.done && echo y || echo n')).stdout.trim() === 'y';
    if (!done) await new Promise((r) => setTimeout(r, 5_000));
  }
  const log = (await sbx.files.read('/home/user/out/job.log')).trim().split('\n').map(Number);
  // Seconds the job was frozen: the biggest gap between two consecutive ticks.
  let gap = 0;
  for (let i = 1; i < log.length; i += 1) gap = Math.max(gap, log[i] - log[i - 1]);
  const echo = await sbx.commands.run('python3 -c "import openpyxl, reportlab; print(\'libs ok\')"');
  const result = {
    at: now(),
    stateBefore: before.state,
    resumeMs,
    pdfSame: sha(pdf) === state.pdfSha,
    xlsxSame: sha(xlsx) === state.xlsxSha,
    jobFinished: done,
    jobTicks: log.length,
    jobExpectedTicks: state.jobSeconds,
    longestFreezeSeconds: gap,
    libsStillInstalled: echo.stdout.trim() === 'libs ok',
  };
  state.checks.push(result);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(result, null, 2));
  // Back to sleep for the next check (the timeout re-arms from now).
  await sbx.setTimeout(TIMEOUT_MS);
}

async function kill() {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  console.log(`killed: ${await Sandbox.kill(state.sandboxId)}`);
}

await { start, check, kill }[mode]();
