import {
  CLOSED_NUDGE_STATUSES,
  insertGapSummary,
  listUnsummarizedClosedNudges,
  type GapSummaryInsert,
} from '../db/gapSummaries.js';
import { listDecisionsForNudges } from '../db/nudgeDecisions.js';
import { findItemForNudge, type ReviewItem } from '../db/reviewItems.js';
import { getTenant } from '../db/tenants.js';
import type { Nudge } from '../db/nudges.js';
import { workingHoursBetween } from './workingHours.js';

// ⑤ Phase 2: the gap-life summarize sweep. One CODE-written row per closed
// gap — the durable experience unit the Reflector reads. Runs every lifecycle
// tick after compose; idempotent (unique nudge_id, insert-ignore); one bad
// gap never blocks the sweep (the lifecycle's per-row isolation idiom).

// The escalation HOLDBACK window: an escalated gap whose review item is still
// open stays unsummarized this long, so the manager's eventual dismissal or
// resolution lands in the summary instead of a frozen 'none'/'still_open'.
export const HOLDBACK_DAYS = 7;

export interface SummarizeSummary {
  scanned: number;
  written: number;
  heldBack: number;
  rowErrors: number;
}

export interface SummarizeDeps {
  listClosed?: typeof listUnsummarizedClosedNudges;
  listDecisions?: typeof listDecisionsForNudges;
  findItem?: typeof findItemForNudge;
  insert?: typeof insertGapSummary;
  tenant?: typeof getTenant;
}

function subjectLabel(n: Nudge): string {
  const c = (n.context ?? {}) as Record<string, unknown>;
  const name = typeof c.customerName === 'string' ? c.customerName : null;
  const title = typeof c.jobTitle === 'string' ? c.jobTitle : null;
  if (name && title) return `${name} — ${title}`;
  return name ?? title ?? n.subject_ref;
}

function contextJobId(n: Nudge): string | null {
  const c = (n.context ?? {}) as Record<string, unknown>;
  return typeof c.jobId === 'string' && c.jobId.length > 0 ? c.jobId : null;
}

export async function runGapSummaries(nowIso: string, deps: SummarizeDeps = {}): Promise<SummarizeSummary> {
  const listClosed = deps.listClosed ?? listUnsummarizedClosedNudges;
  const listDecisions = deps.listDecisions ?? listDecisionsForNudges;
  const findItem = deps.findItem ?? findItemForNudge;
  const insert = deps.insert ?? insertGapSummary;
  const tenant = deps.tenant ?? getTenant;

  const summary: SummarizeSummary = { scanned: 0, written: 0, heldBack: 0, rowErrors: 0 };
  const rows = await listClosed();
  summary.scanned = rows.length;
  if (rows.length === 0) return summary;

  // One tz read per tenant present in the batch, one batched decisions read.
  const tzByTenant = new Map<string, string>();
  const byTenant = new Map<string, Nudge[]>();
  for (const n of rows) {
    (byTenant.get(n.tenant_id) ?? byTenant.set(n.tenant_id, []).get(n.tenant_id)!).push(n);
  }
  const decisionsByNudge = new Map<string, Awaited<ReturnType<typeof listDecisions>>>();
  for (const [tenantId, tenantRows] of byTenant) {
    try {
      const t = await tenant(tenantId);
      tzByTenant.set(tenantId, t?.timezone ?? 'UTC');
      decisionsByNudge.set(
        tenantId,
        await listDecisions(tenantId, tenantRows.map((r) => r.id)),
      );
    } catch (err) {
      // A tenant whose reads fail loses this tick, not the sweep.
      summary.rowErrors += tenantRows.length;
      byTenant.delete(tenantId);
      console.error(`[gapSummaries] tenant ${tenantId}: batch reads failed`, err);
    }
  }

  const nowMs = Date.parse(nowIso);
  for (const [tenantId, tenantRows] of byTenant) {
    const tz = tzByTenant.get(tenantId) ?? 'UTC';
    const decisions =
      decisionsByNudge.get(tenantId) ??
      (new Map() as Awaited<ReturnType<typeof listDecisions>>);
    for (const n of tenantRows) {
      try {
        if (!CLOSED_NUDGE_STATUSES.includes(n.status as (typeof CLOSED_NUDGE_STATUSES)[number])) {
          continue; // tampered row — the lister already filters, belt and braces
        }
        const closedAt = n.resolved_at ?? n.created_at;

        // The holdback: manager_fate must be able to become true (review find
        // 1) — an escalated gap waits for its item, or for the window to pass.
        let item: ReviewItem | null = null;
        let managerFate: GapSummaryInsert['manager_fate'] = 'none';
        let managerResolution: string | null = null;
        let managerLatencyWh: number | null = null;
        if (n.status === 'escalated') {
          item = await findItem(tenantId, n.id);
          const windowOpen = nowMs - Date.parse(closedAt) < HOLDBACK_DAYS * 24 * 3_600_000;
          if ((!item || item.status === 'open') && windowOpen) {
            summary.heldBack += 1;
            continue;
          }
          if (item && item.status !== 'open') {
            managerFate = item.status as 'resolved' | 'dismissed';
            managerResolution = item.resolution;
            managerLatencyWh = workingHoursBetween(closedAt, item.resolved_at, tz);
          } else {
            managerFate = 'still_open';
          }
        }

        const history = decisions.get(n.id) ?? [];
        const arc: Record<string, number> = {};
        for (const d of history) arc[d.action] = (arc[d.action] ?? 0) + 1;
        const lastExtend = [...history].reverse().find((d) => d.action === 'extend');

        const wrote = await insert({
          tenant_id: tenantId,
          nudge_id: n.id,
          job_id: contextJobId(n) ?? history.find((d) => d.job_id)?.job_id ?? null,
          kind: n.kind,
          subject: subjectLabel(n),
          asked_at: n.asked_at,
          closed_at: closedAt,
          status: n.status,
          resolution: n.resolution,
          working_hours_open: workingHoursBetween(n.asked_at, closedAt, tz),
          arc,
          considered: history.length,
          extended_to: lastExtend?.escalate_after ?? n.escalate_after,
          escalated: n.status === 'escalated',
          manager_fate: managerFate,
          manager_resolution: managerResolution,
          manager_latency_wh: managerLatencyWh,
          answered_by_capture_id: n.answered_by_capture_id,
        });
        if (wrote) summary.written += 1;
      } catch (err) {
        summary.rowErrors += 1;
        console.error(`[gapSummaries] nudge ${n.id} failed`, err);
      }
    }
  }
  return summary;
}
