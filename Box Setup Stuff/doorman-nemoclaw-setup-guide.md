# NemoClaw Box \+ Doorman \+ Trades-Spine Agent — Complete Setup Guide

End-to-end instructions to stand up, on a **fresh CPU-only cloud box**:

1. the NemoClaw box \+ a sandbox agent (NVIDIA cloud inference),  
2. the **doorman** badge-proxy (host-side bridge to the remote trades-spine MCP server on Render),  
3. the **sandbox→doorman wiring** (egress policy \+ badge credential \+ MCP config),  
4. **bake-in** so the trades-spine config survives a container recreate/rebuild,  
5. **reboot-resilience** so it all comes back after a stop/start.

**Architecture (Option A — gateway-mediated).** The sandbox holds only a **revocable badge**. The badge goes **sandbox → host doorman (`172.18.0.1:3001`) → Render**. The doorman validates the badge, adds the signed-identity headers, and forwards to Render. **The signing secret never leaves the host, and the sandbox never talks to Render directly.** (The older "direct-to-Render" approach — a signed `x-identity-signature` baked into the sandbox config — is **deprecated and excluded** from this guide.)

---

## 0\. Concepts & the 7 tools

- **Doorman**: a small Node HTTP service on the host. Binds the docker-bridge gateway `172.18.0.1:3001`. Reads `Authorization: Bearer <badge>`, looks the badge up in `/etc/doorman/badges.json`, computes the identity signature with the host-only secret, forwards to the Render upstream. Returns **200** (valid badge), **403** (unknown/revoked badge), **401** (no badge).  
- **Badge**: a low-value, revocable token. Lives in the sandbox's OpenShell provider store (never in the image, never on disk in plaintext). Reference badge (identity `tech-jane`): `3a6fb336ec39071493a98a1a44773a7b7fa09e73df61c9c71c9f11b3cd7e27ba`.  
- **The 7 trades-spine tools** (what a technician-tier badge sees — every count below assumes one): `record_field_note`, `find_customer`, `get_customer_context`, `get_job`, `list_recent_captures`, `brief_customer`, `answer_customer_question`. A badge whose `technicianRef` matches an **ACTIVE `tier='manager'`** row in the server's `technicians` table sees **14** (since 2026-07-02) — the 7 plus the seat/lifecycle tools `add_technician_seat`, `deactivate_technician_seat`, `reactivate_technician_seat`, `get_connect_link`, `list_team`, `list_pending_reviews`, `resolve_review`. The tier is decided **server-side by that roster row, not by the badge**; a badge with no matching active manager row acts as a plain technician (7 tools). The host/doorman does nothing tier-specific — it just forwards the badge.

