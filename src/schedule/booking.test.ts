import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import { insertTechnician, setTechnicianAvailability, type Technician, type WeeklyPattern } from '../db/technicians.js';
import { addTimeOff } from '../db/timeOff.js';
import { createCustomer } from '../db/customers.js';
import { createJob, getJob } from '../db/jobs.js';
import { listAssignmentsForTechnician, listUnassignedOpenJobs } from '../db/assignments.js';
import { latestScheduleVersion, listScheduleEventsSince } from '../db/scheduleEvents.js';
import { bookVisit, cancelVisit, moveVisit, naiveLocalISO } from './booking.js';

// Integration against the local stack, scheduling.test.ts truncate discipline.
const TRUNCATE =
  'truncate table customers, jobs, technicians, technician_time_off, job_type_durations, review_items, schedule_events cascade';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let tech: Technician;
const OTHER_TENANT = '00000000-0000-0000-0000-000000000000';

// 2026-11-02 is a Monday; 2026-11-01 (Sunday) is empty in the pattern.
const WEEKDAYS_ONLY: WeeklyPattern = {
  mon: [['08:00', '17:00']],
  tue: [['08:00', '17:00']],
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
  tech = await insertTechnician({ tenantId, ref: 'book-tech', displayName: 'Booker Bob' });
  await setTechnicianAvailability(tech.id, WEEKDAYS_ONLY);
});

