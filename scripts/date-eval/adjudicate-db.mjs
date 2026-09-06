// Date-eval STEP 4 (optional) — DB adjudication for rows the text grader
// cannot verify. Read-only against the pilot.
//
//   node -r dotenv/config scripts/date-eval/adjudicate-db.mjs --dir <run-dir>
//
// WHY THIS EXISTS. On the 2026-08-13 run, 34 of 94 rows landed in
// needs-adjudication and were judged by hand-run SQL — the whole `specifics`
// category plus every count question whose reply buried the number in prose.
// The judgments were right, but they lived in a conversation. This script IS
// those checks: for the question shapes whose ground truth is a DB read
// (next visit, scheduling window, day/tech counts), it re-derives the truth
// from the pilot at adjudication time and prints verdict + evidence, so a
// "100%" claim is reproducible by anyone running one command.
//
// It does NOT touch verdicts analyze.mjs already made — it only settles rows
// analyze.mjs explicitly refused to guess at, and only those whose truth is
// mechanical. Anything else stays human.
//
// Same truth conventions as plan.mjs (they must never drift):
//   - visits = the visits table, status confirmed|completed, timed unless the
//     question is about windows
//   - times/dates are NAIVE-LOCAL (render raw slices; the '+00' is a lie)
//   - an UNTIMED visit has starts_at null and NO date of any kind (rung 9a
//     deleted the stored window) — the only true answer is "no time set yet"
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const DIR = argOf('dir', join(process.cwd(), 'date-eval-runs', 'pending'));

const rowsPath = join(DIR, 'rows.json');
const manifestPath = join(DIR, 'manifest.json');
if (!existsSync(rowsPath)) {
  console.error(`No rows.json in ${DIR} — run analyze first:  npm run date-eval:report -- --dir ${DIR}`);
  process.exit(1);
}
const rows = JSON.parse(readFileSync(rowsPath, 'utf8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const one = async (sql, params) => (await client.query(sql, params)).rows;
const [{ id: tenantId }] = await one('select id from tenants where name = $1', [manifest.tenant ?? 'Default Tenant']);

// ── truth readers (plan.mjs conventions) ──────────────────────────────────
const nextVisitFor = async (customerLike) => {
  const r = await one(
    `select c.name, (a.starts_at at time zone 'UTC')::date::text as date,
            coalesce(t.ref,'unassigned') as tech
     from visits a join jobs j on j.id=a.job_id join customers c on c.id=j.customer_id
     left join technicians t on t.id=a.technician_id
     where a.tenant_id=$1 and c.name ilike $2 and a.status='confirmed'
       and a.starts_at >= ($3::date)::timestamp
     order by a.starts_at limit 1`,
    [tenantId, `%${customerLike}%`, manifest.today],
  );
  return r[0] ?? null;
};
const untimedFor = async (customerLike, titleLike) => {
  const r = await one(
    `select a.id::text as id
     from visits a join jobs j on j.id=a.job_id join customers c on c.id=j.customer_id
     where a.tenant_id=$1 and c.name ilike $2 and j.title ilike $3
       and a.status='confirmed' and a.starts_at is null limit 1`,
    [tenantId, `%${customerLike}%`, `%${titleLike}%`],
  );
  return r[0] ?? null;
};

// ── which adjudication a question shape needs ─────────────────────────────
// Parsed from the question text — the corpus phrasings are stable.
const NEXT_VISIT = /^When is (.+?)'s next visit\?$/;
const WINDOW = /^When is (.+?)'s (.+?) scheduled\?$/;

const human = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

const results = [];
for (const r of rows) {
  if (r.outcome?.verdict !== 'needs-adjudication') continue;
  const reply = (r.reply ?? '').toLowerCase();
  let verdict = null, evidence = null;

  const nv = r.q.match(NEXT_VISIT);
  const win = r.q.match(WINDOW);
  if (nv) {
    const truth = await nextVisitFor(nv[1]);
    if (truth) {
      evidence = `DB: next confirmed visit ${truth.date} (${truth.tech})`;
      const namesDate = reply.includes(truth.date) || reply.includes(human(truth.date).toLowerCase());
      const deniesAll = /no visits (currently )?scheduled|no upcoming visits|nothing (is )?scheduled/.test(reply);
      verdict = namesDate ? 'correct' : deniesAll ? 'wrong' : 'human';
    } else {
      evidence = 'DB: no upcoming confirmed visit';
      verdict = /no visits|nothing scheduled|none/.test(reply) ? 'correct' : 'human';
    }
  } else if (win) {
    const truth = await untimedFor(win[1], win[2]);
    if (truth) {
      // Rung 9a: the visit is real but carries NO date. Saying so is the only
      // correct answer, and naming ANY date is a fabrication — the exact
      // failure the stored window used to invite.
      evidence = 'DB: the visit exists with no time set';
      const saysUntimed = /no (time|date)|not (yet )?(set|scheduled|placed)|time.{0,4}tbd|unscheduled/.test(reply);
      // 'may' is deliberately ABSENT from the month list: it is also a modal
      // verb, and "the visit may be scheduled once we have a slot" is the
      // correct answer, not a fabricated date. A real May date almost always
      // carries a day number, which the second alternation catches.
      const namesADate =
        /\b20\d\d-\d\d-\d\d\b/.test(reply) ||
        /\b(january|february|march|april|june|july|august|september|october|november|december)\b/.test(reply) ||
        /\bmay\s+\d{1,2}\b|\b\d{1,2}\s+may\b/.test(reply);
      verdict = saysUntimed && !namesADate ? 'correct' : namesADate ? 'wrong' : 'human';
    } else {
      evidence = 'DB: no untimed visit for that customer/job';
      verdict = 'human';
    }
  }

  if (verdict) results.push({ id: r.id, q: r.q, verdict, evidence, replyHead: (r.reply ?? '').slice(0, 90) });
}

const counts = { correct: 0, wrong: 0, human: 0 };
for (const x of results) counts[x.verdict]++;
console.log(`\n=== DB ADJUDICATION — ${DIR} ===`);
console.log(`  settled mechanically: ${results.length} of ${rows.filter((r) => r.outcome?.verdict === 'needs-adjudication').length} adjudication rows`);
console.log(`  correct ${counts.correct} · wrong ${counts.wrong} · still-human ${counts.human}\n`);
for (const x of results) {
  console.log(`  ${x.id.padEnd(5)} ${x.verdict.toUpperCase().padEnd(8)} ${x.evidence}`);
  if (x.verdict !== 'correct') console.log(`        reply: ${x.replyHead}`);
}
writeFileSync(join(DIR, 'db-adjudication.json'), JSON.stringify(results, null, 2));
console.log(`\n  → ${join(DIR, 'db-adjudication.json')}`);
await client.end();
