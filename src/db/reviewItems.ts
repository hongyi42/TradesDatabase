import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import { isUniqueViolation } from './rawCaptures.js';

export type ReviewItem = Database['public']['Tables']['review_items']['Row'];
export type ReviewStatus = Database['public']['Enums']['review_status'];

// The review kinds this cycle writes. A plain string column in the DB (new kinds
// must not need a migration); this union is the compile-time vocabulary.
export type ReviewKind =
  | 'sheet_ref_mismatch'
  | 'unknown_ref_capture'
  | 'pairing_verification'
  | 'pending_deactivation';

export interface UpsertOpenReviewItemInput {
  tenantId: string;
  kind: ReviewKind;
  subjectRef: string;
  suggestion?: string | null;
  detail?: Json;
}

// Open (or re-surface) a review item. At most ONE open item exists per
// (tenant, kind, subject) — enforced by the partial unique index — and callers
// need the row id on the retry path too (e.g. deactivate's confirmId), so on
// conflict this SELECTS and returns the existing open row. Insert-then-catch
// (not upsert) because supabase-js onConflict cannot infer a PARTIAL unique
// index — same pattern as appendRawCapture / upsertDroppedAudit.
export async function upsertOpenReviewItem(input: UpsertOpenReviewItemInput): Promise<ReviewItem> {
  const { data, error } = await getClient()
    .from('review_items')
    .insert({
      tenant_id: input.tenantId,
      kind: input.kind,
      subject_ref: input.subjectRef,
      suggestion: input.suggestion ?? null,
      detail: input.detail ?? {},
    })
    .select()
    .single();
  if (!error && data) return data;
  if (!isUniqueViolation(error)) {
    throw new Error(`upsertOpenReviewItem failed: ${error?.message ?? 'no row returned'}`);
  }
  const existing = await getClient()
    .from('review_items')
    .select()
    .eq('tenant_id', input.tenantId)
    .eq('kind', input.kind)
    .eq('subject_ref', input.subjectRef)
    .eq('status', 'open')
    .maybeSingle();
  if (existing.error || !existing.data) {
    throw new Error(
      `upsertOpenReviewItem failed: conflict but no open row found: ${existing.error?.message ?? 'none'}`,
    );
  }
  return existing.data;
}

// Flag an unknown-ref capture, at most once per source MESSAGE: a redelivery of
// the same message (matched on detail.externalId, any item status) never re-opens
// an item the manager already resolved, while a NEW message from a still-unknown
// ref after resolution legitimately re-flags. The caller's duplicate-status gate
// alone can't suppress redeliveries here: an unmatched capture has no linked L2,
// so recordFieldNote's redelivery takes the orphan-heal path and reports
// 'ingested', not 'duplicate' (observed live 2026-07-02).
export async function flagUnknownRefCapture(input: {
  tenantId: string;
  subjectRef: string;
  externalId?: string | null;
}): Promise<ReviewItem | null> {
  // Normalize falsy ids ('' as well as undefined) to null so the dedup check
  // and the stored detail always agree — an empty-string id must not bypass
  // the once-per-message suppression while storing '' in detail.
  const externalId = input.externalId || null;
  if (externalId) {
    const { data, error } = await getClient()
      .from('review_items')
      .select('id')
      .eq('tenant_id', input.tenantId)
      .eq('kind', 'unknown_ref_capture')
      .eq('subject_ref', input.subjectRef)
      .eq('detail->>externalId', externalId)
      .limit(1);
    if (error) throw new Error(`flagUnknownRefCapture failed: ${error.message}`);
    if (data && data.length > 0) return null; // this message was already flagged once
  }
  return upsertOpenReviewItem({
    tenantId: input.tenantId,
    kind: 'unknown_ref_capture',
    subjectRef: input.subjectRef,
    detail: { externalId },
  });
}

// Point-read of one OPEN item, tenant-guarded and optionally shape-guarded —
// the confirm-token lookup for deactivation (a forged/mismatched id resolves
// nothing because every predicate lives in the WHERE clause, and the read does
// not scale with the size of the tenant's review queue).
export async function getOpenReviewItem(
  id: string,
  tenantId: string,
  filters: { kind?: ReviewKind; subjectRef?: string } = {},
): Promise<ReviewItem | null> {
  let query = getClient()
    .from('review_items')
    .select()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'open');
  if (filters.kind) query = query.eq('kind', filters.kind);
  if (filters.subjectRef) query = query.eq('subject_ref', filters.subjectRef);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`getOpenReviewItem failed: ${error.message}`);
  return data;
}

export async function listOpenReviewItems(tenantId: string): Promise<ReviewItem[]> {
  const { data, error } = await getClient()
    .from('review_items')
    .select()
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listOpenReviewItems failed: ${error.message}`);
  return data ?? [];
}

// Close an item. Tenant-guarded: a cross-tenant (or unknown) id resolves nothing
// and returns null — the caller decides how to surface that.
export async function resolveReviewItem(
  id: string,
  tenantId: string,
  status: 'resolved' | 'dismissed',
  resolution?: string | null,
): Promise<ReviewItem | null> {
  const { data, error } = await getClient()
    .from('review_items')
    .update({ status, resolution: resolution ?? null, resolved_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .select()
    .maybeSingle();
  if (error) throw new Error(`resolveReviewItem failed: ${error.message}`);
  return data;
}
