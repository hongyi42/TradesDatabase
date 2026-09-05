// One-time backfill: copy UPCOMING schedule_entries mirror rows (the retired
// Google-Sheet pipeline) into real `visits` bookings — the DB-owned
// schedule the Telegram-schedule series reads. Idempotent and re-runnable.
//
// Per row (scheduled_start >= today, UTC):
//   technician: resolve technician_ref on the roster — unknown/inactive → SKIP
//     (report; the sheet's loose enforcement guarantees typo'd refs exist).
//   customer:   the row's customer_id link if present, else an exact
//     address_line1 match, else CREATE from the row's denormalized fields.
//   booking:    an open job shell + a CONFIRMED assignment with the row's
//     times (naive-local, exactly as the mirror stored them).
//   ledger:     a 'backfilled' schedule_event carrying {externalRowKey} —
//     ALSO the idempotency key: rows already backfilled are skipped.
//   overlaps:   the DB's no_confirmed_overlap guard refusals are reported and
//     skipped — the run never aborts mid-way.
//
// Targets & flags (seed.mjs idiom). BUILD FIRST — this imports from dist/,
// and a stale dist predating the promise-ladder columns would either crash at
// import or silently write promise-less rows:
//   npm run build && node -r dotenv/config scripts/backfill-schedule.mjs --local [--dry-run]
//   npm run build && node -r dotenv/config scripts/backfill-schedule.mjs --hosted [--dry-run]
//     --hosted is REQUIRED to touch the pilot; --dry-run prints without writing.

import { config as dotenvConfig } from 'dotenv';
import { isLocalDbUrl } from '../dist/testEnvGuard.js';
import { localDateISO } from '../dist/schedule/availability.js';
import {
  getClient,
  getTenantByName,
  getTechnician,
  isInactiveState,
  isOverlapViolation,
  findCustomersByAddress,
  createCustomer,
  createJob,
  createVisit,
  appendScheduleEvent,
  getJobDurationMinutes,
  listVisitsForTechnician,
} from '../dist/db/index.js';

const flag = (name) =>
  process.argv.includes(`--${name}`) ||
  process.env[`npm_config_${name.replaceAll('-', '_')}`] === 'true';
const LOCAL_FLAG = flag('local');
const HOSTED_FLAG = flag('hosted');
const DRY_RUN = flag('dry-run');

if (LOCAL_FLAG) dotenvConfig({ path: '.env.test', override: true });

// Same two-URL agreement + explicit-hosted safety as seed.mjs.
const TEST_REF = 'daqapdlkgxfrhquacprv';
const dbUrl = process.env.DATABASE_URL ?? '';
const supaUrl = process.env.SUPABASE_URL ?? '';
const dbHosted = dbUrl.includes(TEST_REF);
const supaHosted = supaUrl.includes(TEST_REF);
const TARGET =
  dbHosted && supaHosted
    ? 'hosted-test'
    : isLocalDbUrl(dbUrl) && isLocalDbUrl(supaUrl)
      ? 'local'
      : null;
if (!TARGET) {
  console.error(
    'REFUSING TO BACKFILL: DATABASE_URL and SUPABASE_URL must BOTH target the hosted test ' +
      'ref or the local stack. No rows written.',
  );
  process.exit(1);
}
if (TARGET === 'hosted-test' && !HOSTED_FLAG) {
  console.error(
    'REFUSING TO BACKFILL: target is the HOSTED pilot database — pass --hosted explicitly. ' +
      'For the local playground: --local. No rows written.',
  );
  process.exit(1);
}

const tenant = await getTenantByName('Default Tenant');
const tenantId = tenant.id;
// FIRM-local "today", not UTC: mirror rows are naive-local, and an evening run
// (already tomorrow in UTC) would otherwise silently exclude the rest of the
// firm's current day from the backfill.
const today = localDateISO(new Date().toISOString(), tenant.timezone ?? 'UTC');
// Hoisted per-run constants (these were per-row queries): the tenant-default
// duration and a technician memo (a sheet has few distinct refs).
const defaultMinutes = await getJobDurationMinutes(tenantId, null);
const techByRef = new Map();
async function technicianFor(ref) {
  if (!techByRef.has(ref)) techByRef.set(ref, await getTechnician(tenantId, ref));
  return techByRef.get(ref);
}

// Upcoming mirror rows with a start time (NULL starts never scheduled anything).
// Explicit high limit: PostgREST's default max-rows would silently truncate a
// huge mirror; 5000 is far beyond any real pilot sheet — if it ever hits,
// the candidates count in the summary will say so loudly.
const { data: rows, error } = await getClient()
  .from('schedule_entries')
  .select()
  .eq('tenant_id', tenantId)
  .gte('scheduled_start', `${today}T00:00:00.000Z`)
  .order('scheduled_start', { ascending: true })
  .limit(5000);
