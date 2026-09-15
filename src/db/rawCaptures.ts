import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import { captureHasVisitNote } from './visits.js';
import { captureHasJobCapture, TERMINAL_JOB_STATUSES } from './jobs.js';
import { captureHasCustomerCapture } from './customers.js';
// CYCLE, deliberate and safe: observations.ts imports isUniqueViolation from
// here. Both directions use only hoisted function declarations from inside
// function bodies — nothing is read at module-evaluation time — so ESM's live
// bindings resolve either load order. The alternative (a third module for the
// SQLSTATE helpers) would touch every db importer to buy nothing.
import { captureHasObservation } from './observations.js';
import type { ThreadMessage } from '../email/format.js';

export type RawCapture = Database['public']['Tables']['raw_captures']['Row'];
export type CaptureChannel = Database['public']['Enums']['capture_channel'];

export interface AppendRawCaptureInput {
  tenantId: string;
  channel: CaptureChannel;
  rawText?: string | null; // transcripts / notes
  blobPath?: string | null; // pointer into object storage (audio/photos)
  // The source's stable id (Gmail message id, webhook event id, …). Per-tenant
  // unique (uq_raw_captures_external_id, partial — null for technician/MCP captures).
  externalId?: string | null;
  // Person attribution: the badge-mapped technician ref, or `connector:<toolkit>`
  // for unattributed connector captures. Nullable — pre-column rows stay NULL.
  technicianRef?: string | null;
  metadata?: Json;
  // Access marker: 'manager_only' rows are filtered out of technician-tier
  // spine reads (dispatch post-filter). Null = visible to every tier.
  sensitivity?: string | null;
  // Provenance: which entity this capture informed, as known at capture time.
  customerId?: string | null;
  jobId?: string | null;
  visitId?: string | null;
  // Option-B retraction: this capture neutralizes the pointed-at capture.
  // At most one retraction per target (uq_raw_captures_one_retraction).
  retractsCaptureId?: string | null;
}

// DID THE AGENT WRITE THIS ROW, or did the Gmail trigger deliver it?
//
// Rung 10b.3 gave all three producers of an `outbound_email` capture ONE
// external_id (`sent:<messageId>`), so the per-tenant unique index collapses a
// send and its later delivery into a single row. That makes the producer the
// only thing left that tells them apart — and the inbound door has to, because
// an agent's own send must never be run back through the door (it would
// re-extract our own words and ask the planner about a promise the agent itself
// made and already reported), while OUR OWN half-finished delivery must be, or
// a capture that landed and then threw could never heal.
//
// The two keys are stamped unconditionally by their writers: `sentVia` by the
// spine's `send_email`, `toolSlug` by the Composio execution sweep
// (src/composio/logIngest.ts). No trigger-written row can carry either — the
// webhook's stored metadata is headers only. Kept HERE, beside the insert, so
// the readers and the writers cannot drift apart silently; tests on both
// writers assert their real rows satisfy it.
export function isAgentWrittenCapture(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const m = metadata as Record<string, unknown>;
  return !!(m.sentVia || m.toolSlug);
}

// L1 is append-only. This module exposes insert only — no update or delete —
// mirroring the DB trigger that enforces the same invariant.
export async function appendRawCapture(input: AppendRawCaptureInput): Promise<RawCapture> {
  const { data, error } = await getClient()
    .from('raw_captures')
    .insert({
      tenant_id: input.tenantId,
      channel: input.channel,
      raw_text: input.rawText ?? null,
      blob_path: input.blobPath ?? null,
      external_id: input.externalId ?? null,
      technician_ref: input.technicianRef ?? null,
      metadata: input.metadata ?? {},
      // Only name the column when a value is actually set: PostgREST rejects
      // insert bodies naming a column the deployed schema lacks (PGRST204),
      // so an unconditional `sensitivity: null` would take down EVERY L1
      // insert if this code ships before the 20260704120000 migration is
      // applied to the pilot (review finding, empirically verified). Null and
      // omitted are identical outcomes (column default null).
      ...(input.sensitivity != null ? { sensitivity: input.sensitivity } : {}),
      // Same PGRST204 guard SHAPE as sensitivity, but do not read it as
      // ship-ahead safety: unlike sensitivity, the READ paths
      // (findRetractionsFor, the retract_capture stage guards) name the
      // column unconditionally, so the 20260706090000 migration MUST be
      // applied before this code serves reads (review finding). The spread
      // only keeps the insert body stable.
      ...(input.retractsCaptureId != null ? { retracts_capture_id: input.retractsCaptureId } : {}),
      customer_id: input.customerId ?? null,
      job_id: input.jobId ?? null,
      visit_id: input.visitId ?? null,
    })
    .select()
    .single();
  if (error || !data) {
    throw wrapDbError('appendRawCapture failed', error);
  }
  return data;
}

// Wrap a supabase-js error into an Error while PRESERVING the SQLSTATE code,
// so callers can still detect 23505/23503 via isUniqueViolation & co. — a bare
// `new Error(message)` would drop it. ONE definition (review finding: a second
// hand-rolled copy in moneyEvents.ts had already drifted from this one).
export function wrapDbError(prefix: string, error: unknown): Error {
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message?: unknown }).message)
      : 'no row returned';
  const err = new Error(`${prefix}: ${message}`);
  const code = pgErrorCode(error);
  if (code !== undefined) (err as Error & { code?: string }).code = code;
  return err;
}

