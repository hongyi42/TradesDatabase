// The deterministic booking verbs (no AI, no MCP): book / move / cancel one
// visit on the DB-owned schedule, plus their stage-time PREVIEWS. The MCP
// tools (Phase 3), the Mini App (Plan 2), and the auto-scheduler (Plan 3) all
// call THESE — every guard here protects every surface at once. Previews and
// verbs share one resolution front-half so what a preview shows is exactly
// what the commit will do (preview == commit, house rule).
//
// Time convention (recorded in the promise-ladder migration): schedule times
// are stored NAIVE-LOCAL — the firm's wall-clock time written as if UTC, the
// same convention the sheet mirror established. UTC-day readers stay correct;
// availability checks interpret these timestamps with timezone 'UTC'.
import {
  appendScheduleEvent,
  createAssignment,
  createJob,
  getAssignmentForTenant,
  getCustomer,
  getJob,
  getJobDurationMinutes,
  getTechnician,
  getTechnicianById,
  isInactiveState,
  isOverlapViolation,
  listAssignmentsForTechnician,
  listTimeOffForTechnician,
  listUnassignedAssignments,
  rescheduleAssignment,
  updateAssignmentStatus,
  updateJobStatus,
  type Assignment,
  type Customer,
  type Job,
  type PromiseLevel,
  type Technician,
  type WeeklyPattern,
} from '../db/index.js';
import { isTechnicianAvailableOn } from './availability.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PROMISE_LEVELS: PromiseLevel[] = ['none', 'day', 'time'];

// The naive-local storage form: local wall-clock written as if UTC.
export function naiveLocalISO(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00.000Z`;
}

export function isPromiseLevel(v: unknown): v is PromiseLevel {
  return typeof v === 'string' && (PROMISE_LEVELS as string[]).includes(v);
}

// Minutes → 'HH:MM' on the same day, clamped to 23:59 (a duration default that
// spills past midnight books to end-of-day rather than crossing the UTC-day
// boundary the readers bucket by; the manager can pass endTime explicitly).
function addMinutesClamped(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Shared technician resolution: known, active roster ref or a clean error.
async function resolveTechnician(tenantId: string, ref: string): Promise<Technician> {
  const technician = await getTechnician(tenantId, ref);
  if (!technician) throw new Error(`technician '${ref}' not found on the roster`);
  if (isInactiveState(technician.state)) {
    throw new Error(`technician '${ref}' is deactivated — reactivate the seat first`);
  }
  return technician;
}

// Day-level availability advisory (never blocks — the manager may deliberately
// book outside the pattern; window-level fit is Plan 3). Naive timestamps →
// timezone 'UTC' so the pattern day matches the stored wall-clock day.
async function availabilityWarning(
  technician: Technician,
  date: string,
  startISO: string,
): Promise<string | undefined> {
  const timeOff = await listTimeOffForTechnician(technician.id, date, date);
  const available = isTechnicianAvailableOn(
    startISO,
    technician.availability as WeeklyPattern | null,
    timeOff.map((r) => ({ starts_on: r.starts_on, ends_on: r.ends_on })),
    'UTC',
  );
  if (available) return undefined;
  if (timeOff.length > 0) {
    return `${technician.display_name} has time off booked on ${date}${timeOff[0].reason ? ` (${timeOff[0].reason})` : ''}`;
  }
  return technician.availability
    ? `${date} is outside ${technician.display_name}'s working days`
    : `${technician.display_name} has no working pattern configured yet`;
}

// Confirmed rows overlapping [startISO, endISO) for this technician, minus an
// optional excluded row (a move must not collide with itself). PRE-check only:
// the DB exclusion constraint remains the authority under races.
async function overlappingConfirmed(
  technicianId: string,
  startISO: string,
  endISO: string,
  excludeId?: string,
): Promise<Assignment[]> {
  const rows = await listAssignmentsForTechnician(technicianId, startISO, endISO, ['confirmed']);
  return rows.filter((r) => r.id !== excludeId);
}

