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

export async function listVisitsForJob(jobId: string): Promise<Visit[]> {
  const { data, error } = await getClient()
    .from('visits')
    .select()
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listVisitsForJob failed: ${error.message}`);
  return data ?? [];
}
