import type { Json } from './database.types.js';
import { getClient } from './client.js';
import {
  createObservation,
  setObservationStatus,
  type Observation,
} from './observations.js';

// A technician's request to open part of the record (access plan B,
// thoughts/shared/plans/2026-09-19-access-plan-b-the-request-flow-through-the-office.md).
//
// A request IS AN OBSERVATION, kind 'access_request' — not a fifth queue. It is
// something the record has noticed and nobody has settled, which is what
// observations are for: the planner reads its open set every tick, so a
// forwarded request reaches the planner with no new read, and the planner can
// chase the manager or tell the technician it is still waiting.
//
// EVERY READ AND WRITE HERE FILTERS kind = 'access_request'. That is the point
// of the module: `grant_access { requestId }` takes an id from a model, and
// without the kind filter an arbitrary observation id — a call to act on, a
// detector's finding — could be closed through this door by a manager's seat
// guessing a uuid. The tenant filter is the other half, and both are on every
// query below rather than left to the caller (the getObservationForTenant
// precedent, applied one level down).
//
// STATUS IS THE LIFECYCLE, borrowed whole: 'open' (filed, waiting), 'dismissed'
// (answered — granted, declined, or set aside by the planner). 'asked' is
// unused here but accepted everywhere a guard names the unsettled set, because
// the partial unique index covers both and a planner verb may yet write one.

export type AccessRequest = Observation;

/** What the technician asked to be opened. 'record' is the only width the desk
 *  will open by itself; the other two always go to a manager. */
export type AccessWants = 'record' | 'notes' | 'money';

// The statuses that mean "nobody has answered this yet" — the same set the
// partial unique index (uq_open_access_request, migration 20260919170000) is
// built on. Written once so the guard and the index can never drift.
export const UNSETTLED_REQUEST_STATUSES = ['open', 'asked'] as const;

export interface AccessRequestContext {
  /** The dedup key — see requestKeyOf. */
  requestKey: string;
  technicianRef: string;
  technicianName: string;
  jobId?: string;
  customerId: string;
  /** The job or customer in words, for the planner's line and the texts. */
  targetName: string;
  wants: AccessWants;
  /** The technician's own reason, her words. */
  why: string;
  /** The managers who were texted, by display name. Empty = nobody reachable. */
  managersTexted: string[];
}

// ONE open request per person per thing per width. Not per PERSON (she may need
// two jobs) and not per JOB (two technicians may each need the same one): the
// key is all three, so a retried seat call or a second ask the same morning
// converges on the row already waiting instead of texting every manager twice.
// A customer-wide ask keys on 'c:<id>' so it cannot collide with a job id.
export const requestKeyOf = (input: {
  technicianId: string;
  jobId?: string | null;
  customerId?: string | null;
  wants: AccessWants;
}): string =>
  `${input.technicianId}:${input.jobId ?? `c:${input.customerId ?? ''}`}:${input.wants}`;

/** The context, typed, off a row. Unknown shapes read as an empty object rather
 *  than throwing — a request whose context somehow lost a field still has to
 *  render in the planner's list. */
export const contextOf = (row: AccessRequest): Partial<AccessRequestContext> =>
  (row.context && typeof row.context === 'object' && !Array.isArray(row.context)
    ? (row.context as unknown as Partial<AccessRequestContext>)
    : {});

export interface OpenAccessRequestInput {
  tenantId: string;
  technicianId: string;
  context: AccessRequestContext;
}

// File one. Null = this person already has this exact ask waiting (the unique
// index caught it) — the caller says "already asked", it is not an error.
//
// The subject_ref is a FRESH UUID, deliberately: uq_observations_subject_ever is
// partial on author='detector', so a planner row's subject constrains nothing,
// and the real dedup is the requestKey index. A subject that MEANT something
// (the job id, say) would silently become a second, wrong dedup rule the day
// somebody narrowed that index.
export async function openAccessRequest(
  input: OpenAccessRequestInput,
): Promise<AccessRequest | null> {
  return createObservation({
    tenantId: input.tenantId,
    kind: 'access_request',
    subjectRef: `access:${crypto.randomUUID()}`,
    technicianId: input.technicianId,
    author: 'planner',
    context: input.context as unknown as Json,
  });
}

