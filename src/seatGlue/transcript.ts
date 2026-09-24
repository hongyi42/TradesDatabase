import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultFetch, type FetchLike } from './http.js';
import { seatHeaders } from './identity.js';

// The seat's conversation, uploaded to Render as it happens (step 3, plan
// 2026-09-23-step-3-office-reaches-glue-seats), so the office READS what this
// assistant knows instead of asking it (operator, 2026-09-23).
//
// What is recorded (operator: "words + tool calls"): what the person wrote,
// what reached them from the assistant, and each spine tool call — its name,
// its arguments and whether it succeeded. Never a tool's RESULT (record data
// the office already reads), never media bytes, never the office block that
// rides on top of a message (the office wrote that; it is not the person's).
//
// Nothing is lost to a Render outage or a restart: unsent turns wait in
// <stateDir>/transcript-outbox.json and go on the next flush. Each turn carries
// an id minted here, so a batch re-sent after a lost response is stored once.

export type TurnRole = 'person' | 'assistant' | 'tool';

export interface TurnRecord {
  id: string;
  sessionId: string;
  at: string;
  role: TurnRole;
  text?: string;
  tool?: string;
  args?: unknown;
  /** Tool turns only: undefined while the call is running; null = its outcome never came. */
  ok?: boolean | null;
}

/** Oldest turns are dropped past this — a seat cut off from Render for days. */
export const OUTBOX_KEPT = 2_000;
/** Render takes at most this many turns per upload. */
export const UPLOAD_BATCH = 200;
const FILE = 'transcript-outbox.json';

export interface TranscriptConfig {
  spineUrl: string;
  seatToken: string;
  stateDir: string;
  log?: (msg: string) => void;
}

export interface TranscriptDeps {
  fetch?: FetchLike;
  now?: () => Date;
  newId?: () => string;
}

export class Transcript {
  private queue: TurnRecord[] = [];
  private readonly toolTurns = new Map<string, TurnRecord>();
  private writeChain: Promise<void> = Promise.resolve();
  private flushing: Promise<void> | null = null;
  private readonly log: (msg: string) => void;
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly cfg: TranscriptConfig,
    deps: TranscriptDeps = {},
  ) {
    this.log = cfg.log ?? ((m) => console.log(`seat-glue: ${m}`));
    this.fetchFn = deps.fetch ?? defaultFetch;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /** Pick up turns a previous run could not upload. Call once, before recording. */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(join(this.cfg.stateDir, FILE), 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        // A tool call saved while running belongs to a process that is gone: its
        // completion will never come. Unknown, not running — or it would hold
        // back every upload after it for good.
        const loaded = (raw as TurnRecord[]).map((t) => (t.role === 'tool' && t.ok === undefined ? { ...t, ok: null } : t));
        this.queue = [...loaded, ...this.queue];
      }
    } catch {
      // No outbox yet, or an unreadable one: start empty.
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  person(text: string, sessionId: string | null): void {
    this.add({ role: 'person', text }, sessionId);
  }

  assistant(text: string, sessionId: string | null): void {
    this.add({ role: 'assistant', text }, sessionId);
  }

  toolStart(callId: string, tool: string, args: unknown, sessionId: string | null): void {
    const turn = this.add({ role: 'tool', tool, ...(args === undefined ? {} : { args }) }, sessionId);
    this.toolTurns.set(callId, turn);
  }

  toolDone(callId: string, ok: boolean): void {
    const turn = this.toolTurns.get(callId);
    if (!turn) return;
    this.toolTurns.delete(callId);
    turn.ok = ok;
    void this.save();
  }

  /**
   * The reply ended (session.idle): a tool call with no completion by now never
   * reports one (an aborted loop, an id-less completion). Mark it unknown so it
   * stops holding back the turns after it.
   */
  settleOpenTools(): void {
    if (!this.toolTurns.size) return;
    for (const turn of this.toolTurns.values()) turn.ok = null;
    this.toolTurns.clear();
    void this.save();
  }

  /**
   * Upload what is ready. A tool call still running holds back itself and every
   * later turn, so its outcome is never uploaded as unknown. One flush at a time.
   */
  flush(): Promise<void> {
    this.flushing ??= this.runFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    for (;;) {
      const running = this.queue.findIndex((t) => t.role === 'tool' && t.ok === undefined);
      const ready = running === -1 ? this.queue : this.queue.slice(0, running);
      const batch = ready.slice(0, UPLOAD_BATCH);
      if (!batch.length) return;
      try {
        const res = await this.fetchFn(new URL('/seat/conversation', this.cfg.spineUrl).toString(), {
          method: 'POST',
          headers: { ...seatHeaders(this.cfg.seatToken), 'content-type': 'application/json' },
          body: JSON.stringify({ turns: batch }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          this.log(`conversation upload refused (HTTP ${res.status}) — kept for the next try`);
          return;
        }
      } catch (err) {
        this.log(`conversation upload failed (${err instanceof Error ? err.message : String(err)}) — kept for the next try`);
        return;
      }
      const sent = new Set(batch.map((t) => t.id));
      this.queue = this.queue.filter((t) => !sent.has(t.id));
      await this.save();
    }
  }

  private add(turn: Omit<TurnRecord, 'id' | 'sessionId' | 'at'>, sessionId: string | null): TurnRecord {
    const full: TurnRecord = {
      id: this.newId(),
      sessionId: sessionId ?? 'none',
      at: this.now().toISOString(),
      ...turn,
    };
    this.queue.push(full);
    if (this.queue.length > OUTBOX_KEPT) {
      const dropped = this.queue.length - OUTBOX_KEPT;
      this.queue = this.queue.slice(-OUTBOX_KEPT);
      this.log(`${dropped} conversation turn(s) dropped — Render unreachable for too long`);
    }
    void this.save();
    return full;
  }

  /** One write at a time, temp-file-then-rename (the state.ts rule). Failures are logged, never thrown. */
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.queue);
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
        const tmp = join(this.cfg.stateDir, `${FILE}.${process.pid}.${randomUUID()}.tmp`);
        await writeFile(tmp, snapshot, { mode: 0o600 });
        await rename(tmp, join(this.cfg.stateDir, FILE));
      })
      .catch((err: unknown) => this.log(`could not save the conversation outbox: ${err instanceof Error ? err.message : String(err)}`));
    return this.writeChain;
  }

  /** Resolves once every outbox write so far has landed (tests, shutdown). */
  saved(): Promise<void> {
    return this.writeChain;
  }
}
