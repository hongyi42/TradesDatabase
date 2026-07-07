// Day-stops reader — "which stops does this technician have, per day, in this
// date range?" behind the ROUTE_DAY_SOURCE flag.
//
// Two sources, one shape:
//   schedule_entries (DEFAULT) — the Google-Sheet mirror; the pilot's real
//     schedule today. Retires with Plan 5.
//   assignments — the DB-owned booking table (Plan 1); flip the flag when
//     Plan 3 / booking tools start filling it. Confirmed bookings only.
//
// This module only composes typed src/db/ queries (CLAUDE.md: no hand-written
// Supabase access outside the db layer). Grouping is by UTC calendar day —
// the mirror's documented v1 simplification, kept identical in both modes so
// a flag flip never re-buckets anyone's day.

import { formatAddress, type RouteStop } from './deepLink.js';
import { listScheduleForTechnicianInRange } from '../db/scheduleEntries.js';
import { getTechnician } from '../db/technicians.js';
import { listAssignmentsForTechnician } from '../db/assignments.js';
import { listJobsWithCustomerByIds } from '../db/jobs.js';

export interface DayStops {
  date: string; // YYYY-MM-DD (UTC day)
  stops: RouteStop[]; // in scheduled order (not yet drive-optimized)
}

type Source = 'schedule_entries' | 'assignments';

function activeSource(): Source {
  return process.env.ROUTE_DAY_SOURCE === 'assignments' ? 'assignments' : 'schedule_entries';
}

// Group (startISO, stop) pairs into sorted DayStops, stops sorted by time.
function groupByUtcDay(rows: { startISO: string; stop: RouteStop }[]): DayStops[] {
  const byDay = new Map<string, { startISO: string; stop: RouteStop }[]>();
  for (const row of rows) {
    const day = row.startISO.slice(0, 10);
    const bucket = byDay.get(day) ?? [];
    bucket.push(row);
    byDay.set(day, bucket);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, bucket]) => ({
      date,
      stops: bucket
        .sort((a, b) => (a.startISO < b.startISO ? -1 : a.startISO > b.startISO ? 1 : 0))
        .map((r) => r.stop),
    }));
}

export async function listDayStops(
  tenantId: string,
  technicianRef: string,
  fromDate: string,
  toDate: string,
): Promise<DayStops[]> {
  if (activeSource() === 'schedule_entries') {
    const entries = await listScheduleForTechnicianInRange(
      tenantId,
      technicianRef,
      fromDate,
      toDate,
    );
    return groupByUtcDay(
      entries
        .filter((e): e is typeof e & { scheduled_start: string } => e.scheduled_start !== null)
        .map((e) => ({
          startISO: e.scheduled_start,
          stop: {
            label: e.customer_name ?? 'Customer',
            address: formatAddress({
              address_line1: e.address_line1,
              city: e.city,
              state: e.state,
              postal_code: e.postal_code,
            }),
            scheduledStart: e.scheduled_start,
          },
        })),
    );
  }

  // assignments mode. A valid badge may have no roster row (plain-technician
  // surface, server.ts semantics) — that's an empty schedule, never a crash.
  const tech = await getTechnician(tenantId, technicianRef);
  if (!tech) return [];
  const assignments = await listAssignmentsForTechnician(
    tech.id,
    `${fromDate.slice(0, 10)}T00:00:00.000Z`,
    `${toDate.slice(0, 10)}T23:59:59.999Z`,
    ['confirmed'],
  );
  const jobs = await listJobsWithCustomerByIds(tenantId, [
    ...new Set(assignments.map((a) => a.job_id)),
  ]);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  // listAssignmentsForTechnician uses OVERLAP semantics, so an overnight
  // booking that merely ends inside the range would bucket onto a day before
  // fromDate — clamp to the requested days so both modes agree at the edges.
  const from = fromDate.slice(0, 10);
  const to = toDate.slice(0, 10);
  return groupByUtcDay(
    assignments
      .filter((a) => {
        const day = a.starts_at.slice(0, 10);
        return day >= from && day <= to;
      })
      .map((a) => {
        const customer = jobById.get(a.job_id)?.customers ?? null;
        return {
          startISO: a.starts_at,
          stop: {
            label: customer?.name ?? 'Customer',
            address: customer
              ? formatAddress({
                  address_line1: customer.address_line1,
                  address_line2: customer.address_line2,
                  city: customer.city,
                  state: customer.state,
                  postal_code: customer.postal_code,
                })
              : null,
            scheduledStart: a.starts_at,
          },
        };
      }),
  );
}
