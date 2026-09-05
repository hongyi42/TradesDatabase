#!/usr/bin/env bash
# nemoclaw-inference-medic.sh — hold the gateway inference route on the
# OpenRouter preset (Gemini 3.8 Flash → Muse Spark 1.3) and say honestly whether
# the fleet is ACTUALLY SERVING, at a cost the shared key can bear.
#
# v6 (2026-09-05) — the OpenRouter switch. Plan:
#   thoughts/shared/plans/2026-09-05-fleet-to-openrouter-muse-spark.md
# v7 (2026-09-05, evening) — Gemini 3.8 Flash becomes the PRIMARY and Muse the
#   fallback (user decision after both ran the same 82-question date eval:
#   Gemini 80/82, Muse 81/82, 0 weekday↔date contradictions on either; Gemini
#   10.2s vs 14.1s per turn, $0.038 vs $0.064 per question). Only the two
#   constants and this header changed — the mechanism is v6's. Pinned ids on
#   both lanes: served= compares exact strings, and the response's model field
#   spells the primary exactly `google/gemini-3.8-flash`.
#
# ┌─ THE MEDIC NEVER REROUTES. That is still the design (v5, 2026-08-12, user
# │  decision) and it is now EASIER to keep: the route points at an OpenRouter
# │  PRESET (`@preset/trades-seats`) whose config carries the fallback chain
# │  google/gemini-3.8-flash → meta/muse-spark-1.3 SERVER-SIDE, per request.
# │  The gateway can carry exactly one model string, so the preset is how a
# │  second lane reaches the seats at all. If the primary errors, OpenRouter
# │  tries the next — this script only ever asserts ONE route.
# └─ The 08-12 lesson still binds: an unverified fallback is worse than none.
#    So the fallback lane is PROBED (daily, directly) — see probe_fallback.
#
# THREE GATES, in cost order:
#   1. BALANCE (free, every tick). GET /api/v1/key + /api/v1/credits. Money is
#      the failure that actually killed the fleet — DeepInfra, Fireworks 412,
#      Fireworks 402 on 2026-09-04 — and no model fallback survives it: the key
#      is shared by every lane. remaining = min(key limit_remaining, account
#      credits − usage) must clear BALANCE_FLOOR_USD. If NEITHER input is
#      available the medic says NO BALANCE WATCH loudly rather than passing.
#   2. REGISTRATION (free, every tick). `openshell inference set --no-verify`
#      re-asserts the route (the drift the medic was born to fix: onboard/
#      rebuild reset it to the wizard's NVIDIA default). --no-verify because the
#      gateway's verification is endpoint+key, which gate 1 proves directly, and
#      a `@preset/…` id is not a listed model; a typo'd base URL surfaces at gate 3.
#   3. COMPLETION (~$0.003, HOURLY). The v4 turn-shaped probe through the
#      managed route from inside a sandbox: real tool schemas, streaming, and
#      the model must ACTUALLY EMIT A TOOL CALL. Reasoning is mandatory on both lanes
#      and shares the completion budget (204–374 reasoning tokens at medium,
#      peaked 478/512 in testing), hence max_tokens 1024. Re-validated against
#      Muse Spark 1.3 and Gemini 3.8 Flash on 2026-09-05: 8/8 tool calls.
#
# WHY HOURLY, AND WHY STAMP ONLY ON A PASS. With a vendor-side second lane a
# primary outage is not a fleet outage, so this gate's job changed from "alarm" to
# "is the path healthy, and WHICH LANE is carrying it" (served= below). Hourly
# ≈ $2/month; a 5-minute cadence would be ≈ $28 (measured on Muse). The cadence
# stamp is written ONLY when the probe passes: a miss re-probes every tick,
# so a "probe skipped" tick can never exit 0 and close an open ops incident
# while the fleet is down (the collector closes on any `ok`).
#
# served= — the response's "model" names what actually answered. The primary
# is logged as such; the fallback is logged LOUDLY (agents answer, but at the
# fallback's cost and behaviour — Muse thinks more and answers slower);
# an empty field or the literal preset slug is logged as `unknown` and never
# warned on — a gateway that strips the field must not read as an outage.
#
# STATE. Two timestamps (last-probe, last-fallback) in STATE_DIR — cadence,
# not flap state; every verdict still goes to the journal each tick. The unit
# uses StateDirectory= (/var/lib), NOT RuntimeDirectory=, which systemd wipes
# when a oneshot stops. Unwritable → warn, and every tick probes.
#
# Decision table:
#   balance low / key 401            -> route held, exit 1 LOUD (AGENTS ARE DOWN)
#   registration fails               -> exit 1 LOUD
#   probe due, misses twice          -> route held, exit 1 LOUD
#   probe passes (any lane)          -> exit 0 (+ LOUD warn if not the primary)
#   probe not due (last pass fresh)  -> exit 0, "probe skipped"
#   no sandbox container             -> registration only, exit 0 + WARN
#   fallback probe misses            -> WARN only; exit unaffected
#
# History, because this is how the traps got built: v2 probed with `inference
# set` (registration ≠ completion; 12-min stall logged "route OK", 07-28). v3
# probed "hi"/max_tokens:1 (a provider 400-ing every real turn passed it; six
# unnoticed windows on 08-12). v4 made the probe turn-shaped. v5 deleted the
# automatic failover that had been wired in by accident. v6 moves the second
# lane to where it can be honest — the vendor, per request — and keeps the
# probe that proves it.
#
# Runs as the gateway owner (ubuntu). Installed at /usr/local/sbin/, driven by
# nemoclaw-inference-medic.{service,timer}. `-u sandbox` + LOGIN shell on the
# docker exec are LOAD-BEARING (the sandbox's egress env lives in the login
# profile; root's bare curl gets an empty reply from a healthy provider —
# medic v3's first live run, 2026-08-11).
set -euo pipefail
export PATH="/home/ubuntu/.local/bin:$PATH"

