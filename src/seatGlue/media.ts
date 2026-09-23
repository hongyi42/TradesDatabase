import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Photos and voice notes a technician sends, kept on the box for a short while
// (operator, 2026-09-22: 7 days; the future home is Supabase Storage).
//
// THE PATH GUARD: a path returned here must never reach the model or a tool
// argument. raw_captures is permanent (L1) and this file is deleted in a week —
// a box path in blob_path would be a dangling pointer forever. seat.ts passes
// bytes to the engine, never this path.
export async function saveMedia(stateDir: string, buf: Buffer, ext: string, now = new Date()): Promise<string> {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const dir = join(stateDir, 'media', now.toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomUUID()}.${safeExt}`);
  await writeFile(path, buf, { mode: 0o600 });
  return path;
}

/** Delete media older than `days`. Returns how many files went. */
export async function sweepMedia(stateDir: string, days: number, now = Date.now()): Promise<number> {
  const root = join(stateDir, 'media');
  const cutoff = now - days * 86_400_000;
  let removed = 0;
  let dayDirs: string[];
  try {
    dayDirs = await readdir(root);
  } catch {
    return 0;
  }
  for (const d of dayDirs) {
    const dir = join(root, d);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(dir, f);
      const s = await stat(p).catch(() => null);
      if (s?.isFile() && s.mtimeMs < cutoff) {
        await unlink(p);
        removed += 1;
      }
    }
    if ((await readdir(dir).catch(() => ['keep'])).length === 0) await rmdir(dir).catch(() => {});
  }
  return removed;
}
