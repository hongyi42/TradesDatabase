import { describe, expect, test } from 'vitest';
import { purgeExpiredAudio, type PurgeDeps } from './purgeAudio.js';
import type { CallIngest } from '../db/index.js';

function row(over: Partial<CallIngest>): CallIngest {
  return {
    id: 'ci1',
    tenant_id: 'T1',
    external_id: 'RE1',
    caller_phone: null,
    call_sid: null,
    audio_ref: 'audio/T1/RE1.wav',
    status: 'ingested',
    match_status: 'matched',
    attempts: 0,
    capture_id: 'cap1',
    consent_announced: true,
    occurred_at: null,
    audio_delete_after: '2026-08-01T00:00:00.000Z',
    legal_hold: false,
    audio_deleted_at: null,
    payload: {},
    last_error: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function makeDeps(rows: CallIngest[], over: Partial<PurgeDeps> = {}) {
  const removed: Array<{ bucket: string; path: string }> = [];
  const marked: string[] = [];
  const deps: PurgeDeps = {
    listExpiredAudio: async () => rows,
    removeObject: async (bucket, path) => {
      removed.push({ bucket, path });
    },
    markAudioDeleted: async (id) => {
      marked.push(id);
    },
    ...over,
  };
  return { deps, removed, marked };
}

describe('purgeExpiredAudio', () => {
  test('removes each expired object and stamps it deleted', async () => {
    const { deps, removed, marked } = makeDeps([
      row({ id: 'a', audio_ref: 'audio/T1/a.wav' }),
      row({ id: 'b', audio_ref: 'audio/T1/b.wav' }),
    ]);
    const res = await purgeExpiredAudio(deps);
    expect(res.deleted).toBe(2);
    expect(removed.map((r) => r.path)).toEqual(['audio/T1/a.wav', 'audio/T1/b.wav']);
    expect(marked).toEqual(['a', 'b']);
  });

  test('a row with no audio_ref is stamped but not removed', async () => {
    const { deps, removed, marked } = makeDeps([row({ id: 'a', audio_ref: null })]);
    const res = await purgeExpiredAudio(deps);
    expect(res.deleted).toBe(0);
    expect(removed).toHaveLength(0);
    expect(marked).toEqual(['a']);
  });

  test('a remove failure does not block the rest of the batch', async () => {
    const { deps, marked } = makeDeps(
      [row({ id: 'bad', audio_ref: 'audio/T1/bad.wav' }), row({ id: 'good', audio_ref: 'audio/T1/good.wav' })],
      {
        removeObject: async (_bucket, path) => {
          if (path.includes('bad')) throw new Error('storage 500');
        },
      },
    );
    const res = await purgeExpiredAudio(deps);
    // 'bad' threw before its markAudioDeleted → not counted, not marked; 'good' succeeds.
    expect(res.deleted).toBe(1);
    expect(marked).toEqual(['good']);
  });

  test('empty worklist → deleted 0', async () => {
    const { deps } = makeDeps([]);
    expect(await purgeExpiredAudio(deps)).toEqual({ deleted: 0 });
  });
});
