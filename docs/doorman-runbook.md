# Doorman runbook — connecting NemoClaw/OpenClaw sandboxes to the central MCP server

This is a **self-contained handoff** for an agent (or operator) with shell access on the
**NemoClaw host** — the machine that runs the OpenShell/OpenClaw agent sandboxes. It stands up a
"doorman" proxy that lets sandboxed agents reach our central MCP server (deployed on **Render**)
without ever holding a real credential.

It assumes **no access to the design conversation, the rest of this repo, or any memory** — paste it
in cold. Follow the steps in order; do not skip the verification gates. If a step is ambiguous, fall
back to the **Invariants**, not to convenience.

Architecture context (the decision this implements): centralized MCP server, **Option A
(gateway-mediated)** with **Choice 1 (HTTPS + HMAC + IP allowlist, no mTLS — Render doesn't offer
mTLS)** and a **shared doorman with per-sandbox revocable badges**. See
[nemoclaw-tech-agent.md](nemoclaw-tech-agent.md) and
`thoughts/shared/research/2026-06-23-centralized-mcp-server-architecture-a.md`.

---

## Why this doorman exists — the OpenClaw ↔ identity-scheme gap

**What the Render MCP server requires.** Every request is authenticated by three headers (verified
server-side in `src/mcp/identity.ts`, `resolveIdentityFromHeaders` — reproduced here so you don't
need the repo):

```
x-tenant-id:          <tenant uuid>
x-technician-ref:     <technician>
x-identity-signature: HMAC-SHA256(GATEWAY_IDENTITY_SECRET, "<tenantId>.<technicianRef>")   // hex-encoded
```

The server recomputes that HMAC and rejects the request (`bad identity signature`) unless it matches
exactly. The signature *is* the proof of identity: a valid one for `tenantA.bob` lets the holder act
as that technician indefinitely (the payload has no timestamp or nonce, so it never expires).

**What OpenClaw can send.** OpenClaw's `mcpServers` config supports a `headers` map, but the values
are **static literals baked into `~/.openclaw/openclaw.json`**. OpenClaw has no notion of
tenant/technician identity and cannot compute an HMAC per request — it forwards whatever fixed
strings are in the config. Its native shape is a single `Authorization: Bearer <token>`.

**The gap.** The server wants a *computed, signed identity*; OpenClaw can only carry a *fixed string
it already holds*. The two direct ways to bridge that are both unsafe:

- *Bake the three signed headers into `openclaw.json`* → a permanent, non-expiring credential now
  lives inside the untrusted sandbox, readable by any process there, revocable only by rotating the
  global secret (which breaks every tenant at once).
- *Put `GATEWAY_IDENTITY_SECRET` in the sandbox so the agent signs* → the master secret in an
  untrusted box; any tenant can be forged.

**How the doorman closes it.** OpenClaw sends only a **badge** — a random throwaway token that means
nothing to Render. The doorman is the single place that holds the secret, maps
`badge → {tenantId, technicianRef}`, computes the HMAC per request, and injects the three real
headers before forwarding. OpenClaw's "static header only" limitation stops mattering, because the
static thing the sandbox holds (the badge) is individually revocable and useless if stolen — it's
accepted only by the doorman, never by Render. The doorman is a translator:
**static badge in → signed identity out.**

```
┌─ NemoClaw host ────────────────────────────────────────────┐
│  ┌ sandbox (untrusted) ┐   badge      ┌──────────┐          │
│  │ agent + OpenClaw     │──Bearer────► │ DOORMAN  │ holds    │
│  └──────────────────────┘              │ secret + │ secret   │
│                                        │ badges   │          │
└────────────────────────────────────────┴────┬─────┴─────────┘
              HTTPS + x-tenant-id / x-technician-ref / x-identity-signature
                                               ▼
                            ┌─ Render: central MCP server ─┐
                            │  verifies HMAC, enforces      │
                            │  tenant guards                │
                            └───────────────────────────────┘
```

---

## Invariants (load-bearing — never trade them for convenience)

1. **No secret in a sandbox.** `GATEWAY_IDENTITY_SECRET` and the badge table live only on the host,
   readable only by the doorman. A sandbox holds nothing but its own badge. If a step seems to
   require putting the secret or a signed header in a sandbox, you've gone wrong — stop.
2. **Signing must match byte-for-byte.** The doorman's HMAC must be identical to what Render
   verifies, or every request 401s. Scheme: `HMAC-SHA256(secret, "<tenantId>.<technicianRef>")`,
   hex-encoded. No extra whitespace, no trailing newline, exact dot separator.
3. **Fail closed.** Unknown, malformed, or revoked badge → reject at the doorman; the request must
   never reach Render. Default-deny on anything you're unsure about (e.g., if host↔sandbox routing
   is unclear, do **not** open the doorman to the public internet to "make it work").
