import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';

export type Visit = Database['public']['Tables']['visits']['Row'];

export interface CreateVisitInput {
  tenantId: string;
  jobId: string;
  technicianName?: string | null;
  scheduledAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  laborHours?: number | null;
  attributes?: Json; // L3
  sourceCaptureId?: string | null;
}

export async function createVisit(input: CreateVisitInput): Promise<Visit> {
  const { data, error } = await getClient()
    .from('visits')
    .insert({
      tenant_id: input.tenantId,
      job_id: input.jobId,
      technician_name: input.technicianName ?? null,
      scheduled_at: input.scheduledAt ?? null,
      started_at: input.startedAt ?? null,
      completed_at: input.completedAt ?? null,
      labor_hours: input.laborHours ?? null,
      attributes: input.attributes ?? {},
      source_capture_id: input.sourceCaptureId ?? null,
    })
    .select()
    .single();
  if (error || !data) throw new Error(`createVisit failed: ${error?.message ?? 'no row returned'}`);
  return data;
}

// The watcher's OTHER activity home — always paired with rawCaptures'
// listJobStampedCaptureTimes (see its two-homes note): visit rows minted on
// these jobs since a UTC floor. created_at is real UTC; the precise
// naive-local comparison happens in the caller.
export async function listVisitTimesForJobs(
  tenantId: string,
  jobIds: string[],
  sinceUtcIso: string,
): Promise<{ job_id: string; created_at: string }[]> {
  if (jobIds.length === 0) return []; // PostgREST `in.()` with zero values errors
  // PAGED for the same reason as listJobStampedCaptureTimes (see its note):
  // the silent 1000-row cap on an unordered read drops arbitrary rows.
  const PAGE = 1000;
  const out: { job_id: string; created_at: string }[] = [];
  for (let fromRow = 0; ; fromRow += PAGE) {
    const { data, error } = await getClient()
      .from('visits')
      .select('job_id, created_at')
      .eq('tenant_id', tenantId)
      .in('job_id', jobIds)
      .gte('created_at', sinceUtcIso)
      .order('created_at', { ascending: true })
      .range(fromRow, fromRow + PAGE - 1);
    if (error) throw new Error(`listVisitTimesForJobs failed: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

export async function listVisitsForJob(jobId: string): Promise<Visit[]> {
  const { data, error } = await getClient()
    .from('visits')
    .select()
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listVisitsForJob failed: ${error.message}`);
  return data ?? [];
}

// All visits across a customer's jobs, newest first. Visits carry no customer_id,
// so we reach them through the jobs relation and flatten.
export async function listVisitsForCustomer(customerId: string): Promise<Visit[]> {
  const { data, error } = await getClient()
    .from('jobs')
    .select('visits(*)')
    .eq('customer_id', customerId);
  if (error) throw new Error(`listVisitsForCustomer failed: ${error.message}`);
  const visits = (data ?? []).flatMap((job) => job.visits as Visit[]);
  return visits.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
