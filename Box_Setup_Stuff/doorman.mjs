import http from 'node:http';
import https from 'node:https';
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

const sign = (t, r) => createHmac('sha256', SECRET).update(`${t}.${r}`).digest('hex');
const loadBadges = () => { try { return JSON.parse(readFileSync(BADGES_FILE, 'utf8')); } catch { return {}; } };
const badgeOf = (req) => { const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || ''); return m && m[1]; };

http.createServer((req, res) => {
  const badge = badgeOf(req);
  if (!badge) { res.writeHead(401); return res.end('missing badge'); }
  // badges.json keys are sha256 FINGERPRINTS (since 2026-07-02): hash the
  // presented badge before lookup, so the file at rest can't authenticate.
  const fingerprint = createHash('sha256').update(badge).digest('hex');
  const entry = loadBadges()[fingerprint];                 // re-read per request: revocation is instant
  if (!entry || entry.revoked) { res.writeHead(403); return res.end('badge not authorized'); }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    // build a fresh header set — do NOT forward the badge or any sandbox headers
    const headers = {
      'content-type': req.headers['content-type'] || 'application/json',
      'accept':       req.headers['accept'] || 'application/json, text/event-stream',
      'content-length': body.length,
      'x-tenant-id':          entry.tenantId,
      'x-technician-ref':     entry.technicianRef,
      'x-identity-signature': sign(entry.tenantId, entry.technicianRef),
    };
    const upReq = https.request(
      { hostname: up.hostname, port: up.port || 443, path: up.pathname + up.search, method: req.method, headers },
      (upRes) => { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res); } // pipe = supports SSE streams
    );
    upReq.on('error', (e) => { res.writeHead(502); res.end('upstream error: ' + e.message); });
    upReq.end(body);
  });
}).listen(PORT, BIND, () => console.log(`doorman ${BIND}:${PORT} -> ${UPSTREAM}`));
