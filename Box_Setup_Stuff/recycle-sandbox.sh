#!/usr/bin/env bash
# recycle-sandbox.sh — turn a RETIRED sandbox back into a cold pool blank, with
# no operator: destroy it, re-provision a fresh identity-empty sandbox under
# the NEXT ref REUSING the retired sandbox's Telegram bot, and report the swap
# to the spine server (POST /control/sandboxes), which retires the old pool row
# and racks the new blank.
#
# Runs as ROOT, kicked by badge-pull.sh whenever the queue is non-empty; the
# systemd oneshot (sandbox-recycler.service) serializes runs — one recycle at a
# time, ~10 min each (the provision build dominates).
#
# JOURNAL-FIRST design: everything destruction erases (the bot token + handle,
# the chosen new ref) is journaled to a root-only file BEFORE any destructive
# step, so a crash at ANY point resumes cleanly on the next kick:
#   queue/<ref>            the work item (created by badge-pull)
#   journal/<ref>.json     {retiredRef,newRef,botUsername,botToken} — written
#                          pre-teardown, deleted only after the server's 200
#   failed/<ref>           parked items needing an operator (server 409, dead
#                          bot token) — ALARM: these never self-heal
#
# Server contract (POST ${PULL_URL%/badges}/sandboxes, host pull-token bearer):
#   200 rosterCleared!=false → done: delete journal + queue entry
#   200 rosterCleared==false → KEEP both, retry next kick (the POST retry is
#       the ONLY re-drive of a failed roster-residue clear — the pull stops
#       serving the ref once the row is stamped retired)
#   409 → park in failed/ (the server refused: our ref is wrong) + alarm
#   anything else → keep both, retry next kick
#
# Deploy: installed by `sudo ./bootstrap-box.sh recycler` together with the
# systemd unit and a /usr/local/sbin copy of bootstrap-box.sh (whose provision/
# wire/boot/backup-identity phases this script drives).
set -euo pipefail

# Env-overridable ONLY for tests / unusual layouts; real hosts run defaults.
QUEUE_DIR="${RECYCLER_QUEUE_DIR:-/var/lib/sandbox-recycler/queue}"
JOURNAL_DIR="${RECYCLER_JOURNAL_DIR:-/var/lib/sandbox-recycler/journal}"
FAILED_DIR="${RECYCLER_FAILED_DIR:-/var/lib/sandbox-recycler/failed}"
ENV_FILE="${ENV_FILE:-/etc/doorman/badge-pull.env}"           # PULL_URL + HOST_PULL_TOKEN
PROVISION_ENV="${RECYCLER_PROVISION_ENV:-/root/nemoclaw-provision.env}"  # NVIDIA_INFERENCE_API_KEY=…
BOOTSTRAP="${RECYCLER_BOOTSTRAP:-/usr/local/sbin/bootstrap-box.sh}"
NEMOCLAW_USER="${NEMOCLAW_USER:-ubuntu}"
# Cold blanks are provisioned DEAF: the allowlist placeholder is an id no real
# Telegram account has; bind_telegram's apply replaces it wholesale at claim.
PLACEHOLDER_TG_ID="${RECYCLER_PLACEHOLDER_TG_ID:-000000001}"

NEMOCLAW_HOME="$(getent passwd "$NEMOCLAW_USER" | cut -d: -f6)"
SANDBOXES_JSON="$NEMOCLAW_HOME/.nemoclaw/sandboxes.json"
NEMOCLAW_BIN="$NEMOCLAW_HOME/.local/bin/nemoclaw"

# shellcheck disable=SC1090
source "$ENV_FILE"
: "${PULL_URL:?PULL_URL missing from $ENV_FILE}"
: "${HOST_PULL_TOKEN:?HOST_PULL_TOKEN missing from $ENV_FILE}"
REPORT_URL="${PULL_URL%/badges}/sandboxes"

log()  { echo "recycler: $*"; }
warn() { echo "recycler: $*" >&2; }

as_owner() { sudo -u "$NEMOCLAW_USER" -H "$@" </dev/null; }
# Login shell for bootstrap phases that need the owner's PATH (~/.local/bin —
# wire calls bare `nemoclaw`) AND must not run as root (wire's need_not_root).
as_owner_login() { sudo -u "$NEMOCLAW_USER" -H bash -lc "$*" </dev/null; }

