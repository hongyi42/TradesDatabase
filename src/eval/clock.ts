// Date arithmetic for the spine eval — a DELIBERATE second implementation.
//
// src/schedule/dateResolve.ts is code UNDER TEST here. Importing it would make
// the eval's expectations agree with the machinery exactly when the machinery is
// wrong, which is the one case that matters. Same rule date-eval's corpus.mjs
// follows, for the same reason: an oracle that shares code with its subject is
// not an oracle.
//
// Everything is plain UTC-midnight arithmetic over YYYY-MM-DD strings. No
// timezone maths beyond firmToday(), which is the single place a real clock is
// read — so every other function is a pure, testable mapping.

export type Weekday =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday';

export const WEEKDAYS: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isRealDateISO(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function assertDate(iso: string): void {
  if (!isRealDateISO(iso)) throw new Error(`not a real YYYY-MM-DD date: '${iso}'`);
}

/**
 * Today in the firm's timezone, as YYYY-MM-DD. The ONLY clock read in this
 * module — pass `at` to make a caller deterministic.
 *
 * en-CA formats as YYYY-MM-DD, which is why it is used rather than assembling
 * parts by hand (the same trick scripts/seed.mjs uses).
 */
export function firmToday(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function addDays(iso: string, n: number): string {
  assertDate(iso);
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayIndexOf(iso: string): number {
  assertDate(iso);
  return new Date(`${iso}T00:00:00.000Z`).getUTCDay();
}

export function weekdayOf(iso: string): Weekday {
  return WEEKDAYS[weekdayIndexOf(iso)];
}

/** "Wednesday" — for phrases read back to a person. */
export function titleWeekday(iso: string): string {
  const w = weekdayOf(iso);
  return w[0].toUpperCase() + w.slice(1);
}

export function isWeekend(iso: string): boolean {
  const d = weekdayIndexOf(iso);
  return d === 0 || d === 6;
}

/** Whole days from `a` to `b` (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  assertDate(a);
  assertDate(b);
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000);
}

/**
 * The coming occurrence of `weekday`, counting today as that occurrence when
 * today already is that weekday — the convention dateResolve pins for
 * weeksAhead 0, restated here independently.
 */
export function comingWeekday(iso: string, weekday: Weekday): string {
  const target = WEEKDAYS.indexOf(weekday);
  if (target < 0) throw new Error(`not a weekday name: '${weekday}'`);
  return addDays(iso, (target - weekdayIndexOf(iso) + 7) % 7);
}

/** The coming occurrence, then `weeksAhead` further weeks (1 = "next <day>"). */
export function nthWeekday(iso: string, weekday: Weekday, weeksAhead = 0): string {
  return addDays(comingWeekday(iso, weekday), 7 * weeksAhead);
}

/** Monday of the calendar week containing `iso` (Mon–Sun weeks). */
export function mondayOf(iso: string): string {
  const dow = weekdayIndexOf(iso);
  return addDays(iso, -((dow + 6) % 7));
}

/** The Mon–Sun range `weeksAhead` weeks from the one containing `iso`. */
export function weekRange(iso: string, weeksAhead = 0): { start: string; end: string } {
  const start = addDays(mondayOf(iso), 7 * weeksAhead);
  return { start, end: addDays(start, 6) };
}

/** Every date from `from` to `to` inclusive. */
export function eachDay(from: string, to: string): string[] {
  const n = daysBetween(from, to);
  if (n < 0) return [];
  return Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

/**
 * Step `n` working days (Mon–Fri) forward from `iso`, never landing on a
 * weekend. n = 0 returns `iso` itself when it is a workday, else the next one —
 * so the world generator can't book a technician on a day its own availability
 * pattern marks unschedulable (the self-contradiction seed.mjs guards against).
 */
export function nextWorkday(iso: string, n = 0): string {
  let d = iso;
  while (isWeekend(d)) d = addDays(d, 1);
  for (let i = 0; i < n; i++) {
    do {
      d = addDays(d, 1);
    } while (isWeekend(d));
  }
  return d;
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export interface Range {
  start: string;
  end: string;
  label: string;
}

/**
 * The calendar month `offset` months from the one containing `iso`.
 *
 * Deliberately computed by Date arithmetic where dateResolve uses integer
 * (year*12 + month) math — two different techniques, so a bug in either shows up
 * as a disagreement rather than as matching wrong answers. setUTCMonth is
 * normally a footgun (Jan 31 + 1 month = Mar 3), but it is safe here because it
 * only ever moves from the FIRST of a month.
 */
export function monthRange(iso: string, offset = 0): Range {
  assertDate(iso);
  const [y, m] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  first.setUTCMonth(first.getUTCMonth() + offset);
  const next = new Date(first.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1);
  const start = first.toISOString().slice(0, 10);
  return {
    start,
    end: addDays(next.toISOString().slice(0, 10), -1),
    label: `${MONTH_NAMES[first.getUTCMonth()]} ${first.getUTCFullYear()}`,
  };
}

/** The calendar quarter `offset` quarters from the one containing `iso`. */
export function quarterRange(iso: string, offset = 0): Range {
  assertDate(iso);
  const [y, m] = iso.split('-').map(Number);
  const firstMonthOfThisQuarter = Math.floor((m - 1) / 3) * 3; // 0, 3, 6, 9
  const first = new Date(Date.UTC(y, firstMonthOfThisQuarter, 1));
  first.setUTCMonth(first.getUTCMonth() + offset * 3);
  const next = new Date(first.getTime());
  next.setUTCMonth(next.getUTCMonth() + 3);
  return {
    start: first.toISOString().slice(0, 10),
    end: addDays(next.toISOString().slice(0, 10), -1),
    label: `Q${Math.floor(first.getUTCMonth() / 3) + 1} ${first.getUTCFullYear()}`,
  };
}

/** The calendar year `offset` years from the one containing `iso`. */
export function yearRange(iso: string, offset = 0): Range {
  assertDate(iso);
  const y = Number(iso.slice(0, 4)) + offset;
  return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
}

/**
 * Step `n` working days BACKWARD, never landing on a weekend. The mirror of
 * nextWorkday, and load-bearing for any "the last workday at or before X" edge:
 * stepping forward off a weekend can overshoot a boundary the row is meant to
 * sit inside.
 */
export function prevWorkday(iso: string, n = 0): string {
  let d = iso;
  while (isWeekend(d)) d = addDays(d, -1);
  for (let i = 0; i < n; i++) {
    do {
      d = addDays(d, -1);
    } while (isWeekend(d));
  }
  return d;
}

/**
 * Naive-local timestamp: the wall clock written as-if-UTC.
 *
 * Mirrors src/schedule/booking.ts naiveLocalISO deliberately rather than
 * importing it, for the reason at the top of this file — but the CONVENTION is
 * not ours to choose: every reader slices HH:MM straight out of the stored
 * string (booking.ts:677, :1332), so a world written any other way would render
 * as the wrong time everywhere.
 */
export function naiveLocal(date: string, hhmm: string): string {
  assertDate(date);
  if (!/^\d{2}:\d{2}$/.test(hhmm)) throw new Error(`not an HH:MM time: '${hhmm}'`);
  return `${date}T${hhmm}:00.000Z`;
}

/** Add minutes to an HH:MM wall clock. Throws rather than wrap past midnight. */
export function addMinutes(hhmm: string, minutes: number): string {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) throw new Error(`not an HH:MM time: '${hhmm}'`);
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  if (total < 0 || total >= 24 * 60) {
    throw new Error(`${hhmm} + ${minutes}min leaves the day (${total} minutes)`);
  }
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Deterministic PRNG (mulberry32). The world is reproducible from
 * (anchor, seed), so a failing scenario can be regenerated exactly — which is
 * the difference between a bug report and a ghost story.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick one item deterministically. */
export function pick<T>(rand: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick from an empty list');
  return items[Math.floor(rand() * items.length) % items.length];
}
