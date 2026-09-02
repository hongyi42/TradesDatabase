import type { QueuedNudgeForHost } from '../db/index.js';
import {
  getQueuedNudgeForHost,
  isInactiveState,
  listQueuedNudgesForHost,
  listQueuedNudgesInGroupForHost,
  markNudgeAskedGroup,
  setNudgeDeliveryAttempts,
  setNudgeServeCount,
} from '../db/index.js';
import { FOOTER_DELIMITER } from '../teamLead/composeCopy.js';

// The voice's transport, spine side (plan 2026-08-15 feature B, Phase 4).
// The spine NEVER reaches into the agent box — the box already phones home
// every 5 minutes for badges, and queued nudges ride the same posture: served
// on a host-token pull until the box ACKS delivery, so a lost tick self-heals
// (the retirements precedent). The box-side half is
// Box_Setup_Stuff/nudge-runner.sh.
//
// BROKEN-PIPE DOCTRINE (build 5, user ruling 4 — replaces the old
// terminal-failure handoff): an undeliverable question is an OPERATOR
// condition, not a firm decision. No path here hands anything to a manager or
// fails a row any more — a row past its serve or attempt caps is FROZEN
// (never re-served, never terminal), the sweep's alarm pass counts it as
// deliveryStuck, and the PLANNER still owns the gap and ends it however its
// judgment dictates. (That sentence used to say "it can escalate it
// deliberately, with an honest note"; the verb was deleted in build 6 Phase 1.
// A frozen row is QUEUED, so today its only ENDING is `close` — `send` and
// `hold` are refused on a queued row until build 6 Phase 2 widens hold, and
// `leave` records a reason without changing anything. Note what the planner
// still CAN do: `ask_agent` works on any stage, so the person's assistant is
// reachable even when their queued question is not. Build 6 Phase 5 is what
// tells the planner the row is frozen at all — until then it cannot see the
// difference between frozen and merely slow.)

// A nudge served more than this many times without an ack is POISON — some
// box-side fault re-serves it forever, and it must stop re-alarming (the
// PARKED analog). It FREEZES instead of serving (build 5) and the alarm pass
// counts it as deliveryStuck.
export const MAX_SERVE_COUNT = 10;
// Explicit delivery-failure reports before giving up. attempts was reset to 0
// at queue time, so the delivery ledger is its own (see markNudgeQueued).
export const MAX_DELIVERY_ATTEMPTS = 3;

// One deliverable, exactly what the runner needs and nothing else. The
// legacy messageB64 (the footered deliverable v1 relayed through an agent
// turn) was REMOVED in ④b Phase 5 — the whole fleet runs v2, which reads
// only directMessageB64. sessionId remains pinned per nudge (decision D6)
// though v2 no longer opens a session with it.
export interface NudgeDeliveryItem {
  id: string;
  sandboxRef: string;
  replyTo: string; // the technician's telegram user id
  sessionId: string;
  // The verbatim deliverable (④b): base64 keeps the multi-line body
  // shell-safe on the box (badge-pull's argument discipline). The
  // FOOTER_DELIMITER strip below is for LEGACY rows queued before the
  // footer's retirement — a post-retirement question passes through
  // unchanged (stored = shown = sent).
  directMessageB64: string;
}

export interface NudgeQueueDeps {
  listQueued?: typeof listQueuedNudgesForHost;
  getQueued?: typeof getQueuedNudgeForHost;
  serveCount?: typeof setNudgeServeCount;
  asked?: typeof markNudgeAskedGroup;
  groupMembers?: typeof listQueuedNudgesInGroupForHost;
  attempts?: typeof setNudgeDeliveryAttempts;
}

