import { describe, expect, it } from 'vitest';
import { PendingPrompts, PROMPT_DATA } from './prompts.js';

const ids = () => {
  let n = 0;
  return () => (++n).toString(16).padStart(8, '0');
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PendingPrompts', () => {
  it('a tap answers the open prompt with the choice, and hands back the message to clear', async () => {
    const p = new PendingPrompts(ids());
    const answer = p.ask('question', ['Kitchen', 'Bathroom'], async () => 42);
    await flush();
    expect(p.isOpen).toBe(true);
    expect(p.resolveTap('00000001', 1)).toEqual({ messageId: 42 });
    expect(await answer).toEqual({ answer: 'Bathroom', freeform: false, index: 1 });
    expect(p.isOpen).toBe(false);
  });

  it('a stale or out-of-range tap matches nothing', async () => {
    const p = new PendingPrompts(ids());
    void p.ask('question', ['A'], async () => 1);
    await flush();
    expect(p.resolveTap('deadbeef', 0)).toBeNull();
    expect(p.resolveTap('00000001', 5)).toBeNull();
    expect(p.isOpen).toBe(true);
  });

  it('typed text answers it as free-form', async () => {
    const p = new PendingPrompts(ids());
    const answer = p.ask('plan-feedback', [], async () => null);
    await flush();
    expect(p.resolveText('do J-14 first')).toEqual({ messageId: null });
    expect(await answer).toEqual({ answer: 'do J-14 first', freeform: true });
    expect(p.resolveText('nothing open')).toBeUndefined();
  });

  it('one at a time: a second ask waits, and opens when the first is answered', async () => {
    const p = new PendingPrompts(ids());
    const first = p.ask('question', ['x'], async () => 1);
    const second = p.ask('question', ['y'], async () => 2);
    await flush();
    expect(p.resolveTap('00000001', 0)).toEqual({ messageId: 1 });
    await first;
    await flush();
    expect(p.isOpen).toBe(true);
    expect(p.resolveTap('00000002', 0)).toEqual({ messageId: 2 });
    expect(await second).toMatchObject({ answer: 'y' });
  });

  it('cancelAll ends the open prompt AND the queued one, so no handler waits forever', async () => {
    const p = new PendingPrompts(ids());
    const first = p.ask('question', ['x'], async () => 7);
    const second = p.ask('question', ['y'], async () => 8);
    await flush();
    expect(p.cancelAll('stop')).toBe(7);
    expect(await first).toMatchObject({ cancelled: true, reason: 'stop' });
    expect(await second).toMatchObject({ cancelled: true, reason: 'stop' });
    expect(p.isOpen).toBe(false);
  });

  it('a prompt that cannot be posted ends at once instead of waiting', async () => {
    const p = new PendingPrompts(ids());
    const a = await p.ask('question', ['x'], async () => {
      throw new Error('telegram down');
    });
    expect(a).toMatchObject({ cancelled: true });
    expect(p.isOpen).toBe(false);
  });

  it('callback data fits the p:<8 hex>:<n> shape Telegram carries', () => {
    expect(PROMPT_DATA.test('p:0000000a:1')).toBe(true);
    expect(PROMPT_DATA.test('stop')).toBe(false);
    expect(PROMPT_DATA.test('p:zz:1')).toBe(false);
  });

  it('a prompt answered before its post finished hands the late message id back to be cleared', async () => {
    const p = new PendingPrompts(ids());
    let release: (id: number) => void = () => {};
    const orphans: number[] = [];
    const answer = p.ask('question', ['x'], () => new Promise<number>((r) => (release = r)), (mid) => orphans.push(mid));
    await flush();
    p.resolveText('typed before the buttons went out');
    release(99);
    expect(await answer).toMatchObject({ answer: 'typed before the buttons went out' });
    await flush();
    expect(orphans).toEqual([99]);
  });
});
