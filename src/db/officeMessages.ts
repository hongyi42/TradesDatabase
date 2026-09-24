import type { Database } from './database.types.js';
import { getClient } from './client.js';
import { scopeQueueQuery, type QueueScope } from './queueScope.js';
import type { Technician } from './technicians.js';

// The office_messages bucket (plan 2026-08-31 "the planner's inbox", Phase 1).
// RAW ACCESSORS ONLY — the migration header carries the design (one table for
// every planner<->seat flow; operational, never L1). `src/db/` is an import
// LEAF: no production module here reaches up into src/mcp/ or src/teamLead/.

export type OfficeMessage = Database['public']['Tables']['office_messages']['Row'];

// The lifecycle, compile-time (the NudgeStatus pattern; the CHECK is the
// runtime twin). 'to_planner' rows live in unread/read; 'to_agent' rows in
// queued/delivered/failed — one column, two halves, split by direction.
export type OfficeMessageStatus = 'unread' | 'read' | 'queued' | 'delivered' | 'failed';
export type OfficeMessageDirection = 'to_planner' | 'to_agent';
// 'news' (rung 10c): an access decision told to the office. Its writer knows
// the category for certain, so it never rides as an 'inform' a model must read
// twice — and it never wakes the office.
export type OfficeMessageKind = 'ask' | 'inform' | 'reply' | 'desk' | 'news';

// The DB CHECK's twin, applied by the writer too: an over-long body is CUT,
// never refused — by the time some callers get here (a desk transcript, a
// wrapped reply) the words already exist, and losing the tail beats 23514ing
// the whole message away.
export const OFFICE_MESSAGE_BODY_MAX = 2000;

export interface CreateOfficeMessageInput {
  tenantId: string;
  direction: OfficeMessageDirection;
  kind: OfficeMessageKind;
  fromRef: string;
  toRef: string;
  // The ADDRESSEE's roster row — required by the CHECK for 'to_agent' rows
  // (the host pull joins on it); null on 'to_planner' rows.
  technicianId?: string | null;
  body: string;
  // The SENDER's tier at write time — metadata, never authority.
  tier?: string | null;
  nudgeId?: string | null;
  inReplyTo?: string | null;
  status?: OfficeMessageStatus;
  // WHICH PULL SERVES THIS ROW (build 6.5 Phase 4): 'assistant' is a silent
  // injected agent turn through the office pull; 'chat' is verbatim to the
  // person's phone through the NUDGE pull, which needs no box-side change
  // because the runner never asks what table an id came from. Defaults to
  // 'assistant' at the column, which is what every pre-6.5 row is.
  via?: OfficeMessageVia;
}

// Reserved for build 8 (one message, several people) and deliberately NOT on
// the input type: nothing writes `message_group_id` in 6.5, and an optional
// field nobody sets is an invitation to set it wrongly.
export type OfficeMessageVia = 'assistant' | 'chat';

export async function createOfficeMessage(
  input: CreateOfficeMessageInput,
): Promise<OfficeMessage> {
  const { data, error } = await getClient()
    .from('office_messages')
    .insert({
      tenant_id: input.tenantId,
      direction: input.direction,
      kind: input.kind,
      from_ref: input.fromRef,
      to_ref: input.toRef,
      technician_id: input.technicianId ?? null,
      // Cut, not refused (the DB CHECK's writer-side twin): a desk transcript
      // or wrapped reply may arrive over-long after the tool-side refusals
      // already ran, and losing the tail beats losing the message.
      body: input.body.length > OFFICE_MESSAGE_BODY_MAX
        ? input.body.slice(0, OFFICE_MESSAGE_BODY_MAX)
        : input.body,
      tier: input.tier ?? null,
      nudge_id: input.nudgeId ?? null,
      in_reply_to: input.inReplyTo ?? null,
      ...(input.via ? { via: input.via } : {}),
      ...(input.status ? { status: input.status } : {}),
    })
    .select()
    .single();
  if (error || !data) {
    throw new Error(`createOfficeMessage failed: ${error?.message ?? 'no row returned'}`);
  }
  return data as OfficeMessage;
}

// PAGED past PostgREST's silent 1000-row cap (the observations idiom): unread
// informs are unbounded by design — the tick drains them, but a dead planner
// accumulates, and an unpaged read would silently hide the newest.
const PAGE = 1000;

