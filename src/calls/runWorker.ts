import { processNextCall } from './worker.js';

// Long-running drain loop for the call_ingest queue (`npm run calls:worker`).
// Durable queue → safe across stateless replicas and restarts: each iteration
// claims at most one row (SKIP LOCKED), so N workers share the load without
// double-processing. Idle backoff keeps an empty queue from spinning.
const IDLE_BACKOFF_MS = 5000;
const BUSY_BACKOFF_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  for (;;) {
    let outcome: 'idle' | 'ingested' | 'error';
    try {
      outcome = await processNextCall();
    } catch (err) {
      // processNextCall already isolates per-row failures via markCallError; an
      // error here is the claim/infra layer itself — log and back off, don't die.
      console.error('[calls:worker] loop error', err);
      outcome = 'error';
    }
    await delay(outcome === 'idle' ? IDLE_BACKOFF_MS : BUSY_BACKOFF_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
