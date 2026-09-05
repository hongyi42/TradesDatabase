#!/usr/bin/env bash
# gateway-heal.sh — after the gateway starts, put the sandboxes back.
#
# WHY. `Restart=always` on openshell-gateway.service restores the GATEWAY. It
# does not restore the seats, and on 2026-09-05 that difference was a 13-minute
# outage: the gateway came back correctly on both listeners within seconds,
# while all six sandboxes stayed down and needed two manual interventions.
#
# Killing the gateway SIGKILLs every sandbox container (exit 137, OOMKilled
# false). They do not come back on their own, and three of the six additionally
# refused to start at all — their tokens had expired weeks earlier and
# `static token sources cannot rebootstrap automatically`. A gateway that
# restarts itself into a box with no working seats is not recovery.
#
# ORDER IS DELIBERATE. Tokens first, then containers:
#   - the medic renews and restarts only the sandboxes it re-mints
#   - starting a container whose token is expired produces a crash loop, so
#     doing it the other way round means watching six containers flap while the
#     medic catches up
#
# ALWAYS EXITS 0, every external command under a hard timeout. Same bargain
# box-report.sh and ops-report.sh keep: a heal script that can wedge the unit it
# heals is worse than none. Wired as its own unit rather than ExecStartPost so a
# slow heal never holds the gateway in `activating`.
set -uo pipefail

log() { echo "[$(date -u +%FT%TZ)] gateway-heal: $*"; }

# 1. Wait for the gateway to actually serve. The medic and the sandboxes both
#    talk to it, so acting before it listens just burns the retries.
ready=0
for _ in $(seq 1 45); do
  if ss -tln 2>/dev/null | grep -q '127.0.0.1:8080'; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] && log "gateway is listening" \
  || log "gateway not listening after 90s — healing anyway, it may still come up"

# 2. Re-mint anything expired or close to it. This restarts the containers it
#    renews, which is why it runs before the start sweep below.
if [ -x /usr/local/bin/node ] && [ -r /usr/local/sbin/sandbox-token-medic.mjs ]; then
  RENEW_AHEAD_SECS="${RENEW_AHEAD_SECS:-259200}" \
    timeout 180 /usr/local/bin/node /usr/local/sbin/sandbox-token-medic.mjs 2>&1 \
    | while IFS= read -r l; do log "medic: $l"; done
else
  log "token medic not installed — skipping (expired tokens will crash-loop)"
fi

# 3. Start every sandbox that is not running. The medic only touches the ones it
#    re-mints; on 2026-09-05 that left three healthy-token containers stopped,
#    which had to be started by hand.
started=0
for c in $(timeout 15 docker ps -a --filter 'name=openshell-' --filter 'status=exited' \
             --format '{{.Names}}' 2>/dev/null); do
  if timeout 30 docker start "$c" >/dev/null 2>&1; then
    started=$((started + 1)); log "started $c"
  else
    log "could not start $c"
  fi
done

running="$(timeout 15 docker ps --filter 'name=openshell-' --quiet 2>/dev/null | wc -l | tr -d ' ')"
log "heal complete: ${started} started, ${running} sandbox container(s) running"
exit 0
