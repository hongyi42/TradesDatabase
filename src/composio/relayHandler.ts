import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveIdentityFromHeaders } from '../mcp/identity.js';
import { getTechnician, isInactiveState } from '../db/index.js';
import { ensurePersonSession, getSessionMcpUrl } from './sessions.js';

// The composio-doorman relay: sandbox → doorman → THIS route → that person's
// Composio session MCP. The caller controls request content only — destination
// (which session) and credential (x-api-key) are chosen here from the signed
// identity, so the master key never leaves the control plane and a badge can
// only ever reach its own person's session (per-person pinning is the security
// boundary; design of record 2026-07-05, plan 2026-07-06).
//
// Error-shape contract: the bare 401 is reserved for identity failures (the
// resolveIdentityFromHeaders throw propagates to httpServer's catch). Every
// later step answers its own 4xx/5xx with a JSON body, so a Composio-side
// fault is never mistaken for a badge/HMAC problem.

export type ForwardFn = (
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  res: ServerResponse,
) => Promise<void>;

export interface RelayDeps {
  getTech?: typeof getTechnician;
  ensureSession?: typeof ensurePersonSession;
  getMcpUrl?: typeof getSessionMcpUrl;
  forward?: ForwardFn;
}

// All three forms must route here — a query string on the bare path would
// otherwise silently fall through to the spine MCP handler (which serves
// every unrouted path) as a malformed MCP request.
export function isRelayPath(url: string | undefined): boolean {
  if (!url) return false;
  return url === '/composio' || url.startsWith('/composio/') || url.startsWith('/composio?');
}

// Connected-account argument guard: fail-closed defense-in-depth against a
// request naming ANOTHER person's connected account (whether Composio pins
// the session's own account under a master-key-backed call is probed in the
// plan's Phase 2 — this guard ships regardless). Matches key NAMES anywhere
// in the JSON body, case-insensitively, snake or camel.
const CONNECTED_ACCOUNT_KEY = /connected_?account/i;

function findConnectedAccountKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findConnectedAccountKey(item);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (CONNECTED_ACCOUNT_KEY.test(key)) return key;
      const hit = findConnectedAccountKey(nested);
      if (hit) return hit;
    }
  }
  return null;
}

function jsonError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// Default forward leg: raw HTTP proxy to the session MCP endpoint. Piping the
// response (headers included) is what carries SSE streams and any
// Mcp-Session-Id back to the agent. Protocol-selected so tests can point it
// at a local plain-HTTP listener.
const defaultForward: ForwardFn = (urlStr, method, headers, body, res) =>
  new Promise((resolve) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'http:' ? http : https;
    // A client abort must settle the promise — 'end' never fires on an
    // aborted stream (multiple resolve calls are harmless).
    res.on('close', resolve);
    const upReq = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', resolve);
        upRes.on('close', resolve);
      },
    );
    upReq.on('error', () => {
      if (!res.headersSent) jsonError(res, 502, 'upstream error');
      else res.destroy(); // mid-stream fault: cut the client loose rather than hang it
      resolve();
    });
    upReq.end(body);
  });

export async function handleComposioRelay(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: string,
  deps: RelayDeps = {},
): Promise<void> {
  // Identity failures THROW (→ httpServer's bare 401); everything below
  // answers for itself.
  const identity = resolveIdentityFromHeaders(req.headers);

  const tech = await (deps.getTech ?? getTechnician)(identity.tenantId, identity.technicianRef);
  if (!tech) return jsonError(res, 403, 'no roster row for this badge');
  if (isInactiveState(tech.state)) {
    return jsonError(res, 403, 'this badge belongs to a deactivated team member');
  }

  // Mint-on-demand for a session-less row. The key-unset skip lives in the
  // CALLER here (mirroring lifecycle.ts) — ensurePersonSession itself throws
  // from the keyless SDK constructor, it does not return 'skipped'.
  let sessionId = tech.composio_session_id;
  if (!sessionId) {
    if (!process.env.COMPOSIO_API_KEY) return jsonError(res, 503, 'session not ready');
    try {
      const result = await (deps.ensureSession ?? ensurePersonSession)(tech);
      if (result.status === 'skipped') return jsonError(res, 503, 'session not ready');
      sessionId = result.sessionId;
    } catch {
      return jsonError(res, 503, 'session not ready');
    }
  }

  if (rawBody.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return jsonError(res, 400, 'body is not valid JSON');
    }
    const offending = findConnectedAccountKey(parsed);
    if (offending) {
      return jsonError(res, 400, `argument key '${offending}' is not allowed through the relay`);
    }
  }

  // The spread is load-bearing after mint-on-demand: the original row still
  // carries a null session id and getSessionMcpUrl throws on it.
  let url: string;
  try {
    url = await (deps.getMcpUrl ?? getSessionMcpUrl)({ ...tech, composio_session_id: sessionId });
  } catch {
    return jsonError(res, 502, 'could not resolve the Composio session');
  }

  // Fresh header set, built HERE so stubs can assert it: never forward the
  // identity headers to Composio; whitelist the MCP protocol headers a
  // stateful streamable-HTTP server needs post-initialize.
  const body = Buffer.from(rawBody);
  const apiKey = process.env.COMPOSIO_RELAY_API_KEY ?? process.env.COMPOSIO_API_KEY;
  // Keyless forwarding would surface as a Composio 401 — indistinguishable
  // from a badge/HMAC failure at the agent. Answer for the misconfiguration
  // explicitly instead (review finding, Phase 1).
  if (!apiKey) return jsonError(res, 503, 'relay is not configured with a Composio API key');
  const headers: Record<string, string> = {
    'content-type': header(req, 'content-type') ?? 'application/json',
    accept: header(req, 'accept') ?? 'application/json, text/event-stream',
    'content-length': String(body.length),
    'x-api-key': apiKey,
  };
  for (const name of ['mcp-session-id', 'mcp-protocol-version']) {
    const value = header(req, name);
    if (value) headers[name] = value;
  }

  await (deps.forward ?? defaultForward)(url, req.method ?? 'POST', headers, body, res);
}
