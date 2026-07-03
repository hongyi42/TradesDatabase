#!/usr/bin/env bash
# badge-pull.sh — keep /etc/doorman/badges.json in sync with the trades-spine
# roster. Runs as ROOT on a systemd timer (every 5 min). Self-contained: pairs
# with doorman-architecture-memory.md ("Badges are roster-driven" section).
#
# What it does, in order:
#   1. GET $PULL_URL with this host's pull token (a bearer secret held ONLY in
#      the root-only env file below; the server stores just its fingerprint).
#   2. If the returned badgesFile differs from what's on disk, atomically
#      replace /etc/doorman/badges.json — installed doorman:doorman mode 600
#      (the doorman can't read it otherwise and silently 403s EVERY badge).
#   3. Any newBadges in the response are appended to a root-only pending file.
#      Each is the ONE AND ONLY copy of that badge's plaintext: install it as
#      the sandbox's provider credential
#        openshell provider update <AGENT>-telegram-bridge \
#          --credential TRADES_SPINE_BADGE=<badge>
#      then delete the line. CAUTION: that provider write bumps the provider
#      version — safe while openclaw.json placeholders are canonical, but see
#      the "Placeholder VERSIONING trap" gotcha before doing it after a reboot.
#
# Setup (once, as root):
#   install -o root -g root -m 700 badge-pull.sh /usr/local/sbin/badge-pull.sh
#   cat > /etc/doorman/badge-pull.env <<'EOF'   # then chmod 600
#   PULL_URL=https://<svc>.onrender.com/control/badges
#   HOST_PULL_TOKEN=<token printed once by assign-host.mjs create-host>
#   EOF
#   systemd: a oneshot service running this script + a timer (OnCalendar=*:0/5,
#   Persistent=true). Needs curl + jq.
#
# ⚠ BEFORE the first enabled run on a host with EXISTING badges: this script
#   replaces badges.json WHOLESALE with the server's roster view. Any badge the
#   server doesn't know (hand-minted, bootstrap) is erased and a competitor
#   minted — register each one first, server-side:
#     assign-host.mjs set-badge ref=<ref> hash=<sha256 of the badge>
#   The doorman must also be the fingerprint-lookup version (see the upgrade
#   note in doorman-architecture-memory.md's badge section).
#
# Cold-start note (observed live 2026-07-03): a cold free-tier Render spins up
# in ~32s, past the 30s curl cap below — the tick fails CLOSED, but that very
# request warms the service, so the next tick succeeds. For an immediate
# manual pull, pre-warm with any host curl to the service first.
set -euo pipefail

ENV_FILE=/etc/doorman/badge-pull.env
BADGES_FILE=/etc/doorman/badges.json
PENDING_FILE=/root/pending-badges.jsonl

# shellcheck disable=SC1090
source "$ENV_FILE"
: "${PULL_URL:?PULL_URL missing from $ENV_FILE}"
: "${HOST_PULL_TOKEN:?HOST_PULL_TOKEN missing from $ENV_FILE}"

resp=$(curl -fsS --max-time 30 -H "Authorization: Bearer $HOST_PULL_TOKEN" "$PULL_URL")

# Fail closed on shape: an empty/HTML/error body must never replace the file.
file=$(jq -eS '.badgesFile' <<<"$resp")

current='{}'
if [ -f "$BADGES_FILE" ]; then
  current=$(jq -S . "$BADGES_FILE" 2>/dev/null || echo '{}')
fi

if [ "$file" != "$current" ]; then
  # Same-filesystem temp + mv -f = a truly atomic rename: the doorman re-reads
  # per request and swallows read errors into an empty table, so even a
  # millisecond half-written window would 403 in-flight requests. Ownership
  # and mode are set BEFORE the rename — doorman:doorman 600 is load-bearing
  # (observed live 2026-07-02: wrong owner silently 403s EVERY badge).
  tmp=$(mktemp /etc/doorman/.badges.json.XXXXXX)
  printf '%s\n' "$file" >"$tmp"
  chown doorman:doorman "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$BADGES_FILE"
  echo "badge-pull: badges.json updated ($(jq 'length' <<<"$file") entries)"
else
  echo "badge-pull: no change"
fi

count=$(jq '.newBadges | length' <<<"$resp")
if [ "$count" -gt 0 ]; then
  ( umask 077; jq -c '.newBadges[]' <<<"$resp" >> "$PENDING_FILE" )
  echo "badge-pull: $count new badge(s) appended to $PENDING_FILE — install as provider credentials, then delete the lines"
fi
