import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpInit } from './http.js';
import { audioFormat, transcribe } from './voice.js';

function fake(status: number, json: unknown) {
  const seen: Array<{ url: string; init?: HttpInit }> = [];
  const f: FetchLike = async (url, init) => {
    seen.push({ url, init });
    return { ok: status === 200, status, json: async () => json, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { f, seen };
}

describe('transcribe', () => {
  it('asks Gemini on chat/completions with input_audio in the right format', async () => {
    const { f, seen } = fake(200, { id: 'gen-v1', choices: [{ message: { content: ' Fan swapped, parts 180. ' } }] });
    const out = await transcribe(Buffer.from('OggS'), 'audio/ogg', { openrouterKey: 'k', fetch: f });
    expect(out).toEqual({ text: 'Fan swapped, parts 180.', generationId: 'gen-v1' });
    expect(seen[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(seen[0].init?.body ?? '{}');
    expect(body.model).toBe('google/gemini-3.8-flash');
    const audio = body.messages[0].content.find((p: { type: string }) => p.type === 'input_audio');
    expect(audio.input_audio).toEqual({ data: Buffer.from('OggS').toString('base64'), format: 'ogg' });
  });

  it('throws on an HTTP error and on an empty transcript', async () => {
    await expect(transcribe(Buffer.from('x'), 'audio/ogg', { openrouterKey: 'k', fetch: fake(429, {}).f })).rejects.toThrow(
      'HTTP 429',
    );
    await expect(
      transcribe(Buffer.from('x'), 'audio/wav', { openrouterKey: 'k', fetch: fake(200, { choices: [{ message: { content: '' } }] }).f }),
    ).rejects.toThrow('empty');
  });
});

describe('audioFormat', () => {
  it('maps Telegram and fixture types, and refuses others', () => {
    expect(audioFormat('audio/ogg')).toBe('ogg');
    expect(audioFormat('audio/wav')).toBe('wav');
    expect(audioFormat('audio/mpeg')).toBe('mp3');
    expect(() => audioFormat('video/mp4')).toThrow('unsupported');
  });
});
