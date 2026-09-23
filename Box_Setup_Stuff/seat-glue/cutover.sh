#!/usr/bin/env bash
# cutover.sh <seat> — move a seat's Telegram bot from its openclaw sandbox to the
# seat glue. Run as ROOT on trades-box-1 after install.sh. Undo: rollback.sh.
#
# WHY IT REMOVES THE TOKEN INSTEAD OF JUST STOPPING THE CONTAINER. Stopping is
# not retiring: gateway-heal.sh starts every exited openshell- container, and
# sandbox-token-medic.mjs `docker restart`s the containers whose JWT it renews.
# A revived openclaw would poll the bot alongside the glue — Telegram allows one
# poller per bot and both go deaf. So the container's provider gets a dead token
# first; revived or not, it can no longer take the bot. The real token stays in
# /root/seats/<seat>.env, which is where rollback.sh puts it back from.
#
# KNOWN GAP, accepted by the operator (decision 5 = C): the nudge and office
# runners deliver by exec INSIDE this container. From here until step 3 builds
# their replacement, this seat's planner questions, office notes and pushes
# report failed on Render.
set -euo pipefail

SEAT="${1:?usage: cutover.sh <seat>}"
[[ "$SEAT" =~ ^[a-z0-9_]+$ ]] || { echo "cutover: bad seat ref" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "cutover: run as root" >&2; exit 1; }
[ -f "/etc/seat-glue/${SEAT}.env" ] && [ -f /etc/systemd/system/seat-glue@.service ] \
  || { echo "cutover: run install.sh ${SEAT} first" >&2; exit 1; }

NEMOCLAW_USER="${NEMOCLAW_USER:-ubuntu}"
home="$(getent passwd "$NEMOCLAW_USER" | cut -d: -f6)"
OSH="${OSH:-$home/.local/bin/openshell}"
[ -x "$OSH" ] || { echo "cutover: openshell not found at $OSH" >&2; exit 1; }
log() { printf '== %s\n' "$*"; }
container() { docker ps -aq --filter "name=openshell-${SEAT}-" | head -1; }

# 1. A dead token into the openclaw seat's provider. Same argv-safe form as
#    badge-pull.sh:126 (the value rides the environment, never the command line).
DEAD="retired-to-seat-glue-$(date +%s)"
sudo -u "$NEMOCLAW_USER" -H env DEAD="$DEAD" \
  bash -c '"$0" provider update "$1-telegram-bridge" --credential "TELEGRAM_BOT_TOKEN=${DEAD:?}"' "$OSH" "$SEAT" >/dev/null
log "openclaw ${SEAT}: provider token replaced with a dead one"

# 2. Restart it so the process picks the dead token up (credentials inject at
#    launch only), then check what it now holds — by hash, never by value.
cid="$(container)"
if [ -n "$cid" ]; then
  docker restart "$cid" >/dev/null
  sleep 20
  real_hash="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "/root/seats/${SEAT}.env" | cut -d= -f2- | tr -d '"' | sha256sum | cut -d' ' -f1)"
  seen_hash="$(docker exec "$cid" sh -c 'printf %s "${TELEGRAM_BOT_TOKEN:-}"' 2>/dev/null | sha256sum | cut -d' ' -f1)"
  empty_hash="$(printf '' | sha256sum | cut -d' ' -f1)"
  if [ "$seen_hash" = "$real_hash" ]; then
    echo "cutover: the openclaw container STILL holds the real token — stopping here (nothing else changed)" >&2
    exit 1
  elif [ "$seen_hash" = "$empty_hash" ]; then
    log "container env has no TELEGRAM_BOT_TOKEN (the gateway injects it) — relying on the provider change + the glue's 409 check"
  else
    log "container now holds a token that is NOT the real one"
  fi
fi

# 3. Stop the openclaw seat: its revive unit first (Restart=always), then the container.
systemctl disable --now "nemoclaw-agent-${SEAT}.service" 2>/dev/null || true
[ -n "$cid" ] && docker stop "$cid" >/dev/null
log "openclaw ${SEAT}: revive unit disabled, container stopped"

# 4. Start the glue and show its first lines. A 409 here means another poller
#    still holds the bot: the unit stops (exit 3) instead of fighting it.
systemctl enable --now "seat-glue@${SEAT}"
sleep 15
journalctl -u "seat-glue@${SEAT}" -n 20 --no-pager
systemctl is-active --quiet "seat-glue@${SEAT}" && log "seat-glue@${SEAT} is running" \
  || { echo "cutover: seat-glue@${SEAT} is NOT running — see the journal above; rollback.sh ${SEAT} restores openclaw" >&2; exit 1; }
