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
  **Empty-roster guard (since 2026-07-03, post-incident hardening):** a pull whose badgesFile is
  EMPTY while the current badges.json is non-empty is REFUSED — the script exits 1 (unit shows
  failed) and the last good file stays; that shape has only ever meant upstream data loss, never
  a real roster. Deliberate full wipe: set `ALLOW_EMPTY_BADGES=1` in badge-pull.env, re-run,
  remove it.
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
- **Telegram sender bindings are roster-driven too (Feature A, 2026-07-07)** — the manager's
  `bind_telegram` tool records `telegram_user_id` on the roster row; the SAME `badge-pull.sh` ships
  a `bindings[]` array and calls `apply-binding.sh` (copy alongside this file) to reconcile each into
  the sandbox's allowlist with **NO rebuild and NO device-key strip** (so, unlike a badge/provider
  write, it runs automatically). The allowlist lives in TWO host-editable places, both written per
  bind: **(a) SOURCE** `~/.nemoclaw/sandboxes.json` →
  `sandboxes.<ref>.messaging.plan.channels[telegram].inputs[allowedIds].value` (durable across
  rebuilds); **(b) RENDERED** the sandbox's `openclaw.json` → `channels.telegram.accounts[].allowFrom`
  (per-account — NOT the top-level key) + recompute `/sandbox/.openclaw/.config-hash` + chmod 660 +
  `nemoclaw <ref> gateway restart`. Verify with `nemoclaw <ref> channels status --json` — a
  no-messaging drift probe (`warn: expected X; rendered Y` means one layer was missed; `ok` means both
  agree). Gotchas (proven on s2): an `upload` lands mode 640/644 → the restart refuses
  `GATEWAY_UNSAFE_CONFIG_PATH` until chmod 660; `nemoclaw exec` reads stdin → `</dev/null`. Applied
  state: `/etc/doorman/bindings-applied.json`. Full write-up: research doc
  `thoughts/shared/research/2026-07-03-cold-sandbox-identity-injection.md` (Part B).
- **Live state (trades-box-1 on AWS Lightsail since 2026-07-04; the Brev nemoclaw-box is RETIRED
  — see migration-runbook-lightsail.md):** fingerprint doorman + roster-driven badge-pull timer
  (with the empty-file guard) are DEPLOYED via `bootstrap-box.sh` and E2E-verified (Jane turn via
  bot reply + OCSF `ALLOWED …:3001 [policy:trades_spine_doorman]`; hands-off recovery from reboot
  AND console stop/start incl. the agent-revive service). Tenant
  `82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18`. Box access: `ssh tradesbox` (plain keys, agent-reachable).
- **A badge's POWER comes from a matching roster row on the server, not from the badge itself
  (since 2026-07-02).** The badge only maps to `{tenantId, technicianRef}`; the trades-spine server
  looks that `technicianRef` up in its `technicians` table and grants tools by the row's **tier**. So
  minting a badge is now a TWO-PART action: (1) the server side must already have an ACTIVE row for that
  ref — `tier='manager'` for a manager, `tier='technician'` otherwise; (2) mint the badge here with the
  byte-identical `technicianRef`. If no active row matches, the badge still authenticates but silently
  acts as a plain technician (13 tools; the 8 seat/lifecycle admin tools are denied). The reference
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

## The agent model: GLM-5.2 — production route is DeepInfra (`deepinfra-prod / zai-org/GLM-5.2`)
**Current production route (since 2026-07-06, re-asserted 2026-07-08): `deepinfra-prod /
zai-org/GLM-5.2`** — DeepInfra is metered (200 concurrent/model) where NVIDIA's free tier
rate-limits busy agents (`ResourceExhausted: Worker local total request limit reached (N/32)`).
Flip: `openshell inference set -g nemoclaw --provider deepinfra-prod --model zai-org/GLM-5.2`
(gateway-level → all sandboxes; the route forces the model per request). **`nvidia-prod` is
rollback-only** and is ALSO the wizard default `onboard`/`rebuild` fall back to — that drift
rate-limited Judy's s3 on 2026-07-08. Guard: `nemoclaw-inference-medic.timer` re-asserts the
DeepInfra route on boot + every 15 min (units in this repo). Check with `openshell inference get`.

