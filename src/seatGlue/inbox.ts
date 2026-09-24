import { defaultFetch, type FetchLike } from './http.js';
import { seatHeaders } from './identity.js';

// The seat's inbox on Render (step 3, plan 2026-09-23-step-3-office-reaches-
// glue-seats): what the office has queued for this seat's person, pulled with
// the seat token alone. Render serves only this person's rows and stamps the
// seat live, which is what keeps the box's old bash runners off them.
//
//   phone — texted to the person word for word (a planner question, an office
//           chat message, a system push). No model runs.
//   note  — for the assistant only, never shown to the person. No model runs
//           either: the glue attaches it to the person's next message.
//
// The pull also says who the seat is right now, so a running glue notices a
// Telegram rebind or a timezone change without waiting for a restart.

export interface InboxItem {
  id: string;
  leg: 'phone' | 'note';
  text: string;
}

export interface InboxResult {
  /** The seat's Telegram account now — null when nobody is bound. */
  seat: { telegramUserId: string | null; timezone: string };
  items: InboxItem[];
}

/** Render refused the token (401: unknown or rotated) or the person (403: deactivated). */
export class InboxRefused extends Error {
  constructor(readonly status: 401 | 403) {
    super(`seat-glue: inbox refused (HTTP ${status})`);
    this.name = 'InboxRefused';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function fetchInbox(spineUrl: string, token: string, fetchFn: FetchLike = defaultFetch): Promise<InboxResult> {
  const res = await fetchFn(new URL('/seat/inbox', spineUrl).toString(), {
    headers: { ...seatHeaders(token) },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 || res.status === 403) throw new InboxRefused(res.status);
  if (!res.ok) throw new Error(`seat-glue: inbox pull failed (HTTP ${res.status})`);
  const body = (await res.json()) as { seat?: Record<string, unknown>; items?: unknown };
  const seat = body.seat;
  if (!seat || typeof seat.timezone !== 'string' || !seat.timezone) {
    throw new Error('seat-glue: inbox returned no seat');
  }
  const tg = seat.telegramUserId;
  if (tg !== null && typeof tg !== 'string') throw new Error('seat-glue: inbox returned a bad telegramUserId');
  if (!Array.isArray(body.items)) throw new Error('seat-glue: inbox returned no items');
  const items: InboxItem[] = [];
  for (const raw of body.items as Array<Record<string, unknown>>) {
    // One malformed item never blocks the rest; it stays queued on Render.
    if (typeof raw?.id !== 'string' || !UUID.test(raw.id)) continue;
    if (raw.leg !== 'phone' && raw.leg !== 'note') continue;
    if (typeof raw.text !== 'string' || !raw.text) continue;
    items.push({ id: raw.id, leg: raw.leg, text: raw.text });
  }
  return { seat: { telegramUserId: tg, timezone: seat.timezone }, items };
}

export async function reportInbox(
  spineUrl: string,
  token: string,
  report: { id: string; leg: InboxItem['leg']; outcome: 'delivered' | 'failed'; detail?: string },
  fetchFn: FetchLike = defaultFetch,
): Promise<void> {
  const res = await fetchFn(new URL('/seat/inbox', spineUrl).toString(), {
    method: 'POST',
    headers: { ...seatHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`seat-glue: inbox report failed (HTTP ${res.status})`);
}
