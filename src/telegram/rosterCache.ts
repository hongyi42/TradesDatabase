import type { Technician } from '../db/index.js';

// Memoizes the ROSTER LOOKUP behind board auth — the one DB round-trip every
// /board/api/* request paid to answer "which roster row is this Telegram user?".
// That answer changes rarely, but the lookup ran on every single button press.
//
// SECURITY — precisely what is and is not cached:
//   * The Telegram initData SIGNATURE is verified on EVERY request, BEFORE this
//     cache is consulted (verifyInitData is a local HMAC — no DB, microseconds).
//     A forged or stale slip never reaches the cache, so a hit is never an
//     authentication bypass. Only the identity→roster mapping is memoized.
//   * Only the SUCCESS case is stored. A 401 (unknown id) or 409 (ambiguous
//     binding) is re-derived from the DB every time, so a newly-onboarded person
//     works immediately and the deny path can never serve a stale allow.
//   * The cost: a roster change (deactivation, tier change, tenant move) stays
//     invisible for up to TTL_MS. 60s is the accepted window — short enough that
//     revoking access is effectively immediate, long enough that a burst of
//     button presses costs one lookup instead of a dozen.
//
// The clock is injected (`now`) rather than read here, so the TTL is testable
// deterministically instead of with timers.

export interface CachedRoster {
  tenantId: string;
  technician: Technician;
}

export const TTL_MS = 60_000;

// Bounded on purpose. The key is a signature-verified Telegram user id, so an
// unauthenticated caller cannot spray keys into this map — but a hard cap keeps
// a long-lived process flat regardless of how many people ever open the board.
export const MAX_ENTRIES = 5_000;

const entries = new Map<string, { value: CachedRoster; expiresAt: number }>();

export function get(userId: string, now: number): CachedRoster | undefined {
  const hit = entries.get(userId);
  if (!hit) return undefined;
  if (hit.expiresAt <= now) {
    entries.delete(userId); // lazy expiry — no sweeper needed
    return undefined;
  }
  return hit.value;
}

export function set(userId: string, value: CachedRoster, now: number): void {
  // Re-insert so Map iteration order tracks most-recently-stored; the cap below
  // then evicts the oldest entry rather than an arbitrary one.
  entries.delete(userId);
  entries.set(userId, { value, expiresAt: now + TTL_MS });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

// Tests only: the map is module-level, so it outlives an individual test.
export function clear(): void {
  entries.clear();
}

export function size(): number {
  return entries.size;
}
