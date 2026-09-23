import { randomUUID } from 'node:crypto';

// Cowork-style double texting (operator, 2026-09-22): no debounce, every text
// goes to the engine at once, and a text that lands mid-reply joins the reply
// in progress instead of drawing a second one.
//
//   idle                          -> send it
//   busy, a spine tool is pending -> steer: send({mode:"immediate"}), folded in
//                                    when the tool finishes
//   busy, no tool pending         -> abort the model call, wait for its idle,
//                                    then send ONLY the new text (the first is
//                                    already in history)
//
// Three timing rules this class exists to hold (plan review, 2026-09-22):
// 1. BUSY STARTS AT OUR send(), not at assistant.turn_start. turn_start fires
//    once per loop iteration, so keying busy to it leaves a window between
//    send() and the first model call where a second text goes out as a plain
//    send and draws a second reply.
// 2. A TOOL IS PENDING FROM OUR PERMISSION HANDLER, not from
//    tool.execution_start. The handler runs before every MCP call; aborting
//    after the model decided on record_field_note but before the call went out
//    could land the note while the model believes it was interrupted — a
//    permanent duplicate in L1. So we never abort while anything is pending.
// 3. AN ABORT'S IDLE BELONGS TO THE ABORT. After abort() the dying loop emits
//    session.idle a few ms later; if that idle freed the policy after the new
//    text was sent, the next double text would go out as a plain send. The
//    glue awaits the abort's idle (beginAbort) before sending.
export type Route = 'send' | 'steer' | 'abort-then-send';

// Tools a Stop or /new may interrupt mid-call. ask_team_lead is the office,
// which can take minutes and stops itself when the caller hangs up (desk→office
// merge, thoughts/shared/plans/2026-09-22-the-office-one-agent-three-doors.md).
// Everything else — above all record_field_note — is never aborted mid-call.
// Double texts still STEER during any tool: they never abort one.
export const ABORT_SAFE_TOOLS = new Set(['ask_team_lead']);
const bareName = (tool?: string): string => (tool ?? '').replace(/^spine-/, '');

export class TurnPolicy {
  private busy = false;
  /** Pending spine tools by call id, with the tool's name. */
  private readonly pendingIds = new Map<string, string>();
  /** Id-less pending tools, by name. */
  private anonymousPending: string[] = [];
  private replyId: string | null = null;
  private nextId: string | null = null;
  private abortWaiters: Array<() => void> = [];
  private staleAbortIdles = 0;

  constructor(private readonly newId: () => string = randomUUID) {}

  get isBusy(): boolean {
    return this.busy;
  }

  get toolPending(): boolean {
    return this.pendingIds.size + this.anonymousPending.length > 0;
  }

  /** A tool is pending and every pending tool is one a Stop may interrupt. */
  get onlyAbortSafePending(): boolean {
    const names = [...this.pendingIds.values(), ...this.anonymousPending];
    return names.length > 0 && names.every((n) => ABORT_SAFE_TOOLS.has(bareName(n)));
  }

  route(): Route {
    if (!this.busy) return 'send';
    return this.toolPending ? 'steer' : 'abort-then-send';
  }

  /** The reply id the next or current send belongs to (so a voice note's transcription counts toward its reply). */
  currentReplyId(): string {
    if (this.busy && this.replyId) return this.replyId;
    this.nextId ??= this.newId();
    return this.nextId;
  }

  /** Call synchronously right before session.send(). Returns the reply id. */
  onSend(): string {
    if (!this.busy) {
      this.replyId = this.nextId ?? this.newId();
      this.nextId = null;
      this.busy = true;
    }
    return this.replyId as string;
  }

  /** From the permission handler, before the MCP call goes out. */
  onToolPending(toolCallId?: string, toolName?: string): void {
    if (toolCallId) this.pendingIds.set(toolCallId, toolName ?? '');
    else this.anonymousPending.push(toolName ?? '');
  }

  /** From tool.execution_complete. */
  onToolComplete(toolCallId?: string): void {
    if (toolCallId) {
      this.pendingIds.delete(toolCallId);
      return;
    }
    // Only an id-less completion may settle an id-less pending tool: an unknown
    // id must never make a running tool look finished (unsure → steer, the safe side).
    this.anonymousPending.shift();
  }

  /**
   * Before calling session.abort(). `done` resolves on the next session.idle,
   * which is treated as the abort's own idle: it clears pending tools (the loop
   * is dead) but leaves the policy BUSY, because the caller is about to send the
   * new text. A Stop calls finish() after it resolves.
   *
   * Only the `first` caller calls session.abort(); a second abort already in
   * flight shares the first one's idle (two aborts would owe two idles, and the
   * second would free the reply the first one's caller just started). A caller
   * that was not first must call route() again after `done` rather than sending
   * plainly. With nothing running there is nothing to abort: done at once.
   */
  beginAbort(): { done: Promise<void>; first: boolean } {
    if (!this.busy) return { done: Promise.resolve(), first: false };
    const first = this.abortWaiters.length === 0;
    return { done: new Promise((resolve) => this.abortWaiters.push(resolve)), first };
  }

  /**
   * The abort's idle never came (the glue's wait timed out) or the abort call
   * itself failed. Drop the waiters — left behind, they would swallow the NEXT
   * reply's real end-of-reply idle and keep the seat busy forever. When the
   * abort was actually sent, its idle may still arrive: count it as owed.
   */
  cancelAbort(abortWasSent: boolean): void {
    if (!this.abortWaiters.length) return;
    const waiters = this.abortWaiters;
    this.abortWaiters = [];
    for (const w of waiters) w();
    if (abortWasSent) this.staleAbortIdles += 1;
  }

  /**
   * From session.idle, with its `data.aborted`. Returns:
   * - 'abort': the idle released an abort we are waiting on (policy stays busy);
   * - 'stale': a late aborted idle from an abort that the loop's own finish beat
   *   — ignored, so it cannot free the reply that is now running;
   * - 'idle':  the reply is over.
   */
  onIdle(aborted?: boolean): 'abort' | 'stale' | 'idle' {
    // A stale idle belongs to the OLD, dead loop: it must not touch the tools the
    // reply now running has pending — clearing them would let an abort land while
    // a record_field_note is in flight. So it is checked before anything clears.
    if (aborted === true && this.staleAbortIdles > 0 && !this.abortWaiters.length) {
      this.staleAbortIdles -= 1;
      return 'stale';
    }
    this.pendingIds.clear();
    this.anonymousPending = [];
    if (this.abortWaiters.length) {
      // A NORMAL idle while we wait means the loop finished by itself just as we
      // aborted. Release the waiter anyway (waiting for an aborted idle that may
      // never come would hang the seat), and remember that the abort's own idle
      // may still arrive.
      if (aborted !== true) this.staleAbortIdles += 1;
      const waiters = this.abortWaiters;
      this.abortWaiters = [];
      for (const w of waiters) w();
      return 'abort';
    }
    // The reply is truly over: any abort idle still owed is forgotten here, not
    // in finish(), because a Stop calls finish() while its late idle may still
    // be on the way — resetting there would let it free the next reply.
    this.staleAbortIdles = 0;
    this.finish();
    return 'idle';
  }

  /** Back to idle (the reply is over, or a Stop ended it). */
  finish(): void {
    this.busy = false;
    this.replyId = null;
  }
}
