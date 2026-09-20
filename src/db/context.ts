// The customer read, through the retrieval layer (plan
// 2026-09-15-the-retrieval-layer-1-captures-and-the-customer-read).
//
// This module used to assemble a customer's WHOLE record in TypeScript — every
// job, every visit, every capture's full text, one HTTP request per linked
// capture, the retraction fold re-applied here — and hand it to a model as one
// bundle. The operator ruled 2026-09-14 that a model is never given a customer's
// captures in bulk: it gets a TABLE OF CONTENTS and drills in. The rules
// (which captures belong, the fold, the tier gate, order, paging) now live once
// in the database (migration 20260916120000_retrieval_layer_core.sql); this file
// only calls them and applies the two folds that stay in TypeScript because
// their one definition is here: standing facts and correspondence citing a
// retracted capture (foldRetractedFacts / foldRetractedCorrespondence).
import { getClient } from './client.js';
import type { Customer } from './customers.js';
import { getTenant } from './tenants.js';
import { TERMINAL_JOB_STATUSES, foldRetractedCorrespondence, type Job } from './jobs.js';
import { listUpcomingVisitsForCustomer, participantIdsOf, participantsOf } from './visits.js';
import { foldRetractedFacts } from './standingFacts.js';
import { summarizeMoney, type MoneyEvent, type MoneySummary } from './moneyEvents.js';
import type { CaptureChannel } from './rawCaptures.js';
import { localDateISO, localTimeHHMM } from '../schedule/availability.js';
import { spineNowIso } from '../evalClock.js';

// ---- The two timestamp species, rendered into ONE shape ---------------------
//
// `lastCaptureAt` and `lastVisitAt` sit side by side on every job block and go
// out to a MODEL, and underneath they are DIFFERENT SPECIES:
//
//   last_capture_at = max(raw_captures.captured_at)  — a REAL UTC INSTANT
//   last_visit_at   = max(visits.completed_at)       — NAIVE-LOCAL (the firm's
//                                                      wall clock stamped as if
//                                                      UTC; the +00 is a lie)
//
// Served raw, as they were until 2026-09-19, one of them is ALWAYS wrong to a
// reader who treats them alike: slice the capture's digits and you report a UTC
// hour as the firm's, convert the visit's digits and a 2 PM job becomes 7 AM.
// Both renderings looked equally plausible because both strings carried '+00:00'.
//
// So both are rendered HERE into one firm-local wall-clock form,
// "2026-09-18 14:00" — the same shape booking.ts's wallClock() has served for
// every other model-facing visit time since the 2026-07-22 incident, where an
// agent read the offset off a visit and invented a "9 AM Pacific" conversion for
// a manager. The fix then was to withhold the offset rather than explain it;
// this is that fix, applied to the path it never reached.
const naiveWallClock = (ts: string | null): string | null =>
  ts ? `${ts.slice(0, 10)} ${ts.slice(11, 16)}` : null;

const instantWallClock = (ts: string | null, timezone: string): string | null =>
  ts ? `${localDateISO(ts, timezone)} ${localTimeHHMM(ts, timezone)}` : null;

