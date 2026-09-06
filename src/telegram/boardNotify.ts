import {
  getVisitForTenant,
  getTechnicianById,
  listParticipants,
  isInactiveState,
  latestScheduleVersion,
  listScheduleEventsSince,
  listTenantIdsWithTelegramBindings,
  type Visit,
  type ScheduleEvent,
  type Technician,
} from '../db/index.js';
import { sendBoardMessage } from './boardBot.js';

// Turns the append-only schedule_events feed into canned Telegram pushes so a
// person learns their day changed without opening anything. Plain code, no AI:
// fixed copy per event kind, naive-local dates/times printed verbatim.
// Bursts collapse: a recipient owed more than DIGEST_THRESHOLD messages in one
// poll tick gets ONE digest instead (a freeze commit would otherwise machine-
// gun each technician with a push per placed visit).
//
// Two nobody-on-it realities (Feature A):
//  - a visit can have NO participants (unassigned booking/move) — there is
//    nobody to notify for that side; skip cleanly, never crash.
//  - a `moved` event hangs off the visit itself (rung 9b: a move EDITS the row,
//    so there is no "new row"), and a reassignment must ALSO notify the people
//    it was taken FROM: detail.previousTechnicianIds names them directly, since
//    the row no longer remembers who held it a moment ago.
//
// Rung 9c: a trip can carry a CREW, so every one of these is a loop. Both
// people on a two-person visit hear it moved; a reassignment tells the joiner
// and the leaver separately, and somebody on both sides hears it once.

interface Push {
  userId: string;
  text: string;
}

// A recipient getting more than this many messages in one poll tick has hit a
// burst (a freeze commit, a manager's rapid board edits) — collapse the run of
// singles into ONE digest message. At or below it, singles stay instant and
// personal.
const DIGEST_THRESHOLD = 3;
// Digest bullet cap: keeps a big freeze readable on a phone and the message
// safely under Telegram's 4096-char sendMessage limit.
const DIGEST_MAX_LINES = 12;

// One combined message for a recipient's burst. Reuses each single push's
// sentence as a bullet, so the copy has exactly one home above.
function digestText(pushes: Push[]): string {
  const lines = pushes.slice(0, DIGEST_MAX_LINES).map((p) => `• ${p.text}`);
  const more = pushes.length - DIGEST_MAX_LINES;
  if (more > 0) lines.push(`…and ${more} more — open the board for the full list.`);
  // ONE header now. The batch runs that used to name themselves here
  // (`freezeRun` / `resolveRun` stamps) died with the solver, rung 8 — every
  // burst is manual edits, and the count is a claim about this batch only.
  const header = `Your schedule changed — ${pushes.length} updates:`;
  return [header, ...lines].join('\n');
}

// A push must never render 'undefined–undefined' at a technician. An UNTIMED
// visit (rung 9a) has neither a day nor times, so `when` collapses to one
// honest phrase instead of pairing two placeholders.
const day = (row: Visit): string => row.starts_at?.slice(0, 10) ?? 'no date yet';
const span = (row: Visit): string =>
  row.starts_at && row.ends_at
    ? `${row.starts_at.slice(11, 16)}–${row.ends_at.slice(11, 16)}`
    : 'time not set';
// "2026-10-20, 09:00–10:00" for a placed visit; "no time set yet" when there
// is nothing to say.
const when = (row: Visit): string =>
  row.starts_at ? `${day(row)}, ${span(row)}` : 'no time set yet';

const detailStr = (detail: Record<string, unknown>, key: string): string | null =>
  typeof detail[key] === 'string' ? (detail[key] as string) : null;

