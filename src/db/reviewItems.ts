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
  // 'pending_booking' and 'pending_visit_move' were deleted in rung 9a: book
  // and move are one-shot, so nothing mints them. 'pending_visit_cancel' is
  // the one scheduling token that survives.
  | 'pending_visit_cancel'
  | 'pending_job_cancel'
  | 'pending_seat_add'
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
  // small, no summarizer needed. subject_ref = `<visit id>@<starts_at>`
  // (rung 9b — parse it with visitIdOfSubject).
  | 'overdue_visit_gap'
  // Detector #2 (plan 2026-08-19): a job whose work is done but whose parts
  // cost was never recorded. subject_ref is the JOB id, not a visit —
  // the only kind so far whose subject is not a visit.
  | 'job_cost_gap'
  // THE PLANNER'S OWN (build 7, plan 2026-09-02). The one kind no detector
  // mints: it is written by `observe`, and by the planner turning a seat's
  // inform into something that keeps standing. Deliberately absent from
  // NUDGE_KIND_SPECS — a spec is what makes a kind DETECTED and its manager
  // items swept (nudgeKinds.ts), and neither applies here, so the sweep can
  // never create or touch one.
  //
  // It is also the one kind outside `uq_observations_subject_ever`, which is
  // partial on author='detector' since 20260904110000. Its subject_ref is a
  // LABEL, not a dedup key — see createObservation.
  | 'planner_observation';

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

// (`flagNudgeGap` stood here until build 6 Phase 1. It opened a gap's manager
// item at most ONCE PER SUBJECT — EVER (any-status dedup: a gap's subject never
// recurs, so a resolved item must not re-open), and carried the planner's
// handoff sentence plus `detail.escalatedFromNudge` and `detail.agentContext`.
// Its only caller was `escalate`, which is deleted, so nothing files a gap item
// any more. EVERY ITEM EVER FILED STAYS — the rows, the two any-status unique
// indexes, `escalated_from_nudge`, list_pending_reviews and the board all read
// unchanged; only the writer is gone. `upsertOpenReviewItem` remains the way
// every other kind is opened.)

// The watcher's batched cap pre-filter (final-review finding): which of these
// subjects were EVER flagged, any status? Without it, stale flagged-but-
// unfilled gaps re-enter the 72h candidate window every tick and permanently
// occupy detection — the per-item dedup would return
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

// Every OPEN item of a kind, tenant-wide (plan 4b-3). The partial unique index
// is per (tenant, kind, SUBJECT), so two managers can each hold an open item of
// one kind under their own subjectRef. A kind that wants ONE live token per
// TENANT dismisses every open one of its kind through this lister first,
// whoever staged it. (The staged solver plans were that pattern's first user;
// the sweep's per-kind gap read is what uses it now.)
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
