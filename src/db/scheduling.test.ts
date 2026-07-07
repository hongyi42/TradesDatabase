import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { setTenantSeats } from './tenants.js';
import {
  insertTechnician,
  setTechnicianAvailability,
  setTechnicianServiceCities,
  type Technician,
  type WeeklyPattern,
} from './technicians.js';
import { addTimeOff, deleteTimeOff, listTimeOffForTechnician } from './timeOff.js';
import { getJobDurationMinutes, upsertJobTypeDuration } from './jobTypeDurations.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';
import {
  createAssignment,
  isOverlapViolation,
  listAssignmentsForJob,
  listAssignmentsForTechnician,
  listUnassignedOpenJobs,
  rescheduleAssignment,
  updateAssignmentStatus,
} from './assignments.js';

// Integration against the TEST project, self-cleaning (pattern:
// technicians.test.ts, incl. the roster truncate/seat-restore discipline).
//
// Truncate discipline (load-bearing): beforeAll AND afterAll truncate the
// scheduling-adjacent tables. Phase 3's listUnassignedOpenJobs is tenant-wide,
// so seeded open jobs (npm run seed leaves two) would pollute exactly-these
// assertions without the beforeAll claim; the customers/jobs this file creates
// for FK chains must self-clean, and `cascade` sweeps `assignments`.
const TRUNCATE =
  'truncate table customers, jobs, technicians, technician_time_off, job_type_durations, review_items cascade';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let tech: Technician;

const VALID_PATTERN: WeeklyPattern = {
  mon: [['08:00', '17:00']],
  tue: [['08:00', '12:00'], ['13:00', '17:00']],
  wed: [['08:00', '17:00']],
  thu: [['08:00', '17:00']],
  fri: [['08:00', '17:00']],
  sat: [],
  sun: [],
};

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  await pg.query(TRUNCATE);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  tech = await insertTechnician({ tenantId, ref: 'sched-tech', displayName: 'Sched Tech' });
});

