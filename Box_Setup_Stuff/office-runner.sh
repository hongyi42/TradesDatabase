#!/usr/bin/env bash
# office-runner.sh — build 5.5 Phase 3 (plan 2026-08-31 "the planner's
# inbox"): inject queued AGENT-ADDRESSED office messages (the planner's
# ask_agent/inform_agent + seat-to-seat informs) as agent turns via the CLI
# door. Runs as ROOT on a systemd timer (every 5 min), pairs with the spine's
# GET/POST /control/office.
#
# THE CLI DOOR, probed live on s2 2026-08-31: `openclaw agent` runs via the
# GATEWAY by default (the 12k truncation applies only to --local), and
# `--session-key main` lands the turn in the Telegram chat's MAIN session, so
# injected context is recalled by later turns and decays on OpenClaw's normal
# idle rotation — which IS the design (an inform is context, not record).
# NO --deliver, deliberately and load-bearing: nothing reaches Telegram —
# the agent absorbs the turn, and only its own later judgment (answering an
# OFFICE QUESTION via inform_team_lead, or asking its person the normal way)
# produces anything a human sees.
#
# Posture: nudge-runner.sh discipline verbatim — ALWAYS exits 0; failures are
# reported per item to the spine, which owns retries (a message is served
# until acked; frozen past its caps). Every network call carries a hard
# --max-time; every CLI call a hard timeout.
#
# Per item:
#   1. validate id/sandboxRef (they become argv — never paths, never flags),
#   2. sent-marker pre-check: /var/lib/office-runner/sent-<id> present means a
#      previous tick injected this turn and only the ACK was lost — re-ack,
#      never re-inject (a duplicate injected turn is a duplicate instruction
#      to weigh),
#   3. decode directMessageB64 (absent → report failed),
#   4. STAGE the body to a file inside the sandbox (openshell exec rejects
#      newlines in argv — the 2026-08-18 trap) and run
#      `openclaw agent --session-key main --message-file <file> --json`
#      IN-CONTAINER (the binary lives in the sandbox; gateway path by default),
#   5. judge by the CLI's own exit status — a completed turn exits 0,
#   6. write the marker, THEN report — a lost ack re-acks next tick.
#
# Setup (once, as root — the nudge-runner steps, new names):
#   install -o root -g root -m 700 office-runner.sh /usr/local/sbin/office-runner.sh
#   cp office-runner.service office-runner.timer /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now office-runner.timer
# Reuses /etc/doorman/badge-pull.env (PULL_URL + HOST_PULL_TOKEN); no new
# secret. Escape hatch: `systemctl disable --now office-runner.timer`.
# ROLLOUT: s2 first (the canary seat's host), fleet only with the whole-order
# deploy — the harness rebuild stays in testing.

set -u

ENV_FILE="${ENV_FILE:-/etc/doorman/badge-pull.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
: "${HOST_PULL_TOKEN:?HOST_PULL_TOKEN missing from $ENV_FILE}"
: "${PULL_URL:?PULL_URL missing from $ENV_FILE}"
OFFICE_URL="${OFFICE_URL:-${PULL_URL%/control/badges}/control/office}"
NEMOCLAW_USER="${NEMOCLAW_USER:-ubuntu}"
home=$(getent passwd "$NEMOCLAW_USER" | cut -d: -f6)
NEMOCLAW_BIN="${NEMOCLAW_BIN:-$home/.local/bin/nemoclaw}"
# Sent markers: one empty file per injected message id. Must exist BEFORE the
# loop or the idempotence pre-check silently never engages.
MARK_DIR="/var/lib/office-runner"
install -d -m 700 "$MARK_DIR"

if [ ! -x "$NEMOCLAW_BIN" ]; then
  echo "office-runner: nemoclaw not found at $NEMOCLAW_BIN — nothing injected" >&2
  exit 0
fi

resp=$(curl -fsS --max-time 30 -H "Authorization: Bearer $HOST_PULL_TOKEN" "$OFFICE_URL") || {
  echo "office-runner: pull failed — retrying next tick" >&2
  exit 0
}

count=$(printf '%s' "$resp" | jq '.messages | length' 2>/dev/null) || {
  echo "office-runner: pull response was not JSON" >&2
  exit 0
}
[ "$count" -gt 0 ] 2>/dev/null || exit 0

report() { # $1 id, $2 outcome, $3 fixed detail string (NEVER interpolated output)
  curl -fsS --max-time 15 -X POST \
    -H "Authorization: Bearer $HOST_PULL_TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"id\":\"$1\",\"outcome\":\"$2\",\"detail\":\"$3\"}" \
    "$OFFICE_URL" >/dev/null 2>&1 || true
}

printf '%s' "$resp" | jq -c '.messages[]' | while IFS= read -r item; do
  id=$(printf '%s' "$item" | jq -r '.id // empty')
  sref=$(printf '%s' "$item" | jq -r '.sandboxRef // empty')
  b64=$(printf '%s' "$item" | jq -r '.directMessageB64 // empty')

  # ids are uuids minted by the spine; refs become ARGV — accept only sane
  # names (the badge-pull retirement-ref rule).
  if ! printf '%s' "$id" | grep -Eq '^[A-Za-z0-9-]+$'; then continue; fi
  if ! printf '%s' "$sref" | grep -Eq '^[A-Za-z0-9_]+$'; then
    report "$id" failed "invalid sandboxRef"
    continue
  fi

  # Idempotence: a marker means a previous tick injected this id and only the
  # ack was lost — re-ack, never re-inject.
  if [ -f "$MARK_DIR/sent-$id" ]; then
    report "$id" delivered ""
    continue
  fi

  msg=$(printf '%s' "$b64" | base64 -d 2>/dev/null) || {
    report "$id" failed "message decode failed"
    continue
  }
  [ -n "$msg" ] || { report "$id" failed "no direct payload"; continue; }

  # STAGE THE BODY INSIDE THE SANDBOX FIRST (newline-in-argv trap). $id is
  # validated [A-Za-z0-9-]+ above, safe to interpolate.
  msgfile="/tmp/office-$id.txt"
  if ! printf '%s' "$msg" | timeout 60 sudo -u "$NEMOCLAW_USER" -H \
      "$NEMOCLAW_BIN" "$sref" exec --no-tty -- bash -c "cat > $msgfile" \
      >/dev/null 2>&1; then
    report "$id" failed "could not stage message in sandbox"
    continue
  fi

  # Inject the turn IN-CONTAINER via the gateway (the probed door): main
  # session, no --deliver — nothing reaches the human. A real model turn runs.
  # 630s, ABOVE the gateway's own agents.defaults.timeoutSeconds (600, s2
  # config): the gateway is the authority on when a turn has failed, and a
  # client timeout shorter than the turn would report failed on a turn that
  # then completes — no marker, so the next tick would re-inject a duplicate
  # instruction (final review). </dev/null: exec eats stdin (recorded gotcha).
  if timeout 630 sudo -u "$NEMOCLAW_USER" -H "$NEMOCLAW_BIN" "$sref" exec --no-tty -- \
      bash -c "openclaw agent --session-key main --message-file $msgfile --json" \
      </dev/null >/dev/null 2>&1; then
    # Marker BEFORE report: a lost ack re-acks next tick instead of
    # re-injecting. The sha256 line is the byte-identity evidence trail.
    touch "$MARK_DIR/sent-$id"
    hash=$(printf '%s' "$msg" | sha256sum | cut -d' ' -f1)
    echo "office-runner: injected $id chars=${#msg} sha256=$hash" >&2
    report "$id" delivered ""
  else
    report "$id" failed "agent turn failed"
  fi
done

exit 0
