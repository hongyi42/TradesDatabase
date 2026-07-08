#!/usr/bin/env bash
# apply-binding.sh — reconcile ONE sandbox's Telegram sender allowlist to a new
# user id, with NO rebuild and NO device-key strip. Called by badge-pull.sh once
# per new/changed binding (overridden by a stub in the repo's test harness).
#
#   Usage: apply-binding.sh <sandboxRef> <telegramUserId>
#   Exit 0 ONLY if `channels status` confirms the new id (rendered == expected).
#
# Runs AS the nemoclaw state owner (the user who owns ~/.nemoclaw + the CLI);
# badge-pull.sh runs as root and drops to that user before calling this.
#
# Mechanism — proven on scratch sandbox s2 (2026-07-07); full write-up in
# thoughts/shared/research/2026-07-03-cold-sandbox-identity-injection.md and
# doorman-architecture-memory.md. The allowlist lives in TWO places; BOTH are
# written:
#   (a) SOURCE OF TRUTH (durable across rebuilds): ~/.nemoclaw/sandboxes.json →
#       sandboxes.<ref>.messaging.plan.channels[telegram].inputs[allowedIds].value
#   (b) RENDERED (what the running gateway enforces, immediate effect): the
#       sandbox's /sandbox/.openclaw/openclaw.json channels.telegram.allowFrom,
#       with /sandbox/.openclaw/.config-hash recomputed and both files chmod 660,
#       then `nemoclaw <ref> gateway restart` (NOT a rebuild).
# Unlike a badge/provider-credential write this bumps no provider version and
# does not rebuild — so no placeholder-versioning trap and no device-key strip.
set -euo pipefail

sref="${1:?usage: apply-binding.sh <sandboxRef> <telegramUserId>}"
tgid="${2:?usage: apply-binding.sh <sandboxRef> <telegramUserId>}"

# Make the nemoclaw CLI reachable (it lives in the owner's ~/.local/bin, which a
# non-login drop-to-user shell may omit). SANDBOXES_JSON is overridable for tests.
export PATH="$HOME/.local/bin:$PATH"
SANDBOXES_JSON="${SANDBOXES_JSON:-$HOME/.nemoclaw/sandboxes.json}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# (a) SOURCE OF TRUTH — set allowedIds for this sandbox's telegram channel.
jq --arg s "$sref" --arg t "$tgid" '
  (.sandboxes[$s].messaging.plan.channels[]?
     | select(.channelId=="telegram").inputs[]?
     | select(.inputId=="allowedIds").value) = $t
' "$SANDBOXES_JSON" > "$tmp/sandboxes.json"
# Fail closed: confirm the edit actually landed (guards a wrong jq path or an
# unknown sandbox — never install an unchanged source and call it done).
got_src=$(jq -r --arg s "$sref" '
  .sandboxes[$s].messaging.plan.channels[]?
    | select(.channelId=="telegram").inputs[]?
    | select(.inputId=="allowedIds").value' "$tmp/sandboxes.json" | head -1)
if [ "$got_src" != "$tgid" ]; then
  echo "apply-binding: source allowedIds patch did not take for '$sref' (got '$got_src')" >&2
  exit 10
fi
install -m 600 "$tmp/sandboxes.json" "$SANDBOXES_JSON"

# (b) RENDERED — edit openclaw.json allowFrom, recompute .config-hash, chmod 660
# (an upload lands 640/644 and the gateway then refuses to restart with
# GATEWAY_UNSAFE_CONFIG_PATH — Part B gotcha), then restart the gateway so the
# running process loads it. `</dev/null` on every exec: nemoclaw exec reads stdin.
nemoclaw "$sref" download /sandbox/.openclaw/openclaw.json "$tmp/oc.json" </dev/null
# The live allowlist is per-account: channels.telegram.accounts.<name>.allowFrom
# (verified on s2 — NOT a top-level channels.telegram.allowFrom, which the gateway
# ignores). Set it on every telegram account so a non-"default" account name still
# takes.
jq --arg t "$tgid" '(.channels.telegram.accounts[]?.allowFrom) = [$t]' "$tmp/oc.json" > "$tmp/oc.new"
# Fail closed at EDIT time (clearer than only catching it at the verify below): a
# wrong path would leave the id unset and the gateway serving the old allowlist.
got_render=$(jq -r '[.channels.telegram.accounts[]?.allowFrom[]?] | index($t) // empty' \
  --arg t "$tgid" "$tmp/oc.new")
if [ -z "$got_render" ]; then
  echo "apply-binding: rendered allowFrom path did not match for '$sref' (no telegram account?)" >&2
  exit 11
fi
h=$(sha256sum "$tmp/oc.new" | awk '{print $1}')
nemoclaw "$sref" upload "$tmp/oc.new" /sandbox/.openclaw/openclaw.json </dev/null
nemoclaw "$sref" exec --no-tty -- sh -c "printf '%s  openclaw.json\n' '$h' > /sandbox/.openclaw/.config-hash" </dev/null
nemoclaw "$sref" exec --no-tty -- chmod 660 /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash </dev/null
nemoclaw "$sref" gateway restart </dev/null

# (c) VERIFY via the no-messaging drift probe: the rendered allowlist must now be
# the new id (severity returns to ok when rendered == the source we just wrote).
got=$(nemoclaw "$sref" channels status --json </dev/null \
      | jq -r '.channels[]?.signals[]? | select(.label | test("ALLOWED_IDS")) | .detail' | head -1)
if [ "$got" != "$tgid" ]; then
  echo "apply-binding: channels status shows '$got', expected '$tgid' for '$sref'" >&2
  exit 12
fi
echo "apply-binding: $sref -> $tgid applied and verified"
