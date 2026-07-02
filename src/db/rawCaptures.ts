import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';

export type RawCapture = Database['public']['Tables']['raw_captures']['Row'];
export type CaptureChannel = Database['public']['Enums']['capture_channel'];

export interface AppendRawCaptureInput {
  tenantId: string;
  channel: CaptureChannel;
  rawText?: string | null; // transcripts / notes
  blobPath?: string | null; // pointer into object storage (audio/photos)
  // The source's stable id (Gmail message id, webhook event id, …). Per-tenant
  // unique (uq_raw_captures_external_id, partial — null for technician/MCP captures).
  externalId?: string | null;
  // Person attribution: the badge-mapped technician ref, or `connector:<toolkit>`
  // for unattributed connector captures. Nullable — pre-column rows stay NULL.
  technicianRef?: string | null;
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
      external_id: input.externalId ?? null,
      technician_ref: input.technicianRef ?? null,
      metadata: input.metadata ?? {},
      customer_id: input.customerId ?? null,
      job_id: input.jobId ?? null,
      visit_id: input.visitId ?? null,
    })
    .select()
    .single();
  if (error || !data) {
    // Preserve the SQLSTATE code so callers (recordFieldNote's dedup backstop) can
    // detect a 23505 unique violation — a bare `new Error(message)` would drop it.
    const err = new Error(`appendRawCapture failed: ${error?.message ?? 'no row returned'}`);
    if (error && typeof error.code === 'string') (err as { code?: string }).code = error.code;
    throw err;
  }
  return data;
}

// Read-only lookup (the append-only trigger only blocks UPDATE/DELETE). Used by
// the write-path to reload a capture's verbatim text on a confirmation resume.
export async function getRawCapture(id: string): Promise<RawCapture | null> {
  const { data, error } = await getClient().from('raw_captures').select().eq('id', id).maybeSingle();
  if (error) throw new Error(`getRawCapture failed: ${error.message}`);
  return data;
}

// External-id dedup lookup, scoped per tenant (matches uq_raw_captures_external_id).
// The write-path uses this as a cheap fast-path; the unique index is the authority.
export async function getRawCaptureByExternalId(
  tenantId: string,
  externalId: string,
): Promise<RawCapture | null> {
  const { data, error } = await getClient()
    .from('raw_captures')
    .select()
    .eq('tenant_id', tenantId)
    .eq('external_id', externalId)
    .maybeSingle();
  if (error) throw new Error(`getRawCaptureByExternalId failed: ${error.message}`);
  return data;
}

// Postgres unique-violation (SQLSTATE 23505), as surfaced by supabase-js on the
// error object. Used by the write-path to turn a concurrent duplicate insert into
// a no-op instead of a 500 (the TOCTOU backstop behind the fast-path pre-check).
export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23505';
}

// Postgres foreign-key violation (SQLSTATE 23503) — e.g. a capture whose tenant_id
// is not a provisioned tenant. The webhook uses this to turn an unknown-tenant insert
// into a clean "give up" instead of a 401 retry storm.
export function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23503';
}

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

// True if any L2 row (customer/job/visit) links back to this capture via
// source_capture_id — i.e. extract→match→L2 succeeded for it. The write-path uses
// this to tell a FULLY-processed capture (real duplicate) from a HALF-processed one
// (L1 written, L2 build failed → orphan to be healed on redelivery).
export async function captureHasLinkedL2(captureId: string): Promise<boolean> {
  const client = getClient();
  for (const table of ['visits', 'jobs', 'customers'] as const) {
    const { data, error } = await client
      .from(table)
      .select('id')
      .eq('source_capture_id', captureId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`captureHasLinkedL2 failed on ${table}: ${error.message}`);
    if (data) return true;
  }
  return false;
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