function validateDayAndTimes(date: string, startTime: string, endTime: string): void {
  if (!DATE_RE.test(date)) throw new Error('date must be YYYY-MM-DD');
  if (!HHMM_RE.test(startTime) || !HHMM_RE.test(endTime)) {
    throw new Error('startTime/endTime must be HH:MM (24h)');
  }
  if (startTime >= endTime) throw new Error('startTime must be before endTime');
}

export interface BookVisitInput {
  tenantId: string;
  technicianRef?: string; // omit = book UNASSIGNED ("on the calendar, assign later")
  customerId?: string;
  jobId?: string;
  title?: string | null; // job-shell title on the customerId path
  date: string; // YYYY-MM-DD, firm-local
  startTime?: string; // HH:MM, default 08:00
  endTime?: string; // HH:MM, default start + job-type duration
  promiseLevel?: PromiseLevel; // default 'none' — record only promises actually made
  actorRef: string;
}

// The confirmation doctrine (user decision 2026-07-17), single-sourced so every
// surface (MCP tools, the Mini App, the auto-scheduler) inherits it instead of
// re-deriving: confirm only what is irreversible or externally visible — for
// the schedule that means a CUSTOMER PROMISE at stake. Book/cancel gate on the
// promise level; a move gates on whether the move would BREAK the promise
// (same-day time shuffles of a day-promise stay one-shot). Each preview also
// carries the decision as `requiresConfirmation`.
export function bookingRequiresConfirmation(promiseLevel: PromiseLevel): boolean {
  return promiseLevel !== 'none';
}

interface ResolvedBooking {
  technician: Technician | null; // null = unassigned booking
  customer: Customer;
  existingJob: Job | null;
  startTime: string;
  endTime: string;
  endTimeDefaulted: boolean; // true = the server chose the length, not the manager
  startISO: string;
  endISO: string;
  promiseLevel: PromiseLevel;
  warning?: string;
}

