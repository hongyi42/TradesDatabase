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
  | 'pending_deactivation'
  | 'pending_outbound_send'
  | 'pending_field_note'
  | 'pending_retraction'
  | 'pending_standing_fact'
  | 'offboarding_reminder'
  | 'pending_booking'
  | 'pending_visit_move'
  | 'pending_visit_cancel'
  | 'pending_seat_add'
  // Onboarding task-reminder (NOT a staged token): opened when a seat is
  // confirmed, auto-resolved by set_availability, dismissable as the explicit
  // "no availability yet" acknowledgment (user decision 2026-07-20).
  | 'availability_setup';

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
  // Same lookup findOpenReviewItem does — one definition of "the open row".
  const existing = await findOpenReviewItem(input.tenantId, input.kind, input.subjectRef);
  if (!existing) {
    throw new Error('upsertOpenReviewItem failed: conflict but no open row found');
  }
  return existing;
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

// The open item for a (kind, subject), if any — WITHOUT creating one (the
// upsert would). Used to close a stale item on deactivation and to resolve
// the reminder when an offboarding completes. At most one row can match
// (partial unique index on open items).
export async function findOpenReviewItem(
  tenantId: string,
  kind: ReviewKind,
  subjectRef: string,
): Promise<ReviewItem | null> {
  const { data, error } = await getClient()
    .from('review_items')
    .select()
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .eq('subject_ref', subjectRef)
    .eq('status', 'open')
    .maybeSingle();
  if (error) throw new Error(`findOpenReviewItem failed: ${error.message}`);
  return data;
}

// Close the open item of a (kind, subject) in ONE conditional UPDATE — legal
// because the partial unique index guarantees at most one open row. Returns
// the closed row, or null if nothing was open. Replaces the find-then-resolve
// two-round-trip pattern at every lifecycle transition (deactivate closes the
// pairing item, reactivate/expiry close the reminder), which also closes the
// read-to-write race window those pairs had.
export async function resolveOpenReviewItemFor(
  tenantId: string,
  kind: ReviewKind,
  subjectRef: string,
  status: 'resolved' | 'dismissed',
  resolution?: string | null,
): Promise<ReviewItem | null> {
  const { data, error } = await getClient()
    .from('review_items')
    .update({ status, resolution: resolution ?? null, resolved_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .eq('subject_ref', subjectRef)
    .eq('status', 'open')
    .select()
    .maybeSingle();
  if (error) throw new Error(`resolveOpenReviewItemFor failed: ${error.message}`);
  return data;
}

// Remind the manager an offboarding is about to become permanent — ONCE per
// offboarding episode: any-status dedup on detail.startedAt (the same pattern
// as flagUnknownRefCapture), so a dismissed reminder stays dismissed even
// though the 15-min cron keeps observing "remaining ≤ 2 days" until expiry.
export async function flagOffboardingReminder(input: {
  tenantId: string;
  subjectRef: string;
  startedAt: string; // the episode key: the row's offboarding_started_at
  graceEndsAt: string;
}): Promise<ReviewItem | null> {
  const { data, error } = await getClient()
    .from('review_items')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('kind', 'offboarding_reminder')
    .eq('subject_ref', input.subjectRef)
    .eq('detail->>startedAt', input.startedAt)
    .limit(1);
  if (error) throw new Error(`flagOffboardingReminder failed: ${error.message}`);
  if (data && data.length > 0) return null; // this episode was already reminded
  // Supersede a stale open reminder from a PREVIOUS episode (e.g. reactivate's
  // advisory close failed): without this, the insert below hits the one-open-
  // item index and returns the old row — the manager would keep seeing the old
  // episode's already-past deadline while the new episode never surfaces.
  await resolveOpenReviewItemFor(
    input.tenantId,
    'offboarding_reminder',
    input.subjectRef,
    'resolved',
    'superseded by a new offboarding episode',
  );
  return upsertOpenReviewItem({
    tenantId: input.tenantId,
    kind: 'offboarding_reminder',
    subjectRef: input.subjectRef,
    detail: { startedAt: input.startedAt, graceEndsAt: input.graceEndsAt },
  });
}

// Replace an OPEN item's detail payload (all guards in the WHERE clause: id +
// tenant + open). Returns null if the item is no longer open — the caller
// restarts instead of writing into a consumed/cancelled token. One caller: the
// record_field_note identity-resume step, which stores the resolved customer on
// the staged note so commit uses exactly what the preview showed.
export async function updateOpenReviewItemDetail(
  id: string,
  tenantId: string,
  detail: Json,
): Promise<ReviewItem | null> {
  const { data, error } = await getClient()
    .from('review_items')
    .update({ detail })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .select()
    .maybeSingle();
  if (error) throw new Error(`updateOpenReviewItemDetail failed: ${error.message}`);
  return data;
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

// Re-annotate an already-CLOSED item's resolution text. The one caller is the
// send_email confirm path: the token is consumed ('send confirmed by …')
// BEFORE the send for at-most-once, so a send failure must rewrite the
// resolution or the durable record reads as a confirmed send that never ran
// (review finding). Never touches open items — consuming stays the job of
// resolveReviewItem.
export async function annotateResolvedReviewItem(
  id: string,
  tenantId: string,
  resolution: string,
): Promise<ReviewItem | null> {
  const { data, error } = await getClient()
    .from('review_items')
    .update({ resolution })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .neq('status', 'open')
    .select()
    .maybeSingle();
  if (error) throw new Error(`annotateResolvedReviewItem failed: ${error.message}`);
  return data;
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
