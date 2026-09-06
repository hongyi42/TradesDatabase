import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import type { Job, JobCustomerAddress } from './jobs.js';
import type { Customer } from './customers.js';
import type { Technician } from './technicians.js';

export type Visit = Database['public']['Tables']['visits']['Row'];
export type VisitStatus = Database['public']['Enums']['visit_status'];

// Rows that HAVE times (plan 4b-2). Every reader whose query filters on
// starts_at/ends_at returns these by construction: a SQL comparison against
// NULL is never true, so unplaced rows cannot appear in a time-range result.
// A type, not a comment, so the property is compiler-checked.
export type PlacedVisit = Visit & { starts_at: string; ends_at: string };
export const isPlaced = (a: Visit): a is PlacedVisit =>
  a.starts_at !== null && a.ends_at !== null;

// Hardcoded, auditable state machine (jobs.ts pattern). Rung 9b: a move now
// EDITS the row (see moveVisitRow), so times are mutable too — but status is
// still the only field with a legal graph, and cancelled/completed are terminal.
export const VISIT_TRANSITIONS: Record<VisitStatus, VisitStatus[]> = {
  proposed: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  cancelled: [],
  completed: [],
};

export interface CreateVisitInput {
  tenantId: string;
  jobId: string;
  technicianId: string | null; // null = unassigned ("book now, assign later")
  // A visit HAS A TIME OR IT DOES NOT (rung 9a). Both timestamps together, or
  // both null for an untimed visit — the stored date range is gone, so there is
  // no third shape to police.
  startsAt: string | null; // ISO timestamptz (naive-local convention)
  endsAt: string | null; // ISO timestamptz, exclusive
  status?: VisitStatus;
  sourceCaptureId?: string | null;
  // The happened-stage fields, absorbed from the old per-note `visits` table
  // (rung 9b). A trip reported without ever being scheduled is born
  // status:'completed' with completedAt set and no times — that is the whole
  // "walk-in / emergency" shape, and it needs no separate table.
  // NAIVE-LOCAL, like startsAt/endsAt: firm wall clock stamped as if UTC.
  completedAt?: string | null;
  laborHours?: number | null;
  attributes?: Json; // L3
}

// Insert one visit row. Inserting as 'confirmed' can raise the DB's
// no_confirmed_overlap exclusion constraint — preserve the SQLSTATE so callers
// can detect it via isOverlapViolation (Object.assign idiom, insertTechnician).
export async function createVisit(input: CreateVisitInput): Promise<Visit> {
  // Both times or neither. A half-timed row would read as placed to some
  // surfaces and untimed to others; catch it here rather than letting the DB
  // return a raw 23514. (The old XOR guard also required a date range on an
  // untimed row — rung 9a deleted the range, and its CHECK with it.)
  if ((input.startsAt === null) !== (input.endsAt === null)) {
    throw new Error(
      'createVisit: provide BOTH times, or neither (an untimed visit) — never one',
    );
  }
  const { data, error } = await getClient()
    .from('visits')
    .insert({
      tenant_id: input.tenantId,
      job_id: input.jobId,
      technician_id: input.technicianId,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      status: input.status ?? 'proposed',
      source_capture_id: input.sourceCaptureId ?? null,
      completed_at: input.completedAt ?? null,
      labor_hours: input.laborHours ?? null,
      attributes: input.attributes ?? {},
    })
    .select()
    .single();
  if (error) {
    throw Object.assign(new Error(`createVisit failed: ${error.message}`), {
      code: error.code,
    });
  }
  if (!data) throw new Error('createVisit failed: no row returned');
  return data;
}

