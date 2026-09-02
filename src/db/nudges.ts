import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import { isUniqueViolation } from './rawCaptures.js';
import type { ReviewKind } from './reviewItems.js';
import type { Technician } from './technicians.js';

export type Nudge = Database['public']['Tables']['nudges']['Row'];

// The whole lifecycle (see the migration header for the state diagram). A
// plain text column in the DB (CHECK-constrained); this union is the
// compile-time vocabulary, the ReviewKind pattern.
export type NudgeStatus =
  | 'pending'
  | 'queued'
  | 'asked'
  | 'answered'
  | 'escalated'
  | 'cancelled'
  | 'failed'
  // The planner's revisable ending for a question (build 6 Phase 3). NOT a
  // terminal outcome like the four above it: `recover` puts the row back where
  // it was, which is why it carries `prior_status` and why it is absent from
  // mv_gap_outcomes' terminal list. See 20260902120000_nudges_dismissed.sql.
  | 'dismissed';

// A nudge still in flight — what auto-resolve sweeps and what a terminal
// outcome may close.
//
// 'dismissed' IS DELIBERATELY ABSENT, and that absence is load-bearing: it is
// what makes a dismissed question invisible to the planner's own gap read, the
// delivery host pull, the sweep's alarm pass and every guarded terminal write,
// without one of them having to learn the new status. The migration's header
// carries the full list.
export const OPEN_NUDGE_STATUSES: NudgeStatus[] = ['pending', 'queued', 'asked'];

export interface CreatePendingNudgeInput {
  tenantId: string;
  kind: ReviewKind; // shared vocabulary with review_items — one gap, one name
  subjectRef: string; // the gap's subject (assignment id for overdue_visit_gap)
  technicianId: string;
  context?: Json;
}

// Open a pending nudge — or learn this subject was already considered, ever.
// Insert-catch-23505 (the appendRawCapture pattern): the unique index
// (tenant, kind, subject) IS the dedup, so a concurrent tick or a re-noticed
// gap converges to null instead of a second ask. Callers treat null as
// "nothing new to do".
export async function createPendingNudge(input: CreatePendingNudgeInput): Promise<Nudge | null> {
  const { data, error } = await getClient()
    .from('nudges')
    .insert({
      tenant_id: input.tenantId,
      kind: input.kind,
      subject_ref: input.subjectRef,
      technician_id: input.technicianId,
      context: input.context ?? {},
    })
    .select()
    .single();
  if (!error && data) return data;
  if (isUniqueViolation(error)) return null; // already considered, ever
  throw new Error(`createPendingNudge failed: ${error?.message ?? 'no row returned'}`);
}

// The send-time writer (plan 2026-08-31 "a gap is not an ask"): a question
// comes into existence when the PLANNER sends, born 'queued' — there is no
// pending stage left for new rows and no other author. The id is the
// OBSERVATION'S OWN uuid (one gap, one id, two stages — the observations
// migration header carries the design), so decision history and ask_group_id
// semantics span both lives with no mapping.
//
// 23505 → null covers TWO races with one guard, both real: a send applied
// twice (the same-id insert collides on the pk), and a subject with a
// pre-split relic nudge (collides on uq_nudges_subject_ever — the subject was
// asked once, ever, and stays asked). Either way the caller reports refused,
// never a second question.
export interface CreateNudgeFromObservationInput {
  id: string; // the observation's uuid
  tenantId: string;
  kind: ReviewKind;
  subjectRef: string;
  technicianId: string | null;
  context: Json;
  question: string;
  askGroupId?: string | null;
}

export async function createNudgeFromObservation(
  input: CreateNudgeFromObservationInput,
): Promise<Nudge | null> {
  const { data, error } = await getClient()
    .from('nudges')
    .insert({
      id: input.id,
      tenant_id: input.tenantId,
      kind: input.kind,
      subject_ref: input.subjectRef,
      technician_id: input.technicianId,
      context: input.context,
      question: input.question,
      status: 'queued',
      queued_at: new Date().toISOString(),
      attempts: 0,
      ask_group_id: input.askGroupId ?? null,
    })
    .select()
    .single();
  if (!error && data) return data;
  if (isUniqueViolation(error)) return null; // sent already, or a relic owns the subject
  throw new Error(`createNudgeFromObservation failed: ${error?.message ?? 'no row returned'}`);
}

