import { describe, expect, it } from 'vitest';
import { downloadFile, sendFileTool, uploadFile, TELEGRAM_MAX_PHOTO } from './files.js';
import type { FetchLike, HttpInit } from './http.js';

const cfg = { spineUrl: 'https://spine.example/mcp', seatToken: 'st_abc' };
const ID = '11111111-2222-3333-4444-555555555555';

describe('the glue file client (step 2d)', () => {
  it('uploads raw bytes with kind and name in the query, the seat token, and a hard clock', async () => {
    let seen: { url: string; init?: HttpInit } | null = null;
    const fetchFn: FetchLike = async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => ({ id: ID }), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const id = await uploadFile(cfg, { kind: 'document', name: 'a b.pdf', mime: 'application/pdf', bytes: new Uint8Array([1, 2]), source: 'sandbox' }, fetchFn);
    expect(id).toBe(ID);
    const u = new URL(seen!.url);
    expect(u.pathname).toBe('/seat/files');
    expect(u.searchParams.get('kind')).toBe('document');
    expect(u.searchParams.get('name')).toBe('a b.pdf');
    expect(seen!.init?.headers).toMatchObject({ authorization: 'Bearer st_abc', 'content-type': 'application/pdf', 'x-file-source': 'sandbox' });
    expect(seen!.init?.body).toEqual(new Uint8Array([1, 2]));
    expect(seen!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("an upload refusal throws Render's words", async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 413, json: async () => ({ error: 'the file is over 20 MB' }), arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(uploadFile(cfg, { kind: 'photo', name: 'p.jpg', mime: 'image/jpeg', bytes: new Uint8Array([1]) }, fetchFn)).rejects.toThrow('over 20 MB');
  });

  it('downloads bytes with name and type; a 404 is null', async () => {
    const fetchFn: FetchLike = async (url) =>
      url.endsWith(ID)
        ? {
            ok: true,
            status: 200,
            json: async () => null,
            arrayBuffer: async () => new Uint8Array([9, 8]).buffer,
            headers: { get: (h: string) => ({ 'x-file-name': encodeURIComponent('before 1.jpg'), 'content-type': 'image/jpeg' })[h] ?? null },
          }
        : { ok: false, status: 404, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) };
    expect(await downloadFile(cfg, ID, fetchFn)).toEqual({ bytes: new Uint8Array([9, 8]), name: 'before 1.jpg', mime: 'image/jpeg' });
    expect(await downloadFile(cfg, 'other', fetchFn)).toBeNull();
  });
});

describe('send_file (step 2d)', () => {
  const setup = (file: { bytes: Uint8Array; name: string; mime: string } | null | Error) => {
    const photos: number[] = [];
    const docs: string[] = [];
    const tool = sendFileTool({
      downloadFile: async () => {
        if (file instanceof Error) throw file;
        return file;
      },
      sendPhoto: async (b) => void photos.push(b.length),
      sendDocument: async (n) => void docs.push(n),
    });
    return { tool, photos, docs };
  };

  it('a jpeg/png goes as a photo; anything else, or an image over 10 MB, as a document', async () => {
    const a = setup({ bytes: new Uint8Array(3), name: 'p.jpg', mime: 'image/jpeg' });
    expect(await a.tool.handler({ fileId: ID }, {})).toBe('Sent p.jpg to the chat.');
    expect(a.photos).toEqual([3]);
    const b = setup({ bytes: new Uint8Array(3), name: 'q.pdf', mime: 'application/pdf' });
    await b.tool.handler({ fileId: ID }, {});
    expect(b.docs).toEqual(['q.pdf']);
    const c = setup({ bytes: new Uint8Array(TELEGRAM_MAX_PHOTO + 1), name: 'big.jpg', mime: 'image/jpeg' });
    await c.tool.handler({ fileId: ID }, {});
    expect(c.docs).toEqual(['big.jpg']);
  });

  it('a photo Telegram refuses (its dimensions) goes as a document instead', async () => {
    const docs: string[] = [];
    const tool = sendFileTool({
      downloadFile: async () => ({ bytes: new Uint8Array(3), name: 'tall.png', mime: 'image/png' }),
      sendPhoto: async () => {
        throw new Error('telegram: sendPhoto failed (HTTP 400)');
      },
      sendDocument: async (n) => void docs.push(n),
    });
    expect(await tool.handler({ fileId: ID }, {})).toBe('Sent tall.png to the chat.');
    expect(docs).toEqual(['tall.png']);
  });

  it('every failure is words, never a throw', async () => {
    expect(await setup(null).tool.handler({ fileId: ID }, {})).toContain('No such file');
    expect(await setup(new Error('HTTP 503')).tool.handler({ fileId: ID }, {})).toContain('could not be fetched');
    expect(await setup(null).tool.handler({ fileId: 'nope' }, {})).toContain('give the fileId');
  });
});
