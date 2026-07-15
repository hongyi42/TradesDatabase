import { describe, expect, test } from 'vitest';
import { resolveDate, isRealDateISO, isWeekday, type ResolveDateParams } from './dateResolve.js';

// Pure function, no DB — a plain unit suite. Expected values are hand-computed,
// NOT read back from the code, so the test is an independent check of the math.
// Anchor day: 2026-07-15 is a WEDNESDAY (day-of-year 196; 2026-01-01 is a
// Thursday). So "this Friday" MUST be the 17th, and the 18th is a Saturday —
// the exact wrong answer the live bot produced.
const WED_2026_07_15 = '2026-07-15';

function resolved(p: ResolveDateParams): { date: string; weekday: string } {
  const r = resolveDate(p);
  if (r.status !== 'resolved') throw new Error(`expected resolved, got: ${r.reason}`);
  return { date: r.date, weekday: r.weekday };
}

describe('resolveDate — weekday mode (this/next/further weeks)', () => {
  // From Wednesday 2026-07-15, weeksAhead 0 = the COMING occurrence.
  const comingFromWed: Array<[ResolveDateParams['weekday'], string, string]> = [
    ['monday', '2026-07-20', 'monday'],
    ['tuesday', '2026-07-21', 'tuesday'],
    ['wednesday', '2026-07-15', 'wednesday'], // today itself
    ['thursday', '2026-07-16', 'thursday'],
    ['friday', '2026-07-17', 'friday'], // NOT the 18th
    ['saturday', '2026-07-18', 'saturday'], // the 18th is Saturday
    ['sunday', '2026-07-19', 'sunday'],
  ];
  for (const [weekday, date, name] of comingFromWed) {
    test(`this ${weekday} → ${date}`, () => {
      expect(resolved({ todayLocal: WED_2026_07_15, weekday })).toEqual({ date, weekday: name });
    });
    test(`this ${weekday} with explicit weeksAhead:0 matches`, () => {
      expect(resolved({ todayLocal: WED_2026_07_15, weekday, weeksAhead: 0 }).date).toBe(date);
    });
  }

  test('the regression pin: "this Friday" from Wed 2026-07-15 is the 17th, never the 18th', () => {
    const r = resolved({ todayLocal: WED_2026_07_15, weekday: 'friday' });
    expect(r.date).toBe('2026-07-17');
    expect(r.date).not.toBe('2026-07-18');
    expect(r.weekday).toBe('friday');
  });

  test('"next Friday" (weeksAhead 1) and further weeks stack by 7', () => {
    expect(resolved({ todayLocal: WED_2026_07_15, weekday: 'friday', weeksAhead: 1 }).date).toBe('2026-07-24');
    expect(resolved({ todayLocal: WED_2026_07_15, weekday: 'friday', weeksAhead: 2 }).date).toBe('2026-07-31');
    expect(resolved({ todayLocal: WED_2026_07_15, weekday: 'friday', weeksAhead: 3 }).date).toBe('2026-08-07');
  });

  test('"this <today\'s weekday>" resolves to today; "next" is +7', () => {
    // today is Wednesday.
    expect(resolved({ todayLocal: WED_2026_07_15, weekday: 'wednesday', weeksAhead: 0 }).date).toBe('2026-07-15');
    expect(resolved({ todayLocal: WED_2026_07_15, weekday: 'wednesday', weeksAhead: 1 }).date).toBe('2026-07-22');
  });

  test('weekday resolution from a Sunday anchor (2026-07-19)', () => {
    // 2026-07-19 is a Sunday.
    expect(resolved({ todayLocal: '2026-07-19', weekday: 'monday' }).date).toBe('2026-07-20');
    expect(resolved({ todayLocal: '2026-07-19', weekday: 'sunday' }).date).toBe('2026-07-19'); // today
    expect(resolved({ todayLocal: '2026-07-19', weekday: 'saturday' }).date).toBe('2026-07-25');
  });

  test('weekday mode crosses a month boundary', () => {
    // 2026-07-30 is a Thursday; "this Saturday" → 2026-08-01.
    expect(resolved({ todayLocal: '2026-07-30', weekday: 'saturday' }).date).toBe('2026-08-01');
  });

  test('weekday mode crosses a year boundary', () => {
    // 2026-12-31 is a Thursday; "next Monday" (weeksAhead 0) → 2027-01-04.
    expect(resolved({ todayLocal: '2026-12-31', weekday: 'monday' }).date).toBe('2027-01-04');
  });
});