export async function listNudgesByStatus(
  tenantId: string,
  statuses: NudgeStatus[],
): Promise<Nudge[]> {
  if (statuses.length === 0) return []; // PostgREST `in.()` with zero values errors
  const { data, error } = await getClient()
    .from('nudges')
    .select()
    .eq('tenant_id', tenantId)
    .in('status', statuses)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listNudgesByStatus failed: ${error.message}`);
  return (data ?? []) as Nudge[];
}

// The watcher's second fresh-gap pre-filter (the listEverFlaggedSubjectRefs
// twin): which of these subjects were ever nudged, ANY status? Without it a
// nudged gap looks fresh every tick and burns a cap slot re-discovering
// itself. Bounded: `in()` over the caller's candidate ids, never a tenant
// scan.
export async function listNudgedSubjectRefs(
  tenantId: string,
  kind: ReviewKind,
  subjectRefs: string[],
): Promise<string[]> {
  if (subjectRefs.length === 0) return []; // PostgREST `in.()` with zero values errors
  const { data, error } = await getClient()
    .from('nudges')
    .select('subject_ref')
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .in('subject_ref', subjectRefs);
  if (error) throw new Error(`listNudgedSubjectRefs failed: ${error.message}`);
  return (data ?? []).map((r) => r.subject_ref);
}

// pending -> queued, carrying the planner's question. Status-guarded
// conditional UPDATE (the resolveOpenReviewItemFor shape): every predicate in
// the WHERE clause, null when the row was not in the expected state — the
// caller treats that as "someone else moved it" and drops the write.
// attempts resets to 0: from here the column is the DELIVERY attempts ledger,
// and each stage gets its full allowance.
export async function markNudgeQueued(
  id: string,
  tenantId: string,
  question: string,
): Promise<Nudge | null> {
  const { data, error } = await getClient()
    .from('nudges')
    .update({ status: 'queued', question, attempts: 0, queued_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (error) throw new Error(`markNudgeQueued failed: ${error.message}`);
  return data as Nudge | null;
}

// The transport's host-scoped reads (Phase 4). Cross-tenant BY DESIGN — a box
// serves every tenant whose technicians live on it, exactly like the badge
// pull — so these are keyed on host, and the embedded technician row carries
// tenant_id for any per-row writes. `!inner` makes the host filter row-level.
export type QueuedNudgeForHost = Nudge & {
  technicians: Pick<
    Technician,
    'id' | 'ref' | 'state' | 'sandbox_ref' | 'telegram_user_id' | 'host_id' | 'tenant_id'
  > | null;
};

const HOST_QUEUE_SELECT =
  '*, technicians!inner(id,ref,state,sandbox_ref,telegram_user_id,host_id,tenant_id)';

export async function listQueuedNudgesForHost(hostId: string): Promise<QueuedNudgeForHost[]> {
  const { data, error } = await getClient()
    .from('nudges')
    .select(HOST_QUEUE_SELECT)
    .eq('status', 'queued')
    .eq('technicians.host_id', hostId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listQueuedNudgesForHost failed: ${error.message}`);
  return (data ?? []) as QueuedNudgeForHost[];
}

// Point-read for the box's delivery report: the id must be a QUEUED nudge
// whose technician lives on THIS host — a host token can never ack or fail
// another host's rows (host_id comes from the token, never the body).
export async function getQueuedNudgeForHost(
  id: string,
  hostId: string,
): Promise<QueuedNudgeForHost | null> {
  const { data, error } = await getClient()
    .from('nudges')
    .select(HOST_QUEUE_SELECT)
    .eq('id', id)
    .eq('status', 'queued')
    .eq('technicians.host_id', hostId)
    .maybeSingle();
  if (error) throw new Error(`getQueuedNudgeForHost failed: ${error.message}`);
  return data as QueuedNudgeForHost | null;
}

// Literal SETs for the transport's two counters, queued-guarded (the
// setNudgeAttempts pattern — the pull loop read the row this tick and is the
// only writer of these columns).
export async function setNudgeServeCount(
  id: string,
  tenantId: string,
  serveCount: number,
): Promise<Nudge | null> {
  const { data, error } = await getClient()
    .from('nudges')
    .update({ serve_count: serveCount })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'queued')
    .select()
    .maybeSingle();
  if (error) throw new Error(`setNudgeServeCount failed: ${error.message}`);
  return data as Nudge | null;
}

