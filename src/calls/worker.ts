import {
  claimNextPendingCall as liveClaimNextPendingCall,
  markCallError as liveMarkCallError,
  markCallIngested as liveMarkCallIngested,
  openUnlinkedCallReview as liveOpenUnlinkedCallReview,
  setAudioRef as liveSetAudioRef,
  type CallIngest,
} from '../db/index.js';
import {
  recordFieldNote as liveRecordFieldNote,
  type RecordFieldNoteInput,
  type RecordFieldNoteResult,
} from '../writePath/recordFieldNote.js';
import { downloadAndStore, signAudioUrl } from './fetchRecording.js';
import { assemblyAiTranscriber } from './transcribe.js';
import { redactSensitive } from './redact.js';

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
  markCallError: (id: string, message: string) => Promise<void>;
  download: (input: { recordingUrl: string; bucket: string; objectPath: string }) => Promise<string>;
  sign: (bucket: string, objectPath: string) => Promise<string>;
  transcribe: (audioUrl: string) => Promise<string>;
  redact: (text: string) => string;
  recordFieldNote: (input: RecordFieldNoteInput) => Promise<RecordFieldNoteResult>;
  openUnlinkedCallReview: (input: {
    tenantId: string;
    captureId: string;
    callerPhone?: string | null;
    snippet?: string | null;
  }) => Promise<unknown>;
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
  openUnlinkedCallReview: liveOpenUnlinkedCallReview,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export async function processNextCall(deps: WorkerDeps = liveDeps): Promise<'idle' | 'ingested' | 'error'> {
  const row = await deps.claimNextPendingCall();
  if (!row) return 'idle';

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

    const result = await deps.recordFieldNote({
      tenantId: row.tenant_id,
      technicianRef: 'phone-line', // source sentinel (plan decision 1) — not a person
      channel: 'phone_call',
      text: transcript,
      blobPath: retentionDays === 0 ? null : objectPath,
      fallbackPhone: row.caller_phone, // caller-ID → repeat-caller auto-match
      externalId: row.external_id,
      occurredAt: row.occurred_at,
      sourceMeta: {
        fromNumber: row.caller_phone,
        recordingProvider: 'signalwire',
        consentAnnounced: row.consent_announced,
        callSid: row.call_sid,
      },
    });

    // A first-time caller matched nothing → flag for the manager (agentless path,
    // no live "which customer?"). matched/duplicate are not re-flagged.
    if (result.status === 'needs_confirmation' || result.status === 'needs_disambiguation') {
      await deps.openUnlinkedCallReview({
        tenantId: row.tenant_id,
        captureId: result.captureId,
        callerPhone: row.caller_phone,
        snippet: transcript.slice(0, 200),
      });
    }

    // Any non-throwing status counts as ingested (L1 is stored), mirroring email.
    const audioDeleteAfter = new Date(Date.now() + retentionDays * DAY_MS).toISOString();
    await deps.markCallIngested(row.id, {
      captureId: result.captureId,
      matchStatus: result.status,
      audioDeleteAfter,
    });
    return 'ingested';
  } catch (err) {
    await deps.markCallError(row.id, err instanceof Error ? err.message : String(err));
    return 'error';
  }
}