// Full weekday name, matching resolve_date's phrase convention ("Monday
// 2026-08-03") — the label the agent is told to say verbatim. fit.ts's
// weekdayLabel is the short form used by schedule grids; a phrase spoken to a
// person gets the full word.
const weekdayFull = (dateISO: string): string =>
  new Date(`${dateISO}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

// Who is asking. The database's tier gate (capture_visible) is keyed on this:
// a manager and the planner see everything; a technician sees her LIMITED VIEW
// (plan 2: the customers she serves, what a grant opens, the firm's rule) and
// only when the reader passes her roster id; any other value sees NOTHING (fail
// closed). Derived by the hub from the verified identity — never from a tool
// argument.
export type CallerTier = 'technician' | 'manager' | 'planner';

// The trailing parameters every reader sends for the technician view. The id is
// spread only when present: the generated RPC params are optional, not nullable.
const viewerParams = (technicianId: string | null) => ({
  p_terminal_statuses: [...TERMINAL_JOB_STATUSES],
  ...(technicianId ? { p_viewer: technicianId } : {}),
});

// One upcoming stop, in the schedule's display conventions: date + HH:MM
// slices of the naive-local timestamps (never timezone-converted — the wire's
// '+00' is a lie, see get_team_schedule's startTime note). An UNTIMED visit
// (rung 9a) carries no date at all — every date field is null and the phrase
// says so.
export interface UpcomingVisit {
  visitId: string;
  jobId: string;
  jobTitle: string | null;
  technicianRef: string | null;
  technicianName: string | null;
  // EVERY name on the trip: the brief tells a customer who is coming, and
  // "Ben" for a two-person job is a wrong answer, not a short one.
  technicianRefs: string[];
  technicianNames: string[];
  unassigned: boolean;
  date: string | null; // YYYY-MM-DD — null = no time set yet
  startTime: string | null; // HH:MM wall clock
  endTime: string | null;
  untimed?: true;
  /**
   * Server-composed day label — "Tuesday 2026-08-18", or for a window
   * "between Monday 2026-08-24 and Friday 2026-08-28". The resolve_date
   * pattern: the agent SAYS this verbatim instead of composing its own
   * (2026-08-13 eval, S01: served the bare date 2026-08-18, the model wrote
   * "Tuesday, Aug 19" — right weekday, wrong date, exactly the class a
   * pre-composed phrase removes).
   */
  phrase: string;
}

// The opening of one capture: enough to answer "what did the last tech say"
// in one call, with the id that opens the full words (get_capture).
export interface CaptureSnippet {
  captureId: string;
  channel: CaptureChannel;
  capturedAt: string;
  technicianRef: string | null;
  snippet: string;
  truncated: boolean;
}

// A job on the contents page: the row (attributes folded) plus what the layer
// counted for it. `restrictedCount` is how many live captures sit outside the
// caller's view — said in numbers so a seat knows there is something to ask for.
export type JobContents = Job & {
  noteCount: number;
  restrictedCount: number;
  // Notes on this job retracted as recorded-in-error. Managers and the planner
  // only (0 for a technician): the count says there is an audit trail to open.
  retractedCount: number;
  /** Firm-local wall clock, "2026-09-18 14:00" — NOT an ISO instant (species note, top of file). */
  lastCaptureAt: string | null;
  newest: CaptureSnippet | null;
  /** Firm-local wall clock, "2026-09-18 14:00" — NOT an ISO instant (species note, top of file). */
  lastVisitAt: string | null;
  money: MoneySummary | null;
  /** May the caller be told this job's money FIGURES (see view_money_open)? */
  moneyAmounts: boolean;
};

export interface CustomerContents {
  customer: Customer;
  // Up to ten jobs: every LIVE job first (not paid, cancelled or declined),
  // then the newest finished ones — so work still open, unbooked or unpaid is
  // never pushed off the page by newer finished jobs.
  jobs: JobContents[];
  // The jobs the caller may open (for a technician, the ones in her view).
  jobsTotal: number;
  // How many of those are on file but not on the page.
  olderJobs: number;
  // Technicians: jobs of this customer outside her view (0 for everyone else).
  jobsOutsideView: number;
  // Captures filed on the customer with no job anywhere on the record (the
  // door knew WHO, not WHICH).
  customerLevel: { noteCount: number; restrictedCount: number; newest: CaptureSnippet | null };
  /**
   * Confirmed FUTURE work from the visits table — placed visits from today
   * forward plus untimed visits. Added 2026-08-13: this read previously saw
   * only past work, so "when is X's next visit?" answered "none" for customers
   * with four confirmed bookings.
   */
  upcomingVisits: UpcomingVisit[];
}

// A customer outside a technician's view: named, and nothing more. The id is
// what a request for access will carry (the request-flow task).
export interface OutsideView {
  inView: false;
  customer: { id: string; name: string };
}

export const isOutsideView = (c: CustomerContents | OutsideView): c is OutsideView =>
  'inView' in c && c.inView === false;

// ---- the jsonb the database returns, narrowed by hand (the readTenantCostDetail idiom) ----
interface RawSnippet {
  id: string;
  channel: CaptureChannel;
  captured_at: string;
  technician_ref: string | null;
  snippet: string | null;
  truncated: boolean;
}
interface RawJobBlock {
  job: Job;
  note_count: number;
  restricted_count: number;
  retracted_count: number;
  last_capture_at: string | null;
  newest: RawSnippet | null;
  last_visit_at: string | null;
  money_amounts: boolean;
  money_events: MoneyEvent[];
}
interface RawOutside {
  in_view: false;
  customer: { id: string; name: string };
}
interface RawContents {
  in_view: true;
  customer: Customer;
  jobs_total: number;
  older_jobs: number;
  jobs_outside_view: number;
  // Every in-view job id of this customer, for a technician; null = no filter.
  in_view_job_ids: string[] | null;
  jobs: RawJobBlock[];
  customer_level: { note_count: number; restricted_count: number; newest: RawSnippet | null };
  retracted_evidence_ids: string[];
}

const snippetOf = (raw: RawSnippet | null): CaptureSnippet | null =>
  raw
    ? {
        captureId: raw.id,
        channel: raw.channel,
        capturedAt: raw.captured_at,
        technicianRef: raw.technician_ref,
        snippet: raw.snippet ?? '',
        truncated: raw.truncated,
      }
    : null;

// The contents page. Three bounded round trips — the page itself, the firm's
// timezone, the upcoming visits — and nothing that grows with the history:
// the database counts the captures and returns one snippet per job.
export async function getCustomerContents(
  tenantId: string,
  customerId: string,
  tier: CallerTier,
  // The technician's roster id: without it a technician sees nothing (plan 2).
  technicianId: string | null = null,
): Promise<CustomerContents | OutsideView | null> {
  // The timezone is read HERE, not inside readUpcoming, because both readers
  // need it now: the upcoming split is firm-local, and so is the rendering of
  // `lastCaptureAt` (a real instant) into the firm's wall clock. Same three
  // round trips the header promises — one of them just moved up a level.
  const tz = (await getTenant(tenantId))?.timezone ?? 'UTC';
  const [raw, upcoming] = await Promise.all([
    readContents(tenantId, customerId, tier, technicianId),
    readUpcoming(tenantId, customerId, tz),
  ]);
  // Wrong tenant or unknown id: the database returned nothing, and the
  // upcoming read (tenant-filtered) is discarded with it.
  if (!raw) return null;
  // Outside a technician's view: the name, and nothing read with it.
  if (raw.in_view === false) return { inView: false, customer: raw.customer };
  // The schedule ahead stays inside the view too: a trip on a job she may not
  // open is not hers to see. null = no filter (managers, planner, whole firm).
  const inViewJobs = raw.in_view_job_ids ? new Set(raw.in_view_job_ids) : null;
  const upcomingVisits = inViewJobs ? upcoming.filter((u) => inViewJobs.has(u.jobId)) : upcoming;

  // The two folds that stay here: a standing fact or a correspondence entry
  // whose evidence was retracted disappears from the default view (the only
  // removal path). The ids come from the same query that built the page.
  const retracted = new Set(raw.retracted_evidence_ids);
  const customer: Customer = {
    ...raw.customer,
    attributes: foldRetractedFacts(raw.customer.attributes, retracted),
  };
  const jobs: JobContents[] = raw.jobs.map((block) => ({
    ...block.job,
    attributes: foldRetractedCorrespondence(
      foldRetractedFacts(block.job.attributes, retracted),
      retracted,
    ),
    noteCount: block.note_count,
    restrictedCount: block.restricted_count,
    retractedCount: block.retracted_count,
    // Both firm-local wall clock, "2026-09-18 14:00" — see the species note at
    // the top of this file. They arrive as different species and leave as one.
    lastCaptureAt: instantWallClock(block.last_capture_at, tz),
    newest: snippetOf(block.newest),
    lastVisitAt: naiveWallClock(block.last_visit_at),
    // Absence = "no money recorded here" (a zero summary on an untracked job
    // would read as "fully paid"). Every row counts — money never folds with a
    // retraction (operator 2026-09-15) — so this agrees with get_job.
    money: block.money_events.length > 0 ? summarizeMoney(block.money_events) : null,
    // `=== true`, not `!== false`: on a database that has plan 1's migration but
    // not plan 2's, the key is ABSENT — and absent must mean "no figures", the
    // way every other default in this layer does (review finding).
    moneyAmounts: block.money_amounts === true,
  }));

  return {
    customer,
    jobs,
    jobsTotal: raw.jobs_total,
    olderJobs: raw.older_jobs,
    jobsOutsideView: raw.jobs_outside_view,
    customerLevel: {
      noteCount: raw.customer_level.note_count,
      restrictedCount: raw.customer_level.restricted_count,
      newest: snippetOf(raw.customer_level.newest),
    },
    upcomingVisits,
  };
}

// ---- the drill-down reads: one page, one capture, one search ----------------

export type CaptureScope = 'job' | 'customer' | 'customer_level';

export interface PageCapture {
  captureId: string;
  channel: CaptureChannel;
  capturedAt: string;
  technicianRef: string | null;
  // How it is attached: the arms of capture_membership that reached it.
  via: string[];
  text: string;
  textTruncated: boolean;
  textChars: number;
  // Set on a retraction row (audit path only): what it retracts.
  retractsCaptureId: string | null;
  // Set on a retracted capture (audit path only): the retraction that hit it.
  retracted: { id: string; reason: string | null; by: string | null; at: string } | null;
}

export interface CapturesPage {
  scopeFound: boolean;
  // False when a technician's scope (the job or customer) is outside her view.
  inView: boolean;
  captures: PageCapture[];
  hasMore: boolean;
  // Both halves of the keyset cursor, or neither: the next page is
  // "(captured_at, id) before this row".
  next: { beforeAt: string; beforeId: string } | null;
  totalVisible: number;
  restrictedCount: number;
}

export interface CaptureFull {
  captureId: string;
  channel: CaptureChannel;
  capturedAt: string;
  technicianRef: string | null;
  rawText: string | null;
  retractsCaptureId: string | null;
  memberships: { customerId: string | null; jobId: string | null; visitId: string | null; via: string }[];
  retracted: { id: string; reason: string | null; by: string | null; at: string } | null;
}

export interface CaptureSearch {
  scopeFound: boolean;
  inView: boolean;
  query: string;
  matches: { captureId: string; channel: CaptureChannel; capturedAt: string; technicianRef: string | null; snippet: string }[];
  count: number;
  more: boolean;
  note?: string;
}

interface RawPageRow {
  id: string;
  channel: CaptureChannel;
  captured_at: string;
  technician_ref: string | null;
  via: string[];
  text: string | null;
  text_truncated: boolean;
  text_chars: number;
  retracts_capture_id: string | null;
  retracted: { id: string; reason: string | null; by: string | null; at: string } | null;
}
interface RawPage {
  scope_found: boolean;
  in_view: boolean;
  captures: RawPageRow[];
  has_more: boolean;
  next_before_at: string | null;
  next_before_id: string | null;
  total_visible: number;
  restricted_count: number;
}

// One page of a scope's captures, newest first. The cursor is a total order
// (captured_at, id), so a page boundary never repeats or skips a row; both
// halves travel together (the database ignores a lone id and treats a lone
// timestamp as a strict cut, so the wrapper refuses half a cursor).
export async function listCapturesPage(
  tenantId: string,
  scope: CaptureScope,
  scopeId: string,
  tier: CallerTier,
  opts: {
    beforeAt?: string;
    beforeId?: string;
    limit?: number;
    textChars?: number;
    includeRetracted?: boolean;
  } = {},
  technicianId: string | null = null,
): Promise<CapturesPage> {
  if ((opts.beforeAt === undefined) !== (opts.beforeId === undefined)) {
    throw new Error('listCapturesPage: a cursor is both beforeAt and beforeId, or neither');
  }
  const { data, error } = await getClient().rpc('captures_page', {
    p_tenant: tenantId,
    p_scope: scope,
    p_scope_id: scopeId,
    p_caller_tier: tier,
    ...(opts.beforeAt !== undefined ? { p_before_at: opts.beforeAt } : {}),
    ...(opts.beforeId !== undefined ? { p_before_id: opts.beforeId } : {}),
    ...(opts.limit !== undefined ? { p_limit: opts.limit } : {}),
    ...(opts.textChars !== undefined ? { p_text_chars: opts.textChars } : {}),
    ...(opts.includeRetracted ? { p_include_retracted: true } : {}),
    ...viewerParams(technicianId),
  });
  if (error) throw new Error(`captures_page failed: ${error.message}`);
  const raw = data as unknown as RawPage;
  return {
    scopeFound: raw.scope_found,
    // Absent key = a database without plan 2's migration: a technician sees
    // nothing there (fail closed), everyone else is unaffected.
    inView: raw.in_view ?? tier !== 'technician',
    captures: raw.captures.map((r) => ({
      captureId: r.id,
      channel: r.channel,
      capturedAt: r.captured_at,
      technicianRef: r.technician_ref,
      via: r.via,
      text: r.text ?? '',
      textTruncated: r.text_truncated,
      textChars: r.text_chars,
      retractsCaptureId: r.retracts_capture_id,
      retracted: r.retracted,
    })),
    hasMore: raw.has_more,
    next:
      raw.has_more && raw.next_before_at && raw.next_before_id
        ? { beforeAt: raw.next_before_at, beforeId: raw.next_before_id }
        : null,
    totalVisible: raw.total_visible,
    restrictedCount: raw.restricted_count,
  };
}

interface RawFull {
  id: string;
  channel: CaptureChannel;
  captured_at: string;
  technician_ref: string | null;
  raw_text: string | null;
  retracts_capture_id: string | null;
  memberships: { customer_id: string | null; job_id: string | null; visit_id: string | null; via: string }[];
  retracted: { id: string; reason: string | null; by: string | null; at: string } | null;
}

// One capture, full words. Null when it is not on this tenant, not visible to
// the tier, or retracted without the audit flag — one answer for all three,
// so a distinct error cannot confirm that an id exists.
export async function getCaptureFull(
  tenantId: string,
  captureId: string,
  tier: CallerTier,
  includeRetracted = false,
  technicianId: string | null = null,
): Promise<CaptureFull | null> {
  const { data, error } = await getClient().rpc('capture_full', {
    p_tenant: tenantId,
    p_capture: captureId,
    p_caller_tier: tier,
    p_include_retracted: includeRetracted,
    ...viewerParams(technicianId),
  });
  if (error) throw new Error(`capture_full failed: ${error.message}`);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data as unknown as RawFull;
  return {
    captureId: raw.id,
    channel: raw.channel,
    capturedAt: raw.captured_at,
    technicianRef: raw.technician_ref,
    rawText: raw.raw_text,
    retractsCaptureId: raw.retracts_capture_id,
    memberships: raw.memberships.map((m) => ({
      customerId: m.customer_id,
      jobId: m.job_id,
      visitId: m.visit_id,
      via: m.via,
    })),
    retracted: raw.retracted,
  };
}

interface RawSearch {
  scope_found: boolean;
  in_view: boolean;
  query: string;
  matches: { id: string; channel: CaptureChannel; captured_at: string; technician_ref: string | null; snippet: string }[];
  count: number;
  more: boolean;
  note?: string;
}

// Keyword search inside a scope: word forms (full-text) or a bare substring
// (codes, part numbers). Snippets, never whole notes; get_capture opens one.
export async function searchCaptures(
  tenantId: string,
  scope: 'job' | 'customer',
  scopeId: string,
  query: string,
  tier: CallerTier,
  opts: { limit?: number; snippetChars?: number } = {},
  technicianId: string | null = null,
): Promise<CaptureSearch> {
  const { data, error } = await getClient().rpc('search_captures', {
    p_tenant: tenantId,
    p_scope: scope,
    p_scope_id: scopeId,
    p_query: query,
    p_caller_tier: tier,
    ...(opts.limit !== undefined ? { p_limit: opts.limit } : {}),
    ...(opts.snippetChars !== undefined ? { p_snippet_chars: opts.snippetChars } : {}),
    ...viewerParams(technicianId),
  });
  if (error) throw new Error(`search_captures failed: ${error.message}`);
  const raw = data as unknown as RawSearch;
  return {
    scopeFound: raw.scope_found,
    inView: raw.in_view ?? tier !== 'technician',
    query: raw.query,
    matches: raw.matches.map((m) => ({
      captureId: m.id,
      channel: m.channel,
      capturedAt: m.captured_at,
      technicianRef: m.technician_ref,
      snippet: m.snippet,
    })),
    count: raw.count,
    more: raw.more,
    ...(raw.note ? { note: raw.note } : {}),
  };
}

async function readContents(
  tenantId: string,
  customerId: string,
  tier: CallerTier,
  technicianId: string | null,
): Promise<RawContents | RawOutside | null> {
  const { data, error } = await getClient().rpc('customer_contents', {
    p_tenant: tenantId,
    p_customer: customerId,
    p_caller_tier: tier,
    // The one definition of "finished work", derived from the job state machine.
    ...viewerParams(technicianId),
  });
  if (error) throw new Error(`customer_contents failed: ${error.message}`);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  return data as unknown as RawContents | RawOutside;
}

// Upcoming schedule, tenant-scoped by the verified tenant (the caller still
// rejects cross-tenant customers wholesale). "Today" is the firm's local date.
// Booked work stands regardless of note retractions — an assignment dies via
// its own status, never via retract_capture — so these rows never fold.
async function readUpcoming(
  tenantId: string,
  customerId: string,
  tz: string,
): Promise<UpcomingVisit[]> {
  // Real clock unless EVAL_FAKE_NOW anchors THIS tenant (date-eval only):
  // the upcoming/recent split must agree with the anchored resolve_date, or
  // an anchored run charges the model for the harness's own inconsistency.
  const todayLocal = localDateISO(spineNowIso(tenantId), tz);
  const rows = await listUpcomingVisitsForCustomer(tenantId, customerId, todayLocal);
  return (
    rows
      // Re-check the embed's tenant: "a job shares its customer's tenant" is
      // an unenforced invariant (id-only FK) — drop rows that violate it.
      .filter((r) => r.jobs?.tenant_id === tenantId)
      .map((r) => {
        const date = r.starts_at?.slice(0, 10) ?? null;
        const phrase = date ? `${weekdayFull(date)} ${date}` : 'no time set yet';
        const crew = participantsOf(r, tenantId);
        return {
          visitId: r.id,
          jobId: r.job_id,
          jobTitle: r.jobs?.title ?? null,
          technicianRef: crew[0]?.ref ?? null,
          technicianName: crew[0]?.displayName ?? null,
          technicianRefs: crew.map((p) => p.ref),
          technicianNames: crew.map((p) => p.displayName),
          unassigned: participantIdsOf(r, tenantId).length === 0, // counted, not named
          date,
          startTime: r.starts_at?.slice(11, 16) ?? null,
          endTime: r.ends_at?.slice(11, 16) ?? null,
          ...(r.starts_at === null ? { untimed: true as const } : {}),
          phrase,
        };
      })
  );
}
