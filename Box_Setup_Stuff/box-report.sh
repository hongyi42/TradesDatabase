#!/usr/bin/env bash
# box-report.sh — push this box's INTERNAL health to the Render control plane.
#
# WHY THIS EXISTS. n8n is moving off this box to its own host so it can witness
# this box dying. That move costs it the one thing it could only do from here:
# see inside. `docker ps`, `df`, `systemctl` have no API — there is nothing to
# poll from outside, and giving a central n8n SSH keys to every box would make
# n8n a lateral-movement pivot into the whole fleet. So the box reports itself,
# outbound-only, over the same authenticated path the medic already uses. No
# inbound port, no keys held centrally, and adding box #4 costs one systemd
# timer instead of a fourth n8n.
#
# THIS SCRIPT MUST NEVER BE ABLE TO BREAK WHAT IT WATCHES — the same bargain
# ops-report.sh keeps. It ALWAYS EXITS 0, every external command runs under a
# hard `timeout`, and one failing check never aborts the rest. A monitor that
# can fail its subject, or wedge a tick open, is worse than no monitor.
#
# STATELESS BY DESIGN. Reports the CURRENT status of every check on every tick
# and keeps no record of what it said before. `recordOpsEvent` on the server
# folds repeats into ONE incident and only `opened`/`closed` reach Telegram, so
# a dropped tick is harmless and needs no retry. Same contract as ops-report.sh.
#
# WHY IT DOES NOT SHELL OUT TO ops-report.sh. That script is shaped for a single
# systemd unit: it collects a journal tail, an exit code, and — on every call —
# runs `openshell inference get` to attach the live model route. None of that
# fits `box-disk`, and eight invocations per tick would mean eight pointless
# route lookups and eight separate POSTs. The transport below is deliberately a
# near-copy: same endpoint, same bearer token, same keys-only discipline, same
# always-exit-0 rule. Keep the two in step if the /control/ops contract changes.
#
# HOW A DEAD REPORTER IS CAUGHT. It cannot report its own death — silence from a
# stateless reporter looks exactly like "everything is fine", because no new
# report means no incident opens. So a successful run pings Healthchecks LAST
# (REPORTER_HEALTHCHECK_URL) and Healthchecks alarms on the silence. That is a
# SEPARATE check from the box-alive heartbeat on purpose: the heartbeat is one
# bare curl in cron with nothing in it to break, and a bug in this script must
# not be able to masquerade as the box being dead.
#
# Install:
#   sudo install -m 0755 box-report.sh /usr/local/sbin/box-report.sh
#   sudo install -m 0644 box-report.service box-report.timer /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now box-report.timer
#   sudo systemctl start box-report.service    # run once now, read the output
set -uo pipefail

log() { echo "[$(date -u +%FT%TZ)] box-report: $*"; }