// Build one pull's worth of deliveries for a host. Liveness is RE-FILTERED at
// serve time (constraints 19-20): a technician who went inactive or lost
// their sandbox between queue and serve is SKIPPED, not failed — a rebind may
// heal them; a row that can never deliver ages into the deliveryStuck alarm
// and stays the planner's to end (build 5).
export async function buildNudgeDelivery(
  hostId: string,
  deps: NudgeQueueDeps = {},
): Promise<{ nudges: NudgeDeliveryItem[] }> {
  const listQueued = deps.listQueued ?? listQueuedNudgesForHost;
  const serveCount = deps.serveCount ?? setNudgeServeCount;

  const rows = await listQueued(hostId);
  const items: NudgeDeliveryItem[] = [];
  // ONE ITEM PER GROUP (plan 2026-08-25, Phase 2). An ungrouped row is its own
  // group of one, so the ungrouped path below is byte-for-byte what shipped
  // before. Insertion order is preserved from `rows`, which arrives created_at
  // ascending, so a group takes the position of its earliest member and the
  // host's delivery order is unchanged.
  // A delivery GROUP and the member that leads it, decided here so the serve
  // loop below never has to ask again. An UNGROUPED row is its own group of one
  // AND its own lead — that path stays byte-for-byte what shipped before.
  type Group = { lead: QueuedNudgeForHost | null; members: QueuedNudgeForHost[] };
  const groups: Group[] = [];
  const byGroup = new Map<string, Group>();
  for (const row of rows) {
    const g = row.ask_group_id;
    if (!g) {
      groups.push({ lead: row, members: [row] });
      continue;
    }
    const seen = byGroup.get(g);
    if (seen) {
      seen.members.push(row);
      // The lead names the group: `id = ask_group_id`, so it is self-identifying
      // and no second column is needed to point at it.
      if (row.id === g) seen.lead = row;
      continue;
    }
    const fresh: Group = { lead: row.id === g ? row : null, members: [row] };
    byGroup.set(g, fresh);
    groups.push(fresh);
  }
  for (const { lead, members } of groups) {
    // NO LEAD = FROZEN, never promoted (review finding). A group really can lose
    // its lead: the sweep's `moot` closes ONE queued row and leaves its siblings
    // alone (watchers.ts), so an overdue-visit lead can close on a cancelled
    // visit while the cost member stays queued. (There were two such paths until
    // the pre-ask carve-out was deleted on 2026-08-29; one is enough for this to
    // matter, and the planner's own `close` is a third.)
    //
    // Promoting a sibling looks harmless and is not. The delivery item id would
    // change, and the box dedupes on exactly that id (`sent-<id>` in
    // nudge-runner.sh) — so with no marker for the new id it would send the
    // identical grouped text A SECOND TIME, including the question that was just
    // answered. Both ledgers would restart from the new lead's zeros too, buying
    // the group 2x MAX_SERVE_COUNT and 2x MAX_DELIVERY_ATTEMPTS.
    //
    // So this takes the tamper-freeze's treatment: never served, never failed
    // here — the deliveryStuck alarm carries it once the members age past the
    // watch threshold, and the planner ends them by its own judgment
    // (build 6 Phase 1: it can no longer escalate them — see the header).
    if (!lead) {
      // Re-logged on every 5-minute pull — an operator condition, on purpose.
      console.error(
        `[nudgeQueue] ask-group ${members[0].ask_group_id} has no lead row (${members.length} ` +
          'members still queued) — frozen rather than re-delivered; see the alarm counters',
      );
      continue;
    }
    try {
      const tech = lead.technicians;
      if (!tech || isInactiveState(tech.state) || !tech.sandbox_ref || !tech.telegram_user_id) {
        continue; // frozen, not failed — see the liveness note above
      }
      if (!lead.question) continue; // queued implies composed; tampered row stays frozen
      if (lead.serve_count >= MAX_SERVE_COUNT) {
        // FROZEN, not failed (build 5): re-served this many times with no ack
        // means the pipe is broken, which is an operator problem — the alarm
        // counts the LEAD now (the ledgers live on it) and each member as its
        // own created_at ages past the threshold; the planner still owns the
        // gaps. Never reaches `items`, so it is never re-sent.
        console.error(
          `[nudgeQueue] nudge ${lead.id} served ${lead.serve_count}x with no delivery ack — ` +
            `frozen (${members.length} member(s)); delivery is broken, see the alarm counters`,
        );
        continue;
      }
      // Attempt-cap freeze (build 5): the box reported delivery FAILED
      // MAX_DELIVERY_ATTEMPTS times — stop re-serving a message that cannot
      // land, without failing the row. Same operator condition as above.
      if (lead.attempts >= MAX_DELIVERY_ATTEMPTS) {
        console.error(
          `[nudgeQueue] nudge ${lead.id} failed delivery ${lead.attempts}x — frozen ` +
            `(${members.length} member(s)); see the alarm counters`,
        );
        continue;
      }
      // Count the serve BEFORE shipping it (at-most-N-serves, even if this
      // response is lost). null = the row moved under us — drop it. The ledger
      // is the LEAD's: one message, one serve.
      const served = await serveCount(lead.id, lead.tenant_id, lead.serve_count + 1);
      if (!served) continue;
      items.push({
        id: lead.id,
        sandboxRef: tech.sandbox_ref,
        replyTo: tech.telegram_user_id,
        sessionId: `nudge-${lead.id}`,
        directMessageB64: Buffer.from(
          lead.question.split(FOOTER_DELIMITER)[0],
          'utf8',
        ).toString('base64'),
      });
    } catch (err) {
      // One poisoned group never blocks the host's other deliveries.
      console.error(`[nudgeQueue] serve of ${lead.id} failed`, err);
    }
  }
  return { nudges: items };
}

