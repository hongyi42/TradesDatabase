import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import { resolveIdentity, resolveIdentityFromHeaders, seatTokenOf } from './identity.js';

const SECRET = 'test-gateway-secret';

function sign(tenantId: string, technicianRef: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${tenantId}.${technicianRef}`).digest('hex');
}

// A valid header set for tenant firm-A / tech-bob, with overrides applied
// (undefined deletes a header, to test the missing-header cases).
function headers(over: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    'x-tenant-id': 'firm-A',
    'x-technician-ref': 'tech-bob',
    'x-identity-signature': sign('firm-A', 'tech-bob'),
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

describe('resolveIdentityFromHeaders', () => {
  let prevSecret: string | undefined;
  beforeAll(() => {
    prevSecret = process.env.GATEWAY_IDENTITY_SECRET;
    process.env.GATEWAY_IDENTITY_SECRET = SECRET;
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env.GATEWAY_IDENTITY_SECRET;
    else process.env.GATEWAY_IDENTITY_SECRET = prevSecret;
  });

  test('valid signature resolves identity', () => {
    expect(resolveIdentityFromHeaders(headers())).toEqual({
      tenantId: 'firm-A',
      technicianRef: 'tech-bob',
    });
  });

  test('tampered same-length signature throws', () => {
    const wrong = sign('firm-B', 'tech-bob'); // 64 hex chars, wrong content
    expect(() => resolveIdentityFromHeaders(headers({ 'x-identity-signature': wrong }))).toThrow();
  });

  test('wrong-length signature throws (no RangeError)', () => {
    expect(() => resolveIdentityFromHeaders(headers({ 'x-identity-signature': 'abcd' }))).toThrow();
  });

  test('tampered technician-ref invalidates the signature', () => {
    // Signature was computed for tech-bob; changing the header must reject.
    expect(() => resolveIdentityFromHeaders(headers({ 'x-technician-ref': 'tech-jane' }))).toThrow();
  });

  test('wrong secret throws', () => {
    const sig = sign('firm-A', 'tech-bob', 'a-different-secret');
    expect(() => resolveIdentityFromHeaders(headers({ 'x-identity-signature': sig }))).toThrow();
  });

  test('each missing header throws', () => {
    expect(() => resolveIdentityFromHeaders(headers({ 'x-tenant-id': undefined }))).toThrow();
    expect(() => resolveIdentityFromHeaders(headers({ 'x-technician-ref': undefined }))).toThrow();
    expect(() =>
      resolveIdentityFromHeaders(headers({ 'x-identity-signature': undefined })),
    ).toThrow();
  });

  test('missing secret throws', () => {
    delete process.env.GATEWAY_IDENTITY_SECRET;
    try {
      expect(() => resolveIdentityFromHeaders(headers())).toThrow();
    } finally {
      process.env.GATEWAY_IDENTITY_SECRET = SECRET;
    }
  });
});

// Step 4: resolveIdentity puts the seat token first and leaves the HMAC path
// exactly as it was. A found token is covered end to end in httpServer.test.ts
// (mint → whoami → /mcp) and the lookup itself in src/db/seats.test.ts.
describe('resolveIdentity', () => {
  const TOKEN = `st_${'ab'.repeat(32)}`;
  let prevSecret: string | undefined;
  beforeAll(() => {
    prevSecret = process.env.GATEWAY_IDENTITY_SECRET;
    process.env.GATEWAY_IDENTITY_SECRET = SECRET;
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env.GATEWAY_IDENTITY_SECRET;
    else process.env.GATEWAY_IDENTITY_SECRET = prevSecret;
  });

  test('no seat token → the HMAC path, unchanged', async () => {
    expect(await resolveIdentity(headers())).toEqual({ tenantId: 'firm-A', technicianRef: 'tech-bob' });
    await expect(resolveIdentity(headers({ 'x-identity-signature': 'abcd' }))).rejects.toThrow();
  });

  test('only an st_ bearer is a seat token; any other Authorization falls to HMAC', () => {
    expect(seatTokenOf({ authorization: `Bearer ${TOKEN}` })).toBe(TOKEN);
    expect(seatTokenOf({ authorization: 'Bearer some-badge' })).toBeNull();
    expect(seatTokenOf({ authorization: `Bearer st_short` })).toBeNull();
    expect(seatTokenOf({})).toBeNull();
  });

  test('an unknown seat token is rejected, even alongside valid HMAC headers (the token wins)', async () => {
    await expect(
      resolveIdentity({ ...headers(), authorization: `Bearer ${TOKEN}` }),
    ).rejects.toThrow(/unknown seat token/);
  });
});
