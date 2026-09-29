import type { CallRef } from './costLog.js';
import type { BlobAttachment, EngineEvent, EngineSession, ExitPlanRequestLike, ExitPlanResultLike, SeatHooks, UserInputRequestLike, UserInputResponseLike } from './engine.js';
import { SPINE_NAMES } from './engine.js';
import { classify, type Inbound } from './inbound.js';
import { InboxRefused, type InboxItem, type InboxResult } from './inbox.js';
import { PendingPrompts } from './prompts.js';
import { HANDLED_IDS_KEPT, type PendingItem, type SeatState } from './state.js';
import { TelegramConflictError, type ButtonRow, type TelegramApi, type TgUpdate } from './telegram.js';
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
  unsupported: 'I can read texts, photos, voice notes and files.',
  tooBig: 'That file is over 20 MB, too big for me to keep.',
  voiceFailed: "I couldn't make out that voice note. Could you type it?",
  replyFailed: "I couldn't answer that just now. Try again in a minute.",
  promptClosed: 'This question has closed.',
  whatShouldChange: 'What should change?',
  /** Sent once when an approved plan was followed by nothing at all (measured 1/10). */
  goAhead: 'Go ahead with the plan.',
  /** A typed reply to a buttons-only question that names no button. */
  tapAnOption: 'Please tap one of the options above, or type stop.',
  // Step 3 (operator, 2026-09-23): sent once per seat, the first time the glue
  // runs with the office wired in. No em dashes; names AI (customer-facing copy).
  disclosure: 'Heads up from your AI assistant: the office can read our chats here, and your managers can ask it about them.',
} as const;

/** How long a typed plan reply may wait on Jev before it counts as a change request. */
export const APPROVE_WAIT_MS = 3_500;

/** Plan text shown with Go/Change — kept well inside one Telegram message. */
export const PLAN_TEXT_MAX = 3_500;

/** Office items kept for the person's next message (oldest dropped past this). */
export const PENDING_KEPT = 30;
/**
 * Each waiting item's text is cut here: the block rides every next message.
 * Sized to fit the LONGEST office message whole (a 2000-character body plus its
 * framing and the reply id at the END), so a cut can never drop the id an office
 * question tells the assistant to mention.
 */
export const PENDING_TEXT_MAX = 2_500;

export interface SeatDeps {
  telegram: TelegramApi;
  /** Resume the given conversation, or start one when null. `hooks` = how a manager seat asks its person. */
  openSession(sessionId: string | null, hooks?: SeatHooks): Promise<EngineSession>;
  policy: TurnPolicy;
  costLog: { record(ref: CallRef): Promise<unknown> };
  transcribe(buf: Buffer, mime: string): Promise<{ text: string; generationId: string | null }>;
  /** Keeps the bytes on the box for a while. The returned path must never reach the model. */
  saveMedia(buf: Buffer, ext: string): Promise<string>;
  /**
   * Step 2d: keep a photo or document in the file store (Render /seat/files);
   * returns its file id. Absent (tests, an unwired seat) = "could not be saved".
   */
  uploadFile?(f: { kind: 'photo' | 'document'; name: string; mime: string; bytes: Uint8Array }): Promise<string>;
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
  /** Step 2b: called as a reply is stopped (Stop, /new) — kills a manager's running sandbox commands. */
  onAbort?: () => void;
  /** How long a Stop or /new waits for an in-flight spine tool. */
  toolWaitMs?: number;
  /** A manager seat (step 2a): questions and plans reach the person with buttons. */
  manager?: boolean;
  /** Does a TYPED reply to a plan approve it as it stands? (Jev, phase 4.) Absent = never. */
  approvesPlan?(reply: string, planSummary: string): Promise<boolean>;
  /**
   * Should this manager message get a plan first? (Jev, phase 4.) Called before
   * every FRESH send — never for a steer, a prompt answer or the go-ahead nudge.
   * Absent (technicians) = the mode is never touched.
   */
  planChooser?(message: string, previous: { user: string; assistant: string } | null): Promise<{ plan: boolean; p: number | null }>;
  /**
   * A typed or spoken reply while a question or plan waits: does it answer it, or
   * is it a NEW request that should start its own turn (with its own plan check)?
   * (Jev; operator 2026-09-24.) Absent = every reply answers.
   */
  answersPrompt?(reply: string, question: string, choices: string[]): Promise<boolean>;
  /**
   * Step 3: the seat's inbox on Render. Absent = no office traffic (tests, and
   * the local driver, which must never drain a real person's inbox).
   */
  inbox?: {
    fetch(): Promise<InboxResult>;
    report(r: { id: string; leg: InboxItem['leg']; outcome: 'delivered' | 'failed'; detail?: string }): Promise<void>;
  };
  /** Who the seat was at start (whoami): an inbox pull that disagrees means the seat changed. */
  who?: { telegramUserId: number; tz: string; shareConversation?: boolean };
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
  /**
   * A batch job's progress on the Working line (step 2c), e.g. "batch 2 of 10".
   * Kept here so a question or plan prompt — which takes the line down and puts
   * it back — does not lose it; a fresh turn starts plain.
   */
  private progressText: string | null = null;
  /** What the live Working line SHOWS (set only once a send or an edit succeeded). */
  private shownText: string | null = null;
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
  /** A manager seat's hooks (step 2a phase 3); passed to every openSession. */
  protected hooks: SeatHooks | undefined = undefined;
  /** The one waiting question/plan at a time; the person's next tap, text or voice answers it. */
  private readonly prompts = new PendingPrompts();
  private promptCount = 0;
  /** The last manager message and the last reply, for Jev (a follow-up means nothing alone). */
  private lastUser = '';
  private lastReply = '';
  /** After a plan's Go: did anything follow? (the go-ahead nudge, phase 4). */
  private afterApproval: { tools: number; replied: boolean; nudged: boolean; errored: boolean } | null = null;
  /** A typed plan reply is with Jev: later texts are held here, never sent (review round 2). */
  private deciding: { buffer: string[]; cancelled: boolean } | null = null;

