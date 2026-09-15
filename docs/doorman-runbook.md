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
      entrypoint (`node dist/mcp/httpServer.js`). The MCP endpoint is the service **root** `/`; the
      server ignores the request path for MCP **except** the reserved routes `/inbound/*`,
      `/control/badges`, and `/composio*` (the Composio relay, since 2026-07-06) — any other path is
      served as MCP. Use e.g. `https://<svc>.onrender.com/`.
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

Write `/opt/doorman/doorman.mjs`. The canonical, **tested** copy is
`Box_Setup_Stuff/doorman.mjs` in the repo (`src/control/doorman.test.ts` runs that exact file
against a stub upstream — the block below must stay byte-identical to it; it drifted once,
2026-07-06→08-11, and the drifted copy carried a process-killing bug):

```js
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
> procedure above remains the bootstrap/fallback path. See `Box_Setup_Stuff/badge-pull.sh` for the
> polling updater.
>
> **BEFORE enabling the pull timer on a host with existing badges:** register each existing
> badge's fingerprint server-side (`scripts/assign-host.mjs set-badge ref=<ref> hash=<sha256>`),
> or the first pull ERASES those entries (the file is regenerated wholesale from the roster) and
> mints competing replacements — the installed credentials then 403 with no error signal.

### Upgrading a legacy host (plaintext-keyed badges.json → fingerprints, one-time)

Hosts deployed before 2026-07-02 have badges.json keyed by the badge itself and the old doorman
code. There is deliberately NO dual-read fallback (it would turn a leaked hash-keyed file's
fingerprints into usable bearer tokens), so upgrade atomically — expect a few seconds of 403s:

```bash
sudo cp doorman.mjs /opt/doorman/doorman.mjs      # new code (inert until restart)
sudo python3 - <<'EOF'                            # rekey the file in place
import json, hashlib
p = '/etc/doorman/badges.json'
d = json.load(open(p))
json.dump({hashlib.sha256(k.encode()).hexdigest(): v for k, v in d.items()}, open(p, 'w'), indent=2)
EOF
sudo chown doorman:doorman /etc/doorman/badges.json && sudo chmod 600 /etc/doorman/badges.json
sudo systemctl restart doorman                    # immediately — old code + hashed file 403s
# verify: Step 6(a) curl with the PLAINTEXT badge still lists the 13 tools
```

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

# (a) positive: valid badge → tools/list returns the 13 tools
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

- (a) should list the **17** tools for a technician-tier badge: `record_field_note`,
  `find_customer`, `get_customer_context`, `get_job`, `get_capture`, `search_captures`,
  `resolve_date`, `list_recent_captures`, `web_search`, `read_webpage`, `send_email`,
  `retract_capture`, `record_standing_fact`, `get_schedule`, and — since build 5.5 —
  `inform_team_lead`, `ask_team_lead`, `inform_teammate` (`brief_customer` and
  `answer_customer_question` were retired 2026-09-15; `src/mcp/tools/surface.expected.ts` is the
  authority by name). (A badge whose roster row is
  an ACTIVE `tier='manager'` lists **42** as of 2026-09-15 — `surface.expected.ts`'s
  `MANAGER_TOOLS_EXPECTED` pins the list by name and is the authority when this line drifts —
  `get_schedule` and `search_captures` are REMOVED (2026-07-19: it is the technician route view; a
  manager's only schedule read is get_team_schedule, which includes visits they hold, and
  schedule viewing lives on the dispatch board) while the 8 seat/lifecycle-management tools are
  added: add/deactivate/reactivate technician seat, bind_telegram, list_team,
  list_pending_reviews, resolve_review, get_connect_link; plus the 4 scheduling tools since
  2026-07-14: get_team_schedule, book_visit, move_visit, cancel_visit; plus the 5
  schedule-input tools since 2026-07-20: set_availability, add_time_off, remove_time_off,
  set_job_duration, set_technician_skills (one-shot, no confirm); plus `find_slots` since
  2026-07-20 — the read-only ranked slot finder (books nothing; carries the board link like every schedule answer — originally excluded, which made the agent FABRICATE one, live 2026-07-21); plus `update_job` since 2026-07-21 — one-shot job-identity editor (title/jobType/priority, old→new echo); plus `set_technician_horizon` since 2026-07-22 — one-shot visibility dial (weeks 1-12, per-tenant; technician reads beyond it answer "not published yet"); see
  nemoclaw-tech-agent.md §4. Since 2026-07-19 `add_technician_seat` also takes `seatExempt:true`
  — a schedule-only person occupying NO seat, whom bind_telegram/get_connect_link refuse.
  2026-07-25 vocabulary change: `cancel_visit` RENAMED `unschedule_visit` (same behavior — off
  the calendar, job returns to the loose bucket; "cancel" now always means the terminal thing)
  and NEW `cancel_job` — terminal work cancellation, always two-step confirm, cascades its
  live visits. Historical lines above keep the old name as history.)
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
pull. **Remove a person** = deactivate them in the roster — the entry flips to `revoked: true`
on the next pull, and the server rejects their badge's tool calls immediately regardless.
**Leaked/lost badge (person stays)** = `assign-host.mjs rotate-badge ref=…` — the old badge
vanishes from the file on the next pull and a replacement mints in that same response.

⚠ **On a pull-enabled host, hand edits to badges.json last at most one poll interval** — the
file is regenerated wholesale from the roster. Hand-revoking `revoked: true` gets silently
UN-revoked ≤5 min later if the roster row is still active; a hand-added badge gets erased unless
its fingerprint is registered (`set-badge`). Use the server-side operations above; the manual
procedure below is for hosts WITHOUT the pull timer (bootstrap/fallback):

```bash
# issue a badge for a new sandbox (file is keyed by sha256 fingerprint)
NEW=$(openssl rand -hex 32); echo "$NEW"
HASH=$(printf %s "$NEW" | sha256sum | cut -d' ' -f1)
# → add  "<HASH>": { "tenantId": "...", "technicianRef": "...", "revoked": false }  to badges.json
# → if this host will EVER enable badge-pull: also register it —
#   scripts/assign-host.mjs set-badge ref=<ref> hash=<HASH>

# revoke one sandbox without touching others (non-pull hosts only — see ⚠ above)
# → set its "revoked": true in badges.json  (takes effect on the next request)
# → chown doorman:doorman + chmod 600 after EVERY hand edit (silent all-403 otherwise)
```

## Definition of done

- `systemctl status doorman` is active; logs show the bind line.
- Step 6(a) lists all 13 tools; 6(b) returns 403.
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
