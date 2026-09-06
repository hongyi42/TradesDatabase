import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import { insertTechnician, setTechnicianAvailability, type Technician, type WeeklyPattern } from '../db/technicians.js';
import { addTimeOff } from '../db/timeOff.js';
import { createCustomer } from '../db/customers.js';
import { createJob, getJob, updateJobDetails, updateJobStatus } from '../db/jobs.js';
import {
  getVisitForTenant,
  createVisit,
  listVisitsForJob,
  listVisitsForTechnician,
  listUnassignedVisits,
  listUnassignedOpenJobs,
  listParticipants,
  updateVisitStatus,
} from '../db/visits.js';
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
  previewUnscheduleVisit,
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
  test('customerId path mints a job shell and books it confirmed', async () => {
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
    // Preview == commit: the preview disclosed the same value. (A distinct
    // title, so the mint guard lets it through as declared-new work.)
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
        // Rung 9a: the required-check now names the ONE legal omission —
        // ALL THREE of date/startTime/endTime absent (an untimed visit).
      } as Parameters<typeof bookVisit>[0]),
    ).rejects.toThrow(/date AND both times, or none of the three/);
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
      forceNewJob: true, // the Sunday booking above left an open job on file
      actorRef: 'manager-test',
    });
    expect(dayOff.warning).toMatch(/time off .*dentist/);
  });

  test('the customerId MINT GUARD: ambiguous mints refused with the job list, distinct titles and forceNewJob mint', async () => {
    const customer = await createCustomer({ tenantId, name: 'Guarded Gwen' });
    const onFile = await createJob({
      tenantId,
      customerId: customer.id,
      title: 'furnace inspection',
      jobType: 'hvac',
      durationMinutes: 60,
      status: 'open',
    });
    const attempt = {
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      title: 'Furnace Inspection', // case-insensitively NAMES the job on file
      // Far-future dates: 'book-tech' is shared across this file, and these
      // bookings must not overlap the November fixtures other tests place.
      date: '2027-06-07',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    };
    // A title naming on-file work is refused BEFORE any write, and the message
    // carries everything the agent needs to self-correct: title, jobId, hatch.
    await expect(bookVisit(attempt)).rejects.toThrow(/already has open work on file/);
    await expect(bookVisit(attempt)).rejects.toThrow(onFile.id);
    await expect(bookVisit(attempt)).rejects.toThrow(/forceNewJob/);
    expect(await listVisitsForJob(onFile.id)).toHaveLength(0);
    // NO title at all is the other ambiguous shape (which job did the manager
    // mean?) — same refusal, on the preview path too (same front-half).
    await expect(bookVisit({ ...attempt, title: null })).rejects.toThrow(/already has open work on file/);
    await expect(previewBookVisit(attempt)).rejects.toThrow(/already has open work on file/);
    // A DISTINCT title is itself the declaration of new work — mints freely…
    const distinct = await bookVisit({ ...attempt, title: 'gutter clear' });
    expect(distinct.job.id).not.toBe(onFile.id);
    // …and forceNewJob overrides even an ambiguous shape.
    const forced = await bookVisit({
      ...attempt,
      date: '2027-06-08',
      forceNewJob: true,
    });
    expect(forced.job.id).not.toBe(onFile.id);
    // A TERMINAL job never blocks: completed work is history, so once every
    // open job is walked to done, even the title-match books normally.
    for (const j of [onFile, distinct.job, forced.job]) {
      await updateJobStatus(j.id, 'in_progress');
      await updateJobStatus(j.id, 'completed');
    }
    const afterDone = await bookVisit({ ...attempt, date: '2027-06-09' });
    expect(afterDone.assignment.status).toBe('confirmed');
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
  test('a DATE CHANGE moves the row one-shot: confirmed, visible, duration preserved (rung 9a)', async () => {
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
    // Rung 9a: no schema rail gates this. A date change is a plain move — the
    // agent is expected to have READ the job's record for promises first.
    const moved = await moveVisit({
      tenantId,
      visitId: assignment.id,
      date: '2026-11-10',
      startTime: '13:00',
      reason: 'customer asked for Tuesday',
      actorRef: 'manager-test',
    });
    expect(moved.visit.status).toBe('confirmed'); // BLOCKER-#1 regression pin
    // Duration preserved (09–11 was 2h → 13:00–15:00).
    expect(moved.visit.ends_at).toContain('2026-11-10T15:00');
    // Visible to the ['confirmed']-filtered read every surface uses.
    const day = await listVisitsForTechnician(
      tech.id,
      '2026-11-10T00:00:00.000Z',
      '2026-11-11T00:00:00.000Z',
      ['confirmed'],
    );
    expect(day.map((r) => r.id)).toContain(moved.visit.id);
    // Event trail records where it landed.
    const events = await listScheduleEventsSince(tenantId, 0, 100);
    const movedEvent = events.find((e) => e.assignment_id === moved.visit.id && e.kind === 'moved');
    expect(movedEvent?.detail).toMatchObject({ toDay: '2026-11-10' });
  });

  test('same-day time shuffle: the overlap pre-check excludes the moved row itself', async () => {
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
      visitId: assignment.id,
      date: '2026-11-11',
      startTime: '09:30', // overlaps ONLY itself
      reason: 'shift half an hour',
      actorRef: 'manager-test',
    });
    expect(moved.visit.starts_at).toContain('2026-11-11T09:30');

    // Same-technician move onto a SUNDAY warns too (no technicianRef passed).
    const sundayMove = await moveVisit({
      tenantId,
      visitId: moved.visit.id,
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
      forceNewJob: true, // titleless repeat on one customer — a distinct real job
      actorRef: 'manager-test',
    });
    await expect(
      moveVisit({
        tenantId,
        visitId: b.assignment.id,
        date: '2026-11-12',
        startTime: '10:00', // lands inside a's 09–11
        reason: 'bad idea',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/overlaps a confirmed visit .* NOT moved/);
    // b untouched and still confirmed.
    const day = await listVisitsForTechnician(
      tech.id,
      '2026-11-12T00:00:00.000Z',
      '2026-11-13T00:00:00.000Z',
      ['confirmed'],
    );
    expect(day.map((r) => r.id).sort()).toEqual([a.assignment.id, b.assignment.id].sort());
  });

  test('the DB guard firing mid-move leaves the visit EXACTLY where it was', async () => {
    // The pre-check above catches the ordinary case. This is the RACE: the
    // blocker appears after resolveMove has read the day, so the exclusion
    // constraint is what stops it. The property that matters is what the
    // manager is told — under cancel-then-insert the visit was already gone by
    // this point and the message had to admit it; an UPDATE changes nothing.
    const customer = await createCustomer({ tenantId, name: 'Race Rita' });
    const mover = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-11-19',
      startTime: '14:00',
      endTime: '15:00',
      actorRef: 'manager-test',
    });
    // Insert the blocker straight through the db layer, so nothing in the
    // booking path has had a chance to see it.
    await createVisit({
      tenantId,
      jobId: mover.job.id,
      technicianId: tech.id,
      startsAt: '2026-11-19T09:00:00.000Z',
      endsAt: '2026-11-19T11:00:00.000Z',
      status: 'confirmed',
    });
    await expect(
      moveVisit({
        tenantId,
        visitId: mover.assignment.id,
        date: '2026-11-19',
        startTime: '09:30',
        endTime: '10:30',
        reason: 'onto a slot that just filled',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/NOT moved/);
    // Untouched: same id, same times, still on the schedule.
    const still = await getVisitForTenant(mover.assignment.id, tenantId);
    expect(still?.status).toBe('confirmed');
    expect(new Date(still?.starts_at as string).toISOString()).toBe('2026-11-19T14:00:00.000Z');
  });

  test('cross-tenant / unknown visit ids read as not found (move AND cancel)', async () => {
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
        visitId: assignment.id,
        date: '2026-11-13',
        startTime: '11:00',
        reason: 'wrong tenant',
        actorRef: 'intruder',
      }),
    ).rejects.toThrow(/visit not found/);
    await expect(
      unscheduleVisit({
        tenantId: OTHER_TENANT,
        visitId: assignment.id,
        reason: 'wrong tenant',
        actorRef: 'intruder',
      }),
    ).rejects.toThrow(/visit not found/);
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
        forceNewJob: true, // titleless repeat on one customer — a distinct real job
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
      visitId: assignment.id,
      date: '2026-11-25',
      startTime: '09:00',
      technicianRef: 'book-tech',
      reason: 'assigning Bob',
      actorRef: 'manager-test',
    });
    expect(moved.visit.technician_id).toBe(tech.id);
    expect(moved.visit.status).toBe('confirmed');
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
        forceNewJob: true, // titleless repeat on one customer — a distinct real job
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
      forceNewJob: true, // titleless repeat on one customer — a distinct real job
      actorRef: 'manager-test',
    });
    const reparked = await moveVisit({
      tenantId,
      visitId: parked.assignment.id,
      date: '2026-11-27',
      startTime: '09:00',
      reason: 'shift a day',
      actorRef: 'manager-test',
    });
    expect(reparked.visit.technician_id).toBeNull();
  });

  test('listUnassignedVisits: confirmed null-tech rows from fromISO on, no upper bound', async () => {
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
      forceNewJob: true, // titleless repeat on one customer — a distinct real job
      actorRef: 'manager-test',
    });
    // Cancelled unassigned visit — must NOT appear.
    const cancelled = await bookVisit({
      tenantId,
      customerId: customer.id,
      date: '2027-03-17',
      startTime: '09:00',
      endTime: '10:00',
      forceNewJob: true, // titleless repeat on one customer — a distinct real job
      actorRef: 'manager-test',
    });
    await unscheduleVisit({
      tenantId,
      visitId: cancelled.assignment.id,
      reason: 'never mind',
      actorRef: 'manager-test',
    });
    const listed = await listUnassignedVisits(tenantId, '2027-03-01T00:00:00.000Z');
    const ids = listed.map((r) => r.id);
    expect(ids).toContain(far.assignment.id);
    expect(ids).not.toContain(assigned.assignment.id);
    expect(ids).not.toContain(cancelled.assignment.id);
    // Past rows excluded: a from AFTER the visit hides it.
    const after = await listUnassignedVisits(tenantId, '2027-04-01T00:00:00.000Z');
    expect(after.map((r) => r.id)).not.toContain(far.assignment.id);
    // Ordered by starts_at.
    const starts = listed.map((r) => r.starts_at);
    expect([...starts].sort()).toEqual(starts);
  });
});

