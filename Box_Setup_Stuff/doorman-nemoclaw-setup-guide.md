# NemoClaw Box \+ Doorman \+ Trades-Spine Agent — Complete Setup Guide

End-to-end instructions to stand up, on a **fresh CPU-only cloud box**:

1. the NemoClaw box \+ a sandbox agent (NVIDIA cloud inference),  
2. the **doorman** badge-proxy (host-side bridge to the remote trades-spine MCP server on Render),  
3. the **sandbox→doorman wiring** (egress policy \+ badge credential \+ MCP config),  
4. **bake-in** so the trades-spine config survives a container recreate/rebuild,  
5. **reboot-resilience** so it all comes back after a stop/start.

**Automation (2026-07-03):** `bootstrap-box.sh` in this folder scripts the mechanical phases of
this guide (`apply-bakein.py` applies the §6 edits, anchor-checked and idempotent), and
`migration-runbook-lightsail.md` sequences a full host migration. This guide remains the
authority — the scripts cite its sections and fall back to it whenever an anchor drifts.

**Architecture (Option A — gateway-mediated).** The sandbox holds only a **revocable badge**. The badge goes **sandbox → host doorman (`172.18.0.1:3001`) → Render**. The doorman validates the badge, adds the signed-identity headers, and forwards to Render. **The signing secret never leaves the host, and the sandbox never talks to Render directly.** (The older "direct-to-Render" approach — a signed `x-identity-signature` baked into the sandbox config — is **deprecated and excluded** from this guide.)

---

## 0\. Concepts & the 10 tools

