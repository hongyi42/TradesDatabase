import type { CallRef } from './costLog.js';
import type { BlobAttachment, EngineEvent, EngineSession } from './engine.js';
import { classify, type Inbound } from './inbound.js';
import type { SeatState } from './state.js';
import { TelegramConflictError, type TelegramApi, type TgUpdate } from './telegram.js';
import type { TurnPolicy } from './turnPolicy.js';

// One technician seat: Telegram in, the Copilot engine in the middle, Telegram
// out. Everything outside is injected so the whole loop runs in tests against a
// fake engine and a fake Telegram.
//
// Updates are handled ONE AT A TIME, in order: a message is never processed
// while an earlier one is still settling (an abort waiting for its idle, a voice
// note being transcribed). The engine's events arrive asynchronously and only
// drive the turn policy, delivery and the cost log.

export const TEXT = {
  stopped: 'Stopped.',
  fresh: 'Starting fresh.',
  unsupported: 'I can read texts, photos and voice notes.',
  voiceFailed: "I couldn't make out that voice note. Could you type it?",
  replyFailed: "I couldn't answer that just now. Try again in a minute.",
} as const;

export interface SeatDeps {
  telegram: TelegramApi;
  /** Resume the given conversation, or start one when null. */
  openSession(sessionId: string | null): Promise<EngineSession>;
  policy: TurnPolicy;
  costLog: { record(ref: CallRef): Promise<unknown> };
  transcribe(buf: Buffer, mime: string): Promise<{ text: string; generationId: string | null }>;
  /** Keeps the bytes on the box for a while. The returned path must never reach the model. */
  saveMedia(buf: Buffer, ext: string): Promise<string>;
  sweepMedia(): Promise<number>;
  readState(): Promise<SeatState>;
  writeState(state: SeatState): Promise<void>;
  allowedUserId: number;
  log?: (msg: string) => void;
  /** How long to wait for an abort's idle before sending anyway. */
  abortWaitMs?: number;
  typingEveryMs?: number;
  sweepEveryMs?: number;
  /** Pause after a failed poll (network blip). */
  pollRetryMs?: number;
  /** After a session.error, how long to wait for an idle before ending the reply. */
  errorIdleWaitMs?: number;
  /** How long a Stop or /new waits for an in-flight spine tool. */
  toolWaitMs?: number;
}

