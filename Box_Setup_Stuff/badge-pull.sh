#!/usr/bin/env bash
# badge-pull.sh — keep /etc/doorman/badges.json in sync with the trades-spine
# roster. Runs as ROOT on a systemd timer (every 5 min). Self-contained: pairs
# with doorman-architecture-memory.md ("Badges are roster-driven" section).
#
# What it does, in order:
#   1. GET $PULL_URL with this host's pull token (a bearer secret held ONLY in
#      the root-only env file below; the server stores just its fingerprint).
#   2. GUARD (added 2026-07-03 after the roster-truncation incident): if the
#      server returns ZERO badges while the current file is non-empty, REFUSE
#      and exit 1 (systemd unit shows failed) — the last good badges.json stays.
#      A deliberate full-roster wipe needs ALLOW_EMPTY_BADGES=1 in the env file
#      below (remove it again afterwards).
#   3. Otherwise, if the returned badgesFile differs from what's on disk,
#      atomically replace /etc/doorman/badges.json — installed doorman:doorman
#      mode 600 (the doorman can't read it otherwise and silently 403s EVERY badge).
#   4. Any newBadges in the response are appended to a root-only pending file.
#      Each is the ONE AND ONLY copy of that badge's plaintext: install it as
#      the sandbox's provider credential
#        openshell provider update <AGENT>-telegram-bridge \
#          --credential TRADES_SPINE_BADGE=<badge>
#      then delete the line. CAUTION: that provider write bumps the provider
#      version — safe while openclaw.json placeholders are canonical, but see
#      the "Placeholder VERSIONING trap" gotcha before doing it after a reboot.
#      THEN RESTART THE SANDBOX CONTAINER (2026-07-11): credentials REGISTER
#      into the openclaw process env at PROCESS LAUNCH ONLY (as version-scoped
#      placeholders, resolved in-process at component init) — the egress proxy
#      does NOT resolve per-request, so without a restart the running agent
#      keeps its old badge (or none) and the spine 403s it. Confirm with
#      `sudo ./bootstrap-box.sh verify` (credential-freshness check).
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

# Paths are env-overridable ONLY for the repo's automated test harness
# (src/control/badgePullScript.test.ts). On a real host, run with none set.
# The doorman chown below keys off a runtime fact (does a `doorman` user
# exist), NOT an env flag — a flag could leak into the sourced env file and
# silently disable the ownership that keeps the doorman able to read the file.
ENV_FILE="${ENV_FILE:-/etc/doorman/badge-pull.env}"
BADGES_FILE="${BADGES_FILE:-/etc/doorman/badges.json}"
PENDING_FILE="${PENDING_FILE:-/root/pending-badges.jsonl}"

# Feature A — Telegram sender bindings applied to this host's sandboxes.
#   BINDINGS_FILE:  applied-state map sandboxRef->telegramUserId (root-only).
#   BIND_APPLY_CMD: per-binding apply; defaults to the bundled apply-binding.sh,
#                   overridden with a stub by the repo test harness. Invoked as
#                   `<cmd> <sandboxRef> <telegramUserId>`; exit 0 = applied+verified.
#   NEMOCLAW_USER:  OS user owning ~/.nemoclaw + the nemoclaw CLI; root drops to it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINDINGS_FILE="${BINDINGS_FILE:-/etc/doorman/bindings-applied.json}"
BIND_APPLY_CMD="${BIND_APPLY_CMD:-}"
NEMOCLAW_USER="${NEMOCLAW_USER:-ubuntu}"

# shellcheck disable=SC1090
source "$ENV_FILE"
: "${PULL_URL:?PULL_URL missing from $ENV_FILE}"
: "${HOST_PULL_TOKEN:?HOST_PULL_TOKEN missing from $ENV_FILE}"

resp=$(curl -fsS --max-time 30 -H "Authorization: Bearer $HOST_PULL_TOKEN" "$PULL_URL")

# Fail closed on shape: an empty/HTML/error body must never replace the file.
file=$(jq -eS '.badgesFile' <<<"$resp")

current='{}'
cur_state=absent
if [ -f "$BADGES_FILE" ]; then
  # -e: a zero-byte/no-output file counts as corrupt too (plain -S would exit 0
  # with empty output and leave $current empty, breaking the count checks below).
  if current=$(jq -eS . "$BADGES_FILE" 2>/dev/null); then
    cur_state=ok
  else
    current='{}'
    cur_state=corrupt
  fi
fi

# Post-incident guard (2026-07-03): an EMPTY badgesFile over an existing file
# means every technician 403s within one poll. That has only ever meant
# upstream data loss (test-suite truncation), never a real roster — keep the
# last good file and fail the unit loudly instead. A corrupt existing file
# counts as "existing" too: silently confirming an empty roster on top of an
# unreadable file would green-light exactly the outage this guard watches for.
new_count=$(jq 'length' <<<"$file")
if [ "$new_count" -eq 0 ] && [ "$cur_state" != absent ] \
   && [ "${ALLOW_EMPTY_BADGES:-0}" != "1" ]; then
  cur_count=$(jq 'length' <<<"$current")
  if [ "$cur_state" = corrupt ] || [ "$cur_count" -gt 0 ]; then
    echo "badge-pull: REFUSING empty badgesFile over existing badges.json" \
         "(state=$cur_state, entries=$cur_count)." \
         "If this wipe is deliberate, set ALLOW_EMPTY_BADGES=1 in $ENV_FILE and re-run." >&2
    exit 1
  fi
