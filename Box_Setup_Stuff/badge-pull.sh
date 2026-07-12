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
#   4. Any newBadges in the response are AUTO-INSTALLED (2026-07-12, recycler
#      feature): for each entry with a sandboxRef, the badge goes straight into
#      the sandbox's provider (`openshell provider update <AGENT>-telegram-bridge
#      --credential TRADES_SPINE_BADGE=…`, run as $NEMOCLAW_USER via the
#      absolute ~/.local/bin path — sudo's secure_path won't find it bare) and
#      the container is RESTARTED (credentials REGISTER into the openclaw
#      process env at PROCESS LAUNCH ONLY, as version-scoped placeholders
#      resolved in-process at component init; the egress proxy does NOT resolve
#      per-request — without the restart the agent keeps its old badge and the
#      spine 403s it). On success this script persists NO plaintext: the badge
#      crosses to openshell via --preserve-env (sudo's authpriv log records
#      only the unexpanded variable name, never the value), leaving the vendor
#      CLI's transient argv as the sole exposure — the same class as the
#      manual procedure. FALLBACK: entries with no sandboxRef (legacy
#      assignments) or a failed install are parked in the root-only pending
#      file for the old manual procedure (install, delete the line, restart the
#      container, `sudo ./bootstrap-box.sh verify`). CAUTION: the provider
#      write bumps the provider version — safe while openclaw.json placeholders
#      are canonical ("Placeholder VERSIONING trap" gotcha, esp. after reboot).
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

# Badge auto-install (recycler feature) — BADGE_INSTALL_CMD overrides the
# built-in path for the repo test harness. Invoked as `<cmd> <sandboxRef>
# <badge>`; exit 0 = credential installed AND container restarted.
BADGE_INSTALL_CMD="${BADGE_INSTALL_CMD:-}"

# Sandbox retirements (recycler feature) — the pull's retirements[] are queued
# as one file per sandboxRef and the recycler service is kicked. Both paths are
# env-overridable for the repo test harness only.
#   RECYCLER_QUEUE_DIR:  queue consumed by recycle-sandbox.sh (root-only).
#   RECYCLER_FAILED_DIR: parked entries (operator-only) — NEVER re-queued here,
#                        or the recycler would re-park + re-alarm every tick.
#   RECYCLE_KICK_CMD:    recycler starter; default systemctl --no-block.
RECYCLER_QUEUE_DIR="${RECYCLER_QUEUE_DIR:-/var/lib/sandbox-recycler/queue}"
RECYCLER_FAILED_DIR="${RECYCLER_FAILED_DIR:-/var/lib/sandbox-recycler/failed}"
RECYCLE_KICK_CMD="${RECYCLE_KICK_CMD:-}"

# Install one minted badge into its sandbox's provider and restart the
# container (§5b — a provider write only takes effect at process launch).
# Returns: 0 installed+restarted; 1 nothing stored (full manual §5b needed);
# 2 credential STORED but the container was not restarted (only the restart
# remains — a second provider update would pointlessly bump the version).
install_badge() {
  local sref="$1" badge="$2"
  if [ -n "$BADGE_INSTALL_CMD" ]; then
    "$BADGE_INSTALL_CMD" "$sref" "$badge"
    return $?
  fi
  local home osh cid c nm
  home=$(getent passwd "$NEMOCLAW_USER" | cut -d: -f6)
  osh="$home/.local/bin/openshell"
  # Absolute path is load-bearing: sudo's secure_path does not include the
  # user's ~/.local/bin (bootstrap-box.sh uses the same idiom).
  if [ ! -x "$osh" ]; then
    echo "badge-pull: openshell not found at $osh" >&2
    return 1
  fi
  # The badge rides the ENV, never sudo's argv: sudo logs every command line
  # (arguments included) to authpriv, so a literal --credential value would
  # persist the plaintext in the system log on every install. Here sudo logs
  # the UNEXPANDED $BADGE_VALUE; the value crosses via --preserve-env (the
  # bootstrap provision idiom) and expands only inside the sandbox owner's
  # bash — the same transient-argv exposure class as the manual procedure.
  # ${BADGE_VALUE:?} — if a sudo policy ever strips the env var, fail LOUD
  # (parked for manual install) instead of installing an empty credential the
  # freshness probe cannot see (it compares key names, not values).
  BADGE_VALUE="$badge" sudo --preserve-env=BADGE_VALUE -u "$NEMOCLAW_USER" -H \
    bash -c '"$0" provider update "$1-telegram-bridge" --credential "TRADES_SPINE_BADGE=${BADGE_VALUE:?}"' \
    "$osh" "$sref" </dev/null || return 1
  # Container names are openshell-<agent>-…; match on the agent field exactly
  # (the same derivation bootstrap-box.sh's verify phase uses), never a loose
  # name filter — "s1" must not match "s10"'s container.
  cid=""
  for c in $(docker ps -q --filter "name=openshell-"); do
    nm=$(docker inspect -f '{{.Name}}' "$c" 2>/dev/null | sed 's#^/##')
    if [ "$(printf '%s' "$nm" | cut -d- -f2)" = "$sref" ]; then
      cid="$c"
      break
    fi
  done
  if [ -z "$cid" ]; then
    echo "badge-pull: no running container for ${sref} — credential stored but NOT live until a restart" >&2
    return 2
  fi
  docker restart "$cid" >/dev/null || return 2
}

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

