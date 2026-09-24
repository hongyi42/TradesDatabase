import type { QueuedNudgeForHost, QueueScope } from '../db/index.js';
import {
  getQueuedNudgeForHost,
  getQueuedOfficeMessageForHost,
  getQueuedPersonPushForHost,
  listQueuedPersonPushesForHost,
  setPersonPushAttempts,
  setPersonPushDelivered,
  setPersonPushServeCount,
  isInactiveState,
  listQueuedOfficeMessagesForHost,
  setOfficeMessageAttempts,
  setOfficeMessageDelivery,
  setOfficeMessageServeCount,
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
// A frozen row is QUEUED, and the planner ends it with `close` when the record
// settles the matter or `dismiss` when it will not (both legal on every stage
// since build 6 Phase 3). `countsAsTheAsk` is refused on a queued row — there
// is nothing to ask twice — and `hold` writes a date that changes nothing,
// since a frozen row is not waiting on a clock. Note what the planner still
// CAN do: a `send` WITHOUT the flag reaches the same person by either leg, so
// somebody with a frozen question is not out of reach. Build 6 Phase 5 is what
// tells the planner the row is frozen at all — before it, frozen and merely
// slow rendered identically.
//
// (`via='chat'` office rows DO ride this pipe as of build 6.5 Phase 4 — see
// the chat leg at the end of buildNudgeDelivery. They carry their own
// counters and freeze by the same two caps.))

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
  // THE CHAT LEG (build 6.5 Phase 4): office rows with via='chat' ride THIS
  // pull, because the box-side runner that texts a person verbatim is this
  // one. Injected like every other reader so a unit test never touches a DB.
  listQueuedChat?: typeof listQueuedOfficeMessagesForHost;
  getQueuedChat?: typeof getQueuedOfficeMessageForHost;
  chatServeCount?: typeof setOfficeMessageServeCount;
  chatAttempts?: typeof setOfficeMessageAttempts;
  chatDelivery?: typeof setOfficeMessageDelivery;
  getQueued?: typeof getQueuedNudgeForHost;
  serveCount?: typeof setNudgeServeCount;
  asked?: typeof markNudgeAskedGroup;
  groupMembers?: typeof listQueuedNudgesInGroupForHost;
  attempts?: typeof setNudgeDeliveryAttempts;
  // THE PUSH LEG (one-bot phase 2): verbatim system messages — a moved visit, an
  // inbound call — which have no sender and are none of the planner's business,
  // so they live in their own table rather than borrowing office_messages.
  // Injected like every other reader so a unit test never touches a DB.
  listQueuedPush?: typeof listQueuedPersonPushesForHost;
  getQueuedPush?: typeof getQueuedPersonPushForHost;
  pushServeCount?: typeof setPersonPushServeCount;
  pushAttempts?: typeof setPersonPushAttempts;
  pushDelivered?: typeof setPersonPushDelivered;
}

