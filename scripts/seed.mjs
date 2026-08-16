// Dev seed: load a deterministic sample dataset into a spine DB — the LOCAL
// Supabase stack or the hosted TEST project — for manual / live work (briefings,
// the Composio webhook test, eyeballing the three layers).
//
// NOT for automated tests — tests run against the local stack and truncate it
// themselves (src/test.setup.ts). Run this to (re)build a playground.
//
// Targets & flags:
//   npm run seed:local          → the LOCAL stack (.env.test overrides .env);
//                                 roster is ALWAYS reseeded here (harmless, and the
//                                 playground's schedule/briefing demos need it).
//   npm run seed -- --hosted    → the hosted pilot project. REQUIRES the explicit
//                                 --hosted flag (it wipes spine tables the deployed
//                                 stack reads live); without it the script refuses.
//   … --hosted --with-roster    → additionally wipes/reseeds the roster on hosted.
//                                 DANGEROUS: re-seeded rows carry NO badge_hash, so
//                                 the box re-mints credentials on its next pull, and
//                                 each provider install bumps the sandbox generation
//                                 (versioning trap) — treat as maintenance on every
//                                 sandbox (2026-07-03 incident + 2026-07-04 runbook).
// Flags are read from argv AND npm_config_* — npm silently EATS flags passed
// without the `--` separator; the npm_config fallback catches --hosted/--with-roster
// that way, but NOT --local (npm recognizes `local` as its own config key and
// swallows it without setting npm_config_local). A bare `npm run seed --local`
// therefore lands on the hosted-refusal path, which exits safely and names the
// right command. Always use `npm run seed:local` or the `--` separator.
//
// Writes go through the typed src/db layer (compiled to dist/), so provenance
// links, L3 attributes, and legal status transitions follow the same paths the
// app uses. The only raw SQL is the TRUNCATE (the db layer exposes no delete —
// L1 is append-only — and TRUNCATE doesn't fire the row-level append-only trigger).
//
// Usage: `npm run seed` (builds first, loads .env via `-r dotenv/config`).

import pg from 'pg';
import { config as dotenvConfig } from 'dotenv';
import { isLocalDbUrl } from '../dist/testEnvGuard.js';
import {
  createCustomer,
  createJob,
  createVisit,
  updateJobStatus,
  appendRawCapture,
  insertTechnician,
  setTechnicianState,
  setTenantSeats,
  getTenantByName,
  getTechnician,
  setTechnicianAvailability,
  setTechnicianServiceCities,
  addTimeOff,
  upsertJobTypeDuration,
  createAssignment,
} from '../dist/db/index.js';
import { formatEmailRawText } from '../dist/email/format.js';

// Flags first (argv + npm_config_* — npm eats flags passed without `--`).
const flag = (name) =>
  process.argv.includes(`--${name}`) || process.env[`npm_config_${name.replaceAll('-', '_')}`] === 'true';
const LOCAL_FLAG = flag('local');
const HOSTED_FLAG = flag('hosted');
const WITH_ROSTER_FLAG = flag('with-roster');

// --local retargets to the local stack the same way the test suite does:
// .env.test overrides the three DB vars loaded from .env.
if (LOCAL_FLAG) dotenvConfig({ path: '.env.test', override: true });

