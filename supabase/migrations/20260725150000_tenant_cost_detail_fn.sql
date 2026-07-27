-- Per-tenant cost detail (the dashboard's tenant page).
--
-- An RPC rather than a PostgREST read for the same reason the rollup is one: the
-- spine counter writes ONE cost_events row per tool call, so a busy tenant has
-- thousands of rows in a month. Aggregating client-side would hit db-max-rows
-- (1000) and under-report SILENTLY — and PostgREST cannot GROUP BY anyway.
--
-- LEFT join to cost_rates, unlike the rollup's INNER join: the detail page is
-- where an operator goes to understand a number, so a line with usage but no
-- price must still appear — with a null cost — rather than vanish. That covers
-- both `spine` (a counter, unpriced by design, and the basis of the inference
-- allocation) and any sku whose rate has a gap.

create or replace function tenant_cost_detail(p_tenant_id uuid, p_period_start date)
returns table (
  provider   text,
  sku        text,
  unit       text,
  quantity   numeric,
  events     integer,
  cost_usd   numeric   -- null = no rate covered this line
)
language sql
security definer
set search_path = public
stable
as $$
  select e.provider,
         e.sku,
         max(e.unit) as unit,
         sum(e.quantity) as quantity,
         count(*)::integer as events,
         -- null unless EVERY event on this line matched a rate. `count(r.id) = 0`
         -- would only catch a wholly-unpriced sku: with a rate covering PART of
         -- the month, the unmatched events each contribute quantity * 0 and the
         -- line renders as a priced fact that is silently low. Reproduced: a rate
         -- closed mid-month showed the full unit count at half the cost, with no
         -- "not priced" note. "No rate" and "free" are different claims, and a
         -- partially-priced line is neither.
         case when count(r.id) <> count(*) then null
              else sum(e.quantity * r.unit_cost_usd) end as cost_usd
    from cost_events e
    left join cost_rates r
      on r.provider = e.provider
     and r.sku = e.sku
     and (e.occurred_at at time zone 'utc')::date >= r.effective_from
     and (e.occurred_at at time zone 'utc')::date <  coalesce(r.effective_to, 'infinity'::date)
   where e.tenant_id = p_tenant_id
     and (e.occurred_at at time zone 'utc')::date >= p_period_start
     and (e.occurred_at at time zone 'utc')::date <  (p_period_start + interval '1 month')::date
   group by e.provider, e.sku
   order by e.provider, e.sku;
$$;

-- Cross-tenant financial data: service-role only, same posture as rollup_costs.
revoke all on function tenant_cost_detail(uuid, date) from public, anon, authenticated;
