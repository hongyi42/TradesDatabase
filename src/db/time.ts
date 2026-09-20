// THE TWO TIMESTAMP SPECIES, and the only doors that make one of them.
//
// This database holds two kinds of timestamp in one column type:
//
//   NAIVE-LOCAL   visits.starts_at, visits.ends_at, visits.completed_at
//                 The firm's WALL CLOCK written as if it were UTC. A 9 AM
//                 appointment in Los Angeles is stored '2026-09-19T09:00:00.000Z'
//                 and the 'Z' is DELIBERATELY FALSE. Chosen so that anything
//                 grouping by UTC calendar day gets the firm's local day for
//                 free, with no timezone arithmetic anywhere (20260714120000:11).
//
//   real instants created_at, captured_at, noticed_at, expires_at, now() — a
//                 moment, comparable across firms and servers. Not branded:
//                 plain `string`, as they always were.
//
// Mixing them is a silent 7-hour error for a Pacific firm in summer, 8 in
// winter — and a self-consistent one, so every surface agrees on the same wrong
// day and nothing downstream can notice. `NaiveLocal` makes the compiler notice.
//
// WHY THE 'Z' IS THERE AT ALL, since it is the root of the whole problem:
// per ECMA-262 a date-time string WITHOUT an offset is parsed on the HOST's
// clock, so '2026-09-19T09:00:00' means a different instant on a Tokyo laptop
// than on a UTC server. The suffix keeps the string absolute in JavaScript at
// the cost of being a lie in SQL. See availability.ts:8-27 and `parseAsUtc`.
// Postgres has `timestamp without time zone` for exactly this and we do not use
// it, which is why the guard has to be a type-level one here.
//
// THE BRAND IS COMPILE-TIME ONLY. `NaiveLocal` is a `string` at runtime, so
// `starts_at.slice(11, 16)` and `Date.parse(starts_at)` keep working untouched;
// what stops compiling is handing one to something that wants a real moment.
//
// WHAT THIS DOES NOT CATCH, stated plainly so nobody assumes otherwise:
//   - Cross-species COMPARISON. `Date.parse(s: string)` accepts a branded
//     string, so `Date.parse(created_at) < Date.parse(starts_at)` still
//     compiles. The six audited comparison sites remain guarded by comments.
//   - SQL. Views and RPCs derive days from these columns with no types at all,
//     and that is where this bug class has actually fired (v_schedule.local_day,
//     2026-08-06 to 2026-09-16). `src/db/scheduleViews.test.ts` guards that
//     layer instead.
//   - A wrong `tenants.timezone`. Every conversion here is only as right as
//     that one field, which nothing validates.
//
// This module imports NOTHING, deliberately: every layer may depend on it.

declare const NAIVE_LOCAL: unique symbol;

/**
 * The firm's wall clock written as if UTC — "2026-09-19T09:00:00.000Z" meaning
 * 9 AM to the firm, wherever the firm is. The trailing `Z` is false by design.
 */
export type NaiveLocal = string & { readonly [NAIVE_LOCAL]: 'naive-local' };

/**
 * THE storage form, and the primary producer. Pure string concatenation: zero
 * timezone math, because there is none to do — the caller already has the
 * firm's own date and time.
 *
 * (Lived at schedule/booking.ts:59 until 2026-09-20; it moved here so the db
 * layer could reach it without importing from schedule/. booking.ts re-exports
 * it, so its four importers are unchanged.)
 */
export function naiveLocalISO(date: string, hhmm: string): NaiveLocal {
  return `${date}T${hhmm}:00.000Z` as NaiveLocal;
}

/** Inclusive start of a firm-local calendar day. */
export const dayStartNaive = (localDate: string): NaiveLocal => naiveLocalISO(localDate, '00:00');

/**
 * EXCLUSIVE end of a firm-local calendar day — the NEXT day's 00:00.
 *
 * One convention, deliberately. Before 2026-09-20 eight sites hand-built these
 * bounds and did not agree: `daySource.ts` used an INCLUSIVE '23:59:59.999'
 * while everything else used the exclusive next midnight. Both are naive-local,
 * so the arithmetic is safe across DST — a naive value parsed as UTC plus 24h is
 * exactly "same wall-clock time tomorrow", which is what a day bound means here.
 */
export const dayEndNaive = (localDate: string): NaiveLocal =>
  new Date(Date.parse(dayStartNaive(localDate)) + 86_400_000).toISOString() as NaiveLocal;

/**
 * Re-assert the species on a value that lost its type on a round trip — out of
 * a JSONB `detail` blob, or back off the wire. This is an ASSERTION, not a
 * proof: it is the one greppable name for "we are trusting the convention
 * here", so `grep asNaiveLocal` lists every such place.
 */
export const asNaiveLocal = (s: string): NaiveLocal => s as NaiveLocal;

/** `asNaiveLocal` under a short name, for test fixtures that build literals. */
export const nl = asNaiveLocal;
