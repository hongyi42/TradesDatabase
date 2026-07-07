import { describe, expect, test } from 'vitest';
import { buildMapsDeepLink, formatAddress, type RouteStop } from './deepLink.js';

const stop = (address: string | null, label = 'Customer'): RouteStop => ({ label, address });

const stops = (n: number): RouteStop[] =>
  Array.from({ length: n }, (_, i) => stop(`${i + 1} Test St, Fresno, CA`, `C${i + 1}`));

// Parse a built URL back into { origin, destination, waypoints[] } — the
// round-trip proves encoding survives real URL parsing, not just eyeballing.
function parseLink(url: string) {
  const u = new URL(url);
  const waypoints = u.searchParams.get('waypoints');
  return {
    origin: u.searchParams.get('origin'),
    destination: u.searchParams.get('destination'),
    waypoints: waypoints === null ? [] : waypoints.split('|'),
    travelmode: u.searchParams.get('travelmode'),
    api: u.searchParams.get('api'),
  };
}

describe('buildMapsDeepLink', () => {
  test('zero stops → null url, nothing included', () => {
    expect(buildMapsDeepLink([])).toEqual({ url: null, includedStops: 0, linkTruncated: false });
  });

  test('all stops unroutable → null url', () => {
    expect(buildMapsDeepLink([stop(null), stop(null)])).toEqual({
      url: null,
      includedStops: 0,
      linkTruncated: false,
    });
  });

  test('one stop → destination only, no waypoints param', () => {
    const r = buildMapsDeepLink([stop('14 Smith St, Fresno, CA 93701')]);
    expect(r.includedStops).toBe(1);
    expect(r.linkTruncated).toBe(false);
    const parsed = parseLink(r.url!);
    expect(parsed.destination).toBe('14 Smith St, Fresno, CA 93701');
    expect(parsed.waypoints).toEqual([]);
    expect(parsed.travelmode).toBe('driving');
    expect(parsed.api).toBe('1');
  });

  test('two stops → first is waypoint, last is destination', () => {
    const r = buildMapsDeepLink(stops(2));
    const parsed = parseLink(r.url!);
    expect(parsed.waypoints).toEqual(['1 Test St, Fresno, CA']);
    expect(parsed.destination).toBe('2 Test St, Fresno, CA');
  });

  test('nine stops → 8 waypoints + destination, not truncated', () => {
    const r = buildMapsDeepLink(stops(9));
    expect(r.includedStops).toBe(9);
    expect(r.linkTruncated).toBe(false);
    expect(parseLink(r.url!).waypoints).toHaveLength(8);
  });

  test('ten stops → 9 waypoints + destination, at capacity, not truncated', () => {
    const r = buildMapsDeepLink(stops(10));
    expect(r.includedStops).toBe(10);
    expect(r.linkTruncated).toBe(false);
    const parsed = parseLink(r.url!);
    expect(parsed.waypoints).toHaveLength(9);
    expect(parsed.destination).toBe('10 Test St, Fresno, CA');
  });

  test('eleven stops → truncated to first 10 in order', () => {
    const r = buildMapsDeepLink(stops(11));
    expect(r.includedStops).toBe(10);
    expect(r.linkTruncated).toBe(true);
    const parsed = parseLink(r.url!);
    expect(parsed.destination).toBe('10 Test St, Fresno, CA'); // 11th dropped
    expect(parsed.waypoints[0]).toBe('1 Test St, Fresno, CA');
  });

  test('fifteen stops → still first 10, order preserved', () => {
    const r = buildMapsDeepLink(stops(15));
    expect(r.includedStops).toBe(10);
    expect(r.linkTruncated).toBe(true);
    expect(parseLink(r.url!).waypoints).toEqual(
      Array.from({ length: 9 }, (_, i) => `${i + 1} Test St, Fresno, CA`),
    );
  });

  test('unroutable stops are skipped, routable order kept', () => {
    const r = buildMapsDeepLink([stop('1 A St'), stop(null), stop('3 C St')]);
    expect(r.includedStops).toBe(2);
    const parsed = parseLink(r.url!);
    expect(parsed.waypoints).toEqual(['1 A St']);
    expect(parsed.destination).toBe('3 C St');
  });

  test('encoding survives spaces, commas, # and & round-trip', () => {
    const nasty = '99 Ranch Rd #4B, Clovis, CA & Sons';
    const r = buildMapsDeepLink([stop(nasty), stop('Plain St')]);
    const parsed = parseLink(r.url!);
    expect(parsed.waypoints).toEqual([nasty]);
    // Raw URL must not leak an unencoded ampersand or hash from the address.
    const [, query] = r.url!.split('?');
    expect(query.includes('#')).toBe(false);
  });

  test("literal '|' in an address cannot split into extra waypoints", () => {
    // '|' encodes to %7C — identical to the waypoint separator — so the
    // builder replaces it before encoding.
    const r = buildMapsDeepLink([stop('12 Main St | Gate 2'), stop('Plain St'), stop('End St')]);
    const parsed = parseLink(r.url!);
    expect(parsed.waypoints).toHaveLength(2); // NOT 3
    expect(parsed.waypoints[0]).toBe('12 Main St / Gate 2');
  });

  test('origin passed through and encoded when provided', () => {
    const r = buildMapsDeepLink(stops(2), 'Shop HQ, Fresno CA');
    expect(parseLink(r.url!).origin).toBe('Shop HQ, Fresno CA');
  });

  test('origin omitted by default', () => {
    expect(parseLink(buildMapsDeepLink(stops(2)).url!).origin).toBeNull();
  });
});

describe('formatAddress', () => {
  test('joins non-empty parts with commas', () => {
    expect(
      formatAddress({
        address_line1: '99 Ranch Rd',
        address_line2: null,
        city: 'Clovis',
        state: 'CA',
        postal_code: '93611',
      }),
    ).toBe('99 Ranch Rd, Clovis, CA, 93611');
  });

  test('includes address_line2 when present', () => {
    expect(
      formatAddress({
        address_line1: '200 Main St',
        address_line2: 'Suite 4',
        city: 'Fresno',
        state: 'CA',
        postal_code: null,
      }),
    ).toBe('200 Main St, Suite 4, Fresno, CA');
  });

  test('null when address_line1 missing or blank', () => {
    expect(
      formatAddress({ address_line1: null, city: 'Fresno', state: 'CA', postal_code: '93701' }),
    ).toBeNull();
    expect(
      formatAddress({ address_line1: '   ', city: 'Fresno', state: 'CA', postal_code: '93701' }),
    ).toBeNull();
  });

  test('whitespace-only parts dropped', () => {
    expect(
      formatAddress({ address_line1: '1 A St', address_line2: '  ', city: '', state: null, postal_code: null }),
    ).toBe('1 A St');
  });
});
