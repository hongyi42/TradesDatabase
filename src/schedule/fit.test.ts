import { describe, expect, test, vi } from 'vitest';
import type { WeeklyPattern } from '../db/technicians.js';
import type { PlacedAssignment } from '../db/index.js';
import type { RouteStop } from '../routes/deepLink.js';
import {
  clampRowToDay,
  dayWindows,
  DENSE_DAY_STOPS,
  DRIVE_MEASURE_TOP,
  freeGaps,
  generateCandidates,
  measureDriveDeltas,
  sortCandidates,
  techDateKey,
  type FitTechnician,
  type GenerateCandidatesInput,
  type SlotCandidate,
} from './fit.js';

// Pure engine tests — no DB, no clock: today/now are inputs (fake-clock rule).
// Scoring tests pin ORDER, never raw weight numbers (the plan's contract).

const MON_FRI: WeeklyPattern = {
  mon: [['08:00', '17:00']],
  tue: [['08:00', '17:00']],
  wed: [['08:00', '17:00']],
  thu: [['08:00', '17:00']],
  fri: [['08:00', '17:00']],
  sat: [],
  sun: [],
};

// 2026-07-20 is a Monday — the whole suite anchors on that week.
const TODAY = '2026-07-20';

const tech = (over: Partial<FitTechnician> = {}): FitTechnician => ({
  ref: 'bob',
  name: 'Bob',
  pattern: MON_FRI,
  timeOffDates: new Set(),
  visitsByDate: new Map(),
  citiesByDate: new Map(),
  serviceCities: [],
  stopsByDate: new Map(),
  commitmentsByDate: new Map(),
  ...over,
});

const baseInput = (over: Partial<GenerateCandidatesInput> = {}): GenerateCandidatesInput => ({
  todayISO: TODAY,
  nowHHMM: '00:00',
  earliest: TODAY,
  latest: '2026-07-24',
  durationMin: 120,
  durationLabel: '2h repair',
  customerCity: null,
  priority: 'routine',
  technicians: [tech()],
  ...over,
});

describe('freeGaps', () => {
  test('subtracts visits, keeps only gaps >= duration, handles edge-touching visits', () => {
    const gaps = freeGaps(
      [['08:00', '17:00']],
      [
        { start: '08:00', end: '10:00' }, // touches window start — no zero-gap emitted
        { start: '12:00', end: '13:00' },
      ],
      60,
    );
    expect(gaps).toEqual([
      { start: '10:00', end: '12:00', minutes: 120 },
      { start: '13:00', end: '17:00', minutes: 240 },
    ]);
  });

  test('gap-too-small is dropped; empty day yields nothing', () => {
    expect(
      freeGaps([['08:00', '10:00']], [{ start: '08:00', end: '09:30' }], 60),
    ).toEqual([]);
    expect(freeGaps([], [], 60)).toEqual([]);
  });

  test("a '24:00' window end is representable and the gap emits a bookable end", () => {
    const gaps = freeGaps([['16:00', '24:00']], [], 480);
    expect(gaps).toEqual([{ start: '16:00', end: '23:59', minutes: 480 }]);
  });

  test('notBefore trims day-0 gap starts (the "now" clamp)', () => {
    const gaps = freeGaps([['08:00', '17:00']], [], 60, '14:30');
    expect(gaps).toEqual([{ start: '14:30', end: '17:00', minutes: 150 }]);
    // Entirely-past window disappears rather than surfacing a past slot.
    expect(freeGaps([['08:00', '12:00']], [], 60, '13:00')).toEqual([]);
  });

  test('overlapping visits merge correctly against the cursor', () => {
    const gaps = freeGaps(
      [['08:00', '17:00']],
      [
        { start: '09:00', end: '12:00' },
        { start: '11:00', end: '13:00' }, // overlaps the previous one
      ],
      30,
    );
    expect(gaps).toEqual([
      { start: '08:00', end: '09:00', minutes: 60 },
      { start: '13:00', end: '17:00', minutes: 240 },
    ]);
  });
});

describe('dayWindows', () => {
  test('resolves the naive-local weekday (2026-07-20 = Monday, 07-25 = Saturday)', () => {
    expect(dayWindows(MON_FRI, '2026-07-20')).toEqual([['08:00', '17:00']]);
    expect(dayWindows(MON_FRI, '2026-07-25')).toEqual([]);
  });
});