if (error) throw new Error(`reading schedule_entries failed: ${error.message}`);

// Idempotency ledger: externalRowKeys already backfilled for this tenant.
// Same explicit limit as the candidates read: PostgREST's default max-rows
// would silently truncate the done-set on a big backfill, and a missing key
// whose visit was later cancelled would then be RE-booked on a re-run.
const { data: prior, error: priorErr } = await getClient()
  .from('schedule_events')
  .select('detail')
  .eq('tenant_id', tenantId)
  .eq('kind', 'backfilled')
  .limit(5000);
if (priorErr) throw new Error(`reading schedule_events failed: ${priorErr.message}`);
const done = new Set((prior ?? []).map((e) => e.detail?.externalRowKey).filter(Boolean));

const summary = { candidates: rows.length, booked: 0, alreadyDone: 0, skipped: [] };

for (const row of rows) {
  const key = row.external_row_key;
  const skip = (reason) => summary.skipped.push({ rowKey: key, ref: row.technician_ref, reason });
  if (done.has(key)) {
    summary.alreadyDone++;
    continue;
  }

  const technician = await technicianFor(row.technician_ref);
  if (!technician) {
    skip(`unknown technician ref '${row.technician_ref}'`);
    continue;
  }
  if (isInactiveState(technician.state)) {
    skip(`technician '${row.technician_ref}' is ${technician.state}`);
    continue;
  }

  const startsAt = row.scheduled_start;
  const endsAt =
    row.scheduled_end && row.scheduled_end > startsAt
      ? row.scheduled_end
      : new Date(Date.parse(startsAt) + defaultMinutes * 60_000).toISOString();

  // Overlap PRE-check BEFORE creating anything (booking.ts ordering): the
  // common rejection must leave no orphaned customer/job shell behind, and a
  // re-run must not mint another one. Crash-window caveat: a crash between
  // createVisit and appendScheduleEvent leaves a real booking without its
  // ledger event — the re-run then reports that row here as an overlap skip
  // (mislabeled, but nothing double-books and nothing orphans; resolve by
  // checking the reported row by hand).
  const clashes = (
    await listVisitsForTechnician(technician.id, startsAt, endsAt, ['confirmed'])
  ).length;
  if (clashes > 0) {
    skip('overlaps an existing confirmed booking');
    continue;
  }

  if (DRY_RUN) {
    console.log(
      `[dry-run] would book row ${key}: ${row.customer_name ?? '(no name)'} × ` +
        `${row.technician_ref} ${startsAt} – ${endsAt}` +
        (row.customer_id ? ' (linked customer)' : row.address_line1 ? ' (match/create by address)' : ' (create bare)'),
    );
    summary.booked++;
    continue;
  }

  // Customer: link → exact-address match → create from the row's fields.
  let customerId = row.customer_id;
  if (!customerId && row.address_line1) {
    const matches = await findCustomersByAddress(tenantId, row.address_line1);
    if (matches.length === 1) customerId = matches[0].id;
  }
  if (!customerId) {
    customerId = (
      await createCustomer({
        tenantId,
        name: row.customer_name?.trim() || 'Unknown customer',
        phone: row.phone ?? null,
        addressLine1: row.address_line1 ?? null,
        city: row.city ?? null,
        state: row.state ?? null,
        postalCode: row.postal_code ?? null,
      })
    ).id;
  }

  const job =
    row.job_id ??
    (await createJob({ tenantId, customerId, title: row.customer_name ? `Visit — ${row.customer_name}` : null, status: 'open' })).id;

  try {
    const assignment = await createVisit({
      tenantId,
      jobId: job,
      technicianId: technician.id,
      startsAt,
      endsAt,
      status: 'confirmed',
    });
    await appendScheduleEvent({
      tenantId,
      assignmentId: assignment.id,
      kind: 'backfilled',
      actorRef: 'system',
      detail: { externalRowKey: key, technicianRef: row.technician_ref },
    });
    summary.booked++;
  } catch (err) {
    if (isOverlapViolation(err)) {
      // Pre-check raced (or the crash-window caveat above): report and move on.
      skip('overlaps an existing confirmed booking (raced past the pre-check)');
      continue;
    }
    throw err;
  }
}

console.log(JSON.stringify(summary, null, 2));
if (summary.skipped.length > 0) {
  console.error(
    `${summary.skipped.length} row(s) skipped — review them with the manager before ` +
      'declaring the backfill complete.',
  );
}
