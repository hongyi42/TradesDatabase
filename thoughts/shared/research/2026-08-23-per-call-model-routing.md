---
date: 2026-08-23
branch: main
commit: dca36f5
topic: per-call model routing — how MODEL_PROVIDER reaches each model call site, the two transports, cost-ledger SKU mapping, and which Render services run which calls
supersedes: nothing
---

## Summary

Every model call the spine makes goes through exactly two transport functions, and both decide
which AI vendor to talk to by reading **one process-wide environment variable,
`MODEL_PROVIDER`**, at call time. There is no per-call routing anywhere in the code: a caller
(the planner, the extractor, a classifier) cannot ask for a specific model — it gets whatever
provider the *process* it happens to run in is configured for. The reason the planner can be on
Opus 5 while the extractor is on GLM **today** is an accident of deployment topology, not a
code feature: they run in different Render services (the planner in the `lifecycle-heart` cron,
the extractor in the `TradesDatabase` web service), and each service has its own copy of the
env vars. Anything that ever runs two of these callers in the same process — tests, eval
scripts, a future consolidation of services — gets one provider for both. The cost ledger's
SKU map (`MODEL_SKUS`) is keyed **per vendor, not per model**: it hardcodes the assumption
that all Anthropic traffic is Opus 5 and all Fireworks traffic is GLM-5.2-fast.

## Entry Points

