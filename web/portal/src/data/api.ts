import type { Seat, Tier } from './model.js';

// The portal's HTTP client.
//
// Plan: thoughts/shared/plans/2026-08-12-portal-real-data.md (Phase 3).
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO: it never sends a tenant id. Every
// endpoint resolves the tenant from the session cookie server-side, so there is
// no parameter here for the client to get wrong or for an attacker to change.
// If you find yourself wanting to add one, that is the bug — read `D3` in the
// plan and `src/portal/queries.ts` first.
//
// `credentials: 'same-origin'` is what carries the session cookie. The cookie is
// HttpOnly, so this code cannot read it; it only rides along.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown when the session is missing or expired — the caller signs the user out. */
export class Unauthenticated extends ApiError {
  constructor() {
    super(401, 'unauthenticated');
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // A network failure is not an auth failure — distinguishing them matters,
    // because signing someone out because their train went into a tunnel is
    // worse than showing "couldn't reach the server".
    throw new ApiError(0, 'network');
  }
  if (res.status === 401) throw new Unauthenticated();
  if (res.status === 204) return undefined as T;
  if (!res.ok) throw new ApiError(res.status, `request failed (${res.status})`);
  return (await res.json()) as T;
}

// ── Shapes, mirroring src/portal/queries.ts ────────────────────────────────

export interface Me {
  email: string;
  role: 'owner' | 'operator';
}

export interface TierCount {
  purchased: number;
  used: number;
}

export interface Summary {
  tenantId: string;
  tenantName: string;
  manager: TierCount;
  technician: TierCount;
}

/** The wire shape: `seatSince` is an ISO timestamp; the UI formats it. */
interface WireSeat extends Omit<Seat, 'seatSince'> {
  seatSince: string;
}

/**
 * The API returns an ISO timestamp and leaves presentation to the client — a
 * server that pre-formats dates is a server that has guessed the reader's
 * locale. "Aug 2026" is what the seat table has always shown.
 */
function formatSeatSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function toSeat(w: WireSeat): Seat {
  return { ...w, seatSince: formatSeatSince(w.seatSince) };
}

// ── Endpoints ──────────────────────────────────────────────────────────────

/** Who am I? 401 (as `Unauthenticated`) when there is no valid session. */
export function getMe(): Promise<Me> {
  return request<Me>('/portal/api/me');
}

export function getSummary(): Promise<Summary> {
  return request<Summary>('/portal/api/summary');
}

export async function getSeats(): Promise<Seat[]> {
  const body = await request<{ seats: WireSeat[] }>('/portal/api/seats');
  return body.seats.map(toSeat);
}

export async function getSeat(ref: string): Promise<Seat> {
  return toSeat(await request<WireSeat>(`/portal/api/seats/${encodeURIComponent(ref)}`));
}

/**
 * Ask for a sign-in link.
 *
 * Resolves the same way whether or not the address is a customer — the server
 * answers 204 either way on purpose (account enumeration), so this cannot and
 * must not tell the caller which it was. The UI says "if that address has an
 * account, a link is on its way", which is true in both cases.
 *
 * A 503 means no mailer is configured, which is a real outage rather than a
 * user error, so it is surfaced rather than swallowed.
 */
export function requestSignInLink(email: string): Promise<void> {
  return request<void>('/portal/api/auth/request-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

export function signOut(): Promise<void> {
  return request<void>('/portal/api/auth/signout', { method: 'POST' });
}

/** Purchased capacity per tier, in the shape the seats screen already expects. */
export function purchasedFromSummary(s: Summary): Record<Tier, number> {
  return { manager: s.manager.purchased, technician: s.technician.purchased };
}
