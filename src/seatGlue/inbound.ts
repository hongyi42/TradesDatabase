import { STOP_TEXT, type TgUpdate } from './telegram.js';

// What one Telegram update means to the seat. The allowlist lives here: anyone
// but the seat's own person, and any group chat, is dropped without a reply —
// openclaw's dmPolicy:"allowlist" did the same.
export type Inbound =
  | { kind: 'text'; chatId: number; text: string }
  | { kind: 'photo'; chatId: number; fileId: string; caption?: string }
  | { kind: 'voice'; chatId: number; fileId: string; mimeType: string }
  | { kind: 'stop'; chatId: number }
  | { kind: 'new'; chatId: number }
  | { kind: 'unsupported'; chatId: number }
  | { kind: 'ignored' };

export function classify(update: TgUpdate, allowedUserId: number): Inbound {
  const m = update.message;
  if (!m || m.chat?.type !== 'private' || m.from?.id !== allowedUserId) return { kind: 'ignored' };
  const chatId = m.chat.id;

  if (typeof m.text === 'string') {
    const t = m.text.trim();
    if (t.toLowerCase() === STOP_TEXT.toLowerCase()) return { kind: 'stop', chatId };
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

  return { kind: 'unsupported', chatId };
}
