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
// It also holds the two ledgers' readers and writers — the grants and the firm's
// rule — which the manager's access tools call (src/mcp/tools/access.ts, access
// plan A, thoughts/shared/plans/2026-09-19-access-plan-a-the-managers-access-tools.md).
import { Constants, type Database } from './database.types.js';
import { getClient } from './client.js';
import { TERMINAL_JOB_STATUSES } from './jobs.js';
import { wrapDbError, type CaptureChannel } from './rawCaptures.js';
import { POSTGREST_MAX_ROWS, hitRowCap } from './rowCap.js';

export type AccessGrant = Database['public']['Tables']['access_grants']['Row'];
export type TechnicianViewRule = Database['public']['Tables']['technician_view_rules']['Row'];

// The widths a firm's rule can set (the table's CHECK is the authority).
export const TECHNICIAN_JOB_SCOPES = ['own_trips', 'serving', 'serving_history', 'whole_firm'] as const;
export type TechnicianJobScope = (typeof TECHNICIAN_JOB_SCOPES)[number];

export type GrantOpens = 'record' | 'record_and_notes';

// Every capture channel the database knows, for validating a firm's rule
// (technician_view_rules.technician_channels). Read from the generated enum, so
// a channel added by migration is accepted the day the types are regenerated.
export const CAPTURE_CHANNELS: readonly CaptureChannel[] = Constants.public.Enums.capture_channel;

// What a firm reads when it has set no channels of its own. The AUTHORITY is
// technician_view_of's coalesce (migration 20260917120000): this copy exists so
// a tool can say the default in words, and technicianView.test.ts pins the two
// together, because a rule that misdescribes the firm is worse than none.
export const TECHNICIAN_DEFAULT_CHANNELS: readonly CaptureChannel[] = [
  'technician_voice',
  'technician_note',
  'technician_photo',
];

export interface TechnicianView {
  // Every customer and job on the firm (the whole_firm rule).
  allScope: boolean;
  jobIds: Set<string>;
  customerIds: Set<string>;
  /** The firm told us her technicians may be told money figures. */
  moneyAll: boolean;
  /** Jobs and customers a grant opened the figures on. */
  moneyJobIds: Set<string>;
  moneyCustomerIds: Set<string>;
}

// A fresh object each time: the Sets are mutable, and one shared empty view
// widened by a careless caller would widen every roster-less read after it.
const emptyView = (): TechnicianView => ({
  allScope: false,
  jobIds: new Set(),
  customerIds: new Set(),
  moneyAll: false,
  moneyJobIds: new Set(),
  moneyCustomerIds: new Set(),
});

export const viewHasJob = (v: TechnicianView, id: string): boolean => v.allScope || v.jobIds.has(id);
export const viewHasCustomer = (v: TechnicianView, id: string): boolean =>
  v.allScope || v.customerIds.has(id);

// THE ONE MONEY QUESTION: may this person be told money here? The firm's posture,
// or a grant on this job or this customer. The SQL twin is view_money_open.
export const viewShowsMoney = (
  v: TechnicianView,
  where: { jobId?: string | null; customerId?: string | null },
): boolean =>
  v.moneyAll ||
  (!!where.jobId && v.moneyJobIds.has(where.jobId)) ||
  (!!where.customerId && v.moneyCustomerIds.has(where.customerId));

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
    moneyAll: data.money_all === true,
    moneyJobIds: new Set(data.money_job_ids ?? []),
    moneyCustomerIds: new Set(data.money_customer_ids ?? []),
  };
}

