// The deterministic date matrix — every calendar trap, on demand.
//
// resolveDate takes `todayLocal` as a PARAMETER (dateResolve.ts:122), which is
// the whole reason this exists: the clock is an input, so every weekday, month
// end, year rollover and leap day can be exercised in milliseconds, for free, on
// any day of the week. The agent-layer tier cannot do this — it runs on the real
// clock and can only ever test the traps that today happens to expose.
//
// Expectations come from ./clock.ts, a second implementation. Never import
// dateResolve here: it is the subject, and a shared helper would agree with it
// exactly when it is wrong.

import {
  addDays,
  comingWeekday,
  isWeekend,
  monthRange,
  nthWeekday,
  quarterRange,
  titleWeekday,
  weekRange,
  weekdayOf,
  yearRange,
  type Weekday,
} from './clock.js';

/** Mirrors dateResolve's bounds, restated so an out-of-range case is expressible. */
const BOUNDS = { weeks: 52, dayShift: 366, months: 24, quarters: 8, years: 5 };

export type Expectation =
  | { kind: 'day'; date: string; weekday: Weekday }
  | { kind: 'week'; start: string; end: string; ambiguous: boolean; altStart?: string }
  | { kind: 'period'; start: string; end: string; label: string }
  | { kind: 'unresolvable' };

export interface DateCase {
  id: string;
  /** Which resolver mode this exercises — the report groups by this. */
  group: 'dayShift' | 'weekday' | 'week' | 'month' | 'quarter' | 'year' | 'explicit' | 'invalid';
  /** What a person would have said, for a readable failure line. */
  phrase: string;
  params: Record<string, unknown>;
  expected: Expectation;
}

/**
 * Reference days chosen to break things: all seven weekdays, a 31-day month end,
 * a non-leap February end, both sides of a year rollover, a leap day, and the US
 * spring-forward Sunday (date-only maths should be immune — this case is here to
 * prove it stays immune).
 */
export const REFERENCE_DAYS = [
  '2026-08-10', // Monday
  '2026-08-11', // Tuesday
  '2026-08-12', // Wednesday
  '2026-08-13', // Thursday
  '2026-08-14', // Friday
  '2026-08-15', // Saturday
  '2026-08-16', // Sunday
  '2026-01-31', // Saturday, 31-day month end
  '2026-02-28', // Saturday, non-leap February end
  '2026-12-31', // Thursday, last day of the year
  '2027-01-01', // Friday, first day of the year
  '2028-02-29', // Tuesday, a leap day
  '2026-03-08', // Sunday, US spring-forward
] as const;

const day = (date: string): Expectation => ({ kind: 'day', date, weekday: weekdayOf(date) });

