-- OpenRouter / GLM 5.3 rates for the 2026-08-28 provider switch (plan
-- thoughts/shared/plans/2026-08-28-openrouter-migration.md). Prices read from
-- OpenRouter's own catalogue on 2026-08-28 (GET /api/v1/models, z-ai/glm-5.3):
--   prompt            0.0000014   -> $1.40/M
--   completion        0.0000044   -> $4.40/M
--   input_cache_read  0.00000026  -> $0.26/M  (~0.19x base — a real discount)
--
-- THE CACHE-WRITE ROW IS DELIBERATELY $0. OpenRouter publishes NO
-- `input_cache_write` price for this model, so writes are not separately
-- charged. Seeding the SKU at zero rather than omitting it follows the nvidia
-- precedent (src/db/costs.ts): the monthly rollup INNER-joins cost_rates, so an
-- unpriced SKU makes its rows VANISH from the rollup instead of showing as
-- zero. The token counts and the provider attribution are the point; if an
-- upstream ever starts charging for writes, the quantities are already there.
--
-- Fireworks / DeepInfra / NVIDIA / Anthropic rates all REMAIN. This table
-- prices HISTORY by joining cost_events; removing a retired vendor's rates
-- makes its past months un-priceable.
insert into cost_rates (provider, sku, unit, unit_cost_usd, effective_from, source_url) values
  ('openrouter', 'glm-5.3-input',        'token', 0.00000140, '2026-08-28', 'https://openrouter.ai/z-ai/glm-5.3'),
  ('openrouter', 'glm-5.3-output',       'token', 0.00000440, '2026-08-28', 'https://openrouter.ai/z-ai/glm-5.3'),
  ('openrouter', 'glm-5.3-cached-input', 'token', 0.00000026, '2026-08-28', 'https://openrouter.ai/z-ai/glm-5.3'),
  ('openrouter', 'glm-5.3-cache-write',  'token', 0.00000000, '2026-08-28', 'https://openrouter.ai/docs/features/prompt-caching');
