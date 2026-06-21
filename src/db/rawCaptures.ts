import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';

export type RawCapture = Database['public']['Tables']['raw_captures']['Row'];
export type CaptureChannel = Database['public']['Enums']['capture_channel'];

export interface AppendRawCaptureInput {
  tenantId: string;
  channel: CaptureChannel;
  rawText?: string | null; // transcripts / notes
  blobPath?: string | null; // pointer into object storage (audio/photos)
  metadata?: Json;
  // Provenance: which entity this capture informed, as known at capture time.
  customerId?: string | null;
  jobId?: string | null;
  visitId?: string | null;
}

// L1 is append-only. This module exposes insert only — no update or delete —
// mirroring the DB trigger that enforces the same invariant.
export async function appendRawCapture(input: AppendRawCaptureInput): Promise<RawCapture> {
  const { data, error } = await getClient()
    .from('raw_captures')
    .insert({
      tenant_id: input.tenantId,
      channel: input.channel,
      raw_text: input.rawText ?? null,
      blob_path: input.blobPath ?? null,
      metadata: input.metadata ?? {},
      customer_id: input.customerId ?? null,
      job_id: input.jobId ?? null,
      visit_id: input.visitId ?? null,
    })
    .select()
    .single();
  if (error || !data) throw new Error(`appendRawCapture failed: ${error?.message ?? 'no row returned'}`);
  return data;
}

// Read-only lookup (the append-only trigger only blocks UPDATE/DELETE). Used by
// the write-path to reload a capture's verbatim text on a confirmation resume.
export async function getRawCapture(id: string): Promise<RawCapture | null> {
  const { data, error } = await getClient().from('raw_captures').select().eq('id', id).maybeSingle();
  if (error) throw new Error(`getRawCapture failed: ${error.message}`);
  return data;
}

// Captures directly stamped with a job_id, newest first. (Tech notes resolved via
// L2.source_capture_id won't appear here — getCustomerContext unions those in.)
export async function listRawCapturesForJob(jobId: string): Promise<RawCapture[]> {
  const { data, error } = await getClient()
    .from('raw_captures')
    .select()
    .eq('job_id', jobId)
    .order('captured_at', { ascending: false });
  if (error) throw new Error(`listRawCapturesForJob failed: ${error.message}`);
  return data ?? [];
}

// Captures directly stamped with a customer_id, newest first.
export async function listRawCapturesForCustomer(customerId: string): Promise<RawCapture[]> {
  const { data, error } = await getClient()
    .from('raw_captures')
    .select()
    .eq('customer_id', customerId)
    .order('captured_at', { ascending: false });
  if (error) throw new Error(`listRawCapturesForCustomer failed: ${error.message}`);
  return data ?? [];
}