describe('detach (unassign) — plan 4a.5', () => {
  test('moveVisit unassign parks the visit: technician_id NULL, moved event', async () => {
    const customer = await createCustomer({ tenantId, name: 'Detach Dana' });
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-12-01',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    expect(assignment.technician_id).toBe(tech.id);
    // Preview first: a park is one-shot — nothing about it is confirm-gated.
    const preview = await previewMoveVisit({
      tenantId,
      visitId: assignment.id,
      date: '2026-12-01',
      startTime: '09:00',
      unassign: true,
      reason: 'tech pulled to an emergency',
      actorRef: 'manager-test',
    });
    expect(preview.unassign).toBe(true);
    expect(preview.requiresConfirmation).toBe(false);
    expect(preview.technicianName).toBeNull(); // the TARGET is nobody

    const before = await latestScheduleVersion(tenantId);
    const moved = await moveVisit({
      tenantId,
      visitId: assignment.id,
      date: '2026-12-01',
      startTime: '09:00',
      unassign: true,
      reason: 'tech pulled to an emergency',
      actorRef: 'manager-test',
    });
    expect(moved.visit.technician_id).toBeNull();
    expect(moved.visit.status).toBe('confirmed');
    // INVERTED by rung 9b: parking no longer cancels a row and mints a
    // replacement — it EDITS the visit, so the id the manager was holding is
    // still the id afterwards.
    expect(moved.visit.id).toBe(assignment.id);
    // The ledger records a plain 'moved' naming who LOST it — exactly what
    // boardNotify resolves for the "moved off your schedule" push. It used to
    // carry the predecessor's id; there is no predecessor now. A LIST since
    // rung 9c: a crew move takes several people off at once, and the singular
    // key would have named one of them.
    const events = await listScheduleEventsSince(tenantId, before);
    const ev = events.find((e) => e.assignment_id === moved.visit.id && e.kind === 'moved');
    expect(ev).toBeDefined();
    expect((ev?.detail as { previousTechnicianIds?: string[] }).previousTechnicianIds).toEqual([
      tech.id,
    ]);
    expect((ev?.detail as { technicianRefs?: string[] }).technicianRefs).toEqual([]);
    // And the parked row is now in the recall lister.
    const parked = await listUnassignedVisits(tenantId, '2026-12-01T00:00:00.000Z');
    expect(parked.map((r) => r.id)).toContain(moved.visit.id);
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
        visitId: assignment.id,
        date: '2026-12-02',
        startTime: '09:00',
        technicianRef: 'book-tech',
        unassign: true,
        reason: 'contradiction',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/pass ONE of technicianRef.* or unassign/);
    expect((await listVisitsForTechnician(tech.id, '2026-12-02T00:00:00.000Z', '2026-12-03T00:00:00.000Z')).map((r) => r.id)).toContain(assignment.id);
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
      forceNewJob: true, // titleless repeat on one customer — a distinct real job
      actorRef: 'manager-test',
    });
    await expect(
      moveVisit({
        tenantId,
        visitId: assignment.id,
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
      visitId: assignment.id,
      date: '2026-12-03',
      startTime: '13:00',
      endTime: '14:00',
      unassign: true,
      reason: 'park it',
      actorRef: 'manager-test',
    });
    expect(moved.visit.technician_id).toBeNull();
  });

});

