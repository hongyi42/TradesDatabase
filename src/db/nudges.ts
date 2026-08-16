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

// Statuses that HOLD a per-person budget slot (user-ratified 2026-08-16:
// 2 asks/person per rolling 24h, NO firm-wide cap). A slot is claimed at
// CREATION, not delivery — the point of the budget is how often we decide to
// bother someone, and a pending row is that decision already made. cancelled
// and failed refund the slot: the person was never actually asked.
export const BUDGET_HOLDING_STATUSES: NudgeStatus[] = [
  'pending',
  'queued',
  'asked',
  'answered',
  'escalated',
];

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
// an escalation sweep races the activity sweep).
export async function markNudgeOutcome(
  id: string,
  tenantId: string,
  status: 'answered' | 'escalated' | 'cancelled' | 'failed',
  resolution?: string | null,
): Promise<Nudge | null> {
  const { data, error } = await getClient()
    .from('nudges')
    .update({ status, resolution: resolution ?? null, resolved_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .in('status', OPEN_NUDGE_STATUSES)
    .select()
    .maybeSingle();
  if (error) throw new Error(`markNudgeOutcome failed: ${error.message}`);
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

// The per-person budget read: nudges created since `sinceIso` that hold a
// slot (see BUDGET_HOLDING_STATUSES). Rolling window — the caller derives
// `sinceIso` as now minus 24h.
export async function countRecentAsks(
  tenantId: string,
  technicianId: string,
  sinceIso: string,
): Promise<number> {
  const { count, error } = await getClient()
    .from('nudges')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('technician_id', technicianId)
    .gte('created_at', sinceIso)
    .in('status', BUDGET_HOLDING_STATUSES);
  if (error) throw new Error(`countRecentAsks failed: ${error.message}`);
  return count ?? 0;
}
