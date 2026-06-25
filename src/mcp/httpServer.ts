import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { resolveIdentityFromHeaders } from './identity.js';

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

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length ? JSON.parse(raw) : undefined;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
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