/**
 * ONE SENDER'S recent outbound messages (build 6.5 Phase 5).
 *
 * `fromRef` IS NOT OPTIONAL, and that is the fix for a real defect: the planner
 * is NOT the only writer of `to_agent` rows. `inform_teammate` writes them too,
 * with the calling seat's own ref (mcp/server.ts) — so a read filtered on
 * direction alone hands the planner a technician's private note to a teammate
 * under a header that says "your own messages". It would then read somebody
 * else's words as its own history, and (because those rows carry no `via` and
 * default to 'assistant') be told it was awaiting a reply to a message it
 * never sent.
 *
 * BOUNDED BY A WINDOW, and PAGED within it rather than capped. A delivered
 * message stays delivered forever, so an unwindowed read grows for the life of
 * a firm — but capping the read makes the CALLER's "N older not shown" count a
 * lie, since it can never exceed the cap. The window is the bound; the caller
 * slices what it shows and can then subtract honestly.
 */
export async function listRecentOutboundMessages(
  tenantId: string,
  fromRef: string,
  sinceIso: string,
): Promise<OfficeMessage[]> {
  const out: OfficeMessage[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getClient()
      .from('office_messages')
      .select()
      .eq('tenant_id', tenantId)
      .eq('direction', 'to_agent')
      .eq('from_ref', fromRef)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true }) // deterministic paging tiebreak
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listRecentOutboundMessages failed: ${error.message}`);
    out.push(...((data ?? []) as OfficeMessage[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * Which of those were replied to.
 *
 * ONLY AN ASSISTANT CAN REPLY THIS WAY. `in_reply_to` has two writers —
 * `inform_team_lead`'s reply branch and the office's question door (teamLead/office.ts) — but
 * only the first can ever point at a `to_agent` row: the desk answers a
 * `to_planner` ask it created moments earlier, so a desk row's `in_reply_to`
 * is never one of the ids passed here. (An earlier draft of this comment said
 * `inform_team_lead` was the only writer at all, which is false and would have
 * been trusted.)
 *
 * A person answering a CHAT message answers their own assistant, which files a
 * record_field_note and no office row at all — so the absence of a reply here
 * means "nobody used this channel", never "nobody answered". The caller must
 * not turn it into the second thing.
 *
 * PAGED: one ask can carry several replies (`inform_team_lead` is not
 * once-only), so the id list is bounded but the row count is not.
 */
export async function listAnsweredOutboundIds(
  tenantId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return []; // PostgREST `in.()` with zero values errors
  const out: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getClient()
      .from('office_messages')
      .select('in_reply_to')
      .eq('tenant_id', tenantId)
      .in('in_reply_to', ids)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listAnsweredOutboundIds failed: ${error.message}`);
    out.push(...(data ?? []).map((r) => r.in_reply_to).filter((v): v is string => !!v));
    if (!data || data.length < PAGE) break;
  }
  return out;
}



export async function listOfficeMessagesByStatus(
  tenantId: string,
  direction: OfficeMessageDirection,
  statuses: OfficeMessageStatus[],
): Promise<OfficeMessage[]> {
  if (statuses.length === 0) return []; // PostgREST `in.()` with zero values errors
  const out: OfficeMessage[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getClient()
      .from('office_messages')
      .select()
      .eq('tenant_id', tenantId)
      .eq('direction', direction)
      .in('status', statuses)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }) // deterministic paging tiebreak
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listOfficeMessagesByStatus failed: ${error.message}`);
    out.push(...((data ?? []) as OfficeMessage[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// Desk transcripts since a cutoff (plan review F7): desk rows are born 'read'
// — they are transcript, not queue — so the status read above can never
// select them; the next tick's "what was said in my name" appendix needs its
// own time-bounded read.
export async function listDeskTranscriptsSince(
  tenantId: string,
  sinceIso: string,
): Promise<OfficeMessage[]> {
  // NEWEST kept under the cap (final review): the appendix shows its tail as
  // "the latest said in your name", so a capped ascending read would keep the
  // oldest thousand and silently drop the answers most worth auditing. Read
  // descending, then restore chronological order for the caller.
  const { data, error } = await getClient()
    .from('office_messages')
    .select()
    .eq('tenant_id', tenantId)
    .eq('kind', 'desk')
    .gt('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(PAGE);
  if (error) throw new Error(`listDeskTranscriptsSince failed: ${error.message}`);
  return ((data ?? []) as OfficeMessage[]).reverse();
}

// ONE PERSON'S BUSINESS WITH THE OFFICE (plan 2026-09-22, the office): every row
// this ref sent or was sent, newest first, both directions. The office's
// `asker_history` tool reads it for the person asking and NOBODY else — the ref
// is the verified caller's, never a model's argument.
//
// The ref is interpolated into a PostgREST `or=` filter, so anything that is not
// the slug shape roster refs are minted in is refused rather than escaped: a
// comma or a parenthesis there would change the filter, not match a row.
const REF_SHAPE = /^[a-z0-9][a-z0-9:-]*$/;

export async function listOfficeMessagesForRef(
  tenantId: string,
  ref: string,
  sinceIso: string,
  limit = 40,
): Promise<OfficeMessage[]> {
  if (!REF_SHAPE.test(ref)) return [];
  const { data, error } = await getClient()
    .from('office_messages')
    .select()
    .eq('tenant_id', tenantId)
    .or(`from_ref.eq.${ref},to_ref.eq.${ref}`)
    .gt('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listOfficeMessagesForRef failed: ${error.message}`);
  return (data ?? []) as OfficeMessage[];
}

