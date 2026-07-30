import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';

export type ScheduleEvent = Database['public']['Tables']['schedule_events']['Row'];

export interface AppendScheduleEventInput {
  tenantId: string;
  assignmentId?: string | null;
  kind: string; // booked|moved|move_failed|cancelled|completed|backfilled (Plan 2+ adds more)
  actorRef?: string | null; // roster ref of the person who drove it, or 'system'
  detail?: Json;
}

// Append one event to the schedule change log. Append-only by design — the log
// IS the version history; nothing updates or deletes rows here.
export async function appendScheduleEvent(
  input: AppendScheduleEventInput,
): Promise<ScheduleEvent> {
  const { data, error } = await getClient()
    .from('schedule_events')
    .insert({
      tenant_id: input.tenantId,
      assignment_id: input.assignmentId ?? null,
      kind: input.kind,
      actor_ref: input.actorRef ?? null,
      detail: input.detail ?? {},
    })
    .select()
    .single();
  if (error || !data) {
    throw new Error(`appendScheduleEvent failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

// The tenant's schedule VERSION: its latest event id (0 = no events yet).
// Monotonic because ids are a global identity sequence — two tenants' versions
// aren't comparable to each other, only to their own history, which is all a
// version token needs (pin a question / detect "changed since I looked").
export async function latestScheduleVersion(tenantId: string): Promise<number> {
  const { data, error } = await getClient()
    .from('schedule_events')
    .select('id')
    .eq('tenant_id', tenantId)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`latestScheduleVersion failed: ${error.message}`);
  return data ? Number(data.id) : 0;
}

// The newest committed batch run — undo_run's subject (plan 2026-07-30
// Phase 5). Keys on the run SUMMARY event; recorded limitation: a run whose
// best-effort summary append failed is invisible here (not undoable via the
// verb — manual ledger recovery). A newest summary whose detail lost its
// stamp returns null rather than silently falling back to an OLDER run:
// undo targets only the latest run, and reaching past a broken summary
// would undo the wrong one.
export type CommittedRunKind = 'freeze' | 'resolve';
export interface CommittedRun {
  stamp: string; // detail.freezeRun / detail.resolveRun — the run's identity
  kind: CommittedRunKind;
  eventId: number; // the summary event's id (the confirm-time equality pin)
}

export async function latestCommittedRun(tenantId: string): Promise<CommittedRun | null> {
  const { data, error } = await getClient()
    .from('schedule_events')
    .select()
    .eq('tenant_id', tenantId)
    .in('kind', ['freeze_committed', 'resolve_committed'])
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`latestCommittedRun failed: ${error.message}`);
  if (!data) return null;
  const kind: CommittedRunKind = data.kind === 'freeze_committed' ? 'freeze' : 'resolve';
  const detail = (data.detail ?? {}) as Record<string, unknown>;
  const stamp = detail[kind === 'freeze' ? 'freezeRun' : 'resolveRun'];
  if (typeof stamp !== 'string' || !stamp) return null; // stamp-less summary — not undoable
  return { stamp, kind, eventId: Number(data.id) };
}

// Every event a batch run stamped, oldest first (callers reverse for undo
// order). PostgREST JSON filter on the detail key the run's commit wrote.
export async function listEventsByRunStamp(
  tenantId: string,
  key: 'freezeRun' | 'resolveRun',
  stamp: string,
): Promise<ScheduleEvent[]> {
  const { data, error } = await getClient()
    .from('schedule_events')
    .select()
    .eq('tenant_id', tenantId)
    .eq(`detail->>${key}`, stamp)
    .order('id', { ascending: true });
  if (error) throw new Error(`listEventsByRunStamp failed: ${error.message}`);
  return data ?? [];
}

// Events after a known version, oldest first — the "what changed since you
// looked" feed (Plan 2 board notifications; Plan 3 version-pinned questions).
export async function listScheduleEventsSince(
  tenantId: string,
  afterId: number,
  limit = 100,
): Promise<ScheduleEvent[]> {
  const { data, error } = await getClient()
    .from('schedule_events')
    .select()
    .eq('tenant_id', tenantId)
    .gt('id', afterId)
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listScheduleEventsSince failed: ${error.message}`);
  return data ?? [];
}
