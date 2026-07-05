#!/usr/bin/env bash
# bootstrap-box.sh — stand up a doorman + NemoClaw box from a fresh Ubuntu VM.
# Automates the mechanical parts of doorman-nemoclaw-setup-guide.md; that guide
# stays the authority — every phase below cites the section it implements.
#
# Run phases IN ORDER; two manual interludes (onboard, badge install) are
# unavoidable because they're interactive / touch badge plaintext.
#
#   sudo ./bootstrap-box.sh prep                      # §2: docker, ufw, deps
#        ./bootstrap-box.sh nemoclaw                  # §2: install NemoClaw   (needs NVIDIA_API_KEY)
#        ./bootstrap-box.sh bakein                    # §6: source edits BEFORE first onboard
#        nemoclaw onboard                             # §4: MANUAL (cheat sheet: ./bootstrap-box.sh onboard-help)
#   sudo ./bootstrap-box.sh doorman                   # §3: service+unit+ufw   (needs GATEWAY_IDENTITY_SECRET)
#   sudo ./bootstrap-box.sh badgepull                 # §3c roster pull        (needs HOST_PULL_TOKEN)
#        ./bootstrap-box.sh wire <AGENT>              # §5a egress policy + §5b instructions
#   sudo ./bootstrap-box.sh boot <AGENT>              # §7: boot-revive oneshot
#   sudo ./bootstrap-box.sh verify                    # §3f/§7: gates that don't need a real badge
#
# Idempotent: each phase skips what already exists and never overwrites an
# existing secret file. Secrets come from env vars or an interactive prompt —
# they are never baked into this script or its artifacts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEMOCLAW_USER="${NEMOCLAW_USER:-ubuntu}"
NEMOCLAW_HOME="/home/${NEMOCLAW_USER}"
MCP_UPSTREAM_URL="${MCP_UPSTREAM_URL:-https://tradesdatabase.onrender.com/}"
PULL_URL="${PULL_URL:-https://tradesdatabase.onrender.com/control/badges}"
DOORMAN_PORT=3001

log()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ✓ %s\n' "$*"; }
skip() { printf '    - %s (already done)\n' "$*"; }
fail() { printf '    ✗ %s\n' "$*" >&2; exit 1; }

need_root()     { [ "$(id -u)" -eq 0 ] || fail "run this phase with sudo"; }
need_not_root() { [ "$(id -u)" -ne 0 ] || fail "run this phase as ${NEMOCLAW_USER}, not root"; }

# Secret helper: take $1 from the environment, else prompt silently.
need_secret() {
  local var="$1" prompt="$2"
  if [ -z "${!var:-}" ]; then
    read -rsp "    ${prompt}: " "${var?}" && echo
    [ -n "${!var}" ] || fail "${var} is required"
  fi
}

bridge_gateway() {
  docker network inspect openshell-docker 2>/dev/null \
    | grep -oE '"Gateway": "[0-9.]+"' | grep -oE '[0-9.]+' | head -1 || true
}

# ─────────────────────────────────────────────────────────────── prep (§2) ──
phase_prep() {
  need_root
  id "$NEMOCLAW_USER" >/dev/null 2>&1 || fail "user ${NEMOCLAW_USER} missing — on Lightsail the default user is ubuntu; set NEMOCLAW_USER if yours differs"

  log "apt packages (curl jq git ufw docker)"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl jq git ca-certificates ufw docker.io >/dev/null
  systemctl enable --now docker >/dev/null 2>&1
  ok "docker $(docker --version | cut -d, -f1)"

  usermod -aG docker "$NEMOCLAW_USER"
  ok "${NEMOCLAW_USER} in docker group (takes effect on next login)"

  log "ufw (SSH first, so enabling can't lock you out)"
  ufw allow OpenSSH >/dev/null
  ufw --force enable >/dev/null
  # Bridge rules up-front: onboard's gateway preflight needs :8080 reachable
  # from the sandbox subnet BEFORE the doorman phase runs (observed 2026-07-04).
  # The subnet/gateway are OpenShell constants; the doorman phase re-adds them
  # with the discovered gateway IP (ufw dedupes identical rules).
  ufw allow from 172.18.0.0/16 to 172.18.0.1 port 8080 proto tcp comment 'openshell gateway' >/dev/null
  ufw allow from 172.18.0.0/16 to 172.18.0.1 port "$DOORMAN_PORT" proto tcp comment 'doorman' >/dev/null
  ok "ufw active: OpenSSH + bridge rules (:8080 gateway, :${DOORMAN_PORT} doorman)"

  echo
  echo "NEXT (as ${NEMOCLAW_USER}): export NVIDIA_API_KEY=<nvapi-...>  then  ./bootstrap-box.sh nemoclaw"
}

