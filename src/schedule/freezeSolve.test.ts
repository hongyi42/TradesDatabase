import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import {
  insertTechnician,
  setTechnicianAvailability,
  setTechnicianState,
  type WeeklyPattern,
} from '../db/technicians.js';
import { addTimeOff } from '../db/timeOff.js';
import { createCustomer, updateCustomerCoords } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { bookVisit, setVisitLocks } from './booking.js';
import {
  assembleFreezeInputs,
  buildFreezeModel,
  buildResolveModel,
  partitionMovable,
  solveFreeze,
  solveResolve,
  vehicleLabel,
  movableLabel,
  QUEUE_PENALTY,
  CONTEXT_PENALTY,
  DISRUPTION_COST_PER_HOUR,
  TECH_CHANGE_COST,
  type FreezeContextVisit,
  type FreezeInputs,
  type FreezeQueueItem,
} from './freezeSolve.js';

// Horizon under test: 2027-05-03 (Mon) → 2027-05-09 (Sun).
const FROM = '2027-05-03';
const TO = '2027-05-09';

const TRUNCATE =
  'truncate table customers, jobs, technicians, technician_time_off, job_type_durations, review_items, schedule_events cascade';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

// Split pattern (Mon–Fri, lunch gap) — exercises the break mapping.
const SPLIT_WEEK: WeeklyPattern = {
  mon: [['08:00', '12:00'], ['13:00', '17:00']],
  tue: [['08:00', '12:00'], ['13:00', '17:00']],
  wed: [['08:00', '12:00'], ['13:00', '17:00']],
  thu: [['08:00', '12:00'], ['13:00', '17:00']],
  fri: [['08:00', '12:00'], ['13:00', '17:00']],
  sat: [],
  sun: [],
};

// Selective geocode fake: only the deliberately-unlocatable customer's
// address is ever fetched (everyone else is pre-coded or address-less) —
// count the calls to prove it.
const geocodeCalls: string[] = [];
const zeroResultsGeocode = async (address: string): Promise<unknown> => {
  geocodeCalls.push(address);
  return { status: 'ZERO_RESULTS', results: [] };
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
});

