import type { Database } from './database.types.js';
import { getClient } from './client.js';

export type JobTypeDuration = Database['public']['Tables']['job_type_durations']['Row'];

// job_type values reach jobs verbatim from the extractor ("Install" vs
// "install"), so byte-exact matching would silently miss configured durations
// and fall back to the tenant default — wrong booking lengths with no error.
// Normalize once here (write AND read) like service_cities. (Review finding.)
const normalizeJobType = (jobType: string) => jobType.trim().toLowerCase();

// Manager-editable per-type default ("maintenance 60, install 480"). Plain
// unique index on (tenant_id, job_type) → supabase-js onConflict works here
// (unlike the partial-index cases, which need insert-then-catch).
export async function upsertJobTypeDuration(
  tenantId: string,
  jobType: string,
  minutes: number,
): Promise<JobTypeDuration> {
  const { data, error } = await getClient()
    .from('job_type_durations')
    .upsert(
      { tenant_id: tenantId, job_type: normalizeJobType(jobType), minutes },
      { onConflict: 'tenant_id,job_type' },
    )
    .select()
    .single();
  if (error || !data) {
    throw new Error(`upsertJobTypeDuration failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

// The duration the scheduler should assume for a job type: the tenant's
// specific row if one exists, else the tenant-wide default_job_minutes
// (migration default 120 — user decision). jobType null = untyped job.
export async function getJobDurationMinutes(
  tenantId: string,
  jobType: string | null,
): Promise<number> {
  if (jobType) {
    const { data, error } = await getClient()
      .from('job_type_durations')
      .select('minutes')
      .eq('tenant_id', tenantId)
      .eq('job_type', normalizeJobType(jobType))
      .maybeSingle();
    if (error) throw new Error(`getJobDurationMinutes failed: ${error.message}`);
    if (data) return data.minutes;
  }
  const { data, error } = await getClient()
    .from('tenants')
    .select('default_job_minutes')
    .eq('id', tenantId)
    .single();
  if (error || !data) {
    throw new Error(`getJobDurationMinutes failed: ${error?.message ?? 'tenant not found'}`);
  }
  return data.default_job_minutes;
}
