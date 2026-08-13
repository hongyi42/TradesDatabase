import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMinutes,
  comingWeekday,
  daysBetween,
  eachDay,
  firmToday,
  isRealDateISO,
  isWeekend,
  mondayOf,
  monthRange,
  naiveLocal,
  nextWorkday,
  nthWeekday,
  pick,
  quarterRange,
  rng,
  titleWeekday,
  weekRange,
  weekdayOf,
  yearRange,
} from './clock.js';

// Fixtures are real weekdays, computed independently (node -e) rather than
// asserted from memory: 2026-08-12 is a Wednesday, 08-15 Sat, 08-16 Sun,
// 08-17 Mon, 2026-12-31 Thu, 2028-02-29 Tue (a leap day).

describe('isRealDateISO', () => {
  it('accepts real dates including a leap day', () => {
    expect(isRealDateISO('2026-08-12')).toBe(true);
    expect(isRealDateISO('2028-02-29')).toBe(true);
  });

  it('rejects malformed and non-existent dates', () => {
    // 2026-02-30 round-trips to 2026-03-02 in JS Date — the round-trip check is
    // what catches it, not the regex.
    expect(isRealDateISO('2026-02-30')).toBe(false);
    expect(isRealDateISO('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isRealDateISO('2026-8-12')).toBe(false);
    expect(isRealDateISO('12/08/2026')).toBe(false);
    expect(isRealDateISO('')).toBe(false);
  });
});

describe('addDays', () => {
  it('crosses month, year and leap boundaries', () => {
    expect(addDays('2026-08-12', 1)).toBe('2026-08-13');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01'); // non-leap year
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2026-08-12', 0)).toBe('2026-08-12');
  });

  it('rejects a date that does not exist', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(/not a real/);
  });
});

describe('weekdayOf / titleWeekday / isWeekend', () => {
  it('names the real weekday', () => {
    expect(weekdayOf('2026-08-12')).toBe('wednesday');
    expect(weekdayOf('2026-12-31')).toBe('thursday');
    expect(weekdayOf('2028-02-29')).toBe('tuesday');
    expect(titleWeekday('2026-08-12')).toBe('Wednesday');
  });

  it('knows the weekend', () => {
    expect(isWeekend('2026-08-15')).toBe(true); // Saturday
    expect(isWeekend('2026-08-16')).toBe(true); // Sunday
    expect(isWeekend('2026-08-17')).toBe(false); // Monday
  });
});

describe('comingWeekday / nthWeekday', () => {
  it('counts today as the coming occurrence', () => {
    // The convention dateResolve pins for weeksAhead 0 — restated, not imported.
    expect(comingWeekday('2026-08-12', 'wednesday')).toBe('2026-08-12');
  });

  it('finds the next occurrence otherwise', () => {
    expect(comingWeekday('2026-08-12', 'friday')).toBe('2026-08-14');
    expect(comingWeekday('2026-08-12', 'tuesday')).toBe('2026-08-18');
  });

  it('adds whole weeks for weeksAhead', () => {
    expect(nthWeekday('2026-08-12', 'friday', 0)).toBe('2026-08-14');
    expect(nthWeekday('2026-08-12', 'friday', 1)).toBe('2026-08-21');
    expect(nthWeekday('2026-08-12', 'friday', 2)).toBe('2026-08-28');
  });

  it('rejects a non-weekday name', () => {
    // @ts-expect-error — deliberately wrong input
    expect(() => comingWeekday('2026-08-12', 'someday')).toThrow(/not a weekday/);
  });
});

describe('mondayOf / weekRange', () => {
  it('anchors Mon-Sun weeks, including from a Sunday', () => {
    expect(mondayOf('2026-08-12')).toBe('2026-08-10'); // Wed -> Mon
    expect(mondayOf('2026-08-17')).toBe('2026-08-17'); // Mon -> itself
    // The boundary that bit in July: a Sunday belongs to the week that STARTED
    // on the previous Monday, not the one about to begin.
    expect(mondayOf('2026-08-16')).toBe('2026-08-10');
  });

  it('returns the whole range', () => {
    expect(weekRange('2026-08-12')).toEqual({ start: '2026-08-10', end: '2026-08-16' });
    expect(weekRange('2026-08-12', 1)).toEqual({ start: '2026-08-17', end: '2026-08-23' });
  });
});

describe('daysBetween / eachDay', () => {
  it('counts signed whole days', () => {
    expect(daysBetween('2026-08-12', '2026-08-15')).toBe(3);
    expect(daysBetween('2026-08-15', '2026-08-12')).toBe(-3);
    expect(daysBetween('2026-08-12', '2026-08-12')).toBe(0);
  });

  it('enumerates inclusively and empties when reversed', () => {
    expect(eachDay('2026-08-12', '2026-08-14')).toEqual(['2026-08-12', '2026-08-13', '2026-08-14']);
    expect(eachDay('2026-08-14', '2026-08-12')).toEqual([]);
  });
});

describe('nextWorkday', () => {
  it('never lands on a weekend', () => {
    expect(nextWorkday('2026-08-15')).toBe('2026-08-17'); // Sat -> Mon
    expect(nextWorkday('2026-08-16')).toBe('2026-08-17'); // Sun -> Mon
    expect(nextWorkday('2026-08-12')).toBe('2026-08-12'); // Wed -> itself
  });

  it('steps n working days, skipping the weekend', () => {
    expect(nextWorkday('2026-08-12', 1)).toBe('2026-08-13'); // Wed -> Thu
    expect(nextWorkday('2026-08-13', 2)).toBe('2026-08-17'); // Thu -> Mon (skips Sat/Sun)
    expect(nextWorkday('2026-08-12', 5)).toBe('2026-08-19'); // a full working week
  });
});

describe('monthRange / quarterRange / yearRange', () => {
  it('names the month containing the date', () => {
    expect(monthRange('2026-08-12')).toEqual({ start: '2026-08-01', end: '2026-08-31', label: 'August 2026' });
    expect(monthRange('2026-02-15')).toEqual({ start: '2026-02-01', end: '2026-02-28', label: 'February 2026' });
    // Leap February — falls out of the arithmetic, not a table.
    expect(monthRange('2028-02-15')).toEqual({ start: '2028-02-01', end: '2028-02-29', label: 'February 2028' });
  });

  it('wraps backwards into the previous YEAR — the case a model gets wrong', () => {
    // "last month" said in January is December of the previous year.
    expect(monthRange('2027-01-15', -1)).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
      label: 'December 2026',
    });
    expect(monthRange('2026-08-12', -1).label).toBe('July 2026');
    expect(monthRange('2026-12-15', 1).label).toBe('January 2027');
  });

  it('survives a 31-day month end, where naive month arithmetic overflows', () => {
    // Date.setUTCMonth from Jan 31 would land in March; anchoring on the 1st is
    // what makes this correct, so it is pinned.
    expect(monthRange('2026-01-31', 1)).toEqual({ start: '2026-02-01', end: '2026-02-28', label: 'February 2026' });
    expect(monthRange('2026-03-31', -1)).toEqual({ start: '2026-02-01', end: '2026-02-28', label: 'February 2026' });
  });

  it('anchors quarters on their real first month', () => {
    expect(quarterRange('2026-08-12')).toEqual({ start: '2026-07-01', end: '2026-09-30', label: 'Q3 2026' });
    expect(quarterRange('2026-01-05')).toEqual({ start: '2026-01-01', end: '2026-03-31', label: 'Q1 2026' });
    expect(quarterRange('2026-12-31')).toEqual({ start: '2026-10-01', end: '2026-12-31', label: 'Q4 2026' });
    expect(quarterRange('2026-01-05', -1)).toEqual({ start: '2025-10-01', end: '2025-12-31', label: 'Q4 2025' });
    expect(quarterRange('2026-08-12', 1).label).toBe('Q4 2026');
  });

  it('spans whole years', () => {
    expect(yearRange('2026-08-12')).toEqual({ start: '2026-01-01', end: '2026-12-31', label: '2026' });
    expect(yearRange('2026-08-12', -1).label).toBe('2025');
    expect(yearRange('2028-02-29').end).toBe('2028-12-31');
  });
});

