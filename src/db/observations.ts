import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import { isUniqueViolation } from './rawCaptures.js';
import type { ReviewKind } from './reviewItems.js';

// The observation store (plan 2026-08-31 "a gap is not an ask"). RAW ACCESSORS
// ONLY — the migration header carries the design (one gap, one id, two stages;
// dismissal is the planner's and revisable). `src/db/` is an import LEAF: no
// production module here reaches up into src/jobs/ or src/teamLead/.
//
// TENANT SCOPING: every function filters on tenantId, but that is not the whole
// guard — callers that resolve rows for a model must compare ownership the way
// the tool handlers do (the get_job precedent, src/mcp/server.ts).

export type Observation = Database['public']['Tables']['observations']['Row'];

// The lifecycle, compile-time (the NudgeStatus pattern; the CHECK is the
// runtime twin).
export type ObservationStatus = 'open' | 'dismissed' | 'asked';

export interface CreateObservationInput {
  tenantId: string;
  kind: ReviewKind; // shared vocabulary with nudges/review_items
  // THE DEDUP KEY FOR A DETECTOR ROW, AND A LABEL FOR A PLANNER ROW (build 7).
  // uq_observations_subject_ever is partial on author='detector', so only a
  // detector's subject is unique-per-kind; a planner row's names what the
  // observation is about (the job id when there is one) and constrains nothing.
  subjectRef: string;
  // ADVISORY — who the detector thinks could answer, when it knows. Null is a
  // normal value, not a defect: an observation carries no obligation to ask.
  technicianId: string | null;
  // WHO IS WRITING (build 7, migration 20260904110000). Defaults to 'detector'
  // so every existing call site means exactly what it always did.
  author?: 'detector' | 'planner';
  context?: Json;
}

// Record a noticing — or learn this subject was already noticed, ever.
// Insert-catch-23505 (the createPendingNudge idiom): uq_observations_subject_ever
// IS the dedup, so a concurrent tick converges to null instead of a second row.
//
// A NULL RETURN MEANS "SOMETHING UNIQUE ALREADY EXISTS", and which rule caught
// it depends on the kind. uq_observations_subject_ever is partial on
// author='detector', so for a detector row null means "this subject was already
// noticed, ever". Since access plan B (migration 20260919170000) there is a
// second, narrower rule that DOES apply to a planner row:
// uq_open_access_request makes one OPEN access_request per (tenant,
// context->>'requestKey'), so null there means "this person already has this
// exact ask waiting". Callers translate their own case into words —
// openAccessRequest (src/db/accessRequests.ts) says "already asked".
// Every other planner row is still collision-free and always returns a row.
export async function createObservation(
  input: CreateObservationInput,
): Promise<Observation | null> {
  const { data, error } = await getClient()
    .from('observations')
    .insert({
      tenant_id: input.tenantId,
      kind: input.kind,
      subject_ref: input.subjectRef,
      technician_id: input.technicianId,
      author: input.author ?? 'detector',
      context: input.context ?? {},
    })
    .select()
    .single();
  if (!error && data) return data;
  if (isUniqueViolation(error)) return null; // already noticed, ever
  throw new Error(`createObservation failed: ${error?.message ?? 'no row returned'}`);
}

// ── THINGS ONLY A MANAGER CAN SETTLE (the review queue's retirement, 2026-09-19) ──
//
// These three used to be `review_items` rows that reached a manager only if the
// manager thought to ask for "pending reviews" — and nobody did. They are
// observations now, so the planner sees them on its regular pass and decides
// whether and when a manager hears about one. None of them is in PINGED_KINDS:
// a removal deadline or an unknown mailbox is not minute-urgent, and the phone
// path keeps its own instant push for `call_action`.
//
// THE NOTE IS WHAT THE PLANNER READS: with no jobTitle/customerName it renders
// as the gap's `about:` line. So it carries NO DATE and no digit-and-unit
// phrase — the date rail drops a message that echoes one it was not given —
// and no caller words, which a later retraction could not reach inside a copy.
//
// `technicianId` is null on all three, deliberately: each is a manager's
// question, and the person named either cannot settle it or has left. With no
// person on the row, a send can never become the ask, so these rows stay
// `open` until dismissed — which is why the closer below matches `open` only.