// Build one pull's worth of deliveries for a host. Liveness is RE-FILTERED at
// serve time (constraints 19-20): a technician who went inactive or lost
// their sandbox between queue and serve is SKIPPED, not failed — a rebind may
// heal them; a row that can never deliver ages into the deliveryStuck alarm
// and stays the planner's to end (build 5).
export async function buildNudgeDelivery(
  hostId: string,
  deps: NudgeQueueDeps = {},
  // Step 3: a glue seat's own person (onlyTechnicianId), or the box's runners
  // skipping every person whose glue is pulling (skipTechnicianIds).
  scope: QueueScope = {},
): Promise<{ nudges: NudgeDeliveryItem[] }> {
  const listQueued = deps.listQueued ?? listQueuedNudgesForHost;
  const serveCount = deps.serveCount ?? setNudgeServeCount;

  const rows = await listQueued(hostId, scope);
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
  // ── THE CHAT LEG (build 6.5 Phase 4) ──────────────────────────────────────
  // Office rows the planner marked `via='chat'` are served HERE, appended to
  // the same array, because the box-side half that texts a person verbatim is
  // this runner — and it never asks what table an id came from. So the whole
  // leg is spine-side: no Box_Setup_Stuff change, no fleet rollout.
  //
  // No groups. A chat message is one row to one person; `ask_group_id` is the
  // nudges table's way of saying "several gaps, one message", and a message
  // that is not about a gap has nothing to group.
  const listChat = deps.listQueuedChat ?? listQueuedOfficeMessagesForHost;
  const chatServe = deps.chatServeCount ?? setOfficeMessageServeCount;
  for (const row of await listChat(hostId, 'chat', scope)) {
    try {
      const tech = row.technicians;
      // The SAME freeze doctrine, and the same liveness re-check at serve
      // time: someone who went inactive or lost their binding between queue
      // and serve is SKIPPED, not failed — a rebind may heal them.
      // Telegram is required here and NOT on the assistant leg, because this
      // is the leg that actually texts a phone.
      if (!tech || isInactiveState(tech.state) || !tech.sandbox_ref || !tech.telegram_user_id) {
        continue;
      }
      if (row.serve_count >= MAX_SERVE_COUNT) {
        console.error(
          `[nudgeQueue] chat message ${row.id} served ${row.serve_count}x with no delivery ` +
            'ack — frozen; see the alarm counters',
        );
        continue;
      }
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        console.error(
          `[nudgeQueue] chat message ${row.id} failed delivery ${row.attempts}x — frozen`,
        );
        continue;
      }
      const served = await chatServe(row.id, row.tenant_id, row.serve_count + 1);
      if (!served) continue; // moved under us
      items.push({
        id: row.id,
        sandboxRef: tech.sandbox_ref,
        replyTo: tech.telegram_user_id,
        // Distinct from a nudge's `nudge-<id>`, though v2 of the runner reads
        // neither — the ids are uuids from different tables and cannot collide.
        sessionId: `chat-${row.id}`,
        // No FOOTER_DELIMITER split: that strip exists for LEGACY nudge rows
        // queued before the footer's retirement, and no office row ever had one.
        directMessageB64: Buffer.from(row.body, 'utf8').toString('base64'),
      });
    } catch (err) {
      console.error(`[nudgeQueue] serve of chat message ${row.id} failed`, err);
    }
  }
  // ── THE PUSH LEG (one-bot phase 2) ────────────────────────────────────────
  // Schedule changes and inbound-call alerts, which used to go out from Render
  // through the one bot token it holds. Sending as a person's OWN assistant
  // needs that assistant's token, and those never reach Render by design — so
  // the send moves here, to the runner that already texts people verbatim
  // through their own seat bot. This is the last thing keeping the board bot
  // alive after the merge.
  //
  // Same freeze doctrine, same serve-time liveness re-check, same ledgers. No
  // groups: a push is one row to one person.
  const listPush = deps.listQueuedPush ?? listQueuedPersonPushesForHost;
  const pushServe = deps.pushServeCount ?? setPersonPushServeCount;
  for (const row of await listPush(hostId, scope)) {
    try {
      const tech = row.technicians;
      if (!tech || isInactiveState(tech.state) || !tech.sandbox_ref || !tech.telegram_user_id) {
        continue; // frozen, not failed — a rebind may heal them
      }
      if (row.serve_count >= MAX_SERVE_COUNT) {
        console.error(
          `[nudgeQueue] push ${row.id} served ${row.serve_count}x with no delivery ack — ` +
            'frozen; see the alarm counters',
        );
        continue;
      }
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        console.error(`[nudgeQueue] push ${row.id} failed delivery ${row.attempts}x — frozen`);
        continue;
      }
      const served = await pushServe(row.id, row.tenant_id, row.serve_count + 1);
      if (!served) continue; // moved under us
      items.push({
        id: row.id,
        sandboxRef: tech.sandbox_ref,
        replyTo: tech.telegram_user_id,
        // Distinct from `nudge-` and `chat-`, though v2 of the runner reads
        // none of them — the ids are uuids from different tables and cannot
        // collide.
        sessionId: `push-${row.id}`,
        // Verbatim: what the spine composed is byte-what-arrives. No footer
        // strip — no push ever had one.
        directMessageB64: Buffer.from(row.body, 'utf8').toString('base64'),
      });
    } catch (err) {
      console.error(`[nudgeQueue] serve of push ${row.id} failed`, err);
    }
  }
  return { nudges: items };
}