4. **The verification gates (Step 6) must pass before you declare done.** A running process is not a
   working one.

## Values you must obtain first (you cannot infer these)

- [ ] **Render MCP base URL** — the `.onrender.com` URL of the service running this repo's HTTP
      entrypoint (`node dist/mcp/httpServer.js`). The MCP endpoint is the service **root** `/` — there
      is no `/mcp` subpath; the server ignores the request path entirely. Use e.g.
      `https://<svc>.onrender.com/`.
- [ ] **`GATEWAY_IDENTITY_SECRET`** — the exact value currently set on the Render service.
- [ ] **Tenant UUID(s) and technician ref(s)** — one `{tenantId, technicianRef}` pair per sandbox.
- [ ] **Someone who can set Render env vars** (`ALLOWED_CLIENT_IPS`) in the Render dashboard — you'll
      provide the host's outbound IP in Step 4. Also confirm Render's service binds the port it's
      given: the server reads `MCP_HTTP_PORT` (default 8080), so the deploy must set `MCP_HTTP_PORT`
      to Render's assigned `PORT` or the service is unreachable.

---

## Step 0 — Verify environment and host↔sandbox reachability

```bash
node --version            # need Node 18+ (the doorman uses only built-in modules)
ip -4 addr show docker0   # note the bridge gateway IP (often 172.17.0.1)
```

Confirm how a sandbox reaches the host. From inside a running sandbox container:

```bash
getent hosts host.docker.internal || echo "no host.docker.internal — use the bridge IP instead"
```

If `host.docker.internal` doesn't resolve in the sandbox, you'll point OpenClaw at the `docker0`
bridge gateway IP instead. **Record whichever address works — call it `DOORMAN_ADDR`.** Do not work
around a routing problem by binding the doorman to a public interface (Invariant 3).

## Step 1 — Create the doorman service

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin doorman || true
sudo mkdir -p /opt/doorman /etc/doorman
```

Write `/opt/doorman/doorman.mjs`:

```js
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
```

## Step 2 — Secrets and the badge table

```bash
# env file — readable only by the doorman user
sudo tee /etc/doorman/doorman.env >/dev/null <<'EOF'
GATEWAY_IDENTITY_SECRET=<paste the exact value set on Render>
MCP_UPSTREAM_URL=https://<svc>.onrender.com/
BADGES_FILE=/etc/doorman/badges.json
DOORMAN_PORT=3001
DOORMAN_BIND=172.17.0.1
EOF

# issue the first badge (random 256-bit token). Since 2026-07-02 badges.json is
# keyed by the badge's sha256 FINGERPRINT — the file at rest can't authenticate.
BADGE=$(openssl rand -hex 32)
HASH=$(printf %s "$BADGE" | sha256sum | cut -d' ' -f1)   # macOS: shasum -a 256
sudo tee /etc/doorman/badges.json >/dev/null <<EOF
{
  "$HASH": { "tenantId": "<firm-tenant-uuid>", "technicianRef": "<technician>", "revoked": false }
}
EOF
echo "issued badge for this sandbox: $BADGE"     # give this to exactly one sandbox

sudo chown -R doorman:doorman /etc/doorman
sudo chmod 600 /etc/doorman/doorman.env /etc/doorman/badges.json
```

The badge file is the badge→identity table and the revocation list in one. The doorman re-reads it
on every request, so issuing or revoking a badge takes effect with no restart.

> **Roster-driven mode (2026-07-02, preferred):** the server generates this file from the
> `technicians` roster — the host fetches it from `GET /control/badges` on the Render service,
> authenticated by a per-host pull token (registered with `scripts/assign-host.mjs create-host`;
> only its fingerprint is stored server-side). Brand-new people get their badge minted inside the
> pull response (`newBadges` — the only moment the plaintext exists; install it as the sandbox's
> provider credential). Deactivated people arrive as `revoked: true` on the next pull. The manual
> procedure above remains the bootstrap/fallback path. See `Box Setup Stuff/badge-pull.sh` for the
> polling updater.

## Step 3 — Run it as a hardened service

```bash
sudo tee /etc/systemd/system/doorman.service >/dev/null <<'EOF'
[Unit]
Description=trades-spine MCP doorman
After=network-online.target

