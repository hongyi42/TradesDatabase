import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpInit } from './http.js';
import { TelegramClient, TelegramConflictError, splitText } from './telegram.js';

type Call = { url: string; init?: HttpInit };

function fakeFetch(respond: (c: Call) => { status?: number; json?: unknown; bytes?: Buffer }) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const c = { url, init };
    calls.push(c);
    const r = respond(c);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json,
      arrayBuffer: async () => {
        const b = r.bytes ?? Buffer.alloc(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    };
  };
  return { f, calls };
}

const body = (c: Call) => JSON.parse(c.init?.body ?? '{}') as Record<string, unknown>;

describe('TelegramClient', () => {
  it('long-polls for messages only and returns the updates', async () => {
    const { f, calls } = fakeFetch(() => ({ json: { ok: true, result: [{ update_id: 7 }] } }));
    const updates = await new TelegramClient('TOKEN', f).getUpdates(5);
    expect(updates).toEqual([{ update_id: 7 }]);
    expect(calls[0].url).toContain('/getUpdates');
    expect(body(calls[0])).toMatchObject({ offset: 5, timeout: 30, allowed_updates: ['message'] });
  });

  it('turns HTTP 409 into a TelegramConflictError', async () => {
    const { f } = fakeFetch(() => ({ status: 409, json: { ok: false } }));
    await expect(new TelegramClient('TOKEN', f).getUpdates(0)).rejects.toBeInstanceOf(TelegramConflictError);
  });

  it('never puts the token in an error message', async () => {
    const { f } = fakeFetch(() => ({ status: 500, json: { ok: false } }));
    await expect(new TelegramClient('SECRET-TOKEN', f).send(1, 'hi')).rejects.toThrow(/sendMessage failed/);
    await new TelegramClient('SECRET-TOKEN', f).send(1, 'hi').catch((e: unknown) => {
      expect(String(e)).not.toContain('SECRET-TOKEN');
    });
  });

  it('sends plain text with the persistent Stop keyboard on every chunk', async () => {
    const { f, calls } = fakeFetch(() => ({ json: { ok: true, result: {} } }));
    await new TelegramClient('TOKEN', f).send(42, 'x'.repeat(9000));
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      const b = body(c);
      expect(b.chat_id).toBe(42);
      expect(b.parse_mode).toBeUndefined();
      expect(b.reply_markup).toEqual({ keyboard: [[{ text: 'Stop' }]], is_persistent: true, resize_keyboard: true });
    }
  });

  it('downloads a file through getFile and refuses one over 20 MB', async () => {
    const small = fakeFetch((c) =>
      c.url.includes('/getFile')
        ? { json: { ok: true, result: { file_path: 'voice/a.oga', file_size: 3 } } }
        : { bytes: Buffer.from('abc') },
    );
    expect((await new TelegramClient('TOKEN', small.f).download('F1')).toString()).toBe('abc');
    expect(small.calls[1].url).toContain('/file/botTOKEN/voice/a.oga');

    const big = fakeFetch(() => ({ json: { ok: true, result: { file_path: 'x', file_size: 21 * 1024 * 1024 } } }));
    await expect(new TelegramClient('TOKEN', big.f).download('F2')).rejects.toThrow('20 MB');
  });
});

describe('splitText', () => {
  it('splits 9,000 characters into three chunks under the limit', () => {
    const chunks = splitText('y'.repeat(9000));
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
    expect(chunks.join('')).toHaveLength(9000);
  });

  it('prefers a line break near the end of the window', () => {
    const text = `${'a'.repeat(4000)}\n${'b'.repeat(200)}`;
    expect(splitText(text)).toEqual(['a'.repeat(4000), 'b'.repeat(200)]);
  });

  it('leaves short text alone', () => {
    expect(splitText('hello')).toEqual(['hello']);
  });
});