async function getVisit(id: string): Promise<Visit | null> {
  const { data, error } = await getClient()
    .from('visits')
    .select()
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getVisit failed: ${error.message}`);
  return data;
}

// Walk one legal transition. Guarded on the status we validated against
// (jobs.ts concurrency idiom): a concurrent flip between our read and this
// update matches no row and surfaces instead of being silently overwritten.
// `reason` is stored when cancelling (why the booking was undone). Confirming
// can raise the exclusion constraint → SQLSTATE preserved for isOverlapViolation.
export async function updateVisitStatus(
  id: string,
  next: VisitStatus,
  reason?: string | null,
  // Naive-local, like every other time on this row. Optional on purpose: the
  // caller that COMPLETES a visit often knows only that it finished (the
  // cancel_job cascade, the status walk) — a note is what usually knows when.
  completedAt?: string | null,
): Promise<Visit> {
  const current = await getVisit(id);
  if (!current) throw new Error(`updateVisitStatus: visit ${id} not found`);
  const allowed = VISIT_TRANSITIONS[current.status];
  if (!allowed.includes(next)) {
    throw new Error(
      `Illegal visit status transition: ${current.status} → ${next} ` +
        `(allowed: ${allowed.join(', ') || 'none'})`,
    );
  }
  const { data, error } = await getClient()
    .from('visits')
    .update({
      status: next,
      ...(next === 'cancelled' && reason != null ? { reason } : {}),
      ...(next === 'completed' && completedAt != null ? { completed_at: completedAt } : {}),
    }) // updated_at is stamped by the DB trigger
    .eq('id', id)
    .eq('status', current.status)
    .select()
    .maybeSingle();
  if (error) {
    throw Object.assign(new Error(`updateVisitStatus failed: ${error.message}`), {
      code: error.code,
    });
  }
  if (!data) {
    throw new Error(
      `updateVisitStatus: visit ${id} changed concurrently (was '${current.status}'); transition not applied`,
    );
  }
  return data;
}

// SQLSTATE 23P01 = exclusion_violation — the no_confirmed_overlap guard fired.
export function isOverlapViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === '23P01'
  );
}

export interface MoveVisitRowInput {
  startsAt: string;
  endsAt: string;
  technicianId?: string | null; // omit = same technician; null = DETACH (park unassigned)
  reason: string; // why the visit moved (kept on the row)
  status?: VisitStatus; // omit = leave it where it is
}

// THE MOVE PRIMITIVE — ONE UPDATE, and the visit keeps its id (rung 9b).
//
// It used to be cancel-the-old-row + insert-a-new-one, which meant a visit's id
// changed every time anybody touched it. That cost three things this replaces:
//   * a visit could not be named across a move, so nothing could point at one —
//     a gap, a note, a manager's link all went stale the moment it slid an hour;
//   * the two statements were not atomic, so a failure between them left the
//     visit CANCELLED WITH NO SUCCESSOR — stranded, invisible to every reader,
//     and the caller had to apologise for it;
//   * `created_at` had to be hand-carried onto the successor or the unscheduled
//     queue's oldest-first order silently became least-recently-touched.
// An UPDATE has none of those. It is atomic by construction: if the exclusion
// constraint fires (23P01), NOTHING changed and the visit still sits where it
// was, so the caller can say "that slot is taken" instead of "it is gone".
//
// Guarded on the status we read (the jobs.ts concurrency idiom): a concurrent
// CANCEL between our read and this write matches no row and surfaces. Two
// racing MOVES both see 'confirmed', so the later one wins and both append a
// `moved` event — accepted, and narrower than it sounds: the schedule has one
// manager, the DB guard still forbids double-booking a person, and the ledger
// records both attempts in order. (The old cancel-then-insert made the second
// fail on an illegal cancelled → cancelled edge, which read as a crash rather
// than a last-write-wins.)
export async function moveVisitRow(id: string, input: MoveVisitRowInput): Promise<Visit> {
  // Validate BEFORE touching anything. Nothing is destroyed on a bad input now,
  // but a swapped range would still be written, and the DB's own check would
  // reject it with a raw 23514 the caller cannot explain.
  const startMs = Date.parse(input.startsAt);
  const endMs = Date.parse(input.endsAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
    throw new Error(
      `moveVisitRow: invalid time range ${input.startsAt} – ${input.endsAt} (nothing changed)`,
    );
  }
  const old = await getVisit(id);
  if (!old) throw new Error(`moveVisitRow: visit ${id} not found`);
  // Terminal rows are not movable. The old cancel-then-insert primitive got
  // this for free — its first step was a status transition, and cancelled →
  // cancelled is not a legal edge — so an UPDATE has to say it out loud, or
  // "move it" would quietly re-time a visit that was called off or already
  // done. The booking layer checks too (resolveMove); this is the floor.
  if (old.status === 'cancelled' || old.status === 'completed') {
    throw new Error(`cannot move a ${old.status} visit`);
  }
  const { data, error } = await getClient()
    .from('visits')
    .update({
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      // `!== undefined`, not `??`: an explicit null means DETACH, and `??`
      // would silently resurrect the old technician (plan 4a.5).
      ...(input.technicianId !== undefined ? { technician_id: input.technicianId } : {}),
      reason: input.reason,
      ...(input.status ? { status: input.status } : {}),
    }) // updated_at is stamped by the DB trigger
    .eq('id', id)
    .eq('status', old.status)
    .select()
    .maybeSingle();
  if (error) {
    throw Object.assign(new Error(`moveVisitRow failed: ${error.message}`), { code: error.code });
  }
  if (!data) {
    throw new Error(
      `moveVisitRow: visit ${id} changed concurrently (was '${old.status}'); move not applied`,
    );
  }
  return data;
}

// Attach or detach the PERSON on a visit, leaving its times alone — the tray's
// drag-to-assign and its reverse. A sibling of moveVisitRow rather than a
// special case of it: an attach has no new time to validate, and folding the
// two would mean inventing times for an untimed visit just to move nobody.
//
// `status` is passed explicitly for the reason the old cancel-then-insert path
// had to: the successor it created was always 'confirmed', and an attach that
// silently left a row 'proposed' would vanish from every ['confirmed']-filtered
// reader — on the board, in the tray, and in the overlap guard (review finding).
export async function attachVisitTechnician(
  id: string,
  input: { technicianId: string | null; reason: string; status?: VisitStatus },
): Promise<Visit> {
  const old = await getVisit(id);
  if (!old) throw new Error(`attachVisitTechnician: visit ${id} not found`);
  if (old.status === 'cancelled' || old.status === 'completed') {
    throw new Error(`cannot attach a person to a ${old.status} visit`);
  }
  const { data, error } = await getClient()
    .from('visits')
    .update({
      technician_id: input.technicianId,
      reason: input.reason,
      ...(input.status ? { status: input.status } : {}),
    })
    .eq('id', id)
    .eq('status', old.status) // the jobs.ts CAS: a concurrent flip surfaces
    .select()
    .maybeSingle();
  if (error) {
    throw Object.assign(new Error(`attachVisitTechnician failed: ${error.message}`), {
      code: error.code,
    });
  }
  if (!data) {
    throw new Error(
      `attachVisitTechnician: visit ${id} changed concurrently (was '${old.status}'); not applied`,
    );
  }
  return data;
}

// The lifecycle as ONE WORD, mirroring the `stage` case in v_schedule
// (20260906140000). A db test pins the two equal for the four stages the view
// can show — if they drift, the agent's SQL and the app's objects would
// disagree about what a visit IS.
//
// 'cancelled' is the one value SQL never returns: v_schedule is confirmed +
// completed by construction, and a cancelled visit lives in v_cancelled_visits.
// It exists here because an app-side caller holds the row itself and needs a
// total function over it.
export type VisitStage = 'committed' | 'placed' | 'happened' | 'reported' | 'cancelled';

export function stageOf(v: Visit, hasNotes: boolean): VisitStage {
  if (v.status === 'cancelled') return 'cancelled';
  if (v.status === 'completed') return hasNotes ? 'reported' : 'happened';
  return v.starts_at === null ? 'committed' : 'placed';
}

// Tenant-guarded point read for tool/module surfaces: a cross-tenant or
// unknown id reads as null (the caller decides how to surface it).
export async function getVisitForTenant(
  id: string,
  tenantId: string,
): Promise<Visit | null> {
  const { data, error } = await getClient()
    .from('visits')
    .select()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`getVisitForTenant failed: ${error.message}`);
  return data;
}

// Batch point-read, tenant-guarded, ANY status — undo planning reads live
// rows AND their cancelled predecessors in one query instead of N serial
// getVisitForTenant round-trips (the listCustomersByIds precedent).
// Unknown/cross-tenant ids simply don't come back; callers treat a miss
// exactly like getVisitForTenant's null.
//
// CHUNKED + PAGED (build-5 final review): the planner's moot-fact read passes
// every open gap's subject_ref, and the open set is unbounded by design now —
// an unchunked .in() 400s past a few thousand ids and PostgREST's 1000-row
// cap silently truncates the result either way. The jobs-reader idiom.
export async function listVisitsByIds(
  tenantId: string,
  ids: string[],
): Promise<Visit[]> {
  if (ids.length === 0) return [];
  const CHUNK = 200;
  const PAGE = 1000;
  const out: Visit[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('visits')
        .select()
        .eq('tenant_id', tenantId)
        .in('id', slice)
        .order('id', { ascending: true }) // deterministic paging tiebreak
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listVisitsByIds failed: ${error.message}`);
      out.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
  }
  return out;
}

