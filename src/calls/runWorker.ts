import { processNextCall } from './worker.js';
import { drainOneObservationPing } from './observationPing.js';

// Long-running drain loop for the call_ingest queue (`npm run calls:worker`).
// Durable queue → safe across stateless replicas and restarts: each iteration
// claims at most one row (SKIP LOCKED), so N workers share the load without
// double-processing. Idle backoff keeps an empty queue from spinning.
const IDLE_BACKOFF_MS = 5000;
const BUSY_BACKOFF_MS = 250;
// The ping loop's own idle backoff (rung 10). Longer than the call loop's,
// because an empty observation queue is the normal state and this poll is a
// fleet-wide indexed read rather than a per-tenant one. ~10s is the promise the
// rung makes: a manager hears about a committed call within seconds, not on the
// half hour.
const PING_IDLE_BACKOFF_MS = 10_000;
// A focused pass just ran (or failed). Come straight back for the next row —
// the queue is arrival-ordered and a firm may have had two calls at once.
const PING_BUSY_BACKOFF_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callLoop(): Promise<void> {
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

async function pingLoop(): Promise<void> {
  for (;;) {
    let outcome: 'idle' | 'pinged' | 'error';
    try {
      outcome = await drainOneObservationPing();
    } catch (err) {
      // drainOneObservationPing swallows its own per-row failures; reaching
      // here means the claim/infra layer itself — log and back off, don't die.
      console.error('[calls:ping] loop error', err);
      outcome = 'error';
    }
    await delay(outcome === 'idle' ? PING_IDLE_BACKOFF_MS : PING_BUSY_BACKOFF_MS);
  }
}

// TWO INDEPENDENT LOOPS, each with its own backoff — never one loop doing both.
// A single loop would make a three-minute focused pass block the call drain
// behind it, and an empty call queue's 5s sleep would pace the pings. Neither
// promise resolves, so `Promise.all` here is "run both forever"; if either
// throws out of its own `for(;;)` the process exits non-zero and Render
// restarts it, which is the intended failure mode.
async function main(): Promise<void> {
  await Promise.all([callLoop(), pingLoop()]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