// The shared front-half: guards, defaults, overlap PRE-check, availability
// advisory. Throws on anything that would make the booking impossible; writes
// NOTHING. Both previewBookVisit and bookVisit run exactly this.
async function resolveBooking(input: BookVisitInput): Promise<ResolvedBooking> {
  const { tenantId } = input;
  if ((input.customerId ? 1 : 0) + (input.jobId ? 1 : 0) !== 1) {
    throw new Error('provide exactly one of customerId or jobId');
  }
  // No ref = an UNASSIGNED booking: the visit goes on the calendar with nobody
  // attached (attach later via moveVisit). No technician → no overlap pre-check
  // and no availability advisory; the DB guard likewise ignores NULL rows.
  const technician = input.technicianRef
    ? await resolveTechnician(tenantId, input.technicianRef)
    : null;

  // Tenant-guard the target and resolve the customer BEFORE any write.
  let customer: Customer;
  let existingJob: Job | null = null;
  if (input.jobId) {
    const job = await getJob(input.jobId);
    if (!job || job.tenant_id !== tenantId) throw new Error('job not found');
    const jobCustomer = await getCustomer(job.customer_id);
    if (!jobCustomer) throw new Error('job has no customer record');
    existingJob = job;
    customer = jobCustomer;
  } else {
    const byId = await getCustomer(input.customerId as string);
    if (!byId || byId.tenant_id !== tenantId) throw new Error('customer not found');
    customer = byId;
  }

  const startTime = input.startTime ?? '08:00';
  const endTime =
    input.endTime ??
    addMinutesClamped(
      startTime,
      await getJobDurationMinutes(tenantId, existingJob?.job_type ?? null),
    );
  validateDayAndTimes(input.date, startTime, endTime);
  const startISO = naiveLocalISO(input.date, startTime);
  const endISO = naiveLocalISO(input.date, endTime);

  if (technician) {
    const clashes = await overlappingConfirmed(technician.id, startISO, endISO);
    if (clashes.length > 0) {
      throw new Error(
        `${technician.display_name} already has a confirmed visit overlapping ${input.date} ${startTime}–${endTime}`,
      );
    }
  } else {
    // Unassigned rows are exempt from the DB overlap guard (NULL never
    // matches), so a transport retry of a one-shot unassigned booking would
    // otherwise duplicate SILENTLY — no token to consume, no guard to fire.
    // Refuse an IDENTICAL person-less duplicate: same customer, same exact
    // window. Different customers at the same window stay legal (there is no
    // technician to double-book); if two same-window visits for one customer
    // are truly intended, stagger the time or attach technicians.
    const startMs = Date.parse(startISO);
    const endMs = Date.parse(endISO);
    for (const row of await listUnassignedAssignments(tenantId, startISO)) {
      if (Date.parse(row.starts_at) > startMs) break; // ordered — past the window
      if (Date.parse(row.starts_at) !== startMs || Date.parse(row.ends_at) !== endMs) continue;
      const rowJob = await getJob(row.job_id);
      if (rowJob?.customer_id === customer.id) {
        throw new Error(
          `an identical unassigned visit for ${customer.name} already exists at ` +
            `${input.date} ${startTime}–${endTime} — likely a duplicate; attach a technician ` +
            `to it, move it, or change the time`,
        );
      }
    }
  }
  const warning = technician
    ? await availabilityWarning(technician, input.date, startISO)
    : undefined;
  return {
    technician,
    customer,
    existingJob,
    startTime,
    endTime,
    // Disclosure flag, never a gate: when the manager stated no length the
    // duration default fills in — the agent must SAY the length was assumed
    // (and always pass endTime when the manager stated one).
    endTimeDefaulted: input.endTime === undefined,
    startISO,
    endISO,
    // Default 'none': a fresh booking promises the customer NOTHING unless the
    // manager says otherwise. Recording 'day' by default let the schedule
    // "know" the customer was told a day nobody actually told them — an
    // assumption the manager could not distinguish from fact. The agent passes
    // 'day'/'time' only when the manager's words show a promise was made.
    promiseLevel: input.promiseLevel ?? 'none',
    ...(warning ? { warning } : {}),
  };
}

export interface BookVisitPreview {
  technicianRef: string | null; // null = unassigned booking
  technicianName: string | null;
  customerId: string;
  customerName: string;
  newJob: boolean; // true = confirming will mint a job shell
  jobTitle: string | null;
  date: string;
  startTime: string; // resolved (defaults applied) — store these on the stage
  endTime: string;
  endTimeDefaulted: boolean; // server-chosen length — disclose, never confirm-the-guess
  promiseLevel: PromiseLevel;
  requiresConfirmation: boolean; // the doctrine's verdict — surfaces branch on THIS
  warning?: string;
}

// Stage-time preview: everything the person must be shown, with defaults
// resolved so the staged copy can carry EXACTLY what commit will write.
export async function previewBookVisit(input: BookVisitInput): Promise<BookVisitPreview> {
  const r = await resolveBooking(input);
  return {
    technicianRef: r.technician?.ref ?? null,
    technicianName: r.technician?.display_name ?? null,
    customerId: r.customer.id,
    customerName: r.customer.name,
    newJob: r.existingJob === null,
    jobTitle: r.existingJob?.title ?? input.title ?? null,
    date: input.date,
    startTime: r.startTime,
    endTime: r.endTime,
    endTimeDefaulted: r.endTimeDefaulted,
    promiseLevel: r.promiseLevel,
    requiresConfirmation: bookingRequiresConfirmation(r.promiseLevel),
    ...(r.warning ? { warning: r.warning } : {}),
  };
}

export interface BookVisitResult {
  assignment: Assignment;
  job: Job;
  customer: Customer;
  // True iff THIS call's input omitted endTime. Correct when you pass the
  // manager's original args (the one-shot path). If you pass an already-
  // RESOLVED endTime (the staged-confirm path does — preview == commit), this
  // reads false: carry the stage-time truth from the preview/staged copy.
  endTimeDefaulted: boolean;
  warning?: string;
}