// The transport's host-scoped reads (Phase 3, the listQueuedNudgesForHost
// twins). Cross-tenant BY DESIGN — a box serves every tenant whose
// technicians live on it — so these key on host, and `!inner` makes the host
// filter row-level. technician_id is the ADDRESSEE (the migration's CHECK
// requires it on every to_agent row), which is exactly what makes this join
// possible at all (plan review F1).
export type QueuedOfficeMessageForHost = OfficeMessage & {
  technicians: Pick<
    Technician,
    'id' | 'ref' | 'state' | 'sandbox_ref' | 'telegram_user_id' | 'host_id' | 'tenant_id'
  > | null;
};

const HOST_QUEUE_SELECT =
  '*, technicians!inner(id,ref,state,sandbox_ref,telegram_user_id,host_id,tenant_id)';

export async function listQueuedOfficeMessagesForHost(
  hostId: string,
  // WHICH LEG IS ASKING (build 6.5 Phase 4). The two pulls share this read and
  // must not serve each other's rows: an unfiltered office pull would inject a
  // chat message as an agent turn AS WELL AS texting it, and an unfiltered
  // nudge pull would text a message meant to land silently.
  via: OfficeMessageVia = 'assistant',
  // Step 3: one glue seat's person, or everyone except live glue seats.
  scope: QueueScope = {},
): Promise<QueuedOfficeMessageForHost[]> {
  // PAGED (final review): frozen rows deliberately KEEP status 'queued' and
  // sort first (oldest-first), so an unpaged read under PostgREST's silent
  // 1000-row cap would eventually show a host only its frozen backlog and
  // starve every younger message. `direction` filtered as a belt — the CHECKs
  // permit a queued to_planner row in principle, and injecting one into an
  // agent would be the wrong audience.
  const out: QueuedOfficeMessageForHost[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await scopeQueueQuery(
      getClient()
        .from('office_messages')
        .select(HOST_QUEUE_SELECT)
        .eq('status', 'queued')
        .eq('direction', 'to_agent')
        .eq('via', via)
        .eq('technicians.host_id', hostId),
      scope,
    )
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }) // deterministic paging tiebreak
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listQueuedOfficeMessagesForHost failed: ${error.message}`);
    out.push(...((data ?? []) as QueuedOfficeMessageForHost[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// Point-read for the box's delivery report: the id must be a QUEUED message
// whose addressee lives on THIS host — a host token can never ack or fail
// another host's rows (host_id comes from the token, never the body).
export async function getQueuedOfficeMessageForHost(
  id: string,
  hostId: string,
): Promise<QueuedOfficeMessageForHost | null> {
  const { data, error } = await getClient()
    .from('office_messages')
    .select(HOST_QUEUE_SELECT)
    .eq('id', id)
    .eq('status', 'queued')
    .eq('technicians.host_id', hostId)
    .maybeSingle();
  if (error) throw new Error(`getQueuedOfficeMessageForHost failed: ${error.message}`);
  return data as QueuedOfficeMessageForHost | null;
}

// Tenant-scoped point-read: the reply path's validate-or-degrade (plan review
// F8) — a model-echoed replyToMessageId must resolve inside the caller's own
// tenant before it may become an in_reply_to FK.
export async function getOfficeMessage(
  id: string,
  tenantId: string,
): Promise<OfficeMessage | null> {
  const { data, error } = await getClient()
    .from('office_messages')
    .select()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`getOfficeMessage failed: ${error.message}`);
  return data as OfficeMessage | null;
}

// Point-reads for the transcript appendix: the desk rows carry in_reply_to,
// and the questions they answered are fetched by those ids. Bounded by the
// caller's id list, never a tenant scan.
export async function listOfficeMessagesByIds(
  tenantId: string,
  ids: string[],
): Promise<OfficeMessage[]> {
  if (ids.length === 0) return []; // PostgREST `in.()` with zero values errors
  const { data, error } = await getClient()
    .from('office_messages')
    .select()
    .eq('tenant_id', tenantId)
    .in('id', ids);
  if (error) throw new Error(`listOfficeMessagesByIds failed: ${error.message}`);
  return (data ?? []) as OfficeMessage[];
}

// unread -> read for the rows a successful tick actually showed. GUARDED
// (`status='unread'` only): a row that moved under us stays moved, and the
// return is how many really flipped. Best-effort at the call site — a failed
// mark-read re-shows the rows next tick, never a silent drop.
export async function markOfficeMessagesRead(
  tenantId: string,
  ids: string[],
  nowIso: string,
): Promise<number> {
  if (ids.length === 0) return 0; // PostgREST `in.()` with zero values errors
  const { data, error } = await getClient()
    .from('office_messages')
    .update({ status: 'read', read_at: nowIso })
    .eq('tenant_id', tenantId)
    .in('id', ids)
    .eq('status', 'unread')
    .select('id');
  if (error) throw new Error(`markOfficeMessagesRead failed: ${error.message}`);
  return (data ?? []).length;
}

// One guarded writer for the delivery lifecycle (the setObservationStatus
// shape): every predicate in the WHERE clause, null when the row was not in
// the expected state — the caller treats that as "someone else moved it".
export async function setOfficeMessageDelivery(
  id: string,
  tenantId: string,
  patch: { status?: OfficeMessageStatus; deliveredAt?: string | null },
  fromStatuses: OfficeMessageStatus[],
): Promise<OfficeMessage | null> {
  const set: { status?: OfficeMessageStatus; delivered_at?: string | null } = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.deliveredAt !== undefined) set.delivered_at = patch.deliveredAt;
  if (Object.keys(set).length === 0) {
    throw new Error('setOfficeMessageDelivery: nothing to set');
  }
  if (fromStatuses.length === 0) {
    throw new Error('setOfficeMessageDelivery: empty fromStatuses would match nothing');
  }
  const { data, error } = await getClient()
    .from('office_messages')
    .update(set)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .in('status', fromStatuses)
    .select()
    .maybeSingle();
  if (error) throw new Error(`setOfficeMessageDelivery failed: ${error.message}`);
  return data as OfficeMessage | null;
}

// ── Rung 10c: a seat's message wakes the office ──────────────────────────────
// The observations ping-loop twins (observations.ts). `pinged_at` is a CLAIM
// with a lease, never a read marker: a pass that claims and then crashes leaves
// the row unread, and a tick takes it back once the claim is older than
// OFFICE_CLAIM_LEASE_MS.

// The kinds that wake the office. Only 'inform'. A 'reply' answers a gap and
// must reach the tick beside that gap (fix A); an 'ask' is answered by the
// question door while the seat waits; 'desk' rows are born read; 'news' is an
// access decision with nothing to act on.
export const PINGED_MESSAGE_KINDS: OfficeMessageKind[] = ['inform'];

// The ping loop's read: unread seat messages of these kinds nobody has claimed,
// oldest first. FLEET-WIDE — the worker polls every firm at once, which is why
// idx_office_messages_unpinged has no leading tenant column.
export async function listUnpingedOfficeMessages(
  kinds: OfficeMessageKind[],
  limit: number,
): Promise<OfficeMessage[]> {
  if (kinds.length === 0) return []; // PostgREST `in.()` with zero values errors
  const { data, error } = await getClient()
    .from('office_messages')
    .select()
    .eq('direction', 'to_planner')
    .eq('status', 'unread')
    .in('kind', kinds)
    .is('pinged_at', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listUnpingedOfficeMessages failed: ${error.message}`);
  return (data ?? []) as OfficeMessage[];
}

