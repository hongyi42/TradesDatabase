---
name: doorman-trades-spine-architecture
description: "Portable memory: the doorman badge-proxy + NemoClaw sandbox + trades-spine MCP architecture, for bootstrapping a fresh cloud box. Pairs with doorman-nemoclaw-setup-guide.md."
metadata:
  type: project
  portable: true
---

# Doorman + NemoClaw + Trades-Spine — architecture memory (for a fresh box)

This is a **transfer memory** to bootstrap a new-instance Claude. Full step-by-step lives in
**`~/doorman-nemoclaw-setup-guide.md`** (copy it onto the new box too). Read that for commands; this
file is the mental model + the non-obvious facts that aren't recoverable from the code.

## The architecture (Option A — gateway-mediated). This is the ONLY valid design.
Agent (OpenClaw + NVIDIA Nemotron, in an OpenShell sandbox) → **host doorman** (`172.18.0.1:3001`) →
remote **trades-spine MCP** on Render. The sandbox holds only a **revocable badge**; the doorman
validates it, adds the signed-identity headers using a host-only secret, and forwards to Render.
**The secret never leaves the host. The sandbox NEVER talks to Render directly.**

**DEPRECATED — do not revive:** the old "direct-to-Render" approach where the sandbox config baked a
signed `x-identity-signature` (+ `x-tenant`/`x-technician`) header and hit `https://tradesdatabase.onrender.com`
directly. Also dead: the file `~/trades-spine-egress-policy.yaml` (allows `tradesdatabase.onrender.com:443`
directly) and any "Render ALLOWED_CLIENT_IPS / IP allowlist" reasoning. If you see these, they're stale.

## Components & where they live
- **Doorman** (host): `/opt/doorman/doorman.mjs`, unit `doorman.service` (+ drop-in
  `doorman.service.d/override.conf`), config in `/etc/doorman/` (`doorman.env` = `GATEWAY_IDENTITY_SECRET`,
  `badges.json` = badge→{tenantId,technicianRef,revoked}, mode 600 owned `doorman`). Reads badge from
  `Authorization: Bearer <badge>`. Returns 200 valid / 403 unknown-or-revoked / 401 no-badge.
  Node must be copied to `/usr/local/bin/node` because the unit's `ProtectHome=true` hides the nvm node in /home.
- **NemoClaw source** (host): `/home/ubuntu/.nemoclaw/source/` — a real git repo (Dockerfile + `scripts/` +
  `nemoclaw-blueprint/`). `nemoclaw <AGENT> rebuild` stages the build context from here, so edits to these
  files bake into a fresh sandbox image.
- **Sandbox agent config**: `/sandbox/.openclaw/openclaw.json` (agent runs as user `sandbox`, HOME=/sandbox),
  on the container **writable layer** — a *recreate* wipes it (restart/reboot keep it). MCP servers live
  under top-level key `mcp.servers.<name>`.
- **The docker bridge** is `openshell-docker` (subnet typically `172.18.0.0/16`, gateway `172.18.0.1`).
  The host bridge interface name (e.g. `br-XXXXXXXX`) is **instance-specific** — discover it with
  `docker network inspect openshell-docker`, never hardcode it. `host.openshell.internal` resolves to the
  gateway inside the sandbox.

## Naming convention (easy to trip on)
- **`<AGENT>`** = sandbox name (e.g. `s1`). Used by `nemoclaw <AGENT> …`.
- **`<AGENT>-telegram-bridge`** = the OpenShell **provider** auto-created at onboard. Used by
  `openshell provider … <AGENT>-telegram-bridge`. The provider holds the channel + badge credentials.

## The badge & the runtime-secret mechanism (the clean path — VERIFIED working)
- Reference badge (identity `tech-jane`, tenant `82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18`):
  `3a6fb336ec39071493a98a1a44773a7b7fa09e73df61c9c71c9f11b3cd7e27ba`. Reusable across boxes (the doorman's
  `badges.json` + secret define validity).
- The badge is registered as a **provider credential**:
  `openshell provider update <AGENT>-telegram-bridge --credential TRADES_SPINE_BADGE=<badge>`
  (a secret-store write — in a restricted Claude session this is BLOCKED; have the user run it).
- The sandbox config's MCP header is the **placeholder** `Bearer openshell:resolve:env:TRADES_SPINE_BADGE`
  (never the literal secret). **OpenShell's egress proxy substitutes the real badge from the provider store
  at request time** — same mechanism as the telegram bot token (OCSF logs show `bot[CREDENTIAL]` redaction,
  proving generic egress substitution). CONFIRMED 2026-06-29: a real agent turn resolved it and the trades-spine
  tool calls succeeded. So the badge is never in the image, never on disk in plaintext.
