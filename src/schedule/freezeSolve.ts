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
  isPlaced,
  listAssignmentsForTenant,
  listJobsWithCustomerByIds,
  listTeam,
  listTimeOffForTechnician,
  listUnassignedAssignmentsWithRefs,
  listUnplacedAssignedForRange,
  listUnscheduledOpenJobsWithCustomer,
  type PromiseLevel,
  type WeeklyPattern,
} from '../db/index.js';
import { addDaysISO, dayWindows, toMin } from './fit.js';
import { ensureCoordsById, type CustomerCoords, type GeocodeTransport, type LatLng } from '../routes/geocode.js';
import { optimizeTours, type MintRoiToken, type RoiTransport } from '../routes/roiClient.js';
import { addMinutesClamped, spanMinutes } from './booking.js';

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
  // Movability inputs (re-solve): the freeze ignores these — every context
  // visit is a statue there. The assembler always fills them from the row +
  // its job embed, so a re-solve can grade each visit's freedom without a
  // second read.
  locked: boolean;
  promiseLevel: PromiseLevel;
  promisedDay: string | null;
  jobId: string;
  customer: string | null;
  jobTitle: string | null;
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

// The one label composer for skip lines — freezeCommit shares it so a
// commit-time skip reads exactly like a solve-time one.
export const skipLabel = (customer: string | null, title: string | null): string =>
  [customer, title].filter(Boolean).join(' — ') || 'unnamed';

const LADDER_REMEDY =
  "no length set — ask how long it takes and record it (update_job durationMinutes), then run the freeze again";

// Exported as a CONSTANT (final-review finding): run_freeze's pin-cleanup
// line counts pinned skips — matching this exact string, never a substring
// grep over prose that a copy tweak would silently break.
export const PINNED_SKIP_REASON =
  'pinned by a manager — the freeze never touches pinned visits';

const coordSkipReason = (c: CustomerCoords & { ok: false }): string =>
  c.reason === 'no_address'
    ? 'customer has no usable street address on file'
    : "customer's address couldn't be located on the map — check/correct it";

