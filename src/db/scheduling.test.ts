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
import {
  createJob,
  getJob,
  updateJobDetails,
  DURATION_LADDER,
  MAX_DURATION_MINUTES,
  formatDuration,
} from './jobs.js';
import {
  createAssignment,
  getAssignmentForTenant,
  isOverlapViolation,
  listAssignmentsForJob,
  listAssignmentsForTechnician,
  listAssignmentsForTenant,
  listUnassignedAssignmentsWithRefs,
  listUnassignedOpenJobs,
  listUnscheduledOpenJobsWithCustomer,
  rescheduleAssignment,
  updateAssignmentStatus,
} from './assignments.js';
import {
  appendScheduleEvent,
  latestScheduleVersion,
  listScheduleEventsSince,
} from './scheduleEvents.js';

// Integration against the TEST project, self-cleaning (pattern:
// technicians.test.ts, incl. the roster truncate/seat-restore discipline).
//
// Truncate discipline (load-bearing): beforeAll AND afterAll truncate the
// scheduling-adjacent tables. Phase 3's listUnassignedOpenJobs is tenant-wide,
// so seeded open jobs (npm run seed leaves two) would pollute exactly-these
// assertions without the beforeAll claim; the customers/jobs this file creates
// for FK chains must self-clean, and `cascade` sweeps `assignments`.
const TRUNCATE =
  'truncate table customers, jobs, technicians, technician_time_off, job_type_durations, review_items, schedule_events cascade';

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
    expect(new Date(created.starts_at as string).toISOString()).toBe('2026-09-05T14:00:00.000Z');
    expect(new Date(created.ends_at as string).toISOString()).toBe('2026-09-05T16:00:00.000Z');

    const history = await listAssignmentsForJob(job.id);
    expect(history.map((r) => r.id)).toEqual([created.id, cancelled.id]); // newest first
  });

  test('reschedule technicianId:null DETACHES; undefined keeps; time_only rows accept a NULL promised_day', async () => {
    const job = await makeJob('reschedule-detach');
    const original = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-09-25T09:00:00.000Z',
      endsAt: '2026-09-25T11:00:00.000Z',
      status: 'confirmed',
    });
    // Explicit null = detach (the !== undefined idiom — `??` would resurrect
    // the old technician; plan 4a.5).
    const detached = await rescheduleAssignment(original.id, {
      startsAt: '2026-09-25T09:00:00.000Z',
      endsAt: '2026-09-25T11:00:00.000Z',
      technicianId: null,
      reason: 'parked',
    });
    expect(detached.created.technician_id).toBeNull();
    // Omitted still means "same technician" — the pre-4a.5 contract holds.
    const kept = await rescheduleAssignment(detached.created.id, {
      startsAt: '2026-09-25T13:00:00.000Z',
      endsAt: '2026-09-25T15:00:00.000Z',
      reason: 'shifted',
    });
    expect(kept.created.technician_id).toBeNull(); // old row's (null) carried
    // time_only + promised_day NULL passes the swapped CHECK constraint.
    const timeOnly = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: '2026-09-26T09:00:00.000Z',
      endsAt: '2026-09-26T10:00:00.000Z',
      promiseLevel: 'time_only',
      promisedDay: null,
    });
    expect(timeOnly.promise_level).toBe('time_only');
    expect(timeOnly.promised_day).toBeNull();
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

