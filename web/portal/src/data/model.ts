// The portal's view model.
//
// Reconciled against the real spine schema rather than the handoff's
// placeholders (the handoff itself asks for this — "Field names, ID formats and
// the exact provisioning step list are plausible placeholders"). Three
// deliberate divergences, all forced by the database:
//
//  1. SEATS HAVE A TIER. `tenants.manager_seats` and `tenants.technician_seats`
//     are separate columns with separate prices ($80 / $50) and a DB trigger
//     enforcing each cap independently. They are never summed into one
//     "$/seat" figure — that would divide two different products by one
//     denominator and describe neither. The handoff's single flat price does
//     not exist in this system.
//  2. LIFECYCLE IS FIVE STATES, not three. The roster runs
//     invited → pending_verification → active → offboarding → offboarded, and
//     refs are never reused. The handoff's Active/Provisioning/Suspended is a
//     display projection of that, computed by `displayStatus` below.
//  3. NO PER-SEAT REGION OR SIZE. Sandboxes are pre-built cold blanks claimed
//     from `sandbox_pool` on one host; `hosts` carries no region or plan
//     column. Host is a property of the account, not of a seat.

export type Tier = 'manager' | 'technician';

/** Roster lifecycle, mirroring `technicians.state`. */
export type SeatState =
  | 'invited'
  | 'pending_verification'
  | 'active'
  | 'offboarding'
  | 'offboarded';

/** What the UI shows. A projection of SeatState — never stored. */
export type DisplayStatus = 'Active' | 'Provisioning' | 'Suspended' | 'Offboarded';

export interface Seat {
  /** Permanent roster ref. Never reused across humans — L1 is append-only. */
  ref: string;
  name: string;
  trade: string;
  tier: Tier;
  state: SeatState;
  /**
   * A name on the schedule and nothing more: bookable, but occupying no
   * purchased seat and never eligible for a sandbox, binding or mailbox.
   * Excluded from every billing figure.
   */
  seatExempt: boolean;
  /** Numeric Telegram account id, stored as text (JS number precision). */
  telegramUserId: string | null;
  /** The sandbox's bot handle. Null until a bot is created and bound. */
  botUsername: string | null;
  /** Pool sandbox ref (e.g. "s6"), null while unclaimed. */
  sandboxRef: string | null;
  seatSince: string;
}

export interface Invoice {
  id: string;
  period: string;
  managerSeats: number;
  technicianSeats: number;
  amountCents: number;
  status: 'Paid' | 'Open' | 'Past due';
}

export interface QueueItem {
  id: string;
  account: string;
  item: string;
  reason: string;
  /** Label of the filled primary action; varies by failure class. */
  action: 'Retry' | 'Notify' | 'Review' | 'Approve';
}

/**
 * What an export contains. The two tiers carry completely different risk and
 * are deliberately separate actions:
 *   records       — customers, jobs, visits, schedule, team. Ordinary business
 *                   data; the everyday download.
 *   conversations — the above PLUS verbatim email bodies and call transcripts.
 *                   That is bulk PII belonging to the customer's OWN customers,
 *                   so it needs its own confirmation and its own audit row.
 *   logs          — sandbox and account activity. Operational, low risk, no
 *                   customer PII.
 */
export type ExportKind = 'records' | 'conversations' | 'logs';

export interface ExportJob {
  id: string;
  kind: ExportKind;
  requestedBy: string;
  requestedAt: string;
  /** Null while still building. */
  sizeLabel: string | null;
  status: 'Building' | 'Ready' | 'Expired';
  /** Human-readable expiry. Every export link dies after 7 days. */
  expiresLabel: string;
  rowCount: number | null;
}

export const EXPORT_LABEL: Record<ExportKind, string> = {
  records: 'Records',
  conversations: 'Records + conversations',
  logs: 'Activity & sandbox logs',
};

export interface JobRecord {
  id: string;
  description: string;
  site: string;
  date: string;
}

// ── Pricing ─────────────────────────────────────────────────────────────────
// Placeholder amounts (owner decision 2026-08-07, expected to change). They
// live here ONLY for the mock; once Stripe is wired, the unit amount is read
// off the live subscription item so a price change is a dashboard action
// rather than a deploy.
export const PRICE_CENTS: Record<Tier, number> = {
  manager: 8000,
  technician: 5000,
};

export const TIER_LABEL: Record<Tier, string> = {
  manager: 'Manager',
  technician: 'Technician',
};

export const CURRENCY = 'USD';

export function money(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: CURRENCY,
  }).format(cents / 100);
}

/** Whole dollars, for price captions like "$80/mo". */
export function moneyShort(cents: number): string {
  return `$${Math.round(cents / 100)}`;
}

// ── Derivations ─────────────────────────────────────────────────────────────

export function displayStatus(seat: Seat): DisplayStatus {
  switch (seat.state) {
    case 'active':
      return 'Active';
    case 'invited':
    case 'pending_verification':
      return 'Provisioning';
    case 'offboarding':
      return 'Suspended';
    case 'offboarded':
      return 'Offboarded';
  }
}

/**
 * Does this seat consume purchased capacity? Mirrors the DB trigger's
 * predicate exactly: not seat-exempt, and not on the way out.
 */
export function occupiesSeat(seat: Seat): boolean {
  return !seat.seatExempt && seat.state !== 'offboarding' && seat.state !== 'offboarded';
}

export function countByTier(seats: Seat[], tier: Tier): number {
  return seats.filter((s) => s.tier === tier && occupiesSeat(s)).length;
}

export interface TierLine {
  tier: Tier;
  used: number;
  purchased: number;
  unitCents: number;
  subtotalCents: number;
}

/**
 * Per-tier billing lines. Returned as a list, never reduced to a blended
 * per-seat figure — see the note at the top of this file.
 */
export function tierLines(seats: Seat[], purchased: Record<Tier, number>): TierLine[] {
  return (['manager', 'technician'] as Tier[]).map((tier) => ({
    tier,
    used: countByTier(seats, tier),
    purchased: purchased[tier],
    unitCents: PRICE_CENTS[tier],
    subtotalCents: purchased[tier] * PRICE_CENTS[tier],
  }));
}

/**
 * Placeholder proration, flagged as such in the handoff ("replace with real
 * proration"). Stripe computes the real figure; this exists so the mock shows
 * a plausible number rather than a blank.
 */
export function prorate(unitCents: number, days: number, daysInMonth: number): number {
  return Math.round((unitCents * days) / daysInMonth);
}