export type DeliveryReportResult = 'asked' | 'retry' | 'failed' | 'ignored';

// The box's report for ONE item. hostId comes from the TOKEN (the ops-report
// rule): a host can only move rows whose technician lives on it, and only
// while they are still queued — a late duplicate report lands on a row that
// already moved and is ignored.
export async function completeNudgeDelivery(
  hostId: string,
  id: string,
  report: 'delivered' | 'failed',
  detail: string | null,
  deps: NudgeQueueDeps = {},
): Promise<DeliveryReportResult> {
  const getQueued = deps.getQueued ?? getQueuedNudgeForHost;
  const asked = deps.asked ?? markNudgeAskedGroup;
  const groupMembers = deps.groupMembers ?? listQueuedNudgesInGroupForHost;
  const attempts = deps.attempts ?? setNudgeDeliveryAttempts;

  const row = await getQueued(id, hostId);
  if (!row) {
    // The point-read wants a QUEUED row, and a group's lead can leave that state
    // on its own: the sweep's `moot`, or the planner's own `close`, each close one
    // queued row and leave its siblings alone (watchers.ts). A delivered report arriving after
    // that would otherwise be 'ignored' — and the survivors, which really were
    // delivered inside the shared message, would sit queued-forever as
    // deliveryStuck alarms about a message that actually landed, with their
    // asked-clock never starting. The record must say what really happened.
    //
    // The group id IS the lead's id, so the reported id addresses the group even
    // once the lead is gone. Host-scoped, and no promotion happens.
    if (report !== 'delivered') return 'ignored';
    let survivors: QueuedNudgeForHost[] = [];
    try {
      survivors = await groupMembers(id, hostId);
    } catch (err) {
      console.error(`[nudgeQueue] group read for a closed lead ${id} failed`, err);
      return 'ignored';
    }
    if (survivors.length === 0) return 'ignored'; // unknown id, wrong host, or truly moved
    const moved = await asked(survivors[0].id, survivors[0].tenant_id, id);
    return moved.length > 0 ? 'asked' : 'ignored';
  }

  if (report === 'delivered') {
    // The whole group moves on one report, with one shared asked_at — they left
    // in one message, so their escalation clocks start together.
    //
    // TENANT-scoped, not host-scoped (accepted, recorded): a PostgREST UPDATE
    // cannot join, so the group move filters on tenant + group. What makes that
    // safe is Phase 3's rail — every member of a group shares one technician, so
    // one host owns all of them — plus the fact that `asked` is the honest state
    // for a row whose message really did go out.
    const moved = await asked(row.id, row.tenant_id, row.ask_group_id);
    return moved.length > 0 ? 'asked' : 'ignored';
  }

  const next = row.attempts + 1;
  const bumped = await attempts(row.id, row.tenant_id, next);
  if (!bumped) return 'ignored';
  if (next < MAX_DELIVERY_ATTEMPTS) return 'retry'; // still served next pull
  // Delivery gave up (build 5): NO manager handoff and NO terminal status —
  // the row FREEZES (the serve loop skips attempts >= cap), the alarm pass
  // counts it as deliveryStuck, and the planner still owns the gap. 'failed'
  // here tells the BOX to stop retrying, nothing more.
  console.error(
    `[nudgeQueue] nudge ${row.id} failed delivery ${next}x` +
      `${detail ? `: ${detail.slice(0, 300)}` : ''} — frozen; delivery is broken, ` +
      'see the alarm counters',
  );
  return 'failed';
}