- **Doorman**: a small Node HTTP service on the host. Binds the docker-bridge gateway `172.18.0.1:3001`. Reads `Authorization: Bearer <badge>`, looks the badge up in `/etc/doorman/badges.json`, computes the identity signature with the host-only secret, forwards to the Render upstream. Returns **200** (valid badge), **403** (unknown/revoked badge), **401** (no badge).  
- **Badge**: a low-value, revocable token. Lives in the sandbox's OpenShell provider store (never in the image, never on disk in plaintext). **No badge plaintext appears anywhere in this guide, ever** — badges are minted by the server in the badge-pull response (`/root/pending-badges.jsonl` holds the one and only plaintext copy; install it as the provider credential, then delete the line). The old "reference badge" this guide used to print leaked into a transcript and was rotated dead on 2026-07-03.  
- **The 10 trades-spine tools** (what a technician-tier badge sees — every count below assumes one): `record_field_note` (two-step stage→confirm; since 2026-07-06), `find_customer`, `get_customer_context`, `get_job`, `list_recent_captures`, `brief_customer`, `answer_customer_question`, `send_email` (two-step confirm; since 2026-07-04), `retract_capture` (two-step; author-or-manager; since 2026-07-06), `get_schedule` (day-route with Google Maps link; since 2026-07-06 — the sandbox tool allowlist must name it or the agent cannot call it: the allowlist lives in the OpenClaw technician profile, see the repo's `docs/nemoclaw-tech-agent.md` §4; ALREADY-deployed sandboxes keep their old pinned list until that profile is updated and the agent restarted — the doorman-side tools/list check does NOT catch this, it bypasses the sandbox). A badge whose `technicianRef` matches an **ACTIVE `tier='manager'`** row in the server's `technicians` table sees **17** (since 2026-07-06 route release; 16 earlier on 2026-07-06 with retract_capture, 15 from 2026-07-04, 14 before) — the 10 plus the seat/lifecycle tools `add_technician_seat`, `deactivate_technician_seat`, `reactivate_technician_seat`, `get_connect_link`, `list_team`, `list_pending_reviews`, `resolve_review`. The tier is decided **server-side by that roster row, not by the badge**; a badge with no matching active manager row acts as a plain technician (10 tools). The host/doorman does nothing tier-specific — it just forwards the badge.

**Naming convention used below** (don't mix these up):

- **`<AGENT>`** \= the sandbox name you pick at onboard (e.g. `s1`, `d1`). Used by **`nemoclaw <AGENT> …`**.  
- **`<AGENT>-telegram-bridge`** \= the OpenShell **provider** auto-created for that sandbox+channel. Used by **`openshell provider … <AGENT>-telegram-bridge`**.

## 0b. Per-person Composio session via the doorman relay (SHIPPED 2026-07-06)

Beside `trades-spine`, each sandbox registers a second MCP server, `composio`, that reaches its
person's **Composio session** — the outbound connector surface (Gmail/Sheets/…, tier-scoped). It
is authenticated by the **SAME badge the sandbox already holds** — zero new sandbox secrets:

```jsonc
"composio": {
  "transport": "streamable-http",
  "url": "http://host.openshell.internal:3001/composio/",
  "headers": { "Authorization": "Bearer openshell:resolve:env:TRADES_SPINE_BADGE" }
}
```

The doorman routes the `/composio` path to a **Render relay route** (`src/composio/relayHandler.ts`)
that verifies the signed identity, looks up that person's `composio_session_id` in the roster, and
forwards ONLY to that session with the Composio API key attached **server-side** (Render env
`COMPOSIO_RELAY_API_KEY`, a scoped project key; master key is the fallback). The sandbox controls
request content only — never the destination session or the credential. **Per-person pinning is
the security boundary.**

*Why this shape (the §0b wiring that was BLOCKED 2026-07-05, resolved 2026-07-06):* a session's
`mcp.url` alone gets HTTP 401 (`require_mcp_api_key`, Composio default-on since March 2026), and
the only auth header the SDK supplies is the MASTER `COMPOSIO_API_KEY` — which would let a sandbox
act as ANY user. The relay keeps that key on Render. Live-probed 2026-07-06: Composio pins the
connected account to the session (a forged `connectedAccountId` in tool args is ignored), the
scoped key is accepted, and the session MCP responds SSE — so the doorman↔relay pipe carries it.

**Wiring:** the `composio` server block is **baked into the image** by `apply-bakein.py` (guide §6
edits 5+6, gated on the same `NEMOCLAW_TRADES_SPINE_ENABLED`) — a rebuild brings it up
automatically beside `trades-spine`. On a box not yet rebuilt, add it manually the §5c way (writable
layer) alongside `trades-spine`. No secretRef, no `provision-session.mjs` step — that script is now
diagnostics-only. **Render must have `COMPOSIO_RELAY_API_KEY` set** or the relay answers a clean
503 "not configured".

**Tier shape (enforced by Composio at execution — error code 4310, verified 2026-07-04):**
managers get the ENTIRE catalog + self-serve connector pairing (`manageConnections:true`);
technicians get a pinned read/draft list (`direct_tools` preset) with **send structurally
impossible** — technician sends go through the spine `send_email` tool (two-step confirm).

**Manager-agent instruction block (context-engineered safety — REQUIRED in every manager
sandbox's agent instructions; user decision 2026-07-04, no structural block on destructive
tools):**

> You can use many third-party tools, including ones that change things irreversibly (sending
> money, deleting records, emailing customers). Before ANY irreversible or destructive action:
> (1) tell the manager exactly what you are about to do, with the exact values; (2) wait for
> their explicit "yes" in this conversation; (3) only then act. Never chain multiple destructive
> actions on one approval. Remind the manager when relevant: **you are an AI and can make
> mistakes, and actions taken through you are logged by the business.**

**Disclosure (rollout obligation):** managers AND technicians must be told "emails sent via the
assistant are logged" — every send and state-changing connector action lands in the company's
permanent record (CLAUDE.md recorded exception 2026-07-04).

**Session lifecycle gotchas (operator):**
- **Deactivation deletes the person's session** (a live manager session could self-serve-pair NEW
  accounts during the grace period — so it goes down with the badge). On **reactivation** the
  15-min sweep mints a FRESH session at the person's current tier. **No sandbox re-provisioning
  is needed** — the relay reads `composio_session_id` from the roster per request, so it picks up
  the new session automatically. In the ≤15-min window between reactivation and the sweep the
  relay mints on demand (or answers 503 "session not ready" if the key is unset).
- **Tier change (e.g. manager demotion)** is a DB tier update PLUS a session teardown (null
  `composio_session_id`; the sweep re-mints at the new tier). Skipping the teardown leaves the
  old tier's session live — a demoted manager would keep the full catalog.

## 0c. Accuracy-rules block (REQUIRED in every sandbox, both tiers — since 2026-07-05)

Append the block below to the sandbox's `/sandbox/.openclaw/workspace/AGENTS.md` (loaded into
the agent's context at session start). Origin: in the first live send E2E the agent transcribed
the recipient's email address wrong in the staged draft — the user caught it at the confirm
step; this block makes the agent catch it first. **A container recreate/rebuild resets
AGENTS.md to the stock template — re-append after any rebuild** (§6 warning). Apply with:
`sudo docker exec -u sandbox <CID> sh -c 'cat >> /sandbox/.openclaw/workspace/AGENTS.md' <<'EOF' … EOF`

> ## Trades assistant — accuracy rules (host-managed; keep at top priority)
>
> You act for a real trades business through the trades-spine tools. Precision beats speed.
>
> 1. **Copy values character-for-character.** Email addresses, phone numbers, street addresses,
>    names, dollar amounts, job numbers, dates and times: NEVER retype these from memory.
>    Re-read the exact characters in the user's message and copy them into tool arguments.
> 2. **Double-check before showing anything for confirmation.** After staging an action (e.g.
>    send_email), compare every critical value in the staged copy against the user's original
>    message, character by character. If ANY character differs, fix it and re-stage BEFORE
>    showing it. The user should never be the one to catch a transcription error.
> 3. **Show, then wait.** Never treat your own message as approval. Show the exact staged
>    content and wait for an explicit yes. If the user corrects anything, re-stage and show the
>    corrected version in full.
> 4. **Missing or ambiguous detail? Ask.** Which Jones, which address, which date — never guess
>    a value that will leave the building.
> 5. When relevant, remind the user: you are an AI and can make mistakes, and emails and
>    actions sent through you are logged by the business.

**Second required block — permanent-record writes (added 2026-07-05 after a live incident):**
jane's agent inferred a customer from conversation context ("someone" → the previously-discussed
customer) and called record_field_note immediately — wrong-customer capture, permanent (L1 has
no delete). Append this block to every sandbox alongside the accuracy rules:

> ## Permanent-record writes — confirm FIRST (host-managed; added 2026-07-05, updated 2026-07-06)
>
> The company record (record_field_note and any tool that writes to it) is PERMANENT — there is
> no delete. For EVERY such write:
> 1. NEVER infer or assume the customer/job from earlier conversation when the current message
>    does not name one. "Someone", "a customer", "the guy from earlier" → ASK who.
> 2. ONE confirmation, using the server's preview: call the tool right away — staged tools
>    (record_field_note, send_email, retract_capture) record/send NOTHING on the first call;
>    they return the exact staged copy + a confirmId. Show THAT staged copy, wait for the
>    person's explicit yes, then confirm with ONLY the confirmId. Do NOT ask your own extra
>    "shall I?" before calling the tool — that double-asks the person (user feedback
>    2026-07-06: one confirmation is enough).
> 3. If a wrong note does get recorded: first record the corrected note, then retract the wrong
>    capture with retract_capture (captureId + reason — also confirm-gated). The original row is
>    never removed, but retracted notes disappear from briefings and lists; managers can still
>    see the full labeled trail.
> 4. Keep it conversational — don't lecture. Never volunteer reminders that the record is
>    permanent or that there is no delete; follow these rules silently and mention permanence
>    only when someone actually asks to delete or change history.

*(Prompt-level is layer 1. Layer 2 — the structural two-step stage→confirm on record_field_note,
mirroring send_email's pending_outbound_send — SHIPPED 2026-07-06 alongside retract_capture
(Option-B retraction rows). The server now refuses to write without a confirmed token; these
prompt rules remain as defense-in-depth and for conversation quality.)*

(Manager sandboxes get this block PLUS the §0b manager instruction block.)

---

## 1\. Create the box (CPU-only)

Inference runs on NVIDIA's cloud, so the box only needs CPU \+ RAM.

**Host platform is AWS Lightsail since 2026-07-04** (the Brev `nemoclaw-box` is retired — Brev
restarts were a capacity dice-roll and stuck-"starting" instances forced full rebuilds; see
`migration-runbook-lightsail.md` for the migration record and provisioning walkthrough).

Provision per the runbook Phase 1: Lightsail → OS Only → Ubuntu 22.04 LTS → the **16 GB bundle**
(4 vCPU / 16 GB / 320 GB, $84/mo — 16 GB is a hard floor, the image push OOMs below it) → attach a
**static IP** → firewall: SSH :22 only → add the `Host tradesbox` block to `~/.ssh/config`.

- `--min-ram 16` is a floor (below 16 GB the image push can OOM during onboarding).  
- Sizing: \~1 active agent/vCPU; \~1 GB RAM per provisioned agent \+ \~6 GB base. Validate with `nemoclaw resources` / `free -h`.  
- A GPU box is **only** needed for a local model — skip for cloud inference.

---

## 2\. One-time box setup (do once per box)

ssh tradesbox                     \# connect (plain SSH; Lightsail console "Connect" as fallback)

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