// CLAIM one message for a focused pass. Guarded on `pinged_at is null` AND
// still unread, so two workers racing converge and a row the tick already read
// is never claimed. Null means exactly "someone else has it, or it was read".
export async function claimOfficeMessagePing(id: string): Promise<OfficeMessage | null> {
  const { data, error } = await getClient()
    .from('office_messages')
    .update({ pinged_at: new Date().toISOString() })
    .eq('id', id)
    .is('pinged_at', null)
    .eq('status', 'unread')
    .select()
    .maybeSingle();
  if (error) throw new Error(`claimOfficeMessagePing failed: ${error.message}`);
  return data as OfficeMessage | null;
}

// THE HEARTBEAT'S CHEAP PROBE (the hasFreshUnpingedObservation twin): is there
// a message the ping loop has not got to? Bounded by age on purpose — one still
// unclaimed means the Calls worker is down, and the window keeps a row nothing
// can ping from forcing the planner to run on every heartbeat forever.
export async function hasFreshUnpingedOfficeMessage(
  kinds: OfficeMessageKind[],
  sinceIso: string,
): Promise<boolean> {
  if (kinds.length === 0) return false; // PostgREST `in.()` with zero values errors
  const { data, error } = await getClient()
    .from('office_messages')
    .select('id')
    .eq('direction', 'to_planner')
    .eq('status', 'unread')
    .in('kind', kinds)
    .is('pinged_at', null)
    .gte('created_at', sinceIso)
    .limit(1);
  if (error) throw new Error(`hasFreshUnpingedOfficeMessage failed: ${error.message}`);
  return (data ?? []).length > 0;
}