/** One reference day's worth of cases. */
function casesFor(today: string): DateCase[] {
  const out: DateCase[] = [];
  const push = (
    group: DateCase['group'],
    suffix: string,
    phrase: string,
    params: Record<string, unknown>,
    expected: Expectation,
  ) => out.push({ id: `${today}/${suffix}`, group, phrase, params, expected });

  // ── dayShift: plain day offsets, forward and back ──
  for (const [shift, phrase] of [
    [0, 'today'],
    [1, 'tomorrow'],
    [3, 'in three days'],
    [7, 'a week from today'],
    [-1, 'yesterday'],
    [-7, 'a week ago'],
  ] as const) {
    push('dayShift', `shift${shift}`, phrase, { dayShift: shift }, day(addDays(today, shift)));
  }

  // ── weekday × weeksAhead: OCCURRENCE-anchored ──
  // weeksAhead 0 counts today when today IS the named day, and -1 is the most
  // recent past occurrence. Both are conventions a model guesses wrong.
  for (const wd of ['monday', 'friday'] as const) {
    push('weekday', `${wd}-0`, `this ${wd}`, { weekday: wd, weeksAhead: 0 }, day(comingWeekday(today, wd)));
    push('weekday', `${wd}+1`, `next ${wd}`, { weekday: wd, weeksAhead: 1 }, day(nthWeekday(today, wd, 1)));
    push('weekday', `${wd}+2`, `the ${wd} after next`, { weekday: wd, weeksAhead: 2 }, day(nthWeekday(today, wd, 2)));
    push('weekday', `${wd}-1`, `last ${wd}`, { weekday: wd, weeksAhead: -1 }, day(nthWeekday(today, wd, -1)));
    // weeksAhead omitted must behave as 0, not as "unspecified".
    push('weekday', `${wd}-bare`, `${wd}`, { weekday: wd }, day(comingWeekday(today, wd)));
  }

  // ── week: CALENDAR-anchored Mon–Sun, ambiguous on weekends ──
  // A Saturday's "next week" starts in two days by calendar anchoring but a week
  // later by occurrence anchoring; that divergence lost a real Monday visit on
  // 2026-07-25, so both readings must come back flagged.
  for (const [w, phrase] of [
    [0, 'this week'],
    [1, 'next week'],
    [-1, 'last week'],
  ] as const) {
    const r = weekRange(today, w);
    push('week', `week${w}`, phrase, { week: w }, {
      kind: 'week',
      start: r.start,
      end: r.end,
      ambiguous: isWeekend(today),
      ...(isWeekend(today) ? { altStart: addDays(r.start, 7) } : {}),
    });
  }

  // ── calendar periods ──
  for (const [m, phrase] of [
    [0, 'this month'],
    [-1, 'last month'],
    [1, 'next month'],
  ] as const) {
    const r = monthRange(today, m);
    push('month', `month${m}`, phrase, { month: m }, { kind: 'period', ...r });
  }
  for (const [q, phrase] of [
    [0, 'this quarter'],
    [-1, 'last quarter'],
  ] as const) {
    const r = quarterRange(today, q);
    push('quarter', `quarter${q}`, phrase, { quarter: q }, { kind: 'period', ...r });
  }
  for (const [y, phrase] of [
    [0, 'this year'],
    [-1, 'last year'],
  ] as const) {
    const r = yearRange(today, y);
    push('year', `year${y}`, phrase, { year: y }, { kind: 'period', ...r });
  }

  // ── explicit date: pure passthrough, including across a rollover ──
  const stated = addDays(today, 20);
  push('explicit', 'explicit', `on ${stated}`, { explicitDate: stated }, day(stated));

  return out;
}

/**
 * Malformed and out-of-range calls. Every one MUST come back unresolvable: the
 * doctrine is "ask which date they mean, never guess", and that only works if the
 * tool refuses rather than returning a plausible date.
 */
function invalidCases(): DateCase[] {
  const today = '2026-08-12';
  const mk = (suffix: string, phrase: string, params: Record<string, unknown>): DateCase => ({
    id: `invalid/${suffix}`,
    group: 'invalid',
    phrase,
    params,
    expected: { kind: 'unresolvable' },
  });
  return [
    mk('no-mode', 'nothing at all', {}),
    mk('weeksahead-alone', 'weeksAhead with no weekday', { weeksAhead: 1 }),
    mk('two-modes', 'a weekday AND a dayShift', { weekday: 'monday', dayShift: 1 }),
    mk('week-plus-weekday', 'a week range AND a weekday', { week: 1, weekday: 'monday' }),
    mk('month-plus-week', 'a month AND a week', { month: 0, week: 0 }),
    mk('unreal-date', 'the 30th of February', { explicitDate: '2026-02-30' }),
    mk('malformed-date', 'a slash-formatted date', { explicitDate: '12/08/2026' }),
    mk('shift-too-far', `a dayShift past ${BOUNDS.dayShift}`, { dayShift: BOUNDS.dayShift + 1 }),
    mk('week-too-far', `a week past ${BOUNDS.weeks}`, { week: BOUNDS.weeks + 1 }),
    mk('month-too-far', `a month past ${BOUNDS.months}`, { month: BOUNDS.months + 1 }),
    mk('quarter-too-far', `a quarter past ${BOUNDS.quarters}`, { quarter: BOUNDS.quarters + 1 }),
    mk('year-too-far', `a year past ${BOUNDS.years}`, { year: BOUNDS.years + 1 }),
    mk('fractional-shift', 'half a day', { dayShift: 1.5 }),
    // The reference date itself being nonsense must refuse, not throw.
    { ...mk('bad-today', 'an impossible today', { dayShift: 0 }), params: { dayShift: 0, todayLocal: '2026-02-30' } },
    ...[today].map(() => mk('fractional-week', 'a third of a week', { week: 0.33 })),
  ];
}

