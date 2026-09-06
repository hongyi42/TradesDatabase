import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createTenant, setTenantSeats } from './tenants.js';
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
import { appendRawCapture } from './rawCaptures.js';
import {
  createJob,
  getJob,
  updateJobDetails,
  DURATION_LADDER,
  MAX_DURATION_MINUTES,
  formatDuration,
} from './jobs.js';
import {
  createVisit,
  stageOf,
  insertVisitNote,
  getVisitForTenant,
  isOverlapViolation,
  listVisitsForJob,
  listVisitsForTechnician,
  listVisitsForTenant,
  listOverdueConfirmedVisits,
  listUnassignedVisitsWithRefs,
  listUnassignedOpenJobs,
  listUnscheduledOpenJobsWithCustomer,
  moveVisitRow,
  updateVisitStatus,
} from './visits.js';
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
// for FK chains must self-clean, and `cascade` sweeps `visits`.
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

describe('visit_notes — the note↔trip link (rung 9b)', () => {
  test('UPDATE is refused; DELETE cascades with the visit instead of pinning it', async () => {
    const customer = await createCustomer({ tenantId, name: 'Link Cust' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Link job' });
    const visit = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      status: 'completed',
      completedAt: '2026-08-16T13:00:00.000Z',
    });
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      rawText: 'linked note',
    });
    await insertVisitNote({ tenantId, visitId: visit.id, captureId: cap.id });

    // A link, once made, is never silently re-pointed at a different trip.
    await expect(
      pg.query(`update visit_notes set capture_id = capture_id where visit_id = $1`, [visit.id]),
    ).rejects.toThrow(/visit_notes is append-only/);

    // Re-linking the same pair is a no-op, not a 23505: a redelivered capture
    // resolves to the same trip and must not blow up the write path.
    await expect(
      insertVisitNote({ tenantId, visitId: visit.id, captureId: cap.id }),
    ).resolves.toBeUndefined();

    // DELETE is deliberately NOT blocked — the link dies with its visit. If it
    // were append-only on delete too, a single note would make the L2 row
    // undeletable forever, which is the trap this rung exists to escape.
    await pg.query('delete from visits where id = $1', [visit.id]);
    const left = await pg.query<{ n: string }>(
      'select count(*)::int as n from visit_notes where visit_id = $1',
      [visit.id],
    );
    expect(Number(left.rows[0].n)).toBe(0);
    // The evidence itself is untouched: L1 keeps the capture forever.
    const stillThere = await pg.query<{ n: string }>(
      'select count(*)::int as n from raw_captures where id = $1',
      [cap.id],
    );
    expect(Number(stillThere.rows[0].n)).toBe(1);
  });
});

