import { describe, expect, test, vi } from 'vitest';
import { optimizeStopOrder } from './googleRoutes.js';
import type { RouteStop } from './deepLink.js';

const stop = (address: string): RouteStop => ({ label: address, address });

const fourStops = ['1 A St', '2 B St', '3 C St', '4 D St'].map(stop);

// Canned Google response: middles come back reordered [1,0] — meaning drive
// the SECOND intermediate first. Full-list order must become [0, 2, 1, 3].
const cannedResponse = {
  routes: [
    {
      optimizedIntermediateWaypointIndex: [1, 0],
      legs: [{ duration: '600s' }, { duration: '900s' }, { duration: '330s' }],
      duration: '1830s',
    },
  ],
};

describe('optimizeStopOrder (mocked transport)', () => {
  test('maps intermediate order back to full-list indexes', async () => {
    const computeRoutes = vi.fn().mockResolvedValue(cannedResponse);
    const r = await optimizeStopOrder(fourStops, { computeRoutes });
    expect(r.order).toEqual([0, 2, 1, 3]);
    expect(r.legMinutes).toEqual([10, 15, 6]); // 600s, 900s, 330s rounded
    expect(r.totalMinutes).toBe(31); // 1830s → 30.5 → 31
  });

  test('sends origin/destination fixed and middles as intermediates', async () => {
    const computeRoutes = vi.fn().mockResolvedValue(cannedResponse);
    await optimizeStopOrder(fourStops, { computeRoutes });
    expect(computeRoutes).toHaveBeenCalledWith({
      origin: { address: '1 A St' },
      destination: { address: '4 D St' },
      intermediates: [{ address: '2 B St' }, { address: '3 C St' }],
      travelMode: 'DRIVE',
      optimizeWaypointOrder: true,
    });
  });

  test('totalMinutes falls back to leg sum when duration missing', async () => {
    const computeRoutes = vi.fn().mockResolvedValue({
      routes: [{ optimizedIntermediateWaypointIndex: [0], legs: [{ duration: '60s' }, { duration: '120s' }] }],
    });
    const r = await optimizeStopOrder(fourStops.slice(0, 3), { computeRoutes });
    expect(r.totalMinutes).toBe(3);
  });

  test('a single intermediate is measured WITHOUT the optimize flag (live [-1] sentinel trap)', async () => {
    // The live API answers optimizeWaypointOrder over ONE intermediate with an
    // undocumented [-1] (observed 2026-07-20), so a 3-stop route must not ask —
    // and must parse a response that carries NO index field at all.
    const computeRoutes = vi.fn().mockResolvedValue({
      routes: [{ legs: [{ duration: '600s' }, { duration: '1032s' }], duration: '1632s' }],
    });
    const r = await optimizeStopOrder(fourStops.slice(0, 3), { computeRoutes });
    expect(computeRoutes).toHaveBeenCalledWith({
      origin: { address: '1 A St' },
      destination: { address: '3 C St' },
      intermediates: [{ address: '2 B St' }],
      travelMode: 'DRIVE',
      // no optimizeWaypointOrder key — nothing to reorder
    });
    expect(r.order).toEqual([0, 1, 2]); // input order IS the order
    expect(r.legMinutes).toEqual([10, 17]);
    expect(r.totalMinutes).toBe(27);
  });

  test.each([0, 1, 2])('%i stops short-circuits: identity order, null total, NO api call', async (n) => {
    const computeRoutes = vi.fn();
    const r = await optimizeStopOrder(fourStops.slice(0, n), { computeRoutes });
    expect(r.order).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(r.legMinutes).toEqual([]);
    expect(r.totalMinutes).toBeNull();
    expect(computeRoutes).not.toHaveBeenCalled();
  });

  test('rejects null-address stops (caller contract)', async () => {
    const bad: RouteStop[] = [...fourStops.slice(0, 2), { label: 'x', address: null }];
    await expect(optimizeStopOrder(bad, { computeRoutes: vi.fn() })).rejects.toThrow(
      /routable stops only/,
    );
  });

  test('rejects >25 stops with descriptive error', async () => {
    const many = Array.from({ length: 26 }, (_, i) => stop(`${i} Long Rd`));
    await expect(optimizeStopOrder(many, { computeRoutes: vi.fn() })).rejects.toThrow(/25/);
  });

  test('throws on a non-permutation optimized order (out-of-range / short / duplicate)', async () => {
    for (const bad of [[7], [0], [0, 0]]) {
      // [7]: out of range for 2 intermediates; [0]: too short; [0,0]: duplicate
      const computeRoutes = vi.fn().mockResolvedValue({
        routes: [{ optimizedIntermediateWaypointIndex: bad, legs: [], duration: '60s' }],
      });
      await expect(optimizeStopOrder(fourStops, { computeRoutes })).rejects.toThrow(
        /invalid optimized order/,
      );
    }
  });

  test('throws on missing route in response', async () => {
    const computeRoutes = vi.fn().mockResolvedValue({ routes: [] });
    await expect(optimizeStopOrder(fourStops, { computeRoutes })).rejects.toThrow(
      /no route\/optimized order/,
    );
  });

  test('throws on unparseable leg duration', async () => {
    const computeRoutes = vi.fn().mockResolvedValue({
      routes: [{ optimizedIntermediateWaypointIndex: [0, 1], legs: [{ duration: 'soon' }] }],
    });
    await expect(optimizeStopOrder(fourStops, { computeRoutes })).rejects.toThrow(
      /unparseable duration/,
    );
  });

  test('transport errors propagate untouched', async () => {
    const computeRoutes = vi.fn().mockRejectedValue(new Error('computeRoutes failed: HTTP 403 denied'));
    await expect(optimizeStopOrder(fourStops, { computeRoutes })).rejects.toThrow(/HTTP 403/);
  });
});

// One real call, gated on the key — same pattern as the synthesis live tests.
// Asserts shape, not a specific order: traffic changes, Google's answer may too.
describe.skipIf(!process.env.GOOGLE_MAPS_API_KEY)('optimizeStopOrder (live)', () => {
  test(
    'orders four real Fresno-area addresses',
    async () => {
      const real = [
        '1 Capitol Mall, Sacramento, CA', // deliberately far origin
        '2331 Fresno St, Fresno, CA 93721',
        '567 W Shaw Ave, Fresno, CA 93704',
        '99 E Herndon Ave, Fresno, CA 93720',
      ].map(stop);
      const r = await optimizeStopOrder(real);
      expect(r.order[0]).toBe(0); // origin fixed
      expect(r.order[r.order.length - 1]).toBe(3); // destination fixed
      expect([...r.order].sort()).toEqual([0, 1, 2, 3]); // a true permutation
      expect(r.totalMinutes).toBeGreaterThan(0);
      expect(r.legMinutes).toHaveLength(3);
    },
    30_000,
  );
});
