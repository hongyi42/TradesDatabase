#!/usr/bin/env bash
# nemoclaw-inference-medic.sh — hold the gateway inference route on
# DeepInfra/GLM-5.2 and say honestly whether it is ACTUALLY SERVING.
#
# ┌─ THERE IS NO FALLBACK, AND THAT IS THE DESIGN (v5, 2026-08-12, user decision).
# │  Do not add one back without deciding to. The medic exists to (a) re-assert
# │  the route after onboard/rebuild drift and (b) tell the truth about whether
# │  the provider is serving. It does NOT reroute traffic.
# └─ History, because this is how the trap got built:
#      2026-07-02  agents run GLM-5.2 on nvidia-prod. NVIDIA IS the provider.
#      2026-07-06  swap to deepinfra-prod. nvidia-prod kept as a MANUAL rollback.
#      2026-07-11  medic v2 wires that manual rollback up as an AUTOMATIC
#                  failover target. Nobody decided this; nobody verified NVIDIA
#                  still served. The NVIDIA key was rotated the same day.
#      2026-08-06  a 4-min DeepInfra blip fails the fleet over to nvidia-prod,
#                  which 400s every real turn. The failover converts a blip into
#                  a hard outage while logging success. Repeats 6x on 08-12.
#    A break-glass escape hatch was promoted to a live safety net by accident.
#    An unverified fallback is worse than no fallback: it fails you exactly when
#    you depend on it, and it reports success while doing so. Single-provider is
#    now explicit — an outage is an outage, and the log says so.
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
#   - Requiring the tool call is deliberate. A model that will not emit one for a
#     prompt this tool-forcing cannot serve this product — every real turn is
#     tools. NOTE this is an assumption about the MODEL, not the provider: if the
#     routed model ever changes, re-validate the probe against it FIRST, or a
#     model that answers the date in prose gets reported dead while healthy.
#
# Why keep a turn-shaped probe when there is no failover to drive? Because with
# nothing to reroute to, the probe's worst case is crying wolf in a log — the
# false-failover risk that would otherwise argue for a gentler gate is GONE. What
# remains is the signal, and the signal is the whole point: this is what an alert
# should fire on. (Alerting is the open gap — nothing watches this journal today,
# which is why six outage windows on 2026-08-12 went unnoticed.)
#
# Decision table (registration gate, then completion gate):
#   reg ok + completion ok     -> route asserted and SERVING, exit 0
#   reg ok + completion fails  -> route stays asserted, exit 1 LOUD (agents down)
#   reg fails                  -> exit 1 LOUD (agents down)
#   no sandbox container       -> registration only, exit 0 with a WARN
#
# The route is asserted even when the probe fails: DeepInfra outages have
# self-healed every time so far, so leaving the route correct means a recovery is
# picked up by live turns immediately instead of waiting for the next tick.
#
# If NO sandbox container is running, the completion gate cannot run; the medic
# degrades to registration-only with a loud WARN rather than failing the unit —
# a box mid-maintenance must not report a healthy provider as dead.
#
# Runs as the gateway owner (ubuntu). Installed at /usr/local/sbin/, driven by
# nemoclaw-inference-medic.{service,timer}. See doorman-nemoclaw-setup-guide.md
# and docs/engineering-memory.md (medic v4/v5 entries).
set -euo pipefail
export PATH="/home/ubuntu/.local/bin:$PATH"

WANT_PROVIDER="deepinfra-prod"
WANT_MODEL="zai-org/GLM-5.2"     # NOTE: DeepInfra id spelling
# No FALLBACK_* by design — see the header. nvidia-prod still exists in the
# gateway's provider registry (harmless; nothing routes to it), so adding a
# fallback back is a two-line change. Do it deliberately, and only after probing
# the candidate: an unverified fallback is worse than none.
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
  # ONE retry on a miss. The probe waits for the model to finish reasoning and
  # emit a tool call, so a single slow response under load is a plausible miss on
  # a HEALTHY provider. With no failover, a false miss costs no traffic — but it
  # would cost a false ALARM, and an alert that cries wolf gets ignored, which is
  # how you end up back where this started. Two consecutive misses is evidence;
  # one is noise. In-tick only, so no state file (flaps stay visible in the
  # journal — a v2 design decision worth keeping).
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
    log "route OK on $WANT_PROVIDER / $WANT_MODEL — serving verified (tool call returned)"
    return 0
  elif [ "$rc" -eq 2 ]; then
    log "route asserted on $WANT_PROVIDER — REGISTRATION ONLY, no container for the completion probe"
    return 0
  fi

  # No failover by design (see header). Re-assert the route anyway so that when
  # the provider recovers — DeepInfra outages have self-healed every time so far
  # — live turns pick it up immediately rather than waiting for the next tick.
  set +e; set_route "$WANT_PROVIDER" "$WANT_MODEL"; rc=$?; set -e
  if [ "$rc" -eq 0 ]; then
    warn "$WANT_PROVIDER IS NOT SERVING — route held (registration ok, completions failing). AGENTS ARE DOWN. There is no fallback by design; this will clear when the provider recovers. Check the DeepInfra balance (402) and status first."
  else
    warn "$WANT_PROVIDER failed REGISTRATION as well — AGENTS ARE DOWN and the route could not be asserted. Check the DeepInfra key and balance (402)."
  fi
  return 1
}

main "$@"
