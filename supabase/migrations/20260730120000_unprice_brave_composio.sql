-- Unprice Brave and Composio: they become counters, not billed vendors.
--
-- WHY. Neither vendor charges per unit from the first one:
--   * Brave grants $5 of credit every month (~1,000 searches) before billing
--     $5/1,000. The seeded rate was justified by a comment claiming the free
--     tier was removed in Feb 2026; Brave's pricing page documents the credit
--     as current and renewing (verified 2026-07-30).
--   * Composio's $0.299/1,000 is an OVERAGE rate. The free tier includes 20,000
--     tool calls/month; this account is on Free and used 389 in July 2026
--     (verified live via POST /api/v3.1/project/usage/summary, which returns
--     counts only — no dollar figures, which is why there is no auto-collector
--     for it the way DeepInfra has one).
-- Pricing per unit therefore reported spend neither vendor charges.
--
-- DELETED, not closed with effective_to. Closing is the documented mechanism for
-- a price CHANGE, which preserves history because the rollup joins on the event's
-- own date. This is a CORRECTION — these rates never described how the vendors
-- bill — so the rows go entirely, and July's phantom $0.015 of Brave spend goes
-- with them. Deleting is also what lets the unpriced-event signal below become
-- data-driven: with no rows at all, "unpriced by design" and "price-book gap"
-- are finally distinguishable from the data.
--
-- Units keep flowing. backfillBraveCostEvents and recordComposioCall are
-- unchanged; their events remain the per-tenant attribution basis and render as
-- '—' on the tenant page, exactly as `spine` already does.
--
-- Plan: thoughts/shared/plans/2026-07-30-unprice-brave-composio.md

delete from cost_rates where provider in ('brave', 'composio');

-- Re-stated in full with ONE predicate changed (the unpriced-event count below).
-- create or replace preserves existing privileges, but the revoke is restated at
-- the end as cheap insurance: this function reads every tenant's spend.

