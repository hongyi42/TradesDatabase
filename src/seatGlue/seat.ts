import type { CallRef } from './costLog.js';
import { SPINE_NAMES, type BlobAttachment, type EngineEvent, type EngineSession } from './engine.js';
import { classify, type Inbound } from './inbound.js';
import { InboxRefused, type InboxItem, type InboxResult } from './inbox.js';
import { HANDLED_IDS_KEPT, type PendingItem, type SeatState } from './state.js';
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
  // Step 3 (operator, 2026-09-23): sent once per seat, the first time the glue
  // runs with the office wired in. No em dashes; names AI (customer-facing copy).
  disclosure: 'Heads up from your AI assistant: the office can read our chats here, and your managers can ask it about them.',
} as const;

/** Office items kept for the person's next message (oldest dropped past this). */
export const PENDING_KEPT = 30;
/** Each waiting item's text is cut here: the block rides every next message. */
export const PENDING_TEXT_MAX = 1_000;

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
  /**
   * Step 3: the seat's inbox on Render. Absent = no office traffic (tests, and
   * the local driver, which must never drain a real person's inbox).
   */
  inbox?: {
    fetch(): Promise<InboxResult>;
    report(r: { id: string; leg: InboxItem['leg']; outcome: 'delivered' | 'failed'; detail?: string }): Promise<void>;
  };
  /** Who the seat was at start (whoami): an inbox pull that disagrees means the seat changed. */
  who?: { telegramUserId: number; tz: string };
  /**
   * The seat changed under the running glue. 0 = rebind or timezone (restart and
   * ask whoami again); 1 = token refused (restart: a reinstall rotated it);
   * 4 = deactivated or unbound (stay down).
   */
  onSeatChanged?: (code: 0 | 1 | 4) => void;
  pollInboxMs?: number;
  /**
   * Step 3: the conversation, uploaded for the office to read (transcript.ts).
   * Absent = nothing recorded (tests, the local driver).
   */
  transcript?: {
    person(text: string, sessionId: string | null): void;
    assistant(text: string, sessionId: string | null): void;
    toolStart(callId: string, tool: string, args: unknown, sessionId: string | null): void;
    toolDone(callId: string, ok: boolean): void;
    settleOpenTools(): void;
    flush(): Promise<void>;
  };
}

export class Seat {
  private session: EngineSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private state: SeatState = { sessionId: null, offset: 0 };
  private chatId: number;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  /** The "Working…" line's message id, once Telegram has it (null = could not post). */
  private workingLine: Promise<number | null> | null = null;
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
  /** Every state write, in order: the update loop and the inbox poller both write. */
  private writeChain: Promise<void> = Promise.resolve();
  private inboxTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** The one-time office notice while it is being sent and saved. */
  private disclosing: Promise<void> = Promise.resolve();
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
    if (this.deps.inbox) {
      this.disclosing = this.disclose();
      await this.disclosing;
      void this.pollInbox();
      this.inboxTimer = setInterval(() => {
        void this.pollInbox();
        // The retry for an upload that failed at the end of a reply.
        void this.deps.transcript?.flush();
      }, this.deps.pollInboxMs ?? 10_000);
      this.inboxTimer.unref?.();
    }
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

  /**
   * Resolves once an inbox pull in flight has finished and every state write
   * has landed. The shutdown waits on it: exiting between an office text going
   * out and its id being saved would text the person again after the restart.
   */
  async settle(pollMs = 50): Promise<void> {
    await this.disclosing; // never rejects: disclose() catches its own failure
    while (this.polling) await new Promise((r) => setTimeout(r, pollMs));
    await this.writeChain;
  }

