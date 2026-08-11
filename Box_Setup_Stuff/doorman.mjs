import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PORT   = Number(process.env.DOORMAN_PORT || 3001);
const BIND   = process.env.DOORMAN_BIND || '0.0.0.0';   // prefer the docker bridge IP
const SECRET = process.env.GATEWAY_IDENTITY_SECRET;
const UPSTREAM = process.env.MCP_UPSTREAM_URL;            // e.g. https://svc.onrender.com/
const BADGES_FILE = process.env.BADGES_FILE || '/etc/doorman/badges.json';

if (!SECRET) throw new Error('GATEWAY_IDENTITY_SECRET not set');
if (!UPSTREAM) throw new Error('MCP_UPSTREAM_URL not set');
const up = new URL(UPSTREAM);
// A real upstream must be https. Plain http is allowed toward LOOPBACK only,
// so the test harness (src/control/doorman.test.ts) can stand in as the
// upstream — a typo'd http:// URL for a real host refuses to boot rather than
// silently proxying identities in plaintext.
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];
if (up.protocol !== 'https:' && !(up.protocol === 'http:' && LOOPBACK.includes(up.hostname)))
  throw new Error(`MCP_UPSTREAM_URL must be https (got ${up.protocol}//${up.hostname})`);
const client = up.protocol === 'http:' ? http : https;
const upPort = up.port || (up.protocol === 'http:' ? 80 : 443);

// Allowlisted relay prefix: ONLY /composio (bare, slashed, or query form) keeps
// the sandbox's own path when forwarded — the Render composio relay lives there.
// Every other path goes to the configured upstream path exactly as before, so
// unknown paths cannot reach new upstream surfaces (fail-closed).
const RELAY_PREFIX = '/composio';
const isRelayed = (u) => u === RELAY_PREFIX || u.startsWith(RELAY_PREFIX + '/') || u.startsWith(RELAY_PREFIX + '?');

const sign = (t, r) => createHmac('sha256', SECRET).update(`${t}.${r}`).digest('hex');
const loadBadges = () => { try { return JSON.parse(readFileSync(BADGES_FILE, 'utf8')); } catch { return {}; } };
const badgeOf = (req) => { const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || ''); return m && m[1]; };

const server = http.createServer((req, res) => {
  const badge = badgeOf(req);
  if (!badge) { res.writeHead(401); return res.end('missing badge'); }
  // badges.json keys are sha256 FINGERPRINTS (since 2026-07-02): hash the
  // presented badge before lookup, so the file at rest can't authenticate.
  const fingerprint = createHash('sha256').update(badge).digest('hex');
  const entry = loadBadges()[fingerprint];                 // re-read per request: revocation is instant
  if (!entry || entry.revoked) { res.writeHead(403); return res.end('badge not authorized'); }

  // A client that vanishes mid-request must never throw — an unhandled stream
  // 'error' exits this process, which serves EVERY sandbox. (Node 22 survives
  // this path without the listener; older/newer versions are not guaranteed to.)
  req.on('error', () => {});
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const relayed = isRelayed(req.url || '');
    // build a fresh header set — do NOT forward the badge or any sandbox headers
    const headers = {
      'content-type': req.headers['content-type'] || 'application/json',
      'accept':       req.headers['accept'] || 'application/json, text/event-stream',
      'content-length': body.length,
      'x-tenant-id':          entry.tenantId,
      'x-technician-ref':     entry.technicianRef,
      'x-identity-signature': sign(entry.tenantId, entry.technicianRef),
    };
    if (relayed) {
      // MCP protocol headers ride through on the relay branch only (a stateful
      // streamable-HTTP upstream rejects post-initialize calls without them).
      for (const h of ['mcp-session-id', 'mcp-protocol-version']) {
        if (req.headers[h]) headers[h] = req.headers[h];
      }
    }
    const upReq = client.request(
      { hostname: up.hostname, port: upPort, path: relayed ? req.url : up.pathname + up.search, method: req.method, headers },
      // pipeline, not pipe (SSE streams ride through either): when EITHER side
      // dies mid-stream, pipeline destroys both ends; bare pipe() leaves the
      // source's 'error' unhandled, which exits this shared process.
      (upRes) => { res.writeHead(upRes.statusCode || 502, upRes.headers); pipeline(upRes, res, () => {}); }
    );
    upReq.on('error', (e) => {
      // Once the head has been relayed (mid-SSE reset), a 502 here would be a
      // SECOND writeHead — the 2026-08-04 crash (ERR_HTTP_HEADERS_SENT, whole
      // process down, every sandbox's in-flight MCP call with it). Mid-stream
      // the only honest signal left is cutting the client's connection.
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502); res.end('upstream error: ' + e.message);
    });
    // Client gone (agent restart, dropped SSE): stop the upstream leg instead
    // of streaming into a dead response. No-op after normal completion.
    res.on('close', () => upReq.destroy());
    upReq.end(body);
  });
});
server.listen(PORT, BIND, () =>
  // announce the ACTUAL bound port — with DOORMAN_PORT=0 (tests) the kernel picks it
  console.log(`doorman ${BIND}:${server.address().port} -> ${UPSTREAM}`));
