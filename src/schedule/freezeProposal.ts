// The read-only freeze-proposal projection (board view feature, 2026-07-27).
// Pure: review rows + the tenant's latest schedule version + a clock in,
// a board-servable view out. No I/O — boardApi does the reads, server.ts
// shares the TTL constant, and tests exercise every state without a DB.
//
// The projection mirrors BOTH confirm-time staleness guards (server.ts
// run_freeze confirm branch): the 12h clock on detail.stagedAt AND the
// schedule-version pin — "the REAL staleness guard". A view that checked only
// the clock could show a plan the confirm would refuse. States are served,
// never client-computed: board.js has no build step, so a mirrored TTL
// constant would be one more keep-in-lockstep comment waiting to drift.
import type { ReviewItem } from '../db/reviewItems.js';
import {
  PINNED_SKIP_REASON,
  type FreezeCapacity,
  type FreezePlacement,
  type FreezePlan,
  type FreezeSkip,
} from './freezeSolve.js';
import { weekdayLabel } from './fit.js';

// 12 hours, NOT the house 15 minutes (4b-3 plan decision): a morning
// cron-fired proposal must survive until the manager reads it. Single source —
// the confirm branch imports this same constant.
export const FREEZE_PROPOSAL_TTL_MS = 12 * 3600_000;

export type FreezeProposalView =
  | { state: 'none'; message: string }
  | { state: 'expired' | 'stale'; message: string }
  | {
      state: 'open';
      stagedAt: string;
      expiresAt: string; // stagedAt + TTL, served so the client does no math
      horizonFrom: string;
      horizonTo: string;
      pinnedCount: number;
      placements: (FreezePlacement & { weekday: string })[];
      skipped: FreezeSkip[];
      capacity: FreezeCapacity[];
    };

interface StagedDetail {
  plan: FreezePlan;
  scheduleVersion: number;
  stagedAt: string;
}

// The confirm branch's malformed rule PLUS its `d.stagedAt &&` guard (plan
// review finding 2): a valid-plan row with a missing/unparseable stagedAt
// would otherwise serve `expiresAt: NaN` as `open` and break newest-wins.
function validDetail(detail: unknown): StagedDetail | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const d = detail as { plan?: unknown; scheduleVersion?: unknown; stagedAt?: unknown };
  if (!d.plan || typeof d.plan !== 'object') return null;
  // The open branch maps/filters these three unguarded — a shapeless plan
  // object must degrade to `none`, never 500 the endpoint (phase review
  // finding 3: no current writer produces this, but "never throw" is the
  // module's contract, not an assumption about writers).
  const p = d.plan as { placements?: unknown; skipped?: unknown; capacity?: unknown };
  if (!Array.isArray(p.placements) || !Array.isArray(p.skipped) || !Array.isArray(p.capacity)) {
    return null;
  }
  if (typeof d.scheduleVersion !== 'number') return null;
  if (typeof d.stagedAt !== 'string' || !Number.isFinite(Date.parse(d.stagedAt))) return null;
  return d as unknown as StagedDetail;
}

const NONE_MESSAGE = 'No freeze proposal is waiting. Ask the assistant to run the freeze in chat.';

export function projectFreezeProposal(
  items: ReviewItem[],
  latestVersion: number,
  nowMs: number,
): FreezeProposalView {
  // Newest stagedAt wins (staging dismisses kind-wide, so >1 open is an
  // anomaly the per-subject unique index still permits — plan decision).
  const candidates = items
    .map((item) => validDetail(item.detail))
    .filter((d): d is StagedDetail => d !== null)
    .sort((a, b) => Date.parse(b.stagedAt) - Date.parse(a.stagedAt));
  const d = candidates[0];
  if (!d) return { state: 'none', message: NONE_MESSAGE };
  if (nowMs - Date.parse(d.stagedAt) > FREEZE_PROPOSAL_TTL_MS) {
    return {
      state: 'expired',
      message:
        'This freeze proposal expired (proposals live 12 hours). ' +
        'Run the freeze again in chat for a fresh plan.',
    };
  }
  if (d.scheduleVersion !== latestVersion) {
    return {
      state: 'stale',
      message:
        'The schedule changed since this plan was solved — the assistant will refuse to ' +
        'book it. Run the freeze again in chat for a fresh plan.',
    };
  }
  return {
    state: 'open',
    stagedAt: d.stagedAt,
    expiresAt: new Date(Date.parse(d.stagedAt) + FREEZE_PROPOSAL_TTL_MS).toISOString(),
    horizonFrom: d.plan.horizonFrom,
    horizonTo: d.plan.horizonTo,
    // Exact match on the exported constant — never a substring grep (the
    // freezeSolve rule; a copy tweak must break tests, not counters).
    pinnedCount: d.plan.skipped.filter((s) => s.reason === PINNED_SKIP_REASON).length,
    placements: d.plan.placements.map((p) => ({ ...p, weekday: weekdayLabel(p.date) })),
    skipped: d.plan.skipped,
    capacity: d.plan.capacity,
    // Deliberately NO confirmId / row id: the page must not leak a confirm
    // handle — the yes lives in chat (ritual doctrine).
  };
}
