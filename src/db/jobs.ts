import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';

export type Job = Database['public']['Tables']['jobs']['Row'];
export type JobStatus = Database['public']['Enums']['job_status'];

// The customer fields a route/day view needs alongside a job — one embedded
// select instead of a per-row customer lookup.
export type JobCustomerAddress = Pick<
  Database['public']['Tables']['customers']['Row'],
  'name' | 'address_line1' | 'address_line2' | 'city' | 'state' | 'postal_code'
>;
export type JobWithCustomer = Job & { customers: JobCustomerAddress | null };

// Hardcoded, auditable state machine (overview §5: identity/pricing/status are
// code, not the model's guess). The authoritative "done" is a downstream event
// (invoice paid), so paid/cancelled/declined are terminal here.
export const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  open: ['in_progress', 'cancelled', 'declined'],
  in_progress: ['completed', 'cancelled'],
  completed: ['invoiced'],
  invoiced: ['paid'],
  paid: [],
  cancelled: [],
  declined: [],
};

export interface CreateJobInput {
  tenantId: string;
  customerId: string;
  title?: string | null;
  jobType?: string | null;
  status?: JobStatus;
  priceCents?: number | null;
  attributes?: Json; // L3
  sourceCaptureId?: string | null;
}

export async function createJob(input: CreateJobInput): Promise<Job> {
  const { data, error } = await getClient()
    .from('jobs')
    .insert({
      tenant_id: input.tenantId,
      customer_id: input.customerId,
      title: input.title ?? null,
      job_type: input.jobType ?? null,
      status: input.status ?? 'open',
      price_cents: input.priceCents ?? null,
      attributes: input.attributes ?? {},
      source_capture_id: input.sourceCaptureId ?? null,
    })
    .select()
    .single();
  if (error || !data) throw new Error(`createJob failed: ${error?.message ?? 'no row returned'}`);
  return data;
}

// One CAS attempt at merging a standing-fact bundle under `key` — the job twin
// of trySetCustomerAttribute (see customers.ts for the why of the updated_at
// guard). Exported single-attempt so tests can force the CAS miss.
export async function trySetJobAttribute(row: Job, key: string, bundle: Json): Promise<Job | null> {
  const base =
    row.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes)
      ? (row.attributes as Record<string, Json>)
      : {};
  const { data, error } = await getClient()
    .from('jobs')
    .update({ attributes: { ...base, [key]: bundle } })
    .eq('id', row.id)
    .eq('updated_at', row.updated_at)
    .select()
    .maybeSingle();
  if (error) throw new Error(`trySetJobAttribute failed: ${error.message}`);
  return data;
}

// Upsert one standing-fact key onto a job's L3 attributes (read → guarded
// merge, retried on a CAS miss). Tenant guarding is the caller's job.
export async function setJobAttribute(id: string, key: string, bundle: Json): Promise<Job> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getJob(id);
    if (!row) throw new Error(`setJobAttribute: job ${id} not found`);
    const updated = await trySetJobAttribute(row, key, bundle);
    if (updated) return updated;
  }
  throw new Error(`setJobAttribute: job ${id} changed concurrently; write not applied`);
}

export async function getJob(id: string): Promise<Job | null> {
  const { data, error } = await getClient().from('jobs').select().eq('id', id).maybeSingle();
  if (error) throw new Error(`getJob failed: ${error.message}`);
  return data;
}

export async function listJobsForCustomer(customerId: string): Promise<Job[]> {
  const { data, error } = await getClient()
    .from('jobs')
    .select()
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listJobsForCustomer failed: ${error.message}`);
  return data ?? [];
}

// Jobs (with their customer's name + address embedded) for a set of ids —
// the day-route reader's batch lookup. Tenant-scoped in the query itself:
// this fans out to customer PII, so the guard lives here, not two files up
// in whichever caller happened to scope its ids. Empty input short-circuits:
// PostgREST's `in.()` with zero values is an error, not an empty result.
export async function listJobsWithCustomerByIds(
  tenantId: string,
  jobIds: string[],
): Promise<JobWithCustomer[]> {
  if (jobIds.length === 0) return [];
  const { data, error } = await getClient()
    .from('jobs')
    .select('*, customers(name, address_line1, address_line2, city, state, postal_code)')
    .eq('tenant_id', tenantId)
    .in('id', jobIds);
  if (error) throw new Error(`listJobsWithCustomerByIds failed: ${error.message}`);
  return (data ?? []) as JobWithCustomer[];
}

export async function updateJobStatus(id: string, next: JobStatus): Promise<Job> {
  const current = await getJob(id);
  if (!current) throw new Error(`updateJobStatus: job ${id} not found`);
  const allowed = ALLOWED_TRANSITIONS[current.status];
  if (!allowed.includes(next)) {
    throw new Error(
      `Illegal job status transition: ${current.status} → ${next} ` +
        `(allowed: ${allowed.join(', ') || 'none'})`,
    );
  }
  // Guard the write on the status we validated against, so a concurrent
  // transition can't be silently lost: if another writer moved the job between
  // our read and this update, no row matches and we surface it instead of
  // overwriting.
  const { data, error } = await getClient()
    .from('jobs')
    .update({ status: next }) // updated_at is stamped by the DB trigger
    .eq('id', id)
    .eq('status', current.status)
    .select()
    .maybeSingle();
  if (error) throw new Error(`updateJobStatus failed: ${error.message}`);
  if (!data) {
    throw new Error(
      `updateJobStatus: job ${id} changed concurrently (was '${current.status}'); transition not applied`,
    );
  }
  return data;
}