// Read-only lookup (the append-only trigger only blocks UPDATE/DELETE). Used by
// the write-path to reload a capture's verbatim text on a confirmation resume.
export async function getRawCapture(id: string): Promise<RawCapture | null> {
  const { data, error } = await getClient().from('raw_captures').select().eq('id', id).maybeSingle();
  if (error) throw new Error(`getRawCapture failed: ${error.message}`);
  return data;
}

// External-id dedup lookup, scoped per tenant (matches uq_raw_captures_external_id).
// The write-path uses this as a cheap fast-path; the unique index is the authority.
export async function getRawCaptureByExternalId(
  tenantId: string,
  externalId: string,
): Promise<RawCapture | null> {
  const { data, error } = await getClient()
    .from('raw_captures')
    .select()
    .eq('tenant_id', tenantId)
    .eq('external_id', externalId)
    .maybeSingle();
  if (error) throw new Error(`getRawCaptureByExternalId failed: ${error.message}`);
  return data;
}

// Postgres unique-violation (SQLSTATE 23505), as surfaced by supabase-js on the
// error object. Used by the write-path to turn a concurrent duplicate insert into
// a no-op instead of a 500 (the TOCTOU backstop behind the fast-path pre-check).
export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23505';
}

// Postgres foreign-key violation (SQLSTATE 23503) — e.g. a capture whose tenant_id
// is not a provisioned tenant. The webhook uses this to turn an unknown-tenant insert
// into a clean "give up" instead of a 401 retry storm.
export function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23503';
}

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

// True if any L2 row (customer/job/visit) links back to this capture via
// source_capture_id — i.e. extract→match→L2 progressed for it. NOTE: "any link"
// is NOT "complete" — the L2 build is customer → job → visit, so a crash can
// leave a customer/job with no visit; callers needing completeness use
// captureHasLinkedVisit (the visit is always the last write).
export async function captureHasLinkedL2(captureId: string): Promise<boolean> {
  const client = getClient();
  for (const table of ['visits', 'jobs', 'customers'] as const) {
    const { data, error } = await client
      .from(table)
      .select('id')
      .eq('source_capture_id', captureId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`captureHasLinkedL2 failed on ${table}: ${error.message}`);
    if (data) return true;
  }
  // The LINK arms. source_capture_id alone stopped being the whole story once a
  // capture could ATTACH to something it did not create: such a capture leaves
  // no source_capture_id anywhere, so a redelivery of it would read as an
  // unprocessed orphan, re-run extraction, and re-attach.
  //   visit_notes  (rung 9b) — it reported a trip.
  //   job_captures (rung 10) — it landed on a job with no live trip.
  //   observations (rung 10) — it created NOTHING, on purpose, and a manager
  //     was asked instead. That ask IS the processing, and it is the only trace
  //     such a capture leaves; without this arm every redelivery would re-run
  //     the extractor and (the once-ever index aside) re-ping the planner.
  //   customer_captures — the door knew WHO but not WHICH job, so it linked the
  //     level it was sure of. Without this arm a capture the door deliberately
  //     declined to file on a job would read as an unprocessed orphan and be
  //     re-extracted on every redelivery — paying the model to re-reach the same
  //     "I cannot tell" it already recorded.
  // Started together, settled together: four independent reads on the write
  // path's hottest branch, and awaiting them in series adds three round trips to
  // every redelivery (the listAssignments/listJobs idiom in the planner).
  const [note, jobLink, observed, customerLink] = await Promise.all([
    captureHasVisitNote(captureId),
    captureHasJobCapture(captureId),
    captureHasObservation(captureId),
    captureHasCustomerCapture(captureId),
  ]);
  return note || jobLink || observed || customerLink;
}

// Captures directly stamped with a job_id, newest first. (Tech notes resolved via
// L2.source_capture_id won't appear here — getCustomerContext unions those in.)
export async function listRawCapturesForJob(jobId: string): Promise<RawCapture[]> {
  const { data, error } = await getClient()
    .from('raw_captures')
    .select()
    .eq('job_id', jobId)
    .order('captured_at', { ascending: false });
  if (error) throw new Error(`listRawCapturesForJob failed: ${error.message}`);
  return data ?? [];
}

