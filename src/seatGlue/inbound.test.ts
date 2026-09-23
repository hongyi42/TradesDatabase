import { describe, expect, it } from 'vitest';
import { classify } from './inbound.js';
import type { TgMessage, TgUpdate } from './telegram.js';

const BEN = 8991633730;
const msg = (m: Partial<TgMessage>, from = BEN, type = 'private'): TgUpdate => ({
  update_id: 1,
  message: { message_id: 1, chat: { id: from, type }, from: { id: from }, ...m },
});

describe('classify', () => {
  it('drops anyone but the seat person, and any group chat', () => {
    expect(classify(msg({ text: 'hi' }, 111111111), BEN)).toEqual({ kind: 'ignored' });
    expect(classify(msg({ text: 'hi' }, BEN, 'group'), BEN)).toEqual({ kind: 'ignored' });
    expect(classify({ update_id: 3 }, BEN)).toEqual({ kind: 'ignored' });
  });

  it('reads text, the Stop button and /new', () => {
    expect(classify(msg({ text: 'fan is fixed' }), BEN)).toEqual({ kind: 'text', chatId: BEN, text: 'fan is fixed' });
    expect(classify(msg({ text: ' stop ' }), BEN)).toEqual({ kind: 'stop', chatId: BEN });
    expect(classify(msg({ text: '/new' }), BEN)).toEqual({ kind: 'new', chatId: BEN });
    expect(classify(msg({ text: '/new@ragisan03_bot' }), BEN)).toEqual({ kind: 'new', chatId: BEN });
  });

  it('keeps a sentence containing "stop" as text', () => {
    expect(classify(msg({ text: 'stop by the Hendricks job' }), BEN).kind).toBe('text');
  });

  it('takes the largest photo size and its caption', () => {
    const got = classify(
      msg({
        photo: [
          { file_id: 'small', width: 90, height: 90 },
          { file_id: 'big', width: 1280, height: 960 },
          { file_id: 'mid', width: 320, height: 240 },
        ],
        caption: 'before',
      }),
      BEN,
    );
    expect(got).toEqual({ kind: 'photo', chatId: BEN, fileId: 'big', caption: 'before' });
  });

  it('reads a voice note, defaulting its type to ogg', () => {
    expect(classify(msg({ voice: { file_id: 'v1' } }), BEN)).toEqual({
      kind: 'voice',
      chatId: BEN,
      fileId: 'v1',
      mimeType: 'audio/ogg',
    });
  });

  it('answers anything else as unsupported', () => {
    expect(classify(msg({ sticker: { file_id: 's' } }), BEN)).toEqual({ kind: 'unsupported', chatId: BEN });
  });
});