# ── Badge auto-install ───────────────────────────────────────────────────────
# Happy path: provider update + container restart, plaintext never touches
# disk. Per-row isolation (one bad install must not lose the others): a failed
# or uninstallable entry is parked in the pending file for the manual §5b
# procedure, and the unit exits nonzero so the failure is visible.
badge_fail=0
count=$(jq '.newBadges | length' <<<"$resp")
if [ "$count" -gt 0 ]; then
  badge_installed=0
  badge_parked=0
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    sref=$(jq -r '.sandboxRef // empty' <<<"$entry")
    if [ -z "$sref" ]; then
      # Legacy assignment (no pool sandbox on record) — nothing to install
      # into automatically; the operator routes it by ref.
      ( umask 077; printf '%s\n' "$entry" >> "$PENDING_FILE" )
      badge_parked=$((badge_parked + 1))
      echo "badge-pull: badge for $(jq -r '.ref' <<<"$entry") has no sandboxRef — parked in $PENDING_FILE for manual install"
      continue
    fi
    rc=0
    install_badge "$sref" "$(jq -r '.badge' <<<"$entry")" || rc=$?
    if [ "$rc" -eq 0 ]; then
      badge_installed=$((badge_installed + 1))
      echo "badge-pull: badge installed for ${sref} (provider updated + container restarted)"
    else
      ( umask 077; printf '%s\n' "$entry" >> "$PENDING_FILE" )
      badge_parked=$((badge_parked + 1))
      badge_fail=1
      if [ "$rc" -eq 2 ]; then
        # Credential is ALREADY in the provider store — do NOT re-run the
        # provider update (needless version bump): restart the container,
        # verify, then delete the parked line.
        echo "badge-pull: badge for ${sref} STORED but container not restarted — parked in $PENDING_FILE; only the RESTART (+ verify) is needed, then delete the line" >&2
      else
        echo "badge-pull: FAILED to auto-install badge for ${sref} — parked in $PENDING_FILE (manual §5b: install, delete the line, RESTART the container)" >&2
      fi
    fi
  done < <(jq -c '.newBadges[]' <<<"$resp")
  echo "badge-pull: $badge_installed badge(s) auto-installed, $badge_parked parked"
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
fi

# ── Sandbox retirements (recycler) ───────────────────────────────────────────
# Queue each retirement as a file named by its sandboxRef; the recycler service
# does the destroy → re-provision → report. Queueing is idempotent (same
# filename), and the server keeps serving a retirement until the box's report
# lands — a lost tick self-heals.
recycle_fail=0
while IFS= read -r sref; do
  [ -n "$sref" ] || continue
  # The ref becomes a FILENAME — accept only sane sandbox names, never paths.
  if ! printf '%s' "$sref" | grep -Eq '^[A-Za-z0-9_]+$'; then
    echo "badge-pull: retirement ref '$sref' is not a valid sandbox name — SKIPPED" >&2
    recycle_fail=1
    continue
  fi
  # SAFETY: never queue a sandbox this same pull actively binds — that state is
  # a transient CAS window (reactivate landed, cancel not yet) or a server bug;
  # both self-heal or surface next tick. Destruction must fail toward NOT.
  if jq -e --arg s "$sref" '.bindings // [] | any(.sandboxRef == $s)' <<<"$resp" >/dev/null; then
    echo "badge-pull: retirement for ${sref} SKIPPED — this pull also ships an active binding for it" >&2
    continue
  fi
  # A PARKED ref needs an operator (dead bot, server 409) — re-queueing it
  # would just re-park + re-alarm every 5 minutes forever.
  if [ -e "$RECYCLER_FAILED_DIR/$sref" ]; then
    echo "badge-pull: retirement for ${sref} is PARKED (needs operator) — not re-queued" >&2
    continue
  fi
  if [ ! -e "$RECYCLER_QUEUE_DIR/$sref" ]; then
    ( umask 077; mkdir -p "$RECYCLER_QUEUE_DIR"; : > "$RECYCLER_QUEUE_DIR/$sref" )
    echo "badge-pull: queued ${sref} for recycling"
  fi
done < <(jq -r '.retirements // [] | .[].sandboxRef' <<<"$resp")

# Kick whenever the queue has entries — NOT only when something new was queued:
# a kept entry (rosterCleared:false retry, crash resume) no longer appears in
# retirements[] once the server stamped the row retired, and only this kick
# re-drives it. The recycler serializes itself (systemd oneshot).
if [ -d "$RECYCLER_QUEUE_DIR" ] && [ -n "$(ls -A "$RECYCLER_QUEUE_DIR" 2>/dev/null)" ]; then
  if [ -n "$RECYCLE_KICK_CMD" ]; then
    "$RECYCLE_KICK_CMD" || { echo "badge-pull: recycler kick failed" >&2; recycle_fail=1; }
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl start --no-block sandbox-recycler.service \
      || { echo "badge-pull: recycler kick failed" >&2; recycle_fail=1; }
  else
    echo "badge-pull: retirement queue non-empty but no systemctl/RECYCLE_KICK_CMD — recycler NOT kicked" >&2
    recycle_fail=1
  fi
fi

# One combined exit AFTER every section has run: a failed badge install must
# not skip the bindings reconcile (and vice versa). Recovery differs by kind:
# bindings + queued retirements retry automatically next tick; a failed badge
# install does NOT (its plaintext existed only in this pull — it is parked in
# the pending file and needs the manual §5b procedure). Exit 1 = unit red.
if [ "$badge_fail" -ne 0 ] || [ "${bind_fail:-0}" -ne 0 ] || [ "$recycle_fail" -ne 0 ]; then
  exit 1
fi
