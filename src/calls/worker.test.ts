import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { processNextCall, type WorkerDeps } from './worker.js';
import { redactSensitive } from './redact.js';
import type { CallIngest } from '../db/index.js';
import type { RecordFieldNoteInput, RecordFieldNoteResult } from '../writePath/recordFieldNote.js';

let savedRetention: string | undefined;
let savedBucket: string | undefined;
// Capture the worker's stderr heartbeat so (a) the success line does not spam the
// test output and (b) the PII-free test below can assert on exactly what was logged.
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  savedRetention = process.env.CALL_AUDIO_RETENTION_DAYS;
  savedBucket = process.env.CALL_AUDIO_BUCKET;
  process.env.CALL_AUDIO_RETENTION_DAYS = '30';
  process.env.CALL_AUDIO_BUCKET = 'call-audio';
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.env.CALL_AUDIO_RETENTION_DAYS = savedRetention;
  process.env.CALL_AUDIO_BUCKET = savedBucket;
  errSpy.mockRestore();
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
  actionReviews: Array<{
    tenantId: string;
    captureId: string;
    intents: string[];
    priority?: 'normal' | 'high';
  }>;
  notifications: Array<{ tenantId: string; text: string }>;
}

function makeDeps(over: Partial<WorkerDeps> = {}): { deps: WorkerDeps; calls: Recorded } {
  const calls: Recorded = {
    setAudioRef: [],
    ingested: [],
    errors: [],
    record: [],
    actionReviews: [],
    notifications: [],
  };
  const deps: WorkerDeps = {
    claimNextPendingCall: async () => makeRow(),
    setAudioRef: async (id, path) => {
      calls.setAudioRef.push({ id, path });
    },
    markCallIngested: async (id, f) => {
      calls.ingested.push({ id, ...f });
    },
    // Default: a retryable failure (not yet exhausted) → no dead-letter push.
    markCallError: async (id, message) => {
      calls.errors.push({ id, message });
      return { status: 'pending', attempts: 1 };
    },
    download: async () => 'audio/T1/RE1.wav',
    sign: async () => 'https://signed/url',
    transcribe: async () => 'Speaker A: hi. my card is 4242424242424242',
    redact: redactSensitive, // real redaction so the pipeline is exercised end-to-end
    recordFieldNote: async (input): Promise<RecordFieldNoteResult> => {
      calls.record.push(input);
      // Mirror the real gate: L1-only mode returns 'captured', otherwise 'matched'.
      return { status: input.structure === false ? 'captured' : 'matched', captureId: 'cap1' };
    },
    // Default: a plain new-work call, so existing tests keep structuring L2.
    classifyCall: async () => ({ intents: ['new_job'], reason: '' }),
    openCallActionReview: async (input) => {
      calls.actionReviews.push(input);
    },
    notifyManagers: async (tenantId, text) => {
      calls.notifications.push({ tenantId, text });
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

  // RUNG 10B: the worker no longer files anything for an unmatched caller and no
  // longer pushes. recordFieldNote raises `inbound_unmatched` from inside, the
  // ping loop shows the planner, and the planner decides whether a manager is
  // worth interrupting. The call is still ingested and its status still recorded.
  test('unmatched caller → ingested, nothing filed here, nobody pushed', async () => {
    const { deps, calls } = makeDeps({
      recordFieldNote: async (input) => {
        void input;
        return { status: 'needs_disambiguation', captureId: 'cap9' };
      },
    });
    expect(await processNextCall(deps)).toBe('ingested');
    expect(calls.actionReviews).toHaveLength(0);
    expect(calls.notifications).toHaveLength(0);
    expect(calls.ingested[0]).toMatchObject({
      captureId: 'cap9',
      matchStatus: 'needs_disambiguation',
    });
  });

  test('successful ingest logs a heartbeat line — identifiers only, NO PII', async () => {
    const { deps } = makeDeps(); // caller +15551234567, transcript has card 4242…
    expect(await processNextCall(deps)).toBe('ingested');

    const line = errSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((l: string) => l.includes('[calls:worker] ingested'));
    expect(line).toBeDefined();
    // identifiers the operator needs
    expect(line).toContain('ci1'); // the call_ingest UUID (opaque)
    expect(line).toContain('match=matched');
    expect(line).toMatch(/in \d+ms/);
    // the privacy line: the log must carry NO customer PII
    expect(line).not.toContain('+15551234567'); // caller phone
    expect(line).not.toContain('4242'); // transcript content
    expect(line).not.toMatch(/Speaker/i);
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

  test('new_job intent → structures L2; no action review, no push', async () => {
    const { deps, calls } = makeDeps({
      classifyCall: async () => ({ intents: ['new_job'], reason: 'new work' }),
    });
    expect(await processNextCall(deps)).toBe('ingested');
    expect(calls.record[0].structure).toBe(true);
    expect(calls.record[0].sourceMeta).toMatchObject({ callIntents: ['new_job'], reason: 'new work' });
    expect(calls.actionReviews).toHaveLength(0);
    expect(calls.notifications).toHaveLength(0);
  });

  test('cancel intent → L1 only (structure false) + a pushed call_action review', async () => {
    const { deps, calls } = makeDeps({
      classifyCall: async () => ({ intents: ['cancel'], reason: 'wants to cancel' }),
    });
    expect(await processNextCall(deps)).toBe('ingested');
    expect(calls.record[0].structure).toBe(false);
    expect(calls.actionReviews).toEqual([
      {
        tenantId: 'T1',
        captureId: 'cap1',
        intents: ['cancel'],
        priority: 'normal',
        callerPhone: '+15551234567',
        snippet: expect.any(String),
      },
    ]);
    expect(calls.notifications).toHaveLength(1);
    expect(calls.notifications[0].text).toContain('cancel');
  });

  test('mixed [new_job, cancel] → BOTH structures L2 AND opens a call_action review', async () => {
    const { deps, calls } = makeDeps({
      classifyCall: async () => ({ intents: ['new_job', 'cancel'], reason: 'new job and a cancel' }),
    });
    expect(await processNextCall(deps)).toBe('ingested');
    expect(calls.record[0].structure).toBe(true); // new_job present → structure on
    expect(calls.actionReviews).toHaveLength(1);
    expect(calls.actionReviews[0].intents).toEqual(['cancel']); // new_job routed to L2, not the review
    expect(calls.notifications).toHaveLength(1);
  });

  test('mixed [new_job, cancel] on an UNMATCHED caller → ONLY the call_action branch, ONE push', async () => {
    const { deps, calls } = makeDeps({
      classifyCall: async () => ({ intents: ['new_job', 'cancel'], reason: 'new job and a cancel' }),
      // new_job structures, but the caller matches nothing. Before rung 10b this
      // ALSO opened an unlinked-call review and pushed a second time; the
      // unmatched half is now an observation raised inside recordFieldNote.
      recordFieldNote: async () => ({ status: 'needs_disambiguation', captureId: 'capBoth' }),
    });
    expect(await processNextCall(deps)).toBe('ingested');
    // The cancel still reaches a human (new_job excluded from the intent list).
    expect(calls.actionReviews).toHaveLength(1);
    expect(calls.actionReviews[0]).toMatchObject({ captureId: 'capBoth', intents: ['cancel'] });
    // ONE push, not two.
    expect(calls.notifications).toHaveLength(1);
  });

  test('complaint intent → HIGH-priority call_action review', async () => {
    const { deps, calls } = makeDeps({
      classifyCall: async () => ({ intents: ['complaint'], reason: 'angry customer' }),
    });
    expect(await processNextCall(deps)).toBe('ingested');
    expect(calls.actionReviews[0]).toMatchObject({ intents: ['complaint'], priority: 'high' });
    expect(calls.notifications[0].text).toContain('🔴');
  });

  test('classifier throws → unclassified: structure false, HIGH review, still ingested', async () => {
    const { deps, calls } = makeDeps({
      classifyCall: async () => {
        throw new Error('glm down after retries');
      },
    });
    expect(await processNextCall(deps)).toBe('ingested'); // fail-safe, never silence
    expect(calls.record[0].structure).toBe(false);
    expect(calls.record[0].sourceMeta).toMatchObject({ callIntents: ['unclassified'] });
    expect(calls.actionReviews[0]).toMatchObject({ intents: ['unclassified'], priority: 'high' });
    expect(calls.notifications).toHaveLength(1);
  });

  test('an out-of-vocabulary label alone → treated as unclassified (fail-safe)', async () => {
    const { deps, calls } = makeDeps({
      // isCallIntent filters the garbage → empty → unclassified.
      classifyCall: async () => ({ intents: ['made_up' as never], reason: 'garbage label' }),
    });
    expect(await processNextCall(deps)).toBe('ingested');
    expect(calls.actionReviews[0]).toMatchObject({ intents: ['unclassified'], priority: 'high' });
  });

  test("'other' only → L1 kept, NO review, NO push", async () => {
    const { deps, calls } = makeDeps({
      classifyCall: async () => ({ intents: ['other'], reason: 'wrong number' }),
    });
    expect(await processNextCall(deps)).toBe('ingested');
    expect(calls.record[0].structure).toBe(false);
    expect(calls.actionReviews).toHaveLength(0);
    expect(calls.notifications).toHaveLength(0);
  });

  test('duplicate redelivery → no action review even with a review-worthy intent', async () => {
    const { deps, calls } = makeDeps({
      classifyCall: async () => ({ intents: ['cancel'], reason: 'wants to cancel' }),
      recordFieldNote: async () => ({ status: 'duplicate', captureId: 'capDup' }),
    });
    expect(await processNextCall(deps)).toBe('ingested');
    expect(calls.actionReviews).toHaveLength(0); // already processed — do not re-open/re-push
    expect(calls.notifications).toHaveLength(0);
  });

  test('terminal failure (markCallError → error) → dead-letter push to managers', async () => {
    const { deps, calls } = makeDeps({
      transcribe: async () => {
        throw new Error('stt down');
      },
      markCallError: async (id, message) => {
        calls.errors.push({ id, message });
        return { status: 'error', attempts: 5 }; // retries exhausted → parked
      },
    });
    expect(await processNextCall(deps)).toBe('error');
    expect(calls.notifications).toHaveLength(1);
    expect(calls.notifications[0].text).toContain('failed to process');
  });

  test('retryable failure (markCallError → pending) → NO dead-letter push', async () => {
    const { deps, calls } = makeDeps({
      transcribe: async () => {
        throw new Error('stt blip');
      },
      // default markCallError returns { status: 'pending' }
    });
    expect(await processNextCall(deps)).toBe('error');
    expect(calls.notifications).toHaveLength(0); // not yet exhausted — stays silent, will retry
  });
});
