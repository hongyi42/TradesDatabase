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

describe('resolveDate — every resolution is quotable', () => {
  // A single date already returned its weekday, but LOWERCASE and separate from
  // the date, so the agent still assembled the sentence. `phrase` removes the
  // assembly step for every mode, not just the week ranges that caused this.
  test('each single-date mode returns a title-cased "Weekday YYYY-MM-DD" phrase', () => {
    const cases: Array<[ResolveDateParams, string]> = [
      [{ todayLocal: WED_2026_07_15, weekday: 'friday' }, 'Friday 2026-07-17'],
      [{ todayLocal: WED_2026_07_15, dayShift: 0 }, 'Wednesday 2026-07-15'],
      [{ todayLocal: WED_2026_07_15, dayShift: 1 }, 'Thursday 2026-07-16'],
      [{ todayLocal: WED_2026_07_15, explicitDate: '2026-08-04' }, 'Tuesday 2026-08-04'],
    ];
    for (const [params, phrase] of cases) {
      const r = resolveDate(params);
      if (r.status !== 'resolved') throw new Error(`expected resolved: ${JSON.stringify(r)}`);
      expect(r.phrase).toBe(phrase);
      // The phrase must agree with the fields, never drift from them.
      expect(r.phrase.toLowerCase()).toBe(`${r.weekday} ${r.date}`);
    }
  });

  test('2026-08-04 is a Tuesday — the date the live agent called Monday', () => {
    const r = resolveDate({ todayLocal: '2026-08-06', explicitDate: '2026-08-04' });
    if (r.status !== 'resolved') throw new Error('expected resolved');
    expect(r.phrase).toBe('Tuesday 2026-08-04');
  });
});

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
    expect(r.alternate).toEqual({
      weekStart: '2026-08-03',
      weekEnd: '2026-08-09',
      weekStartWeekday: 'monday',
      weekEndWeekday: 'sunday',
      phrase: 'Monday 2026-08-03 through Sunday 2026-08-09',
    });
    expect(r.note).toMatch(/ask/i);
  });

  test('Sunday "next week" starts tomorrow, flagged ambiguous', () => {
    const r = resolvedWeek({ todayLocal: '2026-07-26', week: 1 });
    expect(r.weekStart).toBe('2026-07-27');
    expect(r.weekEnd).toBe('2026-08-02');
    expect(r.boundaryAmbiguous).toBe(true);
  });

  // Changed 2026-08-15: week 0 on a weekend is NOT flagged. "This week" said
  // on a Saturday means the containing calendar week to essentially everyone
  // (the eval corpus and common speech agree), and the always-flag caused the
  // agent to answer "this week, Monday through Sunday" with a clarifying
  // question and zero data (eval W02/W06/P20). Forward weeks keep the flag —
  // the 2026-07-25 live bite was a "next week".
  test('Saturday "this week" is the containing current week — NOT flagged ambiguous', () => {
    const r = resolvedWeek({ todayLocal: '2026-07-25', week: 0 });
    expect(r.weekStart).toBe('2026-07-20');
    expect(r.weekEnd).toBe('2026-07-26');
    expect(r.boundaryAmbiguous).toBeUndefined();
    expect(r.alternate).toBeUndefined();
  });

  test('Saturday "last week" (week -1) is the previous calendar week — NOT flagged', () => {
    const r = resolvedWeek({ todayLocal: '2026-07-25', week: -1 });
    expect(r.weekStart).toBe('2026-07-13');
    expect(r.weekEnd).toBe('2026-07-19');
    expect(r.boundaryAmbiguous).toBeUndefined();
  });

  test('weekend "next week" note steers to answering both ranges with data, not clarify-only', () => {
    const r = resolvedWeek({ todayLocal: '2026-07-25', week: 1 });
    expect(r.note).toMatch(/answer BOTH ranges/i);
    expect(r.note).toMatch(/never reply with only a clarifying question/i);
    expect(r.note).toMatch(/before you book, move, or change/i);
  });

  // The P15 class (2026-08-15 eval): "Friday of next week" said on a Saturday.
  // weeksAhead 1 resolves a week too far; the note names the coming-calendar-
  // week reading first, with both phrases ready to quote.
  test('weekend "weekday of next week": weeksAhead 1 past the coming-week reading carries a steering note', () => {
    // 2026-07-25 = Saturday. Coming week = Jul 27–Aug 2; its Friday = Jul 31.
    // weeksAhead 1 from the coming Friday (Jul 31) = Aug 7.
    const r = resolveDate({ todayLocal: '2026-07-25', weekday: 'friday', weeksAhead: 1 });
    if (r.status !== 'resolved') throw new Error(`expected resolved, got ${r.status}`);
    expect(r.date).toBe('2026-08-07');
    expect(r.note).toContain('Friday 2026-07-31');
    expect(r.note).toMatch(/usually means/i);
  });

  test('weekend "sunday of next week": weeksAhead 1 IS the coming-week reading — no note', () => {
    // From Sat 2026-07-25: coming Sunday = Jul 26 (this week); the Sunday of
    // the coming Mon–Sun week = Aug 2 = weeksAhead 1. Already primary: silent.
    const r = resolveDate({ todayLocal: '2026-07-25', weekday: 'sunday', weeksAhead: 1 });
    if (r.status !== 'resolved') throw new Error(`expected resolved, got ${r.status}`);
    expect(r.date).toBe('2026-08-02');
    expect(r.note).toBeUndefined();
  });

  test('mid-week "weekday of next week" gets no weekend note', () => {
    const r = resolveDate({ todayLocal: '2026-07-22', weekday: 'friday', weeksAhead: 1 });
    if (r.status !== 'resolved') throw new Error(`expected resolved, got ${r.status}`);
    expect(r.note).toBeUndefined();
  });

  test('weekEnd is always weekStart+6 and a Sunday, across a year boundary too', () => {
    // 2026-12-31 is a Thursday; week 1 → Mon 2027-01-04.
    const r = resolvedWeek({ todayLocal: '2026-12-31', week: 1 });
    expect(r.weekStart).toBe('2027-01-04');
    expect(r.weekEnd).toBe('2027-01-10');
    expect(new Date(`${r.weekEnd}T00:00:00.000Z`).getUTCDay()).toBe(0);
    expect(new Date(`${r.weekStart}T00:00:00.000Z`).getUTCDay()).toBe(1);
  });

  // THE reason this file gained `phrase`. On 2026-08-06 the agent asked for
  // week 0 on a Thursday, got back two bare dates, and had to build the sentence
  // itself — once wrongly ("Monday the 4th through Saturday the 8th": Aug 4 is a
  // Tuesday and both boundaries were off), then again correctly but still by
  // derivation ("Mon Aug 3 – Sun Aug 9", from a query that counted rows and
  // selected no weekday at all). v_schedule.local_weekday cannot cover this:
  // the dates being named are the WINDOW's, and they come from here.
  test('a week range hands over its weekday labels and a ready-to-say phrase', () => {
    const r = resolvedWeek({ todayLocal: '2026-08-06', week: 0 });
    expect(r.weekStart).toBe('2026-08-03');
    expect(r.weekEnd).toBe('2026-08-09');
    expect(r.weekStartWeekday).toBe('monday');
    expect(r.weekEndWeekday).toBe('sunday');
    // Title-cased and quotable as-is: anything the model has to reformat is
    // something it can reformat wrongly.
    expect(r.phrase).toBe('Monday 2026-08-03 through Sunday 2026-08-09');
  });

  test('the boundaries are ALWAYS labelled Monday/Sunday, whatever the week', () => {
    // Not a lookup — weekStart is a Monday by construction. Asserted across a
    // year boundary and far out, so a future change to the anchoring cannot
    // silently start emitting a mislabelled range.
    for (const [today, week] of [
      ['2026-08-06', 0],
      ['2026-12-31', 1],
      ['2026-07-25', 0],
      ['2027-03-01', 20],
    ] as const) {
      const r = resolvedWeek({ todayLocal: today, week });
      expect(r.weekStartWeekday).toBe('monday');
      expect(r.weekEndWeekday).toBe('sunday');
      expect(r.phrase).toBe(`Monday ${r.weekStart} through Sunday ${r.weekEnd}`);
    }
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

  test('"last week" is week -1 — a real mode since 2026-08-12, not a refusal', () => {
    // The eval caught W05 ("last week") hand-computing its boundaries because
    // negatives were refused. 2026-07-22 is a Wednesday; its week starts
    // Monday Jul 20, so last week is Jul 13–19.
    const r = resolvedWeek({ todayLocal: '2026-07-22', week: -1 });
    expect(r.weekStart).toBe('2026-07-13');
    expect(r.weekEnd).toBe('2026-07-19');
    expect(r.boundaryAmbiguous).toBeUndefined();
  });

  test('oversized or fractional week is unresolvable', () => {
    expect(resolveDate({ todayLocal: '2026-07-22', week: -53 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: '2026-07-22', week: 53 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: '2026-07-22', week: 1.5 }).status).toBe('unresolvable');
  });

  test('the mode-refusal strings name week (result text is agent steering)', () => {
    // \bweek, not "or week": week sits mid-list since the period modes joined
    // the refusal strings — the property under test is that it is NAMED.
    const none = resolveDate({ todayLocal: '2026-07-22' });
    if (none.status === 'unresolvable') expect(none.reason).toMatch(/, week,/);
    const many = resolveDate({ todayLocal: '2026-07-22', weekday: 'friday', dayShift: 1 });
    if (many.status === 'unresolvable') expect(many.reason).toMatch(/, week,/);
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

  test('oversized or fractional weeksAhead is unresolvable', () => {
    expect(resolveDate({ todayLocal: WED_2026_07_15, weekday: 'friday', weeksAhead: -53 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: WED_2026_07_15, weekday: 'friday', weeksAhead: 53 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: WED_2026_07_15, weekday: 'friday', weeksAhead: 1.5 }).status).toBe('unresolvable');
  });

  test('"last <weekday>" is weeksAhead -1 — anchored a whole week before the coming occurrence', () => {
    // From Wednesday Jul 15: coming Friday is the 17th, so last Friday is the
    // 10th — 5 days back, not 7. The anchor-minus-a-week rule matches speech.
    expect(resolved({ todayLocal: WED_2026_07_15, weekday: 'friday', weeksAhead: -1 })).toEqual({
      date: '2026-07-10',
      weekday: 'friday',
    });
    // Said ON the named day: "last Wednesday" on a Wednesday means a week ago.
    expect(resolved({ todayLocal: WED_2026_07_15, weekday: 'wednesday', weeksAhead: -1 })).toEqual({
      date: '2026-07-08',
      weekday: 'wednesday',
    });
    // From Saturday Jul 18, "last Friday" is yesterday — the coming Friday is
    // 6 days out, minus 7 lands on the 17th.
    expect(resolved({ todayLocal: '2026-07-18', weekday: 'friday', weeksAhead: -1 })).toEqual({
      date: '2026-07-17',
      weekday: 'friday',
    });
  });

  test('non-integer or out-of-range dayShift is unresolvable', () => {
    expect(resolveDate({ todayLocal: WED_2026_07_15, dayShift: 1.5 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: WED_2026_07_15, dayShift: 999 }).status).toBe('unresolvable');
  });

  test('a bad reference date (server bug) refuses rather than guessing', () => {
    expect(resolveDate({ todayLocal: 'not-a-date', dayShift: 0 }).status).toBe('unresolvable');
  });
});

describe('resolveDate — calendar-period modes (month / quarter / year, 2026-08-12)', () => {
  // The date eval's finding: every calendar period above a week had NO path
  // through this tool, so the model invented the boundaries — correct in an
  // easy August, wrong the first February or year wrap. These anchors are
  // hand-computed like the rest of the file.
  function resolvedPeriod(p: ResolveDateParams) {
    const r = resolveDate(p);
    if (r.status !== 'resolved_period') throw new Error(`expected resolved_period, got: ${JSON.stringify(r)}`);
    return r;
  }

  test('month 0 / -1 / +1 from mid-July 2026', () => {
    const july = resolvedPeriod({ todayLocal: WED_2026_07_15, month: 0 });
    expect(july.periodStart).toBe('2026-07-01');
    expect(july.periodEnd).toBe('2026-07-31');
    expect(july.label).toBe('July 2026');
    // Jul 1 2026 is a Wednesday, Jul 31 a Friday — hand-checked.
    expect(july.phrase).toBe('Wednesday 2026-07-01 through Friday 2026-07-31 (July 2026)');

    const june = resolvedPeriod({ todayLocal: WED_2026_07_15, month: -1 });
    expect(june.periodStart).toBe('2026-06-01');
    expect(june.periodEnd).toBe('2026-06-30');
    expect(june.label).toBe('June 2026');

    const august = resolvedPeriod({ todayLocal: WED_2026_07_15, month: 1 });
    expect(august.periodStart).toBe('2026-08-01');
    expect(august.periodEnd).toBe('2026-08-31');
  });

  test('THE year-wrap trap: "last month" in January is December of the PREVIOUS year', () => {
    const r = resolvedPeriod({ todayLocal: '2026-01-15', month: -1 });
    expect(r.periodStart).toBe('2025-12-01');
    expect(r.periodEnd).toBe('2025-12-31');
    expect(r.label).toBe('December 2025');
  });

  test('February length comes from arithmetic, not a table — leap and non-leap', () => {
    expect(resolvedPeriod({ todayLocal: '2028-02-10', month: 0 }).periodEnd).toBe('2028-02-29');
    expect(resolvedPeriod({ todayLocal: '2026-02-10', month: 0 }).periodEnd).toBe('2026-02-28');
    // Reaching February from another month, both directions.
    expect(resolvedPeriod({ todayLocal: '2028-03-15', month: -1 }).periodEnd).toBe('2028-02-29');
    expect(resolvedPeriod({ todayLocal: '2027-12-05', month: 2 }).periodEnd).toBe('2028-02-29');
  });

  test('quarter 0 / -1 and the Q1→Q4 year wrap', () => {
    const q3 = resolvedPeriod({ todayLocal: WED_2026_07_15, quarter: 0 });
    expect(q3.periodStart).toBe('2026-07-01');
    expect(q3.periodEnd).toBe('2026-09-30');
    expect(q3.label).toBe('Q3 2026');

    const q2 = resolvedPeriod({ todayLocal: WED_2026_07_15, quarter: -1 });
    expect(q2.periodStart).toBe('2026-04-01');
    expect(q2.periodEnd).toBe('2026-06-30');
    expect(q2.label).toBe('Q2 2026');

    // "last quarter" asked in February = Q4 of the previous year.
    const q4prev = resolvedPeriod({ todayLocal: '2026-02-10', quarter: -1 });
    expect(q4prev.periodStart).toBe('2025-10-01');
    expect(q4prev.periodEnd).toBe('2025-12-31');
    expect(q4prev.label).toBe('Q4 2025');
  });

  test('year 0 / -1', () => {
    const thisYear = resolvedPeriod({ todayLocal: WED_2026_07_15, year: 0 });
    expect(thisYear.periodStart).toBe('2026-01-01');
    expect(thisYear.periodEnd).toBe('2026-12-31');
    expect(thisYear.label).toBe('2026');

    const lastYear = resolvedPeriod({ todayLocal: WED_2026_07_15, year: -1 });
    expect(lastYear.periodStart).toBe('2025-01-01');
    expect(lastYear.periodEnd).toBe('2025-12-31');
    expect(lastYear.label).toBe('2025');
  });

  test('every period phrase restates its own fields — nothing left to derive', () => {
    const cases: ResolveDateParams[] = [
      { todayLocal: WED_2026_07_15, month: -1 },
      { todayLocal: '2026-02-10', quarter: -1 },
      { todayLocal: WED_2026_07_15, year: 0 },
    ];
    for (const p of cases) {
      const r = resolvedPeriod(p);
      const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
      expect(r.phrase).toBe(
        `${cap(r.periodStartWeekday)} ${r.periodStart} through ${cap(r.periodEndWeekday)} ${r.periodEnd} (${r.label})`,
      );
    }
  });

  test('bounds refuse with steering text, like every other mode', () => {
    for (const [params, re] of [
      [{ todayLocal: WED_2026_07_15, month: 25 }, /month must be/],
      [{ todayLocal: WED_2026_07_15, month: -25 }, /month must be/],
      [{ todayLocal: WED_2026_07_15, quarter: 9 }, /quarter must be/],
      [{ todayLocal: WED_2026_07_15, year: -6 }, /year must be/],
      [{ todayLocal: WED_2026_07_15, month: 1.5 }, /month must be/],
    ] as Array<[ResolveDateParams, RegExp]>) {
      const r = resolveDate(params);
      expect(r.status).toBe('unresolvable');
      if (r.status === 'unresolvable') expect(r.reason).toMatch(re);
    }
  });

  test('period modes obey the exactly-one rule and are named in refusal strings', () => {
    expect(resolveDate({ todayLocal: WED_2026_07_15, month: 0, week: 0 }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: WED_2026_07_15, quarter: 0, weekday: 'friday' }).status).toBe('unresolvable');
    expect(resolveDate({ todayLocal: WED_2026_07_15, year: 0, month: 0 }).status).toBe('unresolvable');
    const none = resolveDate({ todayLocal: WED_2026_07_15 });
    if (none.status === 'unresolvable') expect(none.reason).toMatch(/month, quarter, or year/);
    const many = resolveDate({ todayLocal: WED_2026_07_15, month: 0, week: 0 });
    if (many.status === 'unresolvable') expect(many.reason).toMatch(/month, quarter, or year/);
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