WANT_PROVIDER="openrouter-prod"
WANT_MODEL="@preset/trades-seats"           # the preset IS the route; it carries the chain
PRIMARY_MODEL="google/gemini-3.8-flash"     # what served= should say (v7; pinned — the id the eval verified)
FALLBACK_MODEL="meta/muse-spark-1.3"        # v7: the morning's primary, 81/82 on the same eval
BALANCE_FLOOR_USD="${MEDIC_BALANCE_FLOOR_USD:-2.00}"
PROBE_INTERVAL="${MEDIC_PROBE_INTERVAL:-3600}"        # seconds between PASSED completion probes
FALLBACK_INTERVAL="${MEDIC_FALLBACK_INTERVAL:-86400}" # seconds between PASSED fallback probes
STATE_DIR="${MEDIC_STATE_DIR:-/var/lib/nemoclaw-inference-medic}"
OPENROUTER_API="${MEDIC_OPENROUTER_API:-https://openrouter.ai/api/v1}"
# seconds; a stall reads as a miss. 40 = ~4x the observed worst case on a
# healthy provider. Worst tick = balance 2x10 + probe 2x40 + fallback 40 = 140s,
# inside the unit's TimeoutStartSec=300 and the 5-min timer.
PROBE_TIMEOUT="${MEDIC_PROBE_TIMEOUT:-40}"
RETRY_SLEEP="${MEDIC_RETRY_SLEEP:-2}"       # pause before the one retry; 0 in tests

SERVED=unknown
FALLBACK_SERVED=unknown

log() { echo "nemoclaw-inference-medic: $*"; }
warn() { echo "nemoclaw-inference-medic: $*" >&2; }

# ── state (cadence stamps only) ─────────────────────────────────────────────
state_ready=0
state_init() {
  if mkdir -p "$STATE_DIR" 2>/dev/null && [ -w "$STATE_DIR" ]; then
    state_ready=1
  else
    warn "state dir $STATE_DIR is not writable — cadence stamps disabled; every tick probes"
  fi
}
stamp_age() { # name -> seconds since the stamp, or nothing if there is none
  local f="$STATE_DIR/$1" t
  [ "$state_ready" = 1 ] && [ -f "$f" ] || return 0
  t="$(cat "$f" 2>/dev/null || true)"
  [ -n "$t" ] && echo $(( $(date +%s) - t ))
  return 0
}
stamp_put() { # name — write-then-rename, and SAY SO if it fails: a silently
  # unwritable stamp (a root-owned file from a hand run, say) would otherwise
  # restore the every-tick probe cadence with nothing in the journal.
  [ "$state_ready" = 1 ] || return 0
  local f="$STATE_DIR/$1"
  if date +%s > "$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f" 2>/dev/null; then :; else
    warn "could not write cadence stamp $f — the paid probe runs EVERY tick until this is fixed (root-owned stamp from a hand run? chown ubuntu:ubuntu $STATE_DIR/*)"
  fi
}
due() { # name interval -> 0 when the probe should run
  local age; age="$(stamp_age "$1")"
  # No stamp, a stamp from the future (clock stepped back), or an old one: due.
  [ -z "$age" ] || [ "$age" -lt 0 ] || [ "$age" -ge "$2" ]
}

