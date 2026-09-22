import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The glue's own memory, beside the engine's session files: which conversation
// is the seat's current one, and how far through Telegram's update stream it
// has read. Written temp-file-then-rename so a crash never leaves half a file.
export interface SeatState {
  sessionId: string | null;
  /** The next Telegram update_id to ask for (last seen + 1). */
  offset: number;
}

const FILE = 'state.json';

export async function readState(stateDir: string): Promise<SeatState> {
  try {
    const raw = JSON.parse(await readFile(join(stateDir, FILE), 'utf8')) as Partial<SeatState>;
    return {
      sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
      offset: Number.isInteger(raw.offset) ? (raw.offset as number) : 0,
    };
  } catch {
    return { sessionId: null, offset: 0 };
  }
}

export async function writeState(stateDir: string, state: SeatState): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const tmp = join(stateDir, `${FILE}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, join(stateDir, FILE));
}
