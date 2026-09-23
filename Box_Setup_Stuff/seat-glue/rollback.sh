#!/usr/bin/env bash
# rollback.sh <seat> — undo cutover.sh: stop the seat glue and give the bot back
# to the openclaw sandbox. Run as ROOT on trades-box-1.
#
# The real token comes back from /root/seats/<seat>.env (bootstrap-box.sh wrote
# it at provision time) into the container's provider, the same argv-safe way
# badge-pull.sh installs a badge. The glue's conversation state stays in
# /var/lib/seat-glue/<seat> — a later cutover resumes it.
set -euo pipefail

SEAT="${1:?usage: rollback.sh <seat>}"
[[ "$SEAT" =~ ^[a-z0-9_]+$ ]] || { echo "rollback: bad seat ref" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "rollback: run as root" >&2; exit 1; }

NEMOCLAW_USER="${NEMOCLAW_USER:-ubuntu}"
home="$(getent passwd "$NEMOCLAW_USER" | cut -d: -f6)"
OSH="${OSH:-$home/.local/bin/openshell}"
log() { printf '== %s\n' "$*"; }

# 1. The glue lets go of the bot first — one poller per bot.
systemctl disable --now "seat-glue@${SEAT}" 2>/dev/null || true
log "seat-glue@${SEAT} stopped"

# 2. The real token back into the openclaw provider.
REAL="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "/root/seats/${SEAT}.env" | cut -d= -f2- | tr -d '"')"
[ -n "$REAL" ] || { echo "rollback: no token in /root/seats/${SEAT}.env" >&2; exit 1; }
sudo -u "$NEMOCLAW_USER" -H env REAL="$REAL" \
  bash -c '"$0" provider update "$1-telegram-bridge" --credential "TELEGRAM_BOT_TOKEN=${REAL:?}"' "$OSH" "$SEAT" >/dev/null
unset REAL
log "openclaw ${SEAT}: real token restored"

# 3. The container and its revive unit back up.
cid="$(docker ps -aq --filter "name=openshell-${SEAT}-" | head -1)"
[ -n "$cid" ] && docker restart "$cid" >/dev/null
systemctl enable --now "nemoclaw-agent-${SEAT}.service"
log "openclaw ${SEAT}: container restarted, revive unit enabled — check it polls: docker logs --since 3m $cid | grep getUpdates"