# ── OpenRouter account calls (from the HOST; the key never touches argv) ────
# The Authorization header rides in a curl config on a process-substitution
# fd, so `ps` shows /dev/fd/N, never the key. The journal tail of this unit is
# shipped off-box by ops-report.sh — one more reason it must not appear here.
auth_cfg() { printf 'header = "Authorization: Bearer %s"\n' "$OPENROUTER_API_KEY"; }
or_get() { curl -s -m 10 -K <(auth_cfg) -w '\n%{http_code}' "$1" 2>/dev/null; }

check_balance() {
  if [ -z "${OPENROUTER_API_KEY:-}" ]; then
    warn "NO BALANCE WATCH — OPENROUTER_API_KEY is not in the environment (is /etc/nemoclaw/openrouter.env installed and EnvironmentFile= on the unit?)"
    return 0
  fi
  local key_raw credits_raw verdict
  key_raw="$(or_get "$OPENROUTER_API/key" || true)"
  credits_raw="$(or_get "$OPENROUTER_API/credits" || true)"
  verdict="$(python3 - "$key_raw" "$credits_raw" "$BALANCE_FLOOR_USD" <<'PY'
import json, sys

def split(raw):
    raw = (raw or "").rstrip()
    body, _, code = raw.rpartition("\n")
    try:
        code = int(code)
    except ValueError:
        body, code = raw, 0
    if code != 200:
        return code, {}
    try:
        data = json.loads(body).get("data", {})
    except Exception:
        data = {}
    return code, data if isinstance(data, dict) else {}

def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)

kc, kd = split(sys.argv[1])
cc, cd = split(sys.argv[2])
floor = float(sys.argv[3])
if kc == 401 or cc == 401:
    print("unauth"); sys.exit()
# Every verdict names its SOURCES, so the journal shows when half the watch is
# missing — e.g. `/credits` is documented as management-key-only
# (https://openrouter.ai/docs/api-reference/get-credits) even though this key
# got a 200 on 2026-09-05; a rotated key may 403 it, and that must be visible.
cands, srcs = [], []
lr = kd.get("limit_remaining")
if num(lr):
    cands.append(float(lr)); srcs.append("key:%.2f" % lr)
else:
    srcs.append("key:null" if kc == 200 else "key:http%d" % kc)
tc, tu = cd.get("total_credits"), cd.get("total_usage")
if num(tc) and num(tu):
    cands.append(float(tc) - float(tu)); srcs.append("credits:%.2f" % (float(tc) - float(tu)))
else:
    srcs.append("credits:n/a" if cc == 200 else "credits:http%d" % cc)
src = " ".join(srcs)
if not cands:
    print("nowatch " + src); sys.exit()
rem = min(cands)
print(("low" if rem < floor else "ok") + " %.2f %s" % (rem, src))
PY
)"
  local rest rem src
  rest="${verdict#* }"; rem="${rest%% *}"; src="${rest#* }"
  case "$verdict" in
    unauth)
      warn "KEY REJECTED (401) by OpenRouter — AGENTS ARE DOWN. Rotate it in BOTH places (runbook §3): /etc/nemoclaw/openrouter.env, then export OPENAI_API_KEY from it and run: openshell provider update $WANT_PROVIDER -g nemoclaw --credential OPENAI_API_KEY (bare key = env lookup; never paste the value)"
      return 1 ;;
    nowatch*)
      warn "NO BALANCE WATCH — neither /key limit_remaining nor /credits answered with a number ($rest); the balance is NOT being checked this tick"
      return 0 ;;
    low\ *)
      warn "BALANCE $rem USD is below the floor $BALANCE_FLOOR_USD ($src) — AGENTS ARE DOWN (or about to be). Top up: https://openrouter.ai/settings/credits"
      return 1 ;;
    ok\ *)
      log "balance ok — $rem USD remaining (floor $BALANCE_FLOOR_USD; $src)"
      return 0 ;;
    *)
      warn "NO BALANCE WATCH — the balance check produced no verdict"
      return 0 ;;
  esac
}

# ── the route ───────────────────────────────────────────────────────────────
# `--no-verify` is real: "Skip endpoint verification before saving the route"
# (`openshell inference set --help`, read on the box 2026-09-05). First live
# use is the Phase 4 flip, with the timer stopped, so a rejection shows up in
# an operator's terminal rather than as a 5-minute page.
set_route() { # provider model
  openshell inference set -g nemoclaw --provider "$1" --model "$2" --no-verify >/dev/null 2>&1
}

