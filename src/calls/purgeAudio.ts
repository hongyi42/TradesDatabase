import { fileURLToPath } from 'node:url';
import {
  getClient,
  listExpiredAudio as liveListExpiredAudio,
  markAudioDeleted as liveMarkAudioDeleted,
  type CallIngest,
} from '../db/index.js';

// Retention purge — the audio-lifecycle Supabase Storage won't do natively (no
// object-expiry). Deletes recordings whose retention window has passed, skipping
// any on legal hold, then stamps audio_deleted_at (idempotent — a re-run skips
// already-purged rows). The transcript in L1 is untouched: only the heavy blob
// goes, which never violates append-only. Run by cron (`npm run calls:purge`).
//
// The legal-hold / already-deleted / window filter lives in listExpiredAudio's
// WHERE (SQL) — this orchestrator only removes what it is handed.

export interface PurgeDeps {
  listExpiredAudio: () => Promise<CallIngest[]>;
  removeObject: (bucket: string, objectPath: string) => Promise<void>;
  markAudioDeleted: (id: string) => Promise<void>;
}

async function liveRemoveObject(bucket: string, objectPath: string): Promise<void> {
  const { error } = await getClient().storage.from(bucket).remove([objectPath]);
  if (error) throw new Error(`purge remove failed: ${error.message}`);
}

const liveDeps: PurgeDeps = {
  listExpiredAudio: liveListExpiredAudio,
  removeObject: liveRemoveObject,
  markAudioDeleted: liveMarkAudioDeleted,
};

export async function purgeExpiredAudio(deps: PurgeDeps = liveDeps): Promise<{ deleted: number }> {
  const bucket = process.env.CALL_AUDIO_BUCKET ?? 'call-audio';
  const rows = await deps.listExpiredAudio();
  let deleted = 0;
  for (const row of rows) {
    try {
      // audio_delete_after is only set on the success path (after the worker
      // copied the object), so audio_ref here is the storage object path. Guard
      // the null case anyway — stamp it deleted so it leaves the worklist.
      if (row.audio_ref) {
        await deps.removeObject(bucket, row.audio_ref);
        deleted++;
      }
      await deps.markAudioDeleted(row.id);
    } catch (err) {
      // One bad object must not block the rest of the batch; it stays unmarked
      // and the next run retries it.
      console.error(`[calls:purge] failed to purge ${row.id}`, err);
    }
  }
  return { deleted };
}

async function main(): Promise<void> {
  const { deleted } = await purgeExpiredAudio();
  console.error(`[calls:purge] deleted ${deleted} expired recording(s)`);
}

// Run once when executed directly (cron); inert when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
