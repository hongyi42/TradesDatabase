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
  if (r.status !== 'resolved') throw new Error(`expected resolved, got: ${JSON.stringify(r)}`);
  return { date: r.date, weekday: r.weekday };
}

function resolvedWeek(p: ResolveDateParams) {
  const r = resolveDate(p);
  if (r.status !== 'resolved_week') throw new Error(`expected resolved_week, got: ${JSON.stringify(r)}`);
  return r;
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

describe('resolveDate — week mode (calendar-anchored Mon–Sun ranges)', () => {
  // Anchors are hand-computed: 2026-07-20 is a Monday, so Jul 20–26 is one
  // calendar week and Jul 27–Aug 2 the next. 2026-07-22 = Wednesday,
  // 2026-07-25 = Saturday, 2026-07-26 = Sunday.
  test('mid-week: week 0 is the current Mon–Sun, week 1 the next; no ambiguity flag', () => {
    const thisWeek = resolvedWeek({ todayLocal: '2026-07-22', week: 0 });
    expect(thisWeek.weekStart).toBe('2026-07-20');
    expect(thisWeek.weekEnd).toBe('2026-07-26');
    expect(thisWeek.boundaryAmbiguous).toBeUndefined();
    expect(thisWeek.alternate).toBeUndefined();

    const nextWeek = resolvedWeek({ todayLocal: '2026-07-22', week: 1 });
    expect(nextWeek.weekStart).toBe('2026-07-27');
    expect(nextWeek.weekEnd).toBe('2026-08-02');
    expect(nextWeek.boundaryAmbiguous).toBeUndefined();
  });

  test('THE live-bite regression: Saturday "next week" contains the coming Monday, flagged ambiguous', () => {
    // 2026-07-25 (Sat): the pilot manager's "next week" meant Jul 27–Aug 2 —
    // the week holding the Tom Nguyen Monday visit the agent missed. The
    // primary range must contain Jul 27; the occurrence-anchored reading
    // (Aug 3–9) rides along as the alternate, with the ask instruction.
    const r = resolvedWeek({ todayLocal: '2026-07-25', week: 1 });
    expect(r.weekStart).toBe('2026-07-27');
    expect(r.weekEnd).toBe('2026-08-02');
    expect(r.boundaryAmbiguous).toBe(true);
    expect(r.alternate).toEqual({ weekStart: '2026-08-03', weekEnd: '2026-08-09' });
    expect(r.note).toMatch(/ask/i);
  });

  test('Sunday "next week" starts tomorrow, flagged ambiguous', () => {
    const r = resolvedWeek({ todayLocal: '2026-07-26', week: 1 });
    expect(r.weekStart).toBe('2026-07-27');
    expect(r.weekEnd).toBe('2026-08-02');
    expect(r.boundaryAmbiguous).toBe(true);
  });

  test('Saturday "this week" is the mostly-past current week, ambiguous with the coming one', () => {
    const r = resolvedWeek({ todayLocal: '2026-07-25', week: 0 });
    expect(r.weekStart).toBe('2026-07-20');
    expect(r.weekEnd).toBe('2026-07-26');
    expect(r.boundaryAmbiguous).toBe(true);
    expect(r.alternate).toEqual({ weekStart: '2026-07-27', weekEnd: '2026-08-02' });
  });

  test('weekEnd is always weekStart+6 and a Sunday, across a year boundary too', () => {
    // 2026-12-31 is a Thursday; week 1 → Mon 2027-01-04.
    const r = resolvedWeek({ todayLocal: '2026-12-31', week: 1 });
    expect(r.weekStart).toBe('2027-01-04');
    expect(r.weekEnd).toBe('2027-01-10');
    expect(new Date(`${r.weekEnd}T00:00:00.000Z`).getUTCDay()).toBe(0);
    expect(new Date(`${r.weekStart}T00:00:00.000Z`).getUTCDay()).toBe(1);
  });

  test('week combined with another mode is unresolvable (exactly-one rule)', () => {
    expect(resolveDate({ todayLocal: '2026-07-22', week: 1, weekday: 'friday' }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: '2026-07-22', week: 1, dayShift: 1 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: '2026-07-22', week: 1, explicitDate: '2026-07-24' }).status).toBe('unresolvable');
  });

  test('week with weeksAhead is unresolvable and the reason steers to week alone', () => {
    const r = resolveDate({ todayLocal: '2026-07-22', week: 1, weeksAhead: 1 });
    expect(r.status).toBe('unresolvable');
    if (r.status === 'unresolvable') expect(r.reason).toMatch(/weeksAhead only applies/);
  });

  test('negative, oversized, or fractional week is unresolvable', () => {
    expect(resolveDate({ todayLocal: '2026-07-22', week: -1 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: '2026-07-22', week: 53 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: '2026-07-22', week: 1.5 }).status).toBe('unresolvable');
  });

  test('the mode-refusal strings name week (result text is agent steering)', () => {
    const none = resolveDate({ todayLocal: '2026-07-22' });
    if (none.status === 'unresolvable') expect(none.reason).toMatch(/or week/);
    const many = resolveDate({ todayLocal: '2026-07-22', weekday: 'friday', dayShift: 1 });
    if (many.status === 'unresolvable') expect(many.reason).toMatch(/or week/);
  });
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