export async function bookVisit(input: BookVisitInput): Promise<BookVisitResult> {
  const { tenantId } = input;
  const r = await resolveBooking(input);

  // Order is load-bearing: the overlap pre-check ran BEFORE minting the job
  // shell (inside resolveBooking), so the common rejection leaves no orphaned
  // open job in the scheduler queue.
  const job =
    r.existingJob ??
    (await createJob({
      tenantId,
      customerId: r.customer.id,
      title: input.title ?? null,
      status: 'open',
    }));

  let assignment: Assignment;
  try {
    assignment = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: r.technician?.id ?? null,
      startsAt: r.startISO,
      endsAt: r.endISO,
      status: 'confirmed',
      promiseLevel: r.promiseLevel,
      // Stamp a promised day ONLY when a promise was actually made — a 'none'
      // booking has no promised day (the CHECK constraint requires this pairing).
      promisedDay: r.promiseLevel === 'none' ? null : input.date,
      locked: true,
    });
  } catch (err) {
    // The pre-check raced a concurrent booking and the DB guard fired. If WE
    // minted the job shell this call, best-effort cancel it so it never
    // pollutes listUnassignedOpenJobs (advisory — the booking error is the
    // authority either way).
    if (isOverlapViolation(err) && !r.existingJob) {
      try {
        await updateJobStatus(job.id, 'cancelled');
      } catch {
        /* advisory */
      }
    }
    if (isOverlapViolation(err)) {
      // Only reachable with a technician attached — the DB guard never fires
      // on NULL rows; the fallback text is TS-narrowing, not a real case.
      throw new Error(
        `${r.technician?.display_name ?? 'the technician'} already has a confirmed visit overlapping ${input.date} ${r.startTime}–${r.endTime}`,
      );
    }
    throw err;
  }

  await appendScheduleEvent({
    tenantId,
    assignmentId: assignment.id,
    kind: 'booked',
    actorRef: input.actorRef,
    detail: {
      date: input.date,
      startTime: r.startTime,
      endTime: r.endTime,
      promiseLevel: assignment.promise_level,
      technicianRef: r.technician?.ref ?? null,
      customerId: r.customer.id,
      jobId: job.id,
    },
  });

  return {
    assignment,
    job,
    customer: r.customer,
    endTimeDefaulted: r.endTimeDefaulted,
    ...(r.warning ? { warning: r.warning } : {}),
  };
}

export interface MoveVisitInput {
  tenantId: string;
  assignmentId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime?: string; // HH:MM, default = preserve the old duration
  technicianRef?: string; // omit = same technician
  reason: string;
  actorRef: string;
}

interface ResolvedMove {
  old: Assignment;
  // The TARGET technician. null has two readings — an UNASSIGNED visit staying
  // unassigned (the common case: old.technician_id is null and no ref given),
  // or a roster row that vanished (near-unreachable: techs deactivate, never
  // delete). Discriminate with old.technician_id when it matters.
  technician: Technician | null;
  endTime: string;
  startISO: string;
  endISO: string;
  promiseBroken: boolean;
  warning?: string;
}