  stop(): void {
    this.stopped = true;
    this.stopWorking();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.inboxTimer) clearInterval(this.inboxTimer);
  }

  /**
   * Move the offset past an update BEFORE handling it, then handle it. At most
   * once, on purpose: a crash mid-handling loses that one message, where saving
   * after would re-send it on restart — and a re-sent "file a note" can land a
   * duplicate in L1, which has no delete. A failed update is never retried
   * (no poison loops).
   */
  async handleUpdate(update: TgUpdate): Promise<void> {
    this.processing += 1;
    try {
      await this.persist({ offset: update.update_id + 1 });
      await this.handle(classify(update, this.deps.allowedUserId));
    } catch (err) {
      this.log(`update ${update.update_id} failed: ${errText(err)}`);
      await this.say(TEXT.replyFailed);
    } finally {
      this.processing -= 1;
    }
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
        return this.stopReply(msg.callbackQueryId, msg.workingMessageId);
      case 'new':
        return this.startFresh();
      case 'text':
        this.deps.transcript?.person(msg.text, this.sessionId);
        return this.deliver(msg.text);
      case 'photo': {
        const buf = await this.deps.telegram.download(msg.fileId);
        await this.keepCopy(buf, 'jpg');
        // Bytes only. The saved path never goes near the model: L1 is permanent
        // and the file is deleted in a week.
        const photo: BlobAttachment = { type: 'blob', data: buf.toString('base64'), mimeType: 'image/jpeg', displayName: 'photo.jpg' };
        this.deps.transcript?.person(msg.caption ?? '(photo)', this.sessionId);
        return this.deliver(msg.caption ?? '(photo)', [photo]);
      }
      case 'voice': {
        const buf = await this.deps.telegram.download(msg.fileId);
        await this.keepCopy(buf, msg.mimeType.includes('wav') ? 'wav' : 'ogg');
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
        this.deps.transcript?.person(`[voice note] ${transcript.text}`, this.sessionId);
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
      this.startWorking();
    }
    // Office items ride HERE, at the send, and nowhere earlier: the abort-then-
    // send recursion above re-enters with the RAW prompt, so the block is never
    // doubled, and it is cleared only once a send has carried it.
    const carried = this.state.pending ?? [];
    try {
      await session.send({
        prompt: this.withPending(prompt, carried),
        ...(attachments ? { attachments } : {}),
        ...(route === 'steer' ? { mode: 'immediate' as const } : {}),
      });
      if (carried.length) await this.clearPending(carried);
      if (route === 'steer') this.log('double text mid-tool: steered into the running reply');
    } catch (err) {
      this.log(`send failed: ${errText(err)}`);
      // Nothing is running unless this was a steer into a live reply: a fresh
      // turn never started, and after abort-then-send the old loop is dead.
      if (route !== 'steer') {
        policy.finish();
        this.stopWorking();
      }
      await this.say(TEXT.replyFailed);
    }
  }

  private async stopReply(callbackQueryId?: string, tappedMessageId?: number): Promise<void> {
    const { telegram, policy } = this.deps;
    // A tap on a "Working…" line left over from a reply that already ended:
    // acknowledge it quietly and remove the line — nothing to stop, nothing to say.
    if (callbackQueryId && !policy.isBusy) {
      void telegram.answerCallback(callbackQueryId, 'Nothing to stop').catch(() => {});
      if (tappedMessageId !== undefined) void telegram.deleteMessage(this.chatId, tappedMessageId).catch(() => {});
      return;
    }
    // Telegram spins the button until the tap is answered.
    if (callbackQueryId) void telegram.answerCallback(callbackQueryId, 'Stopping…').catch(() => {});
    // Never abort mid-tool: a note filed while the model believes it was
    // interrupted gets filed again. The wait happens HERE, inside the
    // one-at-a-time update loop, so anything sent after Stop queues behind it.
    // The one exception is ask_team_lead (ABORT_SAFE_TOOLS): the office can take
    // minutes and stops itself when the caller hangs up, so Stop cuts it off.
    await this.toolsSettled({ interruptAbortSafe: true });
    if (policy.isBusy) await this.abortReply();
    this.stopWorking();
    await this.say(TEXT.stopped);
  }

  private async abortReply(): Promise<void> {
    const { done, first } = this.deps.policy.beginAbort();
    if (first) {
      if (this.session) await this.abortAndWait(this.session, done);
      else this.deps.policy.cancelAbort(false); // nothing to abort: never leave a waiter behind
    } else await this.waitFor(done);
    this.deps.policy.finish();
    this.stopWorking();
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
    if (this.state.sessionId !== session.sessionId) await this.persist({ sessionId: session.sessionId });
  }

  /**
   * Merge into the state and write it — every write through ONE chain, so the
   * inbox poller and the update loop never write over each other with a stale
   * copy. The patch is applied synchronously; the write that follows carries
   * everything merged so far. A failed write rejects to its caller only.
   */
  private persist(patch: Partial<SeatState> | ((s: SeatState) => Partial<SeatState>)): Promise<void> {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
    const snapshot = this.state;
    const run = this.writeChain.then(() => this.deps.writeState(snapshot));
    this.writeChain = run.catch(() => {});
    return run;
  }

  // ── step 3: the office's items ────────────────────────────────────────────

  /** One pull of the inbox. Public so a test can drive it without a timer. */
  async pollInbox(): Promise<void> {
    const { inbox, who } = this.deps;
    if (!inbox || !who || this.polling || this.stopped) return;
    this.polling = true;
    try {
      let got: InboxResult;
      try {
        got = await inbox.fetch();
      } catch (err) {
        if (err instanceof InboxRefused) {
          this.log(
            err.status === 403
              ? 'Render says this seat\'s person is deactivated — stopping'
              : 'Render refused this seat\'s token (rotated by a reinstall?) — restarting',
          );
          this.deps.onSeatChanged?.(err.status === 403 ? 4 : 1);
          return;
        }
        this.log(`inbox pull failed: ${errText(err)}`);
        return;
      }
      if (got.seat.telegramUserId === null) {
        this.log('this seat has no Telegram account bound any more — stopping');
        this.deps.onSeatChanged?.(4);
        return;
      }
      if (got.seat.telegramUserId !== String(who.telegramUserId) || got.seat.timezone !== who.tz) {
        this.log('this seat changed on Render (Telegram account or timezone) — restarting to pick it up');
        this.deps.onSeatChanged?.(0);
        return;
      }
      for (const item of got.items) {
        if (this.stopped) return;
        await this.takeItem(item);
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * A phone item goes to Telegram first; every item then waits for the person's
   * next message. An id already handled is re-acked and never re-sent — the
   * report was lost, not the message (the runners' sent-marker rule).
   */
  private async takeItem(item: InboxItem): Promise<void> {
    if ((this.state.handledIds ?? []).includes(item.id)) return this.reportItem(item, 'delivered');
    if (item.leg === 'phone') {
      try {
        await this.sendOrThrow(item.text);
      } catch (err) {
        this.log(`office text ${item.id} did not send: ${errText(err)}`);
        return this.reportItem(item, 'failed', 'telegram send failed');
      }
    }
    const waiting: PendingItem = {
      id: item.id,
      leg: item.leg,
      text: item.text.length > PENDING_TEXT_MAX ? `${item.text.slice(0, PENDING_TEXT_MAX)}…` : item.text,
      at: new Date().toISOString(),
    };
    try {
      await this.persist((st) => {
        const pending = [...(st.pending ?? []), waiting];
        if (pending.length > PENDING_KEPT) {
          this.log(`${pending.length - PENDING_KEPT} office item(s) dropped from the waiting list (over ${PENDING_KEPT})`);
        }
        return {
          pending: pending.slice(-PENDING_KEPT),
          handledIds: [...(st.handledIds ?? []), item.id].slice(-HANDLED_IDS_KEPT),
        };
      });
    } catch (err) {
      // The text already went out: settle it anyway rather than text it twice.
      this.log(`could not save office item ${item.id}: ${errText(err)}`);
    }
    await this.reportItem(item, 'delivered');
  }

  private async reportItem(item: InboxItem, outcome: 'delivered' | 'failed', detail?: string): Promise<void> {
    try {
      await this.deps.inbox?.report({ id: item.id, leg: item.leg, outcome, ...(detail ? { detail } : {}) });
    } catch (err) {
      // Render re-serves an unacked item; the handled list re-acks it then.
      this.log(`inbox report for ${item.id} failed: ${errText(err)}`);
    }
  }

  /** The one-time notice that the office can read these chats (operator, 2026-09-23). */
  private async disclose(): Promise<void> {
    if (this.state.disclosed) return;
    try {
      await this.sendOrThrow(TEXT.disclosure);
      await this.persist({ disclosed: true });
    } catch (err) {
      this.log(`the office notice did not go out (${errText(err)}) — trying again at the next start`);
    }
  }

  /** Office items since the person last wrote, on top of their message. */
  private withPending(prompt: string, items: PendingItem[]): string {
    if (!items.length) return prompt;
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.deps.who?.tz ?? 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const lines = items.map((p) =>
      p.leg === 'phone' ? `- You texted them (${time.format(new Date(p.at))}): "${p.text}"` : `- ${p.text}`,
    );
    return ['[Since your person last wrote — for you, not from them]', ...lines, '[Their message]', prompt].join('\n');
  }

  private async clearPending(carried: PendingItem[]): Promise<void> {
    const ids = new Set(carried.map((p) => p.id));
    try {
      await this.persist((st) => ({ pending: (st.pending ?? []).filter((p) => !ids.has(p.id)) }));
    } catch (err) {
      this.log(`could not clear the office items just shown: ${errText(err)}`);
    }
  }

  private onEvent(e: EngineEvent): void {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const { policy } = this.deps;
    switch (e.type) {
      case 'tool.execution_complete':
        this.activityCount += 1;
        if (typeof data.toolCallId === 'string') this.deps.transcript?.toolDone(data.toolCallId, data.success === true);
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
        // Spine tools only, told apart by SERVER name (SPINE_NAMES holds server
        // names, never tool names). mcpToolName is the tool's own name, without
        // the engine's `spine-` prefix.
        if (typeof data.toolCallId === 'string' && typeof data.mcpServerName === 'string' && SPINE_NAMES.has(data.mcpServerName)) {
          const name = typeof data.mcpToolName === 'string' ? data.mcpToolName : String(data.toolName ?? '');
          this.deps.transcript?.toolStart(data.toolCallId, name, data.arguments, this.sessionId);
        }
        return;
      case 'session.idle': {
        this.idleCount += 1;
        this.releaseHeldText();
        this.deps.transcript?.settleOpenTools();
        void this.deps.transcript?.flush();
        const result = policy.onIdle(data.aborted === true);
        if (result === 'idle') this.stopWorking();
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
              this.stopWorking();
            }
          }, this.deps.errorIdleWaitMs ?? 5_000);
          timer.unref?.();
        }
        return;
      }
    }
  }

  /** The 7-day box copy is a convenience: failing to keep it must never lose the message. */
  private async keepCopy(buf: Buffer, ext: string): Promise<void> {
    try {
      await this.deps.saveMedia(buf, ext);
    } catch (err) {
      this.log(`could not keep a copy of the ${ext} (${errText(err)}) — carrying on`);
    }
  }

  /** The model call ended: send its text as separate messages, unless it asked for a tool. */
  private releaseHeldText(): void {
    const texts = this.heldText;
    const hadTool = this.heldCallHadTool;
    this.heldText = [];
    this.heldCallHadTool = false;
    if (hadTool) return;
    // The answer is here: the "Working…" line goes first (through the same
    // ordered outbox), typing carries on until the reply really ends.
    if (texts.length) this.clearWorkingLine();
    for (const text of texts) {
      this.deps.transcript?.assistant(text, this.sessionId);
      void this.say(text);
    }
  }

  private say(text: string): Promise<void> {
    this.outbox = this.outbox
      .then(() => this.deps.telegram.send(this.chatId, text))
      .catch((err: unknown) => this.log(`send to Telegram failed: ${errText(err)}`));
    return this.outbox;
  }

  /**
   * In order with every other message, like say() — but the caller SEES a
   * failure: an office text that did not go out must be reported failed, and a
   * notice that did not go out must not be marked sent. The outbox itself
   * carries on either way.
   */
  private sendOrThrow(text: string): Promise<void> {
    const run = this.outbox.then(() => this.deps.telegram.send(this.chatId, text));
    this.outbox = run.catch((err: unknown) => this.log(`send to Telegram failed: ${errText(err)}`));
    return run;
  }

  /** A reply started: typing, plus the "Working…" line with its Stop button. */
  private startWorking(): void {
    this.startTyping();
    if (!this.workingLine) {
      this.workingLine = this.deps.telegram.sendWorking(this.chatId).catch((err: unknown) => {
        this.log(`could not post the Working line: ${errText(err)}`);
        return null;
      });
    }
  }

  /** The reply is over (or stopped): typing stops and the "Working…" line goes. */
  private stopWorking(): void {
    this.stopTyping();
    this.clearWorkingLine();
  }

  private clearWorkingLine(): void {
    const line = this.workingLine;
    if (!line) return;
    this.workingLine = null;
    this.outbox = this.outbox
      .then(() => line)
      .then((id) => (id === null ? undefined : this.deps.telegram.deleteMessage(this.chatId, id)))
      .catch((err: unknown) => this.log(`could not remove the Working line: ${errText(err)}`));
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
