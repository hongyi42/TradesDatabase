#!/usr/bin/env bash
# seat-sync.sh — make every seat bot on this box a working door to the console,
# with no operator step and no token leaving the machine.
#
# THE PROBLEM IT SOLVES. A Mini App launch is stamped by Telegram with an
# Ed25519 signature the server verifies against the bot's NUMERIC id — the whole
# reason being that no assistant's token has to sit on Render. But the id comes
# from getMe, which needs the token, which lives here. And a bot's menu button
# can only be set with that same token. So both halves of "wire a seat" can only
# happen on the box, and until this script they happened by hand: an operator
# with a token in their shell, once per bot, forever. Five seats sat unwired
# because their tokens were only recoverable from BotFather (2026-09-12).
#
# WHAT IT DOES, per seat with a token file in /root/seats/:
#   1. getMe — proves the token is live, yields the handle and the numeric id.
#   2. setChatMenuButton, but ONLY when the desired button differs from what
#      this script last applied (recorded beside the token). The server states
#      the desired button in the badge pull, so renaming the label or moving the
#      console is a server-side change that reaches the fleet on the next tick.
#   3. POST /control/seat-bots — the ids, so the allowlist populates itself. The
#      server refuses a handle that disagrees with its row, refuses a retired
#      seat, and never creates a pool row (racking stays deliberate).
#
# Nothing secret is sent anywhere: the id and handle are public, and the token
# is used only against api.telegram.org.
#
# Setup (once, as root) — same env file the badge pull already uses:
#   install -o root -g root -m 700 seat-sync.sh /usr/local/sbin/seat-sync.sh
#   /etc/doorman/badge-pull.env must define PULL_URL and HOST_PULL_TOKEN.
#   systemd: a oneshot service + timer, or call it at the end of badge-pull.
# Needs curl + jq.
set -euo pipefail

