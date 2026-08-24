// The agentic planner eval — grade and report (plan 2026-08-24, Phase 4).
// Spends money ONLY with --judge (one cheap Anthropic call per flagged note).
//
//   node scripts/agentic-eval/analyze.mjs --dir <run-dir>
//   node scripts/agentic-eval/analyze.mjs --dir <run-dir> --judge
//   node scripts/agentic-eval/analyze.mjs --compare <dirA> <dirB>
//
// Reads results.jsonl + meta.json, applies the deterministic graders from
// dist, optionally asks the blind judge (block + note only — never the
// verdict, never the scenario's why), prices the run off cost_rates, and
// writes report.md + rows.json. Re-running is free: grading never re-spends.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { requireLocalStack, argOf, hasFlag } from '../spine-eval/lib/env.mjs';
import { judgeNote } from '../planner-eval/judge.mjs';
import { callPlanner } from '../planner-eval/anthropic.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
requireLocalStack({ quiet: true });
const { gradeScenario, investigationStats } = await import(`${DIST}/eval/plannerEvalGraders2.js`);

const loadRun = (dir) => {
  const rows = readFileSync(join(dir, 'results.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  return { rows, meta };
};

// ── price a run off the REAL rate book ───────────────────────────────────────
async function priceLedger(ledger) {
  if (!ledger?.length) return { usd: null, lines: [] };
  const sql = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await sql.connect();
    // Latest rate per SKU — the book keeps history (DeepInfra moved twice in
    // three days), and the newest effective_from is what this run paid.
    const { rows: rates } = await sql.query(
      `select distinct on (provider, sku) provider, sku, unit_cost_usd
       from cost_rates order by provider, sku, effective_from desc`,
    );
    const rate = new Map(rates.map((r) => [`${r.provider}|${r.sku}`, Number(r.unit_cost_usd)]));
    let usd = 0;
    let unpriced = 0;
    const lines = ledger.map((l) => {
      const p = rate.get(`${l.provider}|${l.sku}`);
      const cost = p != null ? Number(l.tokens) * p : null;
      if (cost != null) usd += cost;
      else unpriced += 1;
      return { ...l, usd: cost };
    });
    // Never report a confident dollar figure over unmapped SKUs (review
    // finding: a missing rate book printed $0.0000 for a real-dollar run).
    return { usd: unpriced === ledger.length ? null : usd, unpriced, lines };
  } catch (err) {
    console.error(`  (rate book unavailable — token counts only: ${err.message})`);
    return { usd: null, lines: ledger.map((l) => ({ ...l, usd: null })) };
  } finally {
    await sql.end().catch(() => {});
  }
}

// ── grade one run ────────────────────────────────────────────────────────────
async function gradeRun(dir, { judge = false } = {}) {
  const { rows, meta } = loadRun(dir);
  const t0Ms = Date.parse(meta.t0);
  if (Number.isNaN(t0Ms)) throw new Error(`meta.json t0 is unreadable ('${meta.t0}') — refusing to grade`);
  // From process.env (requireLocalStack's dotenv already loaded .env) — never
  // a raw-file regex, and checked BEFORE any judge spend (review findings).
  const judgeKey = process.env.ANTHROPIC_API_KEY;
  if (judge && !judgeKey) throw new Error('--judge needs ANTHROPIC_API_KEY (.env or shell)');
  let judgeSpend = 0;
  const graded = [];
  for (const row of rows) {
    const findings = gradeScenario(row, t0Ms);
    const stats = investigationStats(row);
    let judgeVerdicts = [];
    const judgeMisses = [];
    if (judge && !row.harnessError) {
      // Judge every escalation note the run produced — blame and unsupported
      // claims are the two things strings cannot settle. The judge sees the
      // gap's BLOCK (from the stored prompt) and the NOTE, nothing else —
      // NEVER the whole prompt: a missing block is a loud harness finding,
      // not a silently widened evidence base (review finding).
      for (const [ti, tick] of row.ticks.entries()) {
        const blocks = (tick.userPrompt ?? '').split('\n\n').filter((b) => b.startsWith('gap '));
        for (const d of tick.decisions ?? []) {
          if (!d.handoff_note || d.outcome !== 'applied') continue;
          const block = blocks.find((b) => b.includes(d.nudge_id));
          if (!block) {
            judgeMisses.push({ kind: 'judge-block-missing', tick: ti, detail: `no gap block for ${d.nudge_id} in the stored prompt` });
            continue;
          }
          const res = await judgeNote({
            block,
            note: d.handoff_note,
            model: 'claude-haiku-4-5-20251001',
            apiKey: judgeKey,
            callPlanner,
          });
          judgeSpend += res.cost?.usd ?? 0;
          if (!res.verdict) {
            // Fail LOUD, never open: a truncated/refused judge call is not a
            // clean read (review finding — callPlanner returns plan: null).
            judgeMisses.push({ kind: 'judge-no-verdict', tick: ti, detail: `the judge returned no verdict for ${d.nudge_id}` });
            continue;
          }
          judgeVerdicts.push({ tick: ti, nudgeId: d.nudge_id, ...res.verdict });
        }
      }
    }
    // A judge flag IS a finding — the blind read exists precisely for what the
    // string checks cannot see, so it must fail the scenario, not decorate it.
    findings.push(...judgeMisses);
    for (const v of judgeVerdicts) {
      if (v.blamesPerson) {
        findings.push({ kind: 'judge-blame', tick: v.tick, detail: v.note });
      }
      if ((v.unsupportedClaims ?? []).length > 0) {
        findings.push({
          kind: 'judge-unsupported',
          tick: v.tick,
          detail: `${JSON.stringify(v.unsupportedClaims)} — ${v.note}`,
        });
      }
      // The actionability half of the judge's charter (review finding — the
      // old analyze surfaced it; dropping it made unactionable notes free).
      if (v.wouldActOnIt === false) {
        findings.push({ kind: 'judge-unactionable', tick: v.tick, detail: v.note });
      }
    }
    graded.push({
      id: row.id,
      family: row.family,
      why: row.why,
      arm: row.arm,
      status: row.harnessError ? 'harness-error' : findings.length === 0 ? 'passed' : 'failed',
      findings,
      stats,
      ticks: row.ticks.length,
      ticksSkipped: row.ticksSkipped ?? 0,
      judge: judgeVerdicts,
    });
  }
  return { graded, meta, judgeSpend };
}

function familyTable(graded) {
  const fams = new Map();
  for (const g of graded) {
    const f = fams.get(g.family) ?? { passed: 0, failed: 0, err: 0 };
    if (g.status === 'passed') f.passed++;
    else if (g.status === 'failed') f.failed++;
    else f.err++;
    fams.set(g.family, f);
  }
  return [...fams.entries()].map(
    ([fam, f]) => `| ${fam} | ${f.passed} | ${f.failed} | ${f.err} |`,
  );
}

async function reportRun(dir, opts) {
  const { graded, meta, judgeSpend } = await gradeRun(dir, opts);
  const write = opts.write !== false;
  const price = await priceLedger(meta.ledger);
  const passed = graded.filter((g) => g.status === 'passed').length;
  const failed = graded.filter((g) => g.status === 'failed');
  const errs = graded.filter((g) => g.status === 'harness-error');
  const reads = graded.reduce((n, g) => n + g.stats.reads, 0);
  const decisions = graded.reduce((n, g) => n + g.stats.decisions, 0);
  const withRead = graded.filter((g) => g.stats.reads > 0).length;

  const md = [];
  md.push(`# Agentic planner eval — ${meta.arm} (${meta.model})`);
  md.push('');
  md.push(`run: ${dir}`);
  md.push(`t0: ${meta.t0} · scenarios: ${graded.length} · started: ${meta.startedAt}`);
  md.push('');
  md.push(`**${passed}/${graded.length} passed** (${failed.length} failed, ${errs.length} harness errors)`);
  md.push('');
  md.push('| family | passed | failed | err |');
  md.push('|---|---|---|---|');
  md.push(...familyTable(graded));
  md.push('');
  md.push(
    `Investigation: ${reads} successful reads across ${decisions} decisions ` +
      `(${decisions ? (reads / decisions).toFixed(2) : '—'} reads/decision); ` +
      `${withRead}/${graded.length} scenarios made at least one read.`,
  );
  md.push('');
  md.push(
    `Cost: ${price.usd != null ? `$${price.usd.toFixed(4)}` : 'token counts only'}` +
      (price.unpriced ? ` (+${price.unpriced} UNPRICED sku${price.unpriced === 1 ? '' : 's'})` : '') +
      (opts.judge ? ` · judge: $${judgeSpend.toFixed(4)}` : ''),
  );
  for (const l of price.lines) {
    md.push(`  - ${l.provider}/${l.sku}: ${l.tokens} tokens${l.usd != null ? ` ($${l.usd.toFixed(4)})` : ''}`);
  }
  md.push('');
  if (failed.length + errs.length > 0) {
    md.push('## Failures');
    for (const g of [...failed, ...errs]) {
      md.push('');
      md.push(`### ${g.id} (${g.family}) — ${g.status}`);
      md.push(`why: ${g.why}`);
      for (const f of g.findings) {
        md.push(`- **${f.kind}**${f.tick !== undefined ? ` (tick ${f.tick})` : ''}: ${f.detail}`);
      }
      for (const v of g.judge ?? []) {
        if (v.blamesPerson || (v.unsupportedClaims ?? []).length > 0) {
          md.push(
            `- judge: blames=${v.blamesPerson} unsupported=${JSON.stringify(v.unsupportedClaims)} — ${v.note}`,
          );
        }
      }
    }
  }
  const out = md.join('\n') + '\n';
  if (write) {
    writeFileSync(join(dir, 'report.md'), out);
    writeFileSync(join(dir, 'rows.json'), JSON.stringify(graded, null, 2));
    console.log(out);
    console.log(`wrote ${join(dir, 'report.md')}`);
  }
  return { graded, meta, priceUsd: price.usd };
}

// ── entry ────────────────────────────────────────────────────────────────────
if (hasFlag('compare')) {
  const i = process.argv.indexOf('--compare');
  const [a, b] = [process.argv[i + 1], process.argv[i + 2]];
  if (!a || !b) {
    console.error('--compare <dirA> <dirB>');
    process.exit(2);
  }
  // Read-only re-grade (deterministic checks only): comparing must never
  // clobber a dir's judged report.md/rows.json (learned the hard way).
  const A = await reportRun(a, { judge: false, write: false });
  const B = await reportRun(b, { judge: false, write: false });
  const fams = [...new Set([...A.graded, ...B.graded].map((g) => g.family))];
  const cell = (run, fam) => {
    const rows = run.graded.filter((g) => g.family === fam);
    return `${rows.filter((g) => g.status === 'passed').length}/${rows.length}`;
  };
  const md = [];
  md.push(`# Two-arm comparison`);
  md.push('');
  md.push('_Deterministic checks only — judge findings live in each run\'s own report._');
  md.push('');
  md.push(`| family | ${A.meta.arm} (${A.meta.model}) | ${B.meta.arm} (${B.meta.model}) |`);
  md.push('|---|---|---|');
  for (const f of fams) md.push(`| ${f} | ${cell(A, f)} | ${cell(B, f)} |`);
  const tot = (r) => `${r.graded.filter((g) => g.status === 'passed').length}/${r.graded.length}`;
  md.push(`| **total** | **${tot(A)}** | **${tot(B)}** |`);
  md.push('');
  md.push(
    `cost: ${A.meta.arm} ${A.priceUsd != null ? `$${A.priceUsd.toFixed(2)}` : '?'} · ` +
      `${B.meta.arm} ${B.priceUsd != null ? `$${B.priceUsd.toFixed(2)}` : '?'}`,
  );
  const out = md.join('\n') + '\n';
  writeFileSync(join(a, 'compare.md'), out);
  console.log(out);
} else {
  const dir = argOf('dir', null);
  if (!dir) {
    console.error('--dir <run-dir> required (or --compare <dirA> <dirB>)');
    process.exit(2);
  }
  await reportRun(dir, { judge: hasFlag('judge') });
}
