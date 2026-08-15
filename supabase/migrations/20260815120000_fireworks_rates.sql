-- Fireworks Fast rates for the GLM-5.2 provider switch (2026-08-15).
--
-- The fleet + spine move from DeepInfra to Fireworks' fast router
-- (accounts/fireworks/routers/glm-5p2-fast — same GLM-5.2 weights, ~2.4x
-- faster wall-clock on the spine-eval corpus; full trial record in
-- thoughts/shared/research/2026-08-14-glm-5.2-inference-provider-options.md).
--
-- Distinct sku names from the deepinfra rows because the PRICED THING differs
-- (the fast-tier router, not the base model): cost_rates keys on
-- (provider, sku), and MODEL_SKUS maps vendor 'fireworks' to these.
--
-- cached-input is load-bearing here: Fireworks bills cached prefix tokens at
-- $0.21/M vs $2.10/M fresh, and ~90-95% of spine-call input is the stable
-- doctrine prefix — but ONLY when requests carry a stable prompt_cache_key
-- (per-replica cache; see INFERENCE_CACHE_KEY in src/model/forcedTool.ts).
--
-- Price book convention: never edit a rate in place — close with effective_to
-- and open a new row (the deepinfra/nvidia rows above follow the same rule).
insert into cost_rates (provider, sku, unit, unit_cost_usd, effective_from, source_url) values
  ('fireworks', 'glm-5.2-fast-input',        'token', 0.0000021,  '2026-08-15', 'https://fireworks.ai/blog/glm-5p2-fast'),
  ('fireworks', 'glm-5.2-fast-output',       'token', 0.0000066,  '2026-08-15', 'https://fireworks.ai/blog/glm-5p2-fast'),
  ('fireworks', 'glm-5.2-fast-cached-input', 'token', 0.00000021, '2026-08-15', 'https://fireworks.ai/blog/glm-5p2-fast');