The standing model decision is the GLM line — Nemotron-3 Super 120B proved too weak; do NOT
"restore" it when debugging model errors. GLM-5.1 was the first pick but NVIDIA retired it. (Note
the id SPELLING differs by provider: DeepInfra `zai-org/GLM-5.2`, NVIDIA `z-ai/glm-5.2`.)
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

## The bake-in = 5 edits in /home/ubuntu/.nemoclaw/source (re-apply on a fresh box; upstream source is clean)
1. NEW `nemoclaw-blueprint/model-specific-setup/openclaw/nemotron-3-super-toolsearch-off.json` (toolSearch:false).
2. `scripts/generate-openclaw-config.py` — gated block (env `NEMOCLAW_TRADES_SPINE_ENABLED`) writing
   `mcp.servers.trades-spine` with the placeholder header.
3. `scripts/nemoclaw-start.sh` — fallback resolver in the PYPLACEHOLDERS heredoc (harmless no-op; egress is the real path).
3b. `scripts/nemoclaw-start.sh` — placeholder SELF-HEAL in the same heredoc (the versioning-trap fix,
   2026-07-03): maps any stale `v<NUM>_KEY` placeholder to the current generation at every boot. On a
   running container it must ALSO be hot-copied to `/usr/local/bin/nemoclaw-start` (a recreate reverts
   to the image copy until a rebuild bakes it).
4. `Dockerfile` — `ARG/ENV NEMOCLAW_TRADES_SPINE_ENABLED` (set =1 to enable) + `NEMOCLAW_TRADES_SPINE_URL`.
Generator runs at image BUILD time (Dockerfile `RUN … generate-openclaw-config.py`). Exact contents are in the setup guide §6.

