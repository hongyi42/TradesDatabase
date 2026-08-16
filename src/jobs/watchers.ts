import {
  countRecentAsks,
  createPendingNudge,
  findOpenReviewItemsByKind,
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
// reachable and their budget allows, a fresh gap becomes a NUDGE — a question
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

// Ladder tuning (user-ratified 2026-08-16): 2 asks per person per rolling
// 24h, NO firm-wide cap (volume scales with the roster; the per-tick cap
// above is the surge brake); a budget-exhausted gap DEFERS to a later tick,
// never overflows onto the manager. 48h of post-ask silence escalates.
// Code constants, not env (the OVERDUE_HOURS pattern: one tuning surface).
export const NUDGE_BUDGET_PER_PERSON_DAY = 2;
export const NUDGE_ESCALATE_HOURS = 48;

// UTC offsets span −12h..+14h; subtracting 14h from a wall-clock instant is a
// floor no real timezone's UTC reading can undershoot.
const MAX_UTC_OFFSET_MS = 14 * 3_600_000;

// Human label for a naive-local timestamp: "Saturday, Aug 15 at 4:00 PM".
// The input already IS the firm's wall clock (stored as if UTC), so we format
// it in UTC — no timezone math — and the weekday comes from Intl over the
// same string, so the weekday-date pair can never disagree (the weekday-guard
// doctrine: fused derivation, not model arithmetic).
function wallClockLabel(naiveIso: string): string {
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
  findOpenGaps?: typeof findOpenReviewItemsByKind;
  resolveGap?: typeof resolveOpenReviewItemFor;
  notify?: typeof notifyManagers;
  hasPushToken?: () => boolean;
  // Stage-1 ladder seams
  createNudge?: typeof createPendingNudge;
  listNudged?: typeof listNudgedSubjectRefs;
  listNudges?: typeof listNudgesByStatus;
  resolveNudge?: typeof markNudgeOutcome;
  countAsks?: typeof countRecentAsks;
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
  const findOpenGaps = deps.findOpenGaps ?? findOpenReviewItemsByKind;
  const resolveGap = deps.resolveGap ?? resolveOpenReviewItemFor;
  const notify = deps.notify ?? notifyManagers;
  const hasPushToken = deps.hasPushToken ?? (() => !!process.env.BOARD_BOT_TOKEN);
  const createNudge = deps.createNudge ?? createPendingNudge;
  const listNudged = deps.listNudged ?? listNudgedSubjectRefs;
  const listNudges = deps.listNudges ?? listNudgesByStatus;
  const resolveNudge = deps.resolveNudge ?? markNudgeOutcome;
  const countAsks = deps.countAsks ?? countRecentAsks;

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
      const openItems = mode === 'live' ? await findOpenGaps(tenantId, 'overdue_visit_gap') : [];

      // Open items' detail is watcher-written JSON, but fail CLOSED once, at
      // the boundary: malformed rows are dropped here and can only be closed
      // by the status-change path or a manual dismiss.
      const openGaps = openItems.flatMap((item) => {
        const d = (item.detail ?? {}) as Record<string, unknown>;
        const jobId = typeof d.jobId === 'string' ? d.jobId : null;
        const startsAtLocal =
          typeof d.startsAtLocal === 'string' && !Number.isNaN(Date.parse(d.startsAtLocal))
            ? d.startsAtLocal
            : null;
        return jobId && startsAtLocal ? [{ item, jobId, startsAtLocal }] : [];
      });

      // Open nudges are swept ONLY when the ladder is live: 'off'/'shadow'
      // deliberately freeze leftover in-flight nudges (the WATCHERS_MODE
      // rollback precedent — a rolled-back mode must not keep writing).
      // Malformed context rows are KEPT (unlike openGaps): the status-change
      // resolve needs only subject_ref; only the activity path needs context,
      // so a tampered row can still close when its visit is cancelled — it
      // just never escalates (fail-closed, documented).
      const openNudges =
        mode === 'live' && nudgeMode === 'live'
          ? (await listNudges(tenantId, ['pending', 'queued', 'asked'])).filter(
              (n) => n.kind === 'overdue_visit_gap',
            )
          : [];
      const openNudgeGaps = openNudges.map((n) => {
        const c = (n.context ?? {}) as Record<string, unknown>;
        const jobId = typeof c.jobId === 'string' ? c.jobId : null;
        const startsAtLocal =
          typeof c.startsAtLocal === 'string' && !Number.isNaN(Date.parse(c.startsAtLocal))
            ? c.startsAtLocal
            : null;
        return { n, jobId, startsAtLocal };
      });

      // ONE batched activity fetch across candidates', open items', AND open
      // nudges' jobs.
      const jobIds = new Set<string>(candidates.map((c) => c.job_id));
      for (const g of openGaps) jobIds.add(g.jobId);
      for (const x of openNudgeGaps) if (x.jobId && x.startsAtLocal) jobIds.add(x.jobId);

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
        for (const g of openGaps) minNaiveMs = Math.min(minNaiveMs, Date.parse(g.startsAtLocal));
        for (const x of openNudgeGaps)
          if (x.startsAtLocal) minNaiveMs = Math.min(minNaiveMs, Date.parse(x.startsAtLocal));
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
      const statusSubjects = [
        ...new Set([
          ...openGaps.map((g) => g.item.subject_ref),
          ...openNudgeGaps.map((x) => x.n.subject_ref),
        ]),
      ];
      const statusById = new Map(
        (await listAssignments(tenantId, statusSubjects)).map((a) => [a.id, a.status]),
      );
      for (const g of openGaps) {
        if (hasActivitySince(g.jobId, g.startsAtLocal)) {
          const resolved = await resolveGap(
            tenantId,
            'overdue_visit_gap',
            g.item.subject_ref,
            'resolved',
            'field report arrived after this was flagged',
          );
          if (resolved) summary.itemsResolved += 1;
          continue;
        }
        // (2) The visit left 'confirmed' — cancelled or completed is the
        // "status update" the item copy promises counts (final-review fix:
        // without this, a cancelled visit sits in the queue forever asking
        // the manager to follow up on work they already killed).
        const status = statusById.get(g.item.subject_ref);
        if (status === 'cancelled' || status === 'completed') {
          const resolved = await resolveGap(
            tenantId,
            'overdue_visit_gap',
            g.item.subject_ref,
            'resolved',
            `visit was ${status} after this was flagged`,
          );
          if (resolved) summary.itemsResolved += 1;
        }
      }

      // Sweep open nudges with the SAME two resolve paths, then collect the
      // silent ones for escalation. A recorded reply lands as a capture, so
      // "nothing to report" mechanically counts as filled (user-ratified
      // 2026-08-16) — only pure silence climbs the ladder.
      let opened = 0;
      const escalations: typeof openNudgeGaps = [];
      for (const x of openNudgeGaps) {
        if (x.jobId && x.startsAtLocal && hasActivitySince(x.jobId, x.startsAtLocal)) {
          const closed = await resolveNudge(
            x.n.id,
            tenantId,
            'answered',
            'a field report arrived — the gap filled itself',
          );
          if (closed) summary.nudgesResolved += 1;
          continue;
        }
        const status = statusById.get(x.n.subject_ref);
        if (status === 'cancelled' || status === 'completed') {
          const closed = await resolveNudge(
            x.n.id,
            tenantId,
            'cancelled',
            `the visit was ${status} — nothing left to ask`,
          );
          if (closed) summary.nudgesResolved += 1;
          continue;
        }
        if (
          x.n.status === 'asked' &&
          x.n.asked_at &&
          Date.parse(x.n.asked_at) <= nowMs - NUDGE_ESCALATE_HOURS * 3_600_000
        ) {
          escalations.push(x);
        }
      }

      // RUNG 2: silence became the manager's item. Reuses the SAME kind and
      // once-per-assignment-ever dedup as the fallback flag — one assignment
      // can never carry both a fallback item and an escalation item. Copy
      // needs no extra reads: everything rides in the nudge's own context.
      // A malformed context never reaches here (no escalation without the
      // activity fields — see the openNudgeGaps note above).
      for (const x of escalations) {
        const c = (x.n.context ?? {}) as Record<string, unknown>;
        const jobId = typeof c.jobId === 'string' ? c.jobId : null;
        const startsAtLocal = typeof c.startsAtLocal === 'string' ? c.startsAtLocal : null;
        const endsAtLocal = typeof c.endsAtLocal === 'string' ? c.endsAtLocal : null;
        if (!jobId || !startsAtLocal || !endsAtLocal) continue;
        const title = typeof c.jobTitle === 'string' ? c.jobTitle : 'a job';
        const customer = typeof c.customerName === 'string' ? c.customerName : 'unknown customer';
        const techName =
          typeof c.technicianName === 'string' ? c.technicianName : 'The technician';
        const item = await flagGap({
          tenantId,
          assignmentId: x.n.subject_ref,
          jobId,
          technicianRef: typeof c.technicianRef === 'string' ? c.technicianRef : null,
          startsAtLocal,
          endsAtLocal,
          escalatedFromNudge: x.n.id,
          // Same copy doctrine as the fallback suggestion below — and about
          // the JOB, even here: the ask is "close the record out", never
          // "your technician is unresponsive".
          suggestion:
            `${techName}'s assistant asked about the '${title}' visit (${customer}) on ` +
            `${wallClockLabel(naiveLocal(x.n.asked_at as string))} and hasn't heard back — ` +
            `nothing is on the job's record yet. Worth a direct word so it gets closed out. ` +
            `If it's already handled, just dismiss this.`,
        });
        if (item) opened += 1;
        // Mark AFTER the flag: if the flag throws, the nudge stays 'asked'
        // and next tick retries (flagGap's dedup makes the retry converge).
        const moved = await resolveNudge(
          x.n.id,
          tenantId,
          'escalated',
          'no reply — handed to the manager',
        );
        if (moved) summary.nudgesEscalated += 1;
      }

      // Route fresh gaps — capped, oldest scheduled end first (candidates
      // come ordered; the filters preserve it). RUNG 1 when the ladder is
      // live and the technician is reachable within budget; the manager item
      // is the fallback. A budget-exhausted gap takes NEITHER path: it stays
      // fresh and retries when the rolling window frees a slot (user-ratified
      // — deferral, never manager overflow).
      const top = fresh.slice(0, MAX_NEW_ITEMS_PER_TENANT_TICK);
      if (top.length > 0) {
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
            // Counted BEFORE budget (shadow creates nothing, so the budget
            // read would always say 0 anyway): nudgesWouldCreate measures
            // reachability, the flip decision's number.
            summary.nudgesWouldCreate += 1;
          }
          if (reachable && nudgeMode === 'live') {
            const asks = await countAsks(
              tenantId,
              tech.id,
              new Date(nowMs - 24 * 3_600_000).toISOString(),
            );
            if (asks >= NUDGE_BUDGET_PER_PERSON_DAY) continue; // defer, don't overflow
            const nudge = await createNudge({
              tenantId,
              kind: 'overdue_visit_gap',
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
            if (nudge) summary.nudgesCreated += 1; // null = considered concurrently
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
            suggestion:
              `The visit for '${title}' (${customer}) was scheduled to wrap up by ` +
              `${wallClockLabel(g.ends_at)}, but nothing has been recorded about it yet — no ` +
              `field note and no status change. Worth checking how it went so the job's record ` +
              `stays complete. If nothing needed recording, just dismiss this.`,
          });
          if (item) opened += 1; // null = flagged concurrently — not new
        }
      }
      summary.itemsOpened += opened;

      // ONE count-only line per tenant per tick, only when something NEW
      // opened (the ever-flagged filter means a quiet queue never re-pings on
      // any cadence). No names/PII in the push — the queue holds the detail.
      // Same copy doctrine as the suggestion: warm, no jargon, real plurals.
      if (opened > 0) {
        if (hasPushToken()) {
          await notify(
            tenantId,
            opened === 1
              ? 'Heads-up: a recent visit has nothing on record yet — it’s waiting in your pending reviews whenever you have a minute.'
              : `Heads-up: ${opened} recent visits have nothing on record yet — they’re waiting in your pending reviews whenever you have a minute.`,
          );
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
