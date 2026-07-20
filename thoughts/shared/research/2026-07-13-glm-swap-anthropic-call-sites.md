---
date: 2026-07-13
branch: feature-e-web-search-fetch
commit: 58e0c4c
topic: The four Anthropic/Claude call sites and everything a GLM-5.2 (DeepInfra + NVIDIA failover) swap would touch
---

## Summary

The spine (this repo's customer/job record system) calls a hosted language model in exactly four places, all through Anthropic's SDK against the model `claude-sonnet-4-6`: an inbound-email work/personal classifier, a field-note extractor, a customer Q&A answerer, and a customer briefer. All four use the same shape — a single "forced tool" call, meaning the model is required to respond by "calling" one predefined function whose JSON schema is the output contract, so the reply is always a machine-readable object. The API key (`ANTHROPIC_API_KEY`) is read from the process environment at call time in each module; it lives in the local `.env`, on the Render web service, and is referenced in two deployment docs. The NemoClaw agent boxes already run GLM-5.2 with a DeepInfra-primary / NVIDIA-fallback arrangement, but there it is infrastructure-level (a systemd timer flips an OpenShell gateway route); the spine has no equivalent layer, so any failover for these four call sites would live in application code. Live vendor docs confirm both DeepInfra and NVIDIA expose GLM-5.2 through OpenAI-compatible chat-completions APIs with function-calling and structured-output support (citations below); the same model has a differently-spelled ID on each provider.

## Entry Points

- `src/inbound/webhook.ts:220` — `handleInboundWebhook` calls `classify(...)` (default `sonnetClassifier`) as the classify-before-L1 gate for Composio Gmail webhooks. Reached via `src/mcp/httpServer.ts:100` (`POST /inbound/*` on the Render web service).
- `src/mcp/server.ts:628` — `record_field_note` STAGE step calls `(deps.extract ?? sonnetExtractor)(text)`.
- `src/mcp/server.ts:918` — `brief_customer` calls `(deps.brief ?? sonnetBriefer)(ctx, focus)`.
- `src/mcp/server.ts:932` — `answer_customer_question` calls `(deps.answer ?? sonnetAnswerer)(ctx, question)`.
- `scripts/smoke-http.mjs` — standalone smoke test; its header (line 19) states `ANTHROPIC_API_KEY must be set (real extractor runs)`.

## Key Files

**The four model modules (all `claude-sonnet-4-6`, all tool-forced JSON):**

- `src/email/classify.ts` — exports `EmailInput`, `Classification`, `WorkClassifier` (injectable type), `sonnetClassifier`. System prompt at :17 ("When unsure, prefer isWork=false"). Tool `classify_email` (:23) with schema `{isWork: boolean, reason: string}`, both required, `additionalProperties: false`. Client construction :40-42; `max_tokens: 256`; `tool_choice: { type: 'tool', name: 'classify_email' }` (:48). Throws if no key (:41) or no tool_use block in the reply (:57). Result is `toolUse.input as Classification` (:58) — no runtime validation of the shape.
- `src/writePath/extract.ts` — exports `ExtractedFields` (all-optional), `Extractor` (injectable type), `sonnetExtractor`. Tool `record_extraction` (:39) — 13 optional properties incl. `statusSignal` enum `['completed','in_progress']` and `attributes` object with `additionalProperties: true` (:61-65); top-level `additionalProperties: false`, **no `required` array**. `max_tokens: 1024`. Same key/error pattern (:74-75, :89).
- `src/synthesis/answerQuestion.ts` — exports `CustomerAnswer`, `Answerer`, `sonnetAnswerer`. Tool `record_answer` (:20): `{answer: string, citations: [{claim, captureId}]}`, both required. `max_tokens: 1024`. Post-processes with `validateCitations(citations, context)` (:69) — hallucinated capture ids are dropped in code, not trusted from the model.
- `src/synthesis/briefCustomer.ts` — exports `BriefFocus`, `CustomerBriefing`, `Briefer`, `sonnetBriefer`. Tool `record_briefing` (:28), same citations shape; `validateCitations` at :80. `max_tokens: 1024`.
- `src/synthesis/index.ts` — barrel; `src/mcp/server.ts:64-70` imports `sonnetBriefer`/`sonnetAnswerer` from it.
- `src/synthesis/grounding.ts` — `serializeContextForPrompt`, `validateCitations` (model-agnostic; consumed by both synthesis modules).

**Callers and seams:**

- `src/inbound/webhook.ts` — `InboundWebhookDeps.classify?: WorkClassifier` (:77); default binding `deps.classify ?? sonnetClassifier` (:136). Classifier runs only when `envelope.requiresWorkClassifier` (:219), on the clean body from `sourceMeta`.
- `src/mcp/server.ts` — `ServerDeps.extract?/brief?/answer?` (:91-93) injectable "so tests don't call the live model"; production constructs the server with **no** deps, so the `?? sonnet*` fallbacks are load-bearing (comment at :627). Comment at :84-89: "The agent never holds the Supabase or Anthropic keys — this server ... is the only thing that touches the spine."
- `src/mcp/httpServer.ts:53-63` — `INBOUND_STATUS_CODES`: `transient_error → 503` (Composio retries), deterministic outcomes → 2xx/4xx (no retry).

**Tests:**

- `src/email/classify.test.ts` — LIVE, `describe.skipIf(!process.env.ANTHROPIC_API_KEY)`, two unambiguous fixtures (work email → true, newsletter → false).
- `src/synthesis/answerQuestion.test.ts` — LIVE, same gate, 30s timeouts; asserts answer contains "capacitor" and all citations reference real capture ids; second test asserts no fabrication on an unanswerable question.
- `src/synthesis/briefCustomer.test.ts` — LIVE, same gate, 30s timeout.
- **There is no `extract.test.ts`** — `src/writePath/recordFieldNote.test.ts` and the webhook/server tests stub the extractor/classifier through the injection seams. `sonnetExtractor` is exercised live only by `scripts/smoke-http.mjs`.
- `src/test.setup.ts` — loads `.env` first ("ANTHROPIC_API_KEY etc. for the key-gated live-model tests"), then `.env.test` with override; `assertLocalTestEnv` hard-fails the suite against any non-local DB.

**Env / deploy / docs surface:**

- `.env.example:11,24` — `ANTHROPIC_API_KEY` documented as "write-path Sonnet extractor".
- `docs/control-plane.md:76` — Render **cron** explicitly does NOT need `ANTHROPIC_API_KEY` ("the job never receives webhooks, serves MCP, or classifies"). The web service section (:60-64) lists Composio vars; the Anthropic key is an existing web-service var, not re-listed there.
- `docs/nemoclaw-tech-agent.md:19` — architecture diagram: the trades-spine MCP server "(holds SUPABASE_* + ANTHROPIC_API_KEY; tenant pinned)". `:51` — stdio gateway registration example injects `"ANTHROPIC_API_KEY": { "secretRef": "anthropic-api-key" }`. `:68` — Architecture A: secrets (`SUPABASE_*`, `ANTHROPIC_API_KEY`, `GATEWAY_IDENTITY_SECRET`) "live **only** on this host".
- `Box_Setup_Stuff/migration-runbook-lightsail.md:197` — records that "**Render `ANTHROPIC_API_KEY` went invalid** (likely rotated in the 2026-07-03 credential sweep)". (Finding: the deployed pilot's key may currently be dead.)
- `package.json` — `"@anthropic-ai/sdk": "^0.105.0"` is a production dependency; no OpenAI-compatible client library is currently installed.

**Existing GLM-5.2 / failover art (box side, infrastructure-level — not importable by the spine):**

- `Box_Setup_Stuff/nemoclaw-inference-medic.sh` — v2 medic. Constants (:34-37): primary `deepinfra-prod` / `zai-org/GLM-5.2`, fallback `nvidia-prod` / `z-ai/glm-5.2` — "NOTE: NVIDIA id spelling (dashed differently)". Mechanism: `openshell inference set` live-verifies endpoint+key before saving, so validation doubles as the health probe; DeepInfra fails → flip to NVIDIA (loud); next healthy DeepInfra run fails back automatically; both fail → exit 1. Driven by `nemoclaw-inference-medic.{service,timer}` every 5 minutes. Failure history (:12-16): 2026-07-11 DeepInfra balance exhaustion (HTTP 402) then a transient outage where completions hung >120s.
- `Box_Setup_Stuff/doorman-architecture-memory.md:126-145` — production route decision; NVIDIA catalog is queryable publicly: `curl -s https://integrate.api.nvidia.com/v1/models` (as of 2026-07-02 exactly one GLM: `z-ai/glm-5.2`); NVIDIA free tier has a per-worker concurrency cap (32) that rate-limited busy agents ("ResourceExhausted: Worker local total request limit reached", per medic comments and setup guide :456-460).
- `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:456-480` — DeepInfra provider creation with `DEEPINFRA_API_KEY`; DeepInfra limit noted as "200 CONCURRENT requests per model (not per-minute)".

## Data Flows

**Inbound email (classify-before-L1):**

```
Composio POST /inbound/*  (Render web service)
  → httpServer.handleInbound → handleInboundWebhook (webhook.ts:124)
    → HMAC verify → parse → normalizer → roster/tenant checks
    → IF envelope.requiresWorkClassifier:
        classify({from, subject, body})          ← sonnetClassifier → Anthropic API
          isWork=false → recordDrop(...) → 'skipped_non_work' (200)
          isWork=true  → recordFieldNote(...) → L1 append → 'ingested' (200)
          THROWS       → caught at :295 → 'transient_error' → HTTP 503 → Composio RETRIES
```

A classifier outage therefore does not silently drop mail at our boundary: the throw is mapped to 503 and Composio redelivers. The bound on redelivery is Composio's retry policy (external to this repo, not documented here).

**Field note (extract-at-stage, replay-at-commit):**

```
agent → record_field_note {text}                       (mcp/server.ts:598)
  STAGE: extract(text) ← sonnetExtractor → Anthropic    (:628, model call happens HERE)
         matchIdentity(...) → staged review item (detail.extracted persisted)
  CONFIRM (confirmId alone): recordFieldNote(..., { extract: async () => detail.extracted })
         (:806 — replays the STAGED extraction; commit makes NO model call,
          so commit cannot extract differently than what the technician was shown)
```

**Synthesis (read-only):** `brief_customer` / `answer_customer_question` → `getCustomerContext` → tenant guard → `dropSensitive` filter → `sonnetBriefer`/`sonnetAnswerer` → Anthropic → `validateCitations` drops any citation whose `captureId` isn't in the real capture set. A model failure throws out of the tool call; nothing is persisted (both tools are pure reads).

**Common Anthropic call shape (all four):** `new Anthropic({ apiKey })` per call → `client.messages.create({ model: 'claude-sonnet-4-6', max_tokens, system, tools: [ONE_TOOL], tool_choice: { type: 'tool', name }, messages: [ONE_USER_MESSAGE] })` → find the `tool_use` block by name → cast `toolUse.input` to the result type (no runtime schema validation). No streaming, no multi-turn, no temperature/sampling parameters are set anywhere.

## External Dependencies

- `@anthropic-ai/sdk` ^0.105.0 (production dep) — the only model-provider SDK installed.
- Anthropic API, model `claude-sonnet-4-6`, via `ANTHROPIC_API_KEY`.
- **DeepInfra (verified live 2026-07-13):**
  - OpenAI-compatible base URL `https://api.deepinfra.com/v1/openai`; auth `Authorization: Bearer $DEEPINFRA_TOKEN`; `tools` and `tool_choice` listed as supported parameters; `response_format` supported with a "Structured Outputs" feature section. Source: https://docs.deepinfra.com/chat/overview (redirect target of https://deepinfra.com/docs/openai_api).
  - GLM-5.2 model id `zai-org/GLM-5.2`; endpoint `https://api.deepinfra.com/v1/openai/chat/completions`; function calling + JSON mode listed; 1M-token context; pricing $0.93/1M input, $3.00/1M output, $0.18/1M cached input (fp4 serving). Source: https://deepinfra.com/zai-org/GLM-5.2/api ; announcement https://deepinfra.com/blog/glm-5-2-on-deepinfra .
  - Concurrency limit 200 concurrent requests per model (repo doc `doorman-nemoclaw-setup-guide.md:466`, recorded from vendor contact).
- **NVIDIA (verified live 2026-07-13):**
  - OpenAI-compatible base URL `https://integrate.api.nvidia.com/v1`; model id `z-ai/glm-5.2`; tool calling and structured output listed among output features; 1M input context; multiple thinking-effort levels with reasoning traces. Source: https://docs.api.nvidia.com/nim/reference/z-ai-glm-5.2 and https://build.nvidia.com/z-ai/glm-5.2 .
  - Third-party listings report a free tier around 40 RPM (freellm.net) — unconfirmed by NVIDIA's own doc page; the boxes' lived experience was a per-worker concurrency cap of 32 on the free tier (`nemoclaw-inference-medic.sh:9`).
- Model ID spelling differs per provider for the same model: DeepInfra `zai-org/GLM-5.2` vs NVIDIA `z-ai/glm-5.2` (`nemoclaw-inference-medic.sh:35,37`; `doorman-architecture-memory.md:138`).

## Constraints and Invariants

- **classify-before-L1** (CLAUDE.md): L1 is append-only with no delete path; work/personal filtering must gate the insert, never run after. The classifier's system prompt biases to `isWork=false` when unsure. A dropped email leaves only a content-free audit receipt (`recordDrop`).
- **Classifier throw = retryable, not a drop**: webhook.ts:188-190 comments define any throw after the roster check as transient → 503 → Composio retry. Deterministic outcomes must `return` a status, never throw.
- **Extraction happens once, at stage time**: the commit path replays `detail.extracted` verbatim (mcp/server.ts:806). The model provider is only on the stage path.
- **Citations are validated in code**: `validateCitations` (grounding.ts) is the anti-hallucination backstop for both synthesis modules — the model's citation ids are never trusted.
- **Casts, not validation**: all four modules cast `toolUse.input` directly (`as Classification`, `as ExtractedFields`, ...). The Anthropic forced-tool contract is what makes the shape reliable today; nothing downstream re-validates it (except citations).
- **Injection seams everywhere**: `WorkClassifier` via `InboundWebhookDeps.classify`, `Extractor` via `ServerDeps.extract` and `recordFieldNote`'s second param, `Briefer`/`Answerer` via `ServerDeps`. All unit tests stub through these; only the three live test files and `smoke-http.mjs` hit the real model.
- **Key custody**: agents/sandboxes never hold the model key (mcp/server.ts:84-89, nemoclaw-tech-agent.md:68). The key exists on the Render web service (and local `.env`); the Render cron explicitly does not get it (control-plane.md:76).
- **Live tests are gated on the key's presence** (`describe.skipIf(!process.env.ANTHROPIC_API_KEY)`), load `.env` via `src/test.setup.ts`, and use 30s timeouts. A fresh worktree without `.env` skips them (CLAUDE.md).
- **Box_Setup_Stuff sync rule** (memory `box-setup-stuff-sync.md`): agent-stack architectural changes must update `Box_Setup_Stuff/` and `docs/nemoclaw-tech-agent.md` in the same change. The secretRef example at nemoclaw-tech-agent.md:51 and the diagram at :19 both name `ANTHROPIC_API_KEY`.
- **The box medic is not reusable code for the spine**: it heals a gateway *route* via `openshell inference set` (validate-before-save doubles as health probe, 5-min timer, automatic failback). The spine calls the provider directly from Node; it has no gateway or route object to flip.
- **Sampling defaults**: none of the four call sites set temperature or other sampling parameters — the Anthropic default is used. (Relevant because OpenAI-compatible APIs have their own defaults.)
- **`smoke-http.mjs` requires the real extractor** and documents `ANTHROPIC_API_KEY` as a precondition (:19).
- **Finding (pre-existing):** `migration-runbook-lightsail.md:197` records the Render web service's `ANTHROPIC_API_KEY` as invalid/rotated as of the Lightsail migration notes; plan docs (2026-07-06) likewise note "stale-ANTHROPIC_API_KEY synthesis failures" in local runs.

## Decision Points

1. **Where failover lives.** The box precedent is infrastructure-level (systemd timer flips a gateway route once, for all traffic). The spine calls the provider in-process, so DeepInfra→NVIDIA failover would be application code. Options given today's code: (a) per-call try/catch — attempt DeepInfra, on error retry the same request against NVIDIA (two endpoint/model-id/key triples threaded through each call or through one shared helper); (b) a shared client-factory/health-state module that all four call sites use (closer to the medic's "route" concept, with failback logic). Today there is no shared LLM client module — each of the four files constructs its own client inline.
2. **Structured-output mechanism on the OpenAI-compatible API.** The current pattern is Anthropic forced-tool (`tool_choice: {type:'tool', name}`). OpenAI-compatible equivalents both providers document: `tools` + `tool_choice` (function calling), or `response_format` (JSON mode / structured outputs). Which of these GLM-5.2 honors most reliably — and whether a *forced* named function (`tool_choice: {type:'function', function:{name}}`) is supported on each provider — is not explicitly confirmed by the fetched model pages (see Open Questions). The choice affects all four schemas, including `extract.ts`'s no-required-fields schema and its `attributes` sub-object with `additionalProperties: true`.
3. **What replaces the errors and gates keyed to `ANTHROPIC_API_KEY`.** The literal string appears in: the four modules' key checks, three live-test `skipIf` gates, `test.setup.ts` comment, `.env.example`, `smoke-http.mjs` header, `control-plane.md`, `nemoclaw-tech-agent.md` (diagram + secretRef block), and Render's dashboard env. A swap needs a decision on the new variable name(s) (the box side already uses `DEEPINFRA_API_KEY` and `NVIDIA_API_KEY` spellings in its docs) and on which key gates the live tests (primary only, or both).
4. **Naming.** The exported symbols are provider-branded: `sonnetClassifier`, `sonnetExtractor`, `sonnetAnswerer`, `sonnetBriefer` (imported by webhook.ts, mcp/server.ts, synthesis/index.ts, and the three live tests); error strings embed the same names. Renaming vs keeping them is a pure refactor choice but touches every consumer.
5. **Model-id spelling per provider.** Any shared config must carry both spellings (`zai-org/GLM-5.2` on DeepInfra, `z-ai/glm-5.2` on NVIDIA) — a single "model" constant cannot serve both endpoints (`nemoclaw-inference-medic.sh:35-37`).
6. **NVIDIA fallback tier.** The boxes' NVIDIA usage is the free tier with a known concurrency cap (32/worker) that has rate-limited busy agents before; third-party listings say ~40 RPM. Whether the spine's fallback uses the same key/tier as the boxes or a separate paid arrangement is an account decision outside the code (key custody memory: one credential per host).
7. **SDK choice for the OpenAI-compatible calls.** Nothing OpenAI-compatible is installed today. Options given the codebase: add the `openai` npm package pointed at each base URL, or hand-rolled `fetch` against `/chat/completions` (the repo already does raw-`fetch` vendor calls elsewhere, e.g. `src/web/braveSearch.ts`, `src/composio/*`).
8. **Timing relative to Feature E.** Current branch `feature-e-web-search-fetch` (commit 58e0c4c) touches `src/mcp/server.ts` (tool list + dispatch). The GLM swap touches different lines of the same file (imports at :47, :64-70 and the docs). Sequencing (land Feature E first vs parallel worktrees per CLAUDE.md's two-feature rule) is a workflow decision.

## Open Questions

1. **Forced named-function `tool_choice` on GLM-5.2 at each provider.** DeepInfra's overview documents `tools`/`tool_choice` as parameters and the model page lists "Function" support, but neither explicitly confirms `tool_choice: {"type":"function","function":{"name":...}}` (forced single tool) for GLM-5.2; NVIDIA's page lists "tool calling" without documenting `tool_choice` values. Needs a live probe per provider before the pattern is ported 1:1.
2. **Schema adherence without a `required` array** (extract.ts) and with nested `additionalProperties: true` (`attributes`) — whether GLM-5.2's function-calling emits clean JSON for this looser schema, on both providers, is untested here.
3. **Reasoning traces in responses.** NVIDIA documents "reasoning traces" / thinking-effort levels for GLM-5.2. Whether either provider returns a `reasoning_content`-style field alongside `tool_calls` by default, and whether it needs to be disabled or ignored, is unverified.
4. **NVIDIA rate limits for a server-side caller.** The 40 RPM figure is third-party; the authoritative limit for the account tier the spine would use is unconfirmed.
5. **Composio's retry budget** for 503s from `/inbound/*` — bounds the real-world mail-loss window during a both-providers-down incident; not documented in this repo.
6. **Whether the pilot's Render `ANTHROPIC_API_KEY` is currently dead** (migration-runbook-lightsail.md:197 says likely rotated 2026-07-03). If so, classify/extract/synthesis on the deployed pilot are already failing — observable in Render logs; would change the urgency but not the shape of a swap.
