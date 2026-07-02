// Dev seed: load a deterministic sample dataset into the TEST spine for manual /
// live work (briefings, the Composio webhook test, eyeballing the three layers).
//
// NOT for automated tests — `npm test` truncates the DB, so seed data and a test
// run can't coexist. Run this AFTER tests to restore the playground.
//
// Mode: truncate-then-seed. Every run wipes the spine tables, then inserts the
// same fixed set — deterministic, re-runnable, no duplicates. (An additive mode
// can be added later behind a flag.)
//
// Writes go through the typed src/db layer (compiled to dist/), so provenance
// links, L3 attributes, and legal status transitions follow the same paths the
// app uses. The only raw SQL is the TRUNCATE (the db layer exposes no delete —
// L1 is append-only — and TRUNCATE doesn't fire the row-level append-only trigger).
//
// Usage: `npm run seed` (builds first, loads .env via `-r dotenv/config`).

import pg from 'pg';
import {
  createCustomer,
  createJob,
  createVisit,
  updateJobStatus,
  appendRawCapture,
  upsertScheduleEntry,
  insertTechnician,
  setTechnicianState,
  setTenantSeats,
} from '../dist/db/index.js';
import { formatEmailRawText } from '../dist/email/format.js';

// --- Safety: refuse to run against anything but the TEST project ----------------
// Both connection strings must name the test ref. A swapped .env (prod or any
// other DB) aborts before a single row is touched.
const TEST_REF = 'daqapdlkgxfrhquacprv';
const dbUrl = process.env.DATABASE_URL ?? '';
const supaUrl = process.env.SUPABASE_URL ?? '';
if (!dbUrl.includes(TEST_REF) || !supaUrl.includes(TEST_REF)) {
  console.error(
    `REFUSING TO SEED: DATABASE_URL and SUPABASE_URL must both target the test ref ` +
      `(${TEST_REF}). Got DATABASE_URL match=${dbUrl.includes(TEST_REF)}, ` +
      `SUPABASE_URL match=${supaUrl.includes(TEST_REF)}. No rows written.`,
  );
  process.exit(1);
}

// Default Tenant (seeded by the context-spine migration). Single-tenant dev.
const TENANT_ID = '82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18';

// Today's UTC date, so customer B's schedule entry lands on "today" for the
// schedule-confirm / next-visit briefing path (listScheduleForTechnicianOnDate
// matches on the UTC calendar day).
const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

async function truncateSpine() {
  // tenants is intentionally left intact (keeps Default Tenant). dropped_audit is
  // standalone (no spine FK) but cleared too, so privacy receipts reset as well.
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(
      'truncate table customers, jobs, visits, raw_captures, schedule_entries, dropped_audit, technicians, review_items cascade',
    );
  } finally {
    await client.end();
  }
}

// Roster rows matching the refs used across the seed captures/schedule. Insert
// lands as 'invited'; flip to 'active' so schedule-matching and admin-tool
// paths see a live team.
async function seedRoster() {
  // Seat capacity first (typed layer): the migration defaults are 1 manager /
  // 0 technician seats, which would make the roster inserts below hit the
  // seat-cap trigger. Known values also anchor the admin-tool live probes.
  await setTenantSeats(TENANT_ID, { managerSeats: 2, technicianSeats: 5 });
  const roster = [
    { ref: 'manager-sam', displayName: 'Sam Rivera', tier: 'manager' },
    { ref: 'tech-jane', displayName: 'Jane Alvarez', tier: 'technician' },
    { ref: 'office-dispatch', displayName: 'Office Dispatch', tier: 'technician' },
  ];
  for (const person of roster) {
    const row = await insertTechnician({ tenantId: TENANT_ID, ...person });
    await setTechnicianState(row.id, 'active');
  }
  return roster.map((r) => r.ref);
}

