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
  listIdenticalUnassignedVisits,
  listParticipants,
  listUnassignedVisits,
  listUntimedVisitsForJob,
  participantsOf,
  participantIdsOf,
  setVisitParticipants,
  upsertParticipants,
  stageOf,
  insertVisitNote,
  getVisitForTenant,
  isOverlapViolation,
  isJoinerFailure,
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
import { nl, type NaiveLocal } from './time.js';

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
      completedAt: nl('2026-08-16T13:00:00.000Z'),
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
  const T = (h: number) => nl(`2026-09-01T${String(h).padStart(2, '0')}:00:00.000Z`);

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
      startsAt: nl('2026-09-05T09:00:00.000Z'),
      endsAt: nl('2026-09-05T11:00:00.000Z'),
      status: 'confirmed',
    });
    const moved = await moveVisitRow(original.id, {
      startsAt: nl('2026-09-05T14:00:00.000Z'),
      endsAt: nl('2026-09-05T16:00:00.000Z'),
      reason: 'customer asked for the afternoon',
    });
    expect(moved.id).toBe(original.id); // the SAME visit
    expect(moved.status).toBe('confirmed'); // still on the schedule
    expect(moved.reason).toBe('customer asked for the afternoon');
    expect((await listParticipants(moved.id)).map((p) => p.technician_id)).toEqual([tech.id]); // same crew unless overridden
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
      startsAt: nl('2026-09-25T09:00:00.000Z'),
      endsAt: nl('2026-09-25T11:00:00.000Z'),
      status: 'confirmed',
    });
    // Explicit null = detach (the !== undefined idiom — `??` would resurrect
    // the old technician; plan 4a.5).
    const detached = await moveVisitRow(original.id, {
      startsAt: nl('2026-09-25T09:00:00.000Z'),
      endsAt: nl('2026-09-25T11:00:00.000Z'),
      technicianId: null,
      reason: 'parked',
    });
    expect(await listParticipants(detached.id)).toHaveLength(0);
    expect(detached.id).toBe(original.id);
    // Omitted still means "same technician" — the pre-4a.5 contract holds.
    const kept = await moveVisitRow(detached.id, {
      startsAt: nl('2026-09-25T13:00:00.000Z'),
      endsAt: nl('2026-09-25T15:00:00.000Z'),
      reason: 'shifted',
    });
    expect(await listParticipants(kept.id)).toHaveLength(0); // still nobody on it
    expect(kept.id).toBe(original.id);
  });

  test('a move with an invalid new range throws and changes NOTHING', async () => {
    const job = await makeJob('reschedule-guard');
    const original = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: nl('2026-09-06T09:00:00.000Z'),
      endsAt: nl('2026-09-06T11:00:00.000Z'),
      status: 'confirmed',
    });
    // Swapped start/end must not touch the confirmed booking.
    await expect(
      moveVisitRow(original.id, {
        startsAt: nl('2026-09-06T16:00:00.000Z'),
        endsAt: nl('2026-09-06T14:00:00.000Z'),
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
      startsAt: nl('2026-10-02T09:00:00.000Z'),
      endsAt: nl('2026-10-02T11:00:00.000Z'),
      status: 'confirmed',
    });
    const mover = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: nl('2026-10-02T14:00:00.000Z'),
      endsAt: nl('2026-10-02T15:00:00.000Z'),
      status: 'confirmed',
    });
    let raised: unknown;
    try {
      await moveVisitRow(mover.id, {
        startsAt: nl('2026-10-02T09:30:00.000Z'),
        endsAt: nl('2026-10-02T10:30:00.000Z'),
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
      startsAt: nl('2026-10-09T09:00:00.000Z'),
      endsAt: nl('2026-10-09T11:00:00.000Z'),
      status: 'confirmed',
    });
    await updateVisitStatus(original.id, 'cancelled', 'called off');
    await expect(
      moveVisitRow(original.id, {
        startsAt: nl('2026-10-09T14:00:00.000Z'),
        endsAt: nl('2026-10-09T15:00:00.000Z'),
        reason: 'too late',
      }),
    ).rejects.toThrow(/cannot move a cancelled visit/);
  });

  test('a status change under a move SURFACES — it is never silently overwritten', async () => {
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
      startsAt: nl('2026-10-23T09:00:00.000Z'),
      endsAt: nl('2026-10-23T11:00:00.000Z'),
      status: 'confirmed',
    });
    const locker = new Client({ connectionString: process.env.DATABASE_URL });
    await locker.connect();
    try {
      await locker.query('begin');
      await locker.query('select id from visits where id = $1 for update', [original.id]);
      const racer = moveVisitRow(original.id, {
        startsAt: nl('2026-10-23T14:00:00.000Z'),
        endsAt: nl('2026-10-23T15:00:00.000Z'),
        reason: 'moved while being cancelled',
      });
      await locker.query("update visits set status = 'cancelled' where id = $1", [original.id]);
      await locker.query('commit');
      // EITHER message is a pass, and the disjunction is the honest assertion.
      // Both statements are in flight at once, so the move's own SELECT may see
      // the row before OR after the cancel commits: before → the CAS finds no
      // matching row ("changed concurrently"); after → the terminal guard fires
      // first. Pinning one of them would be pinning a race. What must ALWAYS
      // hold is that the move refuses and changes nothing, which is what the
      // read-back below proves.
      await expect(racer).rejects.toThrow(/changed concurrently|cannot move a cancelled visit/);
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
      startsAt: nl('2026-10-16T09:00:00.000Z'), endsAt: nl('2026-10-16T10:00:00.000Z'), status: 'confirmed',
    });
    const happened = await mk({
      tenantId, jobId: job.id, technicianId: null,
      startsAt: null, endsAt: null, status: 'completed',
      completedAt: nl('2026-10-16T11:00:00.000Z'),
    });
    const reported = await mk({
      tenantId, jobId: job.id, technicianId: null,
      startsAt: null, endsAt: null, status: 'completed',
      completedAt: nl('2026-10-16T11:00:00.000Z'),
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
      startsAt: nl('2026-09-02T09:00:00.000Z'),
      endsAt: nl('2026-09-02T11:00:00.000Z'),
      status: 'confirmed',
    });
    const cancelledRow = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: nl('2026-09-02T12:00:00.000Z'),
      endsAt: nl('2026-09-02T13:00:00.000Z'),
    });
    await updateVisitStatus(cancelledRow.id, 'cancelled');
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: nl('2026-09-03T09:00:00.000Z'), // outside the window
      endsAt: nl('2026-09-03T11:00:00.000Z'),
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
        startsAt: nl('2026-10-05T09:00:00.000Z'), endsAt: null,
      }),
    ).rejects.toThrow(/BOTH times, or neither/);
    await expect(
      createVisit({
        tenantId, jobId: job.id, technicianId: null,
        startsAt: null, endsAt: nl('2026-10-05T10:00:00.000Z'),
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
    const D = (h: number) => nl(`2026-10-12T${String(h).padStart(2, '0')}:00:00.000Z`);
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
      startsAt: nl('2026-10-10T09:00:00.000Z'),
      endsAt: nl('2026-10-10T11:00:00.000Z'),
      status: 'confirmed',
    });
    const b = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: otherTech.id,
      // Straddles the window start — overlap semantics must include it.
      startsAt: nl('2026-10-09T23:00:00.000Z'),
      endsAt: nl('2026-10-10T01:00:00.000Z'),
      status: 'confirmed',
    });
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: otherTech.id,
      startsAt: nl('2026-10-10T13:00:00.000Z'), // proposed → excluded by default
      endsAt: nl('2026-10-10T14:00:00.000Z'),
    });
    // Half-open [from, to) boundary pins (Phase-3 day windows lean on these):
    // ends exactly AT the window start / starts exactly AT the window end.
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: nl('2026-10-09T22:00:00.000Z'),
      endsAt: nl('2026-10-10T00:00:00.000Z'), // == fromISO → excluded
      status: 'confirmed',
    });
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: nl('2026-10-11T00:00:00.000Z'), // == toISO → excluded
      endsAt: nl('2026-10-11T02:00:00.000Z'),
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
  const rel = (days: number, hh: string) => {
    const d = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    return nl(`${d}T${hh}:00.000Z`);
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
    // "nobody attached" alone, and "every row has nobody on it" was the pin. An untimed visit sits on NO day, so the day view cannot show
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
    expect(found && participantIdsOf(found)).toEqual([tech.id]);
    // A row with a person AND a time is still not this reader's business.
    expect(after.some((r) => participantIdsOf(r).length > 0 && r.starts_at !== null)).toBe(false);
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
  const FROM = nl('2026-08-10T08:00:00.000Z');
  const TO = nl('2026-08-10T12:00:00.000Z');
  let tenantW: string;
  let watchJobId: string;
  let tenantB: string | undefined;

  const mkVisit = async (jobId: string, startsAt: NaiveLocal, endsAt: NaiveLocal, tid?: string) =>
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
    const atFrom = await mkVisit(watchJobId, nl('2026-08-10T07:00:00.000Z'), FROM); // ends exactly at from → IN
    const mid = await mkVisit(watchJobId, nl('2026-08-10T09:00:00.000Z'), nl('2026-08-10T10:00:00.000Z'));
    await mkVisit(watchJobId, nl('2026-08-10T11:00:00.000Z'), TO); // ends exactly at to → OUT
    const done = await mkVisit(watchJobId, nl('2026-08-10T08:30:00.000Z'), nl('2026-08-10T09:30:00.000Z'));
    await updateVisitStatus(done.id, 'completed');
    const gone = await mkVisit(watchJobId, nl('2026-08-10T10:15:00.000Z'), nl('2026-08-10T10:45:00.000Z'));
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
    const bRow = await mkVisit(bJob.id, nl('2026-08-10T09:00:00.000Z'), nl('2026-08-10T10:00:00.000Z'), tenantB);

    const rowsA = await listOverdueConfirmedVisits(tenantW, FROM, TO);
    expect(rowsA.some((r) => r.id === bRow.id)).toBe(false);
    const rowsB = await listOverdueConfirmedVisits(tenantB, FROM, TO);
    expect(rowsB.map((r) => r.id)).toEqual([bRow.id]);
  });
});