// The watcher's activity probe — one of TWO homes, always paired with visits'
// listNoteTimesForJobs: job-stamped capture times since a UTC floor. The
// floor keeps the read bounded (PostgREST silently caps result sets at 1000
// rows); the precise naive-local comparison happens in the caller. Reading
// only one home UNDER-COUNTS activity: a tech note's capture often carries no
// job_id stamp (identity resolves after L1, which is immutable), but a
// technician note always LINKS a visit — so listNoteTimesForJobs catches what
// this one misses, and vice versa for job-stamped email/call captures.
//
// CLOSED BY RUNG 10, and this reader gained the THIRD home that closes it.
// Rung 9b narrowed the hole: any channel may ATTACH to a visit that already
// exists, so an inbound capture about a BOOKED trip is visible through its
// visit_notes link. What survived was the LINK-LESS shape — an inbound capture
// on a job with no live visit at all, unstamped and linked to nothing, so the
// job read silent. Inbound now writes a `job_captures` row for exactly that
// case, and this reader unions it: capture times come from raw_captures
// (`captured_at`, when the customer actually said it), reached through the
// link. Rung 10 did NOT close it by minting a visit — a call is not a trip, and
// what to put on the calendar is the manager's to say.
export async function listJobStampedCaptureTimes(
  tenantId: string,
  jobIds: string[],
  sinceUtcIso: string,
): Promise<{ job_id: string | null; captured_at: string }[]> {
  if (jobIds.length === 0) return []; // PostgREST `in.()` with zero values errors
  // PAGED (final-review finding): the floor bounds RECENCY, not row count, and
  // PostgREST's silent 1000-row cap on an UNORDERED read would drop arbitrary
  // rows — possibly the one capture proving a visit was reported, turning a
  // filled visit into a false gap flag (the listTenantIdsWithTelegramBindings
  // precedent).
  const PAGE = 1000;
  const out: { job_id: string | null; captured_at: string }[] = [];
  for (let fromRow = 0; ; fromRow += PAGE) {
    const { data, error } = await getClient()
      .from('raw_captures')
      .select('job_id, captured_at')
      .eq('tenant_id', tenantId)
      .in('job_id', jobIds)
      .gte('captured_at', sinceUtcIso)
      .order('captured_at', { ascending: true })
      .range(fromRow, fromRow + PAGE - 1);
    if (error) throw new Error(`listJobStampedCaptureTimes failed: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  // The third home (rung 10): captures LINKED to the job. The floor and the
  // reported time are the CAPTURE's `captured_at` — when the customer said it —
  // not the link's `created_at`; the paging order is the link's own, which is
  // all a stable total order has to be.
  for (let fromRow = 0; ; fromRow += PAGE) {
    const { data, error } = await getClient()
      .from('job_captures')
      // tenant_id on the EMBED as well as the link: `capture_id` is an id-only
      // foreign key, so the link's own tenant is no proof the words are ours.
      .select('job_id, raw_captures!inner(tenant_id, captured_at)')
      .eq('tenant_id', tenantId)
      .in('job_id', jobIds)
      .gte('raw_captures.captured_at', sinceUtcIso)
      // A TOTAL order — see listJobEvidenceSince's job arm for why the whole
      // primary key is named.
      .order('created_at', { ascending: true })
      .order('job_id', { ascending: true })
      .order('capture_id', { ascending: true })
      .range(fromRow, fromRow + PAGE - 1);
    if (error) throw new Error(`listJobStampedCaptureTimes failed: ${error.message}`);
    for (const row of (data ?? []) as unknown as {
      job_id: string;
      raw_captures: { tenant_id: string; captured_at: string } | null;
    }[]) {
      if (row.raw_captures && row.raw_captures.tenant_id === tenantId) {
        out.push({ job_id: row.job_id, captured_at: row.raw_captures.captured_at });
      }
    }
    if (!data || data.length < PAGE) return out;
  }
}

// True if a visit links back to this capture — the completeness marker for a
// processed note (recordFieldNote always writes the visit LAST, so a linked
// visit implies the whole L2 build ran). The staged-confirm duplicate path
// uses this to distinguish "already fully recorded" from "an earlier commit
// crashed mid-L2" (review finding: reporting the latter as a clean duplicate
// silently loses the note's labor hours/attributes forever).
export async function captureHasLinkedVisit(captureId: string): Promise<boolean> {
  // Rung 9b: the marker is the LINK, not ownership of the row. A note that
  // attached to an already-booked trip owns nothing, and reporting it as
  // "an earlier commit crashed mid-L2" would re-run the whole build.
  return await captureHasVisitNote(captureId);
}

// The retraction rows targeting any of the given captures. "Retracted" is a
// derived property — a row is retracted iff a retraction points at it — so read
// paths call this on the ids they fetched and fold with foldRetractions. Not
// derivable from the fetched list alone: a tech-note capture usually has NULL
// customer_id/job_id stamps (identity resolves after L1, which is immutable),
// so its retraction may not appear in the same stamped list.
//
// CHUNKED, because callers hand it every capture id a customer's context holds
// and L1 only grows. One `in.()` builds the whole id list into the URL, and
// PostgREST refuses past 8192 bytes with a 414 ("URI too long") that failed the
// entire read. Measured for THIS query on the local stack (2026-09-14): 150 ids
// = 5,929 bytes passes, 214 = 8,425 bytes is refused (postgrest-js percent-
// encodes the parens and commas, so the wall sits near 205 ids, lower than the
// 215 bisected for findCustomersByThread below). 150 keeps ~2.2 KB of headroom.
// Deduped first: postgrest-js dedupes within one `.in()` but not across chunks,
// so a repeated id would otherwise return its retraction twice. One retraction
// per target (uq_raw_captures_one_retraction) keeps each chunk ≤150 rows, under
// PostgREST's silent 1000-row cap.
const RETRACTION_CHUNK = 150;
export async function findRetractionsFor(captureIds: string[]): Promise<RawCapture[]> {
  const ids = [...new Set(captureIds)];
  const out: RawCapture[] = [];
  for (let i = 0; i < ids.length; i += RETRACTION_CHUNK) {
    const { data, error } = await getClient()
      .from('raw_captures')
      .select()
      .in('retracts_capture_id', ids.slice(i, i + RETRACTION_CHUNK));
    if (error) throw new Error(`findRetractionsFor failed: ${error.message}`);
    out.push(...(data ?? []));
  }
  return out;
}

// The planner's evidence read (plan 2026-08-19, Phase 3): what actually LANDED
// on these jobs after a floor — with the words, not just the timestamps.
//
// listJobStampedCaptureTimes above answers "did anything arrive"; this answers
// "what did they SAY", because the planner may only mark a gap answered by
// quoting the evidence (cite-or-don't-close). Same floor discipline, same paging.
//
// It unions the SAME two homes the watcher's activity probe does, and for the
// same reason: a technician's reply lands in L1 before identity is resolved, so
// its raw_captures.job_id is often null and the only link is the visit_notes row
// tying it to the trip it reported. Reading job-stamped captures alone would
// miss exactly the answers this exists to find. (Same rung-9b gap as
// listJobStampedCaptureTimes documents: an inbound capture matched to an
// existing job links nothing until Phase 3's attach rule lands. CLOSED by rung
// 10's third arm below: `job_captures`.)
//
// Two things are dropped, both deliberately:
//  * manager_only rows — the team lead holds no manager badge, and its citations
//    end up in technician-facing questions and manager items alike. Same
//    treatment the MCP dispatch gives a non-manager caller.
//  * retracted captures and the retraction rows themselves — citing a note
//    somebody retracted would be worse than citing nothing.
export interface JobEvidenceRow {
  jobId: string;
  capture: RawCapture;
  // How this capture was found. 'job_stamp' means it names the job directly;
  // 'visit' means it was reached through a visit it reported; 'job' means it
  // was linked straight to the job (rung 10 — inbound on a job with no trip).
  via: 'job_stamp' | 'visit' | 'job';
}

export async function listJobEvidenceSince(
  tenantId: string,
  jobIds: string[],
  sinceUtcIso: string,
): Promise<JobEvidenceRow[]> {
  if (jobIds.length === 0) return []; // PostgREST `in.()` with zero values errors
  const PAGE = 1000;
  const CHUNK = 500;
  const found = new Map<string, JobEvidenceRow>();

  // (1) Captures that name the job themselves.
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const slice = jobIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('raw_captures')
        .select()
        .eq('tenant_id', tenantId)
        .in('job_id', slice)
        .gte('captured_at', sinceUtcIso)
        .order('captured_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listJobEvidenceSince failed: ${error.message}`);
      for (const row of (data ?? []) as RawCapture[]) {
        if (row.job_id) found.set(row.id, { jobId: row.job_id, capture: row, via: 'job_stamp' });
      }
      if (!data || data.length < PAGE) break;
    }
  }

  // (2) Notes LINKED to a trip since the floor — the capture carries the words.
  // Rung 9b re-sourced this from "visit rows minted since the floor": a note now
  // attaches to a trip that may have been booked weeks earlier, so the row's own
  // created_at is no longer the moment the evidence landed. The LINK's is.
  const viaVisit = new Map<string, string>(); // captureId -> jobId
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const slice = jobIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('visit_notes')
        .select('capture_id, created_at, visits!inner(job_id)')
        .eq('tenant_id', tenantId)
        .in('visits.job_id', slice)
        .gte('created_at', sinceUtcIso)
        .order('created_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listJobEvidenceSince failed: ${error.message}`);
      for (const row of (data ?? []) as {
        capture_id: string;
        visits: { job_id: string } | null;
      }[]) {
        // A capture already found by its own job stamp keeps that provenance —
        // the direct link is the stronger claim.
        if (row.visits && !found.has(row.capture_id)) {
          viaVisit.set(row.capture_id, row.visits.job_id);
        }
      }
      if (!data || data.length < PAGE) break;
    }
  }

  // (3) Captures LINKED straight to the job (rung 10) — an inbound call or
  // email on an open job with no live trip. The floor is the CAPTURE's
  // captured_at, because that is when the customer said it; the link is written
  // in the same breath, so the two never meaningfully diverge here.
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const slice = jobIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('job_captures')
        .select('job_id, raw_captures!inner(*)')
        .eq('tenant_id', tenantId)
        .in('job_id', slice)
        .gte('raw_captures.captured_at', sinceUtcIso)
        // (created_at, job_id, capture_id) is a TOTAL order — the primary key
        // is (job_id, capture_id) and `created_at` is the transaction stamp, so
        // links written together tie. Without the whole key a tie spanning a
        // page boundary could repeat or drop a row.
        .order('created_at', { ascending: true })
        .order('job_id', { ascending: true })
        .order('capture_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listJobEvidenceSince failed: ${error.message}`);
      for (const row of (data ?? []) as unknown as {
        job_id: string;
        raw_captures: RawCapture | null;
      }[]) {
        // TENANT RE-CHECK ON THE CAPTURE, not just the link: `capture_id` is an
        // id-only foreign key, so a row whose link is ours while the words are
        // another firm's would otherwise be handed to the planner as citeable
        // evidence. The visit arm gets this for free — its captures are
        // re-fetched under `.eq('tenant_id', …)` below — and this arm reads the
        // capture through an embed instead, so it has to say so itself.
        //
        // PROVENANCE ORDER: job_stamp, then visit, then this. A capture that
        // named its job directly, or that reported a TRIP, keeps that reading —
        // both are more specific claims than "it landed on the job". Reachable
        // through the retraction twin-insert, which follows its target onto
        // every link it has.
        const capture = row.raw_captures;
        if (
          capture &&
          capture.tenant_id === tenantId &&
          !found.has(capture.id) &&
          !viaVisit.has(capture.id)
        ) {
          found.set(capture.id, { jobId: row.job_id, capture, via: 'job' });
        }
      }
      if (!data || data.length < PAGE) break;
    }
  }

  const missingIds = [...viaVisit.keys()];
  for (let i = 0; i < missingIds.length; i += CHUNK) {
    const slice = missingIds.slice(i, i + CHUNK);
    const { data, error } = await getClient()
      .from('raw_captures')
      .select()
      .eq('tenant_id', tenantId)
      .in('id', slice);
    if (error) throw new Error(`listJobEvidenceSince failed: ${error.message}`);
    for (const row of (data ?? []) as RawCapture[]) {
      const jobId = viaVisit.get(row.id);
      if (jobId) found.set(row.id, { jobId, capture: row, via: 'visit' });
    }
  }

  // (4) Drop what must never be cited.
  const rows = [...found.values()].filter((r) => r.capture.sensitivity !== 'manager_only');
  const kept = new Set(
    foldRetractions(
      rows.map((r) => r.capture),
      await findRetractionsFor(rows.map((r) => r.capture.id)),
    ).map((c) => c.id),
  );
  return rows
    .filter((r) => kept.has(r.capture.id))
    .sort((a, b) => (a.capture.captured_at < b.capture.captured_at ? -1 : 1));
}