describe('untimed bookings + placing them — plan 4b-2, rung 9a', () => {
  async function mkCustomer(name: string) {
    return createCustomer({ tenantId, name });
  }

  test('an UNTIMED booking stores no date at all; the shell stays duration-less', async () => {
    const customer = await mkCustomer('TBD Tina');
    // Rung 9a: omitting date AND both times is the whole shape. Nothing
    // records when it should happen — that lives in the conversation.
    const r = await bookVisit({
      tenantId,
      customerId: customer.id,
      title: 'untimed single',
      actorRef: 'mgr',
    });
    expect(r.assignment.starts_at).toBeNull();
    expect(r.assignment.ends_at).toBeNull();
    expect(r.assignment.status).toBe('confirmed');
    // No span was measured — the never-guess rule holds for the shell too.
    expect(r.job.duration_minutes).toBeNull();
  });

  test('PARTIAL time input is rejected — all three or none', async () => {
    const customer = await mkCustomer('TBD Mix');
    // A date with no times: the accident the "all or none" rule catches.
    await expect(
      bookVisit({ tenantId, customerId: customer.id, date: '2026-11-19', actorRef: 'mgr' }),
    ).rejects.toThrow(/date AND both times, or none of the three/);
    // A start with no end, and times with no day.
    await expect(
      bookVisit({
        tenantId, customerId: customer.id, date: '2026-11-19', startTime: '09:00', actorRef: 'mgr',
      }),
    ).rejects.toThrow(/date AND both times, or none of the three/);
    await expect(
      bookVisit({
        tenantId, customerId: customer.id, startTime: '09:00', endTime: '10:00', actorRef: 'mgr',
      }),
    ).rejects.toThrow(/date AND both times, or none of the three/);
  });

  test('the twin key is the JOB + the person: a retry refuses, a second job books', async () => {
    // The retry hazard the guard exists for: untimed rows are exempt from the
    // DB overlap guard, so a transport retry would duplicate silently. Rung 9a
    // re-keyed it from the date range (gone) onto the JOB — and it stays keyed
    // on the person for the original final-review reason.
    const customer = await mkCustomer('TBD Two Trades');
    const first = await bookVisit({
      tenantId, customerId: customer.id, title: 'first trade',
      technicianRef: 'book-tech', actorRef: 'mgr',
    });
    // The SAME job and the same person again: a retry.
    await expect(
      bookVisit({
        tenantId, jobId: first.job.id, technicianRef: 'book-tech', actorRef: 'mgr',
      }),
    ).rejects.toThrow(/untimed visit for .* already exists on this job/);
    // Two trades on one customer ("plumber then electrician") is legitimate
    // work, not a duplicate — a DIFFERENT job books fine.
    const second = await bookVisit({
      tenantId, customerId: customer.id, title: 'second trade',
      technicianRef: 'helper-hank', actorRef: 'mgr',
    });
    expect(second.assignment.starts_at).toBeNull();
    expect(second.job.id).not.toBe(first.job.id);
    // A DIFFERENT person on the same job is not a retry either.
    const otherPerson = await bookVisit({
      tenantId, jobId: first.job.id, technicianRef: 'helper-hank', actorRef: 'mgr',
    });
    expect(otherPerson.assignment.technician_id).not.toBe(first.assignment.technician_id);
  });

  test('moving an untimed visit to real times PLACES it', async () => {
    const customer = await mkCustomer('TBD Place');
    const booked = await bookVisit({
      tenantId, customerId: customer.id, title: 'place me', actorRef: 'mgr',
    });
    const moved = await moveVisit({
      tenantId,
      visitId: booked.assignment.id,
      date: '2026-11-30',
      startTime: '09:00',
      endTime: '10:30',
      technicianRef: tech.ref,
      reason: 'placing the visit',
      actorRef: 'mgr',
    });
    expect(moved.visit.starts_at).toBe('2026-11-30T09:00:00+00:00');
    expect(moved.visit.ends_at).toBe('2026-11-30T10:30:00+00:00');
    expect(moved.visit.technician_id).toBe(tech.id);
  });

  test('placing without endTime uses the job length; errors when that is null too', async () => {
    const customer = await mkCustomer('TBD Length');
    const withLen = await bookVisit({
      tenantId, customerId: customer.id, title: 'has length', actorRef: 'mgr',
    });
    await updateJobDetails(tenantId, withLen.job.id, { durationMinutes: 90 },
      (await getJob(withLen.job.id))!.updated_at);
    const moved = await moveVisit({
      tenantId, visitId: withLen.assignment.id,
      date: '2026-12-01', startTime: '13:00',
      reason: 'placing with job length', actorRef: 'mgr',
    });
    expect(moved.visit.ends_at).toBe('2026-12-01T14:30:00+00:00'); // 13:00 + 90m

    const noLen = await bookVisit({
      tenantId, customerId: customer.id, title: 'no length', actorRef: 'mgr',
    });
    await expect(
      moveVisit({
        tenantId, visitId: noLen.assignment.id,
        date: '2026-12-02', startTime: '13:00',
        reason: 'no length anywhere', actorRef: 'mgr',
      }),
    ).rejects.toThrow(/no recorded length/);
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
      visitId: assignment.id,
      reason: 'customer cancelled',
      actorRef: 'manager-test',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.reason).toBe('customer cancelled');
    expect(await latestScheduleVersion(tenantId)).toBeGreaterThan(before);
    // The job survives a cancelled visit (rebooking is the job machine's business).
    expect((await getJob(job.id))?.status).toBe('open');
  });

  test('the ONE surviving gate: a PLACED visit confirms, an unplaced one is one-shot', async () => {
    const customer = await createCustomer({ tenantId, name: 'Gate Gale' });
    // Placed = it has a real time, so a customer is expecting it. Rung 9a kept
    // exactly this confirmation and dropped the other two (book and move).
    const placed = await bookVisit({
      tenantId,
      technicianRef: 'book-tech',
      customerId: customer.id,
      date: '2026-11-17',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'manager-test',
    });
    const placedPreview = await previewUnscheduleVisit(tenantId, placed.assignment.id);
    expect(placedPreview.requiresConfirmation).toBe(true);
    expect(placedPreview.day).toBe('2026-11-17');

    // Untimed = nobody's appointment yet. Dropping it needs no ceremony.
    const unplaced = await bookVisit({
      tenantId,
      customerId: customer.id,
      title: 'not placed yet',
      actorRef: 'manager-test',
    });
    const unplacedPreview = await previewUnscheduleVisit(tenantId, unplaced.assignment.id);
    expect(unplacedPreview.requiresConfirmation).toBe(false);
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
      actorRef: 'manager-test',
    });
    const completedRow = await updateVisitStatus(done.assignment.id, 'completed');
    expect(completedRow.status).toBe('completed');

    // Preview: both LIVE visits listed with their promise levels; completed
    // row absent; requiresConfirmation is always true (terminal).
    const preview = await previewCancelJob(tenantId, jobId);
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.jobTitle).toBe('full repipe');
    expect(preview.customerName).toBe('Terminal Tess');
    expect(preview.visits.map((v) => v.visitId).sort()).toEqual(
      [first.assignment.id, parked.assignment.id].sort(),
    );
    expect(preview.visits.find((v) => v.visitId === first.assignment.id)?.technicianRef).toBe(
      'book-tech',
    );
    expect(preview.visits.find((v) => v.visitId === parked.assignment.id)?.technicianRef).toBeNull();

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
    const rows = await listVisitsForJob(jobId);
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

