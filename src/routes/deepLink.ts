// Google Maps deep-link builder — pure string assembly, zero I/O.
//
// A "deep link" is a plain https://www.google.com/maps/dir/ URL carrying the
// day's stops in driving order; tapping it opens the Google Maps app (or web)
// with the whole route loaded. The link carries ORDER ONLY — ETAs, durations,
// and job metadata live in the tool response, not the URL.
// Format reference: https://developers.google.com/maps/documentation/urls/get-started

// One stop on a technician's day. `address` is the free-text single-line
// address ("99 Ranch Rd, Clovis, CA 93611"); null = the source row had no
// usable address — the stop stays visible in schedule text but cannot be
// routed or linked.
export interface RouteStop {
  label: string; // customer name for display
  address: string | null;
  scheduledStart?: string | null; // ISO timestamp, passthrough for display
}

export interface DeepLinkResult {
  url: string | null; // null when no stop has a usable address
  includedStops: number; // how many stops the link actually carries
  linkTruncated: boolean; // true when the day exceeded the URL's stop capacity
}

// Maps URLs allow at most 9 waypoints + destination = 10 stops per link
// (origin excluded; see the doc above). Days beyond that get a link covering
// the first 10 stops in order, flagged so the caller can say so.
const MAX_LINK_STOPS = 10;

// Build the directions URL for stops already in driving order.
//
// `origin` is deliberately optional: omitted, Google Maps starts the route
// from "the most relevant location, such as user location, if available" —
// usually the technician's live position, but platform-dependent. The
// parameter exists so a call site can pin the first stop as origin if the
// no-origin form misbehaves on real phones (plan's manual-check fallback).
export function buildMapsDeepLink(stops: RouteStop[], origin?: string): DeepLinkResult {
  const routable = stops.filter((s): s is RouteStop & { address: string } => s.address !== null);
  if (routable.length === 0) {
    return { url: null, includedStops: 0, linkTruncated: false };
  }

  const linkTruncated = routable.length > MAX_LINK_STOPS;
  const included = routable.slice(0, MAX_LINK_STOPS);
  const destination = included[included.length - 1];
  const waypoints = included.slice(0, -1);

  // A literal '|' inside an address encodes to %7C — byte-identical to the
  // waypoint separator below — and would split one stop into two garbage
  // waypoints. The Maps URL format has no pipe escape, so replace it.
  const enc = (address: string) => encodeURIComponent(address.replaceAll('|', '/'));

  const parts = [
    'https://www.google.com/maps/dir/?api=1',
    origin ? `origin=${enc(origin)}` : null,
    `destination=${enc(destination.address)}`,
    waypoints.length > 0
      ? `waypoints=${waypoints.map((s) => enc(s.address)).join('%7C')}`
      : null,
    'travelmode=driving',
  ].filter((p): p is string => p !== null);

  return { url: parts.join('&'), includedStops: included.length, linkTruncated };
}

// Join the customers/schedule_entries address columns into the single-line
// form both Google surfaces accept. Null when address_line1 is missing — a
// city/state alone routes somewhere useless, so such stops are unroutable.
export function formatAddress(parts: {
  address_line1: string | null;
  address_line2?: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}): string | null {
  if (!parts.address_line1 || parts.address_line1.trim() === '') return null;
  return [parts.address_line1, parts.address_line2, parts.city, parts.state, parts.postal_code]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p && p.length > 0)
    .join(', ');
}