// THE TICK CLAIMS WHAT IT SHOWS. Tenant-scoped, and it takes a row that is
// unclaimed OR whose claim is older than the lease — a live claim belongs to a
// running focused pass and is left alone. Returns the ids it actually moved;
// the caller shows only those, so a message is never handled by two passes.
// Concurrency-safe despite the OR: Postgres re-checks an UPDATE's qualification
// after taking the row lock (the markObservationAsked note).
export async function claimOfficeMessagesForTick(
  tenantId: string,
  ids: string[],
  staleBeforeIso: string,
): Promise<string[]> {
  if (ids.length === 0) return []; // PostgREST `in.()` with zero values errors
  const { data, error } = await getClient()
    .from('office_messages')
    .update({ pinged_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .in('id', ids)
    .eq('status', 'unread')
    .or(`pinged_at.is.null,pinged_at.lt.${staleBeforeIso}`)
    .select('id');
  if (error) throw new Error(`claimOfficeMessagesForTick failed: ${error.message}`);
  return (data ?? []).map((r) => r.id);
}

// FIX A: what the office already read since the planner's last look. A message
// pass marks its message read, and the tick only reads unread — so without this
// an inform that happens to answer a gap would never sit beside that gap, and a
// close could not quote it. Newest first, capped by the caller.
export async function listOfficeReadSince(
  tenantId: string,
  sinceIso: string,
  limit: number,
): Promise<OfficeMessage[]> {
  const { data, error } = await getClient()
    .from('office_messages')
    .select()
    .eq('tenant_id', tenantId)
    .eq('direction', 'to_planner')
    .eq('status', 'read')
    .in('kind', ['inform', 'reply'])
    .gte('read_at', sinceIso)
    .order('read_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listOfficeReadSince failed: ${error.message}`);
  return (data ?? []) as OfficeMessage[];
}

// Literal SETs for the transport's two counters, queued-guarded (the
// setNudgeServeCount twins — the pull loop read the row this tick and is the
// only writer of these columns).
export async function setOfficeMessageServeCount(
  id: string,
  tenantId: string,
  serveCount: number,
): Promise<OfficeMessage | null> {
  const { data, error } = await getClient()
    .from('office_messages')
    .update({ serve_count: serveCount })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'queued')
    .select()
    .maybeSingle();
  if (error) throw new Error(`setOfficeMessageServeCount failed: ${error.message}`);
  return data as OfficeMessage | null;
}

export async function setOfficeMessageAttempts(
  id: string,
  tenantId: string,
  attempts: number,
): Promise<OfficeMessage | null> {
  const { data, error } = await getClient()
    .from('office_messages')
    .update({ attempts })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('status', 'queued')
    .select()
    .maybeSingle();
  if (error) throw new Error(`setOfficeMessageAttempts failed: ${error.message}`);
  return data as OfficeMessage | null;
}