# Secrets tmpfiles must not outlive the run (systemd TERM on timeout is
# trappable; only SIGKILL escapes this).
CLEANUP_FILES=()
cleanup() { [ "${#CLEANUP_FILES[@]}" -gt 0 ] && rm -f "${CLEANUP_FILES[@]}" 2>/dev/null || true; }
trap cleanup EXIT
trap 'cleanup; exit 143' TERM INT

sandbox_exists() { jq -e --arg r "$1" '.sandboxes[$r] != null' "$SANDBOXES_JSON" >/dev/null 2>&1; }

# ANY container for the ref (running or stopped) — teardown must remove all.
container_id_for() {
  local ref="$1" c nm
  for c in $(docker ps -aq --filter "name=openshell-"); do
    nm=$(docker inspect -f '{{.Name}}' "$c" 2>/dev/null | sed 's#^/##')
    if [ "$(printf '%s' "$nm" | cut -d- -f2)" = "$ref" ]; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

# RUNNING container only — the liveness half of the resume report gate.
running_container_for() {
  local ref="$1" c nm
  for c in $(docker ps -q --filter "name=openshell-"); do
    nm=$(docker inspect -f '{{.Name}}' "$c" 2>/dev/null | sed 's#^/##')
    if [ "$(printf '%s' "$nm" | cut -d- -f2)" = "$ref" ]; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

# A blank may only be REPORTED if it is demonstrably alive: running container
# + Telegram poller in its recent logs (the provision phase asserts this at
# build time; this re-asserts it on RESUME, where a half-built new ref would
# otherwise skip provision — and its assertions — entirely).
assert_blank_live() {
  local ref="$1" cid
  cid=$(running_container_for "$ref") || {
    warn "$ref: no RUNNING container — cannot report this blank"
    return 1
  }
  docker logs --tail 200 "$cid" 2>&1 | grep -q getUpdates || {
    warn "$ref: container up but no getUpdates polling in recent logs — cannot report this blank"
    return 1
  }
}

# Park an entry for the operator: these NEVER self-heal (badge-pull will not
# re-queue a parked ref). Journal (if any) rides along for forensics.
park_entry() {
  local ref="$1" why="$2"
  warn "$ref: $why — parking for the operator"
  mkdir -p "$FAILED_DIR"
  mv -f "$QUEUE_DIR/$ref" "$FAILED_DIR/$ref" 2>/dev/null || true
  [ -f "$JOURNAL_DIR/$ref.json" ] && mv -f "$JOURNAL_DIR/$ref.json" "$FAILED_DIR/$ref.journal.json" 2>/dev/null
  return 1
}

# Ask the server whether the retirement still stands (a reactivation cancels
# it). 0 = still marked (proceed); 2 = cancelled (queue entry dropped);
# 1 = pull failed (retry next kick, decide nothing).
recheck_still_retiring() {
  local ref="$1" live
  live=$(curl -fsS --max-time 30 -H "Authorization: Bearer $HOST_PULL_TOKEN" "$PULL_URL") || {
    warn "$ref: pre-destroy re-check pull failed — retrying next kick"
    return 1
  }
  if ! jq -e --arg s "$ref" '.retirements // [] | any(.sandboxRef == $s)' <<<"$live" >/dev/null; then
    log "$ref: no longer marked for retirement (cancelled) — dropping queue entry"
    rm -f "$QUEUE_DIR/$ref"
    return 2
  fi
  return 0
}

# ── Teardown ──────────────────────────────────────────────────────────────────
# Preferred path: the vendor's own destroy verb (probed — SPIKE 2026-07-12 pins
# which verb this NemoClaw version ships). Fallback (verified recipe from the
# plan): rm the container, delete the sandboxes.json entry (backed up first),
# remove the per-agent revive unit. Either way the bot token was already
# journaled — teardown erases the only other copy. Every step is guarded:
# process_entry runs with set -e suspended (called under ||), so an unguarded
# failure here would LIMP FORWARD, and the worst case (empty jq output blindly
# mv'd over sandboxes.json) clobbers the registry for every sandbox on the box.
teardown_sandbox() {
  local ref="$1" cid
  # The registry must parse BEFORE we edit it — an already-corrupt file makes
  # every later existence check vacuous.
  jq -e '.sandboxes' "$SANDBOXES_JSON" >/dev/null 2>&1 || {
    warn "teardown refused: $SANDBOXES_JSON does not parse"
    return 1
  }
  if sandbox_exists "$ref"; then
    if as_owner "$NEMOCLAW_BIN" --help 2>/dev/null | grep -qw destroy; then
      # --no-cleanup-gateway is LOAD-BEARING (spike 2026-07-12, nemoclaw
      # v0.0.73): every sandbox on this box shares ONE gateway — a gateway
      # cleanup here would take down s1-s3 alongside the sandbox being
      # destroyed.
      log "teardown via vendor verb: nemoclaw $ref destroy"
      as_owner "$NEMOCLAW_BIN" "$ref" destroy --yes --no-cleanup-gateway || return 1
    else
      log "no vendor destroy verb — manual teardown recipe for $ref"
      cp -p "$SANDBOXES_JSON" "${SANDBOXES_JSON}.pre-recycle-${ref}.bak" || return 1
      local tmp
      tmp=$(mktemp "$(dirname "$SANDBOXES_JSON")/.sandboxes.XXXXXX") || return 1
      jq --arg r "$ref" 'del(.sandboxes[$r])' "$SANDBOXES_JSON" > "$tmp" || { rm -f "$tmp"; return 1; }
      # The edited file must still be a sane registry before it replaces the
      # real one — never install empty/truncated output.
      jq -e '.sandboxes | type == "object"' "$tmp" >/dev/null || { rm -f "$tmp"; return 1; }
      chown "$NEMOCLAW_USER":"$NEMOCLAW_USER" "$tmp" || { rm -f "$tmp"; return 1; }
      chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
      mv -f "$tmp" "$SANDBOXES_JSON" || { rm -f "$tmp"; return 1; }
    fi
  fi
  # Regardless of path: no container may survive (running OR stopped) — a
  # leftover poller on the reused bot token would fight the new blank's.
  if cid=$(container_id_for "$ref"); then
    docker rm -f "$cid" >/dev/null || return 1
  fi
  # The revive unit would restart a destroyed agent forever — remove it.
  if systemctl list-unit-files "nemoclaw-agent-${ref}.service" 2>/dev/null | grep -q "$ref"; then
    systemctl disable --now "nemoclaw-agent-${ref}.service" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/nemoclaw-agent-${ref}.service"
    systemctl daemon-reload
  fi
  # Completeness: entry gone AND container gone, else do not proceed to
  # provision (ref collision / two pollers on one bot token).
  if sandbox_exists "$ref"; then
    warn "teardown incomplete: $ref still present in sandboxes.json"
    return 1
  fi
  if container_id_for "$ref" >/dev/null; then
    warn "teardown incomplete: a container for $ref still exists"
    return 1
  fi
}

# ── Plan hydration (§4b) ─────────────────────────────────────────────────────
# Builds + hydrates the messaging plan with the vendor's own functions (a
# hand-written plan fails the strict validator). The token crosses via
# --preserve-env, never argv (sudo logs command lines to authpriv — the badge
# auto-install idiom). Prints the b64-encoded plan on stdout.
hydrate_plan() {
  local new_ref="$1"
  local dist="${RECYCLER_NEMOCLAW_DIST:-}"
  # Probe the vendor dist location (SPIKE pins the real path for this install).
  if [ -z "$dist" ]; then
    local d
    # source/dist first — the real location on trades-box-1 (spike 2026-07-12).
    for d in "$NEMOCLAW_HOME/.nemoclaw/source/dist" \
             "$NEMOCLAW_HOME/.nemoclaw/dist" \
             "$NEMOCLAW_HOME/.local/share/nemoclaw/dist" \
             "$NEMOCLAW_HOME/.local/lib/nemoclaw/dist"; do
      if [ -e "$d/lib/messaging/persistence.js" ]; then dist="$d"; break; fi
    done
  fi
  if [ -z "$dist" ] || [ ! -e "$dist/lib/messaging/persistence.js" ]; then
    warn "nemoclaw dist not found (tried ~/.nemoclaw/source/dist, ~/.nemoclaw/dist, ~/.local/share|lib/nemoclaw/dist) — set RECYCLER_NEMOCLAW_DIST"
    return 1
  fi
  PLAN_BOT_TOKEN="$BOT_TOKEN" PLAN_REF="$new_ref" PLAN_TG_ID="$PLACEHOLDER_TG_ID" PLAN_DIST="$dist" \
    sudo --preserve-env=PLAN_BOT_TOKEN,PLAN_REF,PLAN_TG_ID,PLAN_DIST -u "$NEMOCLAW_USER" -H \
    node -e '
    const dist = process.env.PLAN_DIST;
    const { hydrateDerivedSandboxMessagingPlanFields } = require(dist + "/lib/messaging/persistence.js");
    const { MessagingSetupApplier } = require(dist + "/lib/messaging/applier/setup-applier.js");
    const plan = {
      schemaVersion: 1, sandboxName: process.env.PLAN_REF, agent: "openclaw",
      workflow: "onboard", disabledChannels: [],
      // entries value observed uniform across every live sandbox (spike
      // 2026-07-12) — manifest-derived, same for any telegram sandbox.
      networkPolicy: { presets: ["telegram"], entries: [
        { channelId: "telegram", presetName: "telegram", policyKeys: ["telegram_bot"], source: "manifest" }
      ] },
      channels: [{ channelId: "telegram", active: true, configured: true, disabled: false, hooks: [],
        inputs: [
          { inputId: "allowedIds", value: process.env.PLAN_TG_ID },
          { inputId: "botToken",  value: process.env.PLAN_BOT_TOKEN },
          { inputId: "groupPolicy", value: "open" }
        ] }],
      credentialBindings: [], agentRender: [], buildSteps: [], stateUpdates: [], healthChecks: []
    };
    const hydrated = hydrateDerivedSandboxMessagingPlanFields(plan);
    process.stdout.write(MessagingSetupApplier.encodePlan(hydrated));
  ' </dev/null
}

# ── One queue entry ───────────────────────────────────────────────────────────
process_entry() {
  local ref="$1"
  local journal="$JOURNAL_DIR/$ref.json"
  local new_ref bot_user resumed=0

  if [ -f "$journal" ]; then
    log "resuming $ref from journal"
    resumed=1
    new_ref=$(jq -r '.newRef // empty' "$journal" 2>/dev/null) || new_ref=""
    bot_user=$(jq -r '.botUsername // empty' "$journal" 2>/dev/null) || bot_user=""
    BOT_TOKEN=$(jq -r '.botToken // empty' "$journal" 2>/dev/null) || BOT_TOKEN=""
    # A truncated/corrupt journal must never drive destruction — with empty
    # fields the teardown would erase the only remaining copy of the bot token.
    if [ -z "$new_ref" ] || [ -z "$bot_user" ] || [ -z "$BOT_TOKEN" ] \
       || [ "$new_ref" = null ] || [ "$bot_user" = null ] || [ "$BOT_TOKEN" = null ]; then
      park_entry "$ref" "journal is corrupt/incomplete (crash mid-write?)"
      return 1
    fi
  else
    # Fresh entry — last-second cancel check: a reactivation in the past
    # minutes withdraws the retirement; the authoritative list is the server's.
    local rc=0
    recheck_still_retiring "$ref" || rc=$?
    [ "$rc" -eq 2 ] && return 0   # cancelled — entry dropped, nothing to do
    [ "$rc" -ne 0 ] && return 1   # pull failed — retry next kick
    if ! sandbox_exists "$ref"; then
      park_entry "$ref" "not in sandboxes.json and no journal — cannot recover its bot"
      return 1
    fi

    # Everything destruction erases, captured BEFORE it: identity backup, bot
    # token (+ live getMe check), and the chosen new ref.
    as_owner_login "'$BOOTSTRAP' backup-identity '$ref'" \
      || warn "$ref: identity backup failed (continuing — recycle destroys identity anyway)"
    BOT_TOKEN=$(jq -r --arg r "$ref" '
      .sandboxes[$r].messaging.plan.channels[]? | select(.channelId == "telegram")
      | .inputs[]? | select(.inputId == "botToken") | .value // empty' "$SANDBOXES_JSON" 2>/dev/null) || BOT_TOKEN=""
    if [ -z "$BOT_TOKEN" ] || [ "$BOT_TOKEN" = "null" ]; then
      park_entry "$ref" "no bot token recoverable from sandboxes.json"
      return 1
    fi
    # Dead token (bot deleted at BotFather) is DEFINITIVE → park; an empty or
    # unparseable response is a network blip → retry next kick, never park.
    local me
    me=$(curl -s --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/getMe") || me=""
    if ! jq -e '.' <<<"$me" >/dev/null 2>&1; then
      warn "$ref: getMe unreachable/unparseable — retrying next kick"
      return 1
    fi
    if ! jq -e '.ok == true' <<<"$me" >/dev/null; then
      park_entry "$ref" "bot token is DEAD at Telegram (bot deleted at BotFather?)"
      return 1
    fi
    bot_user="@$(jq -r '.result.username' <<<"$me")"
    # Next free ref: s<max+1> across every s<digits> name ever seen locally.
    # Server-side unique(host, sandbox_ref) is the real guard at report time.
    local max
    max=$(jq -r '.sandboxes | keys[]' "$SANDBOXES_JSON" | grep -E '^s[0-9]+$' | sed 's/^s//' | sort -n | tail -1) || max=""
    new_ref="s$(( ${max:-0} + 1 ))"
    # Journal-first, atomically (tmp + mv): a failed or torn write must never
    # let execution reach teardown.
    local jtmp
    mkdir -p "$JOURNAL_DIR"
    jtmp=$(mktemp "$JOURNAL_DIR/.journal.XXXXXX") || { warn "$ref: cannot create journal"; return 1; }
    CLEANUP_FILES+=("$jtmp")
    chmod 600 "$jtmp"
    if ! jq -n --arg rr "$ref" --arg nr "$new_ref" --arg bu "$bot_user" --arg bt "$BOT_TOKEN" \
        '{retiredRef:$rr,newRef:$nr,botUsername:$bu,botToken:$bt}' > "$jtmp"; then
      rm -f "$jtmp"
      warn "$ref: journal write failed — retrying next kick (nothing destroyed)"
      return 1
    fi
    mv -f "$jtmp" "$journal" || { rm -f "$jtmp"; warn "$ref: journal rename failed"; return 1; }
    log "$ref: journaled (new ref $new_ref, bot $bot_user) — proceeding to teardown"
  fi

  # Destructive half — idempotent: skipped when already gone (resume). On a
  # resume where the sandbox still exists (crash between journal and
  # teardown), re-check the server first: the cancel window is a full tick
  # here, not seconds.
  if sandbox_exists "$ref"; then
    if [ "$resumed" -eq 1 ]; then
      local rrc=0
      recheck_still_retiring "$ref" || rrc=$?
      if [ "$rrc" -eq 2 ]; then
        rm -f "$journal"   # cancelled before destruction — sandbox survives
        return 0
      fi
      [ "$rrc" -ne 0 ] && return 1
    fi
    teardown_sandbox "$ref" || { warn "$ref: teardown failed — retrying next kick"; return 1; }
    log "$ref: destroyed"
  fi

  # Provision the fresh blank. On a resume where the new ref ALREADY exists
  # (crash after onboard wrote its entry), provision — and its hard
  # assertions — never ran to completion, so the blank must independently
  # prove liveness below before it can be reported.
  if ! sandbox_exists "$new_ref"; then
    # shellcheck disable=SC1090
    source "$PROVISION_ENV"
    : "${NVIDIA_INFERENCE_API_KEY:?NVIDIA_INFERENCE_API_KEY missing from $PROVISION_ENV}"
    local secrets plan
    secrets=$(mktemp /root/.recycle-secrets.XXXXXX) || return 1
    plan=$(mktemp /root/.recycle-plan.XXXXXX) || { rm -f "$secrets"; return 1; }
    CLEANUP_FILES+=("$secrets" "$plan")
    chmod 600 "$secrets" "$plan"
    printf 'TELEGRAM_BOT_TOKEN=%s\nNVIDIA_INFERENCE_API_KEY=%s\n' "$BOT_TOKEN" "$NVIDIA_INFERENCE_API_KEY" > "$secrets"
    if ! hydrate_plan "$new_ref" > "$plan"; then
      rm -f "$secrets" "$plan"
      warn "$ref: plan hydration failed — retrying next kick"
      return 1
    fi
    if ! "$BOOTSTRAP" provision "$new_ref" "$secrets" "$plan"; then
      rm -f "$secrets" "$plan"
      warn "$ref: provision of $new_ref FAILED (hard assertions) — operator attention"
      return 1
    fi
    rm -f "$secrets" "$plan"
    log "$new_ref: provisioned as the new cold blank (bot $bot_user)"
  fi
  # Wire + boot run UNCONDITIONALLY, outside the provision block: a resume tick
  # (new ref already exists) skips provision entirely, so leaving these inside
  # it would report an UNWIRED blank one tick after a wire failure — liveness
  # below can't see wiring. Both phases are idempotent (policy-add re-applies,
  # AGENTS.md blocks are grep-guarded, boot rewrites+enables), so re-running on
  # every retry is cheap and safe. An unwired blank is never reported: wire =
  # doorman egress + workspace blocks (needs the OWNER + their login PATH),
  # boot = revive unit (needs root).
  if ! as_owner_login "'$BOOTSTRAP' wire '$new_ref'"; then
    warn "$new_ref: wire phase FAILED — retrying next kick (blank not reported)"
    return 1
  fi
  if ! "$BOOTSTRAP" boot "$new_ref"; then
    warn "$new_ref: boot phase FAILED — retrying next kick (blank not reported)"
    return 1
  fi
  # Liveness gate before the report — catches the half-built resume case.
  if ! assert_blank_live "$new_ref"; then
    park_entry "$ref" "new blank $new_ref exists but is not demonstrably live (half-built resume?)"
    return 1
  fi

  # Report the swap; the server does the pool bookkeeping.
  local resp code body
  resp=$(curl -sS --max-time 30 -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer $HOST_PULL_TOKEN" -H 'content-type: application/json' \
    -d "$(jq -n --arg rr "$ref" --arg nr "$new_ref" --arg bu "$bot_user" \
          '{retiredSandboxRef:$rr,newSandboxRef:$nr,botUsername:$bu}')" \
    "$REPORT_URL") || { warn "$ref: report POST failed — retrying next kick"; return 1; }
  code=$(tail -1 <<<"$resp")
  body=$(sed '$d' <<<"$resp")
  case "$code" in
    200)
      if [ "$(jq -r '.rosterCleared' <<<"$body")" = "false" ]; then
        warn "$ref: server accepted but rosterCleared=false — keeping journal+queue for a retry (the POST retry is the only re-drive)"
        return 1
      fi
      rm -f "$journal" "$QUEUE_DIR/$ref"
      log "$ref → $new_ref recycle COMPLETE (server: $body)"
      ;;
    409)
      park_entry "$ref" "server REFUSED the report ($body)"
      return 1
      ;;
    *)
      warn "$ref: report got HTTP $code ($body) — retrying next kick"
      return 1
      ;;
  esac
}

# ── Main: drain the queue, one entry at a time, per-entry isolation ──────────
mkdir -p "$QUEUE_DIR" "$JOURNAL_DIR" "$FAILED_DIR"
chmod 700 "$QUEUE_DIR" "$JOURNAL_DIR" "$FAILED_DIR"
overall=0
for entry in "$QUEUE_DIR"/*; do
  [ -e "$entry" ] || continue
  ref=$(basename "$entry")
  if ! printf '%s' "$ref" | grep -Eq '^[A-Za-z0-9_]+$'; then
    warn "queue entry '$ref' is not a valid sandbox name — parking"
    mv "$entry" "$FAILED_DIR/" 2>/dev/null || true
    overall=1
    continue
  fi
  process_entry "$ref" || overall=1
done
if [ -n "$(ls -A "$FAILED_DIR" 2>/dev/null)" ]; then
  warn "ALARM: parked entries need an operator: $(ls -m "$FAILED_DIR")"
fi
exit "$overall"