// Pure fold: drop every capture a retraction points at, and drop retraction
// rows themselves (their own retracts_capture_id is non-null — they never
// appear in folded views even when stamped into a customer/job list).
export function foldRetractions(rows: RawCapture[], retractions: RawCapture[]): RawCapture[] {
  const retracted = new Set(
    retractions.map((r) => r.retracts_capture_id).filter((id): id is string => !!id),
  );
  return rows.filter((row) => !retracted.has(row.id) && row.retracts_capture_id === null);
}

// Captures directly stamped with a customer_id, newest first.
export async function listRawCapturesForCustomer(customerId: string): Promise<RawCapture[]> {
  const { data, error } = await getClient()
    .from('raw_captures')
    .select()
    .eq('customer_id', customerId)
    .order('captured_at', { ascending: false });
  if (error) throw new Error(`listRawCapturesForCustomer failed: ${error.message}`);
  return data ?? [];
}

// WHAT WAS CREATED FROM THESE CAPTURES (rung 10, the planner's exact close).
// A job or a visit whose `source_capture_id` is one of them — proof that the
// manager's agent acted on that call, and the only close the planner may make
// on THE RECORD for an inbound observation. Batched over the tick's captures,
// because the alternative is one round trip per gap inside a sync closure.
//
// Fleet-wide by capture id, like every other reader keyed on one: the caller
// holds the ids, and the rows it gets back name the L2 they belong to.
// RUNG 10B added two more kinds, because "nothing has been created" is not the
// hole `inbound_unmatched` names. That one asks WHO CALLED, and it is answered
// by the caller having been identified:
//   'customer' — a customer row was created from this capture. `jobId` is null;
//                `id` is the customer's.
//   'link'     — the capture was recorded ONTO an existing job (`job_captures`),
//                which is what LINKING a caller we already knew leaves behind.
//                The link has no row id of its own — its primary key is
//                (job_id, capture_id) — so `id` carries the job's, same as
//                `jobId`.
//   'note'      — the capture was attached to a live TRIP (`visit_notes`). The
//                OTHER shape a link takes, and it is not interchangeable: when a
//                job already has a visit the capture attaches to the visit and no
//                `job_captures` row is written at all, so without this arm a
//                reply landing on a booked job would cite nothing and its item
//                could never become moot. `id` is the visit's, `jobId` the trip's
//                job.
// The two new kinds are NOT closers for `inbound_new_job` / `inbound_commitment`:
// the door writes a `job_captures` link in the SAME call it raises those asks, so
// counting it would close every one of them the moment it was raised. The
// planner's moot fact is kind-aware for exactly that reason.
export interface L2CitingCapture {
  kind: 'job' | 'visit' | 'customer' | 'link' | 'note';
  id: string;
  captureId: string;
  jobId: string | null;
}

