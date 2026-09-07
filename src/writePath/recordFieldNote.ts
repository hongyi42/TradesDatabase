import {
  appendRawCapture,
  findRetractionsFor,
  getRawCaptureByExternalId,
  captureHasLinkedL2,
  isUniqueViolation,
  type RawCapture,
  createCustomer,
  createJob,
  createObservation,
  getCustomer,
  getJob,
  listJobsForCustomer,
  updateJobStatus,
  insertJobCapture,
  appendJobCorrespondence,
  type JobCorrespondenceEntry,
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
  type Visit,
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
  /**
   * RUNG 10: this inbound capture asked instead of creating. Present when an
   * observation was written (absent on a raced redelivery, which the once-ever
   * index converges to the FIRST row rather than a second ask).
   */
  observationId?: string;
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
    // RUNG 9B WIDENED THAT CASE and RUNG 10 CLOSED IT. 9b stopped a
    // non-technician capture minting a visit (`visits` IS the schedule now, and
    // a customer's email is not a trip), which left an inbound capture on an
    // EXISTING customer+job carrying no link at all: the dedup missed it and
    // every redelivery re-ran the extractor. Rung 10 gives that capture its own
    // links — `job_captures` when it lands on a job, an `observations` row when
    // it asks instead — and captureHasLinkedL2 reads both, so a redelivery is a
    // real duplicate. What still re-runs is a work-but-UNMATCHED capture, by
    // design (rung 10b gives that one its own observation).
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
  // The inbound-email webhook and the call worker both call recordFieldNote with
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

  // WHO IS SPEAKING — hoisted above the job resolution by rung 10, because it
  // now gates that too: only a technician's own note may create work silently.
  const isTechnicianChannel =
    channel === 'technician_voice' || channel === 'technician_photo' || channel === 'technician_note';

  // RUNG 10 — THE ASK. An inbound capture that code cannot resolve alone becomes
  // an observation in the planner's own record and NOTHING else: no job, no
  // visit. The Calls-worker's ping loop calls the planner about it within
  // seconds; the planner texts a manager in its own words; the manager's own
  // agent creates whatever they say, citing this capture.
  //
  // `null` from createObservation means the once-ever index already holds this
  // capture — a raced redelivery — so there is nothing new to report and the
  // FIRST row keeps the ask.
  const observeInbound = async (onJob: Job | null): Promise<RecordFieldNoteResult> => {
    const customer = await getCustomer(customerId);
    const obs = await createObservation({
      tenantId,
      // ONE observation per capture; the kind names what code could not decide.
      // A committed capture with no open job carries no `jobId` in its context,
      // which is how the planner reads "a job would be opened too" — never two
      // texts for one call.
      //
      // "One" is enforced by `captureHasObservation` on the dedup path, NOT by
      // the database: uq_observations_subject_ever is keyed
      // (tenant_id, kind, subject_ref), so the index itself would permit an
      // inbound_new_job AND an inbound_commitment row for one capture. That
      // needs two concurrent deliveries of the same capture whose extractions
      // disagree about `visitCommitted` — narrow enough to accept, and named
      // here rather than left to be rediscovered.
      kind: extracted.visitCommitted === true ? 'inbound_commitment' : 'inbound_new_job',
      subjectRef: captureId,
      technicianId: null,
      context: {
        captureId,
        capturedAt,
        customerId,
        channel,
        customerName: customer?.name ?? null,
        from: fromOf(input.sourceMeta),
        ...(onJob ? { jobId: onJob.id, jobTitle: onJob.title } : {}),
        // The extractor's reading, nulls kept — an absent field and a field the
        // model declined to fill are different things to the planner.
        // workPerformed IS here (the planner may want the caller's own account
        // of the problem) but never reaches `correspondence`: the report and the
        // bill stay technician-only.
        asked: {
          jobTitle: extracted.jobTitle ?? null,
          jobType: extracted.jobType ?? null,
          address: extracted.address ?? null,
          city: extracted.city ?? null,
          workPerformed: extracted.workPerformed ?? null,
          followUp: extracted.followUp ?? null,
          attributes: objectOrNull(extracted.attributes),
        },
        // Bounded: the gap view shows the words, and the full capture is one
        // spine_read away.
        words: rawText.slice(0, 1500),
      },
    });
    return {
      status: 'matched',
      captureId,
      customerId,
      ...(onJob ? { jobId: onJob.id } : {}),
      ...(obs ? { observationId: obs.id } : {}),
    };
  };

  // RUNG 10, AMENDED 2026-09-07 (user): an inbound capture the extractor judged
  // NOT worth the office's attention is still the customer's words, and they
  // belong on the customer's record — not thrown back to L1, which is the very
  // problem (C) below was written to fix. So it is filed on their most recent
  // job WHATEVER its status, and nothing is asked.
  //
  // Filing on a terminal job is inert by construction, not by luck:
  //   - the status signal cannot move it (NOTE_SIGNAL_TRANSITIONS has no entry
  //     for invoiced/paid/cancelled/declined),
  //   - no visit can be minted (`mayCreate` is false for every inbound channel),
  //   - `correspondence` is an append keyed by capture id, so it is idempotent.
  // The link is also what makes a webhook redelivery a real duplicate
  // (captureHasLinkedL2 reads job_captures) instead of a second extractor call.
  const fileWithoutAsking = async (onJob: Job | null): Promise<RecordFieldNoteResult> => {
    // No job at all — a first-time sender whose message closes itself. L1 holds
    // the verbatim capture and there is nothing to attach it to. Such a capture
    // has no L2 link, so a redelivery re-extracts; that costs one model call and
    // writes nothing, which is the cheaper side of the trade against inventing a
    // job to hang it on.
    if (!onJob) return { status: 'captured', captureId, customerId };
    await appendJobCorrespondence(
      onJob.id,
      correspondenceOf(captureId, channel, capturedAt, extracted),
    );
    await insertJobCapture({ tenantId, jobId: onJob.id, captureId });
    return { status: 'matched', captureId, customerId, jobId: onJob.id };
  };

  // Resolve the job: a matcher-supplied job, else the most recent non-terminal
  // job for the customer, else — for a technician channel only — a new one.
  let job: Job | null = match.jobId ? await getJob(match.jobId) : null;
  // Held past the resolution: the filter above files on the most recent job of
  // ANY status, which the non-terminal search has by then discarded.
  let priorJobs: Job[] = [];
  if (!job) {
    priorJobs = await listJobsForCustomer(customerId);
    job = [...priorJobs].reverse().find((candidate) => !TERMINAL_STATUSES.has(candidate.status)) ?? null;
  }
  // AMENDED 2026-09-07 (user): inbound with no open job ASKS. It used to mint
  // one here and the manager never heard of it — "so the manager can know,
  // instead of being blind to the job being created."
  if (!isTechnicianChannel && !job) {
    // AMENDED again the same day, after the first version woke the planner for
    // every email from a settled customer: the extractor decides, not the job
    // lookup. `=== false` and not merely falsy — undefined must keep asking.
    if (extracted.needsAttention === false && extracted.visitCommitted !== true) {
      // listJobsForCustomer orders created_at ASCENDING, so the tail is newest.
      return await fileWithoutAsking(priorJobs[priorJobs.length - 1] ?? null);
    }
    return await observeInbound(null);
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
  // (`isTechnicianChannel` is resolved above — the job resolution needs it too.)
  //
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
  // Widened to the bare row on purpose: resolveVisitForNote hands back a visit
  // WITH its crew (the attach rule needs it), but from here on the writes below
  // return plain rows and nothing in this function asks who was on the trip.
  let visit: Visit | null = resolved.visit;

  // (iii) RUNG 10 — A COMMITMENT WITH NO TRIP ASKS, AND IT ASKS FIRST.
  //
  // The firm agreed to come out and nothing on the calendar matches, so a
  // manager decides whether it reaches the schedule. The DECISION is made here,
  // after `resolveVisitForNote` (a read) and before any link is written, and
  // the order is load-bearing: `job_captures` is a "processed" marker that
  // captureHasLinkedL2 reads, so writing it first would let any failure in
  // between — a CAS exhaustion appending correspondence, a killed worker —
  // bury the ask forever. The redelivery would short-circuit as a duplicate and
  // nobody would ever hear that the firm promised to come out.
  //
  // THE TAIL IS ORDERED BY WHAT IT WOULD COST TO LOSE, worst first:
  //     the ask  →  the correspondence  →  the LINK  →  the status signal.
  // The ask outranks everything because it is the only one with a cost OUTSIDE
  // this database: a customer was told someone is coming and nobody at the firm
  // knows. The other three cost record quality, which is recoverable by hand.
  //
  // AND THE ASK IS ITSELF A MARKER — captureHasLinkedL2 reads `observations`
  // too — so this ordering is a deliberate trade, not a free win: if the
  // correspondence append then fails (three CAS misses under a concurrent job
  // write, or a job whose attributes are not an object), the redelivery
  // short-circuits and this job never gets its own copy of the words or its
  // evidence link. Nothing is LOST — the capture is in L1 forever, and the
  // observation's `context.asked` carries the same followUp and attributes for
  // the planner to read — but that job reads silent to the evidence readers
  // until somebody links it by hand. Reversing the two would trade a dropped
  // promise for a tidy record, which is the wrong way round.
  //
  // For an UNCOMMITTED capture there is no such trade: no observation is
  // written, so the correspondence genuinely sits ahead of every marker and a
  // failed append is simply retried.
  //
  // A committed capture that landed on a LIVE visit asks nothing: that is
  // correspondence about work already booked, and asking would be noise.
  const asked =
    !isTechnicianChannel && extracted.visitCommitted === true && !visit
      ? await observeInbound(job)
      : null;

  // (C) RUNG 10 — WHAT THE CALLER SAID, KEPT ON THE JOB. The extractor already
  // read the call into its context; before this, everything it found was thrown
  // away for inbound, because the only home was the technician's trip report.
  // `correspondence` is an APPENDED list, one entry per capture, each naming the
  // capture that evidences it — never a merge over the key, or two emails on one
  // job would keep only the last. laborHours/workPerformed are deliberately NOT
  // copied: the report and the bill stay technician-only (rung 9b's line).
  //
  // BEFORE THE LINKS, for the ordering rule above: this write can genuinely
  // fail (three CAS misses under a concurrent job write, or a job whose
  // attributes are not an object), and behind a "processed" marker that failure
  // would lose the caller's words permanently — the redelivery would
  // short-circuit. Ahead of it, the retry re-runs and lands them; the append is
  // idempotent per capture id, so re-running costs nothing.
  if (!isTechnicianChannel) {
    await appendJobCorrespondence(
      job.id,
      correspondenceOf(captureId, channel, capturedAt, extracted),
    );
  }

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
  } else if (!isTechnicianChannel) {
    // (A) RUNG 10 — THE LINK-LESS SHAPE, CLOSED. No trip attaches, so the
    // capture is pinned to the JOB instead. Before this it was unstamped
    // (identity resolves after L1, which is immutable) and linked to nothing:
    // both evidence homes missed it and the job read silent, so a customer
    // chasing an open job looked like silence. It also makes a redelivery a
    // real duplicate — captureHasLinkedL2 reads this link — instead of a
    // repeat extractor call that could re-apply a stale status signal.
    await insertJobCapture({ tenantId, jobId: job.id, captureId });
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

  // The ask decided above returns HERE — last, so an inbound capture on an open
  // job behaves EXACTLY as an uncommitted one does all the way through: the
  // words reach the job, the link is written, and a note-blessed status signal
  // still moves the job. Whether the firm agreed to come out says nothing about
  // whether the work started, and making one arm skip the signal would be a
  // silent difference nobody asked for.
  if (asked) return asked;

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

// The sender, as the door recorded it. TWO KEYS, because the two doors spell it
// differently and neither is going to change: the email webhook writes `from`
// (src/inbound/webhook.ts) and the phone worker writes `fromNumber`
// (src/calls/worker.ts). Reading only `from` would leave every CALL — this
// rung's headline channel — with no sender to show the planner. Absent
// (technician channels, a webhook carrying neither) is a normal value.
function fromOf(sourceMeta: Json | undefined): string | null {
  if (!sourceMeta || typeof sourceMeta !== 'object' || Array.isArray(sourceMeta)) return null;
  const meta = sourceMeta as Record<string, Json>;
  for (const key of ['from', 'fromNumber']) {
    const value = meta[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

// A plain JSON object, or null — the shape both `asked.attributes` and a
// correspondence entry's `facts` require. An array or scalar is not L3 facts.
function objectOrNull(value: Json | undefined): Record<string, Json> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;
}

// ONE entry for the job's `correspondence` list — what the caller asked for and
// the long-tail facts they gave, nothing else. EXPORTED because the manager's
// agent copies the same shape onto a job it opens from an ask (rung 10 amendment
// C at creation), and one builder is what keeps the two identical.
//
// Null when there is nothing to say: an inbound capture yielding neither a
// follow-up nor a fact adds only noise to L3, and the `job_captures` link
// already records that it landed.
export function correspondenceOf(
  captureId: string,
  channel: CaptureChannel,
  at: string,
  extracted: Pick<ExtractedFields, 'followUp' | 'attributes'>,
): JobCorrespondenceEntry | null {
  const followUp = extracted.followUp?.trim() || null;
  const facts = objectOrNull(extracted.attributes ?? undefined);
  const hasFacts = !!facts && Object.keys(facts).length > 0;
  if (!followUp && !hasFacts) return null;
  return {
    captureId,
    channel,
    at,
    ...(followUp ? { followUp } : {}),
    ...(hasFacts ? { facts: facts as Record<string, Json> } : {}),
  };
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