# ─────────────────────────────────────────────────────────── nemoclaw (§2) ──
phase_nemoclaw() {
  need_not_root
  [ -n "${NVIDIA_API_KEY:-}" ] || fail "export NVIDIA_API_KEY=<nvapi-...> first (guide §2 — installs/rebuilds fail without it)"

  if [ -d "$NEMOCLAW_HOME/.nemoclaw/source" ]; then
    skip "NemoClaw installed ($NEMOCLAW_HOME/.nemoclaw/source exists)"
  else
    log "installing NemoClaw"
    echo "    NOTE: if the installer auto-launches the first 'onboard' wizard, Ctrl-C out of it —"
    echo "    the bakein phase must run BEFORE the first onboard so the image builds pre-wired."
    curl -fsSL https://nvidia.com/nemoclaw.sh | bash
    [ -d "$NEMOCLAW_HOME/.nemoclaw/source" ] || fail "install finished but $NEMOCLAW_HOME/.nemoclaw/source is missing"
    ok "NemoClaw source at $NEMOCLAW_HOME/.nemoclaw/source"
  fi
  echo
  echo "NEXT: ./bootstrap-box.sh bakein"
}

# ───────────────────────────────────────────────────────────── bakein (§6) ──
phase_bakein() {
  need_not_root
  log "applying §6 bake-in edits (apply-bakein.py — idempotent, fail-loud)"
  python3 "$SCRIPT_DIR/apply-bakein.py" "$NEMOCLAW_HOME/.nemoclaw/source"

  log "source edit #6 (§7 token-expiry gotcha): gateway JWT ttl 3600 -> 30 days"
  # The gateway TOML is regenerated from this constant by 'nemoclaw doctor';
  # editing the TOML alone does not stick. Idempotent: sed only matches 3600.
  local f
  for f in \
    "$NEMOCLAW_HOME/.nemoclaw/source/src/lib/onboard/docker-driver-gateway-config.ts" \
    "$NEMOCLAW_HOME/.nemoclaw/source/dist/lib/onboard/docker-driver-gateway-config.js"; do
    if [ -f "$f" ]; then
      sed -i 's/DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS = 3600;/DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS = 2592000; \/\/ trades edit #6: 1h default expires tokens across reboots (see sandbox-token-medic)/' "$f"
      grep -q "TTL_SECS = 2592000" "$f" || fail "edit #6 did not apply to $f (vendor layout changed?)"
    else
      echo "    WARN: $f not found — vendor layout changed; apply edit #6 by hand (§7)"
    fi
  done
  ok "gateway JWT ttl constant patched (takes effect on next gateway [re]start)"
  echo
  echo "NEXT: run 'nemoclaw onboard' yourself (interactive)."
  echo "      Cheat sheet: ./bootstrap-box.sh onboard-help"
  echo "      Then: sudo ./bootstrap-box.sh doorman"
}

phase_onboard_help() {
  cat <<'EOF'
nemoclaw onboard — answers (guide §4):
  provider              1 (NVIDIA Endpoints)
  API key               nvapi-... (reuses stored if present)
  cloud model           z-ai/glm-5.2  — if absent from the menu, pick anything and fix after:
                          nemoclaw inference set --provider nvidia-prod --model z-ai/glm-5.2 --sandbox <AGENT>
                        confirm the exact id first (from the HOST): curl -s https://integrate.api.nvidia.com/v1/models
  sandbox name          <AGENT>  (e.g. s1)
  apply config          Y
  Brave search          N
  messaging channel     Telegram — during a MIGRATION BUILD use a SCRATCH bot token
                        (a second bot from @BotFather), NOT the production bot: two boxes
                        polling one bot token conflict and the live bot goes deaf.
  resource profile      2 (gamer 25%)
  policy tier           <Enter>
  presets               <Enter>
First build ≈ 8 min. If port 8080 is blocked: sudo lsof -i :8080; sudo kill <PID>; re-run.
EOF
}