// Is this exact ask already waiting? Used to say "asked on Tuesday, still
// waiting" instead of the bare refusal a caught 23505 would give. Matches the
// index's expression exactly (`context->>requestKey`), so it uses it.
export async function findOpenAccessRequest(
  tenantId: string,
  requestKey: string,
): Promise<AccessRequest | null> {
  const { data, error } = await getClient()
    .from('observations')
    .select()
    .eq('tenant_id', tenantId)
    .eq('kind', 'access_request')
    .eq('context->>requestKey', requestKey)
    .in('status', [...UNSETTLED_REQUEST_STATUSES])
    .maybeSingle();
  if (error) throw new Error(`findOpenAccessRequest failed: ${error.message}`);
  return (data as AccessRequest | null) ?? null;
}

// One request by id, this firm's only, and an access_request only. Null for an
// unknown id, another firm's row, or an observation of any other kind — a
// caller cannot tell those apart, and should not be able to.
export async function getAccessRequest(
  tenantId: string,
  id: string,
): Promise<AccessRequest | null> {
  const { data, error } = await getClient()
    .from('observations')
    .select()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('kind', 'access_request')
    .maybeSingle();
  if (error) throw new Error(`getAccessRequest failed: ${error.message}`);
  return (data as AccessRequest | null) ?? null;
}

// Everything still waiting, oldest first — what list_access shows a manager and
// what the planner chases. Unbounded by design like the observation set itself,
// but a firm with more open access requests than PostgREST's cap has a problem
// no paging would fix; the cap is noted by the caller instead.
export async function listOpenAccessRequests(tenantId: string): Promise<AccessRequest[]> {
  const { data, error } = await getClient()
    .from('observations')
    .select()
    .eq('tenant_id', tenantId)
    .eq('kind', 'access_request')
    .in('status', [...UNSETTLED_REQUEST_STATUSES])
    .order('noticed_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`listOpenAccessRequests failed: ${error.message}`);
  return (data ?? []) as AccessRequest[];
}

// THE ANSWER, and the guard is what makes "the first answer wins" structural:
// the update matches only an unsettled row, so of two managers answering at
// once the second gets null and is told who answered first. Null also covers an
// unknown id, another firm's row, and an observation of another kind.
//
// Closing it DISMISSES it with the outcome as the reason — the planner reads
// dismiss_reason, and "opened by Dana until Friday" is the whole record of what
// happened to the ask.
export async function closeAccessRequest(
  tenantId: string,
  id: string,
  outcome: string,
): Promise<AccessRequest | null> {
  // The kind is checked first because setObservationStatus is kind-blind: it
  // would happily dismiss a call_action row whose id a model guessed.
  const existing = await getAccessRequest(tenantId, id);
  if (!existing) return null;
  return setObservationStatus(
    id,
    tenantId,
    { status: 'dismissed', dismissReason: outcome, dismissedAt: new Date().toISOString() },
    [...UNSETTLED_REQUEST_STATUSES],
  );
}

// The compensation for an answer that closed the request and then failed to
// write the grant: without it the ask is gone and nothing was opened, which is
// the one outcome the technician can neither see nor re-ask her way out of
// (the index would have refused a duplicate while the row was open — but it is
// closed now, so a fresh ask is possible; this simply avoids making her).
// Clears the dismissal, exactly as the planner's `recover` does.
export async function reopenAccessRequest(
  tenantId: string,
  id: string,
): Promise<AccessRequest | null> {
  const existing = await getAccessRequest(tenantId, id);
  if (!existing) return null;
  return setObservationStatus(
    id,
    tenantId,
    { status: 'open', dismissReason: null, dismissedAt: null },
    ['dismissed'],
  );
}
