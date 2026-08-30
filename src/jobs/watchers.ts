import {
  createObservation,
  listCostGapCandidates,
  listDecisionsForNudges,
  listJobIdsWithCostEvents,
  findOpenReviewItemsByKind,
  flagNudgeGap,
  getTenant,
  listAssignmentsByIds,
  listEverFlaggedSubjectRefs,
  listJobStampedCaptureTimes,
  listJobsWithCustomerByIds,
  listNudgedSubjectRefs,
  listNudgesByStatus,
  listObservedSubjectRefs,
  listOverdueConfirmedAssignments,
  listTeam,
  listTenantIdsWithTelegramBindings,
  listVisitTimesForJobs,
  markNudgeOutcome,
  readSettingsTolerantly,
  resolveOpenReviewItemFor,
} from '../db/index.js';
import { notifyManagers } from '../calls/notify.js';
import {
  NUDGE_KIND_SPECS,
  specFor,
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
// These three moved and the neighbours below did NOT, and the rule is not taste:
// a constant may become per-firm only when EVERY call-site that reads it holds a
// tenant id. NUDGE_ESCALATE_HOURS and NUDGE_DELIVERY_DEADLINE_HOURS are also read
// by currentDeadlineMs/holdCeilingMs in planner.ts — pure functions with no
// tenant in scope — so moving only this side would let `extend` report success
// while the sweep escalated on a different clock. They move as one edit, later.
export {
  OVERDUE_HOURS,
  LOOKBACK_HOURS,
  MAX_NEW_ITEMS_PER_TENANT_TICK,
} from '../db/tenantSettings.js';

// Ladder tuning. 24h of post-ask silence escalates. Code constants, not env (the
// OVERDUE_HOURS pattern: one tuning surface).
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
// ITS DERIVATION IS GONE; THE NUMBER STAYS (plan 2026-08-29 Phase 3). 18 was
// computed FROM the ask window: 12h of overnight hold (13h on a DST fall-back
// night) + ~5h of margin, so a gap found at 7:01pm could hold till 7am, compose,
// and still get 6h of delivery attempts. The window is deleted and nothing holds
// a gap overnight any more, so none of that arithmetic applies.
//
// What it is NOW is a plain broken-pipe timeout, and the question it asks is the
// one two paragraphs up: how long before we admit the MACHINERY is broken. On the
// current cadence 18h is ~36 planner ticks at the full rate (fewer for a firm
// with recorded hours, since it drops to 2-hourly outside them) — a row still
// unasked after that many chances is not waiting, it is stuck.
//
// The number was NOT re-tuned here, deliberately: re-deriving it is its own
// decision with its own evidence, and changing a threshold in the same commit
// that removes its rationale makes both harder to review. Treat 18 as inherited
// until someone measures it.
//
// The old rider — "a window that ever excludes whole DAYS must lengthen this
// deadline with it" — is retired with the window. There is no hold to outlast.
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
  // The kind-generic flagger — the SWEEP's handoffs only now (expiry,
  // escalation); minting stopped flagging anything (plan 2026-08-31).
  flagNudge?: typeof flagNudgeGap;
  findOpenGaps?: typeof findOpenReviewItemsByKind;
  resolveGap?: typeof resolveOpenReviewItemFor;
  notify?: typeof notifyManagers;
  hasPushToken?: () => boolean;
  // Detection-records seams (plan 2026-08-31): the mint writes observations.
  createObservation?: typeof createObservation;
  listObserved?: typeof listObservedSubjectRefs;
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
  freshGaps: number; // gaps never surfaced on EITHER rung — what live would act on
  itemsOpened: number;
  itemsResolved: number;
  pushed: number; // tenants that got the count-only line this tick
  pushSkipped: boolean; // true when items opened but no BOARD_BOT_TOKEN
  tenantErrors: number;
  nudgeMode: NudgeMode;
  // RETIRED AT MINT (plan 2026-08-31): the watcher creates no nudges any more —
  // the planner's send does. Both stay in the shape at 0 (lifecycle summary
  // consumers and their tests pin it); build 5 owns removing them.
  nudgesWouldCreate: number;
  nudgesCreated: number;
  // Detection's whole output now: fresh findings recorded as observations,
  // uncapped (the record is unbounded — user direction 2026-08-31).
  observationsCreated: number;
  // Closed by a FACT: a cancelled visit or job (`moot`). That is now the ONLY
  // thing the sweep closes on — the pre-ask carve-out went with the ask window
  // (plan 2026-08-29 Phase 3), so activity never closes a gap here, asked or
  // not. Judging whether something answers the question is the planner's.
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
  byKind: Record<string, { gapsFound: number; nudgesCreated: number; observationsCreated: number }>;
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
  const flagNudge = deps.flagNudge ?? flagNudgeGap;
  const findOpenGaps = deps.findOpenGaps ?? findOpenReviewItemsByKind;
  const resolveGap = deps.resolveGap ?? resolveOpenReviewItemFor;
  const notify = deps.notify ?? notifyManagers;
  const hasPushToken = deps.hasPushToken ?? (() => !!process.env.BOARD_BOT_TOKEN);
  const createObs = deps.createObservation ?? createObservation;
  const listObserved = deps.listObserved ?? listObservedSubjectRefs;
  const listNudged = deps.listNudged ?? listNudgedSubjectRefs;
  const listNudges = deps.listNudges ?? listNudgesByStatus;
  const resolveNudge = deps.resolveNudge ?? markNudgeOutcome;
  const specs = deps.specs ?? NUDGE_KIND_SPECS;
  const listCostCandidates = deps.listCostCandidates ?? listCostGapCandidates;
  const listCostEvents = deps.listCostEvents ?? listJobIdsWithCostEvents;
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
    itemsOpened: 0,
    itemsResolved: 0,
    pushed: 0,
    pushSkipped: false,
    tenantErrors: 0,
    nudgeMode,
    nudgesWouldCreate: 0,
    nudgesCreated: 0,
    observationsCreated: 0,
    nudgesResolved: 0,
    nudgesAutoClosed: 0,
    nudgesEscalated: 0,
    nudgesExpired: 0,
    byKind: {},
  };
  const bumpKind = (
    kind: string,
    field: 'gapsFound' | 'nudgesCreated' | 'observationsCreated',
    by = 1,
  ): void => {
    const row = (summary.byKind[kind] ??= { gapsFound: 0, nudgesCreated: 0, observationsCreated: 0 });
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
      // Rows this tick already took terminal — `moot` closes PENDING rows and
      // `continue`s. (It was two paths until the pre-ask carve-out was deleted on
      // 2026-08-29; the set is still load-bearing for the one that remains.) The
      // group expansion below reads
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
        // THE PRE-ASK CARVE-OUT IS GONE (plan 2026-08-29 Phase 3). It closed a
        // never-asked gap whose job had since gained activity, and its ONLY
        // stated justification was the ask window: "compose reads pending rows
        // and never re-checks this, and its ask window holds an evening gap until
        // 7am. A report filed at 8pm would then be followed by us asking that
        // technician at 7am how the job went."
        //
        // With no window there is no overnight hold, so there is no stale-question
        // hazard to prevent. The planner sees the note at 8:05pm — the evidence is
        // in its prompt — and closes the gap itself with a reason and a citation.
        // Which is the ruling this ladder already made about ASKED gaps
        // (2026-08-22): judging whether something answers the question is the
        // planner's, and a fast deterministic sweep that keeps winning that race
        // is backwards from the premise.
        //
        // `closedThisTick` below still earns its keep — `moot` populates it.
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
        // or rollback-frozen pending. The STATUS path above still wins (a
        // cancelled visit is moot whatever the clock says); past the deadline,
        // the manager takes the gap.
        //
        // ACTIVITY NO LONGER WINS HERE, and that reversed on 2026-08-29 with the
        // pre-ask carve-out. A job that gained a report but whose question never
        // went out still expires: 18h unasked means delivery is broken, which is
        // exactly what this deadline is for, and the manager's item self-closes
        // on the next sweep if the activity really did answer it.
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

      // ── MINTING became RECORDING (plan 2026-08-31 "a gap is not an ask") ──
      // Every fresh gap becomes an OBSERVATION — no cap, no reachability test,
      // no manager fallback. The caps died WITH the ask-at-detection design:
      // they metered questions (a scarce claim on a person's attention), and an
      // observation asks nobody anything. Deciding which gaps deserve a message
      // is now wholly the planner's, which is what the per-tick slice was a
      // stand-in for all along ("Deciding WHICH gaps deserve a scarce slot is
      // exactly the pacing planner's job" — the old comment here, now true).
      // settings.maxNewPerTick and the per-kind brakes are left DECLARED but
      // unread at mint (build 5 owns retiring them); the once-ever store is
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
