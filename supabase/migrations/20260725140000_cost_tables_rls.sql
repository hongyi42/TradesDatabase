-- Close the Data-API door on the cost ledger (Phase 4, user decision 2026-07-24).
--
-- WHY, with evidence. Verified on the local stack before this migration existed:
-- the publishable ("anon") key read cost_rollup_monthly, cost_events and
-- infra_costs at HTTP 200 straight from PostgREST, and cost_rates returned real
-- prices — bypassing the /admin bearer token entirely. All four tables showed
-- rls = false, as does `customers`, so this is the project's inherited posture
-- via auto_expose_new_tables (supabase/config.toml), NOT something the cost
-- feature introduced.
--
-- It matters more here than elsewhere: every other table holds ONE tenant's
-- business data, whereas cost_rollup_monthly holds EVERY tenant's spend in a
-- single table — one subtraction away from per-customer margin. It is the first
-- surface in this system that is deliberately cross-tenant, so "protected by the
-- bearer token" has to actually be true.
--
-- Mitigating fact, also verified: the anon key is not used anywhere in this
-- project (absent from .env.example and web/; src/db/client.ts uses the
-- service-role key exclusively). This was a latent exposure, not a live one.
--
-- WHY NO POLICY. The service-role key BYPASSES row-level security, and that is
-- the only key the server ever holds — so the cron's rollup, every src/db
-- accessor, and the /admin endpoint are all unaffected. Enabling RLS with no
-- permissive policy therefore means exactly one thing: anon and authenticated
-- get zero rows. Adding a policy would be strictly worse, since any policy is a
-- door and none of these tables has a legitimate client-side reader.
--
-- Also pays down the slice of the auto_expose_new_tables debt (due before
-- 2026-10-30, docs/engineering-memory.md §4) that carries the most risk.

alter table cost_rates          enable row level security;
alter table cost_events         enable row level security;
alter table infra_costs         enable row level security;
alter table cost_rollup_monthly enable row level security;

-- Belt and braces: revoke the Data-API grants too, so the tables are closed even
-- if a future migration or dashboard action toggles RLS back off. RLS alone
-- would be enough today; this makes the closure survive that mistake.
revoke all on cost_rates,          cost_events,
              infra_costs,         cost_rollup_monthly
  from anon, authenticated;
