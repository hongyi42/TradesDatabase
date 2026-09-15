// The technician limited view, read from TypeScript (plan
// 2026-09-15-the-retrieval-layer-2-the-technician-limited-view).
//
// The RULE lives in the database — technician_view_of in migration
// 20260917120000_technician_view.sql works out which jobs and customers a
// technician may open, and the capture reads apply it themselves. This module is
// for the tool doors the SQL readers do not cover (find_customer, get_job,
// record_standing_fact): it fetches that same view, once, so a membership test
// here is a set lookup against the database's answer, never a second rule.
//
// It also holds the two ledgers' writers — the grants and the firm's rule — which
// the manager-seat verbs of the request-flow task will call
// (20260915-the-technician-access-request-flow-tech). Nothing in the product
// writes them yet; the tests do.
import type { Database } from './database.types.js';
import { getClient } from './client.js';
import { TERMINAL_JOB_STATUSES } from './jobs.js';
import { wrapDbError, type CaptureChannel } from './rawCaptures.js';

export type AccessGrant = Database['public']['Tables']['access_grants']['Row'];
export type TechnicianViewRule = Database['public']['Tables']['technician_view_rules']['Row'];

// The widths a firm's rule can set (the table's CHECK is the authority).
export const TECHNICIAN_JOB_SCOPES = ['own_trips', 'serving', 'serving_history', 'whole_firm'] as const;
export type TechnicianJobScope = (typeof TECHNICIAN_JOB_SCOPES)[number];

export type GrantOpens = 'record' | 'record_and_notes';

export interface TechnicianView {
  // Every customer and job on the firm (the whole_firm rule).
  allScope: boolean;
  jobIds: Set<string>;
  customerIds: Set<string>;
}

// A fresh object each time: the Sets are mutable, and one shared empty view
// widened by a careless caller would widen every roster-less read after it.
const emptyView = (): TechnicianView => ({ allScope: false, jobIds: new Set(), customerIds: new Set() });

export const viewHasJob = (v: TechnicianView, id: string): boolean => v.allScope || v.jobIds.has(id);
export const viewHasCustomer = (v: TechnicianView, id: string): boolean =>
  v.allScope || v.customerIds.has(id);

// Who this technician is serving. A null id (a badge with no roster row) is the
// empty view without a round trip — the database would answer the same.
export async function getTechnicianView(
  tenantId: string,
  technicianId: string | null,
): Promise<TechnicianView> {
  if (!technicianId) return emptyView();
  const { data, error } = await getClient().rpc('technician_view_of', {
    p_tenant: tenantId,
    p_technician: technicianId,
    // The one definition of "finished work", derived from the job state machine.
    p_terminal_statuses: [...TERMINAL_JOB_STATUSES],
  });
  if (error) throw wrapDbError('technician_view_of failed', error);
  if (!data) return emptyView();
  return {
    allScope: data.all_scope === true,
    jobIds: new Set(data.job_ids ?? []),
    customerIds: new Set(data.customer_ids ?? []),
  };
}

export interface InsertAccessGrantInput {
  tenantId: string;
  technicianId: string;
  // Exactly one of the two (the table's CHECK refuses both or neither).
  customerId?: string;
  jobId?: string;
  opens: GrantOpens;
  expiresAt?: string | null; // null / absent = standing
  requestedBy?: string | null;
  grantedBy: string;
  reason: string;
}

export async function insertAccessGrant(input: InsertAccessGrantInput): Promise<AccessGrant> {
  const { data, error } = await getClient()
    .from('access_grants')
    .insert({
      tenant_id: input.tenantId,
      technician_id: input.technicianId,
      customer_id: input.customerId ?? null,
      job_id: input.jobId ?? null,
      opens: input.opens,
      expires_at: input.expiresAt ?? null,
      requested_by: input.requestedBy ?? null,
      granted_by: input.grantedBy,
      reason: input.reason,
    })
    .select()
    .single();
  if (error || !data) throw wrapDbError('insertAccessGrant failed', error);
  return data;
}

// The one change a grant takes: its revocation stamp, once. False when there was
// nothing to revoke (unknown id, another firm's grant, already revoked).
export async function revokeAccessGrant(
  id: string,
  tenantId: string,
  by: string,
  reason: string,
): Promise<boolean> {
  const { data, error } = await getClient()
    .from('access_grants')
    .update({ revoked_at: new Date().toISOString(), revoked_by: by, revoke_reason: reason })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('revoked_at', null)
    .select('id');
  if (error) throw wrapDbError('revokeAccessGrant failed', error);
  return (data ?? []).length > 0;
}

export interface TechnicianViewRuleInput {
  jobScope?: TechnicianJobScope | null;
  technicianChannels?: CaptureChannel[] | null;
  hiddenTags?: string[] | null;
}

// Set a firm's rule (a field left out or null = the shipped default), or delete
// it with `null`. The defaults themselves live only in technician_view_of.
export async function setTechnicianViewRule(
  tenantId: string,
  rule: TechnicianViewRuleInput | null,
  setBy: string,
): Promise<void> {
  if (rule === null) {
    const { error } = await getClient().from('technician_view_rules').delete().eq('tenant_id', tenantId);
    if (error) throw wrapDbError('setTechnicianViewRule (delete) failed', error);
    return;
  }
  const { error } = await getClient()
    .from('technician_view_rules')
    .upsert(
      {
        tenant_id: tenantId,
        job_scope: rule.jobScope ?? null,
        technician_channels: rule.technicianChannels ?? null,
        hidden_tags: rule.hiddenTags ?? null,
        set_by: setBy,
      },
      { onConflict: 'tenant_id' },
    );
  if (error) throw wrapDbError('setTechnicianViewRule failed', error);
}
