#!/usr/bin/env bash
# nemoclaw-inference-medic.sh — keep the gateway inference route on the best
# HEALTHY provider: DeepInfra/GLM-5.2 (production) with automatic failover to
# NVIDIA/GLM-5.2 (free-tier rollback) and automatic failback.
#
# WHY (two failure classes, both hit live):
#  1. DRIFT — `nemoclaw onboard` and rebuilds reset the gateway to the wizard's
#     NVIDIA default (nvidia-prod / nvidia/nemotron-3-super), the deprecated
#     "too weak" model whose free-tier per-worker cap (32) rate-limits any busy
#     agent ("ResourceExhausted: Worker local total request limit reached").
#     Bit Judy's s3 on 2026-07-08 after a re-onboard.
#  2. PROVIDER OUTAGE — DeepInfra itself can stop serving (2026-07-11: balance
#     ran out at ~17:45Z [HTTP 402], then a transient outage at ~18:45Z where
#     completions hung >120s and every agent turn on every sandbox timed out).
#     The v1 medic only asserted DeepInfra, so an outage left agents dead until
#     a human flipped the route by hand. This v2 fails over automatically.
#
# HOW: `openshell inference set` live-verifies the endpoint+key BEFORE saving,
# so it is both the health probe and the switch in one call:
#   - try DeepInfra: success → route asserted/failed back; done.
#   - DeepInfra fails → try NVIDIA: success → FAILOVER (loud). Next healthy
#     DeepInfra run fails back automatically — no human step, no state file.
#   - both fail → exit 1 (unit shows failed; check provider status/balance —
#     a DeepInfra 402 means TOP UP THE BALANCE, see nemoclaw-agent-model memory).
# Worst-case dead-agent window = one timer interval (5 min) + validation time.
# Flap worst case = one flip per interval — visible in the journal, tolerable.
#
# Runs as the gateway owner (ubuntu). Installed at /usr/local/sbin/ and driven by
# nemoclaw-inference-medic.{service,timer}. See doorman-nemoclaw-setup-guide.md
# (inference / DeepInfra section) and doorman-architecture-memory.md.
set -euo pipefail
export PATH="/home/ubuntu/.local/bin:$PATH"

WANT_PROVIDER="deepinfra-prod"
WANT_MODEL="zai-org/GLM-5.2"     # NOTE: DeepInfra id spelling
FALLBACK_PROVIDER="nvidia-prod"
FALLBACK_MODEL="z-ai/glm-5.2"    # NOTE: NVIDIA id spelling (dashed differently)

route_is() {
  local provider="$1" model="$2" cur="$3"
  grep -aqF "$provider" <<<"$cur" && grep -aqF "$model" <<<"$cur"
}

# Primary: validation doubles as the health probe; saves only on success.
if openshell inference set -g nemoclaw --provider "$WANT_PROVIDER" --model "$WANT_MODEL" >/dev/null 2>&1; then
  echo "nemoclaw-inference-medic: route OK on primary ($WANT_PROVIDER / $WANT_MODEL)"
  exit 0
fi

cur="$(openshell inference get 2>/dev/null || true)"
if route_is "$FALLBACK_PROVIDER" "$FALLBACK_MODEL" "$cur"; then
  echo "nemoclaw-inference-medic: primary $WANT_PROVIDER UNHEALTHY — already failed over to $FALLBACK_PROVIDER, holding" >&2
  exit 0
fi

echo "nemoclaw-inference-medic: primary $WANT_PROVIDER UNHEALTHY — failing over to $FALLBACK_PROVIDER / $FALLBACK_MODEL" >&2
if openshell inference set -g nemoclaw --provider "$FALLBACK_PROVIDER" --model "$FALLBACK_MODEL"; then
  echo "nemoclaw-inference-medic: FAILOVER active ($FALLBACK_PROVIDER); will fail back automatically when $WANT_PROVIDER recovers" >&2
  exit 0
fi

echo "nemoclaw-inference-medic: BOTH providers failed validation — agents are down. Check DeepInfra balance/status and the NVIDIA key." >&2
exit 1
