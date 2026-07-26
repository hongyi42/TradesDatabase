// The freeze solve (plan 4b-3 Phase 3): queues + capacity in, placement plan
// out. PURE over its inputs past the assembly step — no writes, no chat
// surface; run_freeze (Phase 4) stages what this returns.
//
// Model mapping (the plan's Decisions section):
//   vehicle  = one (pattern-having technician, working day in horizon);
//              window = the day's pattern span, interior gaps as breaks; NO
//              depot (start/end locations omitted — home→first-job drive is a
//              recorded invisible).
//   context  = already-placed visits of vehicle-having techs: exact-arrival
//              window pinned to that one vehicle, LARGE penaltyCost so a
//              visit booked outside the pattern degrades to a capacity
//              warning, never an infeasible solve. NEVER committed.
//   queue    = the three loose queues as skippable shipments (penaltyCost):
//              unscheduled jobs (whole-horizon window), person-less PLACED
//              visits (exact-times window — the solver picks WHO only),
//              unplaced visits (fence∩horizon per-day windows).
// Naive-local ↔ RFC3339 only at this boundary: stored times are wall-clock
// as-if-UTC, so `${date}T${hhmm}:00Z` both directions.
//
// Vendor facts (checked live 2026-07-26, ShipmentModel reference
// https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentModel):
//   - TimeWindow bounds the ARRIVAL time (startTime <= arrival <= endTime).
//   - "Time windows must be disjoint … no time window must overlap with or be
//     ADJACENT to another" — so a day-fence range ships as ONE contiguous
//     arrival window, never per-day windows (adjacent midnight edges would
//     reject the whole request; phase-review finding, supersedes the plan's
//     per-day sketch).
//   - An omitted penaltyCost means MANDATORY ("considered infinite") — every
//     shipment here carries one explicitly.
//   - arrivalLocation is optional (forbidden WITH duration/distance matrices,
//     which we don't use) — a context visit whose customer can't be geocoded
//     ships location-less: it still pins the technician's TIME even though
//     its travel contribution is unknown to the solver.
//   - Durations are strings like "3600s".
// Response parsing keys on LABELS, never indexes: proto3 JSON omits
// zero-valued fields, so an absent shipmentIndex/vehicleIndex means 0 — an
// index-keyed reader silently misattributes the first shipment/vehicle.

import {
  getJob,
  isPlaced,
  listAssignmentsForTenant,
  listJobsWithCustomerByIds,
  listTeam,
  listTimeOffForTechnician,
  listUnassignedAssignmentsWithRefs,
  listUnplacedAssignedForRange,
  listUnscheduledOpenJobsWithCustomer,
  type WeeklyPattern,
} from '../db/index.js';
import { addDaysISO, dayWindows } from './fit.js';
import { ensureCoordsById, type CustomerCoords, type GeocodeTransport, type LatLng } from '../routes/geocode.js';
import { optimizeTours, type MintRoiToken, type RoiTransport } from '../routes/roiClient.js';
import { spanMinutes } from './booking.js';

// ---------------------------------------------------------------------------
// Shapes

export type FreezeQueueKind = 'unscheduled_job' | 'unassigned_visit' | 'unplaced_visit';

export interface FreezeQueueItem {
  kind: FreezeQueueKind;
  jobId: string;
  assignmentId: string | null; // null = unscheduled job (no visit yet)
  customer: string | null;
  jobTitle: string | null;
  technicianRef: string | null; // attached person (unplaced_visit only)
  durationMin: number;
  // Always set by the assembler (coord failures are skipped-with-reason
  // before an item is queued); nullable so a hand-built input can't crash
  // the model builder.
  coords: LatLng | null;
  windowFrom: string; // YYYY-MM-DD, already ∩ horizon
  windowTo: string; // YYYY-MM-DD inclusive
  exactStart: string | null; // naive-local ISO — person-less PLACED rows only
  exactEnd: string | null;
}

export interface FreezeContextVisit {
  assignmentId: string;
  technicianRef: string;
  date: string; // YYYY-MM-DD
  startISO: string; // naive-local
  endISO: string;
  coords: LatLng | null; // null = ungecodable — ships location-less (see header)
}

