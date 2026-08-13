#!/usr/bin/env bash
# ops-report.sh — tell Render whether a unit on this box is serving.
#
#   ops-report.sh <service> <ok|down> [unit-name]
#
# WHY. The inference medic reports honestly whether the provider is serving, to
# `journalctl` on this box, which nobody reads — which is how SIX agent-outage
# windows on 2026-08-12 went unnoticed. This carries that verdict off the box.
#
# THIS SCRIPT MUST NEVER BE ABLE TO BREAK WHAT IT WATCHES. It is wired via
# systemd `OnFailure=`/`OnSuccess=`, so it runs in a SEPARATE unit from the
# medic — and it ALWAYS EXITS 0. A monitoring path that can mark its subject
# failed, or hold its tick open, is worse than no monitoring at all. Hence also
# the hard --max-time: a hung collector must not become a hung box.
#
# STATELESS BY DESIGN. It reports the CURRENT status every time and keeps no
# record of what it said before; the server folds repeats into one incident
# (see recordOpsEvent). That keeps the medic's "no state files" rule intact —
# flaps stay visible in the journal — and means a dropped report is harmless
# and needs no retry.
#
# CREDENTIALS. Reuses the badge pull's existing host token — no new secret:
# HOST_PULL_TOKEN and PULL_URL from /etc/doorman/badge-pull.env.
#
# That file is 0600 root:root and this runs as `ubuntu`, so the unit hands it in
# via `EnvironmentFile=` — systemd reads it as root and injects the variables
# into a process that then drops to ubuntu. Running the whole thing as root
# instead would have been simpler but breaks the route lookup: `openshell` is
# ubuntu's install, and root gets a different HOME and config (the same class of
# trap as the medic's `-u sandbox` login-shell requirement). Sourcing the file
# directly is kept only as a fallback for a manual run as root.
#
# Install:
#   sudo install -m 0755 ops-report.sh /usr/local/sbin/ops-report.sh
#   sudo install -m 0644 ops-report-medic-{down,ok}.service /etc/systemd/system/
#   sudo systemctl daemon-reload
#   # then reinstall nemoclaw-inference-medic.service (it gained OnFailure=/OnSuccess=)
set -uo pipefail

SERVICE="${1:-}"
STATUS="${2:-}"
UNIT="${3:-}"

# Every early return is exit 0 on purpose — see the header.
log() { echo "ops-report: $*"; }
bail() { log "$*"; exit 0; }

[ -n "$SERVICE" ] && [ -n "$STATUS" ] || bail "usage: ops-report.sh <service> <ok|down> [unit]"
case "$STATUS" in ok|down) ;; *) bail "status must be ok|down (got '$STATUS')" ;; esac

ENV_FILE="${OPS_ENV_FILE:-/etc/doorman/badge-pull.env}"
# Normally systemd has already injected these via EnvironmentFile=. The source
# is the fallback for running this by hand as root.
if { [ -z "${HOST_PULL_TOKEN:-}" ] || [ -z "${PULL_URL:-}" ]; } && [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
[ -n "${HOST_PULL_TOKEN:-}" ] || bail "HOST_PULL_TOKEN not in the environment and $ENV_FILE not readable — not reporting"
[ -n "${PULL_URL:-}" ] || bail "PULL_URL not in the environment and $ENV_FILE not readable — not reporting"
TOKEN="$HOST_PULL_TOKEN"
# PULL_URL points at /control/badges; the collector is /control/ops on the same
# service, so keep only scheme+host.
BASE="$(printf '%s' "$PULL_URL" | sed -E 's#(https?://[^/]+).*#\1#')"
[ -n "$BASE" ] || bail "could not derive a base URL from PULL_URL"

# ── evidence ────────────────────────────────────────────────────────────────
# What ships with the event is what makes it diagnosable WITHOUT ssh-ing here.
# "medic exit 1" on its own tells nobody anything.
ROUTE=""; EXITCODE=""; JOURNAL=""
if [ -n "$UNIT" ]; then
  EXITCODE="$(systemctl show "$UNIT" -p ExecMainStatus --value 2>/dev/null || true)"
  # The unit's own last lines: the medic's warn text names the failure mode
  # (not serving vs. failed registration vs. no container).
  JOURNAL="$(journalctl -u "$UNIT" -n 20 --no-pager -o cat 2>/dev/null | tail -c 4000 || true)"
fi
export PATH="/home/ubuntu/.local/bin:$PATH"
ROUTE="$(openshell inference get 2>/dev/null | sed -E "s/$(printf '\033')\[[0-9;]*m//g" \
  | awk '/Provider:/{p=$2} /Model:/{m=$2} END{if (p!="") print p" / "m}' || true)"

# JSON-encode with python3 (present on the box) rather than hand-escaping: the
# journal tail contains quotes, newlines and box-drawing characters.
PAYLOAD="$(python3 - "$SERVICE" "$STATUS" "$UNIT" "$EXITCODE" "$ROUTE" "$JOURNAL" <<'PY' 2>/dev/null
import json, sys
service, status, unit, code, route, journal = sys.argv[1:7]
detail = {"unit": unit, "exitCode": code, "route": route, "journal": journal,
          "reportedBy": "ops-report.sh"}
print(json.dumps({"service": service, "status": status,
                  "detail": {k: v for k, v in detail.items() if v not in ("", None)}}))
PY
)"
[ -n "$PAYLOAD" ] || bail "could not build payload — not reporting"

# ── send ────────────────────────────────────────────────────────────────────
# Short, hard timeouts. This runs on every medic tick; a slow or wedged
# collector must cost seconds, not minutes.
RESP="$(curl -sS -m 5 --connect-timeout 3 \
  -w '\n%{http_code}' \
  -X POST "$BASE/control/ops" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary "$PAYLOAD" 2>&1)" || bail "POST failed (collector unreachable) — status was '$STATUS'"

CODE="$(printf '%s' "$RESP" | tail -1)"
BODY="$(printf '%s' "$RESP" | sed '$d')"
case "$CODE" in
  200) log "reported $SERVICE=$STATUS -> $BODY" ;;
  401) log "reported $SERVICE=$STATUS -> 401 UNAUTHORIZED: the host token in $ENV_FILE is not registered" ;;
  *)   log "reported $SERVICE=$STATUS -> HTTP $CODE: $BODY" ;;
esac
exit 0
