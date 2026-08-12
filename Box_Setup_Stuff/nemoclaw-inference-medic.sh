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
# v3 adds the missing evidence: after the registration gate, a REAL completion
# through the managed route (https://inference.local/v1, curl'd from inside a
# running sandbox container — the exact path agent turns take, with the gateway
# injecting credentials, so no provider key ever leaves the store). No route is
# ever declared healthy, and no failover is ever declared successful, without a
# completion actually coming back.
#
# v4 (2026-08-12) fixes WHAT that completion asks for. v3 probed with
# `{"content":"hi"}, max_tokens:1` — no tools, no streaming, one token. That is
# not shaped like an agent turn, and nvidia-prod proved it: it served the probe
# happily while returning `400 (no body)` on every real turn, so v3 logged
# "FAILOVER active — COMPLETION-VERIFIED" over a hard outage. Six such events on
# 2026-08-12 alone. A gate a dead provider passes is not a gate.
#
# The v4 probe is shaped like production: real tool schemas attached (lifted from
# src/mcp/server.ts — a nested-object tool and a long enum-heavy one, so schema
# validation is actually exercised), a system prompt, STREAMING on, and enough
# max_tokens for the model to finish reasoning and emit. The gate is the thing
# every real turn depends on: the stream must close cleanly AND come back
# `finish_reason: "tool_calls"` with an actual tool call.
#
# Measured on healthy deepinfra/GLM-5.2 before shipping (n=12): 12/12 emitted a
# tool call, 1.9–9.9s against the 40s timeout, ~$0.0003/probe (≈$2.80/month at
# the 5-min cadence). Two calibration results worth keeping:
#   - `tool_choice:"required"` does NOT rescue a small budget. GLM-5.2 reasons by
#     default and spent all 32 tokens on reasoning_content, returning
#     `tool_calls: []` + `finish_reason: "length"`. Token headroom is what makes
#     tool emission observable, not tool_choice.
#   - Requiring the tool call is deliberate. A provider whose model will not emit
#     one for a prompt this tool-forcing cannot serve this product — every real
#     turn is tools. See "SWAPPING THE FALLBACK" below: this is the assumption to
#     re-validate when the provider changes.
#
# Decision table (registration gate then completion gate, per provider):
#   deepinfra reg ok + completion ok            -> primary, done
#   deepinfra fails either gate                 -> try nvidia
#   nvidia reg ok + completion ok               -> FAILOVER (completion-verified)
#   nvidia fails a gate too                     -> restore whichever REGISTERS,
#                                                  exit 1 LOUD (both dead)
#
# SWAPPING THE FALLBACK: nvidia-prod was a stopgap from testing, never a product
# decision, and is due to be replaced. The probe is provider-agnostic, but the
# tool-emission gate assumes the routed model emits a tool call for the probe
# prompt. Before pointing FALLBACK_PROVIDER at anything new, run the probe
# against it directly and confirm it comes back `finish_reason: "tool_calls"` —
# a model that answers the date in prose instead would be marked dead while
# healthy. That check IS the swap's acceptance test.
#
# Known flap window, accepted: during a deepinfra stall (registration ok,
# completions dead) each 5-min tick briefly sets the route to deepinfra, burns
# up to two ~40s probes, and reverts to nvidia. Live turns in that window hit the
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
# seconds; a stall reads as a miss. 40 not 30: the v4 probe waits for reasoning
# + tool emission (measured 1.9–9.9s over n=12 on healthy deepinfra), so this is
# ~4x the observed worst case. Worst-case tick = 2 providers x 2 attempts x 40s
# = 160s, inside the 5-min timer, and the unit is Type=oneshot (no systemd
# start timeout to trip).
PROBE_TIMEOUT="${MEDIC_PROBE_TIMEOUT:-40}"
RETRY_SLEEP="${MEDIC_RETRY_SLEEP:-2}"       # pause before the one retry; 0 in tests

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

