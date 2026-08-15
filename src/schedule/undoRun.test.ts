import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import { insertTechnician, setTechnicianAvailability, setTechnicianState } from '../db/technicians.js';
import { createCustomer } from '../db/customers.js';
import { createJob, getJob } from '../db/jobs.js';
import { getAssignmentForTenant } from '../db/assignments.js';
import { latestCommittedRun, type CommittedRun } from '../db/scheduleEvents.js';
import { bookVisit, moveVisit, setVisitLocks, setVisitPromise } from './booking.js';
import { commitResolvePlan } from './resolveCommit.js';
import { commitFreezePlan } from './freezeCommit.js';
import { commitUndoRun, planUndo } from './undoRun.js';
import type { ResolveMove, ResolvePlan, FreezePlan } from './freezeSolve.js';

// undo_run's engine (plan 2026-07-30 Phase 5), against the local stack with
// REAL runs: every fixture first commits an actual freeze/resolve run through
// the shared commit modules, then plans + commits the undo from the ledger
// trail those runs wrote — never from hand-built event rows.

const TRUNCATE =
  'truncate table customers, jobs, technicians, technician_time_off, job_type_durations, review_items, schedule_events cascade';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let customerId: string;

const ALL_WEEK = {
  mon: [['08:00', '18:00']], tue: [['08:00', '18:00']], wed: [['08:00', '18:00']],
  thu: [['08:00', '18:00']], fri: [['08:00', '18:00']], sat: [['08:00', '18:00']],
  sun: [['08:00', '18:00']],
} as never;

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
  for (const [ref, name] of [
    ['un-ray', 'Ray Undoer'],
    ['un-rita', 'Rita Undoer'],
  ] as const) {
    const t = await insertTechnician({ tenantId, ref, displayName: name });
    await setTechnicianState(t.id, 'active');
    await setTechnicianAvailability(t.id, ALL_WEEK);
  }
  customerId = (await createCustomer({ tenantId, name: 'Undo Casa' })).id;
});