describe('resolveDate — dayShift mode', () => {
  const cases: Array<[number, string, string]> = [
    [0, '2026-07-15', 'wednesday'], // today
    [1, '2026-07-16', 'thursday'], // tomorrow
    [2, '2026-07-17', 'friday'],
    [7, '2026-07-22', 'wednesday'], // a week out
    [-1, '2026-07-14', 'tuesday'], // yesterday
  ];
  for (const [dayShift, date, weekday] of cases) {
    test(`dayShift ${dayShift} → ${date} (${weekday})`, () => {
      expect(resolved({ todayLocal: WED_2026_07_15, dayShift })).toEqual({ date, weekday });
    });
  }

  test('dayShift crosses month, year, and into a leap day', () => {
    expect(resolved({ todayLocal: '2026-07-31', dayShift: 1 }).date).toBe('2026-08-01');
    expect(resolved({ todayLocal: '2026-12-31', dayShift: 1 }).date).toBe('2027-01-01');
    // 2028 is a leap year: Feb 28 + 1 = Feb 29, + 2 = Mar 1.
    expect(resolved({ todayLocal: '2028-02-28', dayShift: 1 }).date).toBe('2028-02-29');
    expect(resolved({ todayLocal: '2028-02-28', dayShift: 2 }).date).toBe('2028-03-01');
    // 2026 is NOT leap: Feb 28 + 1 = Mar 1.
    expect(resolved({ todayLocal: '2026-02-28', dayShift: 1 }).date).toBe('2026-03-01');
  });
});

describe('resolveDate — explicitDate mode', () => {
  test('a valid explicit date passes through and gets its weekday labelled', () => {
    expect(resolved({ todayLocal: WED_2026_07_15, explicitDate: '2026-07-17' })).toEqual({
      date: '2026-07-17',
      weekday: 'friday',
    });
    // The leap day is real in 2028.
    expect(resolved({ todayLocal: WED_2026_07_15, explicitDate: '2028-02-29' }).weekday).toBe('tuesday');
  });

  const badDates = ['2026-02-30', '2026-13-01', '2026-00-10', '2026-07-32', '07/17/2026', '2026-7-1', 'tomorrow'];
  for (const bad of badDates) {
    test(`rejects unreal/misformatted explicitDate '${bad}'`, () => {
      const r = resolveDate({ todayLocal: WED_2026_07_15, explicitDate: bad });
      expect(r.status).toBe('unresolvable');
    });
  }
});

describe('resolveDate — validation and refusals (the clarify path)', () => {
  test('no day reference at all is unresolvable', () => {
    const r = resolveDate({ todayLocal: WED_2026_07_15 });
    expect(r.status).toBe('unresolvable');
    if (r.status === 'unresolvable') expect(r.reason).toMatch(/no day reference/);
  });

  test('more than one mode is unresolvable', () => {
    expect(resolveDate({ todayLocal: WED_2026_07_15, weekday: 'friday', dayShift: 1 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: WED_2026_07_15, explicitDate: '2026-07-17', weekday: 'friday' }).status).toBe('unresolvable');
  });

  test('weeksAhead without a weekday is unresolvable', () => {
    const r = resolveDate({ todayLocal: WED_2026_07_15, weeksAhead: 1 });
    expect(r.status).toBe('unresolvable');
    if (r.status === 'unresolvable') expect(r.reason).toMatch(/weeksAhead only applies/);
  });

  test('negative or oversized weeksAhead is unresolvable (no past weekday refs)', () => {
    expect(resolveDate({ todayLocal: WED_2026_07_15, weekday: 'friday', weeksAhead: -1 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: WED_2026_07_15, weekday: 'friday', weeksAhead: 53 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: WED_2026_07_15, weekday: 'friday', weeksAhead: 1.5 }).status).toBe('unresolvable');
  });

  test('non-integer or out-of-range dayShift is unresolvable', () => {
    expect(resolveDate({ todayLocal: WED_2026_07_15, dayShift: 1.5 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: WED_2026_07_15, dayShift: 999 }).status).toBe('unresolvable');
  });

  test('a bad reference date (server bug) refuses rather than guessing', () => {
    expect(resolveDate({ todayLocal: 'not-a-date', dayShift: 0 }).status).toBe('unresolvable');
  });
});

describe('helpers', () => {
  test('isRealDateISO', () => {
    expect(isRealDateISO('2026-07-17')).toBe(true);
    expect(isRealDateISO('2028-02-29')).toBe(true);
    expect(isRealDateISO('2026-02-29')).toBe(false);
    expect(isRealDateISO('2026-13-01')).toBe(false);
    expect(isRealDateISO('2026-7-1')).toBe(false);
  });
  test('isWeekday', () => {
    expect(isWeekday('friday')).toBe(true);
    expect(isWeekday('Friday')).toBe(false);
    expect(isWeekday('someday')).toBe(false);
  });
});
