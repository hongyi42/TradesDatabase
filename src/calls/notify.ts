import { listManagersWithTelegram } from '../db/index.js';
import { sendBoardMessage } from '../telegram/boardBot.js';

// Best-effort manager push for the inbound-call router. Fans a single one-line
// notice out to every ACTIVE manager with a Telegram binding (the same audience
// and liveness filter the schedule summaries use — see boardNotify.ts). NEVER
// throws: the durable record is the review item in the pull queue, so a Telegram
// blip (a blocked bot, an API 5xx) or even a roster-lookup fault must not fail
// the call it is notifying about. Each send is isolated so one bad recipient
// never suppresses the rest.
export async function notifyManagers(tenantId: string, text: string): Promise<void> {
  try {
    for (const m of await listManagersWithTelegram(tenantId)) {
      if (!m.telegram_user_id) continue; // defensive: the query already excludes nulls
      try {
        await sendBoardMessage(m.telegram_user_id, text);
      } catch (err) {
        console.error('[calls:notify] manager push failed', err);
      }
    }
  } catch (err) {
    console.error('[calls:notify] manager lookup failed', err);
  }
}
