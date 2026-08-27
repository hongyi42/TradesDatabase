import { getClient } from './client.js';
import { isValidService } from './opsEvents.js';

/**
 * What one loop iteration of a headless worker did.
 *
 * Three facts, because a single "still alive" flag cannot tell the two
 * interesting failures apart. A worker whose work throws on every tick keeps
 * cycling forever — `ok: false` is what separates that from a healthy idle loop,
 * and it is the shape `Board_Worker` actually has today:
 *
 *     try   { const sent = await pollOnce(lastSeen); }
 *     catch (err) { console.error('board worker: poll failed (will retry):', err); }
 */
export interface HeartbeatReport {
  /** Lowercase kebab-case, same rule as ops_events. Enforced by a CHECK too. */
  service: string;
  /** Did this iteration complete WITHOUT throwing? */
  ok: boolean;
  /**
   * Did it do real work (send something, process something)? Recorded as
   * CONTEXT for the alert body, never as an alarm condition — zero work is the
   * normal state most of the day, and a monitor that pages on a quiet afternoon
   * gets muted before it ever catches anything.
   */
  didWork?: boolean;
  /** Small counters for the alert body, e.g. { sent: 3, cycles: 120 }. No PII. */
  detail?: Record<string, unknown>;
}

/**
 * Record one iteration.
 *
 * Column semantics, and why omission matters: `beat_at` is written every call,
 * while `last_ok_at` and `work_at` are OMITTED unless they apply. PostgREST's
 * upsert only SETs the columns present in the payload, so omitting one leaves
 * the stored value untouched — which is exactly what "the last time this was
 * true" needs. Sending null instead would erase the history and make a currently
 * failing worker indistinguishable from one that has never succeeded.
 *
 * THROWS on failure, deliberately. The caller decides what a failed heartbeat
 * means; for a worker the answer is always "log it and keep going", because a
 * monitoring write must never break the thing it measures. If these stop landing
 * the row goes stale and the monitor raises it — the failure is covered by the
 * mechanism itself, so it does not need to be fatal here.
 */
export async function recordHeartbeat(report: HeartbeatReport): Promise<void> {
  if (!isValidService(report.service)) {
    throw new Error(`recordHeartbeat: invalid service name ${JSON.stringify(report.service)}`);
  }
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    service: report.service,
    beat_at: now,
    detail: report.detail ?? {},
  };
  if (report.ok) row.last_ok_at = now;
  if (report.didWork) row.work_at = now;

  const { error } = await getClient()
    .from('worker_heartbeats')
    .upsert(row as never, { onConflict: 'service' });
  if (error) throw new Error(`recordHeartbeat failed: ${error.message}`);
}
