import type { Database } from './database.types.js';
import { getClient } from './client.js';
import type { Job } from './jobs.js';

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

// The scheduler's work queue: open jobs with NO live (proposed/confirmed)
// assignment. One embedded select, anti-join filtered in JS — PostgREST
// anti-joins are awkward and tenant job counts are small.
export async function listUnassignedOpenJobs(tenantId: string): Promise<Job[]> {
  const { data, error } = await getClient()
    .from('jobs')
    .select('*, assignments(id,status)')
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listUnassignedOpenJobs failed: ${error.message}`);
  return (data ?? [])
    .filter(
      (row) => !row.assignments.some((a) => a.status === 'proposed' || a.status === 'confirmed'),
    )
    .map((row) => {
      const job: Job & { assignments?: unknown } = { ...row };
      delete job.assignments;
      return job as Job;
    });
}
