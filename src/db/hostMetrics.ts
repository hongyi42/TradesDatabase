import type { Database } from './database.types.js';
import { getClient } from './client.js';

export type HostMetricRow = Database['public']['Tables']['host_metrics']['Row'];

/**
 * One box's counters at one instant.
 *
 * Every numeric field is optional because the reporter must never fail a whole
 * tick over one unreadable file. A box on a kernel without PSI, or a cgroup v1
 * host, simply omits those fields and keeps sending the rest — a partial row is
 * worth far more than no row, and the monitoring view already treats a missing
 * value as "cannot say" rather than as zero.
 */
export interface HostMetricsReport {
  hostId: string;
  /** When the box READ its counters — the axis every derived delta divides by. */
  observedAt: string;
  memAvailMb?: number | null;
  memTotalMb?: number | null;
  diskUsedPct?: number | null;
  seats?: number | null;
  cpuCores?: number | null;
  load5?: number | null;
  /** Cumulative. /proc/vmstat oom_kill. */
  oomKills?: number | null;
  /** Cumulative. /sys/fs/cgroup/cpu.stat usage_usec — the turn counter. */
  cpuUsageUsec?: number | null;
  /** Cumulative. /proc/pressure/* totals, in microseconds. */
  psiMemSomeUs?: number | null;
  psiMemFullUs?: number | null;
  psiCpuSomeUs?: number | null;
  /** Per-container: { "<name>": { mem_mb, cpu_usec, psi_mem_some_us, oom_kill, max } }. */
  sandboxes?: Record<string, unknown>;
}

export type HostMetricsOutcome =
  | { action: 'recorded' }
  /** Same (host, observed_at) already stored — a retried or duplicated tick. */
  | { action: 'duplicate' };

/**
 * Store one tick.
 *
 * Deliberately dumb: no folding, no thresholds, no derived values. This table is
 * a time series, and the reason it exists is that the ops path — which folds
 * observations into incidents — discards every HEALTHY reading. Capacity is made
 * of the healthy readings.
 *
 * Counters are written RAW. Deltas are taken in monitoring.health at read time,
 * so a missed tick self-heals into a wider window rather than vanishing.
 */
export async function recordHostMetrics(
  report: HostMetricsReport,
): Promise<HostMetricsOutcome> {
  const { error } = await getClient()
    .from('host_metrics')
    .insert({
      host_id: report.hostId,
      observed_at: report.observedAt,
      mem_avail_mb: report.memAvailMb ?? null,
      mem_total_mb: report.memTotalMb ?? null,
      disk_used_pct: report.diskUsedPct ?? null,
      seats: report.seats ?? null,
      cpu_cores: report.cpuCores ?? null,
      load5: report.load5 ?? null,
      oom_kills: report.oomKills ?? null,
      cpu_usage_usec: report.cpuUsageUsec ?? null,
      psi_mem_some_us: report.psiMemSomeUs ?? null,
      psi_mem_full_us: report.psiMemFullUs ?? null,
      psi_cpu_some_us: report.psiCpuSomeUs ?? null,
      sandboxes: (report.sandboxes ?? {}) as never,
    });

  // 23505 = unique_violation on the (host_id, observed_at) primary key. A box
  // that retries a tick, or two overlapping runs of the reporter, must not turn
  // into an error the reporter then logs as a failure — the reading it wanted
  // stored IS stored, which is all it asked for. Idempotency by construction is
  // why the reporter needs no delivery guarantee.
  if (error) {
    if (error.code === '23505') return { action: 'duplicate' };
    throw new Error(`recordHostMetrics failed: ${error.message}`);
  }
  return { action: 'recorded' };
}

/**
 * Raw ticks for one host, oldest first — the read the monthly capacity query
 * uses. Deltas are the caller's job here, deliberately: analysis wants the
 * whole series, not the two-row window monitoring.health exposes for alerting.
 */
export async function listHostMetrics(
  hostId: string,
  since: string,
  limit = 5000,
): Promise<HostMetricRow[]> {
  const { data, error } = await getClient()
    .from('host_metrics')
    .select()
    .eq('host_id', hostId)
    .gte('observed_at', since)
    .order('observed_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listHostMetrics failed: ${error.message}`);
  return data ?? [];
}
