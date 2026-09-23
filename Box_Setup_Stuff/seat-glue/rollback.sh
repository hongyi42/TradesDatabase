#!/usr/bin/env bash
# rollback.sh <seat> — undo cutover.sh: stop the seat glue and give the bot back
# to the openclaw sandbox. Run as ROOT on trades-box-1.
#
# The real token comes back from /root/seats/<seat>.env (bootstrap-box.sh wrote
# it at provision time) into the seat's provider through the bare-KEY form: the
# value rides the environment and never reaches sudo's logged command line, ps,
# or the journal. The glue's conversation state stays in /var/lib/seat-glue/<seat>
# — a later cutover resumes it.
set -euo pipefail

SEAT="${1:?usage: rollback.sh <seat>}"
[[ "$SEAT" =~ ^[a-z0-9_]+$ ]] || { echo "rollback: bad seat ref" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "rollback: run as root" >&2; exit 1; }

NEMOCLAW_USER="${NEMOCLAW_USER:-ubuntu}"
home="$(getent passwd "$NEMOCLAW_USER" | cut -d: -f6)"
OSH="${OSH:-$home/.local/bin/openshell}"
log() { printf '== %s\n' "$*"; }

# Everything that can fail is checked BEFORE the glue lets go of the bot.
[ -x "$OSH" ] || { echo "rollback: openshell not found at $OSH — nothing changed" >&2; exit 1; }
REAL="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "/root/seats/${SEAT}.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
[ -n "$REAL" ] || { echo "rollback: no token in /root/seats/${SEAT}.env — nothing changed" >&2; exit 1; }
cid="$(docker ps -aq --filter "name=openshell-${SEAT}-" | head -1 || true)"
[ -n "$cid" ] || { echo "rollback: no openshell-${SEAT}- container on this box — nothing changed" >&2; exit 1; }
trap 'echo "rollback: FAILED at line $LINENO — check seat-glue@${SEAT} and the openclaw container by hand" >&2' ERR

# 1. The glue lets go of the bot first — one poller per bot.
systemctl disable --now "seat-glue@${SEAT}" 2>/dev/null || true
log "seat-glue@${SEAT} stopped"

# 2. The real token back into the provider.
TELEGRAM_BOT_TOKEN="$REAL" sudo --preserve-env=TELEGRAM_BOT_TOKEN -u "$NEMOCLAW_USER" -H \
  "$OSH" provider update "${SEAT}-telegram-bridge" --credential TELEGRAM_BOT_TOKEN </dev/null >/dev/null
unset REAL
log "openclaw ${SEAT}: real token restored"

# 3. A container stopped for days may hold an expired sandbox JWT (the "docker
#    restart = expired JWT" trap): re-mint first, then restart, then relaunch
#    the agent through its revive unit.
systemctl restart sandbox-token-medic.service 2>/dev/null || log "token medic not run (not installed?) — continuing"
docker restart "$cid" >/dev/null
systemctl enable --now "nemoclaw-agent-${SEAT}.service"
log "openclaw ${SEAT}: container restarted, revive unit enabled — waiting for it to poll (up to 180 s)"

# 4. Proof, the way bootstrap-box.sh's provision step checks it.
deadline=$(( $(date +%s) + 180 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if docker logs --since 3m "$cid" 2>&1 | grep -q getUpdates; then
    log "openclaw ${SEAT} is polling Telegram again"
    exit 0
  fi
  sleep 10
done
echo "rollback: openclaw ${SEAT} did not show getUpdates within 180 s — check: docker logs --since 5m $cid" >&2
exit 1
