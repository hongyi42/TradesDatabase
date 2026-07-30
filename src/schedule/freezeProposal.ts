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
  type ResolvePlan,
} from './freezeSolve.js';
import { weekdayLabel } from './fit.js';

// 12 hours, NOT the house 15 minutes (4b-3 plan decision): a morning
// cron-fired proposal must survive until the manager reads it. Single source —
// the confirm branch imports this same constant.
export const FREEZE_PROPOSAL_TTL_MS = 12 * 3600_000;

export type ProposalKind = 'freeze' | 'resolve';

// One move line, fully server-composed (the board has no build step and does
// no date math): weekday-labeled from→to labels, the technician change only
// when the person actually changes, and the placements-idiom grouping pair
// (toDate + toWeekday) so the sheet can group per day exactly like Placements.
export type ProposalMoveView = {
  fromLabel: string; // e.g. "Tue 2026-08-04 09:00–10:00"
  toLabel: string;
  customer: string | null;
  jobTitle: string | null;
  techChange: string | null; // "Joy Chen → Hman Lee", null when unchanged
  toDate: string;
  toWeekday: string;
};

type OpenProposalCommon = {
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

// Kind-agnostic since plan 2026-07-30: the ONE open proposal (freeze OR
// re-solve) — `kind` rides on every non-none state so the sheet titles and
// copy can say which verb to rerun.
export type ProposalView =
  | { state: 'none'; message: string }
  | { state: 'expired' | 'stale'; kind: ProposalKind; message: string }
  | (OpenProposalCommon & { kind: 'freeze' })
  | (OpenProposalCommon & { kind: 'resolve'; moves: ProposalMoveView[]; keptCount: number });

export interface StagedFreezeDetail {
  plan: FreezePlan;
  scheduleVersion: number;
  stagedAt: string;
}

// The confirm branch's malformed rule PLUS its `d.stagedAt &&` guard (plan
// review finding 2): a valid-plan row with a missing/unparseable stagedAt
// would otherwise serve `expiresAt: NaN` as `open` and break newest-wins.
function validDetail(detail: unknown): StagedFreezeDetail | null {
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
  return d as unknown as StagedFreezeDetail;
}

// THE shared staleness kernel (final-review finding): the confirm branch and
// the board projection both consume this one assessment, so "the page never
// shows a plan the confirm would refuse" — and the inverse, "the confirm
// never books a plan the page calls dead" — are structural, not a pair of
// hand-mirrored checks drifting apart. A new refusal rule added here refuses
// in chat and renders on the board in the same edit.
export type StagedFreezeAssessment =
  | { verdict: 'malformed' }
  | { verdict: 'expired' }
  | { verdict: 'stale'; pinnedVersion: number; currentVersion: number }
  | { verdict: 'open'; detail: StagedFreezeDetail };

export function assessStagedFreeze(
  detail: unknown,
  latestVersion: number,
  nowMs: number,
): StagedFreezeAssessment {
  const d = validDetail(detail);
  if (!d) return { verdict: 'malformed' };
  if (nowMs - Date.parse(d.stagedAt) > FREEZE_PROPOSAL_TTL_MS) return { verdict: 'expired' };
  if (d.scheduleVersion !== latestVersion) {
    return { verdict: 'stale', pinnedVersion: d.scheduleVersion, currentVersion: latestVersion };
  }
  return { verdict: 'open', detail: d };
}

// ---------------------------------------------------------------------------
// Re-solve tokens (plan 2026-07-30): same TTL, same version pin, same
// malformed rule — PLUS the plan must carry the resolve arrays. Built ON the
// freeze kernel so the two verbs cannot drift on staleness semantics.

export interface StagedResolveDetail extends StagedFreezeDetail {
  plan: ResolvePlan;
}

// The freeze rule AND the resolve additions: a detail whose plan lacks a
// `moves` array or a numeric `keptCount` is malformed for THIS kind (a
// freeze-shaped detail staged under pending_resolve must dismiss, never
// commit as a zero-move run). Per-MOVE shape too (final-review finding):
// the commit dereferences these fields row by row, and the executor's
// null-target arm now means a corrupt `toTechnicianRef: null` would silently
// PARK the visit person-less instead of failing loudly — a stored token is
// unvalidated JSON, so the malformed gate is where bad rows must die.
function validResolveDetail(detail: unknown): StagedResolveDetail | null {
  const d = validDetail(detail);
  if (!d) return null;
  const p = d.plan as { moves?: unknown; keptCount?: unknown };
  if (!Array.isArray(p.moves) || typeof p.keptCount !== 'number') return null;
  for (const m of p.moves as Array<Record<string, unknown>>) {
    if (!m || typeof m !== 'object') return null;
    for (const k of [
      'assignmentId',
      'toTechnicianRef',
      'toDate',
      'toStartTime',
      'toEndTime',
    ] as const) {
      if (typeof m[k] !== 'string' || m[k] === '') return null;
    }
  }
  return d as StagedResolveDetail;
}

export type StagedResolveAssessment =
  | { verdict: 'malformed' }
  | { verdict: 'expired' }
  | { verdict: 'stale'; pinnedVersion: number; currentVersion: number }
  | { verdict: 'open'; detail: StagedResolveDetail };

export function assessStagedResolve(
  detail: unknown,
  latestVersion: number,
  nowMs: number,
): StagedResolveAssessment {
  const d = validResolveDetail(detail);
  if (!d) return { verdict: 'malformed' };
  const a = assessStagedFreeze(detail, latestVersion, nowMs);
  // validResolveDetail passing implies the freeze kernel cannot say
  // malformed; expiry and version verdicts pass through EXPLICITLY — never
  // via a cast, so a verdict added to the kernel later degrades to a clean
  // malformed dismissal here instead of compiling silently and falling
  // through the caller's if-chain after the token is consumed
  // (final-review finding).
  if (a.verdict === 'open') return { verdict: 'open', detail: d };
  if (a.verdict === 'expired' || a.verdict === 'stale') return a;
  return { verdict: 'malformed' };
}

// Verb-neutral (final-review finding): the none state cannot know which kind
// just vanished — a manager whose RE-SOLVE token was dismissed between the
// pill probe and the sheet fetch must not be steered to the wrong verb.
const NONE_MESSAGE =
  'No proposal is waiting. Ask the assistant to run the freeze — or the re-plan — in chat.';

export function projectOpenProposal(
  freezeItems: ReviewItem[],
  resolveItems: ReviewItem[],
  latestVersion: number,
  nowMs: number,
): ProposalView {
  // Newest stagedAt wins across BOTH kinds (staging dismisses kind-wide, so
  // two open of one kind is an index anomaly; freeze + resolve both open is
  // legal but short-lived — committing either bumps the schedule version and
  // stales the other, so the newest token is the only one worth showing).
  // Resolve candidates parse under the RESOLVE rule: a freeze-shaped detail
  // misfiled under pending_resolve can never outrank a valid token.
  const candidates: { kind: ProposalKind; detail: StagedFreezeDetail }[] = [
    ...freezeItems
      .map((item) => validDetail(item.detail))
      .filter((d): d is StagedFreezeDetail => d !== null)
      .map((detail) => ({ kind: 'freeze' as const, detail })),
    ...resolveItems
      .map((item) => validResolveDetail(item.detail))
      .filter((d): d is StagedResolveDetail => d !== null)
      .map((detail) => ({ kind: 'resolve' as const, detail })),
  ].sort((a, b) => Date.parse(b.detail.stagedAt) - Date.parse(a.detail.stagedAt));
  const head = candidates[0];
  if (!head) return { state: 'none', message: NONE_MESSAGE };
  // The rerun instruction names the right verb; the freeze copy stays
  // byte-identical to the shipped strings.
  const verb = head.kind === 'resolve' ? 're-solve' : 'freeze';
  const noun = head.kind === 'resolve' ? 're-plan' : 'freeze';
  const a =
    head.kind === 'resolve'
      ? assessStagedResolve(head.detail, latestVersion, nowMs)
      : assessStagedFreeze(head.detail, latestVersion, nowMs);
  if (a.verdict === 'malformed') return { state: 'none', message: NONE_MESSAGE }; // unreachable: pre-filtered
  if (a.verdict === 'expired') {
    return {
      state: 'expired',
      kind: head.kind,
      message:
        `This ${noun} proposal expired (proposals live 12 hours). ` +
        `Run the ${verb} again in chat for a fresh plan.`,
    };
  }
  if (a.verdict === 'stale') {
    return {
      state: 'stale',
      kind: head.kind,
      message:
        'The schedule changed since this plan was solved — the assistant will refuse to ' +
        `book it. Run the ${verb} again in chat for a fresh plan.`,
    };
  }
  const d = head.detail;
  // Horizons cap at 31 days, so distinct dates are few — memoize the weekday
  // per date rather than constructing an Intl formatter per placement.
  const weekdayByDate = new Map<string, string>();
  const weekdayFor = (date: string): string => {
    const hit = weekdayByDate.get(date);
    if (hit) return hit;
    const computed = weekdayLabel(date);
    weekdayByDate.set(date, computed);
    return computed;
  };
  const common: OpenProposalCommon = {
    state: 'open',
    stagedAt: d.stagedAt,
    expiresAt: new Date(Date.parse(d.stagedAt) + FREEZE_PROPOSAL_TTL_MS).toISOString(),
    horizonFrom: d.plan.horizonFrom,
    horizonTo: d.plan.horizonTo,
    // Exact match on the exported constant — never a substring grep (the
    // freezeSolve rule; a copy tweak must break tests, not counters).
    pinnedCount: d.plan.skipped.filter((s) => s.reason === PINNED_SKIP_REASON).length,
    placements: d.plan.placements.map((p) => ({ ...p, weekday: weekdayFor(p.date) })),
    skipped: d.plan.skipped,
    capacity: d.plan.capacity,
    // Deliberately NO confirmId / row id: the page must not leak a confirm
    // handle — the yes lives in chat (ritual doctrine).
  };
  if (head.kind !== 'resolve') return { ...common, kind: 'freeze' };
  // The Moves section's render source. Names come from the plan's own
  // capacity rows (solve-time truth, no roster fetch); a technician who has
  // no capacity row (e.g. deactivated since the solve) falls back to the ref.
  const rp = d.plan as ResolvePlan;
  const nameByRef = new Map(rp.capacity.map((c) => [c.technicianRef, c.technicianName]));
  const techName = (ref: string): string => nameByRef.get(ref) ?? ref;
  // Pre-sorted by (toDate, toStartTime) so the client only groups — it never
  // sorts (the labels are display strings, not sort keys).
  const moves = [...rp.moves]
    .sort((x, y) => {
      const kx = `${x.toDate} ${x.toStartTime}`;
      const ky = `${y.toDate} ${y.toStartTime}`;
      return kx < ky ? -1 : kx > ky ? 1 : 0;
    })
    .map(
      (m): ProposalMoveView => ({
        fromLabel: `${weekdayFor(m.fromDate)} ${m.fromDate} ${m.fromStart}–${m.fromEnd}`,
        toLabel: `${weekdayFor(m.toDate)} ${m.toDate} ${m.toStartTime}–${m.toEndTime}`,
        customer: m.customer,
        jobTitle: m.jobTitle,
        techChange:
          m.fromTechnicianRef === m.toTechnicianRef
            ? null
            : `${techName(m.fromTechnicianRef)} → ${techName(m.toTechnicianRef)}`,
        toDate: m.toDate,
        toWeekday: weekdayFor(m.toDate),
      }),
    );
  return { ...common, kind: 'resolve', moves, keptCount: rp.keptCount };
}