// ONE definition of "a person we may still message", by id. Both callers go
// through it: the visit's current holder, and — since rung 9b, where a move
// edits the row instead of replacing it — the previous holder named on the
// event. Resolving the previous one directly with getTechnicianById would skip
// the liveness filter below, which is exactly how an offboarded person's phone
// keeps receiving schedule details.
async function liveTechnician(
  technicianId: string | null | undefined,
  tenantId: string,
): Promise<Technician | null> {
  if (!technicianId) return null; // unassigned — nobody to notify
  const tech = await getTechnicianById(technicianId, tenantId);
  // Deactivation revokes the badge and board access but does NOT clear
  // telegram_user_id — the liveness filter every other Telegram surface
  // applies must hold here too, or offboarding a person (and reassigning
  // their visits, the standard next step) pushes schedule details to a
  // revoked ex-employee's phone.
  return tech && !isInactiveState(tech.state) ? tech : null;
}

// EVERY person on the trip, live-filtered (rung 9c). A crew visit is one trip
// and two people, and both of them need telling — before this, only whoever
// held the visit's single column ever heard anything.
async function liveParticipants(row: Visit | null, tenantId: string): Promise<Technician[]> {
  if (!row) return [];
  const out: Technician[] = [];
  for (const p of await listParticipants(row.id)) {
    const t = await liveTechnician(p.technician_id, tenantId);
    if (t) out.push(t);
  }
  return out;
}

// The people named on a `moved` event as holding the visit BEFORE it moved.
// Three vintages, newest first: the rung-9c list, the rung-9b single id, and
// the pre-9b predecessor ROW. schedule_events is append-only, so all three are
// permanent and each fallback is load-bearing — without them the person who
// LOST a visit silently stops being told.
async function previousHolders(
  detail: Record<string, unknown>,
  tenantId: string,
): Promise<Technician[]> {
  const ids = detail.previousTechnicianIds;
  if (Array.isArray(ids)) {
    const out: Technician[] = [];
    for (const id of ids) {
      const t = typeof id === 'string' ? await liveTechnician(id, tenantId) : null;
      if (t) out.push(t);
    }
    return out;
  }
  const single = detailStr(detail, 'previousTechnicianId');
  if (single) {
    const t = await liveTechnician(single, tenantId);
    return t ? [t] : [];
  }
  const prevRowId = detailStr(detail, 'previousAssignmentId');
  const oldRow = prevRowId ? await getVisitForTenant(prevRowId, tenantId) : null;
  return liveParticipants(oldRow, tenantId);
}

// The pushes one event produces. Best-effort resolution: a vanished row or an
// unbound person simply yields fewer pushes, never an error.
async function pushesFor(tenantId: string, ev: ScheduleEvent): Promise<Push[]> {
  const detail = (ev.detail ?? {}) as Record<string, unknown>;
  const row = ev.assignment_id ? await getVisitForTenant(ev.assignment_id, tenantId) : null;
  const crew = await liveParticipants(row, tenantId);
  const out: Push[] = [];

  switch (ev.kind) {
    case 'booked': {
      for (const tech of crew) {
        if (tech.telegram_user_id && row) {
          out.push({
            userId: tech.telegram_user_id,
            text: `New visit on your schedule: ${when(row)}.`,
          });
        }
      }
      break;
    }
    case 'moved': {
      const fromDay = detailStr(detail, 'fromDay') ?? '?';
      const toDay = detailStr(detail, 'toDay') ?? (row ? day(row) : '?');
      // Rung 9b: a move EDITS the visit, so there is no predecessor row to
      // fetch — `row` IS the moved visit, before and after. What the push needs
      // is who HELD it, which the event carries directly.
      const before = await previousHolders(detail, tenantId);
      const beforeIds = new Set(before.map((t) => t.id));
      const afterIds = new Set(crew.map((t) => t.id));
      // Three populations, one message each. Somebody on BOTH sides gets one
      // "your visit moved", never an add plus a remove; somebody only on the
      // new side is a joiner; somebody only on the old side lost it.
      for (const tech of crew) {
        if (!tech.telegram_user_id || !row) continue;
        out.push({
          userId: tech.telegram_user_id,
          text: beforeIds.has(tech.id)
            ? `Your visit moved: ${fromDay} → ${row.starts_at ? `${toDay}, now ${span(row)}` : 'no time set yet'}.`
            : `A visit landed on your schedule: ${when(row)}.`,
        });
      }
      for (const tech of before) {
        if (!tech.telegram_user_id || afterIds.has(tech.id)) continue;
        out.push({
          userId: tech.telegram_user_id,
          text: `Your ${fromDay} visit was moved off your schedule.`,
        });
      }
      break;
    }
    case 'cancelled': {
      const cancelledDay = detailStr(detail, 'day') ?? (row ? day(row) : 'upcoming');
      for (const tech of crew) {
        if (!tech.telegram_user_id) continue;
        out.push({
          userId: tech.telegram_user_id,
          text: `Your ${cancelledDay} visit was cancelled.`,
        });
      }
      break;
    }
    case 'move_failed': {
      // The event hangs off the OLD row (booking.ts) — everyone on it should
      // hear that the visit is stranded.
      const toDay = detailStr(detail, 'toDay') ?? 'a new day';
      for (const tech of crew) {
        if (!tech.telegram_user_id) continue;
        out.push({
          userId: tech.telegram_user_id,
          text: `A reschedule of your visit (to ${toDay}) failed — it is currently UNSCHEDULED; check the board.`,
        });
      }
      break;
    }
    // completed/backfilled and future kinds: no push.
  }
  return out;
}

