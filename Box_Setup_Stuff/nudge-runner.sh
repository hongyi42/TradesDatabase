#!/usr/bin/env bash
# nudge-runner.sh — v2 (plan 2026-08-23 ④b, Phase 4): deliver queued team-lead
# nudges VERBATIM to each person's Telegram with `openclaw message send` —
# ZERO model calls on the delivery leg. Runs as ROOT on a systemd timer
# (every 5 min), pairs with the spine's GET/POST /control/nudges.
#
# v1 relayed each nudge through the seat agent (`nemoclaw <seat> agent
# --deliver`): a full model turn whose ONLY job was rewording a message the
# spine had already composed, judged by scraping the session trajectory.
# v2 sends the spine's footer-less twin (`directMessageB64`, served since
# 2026-08-23) straight to the chat: what the planner approved is byte-what-
# arrives, the seat's model runs only on the REPLY (which lands in the
# person's NORMAL session with the sent question visible in channel history),
# and the ~6-turn/84k-token delivery cost drops to one CLI call. The duties
# the old footer carried (record the answer; briefings are agent-only) now
# live in the seats' AGENTS.md ("Questions and items from the office" block,
# wired by bootstrap-box.sh).
#
# Posture (ops-report.sh discipline): ALWAYS exits 0 — delivery must never
# mark the box unhealthy; failures are reported per item to the spine, which
# owns retries (a nudge is served until acked, so a lost tick self-heals).
# Every network call carries a hard --max-time; every CLI call a hard timeout.
#
# Per item:
#   1. validate id/sandboxRef/replyTo (they become argv — never paths, never
#      flags; the badge-pull retirement-ref rule),
#   2. sent-marker pre-check: /var/lib/nudge-runner/sent-<id> present means a
#      previous tick delivered and only the ACK was lost — re-ack, never
#      re-ping (duplicate pings are the over-pinging failure mode),
#   3. decode directMessageB64 (absent → report failed: v2 NEVER falls back
#      to relaying the footered payload through the agent),
#   4. STAGE the body to a file inside the sandbox (openshell exec rejects
#      newlines in argv — the live-proven 2026-08-18 trap; the deliverable is
#      multi-line by construction) and send with `openclaw message send`
#      IN-CONTAINER (the binary lives in the sandbox, not on the box PATH —
#      probed 2026-08-23). The weekday guard's message_sending hook fires on
#      this path, so direct send keeps full guard coverage.
#   5. judge by the send's own exit — deterministic (probed: failure = exit 1
#      + OutboundDeliveryError; the gateway logs one `message.action` line),
#      no trajectory scraping,
#   6. write the marker, THEN report — a lost ack re-acks next tick via the
#      marker. One item's failure never aborts the loop.
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
# Sent markers: one empty file per delivered nudge id. Must exist BEFORE the
# loop or the idempotence pre-check silently never engages (plan review catch).
MARK_DIR="/var/lib/nudge-runner"
install -d -m 700 "$MARK_DIR"

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
  b64=$(printf '%s' "$item" | jq -r '.directMessageB64 // empty')

  # ids are uuids minted by the spine; refs become ARGV — accept only sane
  # names (badge-pull.sh retirement-ref rule).
  if ! printf '%s' "$id" | grep -Eq '^[A-Za-z0-9-]+$'; then continue; fi
  if ! printf '%s' "$sref" | grep -Eq '^[A-Za-z0-9_]+$'; then
    report "$id" failed "invalid sandboxRef"
    continue
  fi
  if ! printf '%s' "$reply_to" | grep -Eq '^[0-9]+$'; then
    report "$id" failed "invalid replyTo"
    continue
  fi

  # Idempotence pre-check: the marker means a PREVIOUS tick already sent this
  # id and only the ack was lost — re-ack it, never re-ping the person
  # (without this, a broken report path re-delivers every tick until the
  # serve cap). On the first serve no marker exists and this falls through.
  if [ -f "$MARK_DIR/sent-$id" ]; then
    report "$id" delivered ""
    continue
  fi

  msg=$(printf '%s' "$b64" | base64 -d 2>/dev/null) || {
    report "$id" failed "message decode failed"
    continue
  }
  # An item without the verbatim twin is not deliverable by v2 — never fall
  # back to relaying the footered messageB64 through the agent.
  [ -n "$msg" ] || { report "$id" failed "no direct payload"; continue; }

  # STAGE THE BODY INSIDE THE SANDBOX FIRST. openshell exec REJECTS any argv
  # containing a newline, and the deliverable is multi-line by construction
  # (question / evidence line) — live-proven 2026-08-18: every delivery
  # failed until the message moved out of argv. Single-line test messages
  # hide this bug — always exercise a real one. $id is validated above as
  # [A-Za-z0-9-]+, so it is safe to interpolate.
  msgfile="/tmp/nudge-$id.txt"
  if ! printf '%s' "$msg" | timeout 60 sudo -u "$NEMOCLAW_USER" -H \
      "$NEMOCLAW_BIN" "$sref" exec --no-tty -- bash -c "cat > $msgfile" \
      >/dev/null 2>&1; then
    report "$id" failed "could not stage message in sandbox"
    continue
  fi

  # Send verbatim. The openclaw binary lives IN the container (probed
  # 2026-08-23) — run it via exec; $(cat) rehydrates the multi-line body on
  # the far side of the argv wall. $reply_to is validated ^[0-9]+$ above.
  # </dev/null: exec eats stdin and would swallow the while-loop's remaining
  # items (recorded gotcha). Exit status IS the verdict: the probe showed
  # deterministic exit 1 + OutboundDeliveryError on failure.
  if timeout 120 sudo -u "$NEMOCLAW_USER" -H "$NEMOCLAW_BIN" "$sref" exec --no-tty -- \
      bash -c "openclaw message send --channel telegram --target $reply_to -m \"\$(cat $msgfile)\" --json" \
      </dev/null >/dev/null 2>&1; then
    # Marker BEFORE report: if the ack is lost, next tick re-acks instead of
    # re-pinging. The sha256 line is the byte-identity evidence trail — the
    # hash of exactly what was sent, comparable to the stored question's
    # pre-footer half, without putting message content in the journal.
    touch "$MARK_DIR/sent-$id"
    hash=$(printf '%s' "$msg" | sha256sum | cut -d' ' -f1)
    echo "nudge-runner: sent $id chars=${#msg} sha256=$hash" >&2
    report "$id" delivered ""
  else
    report "$id" failed "message send failed"
  fi
done

exit 0