afterAll(async () => {
  await pg.query(TRUNCATE);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

const plan = (over: Partial<ResolvePlan>): ResolvePlan => ({
  horizonFrom: '2027-07-01',
  horizonTo: '2027-07-31',
  placements: [],
  moves: [],
  keptCount: 0,
  skipped: [],
  capacity: [],
  ...over,
});

const book = (args: {
  technicianRef?: string;
  date: string;
  startTime: string;
  endTime: string;
  promiseLevel?: 'none' | 'day';
  title?: string;
}) =>
  bookVisit({
    tenantId,
    customerId,
    title: args.title ?? 'undo probe visit',
    // Every probe visit is its own job by design; the shared title would
    // otherwise trip the customerId mint guard on the second call.
    forceNewJob: true,
    actorRef: 'un-mgr',
    ...args,
  });

const moveOf = (
  assignmentId: string,
  from: { tech: string; date: string; start: string; end: string },
  to: { tech: string; date: string; start: string; end: string },
): ResolveMove => ({
  assignmentId,
  jobId: 'unused-by-commit',
  customer: 'Undo Casa',
  jobTitle: 'undo probe visit',
  fromTechnicianRef: from.tech,
  fromDate: from.date,
  fromStart: from.start,
  fromEnd: from.end,
  toTechnicianRef: to.tech,
  toDate: to.date,
  toStartTime: to.start,
  toEndTime: to.end,
});

// The run to undo, straight from the ledger — asserting on the way that
// latestCommittedRun really keys on the newest summary.
async function runFor(stamp: string, kind: 'freeze' | 'resolve'): Promise<CommittedRun> {
  const run = await latestCommittedRun(tenantId);
  expect(run).toMatchObject({ stamp, kind });
  return run as CommittedRun;
}

async function undoEvents(stamp: string): Promise<{ kind: string; detail: Record<string, unknown> }[]> {
  const { rows } = await pg.query(
    "select kind, detail from schedule_events where detail->>'undoRun' = $1 order by id",
    [stamp],
  );
  return rows as { kind: string; detail: Record<string, unknown> }[];
}

describe('planUndo + commitUndoRun', { timeout: 60_000 }, () => {
  test('full cycle: a resolve run (chain moves + a queue placement) restores completely — rows back at original slots, job back in the queue, every event stamped', async () => {
    const RUN = '2027-07-01T08:00:00.000Z';
    const UNDO = '2027-07-01T09:00:00.000Z';
    const a = await book({ technicianRef: 'un-ray', date: '2027-07-05', startTime: '11:00', endTime: '12:00' });
    const b = await book({ technicianRef: 'un-ray', date: '2027-07-05', startTime: '09:00', endTime: '10:00' });
    const qJob = await createJob({
      tenantId, customerId, title: 'undo placement job', status: 'open', durationMinutes: 60,
    });
    const committed = await commitResolvePlan(
      tenantId,
      plan({
        moves: [
          // a into b's vacated slot; b to the afternoon (a real chain).
          moveOf(a.assignment.id, { tech: 'un-ray', date: '2027-07-05', start: '11:00', end: '12:00' }, { tech: 'un-ray', date: '2027-07-05', start: '09:00', end: '10:00' }),
          moveOf(b.assignment.id, { tech: 'un-ray', date: '2027-07-05', start: '09:00', end: '10:00' }, { tech: 'un-ray', date: '2027-07-05', start: '13:00', end: '14:00' }),
        ],
        placements: [
          {
            kind: 'unscheduled_job',
            jobId: qJob.id,
            assignmentId: null,
            customer: 'Undo Casa',
            jobTitle: 'undo placement job',
            technicianRef: 'un-rita',
            date: '2027-07-05',
            startTime: '09:00',
            endTime: '10:00',
          },
        ],
      }),
      'un-mgr',
      RUN,
    );
    expect(committed.failed).toBeNull();

    const run = await runFor(RUN, 'resolve');
    const undoPlan = await planUndo(tenantId, run);
    expect(undoPlan.skipped).toEqual([]);
    expect(undoPlan.moves).toHaveLength(2);
    expect(undoPlan.tbdRestores).toEqual([]);
    expect(undoPlan.unschedules).toHaveLength(1);

    const result = await commitUndoRun(tenantId, undoPlan, 'un-mgr', UNDO);
    expect(result.failed).toBeNull();
    expect(result.unscheduled).toHaveLength(1);
    expect(result.movedBack).toHaveLength(2);

    // EVERY row back at its pre-run slot and person.
    const aBack = await getAssignmentForTenant(
      result.movedBack.find((m) => m.move.toStartTime === '11:00')?.assignmentId as string,
      tenantId,
    );
    expect(aBack?.starts_at?.slice(11, 16)).toBe('11:00');
    expect(aBack?.status).toBe('confirmed');
    const bBack = await getAssignmentForTenant(
      result.movedBack.find((m) => m.move.toStartTime === '09:00')?.assignmentId as string,
      tenantId,
    );
    expect(bBack?.starts_at?.slice(11, 16)).toBe('09:00');
    // The placement row is cancelled and its job is queue-visible again: an
    // open job with zero live visits.
    expect((await getJob(qJob.id))?.status).toBe('open');
    const { rows: liveForJob } = await pg.query(
      "select count(*)::int as n from assignments where job_id = $1 and status in ('confirmed','proposed')",
      [qJob.id],
    );
    expect(liveForJob[0].n).toBe(0);
    // Ledger: 1 cancelled + park/attach-shaped moved events + the summary,
    // every one stamped with THIS undo.
    const events = await undoEvents(UNDO);
    expect(events.filter((e) => e.kind === 'cancelled')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'moved').length).toBeGreaterThanOrEqual(2);
    expect(events.find((e) => e.kind === 'undo_committed')?.detail).toMatchObject({
      undoRun: UNDO,
      undid: RUN,
      undidKind: 'resolve',
      restored: 3,
      skipped: 0,
    });
  });

  test('a swap the run PARKED collapses to one restore per visit — no bogus drift skips, nothing person-less after the undo', async () => {
    const RUN = '2027-07-02T08:00:00.000Z';
    const UNDO = '2027-07-02T09:00:00.000Z';
    const s1 = await book({ technicianRef: 'un-ray', date: '2027-07-07', startTime: '09:00', endTime: '10:00' });
    const s2 = await book({ technicianRef: 'un-ray', date: '2027-07-07', startTime: '10:30', endTime: '11:30' });
    const committed = await commitResolvePlan(
      tenantId,
      plan({
        moves: [
          moveOf(s1.assignment.id, { tech: 'un-ray', date: '2027-07-07', start: '09:00', end: '10:00' }, { tech: 'un-ray', date: '2027-07-07', start: '10:30', end: '11:30' }),
          moveOf(s2.assignment.id, { tech: 'un-ray', date: '2027-07-07', start: '10:30', end: '11:30' }, { tech: 'un-ray', date: '2027-07-07', start: '09:00', end: '10:00' }),
        ],
      }),
      'un-mgr',
      RUN,
    );
    expect(committed.failed).toBeNull();
    // The forward run wrote THREE moved events (park + two arrivals) for TWO
    // visits — the collapse must plan exactly two restores and zero skips.
    const undoPlan = await planUndo(tenantId, await runFor(RUN, 'resolve'));
    expect(undoPlan.moves).toHaveLength(2);
    expect(undoPlan.skipped).toEqual([]);
    const result = await commitUndoRun(tenantId, undoPlan, 'un-mgr', UNDO);
    expect(result.failed).toBeNull();
    expect(result.movedBack).toHaveLength(2);
    // Both visits back at their pre-run slots, both with a person attached.
    for (const m of result.movedBack) {
      const row = await getAssignmentForTenant(m.assignmentId, tenantId);
      expect(row?.starts_at?.slice(11, 16)).toBe(m.move.toStartTime);
      expect(row?.technician_id).not.toBeNull();
    }
    const { rows } = await pg.query(
      "select count(*)::int as n from assignments where tenant_id = $1 and status = 'confirmed' and technician_id is null and starts_at >= '2027-07-07' and starts_at < '2027-07-08'",
      [tenantId],
    );
    expect(rows[0].n).toBe(0);
  });

  test('a placement in a freed gap unschedules BEFORE the inverse move returns — no overlap error', async () => {
    const RUN = '2027-07-03T08:00:00.000Z';
    const UNDO = '2027-07-03T09:00:00.000Z';
    const m1 = await book({ technicianRef: 'un-ray', date: '2027-07-09', startTime: '09:00', endTime: '10:00' });
    const gapJob = await createJob({
      tenantId, customerId, title: 'gap filler', status: 'open', durationMinutes: 60,
    });
    const committed = await commitResolvePlan(
      tenantId,
      plan({
        moves: [
          moveOf(m1.assignment.id, { tech: 'un-ray', date: '2027-07-09', start: '09:00', end: '10:00' }, { tech: 'un-ray', date: '2027-07-09', start: '13:00', end: '14:00' }),
        ],
        placements: [
          {
            kind: 'unscheduled_job',
            jobId: gapJob.id,
            assignmentId: null,
            customer: 'Undo Casa',
            jobTitle: 'gap filler',
            technicianRef: 'un-ray',
            // EXACTLY the slot the move vacated: the undo's inverse move must
            // come back here, which only works if the placement vacates first.
            date: '2027-07-09',
            startTime: '09:00',
            endTime: '10:00',
          },
        ],
      }),
      'un-mgr',
      RUN,
    );
    expect(committed.failed).toBeNull();
    const result = await commitUndoRun(
      tenantId,
      await planUndo(tenantId, await runFor(RUN, 'resolve')),
      'un-mgr',
      UNDO,
    );
    expect(result.failed).toBeNull();
    const back = await getAssignmentForTenant(result.movedBack[0].assignmentId, tenantId);
    expect(back?.starts_at?.slice(11, 16)).toBe('09:00');
  });

  test('drift: a hand-moved row is skipped EXACTLY (by its now-cancelled minted id) while the rest restores', async () => {
    const RUN = '2027-07-04T08:00:00.000Z';
    const UNDO = '2027-07-04T09:00:00.000Z';
    const d1 = await book({ technicianRef: 'un-rita', date: '2027-07-11', startTime: '09:00', endTime: '10:00' });
    const d2 = await book({ technicianRef: 'un-rita', date: '2027-07-11', startTime: '11:00', endTime: '12:00' });
    const committed = await commitResolvePlan(
      tenantId,
      plan({
        moves: [
          moveOf(d1.assignment.id, { tech: 'un-rita', date: '2027-07-11', start: '09:00', end: '10:00' }, { tech: 'un-rita', date: '2027-07-11', start: '14:00', end: '15:00' }),
          moveOf(d2.assignment.id, { tech: 'un-rita', date: '2027-07-11', start: '11:00', end: '12:00' }, { tech: 'un-rita', date: '2027-07-11', start: '15:30', end: '16:30' }),
        ],
      }),
      'un-mgr',
      RUN,
    );
    expect(committed.failed).toBeNull();
    const d1Minted = committed.movedRows.find((m) => m.move.assignmentId === d1.assignment.id)
      ?.assignmentId as string;
    // The manager moves d1 again BY HAND after the run — the minted row is
    // now cancelled (moves remint), which is exactly how drift presents.
    const hand = await moveVisit({
      tenantId,
      assignmentId: d1Minted,
      date: '2027-07-12',
      startTime: '08:00',
      reason: 'manager hand move after the run',
      actorRef: 'un-mgr',
    });
    const undoPlan = await planUndo(tenantId, await runFor(RUN, 'resolve'));
    expect(undoPlan.skipped).toEqual([
      expect.objectContaining({
        ref: d1Minted,
        reason: expect.stringContaining('changed since the run'),
      }),
    ]);
    expect(undoPlan.moves).toHaveLength(1);
    const result = await commitUndoRun(tenantId, undoPlan, 'un-mgr', UNDO);
    expect(result.failed).toBeNull();
    // d2 restored; d1 stays where the manager's HAND put it.
    const d2Back = await getAssignmentForTenant(result.movedBack[0].assignmentId, tenantId);
    expect(d2Back?.starts_at?.slice(11, 16)).toBe('11:00');
    const handRow = await getAssignmentForTenant(hand.created.id, tenantId);
    expect(handRow?.status).toBe('confirmed');
    expect(handRow?.starts_at).toContain('2027-07-12T08:00');
  });

  test('a row PINNED since the run is skipped with the unpin-to-restore copy; a post-run promise makes the belt skip its inverse move', async () => {
    const RUN = '2027-07-05T08:00:00.000Z';
    const UNDO = '2027-07-05T09:00:00.000Z';
    const pinned = await book({ technicianRef: 'un-ray', date: '2027-07-14', startTime: '09:00', endTime: '10:00' });
    const promised = await book({ technicianRef: 'un-ray', date: '2027-07-14', startTime: '11:00', endTime: '12:00' });
    const committed = await commitResolvePlan(
      tenantId,
      plan({
        moves: [
          moveOf(pinned.assignment.id, { tech: 'un-ray', date: '2027-07-14', start: '09:00', end: '10:00' }, { tech: 'un-ray', date: '2027-07-15', start: '09:00', end: '10:00' }),
          moveOf(promised.assignment.id, { tech: 'un-ray', date: '2027-07-14', start: '11:00', end: '12:00' }, { tech: 'un-ray', date: '2027-07-15', start: '11:00', end: '12:00' }),
        ],
      }),
      'un-mgr',
      RUN,
    );
    expect(committed.failed).toBeNull();
    const pinnedMinted = committed.movedRows.find((m) => m.move.assignmentId === pinned.assignment.id)
      ?.assignmentId as string;
    const promisedMinted = committed.movedRows.find((m) => m.move.assignmentId === promised.assignment.id)
      ?.assignmentId as string;
    // The manager pins one row (the pin OFFER makes this the NORMAL post-run
    // state) and promises the other's NEW day to the customer.
    await setVisitLocks(tenantId, { assignmentIds: [pinnedMinted] }, true, 'un-mgr');
    await setVisitPromise(tenantId, promisedMinted, 'day', 'un-mgr');

    const undoPlan = await planUndo(tenantId, await runFor(RUN, 'resolve'));
    // The pinned row never becomes a step at all.
    expect(undoPlan.skipped).toEqual([
      expect.objectContaining({
        ref: pinnedMinted,
        reason: expect.stringContaining('pinned since the run'),
      }),
    ]);
    // The promised row IS planned (nothing wrong at plan time)…
    expect(undoPlan.moves).toHaveLength(1);
    const result = await commitUndoRun(tenantId, undoPlan, 'un-mgr', UNDO);
    expect(result.failed).toBeNull();
    // …but the belt refuses the inverse move at commit: moving back to
    // 07-14 would break the day promise recorded AFTER the run.
    expect(result.movedBack).toEqual([]);
    expect(result.skippedAtCommit).toEqual([
      expect.objectContaining({ reason: expect.stringContaining('break what the customer was told') }),
    ]);
    const still = await getAssignmentForTenant(promisedMinted, tenantId);
    expect(still?.starts_at?.slice(0, 10)).toBe('2027-07-15');
    // The pinned row also stayed where the run put it.
    expect((await getAssignmentForTenant(pinnedMinted, tenantId))?.starts_at?.slice(0, 10)).toBe(
      '2027-07-15',
    );
  });

  test('a deactivated pre-run technician skips that restore and the undo still completes the rest', async () => {
    const RUN = '2027-07-06T08:00:00.000Z';
    const UNDO = '2027-07-06T09:00:00.000Z';
    const temp = await insertTechnician({ tenantId, ref: 'un-temp', displayName: 'Temp Tess' });
    await setTechnicianState(temp.id, 'active');
    const onTemp = await book({ technicianRef: 'un-temp', date: '2027-07-17', startTime: '09:00', endTime: '10:00' });
    const onRay = await book({ technicianRef: 'un-ray', date: '2027-07-17', startTime: '09:00', endTime: '10:00' });
    const committed = await commitResolvePlan(
      tenantId,
      plan({
        moves: [
          // The run moved temp's visit onto Ray — undoing means giving it
          // BACK to temp, who will be gone by then.
          moveOf(onTemp.assignment.id, { tech: 'un-temp', date: '2027-07-17', start: '09:00', end: '10:00' }, { tech: 'un-ray', date: '2027-07-17', start: '13:00', end: '14:00' }),
          moveOf(onRay.assignment.id, { tech: 'un-ray', date: '2027-07-17', start: '09:00', end: '10:00' }, { tech: 'un-ray', date: '2027-07-17', start: '15:00', end: '16:00' }),
        ],
      }),
      'un-mgr',
      RUN,
    );
    expect(committed.failed).toBeNull();
    await setTechnicianState(temp.id, 'offboarding'); // isInactiveState's first arm
    const undoPlan = await planUndo(tenantId, await runFor(RUN, 'resolve'));
    expect(undoPlan.skipped).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining('pre-run technician is no longer active'),
      }),
    ]);
    expect(undoPlan.moves).toHaveLength(1);
    const result = await commitUndoRun(tenantId, undoPlan, 'un-mgr', UNDO);
    expect(result.failed).toBeNull();
    expect(result.movedBack).toHaveLength(1);
    expect(
      (await getAssignmentForTenant(result.movedBack[0].assignmentId, tenantId))?.starts_at?.slice(11, 16),
    ).toBe('09:00');
  });

  test('a freeze that PLACED a time-TBD visit undoes back to unplaced — fence, promise, and technician reproduced', async () => {
    const RUN = '2027-07-07T08:00:00.000Z';
    const UNDO = '2027-07-07T09:00:00.000Z';
    const tbd = await bookVisit({
      tenantId,
      customerId,
      title: 'tbd restore probe',
      timeTbd: true,
      earliestDate: '2027-07-19',
      latestDate: '2027-07-21',
      technicianRef: 'un-rita',
      actorRef: 'un-mgr',
    });
    const freezePlan: FreezePlan = {
      horizonFrom: '2027-07-01',
      horizonTo: '2027-07-31',
      placements: [
        {
          kind: 'unplaced_visit',
          jobId: tbd.job.id,
          assignmentId: tbd.assignment.id,
          customer: 'Undo Casa',
          jobTitle: 'tbd restore probe',
          technicianRef: 'un-rita',
          date: '2027-07-20',
          startTime: '10:00',
          endTime: '11:00',
        },
      ],
      skipped: [],
      capacity: [],
    };
    const froze = await commitFreezePlan(tenantId, freezePlan, 'un-mgr', RUN);
    expect(froze.failed).toBeNull();
    const undoPlan = await planUndo(tenantId, await runFor(RUN, 'freeze'));
    expect(undoPlan.tbdRestores).toEqual([
      expect.objectContaining({
        earliestDate: '2027-07-19',
        latestDate: '2027-07-21',
        promiseLevel: 'none',
        technicianRef: 'un-rita',
      }),
    ]);
    expect(undoPlan.moves).toEqual([]);
    const result = await commitUndoRun(tenantId, undoPlan, 'un-mgr', UNDO);
    expect(result.failed).toBeNull();
    expect(result.rebooked).toHaveLength(1);
    const restored = await getAssignmentForTenant(result.rebooked[0].assignmentId, tenantId);
    expect(restored?.starts_at).toBeNull();
    expect(restored?.earliest_date).toBe('2027-07-19');
    expect(restored?.latest_date).toBe('2027-07-21');
    expect(restored?.technician_id).not.toBeNull();
    // The placed row the freeze minted is terminal.
    const events = await undoEvents(UNDO);
    expect(events.filter((e) => e.kind === 'cancelled')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'booked')).toHaveLength(1);
  });

  test('a tbd row vacated in step 1 whose rebook never runs (mid-run failure) is reported as strandedUnplaced — never "unchanged"', async () => {
    const RUN = '2027-07-09T08:00:00.000Z';
    const UNDO = '2027-07-09T09:00:00.000Z';
    // One run: a normal move AND a time-TBD placement (resolve placements
    // ride the freeze walker, which handles unplaced_visit rows).
    const moved = await book({ technicianRef: 'un-rita', date: '2027-07-25', startTime: '09:00', endTime: '10:00' });
    const tbd = await bookVisit({
      tenantId,
      customerId,
      title: 'stranded tbd probe',
      timeTbd: true,
      earliestDate: '2027-07-25',
      latestDate: '2027-07-26',
      technicianRef: 'un-rita',
      actorRef: 'un-mgr',
    });
    const committed = await commitResolvePlan(
      tenantId,
      plan({
        moves: [
          moveOf(moved.assignment.id, { tech: 'un-rita', date: '2027-07-25', start: '09:00', end: '10:00' }, { tech: 'un-rita', date: '2027-07-25', start: '13:00', end: '14:00' }),
        ],
        placements: [
          {
            kind: 'unplaced_visit',
            jobId: tbd.job.id,
            assignmentId: tbd.assignment.id,
            customer: 'Undo Casa',
            jobTitle: 'stranded tbd probe',
            technicianRef: 'un-rita',
            date: '2027-07-25',
            startTime: '15:00',
            endTime: '16:00',
          },
        ],
      }),
      'un-mgr',
      RUN,
    );
    expect(committed.failed).toBeNull();
    const undoPlan = await planUndo(tenantId, await runFor(RUN, 'resolve'));
    expect(undoPlan.moves).toHaveLength(1);
    expect(undoPlan.tbdRestores).toHaveLength(1);
    // A hand booking now occupies the inverse move's target (09:00) — not in
    // the plan, so step (2) fails AFTER step (1) vacated the tbd row.
    await book({ technicianRef: 'un-rita', date: '2027-07-25', startTime: '08:30', endTime: '09:30', title: 'blocker' });
    const result = await commitUndoRun(tenantId, undoPlan, 'un-mgr', UNDO);
    expect(result.failed).not.toBeNull();
    expect(result.rebooked).toEqual([]);
    // The vacated-but-never-rebooked row is NAMED, with its job for rebooking.
    expect(result.strandedUnplaced).toEqual([
      expect.objectContaining({
        assignmentId: undoPlan.tbdRestores[0].assignmentId,
        jobId: tbd.job.id,
      }),
    ]);
    // Its live row really is cancelled (the honest state the report claims).
    const vacated = await getAssignmentForTenant(undoPlan.tbdRestores[0].assignmentId, tenantId);
    expect(vacated?.status).toBe('cancelled');
    // The summary counts it — forensics must not read this run as clean.
    expect((await undoEvents(UNDO)).find((e) => e.kind === 'undo_committed')?.detail).toMatchObject(
      { strandedTbd: 1 },
    );
  });

  test('undoing a freeze returns queue placements to the loose bucket — open jobs with no live visit, counts matching', async () => {
    const RUN = '2027-07-08T08:00:00.000Z';
    const UNDO = '2027-07-08T09:00:00.000Z';
    const j1 = await createJob({ tenantId, customerId, title: 'bucket job one', status: 'open', durationMinutes: 60 });
    const j2 = await createJob({ tenantId, customerId, title: 'bucket job two', status: 'open', durationMinutes: 60 });
    const openWithNoVisit = async (): Promise<number> => {
      const { rows } = await pg.query(
        `select count(*)::int as n from jobs j
          where j.tenant_id = $1 and j.status = 'open'
            and not exists (select 1 from assignments a
              where a.job_id = j.id and a.status in ('confirmed','proposed'))`,
        [tenantId],
      );
      return rows[0].n as number;
    };
    const before = await openWithNoVisit();
    const placementOf = (jobId: string, title: string, start: string, end: string) => ({
      kind: 'unscheduled_job' as const,
      jobId,
      assignmentId: null,
      customer: 'Undo Casa',
      jobTitle: title,
      technicianRef: 'un-ray',
      date: '2027-07-23',
      startTime: start,
      endTime: end,
    });
    const froze = await commitFreezePlan(
      tenantId,
      {
        horizonFrom: '2027-07-01',
        horizonTo: '2027-07-31',
        placements: [
          placementOf(j1.id, 'bucket job one', '09:00', '10:00'),
          placementOf(j2.id, 'bucket job two', '11:00', '12:00'),
        ],
        skipped: [],
        capacity: [],
      },
      'un-mgr',
      RUN,
    );
    expect(froze.failed).toBeNull();
    expect(await openWithNoVisit()).toBe(before - 2); // both left the queue
    const undoPlan = await planUndo(tenantId, await runFor(RUN, 'freeze'));
    expect(undoPlan.unschedules).toHaveLength(2);
    const result = await commitUndoRun(tenantId, undoPlan, 'un-mgr', UNDO);
    expect(result.failed).toBeNull();
    expect(result.unscheduled).toHaveLength(2);
    expect(await openWithNoVisit()).toBe(before); // bucket counts match pre-freeze
    expect((await undoEvents(UNDO)).find((e) => e.kind === 'undo_committed')?.detail).toMatchObject(
      { undidKind: 'freeze', restored: 2 },
    );
  });
});