export async function assembleFreezeInputs(
  tenantId: string,
  horizonFrom: string,
  horizonTo: string,
  // Firm-local wall clock HH:MM (the find_slots nowHHMM precedent): day-0
  // vehicle windows are trimmed to it so a 3 PM freeze can never propose —
  // and then BOOK — this morning's already-past hours (final-review finding;
  // bookVisit has no past-time guard, only the board does). '00:00' default
  // keeps hand-built test fixtures whole-day.
  nowHHMM = '00:00',
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
  // Independent per tech — one parallel batch (final-review efficiency).
  const timeOffByTech = await Promise.all(
    patternTechs.map((t) => listTimeOffForTechnician(t.id, horizonFrom, horizonTo)),
  );
  patternTechs.forEach((t, ti) => {
    const offDates = new Set<string>();
    for (const r of timeOffByTech[ti]) {
      for (let d = r.starts_on; d <= r.ends_on; d = addDaysISO(d, 1)) offDates.add(d);
    }
    for (let date = horizonFrom; date <= horizonTo; date = addDaysISO(date, 1)) {
      if (offDates.has(date)) continue;
      let windows = normalizeWindows(dayWindows(t.availability as WeeklyPattern, date));
      // Day-0 "now" clamp (the freeGaps notBefore precedent): the run day's
      // already-past hours are not capacity, and without this trim the
      // solver proposes — and bookVisit, which has no past-time guard,
      // BOOKS — this morning's slots on an afternoon run (final-review).
      if (date === horizonFrom && nowHHMM !== '00:00') {
        windows = windows
          .filter(([, e]) => e > nowHHMM)
          .map(([s, e]): [string, string] => [s >= nowHHMM ? s : nowHHMM, e]);
      }
      if (windows.length === 0) continue;
      vehicles.push({ technicianRef: t.ref, technicianName: t.display_name, date, windows });
      // toMin('24:00') is 1440, so plain end−start sums whole-day windows.
      const minutes = windows.reduce((sum, [s, e]) => sum + toMin(e) - toMin(s), 0);
      availableByRef.set(t.ref, (availableByRef.get(t.ref) ?? 0) + minutes);
    }
  });
  // Refs that actually got at least one working day — an attached queue row
  // whose person has NO vehicle days must be skipped, not serialized as an
  // empty allowedVehicleIndices (which the API reads as "ALL vehicles";
  // phase-review finding 2).
  const vehicleRefs = new Set(vehicles.map((v) => v.technicianRef));

  // -- Context read + the three queues: independent, one parallel batch.
  // Context = placed confirmed visits of vehicle-having techs in the horizon
  // (the tenant-wide read includes person-less rows — those are QUEUE, picked
  // up via the bucket reader). Queue 2 reads from EPOCH (the tray's idiom):
  // a person-less visit whose day already slipped past must surface as a
  // SKIP, never vanish — the today-lower-bounded read silently dropped it
  // (final-review finding; "a silent drop must never read as covered").
  const techById = new Map(team.map((t) => [t.id, t]));
  const [allPlaced, jobsQueue, personLess, assignedUnplaced] = await Promise.all([
    listAssignmentsForTenant(
      tenantId,
      `${horizonFrom}T00:00:00.000Z`,
      `${addDaysISO(horizonTo, 1)}T00:00:00.000Z`,
      ['confirmed'],
    ),
    listUnscheduledOpenJobsWithCustomer(tenantId),
    listUnassignedAssignmentsWithRefs(tenantId, '1970-01-01T00:00:00.000Z'),
    listUnplacedAssignedForRange(tenantId, horizonFrom, horizonTo),
  ]);
  const placedRows = allPlaced.filter((r) => r.technician_id !== null);
  const contextRows = placedRows.filter((r) => {
    const t = techById.get(r.technician_id as string);
    return t !== undefined && patternRefs.has(t.ref);
  });

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

  const contextJobById = new Map(contextJobs.map((j) => [j.id, j]));
  const context: FreezeContextVisit[] = contextRows.map((r) => {
    const t = techById.get(r.technician_id as string);
    const c = coordsFor(customerIdByJob.get(r.job_id));
    const job = contextJobById.get(r.job_id);
    return {
      assignmentId: r.id,
      technicianRef: (t as { ref: string }).ref,
      date: r.starts_at.slice(0, 10),
      startISO: r.starts_at,
      endISO: r.ends_at,
      coords: c.ok ? c.coords : null,
      locked: r.locked,
      promiseLevel: r.promise_level,
      promisedDay: r.promised_day,
      jobId: r.job_id,
      customer: job?.customers?.name ?? null, // reader is tenant-scoped already
      jobTitle: job?.title ?? null,
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
      skipped.push({ ref: r.id, label, reason: PINNED_SKIP_REASON });
      continue;
    }
    if (isPlaced(r)) {
      const day = r.starts_at.slice(0, 10);
      if (day > horizonTo) {
        skipped.push({ ref: r.id, label, reason: `beyond this freeze's horizon (${day}) — still needs a person` });
        continue;
      }
      // Missed work, not history: say so instead of silently omitting it.
      if (day < horizonFrom) {
        skipped.push({
          ref: r.id,
          label,
          reason: `its date (${day}) already passed with nobody attached — rebook it, or fix it in chat`,
        });
        continue;
      }
      if (day === horizonFrom && r.starts_at.slice(11, 16) < nowHHMM) {
        skipped.push({
          ref: r.id,
          label,
          reason: 'its time today has already passed with nobody attached — move it, or handle it in chat',
        });
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
    // The embed carries duration_minutes since the final review (was an N+1
    // getJob per row); `== null` matches queue 3's guard verbatim.
    if (job?.duration_minutes == null) {
      skipped.push({ ref: r.id, label, reason: LADDER_REMEDY });
      continue;
    }
    const c = coordsFor(job.customer_id);
    if (!c.ok) {
      skipped.push({ ref: r.id, label, reason: coordSkipReason(c) });
      continue;
    }
    queue.push({
      kind: 'unplaced_visit',
      jobId: r.job_id,
      assignmentId: r.id,
      customer,
      jobTitle: job.title,
      technicianRef: null,
      durationMin: job.duration_minutes,
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
      skipped.push({ ref: r.id, label, reason: PINNED_SKIP_REASON });
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
    // End bound is INSIDE the last fence day (23:59:59): the arrival bound is
    // inclusive, so a midnight-after end would legalize arrival at 00:00 of
    // the day AFTER the fence — real for a night-shift pattern starting
    // 00:00 (final-review finding).
    const timeWindows = item.exactStart
      ? [{ startTime: rfcFromISO(item.exactStart), endTime: rfcFromISO(item.exactStart) }]
      : [
          {
            startTime: `${item.windowFrom}T00:00:00Z`,
            endTime: `${item.windowTo}T23:59:59Z`,
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

// ---------------------------------------------------------------------------
// Shared route-response mechanics (freeze + re-solve) — ONE home, so the two
// verbs can never drift on parse semantics (labels, the exact-times rule, the
// skip belts, the ctx| capacity notes).

// Belt over hand-built inputs (assembly already skips these): an attached
// item whose person has no vehicle days must not reach the model — and its
// skip must carry the REAL reason, not the transient-looking solver fallback.
function filterOrphans(
  queue: FreezeQueueItem[],
  vehicles: FreezeVehicle[],
): { queue: FreezeQueueItem[]; orphanSkips: FreezeSkip[] } {
  const vehicleRefs = new Set(vehicles.map((v) => v.technicianRef));
  const orphaned = queue.filter(
    (i) => i.technicianRef !== null && !vehicleRefs.has(i.technicianRef),
  );
  return {
    queue: queue.filter((i) => !orphaned.includes(i)),
    orphanSkips: orphaned.map((item) => ({
      ref: item.assignmentId ?? `job:${item.jobId}`,
      label: skipLabel(item.customer, item.jobTitle),
      reason:
        'assigned to someone with no working days in this horizon — move it, or rerun a later week',
    })),
  };
}

interface WalkedRoutes {
  placements: FreezePlacement[];
  placedLabels: Set<string>;
  skippedLabels: Set<string>;
  // Route visits that are NOT queue shipments (ctx| for the freeze, mv| for
  // the re-solve) — the caller decides what they mean; the freeze ignores
  // them (context visits are NEVER committed).
  otherVisits: { technicianRef: string; label: string; startTime: string }[];
}

function walkRoutes(
  response: RoiResponse,
  queue: FreezeQueueItem[],
  capacity: FreezeCapacity[],
): WalkedRoutes {
  const itemByLabel = new Map(queue.map((item) => [queueLabel(item), item]));
  const placements: FreezePlacement[] = [];
  const placedLabels = new Set<string>();
  const otherVisits: WalkedRoutes['otherVisits'] = [];
  for (const route of response.routes ?? []) {
    const vLabel = route.vehicleLabel;
    if (!vLabel?.startsWith('veh|')) continue;
    const technicianRef = vLabel.split('|')[1];
    for (const visit of route.visits ?? []) {
      const label = visit.shipmentLabel;
      if (!label || !visit.startTime) continue;
      if (!label.startsWith('q|')) {
        otherVisits.push({ technicianRef, label, startTime: visit.startTime });
        continue;
      }
      const item = itemByLabel.get(label);
      if (!item) continue;
      placedLabels.add(label);
      // Exact-times rows keep their OWN stored times verbatim (the solver
      // only chose WHO); windowed rows take the solver's arrival.
      const startTime = item.exactStart
        ? item.exactStart.slice(11, 16)
        : visit.startTime.slice(11, 16);
      const placementDate = item.exactStart ? item.exactStart.slice(0, 10) : visit.startTime.slice(0, 10);
      placements.push({
        kind: item.kind,
        jobId: item.jobId,
        assignmentId: item.assignmentId,
        customer: item.customer,
        jobTitle: item.jobTitle,
        technicianRef,
        date: placementDate,
        startTime,
        // THE booking-layer clamp (23:59 same-day) — never a local copy.
        endTime: item.exactEnd
          ? item.exactEnd.slice(11, 16)
          : addMinutesClamped(startTime, item.durationMin),
      });
      const cap = capacity.find((c) => c.technicianRef === technicianRef);
      if (cap) cap.committedMin += item.durationMin;
    }
  }
  const skippedLabels = new Set(
    (response.skippedShipments ?? []).map((s) => s.label).filter((l): l is string => !!l),
  );
  return { placements, placedLabels, skippedLabels, otherVisits };
}

// Solver-side skips: queue shipments the solve left unperformed. Belt: any
// queue item missing from BOTH routes and skippedShipments is still reported
// (a silent drop must never read as "covered").
function queueSkips(
  queue: FreezeQueueItem[],
  placedLabels: Set<string>,
  skippedLabels: Set<string>,
  rerunHint: string,
): FreezeSkip[] {
  const out: FreezeSkip[] = [];
  for (const item of queue) {
    const label = queueLabel(item);
    if (placedLabels.has(label)) continue;
    out.push({
      ref: item.assignmentId ?? `job:${item.jobId}`,
      label: skipLabel(item.customer, item.jobTitle),
      reason: skippedLabels.has(label)
        ? 'no room in this window — every fitting day is full (or the visit clashes with existing bookings)'
        : `the solver returned no slot for this visit — ${rerunHint}`,
    });
  }
  return out;
}

// A skipped CONTEXT shipment = an existing booking the solver could not seat
// inside the pattern (booked on a warning). Surface as a capacity note, never
// a commit change — the visit is untouched either way.
function contextSkipNotes(
  skippedLabels: Set<string>,
  context: FreezeContextVisit[],
  keptParenthetical: string,
): FreezeSkip[] {
  const out: FreezeSkip[] = [];
  for (const label of skippedLabels) {
    if (!label.startsWith('ctx|')) continue;
    const assignmentId = label.slice(4);
    const v = context.find((c) => c.assignmentId === assignmentId);
    if (!v) continue;
    out.push({
      ref: assignmentId,
      label: `${v.technicianRef} ${v.date} ${v.startISO.slice(11, 16)}`,
      reason:
        `an EXISTING booking sits outside this person's working pattern — kept as booked ` +
        `(${keptParenthetical}); it still counts toward their day`,
    });
  }
  return out;
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

  const { queue, orphanSkips } = filterOrphans(inputs.queue, inputs.vehicles);

  // Nothing to place, or nobody to place onto — no API call, an honest plan.
  if (queue.length === 0) return finish([], [...inputs.skipped, ...orphanSkips]);
  if (inputs.vehicles.length === 0) {
    return finish(
      [],
      [
        ...inputs.skipped,
        ...orphanSkips,
        ...queue.map((item) => ({
          ref: item.assignmentId ?? `job:${item.jobId}`,
          label: skipLabel(item.customer, item.jobTitle),
          reason: 'nobody has a working pattern in this horizon — set_availability, then rerun',
        })),
      ],
    );
  }

  const response = (await optimizeTours(buildFreezeModel({ ...inputs, queue }), deps)) as RoiResponse;

  const walked = walkRoutes(response, queue, capacity);
  const skipped = [
    ...inputs.skipped,
    ...orphanSkips,
    ...queueSkips(
      queue,
      walked.placedLabels,
      walked.skippedLabels,
      'rerun the freeze; if it persists, place it by hand',
    ),
    ...contextSkipNotes(
      walked.skippedLabels,
      inputs.context,
      'the freeze never moves placed visits',
    ),
  ];

  return finish(walked.placements, skipped);
}

// ---------------------------------------------------------------------------
// Re-solve (plan 2026-07-30): the freeze variant where UNPINNED placed visits
// become movable and the promise ladder grades each visit's freedom. Same
// pipeline shape — assemble (shared), partition, model, one solve, parse.

// Disruption pricing, one home (fixed default, no knob — user decision):
// displacing a visit by one hour costs as much as one hour of driving
// (vehicles carry costPerTraveledHour: 1), so the solver only moves work when
// the route genuinely improves. A day hop costs ~24 — same-day shuffles are
// cheap, day changes need big wins. Changing WHO costs two drive-hours.
export const DISRUPTION_COST_PER_HOUR = 1;
export const TECH_CHANGE_COST = 2;

export interface ResolveScope {
  technicianRef?: string; // only this person's visits may move
  onDate?: string; // only this day's visits may move (YYYY-MM-DD)
}

export interface ResolveMove {
  assignmentId: string;
  jobId: string;
  customer: string | null;
  jobTitle: string | null;
  fromTechnicianRef: string;
  fromDate: string;
  fromStart: string; // HH:MM
  fromEnd: string;
  toTechnicianRef: string;
  toDate: string;
  toStartTime: string;
  toEndTime: string;
}

export interface ResolvePlan extends FreezePlan {
  moves: ResolveMove[];
  keptCount: number; // movable rows the solver left exactly where they were
}

export const movableLabel = (assignmentId: string): string => `mv|${assignmentId}`;

export interface MovablePartition {
  movable: FreezeContextVisit[];
  fixed: FreezeContextVisit[];
  skips: FreezeSkip[]; // coord-less movable candidates — kept, with the reason
}

// Which context visits may move. Statues: pinned (human privilege), promise
// 'time'/'time_only' (pinned-in-time by the ladder; time_only's "same clock,
// any day" needs per-day pinpoint windows — deferred, v1 keeps them fixed),
// out-of-scope rows, and day-0 rows already begun (the now-clamp precedent —
// you cannot move the past). A movable candidate WITHOUT coords stays fixed
// too, with a skip line: a location-less shipment with a wide window would
// float freely at zero travel cost.
export function partitionMovable(
  inputs: FreezeInputs,
  scope: ResolveScope,
  nowHHMM: string,
): MovablePartition {
  const movable: FreezeContextVisit[] = [];
  const fixed: FreezeContextVisit[] = [];
  const skips: FreezeSkip[] = [];
  for (const v of inputs.context) {
    const begun =
      v.date === inputs.horizonFrom && nowHHMM !== '00:00' && v.startISO.slice(11, 16) < nowHHMM;
    const inScope =
      (!scope.technicianRef || v.technicianRef === scope.technicianRef) &&
      (!scope.onDate || v.date === scope.onDate);
    const freeLevel = v.promiseLevel === 'none' || v.promiseLevel === 'day';
    if (v.locked || !freeLevel || !inScope || begun) {
      fixed.push(v);
      continue;
    }
    if (v.coords === null) {
      fixed.push(v);
      skips.push({
        ref: v.assignmentId,
        label: skipLabel(v.customer, v.jobTitle),
        reason:
          "kept as booked — the customer's address couldn't be located on the map, so the solver can't route a move; check/correct it",
      });
      continue;
    }
    movable.push(v);
  }
  return { movable, fixed, skips };
}

// The freeze model + one shipment per movable visit. Hard window = the
// promise-graded freedom; soft window = the CURRENT slot, so displacement is
// priced per hour; costsPerVehicle prices handing the visit to someone else.
export function buildResolveModel(
  inputs: FreezeInputs,
  movable: FreezeContextVisit[],
  nowHHMM = '00:00',
): unknown {
  const movableIds = new Set(movable.map((m) => m.assignmentId));
  const base = buildFreezeModel({
    ...inputs,
    context: inputs.context.filter((c) => !movableIds.has(c.assignmentId)),
  }) as { model: { vehicles: unknown[]; shipments: unknown[] } };

  for (const v of movable) {
    // Hard window per promise level. Day-0 opens at the run's wall clock —
    // the solver must not move a visit INTO this morning's past hours
    // (bookVisit has no past guard; the vehicle windows are clamped, but the
    // arrival window should agree rather than rely on it).
    const promisedDay = v.promiseLevel === 'day' ? (v.promisedDay ?? v.date) : null;
    const from = promisedDay ?? inputs.horizonFrom;
    const to = promisedDay ?? inputs.horizonTo;
    const startHHMM = from === inputs.horizonFrom && nowHHMM !== '00:00' ? nowHHMM : '00:00';
    const hardStart = `${from}T${startHHMM}:00Z`;
    const hardEnd = `${to}T23:59:59Z`; // end-inside rule (see queue windows above)
    const otherVehicleIdx: number[] = [];
    inputs.vehicles.forEach((veh, i) => {
      if (veh.technicianRef !== v.technicianRef) otherVehicleIdx.push(i);
    });
    base.model.shipments.push({
      label: movableLabel(v.assignmentId),
      // Near-mandatory: the solver may not silently UNSCHEDULE an existing
      // visit — a skipped movable row means "kept as booked", never dropped.
      penaltyCost: CONTEXT_PENALTY,
      ...(otherVehicleIdx.length > 0
        ? {
            costsPerVehicle: otherVehicleIdx.map(() => TECH_CHANGE_COST),
            costsPerVehicleIndices: otherVehicleIdx,
          }
        : {}),
      deliveries: [
        {
          arrivalLocation: { latitude: (v.coords as LatLng).lat, longitude: (v.coords as LatLng).lng },
          duration: seconds(spanMinutes(v.startISO, v.endISO)),
          timeWindows: [
            {
              startTime: hardStart,
              endTime: hardEnd,
              softStartTime: rfcFromISO(v.startISO),
              softEndTime: rfcFromISO(v.startISO),
              costPerHourBeforeSoftStartTime: DISRUPTION_COST_PER_HOUR,
              costPerHourAfterSoftEndTime: DISRUPTION_COST_PER_HOUR,
            },
          ],
        },
      ],
    });
  }
  return base;
}

export async function solveResolve(
  inputs: FreezeInputs,
  scope: ResolveScope,
  nowHHMM: string,
  deps: { transport?: RoiTransport; mintToken?: MintRoiToken } = {},
): Promise<ResolvePlan> {
  const { movable, skips: partitionSkips } = partitionMovable(inputs, scope, nowHHMM);
  const capacity = inputs.capacity.map((c) => ({ ...c }));
  const finish = (
    placements: FreezePlacement[],
    moves: ResolveMove[],
    keptCount: number,
    skipped: FreezeSkip[],
  ): ResolvePlan => ({
    horizonFrom: inputs.horizonFrom,
    horizonTo: inputs.horizonTo,
    placements,
    moves,
    keptCount,
    skipped,
    capacity,
  });

  // Same orphan belt as the freeze (attached queue rows whose person has no
  // vehicle days), then the same no-API guards — a re-solve with nothing to
  // move OR place must answer honestly without a solver call, and a horizon
  // with zero working days (fleet-wide time off) keeps everything as booked.
  const { queue, orphanSkips } = filterOrphans(inputs.queue, inputs.vehicles);
  const baseSkips = [...inputs.skipped, ...partitionSkips, ...orphanSkips];

  if (queue.length === 0 && movable.length === 0) {
    return finish([], [], 0, baseSkips);
  }
  if (inputs.vehicles.length === 0) {
    return finish(
      [],
      [],
      movable.length, // nothing can move with nobody working — all kept
      [
        ...baseSkips,
        ...queue.map((item) => ({
          ref: item.assignmentId ?? `job:${item.jobId}`,
          label: skipLabel(item.customer, item.jobTitle),
          reason: 'nobody has a working pattern in this horizon — set_availability, then rerun',
        })),
      ],
    );
  }

  const response = (await optimizeTours(
    buildResolveModel({ ...inputs, queue }, movable, nowHHMM),
    deps,
  )) as RoiResponse;

  const walked = walkRoutes(response, queue, capacity);
  const movableByLabel = new Map(movable.map((m) => [movableLabel(m.assignmentId), m]));
  const moves: ResolveMove[] = [];
  const seenMovable = new Set<string>();

  for (const { technicianRef, label, startTime } of walked.otherVisits) {
    if (!label.startsWith('mv|')) continue;
    const m = movableByLabel.get(label);
    if (!m) continue;
    seenMovable.add(label);
    const toDate = startTime.slice(0, 10);
    const toStartTime = startTime.slice(11, 16);
    // Unchanged on every axis = KEPT, not a zero-distance "move".
    if (
      technicianRef === m.technicianRef &&
      toDate === m.date &&
      toStartTime === m.startISO.slice(11, 16)
    ) {
      continue;
    }
    const span = spanMinutes(m.startISO, m.endISO);
    moves.push({
      assignmentId: m.assignmentId,
      jobId: m.jobId,
      customer: m.customer,
      jobTitle: m.jobTitle,
      fromTechnicianRef: m.technicianRef,
      fromDate: m.date,
      fromStart: m.startISO.slice(11, 16),
      fromEnd: m.endISO.slice(11, 16),
      toTechnicianRef: technicianRef,
      toDate,
      toStartTime,
      toEndTime: addMinutesClamped(toStartTime, span),
    });
    // Capacity follows the visit across a technician change (the stage
    // response, note relay, and board Capacity section all display these).
    if (technicianRef !== m.technicianRef) {
      const fromCap = capacity.find((c) => c.technicianRef === m.technicianRef);
      const toCap = capacity.find((c) => c.technicianRef === technicianRef);
      if (fromCap) fromCap.committedMin -= span;
      if (toCap) toCap.committedMin += span;
    }
  }

  const skipped = [
    ...baseSkips,
    ...queueSkips(
      queue,
      walked.placedLabels,
      walked.skippedLabels,
      'rerun the re-solve; if it persists, place it by hand',
    ),
    // The statues that could not be seated (fixed context, e.g. a pinned
    // visit booked outside the pattern) get the same capacity note a freeze
    // reports — resolve ⊇ freeze must not LOSE information.
    ...contextSkipNotes(
      walked.skippedLabels,
      inputs.context,
      'this visit was not movable in this run',
    ),
  ];
  // A movable row the solver skipped OR omitted is KEPT as booked (its
  // penalty is near-infinite, so this is rare) — reported, never dropped.
  for (const m of movable) {
    const label = movableLabel(m.assignmentId);
    if (seenMovable.has(label)) continue;
    skipped.push({
      ref: m.assignmentId,
      label: skipLabel(m.customer, m.jobTitle),
      reason: 'kept as booked — the solver found no better slot for it',
    });
  }
  const keptCount = movable.length - moves.length;

  return finish(walked.placements, moves, keptCount, skipped);
}