export interface FreezeVehicle {
  technicianRef: string;
  technicianName: string;
  date: string; // YYYY-MM-DD
  windows: [string, string][]; // the day's pattern windows, HH:MM
}

export interface FreezeSkip {
  ref: string; // assignmentId, or `job:<id>` for visit-less jobs
  label: string; // human handle: customer and/or title
  reason: string; // server-composed, relayed verbatim
}

export interface FreezeCapacity {
  technicianRef: string;
  technicianName: string;
  committedMin: number; // existing placed visits (+ new placements after solve)
  availableMin: number; // pattern minutes across the horizon minus time off
}

export interface FreezeInputs {
  horizonFrom: string;
  horizonTo: string;
  vehicles: FreezeVehicle[];
  queue: FreezeQueueItem[];
  context: FreezeContextVisit[];
  skipped: FreezeSkip[]; // input-side skips (locked / no duration / no pattern / no coords / out of horizon)
  capacity: FreezeCapacity[]; // pre-solve: committed = context only
}

export interface FreezePlacement {
  kind: FreezeQueueKind;
  jobId: string;
  assignmentId: string | null;
  customer: string | null;
  jobTitle: string | null;
  technicianRef: string;
  date: string;
  startTime: string; // HH:MM
  endTime: string; // HH:MM
}

export interface FreezePlan {
  horizonFrom: string;
  horizonTo: string;
  placements: FreezePlacement[];
  skipped: FreezeSkip[]; // input-side + solver-side, one list
  capacity: FreezeCapacity[]; // committed now INCLUDES the plan's placements
}

// ---------------------------------------------------------------------------
// Input assembly (the impure half)

const skipLabel = (customer: string | null, title: string | null): string =>
  [customer, title].filter(Boolean).join(' — ') || 'unnamed';

const LADDER_REMEDY =
  "no length set — ask how long it takes and record it (update_job durationMinutes), then run the freeze again";

const coordSkipReason = (c: CustomerCoords & { ok: false }): string =>
  c.reason === 'no_address'
    ? 'customer has no usable street address on file'
    : "customer's address couldn't be located on the map — check/correct it";

