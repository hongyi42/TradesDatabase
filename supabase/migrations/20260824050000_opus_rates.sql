-- Opus 5 rates for the 2026-08-24 planner switch (user ruling). Four tiers:
-- base in/out, cache reads at 0.1x, 1h-TTL cache writes at 2x. Source:
-- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
-- (multipliers verified 2026-08-24: 5m write 1.25x, 1h write 2x, reads 0.1x,
-- TTL refreshes free on every read) and the Anthropic pricing page for the
-- Opus 5 base ($5/M in, $25/M out). Sonnet rates remain for history.
insert into cost_rates (provider, sku, unit, unit_cost_usd, effective_from, source_url) values
  ('anthropic', 'claude-opus-5-input',          'token', 0.00000500, '2026-08-24', 'https://docs.claude.com/en/docs/about-claude/pricing'),
  ('anthropic', 'claude-opus-5-output',         'token', 0.00002500, '2026-08-24', 'https://docs.claude.com/en/docs/about-claude/pricing'),
  ('anthropic', 'claude-opus-5-cached-input',   'token', 0.00000050, '2026-08-24', 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching'),
  ('anthropic', 'claude-opus-5-cache-write-1h', 'token', 0.00001000, '2026-08-24', 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching');
