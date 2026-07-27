import { beforeAll, describe, expect, test } from 'vitest';
import { getClient } from '../db/client.js';
import { createCustomer } from '../db/customers.js';
import { geocodeAddress, ensureCustomerCoords, ensureCoordsById } from './geocode.js';
import type { GeocodeTransport } from './geocode.js';

// Fake-transport tests (the googleRoutes idiom): no key, no network. The
// persistence paths run against the local stack's customers table.

const OK_PAYLOAD = {
  status: 'OK',
  results: [{ geometry: { location: { lat: 36.8252, lng: -119.7029 } } }],
};

function countingTransport(payload: unknown): { transport: GeocodeTransport; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    transport: async (address) => {
      calls.push(address);
      return payload;
    },
  };
}

let tenantId: string;

beforeAll(async () => {
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

describe('geocodeAddress', () => {
  test('OK payload → coords', async () => {
    const { transport } = countingTransport(OK_PAYLOAD);
    await expect(geocodeAddress('123 Main St, Clovis, CA', { geocode: transport })).resolves.toEqual(
      { lat: 36.8252, lng: -119.7029 },
    );
  });

  test('ZERO_RESULTS → null; any other non-OK status THROWS (outage ≠ unlocatable)', async () => {
    const zero = countingTransport({ status: 'ZERO_RESULTS', results: [] });
    await expect(geocodeAddress('nowhere', { geocode: zero.transport })).resolves.toBeNull();
    const denied = countingTransport({ status: 'REQUEST_DENIED' });
    await expect(geocodeAddress('x', { geocode: denied.transport })).rejects.toThrow(
      /status REQUEST_DENIED/,
    );
    const empty = countingTransport({ status: 'OK', results: [] });
    await expect(geocodeAddress('x', { geocode: empty.transport })).rejects.toThrow(
      /no usable location/,
    );
  });
});

describe('ensureCustomerCoords (lazy fill + persistence)', () => {
  test('geocodes once, persists, then reuses the stored pair without an API call', async () => {
    const customer = await createCustomer({
      tenantId,
      name: 'Geo Gina',
      addressLine1: '742 Evergreen Terrace',
      city: 'Clovis',
      state: 'CA',
      postalCode: '93611',
    });
    expect(customer.lat).toBeNull();
    const { transport, calls } = countingTransport(OK_PAYLOAD);

    const first = await ensureCustomerCoords(customer, { geocode: transport });
    expect(first).toEqual({ ok: true, coords: { lat: 36.8252, lng: -119.7029 } });
    expect(calls).toEqual(['742 Evergreen Terrace, Clovis, CA, 93611']); // formatAddress form

    // Row read-back: coords + mint stamp persisted.
    const { data: row } = await getClient()
      .from('customers')
      .select('lat,lng,geocoded_at')
      .eq('id', customer.id)
      .single();
    expect(row?.lat).toBe(36.8252);
    expect(row?.lng).toBe(-119.7029);
    expect(row?.geocoded_at).toBeTruthy();

    // Second pass reads the stored pair — the transport is never re-called.
    const again = await ensureCustomerCoords(
      { ...customer, lat: row?.lat ?? null, lng: row?.lng ?? null },
      { geocode: transport },
    );
    expect(again.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('no address → no_address with NO API call; ZERO_RESULTS → unlocatable, nothing persisted', async () => {
    const bare = await createCustomer({ tenantId, name: 'Geo Bare' });
    const { transport, calls } = countingTransport(OK_PAYLOAD);
    await expect(ensureCustomerCoords(bare, { geocode: transport })).resolves.toEqual({
      ok: false,
      reason: 'no_address',
    });
    expect(calls).toHaveLength(0);

    const lost = await createCustomer({
      tenantId,
      name: 'Geo Lost',
      addressLine1: '1 Nowhere Ln',
      city: 'Atlantis',
    });
    const zero = countingTransport({ status: 'ZERO_RESULTS', results: [] });
    await expect(ensureCustomerCoords(lost, { geocode: zero.transport })).resolves.toEqual({
      ok: false,
      reason: 'unlocatable',
    });
    // Nothing persisted — the next solve retries after an address fix.
    const { data: row } = await getClient()
      .from('customers')
      .select('lat,lng,geocoded_at')
      .eq('id', lost.id)
      .single();
    expect(row?.lat).toBeNull();
    expect(row?.geocoded_at).toBeNull();
  });

  test('ensureCoordsById dedupes ids and maps unknown ids to no_address', async () => {
    const c = await createCustomer({
      tenantId,
      name: 'Geo Dup',
      addressLine1: '9 Dup Way',
      city: 'Clovis',
      state: 'CA',
    });
    const { transport, calls } = countingTransport(OK_PAYLOAD);
    const out = await ensureCoordsById(
      [c.id, c.id, '00000000-0000-0000-0000-0000000000ff'],
      { geocode: transport },
    );
    expect(calls).toHaveLength(1); // deduped
    expect(out.get(c.id)?.ok).toBe(true);
    expect(out.get('00000000-0000-0000-0000-0000000000ff')).toEqual({
      ok: false,
      reason: 'no_address',
    });
  });
});