**Naming convention used below** (don't mix these up):

- **`<AGENT>`** \= the sandbox name you pick at onboard (e.g. `s1`, `d1`). Used by **`nemoclaw <AGENT> …`**.  
- **`<AGENT>-telegram-bridge`** \= the OpenShell **provider** auto-created for that sandbox+channel. Used by **`openshell provider … <AGENT>-telegram-bridge`**.

---

## 1\. Create the box (CPU-only)

Inference runs on NVIDIA's cloud, so the box only needs CPU \+ RAM.

brev search cpu \--min-vcpu 4 \--min-ram 16 \--stoppable \--sort price

brev create nemoclaw-box \--type cpu-d3.4vcpu-16gb \--stoppable

- `--min-ram 16` is a floor (below 16 GB the image push can OOM during onboarding).  
- Sizing: \~1 active agent/vCPU; \~1 GB RAM per provisioned agent \+ \~6 GB base. Validate with `nemoclaw resources` / `free -h`.  
- A GPU box is **only** needed for a local model — skip for cloud inference.

---

## 2\. One-time box setup (do once per box)

brev shell nemoclaw-box           \# connect

nproc; free \-h; df \-h             \# confirm specs

\# Docker (CPU boxes usually lack it; nemoclaw needs it)

docker \--version || { sudo apt-get update && sudo apt-get install \-y docker.io; \\

  sudo systemctl enable \--now docker; sudo usermod \-aG docker $USER && newgrp docker; }

\# NVIDIA cloud inference key — re-export EVERY new shell session; rebuilds fail without it

export NVIDIA\_API\_KEY=\<your-nvapi-key\>

\# Install NemoClaw (first agent's onboard auto-runs)

curl \-fsSL https://nvidia.com/nemoclaw.sh | bash

After install, the NemoClaw source repo lives at **`/home/ubuntu/.nemoclaw/source/`** (Dockerfile \+ `scripts/` \+ `nemoclaw-blueprint/`). The bake-in edits in **§6** are applied here.

---

## 3\. Deploy the doorman (host-side)

The doorman is independent of any sandbox; set it up once per box.

### 3a. Discover the docker bridge (do NOT hardcode the interface name)

docker network inspect openshell-docker \\

  | grep \-E '"Subnet"|"Gateway"'        \# expect Subnet 172.18.0.0/16, Gateway 172.18.0.1

ip \-4 addr show | grep 172.18           \# shows the host bridge iface (e.g. br-XXduplicate — instance-specific)

Use the discovered **gateway IP** (normally `172.18.0.1`) as `DOORMAN_BIND` and in the UFW rules below.

The `openshell-docker` bridge only exists **after** the OpenShell gateway/sandbox has been created at least once (i.e. after your first `nemoclaw onboard` in §4). If `docker network inspect openshell-docker` doesn't exist yet, do §4 first, then come back. The doorman's systemd `RestartSec`/`StartLimitIntervalSec=0` (below) lets it wait for the bridge.

### 3b. Node for the service (ProtectHome hides /home)

The unit runs with `ProtectHome=true`, so it can't see the nvm node under `/home`. Copy it to a system path:

ls /home/ubuntu/.nvm/versions/node/\*/bin/node      \# find the installed node

sudo cp /home/ubuntu/.nvm/versions/node/v22.23.1/bin/node /usr/local/bin/node   \# adjust version

node \--version; /usr/local/bin/node \--version

### 3c. Code, secret, badges

sudo useradd \-r \-s /usr/sbin/nologin doorman 2\>/dev/null || true

sudo mkdir \-p /opt/doorman /etc/doorman

sudo cp doorman.mjs /opt/doorman/doorman.mjs        \# copy the doorman service code found here:  
–begin–  
import http from 'node:http';  
import https from 'node:https';  
import { createHash, createHmac } from 'node:crypto';  
import { readFileSync } from 'node:fs';

const PORT   \= Number(process.env.DOORMAN\_PORT || 3001);  
const BIND   \= process.env.DOORMAN\_BIND || '0.0.0.0';   // prefer the docker bridge IP  
const SECRET \= process.env.GATEWAY\_IDENTITY\_SECRET;  
const UPSTREAM \= process.env.MCP\_UPSTREAM\_URL;            // e.g. https://svc.onrender.com/  
const BADGES\_FILE \= process.env.BADGES\_FILE || '/etc/doorman/badges.json';

if (\!SECRET) throw new Error('GATEWAY\_IDENTITY\_SECRET not set');  
if (\!UPSTREAM) throw new Error('MCP\_UPSTREAM\_URL not set');  
const up \= new URL(UPSTREAM);

const sign \= (t, r) \=\> createHmac('sha256', SECRET).update(\`${t}.${r}\`).digest('hex');  
const loadBadges \= () \=\> { try { return JSON.parse(readFileSync(BADGES\_FILE, 'utf8')); } catch { return {}; } };  
const badgeOf \= (req) \=\> { const m \= /^Bearer\\s+(.+)$/i.exec(req.headers\['authorization'\] || ''); return m && m\[1\]; };

http.createServer((req, res) \=\> {  
  const badge \= badgeOf(req);  
  if (\!badge) { res.writeHead(401); return res.end('missing badge'); }  
  // badges.json keys are sha256 FINGERPRINTS (since 2026-07-02): hash the  
  // presented badge before lookup, so the file at rest can't authenticate.  
  const fingerprint \= createHash('sha256').update(badge).digest('hex');  
  const entry \= loadBadges()\[fingerprint\];                 // re-read per request: revocation is instant  
  if (\!entry || entry.revoked) { res.writeHead(403); return res.end('badge not authorized'); }

  const chunks \= \[\];  
  req.on('data', c \=\> chunks.push(c));  
  req.on('end', () \=\> {  
    const body \= Buffer.concat(chunks);  
    // build a fresh header set — do NOT forward the badge or any sandbox headers  
    const headers \= {  
      'content-type': req.headers\['content-type'\] || 'application/json',  
      'accept':       req.headers\['accept'\] || 'application/json, text/event-stream',  
      'content-length': body.length,  
      'x-tenant-id':          entry.tenantId,  
      'x-technician-ref':     entry.technicianRef,  
      'x-identity-signature': sign(entry.tenantId, entry.technicianRef),  
    };  
    const upReq \= https.request(  
      { hostname: up.hostname, port: up.port || 443, path: up.pathname \+ up.search, method: req.method, headers },  
      (upRes) \=\> { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res); } // pipe \= supports SSE streams  
    );  
    upReq.on('error', (e) \=\> { res.writeHead(502); res.end('upstream error: ' \+ e.message); });  
    upReq.end(body);  
  });  
}).listen(PORT, BIND, () \=\> console.log(\`doorman ${BIND}:${PORT} \-\> ${UPSTREAM}\`));  
–end–

\# Secret \+ config (mode 600, owned by doorman). GATEWAY\_IDENTITY\_SECRET must MATCH what Render expects.

sudo tee /etc/doorman/doorman.env \>/dev/null \<\<EOF

MCP\_UPSTREAM\_URL=https://tradesdatabase.onrender.com/

BADGES\_FILE=/etc/doorman/badges.json

DOORMAN\_PORT=3001

DOORMAN\_BIND=172.18.0.1

GATEWAY\_IDENTITY\_SECRET=\<PASTE\_THE\_REAL\_SECRET\_FROM\_YOUR\_PASSWORD\_MANAGER\>

EOF

\# Badge table (sha256-of-badge \-\> identity). Re-read per request, so revocation is instant.
\# The KEY below is sha256("3a6fb336…27ba") — the reference tech-jane badge's fingerprint.
\# The sandbox still presents the PLAINTEXT badge; the doorman hashes it before lookup.

sudo tee /etc/doorman/badges.json \>/dev/null \<\<'EOF'

{

  "025d11d5cde035beb88a1ecaef50bf296978a4361e0f5c39d90389a6f0d687e4": {

    "tenantId": "82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18",

    "technicianRef": "tech-jane",

    "revoked": false

  }

}

EOF

sudo chown \-R doorman:doorman /etc/doorman

sudo chmod 600 /etc/doorman/doorman.env /etc/doorman/badges.json

**Deployment-specific:** `GATEWAY_IDENTITY_SECRET` (must match Render — obtain it, never generate locally), `MCP_UPSTREAM_URL`, and the bridge gateway IP. The badge above is reusable (same `tech-jane` identity); mint a new one only if you want a distinct identity.

**Badge ↔ roster (since 2026-07-02) — read before minting a NON-technician badge.** The `technicianRef` you put here is looked up in the server's `technicians` table, and that row's **tier** decides what the badge can do: an active `tier='manager'` row → the manager tool surface (incl. seat management); anything else (technician, inactive, or no row) → the plain 7. So a *manager* badge is a two-part action you can't complete from the host alone: whoever manages the server DB must have an **active manager roster row** for that ref FIRST, then you mint the badge here with the byte-identical ref. To mint another badge BY HAND: `BADGE=$(openssl rand -hex 32)` (give the plaintext to exactly one sandbox), key its entry by the FINGERPRINT `printf %s "$BADGE" | sha256sum | cut -d' ' -f1` — a plaintext-keyed entry silently 403s — add it as a sibling in the JSON object above (mind the comma), then **restore ownership — load-bearing**: `sudo chown doorman:doorman /etc/doorman/badges.json && sudo chmod 600 /etc/doorman/badges.json`. The doorman (user `doorman`) swallows read errors into an empty badge table, so a file left owned by your user (e.g. after `sudo mv` of a temp file) silently 403s EVERY badge, not just the new one (observed live 2026-07-02). `tech-jane` maps to an active technician row and is fine as-is for the technician path.

**Roster-driven badges (2026-07-02, preferred over hand edits once the box is stable):** the server can GENERATE this file from its roster and this host can keep itself in sync. Deploy `badge-pull.sh` (copied alongside this guide — its header has the full setup: root-only `/etc/doorman/badge-pull.env` holding `PULL_URL=https://<svc>.onrender.com/control/badges` + `HOST_PULL_TOKEN`, plus a 5-minute systemd timer; needs curl + jq). The token is printed ONCE by whoever runs `assign-host.mjs create-host` on the server side — obtain it from them. New team members' badges arrive in the pull response (`/root/pending-badges.jsonl`, plaintext exists only there): install each as the sandbox's provider credential (`openshell provider update <AGENT>-telegram-bridge --credential TRADES_SPINE_BADGE=<badge>` — mind the Placeholder VERSIONING trap in the architecture memory), then delete the line. Deactivations flip entries to `revoked:true` on the next pull — no hand edit, ownership handled by the script.

### 3d. systemd unit \+ reboot-race hardening

sudo tee /etc/systemd/system/doorman.service \>/dev/null \<\<'EOF'

\[Unit\]

Description=trades-spine MCP doorman

After=network-online.target

Wants=network-online.target

\[Service\]

User=doorman

EnvironmentFile=/etc/doorman/doorman.env

ExecStart=/usr/local/bin/node /opt/doorman/doorman.mjs

Restart=always

NoNewPrivileges=true

ProtectSystem=strict

ProtectHome=true

ReadOnlyPaths=/etc/doorman /opt/doorman

\[Install\]

WantedBy=multi-user.target

EOF

\# Hardening drop-in: the doorman binds 172.18.0.1:3001 which only exists once the

\# bridge is up. On reboot it races, crash-loops with EADDRNOTAVAIL, and the default

\# start-limit (5 in 10s) makes it give up \-\> 'failed'. This makes it retry forever.

sudo mkdir \-p /etc/systemd/system/doorman.service.d

sudo tee /etc/systemd/system/doorman.service.d/override.conf \>/dev/null \<\<'EOF'

\[Unit\]

StartLimitIntervalSec=0

After=docker.service

\[Service\]

RestartSec=5

EOF

sudo systemctl daemon-reload

sudo systemctl enable \--now doorman.service

systemctl is-active doorman.service       \# \-\> active

### 3e. Firewall (host-local sandbox→doorman crosses the bridge, gated by UFW)

GW=172.18.0.1   \# the discovered bridge gateway

sudo ufw allow from 172.18.0.0/16 to $GW port 3001 proto tcp comment 'doorman'

sudo ufw allow from 172.18.0.0/16 to $GW port 8080 proto tcp comment 'openshell gateway'   \# if not already present

### 3f. Verify host → doorman → Render \= 200 \+ 7 tools

BADGE=3a6fb336ec39071493a98a1a44773a7b7fa09e73df61c9c71c9f11b3cd7e27ba

curl \-s \-o /dev/null \-w 'HTTP %{http\_code} in %{time\_total}s\\n' \\

  \-X POST http://172.18.0.1:3001/mcp \\

  \-H "Authorization: Bearer $BADGE" \\

  \-H 'Content-Type: application/json' \-H 'Accept: application/json, text/event-stream' \\

  \-d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

\# Expect HTTP 200 (Render free-tier COLD START can take \~32s the first time; warm \~0.3s).

\# Bogus badge \-\> 403; no badge \-\> 401\.

---

## 4\. Create the sandbox agent (onboard)

nemoclaw onboard      \# if port 8080 is blocked: sudo kill \<PID\>; sudo lsof \-i :8080; re-run

Answer the prompts: provider **1 (NVIDIA Endpoints)**; API key (reuses stored / paste `nvapi-…`); cloud model: **the target model is the GLM line — `z-ai/glm-5.2` as of 2026-07-02** (Nemotron-3 Super proved too weak; don't pick it. GLM-5.1 was retired by NVIDIA — 410s). If the GLM model isn't offered in the onboard menu, pick anything and set it afterward with `nemoclaw inference set --provider nvidia-prod --model z-ai/glm-5.2 --sandbox <AGENT>` (the supported path — updates the gateway route + all openclaw.json refs). **Confirm the exact id first** against the live catalog **from the HOST** — `curl -s https://integrate.api.nvidia.com/v1/models` is public, no key (nemoclaw's `--verify` can't reach NVIDIA from inside the gateway container; it fails on connection, not auth). Then: **Sandbox name \= `<AGENT>`**; Apply config **Y**; Brave search **N**; messaging channel (e.g. Telegram — paste bot token \+ your user ID); Resource profile **2 (gamer 25%)**; Policy tier **Enter**; Presets **Enter**. First build ≈ 8 min.

nemoclaw list

nemoclaw \<AGENT\> status         \# Connected: yes (field can lag; trust the agent log)

A second agent on another port: `NEMOCLAW_GATEWAY_PORT=<port> nemoclaw onboard`.

**Bake-in note:** if you applied §6 **before** this onboard, the sandbox already comes up with `toolSearch:false` \+ the trades-spine MCP block. If not, the manual wiring in §5 still works now and you can adopt the bake-in later.

---

## 5\. Wire the agent to the doorman (trades-spine)

Three things: an egress policy, the runtime badge credential, and the MCP config. (If §6 bake-in is in place, the MCP config \+ toolSearch are already baked — you still need 5a \+ 5b after every rebuild/onboard.)

### 5a. Egress policy — let the sandbox dial the host doorman

Create `~/trades-spine-doorman-egress-policy.yaml`:

preset:

  name: trades-spine-doorman

  description: "On-host doorman bridge to trades-spine MCP (host.openshell.internal:3001)"

network\_policies:

  trades\_spine\_doorman:

    name: trades\_spine\_doorman

    endpoints:

      \- host: host.openshell.internal

        port: 3001

        protocol: rest

        enforcement: enforce

        allowed\_ips:               \# MANDATORY: OpenShell's SSRF guard rejects private

          \- 10.0.0.0/8             \# host-gateway IPs (172.18.0.1) unless allowlisted.

          \- 172.16.0.0/12          \# These are STATIC RFC1918 ranges — NOT the box's

          \- 192.168.0.0/16         \# rotating public egress IP.

        rules:

          \- allow: { method: POST, path: "/\*\*" }

          \- allow: { method: GET, path: "/\*\*" }

          \- allow: { method: DELETE, path: "/\*\*" }

    binaries:

      \- { path: /usr/local/bin/node }

      \- { path: /usr/bin/node }

      \- { path: /usr/bin/curl }

Apply it (uses the **sandbox** name):

nemoclaw \<AGENT\> policy-add \--from-file \~/trades-spine-doorman-egress-policy.yaml \--yes

### 5b. Register the badge as a provider credential (runtime secret, never in image/disk)

Uses the **provider** name `<AGENT>-telegram-bridge`. OpenShell's egress proxy substitutes `openshell:resolve:env:TRADES_SPINE_BADGE` from this store at request time (same mechanism as the telegram bot token).

openshell provider update \<AGENT\>-telegram-bridge \\

  \--credential TRADES\_SPINE\_BADGE=3a6fb336ec39071493a98a1a44773a7b7fa09e73df61c9c71c9f11b3cd7e27ba

openshell provider get \<AGENT\>-telegram-bridge | grep \-i 'Credential keys'   \# \-\> TRADES\_SPINE\_BADGE, TELEGRAM\_BOT\_TOKEN

In a security-restricted Claude session this command is blocked as a secret-store write — run it yourself.

**WARNING — a provider credential write like this can silently kill OTHER channels.** At container
boot, the start script rewrites canonical placeholders in openclaw.json to a revision-scoped form
(`openshell:resolve:env:v<NUM>_KEY`) frozen to that boot's provider generation; the version bump this
`provider update` causes then breaks any placeholder still carrying the OLD frozen version (observed
2026-07-02: the Telegram bot token — bridge logs `credential placeholder mismatch`, bot goes deaf).
If a channel dies after a credential write, see the **"Placeholder VERSIONING trap"** gotcha in
`doorman-architecture-memory.md` for the diagnostic and fix (restore the canonical placeholder +
recompute the config hash + restart).

### 5c. MCP config \+ toolSearch (only if NOT using the §6 bake-in)

The agent config is `/sandbox/.openclaw/openclaw.json` (agent runs as user `sandbox`, HOME `/sandbox`). It's on the container **writable layer** — a *recreate* wipes it (that's why §6 exists). Manual form (container id from `docker ps`):

sudo docker exec \-u sandbox \<CID\> sh \-lc 'python3 \- \<\<EOF

import json

p="/sandbox/.openclaw/openclaw.json"; d=json.load(open(p))

d.setdefault("mcp",{}).setdefault("servers",{})\["trades-spine"\]={

  "transport":"streamable-http","url":"http://host.openshell.internal:3001/",

  "headers":{"Authorization":"Bearer openshell:resolve:env:TRADES\_SPINE\_BADGE"}}

d.setdefault("tools",{})\["toolSearch"\]=False     \# nemotron cannot drive code mode

json.dump(d,open(p,"w"),indent=2)

EOF'

Then clean-restart the agent: `sudo docker exec <CID> pkill -9 -x openclaw` (the in-container supervisor respawns it).

**Why `toolSearch:false`?** With `toolSearch:true` ("code mode") OpenClaw hides tools behind a code bridge; the Nemotron model can't drive it (it invents `openclaw.tools.list()` / `require(...)`) and every tool call fails with "**run bridge code failed**". `false` exposes the 7 tools as direct function calls.

### 5d. Verify end-to-end

Message the agent's bot something that needs a tool ("list recent captures"). On the host, OCSF shows the resolution \+ acceptance:

sudo docker exec \<CID\> sh \-lc 'grep 3001 /var/log/openshell.$(date \+%F).log | tail \-3'

\# \-\> ALLOWED /usr/local/bin/node(\<pid\>) \-\> host.openshell.internal:3001 \[policy:trades\_spine\_doorman\]

and the bot returns real trades-spine data. (Pre-warm Render with the §3f curl first so the agent's first connect beats the 30s MCP timeout.)

---

## 6\. Bake-in — make trades-spine survive a container recreate/rebuild

A container **recreate** wipes `/sandbox/.openclaw/openclaw.json`. The bake-in regenerates it at image-build time from 4 source edits in `/home/ubuntu/.nemoclaw/source/`. **A fresh box's source is upstream/clean — you must re-apply these 4 edits there before building.** None of them contain the secret (badge stays in the provider store).

**(1) New manifest** — `nemoclaw-blueprint/model-specific-setup/openclaw/nemotron-3-super-toolsearch-off.json` (declarative `toolSearch:false` for Nemotron, consumed by the generator). **⚠ Model note (2026-07-02): this manifest matches ONLY the Nemotron modelId. The running model is now `z-ai/glm-5.2`, so on a FRESH box it does NOT apply and toolSearch comes up on (s1 still carries `toolSearch:false` from the old bake). Whether GLM-5.2 can drive code mode is unverified — if the agent's tool calls fail with "run bridge code failed", clone this manifest with `z-ai/glm-5.2` in `match.modelIds` (or set `tools.toolSearch:false` directly) and update this note with the verified answer.**

{

  "$schema": "../schema.json",

  "id": "nemotron-3-super-toolsearch-off",

  "agent": "openclaw",

  "description": "Nemotron-3-Super cannot drive OpenClaw code mode (tool\_search\_code); it hallucinates the bridge API and every tool call fails with 'run bridge code failed'. Disable toolSearch so tools — including MCP servers like trades-spine — are exposed directly as native function calls.",

  "match": { "modelIds": \["nvidia/nemotron-3-super-120b-a12b"\] },

  "effects": { "openclawTools": { "toolSearch": false } }

}

**(2) Generator** — `scripts/generate-openclaw-config.py`, insert just before the final `return config` in `build_config()` (after the `tools_web["search"]` block):

    \# ── Trades-spine MCP server (on-host doorman badge-proxy) ─────────

    \# Gated on NEMOCLAW\_TRADES\_SPINE\_ENABLED. Writes ONLY the openshell:resolve:env

    \# placeholder — the real badge is injected at runtime, never baked here.

    if \_truthy\_env\_default(env, "NEMOCLAW\_TRADES\_SPINE\_ENABLED", False):

        trades\_url \= (

            env.get("NEMOCLAW\_TRADES\_SPINE\_URL")

            or "http://host.openshell.internal:3001/"

        )

        config.setdefault("mcp", {}).setdefault("servers", {})\["trades-spine"\] \= {

            "transport": "streamable-http",

            "url": trades\_url,

            "headers": {

                "Authorization": "Bearer openshell:resolve:env:TRADES\_SPINE\_BADGE",

            },

        }

**(3) Runtime resolver (fallback)** — `scripts/nemoclaw-start.sh`, inside the `PYPLACEHOLDERS` Python heredoc, just before `if updated != config:` (flush-left to match that block):

\# Trades-spine MCP badge fallback: if TRADES\_SPINE\_BADGE is in the container env,

\# substitute it into the header. (The real path is OpenShell egress resolution from

\# the provider store; this is a harmless no-op when the badge isn't in env.)

trades\_badge \= os.environ.get("TRADES\_SPINE\_BADGE", "")

trades\_placeholder \= "openshell:resolve:env:TRADES\_SPINE\_BADGE"

mcp\_servers \= updated.get("mcp", {}) if isinstance(updated, dict) else {}

mcp\_servers \= mcp\_servers.get("servers", {}) if isinstance(mcp\_servers, dict) else {}

trades\_server \= mcp\_servers.get("trades-spine") if isinstance(mcp\_servers, dict) else None

if isinstance(trades\_server, dict) and isinstance(trades\_server.get("headers"), dict):

    auth \= trades\_server\["headers"\].get("Authorization")

    if isinstance(auth, str) and trades\_placeholder in auth:

        if not trades\_badge:

            warnings.append("\[mcp\] trades-spine Authorization is a placeholder but TRADES\_SPINE\_BADGE is missing from the runtime environment")

        elif trades\_badge.startswith(prefix):

            warnings.append("\[mcp\] trades-spine left unchanged because TRADES\_SPINE\_BADGE is itself an OpenShell placeholder")

        else:

            trades\_server\["headers"\]\["Authorization"\] \= auth.replace(trades\_placeholder, trades\_badge)

            refreshed.add("TRADES\_SPINE\_BADGE")

**(4) Dockerfile** — add the build flags next to `ARG NEMOCLAW_WEB_SEARCH_ENABLED`, and promote them in the `ENV` block (set ENABLED=1 to turn the bake-in on):

ARG NEMOCLAW\_TRADES\_SPINE\_ENABLED=1

ARG NEMOCLAW\_TRADES\_SPINE\_URL=

\# ...and in the ENV ... \\ block that promotes ARGs:

    NEMOCLAW\_TRADES\_SPINE\_ENABLED=${NEMOCLAW\_TRADES\_SPINE\_ENABLED} \\

    NEMOCLAW\_TRADES\_SPINE\_URL=${NEMOCLAW\_TRADES\_SPINE\_URL}

**Apply \+ verify:**

bash \-n scripts/nemoclaw-start.sh && python3 \-m py\_compile scripts/generate-openclaw-config.py   \# sanity

nemoclaw \<AGENT\> rebuild \--yes        \# needs NVIDIA\_API\_KEY exported; \~minutes; recreates the sandbox

\# Confirm the baked config:

sudo docker exec \<NEW\_CID\> sh \-lc 'python3 \-c "import json;d=json.load(open(\\"/sandbox/.openclaw/openclaw.json\\"));print(d\[\\"tools\\"\]\[\\"toolSearch\\"\], d\[\\"mcp\\"\]\[\\"servers\\"\]\[\\"trades-spine\\"\]\[\\"headers\\"\]\[\\"Authorization\\"\])"'

\# \-\> False  Bearer openshell:resolve:env:TRADES\_SPINE\_BADGE

**After EVERY `nemoclaw <AGENT> rebuild`** the restore only re-applies the standard presets (npm, pypi, huggingface, brew, brave, openclaw-pricing, telegram). **Re-run §5a** (the `trades-spine-doorman` egress preset) and confirm §5b (provider credential) is still present. The bake-in covers the config \+ toolSearch; it does NOT cover the egress preset.

---

## 7\. Reboot-resilience (survive box stop/start)

After a host reboot, three things otherwise need manual nudging:

| Component | Default | Fix |
| :---- | :---- | :---- |
| **doorman** | crash-loops on the bridge race → `failed` | the §3d drop-in (retries forever) — already durable |
| **openshell-gateway** (control plane :8080) | no autostart → dead | boot oneshot below, or `nemoclaw <AGENT> doctor` |
| **sandbox container \+ agent** | container autostarts (`restart=unless-stopped`); the in-container supervisor respawns the agent | usually fine; else `nemoclaw <AGENT> recover` |

Boot oneshot to revive the gateway:

sudo tee /etc/systemd/system/nemoclaw-boot.service \>/dev/null \<\<'EOF'

\[Unit\]

Description=Revive OpenShell gateway \+ sandboxes on boot

After=docker.service network-online.target

Wants=network-online.target

Requires=docker.service

\[Service\]

Type=oneshot

RemainAfterExit=yes

User=ubuntu

Environment=HOME=/home/ubuntu

ExecStartPre=/bin/sleep 25

ExecStart=/bin/bash \-c '/home/ubuntu/.local/bin/nemoclaw \<AGENT\> doctor || true'

\[Install\]

WantedBy=multi-user.target

EOF

sudo systemctl daemon-reload && sudo systemctl enable nemoclaw-boot.service

---

## 8\. Lifecycle, costs, gotchas

- **Pause billing:** `brev stop nemoclaw-box` / `brev start nemoclaw-box` (`brev refresh` if the CLI loses the instance). Box bills per running hour regardless of agent count; idle agents cost nothing on inference but hold RAM.  
- **`export NVIDIA_API_KEY=…` every new shell** — onboard/rebuild fail without it.  
- **Render cold start (\~32s) \> the agent's 30s MCP connect timeout.** Keep Render warm (paid/always-on, or pre-warm with the §3f curl) so the agent's first tool call doesn't time out.  
- **Container *recreate* wipes `/sandbox/.openclaw/openclaw.json`** → use §6 bake-in. *Restart/reboot* preserve it.  
- **Egress IP rotates across stop/start.** It currently does **not** gate the doorman→Render path, so no action needed; do not pin it anywhere.  
- **`device pairing required` loop after a rebuild:** a rebuild can reset `gateway.controlUi.dangerouslyDisableDeviceAuth`; the agent may run tools but fail to deliver its channel reply. If replies go missing post-rebuild, restore that flag in `/sandbox/.openclaw/openclaw.json`.  
- **Two-tier models (smart+dumb):** one model per provider. Add a second NVIDIA-Endpoints provider for Nano and point dumb agents at it; setting a model on a shared provider flips it for all agents on that provider.  
- **Don't reuse `docker exec … curl` to test the doorman from inside the sandbox** — the OpenShell proxy can't attribute that process and denies it (`failed to resolve peer binary`), a false negative. Test with a real agent turn instead.

---

## 9\. Quick reference — order of operations on a fresh box

1. `brev create` CPU box → `brev shell` → install Docker → `export NVIDIA_API_KEY` → install NemoClaw.  
2. (optional but recommended) apply the §6 bake-in edits to `/home/ubuntu/.nemoclaw/source/`.  
3. `nemoclaw onboard` → creates sandbox `<AGENT>` \+ provider `<AGENT>-telegram-bridge` \+ the `openshell-docker` bridge.  
4. Deploy the doorman (§3) → verify §3f \= 200 \+ 7 tools.  
5. `nemoclaw <AGENT> policy-add` egress preset (§5a) \+ `openshell provider update` badge (§5b).  
6. If you skipped the bake-in: write the MCP config \+ `toolSearch:false` (§5c).  
7. Message the bot → confirm a trades-spine tool returns real data (§5d).  
8. Install `nemoclaw-boot.service` (§7).

