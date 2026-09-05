import {
  factSourceIds,
  findRetractionsFor,
  foldRetractedFacts,
  getAssignmentWithRefsForTenant,
  getTenant,
  isInactiveState,
  listAssignmentsWithRefsForTenant,
  listTeam,
  listUnassignedAssignmentsWithRefs,
  listUnscheduledOpenJobsWithCustomer,
  isPlaced,
  unwrapAttributes,
  type Assignment,
  type Json,
} from '../db/index.js';
import { formatAddress } from '../routes/deepLink.js';
import { localDateISO } from './availability.js';
import { weekdayLabel } from './fit.js';
import { clampToTechnicianHorizon, horizonDaysFor } from './policy.js';

// The dispatch board's day view — originally a deliberate mirror of
// get_team_schedule's body (src/mcp/server.ts, post-Feature-A shape) for the
// browser surface. This module is the ONE place the board binds to the per-stop
// shape: if the MCP read changes shape, this is the file to re-check. Kept
// separate from server.ts on purpose (fork (b) in the plan): the board must not
// drag the whole MCP tool surface into its footprint.
//
// DELIBERATE DIVERGENCE from get_team_schedule (2026-07-22, latency work): the
// board does NOT return a scheduleVersion. The agent version-pins its reads to
// detect staleness; the board never did — it re-fetches after every write — so
// the extra latestScheduleVersion round-trip was pure cost on the button path.
// get_team_schedule keeps its own version stamp (it calls latestScheduleVersion
// directly, not through here), as does boardNotify.
//
// Feature A semantics carried over: technician_id is nullable — person-less
// rows render technicianRef/technicianName null and unassigned:true, and a
// technician self-view can never contain them (null never equals a viewer id).

export class InvalidRangeError extends Error {}

export interface BoardStop {
  assignmentId: string;
  technicianRef: string | null;
  technicianName: string | null;
  unassigned: boolean;
  customer: string | null;
  address: string | null;
  start: string;
  end: string;
  status: Assignment['status'];
  // Null when the assignment references another tenant's job — the id is
  // withheld like every other nested field (see the tenant re-check below).
  jobId: string | null;
}

export interface BoardDays {
  from: string;
  to: string;
  days: { date: string; stops: BoardStop[] }[];
  // Present when a technician-tier read was clamped at the visibility horizon
  // (Plan 4a): the payload explains the missing days itself. horizonEnd is
  // the STRUCTURED companion (the last visible day) — clients branch on data,
  // never by parsing the sentence (final-review finding: the client's
  // days-empty proxy conflated "fully beyond" with "trimmed but empty").
  horizonNote?: string;
  horizonEnd?: string;
}

