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

const body = (c: Call) => JSON.parse((c.init?.body as string | undefined) ?? '{}') as Record<string, unknown>;

describe('TelegramClient', () => {
  it('long-polls for messages only and returns the updates', async () => {
    const { f, calls } = fakeFetch(() => ({ json: { ok: true, result: [{ update_id: 7 }] } }));
    const updates = await new TelegramClient('TOKEN', f).getUpdates(5);
    expect(updates).toEqual([{ update_id: 7 }]);
    expect(calls[0].url).toContain('/getUpdates');
    expect(body(calls[0])).toMatchObject({ offset: 5, timeout: 30, allowed_updates: ['message', 'callback_query'] });
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

  it('sends Telegram HTML and removes the old reply keyboard on every chunk', async () => {
    const { f, calls } = fakeFetch(() => ({ json: { ok: true, result: {} } }));
    await new TelegramClient('TOKEN', f).send(42, 'x'.repeat(9000));
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      const b = body(c);
      expect(b.chat_id).toBe(42);
      expect(b.parse_mode).toBe('HTML');
      expect(b.reply_markup).toEqual({ remove_keyboard: true });
    }
  });

  it('resends a chunk as plain text when Telegram rejects the HTML', async () => {
    const { f, calls } = fakeFetch((c) =>
      body(c).parse_mode === 'HTML' ? { status: 400, json: { ok: false } } : { json: { ok: true, result: {} } },
    );
    await new TelegramClient('TOKEN', f).send(1, '**Tom** at 16:00');
    expect(calls).toHaveLength(2);
    expect(body(calls[1]).parse_mode).toBeUndefined();
    expect(body(calls[1]).text).toBe('**Tom** at 16:00');
  });

  it('posts the Working line with an inline Stop button, silently, and returns its id', async () => {
    const { f, calls } = fakeFetch(() => ({ json: { ok: true, result: { message_id: 55 } } }));
    expect(await new TelegramClient('TOKEN', f).sendWorking(9)).toBe(55);
    expect(body(calls[0])).toMatchObject({
      chat_id: 9,
      text: 'Working…',
      disable_notification: true,
      reply_markup: { inline_keyboard: [[{ text: '⏹ Stop', callback_data: 'stop' }]] },
    });
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

  it('step 2b: sendDocument uploads multipart (no JSON content-type) with the name and bytes', async () => {
    const { f, calls } = fakeFetch(() => ({ json: { ok: true, result: {} } }));
    await new TelegramClient('tok', f).sendDocument(42, 'open_jobs.xlsx', new Uint8Array([1, 2, 3]), 'Open jobs');
    const c = calls[0];
    expect(c.url).toBe('https://api.telegram.org/bottok/sendDocument');
    expect(c.init?.headers).toBeUndefined();
    const form = c.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('chat_id')).toBe('42');
    expect(form.get('caption')).toBe('Open jobs');
    const doc = form.get('document') as File;
    expect(doc.name).toBe('open_jobs.xlsx');
    expect(new Uint8Array(await doc.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('step 2b: sendDocument refuses over 50 MB before any request, and reports a failed upload', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 400, json: { ok: false } }));
    const tg = new TelegramClient('tok', f);
    await expect(tg.sendDocument(42, 'big.bin', new Uint8Array(50 * 1024 * 1024 + 1))).rejects.toThrow(/50 MB/);
    expect(calls).toHaveLength(0);
    await expect(tg.sendDocument(42, 'a.csv', new Uint8Array([1]))).rejects.toThrow(/sendDocument failed/);
  });
});