# ── credentials ──────────────────────────────────────────────────────────────
# Reuses the badge pull's existing host token — no new secret. Normally systemd
# has already injected these via EnvironmentFile=; sourcing is the fallback for
# a manual run as root (the file is 0600 root:root).
ENV_FILE="${OPS_ENV_FILE:-/etc/doorman/badge-pull.env}"
if { [ -z "${HOST_PULL_TOKEN:-}" ] || [ -z "${PULL_URL:-}" ]; } && [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
if [ -z "${HOST_PULL_TOKEN:-}" ] || [ -z "${PULL_URL:-}" ]; then
  log "HOST_PULL_TOKEN/PULL_URL not in the environment and $ENV_FILE not readable — not reporting"
  exit 0
fi
# PULL_URL points at /control/badges; the collector is /control/ops on the same
# service, so keep only scheme+host.
BASE="$(printf '%s' "$PULL_URL" | sed -E 's#(https?://[^/]+).*#\1#')"
if [ -z "$BASE" ]; then log "could not derive a base URL from PULL_URL"; exit 0; fi

# ── thresholds (override in /etc/nemoclaw/box-report.env) ────────────────────
DISK_PCT_MAX="${DISK_PCT_MAX:-85}"     # root filesystem % used
MEM_AVAIL_MIN_MB="${MEM_AVAIL_MIN_MB:-400}"
# Units to check. Timers are checked for being active; oneshot services for
# their last Result; everything else for being running. Units that are not
# installed are skipped rather than reported down, so this list is safe to keep
# broad across boxes that do not all run the same things.
#
# nemoclaw-inference-medic.SERVICE is deliberately absent: it already reports
# itself through ops-report.sh via OnFailure=/OnSuccess=, and reporting it here
# too would open a second incident for one outage. Its TIMER is present, because
# nothing else notices a stopped timer — a medic that never runs never reports,
# and silence from it is indistinguishable from health.
BOX_UNITS="${BOX_UNITS:-doorman.service badge-pull.timer badge-pull.service nudge-runner.timer nudge-runner.service sandbox-token-medic.service sandbox-recycler.service nemoclaw-inference-medic.timer}"

FAILED=0   # count of checks reporting down, for the closing log line only

# ── transport ────────────────────────────────────────────────────────────────
# report <service> <ok|down> [key=value ...]
# Values are our own strings and numbers, never command output that could carry
# a connection string — keys-only discipline, same as ops-report.sh.
report() {
  local service="$1" status="$2"; shift 2
  local payload
  payload="$(python3 - "$service" "$status" "$@" <<'PY' 2>/dev/null
import json, sys
service, status = sys.argv[1], sys.argv[2]
detail = {"reportedBy": "box-report.sh"}
for kv in sys.argv[3:]:
    if "=" in kv:
        k, v = kv.split("=", 1)
        detail[k] = v
print(json.dumps({"service": service, "status": status, "detail": detail}))
PY
)"
  if [ -z "$payload" ]; then log "could not build payload for $service — skipping"; return 0; fi
  [ "$status" = down ] && FAILED=$((FAILED + 1))
  # Short, hard timeouts: a wedged collector must cost seconds, not minutes.
  local code
  code="$(curl -sS -m 8 --connect-timeout 4 -o /dev/null -w '%{http_code}' \
    -X POST "$BASE/control/ops" \
    -H "Authorization: Bearer $HOST_PULL_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary "$payload" 2>/dev/null)" || code=000
  case "$code" in
    200) log "$service=$status" ;;
    401) log "$service=$status -> 401 UNAUTHORIZED: the host token in $ENV_FILE is not registered" ;;
    # 400 means the collector REFUSED the row, so this check is not being
    # recorded at all — the reporter looks healthy while monitoring nothing.
    # Called out explicitly because it cost a full install cycle: service names
    # must satisfy opsEvents.ts's SERVICE_RE, which is lowercase kebab-case only.
    # No colons, no dots. The COLUMN is free text; the validator is not.
    400) log "$service=$status -> 400 REJECTED: not recorded. Service name must be lowercase kebab-case ([a-z0-9-], <=64)" ;;
    000) log "$service=$status -> collector unreachable" ;;
    *)   log "$service=$status -> HTTP $code" ;;
  esac
  return 0
}

# Build a collector-legal service name from a systemd unit.
#   doorman.service                 -> box-doorman
#   badge-pull.timer                -> box-badge-pull-timer
#   nemoclaw-inference-medic.timer  -> box-nemoclaw-inference-medic-timer
# opsEvents.ts rejects anything outside ^[a-z0-9]+(-[a-z0-9]+)*$, so the dot in a
# .timer unit and the colon of a namespace prefix are both illegal.
svc_name() { printf 'box-%s' "$(printf '%s' "${1%.service}" | tr '._' '--')"; }

# ── checks ───────────────────────────────────────────────────────────────────

check_disk() {
  local line pct avail
  line="$(timeout 5 df -P / 2>/dev/null | awk 'NR==2 {print $5" "$4}')"
  if [ -z "$line" ]; then report box-disk down reason=df-produced-no-output; return 0; fi
  pct="${line%% *}"; pct="${pct%\%}"
  avail="${line##* }"
  case "$pct" in ''|*[!0-9]*) report box-disk down reason=unparseable-df-output; return 0 ;; esac
  # A percentage above 100 means we read the wrong column, not that the disk is
  # 600% full. Caught in testing against a non-POSIX df whose layout differs:
  # the digits-only guard above passed and it would have reported a false
  # outage. Misreading the input must look like a broken check, never like a
  # real incident — a monitor that cries wolf gets muted, and a muted monitor is
  # the failure this whole pipeline exists to prevent.
  if [ "$pct" -gt 100 ]; then
    report box-disk down reason=df-percentage-out-of-range usedPctRaw="$pct"
    return 0
  fi
  if [ "$pct" -ge "$DISK_PCT_MAX" ]; then
    report box-disk down usedPct="$pct" availKb="$avail" thresholdPct="$DISK_PCT_MAX"
  else
    report box-disk ok usedPct="$pct" availKb="$avail"
  fi
}

check_memory() {
  local mb
  mb="$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
  case "$mb" in ''|*[!0-9]*) report box-memory down reason=could-not-read-meminfo; return 0 ;; esac
  if [ "$mb" -lt "$MEM_AVAIL_MIN_MB" ]; then
    report box-memory down availMb="$mb" thresholdMb="$MEM_AVAIL_MIN_MB"
  else
    report box-memory ok availMb="$mb"
  fi
}

