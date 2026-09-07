import {
  claimNextPendingCall as liveClaimNextPendingCall,
  markCallError as liveMarkCallError,
  markCallIngested as liveMarkCallIngested,
  openUnlinkedCallReview as liveOpenUnlinkedCallReview,
  openCallActionReview as liveOpenCallActionReview,
  setAudioRef as liveSetAudioRef,
  type CallIngest,
  type CostContext,
} from '../db/index.js';
import {
  recordFieldNote as liveRecordFieldNote,
  type RecordFieldNoteInput,
  type RecordFieldNoteResult,
} from '../writePath/recordFieldNote.js';
import { downloadAndStore, signAudioUrl } from './fetchRecording.js';
import { assemblyAiTranscriber } from './transcribe.js';
import { redactSensitive } from './redact.js';
import { defaultCallClassifier, isCallIntent, type CallIntent } from './classifyCall.js';
import { notifyManagers } from './notify.js';

// The async worker: drain one call_ingest row end-to-end. download+copy the
// recording → transcribe (AssemblyAI via a signed URL) → redact SAD → land it
// through the channel-agnostic recordFieldNote (channel 'phone_call',
// technician_ref 'phone-line') → flag unmatched callers. Deps are injectable so
// the pipeline is unit-testable without SignalWire/AssemblyAI/Supabase.

export interface WorkerDeps {
  claimNextPendingCall: () => Promise<CallIngest | null>;
  setAudioRef: (id: string, objectPath: string) => Promise<void>;
  markCallIngested: (
    id: string,
    f: { captureId: string; matchStatus: string; audioDeleteAfter: string },
  ) => Promise<void>;
  markCallError: (id: string, message: string) => Promise<{ status: string; attempts: number }>;
  download: (input: { recordingUrl: string; bucket: string; objectPath: string }) => Promise<string>;
  sign: (bucket: string, objectPath: string) => Promise<string>;
  transcribe: (audioUrl: string) => Promise<string>;
  redact: (text: string) => string;
  recordFieldNote: (input: RecordFieldNoteInput) => Promise<RecordFieldNoteResult>;
  classifyCall: (
    transcript: string,
    ctx?: CostContext,
  ) => Promise<{ intents: CallIntent[]; reason: string }>;
  openUnlinkedCallReview: (input: {
    tenantId: string;
    captureId: string;
    callerPhone?: string | null;
    snippet?: string | null;
  }) => Promise<unknown>;
  openCallActionReview: (input: {
    tenantId: string;
    captureId: string;
    intents: string[];
    priority?: 'normal' | 'high';
    callerPhone?: string | null;
    snippet?: string | null;
  }) => Promise<unknown>;
  notifyManagers: (tenantId: string, text: string) => Promise<void>;
}

