import { describe, expect, test } from 'vitest';
import { asNaiveLocal, dayEndNaive, dayStartNaive, naiveLocalISO, naiveWallClock, type NaiveLocal } from './time.js';
import { isTechnicianAvailableOn, localDateISO, localDayOfWeek, localTimeHHMM } from '../schedule/availability.js';
import type { Visit } from './visits.js';

// THE BRAND'S OWN TESTS — half of them are COMPILE-TIME.
//
// `@ts-expect-error` fails the build when the line it marks STOPS erroring
// ("TS2578: Unused '@ts-expect-error' directive"), and tsconfig includes all of
// `src`, so `npm run typecheck` runs them. That makes each one a live assertion
// that the door is still shut — delete the brand and this file goes red, which
// is exactly what a guard against silent removal has to do.
//
// They cost nothing at runtime: a brand is a compile-time label, and NaiveLocal
// is a plain string once tsc is done.

describe('the producers', () => {
  test('naiveLocalISO concatenates — no timezone math, ever', () => {
    expect(naiveLocalISO('2026-09-19', '09:00')).toBe('2026-09-19T09:00:00.000Z');
  });

  test('dayStartNaive / dayEndNaive are one day apart, end EXCLUSIVE', () => {
    expect(dayStartNaive('2026-09-19')).toBe('2026-09-19T00:00:00.000Z');
    expect(dayEndNaive('2026-09-19')).toBe('2026-09-20T00:00:00.000Z');
  });

  test('a day bound is DST-safe: these are wall clocks, so +24h is "same time tomorrow"', () => {
    // 2026-11-01 is the US fall-back day — a real LOCAL day there is 25 hours.
    // A naive-local bound must NOT care: the digits are the wall clock, parsed
    // as UTC where every day is exactly 24h, which is what makes the arithmetic
    // correct rather than accidentally correct.
    expect(dayEndNaive('2026-11-01')).toBe('2026-11-02T00:00:00.000Z');
    expect(dayEndNaive('2026-03-08')).toBe('2026-03-09T00:00:00.000Z'); // spring forward
  });
});

describe('the door: a wall clock may be read back, never converted', () => {
  const naive = naiveLocalISO('2026-09-19', '06:00');

  test('reading it back with the literal UTC is legal and is a no-op', () => {
    // This is what booking.ts's availability check and fit.ts's weekday lookups
    // do, and why they are correct: 'UTC' means "return the stored digits".
    expect(localDateISO(naive, 'UTC')).toBe('2026-09-19');
    expect(localTimeHHMM(naive, 'UTC')).toBe('06:00');
    expect(localDayOfWeek(naive, 'UTC')).toBe('sat');
  });

  test('a real instant still converts normally — no caller was disturbed', () => {
    // 02:00 UTC on the 19th is still the 18th in Los Angeles.
    expect(localDateISO('2026-09-19T02:00:00.000Z', 'America/Los_Angeles')).toBe('2026-09-18');
  });

  test('COMPILE-TIME: converting a wall clock with a real zone is refused', () => {
    // @ts-expect-error a NaiveLocal may not be converted with a firm timezone — this is
    // the v_schedule.local_day defect, and in TypeScript it now fails to compile.
    void (() => localDateISO(naive, 'America/Los_Angeles'));
    // @ts-expect-error same door, weekday form
    void (() => localDayOfWeek(naive, 'America/Los_Angeles'));
    // @ts-expect-error same door, time form
    void (() => localTimeHHMM(naive, 'America/Los_Angeles'));
    // @ts-expect-error and through the availability calculator, booking.ts's path
    void (() => isTechnicianAvailableOn(naive, null, [], 'America/Los_Angeles'));
    expect(true).toBe(true); // the assertions above are the test; this keeps vitest happy
  });

  test('COMPILE-TIME: the zone must be the LITERAL "UTC", not a string that happens to be it', () => {
    const zone: string = 'UTC'; // widened — the compiler can no longer see the value
    // @ts-expect-error a widened tz fails the narrow overload: the door needs the literal,
    // which is what stops `localDateISO(starts_at, tenant.timezone)` from ever type-checking.
    void (() => localDateISO(naive, zone));
    expect(zone).toBe('UTC');
  });
});

describe('the species boundary on the visit row', () => {
  test('COMPILE-TIME: a real instant may not be written into a visit time', () => {
    // @ts-expect-error created_at is a real moment; starts_at is a wall clock
    const bad: NaiveLocal = new Date().toISOString();
    void bad;
    // @ts-expect-error same refusal through the row type
    const alsoBad: Visit['starts_at'] = '2026-09-19T09:00:00.000Z';
    void alsoBad;
    expect(true).toBe(true);
  });

  test('a NaiveLocal is still a string at runtime — every reader is untouched', () => {
    const v = naiveLocalISO('2026-09-19', '14:30');
    expect(v.slice(0, 10)).toBe('2026-09-19');
    expect(v.slice(11, 16)).toBe('14:30');
    expect(Date.parse(v)).toBe(Date.parse('2026-09-19T14:30:00.000Z'));
  });

  test('asNaiveLocal is an assertion, and says so by being the only way to make one', () => {
    // The JSONB re-entry points (watchers, the cancel CAS) lose the type on the
    // round trip. `grep asNaiveLocal` is the list of places trusting convention.
    expect(asNaiveLocal('2026-09-19T09:00:00.000Z')).toBe('2026-09-19T09:00:00.000Z');
  });
});

describe('naiveWallClock — the only form a naive-local time may take in model-facing output', () => {
  test('drops the false offset, never converts', () => {
    // Every shape the DB or the code produces: '+00:00', fractional seconds, 'Z'.
    expect(naiveWallClock('2026-09-23T16:00:00+00:00')).toBe('2026-09-23 16:00');
    expect(naiveWallClock('2026-09-23T16:00:00.123+00:00')).toBe('2026-09-23 16:00');
    expect(naiveWallClock(naiveLocalISO('2026-09-23', '16:00'))).toBe('2026-09-23 16:00');
  });

  test('passes an untimed value through as null', () => {
    expect(naiveWallClock(null)).toBeNull();
    expect(naiveWallClock(undefined)).toBeNull();
  });
});
