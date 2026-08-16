#!/usr/bin/env bash
# nudge-runner.sh — deliver queued team-lead nudges through each technician's
# OWN agent (plan 2026-08-15 feature B, Phase 4). Runs as ROOT on a systemd
# timer (every 5 min), pairs with the spine's GET/POST /control/nudges.
#
# Posture (ops-report.sh discipline): ALWAYS exits 0 — delivery must never
# mark the box unhealthy; failures are reported per item to the spine, which
# owns retries (a nudge is served until acked, so a lost tick self-heals).
# Every network call carries a hard --max-time; every CLI call a hard timeout.
#
# Per item:
#   1. validate sandboxRef/replyTo/sessionId (they become argv — never paths,
#      never flags; the badge-pull retirement-ref rule),
#   2. decode the message (base64 keeps the multi-line deliverable shell-safe),
#   3. `nemoclaw <sandbox> agent --deliver` into a FRESH per-nudge session
#      (id reuse resumes stale conversations — decision D6); --deliver runs on
#      the GATEWAY and fires the outbound plugin hooks (weekday guard
#      included), so the agent's reply reaches the technician's Telegram,
#   4. judge success by assistant text in the session TRAJECTORY — never CLI
#      stdout (stdout is chrome and has rotted before), never `docker exec`
#      (the gateway port lives in a nested netns; ssh→exec is the way),
#   5. POST the outcome. One item's failure never aborts the loop.
#
# Setup (once, as root — see doorman-nemoclaw-setup-guide.md):
#   install -o root -g root -m 700 nudge-runner.sh /usr/local/sbin/nudge-runner.sh
#   cp nudge-runner.service nudge-runner.timer /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now nudge-runner.timer
# Reuses /etc/doorman/badge-pull.env (PULL_URL + HOST_PULL_TOKEN); no new
# secret is minted. Escape hatch: `systemctl disable --now nudge-runner.timer`
# stops ALL delivery instantly.

set -u

ENV_FILE="${ENV_FILE:-/etc/doorman/badge-pull.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
: "${HOST_PULL_TOKEN:?HOST_PULL_TOKEN missing from $ENV_FILE}"
: "${PULL_URL:?PULL_URL missing from $ENV_FILE}"
# Derived from the badge pull's URL unless overridden — one env file, one host.
NUDGE_URL="${NUDGE_URL:-${PULL_URL%/control/badges}/control/nudges}"
NEMOCLAW_USER="${NEMOCLAW_USER:-ubuntu}"
home=$(getent passwd "$NEMOCLAW_USER" | cut -d: -f6)
NEMOCLAW_BIN="${NEMOCLAW_BIN:-$home/.local/bin/nemoclaw}"
TRAJ_DIR="/sandbox/.openclaw/agents/main/sessions"

if [ ! -x "$NEMOCLAW_BIN" ]; then
  echo "nudge-runner: nemoclaw not found at $NEMOCLAW_BIN — nothing delivered" >&2
  exit 0
fi

resp=$(curl -fsS --max-time 30 -H "Authorization: Bearer $HOST_PULL_TOKEN" "$NUDGE_URL") || {
  echo "nudge-runner: pull failed — retrying next tick" >&2
  exit 0
}

count=$(printf '%s' "$resp" | jq '.nudges | length' 2>/dev/null) || {
  echo "nudge-runner: pull response was not JSON" >&2
  exit 0
}
[ "$count" -gt 0 ] 2>/dev/null || exit 0

report() { # $1 id, $2 outcome, $3 fixed detail string (NEVER interpolated output)
  curl -fsS --max-time 15 -X POST \
    -H "Authorization: Bearer $HOST_PULL_TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"id\":\"$1\",\"outcome\":\"$2\",\"detail\":\"$3\"}" \
    "$NUDGE_URL" >/dev/null 2>&1 || true
}

printf '%s' "$resp" | jq -c '.nudges[]' | while IFS= read -r item; do
  id=$(printf '%s' "$item" | jq -r '.id // empty')
  sref=$(printf '%s' "$item" | jq -r '.sandboxRef // empty')
  reply_to=$(printf '%s' "$item" | jq -r '.replyTo // empty')
  sid=$(printf '%s' "$item" | jq -r '.sessionId // empty')
  b64=$(printf '%s' "$item" | jq -r '.messageB64 // empty')

  # ids are uuids minted by the spine; refs/session ids become ARGV — accept
  # only sane names (badge-pull.sh retirement-ref rule).
  if ! printf '%s' "$id" | grep -Eq '^[A-Za-z0-9-]+$'; then continue; fi
  if ! printf '%s' "$sref" | grep -Eq '^[A-Za-z0-9_]+$'; then
    report "$id" failed "invalid sandboxRef"
    continue
  fi
  if ! printf '%s' "$reply_to" | grep -Eq '^[0-9]+$'; then
    report "$id" failed "invalid replyTo"
    continue
  fi
  if ! printf '%s' "$sid" | grep -Eq '^[A-Za-z0-9-]+$'; then
    report "$id" failed "invalid sessionId"
    continue
  fi
  msg=$(printf '%s' "$b64" | base64 -d 2>/dev/null) || {
    report "$id" failed "message decode failed"
    continue
  }
  [ -n "$msg" ] || { report "$id" failed "empty message"; continue; }

  # Deliver through the person's own agent. </dev/null: exec/agent eat stdin
  # and would swallow the while-loop's remaining items (recorded gotcha).
  if ! timeout 240 sudo -u "$NEMOCLAW_USER" -H "$NEMOCLAW_BIN" "$sref" agent \
      --agent main --session-id "$sid" -m "$msg" \
      --deliver --reply-channel telegram --reply-to "$reply_to" \
      </dev/null >/dev/null 2>&1; then
    report "$id" failed "agent CLI exited non-zero or timed out"
    continue
  fi

  # The CLI exiting 0 is NOT the verdict (stdout/chrome has rotted before) —
  # the session trajectory is: a delivered turn leaves assistant output in the
  # per-nudge session file.
  traj=$(timeout 60 sudo -u "$NEMOCLAW_USER" -H "$NEMOCLAW_BIN" "$sref" exec --no-tty -- \
      cat "$TRAJ_DIR/$sid.jsonl" </dev/null 2>/dev/null) || {
    report "$id" failed "trajectory unreadable"
    continue
  }
  if printf '%s' "$traj" | grep -q '"assistant"'; then
    report "$id" delivered ""
  else
    report "$id" failed "no assistant turn in trajectory"
  fi
done

exit 0
