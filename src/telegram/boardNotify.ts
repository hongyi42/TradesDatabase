import {
  getAssignmentForTenant,
  getTechnicianById,
  isInactiveState,
  latestScheduleVersion,
  listManagersWithTelegram,
  listScheduleEventsSince,
  listTenantIdsWithTelegramBindings,
  type Assignment,
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
// Two null-technician realities (Feature A):
//  - assignment.technician_id can be NULL (unassigned booking/move) — there is
//    nobody to notify for that side; skip cleanly, never crash.
//  - a `moved` event hangs off the NEW row, so a reassignment must ALSO notify
//    the person the visit was taken FROM: detail.previousAssignmentId points at
//    the old (cancelled) row, which still holds the old technician_id.

interface Push {
  userId: string;
  text: string;
  // Set when the source event was stamped by a batch run (freezeCommit stamps
  // `freezeRun`, resolveCommit stamps `resolveRun`) — lets a burst digest say
  // WHY the schedule just changed. Undo runs (`undoRun`) stay unkinded on
  // purpose: their bursts read fine under the generic header.
  runStamp?: string;
  runKind?: 'freeze' | 'resolve';
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
  // Name the run only when EVERY line came from the same one — a mixed burst
  // (run + a manual edit that raced in) keeps the generic header rather than
  // mis-attributing the manual change. No count in the run headers: a slow
  // commit can straddle two poll ticks, so this batch's count is NOT
  // necessarily "what the run did" — the bullets speak for themselves. The
  // generic header's count is a claim about the batch only, so it stays.
  const stamp = pushes[0]?.runStamp;
  const kind = pushes[0]?.runKind;
  const uniform =
    stamp !== undefined && pushes.every((p) => p.runStamp === stamp && p.runKind === kind);
  const header =
    uniform && kind === 'freeze'
      ? 'The schedule freeze updated your schedule:'
      : uniform && kind === 'resolve'
        ? 'The schedule re-plan updated your schedule:'
        : `Your schedule changed — ${pushes.length} updates:`;
  return [header, ...lines].join('\n');
}

// Unplaced rows (plan 4b-2) have a day range and no times — a push must say
// so, never render 'undefined–undefined'.
const day = (row: Assignment): string => row.starts_at?.slice(0, 10) ?? row.earliest_date ?? '?';
const span = (row: Assignment): string =>
  row.starts_at && row.ends_at
    ? `${row.starts_at.slice(11, 16)}–${row.ends_at.slice(11, 16)}`
    : 'time not set';

const detailStr = (detail: Record<string, unknown>, key: string): string | null =>
  typeof detail[key] === 'string' ? (detail[key] as string) : null;

async function technicianOf(
  row: Assignment | null,
  tenantId: string,
): Promise<Technician | null> {
  if (!row?.technician_id) return null; // unassigned — nobody to notify
  const tech = await getTechnicianById(row.technician_id, tenantId);
  // Deactivation revokes the badge and board access but does NOT clear
  // telegram_user_id — the liveness filter every other Telegram surface
  // applies must hold here too, or offboarding a person (and reassigning
  // their visits, the standard next step) pushes schedule details to a
  // revoked ex-employee's phone.
  return tech && !isInactiveState(tech.state) ? tech : null;
}

// The pushes one event produces. Best-effort resolution: a vanished row or an
// unbound person simply yields fewer pushes, never an error.
async function pushesFor(tenantId: string, ev: ScheduleEvent): Promise<Push[]> {
  const detail = (ev.detail ?? {}) as Record<string, unknown>;
  const row = ev.assignment_id ? await getAssignmentForTenant(ev.assignment_id, tenantId) : null;
  const tech = await technicianOf(row, tenantId);
  const out: Push[] = [];

  switch (ev.kind) {
    case 'booked': {
      if (tech?.telegram_user_id && row) {
        out.push({
          userId: tech.telegram_user_id,
          text: `New visit on your schedule: ${day(row)}, ${span(row)}.`,
        });
      }
      break;
    }
    case 'moved': {
      const fromDay = detailStr(detail, 'fromDay') ?? '?';
      const toDay = detailStr(detail, 'toDay') ?? (row ? day(row) : '?');
      const prevId = detailStr(detail, 'previousAssignmentId');
      const oldRow = prevId ? await getAssignmentForTenant(prevId, tenantId) : null;
      const oldTech = await technicianOf(oldRow, tenantId);
      if (tech && oldTech && tech.id === oldTech.id) {
        // Same person, different slot — one message, not an add + a remove.
        if (tech.telegram_user_id && row) {
          out.push({
            userId: tech.telegram_user_id,
            text: `Your visit moved: ${fromDay} → ${toDay}, now ${span(row)}.`,
          });
        }
        break;
      }
      if (tech?.telegram_user_id && row) {
        out.push({
          userId: tech.telegram_user_id,
          text: `A visit landed on your schedule: ${toDay}, ${span(row)}.`,
        });
      }
      if (oldTech?.telegram_user_id) {
        out.push({
          userId: oldTech.telegram_user_id,
          text: `Your ${fromDay} visit was moved off your schedule.`,
        });
      }
      break;
    }
    case 'cancelled': {
      if (tech?.telegram_user_id) {
        const cancelledDay = detailStr(detail, 'day') ?? (row ? day(row) : 'upcoming');
        out.push({
          userId: tech.telegram_user_id,
          text: `Your ${cancelledDay} visit was cancelled.`,
        });
      }
      break;
    }
    case 'move_failed': {
      // The event hangs off the OLD row (booking.ts) — its person should hear
      // that the visit is stranded.
      if (tech?.telegram_user_id) {
        const toDay = detailStr(detail, 'toDay') ?? 'a new day';
        out.push({
          userId: tech.telegram_user_id,
          text: `A reschedule of your visit (to ${toDay}) failed — it is currently UNSCHEDULED; check the board.`,
        });
      }
      break;
    }
    case 'freeze_committed': {
      // The run summary goes to MANAGERS (plan 4b-3) — the first
      // manager-directed push: in a multi-manager firm, everyone hears what a
      // colleague committed. Technicians hear nothing extra here: each
      // committed row already produced its own booked/moved push above.
      const placed = typeof detail.placed === 'number' ? detail.placed : '?';
      const skipped = typeof detail.skipped === 'number' ? detail.skipped : '?';
      for (const m of await listManagersWithTelegram(tenantId)) {
        if (!m.telegram_user_id) continue;
        out.push({
          userId: m.telegram_user_id,
          text: `Freeze ran (by ${ev.actor_ref ?? 'a manager'}): placed ${placed}, skipped ${skipped} — see the board.`,
        });
      }
      break;
    }
    case 'resolve_committed': {
      // Same manager-directed summary for a re-solve run (plan 2026-07-30):
      // each moved/placed row already pushed the affected technician above.
      const moved = typeof detail.moved === 'number' ? detail.moved : '?';
      const placed = typeof detail.placed === 'number' ? detail.placed : '?';
      const kept = typeof detail.kept === 'number' ? detail.kept : '?';
      for (const m of await listManagersWithTelegram(tenantId)) {
        if (!m.telegram_user_id) continue;
        out.push({
          userId: m.telegram_user_id,
          text: `Re-solve ran (by ${ev.actor_ref ?? 'a manager'}): moved ${moved}, placed ${placed}, kept ${kept} — see the board.`,
        });
      }
      break;
    }
    case 'undo_committed': {
      // The undo's manager summary (plan 2026-07-30 Phase 5). Its per-row
      // events stay unkinded on purpose (no undoRun header), so technicians
      // see them under the generic digest header.
      const restored = typeof detail.restored === 'number' ? detail.restored : '?';
      const skipped = typeof detail.skipped === 'number' ? detail.skipped : '?';
      for (const m of await listManagersWithTelegram(tenantId)) {
        if (!m.telegram_user_id) continue;
        out.push({
          userId: m.telegram_user_id,
          text: `Undo ran (by ${ev.actor_ref ?? 'a manager'}): restored ${restored}, skipped ${skipped} — see the board.`,
        });
      }
      break;
    }
    // completed/backfilled and future kinds: no push.
  }
  const freezeRun = detailStr(detail, 'freezeRun');
  const resolveRun = detailStr(detail, 'resolveRun');
  const stamp = freezeRun ?? resolveRun;
  if (!stamp) return out;
  const kind = freezeRun !== null ? ('freeze' as const) : ('resolve' as const);
  return out.map((p) => ({ ...p, runStamp: stamp, runKind: kind }));
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
