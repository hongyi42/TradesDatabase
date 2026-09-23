import { createHmac } from 'node:crypto';

// The three headers the doorman stamps today (Box_Setup_Stuff/doorman.mjs:33,
// :56-63) and Render verifies in src/mcp/identity.ts. In step 1 the glue signs
// them itself: the secret stays in this host-side process, and the engine only
// ever holds the resulting headers for ONE seat — as powerful as that seat's
// badge, never act-as-anyone. Step 4 replaces this with a per-seat token.
export interface IdentityHeaders {
  'x-tenant-id': string;
  'x-technician-ref': string;
  'x-identity-signature': string;
}

export function signedHeaders(secret: string, tenantId: string, technicianRef: string): IdentityHeaders {
  if (!secret) throw new Error('seat-glue: identity secret is empty');
  return {
    'x-tenant-id': tenantId,
    'x-technician-ref': technicianRef,
    'x-identity-signature': createHmac('sha256', secret).update(`${tenantId}.${technicianRef}`).digest('hex'),
  };
}
