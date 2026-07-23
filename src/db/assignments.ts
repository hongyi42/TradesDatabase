import type { Database } from './database.types.js';
import { getClient } from './client.js';
import type { Job, JobCustomerAddress } from './jobs.js';
import type { Customer } from './customers.js';
import type { Technician } from './technicians.js';

export type Assignment = Database['public']['Tables']['assignments']['Row'];
export type AssignmentStatus = Database['public']['Enums']['assignment_status'];
export type PromiseLevel = Database['public']['Enums']['promise_level'];

// Hardcoded, auditable state machine (jobs.ts pattern). Times on a row are
// immutable — a reschedule is cancel + insert, never an edit — so status is the
// only mutable business field and cancelled/completed are terminal.
export const ASSIGNMENT_TRANSITIONS: Record<AssignmentStatus, AssignmentStatus[]> = {
  proposed: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  cancelled: [],
  completed: [],
};

export interface CreateAssignmentInput {
  tenantId: string;
  jobId: string;
  technicianId: string | null; // null = unassigned ("book now, assign later")
  startsAt: string; // ISO timestamptz (naive-local convention — see the promise-ladder migration)
  endsAt: string; // ISO timestamptz, exclusive
  status?: AssignmentStatus;
  sourceCaptureId?: string | null;
  // Commitment ladder: what the customer was told. The DB check requires
  // promisedDay whenever promiseLevel is not 'none'.
  promiseLevel?: PromiseLevel;
  promisedDay?: string | null; // YYYY-MM-DD
  locked?: boolean; // manual manager placement — Plan-3 optimizer routes around it
}

// Insert one assignment row. Inserting as 'confirmed' can raise the DB's
// no_confirmed_overlap exclusion constraint — preserve the SQLSTATE so callers
// can detect it via isOverlapViolation (Object.assign idiom, insertTechnician).
export async function createAssignment(input: CreateAssignmentInput): Promise<Assignment> {
  const { data, error } = await getClient()
    .from('assignments')
    .insert({
      tenant_id: input.tenantId,
      job_id: input.jobId,
      technician_id: input.technicianId,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      status: input.status ?? 'proposed',
      source_capture_id: input.sourceCaptureId ?? null,
      promise_level: input.promiseLevel ?? 'none',
      promised_day: input.promisedDay ?? null,
      locked: input.locked ?? false,
    })
    .select()
    .single();
  if (error) {
    throw Object.assign(new Error(`createAssignment failed: ${error.message}`), {
      code: error.code,
    });
  }
  if (!data) throw new Error('createAssignment failed: no row returned');
  return data;
}

