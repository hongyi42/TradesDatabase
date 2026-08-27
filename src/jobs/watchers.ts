import {
  createPendingNudge,
  listCostGapCandidates,
  listDecisionsForNudges,
  listJobIdsWithCostEvents,
  findOpenReviewItemsByKind,
  flagNudgeGap,
  flagOverdueVisitGap,
  getTenant,
  listAssignmentsByIds,
  listEverFlaggedSubjectRefs,
  listJobStampedCaptureTimes,
  listJobsWithCustomerByIds,
  listNudgedSubjectRefs,
  listNudgesByStatus,
  listOverdueConfirmedAssignments,
  listTeam,
  listTenantIdsWithTelegramBindings,
  listVisitTimesForJobs,
  markNudgeOutcome,
  resolveOpenReviewItemFor,
} from '../db/index.js';
import { notifyManagers } from '../calls/notify.js';
import {
  NUDGE_KIND_SPECS,
  specFor,
  stage0Suggestion,
  type NudgeKindSpec,
  type SweepFacts,
} from './nudgeKinds.js';
import { localDateISO, localTimeHHMM, parseAsUtc } from '../schedule/availability.js';
import { naiveLocalISO } from '../schedule/booking.js';

// The Stage-0 watcher (plan 2026-08-15 feature A): a DETERMINISTIC detector for
// the archetype gap — a confirmed visit whose scheduled end passed hours ago
// with nothing recorded about it. No model calls; detection is SQL + the time
// math below. Findings surface into channels that already exist: the manager's
// review queue (review_items, kind 'overdue_visit_gap') and ONE batched
// count-only notifyManagers line.
//
// "Filled" means job activity SINCE THE VISIT STARTED (final-review fix): a
// field note dictated mid-visit or on the way out IS the report — comparing
// against the scheduled END flagged exactly those punctual reports as gaps
// (and could never auto-resolve them). Activity from before the visit began
// (the booking-time captures) never counts.
//
// Ships SHADOW-FIRST: the research measured the archetype firing on 100% of
// the pilot's historical schedule (67/67), so `shadow` counts gaps into the
// cron summary without writing anything; `live` is flipped only after the
// volume is judged sane (rollout, plan Phase 3). The number to judge is
// `freshGaps` — gaps not already flagged in a previous tick — which is what
// live mode would actually open; `gapsFound` is the standing-gap snapshot.
//
// Restraint machinery (each line guards the manager's attention, the scarce
// resource):
//   - the 72h look-back means the historical backlog NEVER surfaces;
//   - the cap meters FRESH gaps only (ever-flagged assignments are filtered
//     out via one batched read BEFORE capping — final-review fix: without it,
//     stale flagged-but-unfilled gaps occupy the slots and starve new gaps);
//   - once per assignment EVER (flagOverdueVisitGap's any-status dedup stays
//     as the belt-and-suspenders behind the pre-filter);
//   - auto-resolve: an open item whose job gained activity since the visit
//     started — or whose visit left 'confirmed' (cancelled/completed, the
//     "status update" the item copy promises) — is closed by the watcher, so
//     the queue self-cleans;
//   - copy is about the JOB, never "this person is behind" (direction
//     constraint 5); the tech ref rides in detail as routing data only.
//
// TIME CONVENTION (the trap this module exists to not fall into): assignment
// starts_at/ends_at are the firm's WALL-CLOCK stored as if UTC (naive-local),
// while raw_captures.captured_at / visits.created_at are REAL UTC. Every
// comparison converts the real-UTC side to the firm's wall clock via
// localDateISO/localTimeHHMM (Intl owns DST) composed through the canonical
// naiveLocalISO — never the reverse, never offset arithmetic. That conversion
// is MINUTE-precision, so compares use >= against the minute-floored bound
// (same-minute activity counts as filling; the safe direction). DB reads are
// bounded with a conservative real-UTC floor and the listers paginate past
// PostgREST's silent 1000-row cap.

export type WatcherMode = 'shadow' | 'live';

// Stage 1 (plan 2026-08-15 feature B): the ladder. When the technician is
// reachable, a fresh gap becomes a NUDGE — a question
// delivered through their own agent — INSTEAD of a manager review item; the
// manager surface remains as the fallback (unreachable tech) and as rung 2
// (24h of silence after the ask). NUDGES_MODE gates it independently of
// WATCHERS_MODE: 'off' is byte-for-byte the deployed Stage-0 behavior,
// 'shadow' counts would-be nudges while still flagging the manager, 'live'
// runs the ladder. Watchers-live is a PREREQUISITE for any of it — in
// watcher-shadow this function returns before every write path.
export type NudgeMode = 'off' | 'shadow' | 'live';

// Tune at the shadow-volume review (user decision 2026-08-16: 3h/72h/5 stand).
export const OVERDUE_HOURS = 3;
export const LOOKBACK_HOURS = 72;
export const MAX_NEW_ITEMS_PER_TENANT_TICK = 5;

// Ladder tuning. There is NO per-person ask cap (user ruling 2026-08-18,
// reversing the 2-asks/person/24h budget): pace by urgency, earn the ask by
// self-serving first, batch the unimportant — none of which a counter can
// express. Volume is bounded instead by uq_nudges_subject_ever (a subject is
// asked about once, EVER) and by MAX_NEW_ITEMS_PER_TENANT_TICK above, which
// stays as the per-tenant surge brake. 24h of post-ask silence escalates.
// Code constants, not env (the OVERDUE_HOURS pattern: one tuning surface).
//
// The deleted counter was ALSO, incidentally, the brake on a misfiring
// detector. That backstop must return per-detector: today's margin comes from
// having exactly ONE well-tested detector, not from the design, so detector #2
// must land with its own brake. See
// thoughts/shared/research/2026-08-19-nudge-pacing-replacement-design.md (§5).
//
// 48 -> 24 (user decision 2026-08-20), and the evidence for it is unusual: the
// PLANNER reached the same number on its own, three shadow ticks running,
// before the constant was touched. Watching one real pilot gap it chose to
// escalate at 24h — half the constant — and argued the case from job size:
// "a routine 60-min visit follow-up should not sit unanswered for a full day".
// Two days was never reasoned about; it was the round number the ladder shipped
// with. This is now the DEFAULT rather than the rule — a per-row escalate_after
// overrides it, which is the whole point of Phase 2.
export const NUDGE_ESCALATE_HOURS = 24;
// The furthest the PLANNER may push a deadline out with `extend` (plan
// 2026-08-21 ①). 48 is not arbitrary: it is what this ladder shipped with for
// months before the constant above was halved on 2026-08-20, so the ceiling
// says the model may re-derive the slack that was removed when it has a reason,
// and no further. Measured from asked_at, so it bounds TOTAL postponement
// however many times a row is extended — a per-extend cap would let the model
// walk a gap forward forever and the deadline would stop being a fail-safe.
export const NUDGE_ESCALATE_MAX_HOURS = 48;
// A nudge still not ASKED this long after creation is stuck in some silent
// way the serve path cannot see (Phase-4 review F1: an offboarded technician
// is liveness-skipped forever; a recycled sandbox clears host_id, making the
// row invisible to EVERY pull's inner join; a rollback freezes pending rows).
// The ask is not happening — the manager takes the gap.
//
// This asks a DIFFERENT question from NUDGE_ESCALATE_HOURS above, and the two
// must not be read as a pair. Escalation asks "how long do we wait for a
// PERSON". This asks "how long before we admit the MACHINERY is broken" — and
// nobody is ignoring us, so there is no patience to extend. A gap nobody can
// even receive should reach the manager SOONER than one somebody is sitting on.
//
// 24 -> 18 (user decision 2026-08-20). At 24 it had silently become equal to the
// escalation default, which flattened that ordering by coincidence rather than
// by choice: a dead pipe was being treated exactly as patiently as a live
// conversation.
//
// The floor is NOT zero. The compose ask window (7am-7pm firm-local) holds an
// evening gap overnight — 12h, or 13h on a DST fall-back night — so anything
// below ~14h starts expiring rows that were merely waiting for morning, and
// tells the manager "never delivered" about a question that was seconds from
// being asked. 18 keeps 5h of margin over that worst case and still surfaces
// broken delivery 6h before silence escalates. Worked example: a gap found at
// 7:01pm holds till 7am, composes, and still gets 6h of delivery attempts.
//
// A window that ever excludes whole DAYS (a weekend rule, say) must lengthen
// this deadline with it, or weekend-held rows expire to the manager without the
// technician ever being asked. That constraint is tighter at 18 than it was
// at 24 — move this number FIRST if the window ever grows.
export const NUDGE_DELIVERY_DEADLINE_HOURS = 18;