// A removal is about to become permanent. Once per episode: the subject is
// the person's ref plus the episode's start, so a second deactivation later is
// a new row, and the offboarding sweep's every-15-minutes re-observation of
// "under two days left" converges on the one row.
export async function raiseOffboardingObservation(input: {
  tenantId: string;
  ref: string;
  displayName?: string | null;
  startedAt: string;
}): Promise<Observation | null> {
  const name = input.displayName?.trim() || input.ref;
  return createObservation({
    tenantId: input.tenantId,
    kind: 'offboarding_reminder',
    subjectRef: `${input.ref}@${input.startedAt}`,
    technicianId: null,
    context: {
      ref: input.ref,
      startedAt: input.startedAt,
      note:
        `${name}'s removal from the team becomes permanent soon and cannot be undone after ` +
        'that. Until then a manager can undo it (reactivate_technician_seat).',
    },
  });
}

// Mail arrived through a mailbox connection filed under a ref the roster does
// not have. Once per REF, ever — the planner's `recover` is what brings a
// dismissed one back. `captureId` is null when the first such message was
// personal mail, which is dropped before L1 and so has no capture; the note
// says only that THAT message was not kept, since later work mail from the same
// connection lands on the record normally.
export async function raiseUnknownRefObservation(input: {
  tenantId: string;
  ref: string;
  captureId: string | null;
}): Promise<Observation | null> {
  return createObservation({
    tenantId: input.tenantId,
    kind: 'unknown_ref_capture',
    subjectRef: input.ref,
    technicianId: null,
    context: {
      ref: input.ref,
      captureId: input.captureId,
      note:
        `Mail arrived through a mailbox connection filed under '${input.ref}', and nobody on ` +
        'the team has that ref. ' +
        (input.captureId
          ? `It is kept on the record as capture ${input.captureId}.`
          : 'Its first message was personal mail, so that one was not kept.'),
    },
  });
}

// A phone call asked for something only a person should do — a reschedule,
// cancel, question, complaint — or the router could not read it at all. One
// per call (the subject is the L1 capture id), so a worker retry converges.
// The words stay in the capture, and the note points there.
export async function raiseCallActionObservation(input: {
  tenantId: string;
  captureId: string;
  intents: string[];
  priority: 'normal' | 'high';
  callerPhone: string | null;
}): Promise<Observation | null> {
  const from = input.callerPhone ? ` from ${input.callerPhone}` : '';
  return createObservation({
    tenantId: input.tenantId,
    kind: 'call_action',
    subjectRef: input.captureId,
    technicianId: null,
    context: {
      captureId: input.captureId,
      intents: input.intents,
      priority: input.priority,
      callerPhone: input.callerPhone,
      note:
        `${input.priority === 'high' ? 'Urgent: ' : ''}A phone call${from} asked to: ` +
        `${input.intents.join(', ')} (the call router's reading; nothing was changed). The ` +
        `managers got a one-line alert when it came in. Capture ${input.captureId}; spine_read ` +
        'v_captures for the words.',
    },
  });
}

