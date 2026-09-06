import {
  appendRawCapture,
  findRetractionsFor,
  getRawCaptureByExternalId,
  captureHasLinkedL2,
  isUniqueViolation,
  type RawCapture,
  createCustomer,
  createJob,
  getJob,
  listJobsForCustomer,
  updateJobStatus,
  insertVisitNote,
  recordVisitReport,
  updateVisitStatus,
  stageOf,
  appendScheduleEvent,
  getTechnician,
  getTenant,
  ALLOWED_TRANSITIONS,
  type CaptureChannel,
  type Job,
  type JobStatus,
  type Json,
} from '../db/index.js';
import { defaultExtractor, type Extractor, type ExtractedFields } from './extract.js';
import { matchIdentity, type MatchResult, type ScheduledCustomerDraft } from './identityMatch.js';
import { resolveVisitForNote } from './attachNote.js';

// Identity resolved during the staged-confirm flow (MCP tool path): commit must
// use EXACTLY what the preview showed, so the resolution travels here and
// matchIdentity is skipped entirely — a commit-time re-match could resolve
// differently (e.g. the schedule branch keys on the calendar day, which can
// change between stage and confirm).
export interface ResolvedIdentity {
  customerId?: string;
  jobId?: string;
  createFrom?: ScheduledCustomerDraft;
}

export interface RecordFieldNoteInput {
  tenantId: string;
  technicianRef: string;
  text?: string | null;
  blobPath?: string | null;
  channel: CaptureChannel;
  // Staged-confirm path only: pre-resolved identity; skips matchIdentity.
  // (There is deliberately NO `confirmed` passthrough here: a caller-supplied
  // customerId would win outright in matchIdentity with no tenant check at
  // this layer — the tenant guard lives in the MCP dispatch, which resolves
  // identity itself and passes the result via `resolved`.)
  resolved?: ResolvedIdentity;
  // Inbound-connector provenance (Composio webhooks, Gmail message id) AND the
  // staged-confirm idempotency stamp (`note:<confirmId>`). externalId dedups
  // the L1 insert per tenant; occurredAt/sourceMeta land in metadata JSONB.
  externalId?: string | null;
  occurredAt?: string | null;
  sourceMeta?: Json;
  // Caller-ID fallback (phone channel): when the transcript yields no phone,
  // use this as extracted.phone so a REPEAT caller auto-matches by their number.
  // Inert when unset (email / tech notes pass nothing) — the only phone-specific
  // hook in the shared write-path.
  fallbackPhone?: string | null;
  // L1-only switch (default true = structure). When explicitly false, append the
  // verbatim capture to L1 and STOP — no extract, no match, no L2/L3. The phone
  // router uses this for a non-`new_job` call: the transcript is always kept as
  // the call log, but a cancel/complaint/question must NOT auto-build a job (it
  // routes to a pushed human review instead). Gate before-L2, never before-L1.
  structure?: boolean;
}

export interface RecordFieldNoteResult {
  status: 'matched' | 'needs_confirmation' | 'needs_disambiguation' | 'duplicate' | 'captured';
  captureId: string;
  customerId?: string;
  jobId?: string;
  visitId?: string;
  /** The trip's lifecycle in one word once a note has landed on it. */
  stage?: string;
  suggestion?: { address: string; visitId: string };
}

// Terminal job states (no outgoing transitions) — never reused for a new note.
const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(
  (Object.keys(ALLOWED_TRANSITIONS) as JobStatus[]).filter(
    (status) => ALLOWED_TRANSITIONS[status].length === 0,
  ),
);

// Which statusSignal moves a NOTE may drive. Notes speak about the WORK
// dimension only — start, finish, reopen. The money tail (invoiced/paid) is
// derived from money_events by syncJobStatusForMoney, so a late "job done"
// note on an already-invoiced job is stale news, not a reversal: without this
// subset, the machine's invoiced→completed edge (added for void walk-downs)
// would let that note quietly demote the job (money-ledger review finding).
// Exported so a test pins the subset invariant (every edge here must exist in
// ALLOWED_TRANSITIONS) — the runtime relies on updateJobStatus re-validating.
export const NOTE_SIGNAL_TRANSITIONS: Partial<
  Record<JobStatus, ReadonlyArray<'completed' | 'in_progress'>>
> = {
  open: ['in_progress'],
  in_progress: ['completed'],
  completed: ['in_progress'], // reopen — blessed by the money-ledger plan
};