// One poll pass over every tenant with live Telegram bindings. `lastSeen` is
// the caller's in-memory per-tenant cursor; a tenant seen for the FIRST time
// is seeded at its current version (notify only about post-boot events — the
// documented v1 restart limitation). Returns how many messages went out.
export async function pollOnce(lastSeen: Map<string, number>): Promise<number> {
  let sent = 0;
  for (const tenantId of await listTenantIdsWithTelegramBindings()) {
    let after = lastSeen.get(tenantId);
    if (after === undefined) {
      after = await latestScheduleVersion(tenantId);
      lastSeen.set(tenantId, after);
    }
    // Resolve first, send second: the whole tick's pushes are collected before
    // anything goes out, so a burst aimed at one person (a freeze commit, a
    // manager's rapid edits) can collapse into a single digest below.
    const collected: Push[] = [];
    let advanceTo = after;
    for (const ev of await listScheduleEventsSince(tenantId, after)) {
      try {
        collected.push(...(await pushesFor(tenantId, ev)));
      } catch (err) {
        // RESOLUTION failure ≠ poison event: a transient DB fault while
        // resolving rows must NOT advance the cursor (that would drop the
        // notification forever — in-memory cursor, no replay). Stop collecting
        // here — everything resolved so far still sends and advances — and
        // retry the SAME cursor next tick; reads are idempotent and ordered
        // delivery is preserved. Only SEND failures (below) advance past —
        // that's the real poison-message risk.
        console.error(`board notify: resolving event ${ev.id} failed (will retry):`, err);
        break;
      }
      // Advance PAST the event even if its sends fail below: a poison event
      // must not wedge the cursor into an infinite resend loop.
      advanceTo = Number(ev.id);
    }

    const byUser = new Map<string, Push[]>();
    for (const p of collected) {
      const list = byUser.get(p.userId);
      if (list) list.push(p);
      else byUser.set(p.userId, [p]);
    }
    for (const [userId, pushes] of byUser) {
      const texts =
        pushes.length > DIGEST_THRESHOLD ? [digestText(pushes)] : pushes.map((p) => p.text);
      for (const text of texts) {
        try {
          await sendBoardMessage(userId, text);
          sent++;
        } catch (err) {
          // Best-effort per message — one blocked bot never stalls the rest.
          // Conscious v1 trade: a digest is ONE send, so one failure here
          // loses the whole burst's notifications (vs one message before) —
          // same no-replay posture as the in-memory cursor; the board remains
          // the source of truth.
          console.error(`board notify: send to user ${userId} failed:`, err);
        }
      }
    }
    if (advanceTo !== after) lastSeen.set(tenantId, advanceTo);
  }
  return sent;
}
