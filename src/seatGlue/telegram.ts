import { defaultFetch, type FetchLike } from './http.js';

// The Telegram Bot API calls the glue makes (core.telegram.org/bots/api). Long
// polling only — no webhook, so the box needs no inbound port. Telegram allows
// ONE poller per bot: a second one makes both deaf, which is why a 409 here is
// its own error type and the seat exits on it rather than fighting.
//
// Error messages never carry a URL: every URL here contains the bot token.

export const TELEGRAM_MAX_TEXT = 4096;
export const TELEGRAM_MAX_DOWNLOAD = 20 * 1024 * 1024;
// A persistent one-button keyboard: the Stop button is always under the chat.
export const STOP_TEXT = 'Stop';
const KEYBOARD = { keyboard: [[{ text: STOP_TEXT }]], is_persistent: true, resize_keyboard: true };

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

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TelegramApi {
  getUpdates(offset: number): Promise<TgUpdate[]>;
  send(chatId: number, text: string): Promise<void>;
  typing(chatId: number): Promise<void>;
  download(fileId: string): Promise<Buffer>;
}

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
      { offset, timeout: 30, allowed_updates: ['message'] },
      45_000,
    );
    return Array.isArray(result) ? (result as TgUpdate[]) : [];
  }

  async send(chatId: number, text: string): Promise<void> {
    for (const chunk of splitText(text)) {
      await this.call('sendMessage', { chat_id: chatId, text: chunk, reply_markup: KEYBOARD });
    }
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
