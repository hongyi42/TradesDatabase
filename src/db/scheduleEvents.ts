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
