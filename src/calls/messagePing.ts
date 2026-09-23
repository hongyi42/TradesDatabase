import {
  PINGED_MESSAGE_KINDS,
  claimOfficeMessagePing,
  listUnpingedOfficeMessages,
  type OfficeMessage,
} from '../db/index.js';
import { focusedPassBlockedBy, runFocusedMessagePass } from '../jobs/plannerPass.js';

// THE MESSAGE PING LOOP (rung 10c) — a seat's message wakes the office within
// seconds, the way an inbound call already does (observationPing.ts, whose
// every rule this mirrors line for line).
//
// Before this, a technician's inform_team_lead waited for the planner's
// cadence: up to 30 minutes in firm hours, 120 outside them. The Calls worker
// is the one always-on process, so the wake lives here, as a third independent
// loop beside the call drain and the observation pings.
//
// ONLY 'inform' (PINGED_MESSAGE_KINDS). A reply answers a gap and reaches the
// tick beside it; an ask is answered by the question door while the seat
// waits; desk rows are born read; news is an access decision with nothing to do.
export interface MessagePingDeps {
  list?: typeof listUnpingedOfficeMessages;
  claim?: typeof claimOfficeMessagePing;
  pass?: (message: OfficeMessage) => Promise<unknown>;
  blocked?: typeof focusedPassBlockedBy;
}

// One line per REASON, not one per poll (the observation loop's rule).
let lastBlockedReason: string | null = null;

/**
 * Claim at most ONE unclaimed seat message and run a focused message pass on it.
 *
 * Returns 'idle' when there was nothing to do, so the caller can back off.
 */
export async function drainOneMessagePing(
  deps: MessagePingDeps = {},
): Promise<'idle' | 'pinged' | 'error'> {
  const list = deps.list ?? listUnpingedOfficeMessages;
  const claim = deps.claim ?? claimOfficeMessagePing;
  const pass = deps.pass ?? runFocusedMessagePass;
  const blocked = (deps.blocked ?? focusedPassBlockedBy)();
  // BEFORE THE CLAIM, ALWAYS. A claim is released only by the tick's lease, so
  // a loop that claimed and then found it could not run would push every
  // message onto the slow path for nothing.
  if (blocked) {
    if (blocked !== lastBlockedReason) {
      console.warn(`[calls:message-ping] not running message passes — ${blocked}`);
      lastBlockedReason = blocked;
    }
    return 'idle';
  }
  lastBlockedReason = null;
  try {
    // ONE AT A TIME, oldest first.
    const [next] = await list(PINGED_MESSAGE_KINDS, 1);
    if (!next) return 'idle';
    // THE CLAIM IS THE EXCLUSION: guarded on unclaimed AND unread, so a racing
    // worker or a tick that already read it wins and this one does nothing.
    const claimed = await claim(next.id);
    if (!claimed) return 'idle';
    const summary = await pass(claimed);
    if (summary !== undefined) {
      console.log(`[calls:message-ping] focused pass ${claimed.id} ${JSON.stringify(summary)}`);
    }
    return 'pinged';
  } catch (err) {
    // NEVER RETHROWN, and THE CLAIM STAYS: the pass may already have texted
    // somebody. The message is still unread, so the first tick after the
    // lease (OFFICE_CLAIM_LEASE_MS) takes it back.
    console.error('[calls:message-ping] focused pass failed', err);
    return 'error';
  }
}