describe('clampRowToDay', () => {
  const row = (starts: string, ends: string) =>
    ({ starts_at: starts, ends_at: ends }) as unknown as PlacedAssignment;

  test('within-day row keeps its HH:MM span; non-overlapping day is null', () => {
    const r = row('2026-07-21T09:00:00.000Z', '2026-07-21T11:00:00.000Z');
    expect(clampRowToDay(r, '2026-07-21')).toEqual({ start: '09:00', end: '11:00' });
    expect(clampRowToDay(r, '2026-07-22')).toBeNull();
  });

  test('a midnight-crossing row blocks BOTH days (overlap, not start-day, semantics)', () => {
    const r = row('2026-07-21T22:00:00.000Z', '2026-07-22T02:00:00.000Z');
    expect(clampRowToDay(r, '2026-07-21')).toEqual({ start: '22:00', end: '24:00' });
    expect(clampRowToDay(r, '2026-07-22')).toEqual({ start: '00:00', end: '02:00' });
  });

  test("DB wire format ('+00:00', no ms) at midnight boundaries clamps correctly", () => {
    // PostgREST renders timestamptz with an offset suffix, not '.000Z' — the
    // formats must compare as instants (review finding: string comparison made
    // a next-day-midnight start block the whole previous day).
    const nextMidnight = row('2026-08-04T00:00:00+00:00', '2026-08-04T02:00:00+00:00');
    expect(clampRowToDay(nextMidnight, '2026-08-03')).toBeNull();
    expect(clampRowToDay(nextMidnight, '2026-08-04')).toEqual({ start: '00:00', end: '02:00' });
    // Ending exactly AT midnight blocks its own evening with a non-inverted
    // span ('24:00', never '00:00' — freeGaps would silently drop the latter).
    const toMidnight = row('2026-08-03T22:00:00+00:00', '2026-08-04T00:00:00+00:00');
    expect(clampRowToDay(toMidnight, '2026-08-03')).toEqual({ start: '22:00', end: '24:00' });
    expect(clampRowToDay(toMidnight, '2026-08-04')).toBeNull();
  });
});

describe('unplaced commitments — load without shape (plan 4b-2 Phase 4)', () => {
  test('a day with 3 unplaced commitments scores below an identical empty day, stays day-level, and is never called empty', () => {
    const loaded = tech({
      ref: 'loaded',
      name: 'Loaded',
      commitmentsByDate: new Map([['2026-07-21', 3]]),
    });
    const empty = tech({ ref: 'empty', name: 'Empty' });
    const cands = generateCandidates(
      baseInput({
        earliest: '2026-07-21',
        latest: '2026-07-21',
        technicians: [loaded, empty],
      }),
    );
    const loadedCand = cands.find((c) => c.technicianRef === 'loaded');
    const emptyCand = cands.find((c) => c.technicianRef === 'empty');
    expect(loadedCand).toBeDefined();
    expect(emptyCand).toBeDefined();
    // Weight: the committed day scores strictly lower.
    expect((loadedCand as SlotCandidate).score).toBeLessThan((emptyCand as SlotCandidate).score);
    // But NOT shape: zero placed stops keeps it a day-level candidate.
    expect((loadedCand as SlotCandidate).dayLevel).toBe(true);
    // And it is never described as empty.
    expect((loadedCand as SlotCandidate).reasons.join(' ')).not.toContain('day is empty');
    expect((loadedCand as SlotCandidate).reasons.join(' ')).toContain('3 other visit(s)');
    expect((emptyCand as SlotCandidate).reasons.join(' ')).toContain('day is empty');
  });
});

