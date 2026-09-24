import { toTelegramHtml } from './format.js';
import { defaultFetch, type FetchLike } from './http.js';

// The Telegram Bot API calls the glue makes (core.telegram.org/bots/api). Long
// polling only — no webhook, so the box needs no inbound port. Telegram allows
// ONE poller per bot: a second one makes both deaf, which is why a 409 here is
// its own error type and the seat exits on it rather than fighting.
//
// Error messages never carry a URL: every URL here contains the bot token.

export const TELEGRAM_MAX_TEXT = 4096;
export const TELEGRAM_MAX_DOWNLOAD = 20 * 1024 * 1024;
// Stop, operator 2026-09-23: a small "⏹ Stop" button on a "Working…" line that
// exists only while the seat is working (an inline keyboard, answered through
// callback_query), not a permanent reply keyboard taking half the screen.
// Typing "stop" or /stop still works.
export const STOP_TEXT = 'Stop';
export const STOP_CALLBACK = 'stop';
export const WORKING_TEXT = 'Working…';
// Telegram keeps a reply keyboard on the phone until a message removes it: the
// big Stop button the first s5 build installed goes away with the next reply.
const REMOVE_KEYBOARD = { remove_keyboard: true };
const STOP_BUTTON = { inline_keyboard: [[{ text: '⏹ Stop', callback_data: STOP_CALLBACK }]] };

export class TelegramConflictError extends Error {
  constructor() {
    super('telegram: 409 Conflict — another process is polling this bot');
    this.name = 'TelegramConflictError';
  }
}

export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number };
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  voice?: { file_id: string; mime_type?: string; file_size?: number };
  [other: string]: unknown;
}

export interface TgCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message?: { message_id: number; chat: { id: number; type: string } };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TelegramApi {
  getUpdates(offset: number): Promise<TgUpdate[]>;
  send(chatId: number, text: string): Promise<void>;
  typing(chatId: number): Promise<void>;
  download(fileId: string): Promise<Buffer>;
  /** Post the "Working…" line with its Stop button; returns its message id. */
  sendWorking(chatId: number): Promise<number>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  /** Acknowledge a button tap (Telegram shows a spinner until this is called). */
  answerCallback(callbackQueryId: string, text?: string): Promise<void>;
  /**
   * A message with inline buttons (step 2a: ask_user choices, a plan's Go/Change).
   * Long text is split like send(); the buttons ride the LAST chunk, whose id is returned.
   */
  sendButtons(chatId: number, text: string, rows: ButtonRow[]): Promise<number>;
  /** Remove a message's buttons once it is answered. */
  clearButtons(chatId: number, messageId: number): Promise<void>;
}

export type ButtonRow = Array<{ text: string; data: string }>;

export class TelegramClient implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = defaultFetch,
  ) {}

  private async call(method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 409) throw new TelegramConflictError();
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown } | null;
    if (!res.ok || !json?.ok) throw new Error(`telegram: ${method} failed (HTTP ${res.status})`);
    return json.result;
  }

  async getUpdates(offset: number): Promise<TgUpdate[]> {
    const result = await this.call(
      'getUpdates',
      { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
      45_000,
    );
    return Array.isArray(result) ? (result as TgUpdate[]) : [];
  }

  /**
   * One reply, as Telegram HTML (see format.ts) so links are tappable and bold
   * is bold. Split on the Markdown first — Telegram's 4096 limit counts the
   * text after parsing, so tags do not count against it. A chunk Telegram
   * rejects as HTML goes again as plain text: a reply is never lost to markup.
   */
  async send(chatId: number, text: string): Promise<void> {
    for (const chunk of splitText(text)) {
      try {
        await this.call('sendMessage', {
          chat_id: chatId,
          text: toTelegramHtml(chunk),
          parse_mode: 'HTML',
          reply_markup: REMOVE_KEYBOARD,
        });
      } catch {
        await this.call('sendMessage', { chat_id: chatId, text: chunk, reply_markup: REMOVE_KEYBOARD });
      }
    }
  }

  async sendWorking(chatId: number): Promise<number> {
    const msg = (await this.call('sendMessage', {
      chat_id: chatId,
      text: WORKING_TEXT,
      reply_markup: STOP_BUTTON,
      disable_notification: true,
    })) as { message_id?: number };
    if (typeof msg?.message_id !== 'number') throw new Error('telegram: sendMessage returned no message_id');
    return msg.message_id;
  }

  async sendButtons(chatId: number, text: string, rows: ButtonRow[]): Promise<number> {
    const chunks = splitText(text);
    for (const chunk of chunks.slice(0, -1)) await this.send(chatId, chunk);
    const last = chunks.at(-1) ?? '';
    const reply_markup = { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) };
    let msg: { message_id?: number };
    try {
      msg = (await this.call('sendMessage', { chat_id: chatId, text: toTelegramHtml(last), parse_mode: 'HTML', reply_markup })) as { message_id?: number };
    } catch {
      msg = (await this.call('sendMessage', { chat_id: chatId, text: last, reply_markup })) as { message_id?: number };
    }
    if (typeof msg?.message_id !== 'number') throw new Error('telegram: sendMessage returned no message_id');
    return msg.message_id;
  }

  async clearButtons(chatId: number, messageId: number): Promise<void> {
    await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  async typing(chatId: number): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: 'typing' });
  }

  async download(fileId: string): Promise<Buffer> {
    const file = (await this.call('getFile', { file_id: fileId })) as { file_path?: string; file_size?: number };
    if (!file?.file_path) throw new Error('telegram: getFile returned no file_path');
    if ((file.file_size ?? 0) > TELEGRAM_MAX_DOWNLOAD) throw new Error('telegram: file over 20 MB');
    const res = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`telegram: file download failed (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > TELEGRAM_MAX_DOWNLOAD) throw new Error('telegram: file over 20 MB');
    return buf;
  }
}

// Split on a paragraph or line or word boundary near the limit when there is
// one in the back quarter of the window; otherwise cut hard.
export function splitText(text: string, max = TELEGRAM_MAX_TEXT): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    if (cut < max * 0.75) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) out.push(rest);
  return out;
}