export async function setNudgeDeliveryAttempts(
  id: string,
  tenantId: string,
  attempts: number,
): Promise<Nudge | null> {
  const { data, error } = await getClient()
    .from('nudges')
    .update({ attempts })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'queued')
    .select()
    .maybeSingle();
  if (error) throw new Error(`setNudgeDeliveryAttempts failed: ${error.message}`);
  return data as Nudge | null;
}

// queued -> asked: the box runner reported delivery through the person's own
// agent. Same conditional-UPDATE guard.
export async function markNudgeAsked(id: string, tenantId: string): Promise<Nudge | null> {
  const { data, error } = await getClient()
    .from('nudges')
    .update({ status: 'asked', asked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'queued')
    .select()
    .maybeSingle();
  if (error) throw new Error(`markNudgeAsked failed: ${error.message}`);
  return data as Nudge | null;
}

// ── one message, several gaps (plan 2026-08-25, Phase 2) ────────────────────

// pending -> queued for EVERY member of one delivered message, in one guarded
// UPDATE. The group's id IS the lead's own row id, set on every member
// including the lead, so `ask_group_id = leadId` later selects the whole group
// and `id = ask_group_id` identifies the lead without a second column.
//
// Returns the rows that ACTUALLY moved, not a boolean. There is no rollback
// here — a partial move really does queue the movers, and they really will be
// delivered — so the caller has to be able to record per-member outcomes rather
// than one verdict for the group. Reporting `refused` for a gap whose question
// went out is the same class of lie as reporting `applied` for one that did not.
//
// Same pending-only guard as markNudgeQueued, and the same attempts reset: the
// column's ledger changes hands at queue time.
export async function markNudgeGroupQueued(
  ids: string[],
  tenantId: string,
  question: string,
  leadId: string,
): Promise<Nudge[]> {
  if (ids.length === 0) return []; // PostgREST `in.()` with zero values errors
  // The lead must BE a member, or no row satisfies `id = ask_group_id` and the
  // group is leaderless from birth — which the serve loop then freezes forever.
  // Phase 3's rails check this too; this is the layer that would have to survive
  // a hand-written row.
  if (!ids.includes(leadId)) {
    throw new Error(`markNudgeGroupQueued: lead ${leadId} is not among its own members`);
  }
  const { data, error } = await getClient()
    .from('nudges')
    .update({
      status: 'queued',
      question,
      ask_group_id: leadId,
      attempts: 0,
      queued_at: new Date().toISOString(),
    })
    .in('id', ids)
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .select();
  if (error) throw new Error(`markNudgeGroupQueued failed: ${error.message}`);
  return (data ?? []) as Nudge[];
}

// queued -> asked for a whole group on ONE delivery report. An ungrouped row
// (groupId null) behaves exactly like markNudgeAsked, wrapped in an array.
//
// `groupId` is PASSED IN rather than looked up: every caller has just read the
// row and already holds it, so a lookup here would be a second round-trip on
// the common path — and on the far commoner UNGROUPED path it would be a query
// asking a question whose answer the caller knew was null.
//
// Both filters are `.eq()`. Never `.or()` with an interpolated filter string:
// `leadId` reaches completeNudgeDelivery straight out of an HTTP body, and an
// `.or()` is the one construct here that would stop treating it as a bound
// parameter.
//
// ONE `asked_at` for every member, by construction: they left in one message,
// so the asksUnattended alarm (build 5's successor to the escalation clock)
// measures every member from the same instant — two timestamps would let half
// a message read as neglected.
export async function markNudgeAskedGroup(
  leadId: string,
  tenantId: string,
  groupId: string | null = null,
): Promise<Nudge[]> {
  // DELEGATE for the ungrouped case rather than inlining it: two independent
  // implementations of queued -> asked would have to be kept identical by hand,
  // and markNudgeAsked is still the one every other reader has in mind.
  if (!groupId) {
    const one = await markNudgeAsked(leadId, tenantId);
    return one ? [one] : [];
  }
  const { data, error } = await getClient()
    .from('nudges')
    .update({ status: 'asked', asked_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('status', 'queued')
    .eq('ask_group_id', groupId)
    .select();
  if (error) throw new Error(`markNudgeAskedGroup failed: ${error.message}`);
  return (data ?? []) as Nudge[];
}

// Every still-queued member of a group, host-scoped like its siblings above.
//
// completeNudgeDelivery point-reads only the lead; this read serves the
// closed-lead survivors path — a delivered report must still move siblings
// whose lead already ended some other way (build 5: it is the ONLY group read
// left in the queue; the old terminal-failure handoff died with the manager
// handoffs).
export async function listQueuedNudgesInGroupForHost(
  groupId: string,
  hostId: string,
): Promise<QueuedNudgeForHost[]> {
  const { data, error } = await getClient()
    .from('nudges')
    .select(HOST_QUEUE_SELECT)
    .eq('status', 'queued')
    .eq('ask_group_id', groupId)
    .eq('technicians.host_id', hostId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listQueuedNudgesInGroupForHost failed: ${error.message}`);
  return (data ?? []) as QueuedNudgeForHost[];
}

// Close an in-flight nudge with a terminal outcome. Only open rows move — a
// terminal status never overwrites another (answered stays answered whatever
// races it). The racers since build 5 are the PLANNER's own apply pass and
// the delivery ack: `fromStatuses` narrows the guard when the RESOLUTION TEXT
// is only true of specific states, so a write whose claim went stale between
// the read and the UPDATE loses rather than lying in the audit line.
export async function markNudgeOutcome(
  id: string,
  tenantId: string,
  status: 'answered' | 'escalated' | 'cancelled' | 'failed',
  resolution?: string | null,
  fromStatuses: NudgeStatus[] = OPEN_NUDGE_STATUSES,
): Promise<Nudge | null> {
  const { data, error } = await getClient()
    .from('nudges')
    .update({ status, resolution: resolution ?? null, resolved_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .in('status', fromStatuses)
    .select()
    .maybeSingle();
  if (error) throw new Error(`markNudgeOutcome failed: ${error.message}`);
  return data as Nudge | null;
}

/**
 * DISMISS a question: the planner's revisable "stop showing me this" (build 6
 * Phase 3, user ruling 2026-09-01 — "it should have full control on its gaps").
 *
 * Deliberately NOT `markNudgeOutcome(..., 'cancelled')`, which is the shape it
 * most resembles. A cancelled gap is one the WORLD ended — the visit was called
 * off, nothing is left to ask — and mv_gap_outcomes counts it as such. A
 * dismissed one is a judgment the planner made and can take back, which is the
 * whole property the curation design turns on. Collapsing the two would make
 * "the subject disappeared" and "I decided to stop chasing this" the same row.
 *
 * RACE-FREE, and the read is not what makes it so — the GUARD is. `prior_status`
 * has to hold whatever `status` held, and PostgREST cannot express a
 * column-to-column copy in an update payload, so the status is read first. If
 * anything moves the row in between (a delivery ack, a close racing from
 * another path), the UPDATE's `.eq('status', observed)` matches nothing and this
 * returns null — the caller reports "the gap changed state", which is true.
 * The one thing that cannot happen is a `prior_status` that disagrees with the
 * status the row actually had.
 *
 * THE COST of that choice, and it is not free: a BENIGN forward transition
 * between the read and the write — a delivery ack moving queued→asked — also
 * loses, and the caller reports "the gap changed state" about a dismissal that
 * would have been perfectly fine either way. Recoverable on the next tick, and
 * cheaper than the alternative, which is a prior_status recording a stage the
 * row was never in.
 */
export async function dismissNudge(
  id: string,
  tenantId: string,
  reason: string | null,
  fromStatuses: NudgeStatus[] = OPEN_NUDGE_STATUSES,
): Promise<Nudge | null> {
  const client = getClient();
  const { data: row, error: readErr } = await client
    .from('nudges')
    .select('status')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (readErr) throw new Error(`dismissNudge failed: ${readErr.message}`);
  const observed = row?.status as NudgeStatus | undefined;
  if (!observed || !fromStatuses.includes(observed)) return null;
  // NEVER dismiss a dismissed row, whatever a caller passes in `fromStatuses`.
  // `prior_status` is unconstrained text (the CHECK covers `status` only), so
  // this would store prior_status='dismissed' — and recoverNudge would then
  // write status='dismissed', prior_status=null, leaving the row permanently
  // unrecoverable with nothing to say so. Guarded here rather than trusted to
  // every caller, because the failure is silent.
  if (observed === 'dismissed') return null;
  const { data, error } = await client
    .from('nudges')
    .update({
      status: 'dismissed',
      prior_status: observed,
      resolution: reason ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', observed) // the guard, not the read, is the race protection
    .select()
    .maybeSingle();
  if (error) throw new Error(`dismissNudge failed: ${error.message}`);
  return data as Nudge | null;
}

/**
 * RECOVER a dismissed question, back to exactly the stage it was dismissed from
 * (user ruling 2026-09-01: "recover restores it to prior_status").
 *
 * Restoring to a FIXED stage would be wrong in a way that is hard to see later:
 * 'pending' and 'asked' differ in whether a person is currently holding a
 * question, and a recovered-to-pending row that had really been asked would
 * invite a second send that `uq_nudges_subject_ever` refuses outright.
 *
 * A NULL `prior_status` is refused rather than guessed. It means the row was
 * dismissed before that column existed, so nothing knows what it was — and an
 * unrecoverable row is a much smaller problem than one silently restored to the
 * wrong stage. Same guarded-update shape as its twin above.
 */
export async function recoverNudge(id: string, tenantId: string): Promise<Nudge | null> {
  const client = getClient();
  const { data: row, error: readErr } = await client
    .from('nudges')
    .select('prior_status')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'dismissed')
    .maybeSingle();
  if (readErr) throw new Error(`recoverNudge failed: ${readErr.message}`);
  const prior = row?.prior_status as NudgeStatus | null | undefined;
  if (!prior) return null; // not dismissed, or dismissed before prior_status existed
  const { data, error } = await client
    .from('nudges')
    .update({
      status: prior,
      prior_status: null,
      // The dismissal's own audit line goes with it — a recovered row is open
      // again, and an open row carrying a resolution reads as settled.
      resolution: null,
      resolved_at: null,
      // AND THE HOLD, for the same reason the observation branch clears it:
      // recover means "stakes changed, look at this now", and a row that came
      // back wearing a far-future `not_before` would go straight back to sleep
      // — the opposite of the verb. Since build 6 Phase 2 that is not merely
      // cosmetic: `askCandidates` exempts a held row from `asksUnattended`, the
      // only operator-visible alarm on an asked gap, so a recovered question
      // with a stale hold would be silently unwatched for the hold's duration.
      not_before: null,
    })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'dismissed')
    .eq('prior_status', prior)
    .select()
    .maybeSingle();
  if (error) throw new Error(`recoverNudge failed: ${error.message}`);
  return data as Nudge | null;
}

/**
 * The recover-validation read for QUESTIONS — the twin of
 * listDismissedObservationIds, and paged for the same reason: a dismissed row is
 * permanent (there is no delete path) so >1000 is a designed steady state, and
 * an unpaged read would let an arbitrary subset decide which recovers silently
 * drop. Ids only: the planner needs "may this id be recovered", not the row.
 */
export async function listDismissedNudgeIds(tenantId: string): Promise<string[]> {
  const out: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getClient()
      .from('nudges')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('status', 'dismissed')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listDismissedNudgeIds failed: ${error.message}`);
    out.push(...(data ?? []).map((r) => r.id));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// The planner's write onto a nudge's timing — since build 5, a NOTBEFORE-ONLY
// writer in practice: `hold` writes the planner's own pacing note (advisory —
// nothing enforces it but the planner's next look), and no clock reads
// escalate_after any more (the column is dormant; escalate performs its own
// handoff at apply time in planner.ts).
//
// Status-guarded conditional UPDATE (the markNudgeQueued shape): open rows only,
// null when the row moved under us. A planner call takes seconds, and a delivery
// ack or an auto-resolve can land in that window — the write must lose, not
// resurrect a closed gap's timing.
//
// `undefined` leaves a column alone; `null` CLEARS it back to the code default.
// The two are distinguished on purpose: "I have no opinion this tick" and "forget
// what I said last tick" are different instructions.
export async function setNudgeSchedule(
  id: string,
  tenantId: string,
  schedule: { notBefore?: string | null; escalateAfter?: string | null },
  fromStatuses: NudgeStatus[] = OPEN_NUDGE_STATUSES,
): Promise<Nudge | null> {
  // `!== undefined`, NOT `in`: the natural Phase-4 call site spreads a decision
  // object whose fields are OPTIONAL, so `{ notBefore: d.notBefore, escalateAfter:
  // d.escalateAfter }` carries both KEYS with undefined values. Keying on `in`
  // would read "the planner had no opinion about escalation this tick" as "clear
  // the deadline", silently erasing the escalate_after it wrote last tick.
  const patch: { not_before?: string | null; escalate_after?: string | null } = {};
  if (schedule.notBefore !== undefined) patch.not_before = schedule.notBefore;
  if (schedule.escalateAfter !== undefined) patch.escalate_after = schedule.escalateAfter;
  // An empty patch would be an UPDATE with no SET — PostgREST rejects it, and it
  // could only ever come from a caller bug. Refuse it here where the caller is
  // named, rather than as an opaque database error.
  if (Object.keys(patch).length === 0) {
    throw new Error('setNudgeSchedule: nothing to set (pass notBefore and/or escalateAfter)');
  }
  const { data, error } = await getClient()
    .from('nudges')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .in('status', fromStatuses)
    .select()
    .maybeSingle();
  if (error) throw new Error(`setNudgeSchedule failed: ${error.message}`);
  return data as Nudge | null;
}


// Which questions THIS person has actually been ASKED about THIS job — the
// attribution lookup (plan 2026-08-22, Phase 1). Called at record_field_note
// time, after the note has landed and the job is resolved.
//
// Scoped by technician BECAUSE a job can carry gaps belonging to different
// people: Ben's visit report and Judy's cost question can sit on one job, and
// Ben answering his must never stamp hers. `technicianId` is technicians.id
// (the badge's roster row), not a ref.
//
// 'asked' ALONE, not OPEN_NUDGE_STATUSES — deliberately narrower than the plan's
// wording, because the wider read defeats the plan's own purpose in two reachable
// ways (both found at review):
//   1. A pending gap can sit indefinitely (nothing sends it but the planner,
//      and its `hold` is unbounded since build 5). Any routine note in that
//      window would be stamped as the ANSWER to a question nobody has been
//      asked yet — and the stamp is first-write-wins, so the real answer
//      could never claim it afterwards. Attribution would fail silently,
//      forever, on exactly the gap it exists to serve.
//   2. A brand-new pending cost gap on the same job would make the count 2 and
//      block attribution of the answer to the one question that WAS asked.
// A person can only answer a question they were asked. Anything earlier is a
// note, not a reply.
//
// `context->>'jobId'`, not a column: the job a gap is about lives in its
// watcher-written context, which is where every other reader gets it
// (watchers.ts, nudgeKinds.ts). A gap whose context is malformed simply does
// not match, which is the fail-closed answer — an unattributed answer is a
// missing link, an unattributable one stamped anyway is a lie.
export async function listAskedNudgesForTechnicianJob(
  tenantId: string,
  technicianId: string,
  jobId: string,
): Promise<Nudge[]> {
  const { data, error } = await getClient()
    .from('nudges')
    .select()
    .eq('tenant_id', tenantId)
    .eq('technician_id', technicianId)
    .eq('status', 'asked')
    .eq('context->>jobId', jobId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listAskedNudgesForTechnicianJob failed: ${error.message}`);
  return (data ?? []) as Nudge[];
}

// Stamp the capture that answered a gap. First write wins.
//
// `.is('answered_by_capture_id', null)`, NEVER `.eq(col, null)`: PostgREST
// renders `.eq(x, null)` as `col=eq.null`, which matches ZERO rows in SQL's
// three-valued logic — the guard would silently never let anything through and
// the stamp would never land, while a test asserting "no-op when already set"
// passed for entirely the wrong reason. There is no `.eq(x, null)` anywhere in
// src/db/ and there must not be.
//
// KNOWN CONSEQUENCE of first-write-wins (round-2 review): if the stamped capture
// is later RETRACTED, the evidence reader folds it out and the marker disappears,
// but the slot stays taken — a re-recorded answer can never claim it. Degradation
// only (the planner still reads the words), and it is the same "a lost link is a
// lost link" trade this whole helper is built on. Recorded so it is a known
// consequence rather than a surprise.
//
// NOT status-guarded, unlike every other write in this file. The other guards
// exist because their writes MOVE the row's lifecycle and must lose a race; this
// one records a historical fact about a capture that really did land, and it is
// still true if a sweep closed the gap a moment earlier. Stamping a
// just-closed gap is exactly what we want — that is the audit trail for why it
// closed.
export async function setNudgeAnsweredBy(
  id: string,
  tenantId: string,
  captureId: string,
): Promise<Nudge | null> {
  const { data, error } = await getClient()
    .from('nudges')
    .update({ answered_by_capture_id: captureId })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('answered_by_capture_id', null)
    .select()
    .maybeSingle();
  if (error) throw new Error(`setNudgeAnsweredBy failed: ${error.message}`);
  return data as Nudge | null;
}