describe('visits — the schedule half', () => {
  // One customer + job per test where isolation matters; FK chain helpers.
  async function makeJob(title: string) {
    const customer = await createCustomer({ tenantId, name: `Cust for ${title}` });
    return createJob({ tenantId, customerId: customer.id, title, status: 'open' });
  }
  const T = (h: number) => `2026-09-01T${String(h).padStart(2, '0')}:00:00.000Z`;

  test('legal transition walk proposed→confirmed→completed; illegal transitions throw', async () => {
    const job = await makeJob('walk');
    const a = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: T(8),
      endsAt: T(10),
    });
    expect(a.status).toBe('proposed');
    expect((await updateVisitStatus(a.id, 'confirmed')).status).toBe('confirmed');
    expect((await updateVisitStatus(a.id, 'completed')).status).toBe('completed');
    // completed is terminal — no cancel after the work happened.
    await expect(updateVisitStatus(a.id, 'cancelled')).rejects.toThrow(
      /Illegal visit status transition: completed → cancelled/,
    );
  });

  test('out-of-band status flip surfaces instead of being overwritten', async () => {
    const job = await makeJob('concurrent');
    const a = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: T(8),
      endsAt: T(10),
    });
    // Another writer cancels it behind our back (raw update, no typed layer).
    await pg.query(`update visits set status = 'cancelled' where id = $1`, [a.id]);
    // The transition validates against a fresh read → illegal from 'cancelled'.
    // (The narrower .eq('status') zero-row race branch — a flip BETWEEN the
    // read and the update — is not reachable from in-process tests; same
    // accepted gap as jobs.ts's guard. This proves the flip surfaces.)
    await expect(updateVisitStatus(a.id, 'confirmed')).rejects.toThrow(
      /Illegal visit status transition: cancelled → confirmed/,
    );
  });

  test('confirming an overlapping slot raises the DB guard → isOverlapViolation', async () => {
    // Shares 2026-09-01 with the walk test above — safe only because walk's
    // row ends terminal 'completed' (outside the constraint's WHERE). If this
    // test sees an unexpected 23P01 on the FIRST insert, walk broke mid-test.
    const job = await makeJob('overlap');
    const first = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: T(9),
      endsAt: T(11),
      status: 'confirmed',
    });
    // Overlapping proposal is fine (alternatives may coexist)...
    const rival = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: T(10),
      endsAt: T(12),
    });
    // ...but confirming it hits no_confirmed_overlap.
    let err: unknown;
    await updateVisitStatus(rival.id, 'confirmed').catch((e) => {
      err = e;
    });
    expect(err).toBeDefined();
    expect(isOverlapViolation(err)).toBe(true);
    expect(isOverlapViolation(new Error('random'))).toBe(false);
    // Loser untouched: still proposed; winner still confirmed.
    const rows = await listVisitsForJob(job.id);
    expect(rows.find((r) => r.id === rival.id)?.status).toBe('proposed');
    expect(rows.find((r) => r.id === first.id)?.status).toBe('confirmed');
  });

  test('a move EDITS the visit: same id, new times, ONE row — never a cancel + insert', async () => {
    // INVERTED by rung 9b. This used to assert the opposite: that a reschedule
    // cancelled the row and minted a successor with a new id. It does not any
    // more, and the difference is the whole point of the rung — a visit that
    // keeps its id can be pointed at by a gap, a note, or a manager's link
    // across a move, and an UPDATE cannot strand it half-way.
    const job = await makeJob('reschedule');
    const original = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-09-05T09:00:00.000Z',
      endsAt: '2026-09-05T11:00:00.000Z',
      status: 'confirmed',
    });
    const moved = await moveVisitRow(original.id, {
      startsAt: '2026-09-05T14:00:00.000Z',
      endsAt: '2026-09-05T16:00:00.000Z',
      reason: 'customer asked for the afternoon',
    });
    expect(moved.id).toBe(original.id); // the SAME visit
    expect(moved.status).toBe('confirmed'); // still on the schedule
    expect(moved.reason).toBe('customer asked for the afternoon');
    expect(moved.technician_id).toBe(tech.id); // same tech unless overridden
    expect(new Date(moved.starts_at as string).toISOString()).toBe('2026-09-05T14:00:00.000Z');
    expect(new Date(moved.ends_at as string).toISOString()).toBe('2026-09-05T16:00:00.000Z');

    // ONE row on the job, not two: there is no cancelled predecessor to
    // explain to anybody, and the history lives in schedule_events.
    const history = await listVisitsForJob(job.id);
    expect(history.map((r) => r.id)).toEqual([original.id]);
  });

  test('move technicianId:null DETACHES; undefined keeps the technician', async () => {
    const job = await makeJob('reschedule-detach');
    const original = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-09-25T09:00:00.000Z',
      endsAt: '2026-09-25T11:00:00.000Z',
      status: 'confirmed',
    });
    // Explicit null = detach (the !== undefined idiom — `??` would resurrect
    // the old technician; plan 4a.5).
    const detached = await moveVisitRow(original.id, {
      startsAt: '2026-09-25T09:00:00.000Z',
      endsAt: '2026-09-25T11:00:00.000Z',
      technicianId: null,
      reason: 'parked',
    });
    expect(detached.technician_id).toBeNull();
    expect(detached.id).toBe(original.id);
    // Omitted still means "same technician" — the pre-4a.5 contract holds.
    const kept = await moveVisitRow(detached.id, {
      startsAt: '2026-09-25T13:00:00.000Z',
      endsAt: '2026-09-25T15:00:00.000Z',
      reason: 'shifted',
    });
    expect(kept.technician_id).toBeNull(); // the row's own (null) kept
    expect(kept.id).toBe(original.id);
  });

  test('a move with an invalid new range throws and changes NOTHING', async () => {
    const job = await makeJob('reschedule-guard');
    const original = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-09-06T09:00:00.000Z',
      endsAt: '2026-09-06T11:00:00.000Z',
      status: 'confirmed',
    });
    // Swapped start/end must not touch the confirmed booking.
    await expect(
      moveVisitRow(original.id, {
        startsAt: '2026-09-06T16:00:00.000Z',
        endsAt: '2026-09-06T14:00:00.000Z',
        reason: 'oops',
      }),
    ).rejects.toThrow(/invalid time range.*nothing changed/);
    const rows = await listVisitsForJob(job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('confirmed'); // untouched
    expect(new Date(rows[0].starts_at as string).toISOString()).toBe('2026-09-06T09:00:00.000Z');
  });

  test('a move onto a taken slot raises 23P01 and leaves the visit EXACTLY where it was', async () => {
    // The property cancel-then-insert could not offer: a raced overlap used to
    // leave the visit cancelled with no successor — stranded, invisible to
    // every reader. One UPDATE either applies or does not.
    const job = await makeJob('move-overlap');
    const held = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-02T09:00:00.000Z',
      endsAt: '2026-10-02T11:00:00.000Z',
      status: 'confirmed',
    });
    const mover = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-02T14:00:00.000Z',
      endsAt: '2026-10-02T15:00:00.000Z',
      status: 'confirmed',
    });
    let raised: unknown;
    try {
      await moveVisitRow(mover.id, {
        startsAt: '2026-10-02T09:30:00.000Z',
        endsAt: '2026-10-02T10:30:00.000Z',
        reason: 'onto a taken slot',
      });
    } catch (err) {
      raised = err;
    }
    expect(isOverlapViolation(raised)).toBe(true);
    const after = await getVisitForTenant(mover.id, tenantId);
    expect(after?.status).toBe('confirmed');
    expect(new Date(after?.starts_at as string).toISOString()).toBe('2026-10-02T14:00:00.000Z');
    expect(held.id).not.toBe(mover.id);
  });

  test('a cancelled visit cannot be moved — the UPDATE primitive says so itself', async () => {
    const job = await makeJob('move-cas');
    const original = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-09T09:00:00.000Z',
      endsAt: '2026-10-09T11:00:00.000Z',
      status: 'confirmed',
    });
    await updateVisitStatus(original.id, 'cancelled', 'called off');
    await expect(
      moveVisitRow(original.id, {
        startsAt: '2026-10-09T14:00:00.000Z',
        endsAt: '2026-10-09T15:00:00.000Z',
        reason: 'too late',
      }),
    ).rejects.toThrow(/cannot move a cancelled visit/);
  });

  test('a move loses the CAS when the status flips between the read and the write', async () => {
    // The guard the terminal check cannot cover: the row was LIVE when
    // moveVisitRow read it, and something cancelled it before the UPDATE.
    //
    // Made deterministic with a row lock rather than a sleep. A second
    // connection holds `select … for update`, so the move's UPDATE blocks;
    // the lock holder then cancels and commits, and READ COMMITTED re-evaluates
    // the UPDATE's `status = 'confirmed'` qualifier against the new row —
    // matching nothing. Without the lock the move can simply finish first and
    // the test passes or fails on timing, which is worse than not having it.
    const job = await makeJob('move-cas');
    const original = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-23T09:00:00.000Z',
      endsAt: '2026-10-23T11:00:00.000Z',
      status: 'confirmed',
    });
    const locker = new Client({ connectionString: process.env.DATABASE_URL });
    await locker.connect();
    try {
      await locker.query('begin');
      await locker.query('select id from visits where id = $1 for update', [original.id]);
      const racer = moveVisitRow(original.id, {
        startsAt: '2026-10-23T14:00:00.000Z',
        endsAt: '2026-10-23T15:00:00.000Z',
        reason: 'moved while being cancelled',
      });
      await locker.query("update visits set status = 'cancelled' where id = $1", [original.id]);
      await locker.query('commit');
      await expect(racer).rejects.toThrow(/changed concurrently/);
    } finally {
      await locker.end();
    }
    // Untouched by the loser: still cancelled, still at its original time.
    const after = await getVisitForTenant(original.id, tenantId);
    expect(after?.status).toBe('cancelled');
    expect(new Date(after?.starts_at as string).toISOString()).toBe('2026-10-23T09:00:00.000Z');
  });

  test('stageOf agrees with v_schedule.stage, one row per stage', async () => {
    // Two definitions of the same word — the SQL case in 20260906140000 and the
    // TypeScript helper — so this pins them equal. If they drift, the agent's
    // SQL and the app's objects disagree about what a visit IS.
    const job = await makeJob('stages');
    const mk = async (over: Parameters<typeof createVisit>[0]) => createVisit(over);
    const committed = await mk({
      tenantId, jobId: job.id, technicianId: null,
      startsAt: null, endsAt: null, status: 'confirmed',
    });
    const placed = await mk({
      tenantId, jobId: job.id, technicianId: null,
      startsAt: '2026-10-16T09:00:00.000Z', endsAt: '2026-10-16T10:00:00.000Z', status: 'confirmed',
    });
    const happened = await mk({
      tenantId, jobId: job.id, technicianId: null,
      startsAt: null, endsAt: null, status: 'completed',
      completedAt: '2026-10-16T11:00:00.000Z',
    });
    const reported = await mk({
      tenantId, jobId: job.id, technicianId: null,
      startsAt: null, endsAt: null, status: 'completed',
      completedAt: '2026-10-16T11:00:00.000Z',
    });
    const cap = await appendRawCapture({
      tenantId, channel: 'technician_note', rawText: 'stage fixture',
    });
    await insertVisitNote({ tenantId, visitId: reported.id, captureId: cap.id });
    const cancelled = await mk({
      tenantId, jobId: job.id, technicianId: null,
      startsAt: null, endsAt: null, status: 'confirmed',
    });
    await updateVisitStatus(cancelled.id, 'cancelled', 'called off');

    // The TypeScript side.
    expect(stageOf(committed, false)).toBe('committed');
    expect(stageOf(placed, false)).toBe('placed');
    expect(stageOf(happened, false)).toBe('happened');
    expect(stageOf(reported, true)).toBe('reported');
    expect(stageOf({ ...cancelled, status: 'cancelled' }, false)).toBe('cancelled');

    // The SQL side, read through the view exactly as the agent would. The view
    // is tenant-scoped by a session setting, and shows confirmed + completed.
    await pg.query(`select set_config('spine.tenant_id', $1, false)`, [tenantId]);
    const { rows } = await pg.query<{ visit_id: string; stage: string }>(
      'select visit_id, stage from v_schedule where visit_id = any($1)',
      [[committed.id, placed.id, happened.id, reported.id]],
    );
    const byId = new Map(rows.map((r) => [r.visit_id, r.stage]));
    expect(byId.get(committed.id)).toBe('committed');
    expect(byId.get(placed.id)).toBe('placed');
    expect(byId.get(happened.id)).toBe('happened');
    expect(byId.get(reported.id)).toBe('reported');
    // A cancelled visit is not in v_schedule at all — v_cancelled_visits owns it.
    const { rows: gone } = await pg.query('select 1 from v_schedule where visit_id = $1', [
      cancelled.id,
    ]);
    expect(gone).toHaveLength(0);
  });

  test('listVisitsForTechnician: window overlap, live statuses by default', async () => {
    const job = await makeJob('window');
    const inWindow = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-09-02T09:00:00.000Z',
      endsAt: '2026-09-02T11:00:00.000Z',
      status: 'confirmed',
    });
    const cancelledRow = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-09-02T12:00:00.000Z',
      endsAt: '2026-09-02T13:00:00.000Z',
    });
    await updateVisitStatus(cancelledRow.id, 'cancelled');
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-09-03T09:00:00.000Z', // outside the window
      endsAt: '2026-09-03T11:00:00.000Z',
    });

    const hits = await listVisitsForTechnician(
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
    const c = await createVisit({
      tenantId,
      jobId: cancelledOnly.id,
      technicianId: tech.id,
      startsAt: T(8),
      endsAt: T(9),
    });
    await updateVisitStatus(c.id, 'cancelled');

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

  test('an UNTIMED row inserts: both times null, confirmed (rung 9a)', async () => {
    const job = await makeJob('untimed-insert');
    // INVERTED by rung 9a: this all-null row used to be REFUSED by both the
    // typed layer and `assignment_placed_or_windowed`, because a visit had to
    // hold either times or a date range. The range is gone, so "no time set"
    // is now the legal shape for committed-but-unscheduled work.
    const a = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      status: 'confirmed',
    });
    expect(a.starts_at).toBeNull();
    expect(a.ends_at).toBeNull();
    expect(a.status).toBe('confirmed');
  });

  test('HALF-timed rows are rejected; the all-null row is now legal (rung 9a)', async () => {
    const job = await makeJob('half-filled');
    // A start with no end, and an end with no start: still a half-filled row
    // that would read as placed to some surfaces and untimed to others.
    await expect(
      createVisit({
        tenantId, jobId: job.id, technicianId: null,
        startsAt: '2026-10-05T09:00:00.000Z', endsAt: null,
      }),
    ).rejects.toThrow(/BOTH times, or neither/);
    await expect(
      createVisit({
        tenantId, jobId: job.id, technicianId: null,
        startsAt: null, endsAt: '2026-10-05T10:00:00.000Z',
      }),
    ).rejects.toThrow(/BOTH times, or neither/);
    // INVERTED: the raw all-null insert used to raise
    // assignment_placed_or_windowed. That CHECK is dropped, and the surviving
    // `visits_check (ends_at > starts_at)` passes because a CHECK is
    // satisfied when it evaluates to NULL — so the row lands.
    const { rows } = await pg.query(
      `insert into visits (tenant_id, job_id) values ($1, $2)
       returning starts_at, ends_at`,
      [tenantId, job.id],
    );
    expect(rows[0].starts_at).toBeNull();
    expect(rows[0].ends_at).toBeNull();
    // The constraint really is gone, not merely unreached.
    const { rows: cons } = await pg.query(
      `select 1 from pg_constraint where conrelid = 'visits'::regclass
        and conname = 'assignment_placed_or_windowed'`,
    );
    expect(cons).toHaveLength(0);
  });

  test('the narrowed guard: placed overlaps still raise 23P01; untimed twins both insert', async () => {
    const job = await makeJob('narrowed-guard');
    const D = (h: number) => `2026-10-12T${String(h).padStart(2, '0')}:00:00.000Z`;
    // Placed protection is EXACTLY as before.
    await createVisit({
      tenantId, jobId: job.id, technicianId: tech.id,
      startsAt: D(8), endsAt: D(10), status: 'confirmed',
    });
    try {
      await createVisit({
        tenantId, jobId: job.id, technicianId: tech.id,
        startsAt: D(9), endsAt: D(11), status: 'confirmed',
      });
      expect.unreachable('overlapping placed insert must raise the exclusion constraint');
    } catch (err) {
      expect(isOverlapViolation(err)).toBe(true);
    }
    // Two UNTIMED confirmed rows for the SAME technician both insert — an
    // untimed row is demand, not schedule; tstzrange(null,null) would have
    // blocked the whole calendar without the starts_at predicate. This matters
    // MORE after rung 9a, not less: untimed rows are now the normal way work
    // waits, so there are many more of them per technician.
    const u1 = await createVisit({
      tenantId, jobId: job.id, technicianId: tech.id,
      startsAt: null, endsAt: null, status: 'confirmed',
    });
    const u2 = await createVisit({
      tenantId, jobId: job.id, technicianId: tech.id,
      startsAt: null, endsAt: null, status: 'confirmed',
    });
    expect(u1.id).not.toBe(u2.id);
  });
});

