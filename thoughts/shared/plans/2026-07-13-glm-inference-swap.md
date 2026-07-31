---
date: 2026-07-13
task: Swap the spine's four Claude call sites to GLM-5.2 (DeepInfra primary, NVIDIA failover); retire ANTHROPIC_API_KEY and @anthropic-ai/sdk
research: thoughts/shared/research/2026-07-13-glm-swap-anthropic-call-sites.md
status: draft
---

## Overview

Replace the four Anthropic/Claude call sites (email classifier, field-note extractor, customer answerer, customer briefer) with GLM-5.2 served over DeepInfra's OpenAI-compatible API, failing over automatically to NVIDIA's endpoint (same model, different ID spelling) when DeepInfra errors. Fully retires `ANTHROPIC_API_KEY` and the `@anthropic-ai/sdk` dependency. Motivation: user decision to consolidate on GLM-5.2 (2026-07-13); the pilot's Render Anthropic key is likely already dead (migration-runbook-lightsail.md:197).

## Decisions

- **Scope: all four call sites** — user decision (2026-07-13). Includes the L1 classify gate; live tests act as the quality spot-check.
- **Failover: DeepInfra → NVIDIA in application code** — user decision. The boxes' medic flips a gateway route; the spine has no gateway, so a shared helper tries providers in order.
- **Shared client module (`src/llm/glm.ts`)** vs per-call-site try/catch — chosen: shared module. One place for keys, model IDs, timeouts, failover; the four call sites keep only their prompts/schemas.
- **SDK: `openai` npm package** with per-provider `baseURL` vs raw `fetch` — chosen: `openai`. Typed client, auth/timeout handling built in; both providers document OpenAI compatibility. `maxRetries: 0` (failover IS the retry), `timeout: 30_000` per provider (2026-07-11 DeepInfra incident hung >120s; bounds webhook latency to ≤~60s worst case before Composio's 503-retry takes over).
- **Structured output: OpenAI function calling with forced `tool_choice: {type:'function', function:{name}}`** — ports the existing forced-tool pattern 1:1. Verified by a live probe test in Phase 1 before any call site moves. Documented fallback if a provider rejects forced tool_choice: `response_format` JSON schema (decision re-opens only if the probe fails).
- **Env vars: `DEEPINFRA_API_KEY` + `NVIDIA_API_KEY`** — matches the box docs' spellings. Live tests gate on `DEEPINFRA_API_KEY`. Fresh keys for the spine — never reuse the boxes' keys (credential-custody rule: one credential per host).
- **Model IDs: both spellings as constants** — DeepInfra `zai-org/GLM-5.2`, NVIDIA `z-ai/glm-5.2` (nemoclaw-inference-medic.sh:35-37).
- **Renames: `sonnet*` → `glm*`** (`glmClassifier`, `glmExtractor`, `glmAnswerer`, `glmBriefer`) — accurate under both providers (same model). Types (`WorkClassifier`, `Extractor`, `Briefer`, `Answerer`) unchanged.
- **max_tokens headroom** — GLM-5.2 can emit reasoning before the tool call; bump classify 256→1024, the other three 1024→2048. Probe asserts `finish_reason !== 'length'`. Cost ceiling ≈ $0.006/call at $3/1M output.
- **Branch/sequencing** — new branch off `main` after the Feature E PR lands (both edit `src/mcp/server.ts`; landing E first avoids a rebase). If E stalls, implement anyway and rebase — overlap is import lines only.
- **ANTHROPIC_API_KEY removal** — code/docs refs removed here; Render dashboard removal is a manual deploy step; keeping/deleting it from the local `.env` is the user's call.

## Plain-language walkthrough

**Phase 1** builds the "phone line" before rewiring any callers: a small module that knows how to ask GLM-5.2 a question and force the answer into a JSON shape, first via DeepInfra, and if that call fails for any reason, automatically retrying the identical request via NVIDIA. A live "probe" test proves both providers really honor the forced-JSON trick with our loosest schema before we bet the pipeline on it.

**Phase 2** rewires the two write-path callers — the inbound-email work/personal gate and the field-note extractor — onto that module, renaming them from `sonnet…` to `glm…`. The email gate is the risky one (its verdict controls what enters the permanent record), so its live test runs here as the quality check.

**Phase 3** rewires the two read-only synthesis callers (customer Q&A and briefings), then deletes the Anthropic SDK from the project — after this phase no code can call Claude even by accident.

**Phase 4** cleans up every place the old key's name appears (env template, deploy docs, the agent-stack doc's secret-injection example), and writes the Render deploy checklist: add the two new keys to the web service, remove the old one.