async function getAssignment(id: string): Promise<Assignment | null> {
  const { data, error } = await getClient()
    .from('assignments')
    .select()
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getAssignment failed: ${error.message}`);
  return data;
}

// Walk one legal transition. Guarded on the status we validated against
// (jobs.ts concurrency idiom): a concurrent flip between our read and this
// update matches no row and surfaces instead of being silently overwritten.
// `reason` is stored when cancelling (why the booking was undone). Confirming
// can raise the exclusion constraint → SQLSTATE preserved for isOverlapViolation.
export async function updateAssignmentStatus(
  id: string,
  next: AssignmentStatus,
  reason?: string | null,
): Promise<Assignment> {
  const current = await getAssignment(id);
  if (!current) throw new Error(`updateAssignmentStatus: assignment ${id} not found`);
  const allowed = ASSIGNMENT_TRANSITIONS[current.status];
  if (!allowed.includes(next)) {
    throw new Error(
      `Illegal assignment status transition: ${current.status} → ${next} ` +
        `(allowed: ${allowed.join(', ') || 'none'})`,
    );
  }
  const { data, error } = await getClient()
    .from('assignments')
    .update({
      status: next,
      ...(next === 'cancelled' && reason != null ? { reason } : {}),
    }) // updated_at is stamped by the DB trigger
    .eq('id', id)
    .eq('status', current.status)
    .select()
    .maybeSingle();
  if (error) {
    throw Object.assign(new Error(`updateAssignmentStatus failed: ${error.message}`), {
      code: error.code,
    });
  }
  if (!data) {
    throw new Error(
      `updateAssignmentStatus: assignment ${id} changed concurrently (was '${current.status}'); transition not applied`,
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

export interface RescheduleInput {
  startsAt: string;
  endsAt: string;
  technicianId?: string; // omit = same technician
  reason: string; // why the old booking was undone (kept on the cancelled row)
  // Omitted → the new row keeps the old row's promise fields (a move carries
  // the promise). status keeps its 'proposed' default for existing callers;
  // manual moves pass 'confirmed' — a default-'proposed' replacement would
  // vanish from every ['confirmed']-filtered reader and escape the DB guard.
  status?: AssignmentStatus;
  promiseLevel?: PromiseLevel;
  promisedDay?: string | null;
  locked?: boolean;
}

// The reschedule primitive: cancel the old row (reason kept) + insert a fresh
// 'proposed' row. NOT atomic across the two statements — accepted: the worst
// crash case is a cancelled booking with no successor, visible in Plan 4's
// proposal queue, never a double-booking (the DB guard holds regardless).
export async function rescheduleAssignment(
  id: string,
  input: RescheduleInput,
): Promise<{ cancelled: Assignment; created: Assignment }> {
  // Validate the NEW range before mutating anything: cancel-then-fail on a
  // trivially bad input (swapped/malformed times) would destroy a real
  // confirmed booking deterministically — worse than the accepted crash-window
  // non-atomicity, and preventable here. (Review finding, 2026-07-04.)
  const startMs = Date.parse(input.startsAt);
  const endMs = Date.parse(input.endsAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
    throw new Error(
      `rescheduleAssignment: invalid time range ${input.startsAt} – ${input.endsAt} (nothing cancelled)`,
    );
  }
  const old = await getAssignment(id);
  if (!old) throw new Error(`rescheduleAssignment: assignment ${id} not found`);
  const cancelled = await updateAssignmentStatus(id, 'cancelled', input.reason);
  const created = await createAssignment({
    tenantId: old.tenant_id,
    jobId: old.job_id,
    technicianId: input.technicianId ?? old.technician_id,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    status: input.status,
    promiseLevel: input.promiseLevel ?? old.promise_level,
    promisedDay: input.promisedDay !== undefined ? input.promisedDay : old.promised_day,
    locked: input.locked ?? old.locked,
  });
  return { cancelled, created };
}

// Tenant-guarded point read for tool/module surfaces: a cross-tenant or
// unknown id reads as null (the caller decides how to surface it).
export async function getAssignmentForTenant(
  id: string,
  tenantId: string,
): Promise<Assignment | null> {
  const { data, error } = await getClient()
    .from('assignments')
    .select()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`getAssignmentForTenant failed: ${error.message}`);
  return data;
}

// Correct a visit's PROMISE record — what the customer was actually told —
// after booking. Born from a live E2E finding (2026-07-22): a manager's "I
// told Marcus we're coming Thursday" never became promiseLevel on the call,
// the visit landed unprotected ('none'), and no tool could fix it — so a
// genuinely promised visit would move SILENTLY, the exact harm the promise
// ladder exists to prevent. Promise fields only: times are immutable here
// (reschedule = cancel + insert) and status has its own machine above.
// promisedDay is the CALLER's derivation from the row (bookVisit precedent:
// the promise is about THIS visit, so its day comes from the row, never from
// agent date math); the DB check constraint backstops the pairing.
export async function updateAssignmentPromise(
  tenantId: string,
  assignmentId: string,
  promiseLevel: PromiseLevel,
  promisedDay: string | null,
  // CAS: the caller's snapshot of updated_at — the old→new echo the tool
  // returns is only honest if nothing moved between read and write
  // (updateJobDetails precedent).
  expectedUpdatedAt: string,
): Promise<Assignment> {
  const { data, error } = await getClient()
    .from('assignments')
    .update({ promise_level: promiseLevel, promised_day: promisedDay })
    .eq('id', assignmentId)
    .eq('tenant_id', tenantId) // tenant guard: a cross-tenant id matches no row
    .eq('updated_at', expectedUpdatedAt)
    .select()
    .maybeSingle();
  if (error) throw new Error(`updateAssignmentPromise failed: ${error.message}`);
  if (!data) {
    throw new Error(
      'visit changed while updating (or not found) — re-read it and try again so the old→new report stays honest',
    );
  }
  return data;
}

// Rows overlapping the [fromISO, toISO) window for the WHOLE tenant — the
// team-schedule / dispatch-board read. Confirmed only by default: the board
// shows the real schedule, not alternative proposals.
export async function listAssignmentsForTenant(
  tenantId: string,
  fromISO: string,
  toISO: string,
  statuses: AssignmentStatus[] = ['confirmed'],
): Promise<Assignment[]> {
  const { data, error } = await getClient()
    .from('assignments')
    .select()
    .eq('tenant_id', tenantId)
    .lt('starts_at', toISO)
    .gt('ends_at', fromISO)
    .in('status', statuses)
    .order('starts_at', { ascending: true });
  if (error) throw new Error(`listAssignmentsForTenant failed: ${error.message}`);
  return data ?? [];
}

// ---- Dispatch-board reads: the whole visit graph in ONE round-trip ----
//
// The board needs each visit WITH its customer (name/address/contact) and its
// technician (ref + display name). Fetching those as separate point reads costs
// one network round-trip PER TABLE PER BUTTON — the N+1 that made every board
// tap ~1s (DB execution is sub-millisecond; the cost is transit). PostgREST
// resolves the whole graph in a single request via the declared foreign keys
// (assignments→jobs, jobs→customers, assignments→technicians), each of which is
// unambiguous, so no !hint disambiguation is needed.
//
// SECURITY — the foreign keys are ID-ONLY: not one of them carries tenant_id, so
// an embed rooted at a tenant-filtered assignment does NOT guarantee the nested
// job/customer/technician belong to that same tenant. Every nested projection
// therefore ships its own tenant_id and the CALLER must re-check it before
// surfacing the row (see boardRead.ts). Do not drop tenant_id from these
// projections — it is the only thing standing between an embed and a
// cross-tenant leak.

export type AssignmentDetailRow = Assignment & {
  jobs:
    | (Pick<Job, 'id' | 'tenant_id' | 'title' | 'customer_id'> & {
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
  '*, jobs(id,tenant_id,title,customer_id,customers(name,phone,email,address_line1,address_line2,city,state,postal_code,tenant_id)), technicians(id,ref,display_name,tenant_id)';

// One visit + its job/customer/technician, tenant-scoped at the ROOT only.
// A cross-tenant or unknown id reads as null (same contract as
// getAssignmentForTenant); nested tenant checks are the caller's job.
export async function getAssignmentWithRefsForTenant(
  id: string,
  tenantId: string,
): Promise<AssignmentDetailRow | null> {
  const { data, error } = await getClient()
    .from('assignments')
    .select(DETAIL_SELECT)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`getAssignmentWithRefsForTenant failed: ${error.message}`);
  return (data ?? null) as AssignmentDetailRow | null;
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
export type AssignmentDayRow = Assignment & {
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

// Same filters as listAssignmentsForTenant, plus the embedded graph.
export async function listAssignmentsWithRefsForTenant(
  tenantId: string,
  fromISO: string,
  toISO: string,
  statuses: AssignmentStatus[] = ['confirmed'],
): Promise<AssignmentDayRow[]> {
  const { data, error } = await getClient()
    .from('assignments')
    .select(DAY_SELECT)
    .eq('tenant_id', tenantId)
    .lt('starts_at', toISO)
    .gt('ends_at', fromISO)
    .in('status', statuses)
    .order('starts_at', { ascending: true });
  if (error) throw new Error(`listAssignmentsWithRefsForTenant failed: ${error.message}`);
  return (data ?? []) as AssignmentDayRow[];
}

// Rows overlapping the [fromISO, toISO) window for one technician, live
// statuses by default (proposed + confirmed — what claims or may claim time).
export async function listAssignmentsForTechnician(
  technicianId: string,
  fromISO: string,
  toISO: string,
  statuses: AssignmentStatus[] = ['proposed', 'confirmed'],
): Promise<Assignment[]> {
  const { data, error } = await getClient()
    .from('assignments')
    .select()
    .eq('technician_id', technicianId)
    .lt('starts_at', toISO)
    .gt('ends_at', fromISO)
    .in('status', statuses)
    .order('starts_at', { ascending: true });
  if (error) throw new Error(`listAssignmentsForTechnician failed: ${error.message}`);
  return data ?? [];
}

// The booking's full history — every row ever written for the job, newest
// first (reschedules/cancellations included; history = the rows themselves).
export async function listAssignmentsForJob(jobId: string): Promise<Assignment[]> {
  const { data, error } = await getClient()
    .from('assignments')
    .select()
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listAssignmentsForJob failed: ${error.message}`);
  return data ?? [];
}