create or replace function rollup_costs(p_period_start date)
returns table (rows_written integer, tenants_touched integer, unpriced_events integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_end   date := (p_period_start + interval '1 month')::date;
  v_tenant_count integer;
  v_bill         record;
  v_written      integer := 0;
  v_unpriced     integer := 0;
  v_measured     numeric;
  v_serve_all    boolean;
  v_n            integer;
begin
  -- Periods are whole months, and the DELETE below only clears the exact
  -- period_start it is handed. A mid-month argument would therefore write a
  -- SECOND set of rows for events already rolled up under the 1st — invisible
  -- in a single-month view, but silently doubling any query that sums across
  -- periods (the dashboard's 90-day trend).
  if p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'rollup_costs: p_period_start must be the first of a month, got %', p_period_start;
  end if;

  -- Serialize concurrent runs. The delete-then-insert recompute is not safe to
  -- interleave: a second caller's DELETE cannot see the first's uncommitted
  -- rows, so its INSERT then collides on the primary key once the first
  -- commits. Render runs at most one cron at a time, but an operator invoking
  -- the RPC by hand during a tick is exactly the documented verification step —
  -- and the failure would surface as a red heartbeat. Released at commit.
  perform pg_advisory_xact_lock(hashtext('rollup_costs'), 0);

  -- Only tenants we actually serve. An unfiltered count(*) sweeps in seeded demo
  -- rows and abandoned test tenants, and the zero-denominator fallback below then
  -- hands each of them a slice of a real invoice — diluting the paying customer's
  -- figure and putting phantom spend on the dashboard. That fallback fires in two
  -- ordinary windows: the first tick after migration, and every previous-month
  -- rollup for months that predate the collectors.
  select count(*) into v_tenant_count
    from tenants t
   where exists (select 1 from technicians x where x.tenant_id = t.id and x.state = 'active')
      or exists (select 1 from cost_events e where e.tenant_id = t.id
                   and (e.occurred_at at time zone 'utc')::date >= p_period_start
                   and (e.occurred_at at time zone 'utc')::date <  v_period_end);

  -- ...but if NOTHING qualifies, fall back to every tenant rather than allocating
  -- the bill to nobody. A silently vanished invoice understates the total, which
  -- is the same quiet under-report the filter above exists to prevent — just from
  -- the other direction. v_serve_all drives both the count and the CTE so the two
  -- populations can never disagree.
  v_serve_all := (v_tenant_count = 0);
  if v_serve_all then
    select count(*) into v_tenant_count from tenants;
  end if;

  -- FULL RECOMPUTE of the period: delete then insert. An upsert-only rollup
  -- would leave stale rows behind when an infra_costs row is removed or a
  -- mis-entered rate is corrected — the total would silently keep a ghost in it.
  delete from cost_rollup_monthly where period_start = p_period_start;

  -- ── Pass 1: metered events, priced at the rate in force ON THE DAY each one
  -- happened (not today's rate). This is what makes history re-price correctly
  -- when a vendor changes prices mid-month.
  --
  -- INNER join, deliberately: an event whose (provider, sku) has no rate is
  -- dropped. That is how 'spine' — a counter, not a billed vendor — stays out of
  -- the measured totals while still driving the allocation pass below.
  --
  -- The rate window is HALF-OPEN [from, to), matching the daterange exclusion
  -- constraint on cost_rates exactly. With `between` (inclusive), a rate closed
  -- on its successor's opening date would match BOTH rows and double-price that
  -- day.
  --
  -- `at time zone 'utc'` is explicit on every cast: occurred_at is timestamptz
  -- and the rate columns are date, so a bare ::date would resolve against the
  -- session TimeZone GUC and shift both the rate boundary and the month bucket
  -- by hours whenever a session ran non-UTC.
  insert into cost_rollup_monthly (tenant_id, period_start, provider, method, cost_usd, quantity)
  select e.tenant_id,
         p_period_start,
         e.provider,
         e.method,
         sum(e.quantity * r.unit_cost_usd),
         sum(e.quantity)
    from cost_events e
    join cost_rates r
      on r.provider = e.provider
     and r.sku = e.sku
     and (e.occurred_at at time zone 'utc')::date >= r.effective_from
     and (e.occurred_at at time zone 'utc')::date <  coalesce(r.effective_to, 'infinity'::date)
   where (e.occurred_at at time zone 'utc')::date >= p_period_start
     and (e.occurred_at at time zone 'utc')::date <  v_period_end
   group by e.tenant_id, e.provider, e.method;
  get diagnostics v_n = row_count;
  v_written := v_written + v_n;

  -- ── How much spend did that INNER join silently drop?
  -- Nothing requires cost_rates to cover every day continuously, so the routine
  -- "close the old rate, open the new one" done in the wrong order leaves a gap
  -- — and every event in it disappears from the dashboard with no error, reading
  -- as "no spend" rather than "not priced". Same for a SKU nobody seeded. The
  -- inner join is correct; what was missing is the signal, so count the orphans
  -- and hand them back for the cron summary to surface.
  select count(*) into v_unpriced
    from cost_events e
   where (e.occurred_at at time zone 'utc')::date >= p_period_start
     and (e.occurred_at at time zone 'utc')::date <  v_period_end
     -- A provider with NO rate rows AT ALL is a counter by design (spine,
     -- brave, composio — and google/telephony when they arrive). A provider
     -- that HAS rates but none covering this event has a real price-book gap,
     -- which is the only thing this signal should ever fire on. Derived from
     -- the price book instead of a hardcoded name list, so a new counter needs
     -- no code change here — the previous `provider <> 'spine'` form would have
     -- reported hundreds of deliberate counters as gaps every 15 minutes and
     -- trained everyone to ignore the one alarm that catches a real hole.
     and exists (select 1 from cost_rates r2 where r2.provider = e.provider)
     and not exists (
       select 1 from cost_rates r
        where r.provider = e.provider
          and r.sku = e.sku
          and (e.occurred_at at time zone 'utc')::date >= r.effective_from
          and (e.occurred_at at time zone 'utc')::date <  coalesce(r.effective_to, 'infinity'::date)
     );

  -- ── Pass 2: flat monthly bills, split across tenants by each bill's own rule.
  -- Matched by the bill's period_start falling inside this month, so a bill
  -- spanning a boundary is counted once, in the month it starts.
  if v_tenant_count > 0 then
    for v_bill in
      select * from infra_costs
       where period_start >= p_period_start
         and period_start <  v_period_end
         and allocation <> 'unallocated'
    loop
      -- ── Net out what we ALREADY measured for this vendor. ────────────────
      -- Since the spine's model calls moved to GLM on DeepInfra (PR #81), one
      -- vendor can carry both: per-tenant metered spine spend AND the agent
      -- invoice. There is ONE DeepInfra account, so that invoice already
      -- CONTAINS the spine's tokens — allocating it whole on top of measuring
      -- them counts the same dollars twice and overstates the headline number.
      -- Reproduced before this guard: $9.30 measured + $100 invoice = $109.30
      -- reported for $100 of real spend.
      --
      -- greatest(...,0): if measurement somehow exceeds the invoice (a rate that
      -- drifted above the vendor's real price), allocate nothing rather than a
      -- negative share — the measured rows still stand on their own.
      select coalesce(sum(e.quantity * r.unit_cost_usd), 0) into v_measured
        from cost_events e
        join cost_rates r
          on r.provider = e.provider
         and r.sku = e.sku
         and (e.occurred_at at time zone 'utc')::date >= r.effective_from
         and (e.occurred_at at time zone 'utc')::date <  coalesce(r.effective_to, 'infinity'::date)
       where e.provider = v_bill.vendor
         and (e.occurred_at at time zone 'utc')::date >= p_period_start
         and (e.occurred_at at time zone 'utc')::date <  v_period_end;

      -- One weights CTE serves every rule, so the zero-denominator guard is
      -- written once instead of per-rule: when the chosen weight sums to zero
      -- (no spine calls yet, no active seats, no sandboxes), the split falls
      -- back to equal shares rather than dividing by zero or silently
      -- attributing the whole bill to nobody.
      with w as (
        select t.id as tenant_id,
               (case v_bill.allocation
                  when 'per_spine_tool_call' then coalesce(s.spine_qty, 0)
                  when 'per_active_seat'     then coalesce(a.active_seats, 0)
                  when 'per_sandbox'         then coalesce(b.sandboxes, 0)
                  else 1
                end)::numeric as weight
          -- Same population as v_tenant_count above: a tenant that is not in the
          -- count must not be in the split either, or the shares stop summing
          -- to the invoice.
          from (
            select t.id from tenants t
             where v_serve_all
                or exists (select 1 from technicians x where x.tenant_id = t.id and x.state = 'active')
                or exists (select 1 from cost_events e where e.tenant_id = t.id
                             and (e.occurred_at at time zone 'utc')::date >= p_period_start
                             and (e.occurred_at at time zone 'utc')::date <  v_period_end)
          ) t
          left join (
            select tenant_id, sum(quantity) as spine_qty
              from cost_events
             where provider = 'spine'
               and (occurred_at at time zone 'utc')::date >= p_period_start
               and (occurred_at at time zone 'utc')::date <  v_period_end
             group by tenant_id
          ) s on s.tenant_id = t.id
          left join (
            select tenant_id, count(*) as active_seats
              from technicians where state = 'active' group by tenant_id
          ) a on a.tenant_id = t.id
          left join (
            select tenant_id, count(*) as sandboxes
              from technicians where sandbox_ref is not null group by tenant_id
          ) b on b.tenant_id = t.id
      ),
      tot as (select sum(weight) as total from w)
      insert into cost_rollup_monthly (tenant_id, period_start, provider, method, cost_usd, quantity)
      select w.tenant_id,
             p_period_start,
             v_bill.vendor,
             'allocated',
             greatest(v_bill.amount_usd - v_measured, 0) * (case
               when tot.total > 0 then w.weight / tot.total
               else 1.0 / v_tenant_count
             end),
             0
        from w cross join tot
       -- Skip zero shares: an idle tenant would otherwise get a $0.00 row per
       -- bill per month, which the dashboard renders as an "est." line saying
       -- nothing, and which inflates tenants_touched into a meaningless count.
       -- The `tot.total <= 0` arm keeps the equal-split fallback intact, where
       -- every weight is zero but every tenant still owes a share.
       where w.weight > 0 or tot.total <= 0
      -- Two bills from one vendor in a month must SUM, not overwrite each other.
      on conflict (tenant_id, period_start, provider, method)
      do update set cost_usd    = cost_rollup_monthly.cost_usd + excluded.cost_usd,
                    computed_at = now();
      get diagnostics v_n = row_count;
      v_written := v_written + v_n;
    end loop;
  end if;

  return query
    select v_written,
           (select count(distinct tenant_id)::integer
              from cost_rollup_monthly where period_start = p_period_start),
           v_unpriced;
end;
$$;

-- The rollup reads every tenant's spend, so it stays service-role only: the
-- anon/authenticated roles must not be able to invoke a cross-tenant aggregate.
revoke all on function rollup_costs(date) from public, anon, authenticated;
