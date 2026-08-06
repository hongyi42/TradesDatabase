import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { processNextCall, type WorkerDeps } from './worker.js';
import { redactSensitive } from './redact.js';
import type { CallIngest } from '../db/index.js';
import type { RecordFieldNoteInput, RecordFieldNoteResult } from '../writePath/recordFieldNote.js';

let savedRetention: string | undefined;
let savedBucket: string | undefined;
beforeEach(() => {
  savedRetention = process.env.CALL_AUDIO_RETENTION_DAYS;
  savedBucket = process.env.CALL_AUDIO_BUCKET;
  process.env.CALL_AUDIO_RETENTION_DAYS = '30';
  process.env.CALL_AUDIO_BUCKET = 'call-audio';
});
afterEach(() => {
  process.env.CALL_AUDIO_RETENTION_DAYS = savedRetention;
  process.env.CALL_AUDIO_BUCKET = savedBucket;
});

function makeRow(over: Partial<CallIngest> = {}): CallIngest {
  return {
    id: 'ci1',
    tenant_id: 'T1',
    external_id: 'RE1',
    caller_phone: '+15551234567',
    call_sid: 'CA1',
    audio_ref: 'https://sw/rec.wav',
    status: 'processing',
    match_status: null,
    attempts: 0,
    capture_id: null,
    consent_announced: true,
    occurred_at: null,
    audio_delete_after: null,
    legal_hold: false,
    audio_deleted_at: null,
    payload: {},
    last_error: null,
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    ...over,
  };
}

interface Recorded {
  setAudioRef: Array<{ id: string; path: string }>;
  ingested: Array<{ id: string; captureId: string; matchStatus: string; audioDeleteAfter: string }>;
  errors: Array<{ id: string; message: string }>;
  record: RecordFieldNoteInput[];
  flagged: Array<{ tenantId: string; captureId: string; callerPhone?: string | null }>;
}

function makeDeps(over: Partial<WorkerDeps> = {}): { deps: WorkerDeps; calls: Recorded } {
  const calls: Recorded = { setAudioRef: [], ingested: [], errors: [], record: [], flagged: [] };
  const deps: WorkerDeps = {
    claimNextPendingCall: async () => makeRow(),
    setAudioRef: async (id, path) => {
      calls.setAudioRef.push({ id, path });
    },
    markCallIngested: async (id, f) => {
      calls.ingested.push({ id, ...f });
    },
    markCallError: async (id, message) => {
      calls.errors.push({ id, message });
    },
    download: async () => 'audio/T1/RE1.wav',
    sign: async () => 'https://signed/url',
    transcribe: async () => 'Speaker A: hi. my card is 4242424242424242',
    redact: redactSensitive, // real redaction so the pipeline is exercised end-to-end
    recordFieldNote: async (input): Promise<RecordFieldNoteResult> => {
      calls.record.push(input);
      return { status: 'matched', captureId: 'cap1' };
    },
    openUnlinkedCallReview: async (input) => {
      calls.flagged.push(input);
    },
    ...over,
  };
  return { deps, calls };
}

describe('processNextCall', () => {
  test('empty queue → idle', async () => {
    const { deps } = makeDeps({ claimNextPendingCall: async () => null });
    expect(await processNextCall(deps)).toBe('idle');
  });

  test('matched caller → ingested; phone-line source, redacted text, blob set, no flag', async () => {
    const { deps, calls } = makeDeps();
    expect(await processNextCall(deps)).toBe('ingested');

    expect(calls.setAudioRef).toEqual([{ id: 'ci1', path: 'audio/T1/RE1.wav' }]);
    expect(calls.record[0]).toMatchObject({
      tenantId: 'T1',
      technicianRef: 'phone-line',
      channel: 'phone_call',
      fallbackPhone: '+15551234567',
      externalId: 'RE1',
      blobPath: 'audio/T1/RE1.wav',
    });
    // Sensitive-auth data scrubbed BEFORE the write.
    expect(calls.record[0].text).toContain('[CARD]');
    expect(calls.record[0].text).not.toContain('4242');
    // matched → no review item.
    expect(calls.flagged).toHaveLength(0);
    // ingested with match status + ~30d retention.
    expect(calls.ingested[0]).toMatchObject({ id: 'ci1', captureId: 'cap1', matchStatus: 'matched' });
    const delta = Date.parse(calls.ingested[0].audioDeleteAfter) - (Date.now() + 30 * 86400000);
    expect(Math.abs(delta)).toBeLessThan(60000);
  });

  test('retention 0 → blobPath null, audio_ref still set, delete-after ~ now', async () => {
    process.env.CALL_AUDIO_RETENTION_DAYS = '0';
    const { deps, calls } = makeDeps();
    expect(await processNextCall(deps)).toBe('ingested');
    expect(calls.record[0].blobPath).toBeNull();
    expect(calls.setAudioRef).toHaveLength(1); // object still stored (needed to transcribe)
    expect(Math.abs(Date.parse(calls.ingested[0].audioDeleteAfter) - Date.now())).toBeLessThan(60000);
  });

  test('unmatched caller → ingested AND flagged once', async () => {
    const { deps, calls } = makeDeps({
      recordFieldNote: async (input) => {
        void input;
        return { status: 'needs_confirmation', captureId: 'cap9' };
      },
    });
    expect(await processNextCall(deps)).toBe('ingested');
    expect(calls.flagged).toEqual([
      { tenantId: 'T1', captureId: 'cap9', callerPhone: '+15551234567', snippet: expect.any(String) },
    ]);
    expect(calls.ingested[0]).toMatchObject({ captureId: 'cap9', matchStatus: 'needs_confirmation' });
  });

  test('transcriber throws → error, markCallError set, not ingested', async () => {
    const { deps, calls } = makeDeps({
      transcribe: async () => {
        throw new Error('stt down');
      },
    });
    expect(await processNextCall(deps)).toBe('error');
    expect(calls.errors).toEqual([{ id: 'ci1', message: 'stt down' }]);
    expect(calls.ingested).toHaveLength(0);
  });
});
