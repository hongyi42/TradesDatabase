import { defaultFetch, type FetchLike } from './http.js';
import { seatHeaders } from './identity.js';

// "Who am I?" — the glue's first call (step 4). The seat token alone answers it:
// Render returns the firm, the person, their Telegram account and the firm's
// timezone, so none of it is typed by hand on the box and none of it can drift
// from the roster. Every field is checked here, before the glue polls Telegram
// or starts the engine: a seat that cannot say who it is does not start (the
// unit retries), it never runs on a guessed identity.
export interface SeatWho {
  seatRef: string;
  tenantId: string;
  technicianRef: string;
  /** The ONE Telegram account this seat answers (inbound.ts drops everyone else). */
  telegramUserId: number;
  /** The firm's IANA timezone — the engine process's TZ. */
  tz: string;
}

export async function fetchWhoami(spineUrl: string, token: string, fetchFn: FetchLike = defaultFetch): Promise<SeatWho> {
  const res = await fetchFn(new URL('/seat/whoami', spineUrl).toString(), { headers: { ...seatHeaders(token) } });
  if (!res.ok) {
    // 401 = the token is unknown or rotated; 403 = the person is deactivated.
    throw new Error(`seat-glue: whoami refused (HTTP ${res.status})`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const text = (k: string): string => {
    const v = body[k];
    if (typeof v !== 'string' || !v) throw new Error(`seat-glue: whoami returned no ${k}`);
    return v;
  };
  // Same shape the roster's bind_telegram accepts (src/mcp/tools/roster.ts).
  const idText = body.telegramUserId;
  if (typeof idText !== 'string' || !/^[1-9][0-9]{4,19}$/.test(idText)) {
    throw new Error('seat-glue: this seat has no Telegram account bound (bind_telegram first)');
  }
  const tz = text('timezone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`seat-glue: the firm's timezone "${tz}" is not a valid IANA timezone`);
  }
  return {
    seatRef: text('seatRef'),
    tenantId: text('tenantId'),
    technicianRef: text('technicianRef'),
    telegramUserId: Number(idText),
    tz,
  };
}