// Shared front-half for move: guards, duration default, promise-break
// computation, overlap PRE-check excluding the moved row. Writes nothing.
async function resolveMove(input: MoveVisitInput): Promise<ResolvedMove> {
  const { tenantId } = input;
  if (!input.reason?.trim()) throw new Error('reason is required for a move');
  const old = await getAssignmentForTenant(input.assignmentId, tenantId);
  if (!old) throw new Error('assignment not found');
  if (old.status !== 'confirmed' && old.status !== 'proposed') {
    throw new Error(`cannot move a ${old.status} assignment`);
  }

  // Resolve the TARGET technician either way — the availability warning must
  // fire for a same-technician move onto an off-day too (review finding).
  // An unassigned row moved without a ref stays unassigned (technician null);
  // passing a ref is how a person gets ATTACHED to an unassigned visit.
  const technician = input.technicianRef
    ? await resolveTechnician(tenantId, input.technicianRef)
    : old.technician_id
      ? await getTechnicianById(old.technician_id, tenantId)
      : null;
  const targetTechnicianId = technician?.id ?? old.technician_id;

  const oldDurationMin = Math.round(
    (Date.parse(old.ends_at) - Date.parse(old.starts_at)) / 60_000,
  );
  const endTime = input.endTime ?? addMinutesClamped(input.startTime, oldDurationMin);
  validateDayAndTimes(input.date, input.startTime, endTime);
  const startISO = naiveLocalISO(input.date, input.startTime);
  const endISO = naiveLocalISO(input.date, endTime);

  // Does this move break what the customer was told? A day-level promise
  // breaks only when the DAY changes; a time-level promise (customer heard
  // "Tuesday 9:00") also breaks when the start TIME moves on the same day.
  const dayChanged = old.promised_day !== input.date;
  const timeChanged = old.starts_at.slice(11, 16) !== input.startTime;
  const promiseBroken =
    old.promise_level === 'day'
      ? dayChanged
      : old.promise_level === 'time'
        ? dayChanged || timeChanged
        : false;

  // No target technician (unassigned staying unassigned) → nothing to clash
  // with; the DB guard likewise ignores NULL rows.
  if (targetTechnicianId) {
    const clashes = await overlappingConfirmed(targetTechnicianId, startISO, endISO, old.id);
    if (clashes.length > 0) {
      throw new Error(
        `that slot overlaps a confirmed visit on ${input.date} — the booking was NOT moved`,
      );
    }
  }
  const warning = technician
    ? await availabilityWarning(technician, input.date, startISO)
    : undefined;
  return { old, technician, endTime, startISO, endISO, promiseBroken, ...(warning ? { warning } : {}) };
}

export interface MoveVisitPreview {
  assignmentId: string;
  customerName: string | null;
  technicianName: string | null;
  fromDay: string;
  toDay: string;
  startTime: string;
  endTime: string; // resolved — store on the stage
  promiseBroken: boolean;
  requiresConfirmation: boolean; // = promiseBroken (the doctrine's verdict for moves)
  warning?: string;
}

export async function previewMoveVisit(input: MoveVisitInput): Promise<MoveVisitPreview> {
  const r = await resolveMove(input);
  const job = await getJob(r.old.job_id);
  const customer = job ? await getCustomer(job.customer_id) : null;
  return {
    assignmentId: r.old.id,
    customerName: customer?.name ?? null,
    technicianName: r.technician?.display_name ?? null,
    fromDay: r.old.promised_day ?? r.old.starts_at.slice(0, 10),
    toDay: input.date,
    startTime: input.startTime,
    endTime: r.endTime,
    promiseBroken: r.promiseBroken,
    requiresConfirmation: r.promiseBroken,
    ...(r.warning ? { warning: r.warning } : {}),
  };
}

export interface MoveVisitResult {
  cancelled: Assignment;
  created: Assignment;
  promiseBroken: boolean;
  warning?: string;
}