describe('assignment reads + schedule events (Plan 1, schedule core)', () => {
  async function makeJob(title: string) {
    const customer = await createCustomer({ tenantId, name: `Cust for ${title}` });
    return createJob({ tenantId, customerId: customer.id, title, status: 'open' });
  }

  test('getVisitForTenant tenant-guards; listVisitsForTenant spans technicians, confirmed-only default, overlap edges', async () => {
    const job = await makeJob('tenant-list');
    const otherTech = await insertTechnician({
      tenantId,
      ref: 'sched-tech-2',
      displayName: 'Sched Tech Two',
    });
    const a = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-10T09:00:00.000Z',
      endsAt: '2026-10-10T11:00:00.000Z',
      status: 'confirmed',
    });
    const b = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: otherTech.id,
      // Straddles the window start — overlap semantics must include it.
      startsAt: '2026-10-09T23:00:00.000Z',
      endsAt: '2026-10-10T01:00:00.000Z',
      status: 'confirmed',
    });
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: otherTech.id,
      startsAt: '2026-10-10T13:00:00.000Z', // proposed → excluded by default
      endsAt: '2026-10-10T14:00:00.000Z',
    });
    // Half-open [from, to) boundary pins (Phase-3 day windows lean on these):
    // ends exactly AT the window start / starts exactly AT the window end.
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-09T22:00:00.000Z',
      endsAt: '2026-10-10T00:00:00.000Z', // == fromISO → excluded
      status: 'confirmed',
    });
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: '2026-10-11T00:00:00.000Z', // == toISO → excluded
      endsAt: '2026-10-11T02:00:00.000Z',
      status: 'confirmed',
    });

    expect(await getVisitForTenant(a.id, tenantId)).toMatchObject({ id: a.id });
    expect(await getVisitForTenant(a.id, '00000000-0000-0000-0000-000000000000')).toBeNull();

    const day = await listVisitsForTenant(
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
  let bucketCustomerId: string;

  beforeAll(async () => {
    const customer = await createCustomer({ tenantId, name: 'Bucket Casa' });
    bucketCustomerId = customer.id;
    // Parked visit in the future (unassigned, confirmed).
    const parkedJob = await createJob({ tenantId, customerId: customer.id, title: 'Parked work' });
    parkedFutureId = (
      await createVisit({
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
    await createVisit({
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
    const c = await createVisit({
      tenantId,
      jobId: cancelledJob.id,
      technicianId: null,
      startsAt: rel(12, '09:00'),
      endsAt: rel(12, '11:00'),
      status: 'confirmed',
    });
    await updateVisitStatus(c.id, 'cancelled');
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

  test('listUnassignedVisitsWithRefs embeds names; past PLACED rows excluded; ASSIGNED UNTIMED rows included', async () => {
    const rows = await listUnassignedVisitsWithRefs(
      tenantId,
      `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
    const mine = rows.find((r) => r.id === parkedFutureId);
    expect(mine).toBeDefined();
    expect(mine?.jobs?.title).toBe('Parked work');
    expect(mine?.jobs?.customers?.name).toBe('Bucket Casa');
    // Past and cancelled parked visits are still out.
    expect(rows.some((r) => r.jobs?.title === 'Past parked')).toBe(false);
    expect(rows.some((r) => r.jobs?.title === 'Cancelled parked')).toBe(false);

    // INVERTED (rung 9a, review finding): this reader used to be keyed on
    // "nobody attached" alone, and `rows.every(technician_id === null)` was
    // the pin. An untimed visit sits on NO day, so the day view cannot show
    // it — keyed that way, attaching a person to one made it vanish from the
    // entire board. It is unscheduled work either way, so the reader is now
    // "no person OR no time".
    const assignedJob = await createJob({
      tenantId, customerId: bucketCustomerId, title: 'Assigned untimed',
    });
    const assignedUntimed = await createVisit({
      tenantId, jobId: assignedJob.id, technicianId: tech.id,
      startsAt: null, endsAt: null, status: 'confirmed',
    });
    const after = await listUnassignedVisitsWithRefs(
      tenantId,
      `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
    const found = after.find((r) => r.id === assignedUntimed.id);
    expect(found, 'an assigned UNTIMED visit must be reachable here').toBeDefined();
    expect(found?.technician_id).toBe(tech.id);
    // A row with a person AND a time is still not this reader's business.
    expect(after.some((r) => r.technician_id !== null && r.starts_at !== null)).toBe(false);
  });

  test('listUnscheduledOpenJobsWithCustomer: embeds the customer, keeps priority, anti-joins live rows', async () => {
    const jobs = await listUnscheduledOpenJobsWithCustomer(tenantId);
    const bare = jobs.find((j) => j.id === bucketJobId);
    expect(bare).toBeDefined();
    expect(bare?.customers?.name).toBe('Bucket Casa');
    expect(bare?.priority).toBe('urgent');
    // The parked visits' jobs carry LIVE (confirmed) visits → excluded.
    expect(jobs.some((j) => j.title === 'Parked work')).toBe(false);
    // The stripped embed key never leaks into the row shape.
    expect(bare && 'visits' in bare).toBe(false);
  });
});

// Stage-0 watcher candidate read (plan 2026-08-15 feature A). Times below are
// naive-local ISO (firm wall-clock as if UTC — the storage convention).
// Person-less confirmed rows on purpose: the lister filters status+times only,
// and null-technician rows sidestep the no_confirmed_overlap constraint.
// DEDICATED tenant, not the shared seed tenant: this file's loose-bucket
// describe seeds confirmed rows at RELATIVE dates (rel(-10)), and on the one
// calendar day where rel(-10) equals this window the exact-equality assertion
// below would pick up its row (review finding — fixed fixtures + relative
// fixtures must not share a tenant).
describe('listOverdueConfirmedVisits', () => {
  const FROM = '2026-08-10T08:00:00.000Z';
  const TO = '2026-08-10T12:00:00.000Z';
  let tenantW: string;
  let watchJobId: string;
  let tenantB: string | undefined;

  const mkVisit = async (jobId: string, startsAt: string, endsAt: string, tid?: string) =>
    createVisit({
      tenantId: tid ?? tenantW,
      jobId,
      technicianId: null,
      startsAt,
      endsAt,
      status: 'confirmed',
    });

  beforeAll(async () => {
    tenantW = (await createTenant(`watch-tenant-a-${Date.now()}`)).id;
    const customer = await createCustomer({ tenantId: tenantW, name: 'Watcher Casa' });
    watchJobId = (await createJob({ tenantId: tenantW, customerId: customer.id, title: 'Watched work' })).id;
  });

  afterAll(async () => {
    // This nested hook runs BEFORE the file-level TRUNCATE, so the extra
    // tenants' children still exist and the tenants FK is NO ACTION — delete
    // them explicitly first (querySpine.test.ts pattern).
    for (const t of [tenantW, tenantB]) {
      if (!t) continue;
      await pg.query('delete from visits where tenant_id = $1', [t]);
      await pg.query('delete from jobs where tenant_id = $1', [t]);
      await pg.query('delete from customers where tenant_id = $1', [t]);
      await pg.query('delete from tenants where id = $1', [t]);
    }
  });

  test('window bounds: from inclusive, to exclusive; oldest end first; non-confirmed and unplaced excluded', async () => {
    const atFrom = await mkVisit(watchJobId, '2026-08-10T07:00:00.000Z', FROM); // ends exactly at from → IN
    const mid = await mkVisit(watchJobId, '2026-08-10T09:00:00.000Z', '2026-08-10T10:00:00.000Z');
    await mkVisit(watchJobId, '2026-08-10T11:00:00.000Z', TO); // ends exactly at to → OUT
    const done = await mkVisit(watchJobId, '2026-08-10T08:30:00.000Z', '2026-08-10T09:30:00.000Z');
    await updateVisitStatus(done.id, 'completed');
    const gone = await mkVisit(watchJobId, '2026-08-10T10:15:00.000Z', '2026-08-10T10:45:00.000Z');
    await updateVisitStatus(gone.id, 'cancelled', 'watcher test');
    await createVisit({
      // unplaced (windowed) row — no times, can never match a time filter
      tenantId: tenantW,
      jobId: watchJobId,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      status: 'confirmed',
    });

    const rows = await listOverdueConfirmedVisits(tenantW, FROM, TO);
    expect(rows.map((r) => r.id)).toEqual([atFrom.id, mid.id]); // oldest ends_at first
    expect(rows.every((r) => r.status === 'confirmed')).toBe(true);
  });

  test('tenant-B row with identical times never returned', async () => {
    tenantB = (await createTenant(`watch-tenant-b-${Date.now()}`)).id;
    const bCustomer = await createCustomer({ tenantId: tenantB, name: 'Other Firm Casa' });
    const bJob = await createJob({ tenantId: tenantB, customerId: bCustomer.id, title: 'B work' });
    const bRow = await mkVisit(bJob.id, '2026-08-10T09:00:00.000Z', '2026-08-10T10:00:00.000Z', tenantB);

    const rowsA = await listOverdueConfirmedVisits(tenantW, FROM, TO);
    expect(rowsA.some((r) => r.id === bRow.id)).toBe(false);
    const rowsB = await listOverdueConfirmedVisits(tenantB, FROM, TO);
    expect(rowsB.map((r) => r.id)).toEqual([bRow.id]);
  });
});