// How long the planner may be silent about a gap before the sweep stops waiting
// for it (plan 2026-08-22, Phase 2 — user set the duration: ONE WORKING DAY).
//
// This is a LIVENESS window, not a second deadline. The fail-safe itself is
// anchored to the escalation deadline above — already 24h by default,
// planner-adjustable with `extend`, hard-capped at 48h — because that is the
// exact instant the damage lands: the moment the sweep would otherwise hand a
// manager a gap claiming nobody answered when somebody did. This number only
// decides whether the planner counts as ALIVE at that instant.
//
// Read the pairing carefully: an `extend` moves the deadline AND is itself a
// judgment, so a planner that is actively postponing a gap both delays the
// fail-safe and keeps proving it is awake. That is intended — the fail-safe
// exists for a planner that is DEAD, never for one that disagrees.
export const PLANNER_SILENCE_HOURS = 24;

// What counts as the planner having DECIDED something about a gap.
//
// This set is the seam between Phase 2 and Phase 3 of the 2026-08-22 plan, and
// getting it wrong is silent. Phase 3 writes an `unmentioned` row with
// `outcome: 'applied'` for every gap the planner merely LOOKED at — so a naive
// `outcome === 'applied'` liveness test would be true for every open gap on
// every tick, and the fail-safe below would never fire again with nothing to
// show for it. `unmentioned` means "saw it, said nothing"; only a real verb is a
// judgment.
//
// Adding a new planner action means adding it HERE too. Exported so a test pins
// exactly that, rather than trusting a future reader to remember.
export const PLANNER_JUDGMENT_ACTIONS: ReadonlySet<string> = new Set([
  'send',
  'hold',
  'close',
  'escalate',
  'extend',
  'leave',
]);

// UTC offsets span −12h..+14h; subtracting 14h from a wall-clock instant is a
// floor no real timezone's UTC reading can undershoot.
const MAX_UTC_OFFSET_MS = 14 * 3_600_000;

// Human label for a firm wall-clock timestamp: "Saturday, Aug 15 at 4:00 PM".
// The input already IS the firm's wall clock, carried in the storage form
// booking.ts's naiveLocalISO writes — the wall clock stamped with a `Z`, NOT a
// bare offset-less string. So we format it in UTC (no timezone math) and the
// weekday comes from Intl over the same instant, so the weekday-date pair can
// never disagree (the weekday-guard doctrine: fused derivation, not model
// arithmetic). parseAsUtc guards the input's SHAPE: hand a caller's bare
// `2026-08-15T16:00:00` to Date.parse and the host's zone decides what it
// means, which on a non-UTC machine silently shifts every label — and on a
// far-east one rolls the DAY. See its header in schedule/availability.ts.
export function wallClockLabel(wallClockIso: string): string {
  const d = new Date(parseAsUtc(wallClockIso));
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  return `${day} at ${time}`;
}
// The activity floor may reach back to candidates'/open items' visit STARTS,
// but never unboundedly (final-review fix: one stuck open item must not drag
// every tick's read back for months). No visit spans a week; anything older
// can only be closed by the status-change path or a manual dismiss.
const MAX_FLOOR_REACH_MS = 7 * 24 * 3_600_000;

export interface WatcherDeps {
  listTenants?: typeof listTenantIdsWithTelegramBindings;
  getTenant?: typeof getTenant;
  listOverdue?: typeof listOverdueConfirmedAssignments;
  listCaptureTimes?: typeof listJobStampedCaptureTimes;
  listVisitTimes?: typeof listVisitTimesForJobs;
  listTeam?: typeof listTeam;
  listJobs?: typeof listJobsWithCustomerByIds;
  listEverFlagged?: typeof listEverFlaggedSubjectRefs;
  listAssignments?: typeof listAssignmentsByIds;
  flagGap?: typeof flagOverdueVisitGap;
  // The kind-generic flagger, for gaps whose subject is not a visit.
  flagNudge?: typeof flagNudgeGap;
  findOpenGaps?: typeof findOpenReviewItemsByKind;
  resolveGap?: typeof resolveOpenReviewItemFor;
  notify?: typeof notifyManagers;
  hasPushToken?: () => boolean;
  // Stage-1 ladder seams
  createNudge?: typeof createPendingNudge;
  listNudged?: typeof listNudgedSubjectRefs;
  listNudges?: typeof listNudgesByStatus;
  resolveNudge?: typeof markNudgeOutcome;
  // Detector #2 seams
  listCostCandidates?: typeof listCostGapCandidates;
  listCostEvents?: typeof listJobIdsWithCostEvents;
  // The escalation copy carries the planner's own reason, so the sweep reads
  // the decision log. Injected like every other collaborator — un-injected it
  // would make the existing escalation tests hit the database.
  listDecisions?: typeof listDecisionsForNudges;
  // The kind registry, injectable so a test can register a second detector
  // before one exists in production.
  specs?: NudgeKindSpec[];
}

export interface WatchersSummary {
  mode: WatcherMode;
  tenants: number;
  gapsFound: number; // standing snapshot: every current gap in the window
  freshGaps: number; // gaps never surfaced on EITHER rung — what live would act on
  itemsOpened: number;
  itemsResolved: number;
  pushed: number; // tenants that got the count-only line this tick
  pushSkipped: boolean; // true when items opened but no BOARD_BOT_TOKEN
  tenantErrors: number;
  nudgeMode: NudgeMode;
  nudgesWouldCreate: number; // nudge-shadow: gaps the live ladder would have asked about
  nudgesCreated: number;
  // Closed by a FACT: a cancelled visit/job (`moot`), or a gap whose report
  // arrived before anyone was asked (the pre-ask carve-out). Activity on an
  // ALREADY-ASKED gap no longer counts — that close is the planner's.
  nudgesResolved: number;
  // The fail-safe firing: an answered gap whose planner said nothing for a full
  // working day, closed by the sweep at its escalation deadline. Counted apart
  // from nudgesResolved on purpose — this number is not throughput, it is an
  // ALARM. In healthy operation the planner closes and this stays 0 (plan
  // 2026-08-22, Phase 2).
  nudgesAutoClosed: number;
  nudgesEscalated: number; // 24h silence → handed to the manager (rung 2)
  nudgesExpired: number; // never asked within the deadline → manager fallback
  // Per-kind breakdown — the ONLY place a single detector's numbers are
  // readable. The flat counters above are ALL-KIND TOTALS: nudgesCreated,
  // nudgesWouldCreate, nudgesResolved/Escalated/Expired and itemsOpened all
  // sum across detectors. (gapsFound/freshGaps remain visit-only, because the
  // cost pass counts its own candidates into byKind instead.) Read byKind, not
  // the totals, when judging one detector.
  byKind: Record<string, { gapsFound: number; nudgesCreated: number }>;
}