// Rows overlapping the [fromISO, toISO) window for the WHOLE tenant — the
// team-schedule / dispatch-board read. Confirmed only by default: the board
// shows the real schedule, not alternative proposals.
export async function listVisitsForTenant(
  tenantId: string,
  fromISO: string,
  toISO: string,
  statuses: VisitStatus[] = ['confirmed'],
): Promise<PlacedVisit[]> {
  const { data, error } = await getClient()
    .from('visits')
    .select()
    .eq('tenant_id', tenantId)
    .lt('starts_at', toISO)
    .gt('ends_at', fromISO)
    .in('status', statuses)
    .order('starts_at', { ascending: true });
  if (error) throw new Error(`listVisitsForTenant failed: ${error.message}`);
  // Placed by construction: the lt/gt time filters never match NULL.
  return (data ?? []) as PlacedVisit[];
}

// ---- Dispatch-board reads: the whole visit graph in ONE round-trip ----
//
// The board needs each visit WITH its customer (name/address/contact) and its
// technician (ref + display name). Fetching those as separate point reads costs
// one network round-trip PER TABLE PER BUTTON — the N+1 that made every board
// tap ~1s (DB execution is sub-millisecond; the cost is transit). PostgREST
// resolves the whole graph in a single request via the declared foreign keys
// (visits→jobs, jobs→customers, visits→technicians), each of which is
// unambiguous, so no !hint disambiguation is needed.
//
// SECURITY — the foreign keys are ID-ONLY: not one of them carries tenant_id, so
// an embed rooted at a tenant-filtered visit does NOT guarantee the nested
// job/customer/technician belong to that same tenant. Every nested projection
// therefore ships its own tenant_id and the CALLER must re-check it before
// surfacing the row (see boardRead.ts). Do not drop tenant_id from these
// projections — it is the only thing standing between an embed and a
// cross-tenant leak.

