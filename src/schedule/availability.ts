// Pure availability interpretation — no DB, no model (overview §5: hardcode
// what must be correct). Given a technician's stored weekly pattern, their
// time-off ranges, and the firm's IANA timezone, answer: are they available on
// the local calendar day this timestamp falls on? Day-level only — window-level
// fit within a day is Plan 3.
import type { DayKey, WeeklyPattern } from '../db/technicians.js';

// 'short' weekday in the target zone → 'mon'..'sun'. Intl owns the tz/DST math;
// no offset arithmetic here (hand-rolled offsets are exactly what broke the
// schedule_entries UTC-day read this module supersedes for new code).
export function localDayOfWeek(isoTimestamp: string, timezone: string): DayKey {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(new Date(isoTimestamp));
  return weekday.toLowerCase().slice(0, 3) as DayKey;
}

// The local calendar date (YYYY-MM-DD) the timestamp falls on in the zone —
// what a date-ranged time-off row must be compared against. en-CA formats as
// ISO YYYY-MM-DD.
export function localDateISO(isoTimestamp: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(isoTimestamp));
}

// The local wall-clock HH:MM in the zone — the fit engine's day-0 "now" clamp
// input. hourCycle 'h23' pins midnight to '00:00' (h24 renders '24:00', which
// the schedule's HH:MM validation rejects).
export function localTimeHHMM(isoTimestamp: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(isoTimestamp));
}

export interface TimeOffRange {
  starts_on: string; // YYYY-MM-DD, inclusive
  ends_on: string; // YYYY-MM-DD, inclusive
}

// null pattern = availability never configured → NOT schedulable (fail closed:
// the manager must set working days before the scheduler may book the person).
export function isTechnicianAvailableOn(
  isoTimestamp: string,
  pattern: WeeklyPattern | null,
  timeOff: TimeOffRange[],
  timezone: string,
): boolean {
  if (!pattern) return false;
  const localDate = localDateISO(isoTimestamp, timezone);
  // Zero-padded ISO dates compare correctly as strings.
  if (timeOff.some((r) => r.starts_on <= localDate && localDate <= r.ends_on)) return false;
  // The column is plain jsonb — a row written outside setTechnicianAvailability
  // (dashboard edit, partial object) must degrade to "unschedulable", never
  // crash the scheduling pass. Fail closed on any non-array day value.
  const windows = pattern[localDayOfWeek(isoTimestamp, timezone)];
  return Array.isArray(windows) && windows.length > 0;
}
