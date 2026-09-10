// Thin Bot API wrappers for the BOARD bot — one global, plain-code (non-AI)
// bot owned by Render. No update listener exists on purpose: the menu button
// is set once at worker startup (pure Bot API, no BotFather step), and after
// that Telegram itself renders the "Open board" button in every 1:1 chat a
// person has started with the bot. Notifications are plain sendMessage pushes.

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
}

function apiUrl(method: string): string {
  const token = process.env.BOARD_BOT_TOKEN;
  if (!token) throw new Error('BOARD_BOT_TOKEN is not set');
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function callTelegram(method: string, payload: unknown): Promise<void> {
  const resp = await fetch(apiUrl(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await resp.json().catch(() => null)) as TelegramApiResponse | null;
  if (!resp.ok || !body?.ok) {
    throw new Error(`telegram ${method} failed: ${body?.description ?? `HTTP ${resp.status}`}`);
  }
}

// Default-scope menu button: every private chat with the board bot gets an
// "Open board" web_app button pointing at the hosted page. Idempotent — safe
// to call on every worker start.
export async function setBoardMenuButton(): Promise<void> {
  const base = process.env.BOARD_PUBLIC_URL;
  if (!base) throw new Error('BOARD_PUBLIC_URL is not set');
  await callTelegram('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Open board',
      web_app: { url: `${base.replace(/\/+$/, '')}/board` },
    },
  });
}

// PER-CHAT console button — the rollout lever for the new dispatch console
// (src/console/consoleApi.ts) while the board is still the product.
//
// Telegram allows ONE menu button per scope, and the default scope is already
// spoken for by "Open board". A chat-scoped button overrides the default for
// exactly the people named in CONSOLE_MENU_CHAT_IDS, so the console can be put
// in front of one manager on the pilot while every other roster member keeps
// the board they have been using. Nothing about the board changes; the two
// UIs are live at the same time, over the same data, and the swap at the end
// is this list growing to "everyone" and then the default button moving.
//
// Failures are per-chat and non-fatal to the caller's loop: one bad id (a
// person who never started the bot) must not stop the worker from booting.
export async function setConsoleMenuButtonFor(chatIds: string[]): Promise<void> {
  const base = process.env.BOARD_PUBLIC_URL;
  if (!base) throw new Error('BOARD_PUBLIC_URL is not set');
  const url = `${base.replace(/\/+$/, '')}/console`;
  for (const chatId of chatIds) {
    try {
      await callTelegram('setChatMenuButton', {
        chat_id: chatId,
        menu_button: { type: 'web_app', text: 'Schedule', web_app: { url } },
      });
    } catch (err) {
      console.error(`board worker: console button not set for ${chatId}:`, err);
    }
  }
}

// The ids the console button is set for, read from the environment as a
// comma-separated list. Empty/unset = nobody, which is the default: shipping
// this code must not put a half-finished UI in front of the pilot.
export function consoleMenuChatIds(): string[] {
  return (process.env.CONSOLE_MENU_CHAT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// chatId = the person's Telegram user id (technicians.telegram_user_id
// verbatim). "Private-chat id equals user id" is a DE-FACTO Bot API
// convention, not a stated guarantee: sendMessage documents chat_id only as
// "unique identifier for the target chat"
// (https://core.telegram.org/bots/api#sendmessage), and the closest official
// acknowledgement is ChatJoinRequest.user_chat_id — a private-chat id handed
// out precisely for send-to-user use
// (https://core.telegram.org/bots/api#chatjoinrequest). Verified live
// 2026-07-18; if it ever breaks, capture chat.id from the person's /start
// update instead of assuming the equivalence.
export async function sendBoardMessage(chatId: string, text: string): Promise<void> {
  await callTelegram('sendMessage', { chat_id: chatId, text });
}
