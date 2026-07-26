// Google Geocoding API client (plan 4b-3 Phase 2) — one job: free-text
// address → lat/lng for the freeze solver. Google's Route Optimization API
// takes coordinates (or place IDs) only, never free-text addresses, so
// customers must be geocoded before a solve can route to them.
// Docs: https://developers.google.com/maps/documentation/geocoding/requests-geocoding
//
// LAZY: coordinates are filled the first time a solve needs the customer,
// then reused from the row (customers.lat/lng, geocoded_at). An unlocatable
// address persists NOTHING — the next solve retries, so a later address fix
// heals it without an invalidation hook.

import { formatAddress } from './deepLink.js';
import { getCustomer, updateCustomerCoords, type Customer } from '../db/index.js';

export interface LatLng {
  lat: number;
  lng: number;
}

// Injectable transport seam (the googleRoutes idiom) so tests never need the
// key or the network: address text in, raw API payload out.
export type GeocodeTransport = (address: string) => Promise<unknown>;

const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

const liveGeocode: GeocodeTransport = async (address) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set');
  const res = await fetch(`${ENDPOINT}?address=${encodeURIComponent(address)}&key=${apiKey}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`geocode failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
  }
  return res.json();
};

// null = Google genuinely cannot locate the address (ZERO_RESULTS) — the
// caller surfaces that as skipped-with-reason. Everything else non-OK THROWS:
// an outage or quota error must never be recorded as "unlocatable".
export async function geocodeAddress(
  text: string,
  deps: { geocode?: GeocodeTransport } = {},
): Promise<LatLng | null> {
  const transport = deps.geocode ?? liveGeocode;
  const payload = (await transport(text)) as {
    status?: string;
    results?: { geometry?: { location?: { lat?: number; lng?: number } } }[];
  };
  if (payload?.status === 'ZERO_RESULTS') return null;
  if (payload?.status !== 'OK') {
    throw new Error(`geocode returned status ${payload?.status ?? 'unknown'}`);
  }
  const loc = payload.results?.[0]?.geometry?.location;
  if (typeof loc?.lat !== 'number' || typeof loc?.lng !== 'number') {
    throw new Error('geocode returned OK with no usable location');
  }
  return { lat: loc.lat, lng: loc.lng };
}

// The lazy fill. Stored coordinates win (no API call); else geocode the
// customer's formatted address and persist. Returns null — with a reason the
// solver can report — when the customer has no usable address (no API call:
// formatAddress needs address_line1) or the address is unlocatable.
export type CustomerCoords =
  | { ok: true; coords: LatLng }
  | { ok: false; reason: 'no_address' | 'unlocatable' };

export async function ensureCustomerCoords(
  customer: Customer,
  deps: { geocode?: GeocodeTransport } = {},
): Promise<CustomerCoords> {
  if (customer.lat !== null && customer.lng !== null) {
    return { ok: true, coords: { lat: customer.lat, lng: customer.lng } };
  }
  const address = formatAddress({
    address_line1: customer.address_line1,
    address_line2: customer.address_line2,
    city: customer.city,
    state: customer.state,
    postal_code: customer.postal_code,
  });
  if (!address) return { ok: false, reason: 'no_address' };
  const coords = await geocodeAddress(address, deps);
  if (!coords) return { ok: false, reason: 'unlocatable' };
  await updateCustomerCoords(customer.id, coords.lat, coords.lng);
  return { ok: true, coords };
}

// Batch convenience for the solve assembler: resolve MANY customers with one
// point-read + fill each, deduplicated by id (a tenant's queue often repeats
// a customer). Sequential on purpose — geocoding bursts are rare (only
// never-geocoded rows) and the Geocoding API rate-limits.
export async function ensureCoordsById(
  customerIds: string[],
  deps: { geocode?: GeocodeTransport } = {},
): Promise<Map<string, CustomerCoords>> {
  const out = new Map<string, CustomerCoords>();
  for (const id of [...new Set(customerIds)]) {
    const customer = await getCustomer(id);
    if (!customer) {
      out.set(id, { ok: false, reason: 'no_address' });
      continue;
    }
    out.set(id, await ensureCustomerCoords(customer, deps));
  }
  return out;
}
