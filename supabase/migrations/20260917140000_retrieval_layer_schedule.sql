-- The retrieval layer, plan 4 (plan 2026-09-15-the-retrieval-layer-4-schedule-reviews-relay).
--
-- Three things the schedule and review reads need from the database:
--
--   1. INDEXES. `visits` has carried only (tenant_id) and (job_id) since the
--      assignments → visits rename (20260906140000), so every time-window and
--      status read scans a firm's whole visit history. The board tray reads
--      every confirmed visit since 1970 (boardRead.readLooseBucket), the
--      overdue watcher filters on ends_at, and find_slots reads a window per
--      search. visit_notes has no time index for the evidence reads;
--      money_events.corrects_event_id (the correction chain) has none either;
--      the open review queue now pages on (created_at, id).
--
--   2. v_schedule / v_cancelled_visits.local_day WAS WRONG. starts_at is stored
--      NAIVE-LOCAL (the firm's wall clock with a +00 that lies —
--      20260714120000:11), but the views converted it as if it were a real UTC
--      instant: `starts_at at time zone 'America/Los_Angeles'` shifts a 06:00
--      visit back seven hours, onto the PREVIOUS day (verified 2026-09-15 on a
--      local stack: '2026-09-15 06:00+00' → 2026-09-14). For a UTC+ firm the
--      shift runs the other way and a late-evening visit lands on the next day.
--      The wall clock IS the local day, so the conversion is to 'UTC' — which
--      just reads the stored digits back. Same columns, same types, so
--      CREATE OR REPLACE keeps the grants; nothing depends on either view.
--
--   3. review_queue_page — the manager's review queue a page at a time. It used
--      to be every open item with its whole `detail` in one result
--      (listOpenReviewItems): unbounded, and PostgREST's silent 1000-row cap
--      beyond that. Service-role only (the tenant_cost_detail posture): the
--      tenant is a parameter from the verified identity.

-- ---------------------------------------------------------------------------
-- 1. Indexes
create index if not exists idx_visits_tenant_status_starts
  on visits (tenant_id, status, starts_at);
create index if not exists idx_visits_tenant_status_ends
  on visits (tenant_id, status, ends_at);
create index if not exists idx_visit_notes_tenant_created
  on visit_notes (tenant_id, created_at);
create index if not exists idx_money_events_corrects
  on money_events (corrects_event_id) where corrects_event_id is not null;
create index if not exists idx_review_items_open_queue
  on review_items (tenant_id, created_at, id) where status = 'open';

-- ---------------------------------------------------------------------------
-- 2. The local day is the stored wall clock. Bodies verbatim from
-- 20260907100100_drop_visits_technician_id.sql except the two day columns and
-- the tenants join, which existed only to read the timezone.
create or replace view v_schedule as
  select v.id            as visit_id,
         (v.starts_at at time zone 'UTC')::date as local_day,
         to_char((v.starts_at at time zone 'UTC'), 'FMDay') as local_weekday,
         v.starts_at,
         v.ends_at,
         v.completed_at,
         v.status,
         -- No 'cancelled' arm: this view is confirmed+completed by definition
         -- (the WHERE below), and a cancelled visit lives in v_cancelled_visits.
         case
           when v.status = 'completed' then
             case when exists (select 1 from visit_notes n where n.visit_id = v.id)
                  then 'reported' else 'happened' end
           when v.starts_at is null then 'committed'
           else 'placed'
         end            as stage,
         (select array_agg(t.ref order by p.created_at, p.technician_id)
            from visit_participants p
            join technicians t on t.id = p.technician_id
           where p.visit_id = v.id
             and p.tenant_id = v.tenant_id
             and t.tenant_id = v.tenant_id) as technician_refs,
         (select array_agg(t.display_name order by p.created_at, p.technician_id)
            from visit_participants p
            join technicians t on t.id = p.technician_id
           where p.visit_id = v.id
             and p.tenant_id = v.tenant_id
             and t.tenant_id = v.tenant_id) as technician_names,
         j.id            as job_id,
         j.title         as job_title,
         j.job_type,
         j.status        as job_status,
         c.id            as customer_id,
         c.name          as customer_name,
         c.city,
         c.postal_code
    from visits v
    join jobs j     on j.id = v.job_id
    join customers c on c.id = j.customer_id
   where v.tenant_id = current_setting('spine.tenant_id')::uuid
     and v.status in ('confirmed', 'completed');

