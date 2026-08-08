#!/usr/bin/env bash
# nemoclaw-inference-medic.sh — keep the gateway inference route on the best
# provider that is ACTUALLY SERVING COMPLETIONS: DeepInfra/GLM-5.2 (production)
# with automatic failover to NVIDIA/GLM-5.2 and automatic failback.
#
# v3 (2026-08-06). v2's probe was `openshell inference set`, which validates the
# ENDPOINT REGISTRATION, not a completion. That blind spot bit twice:
#  - 2026-07-28 STALL: DeepInfra completions hung ~12 min; the medic ticked
#    twice DURING the stall logging "route OK on primary".
#  - 2026-08-06 BROKEN FAILOVER: a ~4-min DeepInfra blip tripped failover to
#    nvidia-prod, the medic logged "FAILOVER active" — and NVIDIA returned
#    `400 (no body)` on every real completion. The failover converted a blip
#    into a hard outage WHILE REPORTING SUCCESS.
#
# v3 adds the missing evidence: after the registration gate, a REAL 1-token
# completion through the managed route (https://inference.local/v1, curl'd from
# inside a running sandbox container — the exact path agent turns take, with the
# gateway injecting credentials, so no provider key ever leaves the store). No
# route is ever declared healthy, and no failover is ever declared successful,
# without a completion actually coming back.
#
# Decision table (registration gate then completion gate, per provider):
#   deepinfra reg ok + completion ok            -> primary, done
#   deepinfra fails either gate                 -> try nvidia
#   nvidia reg ok + completion ok               -> FAILOVER (completion-verified)
#   nvidia fails a gate too                     -> restore whichever REGISTERS,
#                                                  exit 1 LOUD (both dead)
#
# Known flap window, accepted: during a deepinfra stall (registration ok,
# completions dead) each 5-min tick briefly sets the route to deepinfra, burns
# one ~30s probe, and reverts to nvidia. Live turns in that window hit the
# stalled primary — v2 would have parked on it PERMANENTLY, so this is strictly
# better; a state-file cooldown was considered and rejected (v2 design decision:
# no state files, flaps visible in the journal are the feature).
#
# If NO sandbox container is running, the completion gate cannot run; the medic
# degrades to v2 semantics (registration only) with a loud WARN rather than
# failing the unit — a box mid-maintenance must not mark healthy providers dead.
#
# Runs as the gateway owner (ubuntu). Installed at /usr/local/sbin/, driven by
# nemoclaw-inference-medic.{service,timer}. See doorman-nemoclaw-setup-guide.md
# and docs/engineering-memory.md (medic v3 entry).
set -euo pipefail
export PATH="/home/ubuntu/.local/bin:$PATH"

WANT_PROVIDER="deepinfra-prod"
WANT_MODEL="zai-org/GLM-5.2"     # NOTE: DeepInfra id spelling
FALLBACK_PROVIDER="nvidia-prod"
FALLBACK_MODEL="z-ai/glm-5.2"    # NOTE: NVIDIA id spelling (dashed differently)
PROBE_TIMEOUT="${MEDIC_PROBE_TIMEOUT:-30}"  # seconds; a stall reads as a miss

log() { echo "nemoclaw-inference-medic: $*"; }
warn() { echo "nemoclaw-inference-medic: $*" >&2; }

# Registration gate — unchanged from v2: `inference set` live-verifies the
# endpoint+key before saving, and doubles as the switch.
set_route() { # provider model
  openshell inference set -g nemoclaw --provider "$1" --model "$2" >/dev/null 2>&1
}

probe_container() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep '^openshell-' | head -1
}

# Completion gate — the v3 addition. 1 max_token through the managed route from
# inside a sandbox container. The gateway FORCES the model id per request, so
# this exercises whatever route is CURRENTLY set; the -d model field is
# advisory. Success = HTTP 200 AND a parseable "choices" field — the 08-06
# NVIDIA failure was a 200-less `400 (no body)`, and a 402 balance-out has no
# choices either. Anything else (timeout, stall, 4xx/5xx) is a miss.
probe_completion() { # model-id-hint
  local cid body
  cid="$(probe_container)"
  if [ -z "$cid" ]; then
    return 2  # no container to probe from — caller degrades to v2 semantics
  fi
  body="$(docker exec "$cid" curl -sk -m "$PROBE_TIMEOUT" \
    -X POST https://inference.local/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$1\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}" \
    2>/dev/null)" || return 1
  grep -q '"choices"' <<<"$body"
}

# Try one provider through BOTH gates. Return 0 = healthy-and-routed,
# 1 = failed a gate, 2 = registered but completion gate UNAVAILABLE (no container).
try_provider() { # provider model label
  local provider="$1" model="$2" label="$3" prc
  if ! set_route "$provider" "$model"; then
    warn "$label $provider failed registration validation"
    return 1
  fi
  # Capture the probe status DIRECTLY — `$?` after a bare `if probe; then`
  # with no else is the if-statement's own status (0), not the probe's. The
  # `&& ||` form is also set -e-safe WITHOUT toggling the flag, which matters:
  # re-enabling -e in here would override main's `set +e` wrapper and turn this
  # function's own `return 1` into a script exit.
  probe_completion "$model" && prc=0 || prc=$?
  if [ "$prc" -eq 0 ]; then
    return 0
  fi
  if [ "$prc" -eq 2 ]; then
    warn "no running sandbox container — completion gate SKIPPED for $provider (v2 semantics; registration only)"
    return 2
  fi
  warn "$label $provider REGISTERED but failed the 1-token completion probe (stall or non-serving key/model)"
  return 1
}

main() {
  local rc
  set +e; try_provider "$WANT_PROVIDER" "$WANT_MODEL" "primary"; rc=$?; set -e
  if [ "$rc" -eq 0 ]; then
    log "route OK on primary ($WANT_PROVIDER / $WANT_MODEL) — completion verified"
    return 0
  elif [ "$rc" -eq 2 ]; then
    log "route asserted on primary ($WANT_PROVIDER) — REGISTRATION ONLY, no container for completion probe"
    return 0
  fi

  warn "primary $WANT_PROVIDER UNHEALTHY — trying failover to $FALLBACK_PROVIDER / $FALLBACK_MODEL"
  set +e; try_provider "$FALLBACK_PROVIDER" "$FALLBACK_MODEL" "fallback"; rc=$?; set -e
  if [ "$rc" -eq 0 ]; then
    warn "FAILOVER active ($FALLBACK_PROVIDER) — COMPLETION-VERIFIED; will fail back automatically when $WANT_PROVIDER recovers"
    return 0
  elif [ "$rc" -eq 2 ]; then
    warn "FAILOVER active ($FALLBACK_PROVIDER) — REGISTRATION ONLY (no container); verify completions when a sandbox is up"
    return 0
  fi

  # Both providers failed a gate. Leave the route on whichever still REGISTERS
  # (prefer primary — its outages have self-healed every time so far), so a
  # recovery is picked up by agents even before the next tick.
  if set_route "$WANT_PROVIDER" "$WANT_MODEL"; then
    warn "BOTH providers failed the completion gate — route restored to $WANT_PROVIDER (registration only). Agents are likely DOWN."
  elif set_route "$FALLBACK_PROVIDER" "$FALLBACK_MODEL"; then
    warn "BOTH providers failed the completion gate — route left on $FALLBACK_PROVIDER (registration only). Agents are likely DOWN."
  else
    warn "BOTH providers failed registration AND completion — agents are DOWN. Check DeepInfra balance (402) first, then the NVIDIA key."
  fi
  return 1
}

main "$@"