fi

if [ "$file" != "$current" ]; then
  # Same-filesystem temp + mv -f = a truly atomic rename: the doorman re-reads
  # per request and swallows read errors into an empty table, so even a
  # millisecond half-written window would 403 in-flight requests. Ownership
  # and mode are set BEFORE the rename — doorman:doorman 600 is load-bearing
  # (observed live 2026-07-02: wrong owner silently 403s EVERY badge).
  tmp=$(mktemp "$(dirname "$BADGES_FILE")/.badges.json.XXXXXX")
  printf '%s\n' "$file" >"$tmp"
  # Runtime fact, not a flag: real hosts have the doorman user (and ownership
  # is load-bearing — wrong owner silently 403s EVERY badge); the test harness
  # machine doesn't, so the chown naturally skips there.
  if id doorman >/dev/null 2>&1; then
    chown doorman:doorman "$tmp"
  fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$BADGES_FILE"
  echo "badge-pull: badges.json updated ($new_count entries)"
else
  echo "badge-pull: no change"
fi

count=$(jq '.newBadges | length' <<<"$resp")
if [ "$count" -gt 0 ]; then
  ( umask 077; jq -c '.newBadges[]' <<<"$resp" >> "$PENDING_FILE" )
  echo "badge-pull: $count new badge(s) appended to $PENDING_FILE — install as provider credentials, then delete the lines"
fi

# ── Telegram sender bindings (Feature A) ────────────────────────────────────
# Reconcile desired {sandboxRef, telegramUserId} into each sandbox's allowlist.
# Additive only (unbind is out of scope); old servers omit the key → jq gives [].
# Unlike the badge-provider write above, apply-binding.sh does NOT bump a
# provider version or rebuild, so it is safe to run AUTOMATICALLY here: it edits
# config + restarts the gateway (no placeholder trap, no device-key strip).
# Each apply is idempotent + self-verifying; a failure is ISOLATED (that sandbox
# retries next tick) and makes the unit exit nonzero so it is visible.

# Drop to the state owner (root) or call directly (already the owner), unless the
# test harness supplied a stub. Returns the apply command's exit code.
run_apply() {
  local sref="$1" tgid="$2"
  if [ -n "$BIND_APPLY_CMD" ]; then
    "$BIND_APPLY_CMD" "$sref" "$tgid"
    return $?
  fi
  local apply="$SCRIPT_DIR/apply-binding.sh"
  if [ "$(id -un)" = "$NEMOCLAW_USER" ]; then
    NEMOCLAW_USER="$NEMOCLAW_USER" "$apply" "$sref" "$tgid"
  else
    sudo -u "$NEMOCLAW_USER" -H NEMOCLAW_USER="$NEMOCLAW_USER" "$apply" "$sref" "$tgid"
  fi
}

bindings=$(jq -c '.bindings // []' <<<"$resp")
bind_total=$(jq 'length' <<<"$bindings")
if [ "$bind_total" -gt 0 ]; then
  applied='{}'
  if [ -f "$BINDINGS_FILE" ]; then
    applied=$(jq -eS . "$BINDINGS_FILE" 2>/dev/null || echo '{}')
  fi
  bind_fail=0
  bind_applied=0
  while IFS=$'\t' read -r sref tgid; do
    [ -n "$sref" ] || continue
    prev=$(jq -r --arg s "$sref" '.[$s] // empty' <<<"$applied")
    if [ "$prev" = "$tgid" ]; then
      continue  # already applied — no-op (diff against last-applied state)
    fi
    if run_apply "$sref" "$tgid"; then
      applied=$(jq --arg s "$sref" --arg t "$tgid" '.[$s]=$t' <<<"$applied")
      # Persist after EACH success (per-row isolation like the badge loop): a
      # later failure never rolls back an earlier applied binding.
      ( umask 077
        tmp=$(mktemp "$(dirname "$BINDINGS_FILE")/.bindings.XXXXXX")
        printf '%s\n' "$applied" >"$tmp"
        mv -f "$tmp" "$BINDINGS_FILE" )
      bind_applied=$((bind_applied + 1))
      echo "badge-pull: bound $sref -> $tgid"
    else
      echo "badge-pull: FAILED to bind $sref -> $tgid — will retry next tick" >&2
      bind_fail=1
    fi
  done < <(jq -r '.[] | [.sandboxRef, .telegramUserId] | @tsv' <<<"$bindings")
  if [ "$bind_applied" -gt 0 ]; then
    echo "badge-pull: $bind_applied binding(s) applied"
  fi
  if [ "$bind_fail" -ne 0 ]; then
    exit 1
  fi
fi