// ── Rung 9c: a visit carries a crew ─────────────────────────────────────────
//
// DEDICATED TENANT and DECEMBER dates: this block books the same two people
// against each other on purpose, and the shared seed tenant's fixtures sit in
// August–October. A stray overlap between the two would read as a bug in the
// guard rather than a fixture collision (the listOverdueConfirmedVisits note).
describe('a visit carries a crew (rung 9c)', () => {
  const D = (day: number, hour: number) =>
    nl(`2026-12-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`);
  let crewTenant: string;
  let jobId: string;
  let ben: Technician;
  let joy: Technician;

  const mk = async (over: Partial<Parameters<typeof createVisit>[0]> = {}) =>
    createVisit({
      tenantId: crewTenant,
      jobId,
      startsAt: null,
      endsAt: null,
      status: 'confirmed',
      ...over,
    });

  beforeAll(async () => {
    crewTenant = (await createTenant(`crew-tenant-${Date.now()}`)).id;
    await setTenantSeats(crewTenant, { managerSeats: 2, technicianSeats: 5 });
    const customer = await createCustomer({ tenantId: crewTenant, name: 'Crew Casa' });
    jobId = (await createJob({ tenantId: crewTenant, customerId: customer.id, title: 'Crew work' })).id;
    ben = await insertTechnician({ tenantId: crewTenant, ref: 'ben-crew', displayName: 'Ben Crew' });
    joy = await insertTechnician({ tenantId: crewTenant, ref: 'joy-crew', displayName: 'Joy Crew' });
  });

  afterAll(async () => {
    // Runs BEFORE the file-level TRUNCATE, and tenants is NO ACTION — delete the
    // children first (the listOverdueConfirmedVisits pattern). visit_participants
    // goes with its visit: the FK is ON DELETE CASCADE.
    await pg.query('delete from visits where tenant_id = $1', [crewTenant]);
    await pg.query('delete from jobs where tenant_id = $1', [crewTenant]);
    await pg.query('delete from customers where tenant_id = $1', [crewTenant]);
    await pg.query('delete from technicians where tenant_id = $1', [crewTenant]);
    await pg.query('delete from tenants where id = $1', [crewTenant]);
  });

  test('two people, ONE trip: both participants carry the visit\'s times and status', async () => {
    const v = await mk({ technicianIds: [ben.id, joy.id], startsAt: D(1, 9), endsAt: D(1, 11) });
    const parts = await listParticipants(v.id);
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.technician_id).sort()).toEqual([ben.id, joy.id].sort());
    // The derived copies — what makes the relocated guard trustworthy. No
    // caller wrote these; the fill trigger did.
    expect(parts.every((p) => new Date(p.starts_at as string).toISOString() === D(1, 9))).toBe(true);
    expect(parts.every((p) => new Date(p.ends_at as string).toISOString() === D(1, 11))).toBe(true);
    expect(parts.every((p) => p.status === 'confirmed')).toBe(true);
    // ONE row on the job — the whole point of the rung.
    expect((await listVisitsForJob(jobId)).filter((r) => r.id === v.id)).toHaveLength(1);
  });

  test('a crew-mate already booked elsewhere refuses the booking and leaves NO visit behind', async () => {
    await mk({ technicianId: joy.id, startsAt: D(2, 9), endsAt: D(2, 11) });
    const before = (await listVisitsForJob(jobId)).length;
    let raised: unknown;
    try {
      await mk({ technicianIds: [ben.id, joy.id], startsAt: D(2, 10), endsAt: D(2, 12) });
    } catch (err) {
      raised = err;
    }
    // Raised by the PARTICIPANT constraint: ben (the bridge column) is free, so
    // the visits-level guard passes and joy's participant row is what collides.
    expect(isOverlapViolation(raised)).toBe(true);
    // No phantom trip: a refused booking leaves nothing for a manager to find.
    expect((await listVisitsForJob(jobId)).length).toBe(before);
  });

  test('a move drags EVERY participant\'s copy onto the new slot', async () => {
    const v = await mk({ technicianIds: [ben.id, joy.id], startsAt: D(3, 9), endsAt: D(3, 11) });
    await moveVisitRow(v.id, { startsAt: D(3, 14), endsAt: D(3, 16), reason: 'customer asked' });
    const parts = await listParticipants(v.id);
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => new Date(p.starts_at as string).toISOString() === D(3, 14))).toBe(true);
  });

  test('APP ORDER PIN: a crew-mate can LEAVE onto a slot they are busy in', async () => {
    // Joy is on this trip AND booked elsewhere at 14:00. The manager moves the
    // trip to 14:00 and takes Joy off it: "Ben can cover it alone."
    //
    // Nothing in the DB can save this one. The sync trigger drags EVERY
    // participant's copy onto the new slot and the guard then checks each of
    // them — including Joy, who is on her way off. The only fix is the typed
    // layer taking leavers off BEFORE the UPDATE, which is what moveVisitRow
    // does. (Break that order and this test fails with an exclusion violation.)
    const joysOther = await mk({ technicianId: joy.id, startsAt: D(4, 14), endsAt: D(4, 16) });
    const v = await mk({ technicianIds: [ben.id, joy.id], startsAt: D(4, 9), endsAt: D(4, 11) });
    const moved = await moveVisitRow(v.id, {
      startsAt: D(4, 14),
      endsAt: D(4, 16),
      technicianIds: [ben.id],
      reason: 'joy is out, ben covers it',
    });
    expect(moved.id).toBe(v.id);
    expect((await listParticipants(v.id)).map((p) => p.technician_id)).toEqual([ben.id]);
    // Joy's own booking is untouched — nothing was stolen to make room.
    const other = await getVisitForTenant(joysOther.id, crewTenant);
    expect(other?.status).toBe('confirmed');
    expect(new Date(other?.starts_at as string).toISOString()).toBe(D(4, 14));
  });

  test('a list REPLACES the crew; the leaver\'s row goes with them', async () => {
    const v = await mk({ technicianIds: [ben.id, joy.id], startsAt: D(5, 9), endsAt: D(5, 11) });
    await moveVisitRow(v.id, {
      startsAt: D(5, 13),
      endsAt: D(5, 15),
      technicianIds: [joy.id],
      reason: 'ben off the job',
    });
    expect((await listParticipants(v.id)).map((p) => p.technician_id)).toEqual([joy.id]);
  });

  test('the tiebreak is STABLE and rank-free — the order the manager names them creates no lead', async () => {
    // A crew has no lead (user, 2026-09-01), but a gap has to be addressed to
    // somebody, so the tiebreak is (created_at, technician_id). A crew booked in
    // ONE call shares created_at — it is the transaction's clock — so the id
    // decides, and that is the point: naming Joy first does not make Joy senior.
    // Same two people, opposite order, SAME addressee both times.
    const benFirst = await mk({ technicianIds: [ben.id, joy.id], startsAt: D(7, 9), endsAt: D(7, 11) });
    const joyFirst = await mk({ technicianIds: [joy.id, ben.id], startsAt: D(7, 14), endsAt: D(7, 16) });
    const a = (await listParticipants(benFirst.id)).map((p) => p.technician_id);
    const b = (await listParticipants(joyFirst.id)).map((p) => p.technician_id);
    expect(a).toEqual(b);
    expect(a.slice().sort()).toEqual([ben.id, joy.id].slice().sort()); // both on both
    // And it does not wobble between reads.
    expect((await listParticipants(benFirst.id)).map((p) => p.technician_id)).toEqual(a);
    // Somebody added LATER is last, whatever their id: created_at wins before
    // the id is ever consulted.
    const later = await mk({ technicianIds: [ben.id], startsAt: D(7, 18), endsAt: D(7, 20) });
    await upsertParticipants(crewTenant, later.id, [joy.id]);
    expect((await listParticipants(later.id)).map((p) => p.technician_id)).toEqual([ben.id, joy.id]);
  });

  test('listVisitsForTechnician reaches a crew visit through EITHER person', async () => {
    const v = await mk({ technicianIds: [ben.id, joy.id], startsAt: D(8, 9), endsAt: D(8, 11) });
    const bens = await listVisitsForTechnician(ben.id, D(8, 0), D(8, 23));
    const joys = await listVisitsForTechnician(joy.id, D(8, 0), D(8, 23));
    expect(bens.map((r) => r.id)).toContain(v.id);
    // The crew-mate who is NOT the bridge column's person — invisible to this
    // reader before the rung.
    expect(joys.map((r) => r.id)).toContain(v.id);
  });

  test('"nobody is on it" means NO PARTICIPANT ROWS, across all four recall readers', async () => {
    const heldUntimed = await mk({ technicianIds: [ben.id] });
    const freeUntimed = await mk({});
    const unassigned = (await listUnassignedVisits(crewTenant, D(1, 0))).map((r) => r.id);
    expect(unassigned).toContain(freeUntimed.id);
    expect(unassigned).not.toContain(heldUntimed.id);

    const forBen = (await listUntimedVisitsForJob(crewTenant, jobId, ben.id)).map((r) => r.id);
    expect(forBen).toContain(heldUntimed.id);
    const forNobody = (await listUntimedVisitsForJob(crewTenant, jobId, null)).map((r) => r.id);
    expect(forNobody).toContain(freeUntimed.id);
    expect(forNobody).not.toContain(heldUntimed.id);

    const parkedFree = await mk({ startsAt: D(9, 9), endsAt: D(9, 11) });
    const parkedHeld = await mk({ technicianIds: [joy.id], startsAt: D(9, 9), endsAt: D(9, 11) });
    const twins = (await listIdenticalUnassignedVisits(crewTenant, D(9, 9), D(9, 11))).map((r) => r.id);
    expect(twins).toEqual([parkedFree.id]);

    const tray = (await listUnassignedVisitsWithRefs(crewTenant, D(1, 0))).map((r) => r.id);
    expect(tray).toContain(parkedFree.id);
    // Timed AND crewed is nobody's recall surface. (An UNTIMED row with a crew
    // still belongs in the tray — rung 9a — so heldUntimed is not asserted out.)
    expect(tray).not.toContain(parkedHeld.id);
  });

  test('the watcher sees a crew trip ONCE, with both names on it', async () => {
    const v = await mk({ technicianIds: [ben.id, joy.id], startsAt: D(10, 9), endsAt: D(10, 11) });
    const rows = await listOverdueConfirmedVisits(crewTenant, D(10, 10), D(10, 12));
    // One TRIP, not one per person — the gap mint counts trips.
    expect(rows.filter((r) => r.id === v.id)).toHaveLength(1);
    const crew = participantsOf(rows.find((r) => r.id === v.id)!, crewTenant);
    expect(crew.map((p) => p.ref).sort()).toEqual(['ben-crew', 'joy-crew']);
  });

  test('a colliding ADD leaves the crew exactly as it was', async () => {
    await mk({ technicianId: joy.id, startsAt: D(11, 9), endsAt: D(11, 11) });
    const v = await mk({ technicianId: ben.id, startsAt: D(11, 10), endsAt: D(11, 12) });
    let raised: unknown;
    try {
      await setVisitParticipants(crewTenant, v.id, [ben.id, joy.id]);
    } catch (err) {
      raised = err;
    }
    expect(isOverlapViolation(raised)).toBe(true);
    // The upsert is ONE statement, so it rolls back whole: Ben is still on it.
    expect((await listParticipants(v.id)).map((p) => p.technician_id)).toEqual([ben.id]);
  });

  test('a participant can never carry times its visit does not have', async () => {
    const v = await mk({ startsAt: D(12, 9), endsAt: D(12, 11) });
    // Try to lie on the way in — the fill trigger overwrites regardless.
    await pg.query(
      `insert into visit_participants (tenant_id, visit_id, technician_id, starts_at, ends_at, status)
       values ($1, $2, $3, '2020-01-01T00:00:00Z', '2020-01-01T01:00:00Z', 'proposed')`,
      [crewTenant, v.id, ben.id],
    );
    const [p] = await listParticipants(v.id);
    expect(new Date(p.starts_at as string).toISOString()).toBe(D(12, 9));
    expect(p.status).toBe('confirmed');
    // And a row whose tenant disagrees with the trip's is refused outright.
    await expect(
      pg.query(
        `insert into visit_participants (tenant_id, visit_id, technician_id)
         values ($1, $2, $3)`,
        [tenantId, v.id, joy.id],
      ),
    ).rejects.toThrow(/tenant mismatch/);
  });

  test('a crew member who is STAYING is checked, and their booking elsewhere refuses the move', async () => {
    // Re-stating the same crew in a different order changes nothing about who
    // is going, so everybody's calendar is still checked. (Under the deploy
    // bridge this case had a second failure mode — the column's holder was
    // deleted and their overlap skipped, so the move SUCCEEDED and Ben vanished
    // off the crew. The column is gone; the property it protected is asserted
    // here for good.)
    const bensOther = await mk({ technicianId: ben.id, startsAt: D(15, 14), endsAt: D(15, 16) });
    const v = await mk({ technicianIds: [ben.id, joy.id], startsAt: D(15, 9), endsAt: D(15, 11) });
    let raised: unknown;
    try {
      await moveVisitRow(v.id, {
        startsAt: D(15, 14),
        endsAt: D(15, 16),
        technicianIds: [joy.id, ben.id], // SAME crew, listed the other way round
        reason: 'both still going',
      });
    } catch (err) {
      raised = err;
    }
    expect(isOverlapViolation(raised)).toBe(true);
    // Nothing moved, and nobody was dropped.
    const after = await getVisitForTenant(v.id, crewTenant);
    expect(new Date(after?.starts_at as string).toISOString()).toBe(D(15, 9));
    expect((await listParticipants(v.id)).map((p) => p.technician_id).sort()).toEqual(
      [ben.id, joy.id].sort(),
    );
    expect((await getVisitForTenant(bensOther.id, crewTenant))?.status).toBe('confirmed');
  });

  test('setVisitParticipants REPLACES the crew', async () => {
    const v = await mk({ technicianIds: [ben.id], startsAt: D(16, 9), endsAt: D(16, 11) });
    await setVisitParticipants(crewTenant, v.id, [joy.id]);
    expect((await listParticipants(v.id)).map((p) => p.technician_id)).toEqual([joy.id]);
    // Adding somebody keeps whoever is already on it.
    await setVisitParticipants(crewTenant, v.id, [ben.id, joy.id]);
    expect((await listParticipants(v.id)).map((p) => p.technician_id).sort()).toEqual(
      [ben.id, joy.id].sort(),
    );
  });

  test('a direct UPDATE cannot desynchronise a participant from its trip', async () => {
    // The derived columns are re-derived on UPDATE too, so the guard can never
    // end up checking a time nobody is going.
    const v = await mk({ technicianIds: [ben.id], startsAt: D(17, 9), endsAt: D(17, 11) });
    await pg.query(
      `update visit_participants
          set starts_at = '2020-01-01T00:00:00Z', ends_at = '2020-01-01T01:00:00Z',
              status = 'proposed'
        where visit_id = $1`,
      [v.id],
    );
    const [p] = await listParticipants(v.id);
    expect(new Date(p.starts_at as string).toISOString()).toBe(D(17, 9));
    expect(new Date(p.ends_at as string).toISOString()).toBe(D(17, 11));
    expect(p.status).toBe('confirmed');
  });

  test('a refused re-crew puts the leavers back — it never quietly empties the trip', async () => {
    // setVisitParticipants deletes the leavers before it adds the joiners, and
    // the add is one statement that rolls back whole. Without a restore the
    // caller would be told "that slot is taken" while the person who was ALREADY
    // on the trip had been removed (Phase 1 review).
    await mk({ technicianId: joy.id, startsAt: D(19, 14), endsAt: D(19, 16) });
    const v = await mk({ technicianIds: [ben.id], startsAt: D(19, 14), endsAt: D(19, 16) });
    let raised: unknown;
    try {
      await setVisitParticipants(crewTenant, v.id, [joy.id]);
    } catch (err) {
      raised = err;
    }
    expect(isOverlapViolation(raised)).toBe(true);
    expect((await listParticipants(v.id)).map((p) => p.technician_id)).toEqual([ben.id]);
  });

  test('"moved, but could not add them" is NOT reported as "nothing moved"', async () => {
    // A joiner failure carries 23P01 too, and the two mean opposite things: one
    // says the visit is exactly where it was, the other says it moved and one
    // person is missing from it. isOverlapViolation answers the first question
    // only, so a caller cannot tell a manager the visit did not move when it did.
    const v = await mk({ technicianIds: [ben.id], startsAt: D(20, 9), endsAt: D(20, 11) });
    await mk({ technicianId: joy.id, startsAt: D(20, 14), endsAt: D(20, 16) });
    let raised: unknown;
    try {
      await moveVisitRow(v.id, {
        startsAt: D(20, 14),
        endsAt: D(20, 16),
        technicianIds: [ben.id, joy.id], // ben moves fine; joy is busy there
        reason: 'add joy on the way',
      });
    } catch (err) {
      raised = err;
    }
    expect(isJoinerFailure(raised)).toBe(true);
    expect(isOverlapViolation(raised)).toBe(false);
    // The visit really did move, and Ben went with it.
    const after = await getVisitForTenant(v.id, crewTenant);
    expect(new Date(after?.starts_at as string).toISOString()).toBe(D(20, 14));
    expect((await listParticipants(v.id)).map((p) => p.technician_id)).toEqual([ben.id]);
  });

  test('the planner views: ONE row per trip with the crew as arrays, and a per-person view', async () => {
    // The rebuilt v_schedule (20260907100100). ONE ROW PER TRIP is the whole
    // point: a row per participant would make count(*) count PEOPLE again, and
    // "how many visits on Tuesday" would double for every crew job.
    const v = await mk({ technicianIds: [ben.id, joy.id], startsAt: D(22, 9), endsAt: D(22, 11) });
    await pg.query(`select set_config('spine.tenant_id', $1, false)`, [crewTenant]);
    const { rows } = await pg.query<{
      visit_id: string;
      technician_refs: string[];
      technician_names: string[];
      stage: string;
    }>(
      `select visit_id, technician_refs, technician_names, stage
         from v_schedule where visit_id = $1`,
      [v.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].technician_refs.slice().sort()).toEqual(['ben-crew', 'joy-crew']);
    expect(rows[0].technician_names.slice().sort()).toEqual(['Ben Crew', 'Joy Crew']);
    // The names line up with the refs, position by position — two array_aggs
    // over the same ORDER BY, or a crew would be mislabelled.
    const refOrder = rows[0].technician_refs;
    const nameOrder = rows[0].technician_names;
    expect(nameOrder[refOrder.indexOf('ben-crew')]).toBe('Ben Crew');
    expect(rows[0].stage).toBe('placed');

    // v_visit_participants is the per-PERSON view: one row each.
    const { rows: parts } = await pg.query<{ technician_ref: string }>(
      `select technician_ref from v_visit_participants where visit_id = $1 order by technician_ref`,
      [v.id],
    );
    expect(parts.map((r) => r.technician_ref)).toEqual(['ben-crew', 'joy-crew']);

    // Both views are WALLED by the tenant GUC: another firm sees nothing.
    await pg.query(`select set_config('spine.tenant_id', $1, false)`, [tenantId]);
    const { rows: walledSchedule } = await pg.query(
      `select 1 from v_schedule where visit_id = $1`,
      [v.id],
    );
    expect(walledSchedule).toEqual([]);
    const { rows: walledParts } = await pg.query(
      `select 1 from v_visit_participants where visit_id = $1`,
      [v.id],
    );
    expect(walledParts).toEqual([]);
    await pg.query(`select set_config('spine.tenant_id', '', false)`);
  });

  test('a cancelled crew visit keeps both names on v_cancelled_visits', async () => {
    const v = await mk({ technicianIds: [ben.id, joy.id], startsAt: D(23, 9), endsAt: D(23, 11) });
    await updateVisitStatus(v.id, 'cancelled', 'customer called it off');
    await pg.query(`select set_config('spine.tenant_id', $1, false)`, [crewTenant]);
    const { rows } = await pg.query<{ technician_refs: string[]; reason: string }>(
      `select technician_refs, reason from v_cancelled_visits where visit_id = $1`,
      [v.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].technician_refs.slice().sort()).toEqual(['ben-crew', 'joy-crew']);
    expect(rows[0].reason).toBe('customer called it off');
    await pg.query(`select set_config('spine.tenant_id', '', false)`);
  });

  test('upsertParticipants is idempotent — a redelivered add is a no-op, not an error', async () => {
    const v = await mk({ technicianIds: [ben.id], startsAt: D(13, 9), endsAt: D(13, 11) });
    await upsertParticipants(crewTenant, v.id, [ben.id, joy.id]);
    await upsertParticipants(crewTenant, v.id, [ben.id, joy.id]);
    expect(await listParticipants(v.id)).toHaveLength(2);
  });
});
