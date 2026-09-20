import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import { POSTGREST_MAX_ROWS } from './rowCap.js';
import { isUniqueViolation } from './rawCaptures.js';

export type ReviewItem = Database['public']['Tables']['review_items']['Row'];
export type ReviewStatus = Database['public']['Enums']['review_status'];

// The review kinds this cycle writes. A plain string column in the DB (new kinds
// must not need a migration); this union is the compile-time vocabulary — and
// it is SHARED with `nudges.kind` and `observations.kind` (one gap, one name).
//
// THE REVIEW QUEUE IS RETIRED (2026-09-19). Nothing lists `review_items` to a
// manager any more; the table holds the two-step confirmation tokens, the
// pairing check waiting for the settings page, and the availability reminder.
// Several kinds below live on only as OBSERVATION kinds (say so where they do).
export type ReviewKind =
  | 'sheet_ref_mismatch'
  // An observation kind since 2026-09-19 (raiseUnknownRefObservation): mail
  // through a connection filed under a ref the roster does not have.
  | 'unknown_ref_capture'
  | 'pairing_verification'
  | 'pending_deactivation'
  | 'pending_outbound_send'
  | 'pending_field_note'
  | 'pending_retraction'
  | 'pending_standing_fact'
  // An observation kind since 2026-09-19 (raiseOffboardingObservation): a
  // removal about to become permanent, once per episode.
  | 'offboarding_reminder'
  // 'pending_booking' and 'pending_visit_move' were deleted in rung 9a: book
  // and move are one-shot, so nothing mints them. 'pending_visit_cancel' is
  // the one scheduling token that survives.
  | 'pending_visit_cancel'
  | 'pending_job_cancel'
  | 'pending_seat_add'
  // Onboarding task-reminder (NOT a staged token): opened when a seat is
  // confirmed, auto-resolved by set_availability (user decision 2026-07-20).
  // Its "dismiss it for 'not known yet'" door went with resolve_review,
  // 2026-09-19; an unset pattern simply leaves it open.
  | 'availability_setup'
  // A customer phone call whose caller-ID matched no customer (plan 2026-08-04).
  // The agentless phone path can't ask "which customer?", so the unmatched call is
  // flagged for the manager to link/create (resolve) or mark spam/wrong-number
  // (dismiss). subject_ref = the parked L1 captureId → one open item per call,
  // idempotent across worker retries.
  | 'unlinked_call'
  // A classified inbound call that needs a HUMAN to act (reschedule/cancel/
  // question/complaint) or one the router couldn't classify at all (plan
  // 2026-08-06). The agentless worker NEVER auto-executes these. An OBSERVATION
  // kind since 2026-09-19 (raiseCallActionObservation, subject_ref = the L1
  // captureId); the worker still pushes the managers. Older rows here are
  // review items from before that.
  | 'call_action'
  // Stage-0 watcher (plan 2026-08-15 feature A): a confirmed visit whose
  // scheduled end passed with no field report or status change. NON-token.
  // No longer minted as a review item (the gap is a nudge/observation), and
  // resolve_review is gone; old rows are history. subject_ref = `<visit id>@<starts_at>`
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
  | 'planner_observation'
  // RUNG 10 — the extractor as the planner's EYE on inbound. A call or work
  // email from a customer we know, where code cannot decide alone:
  //   inbound_new_job    — they have no open job on file. Code used to mint one
  //                        silently; the manager is asked instead.
  //   inbound_commitment — the firm agreed to come out, and no trip attaches.
  //                        (`context.jobId` absent ⇒ a job would be opened too:
  //                        one observation per capture, never two texts for one
  //                        call.)
  // Both ride the Calls-worker's ping loop (PINGED_KINDS, src/db/observations.ts).
  // subject_ref is the L1 capture id, author 'detector' — so the once-ever index
  // makes a redelivered call converge instead of asking twice.
  | 'inbound_new_job'
  | 'inbound_commitment'
  // RUNG 10B — NOBODY ON FILE MATCHES THE SENDER. The one inbound kind with no
  // customer on it: subject_ref is the L1 capture id, author 'detector', and
  // `context` carries the sender, the words, and what the extractor read, but no
  // customerId — because that is the open question. It rides the same ping loop
  // (PINGED_KINDS) as the two above, so the planner sees it within seconds and
  // forms the second opinion: a supplier to dismiss, a known customer at a new
  // number to link, or a genuinely new caller to ask a manager about.
  //
  // It REPLACES the `unlinked_call` review the Calls-worker used to open, which
  // no tool could act on. That kind and its rows are kept (the `flagNudgeGap`
  // precedent below) — only the writer is gone.
  | 'inbound_unmatched'
  // ACCESS PLAN B — a technician asked to open part of the record she cannot
  // see, and the desk would not open it itself (money, every note, or wider
  // than one job). An OBSERVATION kind only, never a review item or a nudge:
  // author 'planner' (the desk files it wearing the office's name), subject_ref
  // a fresh uuid, and `context.requestKey` the real dedup — see the partial
  // unique index in migration 20260919170000. It stays in the planner's open
  // set until a manager answers, so the planner can chase or tell the
  // technician it is still waiting; NOT in PINGED_KINDS, because the managers
  // are already texted the moment it is filed.
  | 'access_request';

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

