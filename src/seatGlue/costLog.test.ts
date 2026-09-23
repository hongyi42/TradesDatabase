import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostLog, type CostLine } from './costLog.js';
import type { FetchLike } from './http.js';

const GEN = {
  data: {
    model: 'google/gemini-3.8-flash-20260902',
    provider_name: 'Google',
    total_cost: 0.0042,
    tokens_prompt: 5700,
    tokens_completion: 120,
    native_tokens_cached: 5000,
    native_tokens_reasoning: 300,
  },
};

function scripted(statuses: Array<number | 'throw'>) {
  const urls: string[] = [];
  let i = 0;
  const f: FetchLike = async (url) => {
    urls.push(url);
    const s = statuses[Math.min(i++, statuses.length - 1)];
    if (s === 'throw') throw new Error('network down');
    return { ok: s === 200, status: s, json: async () => (s === 200 ? GEN : {}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { f, urls };
}

async function lines(dir: string): Promise<CostLine[]> {
  const text = await readFile(join(dir, 'costs', '2026-09.jsonl'), 'utf8');
  return text.trim().split('\n').map((l) => JSON.parse(l) as CostLine);
}

describe('CostLog', () => {
  let dir: string;
  const noWait = async () => {};
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'seat-costs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const log = (f: FetchLike) =>
    new CostLog(
      { seat: 's5', tenantId: 't1', technicianRef: 'ben-shelton', stateDir: dir, openrouterKey: 'k' },
      { fetch: f, sleep: noWait, now: () => new Date('2026-09-22T10:00:00Z'), delaysMs: [1, 1, 1] },
    );

  it('retries while the record is not ready, then writes the served model and price', async () => {
    const { f, urls } = scripted([404, 'throw', 200]);
    await log(f).record({ generationId: 'gen-1', replyId: 'r1', sessionId: 's5-1', kind: 'seat' });
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe('https://openrouter.ai/api/v1/generation?id=gen-1');
    expect(await lines(dir)).toEqual([
      expect.objectContaining({
        status: 'ok',
        generationId: 'gen-1',
        replyId: 'r1',
        model: 'google/gemini-3.8-flash-20260902',
        provider: 'Google',
        totalCost: 0.0042,
        tokensPrompt: 5700,
        cached: 5000,
        reasoning: 300,
        technicianRef: 'ben-shelton',
      }),
    ]);
  });

  it('writes an unresolved line once the retries run out', async () => {
    const { f } = scripted([404]);
    await log(f).record({ generationId: 'gen-2', replyId: null, sessionId: null, kind: 'seat' });
    const [line] = await lines(dir);
    expect(line.status).toBe('unresolved');
    expect(line.generationId).toBe('gen-2');
    expect(line.totalCost).toBeUndefined();
  });

  it('stops retrying on an auth error', async () => {
    const { f, urls } = scripted([401]);
    await log(f).record({ generationId: 'gen-3', replyId: null, sessionId: null, kind: 'seat' });
    expect(urls).toHaveLength(1);
  });

  it('logs a generation id once, however many events carry it', async () => {
    const { f, urls } = scripted([200]);
    const l = log(f);
    await l.record({ generationId: 'gen-4', replyId: 'r', sessionId: 's', kind: 'seat' });
    expect(await l.record({ generationId: 'gen-4', replyId: 'r', sessionId: 's', kind: 'seat' })).toBeNull();
    expect(urls).toHaveLength(1);
    expect(await lines(dir)).toHaveLength(1);
  });
});