export async function moveVisit(input: MoveVisitInput): Promise<MoveVisitResult> {
  const { tenantId } = input;
  const r = await resolveMove(input);

  let result: { cancelled: Assignment; created: Assignment };
  try {
    result = await rescheduleAssignment(r.old.id, {
      startsAt: r.startISO,
      endsAt: r.endISO,
      ...(input.technicianRef && r.technician ? { technicianId: r.technician.id } : {}),
      reason: input.reason,
      status: 'confirmed', // default-'proposed' would vanish from every reader
      // Promise level carries from the old row; the promised day tracks the new
      // date only when a promise exists. A 'none' visit stays promise-free.
      promisedDay: r.old.promise_level === 'none' ? null : input.date,
      locked: true,
    });
  } catch (err) {
    // rescheduleAssignment cancels FIRST, so ANY insert failure here — the
    // raced overlap OR a transient DB fault — leaves the visit UNSCHEDULED.
    // Say so honestly (a bare "not moved" would be false: the old booking is
    // gone) and record the stranding in the ledger. The event append is
    // best-effort: it must not mask the real failure.
    const why = isOverlapViolation(err)
      ? 'slot was taken concurrently'
      : err instanceof Error
        ? err.message
        : String(err);
    try {
      await appendScheduleEvent({
        tenantId,
        assignmentId: r.old.id,
        kind: 'move_failed',
        actorRef: input.actorRef,
        detail: { toDay: input.date, reason: why },
      });
    } catch {
      /* advisory */
    }
    throw new Error(
      `the old booking was cancelled but re-booking failed (${why}) — ` +
        'the visit is currently UNSCHEDULED; book it again',
    );
  }

  await appendScheduleEvent({
    tenantId,
    assignmentId: result.created.id,
    kind: 'moved',
    actorRef: input.actorRef,
    detail: {
      fromDay: r.old.promised_day ?? r.old.starts_at.slice(0, 10),
      toDay: input.date,
      promiseBroken: r.promiseBroken,
      previousAssignmentId: r.old.id,
    },
  });

  return {
    ...result,
    promiseBroken: r.promiseBroken,
    ...(r.warning ? { warning: r.warning } : {}),
  };
}

export interface CancelVisitInput {
  tenantId: string;
  assignmentId: string;
  reason: string;
  actorRef: string;
}

export interface CancelVisitPreview {
  assignmentId: string;
  customerName: string | null;
  day: string;
  promiseLevel: PromiseLevel;
  requiresConfirmation: boolean; // the doctrine's verdict for this cancel
}

export async function previewCancelVisit(
  tenantId: string,
  assignmentId: string,
): Promise<CancelVisitPreview> {
  const target = await getAssignmentForTenant(assignmentId, tenantId);
  if (!target) throw new Error('assignment not found');
  if (target.status !== 'confirmed' && target.status !== 'proposed') {
    throw new Error(`cannot cancel a ${target.status} assignment`);
  }
  const job = await getJob(target.job_id);
  const customer = job ? await getCustomer(job.customer_id) : null;
  return {
    assignmentId: target.id,
    customerName: customer?.name ?? null,
    day: target.promised_day ?? target.starts_at.slice(0, 10),
    promiseLevel: target.promise_level,
    requiresConfirmation: bookingRequiresConfirmation(target.promise_level),
  };
}

export async function cancelVisit(input: CancelVisitInput): Promise<Assignment> {
  if (!input.reason?.trim()) throw new Error('reason is required for a cancellation');
  // Tenant guard first — this module is the reuse surface for Plans 2–3, and
  // updateAssignmentStatus alone is id-only.
  const target = await getAssignmentForTenant(input.assignmentId, input.tenantId);
  if (!target) throw new Error('assignment not found');
  // Actionable message when the row went terminal between stage and confirm
  // (e.g. a move cancelled it and re-created the visit under a new id) — the
  // raw state-machine error ("cancelled → cancelled") tells the manager
  // nothing useful.
  if (target.status !== 'confirmed' && target.status !== 'proposed') {
    throw new Error(
      `cannot cancel a ${target.status} assignment — the visit may have been moved or already ` +
        'cancelled; check get_team_schedule for its current booking',
    );
  }
  const cancelled = await updateAssignmentStatus(target.id, 'cancelled', input.reason);
  await appendScheduleEvent({
    tenantId: input.tenantId,
    assignmentId: cancelled.id,
    kind: 'cancelled',
    actorRef: input.actorRef,
    detail: { day: cancelled.starts_at.slice(0, 10), reason: input.reason },
  });
  return cancelled;
}
