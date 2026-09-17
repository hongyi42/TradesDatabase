import { fileURLToPath } from 'node:url';
import { recordHeartbeat } from '../db/workerHeartbeats.js';
import { pollOnce } from './boardNotify.js';

// The board worker — a SEPARATE long-lived process (`npm run board:worker`,
// Render Background Worker), not folded into the web server: the web tier
// stays stateless (Architecture A) and a future >1-replica web tier can't
// double-send notifications. The process loops the schedule_events poll
// forever. The last-seen cursor lives in memory ONLY: a restart re-seeds at
// current versions, so events during downtime are skipped — the documented v1
// trade for having no new table.
//
// IT NO LONGER TOUCHES A MENU BUTTON (2026-09-17). Startup used to call
// setBoardMenuButton() before anything else, from when the board bot was the
// way in. Every seat now carries its own Schedule button, applied on the box by
// seat-sync.sh with that seat's own token — the only place those tokens exist.
// Leaving the call here would have made deleting @DashboardMan_bot fatal to
// THIS process: the Bot API would answer 401, the unguarded await would throw,
// and the entry point below exits 1 on a rejection — so the bot that no longer
// sends anything would still have taken schedule notifications down with it on
// its way out. The poll is this worker's whole job.

export async function startBoardWorker(): Promise<void> {
  // Garbage/empty BOARD_POLL_MS must not become setTimeout(0) — a Render env
  // typo would otherwise turn the 30s poll into a hot loop against the DB.
  const rawMs = Number(process.env.BOARD_POLL_MS);
  const intervalMs = Number.isFinite(rawMs) && rawMs > 0 ? rawMs : 30_000;
  const lastSeen = new Map<string, number>();
  let cycles = 0;
  for (;;) {
    // `ok` exists because the catch below is a SILENT failure mode: a poll that
    // throws every tick leaves this process up, this loop spinning, and
    // notifications stopped, with the only evidence on a stderr stream nobody
    // reads. "The loop cycled" and "the cycle worked" are different facts, and
    // reporting only the first would call that outage healthy.
    let ok = false;
    let sent = 0;
    try {
      sent = await pollOnce(lastSeen);
      ok = true;
      if (sent > 0) console.error(`board worker: sent ${sent} notification(s)`);
    } catch (err) {
      // Never fatal — the next tick retries from the same cursors.
      console.error('board worker: poll failed (will retry):', err);
    }
    cycles++;
    // Best effort, and it must stay that way: a monitoring write may never break
    // the thing it measures. If these stop landing, the row goes stale and the
    // monitor raises it, so a failure here is already covered — see
    // monitoring.health in supabase/migrations/20260827220000_worker_heartbeats.
    try {
      await recordHeartbeat({
        service: 'board-worker',
        ok,
        didWork: sent > 0,
        detail: { sent, cycles, intervalMs },
      });
    } catch (err) {
      console.error('board worker: heartbeat write failed (non-fatal):', err);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startBoardWorker().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
