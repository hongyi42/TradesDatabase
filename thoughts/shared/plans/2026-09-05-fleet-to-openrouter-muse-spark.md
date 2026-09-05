---
date: 2026-09-05
task: Move the six-seat fleet from Fireworks/GLM-5.2 to OpenRouter — Muse Spark 1.3 primary, Gemini Flash (floating) fallback — with a redesigned medic. AMENDED same day after Phase 5's evals — Gemini 3.8 Flash primary, Muse fallback, both pinned (see Decisions)
research: thoughts/shared/research/2026-09-05-fleet-to-openrouter-gemini-3-8-flash.md
status: draft
supersedes: thoughts/shared/plans/2026-08-15-fireworks-switch.md
---

**`supersedes:`** — overturns the 2026-08-15 decision that Fireworks/GLM-5.2-fast is the fleet's
primary (that account is out of credits; the fleet has been inference-dead since 2026-09-04). It
*completes* the seat half of `2026-08-28-openrouter-migration.md`. The 2026-08-12 no-fallback
ruling keeps its intent: **the medic never reroutes.**

## Overview

Register OpenRouter as a gateway provider; point the one fleet-wide route at an OpenRouter
**preset** carrying a vendor-side fallback chain (built Muse-first that morning; **flipped to `google/gemini-3.8-flash` → `meta/muse-spark-1.3` that evening** on the Phase 5 evidence — see Decisions)
chain with a medium-effort default; rewrite the medic to hold that route and report honestly at a
cost the shared $30/month key can bear; update each seat's model metadata; re-run the evals.

## Decisions

- **AMENDED 2026-09-05 (evening, user) — primary `google/gemini-3.8-flash`, fallback `meta/muse-spark-1.3`, both pinned.**
  Decided after Phase 5 ran the date eval on BOTH lanes (Muse 81/82, Gemini 80/82, 0 contradictions
  each; Gemini 10.2s vs 14.1s per turn, $0.038 vs $0.064 per question — the per-call
  pre-first-token cost is the whole gap). The float alias is retired because every verification gate
  compares exact model strings. Preset v3, medic v7, `wire` id, eval default all follow; the two
  bullets below record the morning's ordering and still explain the mechanism.
- **Provider / key** — OpenRouter on the planner's existing key (user: "this is testing suite").
  Fleet + planner share one $30/month cap — accepted, and watched by the medic.
- **Primary** — `meta/muse-spark-1.3`, **standard tier** (user; not `-contributor`, whose page
  says prompts "may be used to improve Meta's products"). Pinned — no `~meta/…-latest` exists.