afterAll(async () => {
  await pg.query(TRUNCATE);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

describe('naiveLocalISO', () => {
  test('formats wall-clock as as-if-UTC', () => {
    expect(naiveLocalISO('2026-11-02', '09:30')).toBe('2026-11-02T09:30:00.000Z');
  });
});

describe('bookVisit', () => {
  test('customerId path mints a job shell, books confirmed+locked+day-promised', async () => {
    const customer = await createCustomer({ tenantId, name: 'Henderson' });
    const { assignment, job, warning } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      title: 'water heater replacement',
      date: '2026-11-02',
      startTime: '09:00',
      endTime: '12:00',
      actorRef: 'manager-test',
    });
    expect(warning).toBeUndefined(); // Monday is in the pattern
    expect(job.customer_id).toBe(customer.id);
    expect(job.status).toBe('open');
    expect(job.title).toBe('water heater replacement');
    expect(assignment.status).toBe('confirmed');
    expect(assignment.promise_level).toBe('day');
    expect(assignment.promised_day).toBe('2026-11-02');
    expect(assignment.locked).toBe(true);
    expect(assignment.starts_at).toContain('2026-11-02T09:00');
    // Event trail: a 'booked' event exists for this assignment.
    const events = await listScheduleEventsSince(tenantId, 0, 50);
    const booked = events.find((e) => e.assignment_id === assignment.id && e.kind === 'booked');
    expect(booked?.actor_ref).toBe('manager-test');
  });

  test('endTime defaults to start + job-type duration (tenant default 120)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Duration Dana' });
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-11-03',
      startTime: '10:00',
      actorRef: 'manager-test',
    });
    expect(assignment.ends_at).toContain('2026-11-03T12:00'); // 120-min default
  });

  test('overlap pre-check rejects cleanly and leaves NO job shell behind', async () => {
    const customer = await createCustomer({ tenantId, name: 'Clash Cal' });
    const before = (await listUnassignedOpenJobs(tenantId)).length;
    await expect(
      bookVisit({
        tenantId,
        technicianRef: 'book-tech',
        customerId: customer.id,
        date: '2026-11-02',
        startTime: '10:00', // overlaps the 09:00–12:00 booking above
        endTime: '11:00',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/already has a confirmed visit overlapping/);
    // No orphaned open job entered the scheduler queue.
    expect((await listUnassignedOpenJobs(tenantId)).length).toBe(before);
  });

  test('availability warning on an off-day and on time off; booking still lands', async () => {
    const customer = await createCustomer({ tenantId, name: 'Sunday Sue' });
    const sunday = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-11-01', // Sunday — pattern empty
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    expect(sunday.warning).toMatch(/outside .*working days/);
    expect(sunday.assignment.status).toBe('confirmed');

    await addTimeOff({
      tenantId,
      technicianId: tech.id,
      startsOn: '2026-11-04',
      endsOn: '2026-11-04',
      reason: 'dentist',
    });
    const dayOff = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-11-04',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    expect(dayOff.warning).toMatch(/time off .*dentist/);
  });

  test('jobId path reuses the job and its customer; unknown technician/customer rejected', async () => {
    const customer = await createCustomer({ tenantId, name: 'Job Jane' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'reuse me', status: 'open' });
    const { job: usedJob, customer: usedCustomer } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      jobId: job.id,
      date: '2026-11-05',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    expect(usedJob.id).toBe(job.id);
    expect(usedCustomer.id).toBe(customer.id);

    await expect(
      bookVisit({
        tenantId,
        technicianRef: 'nobody-here',
        customerId: customer.id,
        date: '2026-11-05',
        startTime: '13:00',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/'nobody-here' not found/);
    await expect(
      bookVisit({
        tenantId,
        technicianRef: 'book-tech',
        customerId: job.id, // a job id is not a customer id
        date: '2026-11-05',
        startTime: '13:00',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/customer not found/);
  });
});

describe('moveVisit', () => {
  test('moved row lands confirmed, visible to confirmed-filtered reads; promise carried; promiseBroken flagged on a day change', async () => {
    const customer = await createCustomer({ tenantId, name: 'Mover Mel' });
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-11-09',
      startTime: '09:00',
      endTime: '11:00',
      actorRef: 'manager-test',
    });
    const moved = await moveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-11-10', // day change → promise break
      startTime: '13:00',
      reason: 'customer asked for Tuesday',
      actorRef: 'manager-test',
    });
    expect(moved.promiseBroken).toBe(true);
    expect(moved.created.status).toBe('confirmed'); // BLOCKER-#1 regression pin
    expect(moved.created.promise_level).toBe('day'); // carried
    expect(moved.created.promised_day).toBe('2026-11-10'); // recomputed
    expect(moved.created.locked).toBe(true);
    // Duration preserved (09–11 was 2h → 13:00–15:00).
    expect(moved.created.ends_at).toContain('2026-11-10T15:00');
    // Visible to the ['confirmed']-filtered read every surface uses.
    const day = await listAssignmentsForTechnician(
      tech.id,
      '2026-11-10T00:00:00.000Z',
      '2026-11-11T00:00:00.000Z',
      ['confirmed'],
    );
    expect(day.map((r) => r.id)).toContain(moved.created.id);
    // Event trail carries the break flag.
    const events = await listScheduleEventsSince(tenantId, 0, 100);
    const movedEvent = events.find((e) => e.assignment_id === moved.created.id && e.kind === 'moved');
    expect(movedEvent?.detail).toMatchObject({ promiseBroken: true, toDay: '2026-11-10' });
  });

  test('same-day time shuffle: pre-check excludes the moved row; promise NOT broken', async () => {
    const customer = await createCustomer({ tenantId, name: 'Shuffle Sam' });
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-11-11',
      startTime: '09:00',
      endTime: '11:00',
      actorRef: 'manager-test',
    });
    const moved = await moveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-11-11',
      startTime: '09:30', // overlaps ONLY itself
      reason: 'shift half an hour',
      actorRef: 'manager-test',
    });
    expect(moved.promiseBroken).toBe(false);
    expect(moved.created.starts_at).toContain('2026-11-11T09:30');
    // A TIME-level promise breaks on a same-day TIME change (the customer
    // heard "9:30", not just "Wednesday") — day-level promises don't.
    const timePromised = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: (await createCustomer({ tenantId, name: 'Time Promise Tia' })).id,
      date: '2026-11-18',
      startTime: '09:00',
      endTime: '10:00',
      promiseLevel: 'time',
      actorRef: 'manager-test',
    });
    const timeShift = await moveVisit({
      tenantId,
      assignmentId: timePromised.assignment.id,
      date: '2026-11-18', // same day…
      startTime: '14:00', // …new time → the told-time promise breaks
      reason: 'ran long',
      actorRef: 'manager-test',
    });
    expect(timeShift.promiseBroken).toBe(true);

    // Same-technician move onto a SUNDAY warns too (no technicianRef passed).
    const sundayMove = await moveVisit({
      tenantId,
      assignmentId: moved.created.id,
      date: '2026-11-15', // Sunday — pattern empty
      startTime: '09:30',
      reason: 'weekend squeeze',
      actorRef: 'manager-test',
    });
    expect(sundayMove.warning).toMatch(/outside .*working days/);
  });

  test('move into an occupied slot rejects BEFORE cancelling (booking intact)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Blocked Bo' });
    const a = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-11-12',
      startTime: '09:00',
      endTime: '11:00',
      actorRef: 'manager-test',
    });
    const b = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-11-12',
      startTime: '13:00',
      endTime: '15:00',
      actorRef: 'manager-test',
    });
    await expect(
      moveVisit({
        tenantId,
        assignmentId: b.assignment.id,
        date: '2026-11-12',
        startTime: '10:00', // lands inside a's 09–11
        reason: 'bad idea',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/overlaps a confirmed visit .* NOT moved/);
    // b untouched and still confirmed.
    const day = await listAssignmentsForTechnician(
      tech.id,
      '2026-11-12T00:00:00.000Z',
      '2026-11-13T00:00:00.000Z',
      ['confirmed'],
    );
    expect(day.map((r) => r.id).sort()).toEqual([a.assignment.id, b.assignment.id].sort());
  });

  test('cross-tenant / unknown assignment ids read as not found (move AND cancel)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Guard Gil' });
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-11-13',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    await expect(
      moveVisit({
        tenantId: OTHER_TENANT,
        assignmentId: assignment.id,
        date: '2026-11-13',
        startTime: '11:00',
        reason: 'wrong tenant',
        actorRef: 'intruder',
      }),
    ).rejects.toThrow(/assignment not found/);
    await expect(
      cancelVisit({
        tenantId: OTHER_TENANT,
        assignmentId: assignment.id,
        reason: 'wrong tenant',
        actorRef: 'intruder',
      }),
    ).rejects.toThrow(/assignment not found/);
  });
});

describe('cancelVisit', () => {
  test('cancels with reason kept and appends the event', async () => {
    const customer = await createCustomer({ tenantId, name: 'Cancel Cara' });
    const { assignment, job } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-11-16',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    const before = await latestScheduleVersion(tenantId);
    const cancelled = await cancelVisit({
      tenantId,
      assignmentId: assignment.id,
      reason: 'customer cancelled',
      actorRef: 'manager-test',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.reason).toBe('customer cancelled');
    expect(await latestScheduleVersion(tenantId)).toBeGreaterThan(before);
    // The job survives a cancelled visit (rebooking is the job machine's business).
    expect((await getJob(job.id))?.status).toBe('open');
  });
});