export async function runWatchers(
  nowIso: string,
  mode: WatcherMode,
  deps: WatcherDeps = {},
  nudgeMode: NudgeMode = 'off',
): Promise<WatchersSummary> {
  const listTenants = deps.listTenants ?? listTenantIdsWithTelegramBindings;
  const get = deps.getTenant ?? getTenant;
  const listOverdue = deps.listOverdue ?? listOverdueConfirmedAssignments;
  const listCaptureTimes = deps.listCaptureTimes ?? listJobStampedCaptureTimes;
  const listVisitTimes = deps.listVisitTimes ?? listVisitTimesForJobs;
  const team = deps.listTeam ?? listTeam;
  const listJobs = deps.listJobs ?? listJobsWithCustomerByIds;
  const listEverFlagged = deps.listEverFlagged ?? listEverFlaggedSubjectRefs;
  const listAssignments = deps.listAssignments ?? listAssignmentsByIds;
  const flagGap = deps.flagGap ?? flagOverdueVisitGap;
  const flagNudge = deps.flagNudge ?? flagNudgeGap;
  const findOpenGaps = deps.findOpenGaps ?? findOpenReviewItemsByKind;
  const resolveGap = deps.resolveGap ?? resolveOpenReviewItemFor;
  const notify = deps.notify ?? notifyManagers;
  const hasPushToken = deps.hasPushToken ?? (() => !!process.env.BOARD_BOT_TOKEN);
  const createNudge = deps.createNudge ?? createPendingNudge;
  const listNudged = deps.listNudged ?? listNudgedSubjectRefs;
  const listNudges = deps.listNudges ?? listNudgesByStatus;
  const resolveNudge = deps.resolveNudge ?? markNudgeOutcome;
  const specs = deps.specs ?? NUDGE_KIND_SPECS;
  const listCostCandidates = deps.listCostCandidates ?? listCostGapCandidates;
  const listCostEvents = deps.listCostEvents ?? listJobIdsWithCostEvents;
  const listDecisions = deps.listDecisions ?? listDecisionsForNudges;

  // listTenantIdsWithTelegramBindings, not listTenantSeats: it skips tenants
  // with nobody Telegram-reachable. Today that ALSO excludes the eval tenants
  // — their build-once worlds bind no Telegram ids — but that exclusion is
  // incidental, not enforced (final-review note): if an eval scenario ever
  // binds a Telegram id, add an explicit eval-tenant guard here before it
  // pollutes an untruncatable world.
  const tenantIds = await listTenants();
  const nowMs = Date.parse(nowIso);

  const summary: WatchersSummary = {
    mode,
    tenants: tenantIds.length,
    gapsFound: 0,
    freshGaps: 0,
    itemsOpened: 0,
    itemsResolved: 0,
    pushed: 0,
    pushSkipped: false,
    tenantErrors: 0,
    nudgeMode,
    nudgesWouldCreate: 0,
    nudgesCreated: 0,
    nudgesResolved: 0,
    nudgesAutoClosed: 0,
    nudgesEscalated: 0,
    nudgesExpired: 0,
    byKind: {},
  };
  const bumpKind = (kind: string, field: 'gapsFound' | 'nudgesCreated', by = 1): void => {
    const row = (summary.byKind[kind] ??= { gapsFound: 0, nudgesCreated: 0 });
    row[field] += by;
  };

  for (const tenantId of tenantIds) {
    try {
      const tz = (await get(tenantId))?.timezone ?? 'UTC';
      // Real-UTC instant → the firm's wall clock in the canonical naive-local
      // storage form (booking.ts owns the format). Minute precision.
      const naiveLocal = (iso: string): string =>
        naiveLocalISO(localDateISO(iso, tz), localTimeHHMM(iso, tz));
      // Minute-floored epoch of a naive-local ISO — the compare bound that
      // pairs with naiveLocal's minute precision (see the header note).
      const minuteFloor = (naiveIso: string): number => {
        const ms = Date.parse(naiveIso);
        return ms - (ms % 60_000);
      };

      const from = naiveLocal(new Date(nowMs - LOOKBACK_HOURS * 3_600_000).toISOString());
      const to = naiveLocal(new Date(nowMs - OVERDUE_HOURS * 3_600_000).toISOString());

      const candidates = await listOverdue(tenantId, from, to);
      // EVERY registered kind (plan 2026-08-19, Phase 2). This read used to name
      // one kind as a literal, which meant a COST item — the manager's copy of a
      // cost gap — was never swept at all: it left the queue only when a human
      // dismissed it. Registry-driven now, so a third detector's items are swept
      // the day its spec is registered, not the day someone remembers this line.
      const openItems =
        mode === 'live'
          ? (
              await Promise.all(
                specs.map(async (spec) =>
                  (await findOpenGaps(tenantId, spec.kind)).map((item) => ({ item, spec })),
                ),
              )
            ).flat()
          : [];

      // Detail is watcher-written JSON, read fail-CLOSED at the boundary. jobId
      // ALONE is required now: a job-scoped kind carries no visit window, and
      // demanding startsAtLocal here is exactly what excluded cost items from
      // every path below. The window is passed along as nullable and a kind that
      // NEEDS it declines in its own predicate — the fail-closed judgment moved
      // into the spec, where it is allowed to differ per kind.
      const openGaps = openItems.flatMap(({ item, spec }) => {
        const d = (item.detail ?? {}) as Record<string, unknown>;
        const jobId = typeof d.jobId === 'string' ? d.jobId : null;
        const startsAtLocal =
          typeof d.startsAtLocal === 'string' && !Number.isNaN(Date.parse(d.startsAtLocal))
            ? d.startsAtLocal
            : null;
        return jobId ? [{ item, spec, jobId, startsAtLocal }] : [];
      });

      // Open nudges are swept whenever the WATCHER is live — deliberately
      // regardless of NUDGES_MODE (Phase-2 review finding F1): the fresh
      // pre-filter below excludes ever-nudged assignments in every mode, so
      // if a rollback (NUDGES_MODE unset/shadow) also froze this sweep, an
      // in-flight asked nudge whose technician never replies would reach
      // NEITHER surface, ever — silence must always escalate. Only rung-1
      // CREATION is nudgeMode-gated; in-flight rows keep their lifecycle.
      // (When Stage 1 has never run this read is empty and free.)
      // Malformed context rows are KEPT (unlike openGaps): the status-change
      // resolve needs only subject_ref; only the activity path needs context,
      // so a tampered row can still close when its visit is cancelled — it
      // just never escalates (fail-closed; the guard in the escalation loop
      // below is what skips it).
      const allOpenNudges =
        mode === 'live' ? await listNudges(tenantId, ['pending', 'queued', 'asked']) : [];
      // A kind with no spec is INVISIBLE to every path below — it can never be
      // answered, escalated or expired, and would sit open forever. That used
      // to be a silent hole (the kind was a literal here); now it is filtered
      // in ONE place and shouted about, so the failure is observable.
      const strandedKinds = [
        ...new Set(allOpenNudges.filter((n) => !specFor(n.kind, specs)).map((n) => n.kind)),
      ];
      if (strandedKinds.length > 0) {
        console.error(
          `[watchers] tenant ${tenantId}: open nudges of UNREGISTERED kind(s) ` +
            `${strandedKinds.join(', ')} — not swept, not escalated, not expired`,
        );
      }
      const openNudges = allOpenNudges.filter((n) => !!specFor(n.kind, specs));
      const openNudgeGaps = openNudges.map((n) => {
        const c = (n.context ?? {}) as Record<string, unknown>;
        const jobId = typeof c.jobId === 'string' ? c.jobId : null;
        const startsAtLocal =
          typeof c.startsAtLocal === 'string' && !Number.isNaN(Date.parse(c.startsAtLocal))
            ? c.startsAtLocal
            : null;
        const endsAtLocal =
          typeof c.endsAtLocal === 'string' && !Number.isNaN(Date.parse(c.endsAtLocal))
            ? c.endsAtLocal
            : null;
        return { n, jobId, startsAtLocal, endsAtLocal };
      });

      // ONE batched activity fetch across candidates', open items', AND open
      // nudges' jobs.
      const jobIds = new Set<string>(candidates.map((c) => c.job_id));
      for (const g of openGaps) jobIds.add(g.jobId);
      // jobId ALONE is the gate — NOT jobId && startsAtLocal. A job-scoped gap
      // (cost) has no visit window, and requiring one silently excluded its job
      // from this fetch, so its `filled` predicate could never see the answer.
      for (const x of openNudgeGaps) if (x.jobId) jobIds.add(x.jobId);

      // Per-job LATEST activity, as minute-precision naive-local epoch — only
      // the max ever matters, and one accumulator serves both homes.
      const latestByJob = new Map<string, number>();
      if (jobIds.size > 0) {
        // Floor: the earliest visit START anything below compares against —
        // clamped (never more than MAX_FLOOR_REACH before the window) and
        // widened by the max legal UTC offset. Conservative, bounded, DB-side;
        // the precise compare stays in JS.
        let minNaiveMs = Date.parse(from);
        for (const c of candidates) minNaiveMs = Math.min(minNaiveMs, Date.parse(c.starts_at));
        // A job-scoped item has no visit start to contribute — the window's own
        // start already bounds it (same treatment as the nudge branch below).
        for (const g of openGaps) {
          if (g.startsAtLocal) minNaiveMs = Math.min(minNaiveMs, Date.parse(g.startsAtLocal));
        }
        for (const x of openNudgeGaps) {
          // A job-scoped gap has no start; its context's visit END is the
          // earliest thing its answer could follow, so it serves as the floor
          // hint. Absent both, the window's own start already bounds it.
          const hint = x.startsAtLocal ?? x.endsAtLocal;
          if (hint) minNaiveMs = Math.min(minNaiveMs, Date.parse(hint));
        }
        minNaiveMs = Math.max(minNaiveMs, Date.parse(from) - MAX_FLOOR_REACH_MS);
        const floorUtcIso = new Date(minNaiveMs - MAX_UTC_OFFSET_MS).toISOString();
        const ids = [...jobIds];
        const [captures, visits] = await Promise.all([
          listCaptureTimes(tenantId, ids, floorUtcIso),
          listVisitTimes(tenantId, ids, floorUtcIso),
        ]);
        const note = (jobId: string | null, utcIso: string): void => {
          if (!jobId) return;
          const ms = Date.parse(naiveLocal(utcIso));
          latestByJob.set(jobId, Math.max(latestByJob.get(jobId) ?? -Infinity, ms));
        };
        for (const c of captures) note(c.job_id, c.captured_at);
        for (const v of visits) note(v.job_id, v.created_at);
      }

      // Parse BOTH sides (PostgREST returns '+00:00', naiveLocal emits 'Z' —
      // a string compare would break on the suffix); >= the minute-floored
      // visit START (see the header's "filled" definition).
      const hasActivitySince = (jobId: string, startsAtIso: string): boolean =>
        (latestByJob.get(jobId) ?? -Infinity) >= minuteFloor(startsAtIso);

      const gaps = candidates.filter((c) => !hasActivitySince(c.job_id, c.starts_at));
      summary.gapsFound += gaps.length;
      bumpKind('overdue_visit_gap', 'gapsFound', gaps.length);

      // FRESH = never surfaced on EITHER rung, any status (the batched cap
      // pre-filter, now over BOTH dedup stores — without the nudges read, a
      // nudged gap would look fresh every tick and burn a cap slot
      // re-discovering itself). Read in both modes: freshGaps is the number
      // the shadow→live flip decision needs, since it is exactly what live
      // would act on.
      const gapIds = gaps.map((g) => g.id);
      const [flaggedRefs, nudgedRefs] = await Promise.all([
        listEverFlagged(tenantId, 'overdue_visit_gap', gapIds),
        listNudged(tenantId, 'overdue_visit_gap', gapIds),
      ]);
      const everSurfaced = new Set([...flaggedRefs, ...nudgedRefs]);
      const fresh = gaps.filter((g) => !everSurfaced.has(g.id));
      summary.freshGaps += fresh.length;

      if (mode === 'shadow') continue; // counts only — nothing written, nobody pushed

      // Auto-resolve, two paths. (1) The gap an open item describes has been
      // filled by activity since the visit started. ONE status batch serves
      // items and nudges alike (both key their subject on the assignment id).
      // Only kinds whose subject IS a visit belong in an assignments lookup. A
      // job-scoped kind's subject_ref is a JOB id: passing it here would be a
      // wasted `in()` element and, worse, a claim that the id means something it
      // does not.
      const statusSubjects = [
        ...new Set([
          ...openGaps.filter((g) => g.spec.subjectIsVisit).map((g) => g.item.subject_ref),
          ...openNudgeGaps
            .filter((x) => specFor(x.n.kind, specs)?.subjectIsVisit)
            .map((x) => x.n.subject_ref),
        ]),
      ];
      const statusById = new Map(
        (await listAssignments(tenantId, statusSubjects)).map((a) => [a.id, a.status]),
      );
      // Job statuses, for the sweep's JOB-scoped predicates (a cost gap is moot
      // once its job is cancelled). Same batched discipline as everything else
      // here — one read over ids already in hand, never per row.
      // Nudges AND items: a cost item on a cancelled job must be able to close
      // too, and it has no assignment status to close on.
      const predicateJobIds = [
        ...new Set([
          ...openNudgeGaps.map((x) => x.jobId).filter((v): v is string => !!v),
          ...openGaps.map((g) => g.jobId),
        ]),
      ];
      const jobStatusById = new Map<string, string>(
        predicateJobIds.length === 0
          ? []
          : (await listJobs(tenantId, predicateJobIds))
              .filter((j) => j.tenant_id === tenantId)
              .map((j) => [j.id, j.status]),
      );
      // Which of those jobs carry a LIVE (non-negated) cost. Built over exactly
      // the same id set as jobStatusById, deliberately: a Set populated for only
      // some jobs is a landmine, because `has() === false` would mean either "no
      // cost" or "never asked" and no caller could tell them apart. One batched
      // read, skipped entirely when nothing is open.
      const jobsWithCostEvents = new Set<string>(
        predicateJobIds.length === 0 ? [] : await listCostEvents(tenantId, predicateJobIds),
      );

      // The facts every spec judges against, built ONCE per tenant per tick and
      // shared by both sweeps (items below, nudges further down). A spec takes
      // facts, never a DB client, so it cannot regress this into N queries.
      const facts: SweepFacts = {
        hasActivitySince,
        visitStatusById: statusById,
        jobStatusById,
        naiveLocal,
        jobsWithCostEvents,
      };
      // ONE resolve path for every kind. The two visit predicates that used to be
      // inlined here now live on OVERDUE_VISIT_GAP_SPEC.itemResolved, with their
      // manager-visible copy carried over verbatim; the cost spec answers the
      // different question its item actually asks (did a cost get RECORDED).
      for (const g of openGaps) {
        const resolution = g.spec.itemResolved(
          { subjectRef: g.item.subject_ref, jobId: g.jobId, startsAtLocal: g.startsAtLocal },
          facts,
        );
        if (!resolution) continue;
        const resolved = await resolveGap(
          tenantId,
          g.spec.kind,
          g.item.subject_ref,
          'resolved',
          resolution,
        );
        if (resolved) summary.itemsResolved += 1;
      }

      // Sweep open nudges with the SAME two resolve paths, then collect the
      // silent ones for escalation. A recorded reply lands as a capture, so
      // "nothing to report" mechanically counts as filled (user-ratified
      // 2026-08-16) — only pure silence climbs the ladder.
      let opened = 0;
      // Which KIND each opened item belongs to — the push copy differs, and a
      // cost item is not a visit.
      const openedByKind = { overdue: 0, cost: 0 };
      const escalations: typeof openNudgeGaps = [];
      const expired: typeof openNudgeGaps = [];
      // Rows this tick already took terminal — the pre-ask carve-out and `moot`
      // both close PENDING rows and `continue`. The group expansion below reads
      // `openNudgeGaps`, whose in-memory rows still say 'pending', so without
      // this a sibling closed seconds ago would be handed to a manager anyway.
      const closedThisTick = new Set<string>();

      // When a row's deadline falls. ONE definition, used by the decision read
      // below and by the sweep loop — if the two ever disagreed, the loop could
      // ask about liveness for a gap the read never fetched and treat a live
      // planner as silent.
      //
      // Fail-closed on a malformed stamp: an unparseable escalate_after falls back
      // to the constant rather than escalating immediately or never.
      const dueAtOf = (n: { asked_at: string | null; escalate_after: string | null }): number => {
        const stamped = n.escalate_after ? Date.parse(n.escalate_after) : NaN;
        return Number.isNaN(stamped)
          ? Date.parse(n.asked_at ?? '') + NUDGE_ESCALATE_HOURS * 3_600_000
          : stamped;
      };

      // The planner's own decisions (plan 2026-08-22, Phase 2). This used to be
      // fetched AFTER the loop, for the escalation copy alone; it now GATES the
      // loop, because the fail-safe has to know whether the planner is alive
      // before it closes anything.
      //
      // Scoped to gaps that are AT OR PAST their deadline, not every asked gap.
      // Both consumers need exactly that set — `plannerAlive` is only ever called
      // inside the deadline branch, and every escalation comes from it — so the
      // wider read bought nothing and cost a great deal once the other two phases
      // landed beside it (final-review finding: this read grew on all three axes
      // at once — every 5 minutes, every asked gap, and a history that Phase 3
      // now appends a row to on every tick, over gaps Phase 2 keeps open far
      // longer). This restores its pre-hoist breadth: usually zero rows.
      //
      // Isolated, and the failure direction is deliberate: on a read failure
      // `decisionsReadable` goes false and every gap is treated as having a LIVE
      // planner, so the fail-safe cannot fire. A missing read is not evidence of
      // silence, and the cost of guessing wrong points one way only — failing
      // toward the manager loses nobody's answer, while auto-closing on absent
      // evidence would swallow a real gap and say the planner did it.
      const askedIds = openNudgeGaps
        .filter((x) => x.n.status === 'asked' && !!x.n.asked_at && dueAtOf(x.n) <= nowMs)
        .map((x) => x.n.id);
      let decisions: Awaited<ReturnType<typeof listDecisions>> = new Map();
      let decisionsReadable = true;
      if (askedIds.length > 0) {
        try {
          decisions = await listDecisions(tenantId, askedIds);
        } catch (err) {
          decisionsReadable = false;
          console.error(
            `[watchers] decision read failed for ${tenantId} — escalating without reasons, ` +
              'and the auto-close fail-safe is held back this tick',
            err,
          );
        }
      }
      // Has the planner DECIDED anything about this gap inside the liveness
      // window? Only a real verb counts — see PLANNER_JUDGMENT_ACTIONS for why
      // `unmentioned` must never be in that set. `applied` only: a refused
      // decision did not happen and a shadow one was never carried out, so
      // neither is evidence of a planner that can act on this row.
      const plannerAlive = (nudgeId: string): boolean => {
        if (!decisionsReadable) return true; // fail toward escalation
        const since = nowMs - PLANNER_SILENCE_HOURS * 3_600_000;
        return (decisions.get(nudgeId) ?? []).some(
          (d) =>
            d.outcome === 'applied' &&
            PLANNER_JUDGMENT_ACTIONS.has(d.action) &&
            Date.parse(d.decided_at) > since,
        );
      };

      for (const x of openNudgeGaps) {
        // Present by construction: openNudges was filtered to registered kinds.
        const spec = specFor(x.n.kind, specs)!;
        // `filled` NO LONGER CLOSES (plan 2026-08-22, Phase 2 — user ruling).
        //
        // "Did this answer the question?" is the one thing the sweep decides that
        // is a JUDGMENT rather than a fact, and the sweep is the wrong organ for
        // it: it runs every 5 minutes against a planner that runs every 30, so
        // the fast deterministic thing always won the race. Backwards from the
        // AI-manager premise. Now the gap STAYS OPEN until the planner reads the
        // answer and closes it with a reason and a citation — which is also what
        // finally lets the planner SEE an answer at all, and what makes the
        // two-gaps-on-one-job case judgeable instead of coin-flipped.
        //
        // The predicate itself survives, and is still consulted twice below: by
        // the fail-safe at the deadline, and (via buildGapView) by the planner.
        // What changed is its authority, not its truth.
        //
        // PRE-ASK CARVE-OUT — the one place `filled` still closes, and it is NOT
        // the case the ruling was about.
        //
        // On a row nobody has been asked yet there is no answer to judge; there
        // is only the DETECTOR re-checking its own predicate — "is this still a
        // gap?" — which is a fact, the same class as `moot`. Closing it needs no
        // mind, and NOT closing it does active harm: compose reads pending rows
        // and never re-checks this, and its ask window holds an evening gap until
        // 7am. A report filed at 8pm would then be followed by us asking that
        // technician at 7am how the job went. That is the mouth lying about what
        // the record already knows — exactly what plan ② was built to stop.
        //
        // Without this the delivery deadline is the other victim: an undelivered
        // row whose job HAS a report would sit until 18h and then hand a manager
        // a gap the record already answers, opening an item that self-closes on
        // the next tick. Churn, and a manager's attention spent on nothing.
        //
        // Only the visit spec can fire here; JOB_COST_GAP_SPEC.filled returns at
        // its own `!n.asked_at` guard, correctly — a cost question's predicate is
        // bounded by the ask and means nothing before it.
        if (!x.n.asked_at) {
          const filledBeforeAsking = spec.filled(x.n, facts);
          if (filledBeforeAsking) {
            const closed = await resolveNudge(x.n.id, tenantId, 'answered', filledBeforeAsking);
            if (closed) summary.nudgesResolved += 1;
            closedThisTick.add(x.n.id);
            continue;
          }
        }
        // `moot` is untouched: a cancelled visit or job is a FACT, not a
        // judgment, and there is nothing left for anyone to decide about it.
        const moot = spec.moot(x.n, facts);
        if (moot) {
          const closed = await resolveNudge(x.n.id, tenantId, 'cancelled', moot);
          if (closed) summary.nudgesResolved += 1;
          closedThisTick.add(x.n.id);
          continue;
        }
        // Rung 2. The deadline is now DATA (plan 2026-08-19, Phase 2): the
        // planner may write escalate_after per row, and the 24h constant is what
        // an unwritten row falls back to. That fallback is the fail-safe — if the
        // planner never runs, or crashes, or is rolled back, every row still
        // escalates on the constant, because the safe behaviour lives in the
        // ABSENCE of a value rather than in a writer being healthy.
        //
        // Fail-closed on a malformed stamp: an unparseable escalate_after falls
        // back to the constant rather than escalating immediately or never.
        // asked_at is still REQUIRED — a row that was never asked has no silence
        // to measure, and the delivery-deadline path below owns it instead.
        if (x.n.status === 'asked' && x.n.asked_at) {
          if (dueAtOf(x.n) <= nowMs) {
            // THE FAIL-SAFE (plan 2026-08-22, Phase 2). Closing moved to the
            // planner, so a dead planner would leave every answered gap sitting
            // open until its deadline and then hand the manager a gap claiming
            // nobody answered — with the answer sitting on the job. This is the
            // exact instant that would happen, which is why the fail-safe is
            // anchored here rather than to a new clock of its own: the deadline
            // is already planner-adjustable via `extend` and 48h-capped, so an
            // extend correctly moves BOTH.
            //
            // It fires only when the planner has said nothing about this gap
            // for a full working day. A planner that HAS been deciding here and
            // chose not to close is exercising judgment, not failing — that
            // escalates exactly as it did before.
            const answered = spec.filled(x.n, facts);
            // The gap's own subject line, from its watcher-written context —
            // read fail-closed like everywhere else, and omitted entirely rather
            // than rendered as "'undefined' (undefined)" when it is thin.
            const c = (x.n.context ?? {}) as Record<string, unknown>;
            const title = typeof c.jobTitle === 'string' ? c.jobTitle : null;
            const customer = typeof c.customerName === 'string' ? c.customerName : null;
            // The separator rides WITH the subject, so an absent subject leaves no
            // orphan space or dash at the front of the line.
            const subject = title ? `'${title}'${customer ? ` (${customer})` : ''} — ` : '';
            // ONE OPEN GAP ON THE JOB, or the fail-safe declines.
            //
            // `filled` is JOB-keyed, not question-keyed — it asks "did anything
            // land on this job", and it cannot tell which QUESTION a note
            // answers. With one gap that is unambiguous. With two it is the
            // same-job double-close this plan set out to end: one note would
            // close both, and the cost gap's permanent resolution would read
            // "the technician answered" about a question nobody answered, with
            // the figure never captured and the ledger still blind.
            //
            // Everywhere else this fail-safe fails TOWARD the manager (see the
            // decision-read failure above). It must here too: an ambiguous gap
            // escalates, which loses nobody's answer, rather than closing
            // silently on a guess. Phase 1's stamp cannot rescue this either —
            // it declines on exactly this shape, for exactly this reason.
            const soleGapOnJob =
              !!x.jobId &&
              openNudgeGaps.filter((o) => o.jobId === x.jobId).length === 1;
            if (answered && soleGapOnJob && !plannerAlive(x.n.id)) {
              const closed = await resolveNudge(
                x.n.id,
                tenantId,
                'answered',
                // WHO ACTUALLY READS THIS, checked rather than assumed: nobody
                // today. `nudges.resolution` has no reader outside this file —
                // there is no v_nudges view, query_spine has no grant on the
                // table, and an auto-closed gap returns before the escalation
                // path so it never becomes a manager item either. The live
                // readers are an engineer at a psql prompt and the console line
                // below; the planner joins them when ④ gives it a nudges view.
                //
                // So it is written to stand ALONE. It names the job the way every
                // human-facing string in this ladder does, because a row that
                // cannot say what it is about is useless to all three of those
                // readers — and "it is fine, nobody sees it" is exactly how a
                // string rots into a surface later.
                `${subject}closed automatically — ${answered}. Nobody reviewed it within ` +
                  `${PLANNER_SILENCE_HOURS}h, so the record was closed on the evidence.`,
              );
              if (closed) {
                summary.nudgesAutoClosed += 1;
                console.error(
                  `[watchers] nudge ${x.n.id} auto-closed at its deadline — the answer landed ` +
                    'but the planner never acted. This is the fail-safe firing, not normal ' +
                    'operation: check that the planner is running.',
                );
              }
              continue;
            }
            escalations.push(x);
            continue;
          }
        }
        // Never ASKED within the deadline (Phase-4 review F1): the row is
        // stuck in some way the serve path cannot see — liveness-skipped
        // forever, host-unbound after a recycle (invisible to every pull),
        // or rollback-frozen pending. The activity/status paths above still
        // win; past the deadline, the manager takes the gap.
        if (
          (x.n.status === 'pending' || x.n.status === 'queued') &&
          Date.parse(x.n.created_at) <= nowMs - NUDGE_DELIVERY_DEADLINE_HOURS * 3_600_000
        ) {
          expired.push(x);
        }
      }

      // ONE MESSAGE, ONE FATE (plan 2026-08-25, Phase 2).
      //
      // The deadline above is per-row, against each row's own created_at — but
      // members of an ask-group are minted at different times (a visit gap and a
      // cost gap on one job can be days apart) and only leave together. So the
      // OLDEST member crosses 18h first, and expiring it alone would be wrong
      // twice over: its question is baked into the shared text the box is still
      // serving, so the manager would be told "never delivered" about a question
      // that really does go out; and markNudgeAskedGroup's queued-only guard
      // would then silently omit the terminal row from the ack, leaving the
      // group half-asked.
      //
      // Expanding from `expired` rather than re-deriving means the group's
      // deadline IS its earliest member's, which is the conservative direction:
      // the whole message expires the moment any part of it has waited too long.
      if (expired.length > 0) {
        const inExpired = new Set(expired.map((x) => x.n.id));
        const expiringGroups = new Set(
          expired.map((x) => x.n.ask_group_id).filter((v): v is string => !!v),
        );
        for (const x of expiringGroups.size > 0 ? openNudgeGaps : []) {
          const g = x.n.ask_group_id;
          if (!g || !expiringGroups.has(g)) continue;
          if (inExpired.has(x.n.id) || closedThisTick.has(x.n.id)) continue;
          // Only a row that never went out can expire as never-delivered. An
          // asked sibling is on the escalation clock and owns its own fate.
          if (x.n.status !== 'pending' && x.n.status !== 'queued') continue;
          inExpired.add(x.n.id);
          expired.push(x);
        }
      }

      // Expired handoff: the Stage-0 copy, NEVER the escalation copy — the
      // ask never landed, and the manager must not be told it did. Flag
      // first, close second (the F1 order); malformed contexts stay frozen
      // (logged; the status-change path can still close them).
      for (const x of expired) {
        const spec = specFor(x.n.kind, specs)!;
        // noCostOnLedger ONLY. No plannerReason (nobody planned this — the ask
        // never went out), and no noNoteOrStatusChange: this list holds
        // pending/queued rows, which were never asked, so JOB_COST_GAP_SPEC.filled
        // returns at its `!n.asked_at` guard without ever calling
        // hasActivitySince. A flag that is honest for one kind and vacuous for
        // another is exactly what naming them after the predicate prevents.
        const plan = spec.handoff(x.n, 'expired', naiveLocal, {
          noCostOnLedger: !jobsWithCostEvents.has(x.jobId ?? ''),
        });
        if (!plan) {
          console.error(`[watchers] expired nudge ${x.n.id} unfit for handoff (thin context)`);
          continue;
        }
        // The KIND-GENERIC flagger: a job-scoped gap has no visit window, and
        // the visit flagger's assignment-as-subject convention does not fit it.
        // Both bounds are optional here and omitted from `detail` when absent.
        const item = await flagNudge({
          tenantId,
          kind: spec.kind,
          subjectRef: plan.subjectRef,
          jobId: plan.jobId,
          technicianRef: plan.technicianRef,
          startsAtLocal: plan.startsAtLocal,
          endsAtLocal: plan.endsAtLocal,
          escalatedFromNudge: x.n.id,
          suggestion: plan.suggestion,
        });
        if (item) {
          opened += 1;
          if (spec.kind === 'job_cost_gap') openedByKind.cost += 1;
          else openedByKind.overdue += 1;
        }
        try {
          // pending|queued-scoped (final-review #3): a delivery ack racing
          // this sweep moves the row to 'asked' — the expiry must then LOSE
          // (the 24h escalation owns an asked row's silence), or the audit
          // would claim an ask that actually landed never did.
          const moved = await resolveNudge(
            x.n.id,
            tenantId,
            'failed',
            'never delivered — handed to the manager',
            ['pending', 'queued'],
          );
          if (moved) summary.nudgesExpired += 1;
        } catch (err) {
          console.error(`[watchers] nudge ${x.n.id} expiry mark failed`, err);
        }
      }

      // RUNG 2: silence became the manager's item. Reuses the SAME kind and
      // once-per-assignment-ever dedup as the fallback flag — one assignment
      // can never carry both a fallback item and an escalation item. Copy
      // needs no extra reads: everything rides in the nudge's own context.
      // The guard just below drops malformed-context rows (they re-collect
      // every tick and never escalate — fail-closed; they still close via
      // the status-change path above).
      // `decisions` was read ONCE above, before the sweep loop, because the
      // fail-safe needed it too (plan 2026-08-22, Phase 2). It covers every ASKED
      // gap, which is a superset of `escalations` — every escalation comes from
      // the asked-and-overdue branch. Losing the planner's note is still strictly
      // better than not escalating at all, so a failed read leaves the map empty
      // and the templates take over.
      //
      // Rows come back OLDEST first, so scan backwards for the newest. Only an
      // APPLIED escalate counts: a refused one did not happen, a shadow one was
      // never carried out, and an `extend`'s note would attribute a decision to
      // the planner that it never made about this handoff.
      //
      // handoff_note, NEVER reason. `reason` is diagnostic — it is written for
      // refusals too and is the corpus continual learning will read; putting it
      // in front of a manager was the 2026-08-21 mistake this replaced.
      const plannerEscalation = (
        id: string,
      ): { note: string | null; agentContext: string | null } => {
        const rows = decisions.get(id) ?? [];
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].action === 'escalate' && rows[i].outcome === 'applied') {
            return { note: rows[i].handoff_note, agentContext: rows[i].agent_context };
          }
        }
        return { note: null, agentContext: null };
      };
      for (const x of escalations) {
        const spec = specFor(x.n.kind, specs)!;
        // noCostOnLedger is honest for every kind: jobsWithCostEvents is built
        // over every open nudge's job, so has() === false means "no cost", not
        // "never asked".
        //
        // noNoteOrStatusChange needs BOTH halves backed (see its doc), so it
        // goes only to a kind whose SUBJECT status was actually consulted —
        // which is what subjectIsVisit names. Those kinds' `moot` read
        // visitStatusById and returned null to reach this loop, and that IS the
        // "no status change" half. A job-scoped kind consults no assignment
        // status at all, so it gets no flag. Inert today, because its copy does
        // not render the clause — and "inert today" is exactly how the claims
        // this phase deleted were allowed to survive.
        //
        // THE "no field note" HALF NOW NEEDS AN EXPLICIT CHECK (Phase-2 review
        // finding). It used to be backed implicitly: a `filled`-true row could
        // never reach this loop, because it closed at the top of the sweep. Phase
        // 2 removed that guarantee — an answered gap whose planner is ALIVE and
        // chose not to close it falls through to here — so without this the item
        // would tell a manager "no note or status update since the visit" with
        // the field report sitting on the job. That is precisely the false claim
        // plan ② deleted, re-entering through the door this phase opened.
        const answerable = spec.filled(x.n, facts);
        const pe = plannerEscalation(x.n.id);
        const plan = spec.handoff(x.n, 'escalated', naiveLocal, {
          plannerNote: pe.note,
          ...(pe.agentContext ? { agentContext: pe.agentContext } : {}),
          ...(spec.subjectIsVisit && !answerable ? { noNoteOrStatusChange: true } : {}),
          answerableFromRecord: answerable,
          noCostOnLedger: !jobsWithCostEvents.has(x.jobId ?? ''),
        });
        if (!plan) continue; // malformed context — fail-closed, never escalates
        if (answerable) {
          // THE SHAPE "the planner is wrong" NOW TAKES. Phase 2's fail-safe only
          // catches a planner that is DEAD; a planner that is alive and simply
          // misjudges an answered gap keeps it open until the deadline and it
          // escalates here instead — with the answer sitting on the job and
          // nudgesAutoClosed still reading 0. That is inside the ratified
          // semantics (the planner's judgment stands), but it must not be
          // SILENT, or the one failure mode this ladder can still have has no
          // signal at all.
          console.error(
            `[watchers] nudge ${x.n.id} escalated although its gap is answerable from the ` +
              `record (${answerable}) — the planner had it and did not close it. Not an ` +
              'outage; a judgment worth reviewing.',
          );
        }
        // The KIND-GENERIC flagger: a job-scoped gap has no visit window, and
        // the visit flagger's assignment-as-subject convention does not fit it.
        // Both bounds are optional here and omitted from `detail` when absent.
        const item = await flagNudge({
          tenantId,
          kind: spec.kind,
          subjectRef: plan.subjectRef,
          jobId: plan.jobId,
          technicianRef: plan.technicianRef,
          startsAtLocal: plan.startsAtLocal,
          endsAtLocal: plan.endsAtLocal,
          escalatedFromNudge: x.n.id,
          suggestion: plan.suggestion,
          ...(plan.agentContext ? { agentContext: plan.agentContext } : {}),
        });
        if (item) {
          opened += 1;
          if (spec.kind === 'job_cost_gap') openedByKind.cost += 1;
          else openedByKind.overdue += 1;
        }
        // Mark AFTER the flag: if the flag throws, the nudge stays 'asked'
        // and next tick retries (flagGap's dedup makes the retry converge).
        // The mark itself is isolated (Phase-2 review F2): the item already
        // exists, so its push must still go out this tick even if this write
        // blips — the nudge simply re-escalates next tick and converges on
        // the dedup.
        try {
          const moved = await resolveNudge(
            x.n.id,
            tenantId,
            'escalated',
            // "no reply" is FALSE once something has landed on the job. The
            // durable audit line must say which of the two actually happened.
            answerable
              ? 'not confirmed as answered — handed to the manager'
              : 'no reply — handed to the manager',
          );
          if (moved) summary.nudgesEscalated += 1;
        } catch (err) {
          console.error(`[watchers] nudge ${x.n.id} escalation mark failed`, err);
        }
      }

      // Route fresh gaps — capped at MAX_NEW_ITEMS_PER_TENANT_TICK, oldest
      // scheduled end first (candidates come ordered; the filters preserve
      // it). RUNG 1 when the ladder is live and the technician is reachable;
      // the manager item is the fallback. Every reachable fresh gap in `top`
      // is asked about — there is no per-person gate any more (user ruling
      // 2026-08-18); the per-tick slice is the only volume brake here.
      // TWO brakes, deliberately both. The per-kind one is the RUNAWAY BACKSTOP
      // the deleted per-person cap used to provide incidentally — a MISFIRING
      // detector can only flood its own kind. The tenant-wide ceiling then caps
      // the combined routed count across kinds, so adding a detector can never
      // raise a firm's per-tick volume (5 stays 5, never 5+N).
      //
      // NOT a fairness mechanism, and deliberately so: passes run in order, so
      // a tick with 5 fresh visit gaps spends the whole ceiling and surfaces no
      // cost gaps. They are picked up on a later tick (nothing is dropped — the
      // once-ever stores keep them fresh until asked). Deciding WHICH gaps
      // deserve a scarce slot is exactly the pacing planner's job, and it does
      // not exist yet — see Plan B. Until then, first-come by pass order.
      // Creation is REGISTRY-GATED: a kind with no spec must not be minted at
      // all, because the sweep above cannot resolve, escalate or expire it —
      // creating one would strand it open forever, which is the very failure
      // this registry exists to prevent. Stranding is possible from BOTH ends;
      // filtering the sweep alone would only close one of them.
      const overdueSpec = specFor('overdue_visit_gap', specs);
      let routedThisTick = 0;
      // Sliced by the PER-KIND brake only — the tenant-wide ceiling is enforced
      // inside the loop, so it stays load-bearing when a second kind routes
      // alongside this one (and so a kind brake above the ceiling cannot raise
      // a firm's per-tick volume).
      const top = overdueSpec ? fresh.slice(0, Math.max(0, overdueSpec.maxNewPerTenantTick)) : [];
      if (overdueSpec && top.length > 0) {
        const [teamRows, jobRows] = await Promise.all([
          team(tenantId),
          listJobs(tenantId, [...new Set(top.map((g) => g.job_id))]),
        ]);
        const techById = new Map(teamRows.map((t) => [t.id, t]));
        // The jobs read is tenant-scoped in the query; the re-check below is
        // the id-only-FK belt-and-suspenders (boardRead pattern). Its customer
        // embed carries no tenant_id to re-check — the job-level scope is the
        // enforced guard for the name (noted at final review).
        const jobById = new Map(jobRows.filter((j) => j.tenant_id === tenantId).map((j) => [j.id, j]));
        for (const g of top) {
          // Counts gaps ROUTED (attempted), not writes that landed — a gap
          // whose create/flag returns null (someone else got there first) still
          // spends its slot. That is exactly what the pre-registry
          // `slice(0, MAX_NEW_ITEMS_PER_TENANT_TICK)` metered; counting only
          // successful writes would quietly raise a firm's per-tick volume.
          if (routedThisTick >= MAX_NEW_ITEMS_PER_TENANT_TICK) break;
          routedThisTick += 1;
          const job = jobById.get(g.job_id);
          const title = job?.title ?? 'a job';
          const customer = job?.customers?.name ?? 'unknown customer';
          const tech = g.technician_id ? techById.get(g.technician_id) : undefined;
          // Reachable = someone a bot can actually message first: active,
          // Telegram-bound, with a live sandbox on a known host.
          const reachable =
            !!tech &&
            tech.state === 'active' &&
            !!tech.telegram_user_id &&
            !!tech.sandbox_ref &&
            !!tech.host_id;
          if (reachable && nudgeMode === 'shadow') {
            // nudgesWouldCreate measures REACHABILITY — the shadow→live flip
            // decision's number, and (since the per-person gate is gone)
            // exactly what live would create from this tick's `top`.
            summary.nudgesWouldCreate += 1;
          }
          if (reachable && nudgeMode === 'live') {
            const nudge = await createNudge({
              tenantId,
              // From the SPEC, never a literal — this is the forget-spot the
              // registry exists to remove.
              kind: overdueSpec.kind,
              subjectRef: g.id,
              technicianId: tech.id,
              // Everything compose and escalation will ever need — the model
              // turn sees ONLY this, and rung 2's copy reads it back.
              context: {
                customerName: customer,
                jobTitle: title,
                technicianRef: tech.ref,
                technicianName: tech.display_name,
                assignmentId: g.id,
                jobId: g.job_id,
                startsAtLocal: g.starts_at,
                endsAtLocal: g.ends_at,
                visitEndLabel: wallClockLabel(g.ends_at),
              },
            });
            if (nudge) {
              summary.nudgesCreated += 1; // null = considered concurrently
              bumpKind('overdue_visit_gap', 'nudgesCreated');
            }
            continue; // rung 1 owns this gap — no manager item, no push
          }
          const item = await flagGap({
            tenantId,
            assignmentId: g.id,
            jobId: g.job_id,
            technicianRef: tech?.ref ?? null,
            startsAtLocal: g.starts_at,
            endsAtLocal: g.ends_at,
            // Copy doctrine (user decision 2026-08-16): warm and professional,
            // self-explaining, about the JOB never the person (direction
            // constraint 5), and no operator jargon — managers have never
            // heard the word "spine". The purpose clause ("so the job's
            // record stays complete") is what makes this read as bookkeeping
            // help rather than an audit.
            // The detector's own filter at :452 IS !hasActivitySince.
            suggestion: stage0Suggestion(title, customer, g.ends_at, true),
          });
          if (item) {
            opened += 1; // null = flagged concurrently — not new
            openedByKind.overdue += 1;
          }
        }
      }

      // ── DETECTOR #2: job cost (plan 2026-08-19) ──────────────────────────
      // Deliberately a SEPARATE pass, not a widened visit query: its subject is
      // the JOB, its window anchor is the assignment end only because that is
      // what supplies a technician to ask, and its "fresh" test is a different
      // question (does a cost exist?) than the visit one (did anything land?).
      const costSpec = specFor('job_cost_gap', specs);
      if (costSpec && nudgeMode !== 'off') {
        const costCandidates = await listCostCandidates(tenantId, from, to);
        if (costCandidates.length > 0) {
          const costJobIds = costCandidates.map((c) => c.jobId);
          // Three filters, all batched: already has a cost, ever flagged, ever
          // nudged. The last two are the same once-ever stores the visit
          // detector uses — they already take a kind.
          const [withCost, flaggedCost, nudgedCost] = await Promise.all([
            listCostEvents(tenantId, costJobIds),
            listEverFlagged(tenantId, 'job_cost_gap', costJobIds),
            listNudged(tenantId, 'job_cost_gap', costJobIds),
          ]);
          const surfaced = new Set([...withCost, ...flaggedCost, ...nudgedCost]);
          const freshCost = costCandidates.filter((c) => !surfaced.has(c.jobId));
          bumpKind('job_cost_gap', 'gapsFound', freshCost.length);

          const costTop = freshCost.slice(0, Math.max(0, costSpec.maxNewPerTenantTick));
          if (costTop.length > 0) {
            const teamRows = await team(tenantId);
            const techById = new Map(teamRows.map((t) => [t.id, t]));
            for (const c of costTop) {
              // The SAME tenant-wide ceiling the visit pass spends from — a
              // second detector must not raise a firm's per-tick volume.
              if (routedThisTick >= MAX_NEW_ITEMS_PER_TENANT_TICK) break;
              routedThisTick += 1;
              const tech = techById.get(c.technicianId);
              const reachable =
                !!tech &&
                tech.state === 'active' &&
                !!tech.telegram_user_id &&
                !!tech.sandbox_ref &&
                !!tech.host_id;
              const title = c.jobTitle ?? 'a job';
              const customer = c.customerName ?? 'unknown customer';
              if (reachable && nudgeMode === 'shadow') {
                summary.nudgesWouldCreate += 1;
              }
              if (reachable && nudgeMode === 'live') {
                const nudge = await createNudge({
                  tenantId,
                  kind: costSpec.kind,
                  // The JOB, not the assignment — the only kind whose subject
                  // is not a visit. uq_nudges_subject_ever therefore asks once
                  // per job FOREVER (accepted limitation, see the spec).
                  subjectRef: c.jobId,
                  technicianId: c.technicianId,
                  context: {
                    customerName: customer,
                    jobTitle: title,
                    technicianRef: tech.ref,
                    technicianName: tech.display_name,
                    jobId: c.jobId,
                    endsAtLocal: c.endsAtLocal,
                  },
                });
                if (nudge) {
                  summary.nudgesCreated += 1;
                  bumpKind('job_cost_gap', 'nudgesCreated');
                }
                continue; // rung 1 owns it
              }
              // Unreachable technician → the manager takes it, same as rung 1's
              // fallback. Job-scoped, so no visit window.
              const item = await flagNudge({
                tenantId,
                kind: costSpec.kind,
                subjectRef: c.jobId,
                jobId: c.jobId,
                technicianRef: tech?.ref ?? null,
                // The claim is backed by this detector's own filter: freshCost
                // excludes every job already in withCost (the ledger read). The
                // CONCLUSION "so the job's costs are incomplete" is deleted — a
                // job with no parts has complete costs.
                suggestion:
                  `'${title}' (${customer}) — nothing recorded yet about what it cost in parts ` +
                  `or materials. Tell me the figure and I'll put it on the books.`,
              });
              if (item) {
                opened += 1;
                openedByKind.cost += 1;
              }
            }
          }
        }
      }
      summary.itemsOpened += opened;

      // ONE count-only line per tenant per tick, only when something NEW
      // opened (the ever-flagged filter means a quiet queue never re-pings on
      // any cadence). No names/PII in the push — the queue holds the detail.
      // Same copy doctrine as the suggestion: warm, no jargon, real plurals.
      if (opened > 0) {
        if (hasPushToken()) {
          // Kind-aware copy: a cost item is not a visit, and telling a manager
          // "a recent visit has nothing on record" when the item is actually
          // about parts cost is simply false. Visit-only tenants keep the exact
          // wording they have today.
          // Plan ② (2026-08-21): this line knows ONE thing — how many items just
          // opened, and of which kind. It used to assert the RECORD's state
          // ("has no parts cost on record yet", "has nothing on record yet")
          // from a count, and the cost wording was reachably FALSE: a cost nudge
          // escalates even when the ledger HAS the cost, because
          // JOB_COST_GAP_SPEC.filled ignores it (①'s ratified decision). The
          // manager got a push saying no cost was on record about an item whose
          // own copy correctly claimed nothing of the kind. It now says what
          // opened, which is true by construction.
          const costOnly = openedByKind.overdue === 0 && openedByKind.cost > 0;
          const mixed = openedByKind.overdue > 0 && openedByKind.cost > 0;
          const line =
            mixed ?
              `Heads-up: ${opened} recent jobs have open questions on them — they’re waiting in your pending reviews whenever you have a minute.`
            : costOnly ?
              opened === 1 ?
                'Heads-up: a recent job has an open question about its parts cost — it’s waiting in your pending reviews whenever you have a minute.'
              : `Heads-up: ${opened} recent jobs have open questions about their parts cost — they’re waiting in your pending reviews whenever you have a minute.`
            : opened === 1 ?
              'Heads-up: a recent visit has an open question on it — it’s waiting in your pending reviews whenever you have a minute.'
            : `Heads-up: ${opened} recent visits have open questions on them — they’re waiting in your pending reviews whenever you have a minute.`;
          await notify(tenantId, line);
          summary.pushed += 1;
        } else {
          summary.pushSkipped = true;
        }
      }
    } catch (err) {
      // One tenant's failure never blocks the siblings (lifecycle step idiom).
      summary.tenantErrors += 1;
      console.error(`[watchers] tenant ${tenantId} failed`, err);
    }
  }

  return summary;
}
