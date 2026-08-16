import {
  findOpenReviewItemsByKind,
  flagOverdueVisitGap,
  getTenant,
  listAssignmentsByIds,
  listEverFlaggedSubjectRefs,
  listJobStampedCaptureTimes,
  listJobsWithCustomerByIds,
  listOverdueConfirmedAssignments,
  listTeam,
  listTenantIdsWithTelegramBindings,
  listVisitTimesForJobs,
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

// Tune at the shadow-volume review (user decision 2026-08-16: 3h/72h/5 stand).
export const OVERDUE_HOURS = 3;
export const LOOKBACK_HOURS = 72;
export const MAX_NEW_ITEMS_PER_TENANT_TICK = 5;

// UTC offsets span −12h..+14h; subtracting 14h from a wall-clock instant is a
// floor no real timezone's UTC reading can undershoot.
const MAX_UTC_OFFSET_MS = 14 * 3_600_000;
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
}

export interface WatchersSummary {
  mode: WatcherMode;
  tenants: number;
  gapsFound: number; // standing snapshot: every current gap in the window
  freshGaps: number; // gaps never flagged before — what live would open
  itemsOpened: number;
  itemsResolved: number;
  pushed: number; // tenants that got the count-only line this tick
  pushSkipped: boolean; // true when items opened but no BOARD_BOT_TOKEN
  tenantErrors: number;
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
  const flagGap = deps.flagGap ?? flagOverdueVisitGap;
  const findOpenGaps = deps.findOpenGaps ?? findOpenReviewItemsByKind;
  const resolveGap = deps.resolveGap ?? resolveOpenReviewItemFor;
  const notify = deps.notify ?? notifyManagers;
  const hasPushToken = deps.hasPushToken ?? (() => !!process.env.BOARD_BOT_TOKEN);

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

      // ONE batched activity fetch across candidates' AND open items' jobs.
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
        for (const g of openGaps) minNaiveMs = Math.min(minNaiveMs, Date.parse(g.startsAtLocal));
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

      // FRESH = never flagged, any status (the batched cap pre-filter). Read
      // in both modes: freshGaps is the number the shadow→live flip decision
      // needs, since it is exactly what live would open.
      const everFlagged = new Set(
        await listEverFlagged(tenantId, 'overdue_visit_gap', gaps.map((g) => g.id)),
      );
      const fresh = gaps.filter((g) => !everFlagged.has(g.id));
      summary.freshGaps += fresh.length;

      if (mode === 'shadow') continue; // counts only — nothing written, nobody pushed

      // Auto-resolve, two paths. (1) The gap an open item describes has been
      // filled by activity since the visit started.
      const statusById = new Map(
        (await listAssignments(tenantId, openGaps.map((g) => g.item.subject_ref))).map((a) => [
          a.id,
          a.status,
        ]),
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

      // Flag fresh gaps — capped, oldest scheduled end first (candidates come
      // ordered; the filters preserve it).
      const top = fresh.slice(0, MAX_NEW_ITEMS_PER_TENANT_TICK);
      let opened = 0;
      if (top.length > 0) {
        const [teamRows, jobRows] = await Promise.all([
          team(tenantId),
          listJobs(tenantId, [...new Set(top.map((g) => g.job_id))]),
        ]);
        const refById = new Map(teamRows.map((t) => [t.id, t.ref]));
        // The jobs read is tenant-scoped in the query; the re-check below is
        // the id-only-FK belt-and-suspenders (boardRead pattern). Its customer
        // embed carries no tenant_id to re-check — the job-level scope is the
        // enforced guard for the name (noted at final review).
        const jobById = new Map(jobRows.filter((j) => j.tenant_id === tenantId).map((j) => [j.id, j]));
        for (const g of top) {
          const job = jobById.get(g.job_id);
          const title = job?.title ?? 'a job';
          const customer = job?.customers?.name ?? 'unknown customer';
          const endsLabel = `${g.ends_at.slice(0, 10)} ${g.ends_at.slice(11, 16)}`;
          const item = await flagGap({
            tenantId,
            assignmentId: g.id,
            jobId: g.job_id,
            technicianRef: (g.technician_id && refById.get(g.technician_id)) || null,
            startsAtLocal: g.starts_at,
            endsAtLocal: g.ends_at,
            // Job-focused copy — a question about the visit, not an audit of
            // the person (direction constraint 5; human tone check in Phase 3).
            suggestion:
              `Visit for '${title}' (${customer}) scheduled to end ${endsLabel} has no field ` +
              `report or status update — ask how it went, or dismiss if nothing was needed.`,
          });
          if (item) opened += 1; // null = flagged concurrently — not new
        }
      }
      summary.itemsOpened += opened;

      // ONE count-only line per tenant per tick, only when something NEW
      // opened (the ever-flagged filter means a quiet queue never re-pings on
      // any cadence). No names/PII in the push — the queue holds the detail.
      if (opened > 0) {
        if (hasPushToken()) {
          await notify(
            tenantId,
            `Spine check: ${opened} recent visit(s) have nothing on record — see pending reviews.`,
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