export class Seat {
  private session: EngineSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private state: SeatState = { sessionId: null, offset: 0 };
  private chatId: number;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private outbox: Promise<void> = Promise.resolve();
  private idleCount = 0;
  /** Engine events that show a loop is still running (see the session.error timer). */
  private activityCount = 0;
  private toolSettledWaiters: Array<() => void> = [];
  /** Text of the model call in progress, held until the call shows whether it asked for a tool. */
  private heldText: string[] = [];
  private heldCallHadTool = false;
  private readonly readyGate: { promise: Promise<void>; resolve: () => void };
  private errorToldFor: string | null = null;
  private stopped = false;
  private processing = 0;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: SeatDeps) {
    this.log = deps.log ?? ((m) => console.log(`seat-glue: ${m}`));
    // Private chats only (the allowlist), so the chat id IS the person's id.
    this.chatId = deps.allowedUserId;
    let resolve = () => {};
    const promise = new Promise<void>((r) => (resolve = r));
    this.readyGate = { promise, resolve };
  }

  /** Resolves once the conversation is open and the seat is taking updates. */
  get ready(): Promise<void> {
    return this.readyGate.promise;
  }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  get idle(): boolean {
    return !this.deps.policy.isBusy;
  }

  async start(): Promise<void> {
    this.state = await this.deps.readState();
    await this.attach(await this.deps.openSession(this.state.sessionId));
    await this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), this.deps.sweepEveryMs ?? 3_600_000);
    this.sweepTimer.unref?.();
    this.readyGate.resolve();
  }

  /** Poll until stop(). A TelegramConflictError is rethrown: another poller owns the bot. */
  async run(): Promise<void> {
    await this.start();
    while (!this.stopped) {
      let updates: TgUpdate[];
      try {
        updates = await this.deps.telegram.getUpdates(this.state.offset);
      } catch (err) {
        if (err instanceof TelegramConflictError) throw err;
        this.log(`poll failed: ${errText(err)}`);
        await new Promise((r) => setTimeout(r, this.deps.pollRetryMs ?? 5_000));
        continue;
      }
      for (const u of updates) {
        if (this.stopped) break;
        await this.handleUpdate(u);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopTyping();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Handle one update, then move the offset past it — even if handling failed (no poison loops). */
  async handleUpdate(update: TgUpdate): Promise<void> {
    this.processing += 1;
    try {
      await this.handle(classify(update, this.deps.allowedUserId));
    } catch (err) {
      this.log(`update ${update.update_id} failed: ${errText(err)}`);
    } finally {
      this.processing -= 1;
    }
    this.state = { ...this.state, offset: update.update_id + 1 };
    await this.deps.writeState(this.state);
  }

  /**
   * Resolves when no update is being handled (a voice note spends seconds in
   * transcription before any reply starts), no reply is in progress, and every
   * queued Telegram message went out.
   */
  async whenIdle(pollMs = 100): Promise<void> {
    while (this.processing > 0 || this.deps.policy.isBusy) await new Promise((r) => setTimeout(r, pollMs));
    await this.outbox;
  }

  private async handle(msg: Inbound): Promise<void> {
    switch (msg.kind) {
      case 'ignored':
        return;
      case 'unsupported':
        return this.say(TEXT.unsupported);
      case 'stop':
        return this.stopReply();
      case 'new':
        return this.startFresh();
      case 'text':
        return this.deliver(msg.text);
      case 'photo': {
        const buf = await this.deps.telegram.download(msg.fileId);
        await this.deps.saveMedia(buf, 'jpg');
        // Bytes only. The saved path never goes near the model: L1 is permanent
        // and the file is deleted in a week.
        const photo: BlobAttachment = { type: 'blob', data: buf.toString('base64'), mimeType: 'image/jpeg', displayName: 'photo.jpg' };
        return this.deliver(msg.caption ?? '(photo)', [photo]);
      }
      case 'voice': {
        const buf = await this.deps.telegram.download(msg.fileId);
        await this.deps.saveMedia(buf, msg.mimeType.includes('wav') ? 'wav' : 'ogg');
        let transcript: { text: string; generationId: string | null };
        try {
          transcript = await this.deps.transcribe(buf, msg.mimeType);
        } catch (err) {
          this.log(`transcription failed: ${errText(err)}`);
          return this.say(TEXT.voiceFailed);
        }
        if (transcript.generationId) {
          void this.deps.costLog.record({
            generationId: transcript.generationId,
            // The reply this transcript feeds, so the $0.02 check counts it there.
            replyId: this.deps.policy.currentReplyId(),
            sessionId: this.sessionId,
            kind: 'transcribe',
          });
        }
        return this.deliver(`[voice note] ${transcript.text}`);
      }
    }
  }

  /** Send a message into the conversation, per the turn policy. */
  private async deliver(prompt: string, attachments?: BlobAttachment[]): Promise<void> {
    // No conversation open (a /new whose open failed): reopen the recorded one,
    // or a fresh one, rather than going silent until a restart.
    if (!this.session) {
      try {
        await this.attach(await this.deps.openSession(this.state.sessionId));
      } catch (err) {
        this.log(`could not open a conversation: ${errText(err)}`);
        return this.say(TEXT.replyFailed);
      }
    }
    const session = this.session as EngineSession;
    const { policy } = this.deps;
    const route = policy.route();

    if (route === 'abort-then-send') {
      const { done, first } = policy.beginAbort();
      if (first) {
        this.log('double text mid-answer: abort, then send only the new text');
        await this.abortAndWait(session, done);
      } else {
        await this.waitFor(done);
        return this.deliver(prompt, attachments); // another abort won: route again
      }
    }

    const freshTurn = !policy.isBusy;
    policy.onSend();
    if (freshTurn) {
      this.errorToldFor = null;
      this.startTyping();
    }
    try {
      await session.send({
        prompt,
        ...(attachments ? { attachments } : {}),
        ...(route === 'steer' ? { mode: 'immediate' as const } : {}),
      });
      if (route === 'steer') this.log('double text mid-tool: steered into the running reply');
    } catch (err) {
      this.log(`send failed: ${errText(err)}`);
      if (freshTurn) {
        policy.finish();
        this.stopTyping();
      }
      await this.say(TEXT.replyFailed);
    }
  }

  private async stopReply(): Promise<void> {
    // Never abort mid-tool: a note filed while the model believes it was
    // interrupted gets filed again. The wait happens HERE, inside the
    // one-at-a-time update loop, so anything sent after Stop queues behind it.
    // The one exception is ask_team_lead (ABORT_SAFE_TOOLS): the office can take
    // minutes and stops itself when the caller hangs up, so Stop cuts it off.
    await this.toolsSettled({ interruptAbortSafe: true });
    if (this.deps.policy.isBusy) await this.abortReply();
    await this.say(TEXT.stopped);
  }

  private async abortReply(): Promise<void> {
    const { done, first } = this.deps.policy.beginAbort();
    if (first) {
      if (this.session) await this.abortAndWait(this.session, done);
      else this.deps.policy.cancelAbort(false); // nothing to abort: never leave a waiter behind
    } else await this.waitFor(done);
    this.deps.policy.finish();
    this.stopTyping();
  }

  /**
   * Abort and wait for the abort's idle — bounded. If the abort call fails or
   * its idle never comes, the policy drops the waiter (cancelAbort); a waiter
   * left behind would swallow the next reply's real idle and keep the seat busy
   * for good.
   */
  private async abortAndWait(session: EngineSession, done: Promise<void>): Promise<void> {
    try {
      await session.abort();
    } catch (err) {
      this.log(`abort failed: ${errText(err)}`);
      this.deps.policy.cancelAbort(false);
      return;
    }
    if (!(await this.waitFor(done))) this.deps.policy.cancelAbort(true);
  }

  private async startFresh(): Promise<void> {
    // Never abort mid-tool (a note filed after the conversation was dropped is
    // filed but never mentioned). Wait inside the update loop, like Stop.
    await this.toolsSettled({ interruptAbortSafe: true });
    if (this.deps.policy.isBusy) await this.abortReply();
    const old = this.session;
    this.unsubscribe?.();
    this.session = null;
    await old?.disconnect().catch((err: unknown) => this.log(`disconnect failed: ${errText(err)}`));
    try {
      await this.attach(await this.deps.openSession(null));
    } catch (err) {
      this.log(`could not start a fresh conversation: ${errText(err)}`);
      return this.say(TEXT.replyFailed);
    }
    await this.say(TEXT.fresh);
  }

  private async attach(session: EngineSession): Promise<void> {
    this.session = session;
    this.unsubscribe = session.on((e) => this.onEvent(e));
    if (this.state.sessionId !== session.sessionId) {
      this.state = { ...this.state, sessionId: session.sessionId };
      await this.deps.writeState(this.state);
    }
  }

  private onEvent(e: EngineEvent): void {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const { policy } = this.deps;
    switch (e.type) {
      case 'tool.execution_complete':
        this.activityCount += 1;
        policy.onToolComplete(typeof data.toolCallId === 'string' ? data.toolCallId : undefined);
        this.releaseToolWaiters();
        return;
      case 'assistant.turn_start':
        this.activityCount += 1;
        this.heldText = [];
        this.heldCallHadTool = false;
        return;
      case 'assistant.turn_end':
        this.releaseHeldText();
        return;
      case 'tool.execution_start':
        this.activityCount += 1;
        return;
      case 'session.idle': {
        this.idleCount += 1;
        this.releaseHeldText();
        const result = policy.onIdle(data.aborted === true);
        if (result === 'idle') this.stopTyping();
        // Idle clears pending tools even when no completion named them (an
        // id-less permission request), so a waiting Stop or /new moves on here too.
        this.releaseToolWaiters();
        return;
      }
      case 'assistant.message': {
        // Held, not sent: text from a model call that ends in a tool request is
        // the model narrating its own steps — live on 2026-09-22 Gemini's thought
        // summaries ("**Checking Tomorrow's Schedule** I'm currently focused on…")
        // arrived as message text right before each tool call, five texts for one
        // note. Only a call that answers without a tool reaches the person
        // (openclaw's behaviour: the final answer). Empty messages (the responses
        // wire ends some turns with one) are never sent.
        this.activityCount += 1;
        if (Array.isArray(data.toolRequests) && data.toolRequests.length) this.heldCallHadTool = true;
        const content = typeof data.content === 'string' ? data.content.trim() : '';
        if (content) this.heldText.push(content);
        return;
      }
      case 'assistant.usage':
      case 'model.call_failure':
        // Both carry the OpenRouter generation id; the cost log keeps one line per id.
        if (typeof data.apiCallId === 'string' && data.apiCallId) {
          void this.deps.costLog.record({
            generationId: data.apiCallId,
            replyId: policy.isBusy ? policy.currentReplyId() : null,
            sessionId: this.sessionId,
            kind: 'seat',
          });
        }
        return;
      case 'session.error': {
        this.log(`session error: ${String(data.errorType ?? '')} ${String(data.message ?? '')}`.trim());
        // An OpenRouter 429 or the key's monthly cap otherwise leaves the person
        // with silence. Once per reply.
        const reply = policy.isBusy ? policy.currentReplyId() : null;
        if (reply && this.errorToldFor !== reply) {
          this.errorToldFor = reply;
          void this.say(TEXT.replyFailed);
        }
        // An error can end the loop without a session.idle (the SDK's own
        // sendAndWait treats it as terminal). If no idle follows, end the reply
        // here, or the seat stays busy and every later text waits on an abort.
        // Any sign of life since the error (a new model turn, a message, a tool)
        // means the loop is still running: leave it alone.
        if (reply) {
          const idlesAtError = this.idleCount;
          const activityAtError = this.activityCount;
          const timer = setTimeout(() => {
            const quiet = this.idleCount === idlesAtError && this.activityCount === activityAtError;
            if (quiet && policy.isBusy && policy.currentReplyId() === reply && !policy.toolPending) {
              this.log('no idle after the error — ending the reply');
              policy.finish();
              this.stopTyping();
            }
          }, this.deps.errorIdleWaitMs ?? 5_000);
          timer.unref?.();
        }
        return;
      }
    }
  }

  /** The model call ended: send its text as separate messages, unless it asked for a tool. */
  private releaseHeldText(): void {
    const texts = this.heldText;
    const hadTool = this.heldCallHadTool;
    this.heldText = [];
    this.heldCallHadTool = false;
    if (hadTool) return;
    for (const text of texts) void this.say(text);
  }

  private say(text: string): Promise<void> {
    this.outbox = this.outbox
      .then(() => this.deps.telegram.send(this.chatId, text))
      .catch((err: unknown) => this.log(`send to Telegram failed: ${errText(err)}`));
    return this.outbox;
  }

  private startTyping(): void {
    this.stopTyping();
    const tick = () => void this.deps.telegram.typing(this.chatId).catch(() => {});
    tick();
    this.typingTimer = setInterval(tick, this.deps.typingEveryMs ?? 4_000);
    this.typingTimer.unref?.();
  }

  private stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  /**
   * Resolves once no spine tool is pending — or at once, when every pending tool
   * is one a Stop may interrupt. Bounded by toolWaitMs, so a hung tool cannot
   * hold the seat for the MCP call's full 300 s.
   */
  private async toolsSettled(opts: { interruptAbortSafe: boolean }): Promise<void> {
    const { policy } = this.deps;
    if (!policy.toolPending) return;
    if (opts.interruptAbortSafe && policy.onlyAbortSafePending) return;
    const done = new Promise<void>((resolve) => this.toolSettledWaiters.push(resolve));
    if (!(await this.waitFor(done, this.deps.toolWaitMs ?? 90_000))) {
      this.log('a tool did not settle in time — carrying on');
    }
  }

  private releaseToolWaiters(): void {
    if (this.deps.policy.toolPending || !this.toolSettledWaiters.length) return;
    for (const w of this.toolSettledWaiters.splice(0)) w();
  }

  /** True when `done` resolved; false when the wait timed out. */
  private async waitFor(done: Promise<void>, ms = this.deps.abortWaitMs ?? 15_000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      done.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), ms);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) this.log(`gave up waiting after ${ms} ms — carrying on`);
    return !timedOut;
  }

  private async sweep(): Promise<void> {
    try {
      const n = await this.deps.sweepMedia();
      if (n) this.log(`deleted ${n} media file(s) past retention`);
    } catch (err) {
      this.log(`media sweep failed: ${errText(err)}`);
    }
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