export async function listL2CitingCapture(captureIds: string[]): Promise<L2CitingCapture[]> {
  if (captureIds.length === 0) return []; // PostgREST `in.()` with zero values errors
  const CHUNK = 200;
  const PAGE = 1000;
  const out: L2CitingCapture[] = [];
  for (let i = 0; i < captureIds.length; i += CHUNK) {
    const slice = captureIds.slice(i, i + CHUNK);
    // TWO EXPLICIT QUERIES rather than one loop over a computed select: the
    // PostgREST client types the column list at compile time, and a select
    // string chosen at runtime resolves to a ParserError instead of a row type.
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('jobs')
        .select('id, source_capture_id')
        .in('source_capture_id', slice)
        // A CANCELLED ROW IS NOT AN ANSWER. bookVisit rolls back a shell it
        // minted when the DB overlap guard fires, by flipping it to
        // 'cancelled' — the stamp stays. Without this filter the planner would
        // read "a job was created from this call", close the ask on the
        // record, and the customer who was told someone is coming would have
        // nothing on the calendar and nobody left asking.
        .neq('status', 'cancelled')
        .order('id', { ascending: true }) // deterministic paging tiebreak
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listL2CitingCapture failed on jobs: ${error.message}`);
      for (const row of data ?? []) {
        if (row.source_capture_id) {
          out.push({ kind: 'job', id: row.id, captureId: row.source_capture_id, jobId: row.id });
        }
      }
      if (!data || data.length < PAGE) break;
    }
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('visits')
        .select('id, job_id, source_capture_id')
        .in('source_capture_id', slice)
        .neq('status', 'cancelled') // same rule as the jobs arm above
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listL2CitingCapture failed on visits: ${error.message}`);
      for (const row of data ?? []) {
        if (row.source_capture_id) {
          out.push({
            kind: 'visit',
            id: row.id,
            captureId: row.source_capture_id,
            jobId: row.job_id,
          });
        }
      }
      if (!data || data.length < PAGE) break;
    }
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('customers')
        .select('id, source_capture_id')
        .in('source_capture_id', slice)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listL2CitingCapture failed on customers: ${error.message}`);
      for (const row of data ?? []) {
        if (row.source_capture_id) {
          out.push({ kind: 'customer', id: row.id, captureId: row.source_capture_id, jobId: null });
        }
      }
      if (!data || data.length < PAGE) break;
    }
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('job_captures')
        // The job's status comes through the embed: a link onto a CANCELLED job
        // is no more an answer than a cancelled job itself is, and the two arms
        // above drop those for the same reason.
        .select('job_id, capture_id, jobs!inner(id, status)')
        .in('capture_id', slice)
        .order('job_id', { ascending: true })
        .order('capture_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listL2CitingCapture failed on job_captures: ${error.message}`);
      for (const row of (data ?? []) as unknown as {
        job_id: string;
        capture_id: string;
        jobs: { id: string; status: string } | null;
      }[]) {
        if (row.jobs && row.jobs.status !== 'cancelled') {
          out.push({ kind: 'link', id: row.job_id, captureId: row.capture_id, jobId: row.job_id });
        }
      }
      if (!data || data.length < PAGE) break;
    }
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('visit_notes')
        .select('capture_id, visits!inner(id, job_id, status)')
        .in('capture_id', slice)
        .order('capture_id', { ascending: true })
        .order('visit_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listL2CitingCapture failed on visit_notes: ${error.message}`);
      for (const row of (data ?? []) as unknown as {
        capture_id: string;
        visits: { id: string; job_id: string; status: string } | null;
      }[]) {
        // Same rule as every arm above: a cancelled trip is not an answer.
        if (row.visits && row.visits.status !== 'cancelled') {
          out.push({
            kind: 'note',
            id: row.visits.id,
            captureId: row.capture_id,
            jobId: row.visits.job_id,
          });
        }
      }
      if (!data || data.length < PAGE) break;
    }
  }
  return out;
}

