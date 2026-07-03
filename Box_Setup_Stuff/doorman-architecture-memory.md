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
  `badges.json` = sha256(badge)→{tenantId,technicianRef,revoked}, mode 600 owned `doorman`). Reads badge from
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
- **badges.json is keyed by sha256 FINGERPRINTS since 2026-07-02** — the doorman hashes the
  presented badge before lookup (`createHash('sha256')`, see doorman.mjs), so the file at rest
  can't authenticate. When hand-writing an entry, the key is `sha256hex(<badge>)`
  (`printf %s "$BADGE" | sha256sum`), NEVER the badge itself. A plaintext-keyed entry silently
  403s (the hash lookup misses) — if every badge 403s after an edit, check keys AND ownership.
- **Badges are ROSTER-DRIVEN now**: the server generates this host's badges.json from its
  `technicians` roster; the host syncs it with `badge-pull.sh` (root, 5-min systemd timer,
  copy alongside this file) calling `GET /control/badges` with a per-host pull token
  (root-only `/etc/doorman/badge-pull.env`; server stores only its fingerprint). New people's
  badges are MINTED IN THE PULL RESPONSE (`newBadges` → `/root/pending-badges.jsonl`) — that is
  the only copy of the plaintext: install it as the sandbox's provider credential
  (`openshell provider update <AGENT>-telegram-bridge --credential TRADES_SPINE_BADGE=<badge>`,
  mind the Placeholder VERSIONING trap below), then delete the line. Deactivated people flip to
  `revoked:true` on the next pull.
  **Pull-host rules (hard-won):** (1) BEFORE enabling the timer on a host with existing badges,
  have the server side register each badge's fingerprint (`assign-host.mjs set-badge ref=… hash=…`)
  — the pull regenerates the file WHOLESALE from the roster, so unregistered entries are erased
  and competing badges minted (installed credentials then 403 with no signal). (2) Hand edits
  last at most one poll: a hand-set `revoked:true` is silently UN-revoked ≤5 min later while the
  roster row is active — leaked badge = server-side `rotate-badge` (old badge dies next pull,
  replacement mints), person removal = deactivate in the roster. (3) Upgrading a legacy
  plaintext-keyed host: copy the new doorman.mjs, rekey every key to its sha256
  (`python3` one-liner over the file), restore doorman:doorman 600, `systemctl restart doorman`
  back-to-back — a few seconds of 403s; NO dual-read fallback exists ON PURPOSE (it would turn a
  leaked file's fingerprints into usable bearer tokens).
- **There is NO reference badge — never record a badge plaintext in any doc/memory.** The one this
  file used to carry leaked into chat transcripts and was rotated dead on 2026-07-03 (403 live-tested).
  Badges exist in plaintext exactly twice: the pull response (`pending-badges.jsonl`, delete after
  install) and the provider store. Everything else records only sha256 fingerprints. Cheap integrity
  check before installing a minted badge: `sha256sum` the pending value and confirm the digest is a
  key in the freshly pulled badges.json — catches file/roster mismatch without exposing plaintext.
- **Live state (nemoclaw-box, since 2026-07-03):** fingerprint doorman + roster-driven badge-pull
  timer are DEPLOYED and E2E-verified (Jane turn confirmed via bot reply + server dispatch logs +
  OCSF `ALLOWED …:3001 [policy:trades_spine_doorman]`). Tenant `82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18`.
- **A badge's POWER comes from a matching roster row on the server, not from the badge itself
  (since 2026-07-02).** The badge only maps to `{tenantId, technicianRef}`; the trades-spine server
  looks that `technicianRef` up in its `technicians` table and grants tools by the row's **tier**. So
  minting a badge is now a TWO-PART action: (1) the server side must already have an ACTIVE row for that
  ref — `tier='manager'` for a manager, `tier='technician'` otherwise; (2) mint the badge here with the
  byte-identical `technicianRef`. If no active row matches, the badge still authenticates but silently
  acts as a plain technician (7 tools; the 7 seat/lifecycle admin tools are denied). The reference
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
- **A provider credential VALUE swap does NOT need an openclaw restart** (verified 2026-07-03) —
  the egress proxy resolves the badge per-request from the provider store. The setup guide's
  "register badge → restart openclaw" applies only to the FIRST-ever registration (lazy MCP
  connect). Do NOT `pkill openclaw` after a swap: the in-container supervisor does not respawn it,
  and `nemoclaw <AGENT> recover` revives the agent early but then stalls ~3 min on its
  port-forward step — check `pgrep -x openclaw` in the container instead of waiting on recover.
- **`nemoclaw list` does NOT show custom policy presets** in its per-sandbox summary (standard ones
  only). `nemoclaw <AGENT> policy-list` is authoritative — check it before re-applying anything
  (observed 2026-07-03: `trades-spine-doorman` showed ● applied there after `list` suggested it
  was missing).
- **badge-pull vs Render cold start:** the script's 30s curl cap fails CLOSED on a cold free-tier
  Render (~32s spin-up), and that failed request itself warms the service — a cold timer tick
  self-heals on the next one. For an immediate manual pull, pre-warm with any host curl first.
- **The openclaw agent's gateway (18789) listens in a NESTED network namespace** inside the sandbox
  container — invisible to plain `docker exec` (ss shows nothing; CLI gets ws 1006 + misleading
  TLS noise). Reach it with `nsenter -t <openclaw-pid> -n …` as root inside the container.
- **Device pairing approval (`openclaw devices approve`) is a PERSISTENT operator grant** — a
  Claude session must not self-approve it; surface the pending requestId to the user.
- **Editing badges.json: restore `doorman:doorman` + mode 600 after EVERY edit or ALL badges 403.**
  The doorman runs as user `doorman` and `loadBadges()` swallows read errors (returns `{}`), so a
  file it can't read silently 403s every badge — including previously-working ones. `sudo mv` of a
  temp file leaves it owned by your user (observed live 2026-07-02):
  `sudo chown doorman:doorman /etc/doorman/badges.json && sudo chmod 600 /etc/doorman/badges.json`.

## Verify (end-to-end)
- Host→doorman→Render: `curl -X POST http://172.18.0.1:3001/mcp -H "Authorization: Bearer <badge>" …
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` → HTTP 200 + **7 tools** for a technician-tier
  badge, or **14** for a badge whose ref maps to an active manager roster row (the extra 7 are the
  seat-management tools; see the badge↔roster note above). A manager badge returning only 7 means the
  server has no active `tier='manager'` row for that ref (or is running older code).
- Agent: message the bot ("list recent captures") → OCSF on host shows
  `ALLOWED /usr/local/bin/node(<pid>) -> host.openshell.internal:3001 [policy:trades_spine_doorman]` and the bot
  returns real data.

## Tools by tier (what `tools/list` returns)
- **Technician badge — 7:** record_field_note, find_customer, get_customer_context, get_job, list_recent_captures, brief_customer, answer_customer_question.
- **Manager badge — 14 (since 2026-07-02):** the 7 above PLUS the seat/lifecycle admin tools: add_technician_seat, deactivate_technician_seat, reactivate_technician_seat, get_connect_link, list_team, list_pending_reviews, resolve_review. Only an ACTIVE `tier='manager'` roster row on the server unlocks these (see the badge↔roster note above); the doorman/host does nothing tier-specific — same badge plumbing either way.
