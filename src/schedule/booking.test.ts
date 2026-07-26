import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import { insertTechnician, setTechnicianAvailability, type Technician, type WeeklyPattern } from '../db/technicians.js';
import { addTimeOff } from '../db/timeOff.js';
import { createCustomer } from '../db/customers.js';
import { createJob, getJob, updateJobDetails } from '../db/jobs.js';
import {
  listAssignmentsForJob,
  listAssignmentsForTechnician,
  listUnassignedAssignments,
  listUnassignedOpenJobs,
  updateAssignmentStatus,
} from '../db/assignments.js';
import { latestScheduleVersion, listScheduleEventsSince } from '../db/scheduleEvents.js';
import {
  bookVisit,
  cancelJob,
  previewCancelJob,
  unscheduleVisit,
  moveVisit,
  naiveLocalISO,
  previewBookVisit,
  previewMoveVisit,
  setVisitPromise,
} from './booking.js';

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
  test('customerId path mints a job shell, books confirmed+locked; promises NOTHING by default', async () => {
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
    // Safe default: no promise was stated, so the record claims none — and
    // stamps NO promised day (never invent a promise the manager didn't make).
    expect(assignment.promise_level).toBe('none');
    expect(assignment.promised_day).toBeNull();
    expect(assignment.locked).toBe(true);
    expect(assignment.starts_at).toContain('2026-11-02T09:00');
    // Event trail: a 'booked' event exists for this assignment.
    const events = await listScheduleEventsSince(tenantId, 0, 50);
    const booked = events.find((e) => e.assignment_id === assignment.id && e.kind === 'booked');
    expect(booked?.actor_ref).toBe('manager-test');
  });

  test('the booked span lands on the minted shell verbatim — rung or not (4b-1)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Span Casa' });
    // A 2h booking → the shell records 120 (a rung, incidentally).
    const twoHours = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      title: 'boiler service',
      date: '2026-12-14',
      startTime: '09:00',
      endTime: '11:00',
      actorRef: 'manager-test',
    });
    expect(twoHours.job.duration_minutes).toBe(120);
    // Preview == commit: the preview disclosed the same value.
    const preview = await previewBookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      title: 'boiler service preview',
      date: '2026-12-15',
      startTime: '09:00',
      endTime: '11:00',
      actorRef: 'manager-test',
    });
    expect(preview.jobDurationMinutes).toBe(120);

    // An OFF-ladder span is kept verbatim (08:00-09:20 → 80): a measured
    // value, not an invented one — discarding it would leave the job
    // duration-less if this visit is later cancelled, and the freeze would
    // re-ask a length we already knew (the whole point of free minutes).
    const offLadder = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      title: 'gutter clear',
      date: '2026-12-16',
      startTime: '08:00',
      endTime: '09:20',
      actorRef: 'manager-test',
    });
    expect(offLadder.job.duration_minutes).toBe(80);

    // The jobId path never touches an existing job's stored length: booking a
    // second 1h visit on the 80-minute job leaves 80 in place, and the preview
    // reports the EXISTING length (post-commit truth), not the span.
    const onExisting = await previewBookVisit({
      tenantId,
      technicianRef: 'book-tech',
      jobId: offLadder.job.id,
      date: '2026-12-17',
      startTime: '13:00',
      endTime: '14:00',
      actorRef: 'manager-test',
    });
    expect(onExisting.jobDurationMinutes).toBe(80);
    const second = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      jobId: offLadder.job.id,
      date: '2026-12-17',
      startTime: '13:00',
      endTime: '14:00',
      actorRef: 'manager-test',
    });
    expect(second.job.duration_minutes).toBe(80);
  });

  test('an explicit day promise records the promised day', async () => {
    const customer = await createCustomer({ tenantId, name: 'Promised Pat' });
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-11-06',
      startTime: '09:00',
      endTime: '10:00',
      promiseLevel: 'day', // the manager told the customer this day
      actorRef: 'manager-test',
    });
    expect(assignment.promise_level).toBe('day');
    expect(assignment.promised_day).toBe('2026-11-06');
  });

  test('a seat-exempt person is bookable like any technician (assignability lock)', async () => {
    const helper = await insertTechnician({
      tenantId,
      ref: 'helper-hank',
      displayName: 'Helper Hank',
      seatExempt: true,
    });
    expect(helper.seat_exempt).toBe(true);
    expect(helper.state).toBe('active'); // derived by insertTechnician
    const customer = await createCustomer({ tenantId, name: 'Exempt Eddie' });
    const { assignment, warning } = await bookVisit({
      tenantId,
      technicianRef: 'helper-hank',
      customerId: customer.id,
      date: '2026-11-04',
      startTime: '13:00',
      endTime: '14:00',
      actorRef: 'manager-test',
    });
    expect(assignment.technician_id).toBe(helper.id);
    expect(assignment.status).toBe('confirmed');
    // No working pattern configured → the standard ADVISORY warning; the
    // booking itself must never block on it.
    expect(warning).toContain('no working pattern configured');
  });

  test('no default times: omitting endTime is refused, nothing is invented or written', async () => {
    const customer = await createCustomer({ tenantId, name: 'Duration Dana' });
    const before = (await listUnassignedOpenJobs(tenantId)).length;
    await expect(
      bookVisit({
        tenantId,
        technicianRef: 'book-tech',
        customerId: customer.id,
        date: '2026-11-03',
        startTime: '10:00',
        actorRef: 'manager-test',
        // endTime deliberately omitted (cast: the untyped MCP boundary —
        // e.g. a malformed staged detail — can still produce this shape).
        // Message updated by plan 4b-2: the required-check now names the ONE
        // legal omission (an explicit timeTbd booking).
      } as Parameters<typeof bookVisit>[0]),
    ).rejects.toThrow(/endTime are all required/);
    expect((await listUnassignedOpenJobs(tenantId)).length).toBe(before);
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
        endTime: '14:00',
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
        endTime: '14:00',
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
      promiseLevel: 'day', // customer was told this day → moving it breaks the promise
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
      promiseLevel: 'day', // day promised → a same-day TIME shift must NOT break it
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
      unscheduleVisit({
        tenantId: OTHER_TENANT,
        assignmentId: assignment.id,
        reason: 'wrong tenant',
        actorRef: 'intruder',
      }),
    ).rejects.toThrow(/assignment not found/);
  });
});

