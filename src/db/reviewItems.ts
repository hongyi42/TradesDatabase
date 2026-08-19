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
  | 'pending_job_cancel'
  | 'pending_seat_add'
  // The staged freeze plan (plan 4b-3): ONE open token per TENANT, kind-wide
  // (staging dismisses every open one first — see findOpenReviewItemsByKind).
  | 'pending_freeze'
  // The staged re-solve plan (plan 2026-07-30): same one-per-tenant kind-wide
  // rule; no cross-kind supersede with pending_freeze — committing either
  // bumps the schedule version, which stales the other at confirm.
  | 'pending_resolve'
  // The staged undo of the latest committed run (plan 2026-07-30 Phase 5):
  // one per tenant kind-wide; 15-MINUTE TTL (the send_email fresh-mistake
  // idiom, NOT the 12h proposal kernel) — an undo is reached for right after
  // the run, never rediscovered the next morning.
  | 'pending_undo'
  // Onboarding task-reminder (NOT a staged token): opened when a seat is
  // confirmed, auto-resolved by set_availability, dismissable as the explicit
  // "no availability yet" acknowledgment (user decision 2026-07-20).
  | 'availability_setup'
  // A customer phone call whose caller-ID matched no customer (plan 2026-08-04).
  // The agentless phone path can't ask "which customer?", so the unmatched call is
  // flagged for the manager to link/create (resolve) or mark spam/wrong-number
  // (dismiss). subject_ref = the parked L1 captureId → one open item per call,
  // idempotent across worker retries.
  | 'unlinked_call'
  // A classified inbound call that needs a HUMAN to act (reschedule/cancel/
  // question/complaint) or one the router couldn't classify at all (plan
  // 2026-08-06). The agentless worker NEVER auto-executes these — it opens ONE
  // review per call (subject_ref = the L1 captureId → deduped by the partial
  // unique index, retry-safe) with the intent list carried in `detail`, and
  // pushes the tenant's managers. Free-text kind → no migration.
  | 'call_action'
  // Stage-0 watcher (plan 2026-08-15 feature A): a confirmed visit whose
  // scheduled end passed with no field report or status change. NON-token —
  // the manager resolves/dismisses freely via resolve_review; detail stays
  // small, no summarizer needed. subject_ref = the assignment id.
  | 'overdue_visit_gap'
  // Detector #2 (plan 2026-08-19): a job whose work is done but whose parts
  // cost was never recorded. subject_ref is the JOB id, not an assignment —
  // the only kind so far whose subject is not a visit.
  | 'job_cost_gap';

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

// Flag an overdue-visit gap, at most ONCE PER ASSIGNMENT — EVER: any-status
// dedup (the flagUnknownRefCapture idiom minus the detail key — an
// assignment's end never recurs, so a resolved/dismissed item must never
// re-open; the open-only partial unique index alone would re-flag forever).
// Returns null when this assignment was ever flagged before. The watcher's
// auto-resolve sweep reads detail.endsAtLocal to decide whether the gap has
// since been filled.
export async function flagNudgeGap(input: {
  tenantId: string;
  kind: ReviewKind; // which gap archetype — the registry's spec.kind
  subjectRef: string; // assignment id for a visit gap; job id for a job-scoped one
  jobId: string;
  technicianRef: string | null; // routing data: whom the manager would ask
  // Null for kinds whose subject is not a visit — a job-scoped gap has no
  // visit window. The visit-gap auto-resolve reads startsAtLocal as its
  // compare bound, so a kind that omits it must not rely on that path.
  startsAtLocal?: string | null;
  endsAtLocal?: string | null;
  suggestion: string;
  // Set when this item is the ladder's RUNG 2 (Stage 1): the silent nudge it
  // grew out of — the audit thread from question to manager item.
  escalatedFromNudge?: string;
}): Promise<ReviewItem | null> {
  const { data, error } = await getClient()
    .from('review_items')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('kind', input.kind)
    .eq('subject_ref', input.subjectRef)
    .limit(1);
  if (error) throw new Error(`flagNudgeGap failed: ${error.message}`);
  if (data && data.length > 0) return null; // this subject was already flagged once
  return upsertOpenReviewItem({
    tenantId: input.tenantId,
    kind: input.kind,
    subjectRef: input.subjectRef,
    suggestion: input.suggestion,
    detail: {
      jobId: input.jobId,
      technicianRef: input.technicianRef,
      // Omitted entirely when absent, so a job-scoped item carries no null
      // visit bounds for the open-gap reader to trip over.
      ...(input.startsAtLocal ? { startsAtLocal: input.startsAtLocal } : {}),
      ...(input.endsAtLocal ? { endsAtLocal: input.endsAtLocal } : {}),
      ...(input.escalatedFromNudge ? { escalatedFromNudge: input.escalatedFromNudge } : {}),
    },
  });
}