// 'delivered' joined in build 6.5 Phase 4: a CHAT office row has no `asked`
// state to move to — it is a message, not a question of record — so its settle
// needs a word of its own rather than borrowing the nudge path's.
export type DeliveryReportResult = 'asked' | 'delivered' | 'retry' | 'failed' | 'ignored';

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
  // Step 3: a glue seat may settle only ITS person's rows. The point-reads are
  // host-scoped, and two glue seats can share a host, so the report is checked
  // against the seat's technician as well.
  scope: QueueScope = {},
): Promise<DeliveryReportResult> {
  const getQueued = deps.getQueued ?? getQueuedNudgeForHost;
  const foreign = (technicianId: string | null): boolean =>
    !!scope.onlyTechnicianId && technicianId !== scope.onlyTechnicianId;
  const asked = deps.asked ?? markNudgeAskedGroup;
  const groupMembers = deps.groupMembers ?? listQueuedNudgesInGroupForHost;
  const attempts = deps.attempts ?? setNudgeDeliveryAttempts;

  const row = await getQueued(id, hostId);
  if (row && foreign(row.technician_id)) return 'ignored';
  if (!row) {
    // ── A CHAT MESSAGE'S REPORT (build 6.5 Phase 4), tried FIRST ────────────
    // The box posts {id, outcome} and never says which table the id came from,
    // so the spine routes it. This must sit ahead of the closed-lead group
    // path below, which returns 'ignored' for any non-delivered report and
    // then swallows the rest — an office id could otherwise never reach a
    // fallback at all, and a `failed` report for a chat row could never bump
    // its attempts, freezing it at MAX_SERVE_COUNT (10) instead of
    // MAX_DELIVERY_ATTEMPTS (3).
    // ── A PUSH'S REPORT (one-bot phase 2), tried first ─────────────────────
    // Same routing problem as the chat leg: the box posts {id, outcome} and
    // never says which table the id came from. Ordering among the three legs is
    // free — the ids are uuids from different tables — but each must sit ahead
    // of the closed-lead group path below, which returns 'ignored' for any
    // non-delivered report and swallows the rest.
    const getPush = deps.getQueuedPush ?? getQueuedPersonPushForHost;
    const push = await getPush(id, hostId);
    if (push && foreign(push.technician_id)) return 'ignored';
    if (push) {
      if (report === 'delivered') {
        const settle = deps.pushDelivered ?? setPersonPushDelivered;
        const moved = await settle(push.id, push.tenant_id);
        return moved ? 'delivered' : 'ignored';
      }
      // FAILED: bump attempts and let the next pull decide. Never a terminal
      // status — a row past its caps FREEZES, staying visible to an operator,
      // rather than disappearing into a status nobody sweeps.
      const bump = deps.pushAttempts ?? setPersonPushAttempts;
      const moved = await bump(push.id, push.tenant_id, push.attempts + 1, detail);
      if (!moved) return 'ignored';
      return push.attempts + 1 >= MAX_DELIVERY_ATTEMPTS ? 'failed' : 'retry';
    }

    const getChat = deps.getQueuedChat ?? getQueuedOfficeMessageForHost;
    const chat = await getChat(id, hostId);
    if (chat && foreign(chat.technician_id)) return 'ignored';
    if (chat) {
      if (report === 'delivered') {
        const settle = deps.chatDelivery ?? setOfficeMessageDelivery;
        const moved = await settle(
          chat.id,
          chat.tenant_id,
          { status: 'delivered', deliveredAt: new Date().toISOString() },
          ['queued'],
        );
        return moved ? 'delivered' : 'ignored';
      }
      // FAILED: bump attempts and let the next pull decide. Never a terminal
      // 'failed' status — the broken-pipe doctrine is that a row past its caps
      // FREEZES, staying visible to the operators, rather than disappearing
      // into a status nobody sweeps.
      const bump = deps.chatAttempts ?? setOfficeMessageAttempts;
      const moved = await bump(chat.id, chat.tenant_id, chat.attempts + 1);
      if (!moved) return 'ignored';
      return chat.attempts + 1 >= MAX_DELIVERY_ATTEMPTS ? 'failed' : 'retry';
    }

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
    if (survivors.some((m) => foreign(m.technician_id))) return 'ignored';
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
