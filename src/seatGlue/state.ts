import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The glue's own memory, beside the engine's session files: which conversation
// is the seat's current one, and how far through Telegram's update stream it
// has read. Written temp-file-then-rename so a crash never leaves half a file.
//
// Step 3 added the office's side: items waiting to ride the person's next
// message, the ids already handled (so a re-served item is re-acked, never
// re-sent), and whether the one-time "the office can read our chats" notice has
// gone out. They live here because they must survive a restart exactly as the
// offset does — a lost list would re-text the person.

/** An office item waiting to be shown to the model on top of the person's next message. */
export interface PendingItem {
  id: string;
  leg: 'phone' | 'note';
  text: string;
  /** When the glue handled it (ISO). */
  at: string;
}

export interface SeatState {
  sessionId: string | null;
  /** The next Telegram update_id to ask for (last seen + 1). */
  offset: number;
  pending?: PendingItem[];
  handledIds?: string[];
  disclosed?: boolean;
}

/** How many handled ids are remembered — far more than one pull ever serves. */
export const HANDLED_IDS_KEPT = 500;

const FILE = 'state.json';

export async function readState(stateDir: string): Promise<SeatState> {
  try {
    const raw = JSON.parse(await readFile(join(stateDir, FILE), 'utf8')) as Partial<SeatState>;
    return {
      sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
      offset: Number.isInteger(raw.offset) ? (raw.offset as number) : 0,
      pending: Array.isArray(raw.pending) ? raw.pending.filter(isPending) : [],
      handledIds: Array.isArray(raw.handledIds) ? raw.handledIds.filter((x) => typeof x === 'string') : [],
      disclosed: raw.disclosed === true,
    };
  } catch {
    return { sessionId: null, offset: 0, pending: [], handledIds: [], disclosed: false };
  }
}

function isPending(x: unknown): x is PendingItem {
  const p = x as PendingItem;
  return (
    !!p &&
    typeof p.id === 'string' &&
    (p.leg === 'phone' || p.leg === 'note') &&
    typeof p.text === 'string' &&
    typeof p.at === 'string'
  );
}

export async function writeState(stateDir: string, state: SeatState): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  // A unique temp name per write: the inbox poller and the update loop both
  // write, and two writes sharing one temp file can rename a torn file.
  const tmp = join(stateDir, `${FILE}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, join(stateDir, FILE));
}