// EVERY CUSTOMER (and, when it is unambiguous, the job) AN EMAIL THREAD ALREADY
// TOUCHES — rung 10b's third identity key.
//
// A reply carries the thread id of the message it answers, so a conversation we
// have already filed identifies its customer even when the reply itself carries
// no phone number and no address. Not hypothetical: a known customer's
// reschedule request was parked as a stranger on 2026-09-08 for exactly that
// reason. The CALLER decides what the answer means — one distinct customer is a
// match, two is a refusal (identityMatch's unique-or-refuse rule).
//
// TWO READS FOR THE CAPTURES, because the two ends of a thread spell the key
// differently and neither is going to change: a thread STARTER is found by its
// own message id (Gmail's convention — a starter's thread id IS its message id,
// and `external_id` is where an INBOUND capture stores that), while every later
// message carries the key in `metadata.threadId` (written by the inbound door
// since PR #213 and by every assistant send).
//
// THE STARTER READ DOES NOT COVER AN OUTBOUND ROW (rung 10b.3): the firm's own
// mail is keyed `sent:<messageId>` so the trigger, `send_email` and `logIngest`
// share one L1 key, and that never equals a bare thread id. It costs nothing —
// those rows all carry `metadata.threadId`, so the second read finds them — but
// the first read is inbound-only and should be read as such.
//
// TENANT-CHECKED ON EVERY HOP: `capture_id`, `job_id` and `visit_id` are id-only
// foreign keys, so a link of ours is no proof the row it points at is ours (the
// listJobEvidenceSince doctrine). A direct `jobs` read rather than
// listL2CitingCapture, which is fleet-wide by capture id and hands back no
// customer — the customer is the whole answer here.
export interface ThreadIdentity {
  customerId: string;
  jobId: string | null;
}

// BOUNDED, AND IT REFUSES RATHER THAN GUESSING WHEN THE BOUND IS HIT.
//   * 150 captures — the id list goes into PostgREST `.in()` filters, and a long
//     enough one builds a URL the server rejects outright with 414. The ceiling
//     was BISECTED against this code's own widest read (the `visit_notes` embed,
//     tenant filter and limit included): 215 ids = 8125 bytes passes, 218 = 8236
//     bytes is a 414, so the wall is the 8192-byte URL limit. 150 leaves ~32%
//     headroom, because UUIDs are fixed-width and nothing absorbs a later
//     `.order()`, one more filter, or a wider select.
//   * 500 rows on every read that fans out from those ids. NOT 1000, and that is
//     the whole point: PostgREST's `max_rows` is 1000 (supabase/config.toml) and
//     it CLAMPS a larger limit SILENTLY — no 206, no error — so a cap of 1000
//     could never be observed to have been hit and the guard below would be
//     decoration. 501 comes back as 501 rows, which is a fact we can act on.
// A read that FILLS its cap has been silently truncated, and a truncated page can
// leave exactly ONE customer standing when the whole thread names three. That is
// the confident wrong match unique-or-refuse exists to prevent, so a filled cap
// returns nothing at all and the next key gets its turn.
const THREAD_CAPTURE_CAP = 150;
const THREAD_ROW_CAP = 500;