```
Before:  webhook / MCP tools ──▶ @anthropic-ai/sdk ──▶ Anthropic (claude-sonnet-4-6)
After:   webhook / MCP tools ──▶ src/llm/glm.ts ──▶ DeepInfra zai-org/GLM-5.2
                                        └─ on error ─▶ NVIDIA  z-ai/glm-5.2
```

## Secrets & env preflight

- **Phase 1:** `DEEPINFRA_API_KEY` in `.env` — deepinfra.com → Dashboard → API Keys (mint a NEW key for the spine; do not reuse the box's). `NVIDIA_API_KEY` in `.env` — build.nvidia.com → account → Generate API Key (`nvapi-…`; new key, not the box's). Neither exists in `.env` today.
- **Phase 2–3:** same two keys (live tests). Local Supabase stack for `npm test` (already required).
- **Phase 4:** Render dashboard access (user-held; manual step). No new secrets.

## Phase 1: Shared GLM client with failover

### What this phase does
Adds `src/llm/glm.ts` — provider config, forced-function-call helper, ordered failover — plus unit tests for the failover logic and a key-gated live probe against both providers. No existing behavior changes.

### Changes required

**`package.json`** — `npm install openai` (production dep).

**`src/llm/glm.ts`** (new)
```ts
import OpenAI from 'openai';

export interface GlmToolCallRequest {
  system: string;
  user: string;
  tool: { name: string; description: string; parameters: Record<string, unknown> };
  maxTokens: number;
}
// One provider attempt: returns the parsed tool arguments or throws.
export type ProviderAttempt = (req: GlmToolCallRequest) => Promise<unknown>;
```
- Constants: `DEEPINFRA_BASE_URL = 'https://api.deepinfra.com/v1/openai'`, `DEEPINFRA_MODEL = 'zai-org/GLM-5.2'`, `NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'`, `NVIDIA_MODEL = 'z-ai/glm-5.2'`.
- `makeAttempt(envKey, baseURL, model): ProviderAttempt` — throws `` `${envKey} is not set` `` if the env var is missing (checked at call time, matching today's per-call key checks); constructs `new OpenAI({ apiKey, baseURL, timeout: 30_000, maxRetries: 0 })`; calls `client.chat.completions.create({ model, max_tokens: req.maxTokens, messages: [{role:'system',content:req.system},{role:'user',content:req.user}], tools: [{type:'function', function: req.tool}], tool_choice: {type:'function', function:{name: req.tool.name}} })`; throws if `choices[0]?.finish_reason === 'length'` (truncated before completing the tool call); finds the `message.tool_calls` entry with `tc.type === 'function' && tc.function.name === req.tool.name` (**the SDK types `tool_calls` as a function/custom union — narrow on `type` first or strict mode won't compile**), `JSON.parse(tc.function.arguments)` → return; throws a descriptive error if the tool call is absent or arguments don't parse.
- `export const deepinfraAttempt = makeAttempt('DEEPINFRA_API_KEY', DEEPINFRA_BASE_URL, DEEPINFRA_MODEL)`; same for `nvidiaAttempt`.
- `export async function glmToolCall(req, attempts: ProviderAttempt[] = [deepinfraAttempt, nvidiaAttempt]): Promise<unknown>` — try in order; **`console.warn('glmToolCall: <provider> failed (<message>) — trying next provider')` on each failed attempt** so a silent primary-key misconfig or DeepInfra outage is visible in Render logs instead of degrading invisibly onto NVIDIA's capped free tier (loud failover, same principle as the boxes' medic); on all-fail throw one error naming every provider and its message (mirrors the medic's "BOTH providers failed" message shape).

**`src/llm/glm.test.ts`** (new)
- Unit (always run, stub attempts): first attempt throws → second's result returned; first succeeds → second never called; both throw → error message contains both provider messages.
- Live probe, `describe.skipIf(!process.env.DEEPINFRA_API_KEY)`, 30s timeouts: call `deepinfraAttempt` with a miniature extract-shaped tool (all-optional properties, nested `attributes` object with `additionalProperties: true`, no `required` array) on a fixture note; assert the result parses to an object with an expected field. Second test `describe.skipIf(!process.env.NVIDIA_API_KEY)`: same request via `nvidiaAttempt`. **This is the go/no-go probe for forced tool_choice (research open questions 1–3) — if either provider rejects it, stop and re-open the structured-output decision before Phase 2.**

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass (unit failover tests included)
- [ ] new `glm.test.ts` unit tests pass without any keys set (stubs only)

### Live verification (agent-executable)
- Prerequisites: `DEEPINFRA_API_KEY` + `NVIDIA_API_KEY` in `.env`
- [ ] `npx vitest run src/llm/glm.test.ts` with keys: both providers return a parsed object; capture output as evidence (finish_reason not 'length', tool call present on both)

### Manual verification
- [ ] none

---
*No manual items — continue to Phase 2 once automated + live checks pass.*

## Phase 2: Swap classifier + extractor (write path)

### What this phase does
Moves the two write-path call sites onto `glmToolCall`, renames their exports, and updates all consumers. The classify-before-L1 gate's semantics are unchanged: any provider failure (after failover) still throws → `transient_error` → 503 → Composio retries.

### Changes required

**`src/email/classify.ts`**
- Drop `import Anthropic from '@anthropic-ai/sdk'`; import `glmToolCall` from `../llm/glm.js`.
- `CLASSIFY_TOOL` becomes a plain `{name, description, parameters}` object (same JSON schema, `input_schema` key renamed `parameters`; type the constant with the Phase-1 request tool shape, not `Anthropic.Tool`).
- Rename `sonnetClassifier` → `glmClassifier`; body becomes: `const result = await glmToolCall({ system: CLASSIFY_SYSTEM, user: \`From: ...\`, tool: CLASSIFY_TOOL, maxTokens: 1024 }); return result as Classification;`. Update the header comment (Claude→GLM) and remove the per-call key check (the helper owns key errors now).

**`src/writePath/extract.ts`** — same treatment: `sonnetExtractor` → `glmExtractor`, `maxTokens: 2048`, schema unchanged apart from the `parameters` key.

**Consumers (rename only):** `src/inbound/webhook.ts:11,136` · `src/email/ingest.ts:5,81` · `src/writePath/recordFieldNote.ts:20,77` · `src/mcp/server.ts:47,628`.

**`src/email/classify.test.ts`** — gate on `DEEPINFRA_API_KEY`; import/describe renames; add `30_000` timeouts to both tests (current default 5s will flake on GLM reasoning latency).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass (all webhook/ingest/recordFieldNote unit tests still stub via the unchanged seams)
- [ ] `rg -n 'sonnetClassifier|sonnetExtractor' src scripts` returns nothing

### Live verification (agent-executable)
- Prerequisites: `DEEPINFRA_API_KEY` in `.env`
- [ ] `npx vitest run src/email/classify.test.ts` — both fixtures classified correctly by GLM (the quality spot-check for the L1 gate); capture the pass output

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 3: Swap synthesis + retire the Anthropic SDK

### What this phase does
Moves the two read-only synthesis call sites, then removes `@anthropic-ai/sdk` entirely — after this phase the repo has no Anthropic code path.

### Changes required

**`src/synthesis/answerQuestion.ts`** — `sonnetAnswerer` → `glmAnswerer`, via `glmToolCall` (`maxTokens: 2048`); keep the `toolUse.input`-equivalent cast and the `validateCitations` post-processing exactly as-is. **`src/synthesis/briefCustomer.ts`** — same, `sonnetBriefer` → `glmBriefer`. (`src/synthesis/index.ts` re-exports `*` — no change.)

**`src/mcp/server.ts:65-66,918,932`** — import + fallback renames.

**Tests** — `answerQuestion.test.ts`, `briefCustomer.test.ts`: gate on `DEEPINFRA_API_KEY`, rename imports/describes (30s timeouts already present).

**`package.json`** — `npm uninstall @anthropic-ai/sdk`.

**Comments referencing the old key/SDK** — `src/test.setup.ts:1` (mention `DEEPINFRA_API_KEY` instead), `src/mcp/server.ts:85` ("Supabase or Anthropic keys" → "Supabase or model-provider keys"), `scripts/smoke-http.mjs:19` (`DEEPINFRA_API_KEY must be set`).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass
- [ ] `rg -n "anthropic|ANTHROPIC" src scripts package.json --ignore-case` returns nothing (docs/thoughts hits are fine)

### Live verification (agent-executable)
- Prerequisites: `DEEPINFRA_API_KEY` in `.env`
- [ ] `npx vitest run src/synthesis` — grounded-answer ("capacitor"), no-fabrication, and citation-validity assertions pass on GLM (the synthesis quality gate); capture output

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 4: Env template, docs, deploy runbook

### What this phase does
Updates every document that names the old key, and produces the deploy checklist. Code is already done; this phase is docs + a full-stack local smoke.

### Changes required

**`.env.example`** — replace the `ANTHROPIC_API_KEY` line (:24) and its where-to-find entry (:11) with `DEEPINFRA_API_KEY` (deepinfra.com → Dashboard → API Keys) and `NVIDIA_API_KEY` (build.nvidia.com → Generate API Key), annotated "🔒 GLM-5.2 inference — primary / failover (write-path extractor + classifier + synthesis)".

**`docs/control-plane.md:76`** — cron's not-needed list: `ANTHROPIC_API_KEY` → `DEEPINFRA_API_KEY`/`NVIDIA_API_KEY`.

**`docs/nemoclaw-tech-agent.md`** — :19 diagram (`holds SUPABASE_* + DEEPINFRA/NVIDIA keys`); :51 secretRef block → two entries (`"DEEPINFRA_API_KEY": {"secretRef": "deepinfra-api-key"}`, `"NVIDIA_API_KEY": {"secretRef": "nvidia-api-key"}`); :68 Architecture A secrets list. (Satisfies the Box-Setup-Stuff sync rule — this is the agent-stack doc; `Box_Setup_Stuff/` itself has no live reference to the spine's model key, only the historical runbook note, which stays.)

**`scripts/smoke-http.mjs:91`** — pre-existing rot that would fail this phase's live gate: the script asserts `tools.length === 7`, but the base tool surface is now 12 (web_search/read_webpage/send_email/retract_capture/get_schedule landed since). Replace the exact-count assertion with a subset check — assert the list *includes* the tools the smoke actually drives (`record_field_note`, `brief_customer`, `answer_customer_question`) — so future tool additions stop breaking the smoke.

**Deploy checklist (goes in the PR description, executed by the user after merge):** Render web service env → add `DEEPINFRA_API_KEY` + `NVIDIA_API_KEY`, remove `ANTHROPIC_API_KEY`; deploy (beware: Render "Redeploy" builds the OLD commit — use "Deploy latest commit", per memory); watch logs for one inbound classification — the glm helper's failover warning means the logs also say WHICH provider served if DeepInfra was unhealthy.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass
- [ ] `rg -n 'ANTHROPIC_API_KEY' . --hidden -g '!thoughts/**' -g '!Box_Setup_Stuff/**' -g '!node_modules/**' -g '!.git/**' -g '!/.env' -g '!/.env.test'` returns nothing — note the globs exclude ONLY the root `.env`/`.env.test` (user-local), NOT `.env.example`: a `-g '!.env*'` basename glob would silently skip the very file this phase edits (thoughts/ = history; runbook note = deliberate history)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack running (`npx supabase start`), `DEEPINFRA_API_KEY` set, `npm run build` done, `.env` DB vars pointed at the LOCAL stack for this run (never the hosted pilot — smoke writes an L1 row)
- [ ] `node scripts/smoke-http.mjs` (in-process mode) — full write-path (L1 → GLM extract → match → L2) passes against the local stack; capture the summary line

### Manual verification
- [ ] After merge + Render deploy: send one work email to a paired test mailbox; confirm it lands as `ingested` in Render logs and a personal-style email lands `skipped_non_work` (cross-channel read-back of the pilot DB rows is the evidence — reads only)
- [ ] Remove `ANTHROPIC_API_KEY` from the Render dashboard (and optionally the local `.env`)

---
*Pause after Phase 4 for the manual deploy steps — they belong to the user.*
