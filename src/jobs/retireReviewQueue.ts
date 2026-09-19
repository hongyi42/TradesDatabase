import {
  getNewestCaptureIdForRef,
  getTechnician,
  listOpenReviewItemsOfKinds,
  raiseOffboardingObservation,
  raiseUnknownRefObservation,
  resolveReviewItem,
  type ReviewItem,
} from '../db/index.js';

// The review queue's one-time retirement sweep (plan
// thoughts/shared/plans/2026-09-19-retire-the-manager-review-queue.md, Phase 3).
// Run by scripts/retire-review-queue.mjs, dry-run first.
//
// The manager queue is gone — nothing lists `review_items` to anybody — so the
// open items of the kinds it used to carry are closed here, once. Two of those
// kinds still mean something live, and are CARRIED to the planner as
// observations before their item closes, so nothing a manager should hear about
// is lost in the move:
//   - an offboarding reminder whose person is still in their grace period;
//   - an unknown-ref item whose ref is STILL off the roster (a ref that has
//     since joined is just closed — telling the planner "nobody on the team has
//     that ref" would be false).
//
// Deliberately LEFT OPEN:
//   - every staged token, `pairing_verification` (it waits for the settings
//     page) and `availability_setup` (set_availability still closes it);
//   - any item carrying `escalatedFromNudge`. Those are the planner's own
//     handovers, and it reads how they ended (v_review_items, plannerPrompt's
//     HISTORY paragraph; mv_escalation_fates). Nobody acted on them, so open is
//     their true state — dismissing them all in one run would forge a pattern
//     of managers turning them down.
//
// One token IS closed: a `pending_deactivation` with no `stagedAt`. It was
// staged before deactivations expired, so it would stay confirmable forever.

// The kinds the queue carried and nothing else holds open any more.
export const RETIRED_REVIEW_KINDS = [
  'sheet_ref_mismatch',
  'unknown_ref_capture',
  'offboarding_reminder',
  'unlinked_call',
  'call_action',
  'overdue_visit_gap',
  'job_cost_gap',
] as const;

export const RETIREMENT_RESOLUTION =
  'review queue retired 2026-09-19; see thoughts/shared/plans/2026-09-19-retire-the-manager-review-queue.md';
export const LEGACY_DEACTIVATION_RESOLUTION =
  'staged before deactivations expired; the review queue was retired 2026-09-19 — stage it again';

export interface KindCounts {
  carried: number; // raised as an observation before closing
  skipped: number; // left open (an escalation)
  dismissed: number;
}

export interface RetireReport {
  dryRun: boolean;
  byKind: Record<string, KindCounts>;
  legacyDeactivations: number;
}

export interface RetireDeps {
  listOpen?: typeof listOpenReviewItemsOfKinds;
  getTechnician?: typeof getTechnician;
  newestCapture?: typeof getNewestCaptureIdForRef;
  raiseOffboarding?: typeof raiseOffboardingObservation;
  raiseUnknownRef?: typeof raiseUnknownRefObservation;
  dismiss?: typeof resolveReviewItem;
}

const escalationOf = (item: ReviewItem): string | null => {
  const v = (item.detail as { escalatedFromNudge?: unknown } | null)?.escalatedFromNudge;
  return typeof v === 'string' && v.length > 0 ? v : null;
};

const stagedAtOf = (item: ReviewItem): string | null => {
  const v = (item.detail as { stagedAt?: unknown } | null)?.stagedAt;
  return typeof v === 'string' && v.length > 0 ? v : null;
};

// `tenantIds` scopes the sweep (the test does; the script never does). A dry
// run reads everything and writes nothing, and reports what a real run would
// do — the operator reads it before running for real.
export async function retireReviewQueue(
  opts: { dryRun: boolean; tenantIds?: readonly string[] },
  deps: RetireDeps = {},
): Promise<RetireReport> {
  const listOpen = deps.listOpen ?? listOpenReviewItemsOfKinds;
  const readTechnician = deps.getTechnician ?? getTechnician;
  const newestCapture = deps.newestCapture ?? getNewestCaptureIdForRef;
  const raiseOffboarding = deps.raiseOffboarding ?? raiseOffboardingObservation;
  const raiseUnknownRef = deps.raiseUnknownRef ?? raiseUnknownRefObservation;
  const dismiss = deps.dismiss ?? resolveReviewItem;

  const report: RetireReport = { dryRun: opts.dryRun, byKind: {}, legacyDeactivations: 0 };
  const counts = (kind: string): KindCounts =>
    (report.byKind[kind] ??= { carried: 0, skipped: 0, dismissed: 0 });

  const items = await listOpen([...RETIRED_REVIEW_KINDS, 'pending_deactivation'], opts.tenantIds);
  for (const item of items) {
    if (item.kind === 'pending_deactivation') {
      if (stagedAtOf(item)) continue; // a live, expiring token — not ours to touch
      if (!opts.dryRun) await dismiss(item.id, item.tenant_id, 'dismissed', LEGACY_DEACTIVATION_RESOLUTION);
      report.legacyDeactivations++;
      continue;
    }
    const c = counts(item.kind);
    if (escalationOf(item)) {
      c.skipped++;
      continue;
    }
    if (item.kind === 'offboarding_reminder') {
      const tech = await readTechnician(item.tenant_id, item.subject_ref);
      if (tech?.state === 'offboarding' && tech.offboarding_started_at) {
        if (!opts.dryRun) {
          await raiseOffboarding({
            tenantId: item.tenant_id,
            ref: tech.ref,
            displayName: tech.display_name,
            startedAt: tech.offboarding_started_at,
          });
        }
        c.carried++;
      }
    } else if (item.kind === 'unknown_ref_capture') {
      const tech = await readTechnician(item.tenant_id, item.subject_ref);
      if (!tech) {
        if (!opts.dryRun) {
          await raiseUnknownRef({
            tenantId: item.tenant_id,
            ref: item.subject_ref,
            captureId: await newestCapture(item.tenant_id, item.subject_ref),
          });
        }
        c.carried++;
      }
    }
    if (!opts.dryRun) await dismiss(item.id, item.tenant_id, 'dismissed', RETIREMENT_RESOLUTION);
    c.dismissed++;
  }
  return report;
}
