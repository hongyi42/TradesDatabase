import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import { insertTechnician, setTechnicianState } from '../db/technicians.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { getAssignmentForTenant } from '../db/assignments.js';
import { bookVisit } from './booking.js';
import { orderMoves, commitResolvePlan } from './resolveCommit.js';
import type { ResolveMove, ResolvePlan } from './freezeSolve.js';

const TRUNCATE =
  'truncate table customers, jobs, technicians, technician_time_off, job_type_durations, review_items, schedule_events cascade';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let customerId: string;

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
  const ray = await insertTechnician({ tenantId, ref: 'rc-ray', displayName: 'Ray Solver' });
  await setTechnicianState(ray.id, 'active');
  const rita = await insertTechnician({ tenantId, ref: 'rc-rita', displayName: 'Rita Solver' });
  await setTechnicianState(rita.id, 'active');
  customerId = (await createCustomer({ tenantId, name: 'Resolve Casa' })).id;
});

afterAll(async () => {
  await pg.query(TRUNCATE);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

// ---------------------------------------------------------------------------
// orderMoves (pure)

const mv = (over: Partial<ResolveMove> & Pick<ResolveMove, 'assignmentId'>): ResolveMove => ({
  jobId: `job-${over.assignmentId}`,
  customer: 'Resolve Casa',
  jobTitle: 'ordered work',
  fromTechnicianRef: 'rc-ray',
  fromDate: '2027-06-07',
  fromStart: '09:00',
  fromEnd: '10:00',
  toTechnicianRef: 'rc-ray',
  toDate: '2027-06-07',
  toStartTime: '13:00',
  toEndTime: '14:00',
  ...over,
});

describe('orderMoves', () => {
  test('a chain orders vacate-before-arrive regardless of input order', () => {
    // A wants B's current slot; B leaves for the afternoon. B must go first.
    const a = mv({ assignmentId: 'a', fromStart: '11:00', fromEnd: '12:00', toStartTime: '09:00', toEndTime: '10:00' });
    const b = mv({ assignmentId: 'b', fromStart: '09:00', fromEnd: '10:00', toStartTime: '13:00', toEndTime: '14:00' });
    const { ordered, parked } = orderMoves([a, b]); // wrong order in
    expect(parked).toHaveLength(0);
    expect(ordered.map((m) => m.assignmentId)).toEqual(['b', 'a']);
  });

  test('a strict 2-cycle parks exactly ONE member (lowest assignmentId)', () => {
    const a = mv({ assignmentId: 'aa', fromStart: '09:00', fromEnd: '10:00', toStartTime: '10:30', toEndTime: '11:30' });
    const b = mv({ assignmentId: 'bb', fromStart: '10:30', fromEnd: '11:30', toStartTime: '09:00', toEndTime: '10:00' });
    const { ordered, parked } = orderMoves([b, a]);
    expect(parked.map((m) => m.assignmentId)).toEqual(['aa']);
    expect(ordered.map((m) => m.assignmentId)).toEqual(['bb']);
  });

  test('a same-tech overlapping shift (09:00→09:30) is NO self-edge and never parks', () => {
    const shift = mv({ assignmentId: 's', fromStart: '09:00', fromEnd: '10:00', toStartTime: '09:30', toEndTime: '10:30' });
    const { ordered, parked } = orderMoves([shift]);
    expect(parked).toHaveLength(0);
    expect(ordered).toEqual([shift]);
  });

  test('disjoint moves keep input order; cross-tech targets need no edges', () => {
    const one = mv({ assignmentId: 'one', toStartTime: '13:00', toEndTime: '14:00' });
    const two = mv({ assignmentId: 'two', fromStart: '10:00', fromEnd: '11:00', toStartTime: '15:00', toEndTime: '16:00' });
    // Rita takes a slot that overlaps Ray's CURRENT 09:00 — different tech,
    // different vehicle: no dependency.
    const cross = mv({ assignmentId: 'x', fromTechnicianRef: 'rc-rita', fromDate: '2027-06-08', toTechnicianRef: 'rc-rita', toDate: '2027-06-07', toStartTime: '09:00', toEndTime: '10:00' });
    void cross;
    const { ordered, parked } = orderMoves([one, two]);
    expect(parked).toHaveLength(0);
    expect(ordered.map((m) => m.assignmentId)).toEqual(['one', 'two']);
  });
});

// ---------------------------------------------------------------------------
// commitResolvePlan (local stack, real verbs)

const plan = (over: Partial<ResolvePlan>): ResolvePlan => ({
  horizonFrom: '2027-06-07',
  horizonTo: '2027-06-20',
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
    title: args.title ?? 'resolve probe visit',
    actorRef: 'rc-mgr',
    ...args,
  });

const moveOf = (
  assignmentId: string,
  from: { tech: string; date: string; start: string; end: string },
  to: { tech: string; date: string; start: string; end: string },
): ResolveMove => ({
  assignmentId,
  jobId: 'unused-by-commit',
  customer: 'Resolve Casa',
  jobTitle: 'resolve probe visit',
  fromTechnicianRef: from.tech,
  fromDate: from.date,
  fromStart: from.start,
  fromEnd: from.end,
  toTechnicianRef: to.tech,
  toDate: to.date,
  toStartTime: to.start,
  toEndTime: to.end,
});

const STAMP = '2027-06-01T08:00:00.000Z';

async function runEvents(stamp: string): Promise<{ kind: string; detail: Record<string, unknown> }[]> {
  const { rows } = await pg.query(
    "select kind, detail from schedule_events where detail->>'resolveRun' = $1 order by id",
    [stamp],
  );
  return rows as { kind: string; detail: Record<string, unknown> }[];
}

describe('commitResolvePlan', { timeout: 30_000 }, () => {
  test('a chain commits in dependency order with zero overlap errors; every event stamped; NO freeze_committed', async () => {
    const stamp = STAMP;
    const a = await book({ technicianRef: 'rc-ray', date: '2027-06-07', startTime: '11:00', endTime: '12:00' });
    const b = await book({ technicianRef: 'rc-ray', date: '2027-06-07', startTime: '09:00', endTime: '10:00' });
    const result = await commitResolvePlan(
      tenantId,
      plan({
        moves: [
          // Input order is WRONG on purpose — a into b's current slot first.
          moveOf(a.assignment.id, { tech: 'rc-ray', date: '2027-06-07', start: '11:00', end: '12:00' }, { tech: 'rc-ray', date: '2027-06-07', start: '09:00', end: '10:00' }),
          moveOf(b.assignment.id, { tech: 'rc-ray', date: '2027-06-07', start: '09:00', end: '10:00' }, { tech: 'rc-ray', date: '2027-06-07', start: '13:00', end: '14:00' }),
        ],
        keptCount: 3,
      }),
      'rc-mgr',
      stamp,
    );
    expect(result.failed).toBeNull();
    expect(result.movedRows).toHaveLength(2);
    // Read back: both rows at their targets, statuses confirmed.
    const aRow = await getAssignmentForTenant(
      result.movedRows.find((m) => m.move.assignmentId === a.assignment.id)?.assignmentId as string,
      tenantId,
    );
    expect(aRow?.starts_at?.slice(11, 16)).toBe('09:00');
    const bRow = await getAssignmentForTenant(
      result.movedRows.find((m) => m.move.assignmentId === b.assignment.id)?.assignmentId as string,
      tenantId,
    );
    expect(bRow?.starts_at?.slice(11, 16)).toBe('13:00');
    // Ledger: two stamped moved events + the resolve_committed summary, and
    // NOT ONE freeze_committed row anywhere in the run.
    const events = await runEvents(stamp);
    expect(events.filter((e) => e.kind === 'moved')).toHaveLength(2);
    const summary = events.find((e) => e.kind === 'resolve_committed');
    expect(summary?.detail).toMatchObject({ moved: 2, placed: 0, kept: 3 });
    expect(events.filter((e) => e.kind === 'freeze_committed')).toHaveLength(0);
  });

  test('a strict swap commits via park-and-reattach on the REMINTED id; nothing left person-less', async () => {
    const stamp = '2027-06-01T09:00:00.000Z';
    const a = await book({ technicianRef: 'rc-ray', date: '2027-06-08', startTime: '09:00', endTime: '10:00' });
    const b = await book({ technicianRef: 'rc-ray', date: '2027-06-08', startTime: '10:30', endTime: '11:30' });
    const result = await commitResolvePlan(
      tenantId,
      plan({
        moves: [
          moveOf(a.assignment.id, { tech: 'rc-ray', date: '2027-06-08', start: '09:00', end: '10:00' }, { tech: 'rc-ray', date: '2027-06-08', start: '10:30', end: '11:30' }),
          moveOf(b.assignment.id, { tech: 'rc-ray', date: '2027-06-08', start: '10:30', end: '11:30' }, { tech: 'rc-ray', date: '2027-06-08', start: '09:00', end: '10:00' }),
        ],
      }),
      'rc-mgr',
      stamp,
    );
    expect(result.failed).toBeNull();
    expect(result.movedRows).toHaveLength(2);
    const aFinal = await getAssignmentForTenant(
      result.movedRows.find((m) => m.move.assignmentId === a.assignment.id)?.assignmentId as string,
      tenantId,
    );
    const bFinal = await getAssignmentForTenant(
      result.movedRows.find((m) => m.move.assignmentId === b.assignment.id)?.assignmentId as string,
      tenantId,
    );
    expect(aFinal?.starts_at?.slice(11, 16)).toBe('10:30');
    expect(bFinal?.starts_at?.slice(11, 16)).toBe('09:00');
    expect(aFinal?.technician_id).not.toBeNull(); // re-attached, not stranded
    // Three stamped moved events: park + two arrivals (one via reminted id).
    const events = await runEvents(stamp);
    expect(events.filter((e) => e.kind === 'moved')).toHaveLength(3);
    // Nothing person-less remains in the window.
    const { rows } = await pg.query(
      "select count(*)::int as n from assignments where tenant_id = $1 and status = 'confirmed' and technician_id is null and starts_at >= '2027-06-08' and starts_at < '2027-06-09'",
      [tenantId],
    );
    expect(rows[0].n).toBe(0);
  });

  test('the promise belt skips a breaking move (bug backstop) and the run continues', async () => {
    const stamp = '2027-06-01T10:00:00.000Z';
    const promised = await book({
      technicianRef: 'rc-rita', date: '2027-06-09', startTime: '09:00', endTime: '10:00', promiseLevel: 'day',
    });
    const free = await book({ technicianRef: 'rc-rita', date: '2027-06-09', startTime: '11:00', endTime: '12:00' });
    const result = await commitResolvePlan(
      tenantId,
      plan({
        moves: [
          // Day-promised row proposed onto ANOTHER day — a window bug; belt must catch it.
          moveOf(promised.assignment.id, { tech: 'rc-rita', date: '2027-06-09', start: '09:00', end: '10:00' }, { tech: 'rc-rita', date: '2027-06-10', start: '09:00', end: '10:00' }),
          moveOf(free.assignment.id, { tech: 'rc-rita', date: '2027-06-09', start: '11:00', end: '12:00' }, { tech: 'rc-rita', date: '2027-06-09', start: '14:00', end: '15:00' }),
        ],
      }),
      'rc-mgr',
      stamp,
    );
    expect(result.failed).toBeNull();
    expect(result.skippedAtCommit).toEqual([
      expect.objectContaining({
        ref: promised.assignment.id,
        reason: expect.stringContaining('break what the customer was told'),
      }),
    ]);
    // The promised row is untouched; the free row moved.
    const untouched = await getAssignmentForTenant(promised.assignment.id, tenantId);
    expect(untouched?.status).toBe('confirmed');
    expect(untouched?.starts_at?.slice(0, 10)).toBe('2027-06-09');
    expect(result.movedRows).toHaveLength(1);
  });

  test('a mid-batch failure STOPS the run: prior moves stand, the failed row is named, later rows untouched', async () => {
    const stamp = '2027-06-01T11:00:00.000Z';
    const first = await book({ technicianRef: 'rc-ray', date: '2027-06-10', startTime: '09:00', endTime: '10:00' });
    const doomed = await book({ technicianRef: 'rc-ray', date: '2027-06-10', startTime: '11:00', endTime: '12:00' });
    const later = await book({ technicianRef: 'rc-ray', date: '2027-06-10', startTime: '13:00', endTime: '14:00' });
    // An UNRELATED confirmed visit occupies doomed's target — not in the plan,
    // so ordering can't help; the pre-check throws mid-run.
    await book({ technicianRef: 'rc-ray', date: '2027-06-11', startTime: '09:00', endTime: '10:00', title: 'blocker' });
    const result = await commitResolvePlan(
      tenantId,
      plan({
        moves: [
          moveOf(first.assignment.id, { tech: 'rc-ray', date: '2027-06-10', start: '09:00', end: '10:00' }, { tech: 'rc-ray', date: '2027-06-10', start: '15:00', end: '16:00' }),
          moveOf(doomed.assignment.id, { tech: 'rc-ray', date: '2027-06-10', start: '11:00', end: '12:00' }, { tech: 'rc-ray', date: '2027-06-11', start: '09:30', end: '10:30' }),
          moveOf(later.assignment.id, { tech: 'rc-ray', date: '2027-06-10', start: '13:00', end: '14:00' }, { tech: 'rc-ray', date: '2027-06-10', start: '16:00', end: '17:00' }),
        ],
      }),
      'rc-mgr',
      stamp,
    );
    expect(result.failed).toMatchObject({ ref: doomed.assignment.id });
    expect(result.movedRows).toHaveLength(1); // only `first` landed
    const untouchedLater = await getAssignmentForTenant(later.assignment.id, tenantId);
    expect(untouchedLater?.status).toBe('confirmed');
    expect(untouchedLater?.starts_at?.slice(11, 16)).toBe('13:00');
    // Summary still lands, honestly naming the stop.
    const summary = (await runEvents(stamp)).find((e) => e.kind === 'resolve_committed');
    expect(summary?.detail).toMatchObject({ moved: 1, stoppedAt: doomed.assignment.id });
  });

  test('queue placements ride the freeze walker with re-solve stamps/reasons and NO freeze summary', async () => {
    const stamp = '2027-06-01T12:00:00.000Z';
    const job = await createJob({
      tenantId, customerId, title: 'placement via resolve', status: 'open', durationMinutes: 60,
    });
    const result = await commitResolvePlan(
      tenantId,
      plan({
        placements: [
          {
            kind: 'unscheduled_job',
            jobId: job.id,
            assignmentId: null,
            customer: 'Resolve Casa',
            jobTitle: 'placement via resolve',
            technicianRef: 'rc-rita',
            date: '2027-06-14',
            startTime: '09:00',
            endTime: '10:00',
          },
        ],
      }),
      'rc-mgr',
      stamp,
    );
    expect(result.failed).toBeNull();
    expect(result.committed).toHaveLength(1);
    const events = await runEvents(stamp);
    const booked = events.find((e) => e.kind === 'booked');
    expect(booked?.detail).toMatchObject({ reason: 're-solve 2027-06-01' });
    expect(events.filter((e) => e.kind === 'freeze_committed')).toHaveLength(0);
    expect(events.find((e) => e.kind === 'resolve_committed')?.detail).toMatchObject({
      moved: 0,
      placed: 1,
    });
  });
});
