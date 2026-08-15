# Plan: switch GLM-5.2 inference from DeepInfra to Fireworks Fast

**Date:** 2026-08-15 · **Branch:** `feat/fireworks-switch` (off main)
**Basis:** the provider trial ([research](../research/2026-08-14-glm-5.2-inference-provider-options.md)):
provider-equal accuracy (57/59 ≡ anchor-adjusted 59/59), wall p50 7.8s vs 18.8s, billed cache
$0.21/M with mandatory `prompt_cache_key`, model id `accounts/fireworks/routers/glm-5p2-fast`
(1M context, same weights as standard). DeepInfra stays fully configured as instant rollback.

## Phase 1 — Spine code + Render (the repo half)

1. **`src/model/forcedTool.ts`**
   - `ledgerVendor()`: map `*.fireworks.ai` → `'fireworks'`.
   - Send `prompt_cache_key` + `user` on every call when `INFERENCE_CACHE_KEY` is set
     (env-gated: unset = today's behavior; value `tradesdb-spine` planned). Harmless on
     DeepInfra (ignored there — verified during the GLM cache-key trial).
2. **`src/db/costs.ts`**: `MODEL_SKUS.fireworks` = `{provider: 'fireworks', input/output/
   cachedInput: 'glm-5.2-fast-*'}`; seed `cost_rates` rows at $2.10 / $6.60 / $0.21 per 1M
   through whatever path seeded the DeepInfra rates (find it; if it's a migration, follow the
   system-design skill's migration rules).
3. **Eval/date-eval defaults**: `scripts/date-eval/plan.mjs` `expectedModel` default and
   `scripts/date-eval/README.md` — parameterize or update to the Fireworks id (the exact
   id-spelling gate that has bitten twice; also check `scripts/eval-date-reliability.mjs`
   stale defaults).
4. Unit tests for the vendor mapping + SKU entry; full gates; PR; merge.
5. **Render env flip** (needs dashboard access — user or documented handoff):
   `INFERENCE_BASE_URL=https://api.fireworks.ai/inference/v1`,
   `INFERENCE_API_KEY=<fireworks key>`, `INFERENCE_MODEL=accounts/fireworks/routers/glm-5p2-fast`,
   `INFERENCE_CACHE_KEY=tradesdb-spine`. **Deploy latest commit — never "Redeploy"**
   (serves the OLD commit; recorded trap).
6. **Verify (cross-channel)**: trigger one model-backed spine call; read `cost_events` back via
   the `supabase-test` MCP (provider = `fireworks`, cached split present); DeepInfra billing
   collector logs its clean skip.

## Phase 2 — Fleet route + medic (the box half)

1. Provider: `openshell provider create -g nemoclaw --name fireworks-prod --type openai
   --config OPENAI_BASE_URL=https://api.fireworks.ai/inference/v1 --credential
   OPENAI_API_KEY=<key>` (key via stdin, not argv — the validated Nebius pattern).
2. Route: `openshell inference set -g nemoclaw --provider fireworks-prod --model
   accounts/fireworks/routers/glm-5p2-fast`. `deepinfra-prod` remains configured = instant
   rollback (the nvidia-prod pattern).
3. **Medic**: update `WANT_PROVIDER=fireworks-prod` / `WANT_MODEL=…glm-5p2-fast` in
   `nemoclaw-inference-medic.sh` — box deploy (install + restart units, md5-verify the path
   the unit runs, NOT a sibling copy) + repo copy + Box_Setup_Stuff byte-identical sync.
   Medic timer stays STOPPED between route flip and medic deploy (5-min revert trap).
4. **Fleet cache-key investigation**: whether openshell's openai provider type can inject
   default body params (`prompt_cache_key`). If yes, wire it; if no, accept replica-luck
   caching fleet-side for now and open a follow-up (cost impact bounded: fleet volume is
   modest; the probe showed uncached calls still complete fine).
5. **Verify**: `openshell inference get`; medic tick log shows "serving verified (tool call
   returned)" against fireworks-prod; one live agent turn on s2 via the CLI path.

## Phase 3 — Behavior verification + docs

1. **Evening date-eval on the new route** (post-5pm PDT, started ≥1h clear of firm-local
   midnight): expect v3-class accuracy; turn latency should beat v3's 14.1s median. The
   route-flip window procedure from the Nebius trial applies (medic handled in Phase 2).
2. User: Fireworks console billing sanity check (cached share visible) + billing model check
   (prepaid credits? if so, enable auto-recharge — the DeepInfra balance-out doctrine applies
   to every prepaid provider).
3. Docs: engineering-memory (provider = Fireworks Fast, DeepInfra = rollback), Box_Setup_Stuff
   setup guide + nemoclaw-tech-agent.md sync, memory index updates.

## Rollback

Any phase: Render env revert (Phase 1) and/or `openshell inference set … --provider
deepinfra-prod --model zai-org/GLM-5.2` + medic revert (Phase 2). Model id spelling differs
between providers — every gate that compares model strings is listed in Phase 1.3.
