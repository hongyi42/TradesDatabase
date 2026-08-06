-- Price the NVIDIA failover at its real rate ($0) so failover traffic is
-- VISIBLE instead of silently dropped.
--
-- Found 2026-08-06 while chasing a suspected stuck failover: cost_rates had
-- deepinfra + anthropic rows only, so a provider flip to NVIDIA would not show
-- up as a provider change in the cost data — it would silently stop the meter.
-- Two layers conspire: recordModelUsage throws on an unmapped vendor (caught,
-- logged, events never written), and the Phase-3 rollup INNER joins cost_rates,
-- so even a written event with no rate row vanishes from the dashboard. The
-- ledgerVendor() seam was BUILT for this — it derives 'nvidia' from the
-- resolved INFERENCE_BASE_URL host precisely so a failover is not priced
-- against a DeepInfra invoice that never arrives — but the vocabulary was
-- never seeded, so the loud path it aimed for was a swallowed error.
--
-- Consequence while unseeded: "zero spend" was AMBIGUOUS — it could mean idle,
-- or it could mean failed-over. A $0 row is not pedantry; it converts absence
-- of data into presence of a $0.00 line with a token count attached.
--
-- Rate: $0. The account runs NVIDIA's free evaluation tier (build.nvidia.com;
-- its per-worker concurrency cap of 32 is the documented reason DeepInfra is
-- primary — see docs/engineering-memory.md). If the account ever moves to paid
-- NIM endpoints, follow the price book convention: CLOSE these rows
-- (effective_to) and open new ones — never edit a rate in place.
--
-- Same GLM sku names as the deepinfra rows on purpose: cost_rates keys on
-- (provider, sku), and MODEL_SKUS maps vendor 'nvidia' to these — the model is
-- the same GLM-5.2, only the biller differs.
insert into cost_rates (provider, sku, unit, unit_cost_usd, effective_from, source_url) values
  ('nvidia', 'glm-5.2-input',  'token', 0, '2026-07-11', 'https://build.nvidia.com/zai-org'),
  ('nvidia', 'glm-5.2-output', 'token', 0, '2026-07-11', 'https://build.nvidia.com/zai-org');
