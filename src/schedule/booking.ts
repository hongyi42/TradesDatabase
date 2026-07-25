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
  ALLOWED_TRANSITIONS,
  appendScheduleEvent,
  createAssignment,
  createJob,
  getAssignmentForTenant,
  getCustomer,
  getJob,
  getTechnician,
  getTechnicianById,
  isInactiveState,
  isOverlapViolation,
  isValidDuration,
  listAssignmentsForTechnician,
  listTimeOffForTechnician,
  listAssignmentsForJob,
  listIdenticalUnassignedVisits,
  rescheduleAssignment,
  updateAssignmentPromise,
  updateAssignmentStatus,
  updateJobDetails,
  updateJobStatus,
  type Assignment,
  type Customer,
  type Job,
  type JobPriority,
  type PromiseLevel,
  type UpdateJobDetailsInput,
  type Technician,
  type WeeklyPattern,
} from '../db/index.js';
import { isTechnicianAvailableOn } from './availability.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PROMISE_LEVELS: PromiseLevel[] = ['none', 'day', 'time', 'time_only'];

// The naive-local storage form: local wall-clock written as if UTC.
export function naiveLocalISO(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00.000Z`;
}

export function isPromiseLevel(v: unknown): v is PromiseLevel {
  return typeof v === 'string' && (PROMISE_LEVELS as string[]).includes(v);
}

// Which levels carry a promised DAY: 'day' and 'time' (= day+time). 'none'
// promises nothing; 'time_only' promises a TIME with no day — the day moves
// freely, so promised_day stays NULL (the DB check allows exactly this pair).
// ONE predicate for every promisedDay stamping site (bookVisit / moveVisit /
// set_promise) so they can never drift (plan 4a.5).
export function carriesPromisedDay(level: PromiseLevel): boolean {
  return level === 'day' || level === 'time';
}

// The ladder's second axis: which levels promise a TIME. Together the two
// predicates ARE the per-level semantics table — promiseBroken derives from
// them (final-review finding: a hand-enumerated ternary chain would silently
// classify any future fifth level as promise-safe).
export function carriesPromisedTime(level: PromiseLevel): boolean {
  return level === 'time' || level === 'time_only';
}

// Minutes → 'HH:MM' on the same day, clamped to 23:59 (a move that preserves
// the old duration onto a late start books to end-of-day rather than crossing
// the UTC-day boundary the readers bucket by; pass endTime explicitly to
// control it).
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
  // Both times are REQUIRED — the server assumes NO default length (user
  // decision 2026-07-18: a booking carries exactly the times the manager
  // stated; when a time wasn't stated, the agent asks instead of the server
  // inventing one). Moves differ: preserving the OLD duration there carries a
  // real value forward, not an invented one.
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  promiseLevel?: PromiseLevel; // default 'none' — record only promises actually made
  // Triage tier for the job SHELL minted on the customerId path (default
  // 'routine'). Ignored on the jobId path — the MCP layer rejects the
  // combination outright so an unstored urgency is never reported as stored.
  priority?: JobPriority;
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

  const { startTime, endTime } = input;
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
    // are truly intended, stagger the time or attach technicians. ONE query
    // (shared with resolveMove's park path — final-review consolidation).
    const twins = await listIdenticalUnassignedVisits(tenantId, startISO, endISO);
    if (twins.some((t) => t.customerId === customer.id)) {
      throw new Error(
        `an identical unassigned visit for ${customer.name} already exists at ` +
          `${input.date} ${startTime}–${endTime} — likely a duplicate; attach a technician ` +
          `to it, move it, or change the time`,
      );
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
  startTime: string; // as the manager stated — store these on the stage
  endTime: string;
  promiseLevel: PromiseLevel;
  // What the job's priority will be after commit: the existing job's recorded
  // tier, or the stated/default tier of the shell about to be minted — shown
  // so the manager confirms exactly what commit writes (preview == commit).
  priority: JobPriority;
  // What the job's duration will be after commit (the priority idiom above):
  // the existing job's stored length, or — on the shell-minting path — the
  // span this booking measures. Preview == commit must cover the 4b-1 write.
  jobDurationMinutes: number | null;
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
    promiseLevel: r.promiseLevel,
    priority: r.existingJob ? r.existingJob.priority : (input.priority ?? 'routine'),
    jobDurationMinutes: r.existingJob
      ? r.existingJob.duration_minutes
      : bookedSpanMinutes(r.startISO, r.endISO),
    requiresConfirmation: bookingRequiresConfirmation(r.promiseLevel),
    ...(r.warning ? { warning: r.warning } : {}),
  };
}

// THE ISO-pair → whole-minutes computation (final-review consolidation: this
// arithmetic previously existed in three hand-written copies — here, moveVisit'
// s duration default, and find_slots' subject-visit branch — which could drift
// in rounding semantics independently).
export function spanMinutes(startISO: string, endISO: string): number {
  return Math.round((Date.parse(endISO) - Date.parse(startISO)) / 60_000);
}

// The span a booking measures — what the minted job shell stores as its
// duration. null when the span falls outside the typed-layer bound (a
// multi-day span is not a per-job estimate); same-day bookings are always
// 1..1439 so the guard is future-proofing, not a live branch.
function bookedSpanMinutes(startISO: string, endISO: string): number | null {
  const span = spanMinutes(startISO, endISO);
  return isValidDuration(span) ? span : null;
}

export interface BookVisitResult {
  assignment: Assignment;
  job: Job;
  customer: Customer;
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
      ...(input.priority ? { priority: input.priority } : {}),
      // The booked span, recorded VERBATIM onto the fresh shell (plan 4b-1): a
      // MEASURED value, not an invented one, so the never-guess rule holds.
      // Kept even off-ladder (08:00-09:20 → 80) — discarding it would leave
      // the job duration-less if the visit is later cancelled, and the freeze
      // would re-ask a length we already knew. isValidDuration guards the
      // (today unreachable) over-24h span: store null, not a bound breach.
      durationMinutes: bookedSpanMinutes(r.startISO, r.endISO),
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
      // Stamp a promised day ONLY for day-carrying levels — 'none' promises
      // nothing and 'time_only' promises no DAY (the CHECK backstops the pair).
      promisedDay: carriesPromisedDay(r.promiseLevel) ? input.date : null,
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
  unassign?: boolean; // true = DETACH: park the visit person-less (plan 4a.5)
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

  if (input.unassign && input.technicianRef) {
    throw new Error(
      'pass ONE of technicianRef (attach/reassign) or unassign:true (park the visit) — not both',
    );
  }
  // Resolve the TARGET technician either way — the availability warning must
  // fire for a same-technician move onto an off-day too (review finding).
  // An unassigned row moved without a ref stays unassigned (technician null);
  // passing a ref is how a person gets ATTACHED to an unassigned visit;
  // unassign:true DETACHES — the target is nobody, so there is no availability
  // advisory and no overlap pre-check (NULL rows are exempt from the DB guard).
  const technician = input.unassign
    ? null
    : input.technicianRef
      ? await resolveTechnician(tenantId, input.technicianRef)
      : old.technician_id
        ? await getTechnicianById(old.technician_id, tenantId)
        : null;
  const targetTechnicianId = input.unassign ? null : (technician?.id ?? old.technician_id);

  const oldDurationMin = spanMinutes(old.starts_at, old.ends_at);
  const endTime = input.endTime ?? addMinutesClamped(input.startTime, oldDurationMin);
  validateDayAndTimes(input.date, input.startTime, endTime);
  const startISO = naiveLocalISO(input.date, input.startTime);
  const endISO = naiveLocalISO(input.date, endTime);

  // Does this move break what the customer was told? Derived from the two
  // ladder predicates — a day-carrying promise breaks when the DAY changes, a
  // time-carrying one when the start TIME changes ('time' = both axes;
  // 'time_only' has promised_day NULL, so dayChanged is never consulted).
  const dayChanged = old.promised_day !== input.date;
  const timeChanged = old.starts_at.slice(11, 16) !== input.startTime;
  const promiseBroken =
    (carriesPromisedDay(old.promise_level) && dayChanged) ||
    (carriesPromisedTime(old.promise_level) && timeChanged);

  // No target technician (a detach, or unassigned staying unassigned) →
  // nothing to clash with; the DB guard likewise ignores NULL rows. That
  // exemption is exactly why the person-less RESULT needs resolveBooking's
  // identical-duplicate refusal instead (same customer + exact window,
  // excluding the moved row itself): a park must not silently land on top of
  // an existing identical parked visit.
  if (targetTechnicianId) {
    const clashes = await overlappingConfirmed(targetTechnicianId, startISO, endISO, old.id);
    if (clashes.length > 0) {
      throw new Error(
        `that slot overlaps a confirmed visit on ${input.date} — the booking was NOT moved`,
      );
    }
  } else {
    // Same guard as resolveBooking's, excluding the moved row itself; the two
    // reads are independent, so they run in parallel (final-review finding).
    const [movedJob, twins] = await Promise.all([
      getJob(old.job_id),
      listIdenticalUnassignedVisits(tenantId, startISO, endISO),
    ]);
    if (
      movedJob &&
      twins.some((t) => t.id !== old.id && t.customerId === movedJob.customer_id)
    ) {
      throw new Error(
        `an identical unassigned visit for this customer already exists at ` +
          `${input.date} ${input.startTime}–${endTime} — likely a duplicate; attach a ` +
          `technician to it or change the time`,
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
  // The OLD row's level — what is at stake. Surfaces phrase the confirm on it
  // ("was told 09:00" for time_only vs "was told Thursday" for day levels).
  promiseLevel: PromiseLevel;
  unassign: boolean; // true = this move PARKS the visit (detach)
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
    promiseLevel: r.old.promise_level,
    unassign: !!input.unassign,
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
      ...(input.unassign
        ? { technicianId: null } // explicit null = DETACH (rescheduleAssignment's !== undefined idiom)
        : input.technicianRef && r.technician
          ? { technicianId: r.technician.id }
          : {}),
      reason: input.reason,
      status: 'confirmed', // default-'proposed' would vanish from every reader
      // Promise level carries from the old row; the promised day tracks the new
      // date only for day-carrying levels ('none'/'time_only' stay day-free).
      promisedDay: carriesPromisedDay(r.old.promise_level) ? input.date : null,
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

export interface UnscheduleVisitInput {
  tenantId: string;
  assignmentId: string;
  reason: string;
  actorRef: string;
}

export interface UnscheduleVisitPreview {
  assignmentId: string;
  customerName: string | null;
  day: string;
  promiseLevel: PromiseLevel;
  requiresConfirmation: boolean; // the doctrine's verdict for this cancel
}

export async function previewUnscheduleVisit(
  tenantId: string,
  assignmentId: string,
): Promise<UnscheduleVisitPreview> {
  const target = await getAssignmentForTenant(assignmentId, tenantId);
  if (!target) throw new Error('assignment not found');
  if (target.status !== 'confirmed' && target.status !== 'proposed') {
    throw new Error(`cannot unschedule a ${target.status} assignment`);
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

export async function unscheduleVisit(input: UnscheduleVisitInput): Promise<Assignment> {
  if (!input.reason?.trim()) throw new Error('reason is required for an unschedule');
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
      `cannot unschedule a ${target.status} assignment — the visit may have been moved or already ` +
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

// ---- Shared edit cores (plan 4a.5): ONE body per verb, every surface calls it ----
//
// The set_promise / update_job MCP handlers used to hold this logic inline;
// the board endpoints need the same writes, and hand-copying the CAS + ledger
// event is exactly how two surfaces start disagreeing. Handlers keep their
// validation and echo composition; these cores own the guarded write + event.

export interface SetVisitPromiseResult {
  previous: Assignment;
  updated: Assignment;
}

// Correct a visit's promise record. The promised day is SERVER-derived from
// the visit's own row (bookVisit precedent — caller date math never touches
// the promise record); 'none'/'time_only' carry no day. CAS on the row read
// here, so the old→new echo callers compose is honest.
export async function setVisitPromise(
  tenantId: string,
  assignmentId: string,
  promiseLevel: PromiseLevel,
  actorRef: string,
): Promise<SetVisitPromiseResult> {
  const row = await getAssignmentForTenant(assignmentId, tenantId);
  if (!row) throw new Error('visit not found');
  if (row.status !== 'confirmed' && row.status !== 'proposed') {
    throw new Error(`this visit is ${row.status} — promises are corrected on live visits only`);
  }
  const promisedDay = carriesPromisedDay(promiseLevel) ? row.starts_at.slice(0, 10) : null;
  const updated = await updateAssignmentPromise(
    tenantId,
    assignmentId,
    promiseLevel,
    promisedDay,
    row.updated_at, // CAS — the echo must describe THIS read
  );
  // The promise level gates every future move/cancel confirmation on this
  // visit — the change joins the append-only ledger like every schedule
  // mutation: who changed what, when, old → new, forever.
  await appendScheduleEvent({
    tenantId,
    assignmentId,
    kind: 'promise_updated',
    actorRef,
    detail: {
      promiseLevel: { from: row.promise_level, to: updated.promise_level },
      promisedDay: { from: row.promised_day, to: updated.promised_day },
    },
  });
  return { previous: row, updated };
}

export interface UpdateJobIdentityResult {
  previous: Job;
  updated: Job;
}

// Correct a job's identity (title / jobType / priority). jobType — including
// null-to-clear — is part of the core: the MCP handler writes it and tests pin
// it (plan review finding #2); surfaces that expose less (the board: title +
// priority) restrict at their own layer. The type-duration warning stays
// MCP-side (it is conversational steering, not a write concern).
export async function updateJobIdentity(
  tenantId: string,
  jobId: string,
  patch: UpdateJobDetailsInput,
  actorRef: string,
): Promise<UpdateJobIdentityResult> {
  const job = await getJob(jobId);
  // Tenant guard: a cross-tenant (or unknown) id reads as not found.
  if (!job || job.tenant_id !== tenantId) throw new Error('job not found');
  const updated = await updateJobDetails(tenantId, jobId, patch, job.updated_at);
  // The identity edit is schedule-visible (board lanes, schedule reads) — it
  // joins the append-only event ledger like every other schedule mutation.
  await appendScheduleEvent({
    tenantId,
    kind: 'job_updated',
    actorRef,
    detail: {
      jobId,
      ...(patch.title !== undefined ? { title: { from: job.title, to: updated.title } } : {}),
      ...(patch.jobType !== undefined
        ? { jobType: { from: job.job_type, to: updated.job_type } }
        : {}),
      ...(patch.priority !== undefined
        ? { priority: { from: job.priority, to: updated.priority } }
        : {}),
      ...(patch.durationMinutes !== undefined
        ? { durationMinutes: { from: job.duration_minutes, to: updated.duration_minutes } }
        : {}),
    },
  });
  return { previous: job, updated };
}

// ---------------------------------------------------------------------------
// cancel_job (cancel-vocabulary plan, 2026-07-25): the TERMINAL verb. Where
// unscheduleVisit takes one calendar attempt off while the work survives,
// cancelJob closes the WORK: the job leaves the loose bucket and every live
// visit dies with it. Terminal per ALLOWED_TRANSITIONS (cancelled → []), so
// the confirmation doctrine's irreversible arm applies — every surface must
// stage-and-confirm; there is no one-shot path.

export interface CancelJobVisit {
  assignmentId: string;
  day: string;
  startTime: string;
  promiseLevel: PromiseLevel;
  technicianRef: string | null;
}

export interface CancelJobPreview {
  jobId: string;
  jobTitle: string | null;
  customerName: string | null;
  // Every live (confirmed/proposed) visit that dies with the job — promises
  // included, so the confirm dialog states the full stake.
  visits: CancelJobVisit[];
  // ALWAYS true — single-sourced here like every requiresConfirmation, so no
  // surface can ever grow a one-shot arm for a terminal action.
  requiresConfirmation: true;
}

// Tenant guard is EXPLICIT (plan-review finding): getJob and every cascade
// helper are id-only, so the guard lives here (the updateJobIdentity idiom)
// and all cascade rows are reached only through the guarded job.
async function resolveCancelJob(tenantId: string, jobId: string): Promise<Job> {
  const job = await getJob(jobId);
  if (!job || job.tenant_id !== tenantId) throw new Error('job not found');
  if (!ALLOWED_TRANSITIONS[job.status].includes('cancelled')) {
    throw new Error(
      `cannot cancel a ${job.status} job — only open or in-progress work can be cancelled` +
        (job.status === 'cancelled' ? ' (it already is)' : ''),
    );
  }
  return job;
}

const liveRowsForJob = async (jobId: string): Promise<Assignment[]> =>
  (await listAssignmentsForJob(jobId)).filter(
    (r) => r.status === 'confirmed' || r.status === 'proposed',
  );

export async function previewCancelJob(
  tenantId: string,
  jobId: string,
): Promise<CancelJobPreview> {
  const job = await resolveCancelJob(tenantId, jobId);
  const customer = await getCustomer(job.customer_id);
  const rows = await liveRowsForJob(job.id);
  // Ref resolution mirrors findDisplacementCandidates: cache per technician.
  const refCache = new Map<string, string | null>();
  const visits: CancelJobVisit[] = [];
  for (const row of rows) {
    let ref: string | null = null;
    if (row.technician_id) {
      if (!refCache.has(row.technician_id)) {
        const t = await getTechnicianById(row.technician_id, tenantId);
        refCache.set(row.technician_id, t?.ref ?? null);
      }
      ref = refCache.get(row.technician_id) ?? null;
    }
    visits.push({
      assignmentId: row.id,
      day: row.starts_at.slice(0, 10),
      startTime: row.starts_at.slice(11, 16),
      promiseLevel: row.promise_level,
      technicianRef: ref,
    });
  }
  return {
    jobId: job.id,
    jobTitle: job.title,
    customerName: customer && customer.tenant_id === tenantId ? customer.name : null,
    visits,
    requiresConfirmation: true,
  };
}

export interface CancelJobInput {
  tenantId: string;
  jobId: string;
  reason: string;
  actorRef: string;
}

export interface CancelJobResult {
  job: Job;
  cancelledVisits: Assignment[];
}

export async function cancelJob(input: CancelJobInput): Promise<CancelJobResult> {
  const { tenantId } = input;
  if (!input.reason?.trim()) throw new Error('reason is required for a job cancellation');
  const job = await resolveCancelJob(tenantId, input.jobId);

  // Cascade order (recorded decision): visits FIRST, job LAST. Each visit
  // gets its own 'cancelled' ledger event — the existing boardNotify copy
  // pushes to the affected technician — and a crash mid-cascade leaves a
  // re-runnable state (the job is still open; already-cancelled rows are
  // simply absent from the next run's live list). Completed/terminal rows
  // are never touched.
  const cancelledVisits: Assignment[] = [];
  for (const row of await liveRowsForJob(job.id)) {
    const cancelled = await updateAssignmentStatus(row.id, 'cancelled', input.reason);
    cancelledVisits.push(cancelled);
    await appendScheduleEvent({
      tenantId,
      assignmentId: cancelled.id,
      kind: 'cancelled',
      actorRef: input.actorRef,
      detail: {
        day: cancelled.starts_at.slice(0, 10),
        reason: input.reason,
        jobCancellation: true, // distinguishes cascade rows from lone unschedules
      },
    });
  }
  // Guarded transition — a concurrent flip between our read and this write
  // surfaces instead of being overwritten (updateJobStatus's CAS-on-status).
  const cancelledJob = await updateJobStatus(job.id, 'cancelled');
  await appendScheduleEvent({
    tenantId,
    kind: 'job_cancelled', // plain-text kind; produces no push (manager-initiated)
    actorRef: input.actorRef,
    detail: { jobId: job.id, reason: input.reason, visitsCancelled: cancelledVisits.length },
  });
  return { job: cancelledJob, cancelledVisits };
}