export type VisitDetailRow = Visit & {
  jobs:
    | (Pick<Job, 'id' | 'tenant_id' | 'title' | 'priority' | 'duration_minutes' | 'customer_id'> & {
        customers: Pick<
          Customer,
          | 'name'
          | 'phone'
          | 'email'
          | 'address_line1'
          | 'address_line2'
          | 'city'
          | 'state'
          | 'postal_code'
          // L3 standing facts — the detail sheet's customer-notes section
          // (plan 4a.5). Detail is a tap path, not the board-load path, so
          // the JSONB rides only here, never on the day/bucket selects.
          | 'attributes'
          | 'tenant_id'
        > | null;
      })
    | null;
  technicians: Pick<Technician, 'id' | 'ref' | 'display_name' | 'tenant_id'> | null;
};

// NOTE: these select strings must stay SINGLE STRING LITERALS — supabase-js
// parses them at the TYPE level to infer the embedded shape, and a concatenated
// ('a' + 'b') string widens to `string`, which makes the inference collapse to
// GenericStringError and breaks the build.
const DETAIL_SELECT =
  '*, jobs(id,tenant_id,title,priority,duration_minutes,customer_id,customers(name,phone,email,address_line1,address_line2,city,state,postal_code,attributes,tenant_id)), technicians(id,ref,display_name,tenant_id)';

// One visit + its job/customer/technician, tenant-scoped at the ROOT only.
// A cross-tenant or unknown id reads as null (same contract as
// getVisitForTenant); nested tenant checks are the caller's job.
export async function getVisitWithRefsForTenant(
  id: string,
  tenantId: string,
): Promise<VisitDetailRow | null> {
  const { data, error } = await getClient()
    .from('visits')
    .select(DETAIL_SELECT)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`getVisitWithRefsForTenant failed: ${error.message}`);
  return (data ?? null) as VisitDetailRow | null;
}

// Day-view projection: customer NAME + ADDRESS only (mirrors what
// listJobsWithCustomerByIds surfaced), no contact details — the grid never
// shows them. The customer DOES carry tenant_id: the pre-embed code gated the
// customer on its JOB's tenant alone, which trusted the unenforced invariant
// "a job's customer shares the job's tenant" (jobs.customer_id → customers(id)
// is an id-only FK, and createJob takes tenantId/customerId as independent
// arguments). Rows written outside the app — migrations, seeds, restores,
// manual fixes — can violate it, and no app-level validation can catch those.
// So the day view now re-checks the customer directly, matching readVisitDetail.
export type VisitDayRow = Visit & {
  jobs:
    | (Pick<Job, 'id' | 'tenant_id' | 'customer_id'> & {
        customers: (JobCustomerAddress & { tenant_id: string }) | null;
      })
    | null;
  technicians: Pick<Technician, 'id' | 'ref' | 'display_name' | 'tenant_id'> | null;
};

// Single string literal — see the DETAIL_SELECT note above.
const DAY_SELECT =
  '*, jobs(id,tenant_id,customer_id,customers(name,address_line1,address_line2,city,state,postal_code,tenant_id)), technicians(id,ref,display_name,tenant_id)';

// Same filters as listVisitsForTenant, plus the embedded graph.
export type PlacedVisitDayRow = VisitDayRow & { starts_at: string; ends_at: string };

export async function listVisitsWithRefsForTenant(
  tenantId: string,
  fromISO: string,
  toISO: string,
  statuses: VisitStatus[] = ['confirmed'],
): Promise<PlacedVisitDayRow[]> {
  const { data, error } = await getClient()
    .from('visits')
    .select(DAY_SELECT)
    .eq('tenant_id', tenantId)
    .lt('starts_at', toISO)
    .gt('ends_at', fromISO)
    .in('status', statuses)
    .order('starts_at', { ascending: true });
  if (error) throw new Error(`listVisitsWithRefsForTenant failed: ${error.message}`);
  // Placed by construction: the lt/gt time filters never match NULL.
  return (data ?? []) as PlacedVisitDayRow[];
}

// Rows overlapping the [fromISO, toISO) window for one technician, live
// statuses by default (proposed + confirmed — what claims or may claim time).
export async function listVisitsForTechnician(
  technicianId: string,
  fromISO: string,
  toISO: string,
  statuses: VisitStatus[] = ['proposed', 'confirmed'],
): Promise<PlacedVisit[]> {
  const { data, error } = await getClient()
    .from('visits')
    .select()
    .eq('technician_id', technicianId)
    .lt('starts_at', toISO)
    .gt('ends_at', fromISO)
    .in('status', statuses)
    .order('starts_at', { ascending: true });
  if (error) throw new Error(`listVisitsForTechnician failed: ${error.message}`);
  // Placed by construction: the lt/gt time filters never match NULL.
  return (data ?? []) as PlacedVisit[];
}