export async function assembleFreezeInputs(
  tenantId: string,
  horizonFrom: string,
  horizonTo: string,
  deps: { geocode?: GeocodeTransport } = {},
): Promise<FreezeInputs> {
  const skipped: FreezeSkip[] = [];

  // -- Technicians → vehicles. Pattern-less techs are INVISIBLE to the freeze
  // (assembleFitContext's skippedNoPattern precedent): no vehicle, no new
  // work, and their placed visits are omitted from context entirely.
  const team = (await listTeam(tenantId)).filter((t) => t.state === 'active');
  const patternTechs = team.filter((t) => t.availability !== null);
  for (const t of team.filter((t) => t.availability === null)) {
    skipped.push({
      ref: `tech:${t.ref}`,
      label: t.display_name,
      reason:
        'no working pattern set — invisible to the freeze (set_availability fixes this)',
    });
  }
  const patternRefs = new Set(patternTechs.map((t) => t.ref));

  const vehicles: FreezeVehicle[] = [];
  const availableByRef = new Map<string, number>();
  for (const t of patternTechs) {
    const timeOff = await listTimeOffForTechnician(t.id, horizonFrom, horizonTo);
    const offDates = new Set<string>();
    for (const r of timeOff) {
      for (let d = r.starts_on; d <= r.ends_on; d = addDaysISO(d, 1)) offDates.add(d);
    }
    for (let date = horizonFrom; date <= horizonTo; date = addDaysISO(date, 1)) {
      if (offDates.has(date)) continue;
      const windows = normalizeWindows(dayWindows(t.availability as WeeklyPattern, date));
      if (windows.length === 0) continue;
      vehicles.push({ technicianRef: t.ref, technicianName: t.display_name, date, windows });
      const minutes = windows.reduce(
        (sum, [s, e]) => sum + (toMin(e === '24:00' ? '23:59' : e) - toMin(s) + (e === '24:00' ? 1 : 0)),
        0,
      );
      availableByRef.set(t.ref, (availableByRef.get(t.ref) ?? 0) + minutes);
    }
  }
  // Refs that actually got at least one working day — an attached queue row
  // whose person has NO vehicle days must be skipped, not serialized as an
  // empty allowedVehicleIndices (which the API reads as "ALL vehicles";
  // phase-review finding 2).
  const vehicleRefs = new Set(vehicles.map((v) => v.technicianRef));

  // -- Context: every placed confirmed visit of a vehicle-having tech in the
  // horizon. The tenant-wide read includes person-less rows — those are QUEUE
  // (picked up below via the bucket reader), not context.
  const placedRows = (
    await listAssignmentsForTenant(
      tenantId,
      `${horizonFrom}T00:00:00.000Z`,
      `${addDaysISO(horizonTo, 1)}T00:00:00.000Z`,
      ['confirmed'],
    )
  ).filter((r) => r.technician_id !== null);
  const techById = new Map(team.map((t) => [t.id, t]));
  const contextRows = placedRows.filter((r) => {
    const t = techById.get(r.technician_id as string);
    return t !== undefined && patternRefs.has(t.ref);
  });

  // -- The three queues.
  const [jobsQueue, personLess, assignedUnplaced] = await Promise.all([
    listUnscheduledOpenJobsWithCustomer(tenantId),
    listUnassignedAssignmentsWithRefs(tenantId, `${horizonFrom}T00:00:00.000Z`),
    listUnplacedAssignedForRange(tenantId, horizonFrom, horizonTo),
  ]);

  // -- One geocoding batch for every customer the model touches (queue items
  // AND context visits). Queue-1 rows embed the customer NAME only, so the
  // address ride comes from the customer id via ensureCoordsById (review
  // finding 11 — getCustomer per unique id inside the batch helper).
  const contextJobs = await listJobsWithCustomerByIds(tenantId, [
    ...new Set(contextRows.map((r) => r.job_id)),
  ]);
  const customerIdByJob = new Map(contextJobs.map((j) => [j.id, j.customer_id]));
  const queueCustomerIds: string[] = [];
  for (const j of jobsQueue) queueCustomerIds.push(j.customer_id);
  for (const r of personLess) if (r.jobs && r.jobs.tenant_id === tenantId) queueCustomerIds.push(r.jobs.customer_id);
  for (const r of assignedUnplaced) if (r.jobs && r.jobs.tenant_id === tenantId) queueCustomerIds.push(r.jobs.customer_id);
  const coordsById = await ensureCoordsById(
    [...queueCustomerIds, ...contextRows.map((r) => customerIdByJob.get(r.job_id)).filter((v): v is string => !!v)],
    deps,
  );
  const coordsFor = (customerId: string | undefined): CustomerCoords =>
    (customerId ? coordsById.get(customerId) : undefined) ?? { ok: false, reason: 'no_address' };

  const context: FreezeContextVisit[] = contextRows.map((r) => {
    const t = techById.get(r.technician_id as string);
    const c = coordsFor(customerIdByJob.get(r.job_id));
    return {
      assignmentId: r.id,
      technicianRef: (t as { ref: string }).ref,
      date: r.starts_at.slice(0, 10),
      startISO: r.starts_at,
      endISO: r.ends_at,
      coords: c.ok ? c.coords : null,
    };
  });

  const queue: FreezeQueueItem[] = [];

  // Queue 1 — open jobs with no visit at all. Window = the whole horizon.
  for (const j of jobsQueue) {
    const label = skipLabel(
      j.customers && j.customers.tenant_id === tenantId ? j.customers.name : null,
      j.title,
    );
    if (j.duration_minutes === null) {
      skipped.push({ ref: `job:${j.id}`, label, reason: LADDER_REMEDY });
      continue;
    }
    const c = coordsFor(j.customer_id);
    if (!c.ok) {
      skipped.push({ ref: `job:${j.id}`, label, reason: coordSkipReason(c) });
      continue;
    }
    queue.push({
      kind: 'unscheduled_job',
      jobId: j.id,
      assignmentId: null,
      customer: j.customers && j.customers.tenant_id === tenantId ? j.customers.name : null,
      jobTitle: j.title,
      technicianRef: null,
      durationMin: j.duration_minutes,
      coords: c.coords,
      windowFrom: horizonFrom,
      windowTo: horizonTo,
      exactStart: null,
      exactEnd: null,
    });
  }

  // Queue 2 — person-less visits (placed AND unplaced; the reader is
  // unbounded above, so beyond-horizon rows are filtered + REPORTED — review
  // finding 10). A placed row keeps its exact times: the solver picks WHO.
  for (const r of personLess) {
    const job = r.jobs && r.jobs.tenant_id === tenantId ? r.jobs : null;
    const customer = job && job.customers && job.customers.tenant_id === tenantId ? job.customers.name : null;
    const label = skipLabel(customer, job?.title ?? null);
    if (r.locked) {
      skipped.push({ ref: r.id, label, reason: 'pinned by a manager — the freeze never touches pinned visits' });
      continue;
    }
    if (isPlaced(r)) {
      const day = r.starts_at.slice(0, 10);
      if (day > horizonTo) {
        skipped.push({ ref: r.id, label, reason: `beyond this freeze's horizon (${day}) — still needs a person` });
        continue;
      }
      const c = coordsFor(job?.customer_id);
      if (!c.ok) {
        skipped.push({ ref: r.id, label, reason: coordSkipReason(c) });
        continue;
      }
      queue.push({
        kind: 'unassigned_visit',
        jobId: r.job_id,
        assignmentId: r.id,
        customer,
        jobTitle: job?.title ?? null,
        technicianRef: null,
        durationMin: spanMinutes(r.starts_at, r.ends_at),
        coords: c.coords,
        windowFrom: day,
        windowTo: day,
        exactStart: r.starts_at,
        exactEnd: r.ends_at,
      });
      continue;
    }
    // Unplaced person-less: fence ∩ horizon.
    const fenceFrom = r.earliest_date as string;
    const fenceTo = r.latest_date as string;
    if (fenceTo < horizonFrom) {
      skipped.push({ ref: r.id, label, reason: 'its whole day range has passed — recover or re-fence it in chat' });
      continue;
    }
    if (fenceFrom > horizonTo) {
      skipped.push({ ref: r.id, label, reason: `beyond this freeze's horizon (${fenceFrom}–${fenceTo})` });
      continue;
    }
    const movedJob = await getJob(r.job_id);
    if (!movedJob?.duration_minutes) {
      skipped.push({ ref: r.id, label, reason: LADDER_REMEDY });
      continue;
    }
    const c = coordsFor(job?.customer_id);
    if (!c.ok) {
      skipped.push({ ref: r.id, label, reason: coordSkipReason(c) });
      continue;
    }
    queue.push({
      kind: 'unplaced_visit',
      jobId: r.job_id,
      assignmentId: r.id,
      customer,
      jobTitle: job?.title ?? null,
      technicianRef: null,
      durationMin: movedJob.duration_minutes,
      coords: c.coords,
      windowFrom: fenceFrom < horizonFrom ? horizonFrom : fenceFrom,
      windowTo: fenceTo > horizonTo ? horizonTo : fenceTo,
      exactStart: null,
      exactEnd: null,
    });
  }

  // Queue 3 — assigned time-TBD visits intersecting the horizon (the reader
  // is range-bounded, so wholly-outside rows aren't in the run — no skip line
  // for them by design, review finding 10).
  for (const r of assignedUnplaced) {
    const job = r.jobs && r.jobs.tenant_id === tenantId ? r.jobs : null;
    const customer = job && job.customers && job.customers.tenant_id === tenantId ? job.customers.name : null;
    const tech = r.technicians && r.technicians.tenant_id === tenantId ? r.technicians : null;
    const label = skipLabel(customer, job?.title ?? null);
    if (r.locked) {
      skipped.push({ ref: r.id, label, reason: 'pinned by a manager — the freeze never touches pinned visits' });
      continue;
    }
    if (!tech || !patternRefs.has(tech.ref)) {
      skipped.push({
        ref: r.id,
        label,
        reason: `assigned to ${tech?.display_name ?? 'someone off-roster'}, who has no working pattern — set_availability, then rerun`,
      });
      continue;
    }
    if (!vehicleRefs.has(tech.ref)) {
      skipped.push({
        ref: r.id,
        label,
        reason: `assigned to ${tech.display_name}, who has no working days in this horizon (time off or pattern) — move it, or rerun a later week`,
      });
      continue;
    }
    if (job?.duration_minutes == null) {
      skipped.push({ ref: r.id, label, reason: LADDER_REMEDY });
      continue;
    }
    const c = coordsFor(job.customer_id);
    if (!c.ok) {
      skipped.push({ ref: r.id, label, reason: coordSkipReason(c) });
      continue;
    }
    const fenceFrom = r.earliest_date as string;
    const fenceTo = r.latest_date as string;
    queue.push({
      kind: 'unplaced_visit',
      jobId: r.job_id,
      assignmentId: r.id,
      customer,
      jobTitle: job.title,
      technicianRef: tech.ref,
      durationMin: job.duration_minutes,
      coords: c.coords,
      windowFrom: fenceFrom < horizonFrom ? horizonFrom : fenceFrom,
      windowTo: fenceTo > horizonTo ? horizonTo : fenceTo,
      exactStart: null,
      exactEnd: null,
    });
  }

  // Pre-solve capacity: committed = the context visits' own spans.
  const committedByRef = new Map<string, number>();
  for (const v of context) {
    committedByRef.set(
      v.technicianRef,
      (committedByRef.get(v.technicianRef) ?? 0) + spanMinutes(v.startISO, v.endISO),
    );
  }
  const capacity: FreezeCapacity[] = patternTechs.map((t) => ({
    technicianRef: t.ref,
    technicianName: t.display_name,
    committedMin: committedByRef.get(t.ref) ?? 0,
    availableMin: availableByRef.get(t.ref) ?? 0,
  }));

  return { horizonFrom, horizonTo, vehicles, queue, context, skipped, capacity };
}

