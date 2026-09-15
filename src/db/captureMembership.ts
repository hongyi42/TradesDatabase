import type { Json } from './database.types.js';
import { getClient } from './client.js';
import type { RawCapture } from './rawCaptures.js';

// The planner's and the watcher's capture readers, over the ONE membership
// definition (retrieval layer plan 3; the rules live in
// supabase/migrations/20260916120000_retrieval_layer_core.sql and the functions in
// 20260917120100_planner_capture_readers.sql).
//
// Each takes its ids in an RPC BODY, never in a URL: PostgREST's gateway refuses
// a request past ~8,192 bytes (~205 UUIDs, measured on the local stack), and the
// hand-written readers these replace chunked at 500 or not at all. Each gets back
// ONE jsonb value, so PostgREST's silent 1000-row cap cannot truncate it either.

// ---------------------------------------------------------------------------
// The planner's evidence (what landed on a gap's job after the gap's own floor).
//
// `via` is every membership arm the capture was reached by, joined with ',' —
// job_stamp, visit_stamp, created_job, created_visit, job_link, visit_note.
// `gapId`/`gapTotal` say which gap asked and how many live captures landed since
// its floor in all, so the prompt can say how many it did not show.
export interface JobEvidenceRow {
  jobId: string;
  gapId?: string;
  gapTotal?: number;
  via: string;
  capture: Pick<RawCapture, 'id' | 'captured_at' | 'channel' | 'technician_ref' | 'raw_text'>;
}

export interface EvidenceAsk {
  gapId: string;
  jobId: string;
  sinceIso: string;
}

type JsonObject = { [key: string]: Json | undefined };
const asObject = (v: Json | undefined): JsonObject | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : null;
const asArray = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const asString = (v: Json | undefined): string | null => (typeof v === 'string' ? v : null);

/**
 * Per gap: its job's newest `perGap` live captures since the gap's floor, oldest
 * first, each carrying `gapId` and the gap's full `gapTotal`. The text is a
 * 2,400-character prefix — the prompt cuts it again at EVIDENCE_TEXT_CHARS.
 * The planner tier sees every capture (no manager_only filter), and retracted
 * captures and retraction rows never come back.
 */
export async function listGapEvidence(
  tenantId: string,
  asks: EvidenceAsk[],
  perGap = 6,
): Promise<JobEvidenceRow[]> {
  if (asks.length === 0) return [];
  const { data, error } = await getClient().rpc('gap_evidence', {
    p_tenant: tenantId,
    p_asks: asks.map((a) => ({ gap_id: a.gapId, job_id: a.jobId, since: a.sinceIso })),
    p_per_gap: perGap,
  });
  if (error) throw new Error(`listGapEvidence failed: ${error.message}`);
  const out: JobEvidenceRow[] = [];
  for (const entry of asArray(data)) {
    const gap = asObject(entry);
    const gapId = asString(gap?.gap_id);
    const jobId = asString(gap?.job_id);
    if (!gap || !gapId || !jobId) continue;
    const gapTotal = typeof gap.total === 'number' ? gap.total : 0;
    for (const item of asArray(gap.captures)) {
      const c = asObject(item);
      const id = asString(c?.id);
      const capturedAt = asString(c?.captured_at);
      if (!c || !id || !capturedAt) continue;
      out.push({
        jobId,
        gapId,
        gapTotal,
        via: asString(c.via) ?? '',
        capture: {
          id,
          captured_at: capturedAt,
          channel: asString(c.channel) as RawCapture['channel'],
          technician_ref: asString(c.technician_ref),
          raw_text: asString(c.text),
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
/**
 * The watcher's activity probe: for each job with a live capture at or after the
 * floor, the latest `captured_at`. Every job arm of the membership counts; a
 * retracted note does not (a withdrawn report is not a report).
 */
export async function listJobActivitySince(
  tenantId: string,
  jobIds: string[],
  sinceUtcIso: string,
): Promise<Map<string, string>> {
  if (jobIds.length === 0) return new Map();
  const { data, error } = await getClient().rpc('job_activity_since', {
    p_tenant: tenantId,
    p_job_ids: jobIds,
    p_since: sinceUtcIso,
  });
  if (error) throw new Error(`listJobActivitySince failed: ${error.message}`);
  const out = new Map<string, string>();
  for (const [jobId, latest] of Object.entries(asObject(data) ?? {})) {
    const at = asString(latest);
    if (at) out.set(jobId, at);
  }
  return out;
}

// ---------------------------------------------------------------------------
// WHAT WAS CREATED FROM THESE CAPTURES (rung 10, the planner's exact close), or
// what filed them. Five kinds, each one membership arm:
//   'job'      — a job whose source_capture_id is the capture (id = the job's)
//   'visit'    — a visit minted from it (id = the visit's, jobId = its job's)
//   'customer' — a customer created from it (id = the customer's, jobId null)
//   'link'     — the capture was recorded ONTO an existing job (`job_captures`);
//                the link has no row id of its own, so `id` is the job's
//   'note'     — the capture was attached to a live TRIP (`visit_notes`); `id` is
//                the visit's
// A CANCELLED job or trip is not an answer. The two linking kinds are not
// closers for `inbound_new_job` / `inbound_commitment`: the door writes that
// link in the same call it raises those asks (the planner's moot fact is
// kind-aware for exactly that reason).
export interface L2CitingCapture {
  kind: 'job' | 'visit' | 'customer' | 'link' | 'note';
  id: string;
  captureId: string;
  jobId: string | null;
}

/** The citing records, and which of these captures have since been retracted. */
export async function readCaptureRecords(
  tenantId: string,
  captureIds: string[],
): Promise<{ citing: L2CitingCapture[]; retracted: string[] }> {
  if (captureIds.length === 0) return { citing: [], retracted: [] };
  const { data, error } = await getClient().rpc('capture_records', {
    p_tenant: tenantId,
    p_capture_ids: captureIds,
  });
  if (error) throw new Error(`readCaptureRecords failed: ${error.message}`);
  const body = asObject(data);
  const citing: L2CitingCapture[] = [];
  for (const item of asArray(body?.records)) {
    const r = asObject(item);
    const captureId = asString(r?.capture_id);
    if (!r || !captureId) continue;
    const jobId = asString(r.job_id);
    const visitId = asString(r.visit_id);
    const customerId = asString(r.customer_id);
    switch (asString(r.via)) {
      case 'created_customer':
        if (customerId) citing.push({ kind: 'customer', id: customerId, captureId, jobId: null });
        break;
      case 'created_job':
        if (jobId) citing.push({ kind: 'job', id: jobId, captureId, jobId });
        break;
      case 'created_visit':
        if (visitId) citing.push({ kind: 'visit', id: visitId, captureId, jobId });
        break;
      case 'job_link':
        if (jobId) citing.push({ kind: 'link', id: jobId, captureId, jobId });
        break;
      case 'visit_note':
        if (visitId) citing.push({ kind: 'note', id: visitId, captureId, jobId });
        break;
    }
  }
  const retracted = asArray(body?.retracted)
    .map(asString)
    .filter((id): id is string => id !== null);
  return { citing, retracted };
}

/** The citing records alone — `record_caller`'s idempotency read. */
export async function listL2CitingCapture(
  tenantId: string,
  captureIds: string[],
): Promise<L2CitingCapture[]> {
  return (await readCaptureRecords(tenantId, captureIds)).citing;
}
