#!/usr/bin/env bash
# nemoclaw-inference-medic.sh — assert the gateway inference route is the
# production DeepInfra/GLM-5.2 route, re-setting it if it has drifted.
#
# WHY: `nemoclaw onboard` and rebuilds reset the gateway to the wizard's NVIDIA
# default (nvidia-prod / nvidia/nemotron-3-super) — the deprecated, "too weak"
# model on NVIDIA's FREE tier, whose per-worker request cap (32) rate-limits any
# busy agent: "ResourceExhausted: Worker local total request limit reached
# (N/32)". DeepInfra (200 concurrent per model) is the production route. On
# 2026-07-08 a re-onboard of Judy's s3 left it on the NVIDIA default and she hit
# that limit mid-task. This medic self-heals the drift on boot AND on a 15-min
# timer, so no one has to remember the post-onboard "flip to DeepInfra" step.
#
# Runs as the gateway owner (ubuntu). Installed at /usr/local/sbin/ and driven by
# nemoclaw-inference-medic.{service,timer}. See doorman-nemoclaw-setup-guide.md
# (inference / DeepInfra section) and doorman-architecture-memory.md.
set -euo pipefail
export PATH="/home/ubuntu/.local/bin:$PATH"

WANT_PROVIDER="deepinfra-prod"
WANT_MODEL="zai-org/GLM-5.2"   # NOTE: DeepInfra id spelling; NVIDIA's was z-ai/glm-5.2

route_ok() {
  local cur="$1"
  grep -aqF "$WANT_PROVIDER" <<<"$cur" && grep -aqF "$WANT_MODEL" <<<"$cur"
}

cur="$(openshell inference get 2>/dev/null || true)"
if route_ok "$cur"; then
  echo "nemoclaw-inference-medic: route OK ($WANT_PROVIDER / $WANT_MODEL)"
  exit 0
fi

echo "nemoclaw-inference-medic: route DRIFTED — re-asserting $WANT_PROVIDER / $WANT_MODEL" >&2
openshell inference set -g nemoclaw --provider "$WANT_PROVIDER" --model "$WANT_MODEL"

# Re-verify; exit nonzero (unit shows failed) if the re-assert did not take.
cur="$(openshell inference get 2>/dev/null || true)"
if route_ok "$cur"; then
  echo "nemoclaw-inference-medic: re-asserted OK"
else
  echo "nemoclaw-inference-medic: FAILED to re-assert the route" >&2
  exit 1
fi
