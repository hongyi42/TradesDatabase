import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { resolveIdentityFromHeaders } from './identity.js';
import { handleInboundWebhook } from '../inbound/webhook.js';
import { sha256hex } from '../control/badges.js';
import { buildBadgeResponse } from '../control/badgeFile.js';
import { getHostByTokenHash } from '../db/index.js';

// Central HTTP entrypoint (Architecture A). Every NemoClaw bot reaches this one
// server through the gateway. It runs STATELESS (sessionIdGenerator: undefined):
// per request we verify the gateway's signed identity header, build a fresh
// identity-scoped MCP server, and serve one Streamable HTTP request — so any
// replica can serve any request (the captureId resume keeps no in-memory state).
//
// mTLS + private-network IP allowlist is provisioned at deploy time; in-code, the
// HMAC-signed identity header (resolveIdentityFromHeaders) is what this process
// trusts. The stdio entrypoint in server.ts is unchanged (used by tests/dev).

// Optional coarse source-IP allowlist in front of mTLS. Skipped if unset, so the
// network/mTLS layer is the boundary unless ALLOWED_CLIENT_IPS is configured.
function allowed(req: http.IncomingMessage): boolean {
  const list = process.env.ALLOWED_CLIENT_IPS;
  if (!list) return true;
  const ips = list.split(',').map((s) => s.trim()).filter(Boolean);
  const ip = req.socket.remoteAddress;
  return !!ip && ips.includes(ip);
}

// The request stream is consumable once, so the webhook path reads the RAW string
// (HMAC is over the exact bytes) while the MCP path parses JSON — never both.
async function readRawBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  return raw.length ? JSON.parse(raw) : undefined;
}

// Inbound handler status → HTTP code, with deliberate retry semantics: 2xx and 4xx
// tell Composio "stop" (deterministic — a retry yields the same result); 503 tells it
// "retry" (a transient fault a retry could fix). Collapsing all of these to one code
// would either retry-storm poison pills or drop recoverable captures.
const INBOUND_STATUS_CODES: Record<string, number> = {
  ingested: 200,
  duplicate: 200,
  unrouted: 200,
  skipped_non_work: 200,
  skipped_offboarded: 200,
  bad_signature: 401,
  bad_payload: 400,
  unknown_tenant: 422,
  transient_error: 503,
};

// Composio connector webhooks. Authenticated by their OWN HMAC over the body
// (webhook-signature) — NOT the gateway identity header and NOT the source-IP
// allowlist (Composio posts from the public internet, not the gateway). So this runs
// BEFORE allowed(). Its own try/catch maps handler status → HTTP code; a genuine
// server fault (e.g. COMPOSIO_WEBHOOK_SECRET unset) → 500 so Composio retries.
async function handleInbound(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const raw = await readRawBody(req);
    // Set INBOUND_DEBUG=1 to print the exact payload + headers Composio sends, so the
    // real envelope/field names can be read off a live trigger (the normalizer mapping
    // is a best-effort guess until then). Dev-only; leave unset in any real deployment.
    if (process.env.INBOUND_DEBUG) {
      console.error('[INBOUND_DEBUG] url=', req.url);
      console.error('[INBOUND_DEBUG] headers=', JSON.stringify(req.headers, null, 2));
      console.error('[INBOUND_DEBUG] body=', raw);
      // Persist the exact raw bytes + signing headers so the signature scheme can be
      // verified offline (re-typing the body would corrupt the bytes the HMAC covers).
      try {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(
          process.env.INBOUND_DEBUG_FILE ?? 'inbound-last.json',
          JSON.stringify({
            id: req.headers['webhook-id'],
            timestamp: req.headers['webhook-timestamp'],
            signature: req.headers['webhook-signature'],
            body: raw,
          }),
        );
      } catch {
        /* best-effort */
      }
    }
    // Standard Webhooks (Svix) scheme: all three headers feed the signature check.
    const pick = (h: string | string[] | undefined): string | undefined =>
      Array.isArray(h) ? h[0] : h;
    const result = await handleInboundWebhook(
      raw,
      {
        id: pick(req.headers['webhook-id']),
        timestamp: pick(req.headers['webhook-timestamp']),
        signature: pick(req.headers['webhook-signature']),
      },
      {},
    );
    res.writeHead(INBOUND_STATUS_CODES[result.status] ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// Badge pull for host machines. Authenticated by the host's own bearer token
// (stored server-side only as a sha256 fingerprint) — NOT the gateway identity
// header and NOT the IP allowlist (hosts' egress IPs rotate), so like /inbound/
// it runs BEFORE allowed(). Every failure is a bare 401: an unauthenticated
// probe learns nothing (not even whether the route exists behind auth).
async function handleBadgePull(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const host = m ? await getHostByTokenHash(sha256hex(m[1].trim())) : null;
    if (!host) {
      res.writeHead(401);
      res.end();
      return;
    }
    const body = await buildBadgeResponse(host.id);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    // Webhooks first — gated by HMAC, not by the gateway IP allowlist below.
    if (req.url?.startsWith('/inbound/')) {
      await handleInbound(req, res);
      return;
    }
    // Host badge pull — gated by the host token, same pre-allowlist placement.
    if (req.url === '/control/badges' && req.method === 'GET') {
      await handleBadgePull(req, res);
      return;
    }
    if (!allowed(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    // Read+parse the body ourselves and pass it to handleRequest, so the transport
    // does not try to re-read the already-consumed stream.
    const body = await readBody(req);
    const identity = resolveIdentityFromHeaders(req.headers);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = createServer({ identity });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch {
    // Identity/parse/allowlist failures are rejected without leaking detail.
    if (!res.headersSent) {
      res.writeHead(401);
      res.end();
    }
  }
}

export function createHttpServer(): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res);
  });
}

async function main(): Promise<void> {
  const port = Number(process.env.MCP_HTTP_PORT ?? 8080);
  createHttpServer().listen(port, () => {
    console.error(`trades-spine MCP HTTP server listening on :${port}`);
  });
}

// Start the HTTP server only when executed directly (node dist/mcp/httpServer.js),
// not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
