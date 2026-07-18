import { fileURLToPath } from 'node:url';
import { setBoardMenuButton } from './boardBot.js';
import { pollOnce } from './boardNotify.js';

// The board worker — a SEPARATE long-lived process (`npm run board:worker`,
// Render Background Worker), not folded into the web server: the web tier
// stays stateless (Architecture A) and a future >1-replica web tier can't
// double-send notifications. Startup sets the launch button once, then the
// process loops the schedule_events poll forever. The last-seen cursor lives
// in memory ONLY: a restart re-seeds at current versions, so events during
// downtime are skipped — the documented v1 trade for having no new table.

export async function startBoardWorker(): Promise<void> {
  await setBoardMenuButton();
  console.error('board worker: menu button set — board launchable from every started chat');
  // Garbage/empty BOARD_POLL_MS must not become setTimeout(0) — a Render env
  // typo would otherwise turn the 30s poll into a hot loop against the DB.
  const rawMs = Number(process.env.BOARD_POLL_MS);
  const intervalMs = Number.isFinite(rawMs) && rawMs > 0 ? rawMs : 30_000;
  const lastSeen = new Map<string, number>();
  for (;;) {
    try {
      const sent = await pollOnce(lastSeen);
      if (sent > 0) console.error(`board worker: sent ${sent} notification(s)`);
    } catch (err) {
      // Never fatal — the next tick retries from the same cursors.
      console.error('board worker: poll failed (will retry):', err);
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