// The visit-gap flagger, unchanged for every existing caller: a thin wrapper
// that pins the kind and the assignment-as-subject convention.
export async function flagOverdueVisitGap(input: {
  tenantId: string;
  assignmentId: string;
  jobId: string;
  technicianRef: string | null;
  startsAtLocal: string;
  endsAtLocal: string;
  suggestion: string;
  escalatedFromNudge?: string;
}): Promise<ReviewItem | null> {
  return flagNudgeGap({
    tenantId: input.tenantId,
    kind: 'overdue_visit_gap',
    subjectRef: input.assignmentId,
    jobId: input.jobId,
    technicianRef: input.technicianRef,
    startsAtLocal: input.startsAtLocal,
    endsAtLocal: input.endsAtLocal,
    suggestion: input.suggestion,
    ...(input.escalatedFromNudge ? { escalatedFromNudge: input.escalatedFromNudge } : {}),
  });
}

// Is this gap ALREADY on a manager surface? flagNudgeGap returns null for two
// opposite reasons — the once-ever dedup found an existing item, or the insert
// produced nothing — and the terminal-failure doctrine needs to tell them
// apart: closing a nudge is only safe when the manager HAS the gap, and
// "already flagged" means they do. Only read on the null path, which is rare.
export async function reviewItemExistsFor(
  tenantId: string,
  kind: ReviewKind,
  subjectRef: string,
): Promise<boolean> {
  const { data, error } = await getClient()
    .from('review_items')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .eq('subject_ref', subjectRef)
    .limit(1);
  if (error) throw new Error(`reviewItemExistsFor failed: ${error.message}`);
  return (data ?? []).length > 0;
}

// The watcher's batched cap pre-filter (final-review finding): which of these
// subjects were EVER flagged, any status? Without it, stale flagged-but-
// unfilled gaps re-enter the 72h candidate window every tick and permanently
// occupy the per-tick cap — flagOverdueVisitGap's per-item dedup would return
// null, but only AFTER the cap already spent its slots on them, starving
// genuinely new gaps for up to three days. Bounded: `in()` over the caller's
// candidate ids, never a tenant-wide scan.
export async function listEverFlaggedSubjectRefs(
  tenantId: string,
  kind: ReviewKind,
  subjectRefs: string[],
): Promise<string[]> {
  if (subjectRefs.length === 0) return []; // PostgREST `in.()` with zero values errors
  const { data, error } = await getClient()
    .from('review_items')
    .select('subject_ref')
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .in('subject_ref', subjectRefs);
  if (error) throw new Error(`listEverFlaggedSubjectRefs failed: ${error.message}`);
  return (data ?? []).map((r) => r.subject_ref);
}

// Flag a phone call whose caller-ID matched no customer, for the manager to link
// or dismiss. subject_ref = the parked L1 captureId, so a worker retry on the same
// capture returns the existing open item (via the partial unique index) rather
// than stacking duplicates — no separate dedup needed. suggestion carries the
// caller number so list_pending_reviews shows who to call back.
export async function openUnlinkedCallReview(input: {
  tenantId: string;
  captureId: string;
  callerPhone?: string | null;
  snippet?: string | null;
}): Promise<ReviewItem> {
  return upsertOpenReviewItem({
    tenantId: input.tenantId,
    kind: 'unlinked_call',
    subjectRef: input.captureId,
    suggestion: input.callerPhone ?? null,
    detail: { callerPhone: input.callerPhone ?? null, snippet: input.snippet ?? null },
  });
}

// Open a review for a classified call that needs a human to ACT — a reschedule,
// cancel, question, or complaint the agentless worker must never auto-execute,
// or an `['unclassified']` fail-safe when the router gave up. subject_ref = the
// L1 captureId, so a worker retry on the same capture returns the existing open
// item (partial unique index) instead of stacking duplicates — the intent list
// travels in `detail` rather than the kind, so ONE `call_action` row covers a
// mixed call and re-classification never forks a second review. suggestion
// carries the caller number so the pull queue shows who to call back.
export async function openCallActionReview(input: {
  tenantId: string;
  captureId: string;
  intents: string[];
  priority?: 'normal' | 'high';
  callerPhone?: string | null;
  snippet?: string | null;
}): Promise<ReviewItem> {
  return upsertOpenReviewItem({
    tenantId: input.tenantId,
    kind: 'call_action',
    subjectRef: input.captureId,
    suggestion: input.callerPhone ?? null,
    detail: {
      intents: input.intents,
      priority: input.priority ?? 'normal',
      callerPhone: input.callerPhone ?? null,
      snippet: input.snippet ?? null,
    },
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

// Every OPEN item of a kind, tenant-wide (plan 4b-3). The partial unique
// index is per (tenant, kind, SUBJECT) — so two managers could each hold an
// open `pending_freeze` under their own subjectRef. The freeze wants ONE live
// plan per TENANT: staging first dismisses every open token of the kind,
// whoever staged it, via this lister.
export async function findOpenReviewItemsByKind(
  tenantId: string,
  kind: ReviewKind,
): Promise<ReviewItem[]> {
  const { data, error } = await getClient()
    .from('review_items')
    .select()
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`findOpenReviewItemsByKind failed: ${error.message}`);
  return data ?? [];
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