export interface ReadBoardDaysInput {
  tenantId: string;
  from?: string; // YYYY-MM-DD; default = firm-local today (tenant timezone)
  to?: string; // YYYY-MM-DD; default = from
  // Set for the technician self-view: only that person's stops. null/omitted =
  // manager view (whole team, unassigned included).
  viewerTechnicianId?: string | null;
  // Technician-tier reads clamp at today + tenants.technician_horizon_days.
  // Keyed on TIER by the caller, never on the self-filter — the manager's
  // "Mine" tab uses viewerTechnicianId too and must keep far weeks.
  clampToHorizon?: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function readBoardDays(input: ReadBoardDaysInput): Promise<BoardDays> {
  const { tenantId } = input;
  let from = input.from;
  // The tenant row (timezone + horizon) costs an uncached round-trip — fetch
  // it only when actually needed: the from-default (once per board session)
  // or the clamp (technician tier). Managers passing `from` keep the
  // PR #70-era zero-extra-read button path.
  const tenant = !from || input.clampToHorizon ? await getTenant(tenantId) : null;
  if (!from) {
    const tz = tenant?.timezone ?? 'UTC';
    from = localDateISO(new Date().toISOString(), tz);
  }
  if (!DATE.test(from)) throw new InvalidRangeError('from must be YYYY-MM-DD');
  let toDay = input.to ?? from;
  if (!DATE.test(toDay) || from > toDay) {
    throw new InvalidRangeError('from/to must be YYYY-MM-DD with from <= to');
  }
  const spanDays =
    (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (!Number.isFinite(spanDays)) throw new InvalidRangeError('from/to is not a real calendar date');
  if (spanDays > 14) throw new InvalidRangeError('range is capped at 14 days');

  // Horizon clamp AFTER validation (a garbage range is still a 400, never a
  // quiet clamp). Trim + note, not an error: the payload explains itself.
  // The policy itself lives in ONE place (schedule/policy.ts).
  let horizonNote: string | undefined;
  let horizonEnd: string | undefined;
  if (input.clampToHorizon) {
    const tz = tenant?.timezone ?? 'UTC';
    const today = localDateISO(new Date().toISOString(), tz);
    const clamp = clampToTechnicianHorizon(today, from, toDay, horizonDaysFor(tenant));
    horizonEnd = clamp.horizonEnd;
    if (clamp.beyond) {
      return { from, to: toDay, days: [], horizonNote: clamp.horizonNote, horizonEnd };
    }
    toDay = clamp.to;
    horizonNote = clamp.horizonNote;
  }

  // ONE embedded read for the whole window (was: assignments + jobs-with-
  // customer + the full roster = three serial round-trips per board button).
  //
  // A second read used to bring the unplaced strip in (plan 4b-2), because a
  // stored range said which days an unplaced visit might land on. Rung 9a
  // deleted the range: an untimed visit belongs to no day, so the day view has
  // nothing to draw and the read is gone. Those visits live in the flat
  // unscheduled tray (readLooseBucket) instead.
  const rows = await listAssignmentsWithRefsForTenant(
    tenantId,
    `${from}T00:00:00.000Z`,
    new Date(Date.parse(`${toDay}T00:00:00.000Z`) + 86_400_000).toISOString(),
    ['confirmed'],
  );
  const visible =
    input.viewerTechnicianId != null
      ? rows.filter((r) => r.technician_id === input.viewerTechnicianId)
      : rows;
  const byDay = new Map<string, BoardStop[]>();
  for (const row of visible) {
    // Overlap semantics can pull in a row starting before `from` — clamp to
    // the requested days by start-day (the get_team_schedule precedent).
    const day = row.starts_at.slice(0, 10);
    if (day < from || day > toDay) continue;
    // SECURITY: the embed's foreign keys are ID-ONLY, so each nested row is
    // re-checked against the tenant before it is surfaced. This reproduces
    // exactly what the per-table reads gave for free: listJobsWithCustomerByIds
    // filtered jobs BY TENANT (a cross-tenant job was simply absent from the map
    // → customer null), and techById was built from listTeam(tenantId) (a
    // cross-tenant technician missed the map → ref/name null).
    const job = row.jobs && row.jobs.tenant_id === tenantId ? row.jobs : null;
    // The customer is re-checked on its OWN tenant, not merely inherited from
    // the job: it is a separate row with its own owner, and it holds the name
    // and address that reach the screen. (Hardening beyond the pre-embed
    // behavior — security review 2026-07-22.)
    const customer =
      job && job.customers && job.customers.tenant_id === tenantId ? job.customers : null;
    const technician =
      row.technicians && row.technicians.tenant_id === tenantId ? row.technicians : null;
    const bucket = byDay.get(day) ?? [];
    bucket.push({
      assignmentId: row.id,
      technicianRef: technician?.ref ?? null,
      technicianName: technician?.display_name ?? null,
      unassigned: row.technician_id === null,
      customer: customer?.name ?? null,
      address: customer
        ? formatAddress({
            address_line1: customer.address_line1,
            address_line2: customer.address_line2,
            city: customer.city,
            state: customer.state,
            postal_code: customer.postal_code,
          })
        : null,
      start: row.starts_at,
      end: row.ends_at,
      status: row.status,
      // Gated on the tenant-checked job, NOT the raw row.job_id: a stranded
      // cross-tenant assignment would otherwise disclose the other firm's job
      // UUID even while its customer/technician were correctly withheld.
      // (Pre-existing leak, closed here — security review 2026-07-22.)
      jobId: job ? row.job_id : null,
    });
    byDay.set(day, bucket);
  }
  // The per-day strip is GONE (rung 9a). An unplaced row used to be smeared
  // across every day of its stored range, because the range said which days it
  // might land on. With no range, an untimed visit belongs to NO day and
  // cannot honestly be drawn on one — it lives in the flat unscheduled tray
  // (`parkedVisits` below), which is the whole point of the remodel: the queue
  // is a queue, not a shadow booking on days nobody chose.
  const days = [...byDay.keys()]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((date) => ({ date, stops: byDay.get(date) ?? [] }));
  return {
    from,
    to: toDay,
    days,
    ...(horizonNote ? { horizonNote } : {}),
    ...(horizonEnd ? { horizonEnd } : {}),
  };
}

// ---- The loose bucket (Plan 4a): what the freeze will consume, made visible ----
//
// Two halves: parked visits (confirmed, nobody attached, from today onward —
// UNBOUNDED, because the point is catching visits parked beyond any board
// window) and unscheduled open jobs (no visit at all — until now surfaced
// NOWHERE). One shape for both consumers (board tray + agent parity): dates
// ship as date + server-computed weekday + HH:MM slices, never raw
// timestamptz (the naive-local convention makes the wire's '+00:00' a lie —
// PR #72's lesson).

export interface UnscheduledJob {
  jobId: string;
  title: string | null;
  customer: string | null;
  priority: string;
  // How long the work takes (plan 4b-1) — null = "length not set", shown, not
  // hidden: the tray is where the manager learns which work is placeable.
  durationMinutes: number | null;
  createdAt: string;
}

export interface LooseBucket {
  parkedVisits: {
    assignmentId: string;
    date: string | null;
    weekday: string | null;
    // Null on an UNTIMED visit — there is no time, and no date either.
    startTime: string | null;
    endTime: string | null;
    customer: string | null;
    jobTitle: string | null;
    // A PLACED visit whose day already slipped past with nobody attached —
    // the most forgettable row of all (final-review finding: it used to vanish
    // from the tray entirely, while its job stayed hidden by the
    // live-assignment anti-join — invisible on every surface at once).
    // Always false for an untimed visit: with no date, nothing can be late.
    overdue: boolean;
  }[];
  unscheduledJobs: UnscheduledJob[];
}

// THE unscheduled-jobs projection — the board tray AND get_team_schedule's
// recall view both call this, so the two surfaces agree by construction
// (final-review finding: parity was previously by duplication, tenant
// re-check included). The job row is already tenant-filtered by the query;
// only the embedded customer needs the re-check (ID-only foreign keys).
export async function readUnscheduledJobs(tenantId: string): Promise<UnscheduledJob[]> {
  return (await listUnscheduledOpenJobsWithCustomer(tenantId)).map((job) => ({
    jobId: job.id,
    title: job.title,
    customer: job.customers && job.customers.tenant_id === tenantId ? job.customers.name : null,
    priority: job.priority,
    durationMinutes: job.duration_minutes,
    createdAt: job.created_at,
  }));
}

export async function readLooseBucket(tenantId: string): Promise<LooseBucket> {
  // The jobs read is independent of the tenant read — start it first so the
  // three queries run at depth 2, not 3 (final-review efficiency finding).
  const jobsPromise = readUnscheduledJobs(tenantId);
  const tz = (await getTenant(tenantId))?.timezone ?? 'UTC';
  const today = localDateISO(new Date().toISOString(), tz);
  // Parked visits are read UNBOUNDED into the past: a parked visit whose day
  // slipped by is missed work, not history — it surfaces flagged `overdue`
  // instead of disappearing. (Terminal rows still drop via status; note the
  // recorded limitation that `proposed` unassigned rows are invisible to
  // BOTH halves — no production writer mints them today; Plan 3c/4b decides.)
  const [parked, unscheduledJobs] = await Promise.all([
    listUnassignedAssignmentsWithRefs(tenantId, '1970-01-01T00:00:00.000Z'),
    jobsPromise,
  ]);
  // Sorted by each visit's DAY after mapping, not by the SQL order: the query
  // orders on starts_at with NULLs last, which shoved every time-TBD row to
  // the bottom of the tray regardless of how soon its range is (final-review
  // finding: a range starting tomorrow rendered below a placed visit weeks
  // out). Stable sort keeps same-day relative order.
  const parkedVisits = parked.map((row) => {
      // ID-only foreign keys: re-check each nested row's tenant before its
      // name/title reaches a screen (withhold the field, keep the row —
      // the boardRead security pattern above).
      const job = row.jobs && row.jobs.tenant_id === tenantId ? row.jobs : null;
      const customer =
        job && job.customers && job.customers.tenant_id === tenantId ? job.customers : null;
      // UNTIMED rows (rung 9a) live in the tray too, and are its whole point:
      // every date field reads null, and nothing untimed can be overdue.
      const placedRow = isPlaced(row);
      const date = placedRow ? row.starts_at.slice(0, 10) : null;
      return {
        assignmentId: row.id,
        date,
        weekday: date ? weekdayLabel(date) : null,
        startTime: placedRow ? row.starts_at.slice(11, 16) : null,
        endTime: placedRow ? row.ends_at.slice(11, 16) : null,
        customer: customer?.name ?? null,
        jobTitle: job ? job.title : null,
        overdue: placedRow ? (date as string) < today : false,
        createdAt: row.created_at,
      };
    });
  // OLDEST FIRST (user choice 2026-09-05). Placed-but-overdue rows still sort
  // by their day; untimed rows have none, so age is the only order they can
  // justify — and it is the order that stops a hard-to-place visit sinking.
  parkedVisits.sort((a, b) => {
    if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    if (a.date) return -1; // dated rows first
    if (b.date) return 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
  return { parkedVisits, unscheduledJobs };
}

// The board picker's roster read (plan 4a.5): every name chat booking would
// accept — the filter mirrors resolveTechnician (!isInactiveState), so
// seat-exempt and invited rows appear; offboarded never. Manager-gated at the
// endpoint; fetched on picker open, never on the board-load path.
export interface BoardRosterEntry {
  ref: string;
  name: string;
}

export async function readRosterForBoard(tenantId: string): Promise<BoardRosterEntry[]> {
  return (await listTeam(tenantId))
    .filter((t) => !isInactiveState(t.state))
    .map((t) => ({ ref: t.ref, name: t.display_name }));
}

// The tap-into-a-visit detail view (contact + logistics; SINCE plan 4a.5 also
// the compressed customer notes — the recorded 2026-07-23 decision that
// consciously revisits "notes stay off the board": standing facts already
// reach technicians through the agent's customer reads, so the sheet shows
// the same folded facts to both tiers; CAPTURES remain off the board, so the
// capture sensitivity filter still has nothing to do here).
export interface VisitDetail {
  assignmentId: string;
  status: Assignment['status'];
  // Null on an UNTIMED visit (rung 9a) — nothing records when it should be.
  start: string | null;
  end: string | null;
  unassigned: boolean;
  technicianRef: string | null;
  technicianName: string | null;
  // Null when the assignment references another tenant's job — withheld like
  // every other nested field (the day-view jobId precedent). The sheet's
  // Purpose editor posts against this id (plan 4a.5).
  jobId: string | null;
  jobTitle: string | null;
  jobPriority: string | null;
  // The job's recorded length (plan 4b-1) — editable through the same job
  // form as title/priority; null = not set.
  jobDurationMinutes: number | null;
  // Compressed standing facts (plan 4a.5): retraction-folded, capped, values
  // truncated — BOTH tiers see them (facts already reach technicians through
  // the agent's customer reads; recorded decision 2026-07-23).
  customerNotes: { key: string; value: string }[];
  customer: {
    name: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
  } | null;
}

// The notes cap/truncation — server-composed so clients render verbatim.
const NOTES_CAP = 8;
const NOTE_VALUE_MAX = 80;

// Attributes → compressed notes: fold facts whose evidence was retracted
// (factSourceIds → findRetractionsFor → foldRetractedFacts — the capture-read
// pattern in src/mcp/server.ts), unwrap bundles to plain values, then cap and
// truncate. Non-bundle (seed/legacy) values pass through the same compression.
async function composeCustomerNotes(attrs: Json): Promise<{ key: string; value: string }[]> {
  const ids = factSourceIds(attrs);
  let folded = attrs;
  if (ids.length > 0) {
    const retracted = new Set(
      (await findRetractionsFor(ids))
        .map((r) => r.retracts_capture_id)
        .filter((id): id is string => !!id),
    );
    if (retracted.size > 0) folded = foldRetractedFacts(attrs, retracted);
  }
  return Object.entries(unwrapAttributes(folded))
    .slice(0, NOTES_CAP)
    .map(([key, value]) => {
      const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      return { key, value: s.length > NOTE_VALUE_MAX ? `${s.slice(0, NOTE_VALUE_MAX - 1)}…` : s };
    });
}

// One visit's detail, or null. viewerTechnicianId carries the SAME semantics
// as readBoardDays: set (technician) = only their own visits resolve — a
// crafted assignmentId for someone else's (or an unassigned) visit reads as
// null, indistinguishable from not-found, so the endpoint leaks nothing the
// day view wouldn't show. null/omitted = manager (any tenant visit).
export async function readVisitDetail(
  tenantId: string,
  assignmentId: string,
  viewerTechnicianId?: string | null,
): Promise<VisitDetail | null> {
  // ONE embedded read (was: assignment → job → customer → technician, four
  // serial round-trips, each waiting on the id from the one before).
  const row = await getAssignmentWithRefsForTenant(assignmentId, tenantId);
  if (!row) return null;
  if (viewerTechnicianId != null && row.technician_id !== viewerTechnicianId) return null;
  // SECURITY: the embed's foreign keys are ID-ONLY, so every nested row is
  // re-checked against the tenant before use — the same guards the id-only
  // getJob/getCustomer reads required, plus the tenant scoping that
  // getTechnicianById used to apply in the query.
  const job = row.jobs && row.jobs.tenant_id === tenantId ? row.jobs : null;
  const customer =
    job && job.customers && job.customers.tenant_id === tenantId ? job.customers : null;
  const technician =
    row.technicians && row.technicians.tenant_id === tenantId ? row.technicians : null;
  return {
    assignmentId: row.id,
    status: row.status,
    start: row.starts_at,
    end: row.ends_at,
    unassigned: row.technician_id === null,
    technicianRef: technician?.ref ?? null,
    technicianName: technician?.display_name ?? null,
    // job/customer/technician are already tenant-gated above — no re-test here.
    // jobId gated on the tenant-checked job, NOT raw row.job_id (the day-view
    // precedent: never disclose another firm's job UUID).
    jobId: job ? row.job_id : null,
    jobTitle: job ? job.title : null,
    jobPriority: job ? job.priority : null,
    jobDurationMinutes: job ? job.duration_minutes : null,
    customerNotes: customer ? await composeCustomerNotes(customer.attributes) : [],
    customer:
      customer
        ? {
            name: customer.name,
            phone: customer.phone,
            email: customer.email,
            address: formatAddress({
              address_line1: customer.address_line1,
              address_line2: customer.address_line2,
              city: customer.city,
              state: customer.state,
              postal_code: customer.postal_code,
            }),
          }
        : null,
  };
}