export interface InsertAccessGrantInput {
  tenantId: string;
  technicianId: string;
  // Three shapes, and the table's CHECK (access_grants_scope) refuses any other:
  //   one customer, with `opens`;  one job, with `opens`;  or
  //   NEITHER — a person-wide money grant: `opensMoney: true` and no `opens`,
  //   which opens the figures on whatever she can already open and nothing more.
  customerId?: string;
  jobId?: string;
  opens?: GrantOpens | null;
  /** …and the figures on what it covers (operator 2026-09-15: money can be opened). */
  opensMoney?: boolean;
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
      opens: input.opens ?? null,
      opens_money: input.opensMoney ?? false,
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

// A grant with the names a reply needs: who it is for, and what it opens.
export type AccessGrantWithNames = AccessGrant & {
  technicians: { ref: string; display_name: string; tenant_id: string } | null;
  customers: { name: string; tenant_id: string } | null;
  jobs: {
    title: string | null;
    customer_id: string;
    tenant_id: string;
    customers: { name: string; tenant_id: string } | null;
  } | null;
};

const GRANT_WITH_NAMES =
  '*, technicians(ref, display_name, tenant_id), customers(name, tenant_id), ' +
  'jobs(title, customer_id, tenant_id, customers(name, tenant_id))';

// EVERY EMBED IS RE-CHECKED FOR THE FIRM. The foreign keys are id-only, and the
// writer does not refuse another firm's customer or job (such a grant opens
// nothing — technician_view_of re-checks the tenant on every join), so an embed
// that followed one would put ANOTHER firm's names in this firm's reply. Dropped
// to null here, exactly as v_access_grants' tenant-checked joins drop them.
function sameFirmNames(g: AccessGrantWithNames): AccessGrantWithNames {
  const mine = <T extends { tenant_id: string } | null>(e: T): T | null =>
    e && e.tenant_id === g.tenant_id ? e : null;
  const job = mine(g.jobs);
  return {
    ...g,
    technicians: mine(g.technicians),
    customers: mine(g.customers),
    jobs: job ? { ...job, customers: mine(job.customers) } : null,
  };
}

// One grant, in any state (live, expired or revoked), on this firm only. Null for
// an unknown id or another firm's grant — a caller cannot tell the two apart, and
// should not be able to.
export async function getAccessGrant(
  id: string,
  tenantId: string,
): Promise<AccessGrantWithNames | null> {
  const { data, error } = await getClient()
    .from('access_grants')
    .select(GRANT_WITH_NAMES)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw wrapDbError('getAccessGrant failed', error);
  return data ? sameFirmNames(data as unknown as AccessGrantWithNames) : null;
}

// The grants that open something right now — not revoked, not expired — newest
// first. Told, not paged (the retrieval-layer ruling): `capped` says the list may
// be short.
export async function listLiveAccessGrants(
  tenantId: string,
  opts: { technicianId?: string } = {},
): Promise<{ rows: AccessGrantWithNames[]; capped: boolean }> {
  let query = getClient()
    .from('access_grants')
    .select(GRANT_WITH_NAMES)
    .eq('tenant_id', tenantId)
    .is('revoked_at', null)
    // Quoted: a timestamp carries `:` and `.`, which PostgREST's logic-tree
    // grammar reserves outside double quotes.
    .or(`expires_at.is.null,expires_at.gt."${new Date().toISOString()}"`)
    .order('created_at', { ascending: false })
    .limit(POSTGREST_MAX_ROWS);
  if (opts.technicianId) query = query.eq('technician_id', opts.technicianId);
  const { data, error } = await query;
  if (error) throw wrapDbError('listLiveAccessGrants failed', error);
  const rows = ((data ?? []) as unknown as AccessGrantWithNames[]).map(sameFirmNames);
  return { rows, capped: hitRowCap(rows.length) };
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

// The firm's rule as stored, or null when the firm has none (every field then
// takes the shipped default, which lives only in technician_view_of).
export async function getTechnicianViewRule(tenantId: string): Promise<TechnicianViewRule | null> {
  const { data, error } = await getClient()
    .from('technician_view_rules')
    .select()
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw wrapDbError('getTechnicianViewRule failed', error);
  return data ?? null;
}

export interface TechnicianViewRuleInput {
  jobScope?: TechnicianJobScope | null;
  /** 'status' (the shipped default) or 'amounts'. */
  money?: 'status' | 'amounts' | null;
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
        money: rule.money ?? null,
        technician_channels: rule.technicianChannels ?? null,
        hidden_tags: rule.hiddenTags ?? null,
        set_by: setBy,
      },
      { onConflict: 'tenant_id' },
    );
  if (error) throw wrapDbError('setTechnicianViewRule failed', error);
}