afterAll(async () => {
  await pg.query(TRUNCATE);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

// ---------------------------------------------------------------------------
// Pure half: model shape + response parsing (hand-built inputs, fake seams)

const COORDS = { lat: 36.8, lng: -119.7 };

function baseInputs(over: Partial<FreezeInputs> = {}): FreezeInputs {
  return {
    horizonFrom: FROM,
    horizonTo: TO,
    vehicles: [
      { technicianRef: 'p1', technicianName: 'Pat One', date: '2027-05-03', windows: [['08:00', '12:00'], ['13:00', '17:00']] },
      { technicianRef: 'p1', technicianName: 'Pat One', date: '2027-05-04', windows: [['08:00', '17:00']] },
      { technicianRef: 'p2', technicianName: 'Pam Two', date: '2027-05-03', windows: [['09:00', '15:00']] },
    ],
    queue: [],
    context: [],
    skipped: [],
    capacity: [
      { technicianRef: 'p1', technicianName: 'Pat One', committedMin: 60, availableMin: 1020 },
      { technicianRef: 'p2', technicianName: 'Pam Two', committedMin: 0, availableMin: 360 },
    ],
    ...over,
  };
}

// Context fixture: an ordinary movable-eligible visit unless overridden
// (unpinned, promise 'none' — the movability additions default to "free").
const ctxVisit = (over: Partial<FreezeContextVisit> & Pick<FreezeContextVisit, 'assignmentId' | 'technicianRef' | 'date' | 'startISO' | 'endISO' | 'coords'>): FreezeContextVisit => ({
  locked: false,
  promiseLevel: 'none',
  promisedDay: null,
  jobId: `job-of-${over.assignmentId}`,
  customer: 'Ctx Customer',
  jobTitle: 'ctx job',
  ...over,
});

const windowedItem = (over: Partial<FreezeQueueItem> = {}): FreezeQueueItem => ({
  kind: 'unplaced_visit',
  jobId: 'job-w',
  assignmentId: 'asg-w',
  customer: 'Windowed Wes',
  jobTitle: 'window job',
  technicianRef: 'p1',
  durationMin: 90,
  coords: COORDS,
  windowFrom: '2027-05-03',
  windowTo: '2027-05-05',
  exactStart: null,
  exactEnd: null,
  ...over,
});

describe('buildFreezeModel', () => {
  test('vehicles: pattern span windows, interior gaps as pinned breaks, no depot', () => {
    const model = buildFreezeModel(baseInputs()) as {
      model: {
        globalStartTime: string;
        globalEndTime: string;
        vehicles: Array<Record<string, unknown>>;
      };
    };
    expect(model.model.globalStartTime).toBe('2027-05-03T00:00:00Z');
    expect(model.model.globalEndTime).toBe('2027-05-10T00:00:00Z');
    const [split, solid] = model.model.vehicles;
    expect(split.label).toBe('veh|p1|2027-05-03');
    expect(split.startTimeWindows).toEqual([{ startTime: '2027-05-03T08:00:00Z' }]);
    expect(split.endTimeWindows).toEqual([{ endTime: '2027-05-03T17:00:00Z' }]);
    expect(split.breakRule).toEqual({
      breakRequests: [
        {
          earliestStartTime: '2027-05-03T12:00:00Z',
          latestStartTime: '2027-05-03T12:00:00Z',
          minDuration: '3600s',
        },
      ],
    });
    expect(solid.breakRule).toBeUndefined();
    expect(split.startWaypoint).toBeUndefined(); // no depot (recorded limitation)
    expect(split.endWaypoint).toBeUndefined();
  });

  test('queue shipments: per-day fence windows, allowedVehicleIndices for attached rows, exact-times pinning, penalties EVERYWHERE', () => {
    const exact = windowedItem({
      kind: 'unassigned_visit',
      jobId: 'job-e',
      assignmentId: 'asg-e',
      technicianRef: null,
      durationMin: 60,
      exactStart: '2027-05-04T10:00:00.000Z',
      exactEnd: '2027-05-04T11:00:00.000Z',
    });
    const model = buildFreezeModel(
      baseInputs({
        queue: [windowedItem(), exact],
        context: [
          ctxVisit({
            assignmentId: 'asg-ctx',
            technicianRef: 'p2',
            date: '2027-05-03',
            startISO: '2027-05-03T09:00:00.000Z',
            endISO: '2027-05-03T10:30:00.000Z',
            coords: null, // ungeocodable context → location-less, still pins time
          }),
        ],
      }),
    ) as {
      model: {
        shipments: Array<{
          label: string;
          penaltyCost: number;
          allowedVehicleIndices?: number[];
          deliveries: Array<{
            arrivalLocation?: { latitude: number; longitude: number };
            duration: string;
            timeWindows: Array<{ startTime: string; endTime: string }>;
          }>;
        }>;
      };
    };
    const [windowed, exactShip, ctx] = model.model.shipments;

    expect(windowed.label).toBe('q|asg-w');
    expect(windowed.penaltyCost).toBe(QUEUE_PENALTY);
    // p1 owns vehicle indexes 0 and 1 — the attached row may only ride those.
    expect(windowed.allowedVehicleIndices).toEqual([0, 1]);
    const visit = windowed.deliveries[0];
    expect(visit.arrivalLocation).toEqual({ latitude: COORDS.lat, longitude: COORDS.lng });
    expect(visit.duration).toBe('5400s');
    // ONE contiguous arrival window for the whole fence — the API rejects
    // adjacent windows ("must be disjoint … nor adjacent"), so per-day
    // windows would fail every real solve (phase-review finding 1). End
    // bound sits INSIDE the last day (arrival is inclusive — midnight-after
    // would legalize a day-after arrival; final-review finding).
    expect(visit.timeWindows).toEqual([
      { startTime: '2027-05-03T00:00:00Z', endTime: '2027-05-05T23:59:59Z' },
    ]);

    // Person-less placed: arrival pinned to the stored start; any vehicle.
    expect(exactShip.allowedVehicleIndices).toBeUndefined();
    expect(exactShip.deliveries[0].timeWindows).toEqual([
      { startTime: '2027-05-04T10:00:00Z', endTime: '2027-05-04T10:00:00Z' },
    ]);

    // Context: LARGE penalty (never mandatory — an off-pattern booking must
    // degrade to a warning, not an infeasible solve), pinned to ONE vehicle,
    // location-less when ungeocodable.
    expect(ctx.label).toBe('ctx|asg-ctx');
    expect(ctx.penaltyCost).toBe(CONTEXT_PENALTY);
    expect(ctx.allowedVehicleIndices).toEqual([2]);
    expect(ctx.deliveries[0].arrivalLocation).toBeUndefined();
    expect(ctx.deliveries[0].duration).toBe('5400s');
  });

  test('adjacent/unsorted pattern windows normalize: merged span, no zero-length break, no inverted vehicle window', () => {
    const model = buildFreezeModel(
      baseInputs({
        vehicles: [
          // Stored patterns can be adjacent or unsorted (assertValidPattern
          // checks windows in isolation) — the builder must not turn them
          // into a "0s" break or a 13:00→12:00 vehicle span.
          { technicianRef: 'p1', technicianName: 'Pat One', date: '2027-05-03', windows: [['08:00', '12:00'], ['12:00', '17:00']] },
          { technicianRef: 'p1', technicianName: 'Pat One', date: '2027-05-04', windows: [['13:00', '17:00'], ['08:00', '12:00']] },
        ],
      }),
    ) as { model: { vehicles: Array<Record<string, unknown>> } };
    const [adjacent, unsorted] = model.model.vehicles;
    expect(adjacent.startTimeWindows).toEqual([{ startTime: '2027-05-03T08:00:00Z' }]);
    expect(adjacent.endTimeWindows).toEqual([{ endTime: '2027-05-03T17:00:00Z' }]);
    expect(adjacent.breakRule).toBeUndefined(); // merged — no zero-length break
    expect(unsorted.startTimeWindows).toEqual([{ startTime: '2027-05-04T08:00:00Z' }]);
    expect(unsorted.endTimeWindows).toEqual([{ endTime: '2027-05-04T17:00:00Z' }]);
    expect(unsorted.breakRule).toEqual({
      breakRequests: [
        {
          earliestStartTime: '2027-05-04T12:00:00Z',
          latestStartTime: '2027-05-04T12:00:00Z',
          minDuration: '3600s',
        },
      ],
    });
  });

  test('belt: an attached item whose tech has NO vehicle days is omitted, never allowedVehicleIndices: []', () => {
    const model = buildFreezeModel(
      baseInputs({ queue: [windowedItem({ technicianRef: 'ghost' })] }),
    ) as { model: { shipments: unknown[] } };
    // [] would mean "ALL vehicles" to the API — the visit would land on the
    // wrong person while the commit keeps the original (review finding 2).
    expect(model.model.shipments).toHaveLength(0);
  });

  test('a context visit on a non-vehicle day (day off / outside pattern) is omitted, never mandatory', () => {
    const model = buildFreezeModel(
      baseInputs({
        context: [
          ctxVisit({
            assignmentId: 'asg-sat',
            technicianRef: 'p1',
            date: '2027-05-08', // Saturday — no vehicle exists
            startISO: '2027-05-08T09:00:00.000Z',
            endISO: '2027-05-08T10:00:00.000Z',
            coords: COORDS,
          }),
        ],
      }),
    ) as { model: { shipments: unknown[] } };
    expect(model.model.shipments).toHaveLength(0);
  });
});

describe('solveFreeze (fake transport)', () => {
  test('routes → placements (windowed take solver arrival, exact keep OWN times); skips joined; capacity updated', async () => {
    const exact = windowedItem({
      kind: 'unassigned_visit',
      jobId: 'job-e',
      assignmentId: 'asg-e',
      technicianRef: null,
      durationMin: 60,
      windowFrom: '2027-05-04',
      windowTo: '2027-05-04',
      exactStart: '2027-05-04T10:00:00.000Z',
      exactEnd: '2027-05-04T11:00:00.000Z',
    });
    const dry = windowedItem({ jobId: 'job-dry', assignmentId: 'asg-dry', technicianRef: null });
    const inputs = baseInputs({
      queue: [windowedItem(), exact, dry],
      skipped: [{ ref: 'job:pre', label: 'Preskipped', reason: 'no length set' }],
    });
    const plan = await solveFreeze(inputs, {
      mintToken: async () => ({ token: 't', projectId: 'p' }),
      transport: async () => ({
        routes: [
          {
            vehicleLabel: vehicleLabel('p1', '2027-05-04'),
            visits: [
              { shipmentLabel: 'q|asg-w', startTime: '2027-05-04T08:30:00Z' },
              { shipmentLabel: 'q|asg-e', startTime: '2027-05-04T10:00:00Z' },
              { shipmentLabel: 'ctx|asg-ctx', startTime: '2027-05-04T13:00:00Z' }, // NEVER committed
            ],
          },
        ],
        skippedShipments: [{ label: 'q|asg-dry' }],
      }),
    });

    expect(plan.placements).toHaveLength(2); // the ctx visit produced NO placement
    const [w, e] = plan.placements;
    expect(w).toMatchObject({
      kind: 'unplaced_visit',
      assignmentId: 'asg-w',
      technicianRef: 'p1',
      date: '2027-05-04',
      startTime: '08:30',
      endTime: '10:00', // 90 min
    });
    expect(e).toMatchObject({
      kind: 'unassigned_visit',
      assignmentId: 'asg-e',
      date: '2027-05-04',
      startTime: '10:00',
      endTime: '11:00', // its OWN stored end, verbatim
    });
    // Input-side skips survive; the solver-skipped item gains a reason.
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: 'job:pre' }),
        expect.objectContaining({ ref: 'asg-dry', reason: expect.stringContaining('no room') }),
      ]),
    );
    // Capacity: p1 committed 60 (context) + 90 + 60 (placements) = 210.
    expect(plan.capacity.find((c) => c.technicianRef === 'p1')?.committedMin).toBe(210);
  });

  test('belt: a queue item absent from routes AND skippedShipments is still reported', async () => {
    const plan = await solveFreeze(baseInputs({ queue: [windowedItem()] }), {
      mintToken: async () => ({ token: 't', projectId: 'p' }),
      transport: async () => ({ routes: [], skippedShipments: [] }),
    });
    expect(plan.placements).toHaveLength(0);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ ref: 'asg-w', reason: expect.stringContaining('rerun the freeze') }),
    ]);
  });

  test('skipped CONTEXT shipment → capacity note (existing booking outside the pattern), never a commit', async () => {
    const inputs = baseInputs({
      queue: [windowedItem()],
      context: [
        ctxVisit({
          assignmentId: 'asg-late',
          technicianRef: 'p2',
          date: '2027-05-03',
          startISO: '2027-05-03T18:00:00.000Z', // after Pam's 15:00 end — unseatable
          endISO: '2027-05-03T19:00:00.000Z',
          coords: COORDS,
        }),
      ],
    });
    const plan = await solveFreeze(inputs, {
      mintToken: async () => ({ token: 't', projectId: 'p' }),
      transport: async () => ({
        routes: [
          {
            vehicleLabel: vehicleLabel('p1', '2027-05-03'),
            visits: [{ shipmentLabel: 'q|asg-w', startTime: '2027-05-03T08:00:00Z' }],
          },
        ],
        skippedShipments: [{ label: 'ctx|asg-late' }],
      }),
    });
    expect(plan.placements).toHaveLength(1);
    expect(plan.skipped).toEqual([
      expect.objectContaining({
        ref: 'asg-late',
        reason: expect.stringContaining('kept as booked'),
      }),
    ]);
  });

  test('short-circuits: empty queue OR zero vehicles → NO API call', async () => {
    const explode = async (): Promise<never> => {
      throw new Error('transport must not be called');
    };
    const empty = await solveFreeze(baseInputs(), { transport: explode, mintToken: explode });
    expect(empty.placements).toHaveLength(0);

    const noVeh = await solveFreeze(
      baseInputs({
        vehicles: [],
        // One ATTACHED item (hits the orphan pre-filter's specific reason)
        // and one person-less (hits the generic no-pattern arm).
        queue: [
          windowedItem(),
          windowedItem({ jobId: 'job-free', assignmentId: 'asg-free', technicianRef: null }),
        ],
        capacity: [],
      }),
      { transport: explode, mintToken: explode },
    );
    expect(noVeh.placements).toHaveLength(0);
    expect(noVeh.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: 'asg-w',
          reason: expect.stringContaining('no working days in this horizon'),
        }),
        expect.objectContaining({
          ref: 'asg-free',
          reason: expect.stringContaining('set_availability'),
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Re-solve: partition, model, parse (plan 2026-07-30 Phase 1)

const movableFix = (over: Partial<FreezeContextVisit> = {}) =>
  ctxVisit({
    assignmentId: 'asg-mv',
    technicianRef: 'p1',
    date: '2027-05-04',
    startISO: '2027-05-04T10:00:00.000Z',
    endISO: '2027-05-04T11:30:00.000Z',
    coords: COORDS,
    ...over,
  });

describe('partitionMovable', () => {
  test('the matrix: pinned / time-promised / begun / out-of-scope stay fixed; coord-less fixed WITH a kept-skip; free rows move', () => {
    const free = movableFix();
    const pinned = movableFix({ assignmentId: 'asg-pin', locked: true });
    const timed = movableFix({ assignmentId: 'asg-time', promiseLevel: 'time' });
    const timeOnly = movableFix({ assignmentId: 'asg-tonly', promiseLevel: 'time_only' });
    const dayPromised = movableFix({
      assignmentId: 'asg-day',
      promiseLevel: 'day',
      promisedDay: '2027-05-04',
    });
    const begun = movableFix({
      assignmentId: 'asg-begun',
      date: FROM,
      startISO: `${FROM}T08:00:00.000Z`,
      endISO: `${FROM}T09:00:00.000Z`,
    });
    const otherTech = movableFix({ assignmentId: 'asg-p2', technicianRef: 'p2' });
    const otherDay = movableFix({ assignmentId: 'asg-tue', date: '2027-05-05', startISO: '2027-05-05T10:00:00.000Z', endISO: '2027-05-05T11:00:00.000Z' });
    const noCoords = movableFix({ assignmentId: 'asg-nocoord', coords: null });

    const inputs = baseInputs({
      context: [free, pinned, timed, timeOnly, dayPromised, begun, otherTech, otherDay, noCoords],
    });

    const all = partitionMovable(inputs, {}, '09:30');
    const movableIds = all.movable.map((m) => m.assignmentId);
    // 'day' rows ARE movable (within their day); 'time'/'time_only' are not.
    expect(movableIds).toEqual(
      expect.arrayContaining(['asg-mv', 'asg-day', 'asg-p2', 'asg-tue']),
    );
    expect(movableIds).toHaveLength(4);
    expect(all.fixed.map((f) => f.assignmentId)).toEqual(
      expect.arrayContaining(['asg-pin', 'asg-time', 'asg-tonly', 'asg-begun', 'asg-nocoord']),
    );
    expect(all.skips).toEqual([
      expect.objectContaining({ ref: 'asg-nocoord', reason: expect.stringContaining('kept as booked') }),
    ]);

    // Scope narrowing: technicianRef and onDate each shrink the movable set.
    const byTech = partitionMovable(inputs, { technicianRef: 'p2' }, '09:30');
    expect(byTech.movable.map((m) => m.assignmentId)).toEqual(['asg-p2']);
    const byDate = partitionMovable(inputs, { onDate: '2027-05-05' }, '09:30');
    expect(byDate.movable.map((m) => m.assignmentId)).toEqual(['asg-tue']);
    // A begun row is only "begun" on day 0 with a real clock.
    const wholeDay = partitionMovable(inputs, {}, '00:00');
    expect(wholeDay.movable.map((m) => m.assignmentId)).toContain('asg-begun');
  });
});

describe('buildResolveModel', () => {
  test('movable shipment: soft window at the CURRENT slot, hard window per promise, tech-change priced, near-mandatory', () => {
    const free = movableFix();
    const dayPromised = movableFix({
      assignmentId: 'asg-day',
      promiseLevel: 'day',
      promisedDay: '2027-05-04',
    });
    const model = buildResolveModel(baseInputs({ context: [free, dayPromised] }), [free, dayPromised]) as {
      model: {
        shipments: Array<{
          label: string;
          penaltyCost: number;
          allowedVehicleIndices?: number[];
          costsPerVehicle?: number[];
          costsPerVehicleIndices?: number[];
          deliveries: Array<{
            arrivalLocation?: unknown;
            duration: string;
            timeWindows: Array<Record<string, unknown>>;
          }>;
        }>;
      };
    };
    const mv = model.model.shipments.find((s) => s.label === movableLabel('asg-mv'));
    expect(mv).toBeDefined();
    expect(mv?.penaltyCost).toBe(CONTEXT_PENALTY); // never silently unscheduled
    expect(mv?.allowedVehicleIndices).toBeUndefined(); // any tech may take it…
    // …but p2's single vehicle (index 2) costs extra.
    expect(mv?.costsPerVehicleIndices).toEqual([2]);
    expect(mv?.costsPerVehicle).toEqual([TECH_CHANGE_COST]);
    expect(mv?.deliveries[0].duration).toBe('5400s');
    expect(mv?.deliveries[0].timeWindows).toEqual([
      {
        startTime: '2027-05-03T00:00:00Z', // 'none' → whole horizon
        endTime: '2027-05-09T23:59:59Z', // end-inside rule
        softStartTime: '2027-05-04T10:00:00Z',
        softEndTime: '2027-05-04T10:00:00Z',
        costPerHourBeforeSoftStartTime: DISRUPTION_COST_PER_HOUR,
        costPerHourAfterSoftEndTime: DISRUPTION_COST_PER_HOUR,
      },
    ]);
    const day = model.model.shipments.find((s) => s.label === movableLabel('asg-day'));
    expect(day?.deliveries[0].timeWindows[0]).toMatchObject({
      startTime: '2027-05-04T00:00:00Z', // 'day' → its promised day only
      endTime: '2027-05-04T23:59:59Z',
    });
    // The movable rows left the fixed-context shipments (no ctx| duplicates).
    expect(model.model.shipments.filter((s) => s.label.startsWith('ctx|'))).toHaveLength(0);
  });

  test('day-0 hard windows open at the run clock; with NO movable rows the model equals the freeze model byte-for-byte', () => {
    const day0 = movableFix({
      assignmentId: 'asg-d0',
      date: FROM,
      startISO: `${FROM}T15:00:00.000Z`,
      endISO: `${FROM}T16:00:00.000Z`,
    });
    const model = buildResolveModel(baseInputs({ context: [day0] }), [day0], '12:30') as {
      model: { shipments: Array<{ label: string; deliveries: Array<{ timeWindows: Array<Record<string, unknown>> }> }> };
    };
    const mv = model.model.shipments.find((s) => s.label === movableLabel('asg-d0'));
    expect(mv?.deliveries[0].timeWindows[0]).toMatchObject({
      startTime: `${FROM}T12:30:00Z`,
    });

    const inputs = baseInputs({
      queue: [windowedItem()],
      context: [movableFix({ assignmentId: 'asg-stay' })],
    });
    expect(buildResolveModel(inputs, [])).toEqual(buildFreezeModel(inputs));
  });
});

describe('solveResolve (fake transport)', () => {
  const seams = (routes: unknown[], skippedShipments: unknown[] = []) => ({
    mintToken: async () => ({ token: 't', projectId: 'p' }),
    transport: async () => ({ routes, skippedShipments }),
  });

  test('changed rows become moves (capacity follows cross-tech), identical rows are KEPT, skipped movables report kept-as-booked', async () => {
    const moved = movableFix(); // p1 Tue 10:00 → will land p2 Wed 09:00
    const stays = movableFix({
      assignmentId: 'asg-stay',
      startISO: '2027-05-04T13:00:00.000Z',
      endISO: '2027-05-04T14:00:00.000Z',
    });
    const shifted = movableFix({
      assignmentId: 'asg-shift', // same tech, same day, new time — still a move
      startISO: '2027-05-04T08:00:00.000Z',
      endISO: '2027-05-04T09:00:00.000Z',
    });
    const dropped = movableFix({ assignmentId: 'asg-drop' });
    const inputs = baseInputs({ context: [moved, stays, shifted, dropped] });
    const plan = await solveResolve(inputs, {}, '00:00', seams(
      [
        {
          vehicleLabel: vehicleLabel('p2', '2027-05-03'),
          visits: [{ shipmentLabel: movableLabel('asg-mv'), startTime: '2027-05-03T09:00:00Z' }],
        },
        {
          vehicleLabel: vehicleLabel('p1', '2027-05-04'),
          visits: [
            { shipmentLabel: movableLabel('asg-stay'), startTime: '2027-05-04T13:00:00Z' },
            { shipmentLabel: movableLabel('asg-shift'), startTime: '2027-05-04T15:00:00Z' },
          ],
        },
      ],
      [{ label: movableLabel('asg-drop') }],
    ));

    expect(plan.moves).toHaveLength(2);
    const cross = plan.moves.find((m) => m.assignmentId === 'asg-mv');
    expect(cross).toMatchObject({
      fromTechnicianRef: 'p1',
      fromDate: '2027-05-04',
      fromStart: '10:00',
      toTechnicianRef: 'p2',
      toDate: '2027-05-03',
      toStartTime: '09:00',
      toEndTime: '10:30', // 90 min carried
    });
    const shift = plan.moves.find((m) => m.assignmentId === 'asg-shift');
    expect(shift).toMatchObject({ toTechnicianRef: 'p1', toStartTime: '15:00' });
    // kept = stays (identical) + dropped (solver-skipped, reported).
    expect(plan.keptCount).toBe(2);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ ref: 'asg-drop', reason: expect.stringContaining('kept as booked') }),
    ]);
    // Capacity: p1 base 60 − 90 (cross-tech out); p2 base 0 + 90 in. The
    // same-tech shift moves no minutes.
    expect(plan.capacity.find((c) => c.technicianRef === 'p1')?.committedMin).toBe(-30);
    expect(plan.capacity.find((c) => c.technicianRef === 'p2')?.committedMin).toBe(90);
  });

  test('queues still place in the same solve (freeze parity)', async () => {
    const plan = await solveResolve(
      baseInputs({ queue: [windowedItem()], context: [movableFix()] }),
      {},
      '00:00',
      seams([
        {
          vehicleLabel: vehicleLabel('p1', '2027-05-04'),
          visits: [
            { shipmentLabel: 'q|asg-w', startTime: '2027-05-04T08:30:00Z' },
            { shipmentLabel: movableLabel('asg-mv'), startTime: '2027-05-04T10:00:00Z' },
          ],
        },
      ]),
    );
    expect(plan.placements).toHaveLength(1);
    expect(plan.placements[0]).toMatchObject({ assignmentId: 'asg-w', startTime: '08:30' });
    expect(plan.moves).toHaveLength(0); // the movable landed exactly where it was
    expect(plan.keptCount).toBe(1);
  });

  test('a FIXED statue the solver could not seat still gets the freeze-parity capacity note (resolve ⊇ freeze)', async () => {
    const pinnedLate = movableFix({
      assignmentId: 'asg-pinlate',
      technicianRef: 'p2',
      date: '2027-05-03',
      startISO: '2027-05-03T18:00:00.000Z', // after Pam's 15:00 end — unseatable
      endISO: '2027-05-03T19:00:00.000Z',
      locked: true, // a statue — ships as ctx|, not mv|
    });
    const plan = await solveResolve(
      baseInputs({ context: [pinnedLate], queue: [windowedItem()] }),
      {},
      '00:00',
      seams(
        [
          {
            vehicleLabel: vehicleLabel('p1', '2027-05-03'),
            visits: [{ shipmentLabel: 'q|asg-w', startTime: '2027-05-03T08:00:00Z' }],
          },
        ],
        [{ label: 'ctx|asg-pinlate' }],
      ),
    );
    expect(plan.skipped).toEqual([
      expect.objectContaining({
        ref: 'asg-pinlate',
        reason: expect.stringContaining('kept as booked'),
      }),
    ]);
  });

  test('guards: nothing movable + empty queue, or zero vehicles → NO API call, everything kept', async () => {
    const explode = async (): Promise<never> => {
      throw new Error('transport must not be called');
    };
    const noWork = await solveResolve(
      baseInputs({ context: [movableFix({ locked: true })] }),
      {},
      '00:00',
      { transport: explode, mintToken: explode },
    );
    expect(noWork.moves).toHaveLength(0);
    expect(noWork.keptCount).toBe(0);

    const noVehicles = await solveResolve(
      baseInputs({ vehicles: [], queue: [windowedItem({ technicianRef: null })], context: [movableFix()], capacity: [] }),
      {},
      '00:00',
      { transport: explode, mintToken: explode },
    );
    expect(noVehicles.moves).toHaveLength(0);
    expect(noVehicles.keptCount).toBe(1); // kept, not dropped
    expect(noVehicles.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringContaining('set_availability') }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Impure half: assembleFreezeInputs against the local stack

describe('assembleFreezeInputs (integration)', { timeout: 30_000 }, () => {
  test('queues, skips, vehicles, context, capacity — the whole assembly', async () => {
    // Roster: one pattern tech (split week, Friday off), one pattern-less.
    const pat = await insertTechnician({ tenantId, ref: 'fz-pat', displayName: 'Freeze Pat' });
    await setTechnicianState(pat.id, 'active'); // the assembler sees ACTIVE techs only (fit.ts parity)
    await setTechnicianAvailability(pat.id, SPLIT_WEEK);
    await addTimeOff({
      tenantId,
      technicianId: pat.id,
      startsOn: '2027-05-07',
      endsOn: '2027-05-07',
      reason: 'PTO',
    });
    const norm = await insertTechnician({ tenantId, ref: 'fz-nopat', displayName: 'Freeze Norm' });
    await setTechnicianState(norm.id, 'active');

    // Customers: A/B pre-coded (no geocode calls), C address-less.
    const custA = await createCustomer({
      tenantId, name: 'Coded Cara', addressLine1: '1 Coded Ct', city: 'Clovis', state: 'CA',
    });
    await updateCustomerCoords(custA.id, 36.81, -119.71);
    const custB = await createCustomer({
      tenantId, name: 'Coded Ben', addressLine1: '2 Coded Ct', city: 'Clovis', state: 'CA',
    });
    await updateCustomerCoords(custB.id, 36.82, -119.72);
    const custC = await createCustomer({ tenantId, name: 'Bare Bea' });
    // D has an address Google can't locate (the fake returns ZERO_RESULTS).
    const custD = await createCustomer({
      tenantId, name: 'Lost Lou', addressLine1: '999 Nowhere Rd', city: 'Atlantis',
    });

    // Queue 1 fixtures: placeable job / duration-less job / address-less job.
    const jobReady = await createJob({
      tenantId, customerId: custA.id, title: 'ready job', status: 'open', durationMinutes: 120,
    });
    const jobNoLen = await createJob({
      tenantId, customerId: custB.id, title: 'lengthless job', status: 'open',
    });
    const jobNoAddr = await createJob({
      tenantId, customerId: custC.id, title: 'addressless job', status: 'open', durationMinutes: 60,
    });
    const jobUnloc = await createJob({
      tenantId, customerId: custD.id, title: 'unlocatable job', status: 'open', durationMinutes: 60,
    });

    // Context: Pat placed in-horizon; Norm placed (pattern-less → omitted).
    const ctxVisit = await bookVisit({
      tenantId, technicianRef: 'fz-pat', customerId: custA.id, title: 'ctx visit',
      date: '2027-05-03', startTime: '09:00', endTime: '10:30', actorRef: 'mgr',
    });
    await bookVisit({
      tenantId, technicianRef: 'fz-nopat', customerId: custA.id, title: 'norm visit',
      date: '2027-05-04', startTime: '09:00', endTime: '10:00', actorRef: 'mgr',
    });

    // Queue 2: person-less placed in-horizon / beyond-horizon / past-fence /
    // straddling-fence unplaced.
    const exactRow = await bookVisit({
      tenantId, customerId: custB.id, title: 'exact person-less',
      date: '2027-05-04', startTime: '10:00', endTime: '11:30', actorRef: 'mgr',
    });
    const beyondRow = await bookVisit({
      tenantId, customerId: custB.id, title: 'beyond person-less',
      date: '2027-05-12', startTime: '10:00', endTime: '11:00', actorRef: 'mgr',
    });
    const pastJob = await createJob({
      tenantId, customerId: custA.id, title: 'past fence job', status: 'open', durationMinutes: 60,
    });
    const pastRow = await bookVisit({
      tenantId, jobId: pastJob.id, timeTbd: true,
      earliestDate: '2027-04-01', latestDate: '2027-04-02', actorRef: 'mgr',
    });
    const straddleJob = await createJob({
      tenantId, customerId: custA.id, title: 'straddle job', status: 'open', durationMinutes: 45,
    });
    const straddleRow = await bookVisit({
      tenantId, jobId: straddleJob.id, timeTbd: true,
      earliestDate: '2027-05-01', latestDate: '2027-05-04', actorRef: 'mgr',
    });
    // Person-less unplaced with a fence wholly BEYOND the horizon → reported.
    const farJob = await createJob({
      tenantId, customerId: custA.id, title: 'far fence job', status: 'open', durationMinutes: 30,
    });
    const farRow = await bookVisit({
      tenantId, jobId: farJob.id, timeTbd: true,
      earliestDate: '2027-06-01', latestDate: '2027-06-02', actorRef: 'mgr',
    });
    // Person-less unplaced on a duration-less shell (customerId timeTbd path
    // mints one) → the ladder remedy.
    const noLenRow = await bookVisit({
      tenantId, customerId: custB.id, title: 'tbd no length', timeTbd: true,
      earliestDate: '2027-05-05', latestDate: '2027-05-06', actorRef: 'mgr',
    });

    // Queue 3: assigned-unplaced to Pat (fence past horizonTo → clamped);
    // assigned to pattern-less Norm → skip; a PINNED one → skip.
    const q3Job = await createJob({
      tenantId, customerId: custB.id, title: 'assigned tbd', status: 'open', durationMinutes: 90,
    });
    const q3Row = await bookVisit({
      tenantId, jobId: q3Job.id, technicianRef: 'fz-pat', timeTbd: true,
      earliestDate: '2027-05-05', latestDate: '2027-05-20', actorRef: 'mgr',
    });
    const normJob = await createJob({
      tenantId, customerId: custA.id, title: 'norm tbd', status: 'open', durationMinutes: 60,
    });
    const normRow = await bookVisit({
      tenantId, jobId: normJob.id, technicianRef: 'fz-nopat', timeTbd: true,
      earliestDate: '2027-05-05', latestDate: '2027-05-06', actorRef: 'mgr',
    });
    const pinJob = await createJob({
      tenantId, customerId: custA.id, title: 'pinned tbd', status: 'open', durationMinutes: 60,
    });
    const pinRow = await bookVisit({
      tenantId, jobId: pinJob.id, technicianRef: 'fz-pat', timeTbd: true,
      earliestDate: '2027-05-06', latestDate: '2027-05-06', actorRef: 'mgr',
    });
    await setVisitLocks(tenantId, { assignmentIds: [pinRow.assignment.id] }, true, 'mgr');

    const inputs = await assembleFreezeInputs(tenantId, FROM, TO, '00:00', {
      geocode: zeroResultsGeocode,
    });
    // The ONLY geocoded address was the unlocatable customer's — everyone
    // else was pre-coded (no re-calls) or address-less (no call at all).
    expect(geocodeCalls).toEqual(['999 Nowhere Rd, Atlantis']);

    // Vehicles: Pat only, Mon–Thu (Fri = PTO, Sat/Sun off-pattern).
    expect(inputs.vehicles.map((v) => `${v.technicianRef}|${v.date}`)).toEqual([
      'fz-pat|2027-05-03', 'fz-pat|2027-05-04', 'fz-pat|2027-05-05', 'fz-pat|2027-05-06',
    ]);
    expect(inputs.vehicles[0].windows).toEqual([['08:00', '12:00'], ['13:00', '17:00']]);

    // Context: Pat's placed visit only (Norm's omitted — pattern-less).
    expect(inputs.context).toHaveLength(1);
    expect(inputs.context[0]).toMatchObject({
      assignmentId: ctxVisit.assignment.id,
      technicianRef: 'fz-pat',
      coords: { lat: 36.81, lng: -119.71 },
      // Movability inputs ride along (re-solve, plan 2026-07-30).
      locked: false,
      promiseLevel: 'none',
      promisedDay: null,
      jobId: ctxVisit.job.id,
      customer: 'Coded Cara',
      jobTitle: 'ctx visit',
    });

    // Queue: ready job + exact person-less + straddler (clamped) + Pat's tbd (clamped).
    const byRef = new Map(inputs.queue.map((q) => [q.assignmentId ?? `job:${q.jobId}`, q]));
    expect(byRef.get(`job:${jobReady.id}`)).toMatchObject({
      kind: 'unscheduled_job', durationMin: 120, windowFrom: FROM, windowTo: TO,
    });
    expect(byRef.get(exactRow.assignment.id)).toMatchObject({
      kind: 'unassigned_visit',
      exactStart: exactRow.assignment.starts_at,
      durationMin: 90,
      windowFrom: '2027-05-04', windowTo: '2027-05-04',
    });
    expect(byRef.get(straddleRow.assignment.id)).toMatchObject({
      kind: 'unplaced_visit', technicianRef: null,
      windowFrom: FROM, windowTo: '2027-05-04', // fence start clamped up
      durationMin: 45,
    });
    expect(byRef.get(q3Row.assignment.id)).toMatchObject({
      kind: 'unplaced_visit', technicianRef: 'fz-pat',
      windowFrom: '2027-05-05', windowTo: TO, // fence end clamped down
      durationMin: 90,
    });
    expect(inputs.queue).toHaveLength(4);

    // Skips: every reason, named.
    const skipByRef = new Map(inputs.skipped.map((s) => [s.ref, s]));
    expect(skipByRef.get('tech:fz-nopat')?.reason).toContain('no working pattern');
    expect(skipByRef.get(`job:${jobNoLen.id}`)?.reason).toContain('no length set');
    expect(skipByRef.get(`job:${jobNoAddr.id}`)?.reason).toContain('no usable street address');
    expect(skipByRef.get(`job:${jobUnloc.id}`)?.reason).toContain("couldn't be located");
    expect(skipByRef.get(beyondRow.assignment.id)?.reason).toContain("beyond this freeze's horizon");
    expect(skipByRef.get(pastRow.assignment.id)?.reason).toContain('passed');
    expect(skipByRef.get(farRow.assignment.id)?.reason).toContain("beyond this freeze's horizon");
    expect(skipByRef.get(noLenRow.assignment.id)?.reason).toContain('no length set');
    expect(skipByRef.get(normRow.assignment.id)?.reason).toContain('who has no working pattern');
    expect(skipByRef.get(pinRow.assignment.id)?.reason).toContain('pinned');

    // Capacity: Pat available = 4 workdays × 480 = 1920; committed = 90 (context).
    expect(inputs.capacity).toEqual([
      expect.objectContaining({
        technicianRef: 'fz-pat', committedMin: 90, availableMin: 1920,
      }),
    ]);
  });

  test("day-0 now clamp: the run day's past hours are not capacity (final review)", async () => {
    // 12:30 falls in Pat's lunch gap — the morning window (ends 12:00) drops
    // entirely; the afternoon window survives whole.
    const inputs = await assembleFreezeInputs(tenantId, FROM, TO, '12:30', {
      geocode: zeroResultsGeocode,
    });
    const day0 = inputs.vehicles.find((v) => v.technicianRef === 'fz-pat' && v.date === FROM);
    expect(day0?.windows).toEqual([['13:00', '17:00']]);
    expect(
      inputs.capacity.find((c) => c.technicianRef === 'fz-pat')?.availableMin,
    ).toBe(240 + 3 * 480); // day-0 afternoon only + Tue–Thu whole days
  });
});