# ──────────────────────────────────────────────────────────── doorman (§3) ──
phase_doorman() {
  need_root

  log "node runtime at /usr/local/bin (ProtectHome hides the nvm copy — §3b)"
  if /usr/local/bin/node --version >/dev/null 2>&1; then
    skip "/usr/local/bin/node ($(/usr/local/bin/node --version))"
  else
    local nvm_node
    nvm_node=$(ls -1 "$NEMOCLAW_HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)
    [ -n "$nvm_node" ] || fail "no nvm node under $NEMOCLAW_HOME/.nvm — run the nemoclaw phase first"
    cp "$nvm_node" /usr/local/bin/node
    ok "copied $nvm_node → /usr/local/bin/node ($(/usr/local/bin/node --version))"
  fi

  log "doorman user, code, config (§3c)"
  useradd -r -s /usr/sbin/nologin doorman 2>/dev/null || true
  mkdir -p /opt/doorman /etc/doorman
  cp "$SCRIPT_DIR/doorman.mjs" /opt/doorman/doorman.mjs
  ok "code at /opt/doorman/doorman.mjs"

  local gw
  gw=$(bridge_gateway)
  if [ -z "$gw" ]; then
    gw="172.18.0.1"
    echo "    ! openshell-docker bridge not found (no onboard yet?) — assuming ${gw}."
    echo "      The doorman will crash-retry until the bridge exists (§3a); that is expected."
  fi

  if [ -f /etc/doorman/doorman.env ]; then
    skip "/etc/doorman/doorman.env exists — NOT overwriting (delete it first to regenerate)"
  else
    need_secret GATEWAY_IDENTITY_SECRET "GATEWAY_IDENTITY_SECRET (must MATCH Render — from the password manager, never generated here)"
    umask 077
    cat > /etc/doorman/doorman.env <<EOF
MCP_UPSTREAM_URL=${MCP_UPSTREAM_URL}
BADGES_FILE=/etc/doorman/badges.json
DOORMAN_PORT=${DOORMAN_PORT}
DOORMAN_BIND=${gw}
GATEWAY_IDENTITY_SECRET=${GATEWAY_IDENTITY_SECRET}
EOF
    ok "doorman.env written (bind ${gw}:${DOORMAN_PORT} → ${MCP_UPSTREAM_URL})"
  fi

  if [ -f /etc/doorman/badges.json ]; then
    skip "badges.json exists — NOT overwriting (badge-pull owns it)"
  else
    echo '{}' > /etc/doorman/badges.json
    ok "badges.json starts EMPTY — the badge-pull timer populates it from the roster (§3c)"
  fi
  chown -R doorman:doorman /etc/doorman
  chmod 600 /etc/doorman/doorman.env /etc/doorman/badges.json
  ok "ownership doorman:doorman, mode 600 (load-bearing — wrong owner silently 403s EVERY badge)"

  log "systemd unit + reboot-race hardening (§3d)"
  cat > /etc/systemd/system/doorman.service <<'EOF'
[Unit]
Description=trades-spine MCP doorman
After=network-online.target
Wants=network-online.target

[Service]
User=doorman
EnvironmentFile=/etc/doorman/doorman.env
ExecStart=/usr/local/bin/node /opt/doorman/doorman.mjs
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/doorman /opt/doorman

[Install]
WantedBy=multi-user.target
EOF
  mkdir -p /etc/systemd/system/doorman.service.d
  cat > /etc/systemd/system/doorman.service.d/override.conf <<'EOF'
[Unit]
StartLimitIntervalSec=0
After=docker.service

[Service]
RestartSec=5
EOF
  systemctl daemon-reload
  systemctl enable --now doorman.service
  ok "doorman.service enabled ($(systemctl is-active doorman.service))"

  log "ufw bridge rules (§3e)"
  ufw allow from 172.18.0.0/16 to "$gw" port "$DOORMAN_PORT" proto tcp comment 'doorman' >/dev/null
  ufw allow from 172.18.0.0/16 to "$gw" port 8080 proto tcp comment 'openshell gateway' >/dev/null
  ok "sandbox subnet → ${gw}:{${DOORMAN_PORT},8080} allowed"

  echo
  echo "NEXT: sudo ./bootstrap-box.sh badgepull   (needs this host's HOST_PULL_TOKEN from create-host)"
}

# ─────────────────────────────────────────── badgepull (§3c roster-driven) ──
phase_badgepull() {
  need_root
  command -v jq >/dev/null || fail "jq missing — run the prep phase"

  log "installing badge-pull.sh + 5-min timer"
  install -o root -g root -m 700 "$SCRIPT_DIR/badge-pull.sh" /usr/local/sbin/badge-pull.sh
  ok "/usr/local/sbin/badge-pull.sh"

  if [ -f /etc/doorman/badge-pull.env ]; then
    skip "badge-pull.env exists — NOT overwriting"
  else
    need_secret HOST_PULL_TOKEN "HOST_PULL_TOKEN (printed ONCE by scripts/assign-host.mjs create-host)"
    umask 077
    cat > /etc/doorman/badge-pull.env <<EOF
PULL_URL=${PULL_URL}
HOST_PULL_TOKEN=${HOST_PULL_TOKEN}
EOF
    chmod 600 /etc/doorman/badge-pull.env
    ok "badge-pull.env written (root-only)"
  fi

  cat > /etc/systemd/system/badge-pull.service <<'EOF'
[Unit]
Description=trades-spine roster badge pull
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/badge-pull.sh
EOF
  cat > /etc/systemd/system/badge-pull.timer <<'EOF'
[Unit]
Description=trades-spine badge pull every 5 minutes

[Timer]
OnCalendar=*:0/5
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now badge-pull.timer
  ok "badge-pull.timer enabled ($(systemctl is-active badge-pull.timer))"

  log "first pull (pre-warming Render first — cold start ~32s beats the 30s curl cap)"
  curl -s -o /dev/null --max-time 60 "$PULL_URL" || true
  if systemctl start badge-pull.service; then
    journalctl -u badge-pull.service -n 3 --no-pager | sed 's/^/    /'
  else
    echo "    ! first pull failed — if Render was cold, just re-run: sudo systemctl start badge-pull.service"
  fi

  echo
  echo "NEXT: ./bootstrap-box.sh wire <AGENT>   (as ${NEMOCLAW_USER})"
}

# ─────────────────────────────────────────────────────────── wire (§5a/5b) ──
phase_wire() {
  need_not_root
  local agent="${1:-}"; [ -n "$agent" ] || fail "usage: ./bootstrap-box.sh wire <AGENT>"

  log "egress policy (§5a)"
  cat > "$HOME/trades-spine-doorman-egress-policy.yaml" <<'EOF'
preset:
  name: trades-spine-doorman
  description: "On-host doorman bridge to trades-spine MCP (host.openshell.internal:3001)"
network_policies:
  trades_spine_doorman:
    name: trades_spine_doorman
    endpoints:
      - host: host.openshell.internal
        port: 3001
        protocol: rest
        enforcement: enforce
        allowed_ips:               # MANDATORY: OpenShell's SSRF guard rejects private
          - 10.0.0.0/8             # host-gateway IPs (172.18.0.1) unless allowlisted.
          - 172.16.0.0/12          # These are STATIC RFC1918 ranges — NOT the box's
          - 192.168.0.0/16         # rotating public egress IP.
        rules:
          - allow: { method: POST, path: "/**" }
          - allow: { method: GET, path: "/**" }
          - allow: { method: DELETE, path: "/**" }
    binaries:
      - { path: /usr/local/bin/node }
      - { path: /usr/bin/node }
      - { path: /usr/bin/curl }
EOF
  nemoclaw "$agent" policy-add --from-file "$HOME/trades-spine-doorman-egress-policy.yaml" --yes
  ok "trades-spine-doorman preset applied to ${agent}"
  echo "    NOTE: this preset is NOT restored by 'nemoclaw ${agent} rebuild' — re-run this phase after every rebuild (§6)."

  log "accuracy-rules block (§0c — REQUIRED both tiers; wiped by rebuild, re-run after one)"
  local cid
  cid=$(docker ps -q --filter "name=openshell-${agent}-" | head -1)
  if [ -n "$cid" ]; then
    if docker exec "$cid" grep -q "Trades assistant — accuracy rules" /sandbox/.openclaw/workspace/AGENTS.md 2>/dev/null; then
      ok "accuracy-rules block already present"
    else
      docker exec -u sandbox "$cid" sh -c 'cat >> /sandbox/.openclaw/workspace/AGENTS.md' <<'EOF'

## Trades assistant — accuracy rules (host-managed; keep at top priority)

You act for a real trades business through the trades-spine tools. Precision beats speed.

1. **Copy values character-for-character.** Email addresses, phone numbers, street addresses,
   names, dollar amounts, job numbers, dates and times: NEVER retype these from memory. Re-read
   the exact characters in the user's message and copy them into tool arguments.
2. **Double-check before showing anything for confirmation.** After staging an action (for
   example send_email), compare every critical value in the staged copy against the user's
   original message, character by character. If ANY character differs, fix it and re-stage
   BEFORE showing it to the user. The user should never be the one to catch a transcription
   error.
3. **Show, then wait.** Never treat your own message as approval. Show the exact staged content
   and wait for an explicit yes. If the user corrects anything, re-stage and show the corrected
   version in full.
4. **Missing or ambiguous detail? Ask.** Which Jones, which address, which date — never guess a
   value that will leave the building.
5. When relevant, remind the user: you are an AI and can make mistakes, and emails and actions
   sent through you are logged by the business.
EOF
      ok "accuracy-rules block appended to ${agent}'s AGENTS.md"
    fi
  else
    echo "    WARN: no running container for ${agent} — append the §0c block manually once it's up"
  fi

  cat <<EOF

MANUAL — badge install (§5b; plaintext stays between the pending file and the provider store):
  1. sudo cat /root/pending-badges.jsonl          # this person's line: {"ref":..., "badge":...}
  2. Integrity check (no plaintext exposure): printf %s '<badge>' | sha256sum | cut -d' ' -f1
     → that digest must be a key in /etc/doorman/badges.json (sudo jq 'keys' /etc/doorman/badges.json)
  3. openshell provider update ${agent}-telegram-bridge --credential TRADES_SPINE_BADGE=<badge>
  4. Delete the line: sudo sed -i '/<ref>/d' /root/pending-badges.jsonl
  (Value swaps don't need a restart; only the FIRST-ever registration does — then:
   sudo docker exec <CID> pkill -9 -x openclaw)

NEXT: sudo ./bootstrap-box.sh boot ${agent}
EOF
}

# ──────────────────────────────────────────────────────────────── boot (§7) ──
phase_boot() {
  need_root
  local agent="${1:-}"; [ -n "$agent" ] || fail "usage: sudo ./bootstrap-box.sh boot <AGENT>"

  log "nemoclaw-boot.service (§7 — revives the :8080 gateway after reboot)"
  cat > /etc/systemd/system/nemoclaw-boot.service <<EOF
[Unit]
Description=Revive OpenShell gateway + sandboxes on boot
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=${NEMOCLAW_USER}
Environment=HOME=${NEMOCLAW_HOME}
ExecStartPre=/bin/sleep 25
ExecStart=/bin/bash -c '${NEMOCLAW_HOME}/.local/bin/nemoclaw ${agent} doctor || true'

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable nemoclaw-boot.service
  ok "enabled (runs at boot; harmless if already healthy)"

  log "sandbox-token-medic (§7 — 2026-07-05: sandbox JWT file expires across reboots)"
  install -o root -g root -m 755 "$SCRIPT_DIR/sandbox-token-medic.mjs" /usr/local/sbin/sandbox-token-medic.mjs
  install -o root -g root -m 644 "$SCRIPT_DIR/sandbox-token-medic.service" /etc/systemd/system/sandbox-token-medic.service
  systemctl daemon-reload
  systemctl enable sandbox-token-medic.service
  ok "sandbox-token-medic.service enabled (heals expired sandbox tokens before revive)"

  log "agent-revive service (2026-07-04: agent supervisor does NOT survive container restarts)"
  install -o root -g root -m 755 "$SCRIPT_DIR/nemoclaw-agent-revive.sh" /usr/local/sbin/nemoclaw-agent-revive.sh
  cat > "/etc/systemd/system/nemoclaw-agent-${agent}.service" <<EOF
[Unit]
Description=NemoClaw agent supervisor for sandbox ${agent} (revive after restart)
After=docker.service nemoclaw-boot.service network-online.target
Wants=nemoclaw-boot.service

[Service]
User=${NEMOCLAW_USER}
Environment=HOME=${NEMOCLAW_HOME}
ExecStart=/usr/local/sbin/nemoclaw-agent-revive.sh ${agent}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "nemoclaw-agent-${agent}.service"
  ok "nemoclaw-agent-${agent}.service enabled ($(systemctl is-active "nemoclaw-agent-${agent}.service"))"
  echo
  echo "NEXT: sudo ./bootstrap-box.sh verify"
}

# ─────────────────────────────────────────────────────────────────── verify ──
phase_verify() {
  need_root
  local gw rc pass=0 warn=0
  gw=$(bridge_gateway); gw="${gw:-172.18.0.1}"

  log "service states"
  for u in doorman.service badge-pull.timer docker.service; do
    if [ "$(systemctl is-active "$u")" = active ]; then ok "$u active"; pass=$((pass+1));
    else echo "    ✗ $u NOT active"; warn=$((warn+1)); fi
  done
  systemctl is-enabled nemoclaw-boot.service >/dev/null 2>&1 && ok "nemoclaw-boot.service enabled" || { echo "    ✗ nemoclaw-boot.service not enabled"; warn=$((warn+1)); }

  log "doorman auth gates (no real badge needed — §3f)"
  rc=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST "http://${gw}:${DOORMAN_PORT}/mcp" \
        -H 'Content-Type: application/json' -d '{}' || echo 000)
  [ "$rc" = 401 ] && { ok "no badge → 401"; pass=$((pass+1)); } || { echo "    ✗ no badge → $rc (want 401)"; warn=$((warn+1)); }
  rc=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST "http://${gw}:${DOORMAN_PORT}/mcp" \
        -H 'Authorization: Bearer bogus-badge-for-verify' -H 'Content-Type: application/json' -d '{}' || echo 000)
  [ "$rc" = 403 ] && { ok "bogus badge → 403"; pass=$((pass+1)); } || { echo "    ✗ bogus badge → $rc (want 403)"; warn=$((warn+1)); }

  log "badges + sandbox"
  local n
  n=$(jq 'length' /etc/doorman/badges.json 2>/dev/null || echo 0)
  [ "$n" -gt 0 ] && ok "badges.json has $n entrie(s)" || echo "    ! badges.json empty — no one assigned to this host yet, or first pull pending"
  docker ps --format '    {{.Names}}  {{.Status}}' | sed -n '1,10p'

  cat <<'EOF'

Remaining gates that NEED a real badge / human (guide §3f, §5d — cannot be scripted safely):
  A. sudo cat /root/pending-badges.jsonl → curl with that badge → HTTP 200 + tools/list
     shows 8 tools (15 if the ref is an active manager row).
  B. Message the Telegram bot something needing a tool ("list recent captures") →
     real data back; on the host, OCSF shows ALLOWED → host.openshell.internal:3001.
  C. sudo reboot → all of the above come back untouched within ~2 min.
EOF
  echo "verify: ${pass} checks passed, ${warn} problems"
  [ "$warn" -eq 0 ]
}

# ──────────────────────────────────────────────────────────────────── main ──
case "${1:-help}" in
  prep)         phase_prep ;;
  nemoclaw)     phase_nemoclaw ;;
  bakein)       phase_bakein ;;
  onboard-help) phase_onboard_help ;;
  doorman)      phase_doorman ;;
  badgepull)    phase_badgepull ;;
  wire)         shift; phase_wire "$@" ;;
  boot)         shift; phase_boot "$@" ;;
  verify)       phase_verify ;;
  *)
    sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
