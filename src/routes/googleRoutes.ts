// Google Routes API client — computeRoutes with waypoint-order optimization.
//
// One job: given a day's routable stops (free-text addresses), ask Google for
// the best driving order and per-leg durations. Fleet assignment (which tech
// gets which job) is deliberately NOT here — that's the Plan-3 fork.
// Docs: https://developers.google.com/maps/documentation/routes/opt-way
// Billing: optimizeWaypointOrder bills the Compute Routes Pro SKU
// (5k free calls/month) — callers skip degenerate days (see below).

import type { RouteStop } from './deepLink.js';

export interface OrderedDay {
  order: number[]; // indexes into the caller's ROUTABLE stop list, drive order
  legMinutes: number[]; // one entry per leg between consecutive ordered stops
  totalMinutes: number | null; // null = not measured (short-circuit days)
}

// Injectable transport seam so tests never need the key or the network.
export type ComputeRoutes = (body: unknown) => Promise<unknown>;

const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
// Field mask = the only fields we pay attention to; required by the API.
const FIELD_MASK = 'routes.optimizedIntermediateWaypointIndex,routes.legs.duration,routes.duration';
// computeRoutes hard limit on waypoints per request (research constraint 7).
const MAX_API_STOPS = 25;

const liveComputeRoutes: ComputeRoutes = async (body) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`computeRoutes failed: HTTP ${res.status} ${detail.slice(0, 500)}`);
  }
  return res.json();
};

// Seconds-string ("1234s") → whole minutes, rounded.
function durationToMinutes(duration: unknown): number {
  const s = typeof duration === 'string' ? Number.parseInt(duration, 10) : NaN;
  if (Number.isNaN(s)) throw new Error(`computeRoutes returned unparseable duration: ${String(duration)}`);
  return Math.round(s / 60);
}

// Best driving order for stops that are already filtered to routable
// (non-null address) — `order` indexes THAT list, nothing else.
//
// <3 stops: identity order with totalMinutes null (unknown ≠ zero — a 2-stop
// day has a real drive we did not measure) and NO API call: there is no
// middle to reorder, and optimizeWaypointOrder requires ≥1 intermediate.
export async function optimizeStopOrder(
  stops: RouteStop[],
  deps: { computeRoutes?: ComputeRoutes } = {},
): Promise<OrderedDay> {
  if (stops.some((s) => s.address === null)) {
    throw new Error('optimizeStopOrder expects routable stops only (null address seen)');
  }
  if (stops.length > MAX_API_STOPS) {
    throw new Error(
      `optimizeStopOrder: ${stops.length} stops exceeds the computeRoutes limit of ${MAX_API_STOPS}`,
    );
  }
  if (stops.length < 3) {
    return { order: stops.map((_, i) => i), legMinutes: [], totalMinutes: null };
  }

  const compute = deps.computeRoutes ?? liveComputeRoutes;
  const middles = stops.slice(1, -1);
  // A SINGLE intermediate has exactly one possible order — asking Google to
  // "optimize" it is an incoherent question, and the live API answers it with
  // an undocumented sentinel `optimizedIntermediateWaypointIndex: [-1]` (the
  // docs imply [0]; observed 2026-07-20 with a real key), which the
  // permutation guard below rightly rejects — every 3-stop day silently
  // degraded to unmeasured. Only request optimization when there are ≥2
  // intermediates to reorder; otherwise the input order IS the order.
  const wantOptimize = middles.length > 1;
  const response = (await compute({
    origin: { address: stops[0].address },
    destination: { address: stops[stops.length - 1].address },
    intermediates: middles.map((s) => ({ address: s.address })),
    travelMode: 'DRIVE',
    ...(wantOptimize ? { optimizeWaypointOrder: true } : {}),
  })) as {
    routes?: {
      optimizedIntermediateWaypointIndex?: number[];
      legs?: { duration?: string }[];
      duration?: string;
    }[];
  };

  const route = response?.routes?.[0];
  if (!route) throw new Error('computeRoutes returned no route/optimized order');

  let order: number[];
  if (wantOptimize) {
    if (!Array.isArray(route.optimizedIntermediateWaypointIndex)) {
      throw new Error('computeRoutes returned no route/optimized order');
    }
    // Google's index array orders the INTERMEDIATES only; origin stays first,
    // destination stays last. Map back to full-list indexes (+1 skips origin).
    order = [0, ...route.optimizedIntermediateWaypointIndex.map((i) => i + 1), stops.length - 1];
    // The response is cast, not trusted: a short/duplicated/out-of-range index
    // array would silently drop a stop or blow up later with routable[i] ===
    // undefined OUTSIDE the caller's degrade path. Require a true permutation.
    const isPermutation =
      order.length === stops.length && [...order].sort((a, b) => a - b).every((v, i) => v === i);
    if (!isPermutation) {
      throw new Error(
        `computeRoutes returned an invalid optimized order (${JSON.stringify(
          route.optimizedIntermediateWaypointIndex,
        )} for ${stops.length - 2} intermediates)`,
      );
    }
  } else {
    order = stops.map((_, i) => i); // one middle stop: nothing to reorder
  }
  const legMinutes = (route.legs ?? []).map((l) => durationToMinutes(l.duration));
  const totalMinutes =
    route.duration !== undefined
      ? durationToMinutes(route.duration)
      : legMinutes.reduce((a, b) => a + b, 0);

  return { order, legMinutes, totalMinutes };
}