// The channel-agnostic write-path: raw in first (L1), then extract → match →
// structure (L2/L3), evidence always linked via source_capture_id. raw_captures
// is append-only, so provenance is never written back onto the capture.
export async function recordFieldNote(
  input: RecordFieldNoteInput,
  deps: { extract?: Extractor } = {},
): Promise<RecordFieldNoteResult> {
  const extract = deps.extract ?? defaultExtractor;
  const { tenantId, technicianRef, channel } = input;

  // (1) L1 first — append the verbatim note.
  let captureId: string;
  let rawText: string;
  let capturedAt: string;
  {
    // Dedup with partial-failure healing. A capture with this (tenant, externalId)
    // may already exist from a prior delivery:
    //   - fully processed (an L2 row links back) → real duplicate, no-op.
    //   - orphan (L1 written, but extract/match threw before L2) → REUSE that L1 row
    //     and re-run extract→L2 now, so a redelivery (pull-window overlap or webhook
    //     retry) heals it instead of being short-circuited to a no-op forever.
    // Note: a work-but-UNMATCHED email also has no L2 (by design — raw kept, no match
    // yet), so it is indistinguishable from an orphan here and re-runs extract on every
    // redelivery. Harmless (it writes nothing while still unresolved), just a repeat
    // model call. Append-only L1 can't carry a "processed" flag, so we accept the
    // re-run rather than mutate the capture.
    // RUNG 9B WIDENED THAT CASE, deliberately: a non-technician capture (email,
    // call, web form) no longer mints a visit, because `visits` IS the schedule
    // now and a customer's email is not a trip. So when such a note resolves to
    // an EXISTING customer AND an existing open job, nothing new carries the
    // capture id and this dedup misses — same bounded cost as above, one repeat
    // extractor call, and pinned as writing nothing twice in
    // recordFieldNote.test.ts ("redelivered onto an EXISTING customer+job").
    // The technician path is unaffected: it always writes a visit_notes link,
    // which captureHasLinkedL2 reads.
    let landed: RawCapture | null = null;

    if (input.externalId) {
      const dup = await getRawCaptureByExternalId(tenantId, input.externalId);
      if (dup) {
        if (await captureHasLinkedL2(dup.id)) return { status: 'duplicate', captureId: dup.id };
        // A RETRACTED unmatched capture is NOT an orphan to heal: rebuilding
        // L2 from a row someone marked recorded-in-error would resurrect it
        // (review finding — webhook redelivery after a manager retraction).
        if ((await findRetractionsFor([dup.id])).length > 0) {
          return { status: 'duplicate', captureId: dup.id };
        }
        landed = dup; // orphan → heal on this delivery
      }
    }

    if (!landed) {
      try {
        landed = await appendRawCapture({
          tenantId,
          channel,
          technicianRef,
          rawText: input.text ?? null,
          blobPath: input.blobPath ?? null,
          externalId: input.externalId,
          metadata: buildCaptureMetadata(input.sourceMeta, input.occurredAt),
          // Staged-confirm path (2026-08-14): the identity was resolved — and
          // tenant-guarded — BEFORE this insert, so stamp it AT the append.
          // L1 is immutable, and an unstamped note is invisible to every
          // stamped-capture reader (listRecentCapturesForCustomer); relying
          // on the L2 visit link alone made a perfectly-executed staged note
          // read as attributed to nobody. The inbound path still appends
          // unstamped: there identity genuinely resolves after L1.
          ...(input.resolved?.customerId ? { customerId: input.resolved.customerId } : {}),
          ...(input.resolved?.jobId ? { jobId: input.resolved.jobId } : {}),
        });
      } catch (err) {
        // TOCTOU backstop: a concurrent delivery of the same externalId won the race
        // on uq_raw_captures_external_id. Re-read its row; if already processed →
        // duplicate, else heal it. (Append-only forbids upsert, so insert-then-catch
        // -23505 is the only correct path.)
        if (input.externalId && isUniqueViolation(err)) {
          const dup = await getRawCaptureByExternalId(tenantId, input.externalId);
          if (!dup) throw err;
          if (await captureHasLinkedL2(dup.id)) return { status: 'duplicate', captureId: dup.id };
          // Same retracted-is-terminal rule as the fast path above.
          if ((await findRetractionsFor([dup.id])).length > 0) {
            return { status: 'duplicate', captureId: dup.id };
          }
          landed = dup;
        } else {
          throw err;
        }
      }
    }

    captureId = landed.id;
    rawText = landed.raw_text ?? input.text ?? '';
    capturedAt = landed.captured_at;
  }

  // L1-only mode: the verbatim capture is stored (and any orphan healed / dup
  // detected above), but no L2 is built. Placed AFTER the dedup/heal block so a
  // redelivered captured call re-returns 'captured' rather than re-running an
  // extract that would never link L2 anyway. The phone router's non-`new_job`
  // path lands here — the call log is kept, the human review carries the action.
  if (input.structure === false) return { status: 'captured', captureId };

  // (2-3) AI extraction of candidate fields.
  // Pass the cost context: this is the extractor's PRODUCTION billing path.
  // The inbound-email webhook and the Gmail pull both call recordFieldNote with
  // no deps.extract, so they fall through to the live model here — instrumenting
  // only the MCP staging call would have missed the highest-volume consumer.
  const extracted = await extract(rawText, { tenantId, technicianRef });

  // Caller-ID fallback: the inbound call's `From` is a strong identity key the
  // transcript often lacks. Apply it only when extraction found no phone, and
  // BEFORE matchIdentity reads extracted.phone.
  if (!extracted.phone && input.fallbackPhone) {
    extracted.phone = input.fallbackPhone;
  }

  // (4) identity: pre-resolved (staged-confirm path — preview == commit, no
  // re-match) or the deterministic matcher (inbound path).
  let match: MatchResult;
  if (input.resolved) {
    match = input.resolved.customerId
      ? { status: 'matched', customerId: input.resolved.customerId, jobId: input.resolved.jobId }
      : { status: 'needs_disambiguation', createFrom: input.resolved.createFrom };
  } else {
    match = await matchIdentity({
      tenantId,
      technicianRef,
      capturedAt,
      extracted,
    });
  }

  // (6) Unresolved and nothing resolved → hand back to the caller.
  // (Inbound: the capture stays L1-only until a later delivery resolves it.)
  if (match.status !== 'matched' && !input.resolved) {
    return { status: match.status, captureId, suggestion: match.suggestion };
  }

  // (5) Resolve the customer: matched existing, or create-new from the confirmed
  // + extracted details on an explicit resume.
  let customerId: string;
  if (match.status === 'matched' && match.customerId) {
    customerId = match.customerId;
  } else {
    // Create-new: prefer a scheduled entry's denormalized fields (match.createFrom)
    // when present, falling back to the extracted/confirmed details.
    const draft = match.createFrom;
    const created = await createCustomer({
      tenantId,
      name: draft?.customerName?.trim() || extracted.customerName?.trim() || 'Unknown customer',
      phone: draft?.phone ?? extracted.phone ?? null,
      addressLine1: draft?.addressLine1 ?? extracted.address ?? null,
      city: draft?.city ?? extracted.city ?? null,
      state: draft?.state ?? extracted.state ?? null,
      postalCode: draft?.postalCode ?? extracted.postalCode ?? null,
      sourceCaptureId: captureId,
    });
    customerId = created.id;
  }

  // Resolve the job: a matcher-supplied job, else the most recent non-terminal
  // job for the customer, else a new one.
  let job: Job | null = match.jobId ? await getJob(match.jobId) : null;
  if (!job) {
    const jobs = await listJobsForCustomer(customerId);
    job = [...jobs].reverse().find((candidate) => !TERMINAL_STATUSES.has(candidate.status)) ?? null;
  }
  if (!job) {
    job = await createJob({
      tenantId,
      customerId,
      title: extracted.jobTitle ?? null,
      jobType: extracted.jobType ?? null,
      sourceCaptureId: captureId,
    });
  }

  // WHICH TRIP IS THIS NOTE ABOUT? (rung 9b phase 3 — see attachNote.ts.)
  //
  // It used to mint a row per note, which was harmless only while `visits` was
  // a table nothing scheduled from. Now a note ATTACHES to the trip it reports:
  // the visit placed on its own firm-local day, else the job's one live visit,
  // else — for a technician channel only — a new one, already happened.
  //
  // ATTACH runs for EVERY channel. A customer's email answering a question
  // about a booked visit is evidence about that trip, and linking nothing left
  // it invisible to the planner's evidence read and the watcher's activity
  // probe — which is how a customer's own answer could leave a gap looking
  // unanswered. Only CREATE is technician-gated: an email is not a trip.
  const isTechnicianChannel =
    channel === 'technician_voice' || channel === 'technician_photo' || channel === 'technician_note';
  // The person column is a real foreign key now, not the old free TEXT name:
  // resolve the badge's roster ref, and leave it null when the ref is not on
  // this tenant's roster rather than inventing a link.
  const technician = await getTechnician(tenantId, technicianRef);
  const timezone = (await getTenant(tenantId))?.timezone ?? 'UTC';
  const noteAttributes = buildVisitAttributes(extracted);
  const resolved = await resolveVisitForNote({
    tenantId,
    jobId: job.id,
    technicianId: technician?.id ?? null,
    capturedAt,
    timezone,
    captureId,
    mayCreate: isTechnicianChannel,
    laborHours: extracted.laborHours ?? null,
    attributes: noteAttributes,
  });
  let visit = resolved.visit;
  if (visit) {
    // The LINK is what every channel gets: it is the evidence citation, and the
    // whole reason attach is channel-blind.
    await insertVisitNote({ tenantId, visitId: visit.id, captureId });
    // What a TECHNICIAN reports is a report; what arrives from a customer is
    // correspondence. Folding an inbound extractor's labor hours into the trip's
    // billing would let a customer's email edit the job's cost, so the report
    // fields — and the happened flip below — stay technician-only.
    if (isTechnicianChannel && !resolved.created) {
      // A visit that already existed absorbs what the note found; a created one
      // was born with it.
      visit = await recordVisitReport(visit.id, {
        laborHours: extracted.laborHours ?? null,
        attributes: noteAttributes,
      });
    }
    // A TECHNICIAN'S REPORT IS EVIDENCE THE TRIP HAPPENED — and only a
    // technician's. An inbound email saying "nobody ever showed up" arrives
    // after the start too, and flipping the visit to completed on it would
    // delete the trip from `listOverdueConfirmedVisits` (confirmed-only)
    // FOREVER — silencing the detector with the very message complaining that
    // nobody came (review finding).
    //
    // Even from a technician, only if the note was filed at or after the
    // visit's start. One landing BEFORE it ("running late", "customer
    // rescheduled at the door") attaches as evidence and leaves the visit
    // exactly where it is, for the same reason. Both sides of the comparison
    // are the firm's wall clock (attachNote.noteLocalOf).
    // Date.parse, NOT a string compare: both sides are naive-local, but the DB
    // renders `…T09:00:00+00:00` while naiveLocalISO writes `…T09:00:00.000Z`.
    // Those differ after the seconds, so `<=` on the raw strings is decided by
    // '+' vs '.' rather than by the clock — right by luck today, wrong the
    // moment either format shifts. (The same trap the planner simulator hit.)
    if (
      isTechnicianChannel &&
      visit.status === 'confirmed' &&
      visit.starts_at !== null &&
      Date.parse(visit.starts_at) <= Date.parse(resolved.noteLocal)
    ) {
      // ADVISORY, like the retraction link: L1, the note link and the report
      // have all landed by now, so a visit cancelled out from under us between
      // resolveVisitForNote's read and this write must not turn a recorded note
      // into "note NOT recorded" and invite the technician to file it twice.
      try {
        visit = await updateVisitStatus(visit.id, 'completed', null, resolved.noteLocal);
        // Plain-text kind, no push — the 'job_cancelled' precedent. The manager
        // does not need a notification that work they already know about is done.
        await appendScheduleEvent({
          tenantId,
          visitId: visit.id,
          kind: 'happened',
          actorRef: technicianRef,
          detail: { reportedAt: resolved.noteLocal, captureId },
        });
      } catch (err) {
        console.error(
          `recordFieldNote: note ${captureId} linked, but visit ${visit.id} was not marked ` +
            `happened — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Status transition only if note-blessed (subset of the hardcoded machine,
  // pinned by test; updateJobStatus re-validates legality at the write). A new
  // job is 'open', so a 'completed' signal is correctly skipped rather than
  // thrown; an invoiced job ignores a late "done" note. Reopen staleness
  // guard: completed→in_progress fires only for a note CAPTURED after the job
  // last changed — a delayed delivery of a mid-job note (pull-window overlap,
  // late transcript) must not resurrect finished work (review finding).
  const signal = extracted.statusSignal;
  if (signal && NOTE_SIGNAL_TRANSITIONS[job.status]?.includes(signal)) {
    const staleReopen =
      job.status === 'completed' && signal === 'in_progress' && capturedAt <= job.updated_at;
    if (!staleReopen) await updateJobStatus(job.id, signal);
  }

  return {
    status: 'matched',
    captureId,
    customerId,
    jobId: job.id,
    // `true`: this note IS a link, so the visit is reported by construction.
    ...(visit ? { visitId: visit.id, stage: stageOf(visit, true) } : {}),
  };
}

// L1 metadata for an inbound capture: the normalizer's sourceMeta (from/subject/…)
// plus occurredAt. occurredAt/sourceMeta have no columns — metadata JSONB is their
// schema home. Undefined keys are omitted (mirrors buildVisitAttributes).
function buildCaptureMetadata(sourceMeta: Json | undefined, occurredAt: string | null | undefined): Json {
  const base: Record<string, Json> =
    sourceMeta && typeof sourceMeta === 'object' && !Array.isArray(sourceMeta)
      ? { ...(sourceMeta as Record<string, Json>) }
      : {};
  if (occurredAt != null) base.occurredAt = occurredAt;
  return base;
}

function buildVisitAttributes(extracted: ExtractedFields): Json {
  const base: Record<string, Json> =
    extracted.attributes &&
    typeof extracted.attributes === 'object' &&
    !Array.isArray(extracted.attributes)
      ? { ...(extracted.attributes as Record<string, Json>) }
      : {};
  if (extracted.workPerformed) base.workPerformed = extracted.workPerformed;
  if (extracted.followUp) base.followUp = extracted.followUp;
  return base;
}