// ── Rung 9c: the verbs carry a crew ─────────────────────────────────────────
//
// December 2026 dates, and a pair of technicians of this block's own — the
// tests here book the two against each other on purpose, and a collision with
// another block's fixture would read as a bug in the guard.
describe('a crew books, moves and is told (rung 9c)', () => {
  let ben: Technician;
  let joy: Technician;
  let customerId: string;

  const D = (day: number) => `2026-12-${String(day).padStart(2, '0')}`;

  beforeAll(async () => {
    ben = await insertTechnician({ tenantId, ref: 'crew-ben', displayName: 'Ben Crew' });
    joy = await insertTechnician({ tenantId, ref: 'crew-joy', displayName: 'Joy Crew' });
    await setTechnicianAvailability(ben.id, WEEKDAYS_ONLY);
    await setTechnicianAvailability(joy.id, WEEKDAYS_ONLY);
    customerId = (await createCustomer({ tenantId, name: 'Crew Casa' })).id;
  });

  const book = async (day: number, start: string, end: string, refs: string[], title: string) =>
    bookVisit({
      tenantId,
      customerId,
      title,
      forceNewJob: true,
      technicianRefs: refs,
      date: D(day),
      startTime: start,
      endTime: end,
      actorRef: 'manager-test',
    });

  test('two refs make ONE visit with two people, and one `booked` event naming both', async () => {
    const before = await latestScheduleVersion(tenantId);
    const booked = await book(21, '09:00', '11:00', [ben.ref, joy.ref], 'Crew job A');
    expect(booked.technicianRefs).toEqual(['crew-ben', 'crew-joy']);
    expect(booked.technicianNames).toEqual(['Ben Crew', 'Joy Crew']);
    expect((await listParticipants(booked.assignment.id)).map((p) => p.technician_id)).toEqual([
      ben.id,
      joy.id,
    ]);
    // ONE trip on the job, not one per person.
    expect(await listVisitsForJob(booked.job.id)).toHaveLength(1);
    // ONE event, carrying the whole crew.
    const events = (await listScheduleEventsSince(tenantId, before)).filter(
      (e) => e.assignment_id === booked.assignment.id && e.kind === 'booked',
    );
    expect(events).toHaveLength(1);
    expect((events[0].detail as { technicianRefs?: string[] }).technicianRefs).toEqual([
      'crew-ben',
      'crew-joy',
    ]);
    // And it lands on BOTH their days.
    for (const t of [ben, joy]) {
      const day = await listVisitsForTechnician(
        t.id,
        `${D(21)}T00:00:00.000Z`,
        `${D(22)}T00:00:00.000Z`,
      );
      expect(day.map((r) => r.id)).toContain(booked.assignment.id);
    }
  });

  test('an unknown SECOND ref is refused BY NAME, and no visit is left behind', async () => {
    const jobsBefore = (await listUnassignedOpenJobs(tenantId)).length;
    await expect(
      book(22, '09:00', '11:00', [ben.ref, 'nobody-here'], 'Crew job B'),
    ).rejects.toThrow(/technician 'nobody-here' not found/);
    // The refusal happens in the resolve half, BEFORE the job shell is minted —
    // so there is no orphaned open job and no half-crewed visit.
    expect((await listUnassignedOpenJobs(tenantId)).length).toBe(jobsBefore);
    const bensDay = await listVisitsForTechnician(
      ben.id,
      `${D(22)}T00:00:00.000Z`,
      `${D(23)}T00:00:00.000Z`,
    );
    expect(bensDay).toHaveLength(0);
  });

  test('one busy crew member refuses the whole booking, and the error names WHICH one', async () => {
    await book(23, '09:00', '11:00', [joy.ref], 'Joys other job');
    await expect(
      book(23, '10:00', '12:00', [ben.ref, joy.ref], 'Crew job C'),
    ).rejects.toThrow(/Joy Crew already has a confirmed visit overlapping 2026-12-23 10:00–12:00/);
  });

  test('technicianRefs on a move REPLACES the crew; the event carries who was on it before', async () => {
    const booked = await book(24, '09:00', '11:00', [ben.ref, joy.ref], 'Crew job D');
    const before = await latestScheduleVersion(tenantId);
    const moved = await moveVisit({
      tenantId,
      visitId: booked.assignment.id,
      date: D(24),
      startTime: '14:00',
      technicianRefs: [joy.ref],
      reason: 'ben is off the job',
      actorRef: 'manager-test',
    });
    expect(moved.technicianRefs).toEqual(['crew-joy']);
    expect(moved.previousTechnicianIds.slice().sort()).toEqual([ben.id, joy.id].slice().sort());
    expect((await listParticipants(booked.assignment.id)).map((p) => p.technician_id)).toEqual([
      joy.id,
    ]);
    const ev = (await listScheduleEventsSince(tenantId, before)).find(
      (e) => e.assignment_id === booked.assignment.id && e.kind === 'moved',
    );
    const detail = ev?.detail as { previousTechnicianIds?: string[]; technicianRefs?: string[] };
    expect(detail.previousTechnicianIds?.slice().sort()).toEqual([ben.id, joy.id].slice().sort());
    expect(detail.technicianRefs).toEqual(['crew-joy']);
  });

  test('a pure time-move leaves the crew alone', async () => {
    const booked = await book(25, '09:00', '11:00', [ben.ref, joy.ref], 'Crew job E');
    const moved = await moveVisit({
      tenantId,
      visitId: booked.assignment.id,
      date: D(25),
      startTime: '14:00',
      reason: 'customer asked for the afternoon',
      actorRef: 'manager-test',
    });
    // Saying nothing about WHO must not quietly empty a two-person trip.
    expect(moved.technicianRefs).toEqual(['crew-ben', 'crew-joy']);
  });

  test('a move is refused BEFORE the write when one crew member is busy at the target', async () => {
    await book(26, '14:00', '16:00', [joy.ref], 'Joys afternoon');
    const booked = await book(26, '09:00', '11:00', [ben.ref, joy.ref], 'Crew job F');
    await expect(
      moveVisit({
        tenantId,
        visitId: booked.assignment.id,
        date: D(26),
        startTime: '14:00',
        reason: 'try the afternoon',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/that slot overlaps a confirmed visit for Joy Crew on 2026-12-26/);
    // Nothing moved, and the crew is untouched.
    const after = await getVisitForTenant(booked.assignment.id, tenantId);
    expect(new Date(after?.starts_at as string).toISOString()).toBe(`${D(26)}T09:00:00.000Z`);
    expect((await listParticipants(booked.assignment.id)).map((p) => p.technician_id)).toEqual([
      ben.id,
      joy.id,
    ]);
  });

  test('reassign-and-move succeeds when the LEAVER is the one busy at the target', async () => {
    // "Joy cannot make the afternoon, send Ben" — and the trip moves onto the
    // slot JOY is booked in. She is leaving, so she is not checked and her copy
    // is off the visit before the times change (the rung 9c order).
    await book(27, '14:00', '16:00', [joy.ref], 'Joys afternoon 27');
    const booked = await book(27, '09:00', '11:00', [ben.ref, joy.ref], 'Crew job G');
    const moved = await moveVisit({
      tenantId,
      visitId: booked.assignment.id,
      date: D(27),
      startTime: '14:00',
      technicianRefs: [ben.ref],
      reason: 'joy is out, ben covers it',
      actorRef: 'manager-test',
    });
    expect(moved.technicianRefs).toEqual(['crew-ben']);
    expect(moved.crewNotAdded).toEqual([]);
    expect(new Date(moved.visit.starts_at as string).toISOString()).toBe(`${D(27)}T14:00:00.000Z`);
  });

  test('unassign:true empties the crew', async () => {
    const booked = await book(28, '09:00', '11:00', [ben.ref, joy.ref], 'Crew job H');
    const moved = await moveVisit({
      tenantId,
      visitId: booked.assignment.id,
      date: D(28),
      startTime: '09:00',
      unassign: true,
      reason: 'park it',
      actorRef: 'manager-test',
    });
    expect(moved.technicianRefs).toEqual([]);
    expect(await listParticipants(booked.assignment.id)).toHaveLength(0);
    expect((await listUnassignedVisits(tenantId, `${D(28)}T00:00:00.000Z`)).map((r) => r.id)).toContain(
      booked.assignment.id,
    );
  });

  test('unassign with technicianRefs is refused', async () => {
    const booked = await book(29, '09:00', '11:00', [ben.ref], 'Crew job I');
    await expect(
      moveVisit({
        tenantId,
        visitId: booked.assignment.id,
        date: D(29),
        startTime: '09:00',
        technicianRefs: [joy.ref],
        unassign: true,
        reason: 'contradiction',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/not both/);
  });

  test('a joiner lost to a RACE is reported as "moved, but not added" — never as "not moved"', async () => {
    // The pre-check refuses an ordinary busy joiner before anything is written
    // (the test above). This is the other half: the slot is taken between the
    // check and the write. The move is real and one person is missing, and the
    // manager has to be told BOTH — reporting "the visit has NOT moved" for
    // this would be the opposite of what happened.
    //
    // Deterministic via a row lock, not a sleep (the scheduling.test.ts idiom):
    // a second connection holds the visit row, so the move's UPDATE blocks; the
    // lock holder books Joy into the target slot and commits, and the move then
    // proceeds and fails only on adding her.
    const booked = await book(31, '09:00', '11:00', [ben.ref], 'Crew job K');
    const locker = new Client({ connectionString: process.env.DATABASE_URL });
    await locker.connect();
    let moved: Awaited<ReturnType<typeof moveVisit>>;
    try {
      await locker.query('begin');
      await locker.query('select id from visits where id = $1 for update', [booked.assignment.id]);
      const racer = moveVisit({
        tenantId,
        visitId: booked.assignment.id,
        date: D(31),
        startTime: '14:00',
        endTime: '16:00',
        technicianRefs: [ben.ref, joy.ref],
        reason: 'add joy on the way',
        actorRef: 'manager-test',
      });
      // WAIT until the move is actually blocked on the lock. Booking Joy before
      // that is the difference between the race this test means to stage and a
      // plain busy-joiner, which the pre-check refuses — the assertion would
      // then fail intermittently for the wrong reason.
      for (let i = 0; ; i++) {
        const { rows } = await locker.query<{ n: number }>(
          'select count(*)::int as n from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0',
        );
        if (rows[0].n > 0) break;
        if (i > 400) throw new Error('the move never blocked on the row lock');
        await new Promise((r) => setTimeout(r, 25));
      }
      // Joy takes the target slot while the move is blocked on the lock.
      await book(31, '14:00', '16:00', [joy.ref], 'Joys race booking');
      await locker.query('commit');
      moved = await racer;
    } finally {
      await locker.end();
    }
    // The visit DID move, and Ben went with it.
    expect(new Date(moved.visit.starts_at as string).toISOString()).toBe(`${D(31)}T14:00:00.000Z`);
    expect(moved.technicianRefs).toEqual(['crew-ben']);
    // And Joy is named as the one who could not come.
    expect(moved.crewNotAdded).toEqual(['crew-joy']);
    expect(moved.warning).toMatch(/moved to 2026-12-31 14:00–16:00, but Joy Crew already has a confirmed visit there — they were NOT added/);
  });

  test('a present-but-EMPTY ref or list is refused — never read as "nobody"', async () => {
    const booked = await book(1, '09:00', '11:00', [ben.ref], 'Crew job L');
    // On a move, '' used to mean "keep the crew" and [] means "park it" — two
    // readings of the same accident. Both are refused at the verb, so no
    // surface can drift from another.
    await expect(
      moveVisit({
        tenantId,
        visitId: booked.assignment.id,
        date: D(1),
        startTime: '14:00',
        technicianRef: '',
        reason: 'empty ref',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/technicianRef was empty/);
    await expect(
      moveVisit({
        tenantId,
        visitId: booked.assignment.id,
        date: D(1),
        startTime: '14:00',
        technicianRefs: [],
        reason: 'empty list',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/technicianRefs was empty/);
    // Nothing moved and nobody came off.
    expect((await listParticipants(booked.assignment.id)).map((p) => p.technician_id)).toEqual([
      ben.id,
    ]);
    await expect(
      bookVisit({
        tenantId,
        customerId,
        title: 'empty crew book',
        forceNewJob: true,
        technicianRefs: [],
        date: D(2),
        startTime: '09:00',
        endTime: '10:00',
        actorRef: 'manager-test',
      }),
    ).rejects.toThrow(/technicianRefs was empty/);
  });

  test('a race names only the joiner who is ACTUALLY busy, never the innocent one', async () => {
    // One colliding joiner rolls the whole upsert back, so BOTH joiners are
    // missing from the trip — but only one of them is busy. Saying "they
    // already have a confirmed visit there" about both would tell the manager
    // something false about Joy.
    const sam = await insertTechnician({ tenantId, ref: 'crew-sam', displayName: 'Sam Crew' });
    await setTechnicianAvailability(sam.id, WEEKDAYS_ONLY);
    const booked = await book(3, '09:00', '11:00', [ben.ref], 'Crew job M');
    const locker = new Client({ connectionString: process.env.DATABASE_URL });
    await locker.connect();
    let moved: Awaited<ReturnType<typeof moveVisit>>;
    try {
      await locker.query('begin');
      await locker.query('select id from visits where id = $1 for update', [booked.assignment.id]);
      const racer = moveVisit({
        tenantId,
        visitId: booked.assignment.id,
        date: D(3),
        startTime: '14:00',
        endTime: '16:00',
        technicianRefs: [ben.ref, joy.ref, sam.ref],
        reason: 'send all three',
        actorRef: 'manager-test',
      });
      for (let i = 0; ; i++) {
        const { rows } = await locker.query<{ n: number }>(
          'select count(*)::int as n from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0',
        );
        if (rows[0].n > 0) break;
        if (i > 400) throw new Error('the move never blocked on the row lock');
        await new Promise((r) => setTimeout(r, 25));
      }
      // Only SAM takes the target slot.
      await book(3, '14:00', '16:00', [sam.ref], 'Sams race booking');
      await locker.query('commit');
      moved = await racer;
    } finally {
      await locker.end();
    }
    expect(moved.technicianRefs).toEqual(['crew-ben']);
    expect(moved.crewNotAdded.slice().sort()).toEqual(['crew-joy', 'crew-sam']);
    // Both are named as not added; only Sam is named as busy.
    expect(moved.warning).toContain('Joy Crew and Sam Crew could not be added');
    expect(moved.warning).toContain('Sam Crew already has a confirmed visit there');
    expect(moved.warning).not.toContain('Joy Crew already has');
  });

  test('the cancel preview names EVERY person on a crew visit', async () => {
    const booked = await book(30, '09:00', '11:00', [ben.ref, joy.ref], 'Crew job J');
    const preview = await previewCancelJob(tenantId, booked.job.id);
    const row = preview.visits.find((v) => v.visitId === booked.assignment.id);
    expect(row?.technicianRefs).toEqual(['crew-ben', 'crew-joy']);
    // The singular field is first-or-null, kept for callers that show one name.
    expect(row?.technicianRef).toBe('crew-ben');
  });
});