// Allowlisted relay prefix: ONLY /composio (bare, slashed, or query form) keeps  
// the sandbox's own path when forwarded — the Render composio relay lives there.  
// Every other path goes to the configured upstream path exactly as before, so  
// unknown paths cannot reach new upstream surfaces (fail-closed).  
const RELAY\_PREFIX \= '/composio';  
const isRelayed \= (u) \=\> u \=== RELAY\_PREFIX || u.startsWith(RELAY\_PREFIX \+ '/') || u.startsWith(RELAY\_PREFIX \+ '?');

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
    const relayed \= isRelayed(req.url || '');  
    // build a fresh header set — do NOT forward the badge or any sandbox headers  
    const headers \= {  
      'content-type': req.headers\['content-type'\] || 'application/json',  
      'accept':       req.headers\['accept'\] || 'application/json, text/event-stream',  
      'content-length': body.length,  
      'x-tenant-id':          entry.tenantId,  
      'x-technician-ref':     entry.technicianRef,  
      'x-identity-signature': sign(entry.tenantId, entry.technicianRef),  
    };  
    if (relayed) {                       // MCP protocol headers ride through on the relay branch only  
      // (a stateful streamable-http upstream rejects post-initialize calls without them)  
      for (const h of \['mcp-session-id', 'mcp-protocol-version'\]) {  
        if (req.headers\[h\]) headers\[h\] \= req.headers\[h\];  
      }  
    }  
    const upReq \= https.request(  
      { hostname: up.hostname, port: up.port || 443, path: relayed ? req.url : up.pathname \+ up.search, method: req.method, headers },  
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
\# Start EMPTY — the badge-pull timer (§ roster-driven badges below) populates it from the
\# server's roster and mints this box's badges in its first response. The sandbox presents
\# the PLAINTEXT badge; the doorman hashes it before lookup, so this file can't authenticate.

sudo tee /etc/doorman/badges.json \>/dev/null \<\<'EOF'

{}

EOF

sudo chown \-R doorman:doorman /etc/doorman

sudo chmod 600 /etc/doorman/doorman.env /etc/doorman/badges.json

**Deployment-specific:** `GATEWAY_IDENTITY_SECRET` (must match Render — obtain it, never generate locally), `MCP_UPSTREAM_URL`, and the bridge gateway IP. Badges come from the server: get this box registered (`create-host` + `assign` on the server side), deploy the pull (next sections), and the first pull mints them.

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

### 3f. Verify host → doorman → Render \= 200 \+ 10 tools

\# Use a badge minted by the pull: the plaintext is the "badge" field of the person's line
\# in /root/pending-badges.jsonl (or, if already installed+deleted, re-mint via server-side
\# rotate-badge and take it from the next pull). Never paste a badge into chat or docs.
BADGE=\<badge plaintext from /root/pending-badges.jsonl\>

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

> **Provider update 2026-07-06 — inference now routes to DeepInfra.** NVIDIA's free tier
> rate-limited live conversations (40 req/min), so the gateway inference route was flipped to
> metered DeepInfra: `openshell provider create -g nemoclaw --name deepinfra-prod --type
> deepinfra --credential DEEPINFRA_API_KEY=…` then `openshell inference set -g nemoclaw
> --provider deepinfra-prod --model zai-org/GLM-5.2` (NOTE the DeepInfra id spelling; NVIDIA's
> was `z-ai/glm-5.2`). The route FORCES the model id per request, so sandbox configs need no
> change — the sandbox banner still displaying "NVIDIA Endpoints" is cosmetic. `nvidia-prod`
> stays configured as instant rollback (`openshell inference set … --provider nvidia-prod
> --model z-ai/glm-5.2`). Gateway-level custom providers (e.g. OpenRouter) are NOT possible:
> cluster inference accepts only openai/anthropic/nvidia/deepinfra/google-vertex-ai/aws-bedrock.
> DeepInfra limit: 200 CONCURRENT requests per model (not per-minute); raiseable by contacting
> them. The onboarding prompts below still describe the original NVIDIA setup — fine for a
> fresh box; flip to DeepInfra afterwards with the two commands above.

Answer the prompts: provider **1 (NVIDIA Endpoints)**; API key (reuses stored / paste `nvapi-…`); cloud model: **the target model is the GLM line — `z-ai/glm-5.2` as of 2026-07-02** (Nemotron-3 Super proved too weak; don't pick it. GLM-5.1 was retired by NVIDIA — 410s). If the GLM model isn't offered in the onboard menu, pick anything and set it afterward with `nemoclaw inference set --provider nvidia-prod --model z-ai/glm-5.2 --sandbox <AGENT>` (the supported path — updates the gateway route + all openclaw.json refs). **Confirm the exact id first** against the live catalog **from the HOST** — `curl -s https://integrate.api.nvidia.com/v1/models` is public, no key (nemoclaw's `--verify` can't reach NVIDIA from inside the gateway container; it fails on connection, not auth). Then: **Sandbox name \= `<AGENT>`**; Apply config **Y**; Brave search **N**; messaging channel (e.g. Telegram — paste bot token \+ your user ID); Resource profile **2 (gamer 25%)**; Policy tier **Enter**; Presets **Enter**. First build ≈ 8 min.

nemoclaw list

nemoclaw \<AGENT\> status         \# Connected: yes (field can lag; trust the agent log)

A second agent on another port: `NEMOCLAW_GATEWAY_PORT=<port> nemoclaw onboard`.

### 4b. Non-interactive onboard (scriptable — verified live 2026-07-05, s2/manager-sam)

The wizard has an undocumented-but-working unattended mode; this is the seat-provisioning
recipe (a SECOND sandbox on the same box reuses the running gateway; dashboard port
auto-shifts). Every future seat should use this instead of the interactive wizard:

1. Build the messaging plan and **hydrate it with the vendor's own function** (a hand-written
   plan fails a strict validator, then a hooks-shape crash — hydration derives hooks/
   credentialBindings/displayName from the channel manifest):
   `node -e` → `require(dist/lib/messaging/persistence.js).hydrateDerivedSandboxMessagingPlanFields(plan)`
   → `require(dist/lib/messaging/applier/setup-applier.js).MessagingSetupApplier.encodePlan(hydrated)`
   → write to a root-only file. Minimal plan: `{schemaVersion:1, sandboxName, agent:"openclaw",
   workflow:"onboard", disabledChannels:[], networkPolicy:{presets:["telegram"],entries:[…]},
   channels:[{channelId:"telegram", active:true, configured:true, disabled:false, hooks:[],
   inputs:[{inputId:"allowedIds",value:"<tg-user-id>"},{inputId:"botToken",value:"<token>"},
   {inputId:"groupPolicy",value:"open"}]}]}` (+ empty arrays for credentialBindings/agentRender/
   buildSteps/stateUpdates/healthChecks).
   **⚠ Validate the bot token FIRST**: `curl -s https://api.telegram.org/bot<TOKEN>/getMe` must
   return ok:true — an invalid token surfaces only as a deep `deleteWebhook failed (404)`
   channel crash-loop after the whole build. **⚠ Transport the token base64-encoded** — shell
   heredoc quoting mangled it once (rejected by Telegram, cost a full debug cycle).
2. Run: `export NVIDIA_INFERENCE_API_KEY=nvapi-…` (required unconditionally in non-interactive
   mode, no stored-key reuse) + `NEMOCLAW_MESSAGING_PLAN_B64=$(cat <planfile>)` +
   `NEMOCLAW_MODEL=z-ai/glm-5.2`, then
   `nemoclaw onboard --non-interactive --yes --name <AGENT> --no-gpu --yes-i-accept-third-party-software`.
3. **The non-interactive path does NOT create the host-side provider** (the interactive wizard
   does). Create + attach it yourself, both credentials in one shot (values via files/env, never
   inline): `openshell provider create --name <AGENT>-telegram-bridge --type generic
   --credential TELEGRAM_BOT_TOKEN="$TOK" --credential TRADES_SPINE_BADGE="$BADGE"` then
   `openshell sandbox provider attach <AGENT> <AGENT>-telegram-bridge`. Without it the channel
   placeholder can't resolve and the bot is silently deaf.
4. Then the usual: §5a wire (egress + §0c blocks), §0b block for managers, `boot <AGENT>`
   (revive unit), badge flow (§3c/§5b), one `nemoclaw <AGENT> gateway restart` to clear
   device-pairing residue, and confirm `getUpdates` polling in the container logs — for BOTH
   sandboxes (provider writes + the versioning trap; this box does not boot-heal placeholders).

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

  \--credential TRADES\_SPINE\_BADGE=\<badge plaintext from /root/pending-badges.jsonl\>

openshell provider get \<AGENT\>-telegram-bridge | grep \-i 'Credential keys'   \# \-\> TRADES\_SPINE\_BADGE, TELEGRAM\_BOT\_TOKEN

Integrity check first: `sha256sum` the pending badge value and confirm the digest is a key in the freshly pulled `/etc/doorman/badges.json` — catches a file/roster mismatch without exposing plaintext. Then install, then delete the pending line. A credential **value swap** does not need an openclaw restart (the egress proxy resolves per-request); only the FIRST-ever registration needs one (lazy MCP connect). In a security-restricted Claude session this command is blocked as a secret-store write — run it yourself.

**WARNING — on an UNPATCHED box, a provider credential write like this can silently kill OTHER
channels.** At container boot, the stock start script rewrites canonical placeholders in
openclaw.json to a revision-scoped form (`openshell:resolve:env:v<NUM>_KEY`) frozen to that boot's
provider generation; the version bump this `provider update` causes then breaks any placeholder
still carrying the OLD frozen version (observed 2026-07-02: the Telegram bot token — bridge logs
`credential placeholder mismatch`, bot goes deaf). **FIXED at boot since 2026-07-03 by bake-in
edit (3b)** (§6) — with it applied, every container boot self-heals any stale versioned form, so
recovery from a killed channel is just a container restart. On a box without (3b), see the
**"Placeholder VERSIONING trap"** gotcha in `doorman-architecture-memory.md` for the manual fix
(restore the canonical placeholder + recompute the config hash + restart).

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

**Why `toolSearch:false`?** With `toolSearch:true` ("code mode") OpenClaw hides tools behind a code bridge; the Nemotron model can't drive it (it invents `openclaw.tools.list()` / `require(...)`) and every tool call fails with "**run bridge code failed**". `false` exposes the 10 tools as direct function calls.

### 5d. Verify end-to-end

Message the agent's bot something that needs a tool ("list recent captures"). On the host, OCSF shows the resolution \+ acceptance:

sudo docker exec \<CID\> sh \-lc 'grep 3001 /var/log/openshell.$(date \+%F).log | tail \-3'

\# \-\> ALLOWED /usr/local/bin/node(\<pid\>) \-\> host.openshell.internal:3001 \[policy:trades\_spine\_doorman\]

and the bot returns real trades-spine data. (Pre-warm Render with the §3f curl first so the agent's first connect beats the 30s MCP timeout.)

---

## 6\. Bake-in — make trades-spine survive a container recreate/rebuild

**⚠ Upstream drift (observed 2026-07-04 on a fresh install):** NVIDIA restructured the NemoClaw
source since this section was written. The config generator is now **TypeScript**
(`scripts/generate-openclaw-config.mts` — the `.py` no longer exists), and the PYPLACEHOLDERS
heredoc in `nemoclaw-start.sh` was rewritten around a `replacement_patterns` list (which still
only rewrites CANONICAL placeholder tokens — **the versioning trap is still present upstream**,
so edit (3b) is still required, in an adapted form). `apply-bakein.py` (this folder) auto-detects
old vs new layout and applies the correct variant of every edit; the manual instructions below
describe the OLD layout and remain valid only for boxes of that generation (e.g. the original
Brev box). The new manifest mechanism natively validates `effects.openclawTools.toolSearch`, so
edit (1) is unchanged. Edit (4)'s Dockerfile anchors are unchanged.

A container **recreate** wipes `/sandbox/.openclaw/openclaw.json`. The bake-in regenerates it at image-build time from 5 source edits in `/home/ubuntu/.nemoclaw/source/`. **A fresh box's source is upstream/clean — you must re-apply these 5 edits there before building.** None of them contain the secret (badge stays in the provider store). *(A 6th source edit — the gateway-JWT `ttl_secs` constant — lives in the same tree but affects gateway-config generation, not the image; see the token-expiry gotcha in §7.)*

**⚠ Recreate/rebuild also wipes the workspace instruction files** (`/sandbox/.openclaw/workspace/AGENTS.md` etc.) back to stock templates — the trades **accuracy-rules block** (§0c) must be re-appended after any rebuild. It is not part of the image bake.

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

**(3b) Placeholder self-heal (the versioning-trap fix, applied+verified live 2026-07-03)** — same file (`scripts/nemoclaw-start.sh`), same `PYPLACEHOLDERS` heredoc, in `refresh_openclaw_provider_placeholders()`. Replaces the canonical-only mapping with one that heals ANY on-disk form — canonical OR a stale revision-scoped `v<NUM>_KEY` frozen by a previous boot — to the CURRENT generation's form (the runtime env's placeholder when the provider snapshot exposes one, else canonical, which the egress proxy resolves to current). Without it, any provider credential write after a boot kills the channel until manual surgery (the trap in §5b's WARNING). Two hunks:

```diff
@@ import block @@
 import json
 import os
+import re
 import sys

 config_file = sys.argv[1]
 prefix = "openshell:resolve:env:"
 keys = os.environ.get("NEMOCLAW_PROVIDER_PLACEHOLDER_KEYS", "").split()
-replacements = {}
 warnings = []

-for key in keys:
+# Map ANY on-disk form of a managed placeholder — canonical or a stale
+# revision-scoped v<NUM>_KEY frozen by a previous boot — to the CURRENT
+# generation's form: the runtime env's placeholder when the provider snapshot
+# exposes one, else canonical (which the egress proxy resolves to current).
+# A config frozen to an old provider generation therefore heals on every boot
+# instead of requiring manual surgery.
+heal_keys = list(keys)
+if "TRADES_SPINE_BADGE" not in heal_keys:
+    heal_keys.append("TRADES_SPINE_BADGE")
+targets = {}
+for key in heal_keys:
     value = os.environ.get(key, "")
-    if value.startswith(prefix) and value != f"{prefix}{key}":
-        replacements[f"{prefix}{key}"] = (key, value)
+    targets[key] = value if value.startswith(prefix) else f"{prefix}{key}"
+placeholder_re = re.compile(
+    re.escape(prefix)
+    + r"(?:v\d+_)?("
+    + "|".join(re.escape(key) for key in heal_keys)
+    + r")(?![A-Za-z0-9_])"
+)
@@ def rewrite(value): @@
     if isinstance(value, str):
-        for old, (key, new) in replacements.items():
-            if old in value:
-                value = value.replace(old, new)
-                refreshed.add(key)
-        return value
+        def _heal(match):
+            key = match.group(1)
+            target = targets[key]
+            if match.group(0) != target:
+                refreshed.add(key)
+            return target
+        return placeholder_re.sub(_heal, value)
```

Design notes: the `(?![A-Za-z0-9_])` guard prevents partial-key matches (e.g. an unmanaged `SLACK_BOT_TOKEN_EXTRA`); `TRADES_SPINE_BADGE` is force-added to the heal set so a stale versioned badge header canonicalizes (which also re-enables edit (3)'s raw-badge fallback downstream); an all-canonical config with no env placeholders is left byte-identical (no spurious config-hash churn). **Deploy to a RUNNING container without a rebuild** by hot-copying the patched script over the container's boot path (`/usr/local/bin/nemoclaw-start`, root:root 755) — it takes effect at the next container boot; restarts and box reboots keep it, but a container **recreate** reverts to the unpatched image copy until the source edit is baked by a rebuild.

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

**⚠ New-generation NemoClaw (2026-07-04, discovered on the Lightsail box):** the table below
describes the OLD architecture. In the new one there is NO in-container supervisor that
respawns the agent — `nemoclaw-start` runs only as the create/rebuild flow's startup
transaction (`openshell sandbox create -- env nemoclaw-start`), so after ANY container
restart or box reboot the sandbox comes up as a bare shell and every recovery command
(`doctor`, `recover`, `gateway restart`) fails with `SUPERVISOR_UNAVAILABLE`. **A rebuild is
NOT required**: the working revival is a gateway-mediated re-exec of the startup command
(raw `docker exec` is rejected by the startup-owner guard) followed by a managed
`nemoclaw <AGENT> gateway restart` to clear the device-pairing residue. This is automated by
`nemoclaw-agent-revive.sh` + a per-agent `nemoclaw-agent-<AGENT>.service`
(installed by `bootstrap-box.sh boot <AGENT>`), which also self-heals runtime container
restarts (systemd re-runs the wrapper when the exec session drops). Verified end-to-end
2026-07-04: reboot AND Lightsail console stop/start both recover hands-off. Scales per
sandbox: one unit per agent, revivals run in parallel, seconds each.

**⚠ Sandbox-token expiry on reboot (2026-07-05, took trades-box-1 down after a Lightsail
restart):** the gateway mints each sandbox's auth JWT ONCE at create with
`gateway_jwt.ttl_secs` (**vendor default 3600 — one hour**), writes it to the host-side token
file (`~/.local/state/openshell/docker-sandbox-tokens/<pool>/<sandbox-id>/sandbox.jwt`,
bind-mounted into the container), and the running supervisor refreshes it **in memory only —
the file is never rewritten**. So ANY reboot later than ttl_secs after sandbox creation brings
the container up with an expired token it cannot refresh (`invalid token: ExpiredSignature`,
`static token sources cannot rebootstrap automatically`) and it crash-loops; the revive unit
can't help because PID1 never gets far enough to accept an exec. Two-part fix, both installed
on trades-box-1 2026-07-05:

1. **Source edit #6 (TTL):** `DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS = 3600` is a hardcoded
   constant in `~/.nemoclaw/source/{src/lib/onboard/docker-driver-gateway-config.ts,
   dist/lib/onboard/docker-driver-gateway-config.js}` — the gateway TOML is REGENERATED from it
   by `nemoclaw doctor` (hand-editing the TOML does not stick, and a validator asserts
   TOML == constant). Patch the constant to `2592000` (30 days) in BOTH files, then kill the
   gateway (`kill $(pgrep -x openshell-gatew)` — never `pgrep -f`, the pattern matches your own
   shell) and re-run `nemoclaw <AGENT> doctor` to regenerate.
2. **`sandbox-token-medic` (boot self-heal, this folder):** a oneshot systemd unit
   (`sandbox-token-medic.service`, ordered Before= the revive chain) that runs
   `sandbox-token-medic.mjs`: for every sandbox token file, if the JWT is expired (or expires
   within 10 min) it mints a replacement from the gateway's own signing key
   (`~/.local/state/nemoclaw/openshell-docker-gateway/jwt/`) with the same claims and restarts
   that container. Install:
   `sudo install -m 0755 sandbox-token-medic.mjs /usr/local/sbin/` +
   `sudo install -m 0644 sandbox-token-medic.service /etc/systemd/system/` +
   `sudo systemctl daemon-reload && sudo systemctl enable sandbox-token-medic.service`.
   Manual-run knobs: `RENEW_AHEAD_SECS=<n>` forces early re-mint, `NO_RESTART=1` heals the file
   without touching a healthy container. Coupling warning: it mints the vendor's token format
   (captured from OpenShell supervisor 0.0.71) — if a vendor upgrade changes the format, fall
   back to `nemoclaw <AGENT> rebuild --yes` and re-capture.

Upstream bug to report: the supervisor should persist refreshed tokens back to the token file.

After a host reboot, three things otherwise need manual nudging (OLD architecture):

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

- **Stop/start (Lightsail):** console Stop → Start is safe and fully self-reviving (verified 2026-07-04: doorman, gateway oneshot, badge timer, and the agent-revive service all recover hands-off; the static IP stays attached). Note a **stopped Lightsail instance still bills** — to truly pause spending, snapshot then delete the instance and restore later. Idle agents cost nothing on inference but hold RAM.  
- **`export NVIDIA_API_KEY=…` every new shell** — onboard/rebuild fail without it.  
- **Render cold start (\~32s) \> the agent's 30s MCP connect timeout.** Keep Render warm (paid/always-on, or pre-warm with the §3f curl) so the agent's first tool call doesn't time out.  
- **Container *recreate* wipes `/sandbox/.openclaw/openclaw.json`** → use §6 bake-in. *Restart/reboot* preserve it.  
- **Egress IP rotates across stop/start.** It currently does **not** gate the doorman→Render path, so no action needed; do not pin it anywhere.  
- **`device pairing required` loop after a rebuild:** a rebuild can reset `gateway.controlUi.dangerouslyDisableDeviceAuth`; the agent may run tools but fail to deliver its channel reply. If replies go missing post-rebuild, restore that flag in `/sandbox/.openclaw/openclaw.json`.  
- **Two-tier models (smart+dumb):** one model per provider. Add a second NVIDIA-Endpoints provider for Nano and point dumb agents at it; setting a model on a shared provider flips it for all agents on that provider.  
- **Don't reuse `docker exec … curl` to test the doorman from inside the sandbox** — the OpenShell proxy can't attribute that process and denies it (`failed to resolve peer binary`), a false negative. Test with a real agent turn instead.

---

## 9\. Quick reference — order of operations on a fresh box

1. Provision the Lightsail box (runbook Phase 1) → `ssh tradesbox` → `sudo ./bootstrap-box.sh prep` → `export NVIDIA_API_KEY` → `./bootstrap-box.sh nemoclaw`.  
2. (optional but recommended) apply the §6 bake-in edits to `/home/ubuntu/.nemoclaw/source/`.  
3. `nemoclaw onboard` → creates sandbox `<AGENT>` \+ provider `<AGENT>-telegram-bridge` \+ the `openshell-docker` bridge.  
4. Deploy the doorman (§3) → verify §3f \= 200 \+ 10 tools.  
5. `nemoclaw <AGENT> policy-add` egress preset (§5a) \+ `openshell provider update` badge (§5b).  
6. If you skipped the bake-in: write the MCP config \+ `toolSearch:false` (§5c).  
7. Message the bot → confirm a trades-spine tool returns real data (§5d).  
8. Install `nemoclaw-boot.service` (§7).