describe('generateCandidates — DENSITY decides the mode, never the date', () => {
  test('an empty day TOMORROW is day-level; a packed day 10 days out gets concrete gap slots', () => {
    // Tomorrow, zero visits → OPEN day: one day-level candidate despite being
    // nearly today (closeness was only ever a proxy — user correction).
    const tomorrow = '2026-07-21';
    const open = generateCandidates(baseInput({ earliest: tomorrow, latest: tomorrow }));
    expect(open).toHaveLength(1);
    expect(open[0].dayLevel).toBe(true);
    expect(open[0].reasons[0]).toContain('quote the DAY');

    // 2026-07-30 (Thursday, 10 days out) with DENSE_DAY_STOPS visits → the day
    // has shape: one CONCRETE candidate per fitting gap, no day-level vagueness.
    const packedDay = '2026-07-30';
    const packed = tech({
      visitsByDate: new Map([
        [packedDay, [{ start: '10:00', end: '11:00' }, { start: '11:30', end: '14:00' }]],
      ]),
      stopsByDate: new Map([[packedDay, DENSE_DAY_STOPS]]),
    });
    const dense = generateCandidates(
      baseInput({ earliest: packedDay, latest: packedDay, technicians: [packed] }),
    );
    // Gaps: 08:00–10:00 (fits 2h) and 14:00–17:00; 11:00–11:30 too small.
    expect(dense).toHaveLength(2);
    expect(dense.every((c) => !c.dayLevel)).toBe(true);
    expect(dense.map((c) => c.startTime).sort()).toEqual(['08:00', '14:00']);
  });

  test('every emitted slot is bookable verbatim: 24:00-edge emits 23:59', () => {
    const evening: WeeklyPattern = { ...MON_FRI, mon: [['16:00', '24:00']] };
    const cands = generateCandidates(
      baseInput({ durationMin: 480, durationLabel: '8h install', technicians: [tech({ pattern: evening })], latest: TODAY }),
    );
    expect(cands).toHaveLength(1);
    expect(cands[0].endTime).toBe('23:59');
  });

  test('day-0 slots start no earlier than now; time off and non-working days are skipped', () => {
    const cands = generateCandidates(
      baseInput({
        nowHHMM: '15:00',
        latest: '2026-07-22',
        technicians: [tech({ timeOffDates: new Set(['2026-07-21']) })],
      }),
    );
    const dates = cands.map((c) => `${c.date}@${c.startTime}`);
    expect(dates).toContain('2026-07-20@15:00'); // trimmed to now, not 08:00
    expect(dates.some((d) => d.startsWith('2026-07-21'))).toBe(false); // time off
    expect(dates).toContain('2026-07-22@08:00'); // future day untrimmed
  });

  test('duration label is fused into every reason string (server-composed disclosure)', () => {
    const cands = generateCandidates(baseInput({ durationLabel: '5h drainage replacement' }));
    for (const c of cands) {
      expect(c.reasons[0]).toContain('5h drainage replacement');
    }
  });

  test('every emitted date carries its SERVER-computed weekday (field + fused reason prefix)', () => {
    // Live finding 2026-07-21: the agent relabeled every candidate one weekday
    // early ("Sunday" for a Monday slot). The server now leaves it no calendar
    // math to do — the weekday rides in the payload AND leads the reason text.
    const cands = generateCandidates(baseInput({ latest: '2026-07-24' }));
    expect(cands.length).toBeGreaterThan(0);
    const expected = new Map([
      ['2026-07-20', 'Mon'],
      ['2026-07-21', 'Tue'],
      ['2026-07-22', 'Wed'],
      ['2026-07-23', 'Thu'],
      ['2026-07-24', 'Fri'],
    ]);
    for (const c of cands) {
      expect(c.weekday).toBe(expected.get(c.date));
      expect(c.reasons[0].startsWith(`${c.weekday} ${c.date} `)).toBe(true);
    }
  });
});