- [src/model/forcedTool.ts:91](src/model/forcedTool.ts#L91) — `activeProvider()`: the single
  routing decision. `process.env.MODEL_PROVIDER === 'anthropic' ? 'anthropic' : 'openai'`.
  Anything else (unset, typo) silently means `'openai'`.
- [src/model/forcedTool.ts:379](src/model/forcedTool.ts#L379) — `runForcedTool(tool, req, ctx?)`:
  the single-shot transport (one system prompt, one forced tool call, one answer). Branches on
  `activeProvider()` per call.
- [src/model/toolLoop.ts:416](src/model/toolLoop.ts#L416) — `runToolLoop(req, tools, execute, ctx?, deps?)`:
  the multi-turn transport (the planner's agentic loop). Branches on `activeProvider()` once at
  loop start to pick its transport object.
- [src/jobs/lifecycle.ts:351-466](src/jobs/lifecycle.ts#L351-L466) — the cron tick's
  planner/reflector steps, gated by `PLANNER_MODE` / `REFLECTOR_MODE` and by
  `hasModelCredentials()` (which itself follows `activeProvider()`).
- [src/mcp/httpServer.ts](src/mcp/httpServer.ts) — the web service process: mounts the MCP
  server (synthesis + extraction) and the inbound email webhook (classifier).

## Key Files

**Transports (the only two places that speak to a model provider):**
- [src/model/forcedTool.ts](src/model/forcedTool.ts) — single-shot forced-tool transport.
  Exports the endpoint/provider resolution the *other* transport imports, deliberately, so the
  two can never drift: `resolveOpenAiEndpoint()` (line 63 — `INFERENCE_API_KEY`,
  `INFERENCE_BASE_URL` default `https://api.fireworks.ai/inference/v1`, `INFERENCE_MODEL`
  default `accounts/fireworks/routers/glm-5p2-fast`), `resolveAnthropicEndpoint()` (line 73 —
  `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` default **`claude-sonnet-4-6`**), `cacheKeyFields()`
  (line 86 — `INFERENCE_CACHE_KEY`, OpenAI path only), `activeProvider()` (line 91),
  `ledgerVendor()` (line 104), `hasModelCredentials()` (line 121), `coerceBySchema()`
  (line 138). Two private implementations: `callAnthropic` (line 226), `callOpenAiCompatible`
  (line 292).
- [src/model/toolLoop.ts](src/model/toolLoop.ts) — multi-turn loop transport. Imports all
  resolution from forcedTool.ts (lines 1–11). Two transport objects: `anthropicTransport`
  (line 201), `openAiTransport` (line 288). Rails: 8 turns, 90s budget, 20k chars/result,
  8 tool calls/turn (lines 35–55).

**Ledger:**
- [src/db/costs.ts:127](src/db/costs.ts#L127) — `MODEL_SKUS`: ledger-vendor → `(provider, sku)`
  rows. Keys today: `nvidia` (GLM, $0 eval tier), `fireworks` (glm-5.2-fast-input/-output/
  -cached-input), `anthropic` (claude-opus-5-input/-output/-cached-input/-cache-write-1h). The
  map's own comment records the constraint: **per-VENDOR, assumes `ANTHROPIC_MODEL=claude-opus-5`;
  a Sonnet rollback must re-edit the SKUs or Sonnet traffic bills at Opus rates.**
- [src/db/costs.ts:182](src/db/costs.ts#L182) — `recordModelUsage(vendor, usage, ctx)`: splits
  usage into fresh-input / cached-input / cache-write / output events; unmapped vendor throws
  (swallowed by failure isolation → logged, not billed).

**Callers (every model call site in `src/`):**

| Caller | File / call line | Transport | maxTokens | reasoningEffort | Label |
|---|---|---|---|---|---|
| Planner | [src/teamLead/planner.ts:1349](src/teamLead/planner.ts#L1349) | `runToolLoop` | 8192 (`PLANNER_MAX_TOKENS`, line 188) | `'low'` (`PLANNER_REASONING`, line 189) | `teamLeadPlanner` |
| Compose | [src/teamLead/compose.ts:279](src/teamLead/compose.ts#L279) | `runForcedTool` | 300 | `'none'` | `teamLeadCompose` |
| Reflector | [src/teamLead/reflector.ts:233](src/teamLead/reflector.ts#L233) | `runForcedTool` | 2000 | `'none'` | `reflector` |
| Extractor | [src/writePath/extract.ts:85](src/writePath/extract.ts#L85) | `runForcedTool` | 1024 | — (provider default) | `defaultExtractor` |
| Briefer | [src/synthesis/briefCustomer.ts:69](src/synthesis/briefCustomer.ts#L69) | `runForcedTool` | 8192 | `'none'` | `defaultBriefer` |
| Answerer | [src/synthesis/answerQuestion.ts:56](src/synthesis/answerQuestion.ts#L56) | `runForcedTool` | 8192 | `'none'` | `defaultAnswerer` |
| Email classifier | [src/email/classify.ts:50](src/email/classify.ts#L50) | `runForcedTool` | 256 | — (provider default) | `defaultClassifier` |
| Call classifier | [src/calls/classifyCall.ts:103](src/calls/classifyCall.ts#L103) | `runForcedTool` | 256 | — (provider default) | `defaultCallClassifier` |

No caller passes a model or provider — the request shape (`ForcedToolRequest`,
`ToolLoopRequest`) has no field for one.

**Script-side consumers (outside `src/`, same env contract):**
- [scripts/planner-eval/run.mjs](scripts/planner-eval/run.mjs) — imports the compiled
  transports; follows whatever `MODEL_PROVIDER` the shell exports.
- [scripts/smoke-http.mjs:20-21](scripts/smoke-http.mjs#L20-L21) — documents the same contract
  for smoke runs.
- The spine-eval/date-eval harnesses talk to the box agent (OpenClaw gateway), not these
  transports — out of scope here.

## Data Flows

```
                       process env (per Render service)
                       MODEL_PROVIDER ─ ANTHROPIC_API_KEY/ANTHROPIC_MODEL
                                      └ INFERENCE_API_KEY/_BASE_URL/_MODEL/_CACHE_KEY
                                          │
   caller (planner/compose/…)             ▼
   runToolLoop / runForcedTool ──► activeProvider() ──┬─ 'anthropic' ─► callAnthropic / anthropicTransport
     (no model/provider arg)                          └─ 'openai'    ─► callOpenAiCompatible / openAiTransport
                                          │
                                          ▼
                              recordModelUsage(ledgerVendor(), usage, ctx)
                                          │
                     ledgerVendor(): 'anthropic' if provider=anthropic,
                     else hostname of INFERENCE_BASE_URL → 'fireworks' | 'nvidia' | raw host
                                          │
                                          ▼
                              MODEL_SKUS[vendor] → cost_events rows
                     (fresh input / cached input / cache write / output)
```

Both transports normalize usage to one convention before billing: `inputTokens` = TOTAL prompt
tokens *including* cached reads (Anthropic's native `input_tokens` excludes cache activity, so
the Anthropic paths add `cache_read_input_tokens` back — forcedTool.ts:273, toolLoop.ts:252).
`recordModelUsage` then subtracts the cached share onto its own SKU, and cache *writes*
(`cache_creation_input_tokens`, Anthropic only) bill on the `cacheWrite` SKU when the vendor
has one, else fold into the input line.

**Which Render service runs which calls (verified live 2026-08-23 via the Render API):**

| Render service | ID | Start command | Model calls in-process |
|---|---|---|---|
| `TradesDatabase` (web) | srv-d8uqmdegvqtc73bfn83g | `npm run mcp:serve:http` | Extractor, Briefer, Answerer (MCP tools); Email classifier (inbound webhook) |
| `lifecycle-heart` (cron, */5) | crn-d93iq7a8qa3s73ap6260 | `npm run job:lifecycle` | Planner, Compose, Reflector |
| `Calls-worker` (background worker) | srv-d9qelh710e5c739hb8vg | `npm run calls:worker` | Call classifier (plus AssemblyAI transcription, non-spine) |
| `Board_Worker` (background worker) | srv-d9dr8iurnols73d1tjq0 | `npm run board:worker` | none |
| `Calls-purge` (cron, daily) | crn-d9qeov1t0dsc73funmag | `npm run calls:purge` | none |

Each service holds its own env-var copy. As deployed after the 2026-08-23 Opus switch (PR #177):
`lifecycle-heart` has `MODEL_PROVIDER=anthropic` + `ANTHROPIC_MODEL=claude-opus-5` (set by the
user; the code default is Sonnet — this is the standing "verify ANTHROPIC_MODEL" flag), while
the web service and Calls-worker keep the GLM/Fireworks config. So the *effective* routing
today is: planner+compose+reflector → Opus 5; extract/brief/answer/email-classify → GLM;
call-classify → GLM. Env values are not readable through the Render MCP tools — this reflects
the deploys performed in-session, not a read-back.

## External Dependencies

- **Anthropic API** via `@anthropic-ai/sdk` (`client.messages.create`), model from
  `ANTHROPIC_MODEL`. Prompt caching: one `cache_control {type:'ephemeral', ttl:'1h'}`
  breakpoint on the system block in both transports (tools+system prefix).
- **OpenAI-compatible endpoint** via raw `fetch` to `${INFERENCE_BASE_URL}/chat/completions` —
  today Fireworks (`glm-5p2-fast` router). `temperature: 0`, optional `reasoning_effort`,
  optional `prompt_cache_key`+`user` cache-affinity fields.
- **Supabase** (`cost_events`, `cost_rates`) through `appendCostEvents`.

## Constraints and Invariants

1. **One provider per process.** `activeProvider()` reads a process-wide env var; neither
   transport request type carries a model/provider field. Per-call divergence exists only
   because callers are distributed across services.
2. **Both transports must stay in step.** forcedTool.ts is the single source for endpoint
   resolution; toolLoop.ts imports it (its header comment names copied-constant drift as the
   failure being prevented). The truncation guard, usage normalization, and cache breakpoint
   are deliberately twinned across both files — a routing change touching one path must touch
   both.
3. **`hasModelCredentials()` follows the flip** (forcedTool.ts:121): it checks the *active*
   provider's key. The lifecycle uses it to decide `skipped: 'no inference credentials'` for
   planner (line 379), compose (line 411), and reflector (line 457) — all three share one
   verdict because the process has one provider.
4. **`ledgerVendor()` decouples wire protocol from billing** (forcedTool.ts:104): 'openai' is a
   protocol; the invoice owner is derived from the `INFERENCE_BASE_URL` hostname. Unknown hosts
   return the raw host so `recordModelUsage` fails loudly (unmapped vendor) instead of
   mis-billing.
5. **`MODEL_SKUS` is per-vendor and model-blind** (costs.ts:127): the `anthropic` entry *is*
   Opus 5's SKUs; the `fireworks` entry *is* GLM-fast's. Pointing `ANTHROPIC_MODEL` at Sonnet,
   or `INFERENCE_MODEL` at another Fireworks model, mis-prices silently unless the map is
   re-edited. The rollup INNER-joins `cost_rates`, so an unseeded SKU drops from the dashboard
   silently.
6. **`reasoningEffort` is OpenAI-path-only** — explicitly ignored on the Anthropic path (noted
   at forcedTool.ts:41-49 and ToolLoopRequest). GLM thinks by default so the field exists to
   bound it; Anthropic models don't receive any thinking parameter from this code.
7. **The Anthropic cache breakpoint has a 512-token floor** (Opus-class minimum): compose's
   ~350-token prompt makes `cache_control` a silent no-op there (comment at forcedTool.ts:236).
8. **`MODEL_PROVIDER` defaults open**: any value other than `'anthropic'` — including a typo —
   routes to the OpenAI path.
9. **Live-model tests gate on `hasModelCredentials()`**, so a provider flip in `.env` moves the
   whole local test suite's live checks with it — there is no way to run "planner tests on
   Anthropic, extractor tests on Fireworks" in one process today.
10. **Cost recording is failure-isolated at the transports** — the only two billing sites
    (runForcedTool once per call; runToolLoop once per turn, toolLoop.ts:476).

## Decision Points

1. **Where routing lives.** Today: one env var per process. To make the planner and extractor
   differ *by intent* rather than by service topology, either (a) each caller passes a
   provider/model hint through `ForcedToolRequest`/`ToolLoopRequest`, (b) a routing map keyed
   by caller label lives in env/config (e.g. `MODEL_PROVIDER_PLANNER=anthropic` with
   `MODEL_PROVIDER` as fallback), or (c) the status quo is ratified and documented (service
   topology IS the router). Each option touches `activeProvider()`'s five dependents:
   transport branch, `hasModelCredentials`, `ledgerVendor`, and the lifecycle's three
   credential gates.
2. **Ledger model-blindness.** `MODEL_SKUS` keys on vendor. If two Anthropic models (or two
   Fireworks models) can ever be live in one deployment, SKU selection has to learn the model
   id — either from the resolved endpoint (`resolveAnthropicEndpoint().model`) or from a new
   argument to `recordModelUsage`. If routing stays one-model-per-vendor, the map holds as-is.
3. **Credential gating granularity.** `hasModelCredentials()` answers for the whole process. If
   one process can route calls to two providers, the lifecycle's per-step skip
   (`'no inference credentials'`) needs a per-caller answer, or a call can be attempted with
   the wrong key present.
4. **`reasoningEffort` semantics across providers.** Callers set `'none'`/`'low'` for GLM's
   default-on thinking. On a per-call-routed system, an Anthropic-routed caller's effort value
   stays a no-op; whether that stays a silent ignore or becomes a mapped parameter is a choice
   the routing change exposes.
5. **The Calls-worker seat.** The call classifier runs in its own service with its own env. Any
   routing scheme has to say what that service's config is — it is a third copy of the vars,
   currently on the GLM side.

## Open Questions

- Actual env values on each Render service are not readable via the MCP tools available here;
  the per-service assignments above come from the deploys performed in-session (cron flipped to
  Anthropic 2026-08-23, web/calls-worker untouched). A read-back would need the dashboard.
- Whether `Calls-worker` and the web service currently set `MODEL_PROVIDER` explicitly to
  `openai` or simply leave it unset (identical behavior today — default is `openai`).
- Whether any Fireworks-side eval scripts assume `MODEL_PROVIDER=openai` implicitly beyond
  planner-eval/smoke-http (not exhaustively audited).
