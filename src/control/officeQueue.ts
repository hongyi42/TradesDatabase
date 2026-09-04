import type { QueuedOfficeMessageForHost } from '../db/index.js';
import {
  getQueuedOfficeMessageForHost,
  getTechnician,
  isInactiveState,
  listQueuedOfficeMessagesForHost,
  setOfficeMessageAttempts,
  setOfficeMessageDelivery,
  setOfficeMessageServeCount,
} from '../db/index.js';
import { TEAM_LEAD_REF } from '../teamLead/identity.js';
import { MAX_DELIVERY_ATTEMPTS, MAX_SERVE_COUNT } from './nudgeQueue.js';

// The office queue's transport, spine side (plan 2026-08-31 "the planner's
// inbox", build 5.5 Phase 3): agent-addressed messages — the planner's
// `send` (as:'assistant') and seat-to-seat informs — served on the same
// host-token pull posture as the nudge queue. The box-side half is
// Box_Setup_Stuff/office-runner.sh: `openclaw agent --session-key main`, NO
// --deliver — the turn lands in the agent's main session and NOTHING pings
// the human (the probed CLI door, s2 2026-08-31).
//
// BROKEN-PIPE DOCTRINE (the nudgeQueue rules, reused verbatim): a row past
// its serve or attempt caps is FROZEN — never re-served, never terminal — and
// stays visible in the queue for the operators. No groups here: one row, one
// injected turn.

/** One deliverable, exactly what the runner needs. `kind` rides so the box
 *  can log ask-vs-inform without decoding the payload. */
export interface OfficeDeliveryItem {
  id: string;
  sandboxRef: string;
  kind: string;
  directMessageB64: string;
}

export interface OfficeQueueDeps {
  listQueued?: typeof listQueuedOfficeMessagesForHost;
  getQueued?: typeof getQueuedOfficeMessageForHost;
  serveCount?: typeof setOfficeMessageServeCount;
  attempts?: typeof setOfficeMessageAttempts;
  delivery?: typeof setOfficeMessageDelivery;
  getTech?: typeof getTechnician;
}

/**
 * The injected turn's wrapper, code-printed and ORIGIN-HONEST: an office row
 * frames itself as the record system (never a person); a seat-sender row
 * names whose assistant it came from (never impersonating the office). The
 * receiving agent weighs it — inform-never-directs applies between seats too.
 */
export function wrapOfficeMessage(
  row: Pick<QueuedOfficeMessageForHost, 'id' | 'kind' | 'from_ref' | 'body'>,
  senderDisplayName: string | null,
): string {
  if (row.from_ref === TEAM_LEAD_REF) {
    const head = row.kind === 'ask' ? 'OFFICE QUESTION' : 'OFFICE NOTE';
    // THE REPLY ID RIDES ON BOTH KINDS since build 6.5 Phase 4, and this is a
    // fix rather than a widening. One `send` absorbed ask_agent/inform_agent,
    // and the collapse writes every planner message as kind 'inform' — because
    // there is no longer an ask/inform distinction for the planner to make.
    // Left alone, that silently removed the reply channel: only the 'ask'
    // framing carried "mention this id", `inform_team_lead`'s replyToMessageId
    // is documented as "the id that question told you to mention", so
    // `in_reply_to` would never be set for a planner message again and the
    // doctrine's promise that "a reply arrives on a later look" would be false.
    //
    // Mislabelling every note an OFFICE QUESTION would have restored the id at
    // the cost of a lie in the framing. Carrying the id on a note instead says
    // the true thing: you may answer this, and nothing is asking you to.
    const tail =
      row.kind === 'ask'
        ? ` — reply via inform_team_lead and mention this id: ${row.id}`
        : ' — verify against the record with your tools if it matters. If there is ' +
          `something to say back, reply via inform_team_lead mentioning this id: ${row.id}`;
    return `${head} (from the office record system, not a person): ${row.body}${tail}`;
  }
  const who = senderDisplayName ?? row.from_ref;
  return (
    `NOTE FROM ${who}'s assistant (relayed through the office queue, not a person ` +
    `speaking): ${row.body} — if this names something your person should be asked, ask ` +
    'them the normal way and record the answer as usual.'
  );
}

/** Build one pull's worth of agent-addressed deliveries for a host. Liveness
 *  is RE-FILTERED at serve time; a row that cannot deliver is SKIPPED (frozen
 *  by aging), never failed here. */
