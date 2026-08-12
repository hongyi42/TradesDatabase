-- v_schedule counted cancelled visits as scheduled work.
--
-- Found by the 2026-08-12 date eval, which graded the agent against truth
-- derived independently from assignments: every "how many visits…" count came
-- back inflated by a constant — August 234 vs 144 (+90), this week 82 vs 57
-- (+25), last 30 days 57 vs 27 (+30). The offsets are exactly the cancelled
-- rows in each window: the view's only predicate was the tenant GUC, so
-- count(*) over v_schedule counted every assignment ever made, cancelled or
-- not. The agent's SQL was impeccable — clean boundaries, straight count(*) —
-- which is what makes this class dangerous: a plausible number, no weekday
-- claim attached, nothing for the outbound guard to contradict. And the gap
-- compounds: cancel-and-rebook activity creates cancelled rows continuously
-- (94 already, created across 2026-07-15..08-04), so the drift only grows.
--
-- Fix: v_schedule now means THE SCHEDULE — visits that stand or were done
-- (status confirmed or completed). Two statuses are excluded, differently:
--   cancelled — moves to its own view below, still queryable, impossible to
--               mistake for booked work;
--   proposed  — staged workflow state (the propose/accept flow), visible in
--               NO SQL view; it has its own tool surface and counting an
--               unaccepted proposal as a visit is the same bug in miniature.
--
-- v_cancelled_visits carries the same columns plus reason (stamped on cancel)
-- and updated_at (when it happened), because "what got cancelled this week,
-- and why?" is the question that view exists to answer.
--
-- CREATE OR REPLACE is safe here for v_schedule (column list unchanged —
-- only the WHERE moves) and preserves the spine_reader grant; the 42P16
-- append-only restriction bites on column renames/inserts, not body changes.
create or replace view v_schedule as
  select a.id            as assignment_id,
         (a.starts_at at time zone tn.timezone)::date as local_day,
         to_char((a.starts_at at time zone tn.timezone), 'FMDay') as local_weekday,
         a.starts_at,
         a.ends_at,
         a.status,
         a.promise_level,
         a.promised_day,
         a.locked,
         a.earliest_date,
         a.latest_date,
         t.ref           as technician_ref,
         t.display_name  as technician_name,
         j.id            as job_id,
         j.title         as job_title,
         j.job_type,
         j.status        as job_status,
         c.id            as customer_id,
         c.name          as customer_name,
         c.city,
         c.postal_code
    from assignments a
    join tenants tn on tn.id = a.tenant_id
    join jobs j     on j.id = a.job_id
    join customers c on c.id = j.customer_id
    left join technicians t on t.id = a.technician_id
   where a.tenant_id = current_setting('spine.tenant_id')::uuid
     and a.status in ('confirmed', 'completed');

create view v_cancelled_visits as
  select a.id            as assignment_id,
         (a.starts_at at time zone tn.timezone)::date as local_day,
         to_char((a.starts_at at time zone tn.timezone), 'FMDay') as local_weekday,
         a.starts_at,
         a.ends_at,
         a.reason,
         a.updated_at,
         a.promise_level,
         a.promised_day,
         a.earliest_date,
         a.latest_date,
         t.ref           as technician_ref,
         t.display_name  as technician_name,
         j.id            as job_id,
         j.title         as job_title,
         j.job_type,
         c.id            as customer_id,
         c.name          as customer_name,
         c.city,
         c.postal_code
    from assignments a
    join tenants tn on tn.id = a.tenant_id
    join jobs j     on j.id = a.job_id
    join customers c on c.id = j.customer_id
    left join technicians t on t.id = a.technician_id
   where a.tenant_id = current_setting('spine.tenant_id')::uuid
     and a.status = 'cancelled';

grant select on v_cancelled_visits to spine_reader;
