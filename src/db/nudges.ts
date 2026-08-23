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
  | 'failed';

// A nudge still in flight — what auto-resolve sweeps and what a terminal
// outcome may close.
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

// pending -> queued, carrying the composed question. Status-guarded
// conditional UPDATE (the resolveOpenReviewItemFor shape): every predicate in
// the WHERE clause, null when the row was not in the expected state — the
// caller treats that as "someone else moved it" and drops the write.
// attempts resets to 0: the column's ledger changes hands here (compose
// attempts before, DELIVERY attempts after) and each stage gets its full
// allowance.
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

// Close an in-flight nudge with a terminal outcome. Only open rows move — a
// terminal status never overwrites another (answered stays answered even if
// an escalation sweep races the activity sweep). `fromStatuses` narrows the
// guard further when the RESOLUTION TEXT is only true of specific states
// (final-review #3: the 24h expiry says "never delivered" — a delivery ack
// landing between the sweep's read and this write moves the row to 'asked',
// and the expiry must then LOSE, or the durable audit lies about the ask).
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

// The planner's ONE write onto a nudge's timing (plan 2026-08-19, Phase 2).
//
// Deliberately a SCHEDULE write and nothing else: the planner never escalates,
// resolves or cancels a row directly. To escalate it sets escalate_after to now
// and lets the sweep perform the handoff — so the rung-2 flag, the orphan
// doctrine and the "flag first, close second" order stay in ONE place
// (watchers.ts) rather than being re-implemented beside it.
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

// Write back a failed COMPOSE attempt count. A literal SET (not an increment
// expression — PostgREST has none): the caller read the row this tick and the
// cron is the only writer (Render guarantees one concurrent run). The guard
// is PENDING-only (Phase-3 review F3): if markNudgeQueued's UPDATE committed
// but its response was lost, the row is already 'queued' — this write must
// then land nowhere, so the compose catch cannot destroy a successfully
// queued deliverable by marking it failed. Phase 4's delivery attempts get
// their own helper with their own guard.
export async function setNudgeAttempts(
  id: string,
  tenantId: string,
  attempts: number,
): Promise<Nudge | null> {
  const { data, error } = await getClient()
    .from('nudges')
    .update({ attempts })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (error) throw new Error(`setNudgeAttempts failed: ${error.message}`);
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
//   1. A pending gap can sit for hours (`not_before` gates compose only, and the
//      planner's `hold` may push it out to the 18h delivery ceiling). Any routine
//      note in that window would be stamped as the ANSWER to a question nobody
//      has been asked yet — and the stamp is first-write-wins, so the real answer
//      could never claim it afterwards. Attribution would fail silently, forever,
//      on exactly the gap it exists to serve.
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
