import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import { resolveIdentityFromHeaders } from './identity.js';

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