// --- Safety: refuse to run against anything but the TEST project or the local
// stack. Both connection strings must agree on ONE allowed target, and the
// hosted pilot additionally requires the explicit --hosted flag. A swapped
// .env (prod or any other DB) aborts before a single row is touched.
const TEST_REF = 'daqapdlkgxfrhquacprv';
const dbUrl = process.env.DATABASE_URL ?? '';
const supaUrl = process.env.SUPABASE_URL ?? '';
const dbHosted = dbUrl.includes(TEST_REF);
const supaHosted = supaUrl.includes(TEST_REF);
const dbLocal = isLocalDbUrl(dbUrl);
const supaLocal = isLocalDbUrl(supaUrl);
const TARGET = dbHosted && supaHosted ? 'hosted-test' : dbLocal && supaLocal ? 'local' : null;
if (!TARGET) {
  console.error(
    `REFUSING TO SEED: DATABASE_URL and SUPABASE_URL must BOTH target either the ` +
      `hosted test ref (${TEST_REF}) or the local stack (127.0.0.1/localhost). ` +
      `Got DATABASE_URL hosted=${dbHosted}/local=${dbLocal}, ` +
      `SUPABASE_URL hosted=${supaHosted}/local=${supaLocal}. No rows written.`,
  );
  process.exit(1);
}
if (TARGET === 'hosted-test' && !HOSTED_FLAG) {
  console.error(
    `REFUSING TO SEED: target is the HOSTED pilot database (${TEST_REF}) — the deployed ` +
      `stack (Render web + cron, trades-box-1) reads it live, and seeding WIPES its spine ` +
      `tables. If that is really what you want: npm run seed -- --hosted. ` +
      `For the local playground: npm run seed:local. No rows written.`,
  );
  process.exit(1);
}

// Roster wipe/reseed: always on the local stack (harmless there, and the seeded
// schedule/captures reference these refs), opt-in via --with-roster on hosted.
const WITH_ROSTER = TARGET === 'local' || WITH_ROSTER_FLAG;

// FIRM-local "today" (seed tenant timezone = the migration default,
// America/Los_Angeles): matchIdentity consults the capture's firm-local day
// against naive-local assignments, so the demo booking must land on the day
// the matcher will actually look at — the UTC date is already tomorrow every
// evening in LA.
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date()); // YYYY-MM-DD

// The scheduling-foundation migration (assignments/time-off/durations) is applied
// to the LOCAL stack but not yet deployed hosted — probe instead of assuming, so
// the same seed works on both targets until the hosted apply happens.
async function schedulingSchemaPresent() {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    // Probe the NEWEST scheduling table (schedule_events, promise-ladder
    // migration 20260714120000) — probing `assignments` alone would pass on a
    // target that has the 07-04 foundation but not the ladder, and the seed's
    // schedule_events truncate + promise-field writes would then crash mid-run.
    const { rows } = await client.query(
      `select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'schedule_events'`,
    );
    return rows.length > 0;
  } finally {
    await client.end();
  }
}

async function truncateSpine(hasScheduling) {
  // tenants is intentionally left intact (keeps Default Tenant). dropped_audit is
  // standalone (no spine FK) but cleared too, so privacy receipts reset as well.
  // technicians/review_items only go when the roster reseed was explicitly asked for.
  let tables = 'customers, jobs, visits, raw_captures, schedule_entries, dropped_audit';
  if (hasScheduling) tables += ', assignments, technician_time_off, job_type_durations, schedule_events';
  if (WITH_ROSTER) tables += ', technicians, review_items';
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    // tenant_profiles references ONLY tenants, so no cascade above ever
    // reaches it — without this, "rebuild the playground" would silently keep
    // a stale firm profile (review finding). Existence-probed because hosted
    // targets may lag on migrations (schedule_events probe precedent).
    const tp = await client.query(
      `select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'tenant_profiles'`,
    );
    if (tp.rows.length > 0) tables += ', tenant_profiles';
    await client.query(`truncate table ${tables} cascade`);
  } finally {
    await client.end();
  }
}

// Roster rows matching the refs used across the seed captures/schedule. Insert
// lands as 'invited'; flip to 'active' so schedule-matching and admin-tool
// paths see a live team.
async function seedRoster(tenantId) {
  // Seat capacity first (typed layer): the migration defaults are 1 manager /
  // 0 technician seats, which would make the roster inserts below hit the
  // seat-cap trigger. Known values also anchor the admin-tool live probes.
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  const roster = [
    { ref: 'manager-sam', displayName: 'Sam Rivera', tier: 'manager' },
    { ref: 'tech-jane', displayName: 'Jane Alvarez', tier: 'technician' },
    { ref: 'office-dispatch', displayName: 'Office Dispatch', tier: 'technician' },
  ];
  // Rows keyed by ref — the scheduling seeds (and the demo assignment) need the
  // technician UUID, not just the ref.
  const rowsByRef = {};
  for (const person of roster) {
    const row = await insertTechnician({ tenantId, ...person });
    await setTechnicianState(row.id, 'active');
    rowsByRef[person.ref] = row;
  }
  return rowsByRef;
}