describe('naiveLocal / addMinutes', () => {
  it('writes the wall clock as-if-UTC', () => {
    // Load-bearing: every reader slices HH:MM straight out of this string, so
    // 09:00 local MUST serialise as T09:00 (booking.ts naiveLocalISO).
    expect(naiveLocal('2026-08-12', '09:00')).toBe('2026-08-12T09:00:00.000Z');
    expect(naiveLocal('2026-08-12', '09:00').slice(11, 16)).toBe('09:00');
    expect(naiveLocal('2026-08-12', '09:00').slice(0, 10)).toBe('2026-08-12');
  });

  it('rejects malformed input', () => {
    expect(() => naiveLocal('2026-08-12', '9:00')).toThrow(/HH:MM/);
    expect(() => naiveLocal('2026-02-30', '09:00')).toThrow(/not a real/);
  });

  it('adds minutes within the day and refuses to wrap', () => {
    expect(addMinutes('09:00', 120)).toBe('11:00');
    expect(addMinutes('09:30', 45)).toBe('10:15');
    expect(addMinutes('10:00', -60)).toBe('09:00');
    expect(() => addMinutes('23:30', 45)).toThrow(/leaves the day/);
    expect(() => addMinutes('00:15', -30)).toThrow(/leaves the day/);
  });
});

describe('firmToday', () => {
  it('reads the date in the firm timezone, not UTC', () => {
    // 2026-08-13 06:30Z is still the 12th in Los Angeles — the evening-rollover
    // trap that makes a UTC "today" name tomorrow.
    const at = new Date('2026-08-13T06:30:00.000Z');
    expect(firmToday('America/Los_Angeles', at)).toBe('2026-08-12');
    expect(firmToday('UTC', at)).toBe('2026-08-13');
  });
});

describe('rng / pick', () => {
  it('is reproducible from the seed', () => {
    const a = rng(42);
    const b = rng(42);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(new Set(first).size).toBe(3); // and not a constant
  });

  it('differs across seeds', () => {
    expect(rng(1)()).not.toBe(rng(2)());
  });

  it('picks deterministically and in range', () => {
    const items = ['a', 'b', 'c'] as const;
    const chosen = Array.from({ length: 20 }, (_, i) => pick(rng(i), items));
    expect(chosen.every((c) => items.includes(c))).toBe(true);
    expect(pick(rng(7), items)).toBe(pick(rng(7), items));
    expect(() => pick(rng(1), [])).toThrow(/empty/);
  });
});