# The probe request body. Quoted heredoc so the tool JSON needs no escaping —
# the v3 form inlined JSON inside a double-quoted `sh -lc` string, which is why
# it could only ever carry a trivial payload. `__MODEL__` is substituted by the
# caller; the gateway FORCES the routed model per request, so that field is
# advisory and only makes the journal readable.
#
# The three tools are real spine schemas (src/mcp/server.ts): a flat one, a
# nested-object one, and a long enum-heavy one. Three is enough to exercise
# schema validation and costs 864 prompt tokens (measured); the 39-tool surface would
# be ~10x that on every 5-min tick for no extra signal about whether the
# provider can parse our schemas. If a provider ever fails on payload SIZE
# rather than shape, that is the knob to turn.
probe_payload() {
  cat <<'JSON'
{"model":"__MODEL__",
 "messages":[
   {"role":"system","content":"You are the assistant for a trades firm. Use tools for anything factual about the schedule, customers, or jobs. Never do calendar arithmetic yourself."},
   {"role":"user","content":"What date is this coming Friday?"}],
 "max_tokens":512,
 "stream":true,
 "tools":[
  {"type":"function","function":{"name":"find_customer","description":"Search customers by name, phone, or address.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
  {"type":"function","function":{"name":"record_field_note","description":"Record a technician field note into the permanent company record - two-step. First call with text: NOTHING is recorded; you get back needs_identity or needs_confirmation with a preview. Only on their explicit yes call again with ONLY confirmId - the STAGED copy is what gets recorded, permanently.","parameters":{"type":"object","properties":{"text":{"type":"string","description":"The note text. First call only."},"blobPath":{"type":"string","description":"Optional object-store pointer."},"channel":{"type":"string","enum":["technician_note","phone_call","sms","email"],"description":"Defaults to technician_note."},"confirmId":{"type":"string","description":"Set on follow-up calls."},"confirmed":{"type":"object","description":"With confirmId: the answer to a needs_identity question.","properties":{"customerId":{"type":"string"},"address":{"type":"string"}}}},"required":[]}}},
  {"type":"function","function":{"name":"resolve_date","description":"Turn a spoken day into a real calendar date. Call this WHENEVER someone names a day relative to now - today, tomorrow, this Friday, next Tuesday, in 3 days - BEFORE you book, move, or otherwise use the date. Do NOT work out the date yourself; you are unreliable at calendar math. Pass the parts you understood: a weekday with weeksAhead (0 = this coming one, 1 = next week's), OR dayShift (0 = today, 1 = tomorrow), OR explicitDate if they gave an actual date. You get back {date, weekday, phrase, today, timezone}; USE the returned date. If it comes back unresolvable, ask which exact date they mean - never guess. For week RANGES pass week alone (0 = this week, 1 = next, -1 = last). For CALENDAR PERIODS pass exactly one of month, quarter, or year. NEVER write a period boundary yourself. WHEN YOU NAME ANY OF THESE DATES TO A PERSON, SAY THE phrase VERBATIM.","parameters":{"type":"object","properties":{"weekday":{"type":"string","enum":["monday","tuesday","wednesday","thursday","friday","saturday","sunday"],"description":"The named day, lowercase. Pair with weeksAhead."},"weeksAhead":{"type":"integer","description":"0 = this coming one, 1 = next week's, -1 = last week's."},"dayShift":{"type":"integer","description":"0 = today, 1 = tomorrow, 3 = in three days."},"explicitDate":{"type":"string","description":"An actual date if they gave one."},"week":{"type":"integer","description":"0 = this week, 1 = next, -1 = last."},"month":{"type":"integer"},"quarter":{"type":"integer"},"year":{"type":"integer"}},"required":[]}}}]}
JSON
}

# Completion gate. A production-shaped streamed tool call through the managed
# route from inside a sandbox container. The gateway FORCES the model id per
# request, so this exercises whatever route is CURRENTLY set. Success requires
# BOTH of:
#   - the stream closed cleanly (`data: [DONE]`) — a mid-stream death fails
#   - `finish_reason":"tool_calls"` — the model actually emitted a tool call
# Everything else is a miss: timeout, stall, 4xx/5xx (the 08-06 nvidia failure
# was a `400 (no body)`), a 402 balance-out, or prose with no tool call.
#
# `-u sandbox` + LOGIN shell (`sh -lc`) are LOAD-BEARING, not style. The
# sandbox's egress environment (proxy/DNS wiring for the container's policy
# rig) is assembled in the sandbox user's login profile; a bare
# `docker exec curl` runs as root with no profile and gets an EMPTY reply from
# a perfectly healthy provider. Found on medic v3's FIRST live run
# (2026-08-11): it declared BOTH providers dead while `nemoclaw exec` — which
# logs in as sandbox — completed fine. The false both-dead did exactly what
# the design said: restored the primary route, exited 1 loud, zero agent harm.
#
# `-i` on docker exec + `--data-binary @-` pipes the body in on stdin. That is
# what lets the payload be this large without a quoting minefield. (`docker
# exec -i` passes stdin fine — it is `nemoclaw exec` that eats it.)
probe_completion() { # model-id-hint
  local cid body
  cid="$(probe_container)"
  if [ -z "$cid" ]; then
    return 2  # no container to probe from — caller degrades to v2 semantics
  fi
  body="$(probe_payload | sed "s|__MODEL__|$1|" | docker exec -i -u sandbox "$cid" sh -lc \
    "curl -sk -m $PROBE_TIMEOUT \
      -X POST https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      --data-binary @-" \
    2>/dev/null)" || return 1
  grep -qF 'data: [DONE]' <<<"$body" || return 1
  grep -q '"finish_reason":"tool_calls"' <<<"$body"
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
  # ONE retry on a miss (v4). The probe is heavier than v3's — it waits for the
  # model to finish reasoning and emit a tool call — so a single slow response
  # under load is a plausible miss on a HEALTHY provider. Failing the fleet over
  # for that would be the same class of bug as the one v4 fixes, pointed the
  # other way. Two consecutive misses is evidence; one is noise. In-tick only,
  # so it stays consistent with v2's no-state-files rule.
  if [ "$prc" -eq 1 ]; then
    sleep "$RETRY_SLEEP"
    probe_completion "$model" && prc=0 || prc=$?
    [ "$prc" -eq 0 ] && log "$label $provider passed the completion probe on retry (first attempt missed)"
  fi
  if [ "$prc" -eq 0 ]; then
    return 0
  fi
  if [ "$prc" -eq 2 ]; then
    warn "no running sandbox container — completion gate SKIPPED for $provider (v2 semantics; registration only)"
    return 2
  fi
  warn "$label $provider REGISTERED but failed the tool-call completion probe TWICE (stall, non-serving key/model, or a model that will not emit tool calls)"
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
