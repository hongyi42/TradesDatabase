import { listManagersWithTelegram, queuePersonPush } from '../db/index.js';

// Best-effort manager push for the inbound-call router. Fans a single one-line
// notice out to every ACTIVE manager with a Telegram binding (the same audience
// and liveness filter the schedule summaries use — see boardNotify.ts). NEVER
// throws: the durable record is the `call_action` observation, so a Telegram
// blip (a blocked bot, an API 5xx) or even a roster-lookup fault must not fail
// the call it is notifying about. Each send is isolated so one bad recipient
// never suppresses the rest.
export async function notifyManagers(tenantId: string, text: string): Promise<void> {
  try {
    for (const m of await listManagersWithTelegram(tenantId)) {
      if (!m.telegram_user_id) continue; // defensive: the query already excludes nulls
      try {
        // QUEUED, not sent (one-bot phase 2): the box delivers it through the
        // manager's own assistant, because sending from here meant sending as
        // the board bot — the one token Render holds, and the last reason that
        // bot had to exist. Delivery is a tick away rather than immediate; the
        // box tick was shortened to a minute because a call notice that is five
        // minutes late has lost most of its point.
        await queuePersonPush({ tenantId, technicianId: m.id, kind: 'call', body: text });
      } catch (err) {
        console.error('[calls:notify] manager push failed', err);
      }
    }
  } catch (err) {
    console.error('[calls:notify] manager lookup failed', err);
  }
}
