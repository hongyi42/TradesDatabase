import { describe, expect, test } from 'vitest';
import type { WeeklyPattern } from '../db/technicians.js';
import {
  isTechnicianAvailableOn,
  localDateISO,
  localDayOfWeek,
  summarizeWeeklyPattern,
} from './availability.js';

// Pure — no DB, no model. Locks the timezone/day math the scheduler will trust.
const LA = 'America/Los_Angeles';

const WEEKDAYS_ONLY: WeeklyPattern = {
  mon: [['08:00', '17:00']],
  tue: [['08:00', '17:00']],
  wed: [['08:00', '17:00']],
  thu: [['08:00', '17:00']],
  fri: [['08:00', '17:00']],
  sat: [],
  sun: [],
};

describe('localDayOfWeek / localDateISO', () => {
  test('an evening-UTC timestamp counts as the local day: 2026-07-11T02:00Z is Friday in LA', async () => {
    // 2026-07-11 02:00 UTC = 2026-07-10 19:00 PDT (Friday evening).
    expect(localDayOfWeek('2026-07-11T02:00:00Z', LA)).toBe('fri');
    expect(localDateISO('2026-07-11T02:00:00Z', LA)).toBe('2026-07-10');
    // Same instant in UTC is Saturday — the tz parameter is load-bearing.
    expect(localDayOfWeek('2026-07-11T02:00:00Z', 'UTC')).toBe('sat');
  });

  test('DST transition days resolve to the correct local weekday (edge-register item)', async () => {
    // Spring forward: 2026-03-08 (2nd Sunday of March). 10:01Z = 03:01 PDT —
    // the 02:00–03:00 local hour does not exist that day.
    expect(localDayOfWeek('2026-03-08T09:59:00Z', LA)).toBe('sun'); // 01:59 PST
    expect(localDayOfWeek('2026-03-08T10:01:00Z', LA)).toBe('sun'); // 03:01 PDT
    expect(localDateISO('2026-03-08T10:01:00Z', LA)).toBe('2026-03-08');
    // Fall back: 2026-11-01. 01:30 local happens twice (PDT then PST) — both
    // instants are still Sunday the 1st.
    expect(localDayOfWeek('2026-11-01T08:30:00Z', LA)).toBe('sun'); // 01:30 PDT
    expect(localDayOfWeek('2026-11-01T09:30:00Z', LA)).toBe('sun'); // 01:30 PST
    expect(localDateISO('2026-11-01T09:30:00Z', LA)).toBe('2026-11-01');
  });
});

describe('isTechnicianAvailableOn', () => {
  test('null pattern → false (fail closed: unset availability is unschedulable)', () => {
    expect(isTechnicianAvailableOn('2026-07-08T18:00:00Z', null, [], LA)).toBe(false);
  });

  test('malformed stored pattern → false, never a crash (fail closed on junk jsonb)', () => {
    // The column is plain jsonb — a dashboard edit can store shapes the typed
    // writer would reject. Missing day key must read as unavailable.
    const junk = {} as unknown as WeeklyPattern;
    expect(isTechnicianAvailableOn('2026-07-08T18:00:00Z', junk, [], LA)).toBe(false);
    const partial = { mon: 'not-an-array' } as unknown as WeeklyPattern;
    expect(isTechnicianAvailableOn('2026-07-06T18:00:00Z', partial, [], LA)).toBe(false); // a Monday
  });

  test('empty day array → false (Saturday for a weekdays-only pattern)', () => {
    // 2026-07-11 18:00 UTC = Saturday 11:00 PDT.
    expect(isTechnicianAvailableOn('2026-07-11T18:00:00Z', WEEKDAYS_ONLY, [], LA)).toBe(false);
  });

  test('pattern day with windows → true; timezone decides which day it is', () => {
    // Friday evening PDT (Saturday in UTC) → available under weekdays-only.
    expect(isTechnicianAvailableOn('2026-07-11T02:00:00Z', WEEKDAYS_ONLY, [], LA)).toBe(true);
    expect(isTechnicianAvailableOn('2026-07-11T02:00:00Z', WEEKDAYS_ONLY, [], 'UTC')).toBe(false);
  });

  test('date inside a time-off range → false; ranges are inclusive both ends', () => {
    const vacation = [{ starts_on: '2026-07-08', ends_on: '2026-07-10' }];
    // Wed 2026-07-08 local — first vacation day.
    expect(isTechnicianAvailableOn('2026-07-08T18:00:00Z', WEEKDAYS_ONLY, vacation, LA)).toBe(
      false,
    );
    // Fri evening 2026-07-10 local (02:00Z on the 11th) — last vacation day.
    expect(isTechnicianAvailableOn('2026-07-11T02:00:00Z', WEEKDAYS_ONLY, vacation, LA)).toBe(
      false,
    );
    // Mon 2026-07-13 local — back at work.
    expect(isTechnicianAvailableOn('2026-07-13T18:00:00Z', WEEKDAYS_ONLY, vacation, LA)).toBe(
      true,
    );
  });
});

