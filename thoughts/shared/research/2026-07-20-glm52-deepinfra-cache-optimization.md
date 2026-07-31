---
date: 2026-07-20
topic: Can we cut inference cost by raising the GLM-5.2 prompt-cache hit rate on DeepInfra?
context: >
  Observed spend $30 with 9.9M cached input tokens (~25% estimated hit rate at the fleet's
  ~230:1 input:output ratio). Boxes run GLM-5.2 via the OpenShell gateway's deepinfra-prod
  provider (medic fails over to nvidia-prod free tier). Question: how much of the bill can
  better caching recover, and which knobs are actually ours?
---

## Summary

Yes — there is real, actionable headroom, and the single biggest knob is a **one-line opt-in
flag in our own agent stack** that we are not using: OpenClaw supports forwarding
`prompt_cache_key` (session-scoped) on OpenAI-compatible completions, but only for providers
that opt in via `compat.supportsPromptCacheKey`; our sandboxes' only provider (`inference`,
the managed gateway route) has `compat: null`, so **no cache key is sent today**. DeepInfra
explicitly supports `prompt_cache_key` to raise hit rates. Realistic outcome is roughly a
**2–3× cut** in input spend (blended $0.74/1M → ~$0.26–0.41/1M at 70–90% hits). The hard
ceiling is GLM-5.2's cached rate itself ($0.18/1M) — which is still **2× the *uncached*
price of DeepSeek V4 Flash ($0.09/1M)**. So cache tuning and the model swap are not
alternatives: the flag is model-agnostic and helps either model; the swap moves the ceiling.

## Verified vendor facts (live, 2026-07-20)

