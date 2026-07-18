import { fileURLToPath } from 'node:url';
import { setBoardMenuButton } from './boardBot.js';

// The board worker — a SEPARATE long-lived process (`npm run board:worker`,
// Render Background Worker), not folded into the web server: the web tier
// stays stateless (Architecture A) and a future >1-replica web tier can't
// double-send notifications. Phase 3: set the launch button once at startup.
// Phase 4 adds the schedule_events poll loop after it.

export async function startBoardWorker(): Promise<void> {
  await setBoardMenuButton();
  console.error('board worker: menu button set — board launchable from every started chat');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startBoardWorker().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
