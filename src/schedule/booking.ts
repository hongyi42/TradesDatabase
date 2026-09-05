// The deterministic booking verbs (no AI, no MCP): book / move / cancel one
// visit on the DB-owned schedule, plus their stage-time PREVIEWS. The MCP tools
// (Phase 3) and the Mini App (Plan 2) both call THESE — every guard here
// protects every surface at once. (The auto-scheduler was a third caller until
// rung 8 deleted it; the manager makes the schedule now.) Previews and
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
  listIdenticalUnplacedVisits,
  listOpenJobsForCustomer,
  rescheduleAssignment,
  updateAssignmentStatus,
  updateJobDetails,
  updateJobStatus,
  isPlaced,
  type Assignment,
  type Customer,
  type Job,
  type JobPriority,
  type Json,
  type UpdateJobDetailsInput,
  type Technician,
  type WeeklyPattern,
} from '../db/index.js';
import { isTechnicianAvailableOn } from './availability.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// The naive-local storage form: local wall-clock written as if UTC.
export function naiveLocalISO(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00.000Z`;
}

// The day a visit belongs to, for replies and ledger events: the placed
// start's day, else the unplaced range's earliest day (plan 4b-2 — an unplaced
// row HAS a day, just no time).
//
// The `promised_day` arm is GONE (rung 9a): the promise ladder is deleted, so
// what the customer was TOLD is no longer a column — it lives in L1, where the
// agent reads it. 'no time set' is the honest label for a row with no day at
// all; it degrades a label, never a booking.
export function visitDay(row: Assignment): string {
  return row.starts_at ? row.starts_at.slice(0, 10) : (row.earliest_date ?? 'no time set');
}

// eventDetailExtra → a spreadable record. Non-object values (arrays/scalars —
// a caller bug) are dropped rather than crashing the write; spread FIRST so
// computed detail keys always win a name clash.
function extraDetail(extra: Json | undefined): Record<string, Json> {
  return extra && typeof extra === 'object' && !Array.isArray(extra)
    ? (extra as Record<string, Json>)
    : {};
}

// Minutes → 'HH:MM' on the same day, clamped to 23:59 (a move that preserves
// the old duration onto a late start books to end-of-day rather than crossing
// the UTC-day boundary the readers bucket by; pass endTime explicitly to
// control it). Exported since 4b-3: the freeze's placement end-times use THE
// same clamp, never a hand-rolled copy.
export function addMinutesClamped(hhmm: string, minutes: number): string {
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
  // The customerId MINT GUARD's escape hatch (2026-08-14): when the customer
  // already has open/in_progress work on file, a customerId booking is REFUSED
  // with the list — the recurring live failure is an agent skipping the
  // context read and silently minting a DUPLICATE job for work the manager
  // just named. Pass true ONLY when the work is genuinely new and different
  // from everything listed.
  forceNewJob?: boolean;
  date?: string; // YYYY-MM-DD, firm-local (required for a PLACED booking)
  // Both times are REQUIRED — the server assumes NO default length (user
  // decision 2026-07-18: a booking carries exactly the times the manager
  // stated; when a time wasn't stated, the agent asks instead of the server
  // inventing one). Moves differ: preserving the OLD duration there carries a
  // real value forward, not an invented one.
  // RECORDED EXCEPTION (plan 4b-2): under timeTbd:true — the manager
  // EXPLICITLY said the time is unsettled — times are absent and the visit
  // books UNPLACED, holding a day (or day range) until placed. Omitting times
  // is never an accident: without the flag they stay required.
  startTime?: string; // HH:MM
  endTime?: string; // HH:MM
  timeTbd?: boolean; // true = book UNPLACED (day known, time not yet)
  earliestDate?: string; // YYYY-MM-DD — the unplaced day / range start (default: date)
  latestDate?: string; // YYYY-MM-DD — range end (default: earliestDate)
  // Triage tier for the job SHELL minted on the customerId path (default
  // 'routine'). Ignored on the jobId path — the MCP layer rejects the
  // combination outright so an unstored urgency is never reported as stored.
  priority?: JobPriority;
  // Why this booking happened (optional — moves REQUIRE one; a book usually
  // speaks for itself). Recorded in the 'booked' event detail when present;
  // the freeze passes 'freeze <run>' so ledger rows say who decided (4b-3).
  reason?: string;
  // Extra ledger-event detail (plan 4b-3): merged UNDER the computed keys —
  // computed detail always wins on a name clash. A batch caller stamps its own
  // run identity here so the rows it wrote are findable as one run.
  eventDetailExtra?: Json;
  actorRef: string;
}

// The confirmation doctrine (user decision 2026-07-17, RE-GATED 2026-09-05),
// single-sourced so every surface (MCP tools, the Mini App) inherits it instead
// of re-deriving: confirm only what is irreversible or externally visible.
//
// It used to key on the promise ladder — `promiseLevel !== 'none'` for
// book/cancel, `promiseBroken` for a move. The ladder is deleted (rung 9a), so
// the test is now PLACEMENT: a visit with a real time on the calendar is one a
// customer is expecting, and cancelling it is the externally-visible act.
// Booking and moving are what the manager just asked for — they are one-shot,
// and the surface says what it did afterwards.
//
// Each preview still carries the verdict as `requiresConfirmation`.
export function cancelRequiresConfirmation(row: Assignment): boolean {
  return isPlaced(row);
}

interface ResolvedBooking {
  technician: Technician | null; // null = unassigned booking
  customer: Customer;
  existingJob: Job | null;
  // PLACED: all four set, range null. UNPLACED (timeTbd): all four null,
  // range set — the same one-shape-only rule the DB enforces.
  startTime: string | null;
  endTime: string | null;
  startISO: string | null;
  endISO: string | null;
  earliestDate: string | null;
  latestDate: string | null;
  warning?: string;
}

/**
 * The customerId mint guard's refusal text — shared by book_visit and
 * find_slots (src/mcp/server.ts) so the steer reads identically wherever the
 * agent hits it. Diagnosed 2026-08-14 from spine-eval args: the model's
 * recurring habit is find_customer → book/search by customerId, never reading
 * the work on file — seven of nine eval failures were this one signature, and
 * every one minted a duplicate job whose booking reply looked perfect.
 */
export function openWorkSteer(verb: 'booked' | 'searched', jobs: Job[]): string {
  const list = jobs
    .map(
      (j) =>
        `'${j.title}' (jobId ${j.id}${j.job_type ? `, ${j.job_type}` : ''}${
          j.duration_minutes ? `, ${j.duration_minutes}m` : ''
        })`,
    )
    .join('; ');
  return (
    `NOT ${verb}: this customer already has open work on file — ${list}. ` +
    'A customerId call describes a brand-NEW job (one job, many visits — a duplicate job ' +
    'splits the record), so pass the matching jobId from that list instead. Pass ' +
    'forceNewJob:true ONLY if this is genuinely different new work.'
  );
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
    // The mint guard: fail closed BEFORE any shell is minted (Tier-1 rule —
    // gate before the irreversible write). Fires on exactly the two shapes
    // every recorded live failure had: NO title (the terse "book them in" —
    // which of the open jobs did the manager mean?), or a title that NAMES a
    // job already on file (the agent parroting the manager's words for work
    // that exists). A DISTINCT new title is itself the declaration of new
    // work and mints without ceremony — the guard adds no friction there.
    if (!input.forceNewJob) {
      const open = await listOpenJobsForCustomer(customer.id);
      const stated = input.title?.trim().toLowerCase();
      const ambiguous = stated
        ? open.some((j) => (j.title ?? '').trim().toLowerCase() === stated)
        : open.length > 0;
      if (ambiguous) throw new Error(openWorkSteer('booked', open));
    }
  }

  // ---- UNPLACED arm (plan 4b-2): the manager explicitly said the time is
  // unsettled. The visit holds a day (or range) and NO times; no overlap
  // pre-check (it claims no slot) and no pattern-based availability advisory
  // (there is no time to check a window against) — but full-day time off on
  // the range is still meaningful, so that half of the advisory stays.
  if (input.timeTbd) {
    if (input.startTime !== undefined || input.endTime !== undefined) {
      throw new Error(
        'timeTbd means NO times — drop startTime/endTime, or book normally with both',
      );
    }
    const earliestDate = input.earliestDate ?? input.date;
    if (!earliestDate) {
      throw new Error('a timeTbd booking needs the day: pass earliestDate (or date)');
    }
    const latestDate = input.latestDate ?? earliestDate;
    if (!DATE_RE.test(earliestDate) || !DATE_RE.test(latestDate)) {
      throw new Error('earliestDate/latestDate must be YYYY-MM-DD');
    }
    if (earliestDate > latestDate) {
      throw new Error('earliestDate must be on or before latestDate');
    }
    // Same duplicate hazard as person-less placed rows, range-keyed: unplaced
    // rows are ALSO exempt from the DB guard, so a transport retry would
    // silently duplicate without this. Technician-keyed — a retry carries the
    // same person-or-nobody, and a DIFFERENT technician on the same range is
    // a legitimate second visit (two trades, same week), not a twin.
    const twins = await listIdenticalUnplacedVisits(
      tenantId,
      earliestDate,
      latestDate,
      technician?.id ?? null,
    );
    if (twins.some((t) => t.customerId === customer.id)) {
      throw new Error(
        `an identical time-TBD visit for ${customer.name} already exists for ` +
          `${earliestDate}${latestDate !== earliestDate ? `–${latestDate}` : ''} — likely a ` +
          'duplicate; place that one, move it, or change its day',
      );
    }
    let warning: string | undefined;
    if (technician) {
      const timeOff = await listTimeOffForTechnician(technician.id, earliestDate, latestDate);
      if (timeOff.length > 0) {
        warning = `${technician.display_name} has time off booked in ${earliestDate}–${latestDate}${
          timeOff[0].reason ? ` (${timeOff[0].reason})` : ''
        }`;
      }
    }
    return {
      technician,
      customer,
      existingJob,
      startTime: null,
      endTime: null,
      startISO: null,
      endISO: null,
      earliestDate,
      latestDate,
      ...(warning ? { warning } : {}),
    };
  }

  const { startTime, endTime } = input;
  if (!input.date || startTime === undefined || endTime === undefined) {
    throw new Error(
      'date, startTime, and endTime are all required — only an explicit timeTbd booking omits times',
    );
  }
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
    earliestDate: null,
    latestDate: null,
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
  // PLACED: date + both times set, range null. UNPLACED (timeTbd): times
  // null, range set, date = the range start (the day the manager named).
  date: string;
  startTime: string | null; // as the manager stated — store these on the stage
  endTime: string | null;
  timeTbd: boolean;
  earliestDate: string | null;
  latestDate: string | null;
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
    date: r.earliestDate ?? (input.date as string),
    startTime: r.startTime,
    endTime: r.endTime,
    timeTbd: r.startISO === null,
    earliestDate: r.earliestDate,
    latestDate: r.latestDate,
    priority: r.existingJob ? r.existingJob.priority : (input.priority ?? 'routine'),
    jobDurationMinutes: r.existingJob
      ? r.existingJob.duration_minutes
      : r.startISO && r.endISO
        ? bookedSpanMinutes(r.startISO, r.endISO)
        : null,
    // ONE-SHOT (rung 9a): booking is what the manager just asked for. The
    // field stays so surfaces need no reshaping when a future gate arrives.
    requiresConfirmation: false,
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
      // A timeTbd booking measures nothing — the shell stays duration-less
      // (fail-closed, never invented; plan 4b-2).
      durationMinutes:
        r.startISO && r.endISO ? bookedSpanMinutes(r.startISO, r.endISO) : null,
    }));

  let assignment: Assignment;
  try {
    assignment = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: r.technician?.id ?? null,
      startsAt: r.startISO,
      endsAt: r.endISO,
      // The unplaced shape (plan 4b-2): range set exactly when times are null.
      earliestDate: r.earliestDate,
      latestDate: r.latestDate,
      status: 'confirmed',
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
        `${r.technician?.display_name ?? 'the technician'} already has a confirmed visit overlapping ${input.date ?? ''} ${r.startTime ?? ''}–${r.endTime ?? ''}`,
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
      ...extraDetail(input.eventDetailExtra), // computed keys below win clashes
      ...(input.reason?.trim() ? { reason: input.reason } : {}),
      ...(r.startISO
        ? { date: input.date, startTime: r.startTime, endTime: r.endTime }
        : {
            timeTbd: true,
            earliestDate: r.earliestDate,
            latestDate: r.latestDate,
          }),
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
  // Extra ledger-event detail — same contract as BookVisitInput's (4b-3).
  eventDetailExtra?: Json;
  actorRef: string;
}

interface ResolvedMove {
  // May be UNPLACED (plan 4b-2): moving an unplaced visit to real times IS
  // the placing verb — the reschedule produces a placed row either way.
  old: Assignment;
  // The TARGET technician. null has two readings — an UNASSIGNED visit staying
  // unassigned (the common case: old.technician_id is null and no ref given),
  // or a roster row that vanished (near-unreachable: techs deactivate, never
  // delete). Discriminate with old.technician_id when it matters.
  technician: Technician | null;
  endTime: string;
  startISO: string;
  endISO: string;
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

  // Default length for the new slot: the old booked span when placed; for an
  // UNPLACED subject there is no span — the job's own recorded length (4b-1)
  // stands in, and when that is null too the manager must state endTime
  // (never invented — the booking doctrine).
  let endTime: string;
  if (input.endTime !== undefined) {
    endTime = input.endTime;
  } else if (isPlaced(old)) {
    endTime = addMinutesClamped(input.startTime, spanMinutes(old.starts_at, old.ends_at));
  } else {
    const movedJob = await getJob(old.job_id);
    if (movedJob?.duration_minutes) {
      endTime = addMinutesClamped(input.startTime, movedJob.duration_minutes);
    } else {
      throw new Error(
        'this visit has no time yet and its job has no recorded length — pass endTime, ' +
          "or set the job's length first (update_job durationMinutes)",
      );
    }
  }
  validateDayAndTimes(input.date, input.startTime, endTime);
  const startISO = naiveLocalISO(input.date, input.startTime);
  const endISO = naiveLocalISO(input.date, endTime);

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
  return { old, technician, endTime, startISO, endISO, ...(warning ? { warning } : {}) };
}

export interface MoveVisitPreview {
  assignmentId: string;
  customerName: string | null;
  technicianName: string | null;
  fromDay: string;
  toDay: string;
  startTime: string;
  endTime: string; // resolved — store on the stage
  unassign: boolean; // true = this move PARKS the visit (detach)
  requiresConfirmation: boolean; // always false since rung 9a — a move is one-shot
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
    fromDay: visitDay(r.old),
    toDay: input.date,
    startTime: input.startTime,
    endTime: r.endTime,
    unassign: !!input.unassign,
    // ONE-SHOT (rung 9a): a move is what the manager just asked for.
    requiresConfirmation: false,
    ...(r.warning ? { warning: r.warning } : {}),
  };
}

export interface MoveVisitResult {
  cancelled: Assignment;
  created: Assignment;
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
        // Caller-supplied detail rides along, so a batch caller can stamp its
        // own identity onto every ledger row it writes — including this
        // stranding one.
        detail: { ...extraDetail(input.eventDetailExtra), toDay: input.date, reason: why },
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
      ...extraDetail(input.eventDetailExtra), // computed keys below win clashes
      fromDay: visitDay(r.old),
      toDay: input.date,
      previousAssignmentId: r.old.id,
    },
  });

  return {
    ...result,
    ...(r.warning ? { warning: r.warning } : {}),
  };
}

export interface UnscheduleVisitInput {
  tenantId: string;
  assignmentId: string;
  reason: string;
  // Extra ledger-event detail — same contract as Book/MoveVisitInput's, so a
  // batch caller can stamp its own identity onto the rows it writes.
  eventDetailExtra?: Json;
  actorRef: string;
}

export interface UnscheduleVisitPreview {
  assignmentId: string;
  customerName: string | null;
  day: string;
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
    day: visitDay(target),
    // The one surviving gate (rung 9a): cancelling a PLACED visit is
    // externally visible — a customer is expecting it. An untimed visit is
    // nobody's appointment yet, so dropping it is one-shot.
    requiresConfirmation: cancelRequiresConfirmation(target),
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
    detail: {
      ...extraDetail(input.eventDetailExtra), // computed keys below win clashes
      day: visitDay(cancelled),
      reason: input.reason,
    },
  });
  return cancelled;
}

// Attach a technician to an UNPLACED visit — or DETACH one (technicianRef
// null) — while KEEPING it unplaced (plan 4b-2 Phase 3): the tray's obvious
// action on a parked time-TBD row must not invent a time, and an attach must
// stay reversible (park it back). Times are immutable by convention (a
// reschedule is cancel + insert), so both directions follow that shape: cancel
// the old row, insert a fresh unplaced row carrying the range/promise.
// Placed rows are refused — move_visit owns them (same times).
export interface AttachUnplacedResult {
  cancelled: Assignment;
  created: Assignment;
}

interface AttachUnplacedGuardInput {
  tenantId: string;
  assignmentId: string;
  technicianRef: string | null; // null = DETACH (park back unassigned)
  // Board policy floor (passed by the board endpoint only — chat keeps its
  // history-correction ability): refuse when the WHOLE range is already past.
  notBeforeDate?: string;
}

// Shared front-half: every guard the commit enforces, writes NOTHING — the
// board previews with exactly these checks (final-review finding: the preview
// used to green-light unconditionally while every sibling write validates at
// preview, so a stale tab walked the picker + confirm into a guaranteed 409).
async function resolveAttachUnplaced(
  input: AttachUnplacedGuardInput,
): Promise<{ old: Assignment; technician: Technician | null }> {
  const { tenantId } = input;
  const old = await getAssignmentForTenant(input.assignmentId, tenantId);
  if (!old) throw new Error('assignment not found');
  if (old.status !== 'confirmed' && old.status !== 'proposed') {
    throw new Error(`cannot attach to a ${old.status} assignment`);
  }
  if (isPlaced(old)) {
    throw new Error('this visit has times — attach a person with move_visit (same day/time)');
  }
  if (input.notBeforeDate && (old.latest_date as string) < input.notBeforeDate) {
    throw new Error(
      'this visit\'s whole day range has passed — recovering it is a chat job ' +
        '(board writes never target the past)',
    );
  }
  if (input.technicianRef === null && old.technician_id === null) {
    throw new Error('this visit is already unassigned');
  }
  const technician = input.technicianRef
    ? await resolveTechnician(tenantId, input.technicianRef)
    : null;
  return { old, technician };
}

export interface AttachUnplacedPreview {
  assignmentId: string;
  technicianRef: string | null; // resolved target; null = detach
  earliestDate: string;
  latestDate: string;
  // An attach is reversible (unassign:true parks it back) — never
  // confirm-gated (the confirmation doctrine).
  requiresConfirmation: false;
}

export async function previewAttachUnplacedVisit(
  input: AttachUnplacedGuardInput,
): Promise<AttachUnplacedPreview> {
  const { old, technician } = await resolveAttachUnplaced(input);
  return {
    assignmentId: old.id,
    technicianRef: technician?.ref ?? null,
    earliestDate: old.earliest_date as string,
    latestDate: old.latest_date as string,
    requiresConfirmation: false,
  };
}

export async function attachUnplacedVisit(
  input: AttachUnplacedGuardInput & {
    reason: string;
    actorRef: string;
  },
): Promise<AttachUnplacedResult> {
  const { tenantId } = input;
  if (!input.reason?.trim()) throw new Error('reason is required for an attach');
  const { old, technician } = await resolveAttachUnplaced(input);
  const cancelled = await updateAssignmentStatus(old.id, 'cancelled', input.reason);
  let created: Assignment;
  try {
    created = await createAssignment({
      tenantId,
      jobId: old.job_id,
      technicianId: technician?.id ?? null,
      startsAt: null,
      endsAt: null,
      earliestDate: old.earliest_date,
      latestDate: old.latest_date,
      status: 'confirmed',
    });
  } catch (err) {
    // Cancel-first means ANY insert failure leaves the visit gone from every
    // reader — say so honestly and ledger the stranding, exactly like
    // moveVisit's identical window (review finding: the bare escape read as a
    // no-op 500 while the visit had really been removed).
    const why = err instanceof Error ? err.message : String(err);
    try {
      await appendScheduleEvent({
        tenantId,
        assignmentId: old.id,
        kind: 'move_failed',
        actorRef: input.actorRef,
        detail: { toDay: visitDay(old), reason: why },
      });
    } catch {
      /* advisory */
    }
    throw new Error(
      `the old row was removed but re-creating the visit failed (${why}) — ` +
        'the visit is currently UNSCHEDULED; book it again',
    );
  }
  // 'moved' so boardNotify's existing copy fires: an attach pushes "a visit
  // landed on your schedule: <day>, time not set" to the new person; a detach
  // pushes "moved off your schedule" to the displaced one (the day/span
  // fallbacks own the unplaced rendering).
  await appendScheduleEvent({
    tenantId,
    assignmentId: created.id,
    kind: 'moved',
    actorRef: input.actorRef,
    detail: {
      fromDay: visitDay(old),
      toDay: visitDay(created),
      attachedTechnicianRef: technician?.ref ?? null,
      previousAssignmentId: old.id,
    },
  });
  return { cancelled, created };
}

// ---- Shared edit cores (plan 4a.5): ONE body per verb, every surface calls it ----
//
// The set_promise / update_job MCP handlers used to hold this logic inline;
// the board endpoints need the same writes, and hand-copying the CAS + ledger
// event is exactly how two surfaces start disagreeing. Handlers keep their
// validation and echo composition; these cores own the guarded write + event.

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
      day: visitDay(row),
      // An unplaced visit has a day but no time — say so rather than crash
      // the cancel preview (its cascade must cover EVERY live row).
      startTime: row.starts_at ? row.starts_at.slice(11, 16) : 'no time set',
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
        day: visitDay(cancelled),
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
