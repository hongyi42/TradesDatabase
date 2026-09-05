-- OpenRouter rates for the SEAT FLEET's models (the 2026-09-05 switch —
-- thoughts/shared/plans/2026-09-05-fleet-to-openrouter-muse-spark.md).
--
-- The six seat agents moved from Fireworks/GLM-5.2 to an OpenRouter preset
-- (`@preset/trades-seats`) that serves meta/muse-spark-1.3 and falls back,
-- per request, to ~google/gemini-flash-latest (google/gemini-3.8-flash today).
--
-- WHY THESE ROWS EXIST WHEN NOTHING STAMPS THEM. Seat inference never passes
-- through recordModelUsage — the gateway is a credential-injecting passthrough
-- — so no cost_events row carries these SKUs today. Seat spend is ACCOUNT-LEVEL:
-- the OpenRouter invoice contains it, and the rollup nets the spine's measured
-- spend out of that bill (src/db/costs.ts, "NOTE this is spine spend"). The
-- price book still needs the rates so that (a) anything that DOES price seat
-- traffic later is not silently dropped by the rollup's INNER join on
-- cost_rates, and (b) the numbers a reader reasons with are the vendor's, not a
-- memory. MODEL_SKUS (the spine's WRITE path) is unchanged: the spine stays on
-- z-ai/glm-5.3.
--
-- cache-write rows are seeded even where the price is $0, for the same reason
-- NVIDIA's $0 rows are: the rollup drops an UNPRICED sku rather than showing
-- it as zero. Muse publishes no input_cache_write price (0); Gemini publishes
-- $0.0417/M. Cached-input on Muse is IMPLICIT (measured 1,137/1,264 tokens hit
-- on a repeat); on Gemini it needs cache_control breakpoints the gateway does
-- not send, so the Gemini cached-input row prices a path the fleet cannot
-- reach today — kept for honesty and for the spine, which could.
--
-- Price book convention: never edit a rate in place — close with effective_to
-- and open a new row. Rates read from the OpenRouter model pages 2026-09-05.
insert into cost_rates (provider, sku, unit, unit_cost_usd, effective_from, source_url) values
  ('openrouter', 'muse-spark-1.3-input',          'token', 0.00000125,   '2026-09-05', 'https://openrouter.ai/meta/muse-spark-1.3'),
  ('openrouter', 'muse-spark-1.3-output',         'token', 0.00000425,   '2026-09-05', 'https://openrouter.ai/meta/muse-spark-1.3'),
  ('openrouter', 'muse-spark-1.3-cached-input',   'token', 0.00000015,   '2026-09-05', 'https://openrouter.ai/meta/muse-spark-1.3'),
  ('openrouter', 'muse-spark-1.3-cache-write',    'token', 0,            '2026-09-05', 'https://openrouter.ai/meta/muse-spark-1.3'),
  ('openrouter', 'gemini-3.8-flash-input',        'token', 0.00000075,   '2026-09-05', 'https://openrouter.ai/google/gemini-3.8-flash'),
  ('openrouter', 'gemini-3.8-flash-output',       'token', 0.00000375,   '2026-09-05', 'https://openrouter.ai/google/gemini-3.8-flash'),
  ('openrouter', 'gemini-3.8-flash-cached-input', 'token', 0.000000075,  '2026-09-05', 'https://openrouter.ai/google/gemini-3.8-flash'),
  ('openrouter', 'gemini-3.8-flash-cache-write',  'token', 0.0000000417, '2026-09-05', 'https://openrouter.ai/google/gemini-3.8-flash');