const liveDeps: WorkerDeps = {
  claimNextPendingCall: liveClaimNextPendingCall,
  setAudioRef: liveSetAudioRef,
  markCallIngested: liveMarkCallIngested,
  markCallError: liveMarkCallError,
  download: downloadAndStore,
  sign: signAudioUrl,
  transcribe: (url) => assemblyAiTranscriber.transcribe(url),
  redact: redactSensitive,
  recordFieldNote: liveRecordFieldNote,
  classifyCall: (transcript, ctx) => defaultCallClassifier(transcript, ctx),
  openUnlinkedCallReview: liveOpenUnlinkedCallReview,
  openCallActionReview: liveOpenCallActionReview,
  notifyManagers,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export async function processNextCall(deps: WorkerDeps = liveDeps): Promise<'idle' | 'ingested' | 'error'> {
  const row = await deps.claimNextPendingCall();
  if (!row) return 'idle';
  const startedAt = Date.now();

  try {
    if (!row.audio_ref) throw new Error('call_ingest row has no audio_ref');
    const bucket = process.env.CALL_AUDIO_BUCKET ?? 'call-audio';
    const retentionDays = Number(process.env.CALL_AUDIO_RETENTION_DAYS ?? 30);

    // Copy the SignalWire recording into our bucket, then rewrite audio_ref from
    // the remote URL to the object path (even in transcript-only mode, so the
    // purge can still find the transient object).
    const objectPath = `audio/${row.tenant_id}/${row.external_id}.wav`;
    await deps.download({ recordingUrl: row.audio_ref, bucket, objectPath });
    await deps.setAudioRef(row.id, objectPath);

    // Transcribe from a signed URL, then scrub sensitive-auth data BEFORE any write.
    const signedUrl = await deps.sign(bucket, objectPath);
    const transcript = deps.redact(await deps.transcribe(signedUrl));

    // Intent router — runs BEFORE-L2, never before-L1 (the transcript is always
    // kept as the call log). Every label is validated with isCallIntent: the tool
    // declares an enum but coerceBySchema passes array items through untouched, so
    // a hallucinated label would otherwise reach the router. A classifier throw
    // (after its own retries), an empty result, or all-invalid labels is NOT
    // silence — it becomes `unclassified` → a pushed HIGH review below, so an
    // important call (a complaint, a cancel) can never fall to L1-only silence.
    let validated: CallIntent[] = [];
    let unclassified = false;
    let reason = '';
    try {
      const c = await deps.classifyCall(transcript, {
        tenantId: row.tenant_id,
        technicianRef: 'phone-line',
      });
      validated = c.intents.filter(isCallIntent);
      reason = c.reason ?? '';
      if (validated.length === 0) unclassified = true; // empty or all-garbage labels
    } catch {
      unclassified = true;
    }
    // Only a validated `new_job` runs the extractor at all. Every other intent —
    // and an unclassified call — keeps L1 and routes to a human, so structuring
    // is OFF unless new_job is present.
    // WHAT STRUCTURING MEANS SINCE RUNG 10: identity resolves, the words are
    // pinned to the caller's open job if they have one, and an OBSERVATION is
    // raised — a manager asked — when they have no open job, or when the firm
    // agreed to come out and no trip on the calendar carries it. It no longer
    // mints a job, so nothing from a call reaches the board's unscheduled
    // bucket until somebody says yes.
    const structure = !unclassified && validated.includes('new_job');

    const result = await deps.recordFieldNote({
      tenantId: row.tenant_id,
      technicianRef: 'phone-line', // source sentinel (plan decision 1) — not a person
      channel: 'phone_call',
      text: transcript,
      blobPath: retentionDays === 0 ? null : objectPath,
      fallbackPhone: row.caller_phone, // caller-ID → repeat-caller auto-match
      externalId: row.external_id,
      occurredAt: row.occurred_at,
      structure,
      sourceMeta: {
        fromNumber: row.caller_phone,
        recordingProvider: 'signalwire',
        consentAnnounced: row.consent_announced,
        callSid: row.call_sid,
        // The router's verdict, on the durable L1 record: what it decided and why.
        callIntents: unclassified ? ['unclassified'] : validated,
        reason,
      },
    });

    // Route each outcome. These two checks are INDEPENDENT — a mixed call
    // (e.g. [new_job, cancel]) fires both. Mutations are NEVER auto-executed:
    // a reschedule/cancel/complaint/question — or an unclassified call — opens a
    // review and pushes the manager; the human acts.
    //
    // (a) a new_job caller who matched nothing → the existing unlinked-call review
    // (link/create), now also pushed. matched/duplicate are not re-flagged.
    if (
      !unclassified &&
      validated.includes('new_job') &&
      (result.status === 'needs_confirmation' || result.status === 'needs_disambiguation')
    ) {
      await deps.openUnlinkedCallReview({
        tenantId: row.tenant_id,
        captureId: result.captureId,
        callerPhone: row.caller_phone,
        snippet: transcript.slice(0, 200),
      });
      await deps.notifyManagers(
        row.tenant_id,
        `📋 Call — new customer to link · ${row.caller_phone ?? ''}`,
      );
    }

    // (b) any mutating/enquiry intent — or an unclassified call — → a call_action
    // review, pushed. The `!== 'duplicate'` gate suppresses re-processing only for
    // an L2-linked (new_job) redelivery; a non-job call is 'captured' and never
    // links L2, so a redelivery re-routes here. The review ITEM stays idempotent
    // (upsert returns the same open row), but the Telegram push is at-least-once —
    // an accepted best-effort tradeoff, with the pull queue as the durable backstop.
    const reviewIntents = unclassified
      ? ['unclassified']
      : validated.filter(
          (i) => i === 'reschedule' || i === 'cancel' || i === 'question' || i === 'complaint',
        );
    if (reviewIntents.length > 0 && result.status !== 'duplicate') {
      const priority: 'normal' | 'high' =
        unclassified || reviewIntents.includes('complaint') ? 'high' : 'normal';
      await deps.openCallActionReview({
        tenantId: row.tenant_id,
        captureId: result.captureId,
        intents: reviewIntents,
        priority,
        callerPhone: row.caller_phone,
        snippet: transcript.slice(0, 200),
      });
      await deps.notifyManagers(
        row.tenant_id,
        `${priority === 'high' ? '🔴' : '📋'} Call — ${reviewIntents.join(', ')} · ` +
          `${row.caller_phone ?? ''} · "${transcript.slice(0, 120)}"`,
      );
    }
    // (c) 'other' only → nothing beyond the L1 capture.

    // Any non-throwing status counts as ingested (L1 is stored), mirroring email.
    const audioDeleteAfter = new Date(Date.now() + retentionDays * DAY_MS).toISOString();
    await deps.markCallIngested(row.id, {
      captureId: result.captureId,
      matchStatus: result.status,
      audioDeleteAfter,
    });
    // Operational heartbeat — ONE line per processed call (a business event, not a
    // machine tick), so a live worker is visible in the logs without the idle-poll
    // spam (see runWorker's backoff). PII-FREE BY DESIGN: the call_ingest UUID +
    // match status + timing only — NEVER the caller phone or transcript, which would
    // leak customer PII to the log surface (wider + retained vs the tenant-scoped DB).
    // The UUID is opaque; resolving who it is still requires a DB read.
    console.error(
      `[calls:worker] ingested ${row.id} match=${result.status} in ${Date.now() - startedAt}ms`,
    );
    return 'ingested';
  } catch (err) {
    // Bump attempts / re-queue or park. Only when the row is TERMINALLY parked
    // ('error' — retries exhausted) push the managers, so a dead call isn't
    // invisible. Best-effort: the alert must never mask the original failure.
    const r = await deps.markCallError(row.id, err instanceof Error ? err.message : String(err));
    if (r.status === 'error') {
      await deps
        .notifyManagers(row.tenant_id, '⚠️ a call failed to process — check the pending-call queue')
        .catch(() => {});
    }
    return 'error';
  }
}