- **Fallback** — `~google/gemini-flash-latest` (user chose float). Retargets the moment Google
  ships a new Flash (https://openrouter.ai/docs/guides/routing/routers/latest-resolution); the
  medic logs the served model so that is visible. Verified live as a direct `model` id (→
  `google/gemini-3.8-flash`) and inside `models[]`.
- **Fallback mechanism = an OpenRouter preset.** The gateway rewrites `model` unconditionally
  and openclaw has no extra-body hook (NVIDIA/OpenShell#2039), so seats cannot send a `models[]`
  chain. A preset is *invoked as a model id* (`@preset/trades-seats`) — the one string the
  gateway carries — and OpenRouter applies the chain server-side. Verified live: our exact probe
  payload with `models:[muse, ~gemini]` fell through to Gemini and passed the medic's gate. The
  medic never changes the route; the fallback IS verified (same probe, daily). Rejected: a
  medic-driven flip — the 08-12 shape. **Branch B** if the gateway refuses a `@preset/…` id:
  route `meta/muse-spark-1.3` directly, no fallback, STOP and report.
- **Reasoning** — default medium, dynamic per task (user: "past doctrine"). openclaw 2026.6.34:
  `thinkingDefault:"adaptive"` → `reasoning_effort:"medium"` (`simple-completion-runtime:202`),
  `/think <level>` per message, emitted only when `model.reasoning && compat.supportsReasoningEffort`
  (`openai-completions:786`) — unset today: config, not code. Request fields take priority over
  the preset (https://openrouter.ai/docs/features/presets); the gateway rewrites only `model`
  (#2039). **Outcome (Phase 4):** the gateway forwards the field, but "request overrides preset"
  holds only for the SAME key — the seats' `reasoning_effort` and the preset's `reasoning.effort`
  were merged as two keys and OpenRouter 400'd every non-medium level. Preset v2 carries no
  `reasoning`; the lever then measured 83 (low) vs 727 (high) reasoning tokens. Dynamic effort is
  LIVE. Per-message control is `/think <level>` on the chat path, `--thinking <level>` on the CLI.
- **Context window** — 131072 technician (s5), **262144 manager** (s2 s3 s6 s7 s8 — roster
  tier; five of six). `maxTokens` 4096→**8192**: Muse's reasoning is mandatory and shares the
  budget (a 20-token budget returned `content:null`); 8192 caps a runaway turn at ≈$0.035.
- **Image input on** (`input:["text","image"]`) — the stated reason for Muse. Video/audio deferred.
- **Medic v6** (user delegated the redesign). 5-min timer unchanged. Each tick: assert route
  (`--no-verify`), **free balance check** — `min(key.limit_remaining, credits.total−usage)` above
  $2.00 else LOUD; both endpoints returned 200 on this key 2026-09-05 (`/credits`: 35 total, 3.39
  used); both unavailable ⇒ LOUD **NO BALANCE WATCH**, never a silent pass. Every **60 min**
  (user, 2026-09-05: "stretch the medic to 60 minutes" — the preset's fallback means a Muse
  outage is not a fleet outage, so the probe's job is health and lane, not alarm), stamped only
  on a PASS (a miss re-probes every tick, so a "skipped" tick can never close an open incident):
  the v4 tool-call probe via `inference.local`, `max_tokens` 1024 (Muse peaked 478/512), logging
  `served=<model>`. Daily: direct probe of the fallback. Served-by-fallback ⇒ exit 0 + LOUD warn
  (paging deferred). ≈$2/month vs ≈$28 for the 5-min medium probe on Muse. `--no-verify`:
  verification is endpoint+key, which the balance check proves; a base-URL typo or a silent
  lane change surfaces within an hour.
- **Registry** — `openrouter-prod`; old providers stay registered, inert. Seats declare
  `meta/muse-spark-1.3` honestly (fallback turns still show it in trajectories — the medic
  journal is the served-model truth). s3's `nemotron` id is normalized by the same wire.
  `NEMOCLAW_MODEL` (:239) stays `z-ai/glm-5.2` — onboard runs on nvidia-prod; wire rewrites it.
- **Sequencing.** The route flip is fleet-wide. Seat *metadata* is per-seat and IS canaried: s2's
  config, gateway proven back, the other five, the one flip, s2 verified first. The medic timer
  is stopped before any file it reads is replaced.

## Plain-language walkthrough

```
BEFORE                                  AFTER
seat ─► gateway ─► Fireworks/GLM  402   seat ─► gateway ─► OpenRouter @preset/trades-seats
        medic: 5-min $0.0003 probe               │            ├─ meta/muse-spark-1.3
        no fallback                              │            └─ ~google/gemini-flash-latest
                                                 medic: balance /5 min · turn probe /60 min
                                                        logs served=<model> · never reroutes
```

**Phase 1** registers OpenRouter with the gateway and you create the preset; seats see no change.
**Phase 2** rewrites the medic — the script that decides "is the fleet up" — and its test.
**Phase 3** updates everything else in the repo that names the old provider. **Phase 4** is the
flip on the box: timer off, files in, s2's metadata, the rest, the one route — texting s2 works
again. **Phase 5** re-runs the evals measured on GLM (dates are blocking) and soaks the medic a day.

## Secrets & env preflight

- **Phase 1:** `OPENROUTER_API_KEY` in `.env` (already required). **OpenRouter dashboard login**
  (user creates the preset; API creation is documented as management-key, which the planner's
  is not). Box file `/etc/nemoclaw/openrouter.env`, created here from `.env`, 0600 root, via ssh stdin.
- **Phase 2/3:** none (local stack, `.env.test`). **Phase 4:** `/etc/doorman/badge-pull.env`
  (already; ops-report). **Phase 5:** `DATE_EVAL_*` per `scripts/date-eval/README.md`.

## Phase 1: OpenRouter preset + gateway provider (no route change)

### What this phase does
Creates the preset, proves it serves a tool call, registers OpenRouter in the gateway. Route untouched.

### Changes required
**OpenRouter dashboard (user)** — https://openrouter.ai/settings/presets/new, slug `trades-seats`:
model `meta/muse-spark-1.3`; fallback `~google/gemini-flash-latest`; reasoning effort `medium`;
max tokens `8192`; provider prefs: allow fallbacks **on**, data collection **deny**; no system prompt.

**Implementer** (key read from `.env` into a shell variable; sent as a curl `-K -` config line, never argv):
- Optional: `GET /api/v1/presets/trades-seats` (https://openrouter.ai/docs/api/api-reference/presets/get-a-preset)
  → `designated_version.config`. **The gate is the smoke test, not this call.**
- Smoke A: the medic's `probe_payload` (`Box_Setup_Stuff/nemoclaw-inference-medic.sh:134-152`)
  with `"model":"@preset/trades-seats"` **and `"max_tokens":1024`** → `finish_reason:"tool_calls"`,
  `data: [DONE]`. Record the response `"model"`: `meta/muse-spark-1.3` expected; **if Gemini**,
  `data_collection: deny` excluded Meta — drop that pref, re-test, record in Decisions; **if the
  literal `@preset/…`**, note it (Phase 2 treats that as `unknown`).
- Smoke B: same payload with `"model":"~google/gemini-flash-latest"` → tool call (the daily fallback probe's exact shape).
- Box key: `grep -m1 '^OPENROUTER_API_KEY=' .env | ssh tradesbox 'sudo install -m 0600 -o root -g root /dev/stdin /etc/nemoclaw/openrouter.env'`;
  verify `sudo stat -c '%a %U'` → `600 root`, `sudo grep -c '^OPENROUTER_API_KEY=' …` → 1.
- Provider, as `ubuntu` in a login shell: `export OPENAI_API_KEY="$(sudo cut -d= -f2- /etc/nemoclaw/openrouter.env)"` then
  `openshell provider create -g nemoclaw --name openrouter-prod --type openai --credential OPENAI_API_KEY --config OPENAI_BASE_URL=https://openrouter.ai/api/v1`
  (`--credential KEY` = env lookup; precedent `doorman-nemoclaw-setup-guide.md:498`).

### Automated verification
- [x] `openshell provider get openrouter-prod -g nemoclaw` → `Type: openai`, keys `OPENAI_API_KEY` / `OPENAI_BASE_URL` (2026-09-05 09:4x UTC)
- [x] `openshell inference get -g nemoclaw` still `fireworks-prod / accounts/fireworks/routers/glm-5p2-fast`
- [x] `npm run typecheck && npm run lint && npm test` unchanged — `git status` shows no repo edits this phase (docs only)

### Live verification (agent-executable)
- Prerequisites: `ssh tradesbox`; repo `.env`.
- [x] Smoke A ×2 (`@preset/trades-seats`, 1024): PASS, served `meta/muse-spark-1.3` (provider Meta),
  tool `resolve_date`, prompt 1264 tok, reasoning 204 / 249 tok, cached 0 / 1137, cost $0.0028 / $0.0017.
  **`data_collection: deny` did NOT exclude Meta** — pref kept. Smoke B (`~google/gemini-flash-latest`
  direct, 1024): PASS, served `google/gemini-3.8-flash`, `resolve_date`, reasoning 153, cost $0.0011.
- Evidence outside the plan: the preset was created **via API with the planner's key** (`POST
  /api/v1/presets/trades-seats/chat/completions` → 200, v1) — the "management key only" doc line
  did not apply; `GET /api/v1/presets/trades-seats` → 200 with the same config. Key file
  `/etc/nemoclaw/openrouter.env` → `600 root:root`, 1 line.

### Manual verification
- [x] User confirmed the preset ("continue", 2026-09-05).

---

## Phase 2: Medic v6 + its test (repo only)

### What this phase does
Rewrites the health script for the new route and cost model; pins its decision table.

### Changes required
**`Box_Setup_Stuff/nemoclaw-inference-medic.sh`** — header rewritten (v6, why). Constants:
`WANT_PROVIDER=openrouter-prod`, `WANT_MODEL=@preset/trades-seats`, `PRIMARY_MODEL=meta/muse-spark-1.3`,
`FALLBACK_MODEL=~google/gemini-flash-latest`, `BALANCE_FLOOR_USD=2.00`,
`PROBE_INTERVAL="${MEDIC_PROBE_INTERVAL:-3600}"`, `FALLBACK_INTERVAL="${MEDIC_FALLBACK_INTERVAL:-86400}"`,
`STATE_DIR="${MEDIC_STATE_DIR:-/var/lib/nemoclaw-inference-medic}"` (cadence stamps only —
not flap state; `mkdir -p`; unwritable → warn and behave as if no stamp exists).
- `set_route`: add `--no-verify`.
- `check_balance`: `curl -s -m 10 -K -` with `header = "Authorization: Bearer $OPENROUTER_API_KEY"`
  on stdin, `GET /api/v1/key` and `GET /api/v1/credits`; python3 → `remaining = min(nonnull(key.limit_remaining), credits.total_credits − credits.total_usage)`.
  `< BALANCE_FLOOR_USD` → `warn "BALANCE $remaining below floor — AGENTS ARE DOWN (or about to be)"`, return 1;
  401 → return 1; **no usable input** (env missing, both calls failed/403, `limit_remaining` null with
  no credits) → `warn "NO BALANCE WATCH — …"` and skip. Log `balance ok — $remaining`.
- `probe_payload`: `"max_tokens":1024`.
- `probe_completion`: `served=$(grep -oE '"model":"[^"]+"' <<<"$body" | head -1 | cut -d'"' -f4)`;
  empty **or `@preset/*`** → `served=unknown`. Warn `PRIMARY NOT SERVING — $served is carrying
  the fleet (fallback active)` only when known and ≠ `PRIMARY_MODEL`.
- cadence: probe when `$STATE_DIR/last-probe` is absent or `now − stamp >= PROBE_INTERVAL`;
  **stamp only on a pass**; else log `probe skipped (N s ago)`.
- `probe_fallback` (same gate on `last-fallback`, stamped on pass): the payload with
  `"model":"$FALLBACK_MODEL"` POSTed **from the host** to `https://openrouter.ai/api/v1/chat/completions`
  (`-K -` header, `-m "$PROBE_TIMEOUT"`); miss → warn `FALLBACK … failed — no verified second lane`.
- `main`: balance fails → 1; registration fails → 1; probe due and misses twice → 1, route held;
  probe passes (any served) or skipped-after-pass → 0; no container → registration only, 0 + WARN.
  Every "Fireworks" string replaced; final warn names `https://openrouter.ai/settings/credits`.

**`Box_Setup_Stuff/nemoclaw-inference-medic.service`** — Description "Assert the OpenRouter
preset route (Muse Spark 1.3 → Gemini Flash) and verify it is serving";
`EnvironmentFile=-/etc/nemoclaw/openrouter.env`; `StateDirectory=nemoclaw-inference-medic`
(persists — `RuntimeDirectory` is wiped when a oneshot stops); `TimeoutStartSec=300`. Timer unchanged.

**`src/control/inferenceMedicScript.test.ts`** — shims: `openshell` keyed on `REG_OPENROUTER`;
`docker` per `COMPLETION_PRIMARY` ∈ `1|0|prose|truncated|flaky|fallback|nomodel|presetslug`
(healthy carries `"model":"meta/muse-spark-1.3"`; `fallback` Gemini; `nomodel` none; `presetslug`
`@preset/trades-seats`); `curl` shim: `/api/v1/key` → `KEY_REMAINING` (default 25, `null` allowed),
`/api/v1/credits` → `CREDITS_REMAINING` (default 30) or HTTP from `KEY_HTTP`; `…/chat/completions`
→ `COMPLETION_FALLBACK`. `run()` env: both intervals 0, `MEDIC_STATE_DIR=<tmp>`, `OPENROUTER_API_KEY=test`.
Cases: healthy → 0, `route OK on openrouter-prod`, `serving verified`, `served=meta/muse-spark-1.3`;
fallback → 0 + `PRIMARY NOT SERVING`; nomodel / presetslug → 0, `served=unknown`, no PRIMARY warn;
`KEY_REMAINING=null`+`CREDITS_REMAINING=1` → 1 + `AGENTS ARE DOWN`; `KEY_REMAINING=null`+`KEY_HTTP=403`
→ 0 + `NO BALANCE WATCH`; `KEY_HTTP=401` → 1; misses twice → 1, route held; **miss, rerun at
`MEDIC_PROBE_INTERVAL=3600` → probes again, 1**; pass, rerun at 3600 → `probe skipped`, 0; prose /
truncated → not serving; flaky → retry passes; no container → registration only; never routes
anywhere but `openrouter-prod`; output never contains `fireworks|deepinfra|nvidia|FAILOVER`; fallback
probe miss → warn, 0; **the key never appears in any shim's argv** (the `curl` shim saw `-K`).

### Automated verification
- [x] `bash -n Box_Setup_Stuff/nemoclaw-inference-medic.sh` OK (shellcheck not installed on this Mac)
- [x] `npx vitest run src/control/inferenceMedicScript.test.ts` — 20/20 (the plan's cases + "half a watch is said out loud")
- [x] `npm run typecheck` 0 · `npm run lint` 0 · `npm test` 2556/2556 (2026-09-05 09:36 PDT-ish)
- Review round 1 (fresh-context subagent): every requirement confirmed; three hardenings taken —
  the balance line names its sources (`key:… credits:…`), stamps are written via rename and a
  failure is warned, a future-dated stamp counts as due. Also noted: `/credits` is documented
  management-key-only yet answered 200 here — recorded in the script header comment.

### Live / Manual verification
- [x] none — shims here; live in Phase 4.

---

## Phase 3: Bootstrap, evals, price book, docs (repo only)

### What this phase does
Every other repo artifact that names the old provider or shapes seat config.

### Changes required
**`Box_Setup_Stuff/bootstrap-box.sh`**
- `:171-177` cheat sheet + `:285-287` route flip → `openshell inference set -g nemoclaw --provider openrouter-prod --model @preset/trades-seats --no-verify`;
  rollback text → "the preset's fallback is the second lane; see runbook".
- `phase_wire` (`:551`): `NEMOCLAW_CTX_WINDOW="${NEMOCLAW_CTX_WINDOW:-131072}"`; extend the jq
  block (`:1272-1283`) so `.models.providers.inference.models` is exactly one entry
  `{id:"meta/muse-spark-1.3", name:"inference/meta/muse-spark-1.3", reasoning:true, input:["text","image"],
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:$ctx, maxTokens:8192,
  compat:{supportsPromptCacheKey:true, supportsReasoningEffort:true,
  supportedReasoningEfforts:["minimal","low","medium","high","xhigh","max"]}, api:"openai-completions"}`
  (**Phase 4 correction:** the plan's original `supportsParallelToolCalls:false` is NOT a field of
  openclaw 2026.6.34's strict `compat` config schema — the s2 canary crash-looped the gateway on
  `compat: Invalid input`; the key was dropped. `parallel_tool_calls` handling is openclaw's default.)
  and `.agents.defaults.model.primary = "inference/meta/muse-spark-1.3"` (no `agents.list[].model`
  override exists on any seat). The `cmp -s` guard keeps it idempotent. Comment: manager 262144 /
  technician 131072 — tier lives in the DB, the operator passes it.
- `phase_verify`: `/etc/nemoclaw/openrouter.env` present → `ok`, else `✗ … medic balance check and
  fallback probe will skip — runbook §3` (warn count).
**`Box_Setup_Stuff/apply-bakein.py`** `:96-101`: add `muse-spark-1-3-toolsearch-off.json` matching `["meta/muse-spark-1.3"]`; `:18`.
**`scripts/date-eval/plan.mjs:181`** default → `'meta/muse-spark-1.3'`; comment: evals run on a
**single-model** route with the medic timer stopped (Phase 5) — under `@preset/trades-seats` a
fallback event is invisible to this harness. **`scripts/date-eval/README.md:79`** same.
**`supabase/migrations/20260906130000_openrouter_seat_model_rates.sql`** — eight `openrouter` rows,
effective `2026-09-05`, `source_url` = the OpenRouter model pages:
`muse-spark-1.3-{input 0.00000125, output 0.00000425, cached-input 0.00000015, cache-write 0}`,
`gemini-3.8-flash-{input 0.00000075, output 0.00000375, cached-input 0.000000075, cache-write 0.0000000417}`.
Header: seat spend is account-level, netted against the invoice (`src/db/costs.ts:196-200`); `MODEL_SKUS` unchanged.
**`src/db/costs.test.ts:232-247`** — the eight strings in sorted position (`gemini-…` before `glm-5.3-…`, `muse-…` after).
**`docs/inference-recovery-runbook.md`** — header table (fleet → OpenRouter `@preset/trades-seats`,
"Muse → Gemini, OpenRouter-side"); §0 strings incl. `served=`, `balance ok`, `NO BALANCE WATCH`; §1 →
https://openrouter.ai/settings/credits + error table from https://openrouter.ai/docs/api-reference/errors
(402 credits, 403 gate/moderation — the 18+ attestation case, 429 Retry-After, 502, 503); §3 →
`openshell provider update openrouter-prod --credential OPENAI_API_KEY=<key>` + the box env file;
§4 → `--session-id`, expected strings; §5 keep "stop the timer first", add "the medic never
reroutes — the second lane is the preset's"; §7 refresh.
**`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:498-533,564`**, **`doorman-architecture-memory.md:126-192`**
— provider/route/medic paragraphs rewritten; history kept.
**`docs/engineering-memory.md`** — dated entry (switch, preset mechanism, measurements, the $30
coupling, medic v6 table); live-route line `:514`.

### Automated verification
- [x] `project_id = "TradesDatabase"` (primary local stack); `npx supabase migration up` applied `20260906130000` (gentler than `db reset`, same result)
- [x] `npm run typecheck` 0 · `npm run lint` 0 · `npm test` 2556/2556 (costs.test.ts pins the eight rows)
- [x] `bash -n` bootstrap + medic OK; `apply-bakein.py` compiles (checked with `ast.parse` — `py_compile` rewrites a TRACKED `.pyc`, restored)
- [x] grep gate: 7 remaining hits, all inside labelled HISTORY blocks/comments or the GLM baseline's own record
- [x] `npm run decisions:index` (193 entries)
- Review round 1: four findings — engineering-memory's present-tense "Current: Fireworks" block
  unsuperseded; stale Fireworks text + Fireworks-rate spend estimate in date-eval; runbook §3
  credential form unverified and disagreeing with the medic's 401 line; triage row → wrong
  section. All fixed. Round 2: resolved (credential form verified on the box:
  `provider update --credential <KEY[=VALUE]>`); one non-verbatim triage row aligned.
  Also caught: `py_compile` dirtied the tracked `.pyc` — restored.

### Live / Manual verification
- [x] none

---

## Phase 4: The flip — timer off, files in, s2's metadata, the rest, then the one route

### What this phase does
Deploys Phases 1–3 to trades-box-1 and restores service. Announce in chat first and run
`loginctl list-sessions` — two operators took the fleet down on 2026-09-05.

### Changes required (box, in this order)
1. `sudo systemctl stop nemoclaw-inference-medic.timer`; `systemctl is-active nemoclaw-inference-medic.service`
   must be `inactive`/`failed` (no in-flight tick) before anything it reads is replaced.
2. Copy medic + unit + bootstrap to `/home/ubuntu/Box_Setup_Stuff/`; `sudo install -m 0755` the
   medic and bootstrap into `/usr/local/sbin/` (the two synced copies of seven); unit →
   `/etc/systemd/system/`; `sudo systemctl daemon-reload`. md5 all three against the repo.
3. **Metadata canary:** as `ubuntu`, login shell: `NEMOCLAW_CTX_WINDOW=262144 ./bootstrap-box.sh wire s2`.
   Confirm the gateway came back (`wire`'s own `http server listening` check, `:1170`) and
   `docker ps` shows s2 healthy — a rejected config key would fail here, on one seat.
4. `wire` s3 s6 s7 s8 with 262144, **s5 with 131072**; same check each.
5. **Fleet-wide:** `openshell inference set -g nemoclaw --provider openrouter-prod --model @preset/trades-seats`
   — verification error → retry `--no-verify`; id rejected → **Branch B** (route `meta/muse-spark-1.3`), STOP and report.
6. `sudo systemctl start nemoclaw-inference-medic.service; journalctl -u nemoclaw-inference-medic.service -n 12 --no-pager`
   (`;` not `&&` — a failing oneshot must still show its journal) → `balance ok — … (floor 2.00;
   key:N credits:M)` **with both sources numeric** (a `credits:http403` means the account
   dimension is unwatched — record it), `route OK on openrouter-prod / @preset/trades-seats —
   serving verified`, `served=meta/muse-spark-1.3`.
   **If `served=unknown`**: record it; the served-model truth becomes OpenRouter's activity page —
   update the runbook line and Phase 5's soak criterion. **Wait ≥60 s after step 5 before this**:
   sandboxes cache the route and refresh it on their own clock (`Inference routes updated` in
   `docker logs`); a probe inside that window goes out on the OLD route (learned live, 2026-09-05).
7. `sudo systemctl start nemoclaw-inference-medic.timer`.

### Automated verification
- [x] `openshell inference get -g nemoclaw` → `openrouter-prod / @preset/trades-seats` (2026-09-05 ~17:30Z; the
  VERIFIED form succeeded — the gateway validates the endpoint, not the model id; `--no-verify` not needed for the flip)
- [x] medic journal: `balance ok — 28.43 USD remaining (floor 2.00; key:28.43 credits:31.56)`,
  `route OK on openrouter-prod / @preset/trades-seats — serving verified (tool call returned) served=meta/muse-spark-1.3`,
  `fallback lane verified — ~google/gemini-flash-latest emitted a tool call (served=google/gemini-3.8-flash)`;
  stamps `last-probe`,`last-fallback` in `/var/lib/nemoclaw-inference-medic`; timer active (next 17:37:18Z).
  First hand-run said IS NOT SERVING — it ran inside the ~60 s sandbox route-cache window (recorded above).
  md5s: medic `399c8514…` ×2, service `e9fbd818…`, timer `040a51e0…`, bootstrap `432f3727…` ×2 (post-fix).
- [x] six seats: `primary inference/meta/muse-spark-1.3`, ctx 262144 (s2 s3 s6 s7 s8) / 131072 (s5), `maxTokens 8192`,
  `input [text,image]`, `compat {supportsPromptCacheKey, supportsReasoningEffort, supportedReasoningEfforts}`,
  `openclaw config validate` → `Config valid` on all six, every gateway `http server listening`, Telegram polling on all;
  s3 no longer names `nemotron`. **The s2 canary caught `compat.supportsParallelToolCalls` as an illegal key
  (strict schema) — s2's gateway crash-looped ~5 min until the key was dropped; the other five were never exposed.**

### Live verification (agent-executable) — run by a fresh-context verifier (maker ≠ checker), 2026-09-05 17:34–17:49Z
- Prerequisites: `ssh tradesbox`; `supabase-test` MCP for the booking rows (pilot DB, read) — both connected.
- [x] **s2 first**: `openrouter-canary-20260905-173307` → "Friday 2026-09-11", 2× `trades-spine__resolve_date`,
  `"model":"meta/muse-spark-1.3"`, 25 s.
- [x] s2 rung-9a checks (customer Marcus Ellery, job `9b014ad9…`): **book with no time** → ONE step, reply
  "Booked … no time set yet", row `65ccece3…` `starts_at NULL`, `confirmed`, created 17:36:15Z (SQL read-back).
  **Move** → "next Tuesday" on a Saturday triggered the spine's own `resolve_date` ambiguity note and the
  seat asked (twice, deterministic — the date rail working, not the route); on "Tuesday 2026-09-08,
  10am to 11am" → ONE step, and `move_visit` cancels+recreates: old row `cancelled`, new row `4a599165…`
  `confirmed`, `starts_at 2026-09-08 10:00` (stored naive-local, `booking.ts:611`). **Unschedule the
  PLACED visit** → asked first (`needs_confirmation`, confirmId issued), row unchanged. Cleaned up by
  status flip (`cancelled`, reason `verification 2026-09-05`); no rows deleted; existing job reused.
- [x] **Reasoning lever** — FAILED first, then fixed and proven. The `/think` inline prefix is a no-op on the
  `agent` CLI path (passed to the model as text; it is the chat-path directive). With the CLI's
  `--thinking low|high`, OpenRouter returned `400 "reasoning_effort" and "reasoning.effort" are both
  provided with conflicting values`: the seats send `reasoning_effort`, the preset carried
  `reasoning.effort medium`, and the shallow merge kept both keys. **Preset v2 (17:52Z) removed
  `reasoning` from the preset**; re-run: `--thinking low` → 83 reasoning tokens (75+8), `--thinking high`
  → 727 (441+286), both "Friday 2026-09-11", zero errors, no new 400s on any seat. The session log
  carries `usage{input,output,cacheRead,cacheWrite,reasoningTokens,totalTokens,cost}` per call —
  Phase 5's cost evidence source. Within-turn caching works (`cacheRead 37745` on call 2 of a 37.7K-token prompt).
- [x] One dated turn per remaining seat, all "Friday 2026-09-11" via `resolve_date` on `meta/muse-spark-1.3`:
  s3 27 s (offered both Fridays), s5 20 s, s6 24 s, s7 27 s, s8 20 s. Prompt sizes 25–38K Muse tokens
  (technician seat smallest).
- Not determined: whether the Gemini lane ever engages under the preset — no eligible error occurred
  (a 400 is not failover-able). The lane itself is probed daily by the medic (`served=google/gemini-3.8-flash` 17:33Z).

### Manual verification
- [ ] User sends a **photo** to s2 on Telegram and the reply describes it.

---

## Phase 5: Re-measure, soak, record

### What this phase does
The blocking eval on a route where the harness's model check binds; a day of medic evidence; the record.

### Changes required
- Date eval (BLOCKING). Timer stopped. **If the lever check passed:** route
  `openrouter-prod / meta/muse-spark-1.3` directly. **If it failed** (gateway drops effort): a
  second preset `trades-seats-eval` (Muse only, effort medium, no fallback) and
  `DATE_EVAL_EXPECT_MODEL=@preset/trades-seats-eval` — same effort as production, exact-model
  gate still honest. `npm run date-eval:plan` then `npm run date-eval:run -- --dir <dir> --yes`
  (≈40 min, ≈$1.13); restore `@preset/trades-seats`; start the timer. Record the score beside
  the GLM 94/94 in `docs/engineering-memory.md`.
- Weekday-guard (INFORMATIONAL): replay the scanMessage corpus per `Box_Setup_Stuff/plugins/trades-weekday-guard/`; record vs 23/419.
- Soak 24 h: `journalctl -u nemoclaw-inference-medic.service --since -24h` → no false `AGENTS ARE DOWN`;
  `served=` Muse throughout or a logged fallback; balance delta ≈ ≤$0.10/day for the medic.
- Memory notes (local + engineering-memory): served-model truth; the $30 cap; probe cost table;
  `data_collection` and reasoning-lever outcomes. Plan `status: complete`; `npm run decisions:index`.

### Automated verification
- [x] date-eval passes its own gates (expected model matches the route; no refusal; no route change) — run `date-eval-runs/2026-09-05-muse/` (82 questions, route `openrouter-prod / meta/muse-spark-1.3` at start and after every question, timer stopped 18:09Z–18:58Z, 0 dead turns, 0 AGENTS.md truncation flags); route and timer restored 18:58Z
- [ ] `npm test` green after the record edits

### Live verification (agent-executable)
- [ ] the 24 h journal criteria, quoted into engineering-memory

### Manual verification
- [x] User accepts the date-eval score before the fleet is called "verified on Muse". — Both scores were on the table when the user ruled "Let's have gemini 3.8 flash as the primary model and Muse as the fallback then" (2026-09-05): **Muse 81/82, Gemini 80/82, 0 weekday↔date contradictions on either**; runs `date-eval-runs/2026-09-05-muse` ($5.33, median $0.064/q) and `date-eval-runs/2026-09-05-gemini` ($3.40, median $0.038/q), both on direct single-model routes with the timer stopped, both restored afterwards. Weekday-guard replay (INFORMATIONAL): 0 caught / 0 missed / 0 false positives on both, vs 23/419 on GLM.
- [x] **Rollout of the amendment (2026-09-05 20:27–20:35Z):** medic v7 installed (md5 `29b57c5f…` = repo) → preset **v3** designated (`POST /api/v1/presets/trades-seats/chat/completions` → 200; `GET` shows `models [google/gemini-3.8-flash, meta/muse-spark-1.3]`) → forced probe: `served=google/gemini-3.8-flash` as primary, no warning, `fallback lane verified — meta/muse-spark-1.3` → `wire s2` (model entry + `messages.inbound.debounceMs 2000`): gateway `http server listening (10 plugins)`, Telegram polling, canary turn correct with both generations on `google/gemini-3.8-flash-20260902` / Google → the other five seats wired.