check_docker() {
  # `docker info` talks to the daemon; `docker ps` alone can succeed from cache
  # on some versions. Distinguishing reachability from function (system-design
  # Tier 4) — a daemon that answers but cannot list containers is still down.
  if ! timeout 12 docker info >/dev/null 2>&1; then
    report box-docker down reason=docker-info-failed-or-timed-out
    return 0
  fi
  local running
  running="$(timeout 12 docker ps --quiet 2>/dev/null | wc -l | tr -d ' ')"
  case "$running" in ''|*[!0-9]*) report box-docker down reason=docker-ps-failed; return 0 ;; esac
  report box-docker ok running="$running"
}

# Decide ok/down for one unit WITHOUT needing to know what kind it is:
#   .timer          -> must be active
#   Type=oneshot    -> must not have failed; last Result must be success
#   anything else   -> must be running
# The oneshot distinction is load-bearing. A oneshot's normal resting state is
# ActiveState=inactive, so checking "is-active" alone would report every healthy
# oneshot as down; conversely, checking only Result on a long-running unit would
# report a STOPPED daemon as fine, because its last Result is still `success`.
unit_status() {
  local u="$1" load active type result
  load="$(timeout 5 systemctl show "$u" -p LoadState --value 2>/dev/null || echo unknown)"
  [ "$load" = loaded ] || { echo skip; return 0; }
  active="$(timeout 5 systemctl show "$u" -p ActiveState --value 2>/dev/null || echo unknown)"
  case "$u" in
    *.timer)
      [ "$active" = active ] && echo "ok $active" || echo "down $active"
      return 0 ;;
  esac
  type="$(timeout 5 systemctl show "$u" -p Type --value 2>/dev/null || echo '')"
  if [ "$type" = oneshot ]; then
    result="$(timeout 5 systemctl show "$u" -p Result --value 2>/dev/null || echo '')"
    if [ "$active" = failed ] || { [ -n "$result" ] && [ "$result" != success ]; }; then
      echo "down $active/${result:-none}"
    else
      echo "ok $active/${result:-none}"
    fi
    return 0
  fi
  case "$active" in
    active|activating) echo "ok $active" ;;
    *)                 echo "down $active" ;;
  esac
}

check_units() {
  local u verdict state svc
  # shellcheck disable=SC2086  # BOX_UNITS is a deliberately space-separated list
  for u in $BOX_UNITS; do
    read -r verdict state <<<"$(unit_status "$u")"
    [ "$verdict" = skip ] && { log "$u not installed — skipping"; continue; }
    svc="$(svc_name "$u")"
    report "$svc" "$verdict" unit="$u" state="$state"
  done
}

# Per-agent sandbox units are enumerated from systemd at run time, never from a
# remembered list. A fleet pass once missed a sandbox that had been added since
# the written map (system-design Tier 3) — a hardcoded list here would silently
# stop covering the newest technician, which is exactly the person most likely
# to be mid-onboarding and least likely to be missed loudly.
check_agents() {
  local units u verdict state
  units="$(timeout 10 systemctl list-units --type=service --all --no-legend --plain --no-pager \
            'nemoclaw-agent-*.service' 2>/dev/null | awk '{print $1}')"
  if [ -z "$units" ]; then
    log "no nemoclaw-agent-*.service units found — nothing to report"
    return 0
  fi
  # shellcheck disable=SC2086  # one unit name per line, no spaces in unit names
  for u in $units; do
    read -r verdict state <<<"$(unit_status "$u")"
    [ "$verdict" = skip ] && continue
    report "$(svc_name "$u")" "$verdict" unit="$u" state="$state"
  done
}

# ── run ──────────────────────────────────────────────────────────────────────
check_disk
check_memory
check_docker
check_units
check_agents

# Liveness ping LAST, so it means "a full sweep completed", not "the script
# started". Healthchecks alarms when these stop — the only way a reporter that
# never ran can announce itself. Note this fires even when checks reported DOWN:
# it attests that the REPORTER works, which is a different question from whether
# the box is healthy. Conflating them would make a real outage look like a dead
# reporter and vice versa.
if [ -n "${REPORTER_HEALTHCHECK_URL:-}" ]; then
  curl -sS -m 8 --connect-timeout 4 "$REPORTER_HEALTHCHECK_URL" >/dev/null 2>&1 \
    || log "(reporter healthcheck ping failed — the sweep itself completed)"
fi

log "sweep complete, ${FAILED} check(s) reporting down"
exit 0
