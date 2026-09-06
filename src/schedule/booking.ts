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
  createVisit,
  createJob,
  getVisitForTenant,
  getCustomer,
  getJob,
  getTechnician,
  getTechnicianById,
  isInactiveState,
  isJoinerFailure,
  isOverlapViolation,
  isValidDuration,
  listVisitsForTechnician,
  listParticipants,
  listTimeOffForTechnician,
  listVisitsForJob,
  listIdenticalUnassignedVisits,
  listUntimedVisitsForJob,
  listOpenJobsForCustomer,
  moveVisitRow,
  attachVisitParticipants,
  updateVisitStatus,
  updateJobDetails,
  updateJobStatus,
  isPlaced,
  type Visit,
  type Customer,
  type Job,
  type JobPriority,
  type Json,
  type UpdateJobDetailsInput,
  type Technician,
  type ParticipantRef,
  type WeeklyPattern,
} from '../db/index.js';
import { isTechnicianAvailableOn } from './availability.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// The naive-local storage form: local wall-clock written as if UTC.
export function naiveLocalISO(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00.000Z`;
}

// The day a visit belongs to, for replies and ledger events.
//
// Rung 9a took both fallbacks away. The `promised_day` arm went with the
// promise ladder — what the customer was TOLD is no longer a column, it lives
// in L1 where the agent reads it — and the unplaced range went with the stored
// window. A visit HAS A TIME OR IT DOES NOT, so a row with no start has no day
// to name, and 'no time set' is the honest label. It degrades a label, never a
// booking.
export function visitDay(row: Visit): string {
  return row.starts_at ? row.starts_at.slice(0, 10) : 'no time set';
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

// A PRESENT-but-empty ref or list is an accident — the caller meant to name
// somebody and the value dropped — so it is refused here, in the shared verb,
// rather than read as "nobody" by one surface and "keep them" by another. Both
// callers already refuse it at their own edge; this is the floor under them.
function refuseEmptyCrewFields(
  input: { technicianRef?: string | null; technicianRefs?: string[] },
  omitAdvice: string,
): void {
  if (typeof input.technicianRef === 'string' && input.technicianRef.trim() === '') {
    throw new Error(`technicianRef was empty — pass a roster ref, or ${omitAdvice}`);
  }
  if (input.technicianRefs !== undefined && input.technicianRefs.length === 0) {
    throw new Error(`technicianRefs was empty — list the crew, or ${omitAdvice}`);
  }
}

// A CREW, resolved (rung 9c). `technicianRef` names one person and
// `technicianRefs` names the crew; the union is the crew, deduped, and order is
// the order they were named — that is what the participant tiebreak reads, and
// it is a tiebreak, not a rank. An unknown ref names ITSELF in the error, so
// "book Ben and Jo" tells the manager which of the two is not on the roster.
async function resolveCrew(
  tenantId: string,
  ref: string | undefined,
  refs: string[] | undefined,
): Promise<Technician[]> {
  const seen = new Set<string>();
  const crew: Technician[] = [];
  for (const r of [...(ref ? [ref] : []), ...(refs ?? [])]) {
    if (!r || seen.has(r)) continue;
    seen.add(r);
    crew.push(await resolveTechnician(tenantId, r));
  }
  return crew;
}

// The people on a visit RIGHT NOW, as roster rows. A participant whose
// technician row has vanished is dropped — near-unreachable (techs deactivate,
// they are not deleted), and a name we cannot resolve is not one we can print.
async function currentCrew(visitId: string, tenantId: string): Promise<Technician[]> {
  const out: Technician[] = [];
  for (const p of await listParticipants(visitId)) {
    const t = await getTechnicianById(p.technician_id, tenantId);
    if (t) out.push(t);
  }
  return out;
}

// One phrase for a crew, in a sentence a manager reads: "Ben", "Ben and Joy",
// "Ben, Joy and Sam".
function crewNames(crew: { display_name: string }[]): string {
  const names = crew.map((t) => t.display_name);
  if (names.length <= 1) return names[0] ?? 'the technician';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// The crew as the shape every surface reports (matches db/visits' ParticipantRef).
function crewRefs(crew: Technician[]): ParticipantRef[] {
  return crew.map((t) => ({ technicianId: t.id, ref: t.ref, displayName: t.display_name }));
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
): Promise<Visit[]> {
  const rows = await listVisitsForTechnician(technicianId, startISO, endISO, ['confirmed']);
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
  // The CREW (rung 9c): two technicians on one trip are ONE visit, not two.
  // Merged with technicianRef; either alone is fine, both together is the union.
  technicianRefs?: string[];
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
  // RECORDED EXCEPTION (plan 4b-2, re-cut by rung 9a): omit date AND both
  // times and the visit books UNTIMED — no day, no range, nothing stored about
  // when it should happen. "Sometime next week" is a conversation with the
  // manager's agent, not a column (user ruling 2026-09-05). Partial input is
  // still refused: a date or one time alone is an accident, not an intention.
  startTime?: string; // HH:MM
  endTime?: string; // HH:MM
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
export function cancelRequiresConfirmation(row: Visit): boolean {
  return isPlaced(row);
}

interface ResolvedBooking {
  crew: Technician[]; // empty = unassigned booking
  customer: Customer;
  existingJob: Job | null;
  // PLACED: all four set. UNTIMED: all four null. There is no third shape.
  startTime: string | null;
  endTime: string | null;
  startISO: string | null;
  endISO: string | null;
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
  refuseEmptyCrewFields(input, 'omit the field entirely to book unassigned');
  // No refs = an UNASSIGNED booking: the visit goes on the calendar with nobody
  // attached (attach later via moveVisit). Nobody → no overlap pre-check and no
  // availability advisory; the DB guard likewise ignores participant-less rows.
  const crew = await resolveCrew(tenantId, input.technicianRef, input.technicianRefs);

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

  // ---- UNTIMED arm (plan 4b-2, re-cut by rung 9a): NO date and NO times means
  // the visit is committed but not scheduled. Nothing is stored about when it
  // should happen — no day, no range — because a commitment frozen in a column
  // is stale the moment the customer calls back (user ruling 2026-09-05).
  // No overlap pre-check (it claims no slot) and no availability advisory
  // (there is no date to check anything against).
  if (input.date === undefined && input.startTime === undefined && input.endTime === undefined) {
    // Same duplicate hazard as person-less placed rows: untimed rows are ALSO
    // exempt from the DB overlap guard, so a transport retry would silently
    // duplicate without this. Keyed on the JOB (the range that used to key it
    // is gone) and on the technician — a retry carries the same
    // person-or-nobody, while a second untimed visit on a DIFFERENT job for
    // one customer is legitimate work, not a twin.
    if (existingJob) {
      // Keyed on the FIRST of the crew: a retry carries the same crew in the
      // same order, so the same first person — and a genuinely different
      // second visit for one job is what the manager is told to explain.
      const twins = await listUntimedVisitsForJob(
        tenantId,
        existingJob.id,
        crew[0]?.id ?? null,
      );
      if (twins.length > 0) {
        throw new Error(
          `an untimed visit for ${customer.name} already exists on this job — likely a ` +
            'duplicate; place that one, or say what makes this a second visit',
        );
      }
    }
    return {
      crew,
      customer,
      existingJob,
      startTime: null,
      endTime: null,
      startISO: null,
      endISO: null,
    };
  }

  const { startTime, endTime } = input;
  if (!input.date || startTime === undefined || endTime === undefined) {
    throw new Error(
      'a booking needs the date AND both times, or none of the three (an untimed visit) — ' +
        'never some of them. Ask the manager for the missing piece rather than inventing it',
    );
  }
  validateDayAndTimes(input.date, startTime, endTime);
  const startISO = naiveLocalISO(input.date, startTime);
  const endISO = naiveLocalISO(input.date, endTime);

  if (crew.length > 0) {
    // PER PERSON — one busy crew member refuses the whole trip, and the error
    // names WHICH one. (The DB exclusion is still the authority under a race;
    // this is the check that can explain itself.)
    for (const t of crew) {
      const clashes = await overlappingConfirmed(t.id, startISO, endISO);
      if (clashes.length > 0) {
        throw new Error(
          `${t.display_name} already has a confirmed visit overlapping ${input.date} ${startTime}–${endTime}`,
        );
      }
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
  // One advisory line per person who is off that day — a crew where both are
  // off should say both, or the manager fixes one and re-hits the other.
  const warnings: string[] = [];
  for (const t of crew) {
    const w = await availabilityWarning(t, input.date, startISO);
    if (w) warnings.push(w);
  }
  const warning = warnings.length > 0 ? warnings.join('; ') : undefined;
  return {
    crew,
    customer,
    existingJob,
    startTime,
    endTime,
    startISO,
    endISO,
    ...(warning ? { warning } : {}),
  };
}

export interface BookVisitPreview {
  // FIRST-OR-NULL, kept for every caller that shows one name. The crew is
  // technicianRefs/technicianNames — read those when the answer may be two
  // people (rung 9c).
  technicianRef: string | null; // null = unassigned booking
  technicianName: string | null;
  technicianRefs: string[];
  technicianNames: string[];
  participants: ParticipantRef[];
  customerId: string;
  customerName: string;
  newJob: boolean; // true = confirming will mint a job shell
  jobTitle: string | null;
  // PLACED: date + both times set. UNTIMED: all three null — the visit is
  // committed, and nothing is recorded about when it should happen.
  date: string | null;
  startTime: string | null; // as the manager stated — store these on the stage
  endTime: string | null;
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
    technicianRef: r.crew[0]?.ref ?? null,
    technicianName: r.crew[0]?.display_name ?? null,
    technicianRefs: r.crew.map((t) => t.ref),
    technicianNames: r.crew.map((t) => t.display_name),
    participants: crewRefs(r.crew),
    customerId: r.customer.id,
    customerName: r.customer.name,
    newJob: r.existingJob === null,
    jobTitle: r.existingJob?.title ?? input.title ?? null,
    date: r.startISO ? (input.date as string) : null,
    startTime: r.startTime,
    endTime: r.endTime,
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
  assignment: Visit;
  job: Job;
  customer: Customer;
  // Everybody who went, in the order they were named. `technicianRefs` is the
  // list a surface echoes; `participants` carries the ids with it.
  technicianRefs: string[];
  technicianNames: string[];
  participants: ParticipantRef[];
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
      // An UNTIMED booking measures nothing — the shell stays duration-less
      // (fail-closed, never invented; plan 4b-2).
      durationMinutes:
        r.startISO && r.endISO ? bookedSpanMinutes(r.startISO, r.endISO) : null,
    }));

  let assignment: Visit;
  try {
    assignment = await createVisit({
      tenantId,
      jobId: job.id,
      technicianIds: r.crew.map((t) => t.id),
      startsAt: r.startISO,
      endsAt: r.endISO,
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
      // Only reachable with somebody attached — the DB guard never fires on a
      // participant-less row. Which crew member lost the race is not in the
      // SQLSTATE, so the message names the crew; for the ordinary one-person
      // booking it reads exactly as it always did.
      throw new Error(
        `${crewNames(r.crew)} already has a confirmed visit overlapping ${input.date ?? ''} ${r.startTime ?? ''}–${r.endTime ?? ''}`,
      );
    }
    throw err;
  }

  await appendScheduleEvent({
    tenantId,
    visitId: assignment.id,
    kind: 'booked',
    actorRef: input.actorRef,
    detail: {
      ...extraDetail(input.eventDetailExtra), // computed keys below win clashes
      ...(input.reason?.trim() ? { reason: input.reason } : {}),
      ...(r.startISO
        ? { date: input.date, startTime: r.startTime, endTime: r.endTime }
        : { untimed: true }),
      // The CREW, not one person (rung 9c). The old singular key is not
      // written any more: a reader that took it would have been told one name
      // for a two-person trip, which is the failure this rung removes.
      technicianRefs: r.crew.map((t) => t.ref),
      customerId: r.customer.id,
      jobId: job.id,
    },
  });

  return {
    assignment,
    job,
    customer: r.customer,
    technicianRefs: r.crew.map((t) => t.ref),
    technicianNames: r.crew.map((t) => t.display_name),
    participants: crewRefs(r.crew),
    ...(r.warning ? { warning: r.warning } : {}),
  };
}

export interface MoveVisitInput {
  tenantId: string;
  visitId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime?: string; // HH:MM, default = preserve the old duration
  technicianRef?: string; // omit = same crew
  // The crew AFTER the move — it REPLACES whoever is on the visit, it does not
  // add to them (user, 2026-09-06). Omit both ref fields to keep the crew as
  // it is; unassign:true empties it.
  technicianRefs?: string[];
  unassign?: boolean; // true = DETACH: park the visit person-less (plan 4a.5)
  reason: string;
  // Extra ledger-event detail — same contract as BookVisitInput's (4b-3).
  eventDetailExtra?: Json;
  actorRef: string;
}

interface ResolvedMove {
  // May be UNPLACED (plan 4b-2): moving an unplaced visit to real times IS
  // the placing verb — the reschedule produces a placed row either way.
  old: Visit;
  // The crew AFTER the move. Empty means nobody goes — either a park
  // (unassign) or an unassigned visit staying unassigned.
  crew: Technician[];
  // Who is on it NOW, so the caller can record who left without re-reading.
  currentCrewIds: string[];
  // Did the caller say anything about WHO? false = keep the crew untouched,
  // which is what lets a pure time-move leave a two-person trip alone.
  crewGiven: boolean;
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
  const old = await getVisitForTenant(input.visitId, tenantId);
  if (!old) throw new Error('visit not found');
  if (old.status !== 'confirmed' && old.status !== 'proposed') {
    throw new Error(`cannot move a ${old.status} visit`);
  }

  refuseEmptyCrewFields(input, 'omit it to keep the crew, or pass unassign:true to park the visit');
  if (input.unassign && (input.technicianRef || (input.technicianRefs?.length ?? 0) > 0)) {
    throw new Error(
      'pass ONE of technicianRef/technicianRefs (attach/reassign) or unassign:true (park the ' +
        'visit) — not both',
    );
  }
  // Resolve the TARGET technician either way — the availability warning must
  // fire for a same-technician move onto an off-day too (review finding).
  // An unassigned row moved without a ref stays unassigned (technician null);
  // passing a ref is how a person gets ATTACHED to an unassigned visit;
  // unassign:true DETACHES — the target is nobody, so there is no availability
  // advisory and no overlap pre-check (NULL rows are exempt from the DB guard).
  const crewGiven =
    !!input.unassign || input.technicianRef !== undefined || input.technicianRefs !== undefined;
  const currentCrewIds = (await listParticipants(old.id)).map((p) => p.technician_id);
  const crew = input.unassign
    ? []
    : input.technicianRef !== undefined || input.technicianRefs !== undefined
      ? await resolveCrew(tenantId, input.technicianRef, input.technicianRefs)
      : await currentCrew(old.id, tenantId);

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
  if (crew.length > 0) {
    // PER PERSON, excluding the moved row itself. One busy crew member refuses
    // the whole move — the trip is one object, so it goes as a unit or not at
    // all. Somebody who is LEAVING is not checked: they are not going.
    for (const t of crew) {
      const clashes = await overlappingConfirmed(t.id, startISO, endISO, old.id);
      if (clashes.length > 0) {
        throw new Error(
          `that slot overlaps a confirmed visit for ${t.display_name} on ${input.date} — ` +
            'the booking was NOT moved',
        );
      }
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
  const warnings: string[] = [];
  for (const t of crew) {
    const w = await availabilityWarning(t, input.date, startISO);
    if (w) warnings.push(w);
  }
  const warning = warnings.length > 0 ? warnings.join('; ') : undefined;
  return {
    old,
    crew,
    currentCrewIds,
    crewGiven,
    endTime,
    startISO,
    endISO,
    ...(warning ? { warning } : {}),
  };
}

export interface MoveVisitPreview {
  visitId: string;
  customerName: string | null;
  technicianName: string | null; // first-or-null; the crew is technicianNames
  technicianRefs: string[];
  technicianNames: string[];
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
    visitId: r.old.id,
    customerName: customer?.name ?? null,
    technicianName: r.crew[0]?.display_name ?? null,
    technicianRefs: r.crew.map((t) => t.ref),
    technicianNames: r.crew.map((t) => t.display_name),
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
  // ONE row, the SAME id it had before (rung 9b). There is no `cancelled`/
  // `created` pair any more: a move edits the visit, so nothing is destroyed
  // and nothing is minted. `previousTechnicianIds` is what the board's push
  // needs to tell the people who LOST the visit — a LIST since rung 9c, and
  // the only shape, now that no column names one person.
  visit: Visit;
  previousTechnicianIds: string[];
  technicianRefs: string[];
  participants: ParticipantRef[];
  // Named when the visit MOVED but somebody could not be added to it — they
  // are booked elsewhere at the new time. The move is real; the omission is
  // real; both get said.
  crewNotAdded: string[];
  warning?: string;
}

export async function moveVisit(input: MoveVisitInput): Promise<MoveVisitResult> {
  const { tenantId } = input;
  const r = await resolveMove(input);
  const previousTechnicianIds = r.currentCrewIds;
  const fromDay = visitDay(r.old);

  // ONE statement, so there is no window to be stranded in. The old code
  // cancelled first and inserted second, which meant an overlap raced at
  // exactly the wrong moment left the visit CANCELLED WITH NO SUCCESSOR and
  // the caller apologising for a booking it had destroyed. An UPDATE that
  // trips the exclusion constraint changes nothing at all, so the honest
  // report is simply "that slot is taken".
  let visit: Visit;
  let joinerFailure: unknown;
  try {
    visit = await moveVisitRow(r.old.id, {
      // Omitted entirely when the caller said nothing about WHO — that is what
      // keeps a pure time-move from re-writing a two-person crew.
      ...(r.crewGiven ? { technicianIds: r.crew.map((t) => t.id) } : {}),
      startsAt: r.startISO,
      endsAt: r.endISO,
      reason: input.reason,
      status: 'confirmed', // a moved visit is on the schedule, never 'proposed'
    });
  } catch (err) {
    // A JOINER failure is not a refusal: the visit HAS moved and one person
    // could not come along. Falling into the branch below would tell the
    // manager the opposite of what happened, so it is handled after the move
    // as a warning on a real result (see below).
    if (isJoinerFailure(err)) {
      joinerFailure = err;
      visit = (err as { visit: Visit }).visit;
    } else if (isOverlapViolation(err)) {
      throw new Error(
        `${crewNames(r.crew)} already has a confirmed visit ` +
          `overlapping ${input.date} ${input.startTime}–${r.endTime} — the visit has NOT moved`,
      );
    } else {
      throw err;
    }
  }

  // READ BACK who is actually on it, rather than assuming the intended crew
  // landed: on a joiner failure the whole upsert rolled back, so the ledger and
  // the pushes must record the trip as it really is.
  const landed = await currentCrew(visit.id, tenantId);
  const landedIds = new Set(landed.map((t) => t.id));
  const notAdded = r.crew.filter((t) => !landedIds.has(t.id));
  // WHICH of them is actually busy. The upsert is one statement, so a single
  // collision rolls back every joiner — saying "they already have a confirmed
  // visit there" about all of them would tell the manager something false about
  // the innocent ones. Re-check each at the new slot and name only the busy.
  let crewWarning: string | undefined;
  if (joinerFailure && notAdded.length > 0) {
    const busy: Technician[] = [];
    for (const t of notAdded) {
      if ((await overlappingConfirmed(t.id, r.startISO, r.endISO, visit.id)).length > 0) busy.push(t);
    }
    const where = `moved to ${input.date} ${input.startTime}–${r.endTime}, but `;
    // If the joiners were the WHOLE crew, the trip is now unassigned. Say it:
    // the move landed, the people did not, and a visit nobody is going on is
    // not something to leave the manager to discover.
    const empty = landed.length === 0 ? ' — NOBODY is on this visit now' : '';
    crewWarning =
      busy.length === notAdded.length
        ? `${where}${crewNames(notAdded)} already has a confirmed visit there — they were NOT added${empty}`
        : `${where}${crewNames(notAdded)} could not be added` +
          (busy.length > 0 ? ` (${crewNames(busy)} already has a confirmed visit there)` : '') +
          empty;
  }

  await appendScheduleEvent({
    tenantId,
    visitId: visit.id,
    kind: 'moved',
    actorRef: input.actorRef,
    detail: {
      ...extraDetail(input.eventDetailExtra), // computed keys below win clashes
      fromDay,
      toDay: input.date,
      // The visit keeps its id now, so "who held it before" is the thing a
      // reader actually needs — the old id would just be this one. Both sides
      // are LISTS since rung 9c: a crew move has several people on each.
      previousTechnicianIds,
      technicianRefs: landed.map((t) => t.ref),
    },
  });

  return {
    visit,
    previousTechnicianIds,
    technicianRefs: landed.map((t) => t.ref),
    participants: crewRefs(landed),
    crewNotAdded: notAdded.map((t) => t.ref),
    ...(r.warning || crewWarning
      ? { warning: [crewWarning, r.warning].filter(Boolean).join('; ') }
      : {}),
  };
}

export interface UnscheduleVisitInput {
  tenantId: string;
  visitId: string;
  reason: string;
  // Extra ledger-event detail — same contract as Book/MoveVisitInput's, so a
  // batch caller can stamp its own identity onto the rows it writes.
  eventDetailExtra?: Json;
  actorRef: string;
}

export interface UnscheduleVisitPreview {
  visitId: string;
  customerName: string | null;
  day: string;
  requiresConfirmation: boolean; // the doctrine's verdict for this cancel
}

export async function previewUnscheduleVisit(
  tenantId: string,
  visitId: string,
): Promise<UnscheduleVisitPreview> {
  const target = await getVisitForTenant(visitId, tenantId);
  if (!target) throw new Error('visit not found');
  if (target.status !== 'confirmed' && target.status !== 'proposed') {
    throw new Error(`cannot unschedule a ${target.status} visit`);
  }
  const job = await getJob(target.job_id);
  const customer = job ? await getCustomer(job.customer_id) : null;
  return {
    visitId: target.id,
    customerName: customer?.name ?? null,
    day: visitDay(target),
    // The one surviving gate (rung 9a): cancelling a PLACED visit is
    // externally visible — a customer is expecting it. An untimed visit is
    // nobody's appointment yet, so dropping it is one-shot.
    requiresConfirmation: cancelRequiresConfirmation(target),
  };
}

export async function unscheduleVisit(input: UnscheduleVisitInput): Promise<Visit> {
  if (!input.reason?.trim()) throw new Error('reason is required for an unschedule');
  // Tenant guard first — this module is the reuse surface for Plans 2–3, and
  // updateVisitStatus alone is id-only.
  const target = await getVisitForTenant(input.visitId, input.tenantId);
  if (!target) throw new Error('visit not found');
  // Actionable message when the row went terminal between stage and confirm.
  // Since rung 9b a move EDITS the row, so the id never changes underneath a
  // staged confirmation — what can still happen is that someone cancelled it,
  // or a field note marked it completed. The raw state-machine error
  // ("cancelled → cancelled") tells the manager nothing useful.
  if (target.status !== 'confirmed' && target.status !== 'proposed') {
    throw new Error(
      `cannot unschedule a ${target.status} visit — it may have been cancelled already, or a ` +
        'field note may have reported it as done; check get_team_schedule for its current state',
    );
  }
  const cancelled = await updateVisitStatus(target.id, 'cancelled', input.reason);
  await appendScheduleEvent({
    tenantId: input.tenantId,
    visitId: cancelled.id,
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
  // Same shape and same reason as MoveVisitResult: attaching a person edits the
  // visit, so its id survives and the tray row the manager tapped still exists.
  visit: Visit;
  previousTechnicianIds: string[];
  technicianRefs: string[];
}

interface AttachUnplacedGuardInput {
  tenantId: string;
  visitId: string;
  technicianRef: string | null; // null = DETACH (park back unassigned)
  // The crew, same contract as move: it REPLACES whoever is on the visit.
  technicianRefs?: string[];
}

// Shared front-half: every guard the commit enforces, writes NOTHING — the
// board previews with exactly these checks (final-review finding: the preview
// used to green-light unconditionally while every sibling write validates at
// preview, so a stale tab walked the picker + confirm into a guaranteed 409).
async function resolveAttachUnplaced(
  input: AttachUnplacedGuardInput,
): Promise<{ old: Visit; crew: Technician[]; currentIds: string[] }> {
  const { tenantId } = input;
  const old = await getVisitForTenant(input.visitId, tenantId);
  if (!old) throw new Error('visit not found');
  if (old.status !== 'confirmed' && old.status !== 'proposed') {
    throw new Error(`cannot attach to a ${old.status} visit`);
  }
  if (isPlaced(old)) {
    throw new Error('this visit has times — attach a person with move_visit (same day/time)');
  }
  // The board's past-date floor used to live here, comparing the stored range
  // to today. Rung 9a deleted the range: an untimed visit holds no date, so
  // there is nothing that can have passed and nothing to refuse.
  const detaching = !input.technicianRef && (input.technicianRefs?.length ?? 0) === 0;
  const currentIds = (await listParticipants(old.id)).map((p) => p.technician_id);
  if (detaching && currentIds.length === 0) {
    throw new Error('this visit is already unassigned');
  }
  const crew = detaching
    ? []
    : await resolveCrew(tenantId, input.technicianRef ?? undefined, input.technicianRefs);
  return { old, crew, currentIds };
}

export interface AttachUnplacedPreview {
  visitId: string;
  technicianRef: string | null; // resolved target, first-or-null; null = detach
  technicianRefs: string[];
  // An attach is reversible (unassign:true parks it back) — never
  // confirm-gated (the confirmation doctrine).
  requiresConfirmation: false;
}

export async function previewAttachUnplacedVisit(
  input: AttachUnplacedGuardInput,
): Promise<AttachUnplacedPreview> {
  const { old, crew } = await resolveAttachUnplaced(input);
  return {
    visitId: old.id,
    technicianRef: crew[0]?.ref ?? null,
    technicianRefs: crew.map((t) => t.ref),
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
  const { old, crew, currentIds } = await resolveAttachUnplaced(input);

  // An attach only changes WHO — the visit stays untimed. One guarded UPDATE,
  // so the row the manager tapped in the tray cannot vanish underneath them
  // (which is exactly what the old cancel-then-insert could do on a failure).
  const visit = await attachVisitParticipants(old.id, {
    technicianIds: crew.map((t) => t.id),
    reason: input.reason,
    status: 'confirmed', // never leave it 'proposed' — see the note on the core
  });

  // 'moved' so boardNotify's existing copy fires: an attach pushes "a visit
  // landed on your schedule: <day>, time not set" to the new person; a detach
  // pushes "moved off your schedule" to the displaced one (the day/span
  // fallbacks own the unplaced rendering).
  await appendScheduleEvent({
    tenantId,
    visitId: visit.id,
    kind: 'moved',
    actorRef: input.actorRef,
    detail: {
      fromDay: visitDay(old),
      toDay: visitDay(visit),
      attachedTechnicianRefs: crew.map((t) => t.ref),
      previousTechnicianIds: currentIds,
    },
  });
  return {
    visit,
    previousTechnicianIds: currentIds,
    technicianRefs: crew.map((t) => t.ref),
  };
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
  visitId: string;
  day: string;
  startTime: string;
  technicianRef: string | null; // first-or-null; the crew is technicianRefs
  technicianRefs: string[];
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

const liveRowsForJob = async (jobId: string): Promise<Visit[]> =>
  (await listVisitsForJob(jobId)).filter(
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
  const refOf = async (technicianId: string): Promise<string | null> => {
    if (!refCache.has(technicianId)) {
      const t = await getTechnicianById(technicianId, tenantId);
      refCache.set(technicianId, t?.ref ?? null);
    }
    return refCache.get(technicianId) ?? null;
  };
  const visits: CancelJobVisit[] = [];
  for (const row of rows) {
    // EVERY person on the trip — a crew cancellation that named one of two
    // would leave the manager telling half the people who need telling.
    const refs: string[] = [];
    for (const p of await listParticipants(row.id)) {
      const ref = await refOf(p.technician_id);
      if (ref) refs.push(ref);
    }
    visits.push({
      visitId: row.id,
      day: visitDay(row),
      // An unplaced visit has a day but no time — say so rather than crash
      // the cancel preview (its cascade must cover EVERY live row).
      startTime: row.starts_at ? row.starts_at.slice(11, 16) : 'no time set',
      technicianRef: refs[0] ?? null,
      technicianRefs: refs,
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
  cancelledVisits: Visit[];
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
  const cancelledVisits: Visit[] = [];
  for (const row of await liveRowsForJob(job.id)) {
    const cancelled = await updateVisitStatus(row.id, 'cancelled', input.reason);
    cancelledVisits.push(cancelled);
    await appendScheduleEvent({
      tenantId,
      visitId: cancelled.id,
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
