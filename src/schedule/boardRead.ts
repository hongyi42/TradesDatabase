import {
  getAssignmentForTenant,
  getCustomer,
  getJob,
  getTechnicianById,
  getTenant,
  latestScheduleVersion,
  listAssignmentsForTenant,
  listJobsWithCustomerByIds,
  listTeam,
  type Assignment,
} from '../db/index.js';
import { formatAddress } from '../routes/deepLink.js';
import { localDateISO } from './availability.js';

// The dispatch board's day view — a deliberate mirror of get_team_schedule's
// body (src/mcp/server.ts, post-Feature-A shape) for the browser surface. This
// module is the ONE place the board binds to the per-stop shape: if the MCP
// read changes shape, this is the file to re-check. Kept separate from
// server.ts on purpose (fork (b) in the plan): the board must not drag the
// whole MCP tool surface into its footprint.
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
  jobId: string;
}

export interface BoardDays {
  scheduleVersion: number;
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

  // Version BEFORE the snapshot — same fail-safe ordering as get_team_schedule:
  // a booking landing between the two reads makes a later "changed since N?"
  // check fire (false positive) instead of vouching for a stale snapshot.
  const scheduleVersion = await latestScheduleVersion(tenantId);
  const rows = await listAssignmentsForTenant(
    tenantId,
    `${from}T00:00:00.000Z`,
    new Date(Date.parse(`${toDay}T00:00:00.000Z`) + 86_400_000).toISOString(),
    ['confirmed'],
  );
  const visible =
    input.viewerTechnicianId != null
      ? rows.filter((r) => r.technician_id === input.viewerTechnicianId)
      : rows;
  const jobs = await listJobsWithCustomerByIds(tenantId, [
    ...new Set(visible.map((r) => r.job_id)),
  ]);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const techById = new Map((await listTeam(tenantId)).map((t) => [t.id, t]));
  const byDay = new Map<string, BoardStop[]>();
  for (const row of visible) {
    // Overlap semantics can pull in a row starting before `from` — clamp to
    // the requested days by start-day (the get_team_schedule precedent).
    const day = row.starts_at.slice(0, 10);
    if (day < from || day > toDay) continue;
    const customer = jobById.get(row.job_id)?.customers ?? null;
    const technician = row.technician_id ? techById.get(row.technician_id) : undefined;
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
      jobId: row.job_id,
    });
    byDay.set(day, bucket);
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, stops]) => ({ date, stops }));
  return { scheduleVersion, from, to: toDay, days };
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
  const row = await getAssignmentForTenant(assignmentId, tenantId);
  if (!row) return null;
  if (viewerTechnicianId != null && row.technician_id !== viewerTechnicianId) return null;
  // Same tenant guards as booking.ts's preview path: getJob/getCustomer are
  // id-only reads, so cross-tenant rows must be re-checked before use.
  const job = await getJob(row.job_id);
  const customer =
    job && job.tenant_id === tenantId ? await getCustomer(job.customer_id) : null;
  const technician = row.technician_id
    ? await getTechnicianById(row.technician_id, tenantId)
    : null;
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
    jobTitle: job && job.tenant_id === tenantId ? job.title : null,
    customer:
      customer && customer.tenant_id === tenantId
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