describe('generateCandidates — scoring ORDER', () => {
  // Honesty rule for this block (review finding): the sort tiebreak is
  // date-then-startTime ASC, so every expected winner below must LOSE the
  // tiebreak — otherwise deleting a weight entirely still passes the test.

  test('earliness is priority-scaled: emergency takes the earlier day, routine trades it away', () => {
    // Same fixture, opposite winners by priority — neither outcome can come
    // from the tiebreak. 'near' is free TODAY only (wrong city); 'far' is free
    // Wednesday only, in the customer's city.
    const monOnly: WeeklyPattern = { ...MON_FRI, tue: [], wed: [], thu: [], fri: [] };
    const wedOnly: WeeklyPattern = { ...MON_FRI, mon: [], tue: [], thu: [], fri: [] };
    const fixture = {
      customerCity: 'springfield',
      technicians: [
        tech({ ref: 'near', name: 'Near', pattern: monOnly }),
        tech({ ref: 'far', name: 'Far', pattern: wedOnly, serviceCities: ['springfield'] }),
      ],
    };
    // Steep emergency earliness (2 days) outweighs the same-city bonus…
    expect(generateCandidates(baseInput({ ...fixture, priority: 'emergency' }))[0].technicianRef)
      .toBe('near');
    // …while shallow routine earliness loses the same trade (LATER day wins).
    expect(generateCandidates(baseInput({ ...fixture, priority: 'routine' }))[0].technicianRef)
      .toBe('far');
  });

  test('morning preference: routine scores the morning gap higher; emergencies are indifferent', () => {
    // Two visits make the day DENSE, so both gaps emit as concrete candidates
    // on the SAME day with the SAME stop count — only MORNING_BONUS differs.
    const busy = tech({
      visitsByDate: new Map([
        [TODAY, [{ start: '10:00', end: '11:00' }, { start: '11:30', end: '14:00' }]],
      ]),
      stopsByDate: new Map([[TODAY, 2]]),
    });
    const routine = generateCandidates(baseInput({ latest: TODAY, technicians: [busy] }));
    const morning = routine.find((c) => c.startTime === '08:00');
    const afternoon = routine.find((c) => c.startTime === '14:00');
    expect(morning && afternoon).toBeTruthy();
    expect(morning!.score).toBeGreaterThan(afternoon!.score);
    // The front-load doctrine is routine/maintenance-only: an emergency sees
    // both gaps as equals (afternoons stay loose to absorb it, not for it).
    const emergency = generateCandidates(
      baseInput({ latest: TODAY, technicians: [busy], priority: 'emergency' }),
    );
    expect(new Set(emergency.map((c) => c.score)).size).toBe(1);
  });

  test('a lighter day outranks a heavier day even when the heavier day sorts first on the tiebreak', () => {
    // busy's first gap starts 09:00; free's window starts 09:30 — the
    // startTime tiebreak would pick busy, so only LIGHT_DAY_PER_STOP can
    // put free first.
    const lateStart: WeeklyPattern = { ...MON_FRI, mon: [['09:30', '17:00']] };
    const busy = tech({
      ref: 'busy',
      name: 'Busy',
      visitsByDate: new Map([[TODAY, [{ start: '08:00', end: '09:00' }]]]),
      stopsByDate: new Map([[TODAY, 1]]),
    });
    const cands = generateCandidates(
      baseInput({
        latest: TODAY,
        technicians: [tech({ ref: 'free', name: 'Free', pattern: lateStart }), busy],
      }),
    );
    expect(cands[0].technicianRef).toBe('free');
  });

  test('same-city bonus applies from that day\'s visits OR the tech\'s service cities', () => {
    const inTown = tech({
      ref: 'local',
      name: 'Local',
      citiesByDate: new Map([[TODAY, new Set(['springfield'])]]),
    });
    const coverage = tech({ ref: 'covers', name: 'Covers', serviceCities: ['springfield'] });
    const nowhere = tech({ ref: 'far', name: 'Far' });
    const cands = generateCandidates(
      baseInput({
        latest: TODAY,
        customerCity: 'springfield',
        technicians: [nowhere, inTown, coverage],
      }),
    );
    const [first, second, third] = cands.map((c) => c.technicianRef);
    expect([first, second]).toEqual(expect.arrayContaining(['local', 'covers']));
    expect(third).toBe('far');
  });

  test('drive delta demotes through the ENGINE comparator (Phase-2 contract)', () => {
    const cands = generateCandidates(
      baseInput({ latest: TODAY, technicians: [tech({ ref: 'a', name: 'A' }), tech({ ref: 'b', name: 'B' })] }),
    );
    // Equal scores initially (stable order a, b). Phase 2 subtracts a measured
    // delta and re-sorts with the SAME exported comparator the engine uses —
    // this pins that a score drop outranks the date/startTime tiebreaks.
    cands[0].score -= 22;
    const resorted = sortCandidates(cands);
    expect(resorted[0].technicianRef).toBe(cands[1].technicianRef);
  });
});

// ---------------------------------------------------------------------------
// measureDriveDeltas (Phase 2) — fake ComputeRoutes, no key, no network

const rstop = (label: string, address: string | null = `${label} St, Fresno, CA`): RouteStop => ({
  label,
  address,
});
const NEW_STOP = rstop('New Customer', '900 New Rd, Fresno, CA');

const slot = (over: Partial<SlotCandidate> = {}): SlotCandidate => ({
  technicianRef: 'bob',
  technicianName: 'Bob',
  date: '2026-07-30',
  weekday: 'Thu', // 2026-07-30 is a Thursday
  startTime: '08:00',
  endTime: '10:00',
  dayLevel: false,
  score: 0,
  reasons: ['fits'],
  driveDeltaMinutes: null,
  driveMeasured: false,
  warnings: [],
  ...over,
});

