import { afterEach, describe, expect, it } from 'vitest';
import { resolveIdentityFromHeaders } from '../mcp/identity.js';
import { signedHeaders } from './identity.js';

// The glue signs what the doorman signed; Render's own verifier is the judge.
describe('signedHeaders', () => {
  const prev = process.env.GATEWAY_IDENTITY_SECRET;
  afterEach(() => {
    if (prev === undefined) delete process.env.GATEWAY_IDENTITY_SECRET;
    else process.env.GATEWAY_IDENTITY_SECRET = prev;
  });

  it("passes Render's resolveIdentityFromHeaders", () => {
    process.env.GATEWAY_IDENTITY_SECRET = 'glue-test-secret';
    const h = signedHeaders('glue-test-secret', 'tenant-1', 'ben-shelton');
    expect(resolveIdentityFromHeaders({ ...h })).toEqual({ tenantId: 'tenant-1', technicianRef: 'ben-shelton' });
  });

  it('is rejected by Render under a different secret', () => {
    process.env.GATEWAY_IDENTITY_SECRET = 'the-real-secret';
    const h = signedHeaders('a-wrong-secret', 'tenant-1', 'ben-shelton');
    expect(() => resolveIdentityFromHeaders({ ...h })).toThrow('bad identity signature');
  });

  it('refuses an empty secret', () => {
    expect(() => signedHeaders('', 't', 'r')).toThrow();
  });
});
