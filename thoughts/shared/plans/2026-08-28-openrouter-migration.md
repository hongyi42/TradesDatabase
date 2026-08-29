---
date: 2026-08-28
task: Move the SPINE (planner + forced-tool callers) to OpenRouter on GLM 5.3, with same-model/different-provider failover
research: thoughts/shared/research/2026-08-28-the-harness-audit.md
status: draft
supersedes: nothing
---

**Scope was SPLIT after adversarial review.** This plan covers the **spine only**. The seat-agent
half (Gemini 3.7 Flash on the boxes) is deferred to its own plan — review found three of its
mechanics do not work as the user's instructions assume. Those are enumerated at the end under
**"Deferred: the seat half"** and need decisions before they can be planned.

This is **Build 1 of the harness rebuild** ("the planner never goes down"), merged with the
provider migration.

## Overview

Today every model call resolves ONE endpoint with no retry (`src/model/forcedTool.ts:63`); a
provider outage becomes `tenantErrors += 1` and the deterministic constants take over. Routing
through OpenRouter makes failover a property of the request rather than code we write.

Verified live 2026-08-28 (`/api/v1/models/{id}/endpoints`): `z-ai/glm-5.3` has **10** upstream
providers, all supporting `tools` + `tool_choice`. `anthropic/claude-opus-5` has 9.

## Decisions

- **Planner model → `z-ai/glm-5.3`** (user). $1.40/M in, $4.40/M out vs Opus 5's $5/$25; ctx 1.31M.
  Provider AND model change together — accepted, with the planner eval as the regression check
  (which is why Phase 2 must repoint that eval; it hard-pins Fireworks today).
- **Gemini is NEVER a planner model** (user). Enforced in code — but see the correction below: it is
  a PER-REQUEST guard, not a startup guard, so it also needs a boot-time check to fail loudly.
- **The planner sets NO `provider` block** (user: *"Make sure caching works properly"*). OpenRouter
  uses **provider sticky routing** to keep caches warm ~10 min, and its docs state *"Sticky routing
  is not used when you specify a manual provider order via `provider.order`."* The planner's input
  is ~90% stable doctrine prefix, so cache hits outweigh marginal tps. Failover still happens —
  OpenRouter falls through on error by default.
  <https://openrouter.ai/docs/features/prompt-caching> · <https://openrouter.ai/docs/features/provider-routing>
- **Anthropic SDK path KEPT as the documented rollback** (user).
- **Cost stays token-SKU based** (mine). Switching the ledger to vendor-reported dollars would
  rewrite the rollup's `cost_events`→`cost_rates` join. With sticky routing the serving provider is
  stable and GLM 5.3's spread is $1.25–$1.40/M (~12%), inside tolerance.
