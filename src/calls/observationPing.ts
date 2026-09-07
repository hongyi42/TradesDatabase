import {
  PINGED_KINDS,
  claimObservationPing,
  listUnpingedObservations,
  type Observation,
} from '../db/index.js';
import { focusedPassBlockedBy, runFocusedObservationPass } from '../jobs/plannerPass.js';

// THE PING LOOP (rung 10) — the planner, called about ONE call, within seconds.
//
// WHY IT LIVES IN THE CALLS-WORKER. That process is the only always-on one we
// have: the web service is on Render's free plan and spins down, and the
// heartbeat is a cron that fires at :00 and :30. A customer told "someone will
// come out" should not wait up to half an hour for anyone at the firm to hear
// about it. The worker already loops; this is a second, independent loop beside
// the call drain.
//
// Rejected alternatives, recorded so they are not re-proposed: running the pass
// in-request from the inbound webhook (a model call inside a connector's
// delivery timeout, retried by the connector on every timeout), and Render's
// trigger-run API (a broad deploy key held by an internet-facing service).
export interface ObservationPingDeps {
  list?: typeof listUnpingedObservations;
  claim?: typeof claimObservationPing;
  pass?: (observation: Observation) => Promise<unknown>;
  blocked?: typeof focusedPassBlockedBy;
}

// One line per REASON, not one per poll: this loop runs every 10 seconds, and
// a misconfigured worker would otherwise write 8,640 identical lines a day.
let lastBlockedReason: string | null = null;

/**
 * Claim at most ONE unpinged inbound observation and run a focused pass for it.
 *
 * Returns 'idle' when there was nothing to do, so the caller can back off.
 */
export async function drainOneObservationPing(
  deps: ObservationPingDeps = {},
): Promise<'idle' | 'pinged' | 'error'> {
  const list = deps.list ?? listUnpingedObservations;
  const claim = deps.claim ?? claimObservationPing;
  const pass = deps.pass ?? runFocusedObservationPass;
  const blocked = (deps.blocked ?? focusedPassBlockedBy)();
  // BEFORE THE CLAIM, ALWAYS. Claiming stamps `pinged_at` and nothing releases
  // a claim, so a loop that claimed and then discovered it could not run would
  // mark calls "the planner was called about this" while calling nobody — and
  // both fast-path readers require `pinged_at is null`, so those rows would be
  // downgraded to the half-hourly cadence permanently. A worker deployed before
  // its env lands is exactly that case.
  if (blocked) {
    if (blocked !== lastBlockedReason) {
      console.warn(`[calls:ping] not running focused passes — ${blocked}`);
      lastBlockedReason = blocked;
    }
    return 'idle';
  }
  lastBlockedReason = null;
  try {
    // ONE AT A TIME, oldest first. A batch would hold the loop for minutes on a
    // busy firm while later calls waited behind it; one row per iteration keeps
    // the queue moving in arrival order.
    const [next] = await list(PINGED_KINDS, 1);
    if (!next) return 'idle';
    // THE CLAIM IS THE EXCLUSION. Guarded on `pinged_at is null`, so two
    // workers racing this row converge: the loser gets null and takes the next
    // iteration. Null is "somebody else has it", never an error.
    const claimed = await claim(next.id);
    if (!claimed) return 'idle';
    await pass(claimed);
    return 'pinged';
  } catch (err) {
    // NEVER RETHROWN, and THE CLAIM STAYS. Rethrowing would kill the worker's
    // ping loop on one firm's bad row; releasing the claim would re-run a pass
    // that may already have texted a manager. The half-hourly heartbeat is the
    // fallback for a row whose pass died — it shows the row again, and the ask
    // marker (not the ping marker) is what stops a second text.
    console.error('[calls:ping] focused pass failed', err);
    return 'error';
  }
}
