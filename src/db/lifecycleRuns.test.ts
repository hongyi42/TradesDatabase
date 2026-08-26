import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getClient } from './client.js';
import {
  findTickGaps,
  insertLifecycleRun,
  listLifecycleRuns,
  pruneLifecycleRuns,
} from './lifecycleRuns.js';

// findTickGaps is PURE — no stack needed, so it is tested unconditionally. The
// round-trip tests below hit the LOCAL stack (testEnvGuard enforces local-only).

describe('findTickGaps', () => {
  const at = (min: number) => ({ started_at: `2026-08-26T12:${String(min).padStart(2, '0')}:00.000Z` });

  test('an evenly-spaced series has no gaps', () => {
    expect(findTickGaps([at(0), at(5), at(10), at(15)])).toEqual([]);
  });

  test('a 20-minute hole reports the three ticks it swallowed', () => {
    const gaps = findTickGaps([at(0), at(5), at(25), at(30)]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toEqual({
      after: '2026-08-26T12:05:00.000Z',
      before: '2026-08-26T12:25:00.000Z',
      missedTicks: 3,
    });
  });

  // Render fires a */5 cron on its own schedule; a tick that lands at :06 is
  // late, not missing. Without the tolerance the report would stream permanent
  // one-tick holes and train the reader to ignore the alarming section.
  test('ordinary jitter inside the tolerance is not a gap', () => {
    expect(findTickGaps([at(0), at(7), at(12)])).toEqual([]);
  });

  test('a gap just past the tolerance still counts at least one missed tick', () => {
    const gaps = findTickGaps([at(0), at(9)]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].missedTicks).toBe(1);
  });

  test('fewer than two rows can have no gap between them', () => {
    expect(findTickGaps([])).toEqual([]);
    expect(findTickGaps([at(0)])).toEqual([]);
  });

  // A row whose timestamp does not parse must not become a NaN gap that reads as
  // a giant outage — the whole point of this function is to be believed.
  test('an unparseable timestamp is skipped, not reported as an outage', () => {
    expect(findTickGaps([{ started_at: 'not-a-date' }, at(30)])).toEqual([]);
  });
});

describe('lifecycle_runs round-trip', () => {
  // Every row this suite writes carries this marker so cleanup can find them
  // without touching real records on a stack that has some.
  const MARK = 'vitest-lifecycle-runs';
  const base = Date.parse('2026-08-26T00:00:00.000Z');
  const iso = (offsetMs: number) => new Date(base + offsetMs).toISOString();

  const clean = async () => {
    await getClient().from('lifecycle_runs').delete().eq('summary->>marker', MARK);
  };

  beforeAll(clean);
  afterAll(clean);

  test('an inserted run reads back, ascending by started_at', async () => {
    await insertLifecycleRun({
      startedAt: iso(5 * 60_000),
      finishedAt: iso(5 * 60_000 + 2_000),
      ok: true,
      summary: { marker: MARK, seq: 2 },
    });
    await insertLifecycleRun({
      startedAt: iso(0),
      finishedAt: iso(1_500),
      ok: false,
      summary: { marker: MARK, seq: 1 },
    });

    const rows = (await listLifecycleRuns(iso(-60_000))).filter(
      (r) => (r.summary as { marker?: string } | null)?.marker === MARK,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.summary as { seq: number }).seq)).toEqual([1, 2]);
    expect(rows[0].ok).toBe(false);
    // Both ends come from the CALLER's clock — the same clock
    // cost_events.occurred_at carries — so the stored window is exactly the one
    // a spend join will be measured against, not a second host's version of it.
    // Compared as INSTANTS: PostgREST renders timestamptz as '+00:00' while
    // toISOString() ends in 'Z' — the same moment, different text, and a string
    // compare here would fail for a reason that has nothing to do with clocks.
    expect(Date.parse(rows[0].started_at)).toBe(base);
    expect(Date.parse(rows[0].finished_at)).toBe(base + 1_500);
  });


  // A tick that does almost nothing (an off-cadence one) finishes in
  // milliseconds. With the two ends on different clocks the CHECK constraint
  // would reject exactly those rows whenever the hosts drifted — this is the
  // regression guard for that.
  test('a sub-second tick records without tripping the finished_at check', async () => {
    await insertLifecycleRun({
      startedAt: iso(0),
      finishedAt: iso(40),
      ok: true,
      summary: { marker: MARK, seq: 'fast' },
    });
    const rows = (await listLifecycleRuns(iso(-60_000))).filter(
      (r) => (r.summary as { seq?: unknown } | null)?.seq === 'fast',
    );
    expect(rows).toHaveLength(1);
  });

  test('the prune deletes only rows before the cutoff', async () => {
    await insertLifecycleRun({
      startedAt: iso(-40 * 24 * 3600_000),
      finishedAt: iso(-40 * 24 * 3600_000 + 1_000),
      ok: true,
      summary: { marker: MARK, seq: 'old' },
    });
    await insertLifecycleRun({
      startedAt: iso(0),
      finishedAt: iso(1_000),
      ok: true,
      summary: { marker: MARK, seq: 'new' },
    });

    // `>= 1`, not `=== 1`: pruneLifecycleRuns deletes by CUTOFF, not by marker,
    // and seed.mjs deliberately never truncates lifecycle_runs — so any local
    // cron run leaves rows this sweep legitimately also removes. Asserting an
    // exact count would make the test fail for a reason that is not a defect.
    // The behaviour under test is WHICH rows survive, so that is what is
    // asserted exactly.
    const deleted = await pruneLifecycleRuns(iso(-1 * 24 * 3600_000));
    expect(deleted).toBeGreaterThanOrEqual(1);

    const left = (await listLifecycleRuns(iso(-90 * 24 * 3600_000))).filter(
      (r) => (r.summary as { marker?: string } | null)?.marker === MARK,
    );
    expect(left.map((r) => (r.summary as { seq: unknown }).seq)).toContain('new');
    expect(left.map((r) => (r.summary as { seq: unknown }).seq)).not.toContain('old');
  });
});