// The summary line is what the manager actually reads, so the grouping rules
// are the contract — not an implementation detail.
describe('summarizeWeeklyPattern', () => {
  const mk = (over: Partial<WeeklyPattern>): WeeklyPattern => ({
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: [],
    ...over,
  });

  test('collapses a standard week into one range plus a trailing off clause', () => {
    expect(summarizeWeeklyPattern(WEEKDAYS_ONLY)).toBe('Mon–Fri 08:00–17:00; Sat, Sun off');
  });

  test('never-configured reads as null, not as "no days"', () => {
    // The caller reports configured:false from this; an unconfigured person is
    // the normal pre-setup state, not an error.
    expect(summarizeWeeklyPattern(null)).toBeNull();
  });

  test('a pattern with every day empty is distinguishable from unconfigured', () => {
    expect(summarizeWeeklyPattern(mk({}))).toBe('Not working any day');
  });

  test('two same-window days list rather than forming a range', () => {
    expect(summarizeWeeklyPattern(mk({ mon: [['09:00', '12:00']], tue: [['09:00', '12:00']] }))).toBe(
      'Mon, Tue 09:00–12:00; Wed, Thu, Fri, Sat, Sun off',
    );
  });

  test('a split shift keeps both windows on the day', () => {
    expect(
      summarizeWeeklyPattern(mk({ wed: [['08:00', '12:00'], ['13:00', '17:00']] })),
    ).toBe('Wed 08:00–12:00, 13:00–17:00; Mon, Tue, Thu, Fri, Sat, Sun off');
  });

  test('differing windows break the run into separate clauses', () => {
    expect(
      summarizeWeeklyPattern(
        mk({ mon: [['08:00', '17:00']], tue: [['08:00', '17:00']], wed: [['10:00', '14:00']] }),
      ),
    ).toBe('Mon, Tue 08:00–17:00; Wed 10:00–14:00; Thu, Fri, Sat, Sun off');
  });

  test('an end-of-day 24:00 window renders verbatim', () => {
    expect(summarizeWeeklyPattern(mk({ fri: [['16:00', '24:00']] }))).toBe(
      'Fri 16:00–24:00; Mon, Tue, Wed, Thu, Sat, Sun off',
    );
  });

  test('working every day produces no off clause', () => {
    const all = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
    const seven = Object.fromEntries(all.map((d) => [d, [['08:00', '17:00']]])) as WeeklyPattern;
    expect(summarizeWeeklyPattern(seven)).toBe('Mon–Sun 08:00–17:00');
  });

  test('malformed jsonb degrades to "off", never throws', () => {
    // The column is plain jsonb; a dashboard edit or partial write must not be
    // able to crash a roster read. Same fail-closed rule as
    // isTechnicianAvailableOn.
    const junk = {
      mon: 'not-an-array',
      tue: [['08:00']],
      wed: [[1, 2]],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    } as unknown as WeeklyPattern;
    expect(summarizeWeeklyPattern(junk)).toBe('Not working any day');
  });
});
