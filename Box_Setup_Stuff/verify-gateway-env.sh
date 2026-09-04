#!/usr/bin/env bash
# verify-gateway-env.sh — prove openshell-gateway.service would hand the binary
# the SAME configuration the working process already has, before anything is
# stopped or started.
#
# WHY THIS EXISTS RATHER THAN A TEST LAUNCH. The obvious check — start a second
# gateway on a spare port and see if it comes up — is not safe here. The
# environment carries OPENSHELL_DRIVERS=docker, so a second gateway connects to
# the docker daemon and, with an empty database, may reconcile against sandboxes
# it does not know about. Validating the control plane by risking the containers
# it controls is the wrong trade.
#
# So this compares environments instead: what systemd would pass, against what
# the working process actually has. If those agree, the only thing that can go
# wrong in the adoption has been ruled out.
#
# ⚠ `systemctl show -p Environment` DOES NOT WORK for this. It reports only
# `Environment=` directives; systemd reads `EnvironmentFile=` at START time, so
# for a unit configured this way it renders nothing at all — which reads exactly
# like "the unit has no environment" and would send you fixing a unit that is
# fine. Instead a transient unit runs /usr/bin/env with the SAME EnvironmentFile
# and the SAME uid, so systemd itself does the parsing. It runs `env`, never the
# gateway, so nothing touches docker or the sandboxes.
#
# READ-ONLY. Starts nothing, stops nothing, writes nothing. Safe at any time.
# Exits non-zero if they disagree, so it can gate the adoption.
set -uo pipefail

UNIT="${UNIT:-openshell-gateway.service}"

pid="$(pgrep -x openshell-gatew | head -1 || true)"
if [ -z "$pid" ]; then
  echo "FAIL: no running openshell-gateway to compare against." >&2
  echo "      The comparison only means something while the WORKING process is up." >&2
  exit 1
fi

if ! systemctl cat "$UNIT" >/dev/null 2>&1; then
  echo "FAIL: $UNIT is not installed. Install it and run daemon-reload first." >&2
  exit 1
fi

live="$(mktemp)"; unitenv="$(mktemp)"
trap 'rm -f "$live" "$unitenv"' EXIT

# The live process, OPENSHELL_* only. HOME/USER/PATH are set by the unit itself
# and the systemd bookkeeping vars (INVOCATION_ID, JOURNAL_STREAM,
# SYSTEMD_EXEC_PID) are deliberately excluded — systemd sets its own.
sudo tr '\0' '\n' < "/proc/$pid/environ" | grep '^OPENSHELL' | sort > "$live"

# What systemd would pass. Read the EnvironmentFile path out of the unit rather
# than assuming it, then let systemd itself parse that file in a transient unit
# running /usr/bin/env — same parser, same uid, no gateway.
envfile="$(systemctl show "$UNIT" -p EnvironmentFiles --value | sed -E 's/ \(ignore_errors=.*\)$//')"
if [ -z "$envfile" ]; then
  echo "FAIL: $UNIT declares no EnvironmentFile. Nothing would be passed." >&2
  exit 1
fi
if [ ! -r "$envfile" ]; then
  echo "FAIL: $UNIT points at $envfile, which does not exist or is unreadable." >&2
  echo "      Run capture-gateway-env.sh first." >&2
  exit 1
fi
echo "unit reads: $envfile"

runuser="$(systemctl show "$UNIT" -p User --value)"
if ! sudo systemd-run --quiet --collect --wait --pipe \
       --unit=gateway-env-check \
       --property="EnvironmentFile=$envfile" \
       --uid="${runuser:-ubuntu}" \
       /usr/bin/env 2>/dev/null | grep '^OPENSHELL' | sort > "$unitenv"; then
  echo "FAIL: could not render the unit's environment via systemd-run." >&2
  exit 1
fi

echo "live process (pid $pid): $(wc -l < "$live") OPENSHELL_* variables"
echo "unit $UNIT:              $(wc -l < "$unitenv") OPENSHELL_* variables"
echo

if diff -u "$live" "$unitenv" > /tmp/gwenv.diff 2>&1; then
  echo "PASS — systemd would hand the binary an identical environment."
  echo "       The adoption's one real failure mode is ruled out."
  exit 0
fi

echo "FAIL — the environments differ. DO NOT adopt until this is empty:"
echo "       (-) only in the working process   (+) only in the unit"
sed -n '3,40p' /tmp/gwenv.diff
echo
echo "Missing variables are the dangerous direction: a gateway started without"
echo "OPENSHELL_DRIVERS has no compute driver at all, and one started without"
echo "OPENSHELL_GATEWAY_CONFIG has no TLS or JWT material. Re-run"
echo "capture-gateway-env.sh, then daemon-reload, then this again."
exit 1
