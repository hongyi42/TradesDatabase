import { describe, expect, it } from 'vitest';
import { resolveDate } from '../schedule/dateResolve.js';
import { buildDateMatrix, gradeDateCase, REFERENCE_DAYS, todayFor } from './dateMatrix.js';
import { WEEKDAYS, weekdayOf } from './clock.js';

// The matrix runs here as well as in the eval report, deliberately: inside the
// suite it is a REGRESSION gate on the date machinery (any change to
// dateResolve.ts that breaks a calendar trap fails `npm test`), and inside the
// eval it is a measured accuracy number. Same cases, two audiences.

const cases = buildDateMatrix();

describe('date matrix — coverage of the corpus itself', () => {
  it('exercises all seven weekdays as reference days', () => {
    const covered = new Set(REFERENCE_DAYS.map(weekdayOf));
    expect([...covered].sort()).toEqual([...WEEKDAYS].sort());
  });

  it('covers every resolver mode', () => {
    const groups = new Set(cases.map((c) => c.group));
    expect([...groups].sort()).toEqual([
      'dayShift',
      'explicit',
      'invalid',
      'month',
      'quarter',
      'week',
      'weekday',
      'year',
    ]);
  });

  it('has unique ids', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is big enough to be worth running', () => {
    expect(cases.length).toBeGreaterThan(250);
  });
});

describe('date matrix — the real resolver agrees', () => {
  for (const c of cases) {
    it(`${c.id} (${c.phrase})`, () => {
      const actual = resolveDate({ todayLocal: todayFor(c), ...c.params });
      const failure = gradeDateCase(c, actual);
      expect(failure, `${c.id} "${c.phrase}" ${JSON.stringify(c.params)}`).toBeNull();
    });
  }
});

describe('gradeDateCase — the grader itself fails when it should', () => {
  // A grader nobody has watched reject anything is not a grader. These pin that
  // each check can actually fire, so a silently-always-passing grader (the worst
  // possible bug in an eval) cannot survive.
  const dayCase = cases.find((c) => c.group === 'dayShift')!;
  const weekCase = cases.find((c) => c.group === 'week' && c.expected.kind === 'week' && c.expected.ambiguous)!;
  const periodCase = cases.find((c) => c.group === 'month')!;

  it('rejects a wrong date', () => {
    expect(gradeDateCase(dayCase, { status: 'resolved', date: '1999-01-01', weekday: 'friday', phrase: 'x' })).toMatch(/date/);
  });

  it('rejects a right date with the wrong weekday — the fabrication case', () => {
    const good = resolveDate({ todayLocal: todayFor(dayCase), ...dayCase.params }) as Record<string, unknown>;
    const lied = { ...good, weekday: good.weekday === 'monday' ? 'tuesday' : 'monday' };
    expect(gradeDateCase(dayCase, lied)).toMatch(/weekday/);
  });

  it('rejects a phrase that disagrees with its own date', () => {
    const good = resolveDate({ todayLocal: todayFor(dayCase), ...dayCase.params }) as Record<string, unknown>;
    expect(gradeDateCase(dayCase, { ...good, phrase: 'Someday 2026-01-01' })).toMatch(/phrase/);
  });

  it('rejects a weekend week range that came back unflagged', () => {
    const good = resolveDate({ todayLocal: todayFor(weekCase), ...weekCase.params }) as Record<string, unknown>;
    const unflagged = { ...good };
    delete unflagged.boundaryAmbiguous;
    expect(gradeDateCase(weekCase, unflagged)).toMatch(/UNFLAGGED/);
  });

  it('rejects an ambiguous result with no alternate to offer', () => {
    const good = resolveDate({ todayLocal: todayFor(weekCase), ...weekCase.params }) as Record<string, unknown>;
    const noAlt = { ...good };
    delete noAlt.alternate;
    expect(gradeDateCase(weekCase, noAlt)).toMatch(/alternate/);
  });

  it('rejects a resolved answer where a refusal was required', () => {
    const invalid = cases.find((c) => c.group === 'invalid')!;
    expect(gradeDateCase(invalid, { status: 'resolved', date: '2026-08-13' })).toMatch(/expected unresolvable/);
  });

  it('rejects a refusal with no reason to relay', () => {
    const invalid = cases.find((c) => c.group === 'invalid')!;
    expect(gradeDateCase(invalid, { status: 'unresolvable' })).toMatch(/no reason/);
  });

  it('rejects a wrong period label', () => {
    const good = resolveDate({ todayLocal: todayFor(periodCase), ...periodCase.params }) as Record<string, unknown>;
    expect(gradeDateCase(periodCase, { ...good, label: 'Marchtober 2026' })).toMatch(/label/);
  });

  it('rejects a missing result outright', () => {
    expect(gradeDateCase(dayCase, null)).toMatch(/no result/);
    expect(gradeDateCase(dayCase, 'nope')).toMatch(/no result/);
  });
});