// ---------------------------------------------------------------------------
// Model building (pure)

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const toHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Pattern windows arrive as stored — assertValidPattern checks each window in
// isolation, so unsorted, overlapping, or ADJACENT windows are storable
// ([['08:00','12:00'],['12:00','17:00']] is a natural lunch-less pattern).
// fit.ts merely degrades on those; here they would build an inverted vehicle
// span or a zero-length break, and the API rejects the whole request
// (BreakRequest minDuration "must be positive"; phase-review finding 3).
// Sort + merge before any span/break math.
export function normalizeWindows(windows: [string, string][]): [string, string][] {
  const sorted = [...windows].sort((a, b) => toMin(a[0]) - toMin(b[0]));
  const out: [string, string][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && toMin(s) <= toMin(last[1])) {
      if (toMin(e) > toMin(last[1])) last[1] = e; // overlap/adjacency merges
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

// Naive-local day + HH:MM → the RFC3339 the API wants (as-if-UTC, the storage
// convention). A '24:00' pattern edge is the next day's midnight.
const rfc = (date: string, hhmm: string): string =>
  hhmm === '24:00' ? `${addDaysISO(date, 1)}T00:00:00Z` : `${date}T${hhmm}:00Z`;
// Stored naive-local ISO ('...T09:00:00.000Z' or '...T09:00:00+00:00') → RFC3339.
const rfcFromISO = (iso: string): string => `${iso.slice(0, 10)}T${iso.slice(11, 19)}Z`;

const seconds = (min: number): string => `${min * 60}s`;

export const QUEUE_PENALTY = 1_000;
export const CONTEXT_PENALTY = 1_000_000;

export const vehicleLabel = (ref: string, date: string): string => `veh|${ref}|${date}`;
export const queueLabel = (item: FreezeQueueItem): string =>
  `q|${item.assignmentId ?? `job:${item.jobId}`}`;
const contextLabel = (assignmentId: string): string => `ctx|${assignmentId}`;

export function buildFreezeModel(inputs: FreezeInputs): unknown {
  const vehicleIndexByLabel = new Map(
    inputs.vehicles.map((v, i) => [vehicleLabel(v.technicianRef, v.date), i]),
  );
  const vehicleIndexesByRef = new Map<string, number[]>();
  inputs.vehicles.forEach((v, i) => {
    vehicleIndexesByRef.set(v.technicianRef, [...(vehicleIndexesByRef.get(v.technicianRef) ?? []), i]);
  });

  const vehicles = inputs.vehicles.map((v) => {
    const windows = normalizeWindows(v.windows);
    const first = windows[0];
    const last = windows[windows.length - 1];
    // Interior pattern gaps become mandatory breaks pinned to the gap
    // (normalization above guarantees every gap is > 0 minutes).
    const breaks = windows.slice(1).map((w, i) => {
      const gapStart = windows[i][1]; // previous window's end
      const gapMin = toMin(w[0]) - toMin(gapStart);
      return {
        earliestStartTime: rfc(v.date, gapStart),
        latestStartTime: rfc(v.date, gapStart),
        minDuration: seconds(gapMin),
      };
    });
    return {
      label: vehicleLabel(v.technicianRef, v.date),
      startTimeWindows: [{ startTime: rfc(v.date, first[0]) }],
      endTimeWindows: [{ endTime: rfc(v.date, last[1]) }],
      // Prefer less driving; no depot (recorded limitation: the home→first-job
      // leg is invisible to the solve).
      costPerTraveledHour: 1,
      ...(breaks.length > 0 ? { breakRule: { breakRequests: breaks } } : {}),
    };
  });

  const shipments: unknown[] = [];
  for (const item of inputs.queue) {
    // Arrival windows: exact rows pin arrival to the stored start; windowed
    // rows get ONE contiguous arrival window covering fence∩horizon (the
    // fence is a contiguous day range, and the API rejects adjacent windows —
    // see the vendor-facts header). TimeWindow bounds the ARRIVAL; the
    // vehicle's own windows keep it inside the pattern.
    const timeWindows = item.exactStart
      ? [{ startTime: rfcFromISO(item.exactStart), endTime: rfcFromISO(item.exactStart) }]
      : [
          {
            startTime: `${item.windowFrom}T00:00:00Z`,
            endTime: `${addDaysISO(item.windowTo, 1)}T00:00:00Z`,
          },
        ];
    const allowed = item.technicianRef ? vehicleIndexesByRef.get(item.technicianRef) ?? [] : null;
    // An attached tech with ZERO vehicle days must never serialize as
    // allowedVehicleIndices: [] — the API reads empty as "ALL vehicles" and
    // the solve would hand the visit to someone else while the commit keeps
    // the original person (phase-review finding 2). Assembly skips these
    // rows; this is the belt.
    if (allowed !== null && allowed.length === 0) continue;
    shipments.push({
      label: queueLabel(item),
      penaltyCost: QUEUE_PENALTY,
      ...(allowed ? { allowedVehicleIndices: allowed } : {}),
      deliveries: [
        {
          ...(item.coords
            ? { arrivalLocation: { latitude: item.coords.lat, longitude: item.coords.lng } }
            : {}),
          duration: seconds(item.durationMin),
          timeWindows,
        },
      ],
    });
  }
  for (const v of inputs.context) {
    const idx = vehicleIndexByLabel.get(vehicleLabel(v.technicianRef, v.date));
    // A context visit on a non-vehicle day (booked onto a day off / outside
    // the pattern) has no vehicle to pin to — omit it; its tech's capacity
    // line already counts it, and bookings only ever warn about such days.
    if (idx === undefined) continue;
    shipments.push({
      label: contextLabel(v.assignmentId),
      penaltyCost: CONTEXT_PENALTY, // NEVER mandatory — see header
      allowedVehicleIndices: [idx],
      deliveries: [
        {
          ...(v.coords
            ? { arrivalLocation: { latitude: v.coords.lat, longitude: v.coords.lng } }
            : {}),
          duration: seconds(spanMinutes(v.startISO, v.endISO)),
          timeWindows: [{ startTime: rfcFromISO(v.startISO), endTime: rfcFromISO(v.startISO) }],
        },
      ],
    });
  }

  return {
    model: {
      globalStartTime: `${inputs.horizonFrom}T00:00:00Z`,
      globalEndTime: `${addDaysISO(inputs.horizonTo, 1)}T00:00:00Z`,
      vehicles,
      shipments,
    },
  };
}

// ---------------------------------------------------------------------------
// Solve + response parsing

interface RoiVisit {
  shipmentLabel?: string;
  startTime?: string;
}
interface RoiRoute {
  vehicleLabel?: string;
  visits?: RoiVisit[];
}
interface RoiResponse {
  routes?: RoiRoute[];
  skippedShipments?: { label?: string }[];
}

export async function solveFreeze(
  inputs: FreezeInputs,
  deps: { transport?: RoiTransport; mintToken?: MintRoiToken } = {},
): Promise<FreezePlan> {
  const capacity = inputs.capacity.map((c) => ({ ...c }));
  const finish = (placements: FreezePlacement[], skipped: FreezeSkip[]): FreezePlan => ({
    horizonFrom: inputs.horizonFrom,
    horizonTo: inputs.horizonTo,
    placements,
    skipped,
    capacity,
  });

  // Nothing to place, or nobody to place onto — no API call, an honest plan.
  if (inputs.queue.length === 0) return finish([], inputs.skipped);
  if (inputs.vehicles.length === 0) {
    return finish(
      [],
      [
        ...inputs.skipped,
        ...inputs.queue.map((item) => ({
          ref: item.assignmentId ?? `job:${item.jobId}`,
          label: skipLabel(item.customer, item.jobTitle),
          reason: 'nobody has a working pattern in this horizon — set_availability, then rerun',
        })),
      ],
    );
  }

  const response = (await optimizeTours(buildFreezeModel(inputs), deps)) as RoiResponse;

  const itemByLabel = new Map(inputs.queue.map((item) => [queueLabel(item), item]));
  const placements: FreezePlacement[] = [];
  const skipped = [...inputs.skipped];
  const placedLabels = new Set<string>();

  for (const route of response.routes ?? []) {
    const vLabel = route.vehicleLabel;
    if (!vLabel?.startsWith('veh|')) continue;
    const technicianRef = vLabel.split('|')[1];
    for (const visit of route.visits ?? []) {
      const label = visit.shipmentLabel;
      if (!label?.startsWith('q|')) continue; // context visits are NEVER committed
      const item = itemByLabel.get(label);
      if (!item || !visit.startTime) continue;
      placedLabels.add(label);
      // Exact-times rows keep their OWN stored times verbatim (the solver
      // only chose WHO); windowed rows take the solver's arrival.
      const startTime = item.exactStart
        ? item.exactStart.slice(11, 16)
        : visit.startTime.slice(11, 16);
      const placementDate = item.exactStart ? item.exactStart.slice(0, 10) : visit.startTime.slice(0, 10);
      const endMin = Math.min(toMin(startTime) + item.durationMin, 23 * 60 + 59);
      placements.push({
        kind: item.kind,
        jobId: item.jobId,
        assignmentId: item.assignmentId,
        customer: item.customer,
        jobTitle: item.jobTitle,
        technicianRef,
        date: placementDate,
        startTime,
        endTime: item.exactEnd ? item.exactEnd.slice(11, 16) : toHHMM(endMin),
      });
      const cap = capacity.find((c) => c.technicianRef === technicianRef);
      if (cap) cap.committedMin += item.durationMin;
    }
  }

  // Solver-side skips: queue shipments the solve left unperformed. Belt: any
  // queue item missing from BOTH routes and skippedShipments is still
  // reported (a silent drop must never read as "covered").
  const skippedLabels = new Set(
    (response.skippedShipments ?? []).map((s) => s.label).filter((l): l is string => !!l),
  );
  for (const item of inputs.queue) {
    const label = queueLabel(item);
    if (placedLabels.has(label)) continue;
    skipped.push({
      ref: item.assignmentId ?? `job:${item.jobId}`,
      label: skipLabel(item.customer, item.jobTitle),
      reason: skippedLabels.has(label)
        ? 'no room in this window — every fitting day is full (or the visit clashes with existing bookings)'
        : 'the solver returned no slot for this visit — rerun the freeze; if it persists, place it by hand',
    });
  }
  // A skipped CONTEXT shipment = an existing booking the solver could not
  // seat inside the pattern (booked on a warning). Surface as a capacity
  // note, never a commit change — the visit is untouched either way.
  for (const label of skippedLabels) {
    if (!label.startsWith('ctx|')) continue;
    const assignmentId = label.slice(4);
    const v = inputs.context.find((c) => c.assignmentId === assignmentId);
    if (!v) continue;
    skipped.push({
      ref: assignmentId,
      label: `${v.technicianRef} ${v.date} ${v.startISO.slice(11, 16)}`,
      reason:
        "an EXISTING booking sits outside this person's working pattern — kept as booked (the freeze never moves placed visits); it still counts toward their day",
    });
  }

  return finish(placements, skipped);
}
