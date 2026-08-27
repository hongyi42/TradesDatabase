-- Per-DAY, per-LANE priced spend — the read side of the cost label.
--
-- WHY A VIEW: cost_rollup_monthly aggregates away both the sku and the day (its
-- PK is (tenant_id, period_start, provider, method)), so every "what did the
-- planner cost on Tuesday" question was a hand-written lateral join against
-- cost_rates. That join is exactly where events silently vanish — see the
-- companion view below — so writing it once, here, and having every reader use
-- it is the difference between one answer and several that disagree.
--
-- Readers: `npm run ticks` (this plan) and `npm run costs:reconcile` (the
-- sibling bill-check plan). cost_rollup_monthly is UNCHANGED and still owns the
-- monthly/allocated picture, including the infra-bill allocation these views
-- deliberately do not attempt.
--
-- ⚠ THE JOIN PREDICATE BELOW IS COPIED VERBATIM from rollup_costs
-- (20260725130000_cost_rollup_fn.sql, "Pass 1"). The duplication is deliberate —
-- a view cannot call into a plpgsql function's body — and it is load-bearing:
--   * the rate window is HALF-OPEN [from, to), matching the daterange exclusion
--     constraint on cost_rates exactly. With `between` a rate closed on its
--     successor's opening date would match BOTH rows and double-price that day.
--   * `at time zone 'utc'` is explicit on every cast, because occurred_at is
--     timestamptz and the rate columns are date: a bare ::date resolves against
--     the session TimeZone GUC and would shift both the rate boundary and the
--     day bucket by hours whenever a session ran non-UTC.
-- CHANGE THE TWO TOGETHER. If they drift, the daily view and the monthly rollup
-- will quietly disagree about the same dollars.

create view priced_cost_events_daily as
select (e.occurred_at at time zone 'utc')::date as day,
       e.tenant_id,
       e.provider,
       e.sku,
       e.method,
       -- NULL for every row written before the lane label existed, and for every
       -- caller that does not set one. That is correct and must NOT be
       -- backfilled: we do not know which lane wrote those rows, and guessing
       -- would put a confident wrong answer where an honest gap belongs.
       e.metadata->>'lane' as lane,
       sum(e.quantity)                     as quantity,
       sum(e.quantity * r.unit_cost_usd)   as cost_usd
  from cost_events e
  join cost_rates r
    on r.provider = e.provider
   and r.sku = e.sku
   and (e.occurred_at at time zone 'utc')::date >= r.effective_from
   and (e.occurred_at at time zone 'utc')::date <  coalesce(r.effective_to, 'infinity'::date)
 group by 1, 2, 3, 4, 5, 6;

-- What the INNER join above dropped. An event whose (provider, sku) has no rate
-- for its day does not appear as $0 — it disappears entirely, reading as "no
-- spend" rather than "not priced". For a cost figure the quiet under-report is
-- the worst failure there is, so the orphans get their own view and every
-- reader is required to print this count beside any dollar total.
--
-- 'spine' is excluded: it is an allocation COUNTER, not a billed vendor, and is
-- unpriced BY DESIGN (same carve-out as rollup_costs). Composio/Brave tool_call
-- rows are NOT excluded — their rates were deliberately deleted, so they belong
-- in this view where they stay visible.
create view unpriced_cost_events_daily as
select (e.occurred_at at time zone 'utc')::date as day,
       e.tenant_id,
       e.provider,
       e.sku,
       e.method,
       e.metadata->>'lane' as lane,
       count(*)         as events,
       sum(e.quantity)  as quantity
  from cost_events e
 where e.provider <> 'spine'
   and not exists (
     select 1 from cost_rates r
      where r.provider = e.provider
        and r.sku = e.sku
        and (e.occurred_at at time zone 'utc')::date >= r.effective_from
        and (e.occurred_at at time zone 'utc')::date <  coalesce(r.effective_to, 'infinity'::date)
   )
 group by 1, 2, 3, 4, 5, 6;

-- Both views read cost_events, which is service-role-only. Revoked explicitly
-- rather than relying on the default: this project still runs with
-- api.auto_expose_new_tables on (deprecated, removed 2026-10-30), so a new
-- relation in the public schema is published to the Data API unless told
-- otherwise — and per-tenant spend is not something anon should ever reach.
revoke all on priced_cost_events_daily from anon, authenticated;
revoke all on unpriced_cost_events_daily from anon, authenticated;
