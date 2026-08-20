import {
  createPendingNudge,
  listCostGapCandidates,
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
import { localDateISO, localTimeHHMM } from '../schedule/availability.js';
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
// (48h of silence after the ask). NUDGES_MODE gates it independently of
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
// stays as the per-tenant surge brake. 48h of post-ask silence escalates.
// Code constants, not env (the OVERDUE_HOURS pattern: one tuning surface).
//
// The deleted counter was ALSO, incidentally, the brake on a misfiring
// detector. That backstop must return per-detector: today's margin comes from
// having exactly ONE well-tested detector, not from the design, so detector #2
// must land with its own brake. See
// thoughts/shared/research/2026-08-19-nudge-pacing-replacement-design.md (§5).
export const NUDGE_ESCALATE_HOURS = 48;
// A nudge still not ASKED this long after creation is stuck in some silent
// way the serve path cannot see (Phase-4 review F1: an offboarded technician
// is liveness-skipped forever; a recycled sandbox clears host_id, making the
// row invisible to EVERY pull's inner join; a rollback freezes pending rows).
// The ask is not happening — the manager takes the gap. Long enough for a
// rebind to heal a recycle first, and for the compose ask window's longest
// overnight hold (12h; 13h on a DST fall-back night) with room to spare — a window
// that ever excludes whole DAYS must lengthen this deadline with it, or
// weekend-held rows expire to the manager without the tech ever being asked.
export const NUDGE_DELIVERY_DEADLINE_HOURS = 24;

// UTC offsets span −12h..+14h; subtracting 14h from a wall-clock instant is a
// floor no real timezone's UTC reading can undershoot.
const MAX_UTC_OFFSET_MS = 14 * 3_600_000;

// Human label for a naive-local timestamp: "Saturday, Aug 15 at 4:00 PM".
// The input already IS the firm's wall clock (stored as if UTC), so we format
// it in UTC — no timezone math — and the weekday comes from Intl over the
// same string, so the weekday-date pair can never disagree (the weekday-guard
// doctrine: fused derivation, not model arithmetic).
export function wallClockLabel(naiveIso: string): string {
  const d = new Date(Date.parse(naiveIso));
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
  nudgesResolved: number; // answered (activity) or cancelled (status change)
  nudgesEscalated: number; // 48h silence → handed to the manager (rung 2)
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
      for (const x of openNudgeGaps) {
        // Present by construction: openNudges was filtered to registered kinds.
        const spec = specFor(x.n.kind, specs)!;
        const filled = spec.filled(x.n, facts);
        if (filled) {
          const closed = await resolveNudge(x.n.id, tenantId, 'answered', filled);
          if (closed) summary.nudgesResolved += 1;
          continue;
        }
        const moot = spec.moot(x.n, facts);
        if (moot) {
          const closed = await resolveNudge(x.n.id, tenantId, 'cancelled', moot);
          if (closed) summary.nudgesResolved += 1;
          continue;
        }
        // Rung 2. The deadline is now DATA (plan 2026-08-19, Phase 2): the
        // planner may write escalate_after per row, and the 48h constant is what
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
          const stamped = x.n.escalate_after ? Date.parse(x.n.escalate_after) : NaN;
          const dueAt = Number.isNaN(stamped)
            ? Date.parse(x.n.asked_at) + NUDGE_ESCALATE_HOURS * 3_600_000
            : stamped;
          if (dueAt <= nowMs) {
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

      // Expired handoff: the Stage-0 copy, NEVER the escalation copy — the
      // ask never landed, and the manager must not be told it did. Flag
      // first, close second (the F1 order); malformed contexts stay frozen
      // (logged; the status-change path can still close them).
      for (const x of expired) {
        const spec = specFor(x.n.kind, specs)!;
        const plan = spec.handoff(x.n, 'expired', naiveLocal);
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
          // (the 48h escalation owns an asked row's silence), or the audit
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
      for (const x of escalations) {
        const spec = specFor(x.n.kind, specs)!;
        const plan = spec.handoff(x.n, 'escalated', naiveLocal);
        if (!plan) continue; // malformed context — fail-closed, never escalates
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
            'no reply — handed to the manager',
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
            suggestion: stage0Suggestion(title, customer, g.ends_at),
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
                suggestion:
                  `Nothing is recorded about what the '${title}' job (${customer}) cost in ` +
                  `parts or materials, so the job's costs are incomplete. Worth checking what ` +
                  `was picked up for it. If there were no parts, just dismiss this.`,
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
          const costOnly = openedByKind.overdue === 0 && openedByKind.cost > 0;
          const mixed = openedByKind.overdue > 0 && openedByKind.cost > 0;
          const line =
            mixed ?
              `Heads-up: ${opened} recent jobs have something missing from their record — they’re waiting in your pending reviews whenever you have a minute.`
            : costOnly ?
              opened === 1 ?
                'Heads-up: a recent job has no parts cost on record yet — it’s waiting in your pending reviews whenever you have a minute.'
              : `Heads-up: ${opened} recent jobs have no parts cost on record yet — they’re waiting in your pending reviews whenever you have a minute.`
            : opened === 1 ?
              'Heads-up: a recent visit has nothing on record yet — it’s waiting in your pending reviews whenever you have a minute.'
            : `Heads-up: ${opened} recent visits have nothing on record yet — they’re waiting in your pending reviews whenever you have a minute.`;
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
