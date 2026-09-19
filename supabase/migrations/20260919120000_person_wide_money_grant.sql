-- ACCESS PLAN A (thoughts/shared/plans/2026-09-19-access-plan-a-the-managers-access-tools.md),
-- phase 1: the grants ledger learns "this technician sees money figures everywhere", and the
-- planner gets a read of the grant history.
--
-- A PERSON-WIDE MONEY GRANT is an access_grants row naming NO customer and NO job. It opens
-- money only: `opens` is NULL and `opens_money` must be true, so it can never widen what a
-- technician may open — only whether she is told the figures on what she already can. Chosen
-- over a roster flag because the ledger already carries who granted it, why, and a revoke stamp
-- (operator, 2026-09-19: money is sensitive by default; a manager may open it firm-wide, for one
-- person, or on one job).
--
-- Every existing row satisfies the new scope CHECK (each names exactly one of customer/job and
-- carries `opens`), so this migration changes no firm's behaviour at apply time.

alter table access_grants alter column opens drop not null;

alter table access_grants drop constraint access_grants_one_scope;
alter table access_grants add constraint access_grants_scope check (
  (num_nonnulls(customer_id, job_id) = 1 and opens is not null)
  or (customer_id is null and job_id is null and opens is null and opens_money)
);

-- THE LEDGER, re-created for one comparison. `new.opens = old.opens` is NULL when `opens` is
-- NULL, which fails the IF and raises — so revoking a person-wide grant, the one change a grant
-- may take, would have been refused. `is not distinct from` is the NULL-safe equality the other
-- nullable columns here already use. Body otherwise verbatim from 20260917120000:123-152.
create or replace function access_grants_ledger()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'access_grants is a ledger: a grant is revoked, never deleted';
  end if;
  if old.revoked_at is null
     and new.revoked_at is not null
     and new.id = old.id
     and new.tenant_id = old.tenant_id
     and new.technician_id = old.technician_id
     and new.customer_id is not distinct from old.customer_id
     and new.job_id is not distinct from old.job_id
     and new.opens is not distinct from old.opens
     and new.opens_money = old.opens_money
     and new.expires_at is not distinct from old.expires_at
     and new.requested_by is not distinct from old.requested_by
     and new.granted_by = old.granted_by
     and new.reason = old.reason
     and new.created_at = old.created_at then
    return new;
  end if;
  raise exception 'access_grants is a ledger: the only change a grant takes is one revocation stamp';
end;
$$;

-- THE VIEW RULE, re-created for the person-wide money grant. Verbatim from
-- 20260917120000:200-337 except two things: the money block after the fail-closed return, and
-- `set search_path = public, pg_temp` — 20260917160000 set that by ALTER, and a
-- `create or replace` that omitted it would silently undo it. The signature is unchanged, so
-- the four readers that call this function and their EXECUTE grants are untouched.
create or replace function technician_view_of(
  p_tenant uuid,
  p_technician uuid,
  p_terminal_statuses text[]
)
returns technician_view
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_out technician_view;
  v_rule technician_view_rules%rowtype;
  v_scope text;
  v_own uuid[];
  v_served uuid[];
  v_jobs uuid[];
  v_customers uuid[];
  v_notes_jobs uuid[] := '{}'::uuid[];
  v_notes_customers uuid[] := '{}'::uuid[];
  v_money_jobs uuid[] := '{}'::uuid[];
  v_money_customers uuid[] := '{}'::uuid[];
  g record;
