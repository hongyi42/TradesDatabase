import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { resolveIdentityFromHeaders } from './identity.js';
import { handleInboundWebhook } from '../inbound/webhook.js';
import {
  handleRecordingWebhook,
  handleVoiceWebhook,
  type RecordingStatus,
} from '../inbound/phoneWebhook.js';
import { sha256hex } from '../control/badges.js';
import { buildBadgeResponse } from '../control/badgeFile.js';
import {
  clearSandboxAssignmentIfRef,
  completeSandboxRecycle,
  getHostByTokenHash,
} from '../db/index.js';
import { handleComposioRelay, isRelayPath } from '../composio/relayHandler.js';
import { handleBoardRequest, isBoardPath } from '../telegram/boardApi.js';
import { handleAdminRequest, isAdminPath } from '../admin/adminApi.js';
import { handlePortalRequest, isPortalPath } from '../portal/portalApi.js';

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
// maxBytes (optional) aborts oversized bodies instead of buffering them: the
// board path reads pre-auth on a publicly-distributed URL, so an uncapped read
// there is a memory-DoS invitation. Existing callers pass no cap (unchanged).
async function readRawBody(req: http.IncomingMessage, maxBytes?: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (maxBytes !== undefined && total > maxBytes) {
      req.destroy();
      throw Object.assign(new Error('request body exceeds cap'), { code: 'BODY_TOO_LARGE' });
    }
    chunks.push(buf);
  }
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

// SignalWire phone webhooks (LaML). Authenticated by validateRequest over
// X-SignalWire-Signature (SignalWire posts from the public internet, not the
// gateway), so like /inbound/ they route BEFORE the IP allowlist. Bodies are
// small form-encoded payloads; capped like the board path (pre-auth, public URL).
const PHONE_BODY_CAP = 64 * 1024;
const PHONE_RECORDING_CODES: Record<RecordingStatus, number> = {
  enqueued: 200,
  duplicate: 200,
  unknown_number: 200,
  ignored_status: 200,
  bad_signature: 403,
  bad_payload: 400,
  transient_error: 503,
};

function pickHeader(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}
// The exact URL SignalWire signed = the configured public base + the path/query it
// posted to. Reconstructed here for validateRequest.
function signalwireFullUrl(req: http.IncomingMessage): string {
  return `${process.env.SIGNALWIRE_WEBHOOK_BASE_URL ?? ''}${req.url ?? ''}`;
}

async function handlePhoneVoice(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const raw = await readRawBody(req, PHONE_BODY_CAP);
    const result = await handleVoiceWebhook({
      fullUrl: signalwireFullUrl(req),
      rawBody: raw,
      signature: pickHeader(req.headers['x-signalwire-signature']),
    });
    if (result.status === 'bad_signature') {
      res.writeHead(403);
      res.end();
      return;
    }
    if (result.status === 'bad_payload') {
      res.writeHead(400);
      res.end();
      return;
    }
    // ok_forward / ok_voicemail / unknown_number all return cXML the caller executes.
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(result.cxml);
  } catch (err) {
    if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
      if (!res.headersSent) {
        res.writeHead(413);
        res.end();
      }
      return;
    }
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

async function handlePhoneRecording(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const raw = await readRawBody(req, PHONE_BODY_CAP);
    const url = new URL(req.url ?? '', 'http://internal'); // base only to parse the query
    const result = await handleRecordingWebhook({
      fullUrl: signalwireFullUrl(req),
      rawBody: raw,
      query: {
        tenant: url.searchParams.get('tenant') ?? undefined,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
      },
      signature: pickHeader(req.headers['x-signalwire-signature']),
    });
    res.writeHead(PHONE_RECORDING_CODES[result.status] ?? 200, {
      'content-type': 'application/json',
    });
    res.end(JSON.stringify(result));
  } catch (err) {
    if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
      if (!res.headersSent) {
        res.writeHead(413);
        res.end();
      }
      return;
    }
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

