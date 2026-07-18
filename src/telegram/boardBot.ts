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

// chatId = the person's Telegram user id (1:1 chat ids equal user ids), i.e.
// technicians.telegram_user_id verbatim.
export async function sendBoardMessage(chatId: string, text: string): Promise<void> {
  await callTelegram('sendMessage', { chat_id: chatId, text });
}
