import { listLiveBotIds } from '../db/index.js';
import { botIdFromToken } from './initData.js';

// THE ALLOWLIST behind Mini App signature checks — the numeric ids of every bot
// that may open the console, memoized.
//
// Why this exists at all: the one-bot-per-person merge means a launch slip can
// be signed for any of a firm's assistant bots, and Telegram's Ed25519 scheme
// verifies a slip against a bot ID rather than a bot TOKEN (initData.ts). Ids
// are not secret, so they can live in the DB and in this process; tokens stay
// on the box.
//
// SECURITY — what membership here does and does not mean:
//   * It means "this slip came through a door we control". Every id belongs to
//     a bot the operator created; no user of ours owns one.
//   * It does NOT mean the person may do anything. The roster lookup after
//     verification still decides tenant, role, and whether the account is live.
//   * The board bot is always included, derived from the token this process
//     already holds, so the changeover needs no data at all to keep working.
//
// FAILURE POSTURE. A DB outage must not open the door or slam it: the last good
// list keeps serving (ids change on a human timescale — a new hire, a recycled
// seat), and a refresh that fails backs off rather than hammering. With no list
// ever loaded, only the board bot is allowed, which is exactly today's
// behaviour. Nothing here ever returns "allow everything".
export const TTL_MS = 300_000; // 5 min: a new seat can open the app that soon
export const FAILURE_BACKOFF_MS = 5_000; // don't re-query on every request

let cached: string[] | null = null;
let expiresAt = 0;
let inFlight: Promise<void> | null = null;

// The global board bot's id, from the token this process already has. Public
// half of a secret we hold anyway — never stored, always derived.
export function boardBotId(): string | null {
  return botIdFromToken(process.env.BOARD_BOT_TOKEN);
}

async function refresh(): Promise<void> {
  try {
    cached = await listLiveBotIds();
    expiresAt = Date.now() + TTL_MS;
  } catch {
    // Keep whatever we had and try again shortly. Swallowed on purpose: the
    // caller's job is to answer an auth question, not to surface DB health,
    // and the outer handler already logs 500s for real faults.
    expiresAt = Date.now() + FAILURE_BACKOFF_MS;
  } finally {
    inFlight = null;
  }
}

// The ids to verify a slip against, board bot first (the common case today, and
// the ordering only affects how many Ed25519 checks a request costs).
export async function allowed(now = Date.now()): Promise<string[]> {
  if (!cached || expiresAt <= now) {
    // One refresh in flight at a time: a burst of launches after a deploy must
    // cost one query, not one per request.
    if (!inFlight) inFlight = refresh();
    await inFlight;
  }
  const board = boardBotId();
  const ids = cached ?? [];
  return board && !ids.includes(board) ? [board, ...ids] : ids;
}

// Tests, and any place that changes the pool and wants the next launch to see
// it without waiting out the TTL.
export function clear(): void {
  cached = null;
  expiresAt = 0;
  inFlight = null;
}
