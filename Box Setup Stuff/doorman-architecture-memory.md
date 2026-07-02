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
- **A badge's POWER comes from a matching roster row on the server, not from the badge itself
  (since 2026-07-02).** The badge only maps to `{tenantId, technicianRef}`; the trades-spine server
  looks that `technicianRef` up in its `technicians` table and grants tools by the row's **tier**. So
  minting a badge is now a TWO-PART action: (1) the server side must already have an ACTIVE row for that
  ref — `tier='manager'` for a manager, `tier='technician'` otherwise; (2) mint the badge here with the
  byte-identical `technicianRef`. If no active row matches, the badge still authenticates but silently
  acts as a plain technician (7 tools; the 5 seat-management admin tools are denied). The reference
  `tech-jane` badge above maps to an active technician row. You (host side) cannot see or change the
  roster — it lives in the server's DB; coordinate with whoever manages it when minting a manager badge.
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

## The agent model: z-ai/glm-5.2 on NVIDIA NIM (GLM line per user 2026-07-02; Nemotron deprecated)
The running model is **`z-ai/glm-5.2`** (applied + verified config-consistent 2026-07-02). The
standing decision is the GLM line — Nemotron-3 Super 120B proved too weak; do NOT "restore" it
when debugging model errors. GLM-5.1 was the first pick but NVIDIA retired it.
- **Verify model ids against the LIVE catalog, from the HOST:**
  `curl -s https://integrate.api.nvidia.com/v1/models` — it is **public, no key needed**. As of
  2026-07-02 it lists exactly ONE GLM: `z-ai/glm-5.2`. Observed: `z-ai/glm-5.1` → 410 Gone
  (retired); `z-ai/glm5.1` → 404 model_not_found. Never trust page URLs or guesses.
- **nemoclaw's own `--verify` CANNOT reach NVIDIA** — it runs inside the egress-restricted
  gateway container and fails on connection (not auth). Run catalog checks from the host shell.
- **Change models the supported way:** `nemoclaw inference set --provider nvidia-prod
  --model <id> --sandbox <AGENT>` — updates the gateway route AND all three openclaw.json refs
  (agents.defaults.model.primary + registry id/name). No hand-edit of the writable layer.
- Error decoding: 410 = retired model route; 404 = id never existed; 401/403 = key problem;
  5xx/timeout = provider blip.

## toolSearch (code mode) — decided per MODEL, manifest is currently Nemotron-only
With `tools.toolSearch:true` ("code mode") OpenClaw hides tools behind a code bridge. Nemotron
could not drive it (hallucinated `openclaw.tools.list()` / `require(...)`; every tool call failed
with "**run bridge code failed**"), so we baked `tools.toolSearch:false` via the
model-specific-setup manifest — **but that manifest matches ONLY modelId
`nvidia/nemotron-3-super-120b-a12b`, so under GLM it does NOT apply.** On s1, `toolSearch` is
still `false` (leftover from the Nemotron bake), so the direct-function path applies there.
**CONFIRMED live 2026-07-02: GLM-5.2 drives the `toolSearch:false` direct-function surface fine** —
a full multi-turn seat-management conversation with real MCP tool calls (incl. a two-step
destructive confirm), zero "run bridge code failed" all day. Whether GLM-5.2 can drive code mode
(`toolSearch:true`, the FRESH-box default since the manifest won't match) is still **UNVERIFIED**:
if a fresh box's tool calls fail with "run bridge code failed", set `tools.toolSearch:false` for
GLM too (clone the manifest keyed on the GLM modelId, or set it directly in openclaw.json) — then
record the verified answer here.

**Observability: Telegram channel turns do NOT emit `embedded_run_agent_end` in the openclaw JSON
log** — that event belongs to the heartbeat lane. Verify a channel turn happened via the OCSF
egress log instead: `ALLOWED … sendMessage` (+ `sendChatAction`) is the ground truth that the
agent ran and delivered. Watching the openclaw log for agent-end on a channel turn is a false
"nothing happened".

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
- **Placeholder VERSIONING trap (observed live 2026-07-02; killed the Telegram bridge for 2 days).**
  Configs are GENERATED with canonical placeholders (`openshell:resolve:env:KEY` — e.g.
  `TELEGRAM_BOT_TOKEN`, `TRADES_SPINE_BADGE`), but at **container boot**
  `refresh_openclaw_provider_placeholders` in `~/.nemoclaw/source/scripts/nemoclaw-start.sh` rewrites
  them in openclaw.json to a revision-scoped form (`openshell:resolve:env:v<NUM>_KEY`) frozen to that
  boot's provider generation. Any later provider resource-version bump (adding/updating ANY credential,
  e.g. a badge swap) invalidates the frozen version — the egress proxy can't resolve it, the bridge
  logs `credential placeholder mismatch` + `bridge did not start within 15s`, and the bot goes deaf.
  The refresher only maps canonical→current, so it can NOT heal a stale versioned form; nothing
  self-heals at runtime. **Fix:** set the placeholder in `/sandbox/.openclaw/openclaw.json` back to
  the CANONICAL form, recompute `/sandbox/.openclaw/.config-hash` the way the start script does, keep
  `sandbox:sandbox` ownership, then kill openclaw + `nemoclaw <AGENT> recover`. **Diagnostic:** compare
  the `v<NUM>` in the agent's `/proc/<pid>/environ` against the one in the config — a mismatch is this
  bug. The mismatch warning lines may KEEP printing after the fix (literal string compare, canonical vs
  versioned) — the OCSF egress log is ground truth: `ALLOWED … getUpdates` polling = bridge is up.
  A recreate/rebuild does NOT need the fix re-applied (the generator bakes canonical), but the next
  container boot re-versions the config and re-arms the trap for the next provider bump. Durable fix
  (recommended, not yet applied): patch the refresher to map any `v*_KEY` form → current, then rebuild.
- **Editing badges.json: restore `doorman:doorman` + mode 600 after EVERY edit or ALL badges 403.**
  The doorman runs as user `doorman` and `loadBadges()` swallows read errors (returns `{}`), so a
  file it can't read silently 403s every badge — including previously-working ones. `sudo mv` of a
  temp file leaves it owned by your user (observed live 2026-07-02):
  `sudo chown doorman:doorman /etc/doorman/badges.json && sudo chmod 600 /etc/doorman/badges.json`.

## Verify (end-to-end)
- Host→doorman→Render: `curl -X POST http://172.18.0.1:3001/mcp -H "Authorization: Bearer <badge>" …
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` → HTTP 200 + **7 tools** for a technician-tier
  badge, or **12** for a badge whose ref maps to an active manager roster row (the extra 5 are the
  seat-management tools; see the badge↔roster note above). A manager badge returning only 7 means the
  server has no active `tier='manager'` row for that ref (or is running older code).
- Agent: message the bot ("list recent captures") → OCSF on host shows
  `ALLOWED /usr/local/bin/node(<pid>) -> host.openshell.internal:3001 [policy:trades_spine_doorman]` and the bot
  returns real data.

## Tools by tier (what `tools/list` returns)
- **Technician badge — 7:** record_field_note, find_customer, get_customer_context, get_job, list_recent_captures, brief_customer, answer_customer_question.
- **Manager badge — 12:** the 7 above PLUS the seat-management admin tools: add_technician_seat, deactivate_technician_seat, list_team, list_pending_reviews, resolve_review. Only an ACTIVE `tier='manager'` roster row on the server unlocks these (see the badge↔roster note above); the doorman/host does nothing tier-specific — same badge plumbing either way.
