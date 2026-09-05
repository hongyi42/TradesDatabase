---
date: 2026-09-05
branch: main
commit: 217cf81
topic: Switching the six-seat fleet from Fireworks/GLM-5.2 to OpenRouter/google/gemini-3.8-flash — the full footprint
supersedes: nothing
---

**`supersedes:`** — this document overturns no prior decision. It *extends* the switch
precedent set by [2026-08-18-deepinfra-retirement.md](2026-08-18-deepinfra-retirement.md)
(DeepInfra → Fireworks) to a new provider AND a new model family. The no-fallback ruling
(2026-08-12) and the Fireworks primary (2026-08-15) are still in force at HEAD; this document
records what changing the model underneath them would touch. It does not retire them.

## Summary

The six seat agents (`s2 s3 s5 s6 s7 s8`) — the Telegram assistants that managers and
technicians text — do not each choose their own model. They all speak to one local endpoint,
`https://inference.local/v1`, which is the **gateway**: a credential-injecting proxy that
rewrites whatever model the sandbox asked for into the one model the gateway is configured to
serve. Today that is Fireworks' GLM-5.2 fast router, and Fireworks is out of credits, so the
whole fleet is dead. Switching to OpenRouter means registering one new provider in the
gateway's registry and repointing one route — but the route is re-asserted every five minutes
by a self-healing systemd unit (`nemoclaw-inference-medic`), so the medic, not the route, is
the real source of truth. That medic also decides whether the fleet is "up", and it decides it
by asking the model a date question and requiring a **tool call** in reply. That gate is
model-specific, and the medic's own header says so in as many words.

The single most consequential fact found: **`google/gemini-3.8-flash` has
`reasoning.mandatory: true`** — thinking cannot be switched off, at any effort level. Every
turn will spend output-priced reasoning tokens before it emits anything, and the medic's probe
allows only `max_tokens: 512` for the whole reply. That is the same class of trap as the
recorded GLM one (`glm-default-think-blows-small-budgets`), except unfixable by disabling
reasoning. The second: **Gemini prompt caching on OpenRouter requires explicit `cache_control`
breakpoints**, which the gateway's plain OpenAI-completions dialect does not send — and the
existing agentic baseline ran at a **93% cached-input rate** on Fireworks.