async function seed() {
  // ── Customer A — Maria Gonzalez: full history, the briefing showcase ──────────
  // L1 intake call lands first (no L2 exists yet), then L2 is created from it.
  const aIntake = await appendRawCapture({
    tenantId: TENANT_ID,
    channel: 'phone_call',
    technicianRef: 'office-dispatch',
    rawText:
      'Intake call: customer says the AC is not cooling, wants service this week. ' +
      'Callback 555-0142. Mentioned a dog in the backyard and a gate code.',
  });
  const maria = await createCustomer({
    tenantId: TENANT_ID,
    name: 'Maria Gonzalez',
    phone: '555-0142',
    addressLine1: '14 Smith St',
    city: 'Fresno',
    state: 'CA',
    postalCode: '93701',
    attributes: { gateCode: '1234', pets: 'dog in backyard', prefers: 'afternoons' }, // L3
    sourceCaptureId: aIntake.id,
  });
  const acJob = await createJob({
    tenantId: TENANT_ID,
    customerId: maria.id,
    title: 'AC repair',
    jobType: 'hvac',
    priceCents: 40000,
    attributes: { symptom: 'not cooling' }, // L3
    sourceCaptureId: aIntake.id,
  });
  // Walk the legal status machine: open → in_progress → completed → invoiced.
  await updateJobStatus(acJob.id, 'in_progress');
  await updateJobStatus(acJob.id, 'completed');
  await updateJobStatus(acJob.id, 'invoiced');
  // Tech voice note (customer + job known now → stamped; visit_id stays null,
  // provenance flows via visit.source_capture_id, matching the write-path).
  const aTechNote = await appendRawCapture({
    tenantId: TENANT_ID,
    channel: 'technician_voice',
    technicianRef: 'tech-jane', // matches the visit's technicianName below
    rawText:
      'Replaced the run capacitor, unit is cooling again. Compressor is showing wear — ' +
      'recommend a full unit replacement next season before summer peak.',
    customerId: maria.id,
    jobId: acJob.id,
  });
  const aVisit = await createVisit({
    tenantId: TENANT_ID,
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
    tenantId: TENANT_ID,
    channel: 'web_form',
    technicianRef: 'connector:web',
    rawText: 'Web form: furnace is making a loud rattling noise when it kicks on.',
  });
  const tom = await createCustomer({
    tenantId: TENANT_ID,
    name: 'Tom Becker',
    phone: '555-0199',
    addressLine1: '99 Ranch Rd',
    city: 'Clovis',
    state: 'CA',
    postalCode: '93611',
    attributes: { prefers: 'mornings' }, // L3
    sourceCaptureId: bWeb.id,
  });
  const furnaceJob = await createJob({
    tenantId: TENANT_ID,
    customerId: tom.id,
    title: 'Furnace inspection',
    jobType: 'hvac',
    status: 'open',
    attributes: { symptom: 'rattling noise on start' }, // L3
    sourceCaptureId: bWeb.id,
  });
  const tomSchedule = await upsertScheduleEntry({
    tenantId: TENANT_ID,
    technicianRef: 'tech-jane',
    externalRowKey: 'seed-sched-tom', // stable → re-run updates in place
    customerId: tom.id,
    jobId: furnaceJob.id,
    customerName: 'Tom Becker',
    addressLine1: '99 Ranch Rd',
    city: 'Clovis',
    state: 'CA',
    postalCode: '93611',
    phone: '555-0199',
    scheduledStart: `${TODAY}T17:00:00.000Z`,
    scheduledEnd: `${TODAY}T18:00:00.000Z`,
    source: 'seed',
  });

  // ── Customer C — Acme Offices: email-sourced, shows external_id dedup ─────────
  const cEmail = await appendRawCapture({
    tenantId: TENANT_ID,
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
    tenantId: TENANT_ID,
    name: 'Acme Offices',
    email: 'facilities@acme.example',
    addressLine1: '200 Main St',
    city: 'Fresno',
    state: 'CA',
    postalCode: '93720',
    sourceCaptureId: cEmail.id,
  });
  const acmeJob = await createJob({
    tenantId: TENANT_ID,
    customerId: acme.id,
    title: 'Quarterly maintenance',
    jobType: 'hvac',
    status: 'open',
    sourceCaptureId: cEmail.id,
  });

  return {
    maria: { id: maria.id, job: acJob.id, visit: aVisit.id, captures: [aIntake.id, aTechNote.id] },
    tom: { id: tom.id, job: furnaceJob.id, schedule: tomSchedule.id, captures: [bWeb.id] },
    acme: { id: acme.id, job: acmeJob.id, captures: [cEmail.id] },
  };
}

async function main() {
  console.log(`Seeding TEST project ${TEST_REF} (tenant ${TENANT_ID})…`);
  await truncateSpine();
  console.log('Truncated spine tables.');
  const refs = await seedRoster();
  console.log(`Roster seeded: ${refs.join(', ')}`);
  const ids = await seed();
  console.log('Seed complete:');
  console.log(JSON.stringify(ids, null, 2));
  console.log(
    '\nSummary: 3 customers (Maria full history + invoiced job + visit; ' +
      'Tom open furnace job scheduled today; Acme email-sourced open job); ' +
      '3 roster rows (manager-sam, tech-jane, office-dispatch).',
  );
}

main().catch((err) => {
  console.error('SEED FAILED:', err.message);
  process.exit(1);
});