ENV_FILE="${SEAT_SYNC_ENV:-/etc/doorman/badge-pull.env}"
SEATS_DIR="${SEAT_SYNC_SEATS_DIR:-/root/seats}"
# shellcheck source=/dev/null
[ -r "$ENV_FILE" ] || { echo "seat-sync: cannot read $ENV_FILE" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
: "${PULL_URL:?PULL_URL not set in $ENV_FILE}"
: "${HOST_PULL_TOKEN:?HOST_PULL_TOKEN not set in $ENV_FILE}"
# /control/badges → /control/seat-bots, so one env file configures both.
REPORT_URL="${SEAT_SYNC_REPORT_URL:-${PULL_URL%/badges}/seat-bots}"

[ -d "$SEATS_DIR" ] || { echo "seat-sync: no $SEATS_DIR yet — nothing provisioned by a version that keeps tokens"; exit 0; }

# What the server wants the button to say. Absent (old server, or
# BOARD_PUBLIC_URL unset) means "no opinion" — leave every button alone rather
# than pointing the fleet at a guess.
pull=$(curl -s --max-time 30 -H "authorization: Bearer ${HOST_PULL_TOKEN}" "$PULL_URL" || true)
want_text=$(printf '%s' "$pull" | jq -r '.menuButton.text // empty' 2>/dev/null || true)
want_url=$(printf '%s' "$pull" | jq -r '.menuButton.url // empty' 2>/dev/null || true)

report='[]'
applied=0; skipped=0

for seatfile in "$SEATS_DIR"/*.env; do
  [ -e "$seatfile" ] || break
  ref=$(basename "$seatfile" .env)
  # Subshell: each seat's token must not leak into the next iteration, and a
  # malformed file must not abort the rack.
  line=$(
    set +e
    # shellcheck source=/dev/null
    ( set -a; source "$seatfile"; set +a
      [ -n "${TELEGRAM_BOT_TOKEN:-}" ] || { echo "ERR no-token"; exit 0; }
      me=$(curl -s --max-time 15 --config - <<CURLEOF
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"
CURLEOF
      )
      printf '%s' "$me" | grep -q '"ok":true' || { echo "ERR getme-rejected"; exit 0; }
      handle=$(printf '%s' "$me" | grep -oE '"username":"[^"]*"' | head -1 | cut -d'"' -f4)
      botid=$(printf '%s' "$me" | grep -oE '"id":[0-9]+' | head -1 | cut -d: -f2)
      [ -n "$handle" ] && [ -n "$botid" ] || { echo "ERR unparsable-getme"; exit 0; }

      # The button, only when it would change. Telegram has no "read what I set
      # last" that distinguishes a default from an explicit button, so the
      # applied state is recorded here instead of re-POSTing every five minutes.
      if [ -n "$want_text" ] && [ -n "$want_url" ]; then
        stamp="${want_text}|${want_url}"
        if [ "$(cat "${seatfile%.env}.menu" 2>/dev/null || true)" != "$stamp" ]; then
          body=$(jq -nc --arg t "$want_text" --arg u "$want_url" \
            '{menu_button:{type:"web_app",text:$t,web_app:{url:$u}}}')
          res=$(curl -s --max-time 15 -H 'content-type: application/json' --data "$body" --config - <<CURLEOF
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setChatMenuButton"
CURLEOF
          )
          if printf '%s' "$res" | grep -q '"ok":true'; then
            ( umask 077; printf '%s' "$stamp" > "${seatfile%.env}.menu" )
            echo "OK $handle $botid applied"
            exit 0
          fi
          echo "ERR setmenu-failed"
          exit 0
        fi
      fi
      echo "OK $handle $botid unchanged"
    )
  )
  status=${line%% *}
  if [ "$status" = "ERR" ]; then
    echo "seat-sync: ${ref}: ${line#ERR }" >&2
    skipped=$(( skipped + 1 ))
    continue
  fi
  handle=$(printf '%s' "$line" | awk '{print $2}')
  botid=$(printf '%s' "$line" | awk '{print $3}')
  [ "$(printf '%s' "$line" | awk '{print $4}')" = "applied" ] && applied=$(( applied + 1 ))
  report=$(printf '%s' "$report" | jq -c --arg r "$ref" --arg h "@$handle" --arg i "$botid" \
    '. + [{sandboxRef:$r, botId:$i, botUsername:$h}]')
done

count=$(printf '%s' "$report" | jq 'length')
if [ "$count" -eq 0 ]; then
  echo "seat-sync: no reportable seats (${skipped} skipped)"
  exit 0
fi

# The report is idempotent by design: the server writes only what differs, so a
# lost tick self-heals on the next one and nothing here needs retry state.
# -w writes the status on its own last line, so the body and the code come back
# in one round trip without a temp file.
resp=$(curl -s --max-time 30 -X POST -w '\n%{http_code}' \
  -H "authorization: Bearer ${HOST_PULL_TOKEN}" -H 'content-type: application/json' \
  --data "$(printf '%s' "$report" | jq -c '{seats: .}')" "$REPORT_URL" || true)
http_code=$(printf '%s' "$resp" | tail -1)
resp=$(printf '%s' "$resp" | sed '$d')

# An empty body reads the same as "nothing recorded" unless the status is
# checked, so check it. A server that predates /control/seat-bots does NOT 404:
# the request falls through to the MCP handler, which refuses it for having no
# gateway identity — so the symptom is a 401 on the report while the pull above
# returned 200 with the same token (observed on the box, 2026-09-15).
if [ "$http_code" != "200" ]; then
  echo "seat-sync: ${count} seats, ${applied} buttons applied, ${skipped} skipped — report REFUSED (HTTP ${http_code:-none})" >&2
  if [ "$http_code" = "401" ] || [ "$http_code" = "404" ]; then
    echo "seat-sync: the pull token works for /control/badges, so a refusal here means the server has no /control/seat-bots route yet — deploy it." >&2
  fi
  exit 1
fi

recorded=$(printf '%s' "$resp" | jq -r '(.recorded // []) | length' 2>/dev/null || echo '?')
echo "seat-sync: ${count} seats, ${applied} buttons applied, ${skipped} skipped, ${recorded} ids recorded"
# Refusals are the operator's business — a seat the server does not know about,
# or a handle that disagrees with its row, means the rack and the box disagree.
printf '%s' "$resp" | jq -r '(.skipped // [])[] | "seat-sync: server refused \(.sandboxRef): \(.why)"' 2>/dev/null || true
