#!/usr/bin/env bash
# monitor-health.sh — report the MONITOR HOST's own health to Healthchecks.
#
# WHY THIS EXISTS. Moving n8n off the agent box gave it a machine that nothing
# watches. `n8n-alive` proves n8n is running; it says nothing about the host
# underneath. A disk filling here kills n8n, and the only warning would be
# n8n-alive going red AFTER the monitoring is already gone — a fire alarm that
# rings once the building has burned down.
#
# WHY NOT box-report.sh + /control/ops. That path authenticates with a host
# token issued to a registered host, and registering this machine means writing
# to the pilot database for the sake of two checks. So this uses the mechanism
# already available: Healthchecks. It is a CONDITIONAL HEARTBEAT — ping on
# healthy, POST /fail with a reason when not.
#
# That inversion is deliberate. A plain "report a problem" call cannot survive
# the machine being dead, but silence can: if this host is powered off, wedged,
# or has no network, the ping simply does not arrive and Healthchecks alarms.
# Reporting failure covers the problems we predicted; silence covers the ones we
# did not.
#
# THIS MUST NEVER BREAK WHAT IT WATCHES. Always exits 0, every command runs under
# a hard timeout, and one failing check never aborts the rest — the same bargain
# box-report.sh and ops-report.sh keep.
#
# Install:
#   sudo install -m 0755 monitor-health.sh /usr/local/sbin/monitor-health.sh
#   sudo install -m 0644 monitor-health.service monitor-health.timer /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now monitor-health.timer
set -uo pipefail

log() { echo "[$(date -u +%FT%TZ)] monitor-health: $*"; }

ENV_FILE="${MONITOR_HEALTH_ENV:-/etc/nemoclaw/monitor-health.env}"
if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi
if [ -z "${MONITOR_HEALTHCHECK_URL:-}" ]; then
  log "MONITOR_HEALTHCHECK_URL not set in $ENV_FILE — nothing to report to"
  exit 0
fi

DISK_PCT_MAX="${DISK_PCT_MAX:-85}"
MEM_AVAIL_MIN_MB="${MEM_AVAIL_MIN_MB:-250}"
N8N_DIR="${N8N_DIR:-/home/ubuntu/n8n}"

PROBLEMS=""
add() { PROBLEMS="${PROBLEMS}${PROBLEMS:+; }$1"; }

# ── disk ─────────────────────────────────────────────────────────────────────
LINE="$(timeout 5 df -P / 2>/dev/null | awk 'NR==2 {print $5" "$4}')"
PCT="${LINE%% *}"; PCT="${PCT%\%}"; AVAIL="${LINE##* }"
case "$PCT" in
  ''|*[!0-9]*) add "disk: could not parse df output" ;;
  *)
    # >100 means we read the wrong column, not a 600%-full disk. Misreading input
    # must look like a broken check, never like a real incident.
    if [ "$PCT" -gt 100 ]; then add "disk: df percentage out of range ($PCT)"
    elif [ "$PCT" -ge "$DISK_PCT_MAX" ]; then add "disk ${PCT}% used (limit ${DISK_PCT_MAX}%), ${AVAIL}KB free"
    fi ;;
esac

# ── memory ───────────────────────────────────────────────────────────────────
MB="$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
case "$MB" in
  ''|*[!0-9]*) add "memory: could not read /proc/meminfo" ;;
  *) [ "$MB" -lt "$MEM_AVAIL_MIN_MB" ] && add "memory ${MB}MB available (limit ${MEM_AVAIL_MIN_MB}MB)" ;;
esac

# ── docker daemon ────────────────────────────────────────────────────────────
if ! timeout 12 docker info >/dev/null 2>&1; then
  add "docker daemon not responding"
else
  # ── the n8n container ──────────────────────────────────────────────────────
  # Two separate questions, and the second is the one that matters: a container
  # can be "running" while the app inside it is wedged. Compose records the
  # health probe's verdict, so read that rather than settling for Up.
  STATE="$(timeout 10 docker inspect -f '{{.State.Status}}' n8n-n8n-1 2>/dev/null || echo missing)"
  HEALTH="$(timeout 10 docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' n8n-n8n-1 2>/dev/null || echo unknown)"
  [ "$STATE" = running ] || add "n8n container state=$STATE"
  case "$HEALTH" in
    healthy|none) ;;
    *) add "n8n container health=$HEALTH" ;;
  esac
fi

# ── report ───────────────────────────────────────────────────────────────────
# The body travels into the Healthchecks event log and the alert itself, so the
# message says what is wrong without anyone needing to SSH in first.
if [ -n "$PROBLEMS" ]; then
  log "UNHEALTHY: $PROBLEMS"
  curl -fsS -m 10 --retry 2 --data-raw "$PROBLEMS" "${MONITOR_HEALTHCHECK_URL%/}/fail" >/dev/null 2>&1 \
    || log "(could not reach Healthchecks to report the failure — silence will raise it instead)"
else
  log "healthy (disk ${PCT}%, mem ${MB}MB, n8n ok)"
  curl -fsS -m 10 --retry 2 --data-raw "disk ${PCT}% mem ${MB}MB n8n ok" "$MONITOR_HEALTHCHECK_URL" >/dev/null 2>&1 \
    || log "(healthcheck ping failed — the host itself is fine)"
fi
exit 0