  constructor(private readonly deps: SeatDeps) {
    this.log = deps.log ?? ((m) => console.log(`seat-glue: ${m}`));
    // Private chats only (the allowlist), so the chat id IS the person's id.
    this.chatId = deps.allowedUserId;
    let resolve = () => {};
    const promise = new Promise<void>((r) => (resolve = r));
    this.readyGate = { promise, resolve };
    if (deps.manager) {
      this.hooks = { onUserInput: (r) => this.askUser(r), onExitPlan: (r) => this.showPlan(r) };
    }
  }

  /** A prompt is waiting on the person. */
  get promptOpen(): boolean {
    return this.prompts.isOpen;
  }

  /** How many prompts this seat has posted — the driver's waitPrompt step waits for it to grow. */
  get promptsPosted(): number {
    return this.promptCount;
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
    await this.attach(await this.deps.openSession(this.state.sessionId, this.hooks));
    await this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), this.deps.sweepEveryMs ?? 3_600_000);
    this.sweepTimer.unref?.();
    if (this.deps.inbox) {
      // The notice only where it is true: a manager's chat is never shared. The
      // inbox itself runs for everyone — the office still asks a manager directly.
      if (this.deps.who?.shareConversation) {
        this.disclosing = this.disclose();
        await this.disclosing;
      }
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
    // A WAITING PROMPT (step 2a): only the person's own text, voice or tap answers
    // it — never delivered as a new message (no abort, no steer). A photo, Stop or
    // /new ends it first, so the engine's handler is never left waiting.
    // Stop, /new or a photo end a decision in progress too (the plan comes back as
    // stopped), so nothing sent afterwards is swallowed into a dead loop's feedback.
    if (msg.kind === 'stop' || msg.kind === 'new' || msg.kind === 'photo' || msg.kind === 'document') this.endDeciding();
    if (this.prompts.isOpen) {
      if (msg.kind === 'photo') this.cancelPrompts('the manager sent a photo instead, which follows as their next message');
      if (msg.kind === 'document') this.cancelPrompts('the manager sent a file instead, which follows as their next message');
      if (msg.kind === 'stop') this.cancelPrompts('the manager pressed Stop');
      if (msg.kind === 'new') this.cancelPrompts('the manager started a new conversation');
    }
    switch (msg.kind) {
      case 'ignored':
        return;
      case 'unsupported':
        return this.say(TEXT.unsupported);
      case 'tooBig':
        return this.say(TEXT.tooBig);
      case 'stop':
        return this.stopReply(msg.callbackQueryId, msg.workingMessageId);
      case 'tap':
        return this.tapPrompt(msg.promptId, msg.index, msg.callbackQueryId);
      case 'new':
        return this.startFresh();
      case 'text':
        this.deps.transcript?.person(msg.text, this.sessionId);
        return this.routeReply(msg.text, false);
      case 'photo': {
        const buf = await this.deps.telegram.download(msg.fileId);
        await this.keepCopy(buf, 'jpg');
        // Bytes only. The saved BOX path never goes near the model; the file
        // store's id does (step 2d), so the model can attach it.
        const saved = await this.store({ kind: 'photo', name: 'photo.jpg', mime: 'image/jpeg', bytes: buf });
        const photo: BlobAttachment = { type: 'blob', data: buf.toString('base64'), mimeType: 'image/jpeg', displayName: 'photo.jpg' };
        this.deps.transcript?.person(msg.caption ?? '(photo)', this.sessionId);
        const note = saved ? `[photo saved as file ${saved}]` : '[photo could not be saved]';
        return this.deliver(`${msg.caption ?? '(photo)'}\n${note}`, [photo]);
      }
      case 'document': {
        let buf: Buffer;
        try {
          buf = await this.deps.telegram.download(msg.fileId);
        } catch (err) {
          // Telegram may not say a document's size up front; the download finds out.
          if (/over 20 MB/.test(errText(err))) return this.say(TEXT.tooBig);
          throw err;
        }
        const saved = await this.store({ kind: 'document', name: msg.fileName, mime: msg.mimeType, bytes: buf });
        const quoted = JSON.stringify(msg.fileName);
        const note = saved ? `[document ${quoted} saved as file ${saved}]` : `[document ${quoted} could not be saved]`;
        this.deps.transcript?.person(`${msg.caption ? `${msg.caption} ` : ''}(file ${msg.fileName})`, this.sessionId);
        // A jpeg/png sent "as a file" is still a picture the model can look at.
        const image = /^image\/(jpeg|png)$/i.test(msg.mimeType)
          ? [{ type: 'blob' as const, data: buf.toString('base64'), mimeType: msg.mimeType.toLowerCase(), displayName: msg.fileName }]
          : undefined;
        return this.deliver(`${msg.caption ? `${msg.caption}\n` : ''}${note}`, image);
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
        return this.routeReply(transcript.text, true);
      }
    }
  }

  /**
   * Where a typed or spoken message goes (step 2a). While Jev judges a typed plan
   * reply it is HELD (it turns the reply into a change request). While a question
   * or plan waits it ANSWERS it — unless Jev says it is a new request, which then
   * closes the prompt unanswered and starts its own turn with its own plan check.
   * Otherwise it is a normal message.
   */
  private async routeReply(text: string, voice: boolean): Promise<void> {
    const asMessage = voice ? `[voice note] ${text}` : text;
    if (this.deciding && !this.prompts.isOpen) {
      this.deciding.buffer.push(text);
      return;
    }
    const spec = this.prompts.current;
    if (spec) {
      // "What should change?" was asked BY the Change tap: the next text answers it.
      if (spec.kind !== 'plan-feedback' && this.deps.answersPrompt) {
        const answers = await this.deps.answersPrompt(text, spec.text, spec.choices);
        // The verdict is about THAT prompt. If it closed while Jev decided (the
        // turn ended, or a failed post handed over to a queued one), the reply is
        // a normal message — never an answer to a question it was not judged against.
        if (this.prompts.current?.id !== spec.id) return this.deliver(asMessage);
        if (!answers) {
          this.log('a reply while a prompt waits is a new request — closing the prompt, starting a new turn');
          this.cancelPrompts('the manager moved on to a new request, which follows as their next message');
          return this.deliver(asMessage);
        }
      }
      if (this.prompts.isOpen) return this.answerPrompt(text);
    }
    return this.deliver(asMessage);
  }

  /** Send a message into the conversation, per the turn policy. */
  private async deliver(prompt: string, attachments?: BlobAttachment[], opts: { nudge?: boolean } = {}): Promise<void> {
    // No conversation open (a /new whose open failed): reopen the recorded one,
    // or a fresh one, rather than going silent until a restart.
    if (!this.session) {
      try {
        await this.attach(await this.deps.openSession(this.state.sessionId, this.hooks));
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

    // PLAN OR NOT (step 2a phase 4): Jev decides for every fresh manager message
    // and the session's mode is set before the send (agentMode on send() is only
    // a label — measured). A steer joins a running reply, and the nudge must not
    // re-plan, so neither is classified. A failing Jev or mode switch never blocks.
    if (this.deps.planChooser && route !== 'steer' && !opts.nudge) {
      // Show typing at once: Jev can take up to 3 s before the turn starts.
      if (!policy.isBusy) this.startTyping();
      const previous = this.lastUser ? { user: this.lastUser, assistant: this.lastReply } : null;
      const { plan, p } = await this.deps.planChooser(prompt, previous);
      this.log(`plan ${plan ? 'yes' : 'no'} p=${p === null ? 'n/a' : p.toFixed(2)}`);
      try {
        await session.rpc?.mode.set({ mode: plan ? 'plan' : 'interactive' });
      } catch (err) {
        this.log(`could not set the mode (${errText(err)}) — sending anyway`);
      }
      this.lastUser = prompt;
      this.lastReply = '';
      this.afterApproval = null;
    }

    const freshTurn = !policy.isBusy;
    policy.onSend();
    if (freshTurn) {
      this.errorToldFor = null;
      this.progressText = null;
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
    // Our own tools first (step 2b): the SDK does not cancel a custom tool's call
    // on abort, so a running sandbox command would carry on (measured live).
    this.deps.onAbort?.();
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
      await this.attach(await this.deps.openSession(null, this.hooks));
    } catch (err) {
      this.log(`could not start a fresh conversation: ${errText(err)}`);
      return this.say(TEXT.replyFailed);
    }
    // The new conversation has no history: Jev must not judge against the old one.
    this.lastUser = '';
    this.lastReply = '';
    this.afterApproval = null;
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
      // Compared as numbers: whoami parsed the same text with Number(), so an id
      // too long for exact integers still compares equal to itself.
      if (
        Number(got.seat.telegramUserId) !== who.telegramUserId ||
        got.seat.timezone !== who.tz ||
        got.seat.shareConversation !== (who.shareConversation ?? false)
      ) {
        this.log('this seat changed on Render (Telegram account, timezone or tier) — restarting to pick it up');
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
        if (this.afterApproval && data.toolName !== 'exit_plan_mode') this.afterApproval.tools += 1;
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
        // A finished (or aborted) turn has no handler left waiting: close any
        // prompt — but NOT on a stale idle, which belongs to an old, dead loop
        // while the reply now running may be waiting on its person.
        if (result !== 'stale' && this.prompts.isOpen) this.cancelPrompts('the turn ended');
        if (result !== 'stale') this.endDeciding();
        // An approved plan followed by nothing at all (no tool, no reply): say go
        // once, as a plain send — no Jev, no mode switch, never twice per plan.
        let nudge = false;
        if (result === 'idle' && this.afterApproval) {
          const a = this.afterApproval;
          if (!a.nudged && !a.errored && a.tools === 0 && !a.replied) {
            a.nudged = true;
            nudge = true;
          } else this.afterApproval = null;
        }
        if (result === 'idle') this.stopWorking();
        // Idle clears pending tools even when no completion named them (an
        // id-less permission request), so a waiting Stop or /new moves on here too.
        this.releaseToolWaiters();
        // AFTER the idle bookkeeping: the nudge starts a new reply (typing, the
        // Working line with Stop) that stopWorking() above must not take down.
        if (nudge) {
          this.log('plan approved but nothing followed — nudging once');
          void this.deliver(TEXT.goAhead, undefined, { nudge: true });
        }
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
        // An approved plan that died on an error (a 429, the key's cap) is not
        // "nothing followed": the nudge would only fail again.
        if (this.afterApproval) this.afterApproval.errored = true;
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
              // A prompt left open by the dead loop would swallow the next text.
              this.cancelPrompts('the turn ended');
              policy.finish();
              this.stopWorking();
              // The reply is over without an idle: close its tool turns too, or
              // the conversation upload waits on them for good.
              this.deps.transcript?.settleOpenTools();
            }
          }, this.deps.errorIdleWaitMs ?? 5_000);
          timer.unref?.();
        }
        return;
      }
    }
  }

  // ── waiting prompts (step 2a phase 3) ──────────────────────────────────────

  /** The engine's ask_user: the question with its choices as buttons; the turn waits here. */
  private async askUser(req: UserInputRequestLike): Promise<UserInputResponseLike> {
    // Empty choices make Telegram refuse the whole message; past 10 the keyboard
    // gets unwieldy, so the rest are listed in the text for typing.
    const all = (req.choices ?? []).map((c) => c.trim()).filter(Boolean);
    const choices = all.slice(0, 10);
    const extra = all.slice(10);
    let text = req.question;
    if (extra.length) text += `\n\nAlso possible (type it): ${extra.join('; ')}`;
    else if (choices.length && req.allowFreeform !== false) text += '\n\n(Or type your answer.)';
    if (all.length > 10) this.log(`ask_user offered ${all.length} choices; ${extra.length} listed as text`);
    const r = await this.prompts.ask(
      // Every choice, buttons and listed alike, so a typed one matches (buttons-only questions).
      { kind: 'question', choices: all, text, allowFreeform: req.allowFreeform !== false },
      (id) => this.postPrompt(text, choices.map((c, i) => [{ text: c.slice(0, 60), data: `p:${id}:${i}` }])),
      (mid) => this.clearPromptButtons(mid),
    );
    this.resumeWorking();
    if (r.cancelled) return { answer: `(no answer: ${r.reason ?? 'cancelled'})`, wasFreeform: true };
    return { answer: r.answer, wasFreeform: r.freeform };
  }

  /** The engine's exit_plan_mode: the plan with [Go][Change]; Change asks what should change. */
  private async showPlan(req: ExitPlanRequestLike): Promise<ExitPlanResultLike> {
    const stopped: ExitPlanResultLike = { approved: false, feedback: 'The manager stopped this plan. Do not carry it out.' };
    // Not approved, and why — the model reads it (a photo or a new request may follow).
    const notApproved = (reason?: string): ExitPlanResultLike =>
      reason ? { approved: false, feedback: `The manager did not approve this plan (${reason}). Do not carry it out.` } : stopped;
    // exit_only = the model is only LEAVING plan mode, with nothing to carry out
    // (a cancelled plan, a question answered). There is nothing to approve, so no
    // Go / Change: say its summary as a message and let it leave. Live finding
    // 2026-09-27: "cancel the plan" came back as a "Plan Cancelled" plan with Go.
    // No afterApproval either: a go-ahead nudge would tell it to act.
    if (req.recommendedAction === 'exit_only') {
      const summary = [req.summary.trim(), (req.planContent ?? '').trim()].filter(Boolean).join('\n\n');
      if (summary) void this.say(summary.length <= PLAN_TEXT_MAX ? summary : `${summary.slice(0, PLAN_TEXT_MAX - 1).trimEnd()}…`);
      return { approved: true, selectedAction: 'exit_only' };
    }
    const body = planText(req);
    const r = await this.prompts.ask(
      { kind: 'plan', choices: ['Go', 'Change'], text: body, allowFreeform: true },
      (id) => this.postPrompt(body, [[{ text: 'Go', data: `p:${id}:0` }, { text: 'Change', data: `p:${id}:1` }]]),
      (mid) => this.clearPromptButtons(mid),
    );
    const go: ExitPlanResultLike = { approved: true, selectedAction: req.recommendedAction };
    if (r.cancelled) return this.resumed(notApproved(r.reason));
    if (!r.freeform && r.index === 0) return this.approved(go);
    if (r.freeform) {
      // A typed reply instead of a tap: "yes go" approves; anything else is a
      // change request. Texts arriving while Jev decides are HELD and make it one.
      const deciding = { buffer: [] as string[], cancelled: false };
      this.deciding = deciding;
      // Never throws: a failing or slow Jev answers "not approved".
      const yes = this.deps.approvesPlan
        ? await Promise.race([
            this.deps.approvesPlan(r.answer, req.summary).catch(() => false),
            new Promise<boolean>((res) => setTimeout(() => res(false), APPROVE_WAIT_MS).unref?.()),
          ])
        : false;
      if (this.deciding === deciding) this.deciding = null;
      if (deciding.cancelled) return this.resumed(stopped);
      if (deciding.buffer.length) return this.resumed({ approved: false, feedback: [r.answer, ...deciding.buffer].join('\n') });
      return yes ? this.approved(go) : this.resumed({ approved: false, feedback: r.answer });
    }
    const f = await this.prompts.ask(
      { kind: 'plan-feedback', choices: [], text: TEXT.whatShouldChange, allowFreeform: true },
      () => this.postPrompt(TEXT.whatShouldChange, []),
    );
    return this.resumed(f.cancelled ? notApproved(f.reason) : { approved: false, feedback: f.answer });
  }

  /** End a typed-reply decision in progress: the plan answers "stopped". */
  private endDeciding(): void {
    if (!this.deciding) return;
    this.deciding.cancelled = true;
    this.deciding = null;
  }

  /** Go: the plan runs — and the glue watches that something actually follows. */
  private approved(value: ExitPlanResultLike): ExitPlanResultLike {
    this.afterApproval = { tools: 0, replied: false, nudged: false, errored: false };
    return this.resumed(value);
  }

  private resumed<T>(value: T): T {
    this.resumeWorking();
    return value;
  }

  /** Post a prompt through the ordered outbox; the Working line and typing pause while it waits. */
  private postPrompt(text: string, rows: ButtonRow[]): Promise<number | null> {
    this.promptCount += 1;
    this.stopWorking();
    const posted = this.outbox.then(() =>
      rows.length
        ? this.deps.telegram.sendButtons(this.chatId, text, rows)
        : this.deps.telegram.send(this.chatId, text).then(() => null),
    );
    this.outbox = posted.then(
      () => undefined,
      (err: unknown) => this.log(`could not post a prompt: ${errText(err)}`),
    );
    return posted;
  }

  /** The prompt was answered: the reply carries on, so typing and the Stop line come back. */
  private resumeWorking(): void {
    if (this.deps.policy.isBusy && !this.prompts.isOpen) this.startWorking();
  }

  private answerPrompt(text: string): void {
    const r = this.prompts.resolveText(text);
    // A buttons-only question: text that names no button leaves it open.
    if (r?.rejected) {
      void this.say(TEXT.tapAnOption);
      return;
    }
    if (r?.messageId != null) this.clearPromptButtons(r.messageId);
  }

  private tapPrompt(promptId: string, index: number, callbackQueryId: string): void {
    const r = this.prompts.resolveTap(promptId, index);
    void this.deps.telegram.answerCallback(callbackQueryId, r ? undefined : TEXT.promptClosed).catch(() => {});
    if (r?.messageId != null) this.clearPromptButtons(r.messageId);
  }

  private cancelPrompts(reason: string): void {
    const messageId = this.prompts.cancelAll(reason);
    if (messageId != null) this.clearPromptButtons(messageId);
  }

  private clearPromptButtons(messageId: number): void {
    void this.deps.telegram.clearButtons(this.chatId, messageId).catch((err: unknown) => this.log(`could not clear buttons: ${errText(err)}`));
  }

  /**
   * Step 2d: the file store's id, or null — a failed save is logged and said,
   * never blocks the turn. ONE retry: an upload only happens on arrival, so a
   * miss is permanent, and the likeliest miss is Render waking from its sleep.
   */
  private async store(f: { kind: 'photo' | 'document'; name: string; mime: string; bytes: Buffer }): Promise<string | null> {
    if (!this.deps.uploadFile) return null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.deps.uploadFile(f);
      } catch (err) {
        this.log(`keeping the ${f.kind} failed (attempt ${attempt}): ${errText(err)}`);
      }
    }
    return null;
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
    if (texts.length) {
      this.clearWorkingLine();
      this.lastReply = texts.join('\n');
      if (this.afterApproval) this.afterApproval.replied = true;
    }
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
      const posting = this.progressText;
      this.workingLine = this.deps.telegram.sendWorking(this.chatId, posting ?? undefined).then((id) => {
        this.shownText = posting;
        return id;
      }).catch((err: unknown) => {
        this.log(`could not post the Working line: ${errText(err)}`);
        return null;
      });
    }
  }

  /**
   * Step 2c: a batch job's progress on the Working line. Only a CHANGED text is
   * sent (Telegram refuses an edit that changes nothing), and only while a reply
   * shows the line; a failed edit is logged — the job itself carries on.
   */
  showProgress(text: string | null): void {
    this.progressText = text;
    const line = this.workingLine;
    if (!line) return;
    this.outbox = this.outbox
      .then(() => line)
      .then(async (id) => {
        // Decided when it is sent, against what the line SHOWS: a failed edit
        // leaves the old text, so the next one is sent even if it repeats (review).
        if (id === null || text === this.shownText) return;
        await this.deps.telegram.editWorking(this.chatId, id, text);
        this.shownText = text;
      })
      .catch((err: unknown) => this.log(`could not update the Working line: ${errText(err)}`));
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

/** The plan as the manager reads it, inside PLAN_TEXT_MAX. */
export function planText(req: ExitPlanRequestLike): string {
  const parts = ["Here's the plan:", req.summary.trim(), (req.planContent ?? '').trim()].filter(Boolean);
  const text = parts.join('\n\n');
  return text.length <= PLAN_TEXT_MAX ? text : `${text.slice(0, PLAN_TEXT_MAX - 1).trimEnd()}…`;
}