// The "assign later" recall surface (and Plan 3's future work queue): every
// upcoming confirmed visit with NOBODY attached. No upper date bound — the
// point is catching visits parked beyond any board window. These rows do NOT
// appear in listUnassignedOpenJobs (their job HAS a live assignment) and are
// invisible to every per-technician reader, so this is their only lister.
export async function listUnassignedAssignments(
  tenantId: string,
  fromISO: string,
): Promise<Assignment[]> {
  const { data, error } = await getClient()
    .from('assignments')
    .select()
    .eq('tenant_id', tenantId)
    .is('technician_id', null)
    .eq('status', 'confirmed')
    .gte('starts_at', fromISO)
    .order('starts_at', { ascending: true });
  if (error) throw new Error(`listUnassignedAssignments failed: ${error.message}`);
  return data ?? [];
}

// ---- Loose-bucket reads (Plan 4a): the tray + agent-parity surfaces ----
//
// Same ID-ONLY-foreign-key caveat as the board reads above: callers must
// re-check every nested row's tenant_id before surfacing its name/title.

// Single string literal — see the DETAIL_SELECT note above.
const BUCKET_SELECT =
  '*, jobs(id,tenant_id,title,customer_id,customers(name,tenant_id))';

export type AssignmentBucketRow = Assignment & {
  jobs:
    | (Pick<Job, 'id' | 'tenant_id' | 'title' | 'customer_id'> & {
        customers: Pick<Customer, 'name' | 'tenant_id'> | null;
      })
    | null;
};