describe('unplaced visits (Plan 4b-2): shapes + the narrowed overlap guard)', () => {
  async function makeJob(title: string) {
    const customer = await createCustomer({ tenantId, name: `Cust for ${title}` });
    return createJob({ tenantId, customerId: customer.id, title, status: 'open' });
  }

  test('an UNPLACED row inserts: null times, day range, confirmed', async () => {
    const job = await makeJob('unplaced-insert');
    const a = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      earliestDate: '2026-10-01',
      latestDate: '2026-10-03',
      status: 'confirmed',
    });
    expect(a.starts_at).toBeNull();
    expect(a.ends_at).toBeNull();
    expect(a.earliest_date).toBe('2026-10-01');
    expect(a.latest_date).toBe('2026-10-03');
  });

  test('half-filled shapes are rejected: typed layer XOR + the DB check itself', async () => {
    const job = await makeJob('half-filled');
    // Typed layer: neither shape.
    await expect(
      createAssignment({ tenantId, jobId: job.id, technicianId: null, startsAt: null, endsAt: null }),
    ).rejects.toThrow(/BOTH times .* or BOTH range dates/);
    // Typed layer: a complete shape mixed with HALF of the other (the
    // cross-shape the plain XOR missed — review finding).
    await expect(
      createAssignment({
        tenantId, jobId: job.id, technicianId: null,
        startsAt: '2026-10-05T09:00:00.000Z', endsAt: '2026-10-05T10:00:00.000Z',
        earliestDate: '2026-10-05',
      }),
    ).rejects.toThrow(/BOTH times .* or BOTH range dates/);
    // Typed layer: both shapes at once.
    await expect(
      createAssignment({
        tenantId, jobId: job.id, technicianId: null,
        startsAt: '2026-10-05T09:00:00.000Z', endsAt: '2026-10-05T10:00:00.000Z',
        earliestDate: '2026-10-05', latestDate: '2026-10-05',
      }),
    ).rejects.toThrow(/BOTH times .* or BOTH range dates/);
    // The DB check is the backstop — prove it fires on a RAW half-filled
    // insert the typed layer never sees (times + range mixed).
    await expect(
      pg.query(
        `insert into assignments (tenant_id, job_id, starts_at, ends_at, earliest_date, latest_date)
         values ($1, $2, '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z', '2026-10-05', '2026-10-05')`,
        [tenantId, job.id],
      ),
    ).rejects.toThrow(/assignment_placed_or_windowed/);
    // The all-null "neither" row must be rejected by the CONSTRAINT itself,
    // not only the typed layer (review nit — both arms demand non-nulls).
    await expect(
      pg.query(
        `insert into assignments (tenant_id, job_id) values ($1, $2)`,
        [tenantId, job.id],
      ),
    ).rejects.toThrow(/assignment_placed_or_windowed/);
    // And on an inverted range.
    await expect(
      pg.query(
        `insert into assignments (tenant_id, job_id, earliest_date, latest_date)
         values ($1, $2, '2026-10-06', '2026-10-05')`,
        [tenantId, job.id],
      ),
    ).rejects.toThrow(/assignment_placed_or_windowed/);
  });

  test('the narrowed guard: placed overlaps still raise 23P01; unplaced twins both insert', async () => {
    const job = await makeJob('narrowed-guard');
    const D = (h: number) => `2026-10-12T${String(h).padStart(2, '0')}:00:00.000Z`;
    // Placed protection is EXACTLY as before.
    await createAssignment({
      tenantId, jobId: job.id, technicianId: tech.id,
      startsAt: D(8), endsAt: D(10), status: 'confirmed',
    });
    try {
      await createAssignment({
        tenantId, jobId: job.id, technicianId: tech.id,
        startsAt: D(9), endsAt: D(11), status: 'confirmed',
      });
      expect.unreachable('overlapping placed insert must raise the exclusion constraint');
    } catch (err) {
      expect(isOverlapViolation(err)).toBe(true);
    }
    // Two UNPLACED confirmed rows for the SAME technician both insert — an
    // unplaced row is demand, not schedule; tstzrange(null,null) would have
    // blocked the whole calendar without the starts_at predicate.
    const u1 = await createAssignment({
      tenantId, jobId: job.id, technicianId: tech.id,
      startsAt: null, endsAt: null,
      earliestDate: '2026-10-12', latestDate: '2026-10-12', status: 'confirmed',
    });
    const u2 = await createAssignment({
      tenantId, jobId: job.id, technicianId: tech.id,
      startsAt: null, endsAt: null,
      earliestDate: '2026-10-12', latestDate: '2026-10-14', status: 'confirmed',
    });
    expect(u1.id).not.toBe(u2.id);
  });
});

