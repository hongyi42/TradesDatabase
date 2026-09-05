// Spine-eval STEP 0b — verify the world actually landed.
//
//   npm run spine-eval:verify
//
// src/eval/worldSpec.test.ts proves the SPEC is self-consistent. This proves the
// DATABASE agrees with it: that the applier wrote what the spec described, that
// the status machine and DB constraints did not quietly reshape it, and that the
// planted edges are really there. Different failure class, so it needs its own
// check — a spec that is perfect and an applier that drops a field produce the
// same green unit test and a useless world.
//
// Read-only. Exits non-zero on the first sign the world cannot be graded against,
// so it is safe to chain ahead of a run (and cheap enough to do every time).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { requireLocalStack, argOf } from './lib/env.mjs';
import { addDays, daysBetween } from '../../dist/eval/clock.js';
import { HORIZON_DAYS } from '../../dist/eval/worldSpec.js';

console.log('\n=== SPINE EVAL — VERIFY WORLD ===');
const { dbUrl } = requireLocalStack();

const worldPath = join(argOf('dir', join(process.cwd(), 'spine-eval-runs')), 'world.json');
if (!existsSync(worldPath)) {
  console.error(`\nNo world at ${worldPath}. Run:  npm run spine-eval:world\n`);
  process.exit(1);
}
const w = JSON.parse(readFileSync(worldPath, 'utf8'));
const main = w.tenants.find((t) => t.name === 'Eval Main');
const other = w.tenants.find((t) => t.name === 'Eval Other Firm');

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `   (${detail})` : ''}`);
};

console.log(`  anchor ${w.anchor}   span ${w.span.from} → ${w.span.to}\n`);

try {
  // ── the rows are all there ──
  for (const t of w.tenants) {
    const [{ n: customers }] = await q('select count(*)::int n from customers where tenant_id=$1', [t.id]);
    const [{ n: jobs }] = await q('select count(*)::int n from jobs where tenant_id=$1', [t.id]);
    const [{ n: visits }] = await q('select count(*)::int n from assignments where tenant_id=$1', [t.id]);
    check(
      `${t.name.padEnd(16)} counts match the manifest`,
      customers === t.counts.customers && jobs === t.counts.jobs && visits === t.counts.visits,
      `db ${customers}/${jobs}/${visits} vs spec ${t.counts.customers}/${t.counts.jobs}/${t.counts.visits}`,
    );
  }

  // ── the schedule is internally consistent ──
  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const placed = await q(
    `select t.ref, (a.starts_at)::date::text d, to_char(a.starts_at,'HH24:MI') st,
            to_char(a.ends_at,'HH24:MI') et, t.availability
       from assignments a join technicians t on t.id = a.technician_id
      where a.tenant_id = $1 and a.starts_at is not null`,
    [main.id],
  );
  const outside = placed.filter((r) => {
    const windows = r.availability?.[DAY_KEYS[new Date(`${r.d}T00:00:00Z`).getUTCDay()]] ?? [];
    return !windows.some(([from, to]) => r.st >= from && r.et <= to);
  });
  check('every placed visit sits inside its technician pattern', outside.length === 0, `${outside.length} outside`);

  const [{ n: weekend }] = await q(
    `select count(*)::int n from assignments a join technicians t on t.id=a.technician_id
      where a.tenant_id=$1 and a.starts_at is not null and t.ref in ('tech-jane','tech-marco')
        and extract(dow from a.starts_at) in (0,6)`,
    [main.id],
  );
  check('no weekend work for the Mon–Fri technicians', weekend === 0, `${weekend} found`);

  const [{ n: onLeave }] = await q(
    `select count(*)::int n from assignments a
       join technician_time_off o on o.technician_id = a.technician_id
      where a.tenant_id=$1 and a.starts_at is not null
        and (a.starts_at)::date between o.starts_on and o.ends_on`,
    [main.id],
  );
  check('nobody is booked during their own time off', onLeave === 0, `${onLeave} found`);

  // Naive-local storage: the stored HH:MM must BE a slot wall-clock. A UTC-shifted
  // write would render as the wrong time in every schedule answer.
  const [{ st: firstStart }] = await q(
    `select to_char(starts_at,'HH24:MI') st from assignments
      where tenant_id=$1 and starts_at is not null order by starts_at limit 1`,
    [main.id],
  );
  check('times are stored naive-local', /^(0[7-9]|1[0-6]):(00|15|30|45)$/.test(firstStart), firstStart);

  // ── the planted edges ──
  const [noAddr] = await q('select address_line1, city from customers where tenant_id=$1 and name=$2', [
    main.id,
    w.edges.noAddressCustomer,
  ]);
  check('no-address customer has no address', Boolean(noAddr) && !noAddr.address_line1 && !noAddr.city);

  const [{ n: surnames }] = await q(
    "select count(*)::int n from customers where tenant_id=$1 and name like '%Whitfield'",
    [main.id],
  );
  check('two same-surname customers exist', surnames === 2, `${surnames}`);

  const [durationless] = await q('select duration_minutes from jobs where tenant_id=$1 and title=$2', [
    main.id,
    w.edges.durationlessJob,
  ]);
  check('duration-less job still has no duration', Boolean(durationless) && durationless.duration_minutes === null);

  const [rich] = await q('select attributes from customers where tenant_id=$1 and name=$2', [
    main.id,
    w.edges.richHistoryCustomer,
  ]);
  const [foldCapture] = await q(
    `select id from raw_captures where tenant_id=$1 and raw_text like '%Gate code 4321%' limit 1`,
    [main.id],
  );
  const facts = Object.entries(rich?.attributes ?? {});
  const citing = facts.filter(([, v]) => v && v.sourceCaptureId === foldCapture?.id);
  // Standing facts must be BUNDLES citing a capture, never plain values: a plain
  // value has no provenance and no removal path, so retract_capture's fold could
  // never take it away (the 2026-07-14 live finding).
  check(
    'rich-history facts are bundles citing the retract-fold capture',
    facts.length >= 3 && citing.length === facts.length,
    `${citing.length}/${facts.length}`,
  );

  const horizon = await q(
    // ILIKE, not LIKE: 'Horizon-edge tune-up' is capitalised and a case-sensitive
    // match silently found only one of the two rows — a check that under-reports
    // is worse than no check.
    `select (a.starts_at)::date::text d from assignments a join jobs j on j.id=a.job_id
      where a.tenant_id=$1 and j.title ilike '%horizon%' order by 1`,
    [main.id],
  );
  const inside = daysBetween(w.anchor, w.edges.horizonEdgeVisit);
  const beyond = daysBetween(w.anchor, w.edges.beyondHorizonVisit);
  check(
    'horizon-edge visits landed on the manifest days',
    horizon.length === 2 && horizon[0].d === w.edges.horizonEdgeVisit && horizon[1].d === w.edges.beyondHorizonVisit,
    horizon.map((h) => h.d).join(' / '),
  );
  check(
    `one visit inside the ${HORIZON_DAYS}d horizon (+${inside}d) and one past it (+${beyond}d)`,
    inside < HORIZON_DAYS && beyond > HORIZON_DAYS,
  );

  // ── tenant isolation ──
  const canary = await q('select tenant_id from customers where name=$1', [w.edges.crossTenantCanary]);
  check(
    'the cross-tenant canary lives in exactly one tenant',
    canary.length === 1 && canary[0].tenant_id === other.id,
    `${canary.length} row(s)`,
  );

  // ── the world has something to answer questions about ──
  const density = await q(
    `select (starts_at)::date::text d, count(*)::int n from assignments
      where tenant_id=$1 and status='confirmed' and starts_at is not null
        and (starts_at)::date between $2::date and $3::date
      group by 1 order by 1`,
    [main.id, w.anchor, addDays(w.anchor, 6)],
  );
  console.log(`\n  confirmed visits/day ahead: ${density.map((d) => `${d.d.slice(5)}=${d.n}`).join(' ')}`);
  check('the week ahead carries real density', density.filter((d) => d.n >= 6).length >= 4);

  const [{ n: queue }] = await q(
    `select count(*)::int n from jobs j where j.tenant_id=$1 and j.status='open'
       and not exists (select 1 from assignments a where a.job_id = j.id)`,
    [main.id],
  );
  const [{ n: tbd }] = await q(
    `select count(*)::int n from assignments where tenant_id=$1 and starts_at is null and earliest_date is not null`,
    [main.id],
  );
  const [{ n: personless }] = await q(
    `select count(*)::int n from assignments where tenant_id=$1 and technician_id is null`,
    [main.id],
  );
  check(
    `the loose queue and its edges exist`,
    queue >= 4 && tbd >= 3 && personless >= 1,
    `queue ${queue}, time-TBD ${tbd}, person-less ${personless}`,
  );


  const seats = w.tenants.find((x) => x.name === 'Eval Seats');
  const [seatRow] = await q('select technician_seats from tenants where id=$1', [seats.id]);
  const [{ n: used }] = await q(
    `select count(*)::int n from technicians where tenant_id=$1 and tier='technician' and not seat_exempt`,
    [seats.id],
  );
  check('the seats tenant has no free technician seat', used === seatRow.technician_seats, `${used}/${seatRow.technician_seats}`);

  const [{ n: exempt }] = await q(
    `select count(*)::int n from technicians where tenant_id=$1 and seat_exempt`,
    [main.id],
  );
  check('the seat-exempt part-timer exists', exempt >= 1, `${exempt}`);
} finally {
  await client.end();
}

if (failed > 0) {
  console.error(`\n  ${failed} CHECK(S) FAILED — the world is not safe to grade against.\n`);
  process.exit(1);
}
console.log(`\n  world verified.\n`);