// listUnassignedAssignments with the customer/job names embedded — the tray's
// parked-visits read (one round trip, the board-latency doctrine).
export async function listUnassignedAssignmentsWithRefs(
  tenantId: string,
  fromISO: string,
): Promise<AssignmentBucketRow[]> {
  const { data, error } = await getClient()
    .from('assignments')
    .select(BUCKET_SELECT)
    .eq('tenant_id', tenantId)
    .is('technician_id', null)
    .eq('status', 'confirmed')
    .gte('starts_at', fromISO)
    .order('starts_at', { ascending: true });
  if (error) throw new Error(`listUnassignedAssignmentsWithRefs failed: ${error.message}`);
  return (data ?? []) as AssignmentBucketRow[];
}

// Named columns, no '*': jobs carry the elastic L3 `attributes` JSONB, which
// the bucket never uses — and this query feeds an HTTP endpoint hit on every
// board load (final-review efficiency finding). Single string literal — see
// the DETAIL_SELECT note above.
const UNSCHEDULED_JOBS_SELECT =
  'id,tenant_id,customer_id,title,status,priority,created_at, assignments(id,status), customers(name,tenant_id)';

export type UnscheduledJobRow = Pick<
  Job,
  'id' | 'tenant_id' | 'customer_id' | 'title' | 'status' | 'priority' | 'created_at'
> & {
  customers: Pick<Customer, 'name' | 'tenant_id'> | null;
};

// The scheduler's work queue with the customer name embedded — the bucket's
// unscheduled-jobs half: open jobs with NO live (proposed/confirmed)
// assignment. Anti-join filtered in JS — PostgREST anti-joins are awkward and
// tenant job counts are small. THE one body for the "live assignment"
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
      (row) => !row.assignments.some((a) => a.status === 'proposed' || a.status === 'confirmed'),
    )
    .map((row) => {
      const job: UnscheduledJobRow & { assignments?: unknown } = { ...row };
      delete job.assignments;
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