begin
  select * into v_rule from technician_view_rules where tenant_id = p_tenant;

  v_out.tenant_id := p_tenant;
  v_out.all_scope := false;
  v_out.job_ids := '{}'::uuid[];
  v_out.customer_ids := '{}'::uuid[];
  v_out.notes_job_ids := '{}'::uuid[];
  v_out.notes_customer_ids := '{}'::uuid[];
  v_out.channels := coalesce(
    v_rule.technician_channels,
    array['technician_voice', 'technician_note', 'technician_photo']::capture_channel[]
  );
  v_out.hidden_tags := coalesce(v_rule.hidden_tags, '{}'::text[]);
  v_out.money_all := coalesce(v_rule.money, 'status') = 'amounts';
  v_out.money_job_ids := '{}'::uuid[];
  v_out.money_customer_ids := '{}'::uuid[];

  -- No viewer, or not a technician on THIS firm: the empty view. Checked before
  -- anything else, so a caller that never learned the viewer sees nothing
  -- rather than an error.
  if p_technician is not null then
    select t.ref into v_out.technician_ref
      from technicians t where t.id = p_technician and t.tenant_id = p_tenant;
  end if;
  if v_out.technician_ref is null then
    return v_out;
  end if;

  -- A PERSON-WIDE MONEY GRANT (20260919120000): a live grant naming no customer
  -- and no job opens money figures on whatever she can already open. It never
  -- widens the view itself — the grants loop below drops it through its inner
  -- join on customers.
  if not v_out.money_all then
    v_out.money_all := exists (
      select 1 from access_grants ag
       where ag.tenant_id = p_tenant
         and ag.technician_id = p_technician
         and ag.customer_id is null
         and ag.job_id is null
         and ag.opens_money
         and ag.revoked_at is null
         and (ag.expires_at is null or ag.expires_at > now()));
  end if;
  if coalesce(cardinality(p_terminal_statuses), 0) = 0 then
    raise exception 'technician_view_of: p_terminal_statuses is required';
  end if;

  v_scope := coalesce(v_rule.job_scope, 'serving');

  -- Her trips → her own jobs → the customers she serves. Every hop re-checks the
  -- tenant: each of these foreign keys is id-only.
  select coalesce(array_agg(distinct j.id), '{}'::uuid[]),
         coalesce(array_agg(distinct j.customer_id), '{}'::uuid[]),
         coalesce(array_agg(distinct j.customer_id)
                    filter (where not (j.status::text = any(p_terminal_statuses))), '{}'::uuid[])
    into v_own, v_customers, v_served
    from visit_participants p
    join visits v on v.id = p.visit_id and v.tenant_id = p.tenant_id
    join jobs j on j.id = v.job_id and j.tenant_id = v.tenant_id
    join customers cu on cu.id = j.customer_id and cu.tenant_id = j.tenant_id
   where p.tenant_id = p_tenant
     and p.technician_id = p_technician
     and v.status <> 'cancelled'
     and not exists (select 1 from raw_captures src
                      where src.id = v.source_capture_id
                        and src.channel in ('technician_voice', 'technician_note', 'technician_photo'));

  if v_scope = 'whole_firm' then
    v_out.all_scope := true;
    v_jobs := v_own;
  elsif v_scope = 'own_trips' then
    v_jobs := v_own;
  elsif v_scope = 'serving_history' then
    select coalesce(array_agg(j.id), '{}'::uuid[]) into v_jobs
      from jobs j
     where j.tenant_id = p_tenant
       and (j.id = any(v_own) or j.customer_id = any(v_served));
  else
    select coalesce(array_agg(j.id), '{}'::uuid[]) into v_jobs
      from jobs j
     where j.tenant_id = p_tenant
       and (j.id = any(v_own)
            or (j.customer_id = any(v_served) and not (j.status::text = any(p_terminal_statuses))));
  end if;

  -- Live grants. The grant AND the customer (direct, or through the job) must be
  -- on this firm: a grant row naming another firm's customer opens nothing.
  for g in
    select ag.job_id, ag.opens, ag.opens_money, cu.id as customer_id
      from access_grants ag
      left join jobs j on j.id = ag.job_id and j.tenant_id = ag.tenant_id
      join customers cu on cu.id = coalesce(ag.customer_id, j.customer_id) and cu.tenant_id = ag.tenant_id
     where ag.tenant_id = p_tenant
       and ag.technician_id = p_technician
       and ag.revoked_at is null
       and (ag.expires_at is null or ag.expires_at > now())
       and (ag.job_id is null or j.id is not null)
  loop
    v_customers := v_customers || g.customer_id;
    if g.job_id is not null then
      v_jobs := v_jobs || g.job_id;
      if g.opens = 'record_and_notes' then
        v_notes_jobs := v_notes_jobs || g.job_id;
      end if;
      if g.opens_money then
        v_money_jobs := v_money_jobs || g.job_id;
      end if;
    else
      v_jobs := v_jobs || coalesce(
        (select array_agg(j.id) from jobs j where j.tenant_id = p_tenant and j.customer_id = g.customer_id),
        '{}'::uuid[]);
      if g.opens = 'record_and_notes' then
        v_notes_customers := v_notes_customers || g.customer_id;
      end if;
      if g.opens_money then
        v_money_customers := v_money_customers || g.customer_id;
      end if;
    end if;
  end loop;

  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_out.job_ids from unnest(v_jobs) x;
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_out.customer_ids from unnest(v_customers) x;
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_out.notes_job_ids from unnest(v_notes_jobs) x;
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_out.notes_customer_ids from unnest(v_notes_customers) x;
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_out.money_job_ids from unnest(v_money_jobs) x;
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_out.money_customer_ids from unnest(v_money_customers) x;
  return v_out;
end;
$$;

-- THE GRANT HISTORY, for the planner (spine_read) and a manager's ad-hoc questions
-- (query_spine). Every grant, live or ended; `live` is whether it opens anything right now.
-- Operator 2026-09-19: the planner does not grant, but it should see the history.
--
-- `reason` is shown, and spine_read is a CITABLE tool, so nothing the planner itself writes may
-- land in it: grants are written by managers (their words) and, in plan B, by the desk quoting
-- the technician's own words — never the model's prose (the self-citation rail of
-- 20260904120000_office_messages_read_surface.sql).
create view v_access_grants as
  select ag.id,
         t.ref as technician_ref,
         t.display_name as technician_name,
         cu.id as customer_id,
         cu.name as customer_name,
         ag.job_id,
         j.title as job_title,
         ag.opens,
         ag.opens_money,
         ag.expires_at,
         ag.requested_by,
         ag.granted_by,
         ag.reason,
         ag.created_at,
         ag.revoked_at,
         ag.revoked_by,
         ag.revoke_reason,
         (ag.revoked_at is null and (ag.expires_at is null or ag.expires_at > now())) as live
    from access_grants ag
    join technicians t on t.id = ag.technician_id and t.tenant_id = ag.tenant_id
    left join jobs j on j.id = ag.job_id and j.tenant_id = ag.tenant_id
    left join customers cu on cu.id = coalesce(ag.customer_id, j.customer_id)
                          and cu.tenant_id = ag.tenant_id
   where ag.tenant_id = current_setting('spine.tenant_id')::uuid;

grant select on v_access_grants to spine_reader;
-- auto_expose_new_tables grants the publishable keys SELECT on every new entity, views
-- included, unless the migration says otherwise (the v_office_messages precedent).
revoke all on v_access_grants from anon, authenticated;