## Reboot-resilience (4 systemd pieces)
- `sandbox-token-medic.service` (oneshot, root, Before= the revive chain; since 2026-07-05) → the gateway
  mints each sandbox's JWT ONCE at create (`gateway_jwt.ttl_secs`, vendor-hardcoded 1h — patched to 30d by
  source edit #6) and the supervisor refreshes it IN MEMORY ONLY, so any reboot >ttl after create is an
  `ExpiredSignature` crash loop the revive unit cannot fix (PID1 never comes up). The medic re-mints from
  the gateway's own signing key and restarts the container. Took trades-box-1 down 2026-07-05 (Lightsail
  restart at 20:03; healed same day, no rebuild). Upstream bug: supervisor should persist refreshed tokens.
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
- **Placeholder VERSIONING trap — FIXED 2026-07-03 by bake-in edit (3b)** (patch text in the setup
  guide §6; applied + 12/12 unit-verified on the live box: source repo edited AND hot-copied over the
  running container's `/usr/local/bin/nemoclaw-start`). With the patch, every container boot maps ANY
  on-disk placeholder form — canonical or a stale `v<NUM>_KEY` frozen by a previous boot — to the
  current generation's form, so a config frozen to an old provider generation self-heals at boot and
  recovery from a killed channel is just a container restart. **Recreate caveat:** a container
  recreate reverts to the unpatched image copy until a rebuild bakes the source edit — until that
  rebuild, re-hot-copy after any recreate. **History (unpatched boxes; keep for diagnosis):** the
  stock refresher rewrites canonical placeholders (`openshell:resolve:env:KEY`) at boot to a
  revision-scoped form frozen to that boot's provider generation; any later credential write bumps
  the generation, the egress proxy can't resolve the frozen form, the bridge logs
  `credential placeholder mismatch` + `bridge did not start within 15s`, and the bot goes deaf
  (killed the Telegram bridge for 2 days, 2026-07-02). Manual fix on such a box: restore the
  CANONICAL placeholder in `/sandbox/.openclaw/openclaw.json`, recompute
  `/sandbox/.openclaw/.config-hash` the way the start script does, keep `sandbox:sandbox` ownership,
  then kill openclaw + `nemoclaw <AGENT> recover`. Diagnostic: compare the `v<NUM>` in the agent's
  `/proc/<pid>/environ` against the config — a mismatch is this bug; ignore lingering mismatch
  warning lines (literal string compare) — OCSF `ALLOWED … getUpdates` polling is ground truth.
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
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` → HTTP 200 + **13 tools** for a technician-tier
  badge, or **21** for a badge whose ref maps to an active manager roster row (the extra 8 are the
  seat-management tools; see the badge↔roster note above). A manager badge returning only 13 means the
  server has no active `tier='manager'` row for that ref (or is running older code).
- Agent: message the bot ("list recent captures") → OCSF on host shows
  `ALLOWED /usr/local/bin/node(<pid>) -> host.openshell.internal:3001 [policy:trades_spine_doorman]` and the bot
  returns real data.

## Tools by tier (what `tools/list` returns)
- **Technician badge — 12 (since 2026-07-13):** record_field_note (two-step stage→confirm; since 2026-07-06), find_customer, get_customer_context, get_job, list_recent_captures, brief_customer, answer_customer_question, web_search (Brave via Render; per-person daily cap; since 2026-07-13), read_webpage (hardened page/PDF reader: provenance-tiered URL cap + SSRF guard + daily cap; since 2026-07-13), send_email (two-step confirm; since 2026-07-04), retract_capture (two-step; author-or-manager, but audit rows outbound_email/agent_action are manager-only; since 2026-07-06), get_schedule (day-route: best stop order + Google Maps deep link; since 2026-07-06 — must ALSO be added to the sandbox tool allowlist or the agent can't call it; same caveat for the two web tools).
- **Manager badge — 20 (since 2026-07-13; 18 from 2026-07-07 with bind_telegram — an old revision of this line said 17 and omitted it):** the 12 above PLUS the seat/lifecycle admin tools: add_technician_seat, deactivate_technician_seat, reactivate_technician_seat, get_connect_link, bind_telegram, list_team, list_pending_reviews, resolve_review. Only an ACTIVE `tier='manager'` roster row on the server unlocks these (see the badge↔roster note above); the doorman/host does nothing tier-specific — same badge plumbing either way.
- **The web tools ride trades-spine** (sandbox → doorman :3001 → Render → Brave/target site): NO new sandbox egress, no web-API key on the box, badge revocation kills web access with everything else. All searches/fetches are logged server-side (`web_requests` table) with per-person daily caps.
- **Second MCP server per sandbox (relay since 2026-07-06): the `composio` entry → doorman `/composio/` → Render relay → the person's Composio session.** Registered beside `trades-spine`, authenticated by the **SAME badge** (zero new sandbox secrets; header `Bearer openshell:resolve:env:TRADES_SPINE_BADGE`). The doorman passes the `/composio` path through to the Render relay (`src/composio/relayHandler.ts`), which verifies the signed identity, looks up `composio_session_id`, and forwards ONLY to that session with the Composio key attached server-side (`COMPOSIO_RELAY_API_KEY` on Render, scoped; master fallback). **Per-person pinning is the security boundary — the master key never enters the box.** Tier is enforced INSIDE Composio's session config (execution-time, error code `4310`): manager = full catalog + `manageConnections:true`; technician = pinned `direct_tools` read/draft list, send impossible (spine `send_email` is the only technician send path). Sessions are minted by the Render lifecycle cron for ACTIVE rows (relay mints on demand in the reactivation gap). The `composio` block is baked by `apply-bakein.py` (§6 edits 5+6); `scripts/provision-session.mjs` is now diagnostics-only (the old per-sandbox secretRef wiring is retired — session `mcp.url` alone 401s and its SDK auth header is the master key). Manager sandboxes REQUIRE the destructive-action confirmation instruction block (§0b) — that is the only guard on destructive tools, by decision.
