import type { Database } from './database.types.js';
import { getClient } from './client.js';
import type { Technician } from './technicians.js';

// The person_pushes queue (plan 2026-09-09 one-bot-per-person, phase 2).
// RAW ACCESSORS ONLY — the migration header carries the design. `src/db/` is an
// import LEAF: nothing here reaches up into src/telegram/ or src/control/.

export type PersonPush = Database['public']['Tables']['person_pushes']['Row'];
export type PersonPushKind = 'schedule' | 'call' | 'ops';
export type PersonPushStatus = 'queued' | 'delivered' | 'failed';

// The DB CHECK's twin, applied by the writer too: an over-long body is CUT,
// never refused. By the time a caller reaches here the words already exist —
// a digest of nine moved visits, a call summary — and losing the tail beats
// 23514ing the whole notification away. Same ruling as OFFICE_MESSAGE_BODY_MAX.
export const PERSON_PUSH_BODY_MAX = 2000;

export async function queuePersonPush(input: {
  tenantId: string;
  technicianId: string;
  kind: PersonPushKind;
  body: string;
}): Promise<PersonPush> {
  const body = input.body.slice(0, PERSON_PUSH_BODY_MAX);
  const { data, error } = await getClient()
    .from('person_pushes')
    .insert({
      tenant_id: input.tenantId,
      technician_id: input.technicianId,
      kind: input.kind,
      body,
    })
    .select()
    .single();
  if (error || !data) {
    throw Object.assign(
      new Error(`queuePersonPush failed: ${error?.message ?? 'no row returned'}`),
      { code: error?.code },
    );
  }
  return data;
}

export type QueuedPersonPushForHost = PersonPush & {
  technicians: Pick<
    Technician,
    'id' | 'ref' | 'state' | 'sandbox_ref' | 'telegram_user_id' | 'host_id' | 'tenant_id'
  > | null;
};

const HOST_QUEUE_SELECT =
  '*, technicians!inner(id,ref,state,sandbox_ref,telegram_user_id,host_id,tenant_id)';

const PAGE = 500;

// PAGED, for the office queue's reason: frozen rows deliberately KEEP status
// 'queued' and sort first (oldest-first), so an unpaged read under PostgREST's
// silent 1000-row cap would eventually show a host only its frozen backlog and
// starve every younger message.
export async function listQueuedPersonPushesForHost(
  hostId: string,
): Promise<QueuedPersonPushForHost[]> {
  const out: QueuedPersonPushForHost[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getClient()
      .from('person_pushes')
      .select(HOST_QUEUE_SELECT)
      .eq('status', 'queued')
      .eq('technicians.host_id', hostId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }) // deterministic paging tiebreak
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listQueuedPersonPushesForHost failed: ${error.message}`);
    out.push(...((data ?? []) as QueuedPersonPushForHost[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// Point-read for the box's delivery report: the id must be a QUEUED row whose
// addressee lives on THIS host — a host token can never ack or fail another
// host's rows (hostId comes from the token, never the body).
export async function getQueuedPersonPushForHost(
  id: string,
  hostId: string,
): Promise<QueuedPersonPushForHost | null> {
  const { data, error } = await getClient()
    .from('person_pushes')
    .select(HOST_QUEUE_SELECT)
    .eq('id', id)
    .eq('status', 'queued')
    .eq('technicians.host_id', hostId)
    .maybeSingle();
  if (error) throw new Error(`getQueuedPersonPushForHost failed: ${error.message}`);
  return data as QueuedPersonPushForHost | null;
}

// Count the serve BEFORE shipping it (at-most-N-serves even if the response is
// lost). Write-if-still-queued: null = the row moved under us, so the caller
// drops it rather than serving a row somebody else already settled.
export async function setPersonPushServeCount(
  id: string,
  tenantId: string,
  serveCount: number,
): Promise<PersonPush | null> {
  const { data, error } = await getClient()
    .from('person_pushes')
    .update({ serve_count: serveCount })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'queued')
    .select()
    .maybeSingle();
  if (error) throw new Error(`setPersonPushServeCount failed: ${error.message}`);
  return data;
}

// A reported FAILURE: the row stays queued and its attempt ledger grows, so it
// is re-served until the cap freezes it. Failure is not terminal here for the
// same reason it is not on the nudge path — an undeliverable message is an
// operator condition, not a decision anybody made.
export async function setPersonPushAttempts(
  id: string,
  tenantId: string,
  attempts: number,
  detail: string | null,
): Promise<PersonPush | null> {
  const { data, error } = await getClient()
    .from('person_pushes')
    .update({ attempts, detail })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'queued')
    .select()
    .maybeSingle();
  if (error) throw new Error(`setPersonPushAttempts failed: ${error.message}`);
  return data;
}

// The settle. Write-if-still-queued, so a late duplicate report from a box that
// lost its ack lands on a row that already moved and changes nothing.
export async function setPersonPushDelivered(
  id: string,
  tenantId: string,
): Promise<PersonPush | null> {
  const { data, error } = await getClient()
    .from('person_pushes')
    .update({ status: 'delivered', delivered_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'queued')
    .select()
    .maybeSingle();
  if (error) throw new Error(`setPersonPushDelivered failed: ${error.message}`);
  return data;
}
