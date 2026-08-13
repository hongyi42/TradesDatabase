import type { Database } from './database.types.js';
import { getClient } from './client.js';

export type OpsEvent = Database['public']['Tables']['ops_events']['Row'];

/** What a reporter says about one service, right now. */
export type OpsStatus = 'ok' | 'down';

export interface OpsReport {
  hostId: string;
  service: string;
  status: OpsStatus;
  /** Evidence: the failing message, the route, exit code, journal tail. */
  detail?: Record<string, unknown>;
}

/** What the report did — the endpoint returns this so a reporter can log it. */
export type OpsOutcome =
  | { action: 'opened'; incidentId: string }
  | { action: 'suppressed'; incidentId: string } // already open; the common case
  | { action: 'closed'; incidentId: string; openMs: number }
  | { action: 'noop' }; // healthy, and it already was

// A service name becomes a separate incident stream, so a typo silently creates
// a stream nobody is watching while the real one looks quiet. The column is
// free text on purpose (new producers should not each need a migration), so the
// validation lives here instead: lowercase kebab-case, bounded.
const SERVICE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SERVICE_MAX = 64;

export function isValidService(service: string): boolean {
  return service.length > 0 && service.length <= SERVICE_MAX && SERVICE_RE.test(service);
}

/** The currently-open incident for this host+service, if any. */
export async function getOpenIncident(hostId: string, service: string): Promise<OpsEvent | null> {
  const { data, error } = await getClient()
    .from('ops_events')
    .select()
    .eq('host_id', hostId)
    .eq('service', service)
    .is('closed_at', null)
    .maybeSingle();
  if (error) throw new Error(`getOpenIncident failed: ${error.message}`);
  return data;
}

/**
 * Fold one observation into the incident list.
 *
 * The reporter is stateless and sends its CURRENT status every tick; this is
 * where those become transitions. Four cases, and three of them write nothing:
 *
 *   down + nothing open  -> OPEN a new incident
 *   down + already open  -> suppressed (the 5-min tick during an outage)
 *   ok   + one open      -> CLOSE it
 *   ok   + nothing open  -> noop (the overwhelmingly common case)
 *
 * Suppression is the point. Without it a 30-minute outage is six identical
 * rows, and any notifier built on top fires six times and gets muted.
 */
export async function recordOpsEvent(report: OpsReport): Promise<OpsOutcome> {
  const { hostId, service, status, detail } = report;
  const open = await getOpenIncident(hostId, service);

  if (status === 'down') {
    if (open) return { action: 'suppressed', incidentId: open.id };
    const { data, error } = await getClient()
      .from('ops_events')
      .insert({ host_id: hostId, service, detail: (detail ?? {}) as never })
      .select()
      .single();
    // A partial unique index allows only one open incident per host+service, so
    // two reports racing on a flapping provider cannot both open one. Losing
    // that race is not an error — the incident exists, which is all the caller
    // wanted. 23505 = unique_violation.
    if (error) {
      if (error.code === '23505') {
        const raced = await getOpenIncident(hostId, service);
        if (raced) return { action: 'suppressed', incidentId: raced.id };
      }
      throw new Error(`recordOpsEvent open failed: ${error.message}`);
    }
    if (!data) throw new Error('recordOpsEvent open failed: no row returned');
    return { action: 'opened', incidentId: data.id };
  }

  if (!open) return { action: 'noop' };

  const closedAt = new Date();
  const { error } = await getClient()
    .from('ops_events')
    .update({ closed_at: closedAt.toISOString(), resolved_detail: (detail ?? {}) as never })
    .eq('id', open.id);
  if (error) throw new Error(`recordOpsEvent close failed: ${error.message}`);
  return {
    action: 'closed',
    incidentId: open.id,
    openMs: closedAt.getTime() - new Date(open.opened_at).getTime(),
  };
}

/** Recent incidents for a host, newest first — the "what happened last night" read. */
export async function listRecentIncidents(hostId: string, limit = 50): Promise<OpsEvent[]> {
  const { data, error } = await getClient()
    .from('ops_events')
    .select()
    .eq('host_id', hostId)
    .order('opened_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRecentIncidents failed: ${error.message}`);
  return data ?? [];
}
