import { describe, expect, it } from 'vitest';
import { TurnPolicy } from './turnPolicy.js';

const ids = () => {
  let n = 0;
  return () => `r${++n}`;
};

describe('TurnPolicy', () => {
  it('sends when idle', () => {
    expect(new TurnPolicy(ids()).route()).toBe('send');
  });

  it('is busy from the moment we send — a text before the first model call is not a plain send', () => {
    const p = new TurnPolicy(ids());
    p.onSend();
    expect(p.route()).toBe('abort-then-send');
  });

  it('never aborts while a tool is pending, from permission to completion', () => {
    const p = new TurnPolicy(ids());
    p.onSend();
    p.onToolPending('call-1');
    expect(p.route()).toBe('steer');
    p.onToolComplete('call-1');
    expect(p.route()).toBe('abort-then-send');
  });

  it('tracks nested and id-less tools', () => {
    const p = new TurnPolicy(ids());
    p.onSend();
    p.onToolPending('a');
    p.onToolPending();
    p.onToolComplete('a');
    expect(p.route()).toBe('steer');
    p.onToolComplete();
    expect(p.route()).toBe('abort-then-send');
  });

  it("lets an abort's idle resolve the abort without freeing the next turn", async () => {
    const p = new TurnPolicy(ids());
    const reply = p.onSend();
    const { done: waited } = p.beginAbort();
    expect(p.onIdle(true)).toBe('abort');
    await waited;
    // The glue now sends the new text; the policy must still be busy on the same reply.
    expect(p.isBusy).toBe(true);
    expect(p.onSend()).toBe(reply);
    expect(p.route()).toBe('abort-then-send');
    // The new turn's own idle ends the reply.
    expect(p.onIdle()).toBe('idle');
    expect(p.route()).toBe('send');
  });

  it('ignores a late aborted idle when the loop finished by itself as we aborted', async () => {
    const p = new TurnPolicy(ids());
    p.onSend();
    const { done: waited } = p.beginAbort();
    // The model finished normally just as the glue aborted: the NORMAL idle
    // releases the waiter so the seat does not hang…
    expect(p.onIdle(false)).toBe('abort');
    await waited;
    p.onSend(); // the new text goes out
    // …and the abort's own idle, arriving late, must not free the new turn.
    expect(p.onIdle(true)).toBe('stale');
    expect(p.isBusy).toBe(true);
    expect(p.route()).toBe('abort-then-send');
    expect(p.onIdle(false)).toBe('idle');
    expect(p.route()).toBe('send');
  });

  it("leaves the new reply's pending tool alone when a stale idle arrives", async () => {
    const p = new TurnPolicy(ids());
    p.onSend();
    const { done: waited } = p.beginAbort();
    p.onIdle(false); // loop finished by itself as we aborted
    await waited;
    p.onSend();
    p.onToolPending('record-note'); // the new reply is filing a note
    expect(p.onIdle(true)).toBe('stale'); // the old loop's late idle
    expect(p.route()).toBe('steer'); // still never abort mid-tool
  });

  it('does not let a late idle after a Stop free the next reply', async () => {
    const p = new TurnPolicy(ids());
    p.onSend();
    const { done: waited } = p.beginAbort();
    p.onIdle(false); // the loop beat the Stop
    await waited;
    p.finish(); // Stop ends the reply
    p.onSend(); // Ben texts again before the late idle lands
    expect(p.onIdle(true)).toBe('stale');
    expect(p.route()).toBe('abort-then-send');
  });

  it('lets a second abort in flight share the first one instead of issuing its own', async () => {
    const p = new TurnPolicy(ids());
    p.onSend();
    const a = p.beginAbort();
    const b = p.beginAbort();
    expect(a.first).toBe(true);
    expect(b.first).toBe(false);
    expect(p.onIdle(true)).toBe('abort');
    await Promise.all([a.done, b.done]);
    p.onSend(); // the first caller sends
    expect(p.route()).toBe('abort-then-send'); // the second re-routes instead of sending plainly
  });

  it('has nothing to abort when idle', async () => {
    const p = new TurnPolicy(ids());
    const a = p.beginAbort();
    expect(a.first).toBe(false);
    await a.done;
    expect(p.route()).toBe('send');
  });

  it('never lets an unknown tool id settle an id-less pending tool', () => {
    const p = new TurnPolicy(ids());
    p.onSend();
    p.onToolPending();
    p.onToolComplete('someone-else');
    expect(p.route()).toBe('steer');
  });

  it('cancelAbort drops a waiter whose idle never came, so the next reply can end', async () => {
    const p = new TurnPolicy(ids());
    p.onSend();
    const a = p.beginAbort();
    p.cancelAbort(true); // timed out: the abort was sent, its idle is owed
    await a.done;
    p.onSend();
    expect(p.onIdle(true)).toBe('stale'); // the owed idle, late
    expect(p.onIdle(false)).toBe('idle'); // the reply's real end
    expect(p.isBusy).toBe(false);
  });

  it('knows when every pending tool is one a Stop may interrupt', () => {
    const p = new TurnPolicy(ids());
    p.onSend();
    p.onToolPending('a', 'spine-ask_team_lead');
    expect(p.onlyAbortSafePending).toBe(true);
    p.onToolPending('b', 'spine-record_field_note');
    expect(p.onlyAbortSafePending).toBe(false);
    p.onToolComplete('b');
    expect(p.onlyAbortSafePending).toBe(true);
    expect(p.route()).toBe('steer'); // a double text still never aborts it
  });

  it('treats an aborted idle with nothing waiting as the end of the reply', () => {
    const p = new TurnPolicy(ids());
    p.onSend();
    expect(p.onIdle(true)).toBe('idle');
    expect(p.route()).toBe('send');
  });

  it('keeps one reply id across a steer and an abort, and mints a new one after idle', () => {
    const p = new TurnPolicy(ids());
    const first = p.onSend();
    p.onToolPending('t');
    expect(p.onSend()).toBe(first); // steer
    p.onToolComplete('t');
    void p.beginAbort().done;
    p.onIdle();
    expect(p.onSend()).toBe(first); // abort-then-send
    p.onIdle();
    expect(p.onSend()).not.toBe(first);
  });

  it('pre-mints the next reply id so a transcription counts toward the reply it feeds', () => {
    const p = new TurnPolicy(ids());
    const early = p.currentReplyId();
    expect(p.onSend()).toBe(early);
    expect(p.currentReplyId()).toBe(early);
  });

  it('clears pending tools when any idle arrives', () => {
    const p = new TurnPolicy(ids());
    p.onSend();
    p.onToolPending('t');
    p.onIdle();
    p.onSend();
    expect(p.route()).toBe('abort-then-send');
  });
});
