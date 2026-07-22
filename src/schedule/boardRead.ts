import {
  getAssignmentWithRefsForTenant,
  getTenant,
  listAssignmentsWithRefsForTenant,
  type Assignment,
} from '../db/index.js';
import { formatAddress } from '../routes/deepLink.js';
import { localDateISO } from './availability.js';

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
  promiseLevel: Assignment['promise_level'];
  promisedDay: string | null;
  locked: boolean;
  status: Assignment['status'];
  // Null when the assignment references another tenant's job — the id is
  // withheld like every other nested field (see the tenant re-check below).
  jobId: string | null;
}

export interface BoardDays {
  from: string;
  to: string;
  days: { date: string; stops: BoardStop[] }[];
}

export interface ReadBoardDaysInput {
  tenantId: string;
  from?: string; // YYYY-MM-DD; default = firm-local today (tenant timezone)
  to?: string; // YYYY-MM-DD; default = from
  // Set for the technician self-view: only that person's stops. null/omitted =
  // manager view (whole team, unassigned included).
  viewerTechnicianId?: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function readBoardDays(input: ReadBoardDaysInput): Promise<BoardDays> {
  const { tenantId } = input;
  let from = input.from;
  if (!from) {
    const tz = (await getTenant(tenantId))?.timezone ?? 'UTC';
    from = localDateISO(new Date().toISOString(), tz);
  }
  if (!DATE.test(from)) throw new InvalidRangeError('from must be YYYY-MM-DD');
  const toDay = input.to ?? from;
  if (!DATE.test(toDay) || from > toDay) {
    throw new InvalidRangeError('from/to must be YYYY-MM-DD with from <= to');
  }
  const spanDays =
    (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (!Number.isFinite(spanDays)) throw new InvalidRangeError('from/to is not a real calendar date');
  if (spanDays > 14) throw new InvalidRangeError('range is capped at 14 days');

  // ONE embedded read for the whole window (was: assignments + jobs-with-
  // customer + the full roster = three serial round-trips per board button).
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
      promiseLevel: row.promise_level,
      promisedDay: row.promised_day,
      locked: row.locked,
      status: row.status,
      // Gated on the tenant-checked job, NOT the raw row.job_id: a stranded
      // cross-tenant assignment would otherwise disclose the other firm's job
      // UUID even while its customer/technician were correctly withheld.
      // (Pre-existing leak, closed here — security review 2026-07-22.)
      jobId: job ? row.job_id : null,
    });
    byDay.set(day, bucket);
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, stops]) => ({ date, stops }));
  return { from, to: toDay, days };
}

// The tap-into-a-visit detail view (contact + logistics only — user decision
// 2026-07-19: notes/briefings stay OFF the board, so nothing here needs the
// capture sensitivity filter and both tiers may see every field).
export interface VisitDetail {
  assignmentId: string;
  status: Assignment['status'];
  start: string;
  end: string;
  promiseLevel: Assignment['promise_level'];
  promisedDay: string | null;
  locked: boolean;
  unassigned: boolean;
  technicianRef: string | null;
  technicianName: string | null;
  jobTitle: string | null;
  customer: {
    name: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
  } | null;
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
    promiseLevel: row.promise_level,
    promisedDay: row.promised_day,
    locked: row.locked,
    unassigned: row.technician_id === null,
    technicianRef: technician?.ref ?? null,
    technicianName: technician?.display_name ?? null,
    // job/customer/technician are already tenant-gated above — no re-test here.
    jobTitle: job ? job.title : null,
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