// Fake Google: WITH-routes (an intermediate carries the new stop's address)
// total 62 min, WITHOUT-routes 40 min → delta 22. Permutation-valid response.
type RoutesBody = { origin: { address: string }; destination: { address: string }; intermediates: { address: string }[] };
const fakeRoutes = () =>
  vi.fn(async (body: unknown) => {
    const b = body as RoutesBody;
    const isWith = b.intermediates.some((i) => i.address === NEW_STOP.address);
    return {
      routes: [
        {
          optimizedIntermediateWaypointIndex: b.intermediates.map((_, i) => i),
          legs: [],
          duration: `${(isWith ? 62 : 40) * 60}s`,
        },
      ],
    };
  });

describe('measureDriveDeltas', () => {
  const key = techDateKey('bob', '2026-07-30');
  const threeStops = [rstop('A'), rstop('B'), rstop('C')];

  test('≥3-stop day: true delta, new stop rides as an INTERMEDIATE only, demotion re-sorts', async () => {
    const computeRoutes = fakeRoutes();
    const dense = slot({ score: 5 }); // pre-scored above the rival...
    const rival = slot({ technicianRef: 'ann', technicianName: 'Ann', date: '2026-07-31' });
    const out = await measureDriveDeltas(
      {
        candidates: [dense, rival],
        stopsByTechDate: new Map([[key, threeStops]]),
        newStop: NEW_STOP,
      },
      { computeRoutes },
    );
    const measured = out.find((c) => c.technicianRef === 'bob')!;
    expect(measured.driveMeasured).toBe(true);
    expect(measured.driveDeltaMinutes).toBe(22);
    expect(measured.score).toBe(5 - 22);
    expect(measured.reasons.some((r) => r.includes('adds ~22 min'))).toBe(true);
    // ...but the 22-minute detour demotes it below the unmeasured rival.
    expect(out[0].technicianRef).toBe('ann');

    // Request shape: the new stop appears ONLY as an intermediate; the
    // endpoints stay pinned to the SAME existing first/last in both calls.
    const bodies = computeRoutes.mock.calls.map(([b]) => b as RoutesBody);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b.origin.address).toBe(threeStops[0].address);
      expect(b.destination.address).toBe(threeStops[2].address);
    }
    const withBody = bodies.find((b) => b.intermediates.some((i) => i.address === NEW_STOP.address))!;
    const withoutBody = bodies.find((b) => b !== withBody)!;
    expect(withBody.intermediates.map((i) => i.address)).toContain(NEW_STOP.address);
    expect(withBody.intermediates).toHaveLength(2);
    expect(withoutBody.intermediates).toHaveLength(1);
  });

  test('exactly-2-stop day: with-only measurement, "route becomes", delta stays null', async () => {
    const computeRoutes = fakeRoutes();
    const out = await measureDriveDeltas(
      {
        candidates: [slot()],
        stopsByTechDate: new Map([[key, [rstop('A'), rstop('B')]]]),
        newStop: NEW_STOP,
      },
      { computeRoutes },
    );
    expect(computeRoutes).toHaveBeenCalledTimes(1); // no unmeasurable without-call
    expect(out[0].driveMeasured).toBe(true);
    expect(out[0].driveDeltaMinutes).toBeNull();
    expect(out[0].score).toBe(0); // nothing to subtract — no phantom scoring
    expect(out[0].reasons.some((r) => r.includes('route becomes ~62 min'))).toBe(true);
  });

  test('0–1 routable stops: NO api call, driveMeasured false, and no "null min" strings', async () => {
    const computeRoutes = fakeRoutes();
    // One routable + one address-less stop → routable count 1.
    const out = await measureDriveDeltas(
      {
        candidates: [slot()],
        stopsByTechDate: new Map([[key, [rstop('A'), rstop('NoAddr', null)]]]),
        newStop: NEW_STOP,
      },
      { computeRoutes },
    );
    expect(computeRoutes).not.toHaveBeenCalled();
    expect(out[0].driveMeasured).toBe(false);
    expect(out[0].driveDeltaMinutes).toBeNull();
    for (const s of [...out[0].reasons, ...out[0].warnings]) {
      expect(s).not.toMatch(/null/);
    }
  });

  test('cap: only the top DRIVE_MEASURE_TOP candidates get calls', async () => {
    const computeRoutes = fakeRoutes();
    // 7 measurable candidates on 7 distinct days, strictly descending scores.
    const candidates = Array.from({ length: 7 }, (_, i) =>
      slot({ date: `2026-08-1${i}`, score: 70 - i * 10 }),
    );
    const stopsByTechDate = new Map(
      candidates.map((c) => [techDateKey('bob', c.date), threeStops]),
    );
    const out = await measureDriveDeltas(
      { candidates, stopsByTechDate, newStop: NEW_STOP },
      { computeRoutes },
    );
    expect(computeRoutes).toHaveBeenCalledTimes(DRIVE_MEASURE_TOP * 2);
    expect(out.filter((c) => c.driveMeasured)).toHaveLength(DRIVE_MEASURE_TOP);
    expect(out.filter((c) => !c.driveMeasured)).toHaveLength(2);
  });

  test('cap boundary: an over-cap sibling gap on an already-measured day absorbs the cached delta', async () => {
    const computeRoutes = fakeRoutes();
    // Ranks 1–4 on distinct days; ranks 5 AND 6 are two gaps on the same day.
    // The cap admits rank 5 only, but rank 6 needs no new calls — the day's
    // numbers are cached, and skipping it would rank the unmeasured twin
    // above its measured sibling despite identical real driving.
    const sharedDay = '2026-08-20';
    const candidates = [
      ...Array.from({ length: 4 }, (_, i) => slot({ date: `2026-08-1${i}`, score: 90 - i * 10 })),
      slot({ date: sharedDay, startTime: '08:00', score: 50 }),
      slot({ date: sharedDay, startTime: '14:00', score: 40 }),
    ];
    const stopsByTechDate = new Map(
      candidates.map((c) => [techDateKey('bob', c.date), threeStops]),
    );
    const out = await measureDriveDeltas(
      { candidates, stopsByTechDate, newStop: NEW_STOP },
      { computeRoutes },
    );
    expect(computeRoutes).toHaveBeenCalledTimes(DRIVE_MEASURE_TOP * 2); // cap holds
    expect(out.filter((c) => c.driveMeasured)).toHaveLength(6); // all coherent
    expect(out.every((c) => c.driveDeltaMinutes === 22)).toBe(true);
  });

  test('same-day candidates share one measurement (day-level cache)', async () => {
    const computeRoutes = fakeRoutes();
    const out = await measureDriveDeltas(
      {
        candidates: [slot({ startTime: '08:00' }), slot({ startTime: '14:00' })],
        stopsByTechDate: new Map([[key, threeStops]]),
        newStop: NEW_STOP,
      },
      { computeRoutes },
    );
    expect(computeRoutes).toHaveBeenCalledTimes(2); // with + without, ONCE
    expect(out.every((c) => c.driveMeasured && c.driveDeltaMinutes === 22)).toBe(true);
  });

  test('Google failure degrades that candidate, never eats the answer', async () => {
    const computeRoutes = vi.fn().mockRejectedValue(new Error('computeRoutes failed: HTTP 500'));
    const out = await measureDriveDeltas(
      {
        candidates: [slot({ reasons: ['fits'] })],
        stopsByTechDate: new Map([[key, threeStops]]),
        newStop: NEW_STOP,
      },
      { computeRoutes },
    );
    expect(out).toHaveLength(1); // candidate survives
    expect(out[0].driveMeasured).toBe(false);
    expect(out[0].warnings).toContain('drive not measured (routing service error)');
  });

  test('unroutable new customer: no calls, an address-incomplete warning', async () => {
    const computeRoutes = fakeRoutes();
    const out = await measureDriveDeltas(
      {
        candidates: [slot()],
        stopsByTechDate: new Map([[key, threeStops]]),
        newStop: rstop('No Address', null),
      },
      { computeRoutes },
    );
    expect(computeRoutes).not.toHaveBeenCalled();
    expect(out[0].driveMeasured).toBe(false);
    expect(out[0].warnings).toContain('customer address incomplete — drive not measured');
  });
});

// One real measurement, gated on the key — googleRoutes.test.ts live idiom.
describe.skipIf(!process.env.GOOGLE_MAPS_API_KEY)('measureDriveDeltas (live)', () => {
  test(
    'a real 3-stop Fresno day yields a finite delta',
    async () => {
      const existing = [
        rstop('A', '2331 Fresno St, Fresno, CA 93721'),
        rstop('B', '567 W Shaw Ave, Fresno, CA 93704'),
        rstop('C', '99 E Herndon Ave, Fresno, CA 93720'),
      ];
      const out = await measureDriveDeltas({
        candidates: [slot()],
        stopsByTechDate: new Map([[techDateKey('bob', '2026-07-30'), existing]]),
        newStop: rstop('New', '4780 N Marks Ave, Fresno, CA 93722'),
      });
      expect(out[0].driveMeasured).toBe(true);
      expect(Number.isFinite(out[0].driveDeltaMinutes)).toBe(true);
    },
    30_000,
  );
});
