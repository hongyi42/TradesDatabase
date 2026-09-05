// Day-stops reader — "which stops does this technician have, per day, in this
// date range?" — reading the DB-owned booking table (`visits`, confirmed
// rows only). The schedule_entries sheet-mirror source (and its ROUTE_DAY_SOURCE
// flag) retired with the Telegram-schedule series Plan 1: the sheet is no
// longer an input.
//
// This module only composes typed src/db/ queries (CLAUDE.md: no hand-written
// Supabase access outside the db layer). Grouping is by UTC calendar day —
// correct under the naive-local time convention (wall-clock stored as if UTC;
// see the promise-ladder migration).

import { formatAddress, type RouteStop } from './deepLink.js';
import { getTechnician } from '../db/technicians.js';
import { listVisitsForTechnician } from '../db/visits.js';
import { listJobsWithCustomerByIds } from '../db/jobs.js';

export interface DayStops {
  date: string; // YYYY-MM-DD (UTC day)
  stops: RouteStop[]; // in booked (time) order — callers render this, never reorder it
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
  // A valid badge may have no roster row (plain-technician surface, server.ts
  // semantics) — that's an empty schedule, never a crash.
  const tech = await getTechnician(tenantId, technicianRef);
  if (!tech) return [];
  const visits = await listVisitsForTechnician(
    tech.id,
    `${fromDate.slice(0, 10)}T00:00:00.000Z`,
    `${toDate.slice(0, 10)}T23:59:59.999Z`,
    ['confirmed'],
  );
  const jobs = await listJobsWithCustomerByIds(tenantId, [
    ...new Set(visits.map((a) => a.job_id)),
  ]);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  // listVisitsForTechnician uses OVERLAP semantics, so an overnight
  // booking that merely ends inside the range would bucket onto a day before
  // fromDate — clamp to the requested days.
  const from = fromDate.slice(0, 10);
  const to = toDate.slice(0, 10);
  return groupByUtcDay(
    visits
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