- **`cacheWrite` SKU DROPPED from the openrouter entry** (review #6). `src/db/costs.ts:231-233`
  only emits a cache-write row when `cacheWriteTokens` is a number; if the response type carries no
  such field the SKU is dead weight. Phase 1 adds the field to the type and the SKU together, or
  neither.

## Plain-language walkthrough

The spine has one phone number for its AI provider. If that number is busy, nothing happens — the
timers take over and gaps get handed to managers on a clock. OpenRouter is a switchboard: one
account, and — the part that matters — **the same model from many different companies**. Asking for
`z-ai/glm-5.3` means "give me GLM 5.3 from whoever is available, and if they fail, try the next."
Ten companies serve it.

```
BEFORE                                AFTER
──────                                ─────
spine ──► Fireworks ──► GLM 5.2       spine ──► OpenRouter ──► GLM 5.3
          (one number, no retry)                  │            via any of 10
planner ► Anthropic ──► Opus 5                    └─ sticky-routed so the cache stays warm
                                      (Anthropic SDK path kept as the rollback)
```

**Phase 1** changes the code: new endpoint, new model, the cost ledger learns the new vendor, and
the guard that keeps Gemini off the planner. Nothing deploys.

**Phase 2** repoints the three eval harnesses, which today hard-code Fireworks and GLM-5.2 — without
this, the regression check named in the Decisions would keep measuring the OLD model on the OLD
provider and report a false pass.

**Phase 3** proves the cache works, applies the price rows to the pilot database, and deploys. This
is the phase that protects the bill: ~90% of what the planner sends every tick is the same doctrine
text and should be billed at a fraction.

## Secrets & env preflight

- **Phase 1:** `INFERENCE_API_KEY` — **already required**, VALUE changes to an OpenRouter key
  (openrouter.ai → Settings → Keys). Local `.env` only in this phase.
- **Phase 2:** `FIREWORKS_API_KEY` — **already required** by `scripts/agentic-eval/run.mjs:58`;
  after this phase that gate moves to `OPENROUTER_API_KEY` (same value as `INFERENCE_API_KEY`).
- **Phase 3:** on Render — `INFERENCE_API_KEY`, `INFERENCE_BASE_URL=https://openrouter.ai/api/v1`,
  `INFERENCE_MODEL=z-ai/glm-5.3`. `MODEL_PROVIDER` stays UNSET. `ANTHROPIC_API_KEY` /
  `ANTHROPIC_MODEL` stay set — they are the rollback, do not remove.
  Set on **both** the web service and the `lifecycle-heart` cron.
  `INFERENCE_CACHE_KEY` — leave set; expected INERT on OpenRouter (`prompt_cache_key` is
  OpenAI-specific). Phase 3 measures rather than assumes.

---

## Phase 1: The spine speaks OpenRouter

### What this phase does
Repoints the OpenAI-compatible transport, moves the planner to GLM 5.3, teaches the ledger the new
vendor, and adds the Gemini guard. Code only — nothing deploys.

### Changes required

**`src/model/forcedTool.ts`**
- `DEFAULT_OPENAI_BASE_URL` (:54) → `'https://openrouter.ai/api/v1'`
- `DEFAULT_OPENAI_MODEL` (:55) → `'z-ai/glm-5.3'`
- `ledgerVendor()` (:104): add `if (host.endsWith('openrouter.ai')) return 'openrouter';` before the
  fallthrough. KEEP the fireworks/nvidia arms — history is priced by joining these.
- **Restructure `resolveOpenAiEndpoint()` (:63-70) so the model id is a local** before the guard can
  reference it (review #7 — the id is currently computed inline in the returned literal):
  ```ts
  const model = process.env.INFERENCE_MODEL || DEFAULT_OPENAI_MODEL;
  // User ruling 2026-08-28: Gemini is a SEAT model, never the planner's. One
  // INFERENCE_MODEL typo would put it on the planner AND on all four
  // forced-tool callers. Enforced, not documented.
  if (/^google\/gemini/i.test(model)) {
    throw new Error(`INFERENCE_MODEL '${model}' is a seat model — never the spine's`);
  }
  return { apiKey, baseUrl: ..., model };
  ```
- **Also export `assertSpineModelAllowed()` and call it from the lifecycle's boot path** (review #7).
  `resolveOpenAiEndpoint()` is per-REQUEST (`forcedTool.ts:296`, `toolLoop.ts:301`), so a bad id
  throws inside `runPlanner`'s catch (`src/teamLead/planner.ts:2020`) and presents as `tenantErrors`
  — i.e. a misconfiguration disguised as a provider outage. It must fail loudly at boot instead.
- Response-body type (:335): add `cache_write_tokens?: number` to `prompt_tokens_details` (review
  #6 — without it the mapping below is TS2339).
- Usage mapping (:372): add `cacheWriteTokens: body.usage?.prompt_tokens_details?.cache_write_tokens`
- Attribution headers on the fetch (:297): `'HTTP-Referer'`, `'X-Title'`.

**`src/model/toolLoop.ts`** — the same four changes: type (:343), mapping (:383), headers (:308).
No `provider` block.

**`src/db/costs.ts`** — add to `MODEL_SKUS` (:135), matching the `anthropic` entry's shape:
```ts
openrouter: { provider: 'openrouter', input: 'glm-5.3-input', output: 'glm-5.3-output',
              cachedInput: 'glm-5.3-cached-input', cacheWrite: 'glm-5.3-cache-write' },
```

**New migration `supabase/migrations/<ts>_openrouter_cost_rates.sql`** — seed four `cost_rates` rows
at GLM 5.3 list price ($1.40/M in, $4.40/M out), **each with a `source_url`** (review #4:
`src/db/costs.test.ts:240` asserts every seeded rate has one starting `https://`). Do NOT touch
existing fireworks/deepinfra/anthropic/nvidia rates.

**Existing tests that BREAK and must be updated in this phase** (review #4, #5):
- `src/db/costs.test.ts:214-238` — `listCurrentRates returns the seeded book` pins the entire
  `(provider, sku)` vocabulary with an exact `toEqual`. Add the four openrouter rows.
- `src/model/toolLoop.test.ts:155` — asserts `ledgerVendor()` returns `'fireworks'` from the default
  base URL. Update to `'openrouter'`, or pin `INFERENCE_BASE_URL` explicitly in that block.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [x] New test: `ledgerVendor()` → `'openrouter'` for the OpenRouter URL; still `'fireworks'` /
      `'nvidia'` for theirs.
- [x] New test: `resolveOpenAiEndpoint()` THROWS for `google/gemini-3.7-flash`, does not for
      `z-ai/glm-5.3`. Plus: `hasModelCredentials()` still works (it reads env directly and never
      calls the resolver — confirm the throw did not change that).
- [x] New test: the OpenAI-path usage mapper reads `prompt_tokens_details.cache_write_tokens` into
      `cacheWriteTokens` (fixture body, no network).
- [x] New test: the boot-path assertion rejects a gemini `INFERENCE_MODEL` loudly.

### Live verification (agent-executable)
- Prerequisites: OpenRouter `INFERENCE_API_KEY` in `.env`; local Supabase stack running;
  `mcp__supabase-test__execute_sql` NOT needed (local stack only in this phase).
- [x] One real planner tick against the LOCAL stack. Capture the 200, the response `model` field
      (which upstream served it), and `usage`.
- [x] Read back on the LOCAL stack: `select provider, sku, quantity from cost_events order by
      created_at desc limit 8` shows `provider='openrouter'`. Evidence = the rows.

### Manual verification
- [x] None.

---
*No manual items — continue.*

## Phase 2: Repoint the eval harnesses

### What this phase does
Three eval harnesses resolve their own endpoint independently of `src/model/` and hard-code
Fireworks + GLM-5.2. Until they move, the regression check this migration relies on measures the
old model on the old provider and reports a false pass (review #8, #9).

### Changes required
- **`scripts/agentic-eval/run.mjs:58-66`** — the planner eval. Gate on `OPENROUTER_API_KEY` (falling
  back to `INFERENCE_API_KEY`), set `INFERENCE_BASE_URL=https://openrouter.ai/api/v1` and
  `INFERENCE_MODEL=z-ai/glm-5.3`. **Keep the no-silent-fallback discipline** its comment records —
  a missing key must exit 2, never quietly use a stale one.
- **`scripts/spine-eval/lib/env.mjs:126-127`** — default base URL and model.
- **`scripts/date-eval/plan.mjs:177`** — `expectedModel` default. Its own comment (:165-176) records
  that this exact staleness *"refused every run until someone set `DATE_EVAL_EXPECT_MODEL`, and the
  refusal looked like a fleet problem."* Note: this one asserts the FLEET's model, which does not
  change until the seat plan lands — leave it on the Fireworks id and add a comment saying why, or
  it will refuse every run.
- **`scripts/eval-date-reliability.mjs:120-121`** and **`.env.example:13-15, :36-37`**.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test`
- [ ] `node scripts/agentic-eval/run.mjs` with no key set exits 2 with a named-variable message.
- [ ] Grep proves no Fireworks pin remains outside the deliberate date-eval fleet assertion:
      `grep -rn "glm-5p2-fast\|api.fireworks.ai" scripts/ src/ .env.example` — every remaining hit is
      either a comment, a historical cost-rate, or the annotated date-eval line.

### Live verification (agent-executable)
- Prerequisites: OpenRouter key; local Supabase stack. Cost ~$0.40 for one planner-eval pass.
- [ ] Run the planner eval once against GLM 5.3. Record the score and compare to the last recorded
      Opus 5 run. Evidence = both scores side by side.

### Manual verification
- [ ] Judge whether GLM 5.3's written questions and handover notes read as well as Opus 5's. The
      graders score correctness; voice is a human call, and this is a model change, not just a
      provider change.

---
*Manual item present — STOP and wait for the user.*

## Phase 3: Prove the cache, price the pilot, deploy

### What this phase does
Measures cache behaviour before this reaches the pilot, seeds the price rows in the pilot database,
then deploys.

### Changes required
- **`scripts/probe-cache.mjs`** (new): send the SAME planner-shaped system+user twice ~5s apart;
  print `usage.prompt_tokens`, `usage.prompt_tokens_details.cached_tokens`, `usage.cost` and the
  response `model` for each call.
- **Apply the migration to the pilot** (review #11). Render deploys NO migrations
  (`docs/engineering-memory.md:3449`), and the monthly rollup INNER-joins `cost_rates`
  (`supabase/migrations/20260730120000_unprice_brave_composio.sql:121-124`), so unpriced rows are
  DROPPED — the exact NVIDIA failure class already recorded at `engineering-memory.md:1762-1766`.
  Use `mcp__supabase-test__apply_migration`. Verify against `information_schema`, never
  `list_migrations` (the pilot's ledger is out of sync with its real schema).
- **`docs/control-plane.md:145-154`** (review #10) — replace the WHOLE Fireworks block, header
  (*"Inference vars on this cron (Fireworks, set 2026-08-17)"*) and the closing Fireworks pricing
  sentence included. Also ADD the `INFERENCE_*` vars to the **web service** section at :100-111,
  which lists none today.
- **`docs/inference-recovery-runbook.md`** (review #14) — Fireworks-specific at :26, :44, :63, :70,
  :91, :112. This is the outage procedure; leaving it pointing at the retired vendor is the failure
  it exists to prevent. **Spine-side entries only** — the fleet entries stay until the seat plan.
- **`docs/engineering-memory.md`** — record the switch and the measured cache numbers.
- Only after the probe passes: set env on the Render web service AND `lifecycle-heart`.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] The probe's second call reports `cached_tokens > 0`. **If it reports 0, STOP — do not deploy**
      and report. That means `INFERENCE_CACHE_KEY` is inert AND sticky routing is not engaging,
      which changes the planner's running cost materially.

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test__apply_migration` + `execute_sql`; `mcp__render__*`
  (workspace `tea-d69903h5pdvs738dm81g`, owner yu.utaocai@gmail.com — pass `workspaceId`
  explicitly). Pilot DB is READ-ONLY except this one additive migration; never truncate.
- [ ] Confirm the four `cost_rates` rows exist in the pilot via `execute_sql` against
      `information_schema` + a direct select. Evidence = the rows.
- [ ] After env is set, read one `lifecycle-heart` tick JSON: `planner.mode` live, `tenantErrors: 0`.
- [ ] **Price the rows, not just count them** (review #11): read `cost_rollup_monthly` (or the
      `v_unpriced` orphan counter) and confirm OpenRouter spend APPEARS THERE — a `cost_events`
      query returns rows whether or not rates exist, so it cannot catch this failure.

### Manual verification
- [ ] None.

---

## Deferred: the seat half

Review found three blockers. **Two are now resolved** (user Q&A 2026-08-28, verified against
OpenRouter docs); one remains.

**RESOLVED — throughput sorting IS deliverable.** My earlier finding was wrong. `provider.sort` is a
body param and the gateway cannot inject body params — that holds — but OpenRouter also exposes
routing as a MODEL-ID SUFFIX, and the gateway can set a model id:
*"You can append `:nitro` to any model slug as a shortcut to sort by throughput"*
(<https://openrouter.ai/docs/features/provider-routing>; `:floor` sorts by price). `:nitro` is a
superset of plain sorting — it additionally opens priority-tier endpoints. So
`--model google/gemini-3.7-flash:nitro` would work.
**User decision 2026-08-28: no sorting — plain `google/gemini-3.7-flash`.** Default routing is
price-weighted with an outage filter (*"prioritize providers that have not seen significant outages
in the last 30 seconds … select one weighted by inverse square of the price"*), which lands on
Gemini's cheapest tier most of the time.

**RESOLVED — the cross-model fallback has a mechanism.** User decision 2026-08-28: if no Gemini
provider works, fall back to **`z-ai/glm-5.3-flash`** ($0.075/M in, $0.25/M out, ctx 1,310,720,
tools supported — verified live). OpenRouter's `models` array is a body param and therefore not
injectable, but the MEDIC already owns route-switching and its failover branch was deliberately
removed, not lost:
> `nemoclaw-inference-medic.sh:100-105` — *"No FALLBACK_* by design … Adding a fallback back is a
> two-line change. Do it deliberately, and only after probing the candidate: an unverified fallback
> is worse than none."*
`try_provider` is still factored out in `main()`. This yields two layers: OpenRouter falls through
Gemini's 6 endpoints per request; the medic switches the gateway route to `z-ai/glm-5.3-flash` on a
5-minute timer when all of Gemini is down. **The medic's own condition binds: probe GLM 5.3 Flash
before wiring it.**

**STILL OPEN — the canary.** `openshell inference set -g nemoclaw` is *"gateway-level → all
sandboxes"* (`doorman-architecture-memory.md:133`, `engineering-memory.md:1751`), so it switches
every seat on the box at once. A per-sandbox form exists (`bootstrap-box.sh:172`,
`nemoclaw inference set … --sandbox <AGENT>`) but whether it survives the medic's global re-assert
is UNTESTED. Until that is answered, "s2 first, then fleet" has no mechanism.

**Sequencing constraint for any seat plan.** The medic reverts a hand-run switch within 5 minutes
(`engineering-memory.md:1619`); the recorded rollback stops the medic timer FIRST (`:423`). And the
probe cannot run "from a host" — `probe_completion()` is hard-wired to `docker exec -u sandbox` into
a sandbox container, a shape marked LOAD-BEARING at `nemoclaw-inference-medic.sh:162-171`.

**Also outstanding:** `bootstrap-box.sh:287` prints a hardcoded `ok "fireworks-prod / …"` success
line that must move with :286 (review #13); `doorman-architecture-memory.md:126-140` and
`doorman-nemoclaw-setup-guide.md:498-524` both carry the production route and fall under the
Box_Setup_Stuff sync rule. Registration also needs `provider create --type openai` with
`OPENAI_BASE_URL` BEFORE `inference set` — cluster inference accepts only
openai/anthropic/nvidia/deepinfra/google-vertex-ai/aws-bedrock natively, and `inference set`
live-verifies, so it hard-fails without that step (`doorman-nemoclaw-setup-guide.md:510-511`).