probe_container() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep '^openshell-' | head -1
}

# The probe request body. Quoted heredoc so the tool JSON needs no escaping.
# `__MODEL__` is substituted by the caller; the gateway FORCES the routed model
# per request, so that field is advisory and only makes the journal readable.
#
# The three tools are real spine schemas (src/mcp/server.ts): a flat one, a
# nested-object one, and a long enum-heavy one. Three is enough to exercise
# schema validation (1,264 prompt tokens on Muse's tokenizer, 570 on Gemini's).
probe_payload() {
  cat <<'JSON'
{"model":"__MODEL__",
 "messages":[
   {"role":"system","content":"You are the assistant for a trades firm. Use tools for anything factual about the schedule, customers, or jobs. Never do calendar arithmetic yourself."},
   {"role":"user","content":"What date is this coming Friday?"}],
 "max_tokens":1024,
 "stream":true,
 "tools":[
  {"type":"function","function":{"name":"find_customer","description":"Search customers by name, phone, or address.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
  {"type":"function","function":{"name":"record_field_note","description":"Record a technician field note into the permanent company record. ONE call: pass the text and it is recorded. Two answers mean it did not land yet: needs_identity (ask which customer, then call again with confirmId + confirmed) and needs_confirmation (the answer would CREATE a customer - show the preview, then confirmId alone). Recording is permanent.","parameters":{"type":"object","properties":{"text":{"type":"string","description":"The note text."},"blobPath":{"type":"string","description":"Optional object-store pointer."},"channel":{"type":"string","enum":["technician_note","phone_call","sms","email"],"description":"Defaults to technician_note."},"confirmId":{"type":"string","description":"Set on follow-up calls."},"confirmed":{"type":"object","description":"With confirmId: the answer to a needs_identity question.","properties":{"customerId":{"type":"string"},"address":{"type":"string"}}}},"required":[]}}},
  {"type":"function","function":{"name":"resolve_date","description":"Turn a spoken day into a real calendar date. Call this WHENEVER someone names a day relative to now - today, tomorrow, this Friday, next Tuesday, in 3 days - BEFORE you book, move, or otherwise use the date. Do NOT work out the date yourself; you are unreliable at calendar math. Pass the parts you understood: a weekday with weeksAhead (0 = this coming one, 1 = next week's), OR dayShift (0 = today, 1 = tomorrow), OR explicitDate if they gave an actual date. You get back {date, weekday, phrase, today, timezone}; USE the returned date. If it comes back unresolvable, ask which exact date they mean - never guess. For week RANGES pass week alone (0 = this week, 1 = next, -1 = last). For CALENDAR PERIODS pass exactly one of month, quarter, or year. NEVER write a period boundary yourself. WHEN YOU NAME ANY OF THESE DATES TO A PERSON, SAY THE phrase VERBATIM.","parameters":{"type":"object","properties":{"weekday":{"type":"string","enum":["monday","tuesday","wednesday","thursday","friday","saturday","sunday"],"description":"The named day, lowercase. Pair with weeksAhead."},"weeksAhead":{"type":"integer","description":"0 = this coming one, 1 = next week's, -1 = last week's."},"dayShift":{"type":"integer","description":"0 = today, 1 = tomorrow, 3 = in three days."},"explicitDate":{"type":"string","description":"An actual date if they gave one."},"week":{"type":"integer","description":"0 = this week, 1 = next, -1 = last."},"month":{"type":"integer"},"quarter":{"type":"integer"},"year":{"type":"integer"}},"required":[]}}}]}
JSON
}

# The served model, from the stream's "model" field. Empty, or the literal
# preset slug, is `unknown` — never an alarm.
served_of() {
  local m
  m="$(grep -oE '"model":"[^"]+"' <<<"$1" | head -1 | cut -d'"' -f4 || true)"
  case "$m" in ""|@preset/*) echo unknown ;; *) echo "$m" ;; esac
}

# Completion gate: a production-shaped streamed tool call through the managed
# route from inside a sandbox container (the exact path agent turns take).
# Success requires BOTH `data: [DONE]` and `"finish_reason":"tool_calls"`.
# Returns 0 = pass (SERVED set), 1 = miss, 2 = no container to probe from.
probe_completion() { # model-id-hint
  local cid body
  cid="$(probe_container)"
  [ -n "$cid" ] || return 2
  body="$(probe_payload | sed "s|__MODEL__|$1|" | docker exec -i -u sandbox "$cid" sh -lc \
    "curl -sk -m $PROBE_TIMEOUT \
      -X POST https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      --data-binary @-" \
    2>/dev/null)" || return 1
  grep -qF 'data: [DONE]' <<<"$body" || return 1
  grep -q '"finish_reason":"tool_calls"' <<<"$body" || return 1
  SERVED="$(served_of "$body")"
  return 0
}

# The fallback lane, probed DIRECTLY at OpenRouter from the host (the gateway
# forces the preset, so it cannot address one lane). Same payload, same gate.
probe_fallback() {
  local body
  body="$(probe_payload | sed "s|__MODEL__|$FALLBACK_MODEL|" | curl -s -m "$PROBE_TIMEOUT" -K <(auth_cfg) \
    -X POST "$OPENROUTER_API/chat/completions" -H 'Content-Type: application/json' --data-binary @- 2>/dev/null)" || return 1
  grep -qF 'data: [DONE]' <<<"$body" || return 1
  grep -q '"finish_reason":"tool_calls"' <<<"$body" || return 1
  FALLBACK_SERVED="$(served_of "$body")"
  return 0
}

main() {
  local rc prc age
  state_init

  # Gate 1 — money. Hold the route even when this fails: a top-up must be
  # picked up by the next live turn, not the next tick.
  set +e; check_balance; rc=$?; set -e
  if [ "$rc" -ne 0 ]; then
    set +e; set_route "$WANT_PROVIDER" "$WANT_MODEL"; set -e
    warn "route held on $WANT_PROVIDER / $WANT_MODEL while the key cannot pay"
    return 1
  fi

  # Gate 2 — registration.
  if ! set_route "$WANT_PROVIDER" "$WANT_MODEL"; then
    warn "$WANT_PROVIDER failed REGISTRATION — AGENTS ARE DOWN and the route could not be asserted. Check: openshell provider get $WANT_PROVIDER -g nemoclaw"
    return 1
  fi

  # Gate 3 — completion, on its own cadence.
  if due last-probe "$PROBE_INTERVAL"; then
    set +e; probe_completion "$WANT_MODEL"; prc=$?; set -e
    # ONE retry on a miss: a single slow response under load is a plausible
    # miss on a healthy lane; two consecutive misses is evidence.
    if [ "$prc" -eq 1 ]; then
      sleep "$RETRY_SLEEP"
      set +e; probe_completion "$WANT_MODEL"; prc=$?; set -e
      [ "$prc" -eq 0 ] && log "primary passed the completion probe on retry (first attempt missed)"
    fi
    case "$prc" in
      0)
        stamp_put last-probe
        log "route OK on $WANT_PROVIDER / $WANT_MODEL — serving verified (tool call returned) served=$SERVED"
        if [ "$SERVED" != unknown ] && [ "$SERVED" != "$PRIMARY_MODEL" ]; then
          warn "PRIMARY NOT SERVING — $SERVED is carrying the fleet (fallback active). Agents answer, at the fallback's cost and behaviour; the medic never reroutes. Check Google / OpenRouter status."
        fi ;;
      2)
        warn "no running sandbox container — completion gate SKIPPED (registration only)"
        log "route asserted on $WANT_PROVIDER — REGISTRATION ONLY, no container for the completion probe"
        return 0 ;;
      *)
        warn "$WANT_PROVIDER REGISTERED but failed the tool-call completion probe TWICE (stall, non-serving key/model, or a model that will not emit tool calls)"
        warn "$WANT_PROVIDER IS NOT SERVING — route held (registration ok, completions failing). AGENTS ARE DOWN. The medic never reroutes; the preset's own chain is the second lane. Check https://openrouter.ai/settings/credits and OpenRouter status first."
        return 1 ;;
    esac
  else
    age="$(stamp_age last-probe)"
    log "probe skipped (last pass ${age}s ago; interval ${PROBE_INTERVAL}s) — route asserted on $WANT_PROVIDER / $WANT_MODEL"
  fi

  # The second lane, kept honest.
  if due last-fallback "$FALLBACK_INTERVAL"; then
    if [ -z "${OPENROUTER_API_KEY:-}" ]; then
      warn "FALLBACK probe skipped — no OPENROUTER_API_KEY in the environment"
    else
      set +e; probe_fallback; rc=$?; set -e
      if [ "$rc" -eq 0 ]; then
        stamp_put last-fallback
        log "fallback lane verified — $FALLBACK_MODEL emitted a tool call (served=$FALLBACK_SERVED)"
      else
        warn "FALLBACK $FALLBACK_MODEL failed its tool-call probe — the chain has no verified second lane (primary unaffected; exit unaffected)"
      fi
    fi
  fi
  return 0
}

main "$@"
