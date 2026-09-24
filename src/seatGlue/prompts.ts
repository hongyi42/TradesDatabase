import { randomBytes } from 'node:crypto';

// A manager seat's waiting prompts (step 2a phase 3): a question from ask_user,
// a plan from exit_plan_mode, or the "what should change?" that follows Change.
// While one is open, the engine's turn is paused inside that handler, waiting on
// the person — and the seat must route the person's next tap, text or voice note
// HERE, never into the conversation as a new message.
//
// ONE open prompt at a time; a second ask queues behind it (the model can ask two
// questions in one step). cancelAll ends the open one AND everything queued, so
// Stop, /new, a photo that aborts the turn, or the turn ending by itself can
// never leave a handler waiting on a prompt nobody will answer.

export type PromptKind = 'question' | 'plan' | 'plan-feedback';

export interface PromptAnswer {
  answer: string;
  /** Typed (or spoken) rather than a button. */
  freeform: boolean;
  /** Which button, when one was tapped. */
  index?: number;
  /** Ended by cancelAll, not by the person. */
  cancelled?: boolean;
  reason?: string;
}

interface Open {
  id: string;
  kind: PromptKind;
  choices: string[];
  messageId: number | null;
  resolve: (a: PromptAnswer) => void;
}

/** The callback_data a button carries: `p:<8 hex>:<index>` (Telegram allows 64 bytes). */
export const PROMPT_DATA = /^p:([0-9a-f]{8}):(\d{1,2})$/;

export class PendingPrompts {
  private open: Open | null = null;
  private readonly queue: Array<{ start: () => void; cancel: (reason: string) => void }> = [];

  constructor(private readonly newId: () => string = () => randomBytes(4).toString('hex')) {}

  get isOpen(): boolean {
    return this.open !== null;
  }

  get openKind(): PromptKind | null {
    return this.open?.kind ?? null;
  }

  /**
   * Wait for any open prompt to finish, post this one (`post` returns the
   * Telegram message id carrying the buttons, or null), then wait for the answer.
   */
  async ask(
    kind: PromptKind,
    choices: string[],
    post: (id: string) => Promise<number | null>,
    /** Called with the posted message id when the prompt was already answered or cancelled before it went out. */
    onOrphan?: (messageId: number) => void,
  ): Promise<PromptAnswer> {
    if (this.open) {
      const cancelledWhileQueued = await new Promise<string | null>((resolve) => {
        this.queue.push({ start: () => resolve(null), cancel: (reason) => resolve(reason) });
      });
      if (cancelledWhileQueued !== null) return { answer: '', freeform: true, cancelled: true, reason: cancelledWhileQueued };
    }
    const id = this.newId();
    let resolve: (a: PromptAnswer) => void = () => {};
    const answered = new Promise<PromptAnswer>((r) => (resolve = r));
    this.open = { id, kind, choices, messageId: null, resolve };
    try {
      const messageId = await post(id);
      if (this.open?.id === id) this.open.messageId = messageId;
      // Answered (or cancelled) while the post was still queued: its buttons
      // arrived after their own answer — take them straight back down.
      else if (messageId != null) onOrphan?.(messageId);
    } catch (err) {
      // Could not even show it: end it now rather than wait forever.
      this.finish(id, { answer: '', freeform: true, cancelled: true, reason: `could not post: ${err instanceof Error ? err.message : String(err)}` });
    }
    return answered;
  }

  /** A button tap. Returns the message id whose buttons should be cleared, or null if it matched nothing open. */
  resolveTap(promptId: string, index: number): { messageId: number | null } | null {
    const o = this.open;
    if (!o || o.id !== promptId || index < 0 || index >= o.choices.length) return null;
    const messageId = o.messageId;
    this.finish(o.id, { answer: o.choices[index], freeform: false, index });
    return { messageId };
  }

  /** Typed or spoken text answers the open prompt. Returns the message id to clear, or undefined if nothing was open. */
  resolveText(text: string): { messageId: number | null } | undefined {
    const o = this.open;
    if (!o) return undefined;
    const messageId = o.messageId;
    this.finish(o.id, { answer: text, freeform: true });
    return { messageId };
  }

  /** End the open prompt and everything queued. Returns the open prompt's message id (to clear its buttons). */
  cancelAll(reason: string): number | null {
    const queued = this.queue.splice(0);
    for (const q of queued) q.cancel(reason);
    const o = this.open;
    if (!o) return null;
    this.finish(o.id, { answer: '', freeform: true, cancelled: true, reason });
    return o.messageId;
  }

  private finish(id: string, a: PromptAnswer): void {
    const o = this.open;
    if (!o || o.id !== id) return;
    this.open = null;
    o.resolve(a);
    this.queue.shift()?.start();
  }
}
