import {
  createObservation,
  listCostGapCandidates,
  listDecisionsForNudges,
  listJobIdsWithCostEvents,
  findOpenReviewItemsByKind,
  getTenant,
  listAssignmentsByIds,
  listEverFlaggedSubjectRefs,
  listJobStampedCaptureTimes,
  listJobsWithCustomerByIds,
  listNudgedSubjectRefs,
  listNudgesByStatus,
  listObservationsByStatus,
  listObservedSubjectRefs,
  listOverdueConfirmedAssignments,
  listTeam,
  listTenantIdsWithTelegramBindings,
  listVisitTimesForJobs,
  readSettingsTolerantly,
  resolveOpenReviewItemFor,
} from '../db/index.js';
import {
  NUDGE_KIND_SPECS,
  specFor,
  type NudgeKindSpec,
  type SweepFacts,
} from './nudgeKinds.js';
// No cycle: nudgeQueue imports only from src/db and composeCopy.
import { MAX_DELIVERY_ATTEMPTS, MAX_SERVE_COUNT } from '../control/nudgeQueue.js';
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
//   - once per assignment EVER (uq_observations_subject_ever owns this since
//     plan 2026-08-31; the older nudge/item stores keep pre-split history from
//     re-surfacing);
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

// NUDGES_MODE IS GONE (build 5). It gated rung-1 creation back when detection
// implied a question; build 4 made detection a recording (observations), build
// 5 made every remaining judgment the planner's, and the mode had nothing left
// to gate. Delete the env var from the lifecycle-heart service at deploy time.

// THE THREE DETECTION PARAMETERS ARE NO LONGER READ HERE. They live in
// src/db/tenantSettings.ts as the FALLBACKS a firm that has recorded none of its
// own falls back to, and this sweep reads the RESOLVED per-firm values instead
// (plan 2026-08-29 "the firm is data"). Re-exported with their full history so
// every existing importer, and every reader of this file, still finds them where
// they have always been — but there is exactly ONE definition.
//
// The declarations had to move DOWN rather than the fallbacks move UP: `src/db/`
// is a leaf, and importing these from a job would have made the database layer
// depend on one.
//
// The rule that governed which constants could move per-firm still stands for
// the future: a constant may become per-firm only when EVERY call-site that
// reads it holds a tenant id. (The clock constants this note used to name died
// with the acting clocks, build 5.)
export { OVERDUE_HOURS, LOOKBACK_HOURS } from '../db/tenantSettings.js';

// THE ACTING CLOCKS ARE GONE (build 5, user ruling 1 — plan 2026-08-31
// "the sweep stops deciding"). NUDGE_ESCALATE_HOURS (24), NUDGE_ESCALATE_MAX_
// HOURS (48), NUDGE_DELIVERY_DEADLINE_HOURS (18) and PLANNER_SILENCE_HOURS
// (24) all fired handoffs or closes from here; nothing escalates, expires or
// auto-closes on a clock any more — the planner ends every gap. What replaced
// them is the ALARM pass below: WATCH thresholds inheriting the dead
// deadlines' numbers, chosen not re-derived, firing NOTHING. Alarm, never
// actor — and never `ok = false` (a permanently stuck row reddening every
// five minutes forever is the alarm-fatigue trap; `npm run ticks` and stderr
// are the operator surface).
//
// The pass lives in the SWEEP so it survives planner death — the one thing an
// alarm about planner neglect must do (the build-4 stale counter lived inside
// the planner and went dark exactly when the planner did).
export const ASK_UNATTENDED_ALARM_HOURS = 24;
export const DELIVERY_STUCK_ALARM_HOURS = 18;
// Moved here from planner.ts (same value, new home — build 4's counter,
// re-homed): open observations this old with no applied decision beyond
// `leave` inside the window. Looking is not acting.
export const OBSERVATION_STALE_HOURS = 72;

