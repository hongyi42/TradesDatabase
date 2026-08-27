// Pure availability interpretation — no DB, no model (overview §5: hardcode
// what must be correct). Given a technician's stored weekly pattern, their
// time-off ranges, and the firm's IANA timezone, answer: are they available on
// the local calendar day this timestamp falls on? Day-level only — window-level
// fit within a day is Plan 3.
import { WEEK_DAYS, type DayKey, type WeeklyPattern } from '../db/technicians.js';

// Every timestamp this codebase formats or compares carries a UTC offset, and
// that is load-bearing rather than incidental. Two shapes flow through here:
// real instants read from the database (`…Z` / `…+00:00`), and the firm's wall
// clock written by booking.ts's naiveLocalISO — which appends `.000Z` for
// exactly this reason, so a wall-clock string stays an ABSOLUTE string.
//
// Per ECMA-262 a date-time string WITHOUT an offset is parsed on the host's
// clock, so the same characters mean a different instant on a Tokyo laptop
// than on a UTC server — `2026-08-24T07:00:00` renders as Sunday there and
// Monday here. Nothing in the repo produces that shape today, but nothing
// stops a caller from hand-building one either, and the labels these helpers
// produce are the ONLY date vocabulary the planner is allowed to quote — a
// shifted label is laundered into a confident sentence to a technician, and
// no rail downstream can catch it (the rail checks that the model copied the
// string, never that the string was right).
//
// So the rule is explicit here instead of conventional: an offset-less
// date-time is read as UTC, never as host-local. Anything else — already
// offset-stamped, date-only (UTC per spec), or unparseable — is handed to
// Date.parse untouched, NaN and all.
const UTC_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const BARE_DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

export function parseAsUtc(stamp: string): number {
  const bare = UTC_OFFSET_RE.test(stamp) ? null : BARE_DATE_TIME_RE.exec(stamp);
  return Date.parse(bare ? `${bare[1]}T${bare[2]}Z` : stamp);
}

// 'short' weekday in the target zone → 'mon'..'sun'. Intl owns the tz/DST math;
// no offset arithmetic here (hand-rolled offsets are exactly what broke the
// schedule_entries UTC-day read this module supersedes for new code).
export function localDayOfWeek(isoTimestamp: string, timezone: string): DayKey {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(new Date(parseAsUtc(isoTimestamp)));
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
  }).format(new Date(parseAsUtc(isoTimestamp)));
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
  }).format(new Date(parseAsUtc(isoTimestamp)));
}

export interface TimeOffRange {
  starts_on: string; // YYYY-MM-DD, inclusive
  ends_on: string; // YYYY-MM-DD, inclusive
}

// Render a stored pattern as ONE line a person can read: "Mon–Fri 08:00–17:00;
// Sat, Sun off". Rendered firm-side on purpose — the agent relays a line it is
// given, but paraphrases a seven-key JSON object, and a paraphrased working
// week is wrong in a way nobody notices (the resolve_date lesson: instructions
// fused into the result beat instructions in a description).
//
// Fail-closed on malformed jsonb exactly like isTechnicianAvailableOn: the
// column is plain jsonb and a row written outside setTechnicianAvailability
// must degrade to "off that day", never throw. A summary is a read on a manager
// UI path; crashing it would take out the whole roster answer for one bad row.
const DAY_LABEL: Record<DayKey, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

// A day's windows collapsed to a comparable string; '' means not working.
// Invalid windows are dropped rather than rendered, so junk reads as time off
// instead of as a shift nobody can work.
function dayWindowsText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const win of value) {
    if (!Array.isArray(win) || win.length !== 2) continue;
    const [start, end] = win as unknown[];
    if (typeof start !== 'string' || typeof end !== 'string') continue;
    parts.push(`${start}–${end}`);
  }
  return parts.join(', ');
}

export function summarizeWeeklyPattern(pattern: WeeklyPattern | null): string | null {
  if (!pattern) return null;
  const texts = WEEK_DAYS.map((d) => dayWindowsText(pattern[d]));
  if (texts.every((t) => t === '')) return 'Not working any day';

  // Group CONSECUTIVE days sharing identical windows, in Mon..Sun order, so a
  // standard week reads "Mon–Fri 08:00–17:00" rather than five separate clauses.
  const runs: { from: number; to: number; text: string }[] = [];
  for (let i = 0; i < WEEK_DAYS.length; i += 1) {
    const prev = runs[runs.length - 1];
    if (prev && prev.text === texts[i] && prev.to === i - 1) prev.to = i;
    else runs.push({ from: i, to: i, text: texts[i] });
  }

  const label = (r: { from: number; to: number }) => {
    const from = DAY_LABEL[WEEK_DAYS[r.from]];
    const to = DAY_LABEL[WEEK_DAYS[r.to]];
    const span = r.to - r.from + 1;
    if (span === 1) return from;
    // An en dash only reads as a range over 3+ days; two days list better.
    if (span === 2) return `${from}, ${to}`;
    return `${from}–${to}`;
  };

  const working = runs.filter((r) => r.text !== '').map((r) => `${label(r)} ${r.text}`);
  // Off days collapse into ONE trailing clause however they fall in the week —
  // "Mon–Fri 08:00–17:00; Sat, Sun off" beats interleaving them.
  const offLabels = WEEK_DAYS.filter((_, i) => texts[i] === '').map((d) => DAY_LABEL[d]);
  const off = offLabels.length > 0 ? `${offLabels.join(', ')} off` : '';
  return [working.join('; '), off].filter(Boolean).join('; ');
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
