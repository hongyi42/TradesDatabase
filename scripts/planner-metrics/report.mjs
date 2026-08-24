// ⑤ Phase 1: the planner's baseline metrics report. Operator tool — reads the
// mv_* views with the service connection (DATABASE_URL), prints PAIRED metrics
// with their denominators (never a rate without its n — a rate alone is
// gameable and a small-n rate is noise wearing a suit).
//
//   npm run metrics:planner              # print to stdout
//   npm run metrics:planner -- --markdown docs/planner-baseline-YYYY-MM.md
//
// PILOT CAVEAT (user note in the plan): the pilot is a testing environment —
// gaps do not close realistically there, so pilot numbers demonstrate the
// machinery and are NOT a benchmark. The report prints this caveat with every
// run; it becomes a real baseline only on a firm that has run the planner for
// weeks.
import pg from 'pg';
import { writeFileSync } from 'node:fs';

const dbUrl = process.env.DATABASE_URL ?? '';
if (!dbUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const mdIdx = process.argv.indexOf('--markdown');
const mdPath = mdIdx !== -1 ? process.argv[mdIdx + 1] : null;
if (mdIdx !== -1 && !mdPath) {
  console.error('--markdown needs a file path');
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

const q = async (sql) => (await client.query(sql)).rows;
const pct = (num, den) => (den > 0 ? `${((100 * num) / den).toFixed(0)}% (${num}/${den})` : `n/a (0)`);

try {
  const outcomes = await q(`
    select outcome_bucket, closed_by_technician, count(*)::int as n,
           round(avg(working_hours_open), 1) as avg_wh
      from mv_gap_outcomes group by 1, 2 order by 1, 2`);
  const fates = await q(`
    select fate, premature, late, by_planner, count(*)::int as n
      from mv_escalation_fates group by 1, 2, 3, 4 order by 1`);
  const whiplash = await q(`
    select count(*)::int as n,
           round(avg(hours_between), 1) as avg_hours
      from mv_whiplash`);
  const extendEff = await q(`
    select answered_in_time, count(*)::int as n from mv_extend_effectiveness
     where not pending group by 1`);
  const pendingExtends = await q(`
    select count(*)::int as n from mv_extend_effectiveness where pending`);

  const closed = outcomes.reduce((s, r) => s + r.n, 0);
  const answered = outcomes.filter((r) => r.outcome_bucket === 'answered').reduce((s, r) => s + r.n, 0);
  const byTech = outcomes.filter((r) => r.closed_by_technician).reduce((s, r) => s + r.n, 0);
  const toManager = outcomes.filter((r) => r.outcome_bucket === 'manager').reduce((s, r) => s + r.n, 0);
  const escalations = fates.reduce((s, r) => s + r.n, 0);
  const premature = fates.filter((r) => r.premature).reduce((s, r) => s + r.n, 0);
  const late = fates.filter((r) => r.late).reduce((s, r) => s + r.n, 0);
  const usefulFates = fates.filter((r) => r.fate === 'resolved' && !r.premature).reduce((s, r) => s + r.n, 0);
  const extends_ = extendEff.reduce((s, r) => s + r.n, 0);
  const extendsWorked = extendEff.filter((r) => r.answered_in_time).reduce((s, r) => s + r.n, 0);

  const lines = [];
  const now = new Date().toISOString();
  lines.push(`# Planner baseline metrics — ${now}`);
  lines.push('');
  lines.push('> CAVEAT: numbers from a testing/pilot database demonstrate the machinery and');
  lines.push('> are NOT a benchmark — pilot gaps do not close realistically. Read as a real');
  lines.push('> baseline only on a firm that has run the planner for weeks. Small n = noise.');
  lines.push('');
  lines.push('## Outcomes (paired with cost below — neither reads alone)');
  lines.push(`- closed gaps: ${closed}`);
  lines.push(`- filled by an answer: ${pct(answered, closed)}  ·  closed by the technician: ${pct(byTech, closed)}`);
  lines.push(`- handed to the manager: ${pct(toManager, closed)}`);
  for (const r of outcomes) {
    lines.push(`  - ${r.outcome_bucket}${r.closed_by_technician ? ' (tech-answered)' : ''}: n=${r.n}, avg working-hours open=${r.avg_wh ?? 'n/a'}`);
  }
  lines.push('');
  lines.push('## Escalation judgment (premature pairs with late — either alone is gameable)');
  lines.push(`- escalations: ${escalations}`);
  lines.push(`- premature (fate within 12 working hours): ${pct(premature, escalations)}`);
  lines.push(`- late (past 2x the gap's own allowance): ${pct(late, escalations)}`);
  lines.push(`- useful (resolved, not premature): ${pct(usefulFates, escalations)}`);
  for (const r of fates) {
    lines.push(`  - fate=${r.fate}${r.premature ? ' premature' : ''}${r.late ? ' late' : ''}${r.by_planner ? ' by-planner' : ' by-sweep'}: n=${r.n}`);
  }
  lines.push('');
  lines.push('## Whiplash (verb flips with no new evidence between)');
  lines.push(`- flip pairs: ${whiplash[0]?.n ?? 0}${whiplash[0]?.n ? ` (avg ${whiplash[0].avg_hours}h apart)` : ''}`);
  lines.push('');
  lines.push('## Extend effectiveness');
  lines.push(`- extends answered before their extended deadline: ${pct(extendsWorked, extends_)}`);
  lines.push(`- still pending (deadline in the future — not counted above): ${pendingExtends[0]?.n ?? 0}`);
  lines.push('');

  const text = lines.join('\n');
  console.log(text);
  if (mdPath) {
    writeFileSync(mdPath, text + '\n');
    console.log(`\nwritten: ${mdPath}`);
  }
} finally {
  await client.end();
}