describe('unassigned bookings (technician-optional)', () => {
  test('bookVisit with no technicianRef books unassigned; preview echoes null', async () => {
    const customer = await createCustomer({ tenantId, name: 'Later Lara' });
    const preview = await previewBookVisit({
      tenantId,
      customerId: customer.id,
      date: '2026-11-23',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    expect(preview.technicianRef).toBeNull();
    expect(preview.technicianName).toBeNull();
    expect(preview.warning).toBeUndefined(); // no technician → no availability advisory

    const { assignment, warning } = await bookVisit({
      tenantId,
      customerId: customer.id,
      date: '2026-11-23',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    expect(warning).toBeUndefined();
    expect(assignment.technician_id).toBeNull();
    expect(assignment.status).toBe('confirmed');
    expect(assignment.locked).toBe(true);
  });

  test('unassigned same-window: different customers land; an identical duplicate is refused', async () => {
    const pia = await createCustomer({ tenantId, name: 'Parallel Pia' });
    const paul = await createCustomer({ tenantId, name: 'Parallel Paul' });
    const a = await bookVisit({
      tenantId,
      customerId: pia.id,
      date: '2026-11-24',
      startTime: '09:00',
      endTime: '11:00',
      actorRef: 'manager-test',
    });
    // A DIFFERENT customer at the identical window lands — the exclusion
    // guard keys on technician_id and NULL never matches; there is no
    // technician to double-book. The semantic point of Decision 1.
    const b = await bookVisit({
      tenantId,
      customerId: paul.id,
      date: '2026-11-24',
      startTime: '09:00',
      endTime: '11:00',
      actorRef: 'manager-test',
    });
    expect(a.assignment.technician_id).toBeNull();
    expect(b.assignment.technician_id).toBeNull();
    expect(a.assignment.id).not.toBe(b.assignment.id);
    // The SAME customer at the identical window is refused: unassigned rows
    // escape the DB guard, so a transport retry of a one-shot booking would
    // otherwise duplicate silently (review finding).
    await expect(
      bookVisit({
        tenantId,
        customerId: pia.id,
        date: '2026-11-24',
        startTime: '09:00',
        endTime: '11:00',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/identical unassigned visit .* likely a duplicate/);
  });

  test('moveVisit attaches a technician to an unassigned row; overlap then enforced', async () => {
    const customer = await createCustomer({ tenantId, name: 'Attach Abe' });
    const { assignment } = await bookVisit({
      tenantId,
      customerId: customer.id,
      date: '2026-11-25',
      startTime: '09:00',
      endTime: '11:00',
      actorRef: 'manager-test',
    });
    expect(assignment.technician_id).toBeNull();
    const moved = await moveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-11-25',
      startTime: '09:00',
      technicianRef: 'book-tech',
      reason: 'assigning Bob',
      actorRef: 'manager-test',
    });
    expect(moved.created.technician_id).toBe(tech.id);
    expect(moved.created.status).toBe('confirmed');
    // The attached technician's slot is now guarded: booking Bob into the
    // same window must clash.
    await expect(
      bookVisit({
        tenantId,
        technicianRef: 'book-tech',
        customerId: customer.id,
        date: '2026-11-25',
        startTime: '10:00',
        endTime: '11:00',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/already has a confirmed visit overlapping/);
    // An unassigned move WITHOUT a ref stays unassigned.
    const parked = await bookVisit({
      tenantId,
      customerId: customer.id,
      date: '2026-11-26',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    const reparked = await moveVisit({
      tenantId,
      assignmentId: parked.assignment.id,
      date: '2026-11-27',
      startTime: '09:00',
      reason: 'shift a day',
      actorRef: 'manager-test',
    });
    expect(reparked.created.technician_id).toBeNull();
  });

  test('listUnassignedAssignments: confirmed null-tech rows from fromISO on, no upper bound', async () => {
    const customer = await createCustomer({ tenantId, name: 'Recall Rae' });
    // Far-future unassigned visit — months out, beyond any board window.
    const far = await bookVisit({
      tenantId,
      customerId: customer.id,
      date: '2027-03-15',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    // Assigned visit — must NOT appear.
    const assigned = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2027-03-16',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    // Cancelled unassigned visit — must NOT appear.
    const cancelled = await bookVisit({
      tenantId,
      customerId: customer.id,
      date: '2027-03-17',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    await unscheduleVisit({
      tenantId,
      assignmentId: cancelled.assignment.id,
      reason: 'never mind',
      actorRef: 'manager-test',
    });
    const listed = await listUnassignedAssignments(tenantId, '2027-03-01T00:00:00.000Z');
    const ids = listed.map((r) => r.id);
    expect(ids).toContain(far.assignment.id);
    expect(ids).not.toContain(assigned.assignment.id);
    expect(ids).not.toContain(cancelled.assignment.id);
    // Past rows excluded: a from AFTER the visit hides it.
    const after = await listUnassignedAssignments(tenantId, '2027-04-01T00:00:00.000Z');
    expect(after.map((r) => r.id)).not.toContain(far.assignment.id);
    // Ordered by starts_at.
    const starts = listed.map((r) => r.starts_at);
    expect([...starts].sort()).toEqual(starts);
  });
});

describe('detach (unassign) + time_only promise — plan 4a.5', () => {
  test('moveVisit unassign parks the visit: technician_id NULL, moved event, promise intact', async () => {
    const customer = await createCustomer({ tenantId, name: 'Detach Dana' });
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-12-01',
      startTime: '09:00',
      endTime: '10:00',
      promiseLevel: 'day',
      actorRef: 'manager-test',
    });
    expect(assignment.technician_id).toBe(tech.id);
    // Preview first: a same-day/same-time park breaks NO promise (day-level
    // promises gate the DAY; the person is not part of the promise).
    const preview = await previewMoveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-12-01',
      startTime: '09:00',
      unassign: true,
      reason: 'tech pulled to an emergency',
      actorRef: 'manager-test',
    });
    expect(preview.unassign).toBe(true);
    expect(preview.promiseLevel).toBe('day');
    expect(preview.promiseBroken).toBe(false);
    expect(preview.requiresConfirmation).toBe(false);
    expect(preview.technicianName).toBeNull(); // the TARGET is nobody

    const before = await latestScheduleVersion(tenantId);
    const moved = await moveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-12-01',
      startTime: '09:00',
      unassign: true,
      reason: 'tech pulled to an emergency',
      actorRef: 'manager-test',
    });
    expect(moved.created.technician_id).toBeNull();
    expect(moved.created.status).toBe('confirmed');
    expect(moved.created.promise_level).toBe('day'); // promise carries
    expect(moved.created.promised_day).toBe('2026-12-01');
    expect(moved.cancelled.id).toBe(assignment.id);
    expect(moved.promiseBroken).toBe(false);
    // The ledger records a plain 'moved' with the old row linked — exactly
    // what boardNotify resolves for the "moved off your schedule" push.
    const events = await listScheduleEventsSince(tenantId, before);
    const ev = events.find((e) => e.assignment_id === moved.created.id && e.kind === 'moved');
    expect(ev).toBeDefined();
    expect((ev?.detail as { previousAssignmentId?: string }).previousAssignmentId).toBe(
      assignment.id,
    );
    // And the parked row is now in the recall lister.
    const parked = await listUnassignedAssignments(tenantId, '2026-12-01T00:00:00.000Z');
    expect(parked.map((r) => r.id)).toContain(moved.created.id);
  });

  test('unassign + technicianRef is refused; nothing changes', async () => {
    const customer = await createCustomer({ tenantId, name: 'Both Bo' });
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-12-02',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    await expect(
      moveVisit({
        tenantId,
        assignmentId: assignment.id,
        date: '2026-12-02',
        startTime: '09:00',
        technicianRef: 'book-tech',
        unassign: true,
        reason: 'contradiction',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/pass ONE of technicianRef .* or unassign/);
    expect((await listAssignmentsForTechnician(tech.id, '2026-12-02T00:00:00.000Z', '2026-12-03T00:00:00.000Z')).map((r) => r.id)).toContain(assignment.id);
  });

  test('a park onto an identical existing parked window for the same customer is refused', async () => {
    const customer = await createCustomer({ tenantId, name: 'Dup Dora' });
    // An existing PARKED visit at the target window.
    await bookVisit({
      tenantId,
      customerId: customer.id,
      date: '2026-12-03',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    // An assigned visit elsewhere, about to be parked onto that exact window.
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-12-03',
      startTime: '11:00',
      endTime: '12:00',
      actorRef: 'manager-test',
    });
    await expect(
      moveVisit({
        tenantId,
        assignmentId: assignment.id,
        date: '2026-12-03',
        startTime: '09:00',
        endTime: '10:00',
        unassign: true,
        reason: 'park it',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/identical unassigned visit .* likely a duplicate/);
    // A park onto a CLEAN window still lands.
    const moved = await moveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-12-03',
      startTime: '13:00',
      endTime: '14:00',
      unassign: true,
      reason: 'park it',
      actorRef: 'manager-test',
    });
    expect(moved.created.technician_id).toBeNull();
  });

  test('time_only: promised_day NULL; day moves freely; a time change breaks', async () => {
    const customer = await createCustomer({ tenantId, name: 'Nine AM Nia' });
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-12-04',
      startTime: '09:00',
      endTime: '10:00',
      promiseLevel: 'time_only',
      actorRef: 'manager-test',
    });
    expect(assignment.promise_level).toBe('time_only');
    expect(assignment.promised_day).toBeNull(); // the constraint accepts the pair
    // Different DAY, same start time → one-shot (the day was never promised).
    const dayMove = await previewMoveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-12-07',
      startTime: '09:00',
      reason: 'shift the day',
      actorRef: 'manager-test',
    });
    expect(dayMove.promiseBroken).toBe(false);
    expect(dayMove.requiresConfirmation).toBe(false);
    // Same day, different START TIME → the promise breaks.
    const timeMove = await previewMoveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-12-04',
      startTime: '13:00',
      reason: 'shift the time',
      actorRef: 'manager-test',
    });
    expect(timeMove.promiseLevel).toBe('time_only');
    expect(timeMove.promiseBroken).toBe(true);
    expect(timeMove.requiresConfirmation).toBe(true);
    // Committing the day move keeps promised_day NULL (carriesPromisedDay).
    const moved = await moveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-12-07',
      startTime: '09:00',
      reason: 'shift the day',
      actorRef: 'manager-test',
    });
    expect(moved.created.promise_level).toBe('time_only');
    expect(moved.created.promised_day).toBeNull();
    expect(moved.promiseBroken).toBe(false);
  });
});

