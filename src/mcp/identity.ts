import { createHmac, timingSafeEqual } from 'node:crypto';

// The per-request identity the MCP server acts on: which firm (tenant) and which
// technician a tool call is for. It is established at the boundary — never read
// from a model-supplied tool argument — so the agent cannot forge it.
//
//  - stdio / dev: identityFromEnv() pins one identity for the process (single-box).
//  - central HTTP: resolveIdentityFromHeaders() resolves it per request from the
//    gateway's signed header (added in Phase 3).
//
// `dispatch` consumes this via ServerDeps.identity, so swapping the *source* (env
// → signed header → a future JWT/Option B) never touches the tools.
export interface RequestIdentity {
  tenantId: string;
  technicianRef: string;
  scopes?: string[];
}

// The single-identity source for the stdio entrypoint: read once at startup from
// the process environment (injected by the launcher), not per request.
export function identityFromEnv(): RequestIdentity {
  const tenantId = process.env.DEFAULT_TENANT_ID;
  const technicianRef = process.env.DEFAULT_TECHNICIAN_REF;
  if (!tenantId) throw new Error('DEFAULT_TENANT_ID is not set');
  if (!technicianRef) throw new Error('DEFAULT_TECHNICIAN_REF is not set');
  return { tenantId, technicianRef };
}

function header(headers: NodeJS.Dict<string | string[]>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// The per-request identity source for the central HTTP server: the gateway stamps
// x-tenant-id / x-technician-ref and an HMAC of them (x-identity-signature) signed
// with the shared GATEWAY_IDENTITY_SECRET. We recompute the HMAC and reject any
// mismatch, so the asserted identity is tamper-evident. This is the in-code
// integrity half of Architecture A; mTLS + the IP allowlist are deploy-time infra.
//
// Swapping this one function for JWT validation is the future Option B migration.
export function resolveIdentityFromHeaders(
  headers: NodeJS.Dict<string | string[]>,
): RequestIdentity {
  const secret = process.env.GATEWAY_IDENTITY_SECRET;
  if (!secret) throw new Error('GATEWAY_IDENTITY_SECRET is not set');

  const tenantId = header(headers, 'x-tenant-id');
  const technicianRef = header(headers, 'x-technician-ref');
  const signature = header(headers, 'x-identity-signature');
  if (!tenantId || !technicianRef || !signature) {
    throw new Error('missing identity headers');
  }

  const expected = createHmac('sha256', secret).update(`${tenantId}.${technicianRef}`).digest();
  const provided = Buffer.from(signature, 'hex');
  // Length-guard FIRST: timingSafeEqual throws RangeError on unequal lengths, so a
  // tampered/short signature must be rejected here rather than crash the handler.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error('bad identity signature');
  }

  return { tenantId, technicianRef };
}