// (The unknown-ref review flag stood here until the review queue was retired,
// 2026-09-19. Mail through a connection filed under a ref the roster does not
// have is now an `unknown_ref_capture` OBSERVATION — raiseUnknownRefObservation
// in observations.ts — so the planner sees it instead of a queue nobody opened.)

// (`flagNudgeGap` stood here until build 6 Phase 1. It opened a gap's manager
// item at most ONCE PER SUBJECT — EVER (any-status dedup: a gap's subject never
// recurs, so a resolved item must not re-open), and carried the planner's
// handoff sentence plus `detail.escalatedFromNudge` and `detail.agentContext`.
// Its only caller was `escalate`, which is deleted, so nothing files a gap item
// any more. EVERY ITEM EVER FILED STAYS — the rows, the two any-status unique
// indexes, `escalated_from_nudge` and the board all read unchanged; only the
// writer is gone (list_pending_reviews read them too until the queue was
// retired, 2026-09-19). `upsertOpenReviewItem` remains the way every other
// kind is opened.)

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

// (`openUnlinkedCallReview` stood here until rung 10b. It opened an
// `unlinked_call` item for a phone call whose caller-ID matched no customer, and
// pushed the managers about it — a dead end, because NO TOOL could act on that
// item: the manager could resolve or dismiss it, and nothing would ever link the
// call to anybody. The unmatched caller now becomes an `inbound_unmatched`
// observation instead (src/writePath/recordFieldNote.ts), which the planner sees
// on the ping loop and can actually settle. EVERY ITEM EVER FILED STAYS — the
// `unlinked_call` kind, its rows, the partial unique index and the board all
// read unchanged; only the writer is gone, the same way `flagNudgeGap` was
// retired above. The six open rows on the pilot are closed by
// scripts/retire-review-queue.mjs, which retired the queue itself, 2026-09-19.)

// (The call-action review opener stood here until the review queue was retired,
// 2026-09-19. A call that needs a person — reschedule, cancel, question,
// complaint, or one the router could not read — is now a `call_action`
// OBSERVATION: raiseCallActionObservation in observations.ts.)

// The open item for a (kind, subject), if any — WITHOUT creating one (the
// upsert would). The upsert's conflict path uses it to return the open row, and
// record_standing_fact to find the fact it supersedes. At most one row can
// match (partial unique index on open items).
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
// pairing item, set_availability closes the availability reminder), which also
// closes the read-to-write race window those pairs had.
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

// (The offboarding-reminder review flag stood here until the review queue was retired,
// 2026-09-19. The "removal becomes permanent soon" heads-up is now an
// `offboarding_reminder` OBSERVATION, once per episode:
// raiseOffboardingObservation in observations.ts.)

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

// Every OPEN item of these kinds — FLEET-WIDE unless tenants are named. One
// caller: the review queue's one-time retirement sweep
// (src/jobs/retireReviewQueue.ts). Paged past PostgREST's silent 1000-row cap
// and ordered by id, so a big backlog is read whole and in a stable order.
export async function listOpenReviewItemsOfKinds(
  kinds: readonly string[],
  tenantIds?: readonly string[],
): Promise<ReviewItem[]> {
  if (kinds.length === 0 || tenantIds?.length === 0) return []; // `in.()` with zero values errors
  // The database's own per-read limit, not a literal: a lowered max_rows would
  // make a hardcoded 1000 end the sweep on the first short page.
  const PAGE = POSTGREST_MAX_ROWS;
  const out: ReviewItem[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = getClient()
      .from('review_items')
      .select()
      .eq('status', 'open')
      .in('kind', [...kinds]);
    if (tenantIds) query = query.in('tenant_id', [...tenantIds]);
    const { data, error } = await query.order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`listOpenReviewItemsOfKinds failed: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
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

// (The review queue's page reader stood here — list_pending_reviews' read over
// the review_queue_page function, retrieval layer 4. Both went when the queue
// was retired, 2026-09-19; the function is dropped by migration
// 20260919160000.)

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
