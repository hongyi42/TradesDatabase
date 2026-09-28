import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpInit } from './http.js';
import { ANSWER_Q, JEV_MODEL, PLAN_Q, answersPrompt, approvesPlan, needsPlan } from './jev.js';

function fake(p: number | null, status = 200, seen: { url?: string; body?: Record<string, unknown>; auth?: string } = {}): FetchLike {
  return async (url: string, init?: HttpInit) => {
    seen.url = url;
    seen.body = JSON.parse((init?.body as string | undefined) ?? '{}');
    seen.auth = init?.headers?.authorization;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ answers: { q: { noul: p } } }),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}
const opts = (fetchFn: FetchLike, timeoutMs?: number) => ({ openrouterKey: 'or-key', fetchFn, timeoutMs, log: () => {} });

describe('jev.needsPlan', () => {
  it('asks the decisions endpoint with the measured question and the previous exchange', async () => {
    const seen: { url?: string; body?: Record<string, unknown>; auth?: string } = {};
    const r = await needsPlan(opts(fake(0.87, 200, seen)), 'invoice last month', { user: 'hi', assistant: 'hello' });
    expect(r).toEqual({ plan: true, p: 0.87 });
    expect(seen.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(seen.auth).toBe('Bearer or-key');
    expect(seen.body).toMatchObject({
      model: JEV_MODEL,
      state: { message: 'invoice last month', previous: { user: 'hi', assistant: 'hello' } },
      questions: { q: { type: 'noul', instructions: PLAN_Q } },
    });
  });

  it('0.5 plans, 0.49 does not', async () => {
    expect((await needsPlan(opts(fake(0.5)), 'x')).plan).toBe(true);
    expect((await needsPlan(opts(fake(0.49)), 'x')).plan).toBe(false);
  });

  it('an HTTP error, a missing answer or a timeout means no plan — never a blocked reply', async () => {
    expect(await needsPlan(opts(fake(0.9, 500)), 'x')).toEqual({ plan: false, p: null });
    expect(await needsPlan(opts(fake(null)), 'x')).toEqual({ plan: false, p: null });
    const hang: FetchLike = (_u, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    const t0 = Date.now();
    expect(await needsPlan(opts(hang, 50), 'x')).toEqual({ plan: false, p: null });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('jev.approvesPlan', () => {
  it('approves only when sure (≥ 0.6); failure is a change request', async () => {
    expect(await approvesPlan(opts(fake(0.9)), 'yes go', 'plan')).toBe(true);
    expect(await approvesPlan(opts(fake(0.59)), 'maybe', 'plan')).toBe(false);
    expect(await approvesPlan(opts(fake(0.9, 503)), 'yes', 'plan')).toBe(false);
  });
});

describe('jev.answersPrompt', () => {
  it('sends the question, its options and the reply; ≥ 0.5 answers; failure counts as an answer', async () => {
    const seen: { url?: string; body?: Record<string, unknown>; auth?: string } = {};
    expect(await answersPrompt(opts(fake(0.8, 200, seen)), 'the furnace one', 'Which job?', ['Furnace', 'AC'])).toBe(true);
    expect(seen.body).toMatchObject({ state: { question: 'Which job?', options: ['Furnace', 'AC'], reply: 'the furnace one' }, questions: { q: { instructions: ANSWER_Q } } });
    expect(await answersPrompt(opts(fake(0.2)), 'send Mrs Lee her invoice', 'Which job?', [])).toBe(false);
    expect(await answersPrompt(opts(fake(0.2, 500)), 'x', 'q', [])).toBe(true);
  });
});
