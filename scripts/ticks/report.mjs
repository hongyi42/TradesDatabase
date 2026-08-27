// The lifecycle heartbeat's own report — the thing that makes lifecycle_runs
// worth having. Operator tool; reads with the service connection (DATABASE_URL)
// and writes NOTHING.
//
//   npm run ticks                    # the last 24h
//   npm run ticks -- --since 72h     # or 90m, or 7d
//
// It answers the four questions the tick JSON on stdout could never answer once
// the log rotated: did it run, what did it quietly skip, which firms did it
// touch, and what did it cost.
//
// THE POINT OF THE "Ran" SECTION: a cron that stops firing cannot report its own
// absence. The rows it DID write are the only evidence, and a hole between two of
// them is the outage. That is why the gap scan leads.
//
// Plan: thoughts/shared/plans/2026-08-26-the-tick-leaves-a-trace.md (Phase 4)
import pg from 'pg';
// findTickGaps lives in src/ so it is unit-tested (its arithmetic is this
// report's only real logic). BUILD FIRST — the npm script does. getClient() is
// lazy, so importing this module needs no SUPABASE_URL.
import { findTickGaps } from '../../dist/db/lifecycleRuns.js';

const dbUrl = process.env.DATABASE_URL ?? '';
if (!dbUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const TICK_MS = 5 * 60 * 1000; // the Render cron cadence, */5
// Same slack findTickGaps uses: a tick that fires at :06 is late, not missing.
const TICK_TOLERANCE_MS = 3 * 60 * 1000;

const sinceIdx = process.argv.indexOf('--since');
const sinceArg = sinceIdx !== -1 ? process.argv[sinceIdx + 1] : '24h';
const m = /^(\d+)([mhd])$/.exec(sinceArg ?? '');
if (!m) {
  console.error(`--since wants a duration like 90m, 24h or 7d — got '${sinceArg}'`);
  process.exit(1);
}
const windowMs = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
const sinceIso = new Date(Date.now() - windowMs).toISOString();

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

// A step's value is one of three shapes: a summary object, {skipped}, or
// {stepError}. These read whichever is present without asserting which.
const skipReason = (v) => (v && typeof v === 'object' ? v.skipped : undefined);
const stepError = (v) => (v && typeof v === 'object' ? v.stepError : undefined);
const hhmm = (iso) => new Date(iso).toISOString().slice(11, 16);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

try {
  const runs = await q(
    `select started_at, finished_at, ok, summary
       from lifecycle_runs
      where started_at >= $1
      order by started_at asc`,
    [sinceIso],
  );

  const lines = [];
  lines.push(`# Lifecycle ticks — last ${sinceArg} (since ${sinceIso})`);
  lines.push('');

  // ── Ran ────────────────────────────────────────────────────────────────────
  const expected = Math.floor(windowMs / TICK_MS);
  lines.push('## Ran');
  lines.push(`- expected ~${expected} ticks in this window, saw ${runs.length}`);
  if (runs.length > 0) {
    // The window's expectation is only fair once the table has covered it. On the
    // first day after the migration lands, "expected 288, saw 24" is a young
    // table, not an outage — and a report that cries wolf on day one is a report
    // nobody reads on day thirty. So the honest denominator is also printed.
    //
    // Measured to NOW, never to the last row: anchoring on the last row would
    // shrink the denominator by exactly the length of a trailing outage and
    // report 120 missing ticks as the correct number. The denominator must not
    // be defined by the thing it is meant to expose.
    const covered = Date.now() - runs[0].started_at;
    const expectedSinceFirst = Math.floor(covered / TICK_MS) + 1;
    if (expectedSinceFirst < expected * 0.9) {
      lines.push(
        `- …but records only start ${((Date.now() - runs[0].started_at) / 3600000).toFixed(1)}h ago: ` +
          `~${expectedSinceFirst} expected since the first one. Judge against THAT until the ` +
          'table has covered the window.',
      );
    }
  }
  if (runs.length === 0) {
    // Said explicitly rather than left as an empty section: on a stack where the
    // cron has never run, "no rows" is the finding, not an absence of one.
    lines.push('- NO TICKS RECORDED in this window. Either the cron is not running, the deploy');
    lines.push('  predates the run record, or the migration has not been applied here.');
  } else {
    const gaps = findTickGaps(runs.map((r) => ({ started_at: r.started_at.toISOString() })), TICK_MS);
    const durations = runs
      .map((r) => r.finished_at - r.started_at)
      .filter((d) => Number.isFinite(d))
      .sort((a, b) => a - b);
    const p50 = durations[Math.floor(durations.length / 2)] ?? 0;
    lines.push(`- first ${runs[0].started_at.toISOString()} · last ${runs.at(-1).started_at.toISOString()}`);
    lines.push(`- median tick duration ${(p50 / 1000).toFixed(1)}s`);

    // THE OUTAGE THAT IS STILL HAPPENING. findTickGaps walks BETWEEN rows, so a
    // cron that died an hour ago leaves no gap to find — the silence is after
    // the last row, not between two of them, and the report would cheerfully
    // say "did not miss a beat" while nothing was running. This is the single
    // most important line here: it is the live-outage check, and every other
    // section is history by comparison.
    const silentMs = Date.now() - runs.at(-1).started_at;
    if (silentMs > TICK_MS + TICK_TOLERANCE_MS) {
      lines.push(
        `- 🚨 NOT RUNNING: last tick was ${(silentMs / 60000).toFixed(0)} min ago ` +
          `(~${Math.max(Math.round(silentMs / TICK_MS) - 1, 1)} ticks missed and counting). ` +
          'The heartbeat is dark RIGHT NOW.',
      );
    } else {
      lines.push(`- last tick ${(silentMs / 60000).toFixed(1)} min ago — currently alive`);
    }

    if (gaps.length === 0) {
      lines.push('- no gaps between recorded ticks');
    } else {
      const missed = gaps.reduce((s, g) => s + g.missedTicks, 0);
      lines.push(`- ⚠ ${plural(gaps.length, 'GAP', 'GAPS')}, ${missed} ticks missed:`);
      for (const g of gaps) {
        lines.push(
          `  - ${hhmm(g.after)} → ${hhmm(g.before)} (${g.missedTicks} missed, ` +
            `${((Date.parse(g.before) - Date.parse(g.after)) / 60000).toFixed(0)} min dark)`,
        );
      }
    }
  }
  lines.push('');

  // ── Failures ───────────────────────────────────────────────────────────────
  const failed = runs.filter((r) => !r.ok);
  lines.push('## Failures');
  if (failed.length === 0) {
    lines.push('- none — every tick exited 0');
  } else {
    lines.push(`- ⚠ ${plural(failed.length, 'tick', 'ticks')} exited non-zero:`);
    // Grouped by (step, message): fifty identical failures are ONE problem, and
    // printing fifty lines buries the second, different one.
    const byError = new Map();
    let unexplained = 0;
    const bump = (key, at) => {
      const hit = byError.get(key) ?? { n: 0, first: at, last: at };
      hit.n += 1;
      hit.last = at;
      byError.set(key, hit);
    };
    for (const r of failed) {
      let named = false;
      for (const [step, value] of Object.entries(r.summary)) {
        const err = stepError(value);
        if (!err) continue;
        named = true;
        bump(`${step}: ${err}`, r.started_at);
      }
      // A tick can go red WITHOUT any stepError: the systemic detectors set
      // ok=false when every ATTEMPTED row failed (lifecycle.ts:248, :291) or
      // every tenant failed (:422), and those steps still report an ordinary
      // summary object. Counting only stepError ticks printed the "exited
      // non-zero" header with nothing under it — for exactly the classes
      // (revoked key, Composio down, DB down) most worth naming.
      if (named) continue;
      unexplained += 1;
      for (const [step, value] of Object.entries(r.summary)) {
        if (!value || typeof value !== 'object') continue;
        const rowErrors = value.rowErrors ?? 0;
        const tenantErrors = value.tenantErrors ?? 0;
        if (rowErrors === 0 && tenantErrors === 0) continue;
        bump(
          `${step}: every attempted row/tenant failed (rowErrors ${rowErrors}, ` +
            `tenantErrors ${tenantErrors}) — systemic, not a blip`,
          r.started_at,
        );
      }
    }
    for (const [key, hit] of [...byError].sort((a, b) => b[1].n - a[1].n)) {
      lines.push(`  - ${hit.n}x ${key}`);
      lines.push(`    first ${hhmm(hit.first.toISOString())}, last ${hhmm(hit.last.toISOString())}`);
    }
    if (byError.size === 0) {
      lines.push(`  - ${unexplained}x ok=false with no step naming a cause — read the raw summary:`);
      lines.push('    select summary from lifecycle_runs where not ok order by started_at desc limit 5;');
    }
  }
  lines.push('');

  // ── Steps ──────────────────────────────────────────────────────────────────
  // The section that would have caught the dead manager-push: a step that is
  // quietly off says so here, every tick, in its own words.
  lines.push('## Steps — what each one skipped, and why');
  const bySkip = new Map();
  for (const r of runs) {
    for (const [step, value] of Object.entries(r.summary)) {
      const why = skipReason(value);
      if (why === undefined) continue;
      const perStep = bySkip.get(step) ?? new Map();
      perStep.set(why, (perStep.get(why) ?? 0) + 1);
      bySkip.set(step, perStep);
    }
  }
  if (bySkip.size === 0) {
    lines.push('- nothing skipped');
  }
  for (const [step, reasons] of [...bySkip].sort()) {
    for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
      // "off-cadence" is the design working (steps 1-7 run quarter-hourly on a
      // */5 schedule), so it is marked as expected rather than left to look like
      // a finding. Everything else deserves a second look.
      const expectedSkip = /off-cadence/.test(why);
      lines.push(`- ${step}: ${n}x "${why}"${expectedSkip ? '' : '   ← check this is intended'}`);
    }
  }
  lines.push('');

  // ── Planner ────────────────────────────────────────────────────────────────
  // Per FIRM, which is the whole point of naming them: "2 skipped" never said
  // which two, so a firm that had gone quiet was indistinguishable from one that
  // simply had no work.
  lines.push('## Planner — per firm');
  const perFirm = new Map();
  for (const r of runs) {
    const plans = r.summary?.teamLeadPlanner?.plans;
    if (!Array.isArray(plans)) continue;
    for (const p of plans) {
      const f = perFirm.get(p.tenantId) ?? {
        planned: 0, no_gaps: 0, out_of_window: 0, error: 0,
        turns: 0, toolCalls: 0, ms: 0, decisions: 0,
      };
      if (f[p.outcome] !== undefined) f[p.outcome] += 1;
      f.turns += p.turns ?? 0;
      f.toolCalls += p.toolCalls ?? 0;
      f.ms += p.ms ?? 0;
      // Already a COUNT by the time it is stored — redactForRecord replaced the
      // array (which carried the technician's question and the model's reasoning)
      // before the row was written.
      f.decisions += typeof p.decisions === 'number' ? p.decisions : 0;
      perFirm.set(p.tenantId, f);
    }
  }
  if (perFirm.size === 0) {
    lines.push('- no planner ticks in this window (off, off-cadence, or pre-deploy records)');
  }
  for (const [tenantId, f] of perFirm) {
    lines.push(
      `- ${tenantId}: planned ${f.planned} · no work ${f.no_gaps} · ` +
        `out of hours ${f.out_of_window} · errors ${f.error}`,
    );
    if (f.planned > 0) {
      lines.push(
        `    ${f.decisions} decisions over ${f.turns} turns / ${f.toolCalls} tool calls, ` +
          `${(f.ms / f.planned / 1000).toFixed(1)}s avg`,
      );
    }
  }
  lines.push('');

  // ── Mute ───────────────────────────────────────────────────────────────────
  // Deliberately never rolled up: this string names an operational state (gaps
  // being minted with nobody to write the questions) and its exact wording says
  // whether a backstop sweep is running.
  const muted = runs.filter((r) => r.summary?.ladderMute);
  lines.push('## Ladder mute');
  if (muted.length === 0) {
    lines.push('- not muted');
  } else {
    lines.push(`- ⚠ ${plural(muted.length, 'tick', 'ticks')} reported the ladder MUTE:`);
    for (const why of new Set(muted.map((r) => r.summary.ladderMute))) {
      lines.push(`  - ${why}`);
    }
  }
  lines.push('');

  // ── Cost ───────────────────────────────────────────────────────────────────
  // NEVER a bare dollar figure. Pricing is an INNER join against cost_rates, so
  // an event whose sku has no rate for its day does not show as $0 — it vanishes.
  // The unpriced count is printed beside every total so a silent under-report
  // cannot read as "cheap".
  const sinceDay = sinceIso.slice(0, 10);
  const cost = await q(
    // day::text, never a JS Date: node-postgres parses a `date` column into a
    // Date at LOCAL midnight, so toISOString() shifts it back a day on any
    // UTC+ host — the same row printed 2026-08-26 in Los Angeles and 2026-08-25
    // in Tokyo. Postgres already holds the right string; take it verbatim.
    `select day::text as day, provider, coalesce(lane, '(unlabelled)') as lane,
            sum(quantity)::float8 as quantity, sum(cost_usd)::float8 as usd
       from priced_cost_events_daily
      where day >= $1::date
      group by day, provider, lane
      order by day desc, usd desc nulls last`,
    [sinceDay],
  );
  const unpriced = await q(
    `select day::text as day, provider, sku, sum(events)::int as events
       from unpriced_cost_events_daily
      where day >= $1::date
      group by day, provider, sku
      order by day desc, events desc`,
    [sinceDay],
  );
  lines.push(`## Cost — by day and lane (from ${sinceDay})`);
  if (cost.length === 0) lines.push('- no priced spend in this window');
  for (const r of cost) {
    lines.push(
      `- ${r.day} ${r.provider} ${r.lane}: ` +
        `$${r.usd.toFixed(4)} (${r.quantity.toLocaleString('en-US')} units)`,
    );
  }
  if (unpriced.length === 0) {
    lines.push('- unpriced events: 0 — every event in this window had a rate');
  } else {
    lines.push('- ⚠ UNPRICED events (absent from the dollars above, NOT counted as zero):');
    for (const r of unpriced) {
      lines.push(`  - ${r.day} ${r.provider}/${r.sku}: ${r.events} events`);
    }
  }
  lines.push('');
  lines.push('_Anthropic + Fireworks only, and only what this ledger measured. Checking these');
  lines.push("figures against the vendors' actual bills is `npm run costs:reconcile`._");

  console.log(lines.join('\n'));
} finally {
  await client.end();
}
