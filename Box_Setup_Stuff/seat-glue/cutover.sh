#!/usr/bin/env bash
# cutover.sh <seat> — move a seat's Telegram bot from its openclaw sandbox to the
# seat glue. Run as ROOT on trades-box-1 after install.sh. Undo: rollback.sh.
#
# STOPPING A CONTAINER IS NOT RETIRING IT. gateway-heal.sh starts every exited
# openshell- container and sandbox-token-medic.mjs `docker restart`s the ones
# it renews. What keeps a restarted container from polling the bot is that its
# openclaw agent only comes back through nemoclaw-agent-<seat>.service
# (nemoclaw-agent-revive.sh: a bare container restart brings up PID 1 only). So:
#   1. disable that revive unit — the agent can no longer be relaunched;
#   2. put a DEAD bot token in the seat's provider — a second layer, for any
#      relaunch path we do not know about (credentials resolve at launch);
#   3. stop the container, which ends the poller that is running now;
#   4. start the glue. Telegram allows ONE poller per bot: if anything still
#      polls, the glue logs ANOTHER POLLER and its unit stays down (exit 3).
# The real token stays in /root/seats/<seat>.env; rollback.sh restores it.
#
# What this does NOT verify, honestly: which token the openclaw process holds.
# A sandbox never shows a credential's value — `docker exec … printenv` sees a
# placeholder or nothing — so the only live proof is the glue polling without
# a 409, which step 4 shows.
#
# KNOWN GAP, accepted by the operator (decision 5 = C): the nudge and office
# runners deliver by exec INSIDE this container. Until step 3 builds their
# replacement, this seat's planner questions, office notes and pushes report
# failed on Render.
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

# Nothing has changed yet. From the first change on, a failure must say how to recover.
changed=0
trap '[ "$changed" = 1 ] && echo "cutover: FAILED at line $LINENO — the bot may have NO poller now; run rollback.sh ${SEAT}" >&2' ERR

# 0. The provider must already hold a TELEGRAM_BOT_TOKEN key — otherwise the
#    update below would ADD a key and leave the real one live. Key NAMES only
#    (bootstrap-box.sh's idiom: strip colours, read the "Credential keys" line).
keys="$(sudo -u "$NEMOCLAW_USER" -H "$OSH" provider get "${SEAT}-telegram-bridge" </dev/null 2>/dev/null \
        | sed 's/\x1b\[[0-9;]*m//g' | grep -i 'Credential keys:' || true)"
case "$keys" in
  *TELEGRAM_BOT_TOKEN*) log "provider ${SEAT}-telegram-bridge holds TELEGRAM_BOT_TOKEN" ;;
  *) echo "cutover: could not confirm ${SEAT}-telegram-bridge holds TELEGRAM_BOT_TOKEN — nothing changed" >&2; exit 1 ;;
esac
cid="$(docker ps -aq --filter "name=openshell-${SEAT}-" | head -1 || true)"

# 1. No more relaunches.
changed=1
systemctl disable --now "nemoclaw-agent-${SEAT}.service" 2>/dev/null || true
log "openclaw ${SEAT}: revive unit disabled"

# 2. A dead token in the provider. The bare-KEY form reads the value from the
#    environment (docs/inference-recovery-runbook.md), so it never reaches
#    sudo's logged command line or ps. (This value is not a secret either way.)
TELEGRAM_BOT_TOKEN="retired-to-seat-glue-$(date +%s)" \
  sudo --preserve-env=TELEGRAM_BOT_TOKEN -u "$NEMOCLAW_USER" -H \
  "$OSH" provider update "${SEAT}-telegram-bridge" --credential TELEGRAM_BOT_TOKEN </dev/null >/dev/null
log "openclaw ${SEAT}: provider token replaced with a dead one"

# 3. End the poller that is running now.
if [ -n "$cid" ]; then docker stop "$cid" >/dev/null; fi
log "openclaw ${SEAT}: container stopped"

# 4. Start the glue and show its first lines.
systemctl enable --now "seat-glue@${SEAT}"
sleep 20
journalctl -u "seat-glue@${SEAT}" -n 20 --no-pager
if systemctl is-active --quiet "seat-glue@${SEAT}"; then
  log "seat-glue@${SEAT} is running — text the bot to test it"
else
  echo "cutover: seat-glue@${SEAT} is NOT running — see the journal above; rollback.sh ${SEAT} restores openclaw" >&2
  exit 1
fi