describe('unplaced (timeTbd) bookings + placing them — plan 4b-2', () => {
  async function mkCustomer(name: string) {
    return createCustomer({ tenantId, name });
  }

  test('a timeTbd booking creates NULL times + the day range; the shell stays duration-less', async () => {
    const customer = await mkCustomer('TBD Tina');
    const r = await bookVisit({
      tenantId,
      customerId: customer.id,
      title: 'tbd single day',
      timeTbd: true,
      earliestDate: '2026-11-19',
      actorRef: 'mgr',
    });
    expect(r.assignment.starts_at).toBeNull();
    expect(r.assignment.ends_at).toBeNull();
    expect(r.assignment.earliest_date).toBe('2026-11-19');
    expect(r.assignment.latest_date).toBe('2026-11-19'); // defaults to earliest
    expect(r.assignment.status).toBe('confirmed');
    // No span was measured — the never-guess rule holds for the shell too.
    expect(r.job.duration_minutes).toBeNull();
  });

  test('timeTbd with a startTime is rejected; missing day is rejected', async () => {
    const customer = await mkCustomer('TBD Mix');
    await expect(
      bookVisit({
        tenantId, customerId: customer.id, timeTbd: true,
        earliestDate: '2026-11-19', startTime: '09:00', actorRef: 'mgr',
      }),
    ).rejects.toThrow(/timeTbd means NO times/);
    await expect(
      bookVisit({ tenantId, customerId: customer.id, timeTbd: true, actorRef: 'mgr' }),
    ).rejects.toThrow(/needs the day/);
  });

  test('time promises are refused on timeTbd; a day promise needs ONE day', async () => {
    const customer = await mkCustomer('TBD Promise');
    await expect(
      bookVisit({
        tenantId, customerId: customer.id, timeTbd: true,
        earliestDate: '2026-11-19', promiseLevel: 'time', actorRef: 'mgr',
      }),
    ).rejects.toThrow(/needs a booked time/);
    await expect(
      bookVisit({
        tenantId, customerId: customer.id, timeTbd: true,
        earliestDate: '2026-11-19', latestDate: '2026-11-20',
        promiseLevel: 'day', actorRef: 'mgr',
      }),
    ).rejects.toThrow(/ONE day/);
    // Single-day + day promise is coherent and stamps the promised day.
    const ok = await bookVisit({
      tenantId, customerId: customer.id, title: 'tbd promised',
      timeTbd: true, earliestDate: '2026-11-19',
      promiseLevel: 'day', actorRef: 'mgr',
    });
    expect(ok.assignment.promise_level).toBe('day');
    expect(ok.assignment.promised_day).toBe('2026-11-19');
  });

  test('identical unplaced twins for one customer are refused (retry hazard)', async () => {
    const customer = await mkCustomer('TBD Twin');
    await bookVisit({
      tenantId, customerId: customer.id, title: 'twin', timeTbd: true,
      earliestDate: '2026-11-23', latestDate: '2026-11-25', actorRef: 'mgr',
    });
    await expect(
      bookVisit({
        tenantId, customerId: customer.id, title: 'twin again', timeTbd: true,
        earliestDate: '2026-11-23', latestDate: '2026-11-25', actorRef: 'mgr',
      }),
    ).rejects.toThrow(/identical time-TBD visit/);
  });

  test('moving an unplaced visit to real times PLACES it: times set, range cleared', async () => {
    const customer = await mkCustomer('TBD Place');
    const booked = await bookVisit({
      tenantId, customerId: customer.id, title: 'place me', timeTbd: true,
      earliestDate: '2026-11-30', actorRef: 'mgr',
    });
    const moved = await moveVisit({
      tenantId,
      assignmentId: booked.assignment.id,
      date: '2026-11-30',
      startTime: '09:00',
      endTime: '10:30',
      technicianRef: tech.ref,
      reason: 'placing the visit',
      actorRef: 'mgr',
    });
    expect(moved.created.starts_at).toBe('2026-11-30T09:00:00+00:00');
    expect(moved.created.ends_at).toBe('2026-11-30T10:30:00+00:00');
    expect(moved.created.earliest_date).toBeNull();
    expect(moved.created.latest_date).toBeNull();
    expect(moved.created.technician_id).toBe(tech.id);
    // Placing is never a TIME break (there was no old time).
    expect(moved.promiseBroken).toBe(false);
  });

  test('placing without endTime uses the job length; errors when that is null too', async () => {
    const customer = await mkCustomer('TBD Length');
    const withLen = await bookVisit({
      tenantId, customerId: customer.id, title: 'has length', timeTbd: true,
      earliestDate: '2026-12-01', actorRef: 'mgr',
    });
    await updateJobDetails(tenantId, withLen.job.id, { durationMinutes: 90 },
      (await getJob(withLen.job.id))!.updated_at);
    const moved = await moveVisit({
      tenantId, assignmentId: withLen.assignment.id,
      date: '2026-12-01', startTime: '13:00',
      reason: 'placing with job length', actorRef: 'mgr',
    });
    expect(moved.created.ends_at).toBe('2026-12-01T14:30:00+00:00'); // 13:00 + 90m

    const noLen = await bookVisit({
      tenantId, customerId: customer.id, title: 'no length', timeTbd: true,
      earliestDate: '2026-12-02', actorRef: 'mgr',
    });
    await expect(
      moveVisit({
        tenantId, assignmentId: noLen.assignment.id,
        date: '2026-12-02', startTime: '13:00',
        reason: 'no length anywhere', actorRef: 'mgr',
      }),
    ).rejects.toThrow(/no recorded length/);
  });

  test('set promise on unplaced: day works on single-day, refused on a range; time refused', async () => {
    const customer = await mkCustomer('TBD SetPromise');
    const single = await bookVisit({
      tenantId, customerId: customer.id, title: 'single', timeTbd: true,
      earliestDate: '2026-12-07', actorRef: 'mgr',
    });
    const done = await setVisitPromise(tenantId, single.assignment.id, 'day', 'mgr');
    expect(done.updated.promise_level).toBe('day');
    expect(done.updated.promised_day).toBe('2026-12-07');
    await expect(
      setVisitPromise(tenantId, single.assignment.id, 'time', 'mgr'),
    ).rejects.toThrow(/needs a booked time/);

    const ranged = await bookVisit({
      tenantId, customerId: customer.id, title: 'ranged', timeTbd: true,
      earliestDate: '2026-12-08', latestDate: '2026-12-10', actorRef: 'mgr',
    });
    await expect(
      setVisitPromise(tenantId, ranged.assignment.id, 'day', 'mgr'),
    ).rejects.toThrow(/ONE day/);
  });
});

