import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike, HttpInit } from './http.js';
import { OUTBOX_KEPT, Transcript, type TurnRecord } from './transcript.js';

const TOKEN = `st_${'b'.repeat(64)}`;

function server(statuses: number[]) {
  const posts: TurnRecord[][] = [];
  const calls: HttpInit[] = [];
  let i = 0;
  const fetch: FetchLike = async (_url, init) => {
    calls.push(init ?? {});
    const status = statuses[Math.min(i++, statuses.length - 1)];
    if (status === 0) throw new Error('fetch failed');
    posts.push((JSON.parse(init?.body as string) as { turns: TurnRecord[] }).turns);
    return { ok: status < 300, status, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { fetch, posts, calls };
}

describe('Transcript', () => {
  let dir: string;
  let n = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'seat-transcript-'));
  });
  afterEach(async () => {
    // Retries: a save still in flight (the outbox writes in the background) can
    // land a file mid-delete — ENOTEMPTY under load, the suite's one flake.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
  const make = (fetch: FetchLike) =>
    new Transcript({ spineUrl: 'https://spine.example/mcp', seatToken: TOKEN, stateDir: dir, log: () => {} }, { fetch, newId });

  it('uploads person, tool and assistant turns in order with the seat token, then empties', async () => {
    const s = server([200]);
    const t = make(s.fetch);
    t.person('fan swapped at the Smiths', 's5-1');
    t.toolStart('call-1', 'record_field_note', { jobId: 'j1' }, 's5-1');
    t.toolDone('call-1', true);
    t.assistant('Got that recorded.', 's5-1');
    await t.flush();
    expect(s.calls[0].headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(s.posts[0].map((x) => [x.role, x.text ?? x.tool, x.ok])).toEqual([
      ['person', 'fan swapped at the Smiths', undefined],
      ['tool', 'record_field_note', true],
      ['assistant', 'Got that recorded.', undefined],
    ]);
    expect(t.pending).toBe(0);
  });

  it('a running tool call holds itself and every later turn back', async () => {
    const s = server([200]);
    const t = make(s.fetch);
    t.person('hi', 's');
    t.toolStart('call-2', 'get_job', {}, 's');
    t.assistant('later', 's');
    await t.flush();
    expect(s.posts[0].map((x) => x.role)).toEqual(['person']);
    expect(t.pending).toBe(2);
    t.settleOpenTools(); // the reply ended with no completion
    await t.flush();
    expect(s.posts[1].map((x) => [x.role, x.ok])).toEqual([
      ['tool', null],
      ['assistant', undefined],
    ]);
  });

  it('keeps turns on a refusal or a network error, and a new instance picks them up from disk', async () => {
    const t = make(server([500]).fetch);
    t.person('one', 's');
    await t.flush();
    await t.saved();
    const down = make(server([0]).fetch);
    await down.load();
    await down.flush();
    expect(down.pending).toBe(1);
    const later = server([200]);
    const again = make(later.fetch);
    await again.load();
    await again.flush();
    expect(later.posts[0].map((x) => x.text)).toEqual(['one']);
    await again.saved();
    expect(JSON.parse(await readFile(join(dir, 'transcript-outbox.json'), 'utf8'))).toEqual([]);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('drops the oldest turns past the cap', async () => {
    const t = make(server([500]).fetch);
    for (let i = 0; i < OUTBOX_KEPT + 3; i++) t.person(`m${i}`, 's');
    expect(t.pending).toBe(OUTBOX_KEPT);
    await t.saved();
    const saved = JSON.parse(await readFile(join(dir, 'transcript-outbox.json'), 'utf8')) as TurnRecord[];
    expect(saved[0].text).toBe('m3');
  });

  it('uploads in batches of at most 200', async () => {
    const s = server([200]);
    const t = make(s.fetch);
    for (let i = 0; i < 450; i++) t.person(`m${i}`, 's');
    await t.flush();
    expect(s.posts.map((p) => p.length)).toEqual([200, 200, 50]);
  });

  it('one flush at a time', async () => {
    const s = server([200]);
    const t = make(s.fetch);
    t.person('x', 's');
    await Promise.all([t.flush(), t.flush()]);
    expect(s.posts).toHaveLength(1);
  });

  it('after a restart, a tool call saved while running is unknown and never blocks uploads', async () => {
    const t = make(server([500]).fetch);
    t.toolStart('call-9', 'record_field_note', {}, 's');
    t.assistant('after the tool', 's');
    await t.saved();
    const s = server([200]);
    const next = make(s.fetch);
    await next.load();
    await next.flush();
    expect(s.posts[0].map((x) => [x.role, x.ok])).toEqual([
      ['tool', null],
      ['assistant', undefined],
    ]);
    expect(next.pending).toBe(0);
  });

  it('caps what it records, and sizes each upload by bytes so no batch is refused as too large', async () => {
    const s = server([200]);
    const t = make(s.fetch);
    t.person('é'.repeat(9_000), 's'); // 9000 characters, two bytes each
    t.toolStart('c', 'record_field_note', { note: 'x'.repeat(5_000) }, 's');
    t.toolDone('c', true);
    for (let i = 0; i < 60; i++) t.person('ü'.repeat(7_000), 's');
    await t.flush();
    const first = s.posts[0];
    expect(Array.from(first[0].text!)).toHaveLength(8_000);
    expect(first[1].args).toEqual({ truncated: true });
    for (const batch of s.posts) {
      expect(Buffer.byteLength(JSON.stringify({ turns: batch }))).toBeLessThan(256 * 1024);
    }
    expect(s.posts.flat()).toHaveLength(62);
    expect(t.pending).toBe(0);
  });

  it('a single turn Render refuses as too large is dropped, never retried forever', async () => {
    const t = make(server([413]).fetch);
    t.person('one', 's');
    await t.flush();
    expect(t.pending).toBe(0);
  });

  it('a multi-turn batch refused as too large is kept (the byte sizing prevents it)', async () => {
    const t = make(server([413]).fetch);
    t.person('one', 's');
    t.person('two', 's');
    await t.flush();
    expect(t.pending).toBe(2);
  });
});

