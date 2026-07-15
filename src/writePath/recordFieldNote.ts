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
  createVisit,
  ALLOWED_TRANSITIONS,
  type CaptureChannel,
  type Job,
  type JobStatus,
  type Json,
} from '../db/index.js';
import { sonnetExtractor, type Extractor, type ExtractedFields } from './extract.js';
import { matchIdentity, type MatchResult, type ScheduledCustomerDraft } from './identityMatch.js';

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
}

export interface RecordFieldNoteResult {
  status: 'matched' | 'needs_confirmation' | 'needs_disambiguation' | 'duplicate';
  captureId: string;
  customerId?: string;
  jobId?: string;
  visitId?: string;
  suggestion?: { address: string; assignmentId: string };
}

// Terminal job states (no outgoing transitions) — never reused for a new note.
const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(
  (Object.keys(ALLOWED_TRANSITIONS) as JobStatus[]).filter(
    (status) => ALLOWED_TRANSITIONS[status].length === 0,
  ),
);

// The channel-agnostic write-path: raw in first (L1), then extract → match →
// structure (L2/L3), evidence always linked via source_capture_id. raw_captures
// is append-only, so provenance is never written back onto the capture.
export async function recordFieldNote(
  input: RecordFieldNoteInput,
  deps: { extract?: Extractor } = {},
): Promise<RecordFieldNoteResult> {
  const extract = deps.extract ?? sonnetExtractor;
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

  // (2-3) AI extraction of candidate fields.
  const extracted = await extract(rawText);

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

  // The visit is this note's trip.
  const visit = await createVisit({
    tenantId,
    jobId: job.id,
    technicianName: technicianRef,
    laborHours: extracted.laborHours ?? null,
    attributes: buildVisitAttributes(extracted),
    sourceCaptureId: captureId,
  });

  // Status transition only if legal (hardcoded state machine, overview §5). A new
  // job is 'open', so a 'completed' signal is correctly skipped rather than thrown.
  if (extracted.statusSignal && ALLOWED_TRANSITIONS[job.status].includes(extracted.statusSignal)) {
    await updateJobStatus(job.id, extracted.statusSignal);
  }

  return { status: 'matched', captureId, customerId, jobId: job.id, visitId: visit.id };
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