// Scheduling foundation seeds: tech-jane's working pattern + cities, one
// vacation range next week, and the hvac duration default. Deterministic:
// fixed day offsets from TODAY. `jane` may be null (hosted target whose roster
// has no tech-jane) — then only the tenant-level duration row is written.
async function seedScheduling(tenantId, jane) {
  await upsertJobTypeDuration(tenantId, 'hvac', 120);
  if (!jane) return { availability: 'skipped (no tech-jane row)', timeOff: 'skipped' };
  const dayOffset = (days) => {
    const d = new Date(`${TODAY}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  await setTechnicianAvailability(jane.id, {
    mon: [['08:00', '17:00']],
    tue: [['08:00', '17:00']],
    wed: [['08:00', '17:00']],
    thu: [['08:00', '17:00']],
    fri: [['08:00', '17:00']],
    sat: [],
    sun: [],
  });
  await setTechnicianServiceCities(jane.id, ['Fresno', 'Clovis']); // stored lowercased
  await addTimeOff({
    tenantId,
    technicianId: jane.id,
    startsOn: dayOffset(7),
    endsOn: dayOffset(9),
    reason: 'vacation',
  });
  return { availability: 'tech-jane Mon–Fri 08–17', timeOff: `${dayOffset(7)}..${dayOffset(9)}` };
}

// Customer/job L3 attributes are STANDING FACTS: wrapped with the L1 capture
// that evidences them (Feature C+D Phase 1), so demo facts are retractable and
// fold exactly like tool-written ones. Plain values are only legal on VISITS —
// a plain customer/job value has no provenance and no removal path (live E2E
// finding 2026-07-14: the seed's plain `pets` kept a retracted dog alive).
const fact = (value, capture) => ({
  value,
  sourceCaptureId: capture.id,
  recordedAt: capture.captured_at,
});

async function seed(tenantId, janeId) {
  // ── Customer A — Maria Gonzalez: full history, the briefing showcase ──────────
  // L1 intake call lands first (no L2 exists yet), then L2 is created from it.
  const aIntake = await appendRawCapture({
    tenantId,
    channel: 'phone_call',
    technicianRef: 'office-dispatch',
    rawText:
      'Intake call: customer says the AC is not cooling, wants service this week. ' +
      'Callback 555-0142. Mentioned a dog in the backyard and a gate code.',
  });
  const maria = await createCustomer({
    tenantId,
    name: 'Maria Gonzalez',
    phone: '555-0142',
    addressLine1: '14 Smith St',
    city: 'Fresno',
    state: 'CA',
    postalCode: '93701',
    // L3 standing facts, evidence = the intake call (snake_case keys: the
    // record_standing_fact tool normalizes to snake_case, so seed keys must
    // collide with — not shadow — tool-written ones, e.g. gate_code).
    attributes: {
      gate_code: fact('1234', aIntake),
      pets: fact('dog in backyard', aIntake),
      prefers: fact('afternoons', aIntake),
    },
    sourceCaptureId: aIntake.id,
  });
  const acJob = await createJob({
    tenantId,
    customerId: maria.id,
    title: 'AC repair',
    jobType: 'hvac',
    priceCents: 40000,
    attributes: { symptom: fact('not cooling', aIntake) }, // L3
    sourceCaptureId: aIntake.id,
  });
  // Walk the legal status machine: open → in_progress → completed → invoiced.
  await updateJobStatus(acJob.id, 'in_progress');
  await updateJobStatus(acJob.id, 'completed');
  await updateJobStatus(acJob.id, 'invoiced');
  // Tech voice note (customer + job known now → stamped; visit_id stays null,
  // provenance flows via visit.source_capture_id, matching the write-path).
  const aTechNote = await appendRawCapture({
    tenantId,
    channel: 'technician_voice',
    technicianRef: 'tech-jane', // matches the visit's technicianName below
    rawText:
      'Replaced the run capacitor, unit is cooling again. Compressor is showing wear — ' +
      'recommend a full unit replacement next season before summer peak.',
    customerId: maria.id,
    jobId: acJob.id,
  });
  const aVisit = await createVisit({
    tenantId,
    jobId: acJob.id,
    technicianName: 'tech-jane',
    laborHours: 2,
    completedAt: `${TODAY}T19:00:00.000Z`,
    attributes: {
      workPerformed: 'Replaced run capacitor',
      followUp: 'Recommend full unit replacement next season',
    }, // L3
    sourceCaptureId: aTechNote.id,
  });

  // ── Customer B — Tom Becker: open job scheduled today ─────────────────────────
  const bWeb = await appendRawCapture({
    tenantId,
    channel: 'web_form',
    technicianRef: 'connector:web',
    rawText: 'Web form: furnace is making a loud rattling noise when it kicks on.',
  });
  const tom = await createCustomer({
    tenantId,
    name: 'Tom Becker',
    phone: '555-0199',
    addressLine1: '99 Ranch Rd',
    city: 'Clovis',
    state: 'CA',
    postalCode: '93611',
    attributes: { prefers: fact('mornings', bWeb) }, // L3 standing fact
    sourceCaptureId: bWeb.id,
  });
  const furnaceJob = await createJob({
    tenantId,
    customerId: tom.id,
    title: 'Furnace inspection',
    jobType: 'hvac',
    status: 'open',
    attributes: { symptom: fact('rattling noise on start', bWeb) }, // L3 standing fact
    sourceCaptureId: bWeb.id,
  });
  // The scheduler-owned booking: tech-jane × Tom's furnace job, CONFIRMED on
  // the NEXT WEEKDAY at 16:00–18:00Z (09:00–11:00 PDT; 08:00–10:00 in PST
  // months) — so Acme's open job below is the ONE unassigned open job.
  // Weekday, not blind "tomorrow": jane's seeded pattern has sat/sun empty, and
  // a Friday seed run would otherwise book her on a day the same seed marks
  // unschedulable — a self-contradicting playground. (Review finding.)
  // 16:00Z is 08/09:00 LA, so the UTC date's weekday == the LA weekday here.
  // janeId is null when the target lacks the scheduling schema or roster row.
  let tomAssignment = null;
  if (janeId) {
    const tomorrow = new Date(`${TODAY}T00:00:00.000Z`);
    do {
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    } while (tomorrow.getUTCDay() === 0 || tomorrow.getUTCDay() === 6);
    const tomorrowDate = tomorrow.toISOString().slice(0, 10);
    tomAssignment = await createAssignment({
      tenantId,
      jobId: furnaceJob.id,
      technicianId: janeId,
      startsAt: `${tomorrowDate}T16:00:00.000Z`,
      endsAt: `${tomorrowDate}T18:00:00.000Z`,
      status: 'confirmed',
      sourceCaptureId: bWeb.id,
    });
    // A TODAY-dated confirmed visit on the same job: the schedule-confirm demo
    // ("is this the address: 99 Ranch Rd?") consults the capture day's
    // ASSIGNMENTS since the mirror retired — matchIdentity keys on "today".
    await createAssignment({
      tenantId,
      jobId: furnaceJob.id,
      technicianId: janeId,
      startsAt: `${TODAY}T17:00:00.000Z`,
      endsAt: `${TODAY}T18:00:00.000Z`,
      status: 'confirmed',
      promiseLevel: 'day',
      promisedDay: TODAY,
      // NOT locked (plan 4b-3): pinning is a human privilege — seeded rows
      // must not wear a pin nobody chose (the freeze would silently skip them).
      sourceCaptureId: bWeb.id,
    });
  }

  // ── Customer C — Acme Offices: email-sourced, shows external_id dedup ─────────
  const cEmail = await appendRawCapture({
    tenantId,
    channel: 'email',
    technicianRef: 'connector:gmail',
    rawText: formatEmailRawText({
      from: 'facilities@acme.example',
      subject: 'Quarterly HVAC maintenance',
      body: 'Please schedule our Q3 rooftop unit maintenance for the 200 Main St office.',
    }),
    externalId: 'seed-gmail-001', // re-delivering this id via the webhook would dedup
    metadata: { from: 'facilities@acme.example', subject: 'Quarterly HVAC maintenance' },
  });
  const acme = await createCustomer({
    tenantId,
    name: 'Acme Offices',
    email: 'facilities@acme.example',
    addressLine1: '200 Main St',
    city: 'Fresno',
    state: 'CA',
    postalCode: '93720',
    sourceCaptureId: cEmail.id,
  });
  const acmeJob = await createJob({
    tenantId,
    customerId: acme.id,
    title: 'Quarterly maintenance',
    jobType: 'hvac',
    status: 'open',
    sourceCaptureId: cEmail.id,
  });

  return {
    maria: { id: maria.id, job: acJob.id, visit: aVisit.id, captures: [aIntake.id, aTechNote.id] },
    tom: {
      id: tom.id,
      job: furnaceJob.id,
      assignment: tomAssignment?.id ?? null,
      captures: [bWeb.id],
    },
    acme: { id: acme.id, job: acmeJob.id, captures: [cEmail.id] },
  };
}

async function main() {
  if (TARGET === 'hosted-test') {
    console.warn(
      `⚠  --hosted: wiping spine tables on the PILOT database (${TEST_REF}) — the deployed ` +
        `stack reads it live` +
        (WITH_ROSTER
          ? '; --with-roster ALSO wipes the roster (badge credentials churn + sandbox ' +
            'provider-generation bumps — see the seed header).'
          : '.'),
    );
  }
  const tenant = await getTenantByName('Default Tenant');
  const hasScheduling = await schedulingSchemaPresent();
  console.log(`Seeding ${TARGET} spine (tenant ${tenant.id})…`);
  await truncateSpine(hasScheduling);
  console.log(`Truncated ${WITH_ROSTER ? 'spine + roster' : 'spine'} tables.`);
  let rosterNote = 'roster untouched';
  let roster = null;
  if (WITH_ROSTER) {
    roster = await seedRoster(tenant.id);
    const refs = Object.keys(roster);
    rosterNote = `${refs.length} roster rows (${refs.join(', ')})`;
  } else {
    console.log(
      'Roster untouched (add --with-roster to wipe/reseed it — re-seeded rows have NO ' +
        'badge fingerprints, so the box re-mints credentials on its next pull).',
    );
  }
  let jane = null;
  let schedNote = 'scheduling schema absent — scheduling seeds skipped';
  if (hasScheduling) {
    jane = roster?.['tech-jane'] ?? (await getTechnician(tenant.id, 'tech-jane'));
    const sched = await seedScheduling(tenant.id, jane);
    schedNote = `scheduling: ${sched.availability}; time off ${sched.timeOff}; hvac=120min`;
  }
  console.log(schedNote);
  const ids = await seed(tenant.id, hasScheduling ? (jane?.id ?? null) : null);
  console.log('Seed complete:');
  console.log(JSON.stringify(ids, null, 2));
  console.log(
    '\nSummary: 3 customers (Maria full history + invoiced job + visit; ' +
      'Tom open furnace job scheduled today' +
      (ids.tom.assignment ? ' + a confirmed assignment next weekday' : '') +
      '; Acme email-sourced open job' +
      (ids.tom.assignment ? ' = the one unassigned open job' : '') +
      '); ' +
      rosterNote +
      '.',
  );
}

main().catch((err) => {
  console.error('SEED FAILED:', err.message);
  process.exit(1);
});