export function buildDateMatrix(): DateCase[] {
  return [...REFERENCE_DAYS.flatMap(casesFor), ...invalidCases()];
}

/** The todayLocal a case runs with (its own override, else the id's prefix). */
export function todayFor(c: DateCase): string {
  if (typeof c.params.todayLocal === 'string') return c.params.todayLocal;
  const prefix = c.id.split('/')[0];
  return prefix === 'invalid' ? '2026-08-12' : prefix;
}

/**
 * Grade one resolver result. Returns null on pass, else why it failed.
 *
 * `phrase` is checked as strictly as the dates are, because the doctrine tells
 * the agent to say it VERBATIM: a phrase that disagrees with its own date is a
 * fabricated weekday with a tool's authority behind it.
 */
export function gradeDateCase(c: DateCase, actual: unknown): string | null {
  const a = actual as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== 'object') return `no result object (got ${JSON.stringify(actual)})`;
  const status = a.status;
  const e = c.expected;

  if (e.kind === 'unresolvable') {
    if (status !== 'unresolvable') return `expected unresolvable, got ${String(status)} ${JSON.stringify(a).slice(0, 120)}`;
    if (typeof a.reason !== 'string' || a.reason.length === 0) return 'unresolvable with no reason to relay';
    return null;
  }

  if (e.kind === 'day') {
    if (status !== 'resolved') return `expected resolved, got ${String(status)}: ${String(a.reason ?? '')}`;
    if (a.date !== e.date) return `date ${String(a.date)} ≠ expected ${e.date}`;
    if (a.weekday !== e.weekday) return `weekday '${String(a.weekday)}' ≠ expected '${e.weekday}'`;
    const want = `${titleWeekday(e.date)} ${e.date}`;
    if (a.phrase !== want) return `phrase '${String(a.phrase)}' ≠ expected '${want}'`;
    return null;
  }

  if (e.kind === 'week') {
    if (status !== 'resolved_week') return `expected resolved_week, got ${String(status)}: ${String(a.reason ?? '')}`;
    if (a.weekStart !== e.start) return `weekStart ${String(a.weekStart)} ≠ expected ${e.start}`;
    if (a.weekEnd !== e.end) return `weekEnd ${String(a.weekEnd)} ≠ expected ${e.end}`;
    if (a.weekStartWeekday !== 'monday') return `weekStartWeekday '${String(a.weekStartWeekday)}' is not monday`;
    if (a.weekEndWeekday !== 'sunday') return `weekEndWeekday '${String(a.weekEndWeekday)}' is not sunday`;
    const ambiguous = a.boundaryAmbiguous === true;
    if (ambiguous !== e.ambiguous) {
      return e.ambiguous
        ? 'a weekend week range came back UNFLAGGED — the agent would silently pick one reading'
        : 'a midweek week range was flagged ambiguous when it is not';
    }
    if (e.ambiguous) {
      const alt = a.alternate as Record<string, unknown> | undefined;
      if (!alt) return 'flagged ambiguous but carries no alternate range to offer';
      if (alt.weekStart !== e.altStart) return `alternate weekStart ${String(alt.weekStart)} ≠ expected ${e.altStart}`;
      if (typeof alt.phrase !== 'string' || !alt.phrase.includes(String(e.altStart))) {
        return 'the alternate range has no phrase naming its own dates';
      }
      if (typeof a.note !== 'string' || !/ambiguous/i.test(a.note)) return 'ambiguous result with no instruction to ask';
    }
    const want = `${titleWeekday(e.start)} ${e.start} through ${titleWeekday(e.end)} ${e.end}`;
    if (a.phrase !== want) return `phrase '${String(a.phrase)}' ≠ expected '${want}'`;
    return null;
  }

  // period
  if (status !== 'resolved_period') return `expected resolved_period, got ${String(status)}: ${String(a.reason ?? '')}`;
  if (a.periodStart !== e.start) return `periodStart ${String(a.periodStart)} ≠ expected ${e.start}`;
  if (a.periodEnd !== e.end) return `periodEnd ${String(a.periodEnd)} ≠ expected ${e.end}`;
  if (a.label !== e.label) return `label '${String(a.label)}' ≠ expected '${e.label}'`;
  if (typeof a.phrase !== 'string' || !a.phrase.includes(e.label)) return `phrase does not name the period '${e.label}'`;
  return null;
}