- **DeepInfra prompt caching** ([docs](https://docs.deepinfra.com/chat/prompt-caching)):
  automatic KV prefix reuse; prefix must be byte-identical ("put stable content first…
  avoid dynamic content like timestamps"); "cache entries expire after a period of
  inactivity" — **TTL undisclosed**; caches are **per-model and per-account**; optional
  **`prompt_cache_key`** — requests sharing a key + model share a KV cache; recommended
  value is a session-scoped key (`userid-chatsessionid`); hits reported in
  `usage.prompt_tokens_details.cached_tokens`.
- **GLM-5.2 on DeepInfra** ([model page](https://deepinfra.com/zai-org/GLM-5.2/api)):
  $0.93/1M input, $3.00/1M output, **$0.18/1M cached input**.
- **DeepSeek V4 Flash on DeepInfra** ([model page](https://deepinfra.com/deepseek-ai/DeepSeek-V4-Flash/api)):
  $0.09/1M input, $0.18/1M output, **$0.018/1M cached input**.
- **GLM-5.2 elsewhere among our four gateway profiles**: Bedrock (`zai.glm-5`) and Vertex
  (`glm-5-maas`) serve it per-token at ~$1.40/$4.40 ([aggregator](https://pricepertoken.com/pricing-page/model/z-ai-glm-5.2),
  [OpenRouter](https://openrouter.ai/z-ai/glm-5.2)) — more expensive than DeepInfra, and
  neither documents a GLM cache discount. NVIDIA free tier is $0 but capacity-capped
  (32 concurrent/worker — rate-limited busy agents before; medic history). Z.ai first-party
  is unreachable: the gateway has no profile for it (live `openshell provider list-profiles`
  2026-07-20: aws-bedrock, deepinfra, google-vertex-ai, nvidia only).

## Verified box facts (live on trades-box-1, 2026-07-20)

- Installed agent: **OpenClaw 2026.5.27** (`/usr/local/lib/node_modules/openclaw`).
- Its CHANGELOG + transport code confirm: `prompt_cache_key` is forwarded on Completions
  **only when the provider's model entry sets `compat.supportsPromptCacheKey: true`**
  ("keeping default proxy payloads unchanged", fixes #69272; flag introduced in #67427).
  Value derivation in `dist/openai-transport-stream-*.js`: `promptCacheKey ?? options?.sessionId`
  — i.e. **defaults to the session ID**, exactly DeepInfra's recommended shape.
  The transport logs `promptCacheKey=present|absent` per request — a clean verification marker.
- s2's rendered `/sandbox/.openclaw/openclaw.json`: single provider `inference`
  (`https://inference.local/v1`), model entry `compat: null` → **flag off fleet-wide today**.
- No heartbeat/idle-polling config in the live sandbox config; no timestamp-injection
  markers found in the prompt-building code (prefix appears stable — consistent with the
  observed partial hits).
- s2's `AGENTS.md` is 20,354 bytes (≈5k tokens) — re-sent in the prefix of every model call.

## Why the hit rate is ~25% today

Within one message's tool loop, consecutive calls share their growing prefix → hits.
Across messages, two loss mechanisms (indistinguishable from the dashboard alone):

1. **Inactivity eviction** — chat gaps exceed DeepInfra's undisclosed TTL, so each new
   message re-buys the whole accumulated prefix at $0.93/1M.
2. **Routing misses** — without a cache key, nothing steers a session's requests to the
   backend replica holding its KV cache; DeepInfra's own docs position `prompt_cache_key`
   as the fix.

Enabling the flag addresses (2) directly and improves (1)'s odds (repeated touches on one
entry). It cannot beat a genuinely expired cache — no knob of ours controls TTL.

## The math

Blended input price = h×$0.18 + (1−h)×$0.93 (GLM) at hit rate h; observed window ≈ 40M
input tokens / $30:

| Hit rate | GLM blended /1M | ≈ bill | V4 Flash blended /1M | ≈ bill |
|---|---|---|---|---|
| 25% (today) | $0.74 | $30 | $0.072 | $2.90 |
| 50% | $0.56 | $23 | $0.054 | $2.20 |
| 70% | $0.41 | $17 | $0.040 | $1.65 |
| 90% | $0.26 | $11 | $0.026 | $1.10 |
| 100% (ceiling) | $0.18 | $7.70 | $0.018 | $0.80 |

Orthogonal volume levers multiply with any row: session resets between E2E batches
(shrinks the history re-bought each message — the dominant prefix component late in a
session), trimming AGENTS.md, and curating the manager Composio tool surface.

**Rejected: cache-warming pings.** At a 40k-token late-session prefix, a keep-warm request
costs ~$0.0072 (cached rate on the whole prefix); one avoided cold re-buy saves ~$0.03.
With TTL undisclosed, break-even needs sustained sub-15-minute message cadence — true only
during dense testing bursts, pure waste when idle. Not worth engineering against an
undocumented TTL.

## Trial log — APPLIED to s2 (2026-07-20)

Owner decisions: **GLM-5.2 stays** (Nemotron — a larger model than V4 Flash — was not up to
quality, so flash-tier models are ruled out); trial on **@ragisan_bot = s2** (the owner's
manager seat; mapping per engineering-memory §4 sandbox map, TG 5801703167 matches s2's
allowed ID). s3 (real beta — hands off), s5, s6 untouched.

What was done (evidence captured in-session):

1. Backup: `/sandbox/.openclaw/openclaw.json.bak-cachekey-20260720` (6,119 B, original mtime kept).
2. Patch: `models.providers.inference.models[0]` (id `z-ai/glm-5.2` — the known cosmetic
   spelling; the gateway route forces the DeepInfra id per request) `compat: null` →
   `{"supportsPromptCacheKey": true}`.
3. `.config-hash` regenerated (`sha256sum openclaw.json > .config-hash` — verified that is the
   stored format, previous hash matched the file byte-for-byte). Both files kept `660 sandbox:sandbox`.
4. `nemoclaw s2 gateway restart` → "✓ Gateway restarted; health passed; forwards
   checked/recovered for 's2'."

Verification state (updated after the owner's live test message, 2026-07-20 ~23:56Z):
- **The `promptCacheKey=` marker is NOT emitted at s2's default log level** — zero occurrences
  (present *or* absent) across the whole gateway log. Marker absence is inconclusive by design;
  skip it as a check unless debug logging is enabled.
- Content-free health signals after the test message: turn activity processed 23:56:04; **zero**
  HTTP 4xx/5xx patterns in the post-change window; error-word rate 7 per 60KB vs 38 per 60KB in
  a pre-change baseline slice (2026-07-13) — no new failure signature. The parameter was
  therefore not rejected end-to-end (it is either forwarded or silently stripped by the gateway).
- **Consequence: the DeepInfra dashboard cached-token share is the ONLY discriminator** between
  "forwarded and working" (share climbs above the 25% baseline on active days) and "silently
  stripped" (share unchanged → vendor feature-ask for the gateway).

Original owner-run steps (superseded by the above where noted):

- Send any message to @ragisan_bot; a normal reply is the loud-failure check (if the gateway or
  DeepInfra rejected the new parameter, the turn would error visibly).
- Optional marker check (prints only present/absent tokens, no chat content):
  `ssh tradesbox` then
  `docker exec $(docker ps --format '{{.Names}}' | grep s2) sh -c "grep -a -o 'promptCacheKey=[a-z]*' /sandbox/.openclaw/logs/gateway-persistent.log | sort | uniq -c"`
  — expect `promptCacheKey=present` entries timestamped after the restart. (The marker may sit
  at debug log level; absence alone is inconclusive.)
- Outcome measure: DeepInfra dashboard cached-token share over the next days vs the
  2026-07-20 baseline — **9.9M cached tokens on $30 total usage (~25% est. hit rate)**.

Revert (if turns fail or behavior regresses):
`docker exec <s2-container> sh -c "cd /sandbox/.openclaw && cp -p openclaw.json.bak-cachekey-20260720 openclaw.json && sha256sum openclaw.json > .config-hash && chmod 660 openclaw.json .config-hash"`
then `nemoclaw s2 gateway restart`.

Standing risk: an s2 rebuild/re-onboard re-renders `openclaw.json` and silently drops the flag
(the medic's drift class). If the trial wins → mirror into the render source + roll to all
sandboxes (including s3, which is otherwise hands-off — coordinate with Judy).

## Recommended path (not yet implemented)

1. **Trial the flag on one sandbox** (s2 or s5): set
   `models.providers.inference.models[*].compat.supportsPromptCacheKey: true` in the
   rendered `openclaw.json` — using the established no-rebuild edit recipe (edit rendered
   config + `.config-hash`, chmod 660, `nemoclaw <s> gateway restart`), and mirror the flag
   into the source-of-truth template so the next onboard/rebuild doesn't silently regress it
   (same drift class the inference medic exists for).
2. **Verify**: transport log shows `promptCacheKey=present`; then watch the DeepInfra
   dashboard cached-token share over several active days. Revert = flip the flag back +
   restart.
3. **Open question the trial answers**: whether the OpenShell gateway's managed route
   passes `prompt_cache_key` through to DeepInfra (the route already rewrites `model` per
   request, so body rewriting exists; some proxies strip or 400 on unknown fields — the
   OpenClaw flag exists precisely because some proxies rejected the param, #49877).
   If the gateway strips it: hit rate won't move → file it as a gateway feature ask; if it
   400s: agent turns fail loudly → revert (one-sandbox blast radius).
4. **Decision frame**: even a perfect GLM cache lands at 2× the price of V4 Flash uncached.
   If the Flash quality trial (separate decision) passes, do both — the flag helps Flash's
   economics identically ($0.018 cached), and together they bound the bill near ~$1–3 per
   $30 of today's usage.
