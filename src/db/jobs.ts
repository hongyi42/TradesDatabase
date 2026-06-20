import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';

export type Job = Database['public']['Tables']['jobs']['Row'];
export type JobStatus = Database['public']['Enums']['job_status'];

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