create or replace view v_cancelled_visits as
  select v.id            as visit_id,
         (v.starts_at at time zone 'UTC')::date as local_day,
         to_char((v.starts_at at time zone 'UTC'), 'FMDay') as local_weekday,
         v.starts_at,
         v.ends_at,
         v.reason,
         v.updated_at,
         (select array_agg(t.ref order by p.created_at, p.technician_id)
            from visit_participants p
            join technicians t on t.id = p.technician_id
           where p.visit_id = v.id
             and p.tenant_id = v.tenant_id
             and t.tenant_id = v.tenant_id) as technician_refs,
         (select array_agg(t.display_name order by p.created_at, p.technician_id)
            from visit_participants p
            join technicians t on t.id = p.technician_id
           where p.visit_id = v.id
             and p.tenant_id = v.tenant_id
             and t.tenant_id = v.tenant_id) as technician_names,
         j.id            as job_id,
         j.title         as job_title,
         j.job_type,
         c.id            as customer_id,
         c.name          as customer_name,
         c.city,
         c.postal_code
    from visits v
    join jobs j     on j.id = v.job_id
    join customers c on c.id = j.customer_id
   where v.tenant_id = current_setting('spine.tenant_id')::uuid
     and v.status = 'cancelled';

-- Replace keeps grants, but the posture is re-asserted so this file reads whole.
grant select on v_schedule to spine_reader;
revoke all on v_schedule from anon, authenticated;
grant select on v_cancelled_visits to spine_reader;
revoke all on v_cancelled_visits from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The review queue, one page at a time.
--
-- Keyset on (created_at, id), oldest first — the order the queue has always
-- been read in. `next_after_created` is the timestamp as jsonb renders it
-- (microseconds kept): passed back verbatim it names the exact row, where a
-- JS Date round trip would drop the microseconds and repeat a row.
--
-- A `detail` longer than p_detail_chars is WITHHELD rather than cut: a cut JSON
-- document is not JSON, and a staged preview half-shown is worse than one the
-- agent knows to open whole (list_pending_reviews' reviewItemId).
create or replace function review_queue_page(
  p_tenant uuid,
  p_kind text default null,
  p_after_created timestamptz default null,
  p_after_id uuid default null,
  p_limit int default 20,
  p_detail_chars int default 1500
) returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 20), 50));
  v_detail_chars int := greatest(0, coalesce(p_detail_chars, 1500));
  v_rows jsonb;
  v_count int;
  v_total int;
  v_by_kind jsonb;
  v_last jsonb;
begin
  select coalesce(jsonb_agg(item order by created_at, id), '[]'::jsonb), count(*)
    into v_rows, v_count
    from (
      select r.id,
             r.created_at,
             jsonb_build_object(
               'id', r.id,
               'kind', r.kind,
               'subject_ref', r.subject_ref,
               'suggestion', r.suggestion,
               'created_at', r.created_at,
               'detail', case when length(r.detail::text) > v_detail_chars then null else r.detail end,
               'detail_chars', length(r.detail::text),
               'detail_withheld', length(r.detail::text) > v_detail_chars
             ) as item
        from review_items r
       where r.tenant_id = p_tenant
         and r.status = 'open'
         and (p_kind is null or r.kind = p_kind)
         and (p_after_created is null
              or (r.created_at, r.id) > (p_after_created, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
       order by r.created_at, r.id
       limit v_limit + 1
    ) page;

  -- The +1 row only proves there is more; it is not served.
  if v_count > v_limit then
    v_rows := v_rows - v_limit;
  end if;
  v_last := case when jsonb_array_length(v_rows) > 0 then v_rows -> -1 else null end;

  select count(*) into v_total
    from review_items r
   where r.tenant_id = p_tenant and r.status = 'open'
     and (p_kind is null or r.kind = p_kind);

  select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) into v_by_kind
    from (
      select r.kind, count(*) as n
        from review_items r
       where r.tenant_id = p_tenant and r.status = 'open'
       group by r.kind
    ) k;

  return jsonb_build_object(
    'total', v_total,
    'by_kind', v_by_kind,
    'items', v_rows,
    'has_more', v_count > v_limit,
    'next_after_created', case when v_count > v_limit then v_last -> 'created_at' else null end,
    'next_after_id', case when v_count > v_limit then v_last -> 'id' else null end
  );
end;
$$;

revoke all on function review_queue_page(uuid, text, timestamptz, uuid, int, int) from public, anon, authenticated;
grant execute on function review_queue_page(uuid, text, timestamptz, uuid, int, int) to service_role;