afterAll(async () => {
  await pg.query(TRUNCATE);
  // Restore the seed capacity (2/5) — same discipline as technicians.test.ts.
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

describe('technician availability + service cities', () => {
  test('valid pattern stores and reads back', async () => {
    const updated = await setTechnicianAvailability(tech.id, VALID_PATTERN);
    expect(updated.availability).toEqual(VALID_PATTERN);
  });

  test('pattern validation rejects bad shapes before any write', async () => {
    // invalid time
    await expect(
      setTechnicianAvailability(tech.id, {
        ...VALID_PATTERN,
        mon: [['25:00', '26:00']],
      }),
    ).rejects.toThrow(/invalid time/);
    // start >= end
    await expect(
      setTechnicianAvailability(tech.id, {
        ...VALID_PATTERN,
        mon: [['17:00', '08:00']],
      }),
    ).rejects.toThrow(/start must be before end/);
    // missing day key
    const missingSun = { ...VALID_PATTERN } as Record<string, unknown>;
    delete missingSun.sun;
    await expect(
      setTechnicianAvailability(tech.id, missingSun as WeeklyPattern),
    ).rejects.toThrow(/missing day 'sun'/);
    // '24:00' is a legal END (until-midnight shift) but never a start.
    await expect(
      setTechnicianAvailability(tech.id, { ...VALID_PATTERN, fri: [['16:00', '24:00']] }),
    ).resolves.toBeDefined();
    await expect(
      setTechnicianAvailability(tech.id, { ...VALID_PATTERN, fri: [['24:00', '24:00']] }),
    ).rejects.toThrow(/invalid time/);
    // restore the canonical pattern for the read-back assertion below
    await setTechnicianAvailability(tech.id, VALID_PATTERN);
    // stored pattern untouched by the rejected writes
    const { data } = await getClient()
      .from('technicians')
      .select('availability')
      .eq('id', tech.id)
      .single();
    expect(data?.availability).toEqual(VALID_PATTERN);
  });

  test('cities are trimmed, lowercased, empties dropped', async () => {
    const updated = await setTechnicianServiceCities(tech.id, ['  Fresno ', '', 'CLOVIS', '  ']);
    expect(updated.service_cities).toEqual(['fresno', 'clovis']);
  });
});

describe('time off', () => {
  test('overlap query returns ranges straddling the window edges; delete is tenant-guarded', async () => {
    const inside = await addTimeOff({
      tenantId,
      technicianId: tech.id,
      startsOn: '2026-08-10',
      endsOn: '2026-08-12',
      reason: 'vacation',
    });
    const straddlesStart = await addTimeOff({
      tenantId,
      technicianId: tech.id,
      startsOn: '2026-08-01',
      endsOn: '2026-08-05',
    });
    const straddlesEnd = await addTimeOff({
      tenantId,
      technicianId: tech.id,
      startsOn: '2026-08-14',
      endsOn: '2026-08-18',
    });
    const outside = await addTimeOff({
      tenantId,
      technicianId: tech.id,
      startsOn: '2026-08-20',
      endsOn: '2026-08-22',
    });
    await addTimeOff({
      tenantId,
      technicianId: tech.id,
      startsOn: '2026-08-01',
      endsOn: '2026-08-02',
    }); // entirely before the window → excluded

    // Window [08-04, 08-15]: 'inside' fully within; 'straddlesStart' overlaps the
    // leading edge (ends inside); 'straddlesEnd' overlaps the trailing edge
    // (starts inside, ends after); ranges entirely before/after → excluded.
    const hits = await listTimeOffForTechnician(tech.id, '2026-08-04', '2026-08-15');
    expect(hits.map((r) => r.id).sort()).toEqual(
      [inside.id, straddlesStart.id, straddlesEnd.id].sort(),
    );

    // DB check constraint: ends_on >= starts_on.
    await expect(
      addTimeOff({ tenantId, technicianId: tech.id, startsOn: '2026-08-05', endsOn: '2026-08-01' }),
    ).rejects.toMatchObject({ code: '23514' });

    // Tenant-guarded delete: wrong tenant → false, row survives; right → true.
    expect(await deleteTimeOff(outside.id, '00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(await deleteTimeOff(outside.id, tenantId)).toBe(true);
    expect(await deleteTimeOff(outside.id, tenantId)).toBe(false); // already gone
  });
});

describe('assignments', () => {
  // One customer + job per test where isolation matters; FK chain helpers.
  async function makeJob(title: string) {
    const customer = await createCustomer({ tenantId, name: `Cust for ${title}` });
    return createJob({ tenantId, customerId: customer.id, title, status: 'open' });
  }
  const T = (h: number) => `2026-09-01T${String(h).padStart(2, '0')}:00:00.000Z`;

  test('legal transition walk proposed→confirmed→completed; illegal transitions throw', async () => {
    const job = await makeJob('walk');
    const a = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: T(8),
      endsAt: T(10),
    });
    expect(a.status).toBe('proposed');
    expect((await updateAssignmentStatus(a.id, 'confirmed')).status).toBe('confirmed');
    expect((await updateAssignmentStatus(a.id, 'completed')).status).toBe('completed');
    // completed is terminal — no cancel after the work happened.
    await expect(updateAssignmentStatus(a.id, 'cancelled')).rejects.toThrow(
      /Illegal assignment status transition: completed → cancelled/,
    );
  });

  test('out-of-band status flip surfaces instead of being overwritten', async () => {
    const job = await makeJob('concurrent');
    const a = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: T(8),
      endsAt: T(10),
    });
    // Another writer cancels it behind our back (raw update, no typed layer).
    await pg.query(`update assignments set status = 'cancelled' where id = $1`, [a.id]);
    // The transition validates against a fresh read → illegal from 'cancelled'.
    // (The narrower .eq('status') zero-row race branch — a flip BETWEEN the
    // read and the update — is not reachable from in-process tests; same
    // accepted gap as jobs.ts's guard. This proves the flip surfaces.)
    await expect(updateAssignmentStatus(a.id, 'confirmed')).rejects.toThrow(
      /Illegal assignment status transition: cancelled → confirmed/,
    );
  });

  test('confirming an overlapping slot raises the DB guard → isOverlapViolation', async () => {
    // Shares 2026-09-01 with the walk test above — safe only because walk's
    // row ends terminal 'completed' (outside the constraint's WHERE). If this
    // test sees an unexpected 23P01 on the FIRST insert, walk broke mid-test.
    const job = await makeJob('overlap');
    const first = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: T(9),
      endsAt: T(11),
      status: 'confirmed',
    });
    // Overlapping proposal is fine (alternatives may coexist)...
    const rival = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: T(10),
      endsAt: T(12),
    });
    // ...but confirming it hits no_confirmed_overlap.
    let err: unknown;
    await updateAssignmentStatus(rival.id, 'confirmed').catch((e) => {
      err = e;
    });
    expect(err).toBeDefined();
    expect(isOverlapViolation(err)).toBe(true);
    expect(isOverlapViolation(new Error('random'))).toBe(false);
    // Loser untouched: still proposed; winner still confirmed.
    const rows = await listAssignmentsForJob(job.id);
    expect(rows.find((r) => r.id === rival.id)?.status).toBe('proposed');
    expect(rows.find((r) => r.id === first.id)?.status).toBe('confirmed');
  });

  test('reschedule = cancel(reason kept) + fresh proposed row; job history shows both', async () => {
    const job = await makeJob('reschedule');
    // Own calendar day: the 'overlap' test legitimately leaves a confirmed
    // 09–11 row for this same technician on 2026-09-01, and the DB guard is
    // table-wide — colliding fixtures would (correctly) be rejected.
    const original = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-09-05T09:00:00.000Z',
      endsAt: '2026-09-05T11:00:00.000Z',
      status: 'confirmed',
    });
    const { cancelled, created } = await rescheduleAssignment(original.id, {
      startsAt: '2026-09-05T14:00:00.000Z',
      endsAt: '2026-09-05T16:00:00.000Z',
      reason: 'customer asked for the afternoon',
    });
    expect(cancelled.id).toBe(original.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.reason).toBe('customer asked for the afternoon');
    expect(created.status).toBe('proposed');
    expect(created.technician_id).toBe(tech.id); // same tech unless overridden
    // New row carries exactly the requested times (normalize tz formatting).
    expect(new Date(created.starts_at).toISOString()).toBe('2026-09-05T14:00:00.000Z');
    expect(new Date(created.ends_at).toISOString()).toBe('2026-09-05T16:00:00.000Z');

    const history = await listAssignmentsForJob(job.id);
    expect(history.map((r) => r.id)).toEqual([created.id, cancelled.id]); // newest first
  });

  test('reschedule with an invalid new range throws BEFORE cancelling anything', async () => {
    const job = await makeJob('reschedule-guard');
    const original = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-09-06T09:00:00.000Z',
      endsAt: '2026-09-06T11:00:00.000Z',
      status: 'confirmed',
    });
    // Swapped start/end must not destroy the confirmed booking.
    await expect(
      rescheduleAssignment(original.id, {
        startsAt: '2026-09-06T16:00:00.000Z',
        endsAt: '2026-09-06T14:00:00.000Z',
        reason: 'oops',
      }),
    ).rejects.toThrow(/invalid time range.*nothing cancelled/);
    const rows = await listAssignmentsForJob(job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('confirmed'); // untouched
  });

  test('listAssignmentsForTechnician: window overlap, live statuses by default', async () => {
    const job = await makeJob('window');
    const inWindow = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-09-02T09:00:00.000Z',
      endsAt: '2026-09-02T11:00:00.000Z',
      status: 'confirmed',
    });
    const cancelledRow = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-09-02T12:00:00.000Z',
      endsAt: '2026-09-02T13:00:00.000Z',
    });
    await updateAssignmentStatus(cancelledRow.id, 'cancelled');
    await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-09-03T09:00:00.000Z', // outside the window
      endsAt: '2026-09-03T11:00:00.000Z',
    });

    const hits = await listAssignmentsForTechnician(
      tech.id,
      '2026-09-02T00:00:00.000Z',
      '2026-09-03T00:00:00.000Z',
    );
    // cancelled excluded by the default statuses; next-day row outside window.
    expect(hits.map((r) => r.id)).toEqual([inWindow.id]);
  });

  test('listUnassignedOpenJobs: excludes live-assigned jobs, includes cancelled-only and bare jobs', async () => {
    // Claimed table state (truncate discipline): exactly the jobs this block
    // created exist. Jobs from tests above all carry live rows EXCEPT
    // 'concurrent' (cancelled out-of-band) and 'reschedule'/'overlap'/'walk'
    // (live or terminal rows) — build two fresh, unambiguous cases instead.
    const bare = await makeJob('bare — never assigned');
    const cancelledOnly = await makeJob('cancelled-only');
    const c = await createAssignment({
      tenantId,
      jobId: cancelledOnly.id,
      technicianId: tech.id,
      startsAt: T(8),
      endsAt: T(9),
    });
    await updateAssignmentStatus(c.id, 'cancelled');

    const queue = await listUnassignedOpenJobs(tenantId);
    const ids = queue.map((j) => j.id);
    expect(ids).toContain(bare.id); // no assignment at all
    expect(ids).toContain(cancelledOnly.id); // only a cancelled row → needs rebooking
    // 'overlap' has a confirmed row; 'window' has proposed+confirmed rows.
    const byTitle = new Map(queue.map((j) => [j.title, j]));
    expect(byTitle.has('overlap')).toBe(false);
    expect(byTitle.has('window')).toBe(false);
    // 'walk' ended completed (terminal) — its job carries no LIVE assignment,
    // so it re-enters the queue (job.status is still 'open'; closing the JOB
    // is the job state machine's business, not the assignment's).
    expect(byTitle.has('walk')).toBe(true);
  });
});

describe('job type durations', () => {
  test('upsert inserts then updates in place; lookup falls back to tenant default', async () => {
    const first = await upsertJobTypeDuration(tenantId, 'hvac', 90);
    expect(first.minutes).toBe(90);
    const updated = await upsertJobTypeDuration(tenantId, 'hvac', 150);
    expect(updated.id).toBe(first.id); // same row, not a duplicate
    expect(updated.minutes).toBe(150);

    expect(await getJobDurationMinutes(tenantId, 'hvac')).toBe(150);
    // Case/whitespace variants match: job_type is normalized on write AND read
    // (extractor-written jobs carry verbatim casing like 'Install').
    expect(await getJobDurationMinutes(tenantId, ' HVAC ')).toBe(150);
    const recased = await upsertJobTypeDuration(tenantId, 'Hvac', 200);
    expect(recased.id).toBe(first.id); // normalized write hits the same row
    // Unset type and untyped job both fall back to tenants.default_job_minutes
    // (migration default 120).
    expect(await getJobDurationMinutes(tenantId, 'plumbing')).toBe(120);
    expect(await getJobDurationMinutes(tenantId, null)).toBe(120);
  });
});