describe('promise ladder + schedule events (Plan 1, schedule core)', () => {
  async function makeJob(title: string) {
    const customer = await createCustomer({ tenantId, name: `Cust for ${title}` });
    return createJob({ tenantId, customerId: customer.id, title, status: 'open' });
  }

  test('promise columns round-trip; defaults are none/null/false', async () => {
    const job = await makeJob('promise-roundtrip');
    const bare = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-01T09:00:00.000Z',
      endsAt: '2026-10-01T11:00:00.000Z',
    });
    expect(bare.promise_level).toBe('none');
    expect(bare.promised_day).toBeNull();
    expect(bare.locked).toBe(false);

    const promised = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-02T09:00:00.000Z',
      endsAt: '2026-10-02T11:00:00.000Z',
      promiseLevel: 'day',
      promisedDay: '2026-10-02',
      locked: true,
    });
    expect(promised.promise_level).toBe('day');
    expect(promised.promised_day).toBe('2026-10-02');
    expect(promised.locked).toBe(true);
  });

  test('DB check rejects a promise without a promised day', async () => {
    const job = await makeJob('promise-check');
    await expect(
      createAssignment({
        tenantId,
        jobId: job.id,
        technicianId: tech.id,
        startsAt: '2026-10-03T09:00:00.000Z',
        endsAt: '2026-10-03T11:00:00.000Z',
        promiseLevel: 'day', // promisedDay deliberately omitted
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('reschedule carries promise fields by default and honors status/overrides', async () => {
    const job = await makeJob('promise-carry');
    const original = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-06T09:00:00.000Z',
      endsAt: '2026-10-06T11:00:00.000Z',
      status: 'confirmed',
      promiseLevel: 'day',
      promisedDay: '2026-10-06',
      locked: true,
    });
    // Default: promise fields carry, status falls back to 'proposed'.
    const first = await rescheduleAssignment(original.id, {
      startsAt: '2026-10-06T13:00:00.000Z',
      endsAt: '2026-10-06T15:00:00.000Z',
      reason: 'carry check',
    });
    expect(first.created.status).toBe('proposed');
    expect(first.created.promise_level).toBe('day');
    expect(first.created.promised_day).toBe('2026-10-06');
    expect(first.created.locked).toBe(true);
    // Overrides: status 'confirmed' + a new promised day (the manual-move shape).
    const second = await rescheduleAssignment(first.created.id, {
      startsAt: '2026-10-07T09:00:00.000Z',
      endsAt: '2026-10-07T11:00:00.000Z',
      reason: 'move to the 7th',
      status: 'confirmed',
      promisedDay: '2026-10-07',
    });
    expect(second.created.status).toBe('confirmed');
    expect(second.created.promised_day).toBe('2026-10-07');
    expect(second.created.promise_level).toBe('day'); // still carried
  });

  test('getAssignmentForTenant tenant-guards; listAssignmentsForTenant spans technicians, confirmed-only default, overlap edges', async () => {
    const job = await makeJob('tenant-list');
    const otherTech = await insertTechnician({
      tenantId,
      ref: 'sched-tech-2',
      displayName: 'Sched Tech Two',
    });
    const a = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-10T09:00:00.000Z',
      endsAt: '2026-10-10T11:00:00.000Z',
      status: 'confirmed',
    });
    const b = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: otherTech.id,
      // Straddles the window start — overlap semantics must include it.
      startsAt: '2026-10-09T23:00:00.000Z',
      endsAt: '2026-10-10T01:00:00.000Z',
      status: 'confirmed',
    });
    await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: otherTech.id,
      startsAt: '2026-10-10T13:00:00.000Z', // proposed → excluded by default
      endsAt: '2026-10-10T14:00:00.000Z',
    });
    // Half-open [from, to) boundary pins (Phase-3 day windows lean on these):
    // ends exactly AT the window start / starts exactly AT the window end.
    await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-09T22:00:00.000Z',
      endsAt: '2026-10-10T00:00:00.000Z', // == fromISO → excluded
      status: 'confirmed',
    });
    await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-11T00:00:00.000Z', // == toISO → excluded
      endsAt: '2026-10-11T02:00:00.000Z',
      status: 'confirmed',
    });

    expect(await getAssignmentForTenant(a.id, tenantId)).toMatchObject({ id: a.id });
    expect(await getAssignmentForTenant(a.id, '00000000-0000-0000-0000-000000000000')).toBeNull();

    const day = await listAssignmentsForTenant(
      tenantId,
      '2026-10-10T00:00:00.000Z',
      '2026-10-11T00:00:00.000Z',
    );
    expect(day.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  test('events append; latestScheduleVersion is monotonic; since-feed returns newer only', async () => {
    expect(await latestScheduleVersion(tenantId)).toBe(0); // truncate discipline
    const e1 = await appendScheduleEvent({
      tenantId,
      kind: 'booked',
      actorRef: 'sched-tech',
      detail: { date: '2026-10-10' },
    });
    const v1 = await latestScheduleVersion(tenantId);
    expect(v1).toBe(Number(e1.id));
    const e2 = await appendScheduleEvent({ tenantId, kind: 'moved' });
    const v2 = await latestScheduleVersion(tenantId);
    expect(v2).toBe(Number(e2.id));
    expect(v2).toBeGreaterThan(v1);

    const since = await listScheduleEventsSince(tenantId, v1, 10);
    expect(since.map((e) => Number(e.id))).toEqual([Number(e2.id)]);
    expect(since[0].kind).toBe('moved');
  });

  test('schedule_events is append-only at the DB level (raw_captures precedent)', async () => {
    const e = await appendScheduleEvent({ tenantId, kind: 'booked' });
    await expect(
      pg.query(`update schedule_events set kind = 'rewritten' where id = $1`, [e.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pg.query(`delete from schedule_events where id = $1`, [e.id]),
    ).rejects.toThrow(/append-only/);
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

describe('job duration ladder (Plan 4b-1)', () => {
  let customerId: string;

  beforeAll(async () => {
    customerId = (await createCustomer({ tenantId, name: 'Duration Casa' })).id;
  });

  const freshJob = async (durationMinutes?: number | null) =>
    createJob({
      tenantId,
      customerId,
      title: 'Duration subject',
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    });

  test('createJob persists a duration and defaults to null', async () => {
    expect((await freshJob()).duration_minutes).toBeNull();
    expect((await freshJob(120)).duration_minutes).toBe(120);
    // Off-ladder is legal at every write point — the ladder is offered, not
    // enforced (user decision 2026-07-24: a 20-minute callout is not a lie).
    expect((await freshJob(20)).duration_minutes).toBe(20);
    await expect(freshJob(6000)).rejects.toThrow(/whole number of minutes/);
  });

  test('updateJobDetails accepts every rung', async () => {
    let job = await freshJob();
    for (const rung of DURATION_LADDER) {
      job = await updateJobDetails(tenantId, job.id, { durationMinutes: rung }, job.updated_at);
      expect(job.duration_minutes).toBe(rung);
    }
  });

  test('updateJobDetails accepts off-ladder minutes and clears with null', async () => {
    let job = await freshJob();
    // 20 = a firm whose standard callout is not a rung; 80 = the span a
    // 08:00-09:20 booking measures (Phase 2 writes exactly this).
    for (const off of [20, 80, MAX_DURATION_MINUTES]) {
      job = await updateJobDetails(tenantId, job.id, { durationMinutes: off }, job.updated_at);
      expect(job.duration_minutes).toBe(off);
    }
    // null is an explicit CLEAR back to unknown, not "no change" — the undo
    // arm, mirroring jobType's.
    job = await updateJobDetails(tenantId, job.id, { durationMinutes: null }, job.updated_at);
    expect(job.duration_minutes).toBeNull();
  });

  test('updateJobDetails rejects non-integers, zero, negatives and over-bound', async () => {
    const job = await freshJob(60);
    for (const bad of [45.5, 0, -30, MAX_DURATION_MINUTES + 1]) {
      await expect(
        updateJobDetails(tenantId, job.id, { durationMinutes: bad }, job.updated_at),
      ).rejects.toThrow(/whole number of minutes/);
    }
    // The rejections left the stored value untouched (no partial patch).
    expect((await getJob(job.id))?.duration_minutes).toBe(60);
  });

  // formatDuration is the ONE label composer chat and the board both render, so
  // a drift here would desynchronise copy across surfaces silently.
  test('formatDuration labels every rung and the boundaries', () => {
    expect(DURATION_LADDER.map(formatDuration)).toEqual([
      '15m', '30m', '45m', '1h', '1h 30m', '2h', '3h', '4h', '6h', '8h',
    ]);
    expect(formatDuration(59)).toBe('59m');
    expect(formatDuration(80)).toBe('1h 20m'); // the 08:00-09:20 booked span
    expect(formatDuration(MAX_DURATION_MINUTES)).toBe('24h');
  });

  test('a duration-only update is not "nothing to update"', async () => {
    const job = await freshJob();
    const updated = await updateJobDetails(
      tenantId,
      job.id,
      { durationMinutes: 90 },
      job.updated_at,
    );
    expect(updated.duration_minutes).toBe(90);
    expect(updated.title).toBe(job.title); // nothing else moved
  });
});

describe('loose-bucket listers (Plan 4a)', () => {
  // Relative dates only — a bucket read is anchored at "today", so fixed
  // fixtures rot. Naive-local convention: wall-clock written as if UTC.
  const rel = (days: number, hh: string): string => {
    const d = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    return `${d}T${hh}:00.000Z`;
  };
  let parkedFutureId: string;
  let bucketJobId: string;

  beforeAll(async () => {
    const customer = await createCustomer({ tenantId, name: 'Bucket Casa' });
    // Parked visit in the future (unassigned, confirmed).
    const parkedJob = await createJob({ tenantId, customerId: customer.id, title: 'Parked work' });
    parkedFutureId = (
      await createAssignment({
        tenantId,
        jobId: parkedJob.id,
        technicianId: null,
        startsAt: rel(10, '09:00'),
        endsAt: rel(10, '11:00'),
        status: 'confirmed',
      })
    ).id;
    // Parked visit in the PAST — must be excluded by the from bound.
    const pastJob = await createJob({ tenantId, customerId: customer.id, title: 'Past parked' });
    await createAssignment({
      tenantId,
      jobId: pastJob.id,
      technicianId: null,
      startsAt: rel(-10, '09:00'),
      endsAt: rel(-10, '11:00'),
      status: 'confirmed',
    });
    // Unassigned CANCELLED future visit — the status filter must drop it.
    const cancelledJob = await createJob({
      tenantId,
      customerId: customer.id,
      title: 'Cancelled parked',
    });
    const c = await createAssignment({
      tenantId,
      jobId: cancelledJob.id,
      technicianId: null,
      startsAt: rel(12, '09:00'),
      endsAt: rel(12, '11:00'),
      status: 'confirmed',
    });
    await updateAssignmentStatus(c.id, 'cancelled');
    // Unscheduled open job (no assignment at all), priority carried.
    bucketJobId = (
      await createJob({
        tenantId,
        customerId: customer.id,
        title: 'Bucket bare job',
        priority: 'urgent',
      })
    ).id;
  });

  test('listUnassignedAssignmentsWithRefs embeds names; from bound excludes past rows', async () => {
    const rows = await listUnassignedAssignmentsWithRefs(
      tenantId,
      `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
    const mine = rows.find((r) => r.id === parkedFutureId);
    expect(mine).toBeDefined();
    expect(mine?.jobs?.title).toBe('Parked work');
    expect(mine?.jobs?.customers?.name).toBe('Bucket Casa');
    // Past and cancelled parked visits are out; nothing here is assigned.
    expect(rows.some((r) => r.jobs?.title === 'Past parked')).toBe(false);
    expect(rows.some((r) => r.jobs?.title === 'Cancelled parked')).toBe(false);
    expect(rows.every((r) => r.technician_id === null)).toBe(true);
  });

  test('listUnscheduledOpenJobsWithCustomer: embeds the customer, keeps priority, anti-joins live rows', async () => {
    const jobs = await listUnscheduledOpenJobsWithCustomer(tenantId);
    const bare = jobs.find((j) => j.id === bucketJobId);
    expect(bare).toBeDefined();
    expect(bare?.customers?.name).toBe('Bucket Casa');
    expect(bare?.priority).toBe('urgent');
    // The parked visits' jobs carry LIVE (confirmed) assignments → excluded.
    expect(jobs.some((j) => j.title === 'Parked work')).toBe(false);
    // The stripped embed key never leaks into the row shape.
    expect(bare && 'assignments' in bare).toBe(false);
  });
});