- Note: OpenClaw's streamable-http MCP loader does NOT itself resolve placeholders (its `resolveEnvPlaceholder`
  with format `Bearer ${VAR}` only covers the codex/gemini path). The egress proxy is what resolves it.

## toolSearch:false is mandatory for Nemotron
With `tools.toolSearch:true` ("code mode") OpenClaw hides tools behind a code bridge; Nemotron can't drive it
(it hallucinates `openclaw.tools.list()` / `require(...)`) and every tool call fails — the user sees
"**run bridge code failed**". Set `tools.toolSearch:false` (exposes the 7 tools as direct function calls).
Bake it in declaratively via the model-specific-setup manifest (matches modelId
`nvidia/nemotron-3-super-120b-a12b`, sets `effects.openclawTools.toolSearch=false`).

## The bake-in = 4 edits in /home/ubuntu/.nemoclaw/source (re-apply on a fresh box; upstream source is clean)
1. NEW `nemoclaw-blueprint/model-specific-setup/openclaw/nemotron-3-super-toolsearch-off.json` (toolSearch:false).
2. `scripts/generate-openclaw-config.py` — gated block (env `NEMOCLAW_TRADES_SPINE_ENABLED`) writing
   `mcp.servers.trades-spine` with the placeholder header.
3. `scripts/nemoclaw-start.sh` — fallback resolver in the PYPLACEHOLDERS heredoc (harmless no-op; egress is the real path).
4. `Dockerfile` — `ARG/ENV NEMOCLAW_TRADES_SPINE_ENABLED` (set =1 to enable) + `NEMOCLAW_TRADES_SPINE_URL`.
Generator runs at image BUILD time (Dockerfile `RUN … generate-openclaw-config.py`). Exact contents are in the setup guide §6.

## Reboot-resilience (3 systemd pieces)
- doorman drop-in: `StartLimitIntervalSec=0` + `RestartSec=5` + `After=docker.service` → survives the
  EADDRNOTAVAIL bridge-startup race (otherwise it gives up `failed` after 5 quick crashes).
- `nemoclaw-boot.service` (oneshot, User=ubuntu, sleep 25, runs `nemoclaw <AGENT> doctor || true`) → revives
  the openshell-gateway control plane (:8080), which has NO native autostart and dies on reboot.
- Sandbox container autostarts (`restart=unless-stopped`); its in-container supervisor (`nemoclaw-start`)
  respawns the openclaw agent. If the agent is down: `nemoclaw <AGENT> recover` (kill openclaw first for a clean boot).

## Gotchas (hard-won; not in the code)
- **`export NVIDIA_API_KEY=…` every new shell** — onboard/rebuild preflight fails without it (even on a CPU box;
  it's the cloud-inference key, not a GPU key).
- **Render free-tier cold start ~32s > the agent's 30s MCP connect timeout** → the first tool call after idle can
  time out. Keep Render warm (the user plans paid/always-on) or pre-warm with the host curl before testing.
- **`nemoclaw <AGENT> rebuild` restore re-applies ONLY standard presets** (npm/pypi/huggingface/brew/brave/
  openclaw-pricing/telegram) — the custom `trades-spine-doorman` egress preset must be re-applied after every rebuild.
- **The egress preset MUST include `allowed_ips` RFC1918 ranges** (10/8, 172.16/12, 192.168/16) — OpenShell's
  SSRF guard rejects the private host-gateway IP (172.18.0.1) without it. These are static, NOT the rotating egress IP.
- **`docker exec … curl/node` to the doorman is a FALSE NEGATIVE** — the OpenShell proxy can't attribute a
  docker-exec'd process to an allowlisted binary and denies it (`failed to resolve peer binary -(0)`). Test with a
  REAL agent turn (a channel message), which runs as the attributed agent node and uses the managed proxy.
- **`device pairing required` loop after a rebuild** — a rebuild can reset `gateway.controlUi.dangerouslyDisableDeviceAuth`;
  the agent may run tools but fail to deliver its channel reply. Restore that flag in openclaw.json if replies vanish.
- Egress public IP rotates across stop/start but currently does NOT gate doorman→Render. Don't pin it anywhere.

## Verify (end-to-end)
- Host→doorman→Render: `curl -X POST http://172.18.0.1:3001/mcp -H "Authorization: Bearer <badge>" …
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` → HTTP 200 + 7 tools (technician-tier badge;
  an ACTIVE manager-tier roster row lists 12 — nemoclaw-tech-agent.md §4, 2026-07-02).
- Agent: message the bot ("list recent captures") → OCSF on host shows
  `ALLOWED /usr/local/bin/node(<pid>) -> host.openshell.internal:3001 [policy:trades_spine_doorman]` and the bot
  returns real data.

## The 7 trades-spine tools
record_field_note, find_customer, get_customer_context, get_job, list_recent_captures, brief_customer, answer_customer_question.
