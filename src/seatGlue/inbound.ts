import { PROMPT_DATA } from './prompts.js';
import { STOP_CALLBACK, STOP_TEXT, TELEGRAM_MAX_DOWNLOAD, type TgUpdate } from './telegram.js';

// What one Telegram update means to the seat. The allowlist lives here: anyone
// but the seat's own person, and any group chat, is dropped without a reply —
// openclaw's dmPolicy:"allowlist" did the same.
export type Inbound =
  | { kind: 'text'; chatId: number; text: string }
  | { kind: 'photo'; chatId: number; fileId: string; caption?: string }
  | { kind: 'voice'; chatId: number; fileId: string; mimeType: string }
  /** A file sent as a file (step 2d): kept like a photo. */
  | { kind: 'document'; chatId: number; fileId: string; fileName: string; mimeType: string; caption?: string }
  /** A document over Telegram's 20 MB bot download limit: said, never fetched. */
  | { kind: 'tooBig'; chatId: number }
  | { kind: 'stop'; chatId: number; callbackQueryId?: string; workingMessageId?: number }
  /** A tap on a waiting prompt's button (step 2a): `p:<promptId>:<index>`. */
  | { kind: 'tap'; chatId: number; promptId: string; index: number; callbackQueryId: string }
  | { kind: 'new'; chatId: number }
  | { kind: 'unsupported'; chatId: number }
  | { kind: 'ignored' };

export function classify(update: TgUpdate, allowedUserId: number): Inbound {
  // A tap on the "Working…" line's Stop button.
  const cb = update.callback_query;
  if (cb) {
    const chat = cb.message?.chat;
    if (cb.from?.id !== allowedUserId || !chat || chat.type !== 'private') return { kind: 'ignored' };
    if (cb.data === STOP_CALLBACK) {
      return { kind: 'stop', chatId: chat.id, callbackQueryId: cb.id, workingMessageId: cb.message?.message_id };
    }
    const tap = PROMPT_DATA.exec(cb.data ?? '');
    if (tap) return { kind: 'tap', chatId: chat.id, promptId: tap[1], index: Number(tap[2]), callbackQueryId: cb.id };
    return { kind: 'ignored' };
  }

  const m = update.message;
  if (!m || m.chat?.type !== 'private' || m.from?.id !== allowedUserId) return { kind: 'ignored' };
  const chatId = m.chat.id;

  if (typeof m.text === 'string') {
    const t = m.text.trim();
    if (t.toLowerCase() === STOP_TEXT.toLowerCase() || /^\/stop(@\w+)?$/i.test(t)) return { kind: 'stop', chatId };
    // "/new" or "/new@botname", as Telegram sends commands.
    if (/^\/new(@\w+)?$/i.test(t)) return { kind: 'new', chatId };
    if (!t) return { kind: 'unsupported', chatId };
    return { kind: 'text', chatId, text: m.text };
  }

  if (Array.isArray(m.photo) && m.photo.length) {
    const largest = m.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    const caption = typeof m.caption === 'string' && m.caption.trim() ? m.caption : undefined;
    return { kind: 'photo', chatId, fileId: largest.file_id, caption };
  }

  if (m.voice?.file_id) {
    return { kind: 'voice', chatId, fileId: m.voice.file_id, mimeType: m.voice.mime_type || 'audio/ogg' };
  }

  if (m.document?.file_id) {
    if ((m.document.file_size ?? 0) > TELEGRAM_MAX_DOWNLOAD) return { kind: 'tooBig', chatId };
    const caption = typeof m.caption === 'string' && m.caption.trim() ? m.caption : undefined;
    return {
      kind: 'document',
      chatId,
      fileId: m.document.file_id,
      fileName: m.document.file_name?.trim() || 'file',
      mimeType: m.document.mime_type || 'application/octet-stream',
      caption,
    };
  }

  return { kind: 'unsupported', chatId };
}