describe('unscheduleVisit', () => {
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
    const cancelled = await unscheduleVisit({
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

describe('cancelJob — the terminal verb (cancel-vocabulary plan, 2026-07-25)', () => {
  test('cascade: live visits die with their own events, job flips, ledger complete', async () => {
    const customer = await createCustomer({ tenantId, name: 'Terminal Tess' });
    // One job, two live visits (one assigned, one PARKED person-less — the
    // cascade must cover null-technician rows) + one COMPLETED visit that the
    // cascade must never touch.
    const first = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      title: 'full repipe',
      date: '2027-01-04',
      startTime: '09:00',
      endTime: '11:00',
      actorRef: 'manager-test',
    });
    const jobId = first.job.id;
    const parked = await bookVisit({
      tenantId,
      jobId,
      date: '2027-01-06',
      startTime: '09:00',
      endTime: '11:00',
      actorRef: 'manager-test',
    });
    const done = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      jobId,
      date: '2027-01-05',
      startTime: '13:00',
      endTime: '14:00',
      promiseLevel: 'day',
      actorRef: 'manager-test',
    });
    const completedRow = await updateAssignmentStatus(done.assignment.id, 'completed');
    expect(completedRow.status).toBe('completed');

    // Preview: both LIVE visits listed with their promise levels; completed
    // row absent; requiresConfirmation is always true (terminal).
    const preview = await previewCancelJob(tenantId, jobId);
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.jobTitle).toBe('full repipe');
    expect(preview.customerName).toBe('Terminal Tess');
    expect(preview.visits.map((v) => v.assignmentId).sort()).toEqual(
      [first.assignment.id, parked.assignment.id].sort(),
    );
    expect(preview.visits.find((v) => v.assignmentId === first.assignment.id)?.technicianRef).toBe(
      'book-tech',
    );
    expect(preview.visits.find((v) => v.assignmentId === parked.assignment.id)?.technicianRef).toBeNull();

    const result = await cancelJob({
      tenantId,
      jobId,
      reason: 'customer called it off',
      actorRef: 'manager-test',
    });
    expect(result.job.status).toBe('cancelled');
    expect(result.cancelledVisits.map((v) => v.id).sort()).toEqual(
      [first.assignment.id, parked.assignment.id].sort(),
    );
    // The completed row is history, untouched.
    const rows = await listAssignmentsForJob(jobId);
    expect(rows.find((r) => r.id === done.assignment.id)?.status).toBe('completed');
    expect(rows.filter((r) => r.status === 'cancelled')).toHaveLength(2);
    // Ledger: one 'cancelled' per visit (jobCancellation-stamped) + one
    // job_cancelled with the count.
    const events = await listScheduleEventsSince(tenantId, 0, 200);
    const visitEvents = events.filter(
      (e) =>
        e.kind === 'cancelled' &&
        (e.detail as { jobCancellation?: boolean } | null)?.jobCancellation === true,
    );
    expect(visitEvents).toHaveLength(2);
    const jobEvent = events.find((e) => e.kind === 'job_cancelled');
    expect(jobEvent?.assignment_id).toBeNull();
    expect((jobEvent?.detail as { visitsCancelled?: number }).visitsCancelled).toBe(2);
  });

  test('terminal/unknown/cross-tenant refusals; reason required', async () => {
    const customer = await createCustomer({ tenantId, name: 'Refusal Rae' });
    const { job } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      title: 'one and done',
      date: '2027-01-11',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    await cancelJob({ tenantId, jobId: job.id, reason: 'gone', actorRef: 'manager-test' });
    // Already cancelled → terminal refusal that says so.
    await expect(previewCancelJob(tenantId, job.id)).rejects.toThrow(/it already is/);
    await expect(
      cancelJob({ tenantId, jobId: job.id, reason: 'again', actorRef: 'manager-test' }),
    ).rejects.toThrow(/cannot cancel a cancelled job/);
    // Cross-tenant and unknown ids read as not found (tenant guard is explicit
    // — every helper underneath is id-only; the plan-review finding).
    await expect(previewCancelJob(OTHER_TENANT, job.id)).rejects.toThrow('job not found');
    await expect(
      previewCancelJob(tenantId, '00000000-0000-0000-0000-000000000001'),
    ).rejects.toThrow('job not found');
    await expect(
      cancelJob({ tenantId, jobId: job.id, reason: '  ', actorRef: 'manager-test' }),
    ).rejects.toThrow('reason is required');
  });
});
