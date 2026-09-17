// The OPS bot: one plain-code bot that tells the operator when infrastructure
// breaks. Deliberately its own module, and deliberately NOT importing anything
// from boardBot.ts.
//
// WHY IT EXISTS. Ops alerts were the last thing still sent with
// BOARD_BOT_TOKEN, which is what kept @DashboardMan_bot alive after the
// one-bot-per-person merge moved every PERSON-facing message onto that person's
// own assistant (plan 2026-09-09, phase 2). An ops alert is the odd one out: it
// is not addressed to a customer's manager or a technician, it is
// host-scoped infrastructure news for whoever runs the box — so it does not
// belong on anyone's assistant either. It needs a bot of its own.
//
// WHY THE FALLBACK. Setting OPS_BOT_TOKEN is a deploy-time step, and the fleet
// is currently single-provider with no inference fallback — the medic's verdict
// is the only warning that every assistant has gone quiet. Cutting alerting off
// to make an architectural point would be strictly worse than the coupling it
// removes. So this resolves OPS_BOT_TOKEN and falls back to BOARD_BOT_TOKEN,
// announcing the fallback once per process.
//
// THE FALLBACK IS THE RETIREMENT SWITCH. Once OPS_BOT_TOKEN is set in Render,
// nothing here reads BOARD_BOT_TOKEN again — so retiring the board bot's
// notification role is a CONFIG change, not a deploy. When the board bot is
// finally deleted at BotFather, delete the fallback branch below with it.

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
}

let warnedAboutFallback = false;

/**
 * The token this bot sends with, or undefined when neither is configured.
 *
 * Exported so callers can skip cleanly on an unconfigured deploy rather than
 * letting a throw surface every tick — the same reason `notifyOpsTransition`
 * checked for a token before sending.
 */
export function opsBotToken(): string | undefined {
  const own = process.env.OPS_BOT_TOKEN?.trim();
  if (own) return own;
  const board = process.env.BOARD_BOT_TOKEN?.trim();
  if (!board) return undefined;
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      '[opsBot] OPS_BOT_TOKEN is not set — falling back to BOARD_BOT_TOKEN. ' +
        'Ops alerts are the last thing keeping the board bot alive; set OPS_BOT_TOKEN to cut it loose.',
    );
  }
  return board;
}

// Test seam. `.env` carries a REAL token, so without this the HTTP suite —
// which drives a real server over a real socket — would fire live Telegram
// messages at the operator.
export function resetOpsBotWarning(): void {
  warnedAboutFallback = false;
}

/**
 * Send one plain-text message as the ops bot.
 *
 * Throws if the send fails. Callers on a monitoring path are responsible for
 * swallowing that: a monitoring path that can fail its subject is worse than no
 * monitoring at all.
 */
export async function sendOpsMessage(chatId: string, text: string): Promise<void> {
  const token = opsBotToken();
  if (!token) throw new Error('neither OPS_BOT_TOKEN nor BOARD_BOT_TOKEN is set');
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const body = (await resp.json().catch(() => null)) as TelegramApiResponse | null;
  if (!resp.ok || !body?.ok) {
    throw new Error(`telegram sendMessage failed: ${body?.description ?? `HTTP ${resp.status}`}`);
  }
}