// A refusal is otherwise COMPLETELY SILENT: the caller cannot tell it from
// "nobody is on this thread", so every reply on such a thread would quietly stop
// matching with nothing anywhere saying why. One line, carrying no PII beyond
// the thread id — a Gmail conversation handle that already sits in L1 metadata.
function refuseThread(threadId: string, why: string): [] {
  console.error(`findCustomersByThread: refusing thread ${threadId} — ${why}`);
  return [];
}

export async function findCustomersByThread(
  tenantId: string,
  threadId: string,
): Promise<ThreadIdentity[]> {
  if (!threadId) return [];
  const client = getClient();

  const stamps: { customerId: string | null; jobId: string | null }[] = [];
  const captureIds = new Set<string>();
  for (const read of [
    client
      .from('raw_captures')
      .select('id, customer_id, job_id')
      .eq('tenant_id', tenantId)
      .eq('external_id', threadId)
      .limit(THREAD_CAPTURE_CAP + 1),
    client
      .from('raw_captures')
      .select('id, customer_id, job_id')
      .eq('tenant_id', tenantId)
      .eq('metadata->>threadId', threadId)
      .limit(THREAD_CAPTURE_CAP + 1),
  ]) {
    const { data, error } = await read;
    if (error) throw new Error(`findCustomersByThread failed on raw_captures: ${error.message}`);
    for (const row of data ?? []) {
      if (captureIds.has(row.id)) continue;
      captureIds.add(row.id);
      stamps.push({ customerId: row.customer_id, jobId: row.job_id });
    }
  }
  if (captureIds.size === 0) return [];
  if (captureIds.size > THREAD_CAPTURE_CAP) {
    return refuseThread(threadId, `more than ${THREAD_CAPTURE_CAP} captures — too many to answer safely`);
  }
  const ids = [...captureIds];

  const jobIds = new Set<string>();
  const stampedCustomerIds = new Set<string>();
  // (a) What the capture itself was stamped with at append time (the
  //     staged-confirm path stamps identity AT the insert). NEITHER id is taken
  //     as it stands: `customer_id` and `job_id` are id-only foreign keys, so a
  //     capture of ours can name another firm's row. The customer is re-read
  //     under this tenant below; the job goes through the same tenant-scoped
  //     resolution every other arm uses, which is also what applies the
  //     terminal-job rule to it.
  for (const stamp of stamps) {
    if (stamp.customerId) stampedCustomerIds.add(stamp.customerId);
    if (stamp.jobId) jobIds.add(stamp.jobId);
  }
  // (b) The capture LANDED on a job (rung 10's link-less shape).
  {
    const { data, error } = await client
      .from('job_captures')
      .select('job_id')
      .eq('tenant_id', tenantId)
      .in('capture_id', ids)
      .limit(THREAD_ROW_CAP + 1);
    if (error) throw new Error(`findCustomersByThread failed on job_captures: ${error.message}`);
    if ((data?.length ?? 0) > THREAD_ROW_CAP) {
      return refuseThread(threadId, 'over the job_captures row cap');
    }
    for (const row of data ?? []) jobIds.add(row.job_id);
  }
  // (c) The capture reported a TRIP — the visit names its job.
  {
    const { data, error } = await client
      .from('visit_notes')
      .select('visits!inner(id, tenant_id, job_id)')
      .eq('tenant_id', tenantId)
      .in('capture_id', ids)
      .limit(THREAD_ROW_CAP + 1);
    if (error) throw new Error(`findCustomersByThread failed on visit_notes: ${error.message}`);
    if ((data?.length ?? 0) > THREAD_ROW_CAP) {
      return refuseThread(threadId, 'over the visit_notes row cap');
    }
    for (const row of (data ?? []) as unknown as {
      visits: { id: string; tenant_id: string; job_id: string } | null;
    }[]) {
      if (row.visits && row.visits.tenant_id === tenantId) jobIds.add(row.visits.job_id);
    }
  }
  // (d) L2 rows CREATED from one of these captures. A customer with no job of
  //     its own still answers "who is this", which is the question asked.
  const pairs: ThreadIdentity[] = [];
  {
    const { data, error } = await client
      .from('customers')
      .select('id')
      .eq('tenant_id', tenantId)
      .in('source_capture_id', ids)
      .limit(THREAD_ROW_CAP + 1);
    if (error) throw new Error(`findCustomersByThread failed on customers: ${error.message}`);
    if ((data?.length ?? 0) > THREAD_ROW_CAP) {
      return refuseThread(threadId, 'over the customers row cap');
    }
    for (const row of data ?? []) pairs.push({ customerId: row.id, jobId: null });
  }
  {
    const { data, error } = await client
      .from('jobs')
      .select('id')
      .eq('tenant_id', tenantId)
      .in('source_capture_id', ids)
      .limit(THREAD_ROW_CAP + 1);
    if (error) throw new Error(`findCustomersByThread failed on jobs: ${error.message}`);
    if ((data?.length ?? 0) > THREAD_ROW_CAP) {
      return refuseThread(threadId, 'over the jobs row cap');
    }
    for (const row of data ?? []) jobIds.add(row.id);
  }
  // The stamped customers, proved to be ours before they can answer anything.
  if (stampedCustomerIds.size > 0) {
    const { data, error } = await client
      .from('customers')
      .select('id')
      .eq('tenant_id', tenantId)
      .in('id', [...stampedCustomerIds])
      .limit(THREAD_ROW_CAP + 1);
    if (error) throw new Error(`findCustomersByThread failed on customers: ${error.message}`);
    if ((data?.length ?? 0) > THREAD_ROW_CAP) {
      return refuseThread(threadId, 'over the customers row cap');
    }
    for (const row of data ?? []) pairs.push({ customerId: row.id, jobId: null });
  }

  // Resolve every job this thread reached to its customer, chunked because the
  // arms above can name more jobs than one `.in()` may carry. A TERMINAL job
  // (paid, cancelled, declined) still answers WHO — the customer did not stop
  // being that customer — but its id is dropped: handing it back as the job to
  // file a reply on would put new work on a closed job AND swallow rung 10's
  // ask, which only fires when the door found no job at all.
  const jobList = [...jobIds];
  for (let i = 0; i < jobList.length; i += THREAD_CAPTURE_CAP) {
    const { data, error } = await client
      .from('jobs')
      .select('id, customer_id, status')
      .eq('tenant_id', tenantId)
      .in('id', jobList.slice(i, i + THREAD_CAPTURE_CAP))
      .limit(THREAD_ROW_CAP + 1);
    if (error) throw new Error(`findCustomersByThread failed on jobs: ${error.message}`);
    if ((data?.length ?? 0) > THREAD_ROW_CAP) {
      return refuseThread(threadId, 'over the jobs row cap');
    }
    for (const row of data ?? []) {
      pairs.push({
        customerId: row.customer_id,
        jobId: TERMINAL_JOB_STATUSES.has(row.status) ? null : row.id,
      });
    }
  }

  const seen = new Set<string>();
  return pairs.filter((pair) => {
    const key = `${pair.customerId}|${pair.jobId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// OUR OWN CAPTURES ON A THREAD, as messages — the FALLBACK when Composio cannot
// hand us the conversation (a blip, a revoked account, a mailbox that never
// paired). It is strictly weaker than the real thread: it holds only what
// reached US, so a message the customer sent to somebody else, or one that
// predates the pairing, is simply not there. That is still better than nothing,
// and it costs no billed execution.
//
// The same two reads and the same caps as findCustomersByThread, for the same
// reasons — see its header. `raw_text` is the STORAGE form (headers prepended by
// formatEmailRawText), which is what the extractor already reads elsewhere.
export interface ThreadFromL1 {
  messages: ThreadMessage[];
  // The Gmail message ids of captures on this thread that must NEVER be shown to
  // the extractor — retracted, or manager_only. Returned SEPARATELY because the
  // preferred source is Gmail itself, which knows nothing of either: without
  // this, a retraction would hold only while Composio was down.
  blockedMessageIds: string[];
}

export async function listCapturesByThread(
  tenantId: string,
  threadId: string,
): Promise<ThreadFromL1> {
  if (!threadId) return { messages: [], blockedMessageIds: [] };
  const client = getClient();
  // A READER, NOT A MATCHER — so it does NOT refuse on a full page. Truncation
  // here costs context, not correctness (findCustomersByThread refuses because a
  // truncated page there can leave one customer standing out of three). It asks
  // for the NEWEST few directly instead of paging a busy thread's full text into
  // memory on the ingest path: the renderer shows at most eight, and the caller
  // drops the current message, so a handful of spares is the whole need.
  const WANT = 16;
  const seen = new Set<string>();
  const rows: RawCapture[] = [];
  for (const read of [
    client
      .from('raw_captures')
      .select()
      .eq('tenant_id', tenantId)
      .eq('external_id', threadId)
      .order('captured_at', { ascending: false })
      .limit(WANT),
    client
      .from('raw_captures')
      .select()
      .eq('tenant_id', tenantId)
      .eq('metadata->>threadId', threadId)
      .order('captured_at', { ascending: false })
      .limit(WANT),
  ]) {
    const { data, error } = await read;
    if (error) throw new Error(`listCapturesByThread failed: ${error.message}`);
    for (const row of (data ?? []) as RawCapture[]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  if (rows.length === 0) return { messages: [], blockedMessageIds: [] };

  // WHAT MUST NEVER BE SHOWN, the same two exclusions every other capture reader
  // applies (listJobEvidenceSince):
  //   * a RETRACTED capture — somebody marked it recorded in error, and the
  //     write-path treats it as terminal precisely so it can never be rebuilt
  //     from. Handing its words to the extractor as context would launder them
  //     back into L2/L3 against the NEW capture, which is the same resurrection
  //     by another road.
  //   * `manager_only` — the extractor's output reaches technician-facing rows.
  const visible = rows.filter((row) => row.sensitivity !== 'manager_only');
  const kept = foldRetractions(visible, await findRetractionsFor(rows.map((row) => row.id)));
  const keptIds = new Set(kept.map((row) => row.id));
  const blockedMessageIds = rows
    .filter((row) => !keptIds.has(row.id))
    .map((row) => row.external_id)
    .filter((id): id is string => !!id);
  const messages = kept
    .sort((a, b) => (a.captured_at < b.captured_at ? -1 : 1)) // oldest first, as read
    .map((row) => {
      const meta =
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, Json>)
          : {};
      const str = (key: string): string | null =>
        typeof meta[key] === 'string' && meta[key] ? (meta[key] as string) : null;
      return {
        messageId: row.external_id,
        from: str('from'),
        to: str('to'),
        subject: str('subject'),
        body: row.raw_text ?? '',
        at: row.captured_at,
      };
    });
  return { messages, blockedMessageIds };
}
