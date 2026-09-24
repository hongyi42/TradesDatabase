import { randomBytes } from 'node:crypto';

// A manager seat's waiting prompts (step 2a phase 3): a question from ask_user,
// a plan from exit_plan_mode, or the "what should change?" that follows Change.
// While one is open, the engine's turn is paused inside that handler, waiting on
// the person — and the seat must route the person's next tap, text or voice note
// HERE, never into the conversation as a new message.
//
// ONE open prompt at a time; a second ask queues behind it (the model can ask two
// questions in one step). The hand-over is SYNCHRONOUS: finish() makes the next
// queued prompt the open one in the same step, so no new ask can slip in between
// and be overwritten (final review finding). cancelAll ends the open one AND
// everything queued, so Stop, /new, a photo that aborts the turn, or the turn
// ending by itself can never leave a handler waiting on a prompt nobody answers.

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

export interface PromptSpec {
  kind: PromptKind;
  choices: string[];
  /** What the person was asked (Jev reads it to tell an answer from a new request). */
  text: string;
  /** false = buttons only: typed text counts only when it matches a button. */
  allowFreeform: boolean;
}

interface Open extends PromptSpec {
  id: string;
  messageId: number | null;
  resolve: (a: PromptAnswer) => void;
}

interface Queued extends PromptSpec {
  post: (id: string) => Promise<number | null>;
  onOrphan?: (messageId: number) => void;
  resolve: (a: PromptAnswer) => void;
}

// A voice transcript comes back as "Job 14." — case, edge spaces and trailing
// punctuation never decide whether a typed or spoken reply names a button.
const norm = (s: string) => s.trim().toLowerCase().replace(/[\s.,!?;:'"]+$/u, '').replace(/^[\s'"]+/u, '');
const sameChoice = (choice: string, text: string) => norm(choice) === norm(text);

/** The callback_data a button carries: `p:<8 hex>:<index>` (Telegram allows 64 bytes). */
export const PROMPT_DATA = /^p:([0-9a-f]{8}):(\d{1,2})$/;

export class PendingPrompts {
  private open: Open | null = null;
  private readonly queue: Queued[] = [];

  constructor(private readonly newId: () => string = () => randomBytes(4).toString('hex')) {}

  get isOpen(): boolean {
    return this.open !== null;
  }

  /** The open prompt's id, question and choices (for Jev), or null. */
  get current(): (PromptSpec & { id: string }) | null {
    const o = this.open;
    return o ? { id: o.id, kind: o.kind, choices: o.choices, text: o.text, allowFreeform: o.allowFreeform } : null;
  }

  /**
   * Post this prompt (`post` returns the Telegram message id carrying the
   * buttons, or null) once nothing else is open, then wait for the answer.
   */
  ask(
    spec: PromptSpec,
    post: (id: string) => Promise<number | null>,
    /** Called with the posted message id when the prompt was already answered or cancelled before it went out. */
    onOrphan?: (messageId: number) => void,
  ): Promise<PromptAnswer> {
    return new Promise<PromptAnswer>((resolve) => {
      const q: Queued = { ...spec, post, onOrphan, resolve };
      if (this.open || this.queue.length) this.queue.push(q);
      else this.activate(q);
    });
  }

  /** A button tap. Returns the message id whose buttons should be cleared, or null if it matched nothing open. */
  resolveTap(promptId: string, index: number): { messageId: number | null } | null {
    const o = this.open;
    if (!o || o.id !== promptId || index < 0 || index >= o.choices.length) return null;
    const messageId = o.messageId;
    this.finish(o.id, { answer: o.choices[index], freeform: false, index });
    return { messageId };
  }

  /**
   * Typed or spoken text answers the open prompt. A buttons-only prompt accepts
   * text only when it names a button (case-insensitive); otherwise it stays open
   * and `rejected` says so. undefined = nothing was open.
   */
  resolveText(text: string): { messageId: number | null; rejected?: boolean } | undefined {
    const o = this.open;
    if (!o) return undefined;
    const messageId = o.messageId;
    if (!o.allowFreeform) {
      const index = o.choices.findIndex((c) => sameChoice(c, text));
      if (index < 0) return { messageId, rejected: true };
      this.finish(o.id, { answer: o.choices[index], freeform: false, index });
      return { messageId };
    }
    this.finish(o.id, { answer: text, freeform: true });
    return { messageId };
  }

  /** End the open prompt and everything queued. Returns the open prompt's message id (to clear its buttons). */
  cancelAll(reason: string): number | null {
    const cancelled: PromptAnswer = { answer: '', freeform: true, cancelled: true, reason };
    for (const q of this.queue.splice(0)) q.resolve(cancelled);
    const o = this.open;
    if (!o) return null;
    this.finish(o.id, cancelled);
    return o.messageId;
  }

  private activate(q: Queued): void {
    const id = this.newId();
    this.open = { kind: q.kind, choices: q.choices, text: q.text, allowFreeform: q.allowFreeform, id, messageId: null, resolve: q.resolve };
    q.post(id).then(
      (messageId) => {
        if (this.open?.id === id) this.open.messageId = messageId;
        // Answered (or cancelled) while the post was still queued: its buttons
        // arrived after their own answer — take them straight back down.
        else if (messageId != null) q.onOrphan?.(messageId);
      },
      (err: unknown) => {
        // Could not even show it: end it now rather than wait forever.
        this.finish(id, { answer: '', freeform: true, cancelled: true, reason: `could not post: ${err instanceof Error ? err.message : String(err)}` });
      },
    );
  }

  private finish(id: string, a: PromptAnswer): void {
    const o = this.open;
    if (!o || o.id !== id) return;
    this.open = null;
    o.resolve(a);
    const next = this.queue.shift();
    if (next) this.activate(next);
  }
}