[Service]
User=doorman
EnvironmentFile=/etc/doorman/doorman.env
ExecStart=/usr/bin/node /opt/doorman/doorman.mjs
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/doorman /opt/doorman

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now doorman
sudo systemctl status doorman --no-pager
journalctl -u doorman -n 20 --no-pager   # expect "doorman 172.17.0.1:3001 -> https://..."
```

## Step 4 — Network: bind, egress, and Render allowlist

- **Bind narrowly.** `DOORMAN_BIND=172.17.0.1` (the bridge IP) keeps the doorman off any public
  interface. If the host has a public IP, also firewall the port:
  `sudo ufw deny in on <public-iface> to any port 3001`.
- **NemoClaw egress policy.** Through NemoClaw's network-approval flow (operator TUI), allow only:
  sandbox → `DOORMAN_ADDR:3001`, and host → the Render hostname on 443. Everything else stays
  blocked.
- **Render allowlist (operator sets this in the Render dashboard).** Find the host's outbound IP:
  `curl -s https://api.ipify.org`. Set Render's `ALLOWED_CLIENT_IPS` to that IP. Confirm Render's
  `GATEWAY_IDENTITY_SECRET` equals the one in `doorman.env`. (Render web services are public by
  default — the HMAC blocks tenant impersonation, but the IP allowlist is what keeps unsigned probe
  traffic off entirely.)

## Step 5 — Wire one sandbox

In that sandbox's `~/.openclaw/openclaw.json`, add the server (badge only — no secret):

```jsonc
"mcpServers": {
  "trades-spine": {
    "transport": "streamable-http",
    "url": "http://host.docker.internal:3001/",   // or http://172.17.0.1:3001/ if that's DOORMAN_ADDR
    "headers": { "Authorization": "Bearer <the badge from Step 2>" }
  }
}
```

## Step 6 — Verify (gate before declaring done)

Run on the host. Responses may be SSE, so use `-N`.

```bash
BADGE=<the issued badge>

# (a) positive: valid badge → tools/list returns the 7 tools
curl -sN -X POST http://172.17.0.1:3001/ \
  -H "Authorization: Bearer $BADGE" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# (b) negative: revoked/unknown badge → 403, request never reaches Render
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://172.17.0.1:3001/ \
  -H "Authorization: Bearer deadbeef" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # expect 403
```

- (a) should list the 7 tools for a technician-tier badge: `record_field_note`, `find_customer`,
  `get_customer_context`, `get_job`, `list_recent_captures`, `brief_customer`,
  `answer_customer_question`. (A badge whose roster row is an ACTIVE `tier='manager'` lists 12 —
  the 5 seat-management tools are added; see nemoclaw-tech-agent.md §4, 2026-07-02.)
  - `401 / bad identity signature` from upstream → `GATEWAY_IDENTITY_SECRET` differs between host and
    Render (Invariant 2).
  - connection error to upstream → the host isn't on Render's `ALLOWED_CLIENT_IPS` (Step 4).
- (b) must return `403`. If a bad badge reaches Render, the doorman is failing open — stop and fix
  (Invariant 3).
- **Definitive end-to-end:** launch the agent in the wired sandbox and have it call a read tool
  (e.g. ask it to look up a customer). That exercises the full sandbox → doorman → Render path with
  a real badge.

## Ongoing ops

Roster-driven (preferred, 2026-07-02): issue = assign the person to this host
(`scripts/assign-host.mjs assign ref=… host=… sandbox=…`) — the badge mints on the host's next
pull; revoke = deactivate the person in the roster — the entry flips to `revoked: true` on the
next pull (the roster gate on the server cuts mail/tools instantly regardless).

Manual fallback (also how to act faster than the poll interval):

```bash
# issue a badge for a new sandbox (file is keyed by sha256 fingerprint)
NEW=$(openssl rand -hex 32); echo "$NEW"
HASH=$(printf %s "$NEW" | sha256sum | cut -d' ' -f1)
# → add  "<HASH>": { "tenantId": "...", "technicianRef": "...", "revoked": false }  to badges.json

# revoke one sandbox without touching others
# → set its "revoked": true in badges.json  (takes effect on the next request)
# → chown doorman:doorman + chmod 600 after EVERY hand edit (silent all-403 otherwise)
```

## Definition of done

- `systemctl status doorman` is active; logs show the bind line.
- Step 6(a) lists all 7 tools; 6(b) returns 403.
- An agent in a wired sandbox successfully calls a tool.
- No secret or signed header exists inside any sandbox — only a badge.

---

## Notes / future hardening

- **Permanent signatures.** The HMAC payload is `"<tenantId>.<technicianRef>"` with no timestamp or
  nonce, so a leaked *signature* never expires. This is contained here because the signature lives
  only on the doorman and the sandbox holds a revocable badge instead. The MCP-spec-aligned next step
  (deferred "Option B") is per-bot scoped JWTs validated as an OAuth Resource Server, which would
  swap only `resolveIdentityFromHeaders` server-side and the doorman's header-minting client-side.
- **True mTLS (deferred "Choice 2").** Render's managed services don't offer mutual TLS. If a
  compliance requirement later demands it, front the MCP server with your own ingress/tunnel that
  terminates mTLS, rather than relying on Render's endpoint.
