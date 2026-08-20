import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';

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
  return false;
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
// listVisitTimesForJobs: job-stamped capture times since a UTC floor. The
// floor keeps the read bounded (PostgREST silently caps result sets at 1000
// rows); the precise naive-local comparison happens in the caller. Reading
// only one home UNDER-COUNTS activity: a tech note's capture often carries no
// job_id stamp (identity resolves after L1, which is immutable), but
// recordFieldNote ALWAYS mints its visit row — so the visits lister catches
// what this one misses, and vice versa for job-stamped email/call captures.
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
  const { data, error } = await getClient()
    .from('visits')
    .select('id')
    .eq('source_capture_id', captureId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`captureHasLinkedVisit failed: ${error.message}`);
  return !!data;
}

// The retraction rows targeting any of the given captures. "Retracted" is a
// derived property — a row is retracted iff a retraction points at it — so read
// paths call this on the ids they fetched and fold with foldRetractions. Not
// derivable from the fetched list alone: a tech-note capture usually has NULL
// customer_id/job_id stamps (identity resolves after L1, which is immutable),
// so its retraction may not appear in the same stamped list.
export async function findRetractionsFor(captureIds: string[]): Promise<RawCapture[]> {
  if (captureIds.length === 0) return [];
  const { data, error } = await getClient()
    .from('raw_captures')
    .select()
    .in('retracts_capture_id', captureIds);
  if (error) throw new Error(`findRetractionsFor failed: ${error.message}`);
  return data ?? [];
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
// its raw_captures.job_id is often null and the only link is the visit that
// recordFieldNote minted from it (visits.source_capture_id). Reading job-stamped
// captures alone would miss exactly the answers this exists to find.
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
  // 'visit' means it was reached through a visit minted from it.
  via: 'job_stamp' | 'visit';
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

  // (2) Visits minted since the floor — their source capture carries the words.
  const viaVisit = new Map<string, string>(); // captureId -> jobId
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const slice = jobIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('visits')
        .select('job_id, source_capture_id, created_at')
        .eq('tenant_id', tenantId)
        .in('job_id', slice)
        .gte('created_at', sinceUtcIso)
        .not('source_capture_id', 'is', null)
        .order('created_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listJobEvidenceSince failed: ${error.message}`);
      for (const row of (data ?? []) as { job_id: string; source_capture_id: string | null }[]) {
        // A capture already found by its own job stamp keeps that provenance —
        // the direct link is the stronger claim.
        if (row.source_capture_id && !found.has(row.source_capture_id)) {
          viaVisit.set(row.source_capture_id, row.job_id);
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

  // (3) Drop what must never be cited.
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