// What counts as the planner having DECIDED something about a gap.
//
// The fail-safe that used to read this is gone (build 5); its consumer now is
// the ALARM pass — "unattended" means no applied action from THIS set inside
// the window. The hazard is unchanged: `unmentioned` is written for every gap
// the planner merely LOOKED at, so putting it in this set would make every gap
// read as attended on every tick and the alarm would never say anything.
//
// Adding a new planner action means adding it HERE too. Exported so a test pins
// exactly that, rather than trusting a future reader to remember. `extend`
// left the set when the verb retired with the escalation clock (build 5).
export const PLANNER_JUDGMENT_ACTIONS: ReadonlySet<string> = new Set([
  'send',
  'hold',
  'close',
  'escalate',
  'leave',
  'dismiss',
  'recover',
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
  findOpenGaps?: typeof findOpenReviewItemsByKind;
  resolveGap?: typeof resolveOpenReviewItemFor;
  // Detection-records seams (plan 2026-08-31): the mint writes observations.
  createObservation?: typeof createObservation;
  listObserved?: typeof listObservedSubjectRefs;
  listNudged?: typeof listNudgedSubjectRefs;
  // Detector #2 seams
  listCostCandidates?: typeof listCostGapCandidates;
  listCostEvents?: typeof listJobIdsWithCostEvents;
  // The ALARM pass's reads (build 5): open asks, open observations, and the
  // decision log for exactly the rows past a threshold.
  listNudges?: typeof listNudgesByStatus;
  listOpenObservations?: typeof listObservationsByStatus;
  listDecisions?: typeof listDecisionsForNudges;
  // The firm's own detection thresholds. Injected like every other collaborator
  // — un-injected, a fixture tenant id that is not a uuid throws 22P02 inside the
  // per-tenant catch and every tenantErrors assertion in the suite fails.
  getSettings?: typeof readSettingsTolerantly;
  // The kind registry, injectable so a test can register a second detector
  // before one exists in production.
  specs?: NudgeKindSpec[];
}

export interface WatchersSummary {
  mode: WatcherMode;
  tenants: number;
  gapsFound: number; // standing snapshot: every current gap in the window
  freshGaps: number; // gaps never surfaced anywhere — what live records
  itemsResolved: number; // the manager queue self-cleaning (the one judgment kept)
  tenantErrors: number;
  // Detection's whole output: fresh findings recorded as observations,
  // uncapped (the record is unbounded — user direction 2026-08-31). The sweep
  // creates nothing else, closes nothing, escalates nothing and expires
  // nothing (build 5) — every counter those paths carried is gone with them.
  observationsCreated: number;
  // Per-kind breakdown — the ONLY place a single detector's numbers are
  // readable. (gapsFound/freshGaps remain visit-only, because the cost pass
  // counts its own candidates into byKind instead.)
  byKind: Record<string, { gapsFound: number; observationsCreated: number }>;
  // THE ALARMS (build 5): what the acting clocks became. Counters only —
  // nothing fires on them and they never redden a tick. Totals across
  // tenants; the per-tenant detail is on stderr, and `npm run ticks` prints
  // the ⚠ line from the latest run.
  alarms: {
    // Asked gaps ≥24h old with no applied planner judgment inside the window.
    asksUnattended: number;
    // pending/queued rows ≥18h old, or frozen at the serve/attempt caps.
    deliveryStuck: number;
    // Open observations ≥72h old, untouched (leave excluded) in the window.
    observationsStale: number;
  };
  // tenant_settings has not been migrated to this database yet, so every firm ran
  // on the global defaults. Present ONLY when true — an operator condition, not a
  // routine counter. It does NOT make the tick unhealthy: the sweep is unaffected
  // (see the read below), and turning the heartbeat red for a self-resolving
  // deploy window is the alarm-fatigue failure the cost-ledger skip gates exist to
  // avoid. It is here so the condition reaches a SUMMARY and not only a log line.
  settingsTableMissing?: boolean;
}

export async function runWatchers(
  nowIso: string,
  mode: WatcherMode,
  deps: WatcherDeps = {},
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
  const findOpenGaps = deps.findOpenGaps ?? findOpenReviewItemsByKind;
  const resolveGap = deps.resolveGap ?? resolveOpenReviewItemFor;
  const createObs = deps.createObservation ?? createObservation;
  const listObserved = deps.listObserved ?? listObservedSubjectRefs;
  const listNudged = deps.listNudged ?? listNudgedSubjectRefs;
  const specs = deps.specs ?? NUDGE_KIND_SPECS;
  const listCostCandidates = deps.listCostCandidates ?? listCostGapCandidates;
  const listCostEvents = deps.listCostEvents ?? listJobIdsWithCostEvents;
  const listNudges = deps.listNudges ?? listNudgesByStatus;
  const listOpenObs = deps.listOpenObservations ?? listObservationsByStatus;
  const listDecisions = deps.listDecisions ?? listDecisionsForNudges;
  const getSettings = deps.getSettings ?? readSettingsTolerantly;

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
    itemsResolved: 0,
    tenantErrors: 0,
    observationsCreated: 0,
    byKind: {},
    alarms: { asksUnattended: 0, deliveryStuck: 0, observationsStale: 0 },
  };
  const bumpKind = (
    kind: string,
    field: 'gapsFound' | 'observationsCreated',
    by = 1,
  ): void => {
    const row = (summary.byKind[kind] ??= { gapsFound: 0, observationsCreated: 0 });
    row[field] += by;
  };

  for (const tenantId of tenantIds) {
    try {
      // ONE read per firm per tick, not one per gap — paired with the tenant read
      // it already pays for. An absent ROW is the common case and resolves to the
      // global defaults, so an empty tenant_settings table is byte-for-byte the
      // behaviour that shipped before this existed.
      //
      // AN ABSENT TABLE IS TOLERATED HERE, and this is the only place that
      // decides so. Render deploys run NO migrations, so the window between
      // merging this and applying the migration is a certainty. In that window
      // the honest answer to "what has this firm recorded?" is "nothing", which
      // resolves to exactly the pre-Phase-2 constants — so the sweep runs
      // normally. Rethrowing would fail EVERY tenant, and since the read is the
      // first statement of the loop body that means no detection, no escalation,
      // no delivery fail-safe and no manager push for anyone, plus a heartbeat
      // alarming every five minutes on a condition that fixes itself.
      //
      // Only the missing RELATION is tolerated. Every other failure — permission,
      // a bad uuid, a dead connection — throws into the per-tenant catch below and
      // keeps its containment.
      const [tenantRow, read] = await Promise.all([get(tenantId), getSettings(tenantId)]);
      const tz = tenantRow?.timezone ?? 'UTC';
      const settings = read.settings;
      if (read.tableMissing && !summary.settingsTableMissing) {
        summary.settingsTableMissing = true;
        console.warn(
          '[watchers] tenant_settings is not migrated here yet — every firm is running on the ' +
            'global defaults. Apply supabase/migrations/20260829120000_tenant_settings.sql.',
        );
      }
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

      const from = naiveLocal(new Date(nowMs - settings.lookbackHours * 3_600_000).toISOString());
      const to = naiveLocal(new Date(nowMs - settings.overdueHours * 3_600_000).toISOString());

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

      // THE OPEN-NUDGE AND OPEN-OBSERVATION SWEEPS ARE GONE (build 5): no
      // moot close, no fail-safe, no escalation, no expiry — the planner ends
      // every gap, and the alarm pass (Phase 4) is what watches the ones it
      // neglects. The batched reads below serve the ITEM auto-resolve alone.
      // ONE batched activity fetch across candidates' and open items' jobs.

      const jobIds = new Set<string>(candidates.map((c) => c.job_id));
      for (const g of openGaps) jobIds.add(g.jobId);

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
      const [flaggedRefs, nudgedRefs, observedRefs] = await Promise.all([
        listEverFlagged(tenantId, 'overdue_visit_gap', gapIds),
        listNudged(tenantId, 'overdue_visit_gap', gapIds),
        // The store that owns "noticed once, ever" from here on; the older two
        // keep pre-split history from re-surfacing (plan 2026-08-31).
        listObserved(tenantId, 'overdue_visit_gap', gapIds),
      ]);
      const everSurfaced = new Set([...flaggedRefs, ...nudgedRefs, ...observedRefs]);
      const fresh = gaps.filter((g) => !everSurfaced.has(g.id));
      summary.freshGaps += fresh.length;

      if (mode === 'shadow') continue; // counts only — nothing written, nobody pushed

      // Auto-resolve: the ONE judgment the sweep keeps (build 5, user ruling
      // 5) — a manager's queue item whose ask has since been satisfied closes
      // itself. Only kinds whose subject IS a visit belong in an assignments
      // lookup: a job-scoped kind's subject_ref is a JOB id.
      const statusSubjects = [
        ...new Set(
          openGaps.filter((g) => g.spec.subjectIsVisit).map((g) => g.item.subject_ref),
        ),
      ];
      const statusById = new Map(
        (await listAssignments(tenantId, statusSubjects)).map((a) => [a.id, a.status]),
      );
      // Job statuses, for the item sweep's JOB-scoped predicates (a cost item
      // on a cancelled job closes). One batched read over ids in hand.
      const predicateJobIds = [...new Set(openGaps.map((g) => g.jobId))];
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

      // The facts every spec judges against, built ONCE per tenant per tick —
      // the item sweep is their only consumer now (build 5). A spec takes
      // facts, never a DB client, so it cannot regress this into N queries.
      const facts: SweepFacts = {
        hasActivitySince,
        visitStatusById: statusById,
        jobStatusById,
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

      // (The nudge sweep, the observation moot pass, the deadline fail-safe,
      // the escalation and expiry loops and the group-expiry expansion all
      // stood here until build 5. Nothing in this function touches a nudge or
      // an observation's STATE any more.)

      // ── MINTING became RECORDING (plan 2026-08-31 "a gap is not an ask") ──
      // Every fresh gap becomes an OBSERVATION — no cap, no reachability test,
      // no manager fallback. The caps died WITH the ask-at-detection design:
      // they metered questions (a scarce claim on a person's attention), and an
      // observation asks nobody anything. Deciding which gaps deserve a message
      // is now wholly the planner's, which is what the per-tick slice was a
      // stand-in for all along ("Deciding WHICH gaps deserve a scarce slot is
      // exactly the pacing planner's job" — the old comment here, now true).
      // The caps are DELETED (build 5); the once-ever store is
      // uq_observations_subject_ever, and dismissal — the planner's, revisable
      // — is what stops re-surfacing.
      //
      // The technician lookup SURVIVES as context enrichment only: who the
      // detector THINKS could answer rides along advisorily (observations
      // migration header). Unreachable, unknown, or absent — the observation
      // is recorded the same.
      //
      // Creation stays REGISTRY-GATED: a kind with no spec must not be minted
      // at all (the sweep above cannot resolve, escalate or expire its asks).
      const overdueSpec = specFor('overdue_visit_gap', specs);
      if (overdueSpec && fresh.length > 0) {
        const [teamRows, jobRows] = await Promise.all([
          team(tenantId),
          listJobs(tenantId, [...new Set(fresh.map((g) => g.job_id))]),
        ]);
        const techById = new Map(teamRows.map((t) => [t.id, t]));
        // The jobs read is tenant-scoped in the query; the re-check below is
        // the id-only-FK belt-and-suspenders (boardRead pattern).
        const jobById = new Map(jobRows.filter((j) => j.tenant_id === tenantId).map((j) => [j.id, j]));
        for (const g of fresh) {
          const job = jobById.get(g.job_id);
          const title = job?.title ?? 'a job';
          const customer = job?.customers?.name ?? 'unknown customer';
          const tech = g.technician_id ? techById.get(g.technician_id) : undefined;
          const obs = await createObs({
            tenantId,
            // From the SPEC, never a literal — the forget-spot the registry
            // exists to remove.
            kind: overdueSpec.kind,
            subjectRef: g.id,
            technicianId: tech?.id ?? null,
            // Everything the planner's view and a later send will ever need —
            // the same shape nudges.context has always carried; the send
            // copies it across verbatim.
            context: {
              customerName: customer,
              jobTitle: title,
              ...(tech ? { technicianRef: tech.ref, technicianName: tech.display_name } : {}),
              assignmentId: g.id,
              jobId: g.job_id,
              startsAtLocal: g.starts_at,
              endsAtLocal: g.ends_at,
              visitEndLabel: wallClockLabel(g.ends_at),
            },
          });
          if (obs) {
            summary.observationsCreated += 1; // null = noticed concurrently
            bumpKind('overdue_visit_gap', 'observationsCreated');
          }
        }
      }

      // ── DETECTOR #2: job cost (plan 2026-08-19) ──────────────────────────
      // Deliberately a SEPARATE pass, not a widened visit query: its subject is
      // the JOB, its window anchor is the assignment end only because that is
      // what supplies a technician who might know, and its "fresh" test is a
      // different question (does a cost exist?) than the visit one.
      //
      // UNGATED BY nudgeMode (plan 2026-08-31, review F2): the old wrapper
      // `nudgeMode !== 'off'` gated the ENTIRE pass — candidates, dedup,
      // fallback — because detection used to IMPLY an ask and the mode gated
      // asking. Recording an observation asks nobody anything, so detection
      // now gates on watcher mode alone (this code is unreachable in shadow —
      // the `continue` above).
      const costSpec = specFor('job_cost_gap', specs);
      if (costSpec) {
        const costCandidates = await listCostCandidates(tenantId, from, to);
        if (costCandidates.length > 0) {
          const costJobIds = costCandidates.map((c) => c.jobId);
          // Four filters, all batched: already has a cost, ever flagged, ever
          // nudged, ever OBSERVED — the last is the store that owns "noticed
          // once, ever" from here on; the older two keep pre-split history
          // from re-surfacing.
          const [withCost, flaggedCost, nudgedCost, observedCost] = await Promise.all([
            listCostEvents(tenantId, costJobIds),
            listEverFlagged(tenantId, 'job_cost_gap', costJobIds),
            listNudged(tenantId, 'job_cost_gap', costJobIds),
            listObserved(tenantId, 'job_cost_gap', costJobIds),
          ]);
          const surfaced = new Set([...withCost, ...flaggedCost, ...nudgedCost, ...observedCost]);
          const freshCost = costCandidates.filter((c) => !surfaced.has(c.jobId));
          bumpKind('job_cost_gap', 'gapsFound', freshCost.length);

          if (freshCost.length > 0) {
            const teamRows = await team(tenantId);
            const techById = new Map(teamRows.map((t) => [t.id, t]));
            for (const c of freshCost) {
              // No cap, no reachability, no manager fallback — the visit
              // pass's reasoning, verbatim (see the block above).
              const tech = techById.get(c.technicianId);
              const title = c.jobTitle ?? 'a job';
              const customer = c.customerName ?? 'unknown customer';
              const obs = await createObs({
                tenantId,
                kind: costSpec.kind,
                // The JOB, not the assignment — the only kind whose subject is
                // not a visit. uq_observations_subject_ever therefore notices
                // once per job FOREVER (the accepted limitation moved store).
                subjectRef: c.jobId,
                technicianId: tech?.id ?? null,
                context: {
                  customerName: customer,
                  jobTitle: title,
                  ...(tech ? { technicianRef: tech.ref, technicianName: tech.display_name } : {}),
                  jobId: c.jobId,
                  endsAtLocal: c.endsAtLocal,
                },
              });
              if (obs) {
                summary.observationsCreated += 1;
                bumpKind('job_cost_gap', 'observationsCreated');
              }
            }
          }
        }
      }

      // ── THE ALARM PASS (build 5) ─────────────────────────────────────────
      // What the acting clocks became: three counters that watch what the
      // planner is neglecting and what delivery has broken, shouted to stderr
      // and the tick record, acting on NOTHING. In the sweep so it survives
      // planner death. Its own try/catch: a broken alarm must not cost the
      // tenant its detection.
      try {
        const [openNudges, openObs] = await Promise.all([
          listNudges(tenantId, ['pending', 'queued', 'asked']),
          listOpenObs(tenantId, ['open']),
        ]);
        const deliveryStuckRows = openNudges.filter(
          (n) =>
            (n.status === 'pending' || n.status === 'queued') &&
            (Date.parse(n.created_at) <= nowMs - DELIVERY_STUCK_ALARM_HOURS * 3_600_000 ||
              n.serve_count >= MAX_SERVE_COUNT ||
              n.attempts >= MAX_DELIVERY_ATTEMPTS),
        );
        // Decisions are read for exactly the rows past a threshold — usually
        // zero — never for every open gap (the pre-hoist scoping discipline).
        const askCandidates = openNudges.filter(
          (n) =>
            n.status === 'asked' &&
            !!n.asked_at &&
            Date.parse(n.asked_at) <= nowMs - ASK_UNATTENDED_ALARM_HOURS * 3_600_000,
        );
        const staleCandidates = openObs.filter(
          (o) => Date.parse(o.noticed_at) <= nowMs - OBSERVATION_STALE_HOURS * 3_600_000,
        );
        let decisions: Awaited<ReturnType<typeof listDecisions>> = new Map();
        let decisionsReadable = true;
        const candidateIds = [...askCandidates.map((n) => n.id), ...staleCandidates.map((o) => o.id)];
        if (candidateIds.length > 0) {
          try {
            decisions = await listDecisions(tenantId, candidateIds);
          } catch (err) {
            // Fail TOWARD alarming: a missing read is not evidence of
            // attention, so every candidate counts.
            decisionsReadable = false;
            console.error(`[watchers] tenant ${tenantId}: alarm decisions read failed`, err);
          }
        }
        const attendedWithin = (id: string, windowHours: number, leaveCounts: boolean): boolean => {
          if (!decisionsReadable) return false;
          const floor = nowMs - windowHours * 3_600_000;
          return (decisions.get(id) ?? []).some(
            (d) =>
              d.outcome === 'applied' &&
              PLANNER_JUDGMENT_ACTIONS.has(d.action) &&
              (leaveCounts || d.action !== 'leave') &&
              Date.parse(d.decided_at) >= floor,
          );
        };
        const asksUnattended = askCandidates.filter(
          (n) => !attendedWithin(n.id, ASK_UNATTENDED_ALARM_HOURS, true),
        );
        // Build 4's semantics, moved verbatim: `leave` is looking, not acting.
        const observationsStale = staleCandidates.filter(
          (o) => !attendedWithin(o.id, OBSERVATION_STALE_HOURS, false),
        );
        summary.alarms.asksUnattended += asksUnattended.length;
        summary.alarms.deliveryStuck += deliveryStuckRows.length;
        summary.alarms.observationsStale += observationsStale.length;
        const name5 = (rows: Array<{ id: string }>): string =>
          rows.slice(0, 5).map((r) => r.id).join(', ') + (rows.length > 5 ? ', …' : '');
        if (asksUnattended.length + deliveryStuckRows.length + observationsStale.length > 0) {
          console.error(
            `[watchers] ALARMS for tenant ${tenantId}: ` +
              (asksUnattended.length > 0
                ? `${asksUnattended.length} ask(s) unattended ≥${ASK_UNATTENDED_ALARM_HOURS}h ` +
                  `(${name5(asksUnattended)}); `
                : '') +
              (deliveryStuckRows.length > 0
                ? `${deliveryStuckRows.length} delivery-stuck row(s) (${name5(deliveryStuckRows)}); `
                : '') +
              (observationsStale.length > 0
                ? `${observationsStale.length} stale observation(s) (${name5(observationsStale)})`
                : ''),
          );
        }
      } catch (err) {
        console.error(`[watchers] tenant ${tenantId}: alarm pass failed`, err);
      }
    } catch (err) {
      // One tenant's failure never blocks the siblings (lifecycle step idiom).
      summary.tenantErrors += 1;
      console.error(`[watchers] tenant ${tenantId} failed`, err);
    }
  }

  return summary;
}