> **Amendment 2026-09-05 (measured, supersedes the sentence above).** Gemini 3.8 Flash caches
> **implicitly** through the gateway's plain OpenAI-completions requests — no `cache_control`
> needed. Direct probe: identical 27,575-token prompt twice → second call `cached_tokens` 24,542,
> cost $0.0207 → $0.0041. Fleet requests during the 2026-09-05 Gemini date-eval: call 2 of every
> session read 28,002 of 32,260 tokens from cache. The catch is that the implicit cache is
> **session-sticky**: the FIRST call of every fresh session missed (0 cached — P01–P04 all), because
> OpenRouter's `prompt_cache_key` (= the openclaw session id) pins routing to one Google replica and
> a new id lands cold; Muse's cache is prefix-global and hit 99.4% on fresh sessions. Explicit
> `cache_control: {type:"ephemeral"}` breakpoints do better — 27,569/27,575 cached, read $0.0021, and
> a never-seen-before write billed only $0.0041 for 33,486 tokens (cache-read price + storage
> surcharge, NOT the docs' "input price + storage" formula; both measured via `usage.cost`) — but
> openclaw 2026.6.34 can only emit them for provider `openrouter` + `anthropic/*` model ids
> (`openai-completions.js:1076`, `createOpenRouterSystemCacheWrapper` requires `isAnthropicModelRef`),
> and `compat.cacheControlFormat` is not a key the strict config schema accepts (it exists only in the
> runtime catalog's TypeBox type, `sessions-*.js:1244`). Reaching explicit caching from the seats
> would need a payload-patch plugin. Pricing source: `GET /api/v1/models` 2026-09-05 —
> gemini-3.8-flash prompt $0.75/M, `input_cache_read` $0.075/M (0.1×, not the docs page's 0.25×),
> `input_cache_write` $0.0417/M, completion and reasoning $3.75/M.
> Docs: https://openrouter.ai/docs/features/prompt-caching (fetched 2026-09-05: "Implicit caching
> works seamlessly — no manual setup or additional `cache_control` breakpoints required"; TTL
> "5 minute … that does not update").

## Entry Points

| Where the switch is actually made | File / command |
|---|---|
| Provider registry (add OpenRouter) | `openshell provider create -g nemoclaw --name <n> --type openai --credential OPENAI_API_KEY --config OPENAI_BASE_URL=…` |
| The live route (fleet-wide, one) | `openshell inference set -g nemoclaw --provider <p> --model <m>` |
| **What re-asserts the route every 5 min** | `Box_Setup_Stuff/nemoclaw-inference-medic.sh:103-104` (`WANT_PROVIDER` / `WANT_MODEL`) → deployed at `/usr/local/sbin/nemoclaw-inference-medic.sh` |
| Per-seat model id + context metadata | `/sandbox/.openclaw/openclaw.json` → `agents.defaults.model.primary`, `models.providers.inference.models[0]` |
| Seat provisioning default | `Box_Setup_Stuff/bootstrap-box.sh:239` (`NEMOCLAW_MODEL`) |
| Post-onboard route flip | `Box_Setup_Stuff/bootstrap-box.sh:286-287` |
| Onboard cheat-sheet text | `Box_Setup_Stuff/bootstrap-box.sh:171-177` |
| Incident runbook | `docs/inference-recovery-runbook.md` |
| The test that pins the medic | `src/control/inferenceMedicScript.test.ts` |

## Key Files

- **`Box_Setup_Stuff/nemoclaw-inference-medic.sh`** (252 lines) — the fleet's health authority
  and route-holder. `WANT_PROVIDER=fireworks-prod` (:103), `WANT_MODEL=accounts/fireworks/routers/glm-5p2-fast`
  (:104), `PROBE_TIMEOUT=40` (:110), `RETRY_SLEEP=2` (:111). Functions: `set_route` (:117),
  `probe_container` (:120), `probe_payload` (:134), `probe_completion` (:180), `try_provider`
  (:196), `main` (:230).
- **`src/control/inferenceMedicScript.test.ts`** (~290 lines) — executes the *repo copy* of the
  medic against bash shims and asserts its decision table. **17 provider-name references.**
- **`Box_Setup_Stuff/bootstrap-box.sh`** (95,555 bytes) — provisioning + `wire`. Writes the seat
  prompt into `/sandbox/.openclaw/workspace/AGENTS.md` in delete-then-append blocks (:585-717+)
  and the openclaw.json tool-trim/reasoning block (:1272-1290).
- **`docs/inference-recovery-runbook.md`** — the incident procedure. Entirely Fireworks-shaped.
- **`scripts/date-eval/plan.mjs:181`, `scripts/date-eval/run.mjs:189-193`** — the date eval's
  expected-model gate.
- **`docs/eval-baselines/agentic-glm-2026-08-24.{meta.json,results.jsonl}`** — the 65-scenario
  agentic baseline, `model: accounts/fireworks/routers/glm-5p2-fast`.
- **Systemd (all four in sync repo↔box, verified by md5)** — `nemoclaw-inference-medic.service`
  `934b225a…`, `.timer` `fc62e905…`, `ops-report-medic-down.service` `e98e965d…`,
  `ops-report-medic-ok.service` `cff7d617…`.

## Data Flows

### The request path (and where the model is actually decided)

```
 s2 … s8   openclaw agent in a docker sandbox
   │  openclaw.json: model.primary = "inference/z-ai/glm-5.2"
   │                 provider "inference" → baseUrl https://inference.local/v1
   │                 apiKey "unused"  ·  api "openai-completions"
   ▼
 THE GATEWAY (openshell-gateway.service)
   │  ONE inference route for the whole fleet:
   │     provider fireworks-prod  ·  model accounts/fireworks/routers/glm-5p2-fast
   │  → OVERRIDES the requested model, injects OPENAI_API_KEY from the provider store
   ▼
 Fireworks  ──►  402 out of credits  ──►  every seat dead
   ▲
   │ re-asserted on boot + every 5 min
 nemoclaw-inference-medic.timer → .service → /usr/local/sbin/nemoclaw-inference-medic.sh
       gate 1  registration: `openshell inference set` (live-validates endpoint+key)
       gate 2  completion:  docker exec -u sandbox sh -lc curl https://inference.local/v1
                            must return  data: [DONE]  AND  "finish_reason":"tool_calls"
       OnSuccess → ops-report-medic-ok.service   OnFailure → ops-report-medic-down.service
```

The gateway rewriting the model id is why the sandbox says `z-ai/glm-5.2` while Fireworks
serves `glm-5p2-fast`, and why **`nemoclaw <seat> inference` does not exist** in this build
("command inference not found"). There is no per-seat route: the switch is atomic across all
six seats and cannot be canaried one seat at a time.

### The medic's probe, exactly

`probe_payload()` (`nemoclaw-inference-medic.sh:134-152`) posts a quoted heredoc:

- **system**: *"You are the assistant for a trades firm. Use tools for anything factual about
  the schedule, customers, or jobs. Never do calendar arithmetic yourself."*
- **user**: *"What date is this coming Friday?"*
- `"max_tokens": 512`, `"stream": true`
- **three real spine tool schemas** lifted from `src/mcp/server.ts` — `find_customer` (flat),
  `record_field_note` (nested object), `resolve_date` (long, enum-heavy). Measured at 864
  prompt tokens.
- **no `tool_choice`** — the model must *decide* to call `resolve_date` unprompted.

Pass requires **both** (`:186-187`):
```bash
grep -qF 'data: [DONE]'            <<<"$body" || return 1
grep -q  '"finish_reason":"tool_calls"' <<<"$body"
```
One retry on a miss (`:212-217`); two consecutive misses is the verdict. `-u sandbox` **and** a
login shell (`sh -lc`) are load-bearing — the container's egress env is assembled in the
sandbox user's login profile, and a bare root `docker exec curl` returns empty from a perfectly
healthy provider (medic v3's first live run, 2026-08-11).

### Decision table (`main`, `:230-252`)

| Condition | Result |
|---|---|
| registration ok + completion ok | `route OK on <provider> / <model> — serving verified`, exit 0 |
| registration ok + completion fails twice | route **held** on primary, exit 1 LOUD, "AGENTS ARE DOWN" |
| registration fails | exit 1 LOUD |
| no sandbox container | registration only, exit 0 + WARN |
| any outcome | **the route is never set to anything but the primary** — no fallback, by decision |

## External Dependencies

All OpenRouter facts below were verified live on 2026-09-05 against the vendor, per CLAUDE.md.

**`google/gemini-3.8-flash`** — `GET https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints`:

- **Hosts: Google only** — two lanes, `Google AI Studio` and `Google` (Vertex). Memory
  `gemini-37-flash-tps` ("only Google hosts Gemini") **still holds for 3.8**. OpenRouter's
  cross-vendor failover therefore buys *nothing* for this model; the stated benefit is
  model-switching ease, not redundancy.
- `context_length` **1,048,576**; `max_completion_tokens` **65,536**.
- `supported_parameters`: `tools`, `tool_choice`, `reasoning`, `reasoning_effort`,
  `include_reasoning`, `max_tokens`, `response_format`, `structured_outputs`, `seed`,
  `temperature`/`top_p` (**AI Studio lane only**), `stop` (**Vertex lane only**).
  **No `parallel_tool_calls`** — GLM-5.2/5.3 have it, Gemini does not.
- **`reasoning: {"mandatory": true, "default_enabled": true, "supported_efforts":
  ["high","medium","low"], "default_effort": "medium"}`.** Compare `z-ai/glm-5.2`:
  `"mandatory": false`. There is no `none`/`minimal` effort for Gemini 3.8 Flash.
- Pricing (standard tier) `prompt $0.75/M`, `completion $3.75/M`,
  **`internal_reasoning $3.75/M`** (reasoning billed as output),
  `input_cache_read $0.075/M`, `input_cache_write $0.0417/M`. The endpoints call returns
  **three price tiers** per lane (0.375/1.875, 0.75/3.75, 1.35/6.75) — consistent with Gemini's
  prompt-size tiering; which tier applies at which token count is **not** stated by the API and
  is an open question below.
- Some endpoint records carry `status: -2` alongside `status: 0` — deranked/degraded lanes
  exist at any moment; OpenRouter picks among them.

**Docs, cited:**

- Reasoning — https://openrouter.ai/docs/use-cases/reasoning-tokens : *"Reasoning tokens are
  considered output tokens and charged accordingly."* For Anthropic it states **"`max_tokens`
  must be strictly higher than the reasoning budget"**; the same arithmetic applies wherever
  reasoning shares the completion budget. On Gemini 3, *"specifying `max_tokens` … results in
  Google internally mapping this to a `thinkingLevel`"* — so the reasoning budget is **not
  precisely controllable**. `effort: "none"` / `enabled: false` disable reasoning **on models
  where it is not mandatory**; 3.8-flash is mandatory.
- Prompt caching — https://openrouter.ai/docs/features/prompt-caching. **CORRECTED 2026-09-05
  (the original reading of this page was wrong — see the amendment at the top).** The page's
  `cache_control` sentence is scoped to OLDER Gemini models; the same section says *"Gemini 2.5
  series models and newer support implicit caching … no manual setup or additional
  `cache_control` breakpoints required"*, and 3.8-flash is newer. Measured: implicit caching DOES
  engage through the gateway's plain requests. Explicit breakpoints still cache more (99.98% vs
  ~89%) because the implicit cache is session-sticky. TTL *"5 minute … that does not update"*;
  Flash minimum **1,024 tokens**. `prompt_cache_key` is honoured **as a sticky-routing key**, not as a cache enabler:
  *"If neither [session_id nor header] is set, OpenRouter falls back to the OpenAI-style
  `prompt_cache_key` request field as the sticky routing key."*
- Headers — https://openrouter.ai/docs/api-reference/overview : `HTTP-Referer` and `X-Title` are
  **optional** ("optional headers to identify your app"); only `Authorization: Bearer` is
  required. **The `type: openai` provider shape is therefore sufficient — no header blocker.**

**The key.** The box has **no** OpenRouter key (`printenv OPENROUTER_API_KEY` → unset in the
login env). The only key in play is the planner's, in the repo `.env`: paid
(`is_free_tier: false`), `limit $30/month`, `limit_remaining $28.53`, `usage_monthly $1.47`,
no expiry. Per user ruling 2026-09-05 the fleet will share it for now ("this is testing suite").
**Exposure, recorded not litigated:** fleet spend and planner spend then draw on one $30 cap, so
exhausting it stops the pilot's 15-minute planner tick as well as the seats. `limit_reset` is
monthly.

## Constraints and Invariants

1. **The route is fleet-wide and atomic.** No per-seat inference command exists in this build.
2. **The medic owns the route.** A hand-run `openshell inference set` is reverted within 5
   minutes. `docs/inference-recovery-runbook.md:164` states the rule: *"Do not hand-run
   `openshell inference set` without stopping the medic timer first."*
3. **No fallback, by explicit user decision (2026-08-12).** Re-adding one must be a deliberate
   change that also changes `inferenceMedicScript.test.ts`.
4. **The medic's probe is a model assumption, not a provider assumption.** Its own header:
   *"if the routed model ever changes, re-validate the probe against it FIRST, or a model that
   answers the date in prose gets reported dead while healthy."*
5. **`openclaw config patch` is never used.** Seat config is written as: `nemoclaw <seat> upload`
   the new JSON → write `.config-hash` → `chmod 660` → `nemoclaw <seat> gateway restart`
   (`bootstrap-box.sh:1284-1288`). `exec` eats stdin, so every call takes `</dev/null`.
6. **`nemoclaw` is on the login PATH only** (`/home/ubuntu/.local/bin`) — always `bash -lc`.
7. **DRIFT, live: the deployed medic ≠ the repo medic.** repo `49fd6425c00740fdf92b5f786647b432`,
   box `0921ab1e21d88a4ef38a1da4c044fc0f`. Exactly **one line** differs (:149): the probe's
   `record_field_note` description. The repo carries the current one-call wording ("ONE call:
   pass the text and it is recorded"); the box still carries the retired two-step wording
   ("two-step. First call with text: NOTHING is recorded"). Functionally inert for the probe —
   it only needs *some* tool call — but it proves the medic's deploy step is separate from the
   repo edit and has already been missed once.
8. **Seven `bootstrap-box.sh` copies exist on the box**, at five distinct vintages. Only two
   match the repo (`52edc6c73a5b131fbe24baa00ff15b0d`):
   `/home/ubuntu/Box_Setup_Stuff/` and `/usr/local/sbin/`. Stale:
   `/home/ubuntu/bootstrap-box.sh` `746911…`, `/home/ubuntu/bss-repo/` and
   `/home/ubuntu/stage-deepinfra-retire/` both `973afe2f…`, `/home/ubuntu/deploy-recycler/`
   `dadbf315…`, `/home/ubuntu/Box_Setup_Stuff.prev-20260825/` `82751ab6…`.
9. **Seat provisioning still requires an NVIDIA key.** `bootstrap-box.sh:236` —
   `need_secret NVIDIA_INFERENCE_API_KEY`; onboard runs on NVIDIA, then :286 flips the route.
   A provider switch does not remove that dependency for *new* seats.
10. **`inference.local` silently follows the route**, so a provider flip invalidates any latency
    measurement taken across it (`docs/engineering-memory.md:3078`).
11. **s3 is drifted.** Its `model.primary` is `inference/nvidia/nemotron-3-super-120b-a12b`;
    the other five are `inference/z-ai/glm-5.2`. Because the gateway overrides the model id,
    this has had no functional effect — it only mislabels s3's logs and errors.
12. **The seat prompt is model-agnostic.** `/sandbox/.openclaw/workspace/AGENTS.md` on s2:
    **33,473 bytes, 21 `##` sections, zero** matches for glm/gemini/fireworks/deepinfra. The
    rung-9a confirmation doctrine (6 rules) is among those sections and names no model.

## What a model switch invalidates

Everything below was measured on GLM-5.2. None of it is evidence about Gemini 3.8 Flash.

| Item | Where | What it measured | Status after a switch |
|---|---|---|---|
| **Date-eval expected-model gate** | `scripts/date-eval/plan.mjs:181`; `run.mjs:189-193` | Refuses to run unless the live route's model **exactly** equals `accounts/fireworks/routers/glm-5p2-fast`; re-checked after **every** question | **BLOCKING — operationally red.** The eval cannot run at all until the default (or `DATE_EVAL_EXPECT_MODEL`) is updated |
| **Date-reliability result** (100%, 94/94, v3) | memory `date-eval-phase-attribution`; `scripts/date-eval/` | GLM-5.2's date accuracy incl. the evening adversarial regime | **BLOCKING** — must be re-run; date safety is a standing product invariant (`humans-never-check-dates`) |
| **Agentic baseline** | `docs/eval-baselines/agentic-glm-2026-08-24.{meta,results}` | 65 scenarios; ledger 1,302,601 cached-input vs 92,948 input vs 157,346 output tokens | **INFORMATIONAL as history; invalid as a comparison basis.** Note the **93% cached-input rate** — see cost, below |
| **Weekday-guard plugin** | `Box_Setup_Stuff/plugins/trades-weekday-guard/` | Failure rate 23/419, 0 false positives, on GLM | Plugin **code is model-agnostic** (no model reference; it scans messages). Its **rate is not** — INFORMATIONAL, re-measure to keep the claim honest |
| **Tool-schema latency finding** | memory `agent-turn-latency-tool-schemas` | one 13-deep schema = 67s→3s | INFORMATIONAL — schema-shape effects are model-specific |
| **Tool deny list + `toolSearch:false` rationale** | `bootstrap-box.sh:1260-1290` | token/latency cost of 39 flat-schema tools | INFORMATIONAL — the reasoning is about prompt size, largely portable |
| **Date scaffolding verdict** | memory `opus5-date-scaffolding-verdict` | GLM needs scaffolding, Opus does not | INFORMATIONAL — explicitly a per-model finding |

### Cost shape

The seat prompt alone is **33,473 bytes** (~8.4K tokens) before tool schemas and history. On
Fireworks the agentic baseline ran **93% cached input**. **CORRECTED 2026-09-05 by measurement
(this paragraph predicted the opposite):** Gemini caches IMPLICITLY through the gateway's plain
`openai-completions` requests — no `cache_control` needed. `prompt_cache_key` (which the seats do
set) pins **sticky routing**, and that is precisely what makes the implicit cache session-sticky:
the first call of a fresh session misses, later calls in the same session hit. The 82-question
eval ran **61.4% cached across the whole run** (call 2 of every session read 28,002 of 32,260
tokens). Actual shape: **$0.038 per question**, cached input at $0.075/M, uncached at $0.75/M,
mandatory reasoning billed at $3.75/M.

Per `never-size-from-the-pilot-box`, no per-turn figure is derived here from accumulated box
state — the numbers above are the eval harness's own recorded ledger and the vendor's published
rates. A driven measurement is what would settle actual cost.

## Blast radius and rollback

**Not affected.** The five Render services do not use the gateway. The spine calls OpenRouter
directly (`docs/inference-recovery-runbook.md:6-19`), which already documents the split:

| | provider | model | failover |
|---|---|---|---|
| Seat agents (the boxes) | Fireworks | `accounts/fireworks/routers/glm-5p2-fast` | none, by design |
| Spine (Render web + `lifecycle-heart`) | **OpenRouter** | `z-ai/glm-5.3` | ~10 upstream providers, automatic |

After this change both sides sit on OpenRouter with **different models** and, under the accepted
ruling, **the same key**. The runbook's headline table becomes wrong on the fleet row and on the
"different providers" framing.

**Also reaching `inference.local`:** only the medic (`nemoclaw-inference-medic.sh:183`) and the
seats. `scripts/spine-eval/run-gateway.mjs:29` targets it for gateway-based evals, and a
documented `getaddrinfo EAI_AGAIN inference.local` false-negative exists
(`docs/engineering-memory.md:3136-3142`).

**Rollback.** `openshell inference set -g nemoclaw --provider fireworks-prod --model
accounts/fireworks/routers/glm-5p2-fast` **plus** reverting `WANT_PROVIDER`/`WANT_MODEL` in
both the repo and `/usr/local/sbin/` copies of the medic — the route alone is reverted by the
medic within 5 minutes, in whichever direction the medic disagrees. **Stated plainly: rolling
back to Fireworks restores the OLD OUTAGE, not service** — that account is out of credits, which
is the reason for this change. The other registered providers (`deepinfra-prod`, `nvidia-prod`,
`nebius-trial`, `anthropic-eval`) are inert and unverified; `nvidia-prod`'s history
(400s on every real turn while passing a weak probe) is the precedent that produced the
no-fallback rule.

## Tests and CI that would turn red

| File | Nature | Detail |
|---|---|---|
| **`src/control/inferenceMedicScript.test.ts`** | **HARD PIN — will fail** | Runs the repo medic. Asserts `'route OK on fireworks-prod'`, `activeRoute()` `.toBe('fireworks-prod')` in **4** places, shims keyed on `fireworks-prod`/`deepinfra-prod`/`nvidia-prod`, and bans the substrings `'nvidia'` and `'deepinfra'` from medic output. Also pins the v3/v5 invariants (prose → not serving; truncated stream → not serving; flaky → one retry; no container → registration only) |
| `scripts/date-eval/plan.mjs:181` + `run.mjs:189-193` | **HARD GATE — refuses to run** | Expected-model equality check, re-verified after every question |
| `src/telegram/opsNotify.test.ts:59,62` | Fixture, cosmetic | Feeds `'fireworks-prod / accounts/…glm-5p2-fast'` as input and asserts `toContain('route: fireworks-prod')` — tests formatting, not the live route |
| `src/db/opsEvents.test.ts:55` | Fixture, cosmetic | `'deepinfra-prod IS NOT SERVING'` as a stored detail |
| `src/mcp/httpServer.test.ts:380` | Fixture, cosmetic | same shape |
| `supabase/migrations/20260815120000_fireworks_rates.sql`, `20260725120000_cost_ledger.sql` | Cost-ledger SKUs | Fireworks/GLM SKU rows exist; OpenRouter/Gemini SKUs do not. Cost attribution for seat traffic would land unpriced until added |

## Documentation carrying the old provider/model

`docs/engineering-memory.md` (29 hits) · `docs/inference-recovery-runbook.md` (7, incl. the
headline table and the Fireworks billing URL) · `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`
(12) · `Box_Setup_Stuff/doorman-architecture-memory.md` (11) ·
`Box_Setup_Stuff/bootstrap-box.sh` (7: :171-177 onboard cheat sheet, :239 `NEMOCLAW_MODEL`,
:286-287 route flip) · `Box_Setup_Stuff/nemoclaw-inference-medic.sh` (13) ·
`Box_Setup_Stuff/apply-bakein.py` (3) · `scripts/date-eval/README.md`,
`scripts/provider-trial/*.mjs`.

## Decision Points

**(a) `contextWindow` declared per seat.** Today every seat declares `131072`; Gemini's real
window is `1048576`. Leaving 131072 under-declares (openclaw compacts earlier than it must);
raising it to 1M lets sessions grow ~8x larger, and each turn re-sends the whole history as
uncached input at $0.75/M — with box memory at ~415MB/turn and concurrency the known hazard
(`lightsail-box-capacity`). Any value between is available.

**(b) `maxTokens` per seat (today 4096) and `max_tokens` in the medic probe (today 512).**
Reasoning is mandatory on 3.8-flash and is billed as output, and OpenRouter's docs say the
budget must leave room for the answer. Raising them buys headroom against truncation at
`finish_reason: "length"` and costs output tokens; leaving them risks turns and probes that
truncate mid-reasoning. The ceiling is 65,536. Google maps a reasoning budget to an internal
`thinkingLevel`, so precise control is not available.

**(c) What the medic's probe becomes.** Options: keep the turn-shaped tool-call gate unchanged
(strongest signal; risks a false "AGENTS ARE DOWN" if Gemini answers the Friday question in
prose or truncates inside reasoning); raise only `max_tokens`; add `tool_choice: "required"`
(note the recorded calibration: *tool_choice does not rescue a small budget* — GLM spent all 32
tokens reasoning and returned `tool_calls: []`); or relax the gate to "stream closed cleanly".
Relaxing re-opens the exact v3 blind spot that `inferenceMedicScript.test.ts` exists to prevent.
**Whatever is chosen, the medic's header requires re-validating the probe against the new model
before it is trusted** — and that re-validation was deliberately not run in this read-only pass.

**(d) s3's drifted model id** (`nvidia/nemotron-3-super-120b-a12b`) — normalize with this change
or leave it. It is cosmetic today because the gateway overrides it, but it makes s3's logs and
error messages name a model that is not serving.

**(e) Provider registry naming and what stays.** A name matching the `-prod` convention
(e.g. `openrouter-prod`) vs something else; and whether `fireworks-prod`, `deepinfra-prod`,
`nvidia-prod`, `nebius-trial` remain registered as inert rollback targets or are deleted. The
no-fallback rule bans *routing* to them, not their registration; `inferenceMedicScript.test.ts`
bans the strings `nvidia` and `deepinfra` from medic **output**.

**(f) Pin `google/gemini-3.8-flash` or float `~google/gemini-flash-latest`.** The user's stated
reason for OpenRouter is ease of model switching. The floating alias makes switching automatic
but means the fleet's model can change without a commit — and every eval, baseline and the
date-eval's exact-string gate assume a stable model id. The pinned id keeps runs reproducible
and makes each switch an explicit change.

**(g) Whether the seats declare the model honestly.** `openclaw.json` currently names
`z-ai/glm-5.2` while `glm-5p2-fast` is served — the gateway override makes the declared id
cosmetic. It is what appears in agent error messages (which is how this session identified the
outage) and in trajectories; `docs/inference-recovery-runbook.md:153-154` already warns that the
trajectory does not tell you which provider served. Updating it to `google/gemini-3.8-flash`
makes logs truthful; leaving it preserves the existing indirection.

**(h) Cost-ledger SKUs.** Fireworks/GLM SKUs exist in
`supabase/migrations/20260815120000_fireworks_rates.sql`; OpenRouter/Gemini rates do not.
Seat-traffic cost attribution stays unpriced until rows are added.

## Open Questions

1. **Does Gemini 3.8 Flash emit a tool call for the medic's exact probe within 512 tokens?**
   The single question that decides whether the fleet reports itself up. Answerable only by
   running the payload against the model — deliberately not done in this read-only pass.
2. **At what prompt size does the higher price tier engage?** The endpoints API returns three
   tiers (0.375/1.875, 0.75/3.75, 1.35/6.75 per M) without stating the breakpoints. Load-bearing
   for decision (a) — a 1M window may cost 1.8x per token, not just more tokens.
3. **Does the gateway forward `reasoning` / `reasoning_effort` at all?** If not, the fleet gets
   `default_effort: "medium"` with no lever, and (b) becomes the only control.
4. ~~**Does openclaw's `openai-completions` dialect send `cache_control` breakpoints?**~~
   **ANSWERED 2026-09-05: it does not — and it does not need to.** openclaw emits breakpoints only
   for provider `openrouter` + an `anthropic/*` model id
   (`openai-completions.js:1076`, `createOpenRouterSystemCacheWrapper`), and
   `compat.cacheControlFormat` is not a key the strict config schema accepts. But Gemini caches
   implicitly anyway (measured), so the caching economics DO carry over — at 61% rather than the
   93% Fireworks reached, because the implicit cache is session-sticky.
5. **Does the gateway send `temperature`?** The Vertex (`Google`) lane does not list
   `temperature`/`top_p` as supported while the AI Studio lane does — sending it may silently
   narrow routing to one lane.
6. **Does OpenRouter's SSE emit the exact byte sequence `"finish_reason":"tool_calls"`?** The
   medic greps for it with no whitespace tolerance (`:187`).
7. **What re-deploys the medic to `/usr/local/sbin/`?** The repo↔box drift shows the copy step is
   manual and has already been missed; no automated sync was found.