// The booking's full history — every row ever written for the job, newest
// first (reschedules/cancellations included; history = the rows themselves).
export async function listVisitsForJob(jobId: string): Promise<Visit[]> {
  const { data, error } = await getClient()
    .from('visits')
    .select()
    .eq('job_id', jobId)
    // Newest first. `updated_at` is the tiebreak because rung 9a made
    // `created_at` the VISIT's age rather than the ROW's: a move/park/attach is
    // a cancel-plus-insert that carries the original age onto the successor, so
    // both links of a chain now share a created_at and only updated_at
    // separates them (the cancel UPDATE, then the INSERT).
    .order('created_at', { ascending: false })
    .order('updated_at', { ascending: false });
  if (error) throw new Error(`listVisitsForJob failed: ${error.message}`);
  return data ?? [];
}

// The "assign later" recall surface (and Plan 3's future work queue): every
// upcoming confirmed visit with NOBODY attached. No upper date bound — the
// point is catching visits parked beyond any board window. These rows do NOT
// appear in listUnassignedOpenJobs (their job HAS a live visit) and are
// invisible to every per-technician reader, so this is their only lister.
export async function listUnassignedVisits(
  tenantId: string,
  fromISO: string,
): Promise<Visit[]> {
  // DELIBERATELY WIDE (plan 4b-2): unplaced rows (null starts_at) are part of
  // the recall surface — a parked time-TBD visit must be visible SOMEWHERE the
  // moment it exists. NULLs order last. (PostgREST .or() syntax verified
  // against the local stack during plan review.)
  const { data, error } = await getClient()
    .from('visits')
    .select()
    .eq('tenant_id', tenantId)
    .is('technician_id', null)
    .eq('status', 'confirmed')
    .or(`starts_at.gte.${fromISO},starts_at.is.null`)
    // Timed rows in time order, then untimed OLDEST FIRST (rung 9a) — with no
    // stored range there is no date to sort them by, and age is what stops a
    // hard-to-place visit sinking to the bottom forever.
    .order('starts_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listUnassignedVisits failed: ${error.message}`);
  return data ?? [];
}

// The Stage-0 watcher's candidate read (plan 2026-08-15 feature A): confirmed
// placed rows whose scheduled END falls in [endedFromNaive, endedToNaive),
// oldest end first. Both bounds are FIRM WALL-CLOCK formatted as if UTC (the
// naive-local storage convention — see listUpcomingVisitsForCustomer's
// note below); callers derive BOTH from the same firm-local moment so the
// window stays coherent across a DST edge.
export async function listOverdueConfirmedVisits(
  tenantId: string,
  endedFromNaive: string, // ISO, firm wall-clock as if UTC — inclusive
  endedToNaive: string, // ISO, firm wall-clock as if UTC — exclusive
): Promise<PlacedVisit[]> {
  const { data, error } = await getClient()
    .from('visits')
    .select()
    .eq('tenant_id', tenantId)
    .eq('status', 'confirmed')
    .gte('ends_at', endedFromNaive)
    .lt('ends_at', endedToNaive)
    .order('ends_at', { ascending: true });
  if (error) throw new Error(`listOverdueConfirmedVisits failed: ${error.message}`);
  // Placed by construction: the gte/lt time filters never match NULL.
  return (data ?? []) as PlacedVisit[];
}

// The customer brief's schedule half (date-eval finding, 2026-08-13): the
// context aggregate read only the `visits` table — L2 evidence of PAST work —
// so a customer with four confirmed bookings briefed as "no visits scheduled",
// and the agent told the manager exactly that (eval S06–S08). Scheduling
// windows sitting on unplaced rows were equally invisible (S09–S12). This is
// their lister: every confirmed visit for the customer that is still
// upcoming — placed rows from `todayLocal` forward (day-granular, the
// get_schedule precedent), plus every UNTIMED row, which has no date to have
// passed (rung 9a deleted the stored window).
//
// jobs is an INNER embed used as the customer filter; it carries tenant_id so
// the caller can re-check the unenforced "job shares its customer's tenant"
// invariant (the VisitDayRow precedent above). Top-level rows are
// tenant-scoped directly — the embed never widens the read.
export type CustomerUpcomingRow = Visit & {
  jobs: Pick<Job, 'id' | 'tenant_id' | 'customer_id' | 'title'> | null;
  technicians: Pick<Technician, 'id' | 'ref' | 'display_name' | 'tenant_id'> | null;
};

// Single string literal — see the DETAIL_SELECT note above.
const CUSTOMER_UPCOMING_SELECT =
  '*, jobs!inner(id,tenant_id,customer_id,title), technicians(id,ref,display_name,tenant_id)';

export async function listUpcomingVisitsForCustomer(
  tenantId: string,
  customerId: string,
  todayLocal: string, // YYYY-MM-DD in the firm's timezone
): Promise<CustomerUpcomingRow[]> {
  // todayLocal is server-derived, but it rides inside a PostgREST .or()
  // string — refuse anything that isn't a bare date rather than interpolate it.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayLocal)) {
    throw new Error(`listUpcomingVisitsForCustomer: bad todayLocal ${todayLocal}`);
  }
  const { data, error } = await getClient()
    .from('visits')
    .select(CUSTOMER_UPCOMING_SELECT)
    .eq('tenant_id', tenantId)
    .eq('jobs.customer_id', customerId)
    .eq('status', 'confirmed')
    // Times are stored naive-local (the '+00' is a lie — see startTime in
    // server.ts), so "upcoming" compares against local midnight, not real UTC.
    // A visit with no time set has no day to compare against and no way to go
    // stale (rung 9a deleted the stored range), so every live untimed visit is
    // upcoming. Timed rows first in time order, then untimed oldest-first.
    .or(`starts_at.gte.${todayLocal}T00:00:00.000Z,starts_at.is.null`)
    .order('starts_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listUpcomingVisitsForCustomer failed: ${error.message}`);
  return (data ?? []) as CustomerUpcomingRow[];
}

// Exact-window parked twins for the person-less duplicate guard (plan 4a.5
// final review): ONE embedded query replaces the scan-plus-getJob-per-row
// loops that previously lived as separate copies in resolveBooking and
// resolveMove. jobs is an ID-ONLY foreign key — customer_id is surfaced only
// when the job's tenant re-checks (the boardRead pattern).
// Single string literal — see the DETAIL_SELECT note above.
const IDENTICAL_UNASSIGNED_SELECT = 'id, jobs(customer_id, tenant_id)';

export interface IdenticalUnassignedRow {
  id: string;
  customerId: string | null;
}

export async function listIdenticalUnassignedVisits(
  tenantId: string,
  startISO: string,
  endISO: string,
): Promise<IdenticalUnassignedRow[]> {
  const { data, error } = await getClient()
    .from('visits')
    .select(IDENTICAL_UNASSIGNED_SELECT)
    .eq('tenant_id', tenantId)
    .is('technician_id', null)
    .eq('status', 'confirmed')
    .eq('starts_at', startISO)
    .eq('ends_at', endISO);
  if (error) throw new Error(`listIdenticalUnassignedVisits failed: ${error.message}`);
  return (
    (data ?? []) as Array<{ id: string; jobs: { customer_id: string; tenant_id: string } | null }>
  ).map((row) => ({
    id: row.id,
    customerId: row.jobs && row.jobs.tenant_id === tenantId ? row.jobs.customer_id : null,
  }));
}

// ASSIGNED-and-unplaced rows intersecting a day window (plan 4b-2 Phase 3):
// the board's "no time yet" strip. Confirmed rows with a person attached and
// no times; the range-intersection predicate (earliest <= to AND latest >=
// from) shows a Tue–Thu visit on each covered day. DAY_SELECT shape so the
// strip carries customer/technician names in the same single round trip.
// Single string literal — see the DETAIL_SELECT note above. The strip shows
// what the work IS (title) and how long it takes (4b-1 duration), unlike the
// time-grid day view where the sheet fetches those on tap.
const UNPLACED_STRIP_SELECT =
  '*, jobs(id,tenant_id,title,duration_minutes,customer_id,customers(name,tenant_id)), technicians(id,ref,display_name,tenant_id)';

export type UnplacedStripRow = Visit & {
  jobs:
    | (Pick<Job, 'id' | 'tenant_id' | 'title' | 'duration_minutes' | 'customer_id'> & {
        customers: Pick<Customer, 'name' | 'tenant_id'> | null;
      })
    | null;
  technicians: Pick<Technician, 'id' | 'ref' | 'display_name' | 'tenant_id'> | null;
};

// EVERY untimed row — assigned or not. The reader above deliberately shows only
// person-attached rows (unassigned ones live in the unassignedOnly recall view);
// this one is the complete queue. Same shape so handlers can reuse one row type,
// and the same oldest-first order.
export async function listUnplaced(tenantId: string): Promise<UnplacedStripRow[]> {
  const { data, error } = await getClient()
    .from('visits')
    .select(UNPLACED_STRIP_SELECT)
    .eq('tenant_id', tenantId)
    .eq('status', 'confirmed')
    .is('starts_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listUnplaced failed: ${error.message}`);
  return (data ?? []) as UnplacedStripRow[];
}

// Sibling of the guard above (plan 4b-2): untimed rows are ALSO exempt from the
// DB overlap guard, so a retried one-shot untimed booking would silently
// duplicate without this check. It used to key on the exact date range; rung 9a
// deleted the range, so the key is now the JOB — two untimed visits on one job
// with the same person is a retry, while two untimed visits on DIFFERENT jobs
// for one customer are legitimate (two trades). Keyed on the technician for the
// same final-review reason: a retry carries the same person-or-nobody.
export async function listUntimedVisitsForJob(
  tenantId: string,
  jobId: string,
  technicianId: string | null,
): Promise<IdenticalUnassignedRow[]> {
  let query = getClient()
    .from('visits')
    .select(IDENTICAL_UNASSIGNED_SELECT)
    .eq('tenant_id', tenantId)
    .eq('status', 'confirmed')
    .is('starts_at', null)
    .eq('job_id', jobId);
  query =
    technicianId === null ? query.is('technician_id', null) : query.eq('technician_id', technicianId);
  const { data, error } = await query;
  if (error) throw new Error(`listUntimedVisitsForJob failed: ${error.message}`);
  return (
    (data ?? []) as Array<{ id: string; jobs: { customer_id: string; tenant_id: string } | null }>
  ).map((row) => ({
    id: row.id,
    customerId: row.jobs && row.jobs.tenant_id === tenantId ? row.jobs.customer_id : null,
  }));
}

// ---- Loose-bucket reads (Plan 4a): the tray + agent-parity surfaces ----
//
// Same ID-ONLY-foreign-key caveat as the board reads above: callers must
// re-check every nested row's tenant_id before surfacing its name/title.

// Single string literal — see the DETAIL_SELECT note above. duration_minutes
// rides along (4b-3): the freeze's queue-2 ladder needs the job length, and
// fetching it per row was an N+1 the strip's sibling select never had.
const BUCKET_SELECT =
  '*, jobs(id,tenant_id,title,duration_minutes,customer_id,customers(name,tenant_id))';

export type VisitBucketRow = Visit & {
  jobs:
    | (Pick<Job, 'id' | 'tenant_id' | 'title' | 'duration_minutes' | 'customer_id'> & {
        customers: Pick<Customer, 'name' | 'tenant_id'> | null;
      })
    | null;
};

// listUnassignedVisits with the customer/job names embedded — the tray's
// parked-visits read (one round trip, the board-latency doctrine).
export async function listUnassignedVisitsWithRefs(
  tenantId: string,
  fromISO: string,
): Promise<VisitBucketRow[]> {
  // DELIBERATELY WIDE, on BOTH axes:
  //   * no person attached — the original "assign later" recall surface, and
  //   * NO TIME SET — added by rung 9a, and the reason this reader was widened.
  // An untimed visit WITH a person on it is still unscheduled work: it sits on
  // no day (there is no stored range any more), so the day view cannot show it
  // and the tray is the only place it can appear. Keyed on technician alone,
  // tapping Assign on a tray row made the visit vanish from the whole board
  // with no way back except chat (review finding, rung 9a phase 2).
  const { data, error } = await getClient()
    .from('visits')
    .select(BUCKET_SELECT)
    .eq('tenant_id', tenantId)
    .eq('status', 'confirmed')
    .or(
      `and(technician_id.is.null,or(starts_at.gte.${fromISO},starts_at.is.null)),starts_at.is.null`,
    )
    .order('starts_at', { ascending: true, nullsFirst: false });
  if (error) throw new Error(`listUnassignedVisitsWithRefs failed: ${error.message}`);
  return (data ?? []) as VisitBucketRow[];
}

// Named columns, no '*': jobs carry the elastic L3 `attributes` JSONB, which
// the bucket never uses — and this query feeds an HTTP endpoint hit on every
// board load (final-review efficiency finding). Single string literal — see
// the DETAIL_SELECT note above.
const UNSCHEDULED_JOBS_SELECT =
  'id,tenant_id,customer_id,title,status,priority,duration_minutes,created_at, visits(id,status), customers(name,tenant_id)';

export type UnscheduledJobRow = Pick<
  Job,
  'id' | 'tenant_id' | 'customer_id' | 'title' | 'status' | 'priority' | 'duration_minutes' | 'created_at'
> & {
  customers: Pick<Customer, 'name' | 'tenant_id'> | null;
};

// The scheduler's work queue with the customer name embedded — the bucket's
// unscheduled-jobs half: open jobs with NO live (proposed/confirmed)
// visit. Anti-join filtered in JS — PostgREST anti-joins are awkward and
// tenant job counts are small. THE one body for the "live visit"
// predicate (final-review finding: a second copy would let the board tray and
// the scheduler queue disagree about which jobs are scheduled). Recorded
// limitation: a `proposed` unassigned row counts as live here while being
// invisible to the parked-visits lister (confirmed-only) — no production
// writer mints proposed rows today; the Plan-3c/4b scheduler decides.
export async function listUnscheduledOpenJobsWithCustomer(
  tenantId: string,
): Promise<UnscheduledJobRow[]> {
  const { data, error } = await getClient()
    .from('jobs')
    .select(UNSCHEDULED_JOBS_SELECT)
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listUnscheduledOpenJobsWithCustomer failed: ${error.message}`);
  return (data ?? [])
    .filter(
      (row) => !row.visits.some((v) => v.status === 'proposed' || v.status === 'confirmed'),
    )
    .map((row) => {
      const job: UnscheduledJobRow & { visits?: unknown } = { ...row };
      delete job.visits;
      return job as UnscheduledJobRow;
    });
}

// Name-less projection of the same queue (kept for existing callers/tests) —
// never a second query body. Strip idiom matches the embed-key strip above.
export async function listUnassignedOpenJobs(
  tenantId: string,
): Promise<Omit<UnscheduledJobRow, 'customers'>[]> {
  return (await listUnscheduledOpenJobsWithCustomer(tenantId)).map((row) => {
    const job: Omit<UnscheduledJobRow, 'customers'> & { customers?: unknown } = { ...row };
    delete job.customers;
    return job;
  });
}

// ---- visit_notes: which L1 capture reported which trip (rung 9b) ----------
//
// The link is a TABLE, not a column on raw_captures: the capture is inserted
// BEFORE the visit is resolved (every recordFieldNote caller hands in an
// existing captureId), and L1 can never be updated afterwards. One trip takes
// many notes — two technicians, or one filing twice.

export interface InsertVisitNoteInput {
  tenantId: string;
  visitId: string;
  captureId: string;
}

// UPSERT with ignoreDuplicates, never a plain insert: a redelivered capture
// (pull-window overlap, retried webhook) resolves to the same visit and would
// otherwise raise 23505 on the (visit_id, capture_id) primary key. It must also
// never become an ON CONFLICT DO **UPDATE** — visit_notes is append-only on
// UPDATE, so that would raise instead of being a no-op.
export async function insertVisitNote(input: InsertVisitNoteInput): Promise<void> {
  const { error } = await getClient()
    .from('visit_notes')
    .upsert(
      {
        tenant_id: input.tenantId,
        visit_id: input.visitId,
        capture_id: input.captureId,
      },
      { onConflict: 'visit_id,capture_id', ignoreDuplicates: true },
    );
  if (error) throw new Error(`insertVisitNote failed: ${error.message}`);
}

// True if any note links this capture — the completeness marker for a processed
// note (recordFieldNote writes the link LAST, so a link implies the whole L2
// build ran). Replaces captureHasLinkedVisit's source_capture_id probe, which
// went blind the moment a note could attach to a visit it did not create.
export async function captureHasVisitNote(captureId: string): Promise<boolean> {
  const { data, error } = await getClient()
    .from('visit_notes')
    .select('capture_id')
    .eq('capture_id', captureId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`captureHasVisitNote failed: ${error.message}`);
  return !!data;
}

// The watcher's OTHER activity home — always paired with rawCaptures'
// listJobStampedCaptureTimes (see its two-homes note). Rung 9b re-sourced it:
// the old reader counted VISIT ROWS minted since the floor, which worked only
// while every note minted one. Now a note attaches to an existing trip, so the
// signal is the LINK, not the row.
//
// PAGED for the same reason as listJobStampedCaptureTimes: the silent 1000-row
// cap on an unordered read drops arbitrary rows — possibly the one note proving
// a visit was reported, turning a filled visit into a false gap flag.
export async function listNoteTimesForJobs(
  tenantId: string,
  jobIds: string[],
  sinceUtcIso: string,
): Promise<{ job_id: string; created_at: string }[]> {
  if (jobIds.length === 0) return []; // PostgREST `in.()` with zero values errors
  const PAGE = 1000;
  const out: { job_id: string; created_at: string }[] = [];
  for (let fromRow = 0; ; fromRow += PAGE) {
    // !inner, so filtering on the embedded job actually filters the note rows
    // rather than just nulling the embed.
    const { data, error } = await getClient()
      .from('visit_notes')
      .select('created_at, visits!inner(job_id)')
      .eq('tenant_id', tenantId)
      .in('visits.job_id', jobIds)
      .gte('created_at', sinceUtcIso)
      .order('created_at', { ascending: true })
      .range(fromRow, fromRow + PAGE - 1);
    if (error) throw new Error(`listNoteTimesForJobs failed: ${error.message}`);
    for (const row of (data ?? []) as { created_at: string; visits: { job_id: string } | null }[]) {
      if (row.visits) out.push({ job_id: row.visits.job_id, created_at: row.created_at });
    }
    if (!data || data.length < PAGE) return out;
  }
}

// ---- The customer brief's PAST-work half ----------------------------------

export type VisitWithTechnician = Visit & {
  technicians: Pick<Technician, 'ref' | 'display_name' | 'tenant_id'> | null;
};

// Single string literal — see the DETAIL_SELECT note above.
const CUSTOMER_VISITS_SELECT = 'visits(*, technicians(ref,display_name,tenant_id))';

// Every trip that HAS HAPPENED across a customer's jobs, newest first. Visits
// carry no customer_id, so we reach them through the jobs relation and flatten.
//
// FILTERED TO 'completed' (rung 9b): this feeds `recentVisits`, which the tool
// surface documents as evidence of PAST work — the schedule half is
// listUpcomingVisitsForCustomer. Before the merge that distinction was free,
// because the old table only ever held reported trips; now one table holds
// both, so an unfiltered read would brief three future bookings as three past
// visits AND list them again as upcoming.
export async function listVisitsForCustomer(customerId: string): Promise<VisitWithTechnician[]> {
  const { data, error } = await getClient()
    .from('jobs')
    .select(CUSTOMER_VISITS_SELECT)
    .eq('customer_id', customerId)
    .eq('visits.status', 'completed');
  if (error) throw new Error(`listVisitsForCustomer failed: ${error.message}`);
  const visits = (data ?? []).flatMap((job) => job.visits as VisitWithTechnician[]);
  return visits
    // technicians is an ID-ONLY foreign key: re-check the tenant before any
    // caller prints the name (the DETAIL_SELECT doctrine above).
    .map((v) => (v.technicians && v.technicians.tenant_id !== v.tenant_id ? { ...v, technicians: null } : v))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
