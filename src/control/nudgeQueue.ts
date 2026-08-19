import {
  flagOverdueVisitGap,
  getQueuedNudgeForHost,
  isInactiveState,
  listQueuedNudgesForHost,
  markNudgeAsked,
  markNudgeOutcome,
  setNudgeDeliveryAttempts,
  setNudgeServeCount,
} from '../db/index.js';
import { handToManager, readComposeContext } from '../teamLead/compose.js';

// The voice's transport, spine side (plan 2026-08-15 feature B, Phase 4).
// The spine NEVER reaches into the agent box — the box already phones home
// every 5 minutes for badges, and queued nudges ride the same posture: served
// on a host-token pull until the box ACKS delivery, so a lost tick self-heals
// (the retirements precedent). The box-side half is
// Box_Setup_Stuff/nudge-runner.sh.
//
// Terminal-failure doctrine (Phase-3 review F1, extended here): ANY path that
// fails a nudge without the ask ever landing hands the gap to the manager
// first — an undeliverable question must not orphan the gap it was written
// for.

// A nudge served more than this many times without an ack is POISON — some
// box-side fault re-serves it forever, and it must stop re-alarming (the
// PARKED analog). It hands to the manager and fails instead of serving.
export const MAX_SERVE_COUNT = 10;
// Explicit delivery-failure reports before giving up. attempts was reset to 0
// at queue time, so the delivery ledger is its own (see markNudgeQueued).
export const MAX_DELIVERY_ATTEMPTS = 3;

// One deliverable, exactly what the runner needs and nothing else. messageB64
// keeps the multi-line deliverable shell-safe on the box (badge-pull's
// argument discipline); sessionId pins a FRESH session per nudge (decision
// D6 — id reuse resumes stale conversations).
export interface NudgeDeliveryItem {
  id: string;
  sandboxRef: string;
  replyTo: string; // the technician's telegram user id
  sessionId: string;
  messageB64: string;
}

export interface NudgeQueueDeps {
  listQueued?: typeof listQueuedNudgesForHost;
  getQueued?: typeof getQueuedNudgeForHost;
  serveCount?: typeof setNudgeServeCount;
  asked?: typeof markNudgeAsked;
  outcome?: typeof markNudgeOutcome;
  attempts?: typeof setNudgeDeliveryAttempts;
  flagGap?: typeof flagOverdueVisitGap;
}

// Build one pull's worth of deliveries for a host. Liveness is RE-FILTERED at
// serve time (constraints 19-20): a technician who went inactive or lost
// their sandbox between queue and serve is SKIPPED, not failed — a rebind may
// heal them, and the escalation sweep (48h from asked) never starts because
// the row never reaches 'asked'; the 10-serve cap is what finally moves a
// never-deliverable row to the manager.
export async function buildNudgeDelivery(
  hostId: string,
  deps: NudgeQueueDeps = {},
): Promise<{ nudges: NudgeDeliveryItem[] }> {
  const listQueued = deps.listQueued ?? listQueuedNudgesForHost;
  const serveCount = deps.serveCount ?? setNudgeServeCount;
  const outcome = deps.outcome ?? markNudgeOutcome;
  const flagGap = deps.flagGap ?? flagOverdueVisitGap;

  const rows = await listQueued(hostId);
  const items: NudgeDeliveryItem[] = [];
  for (const row of rows) {
    try {
      const tech = row.technicians;
      if (!tech || isInactiveState(tech.state) || !tech.sandbox_ref || !tech.telegram_user_id) {
        continue; // frozen, not failed — see the liveness note above
      }
      if (!row.question) continue; // queued implies composed; tampered row stays frozen
      if (row.serve_count >= MAX_SERVE_COUNT) {
        // NOT gated on the handoff landing — see the note in compose.ts's
        // decline path. Freezing here removes the only terminal exit a queued
        // row has: it is never re-served (this branch never reaches `items`)
        // but stays 'queued' forever, so every 5-minute pull re-reads it and
        // logs. Phase 4 gates this once the flagger can tell "already flagged"
        // from "flag failed".
        await handToManager(row, readComposeContext(row), flagGap);
        await outcome(
          row.id,
          row.tenant_id,
          'failed',
          `undeliverable: served ${row.serve_count}x with no delivery ack`,
        );
        continue;
      }
      // Count the serve BEFORE shipping it (at-most-N-serves, even if this
      // response is lost). null = the row moved under us — drop it.
      const served = await serveCount(row.id, row.tenant_id, row.serve_count + 1);
      if (!served) continue;
      items.push({
        id: row.id,
        sandboxRef: tech.sandbox_ref,
        replyTo: tech.telegram_user_id,
        sessionId: `nudge-${row.id}`,
        messageB64: Buffer.from(row.question, 'utf8').toString('base64'),
      });
    } catch (err) {
      // One poisoned row never blocks the host's other deliveries.
      console.error(`[nudgeQueue] serve of ${row.id} failed`, err);
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
  const asked = deps.asked ?? markNudgeAsked;
  const outcome = deps.outcome ?? markNudgeOutcome;
  const attempts = deps.attempts ?? setNudgeDeliveryAttempts;
  const flagGap = deps.flagGap ?? flagOverdueVisitGap;

  const row = await getQueued(id, hostId);
  if (!row) return 'ignored'; // unknown id, wrong host, or already moved

  if (report === 'delivered') {
    const moved = await asked(row.id, row.tenant_id);
    return moved ? 'asked' : 'ignored';
  }

  const next = row.attempts + 1;
  const bumped = await attempts(row.id, row.tenant_id, next);
  if (!bumped) return 'ignored';
  if (next < MAX_DELIVERY_ATTEMPTS) return 'retry'; // still served next pull
  // Delivery gave up: the manager takes the gap, then the row goes terminal
  // (flag-first, the F1 order). Ungated for the same reason as the serve cap
  // above — Phase 4 owns it.
  await handToManager(row, readComposeContext(row), flagGap);
  await outcome(
    row.id,
    row.tenant_id,
    'failed',
    `delivery failed ${next}x${detail ? `: ${detail.slice(0, 300)}` : ''}`,
  );
  return 'failed';
}