// Close every OPEN detector observation of one kind about one roster person —
// the fact it was about has settled (a removal undone or made permanent). The
// `retract_capture` precedent: code dismisses, with a reason the planner and
// the manager can read, and `recover` still works. Keyed on `context->>'ref'`,
// which every ref-carrying raise above writes. Returns how many rows closed.
export async function dismissOpenObservationsForRef(
  tenantId: string,
  kind: ReviewKind,
  ref: string,
  reason: string,
): Promise<number> {
  const { data, error } = await getClient()
    .from('observations')
    .update({ status: 'dismissed', dismiss_reason: reason, dismissed_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .eq('status', 'open')
    .eq('author', 'detector')
    .eq('context->>ref', ref)
    .select('id');
  if (error) throw new Error(`dismissOpenObservationsForRef failed: ${error.message}`);
  return (data ?? []).length;
}

// PAGED past PostgREST's silent 1000-row cap (code-review): the open set is
// unbounded BY DESIGN (the record grows; the planner curates), so an unpaged
// read would silently show the planner only the oldest 1000 and hide every
// newer observation with no error anywhere. The nudgeDecisions .range() idiom.
const PAGE = 1000;

// One observation, tenant-guarded. The MCP dispatch needs it: a team-lead tool
// naming an item must prove the item is this firm's before it acts on it, and
// every other reader here is either fleet-wide by capture id (where holding the
// id is proof enough) or already tenant-scoped by its query.
export async function getObservationForTenant(
  id: string,
  tenantId: string,
): Promise<Observation | null> {
  const { data, error } = await getClient()
    .from('observations')
    .select()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`getObservationForTenant failed: ${error.message}`);
  return (data as Observation | null) ?? null;
}

export async function listObservationsByStatus(
  tenantId: string,
  statuses: ObservationStatus[],
): Promise<Observation[]> {
  if (statuses.length === 0) return []; // PostgREST `in.()` with zero values errors
  const out: Observation[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getClient()
      .from('observations')
      .select()
      .eq('tenant_id', tenantId)
      .in('status', statuses)
      .order('noticed_at', { ascending: true })
      .order('id', { ascending: true }) // deterministic paging tiebreak
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listObservationsByStatus failed: ${error.message}`);
    out.push(...((data ?? []) as Observation[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// The detector's third dedup store (the listNudgedSubjectRefs twin): which of
// these subjects were ever noticed, ANY status?
//
// CORRECTED IN BUILD 7, because the original wording here — and the migration
// header at 20260901130000:66 — described TWO mechanisms as one. It said a
// dismissed observation must keep blocking re-notice "or dismiss stops meaning
// stop showing me this". Those are different things:
//
//   this read + uq_observations_subject_ever  = the DETECTOR'S MEMORY. The
//     sweep is stateless and runs every five minutes; without a record of what
//     it already noticed it would re-notice the same visit forever. That is why
//     the status is deliberately not filtered.
//   status='dismissed'                        = what hides a row from every
//     ['open'] reader — the PLANNER's gap read (runPlanner) and also the
//     sweep's neglect counter (watchers.ts, the build-5 alarm pass), so a
//     dismissal stops the row being counted as stale too. Revisable via
//     `recover`.
//
// The planner never needed the first: it is shown its open set every tick, and
// doctrine — not a database rule — is what brakes a duplicate open (the plan's
// explicit choice; a DB rail and a per-tick cap were both considered and
// rejected). Build 7 made that split explicit by narrowing the index to
// author='detector'.
//
// AND THIS READ MUST NAME THE AUTHOR TOO, which is not cosmetic. A partial
// index is only usable when the query IMPLIES its predicate, so once the index
// gained `where author = 'detector'` a read that did not mention `author` could
// no longer use it — measured on the local stack at 20k rows: Index Only Scan
// (cost 33) became a Seq Scan (cost 770), twice per tenant per five-minute
// sweep tick, on a table with NO DELETE PATH that therefore only grows.
// The filter changes no RESULT — a planner row carries kind
// 'planner_observation' and this read already filters on kind — it states the
// invariant the paragraph above describes, and restores the index. That is a
// CONVENTION, not a guarantee: the column permits author='planner' on a
// detector kind, and what keeps them apart is that `observe` hardcodes the
// kind, nothing enforced here.
//
// Still any-status, deliberately: the detector's memory does not care what
// later became of the row.
//
// Bounded: `in()` over the caller's candidate ids, never a tenant scan.
export async function listObservedSubjectRefs(
  tenantId: string,
  kind: ReviewKind,
  subjectRefs: string[],
): Promise<string[]> {
  if (subjectRefs.length === 0) return [];
  const { data, error } = await getClient()
    .from('observations')
    .select('subject_ref')
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .eq('author', 'detector') // implies the partial index's predicate — see above
    .in('subject_ref', subjectRefs);
  if (error) throw new Error(`listObservedSubjectRefs failed: ${error.message}`);
  return (data ?? []).map((r) => r.subject_ref);
}

// The recover-validation read: ids only, deliberately — dismissed rows are
// permanent (no delete path) and monotonic, and pulling full rows (context
// jsonb included) for every tick would grow forever. The planner needs only
// "may this id be recovered", which is the id set (phase-3 review F3).
export async function listDismissedObservationIds(tenantId: string): Promise<string[]> {
  // Paged and ORDERED (code-review): dismissed rows are permanent, so >1000 is
  // the designed steady state — unpaged, an arbitrary subset would decide which
  // recovers silently drop (the F4 path leaves no record row).
  const out: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getClient()
      .from('observations')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('status', 'dismissed')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listDismissedObservationIds failed: ${error.message}`);
    out.push(...(data ?? []).map((r) => r.id));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// One guarded writer for every state move (the setNudgeSchedule idiom): every
// predicate in the WHERE clause, null when the row was not in the expected
// state — the caller treats that as "someone else moved it" and drops the
// write. `undefined` leaves a column alone; `null` CLEARS it (recover clears
// the dismissal, a cleared hold clears not_before) — different instructions,
// distinguished on purpose.
export async function setObservationStatus(
  id: string,
  tenantId: string,
  patch: {
    status?: ObservationStatus;
    dismissReason?: string | null;
    dismissedAt?: string | null;
    notBefore?: string | null;
  },
  fromStatuses: ObservationStatus[],
): Promise<Observation | null> {
  const set: {
    status?: ObservationStatus;
    dismiss_reason?: string | null;
    dismissed_at?: string | null;
    not_before?: string | null;
  } = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.dismissReason !== undefined) set.dismiss_reason = patch.dismissReason;
  if (patch.dismissedAt !== undefined) set.dismissed_at = patch.dismissedAt;
  if (patch.notBefore !== undefined) set.not_before = patch.notBefore;
  if (Object.keys(set).length === 0) {
    throw new Error('setObservationStatus: nothing to set');
  }
  if (fromStatuses.length === 0) {
    throw new Error('setObservationStatus: empty fromStatuses would match nothing');
  }
  const { data, error } = await getClient()
    .from('observations')
    .update(set)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .in('status', fromStatuses)
    .select()
    .maybeSingle();
  if (error) throw new Error(`setObservationStatus failed: ${error.message}`);
  return data as Observation | null;
}

// ── RUNG 10: the ping loop's markers ─────────────────────────────────────────
//
// TWO markers, deliberately separate:
//   pinged_at — the planner was CALLED about this row. Written by the
//               Calls-worker's guarded claim (and best-effort by a heartbeat
//               pass that showed the row), so exactly one process runs the
//               focused pass for it.
//   asked_at  — a message actually WENT OUT about it. Written by the send
//               itself, under its own guard, so the focused pass and the
//               heartbeat can never both text a manager about one call.
// A planner that reads the item and decides to WAIT has pinged, not asked —
// which is why `hold` must not consume the ask.

// The kinds the ping loop watches. Kind-blind by construction, and rung 10b
// proved it: `inbound_unmatched` was appended here and every helper below —
// plus the heartbeat probe, the planner's gap block and the MCP filters —
// followed with no edit of their own.
export const PINGED_KINDS: ReviewKind[] = ['inbound_new_job', 'inbound_commitment', 'inbound_unmatched'];

// Has this capture already been noticed? The write-path's dedup arm — an
// observation is the only L2-side trace a "matched customer, nothing created"
// inbound capture leaves, so without this a redelivery re-runs the extractor
// and re-asks. Subject-ref keyed, any kind, any status, FLEET-WIDE: the caller
// holds a capture id, which is proof enough of tenancy (the captureHasVisitNote
// precedent).
export async function captureHasObservation(captureId: string): Promise<boolean> {
  const { data, error } = await getClient()
    .from('observations')
    .select('id')
    .eq('subject_ref', captureId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`captureHasObservation failed: ${error.message}`);
  return !!data;
}

// The ping loop's read: open rows of these kinds nobody has called the planner
// about and nobody has texted about, oldest first. FLEET-WIDE — the worker
// polls every firm at once, which is why idx_observations_unpinged has no
// leading tenant column and why this WHERE must match its predicate exactly.
export async function listUnpingedObservations(
  kinds: ReviewKind[],
  limit: number,
): Promise<Observation[]> {
  if (kinds.length === 0) return []; // PostgREST `in.()` with zero values errors
  const { data, error } = await getClient()
    .from('observations')
    .select()
    .eq('status', 'open')
    .in('kind', kinds)
    .is('pinged_at', null)
    .is('asked_at', null)
    .order('noticed_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listUnpingedObservations failed: ${error.message}`);
  return (data ?? []) as Observation[];
}

// THE HEARTBEAT'S CHEAP PROBE: is there an inbound observation the ping loop
// has not got to? Boolean, and BOUNDED BY AGE on purpose — an unclaimed row is
// normally claimed within ~10s, so one still sitting here means the Calls-worker
// is down, restarting, or died on it. The window keeps that from becoming
// permanent: a row nothing ever manages to ping must not force the planner to
// run on every heartbeat forever. The half-hourly pass shows it anyway.
export async function hasFreshUnpingedObservation(
  kinds: ReviewKind[],
  sinceIso: string,
): Promise<boolean> {
  if (kinds.length === 0) return false; // PostgREST `in.()` with zero values errors
  const { data, error } = await getClient()
    .from('observations')
    .select('id')
    .eq('status', 'open')
    .in('kind', kinds)
    .is('pinged_at', null)
    .is('asked_at', null)
    .gte('noticed_at', sinceIso)
    .limit(1);
  if (error) throw new Error(`hasFreshUnpingedObservation failed: ${error.message}`);
  return (data ?? []).length > 0;
}

// CLAIM one row for a focused pass. Guarded on `pinged_at is null`, so two
// workers racing the same row converge: the loser gets null and does nothing.
// Null therefore means exactly "somebody else has it", never an error.
export async function claimObservationPing(id: string): Promise<Observation | null> {
  const { data, error } = await getClient()
    .from('observations')
    .update({ pinged_at: new Date().toISOString() })
    .eq('id', id)
    .is('pinged_at', null)
    .select()
    .maybeSingle();
  if (error) throw new Error(`claimObservationPing failed: ${error.message}`);
  return data as Observation | null;
}

// MARK ASKED. Called by the send itself, and the guard is what makes "one call,
// one text" structural rather than a doctrine hope.
//
// IT WRITES NO `not_before`, deliberately. An earlier draft set one to the same
// distance, which was redundant — `asked_at` plus the window below already
// holds the row — and actively harmful twice over: the gap view renders
// `currently held until: <ISO>`, a raw date the planner may NOT use (it is not
// in `dateLabels`), so the day-later re-ask this window exists to allow would
// have had its whole message dropped by the date rail; and the failure
// compensation clears `asked_at` only, so a transient write failure would have
// left a hold nothing could lift. `not_before` stays what it was: the planner's
// own `hold`.
//
// A WINDOW, NOT A ONE-TIME CAP, and the difference is the whole point. What has
// to be impossible is the focused pass and the half-hourly heartbeat BOTH
// texting a manager about one call — two passes minutes apart. What must stay
// possible is the planner deciding, a day later, that an unanswered call is
// worth raising again: pacing is its judgment, not a number in this file (the
// standing ruling behind the deleted nudge cap). So the row is askable again
// once `asked_at` is older than `reaskAfterIso`, and the caller picks that
// distance.
//
// Concurrency-safe despite the OR: Postgres re-checks an UPDATE's qualification
// after taking the row lock, so of two passes racing here the second finds
// `asked_at` already set to now and matches nothing.
//
// Returns the stamp it wrote, so the caller can compensate if the delivery then
// fails; null = asked too recently (or the row moved), and the send is refused.
export async function markObservationAsked(
  id: string,
  reaskAfterIso: string,
): Promise<string | null> {
  const stamp = new Date().toISOString();
  const { data, error } = await getClient()
    .from('observations')
    .update({ asked_at: stamp })
    .eq('id', id)
    .eq('status', 'open')
    .or(`asked_at.is.null,asked_at.lt.${reaskAfterIso}`)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`markObservationAsked failed: ${error.message}`);
  return data ? stamp : null;
}

// The compensation for a send that stamped and then failed to deliver. Guarded
// on the EXACT stamp this caller wrote, so it can never clear somebody else's
// later, successful ask. Without it a transient office-write failure leaves the
// row marked asked with nothing delivered — un-askable forever.
export async function clearObservationAsked(id: string, stamp: string): Promise<void> {
  const { error } = await getClient()
    .from('observations')
    .update({ asked_at: null })
    .eq('id', id)
    .eq('asked_at', stamp);
  if (error) throw new Error(`clearObservationAsked failed: ${error.message}`);
}

// The heartbeat's best-effort stamp: a :00/:30 pass that SHOWED these rows has
// called the planner about them, so the ping loop must not call again. Guarded
// on `pinged_at is null` so it never overwrites a real claim's timestamp.
export async function stampObservationsPinged(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await getClient()
    .from('observations')
    .update({ pinged_at: new Date().toISOString() })
    .in('id', ids)
    .is('pinged_at', null);
  if (error) throw new Error(`stampObservationsPinged failed: ${error.message}`);
}