// The box's recycle-completion report: "retired sandbox X is destroyed, blank Y
// is racked with bot Z". Same host-token auth + bare-401 posture as the pull.
// The response's rosterCleared:false tells the box to RETRY the whole (idempotent)
// report next tick — the residue clear is the only non-idempotent-looking half,
// and a person re-bound to a fresh blank is protected by the ref-guarded clear.
async function handleSandboxReport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const host = m ? await getHostByTokenHash(sha256hex(m[1].trim())) : null;
    if (!host) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      json(400, { error: 'malformed JSON body' });
      return;
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const retiredSandboxRef = typeof b.retiredSandboxRef === 'string' ? b.retiredSandboxRef.trim() : '';
    const newSandboxRef = typeof b.newSandboxRef === 'string' ? b.newSandboxRef.trim() : '';
    const botUsername = b.botUsername == null ? null : b.botUsername;
    if (!retiredSandboxRef || !newSandboxRef) {
      json(400, { error: 'retiredSandboxRef and newSandboxRef are required' });
      return;
    }
    // Same handle contract as assign-host.mjs: @, 5-32 word chars. null is
    // allowed (registers handle-less; bind_telegram says "ask your operator").
    if (botUsername !== null && (typeof botUsername !== 'string' || !/^@[A-Za-z0-9_]{5,32}$/.test(botUsername))) {
      json(400, { error: 'botUsername must be @<5-32 word chars> or null' });
      return;
    }
    let result;
    try {
      result = await completeSandboxRecycle({
        hostId: host.id,
        retiredSandboxRef,
        newSandboxRef,
        botUsername,
      });
    } catch (err) {
      // Refusals (code 'recycle_refused') are the box being wrong, not the
      // server failing: conflict, not 500 — the box parks the entry and alarms.
      if ((err as { code?: string }).code === 'recycle_refused') {
        json(409, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      throw err;
    }
    // Clear the roster's pointer at the destroyed sandbox. rosterCleared:false
    // → the box retries the report (this is the ONLY half without its own
    // retry, and the reactivate-path re-bind nudge depends on it landing).
    let rosterCleared: boolean | null = null;
    if (result.retiredTechnicianId) {
      try {
        await clearSandboxAssignmentIfRef(result.retiredTechnicianId, retiredSandboxRef, host.id);
        rosterCleared = true;
      } catch {
        rosterCleared = false;
      }
    }
    json(200, { retired: result.retired, registered: result.registered, rosterCleared });
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
    // SignalWire phone webhooks (their own X-SignalWire-Signature) route ahead of
    // the Composio /inbound/ handler.
    if (req.url?.startsWith('/inbound/phone/voice')) {
      await handlePhoneVoice(req, res);
      return;
    }
    if (req.url?.startsWith('/inbound/phone/recording')) {
      await handlePhoneRecording(req, res);
      return;
    }
    if (req.url?.startsWith('/inbound/')) {
      await handleInbound(req, res);
      return;
    }
    // Host badge pull — gated by the host token, same pre-allowlist placement.
    if (req.url === '/control/badges' && req.method === 'GET') {
      await handleBadgePull(req, res);
      return;
    }
    // Host recycle-completion report — same host-token gate + placement.
    if (req.url === '/control/sandboxes' && req.method === 'POST') {
      await handleSandboxReport(req, res);
      return;
    }
    // Dispatch-board Mini App — self-authenticated by Telegram initData (board
    // traffic is users' public browsers, not the gateway), so like /inbound/
    // and /control/ it must route BEFORE the IP allowlist. Only POSTs carry a
    // body, and it is CAPPED: this path is pre-auth AND its URL is handed to
    // every roster user via the Telegram menu button, so an unbounded read
    // would let any client balloon the shared process before auth runs.
    if (isBoardPath(req.url)) {
      let boardBody = '';
      if (req.method === 'POST') {
        // Honest oversized clients get a clean 413 via Content-Length before
        // any read; a length-less (chunked) flood is cut off mid-stream by
        // the read cap — no clean response owed to that caller.
        const BOARD_BODY_CAP = 64 * 1024;
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > BOARD_BODY_CAP) {
          res.writeHead(413);
          res.end();
          req.destroy();
          return;
        }
        try {
          boardBody = await readRawBody(req, BOARD_BODY_CAP);
        } catch (err) {
          if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
            if (!res.headersSent) {
              res.writeHead(413);
              res.end();
            }
            return;
          }
          throw err;
        }
      }
      await handleBoardRequest(req, res, boardBody);
      return;
    }
    // Operator cost dashboard — routed BEFORE the IP allowlist for the same
    // reason as the board: it loads in an operator's ordinary browser, not
    // through the gateway, so the allowlist would 403 every real user. It
    // authenticates itself with a bearer token, and the underlying tables have
    // RLS enabled so the anon key cannot reach the data around this handler.
    // GET-only, so no body to read or cap.
    if (isAdminPath(req.url)) {
      await handleAdminRequest(req, res);
      return;
    }
    // Customer account portal — same placement and reasoning as /admin above:
    // it loads in a customer's ordinary browser rather than through the
    // gateway, so the IP allowlist must not gate it. Static assets only today
    // (the app runs on mock data); its data endpoints will authenticate per
    // request and scope every read to one tenant.
    if (isPortalPath(req.url)) {
      await handlePortalRequest(req, res);
      return;
    }
    if (!allowed(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    // Composio relay — same signed-identity trust as the MCP path (it shares
    // this catch's bare 401 for identity failures). Must route BEFORE the MCP
    // fallthrough below, which serves every unrouted path.
    if (isRelayPath(req.url)) {
      await handleComposioRelay(req, res, await readRawBody(req));
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