export async function buildOfficeDelivery(
  hostId: string,
  deps: OfficeQueueDeps = {},
): Promise<{ messages: OfficeDeliveryItem[] }> {
  const listQueued = deps.listQueued ?? listQueuedOfficeMessagesForHost;
  const serveCount = deps.serveCount ?? setOfficeMessageServeCount;
  const getTech = deps.getTech ?? getTechnician;

  // 'assistant' ONLY (build 6.5 Phase 4). A chat row rides the NUDGE pull, and
  // serving it here as well would inject it as a silent agent turn AND text it
  // — the same words arriving twice by two routes.
  const rows = await listQueued(hostId, 'assistant');
  const items: OfficeDeliveryItem[] = [];
  for (const row of rows) {
    try {
      const tech = row.technicians;
      if (!tech || isInactiveState(tech.state) || !tech.sandbox_ref) {
        continue; // frozen, not failed — a rebind may heal it
      }
      if (row.serve_count >= MAX_SERVE_COUNT) {
        // FROZEN (the nudgeQueue doctrine): re-served this many times with no
        // ack means the pipe is broken — an operator condition. Re-logged on
        // every pull, on purpose; see the office queue.
        console.error(
          `[officeQueue] message ${row.id} served ${row.serve_count}x with no delivery ack — ` +
            'frozen; see the office queue',
        );
        continue;
      }
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        console.error(
          `[officeQueue] message ${row.id} failed delivery ${row.attempts}x — frozen; ` +
            'see the office queue',
        );
        continue;
      }
      // Sender display name, for the seat-sender framing only — a failed read
      // degrades to the ref, never blocks the serve.
      let senderName: string | null = null;
      if (row.from_ref !== TEAM_LEAD_REF) {
        try {
          senderName = (await getTech(row.tenant_id, row.from_ref))?.display_name ?? null;
        } catch {
          senderName = null;
        }
      }
      // Count the serve BEFORE shipping (at-most-N-serves, even if this
      // response is lost). null = the row moved under us — drop it.
      const served = await serveCount(row.id, row.tenant_id, row.serve_count + 1);
      if (!served) continue;
      items.push({
        id: row.id,
        sandboxRef: tech.sandbox_ref,
        kind: row.kind,
        directMessageB64: Buffer.from(wrapOfficeMessage(row, senderName), 'utf8').toString(
          'base64',
        ),
      });
    } catch (err) {
      // One poisoned row never blocks the host's other deliveries.
      console.error(`[officeQueue] serve of ${row.id} failed`, err);
    }
  }
  return { messages: items };
}

export type OfficeReportResult = 'delivered' | 'retry' | 'failed' | 'ignored';

/** The box's report for ONE item. hostId comes from the TOKEN (the ops-report
 *  rule); only still-queued rows on this host can move. */
export async function completeOfficeDelivery(
  hostId: string,
  id: string,
  report: 'delivered' | 'failed',
  detail: string | null,
  deps: OfficeQueueDeps = {},
): Promise<OfficeReportResult> {
  const getQueued = deps.getQueued ?? getQueuedOfficeMessageForHost;
  const attempts = deps.attempts ?? setOfficeMessageAttempts;
  const delivery = deps.delivery ?? setOfficeMessageDelivery;

  const row = await getQueued(id, hostId);
  if (!row) return 'ignored'; // unknown id, wrong host, or already moved

  if (report === 'delivered') {
    const moved = await delivery(
      row.id,
      row.tenant_id,
      { status: 'delivered', deliveredAt: new Date().toISOString() },
      ['queued'],
    );
    return moved ? 'delivered' : 'ignored';
  }

  const next = row.attempts + 1;
  const bumped = await attempts(row.id, row.tenant_id, next);
  if (!bumped) return 'ignored';
  if (next < MAX_DELIVERY_ATTEMPTS) return 'retry'; // still served next pull
  // Gave up: NO status flip — the row FREEZES (the serve loop skips
  // attempts >= cap). 'failed' tells the BOX to stop retrying, nothing more.
  console.error(
    `[officeQueue] message ${row.id} failed delivery ${next}x` +
      `${detail ? `: ${detail.slice(0, 300)}` : ''} — frozen; see the office queue`,
  );
  return 'failed';
}
