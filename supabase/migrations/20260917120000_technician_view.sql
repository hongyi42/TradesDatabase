-- The retrieval layer, plan 2 — THE TECHNICIAN LIMITED VIEW (plan
-- 2026-09-15-the-retrieval-layer-2-the-technician-limited-view).
--
-- Plan 1 (20260916120000_retrieval_layer_core) put the capture rules here once,
-- but its tier gate was content-only: a technician badge could open ANY customer
-- on the firm. The operator ruled 2026-09-15 (task
-- 20260915-customer-context-becomes-a-table-of-cont, TECHNICIAN VIEW + GRANT
-- ACCESS) that a technician gets a LIMITED VIEW by default, widened per item by
-- a manager's GRANT and per firm by the FIRM'S RULE — and that all of it lives in
-- the SAME predicate, never a second one. This migration adds:
--
--   technician_view_rules  the firm's rule: how wide the view is, which capture
--                          channels a technician reads, which content tags hide
--                          a capture. NULL column = the shipped default, and the
--                          defaults live ONLY in technician_view_of below — the
--                          rule is evaluated nowhere else, which is why it is a
--                          table of its own and not tenant_settings (whose
--                          defaults live in TypeScript's resolveSettings()).
--   access_grants          the grants LEDGER: one customer or one job, for one
--                          technician, time-boxed or standing, opening the record
--                          or the record AND its notes (the manager picks, operator
--                          3C). Revoked by a one-way stamp; never edited, never
--                          deleted directly.
--   capture_tags           the content-tag HOOK: the rule already consults it; the
--                          extractor task (20260915-the-extractor-tags-each-inbound-
--                          capture) writes it.
--   technician_view_of     WHO JANE IS SERVING, computed once per read into a
--                          `technician_view` value the predicate takes.
--   capture_in_scope / capture_content_open
--                          the two halves of capture_visible: is the capture on a
--                          job/customer in the view, and may its content be read.
--
-- "Serving" (operator 1A): a TRIP is a visit_participants row on a visit that is
-- not cancelled AND was not minted by a technician's own note (operator,
-- 2026-09-15, Phase 2 review). The note door creates a completed visit with its
-- author on it when the job has no matching trip (attachNote.ts:115-130), so
-- without that second half a technician could open any customer's record by
-- filing one note about them — no manager, no grant. A trip booked from a CALL
-- (record_caller) still counts: that one was the firm's decision, not hers.
-- The contradiction ("she filed on a job she is not booked on") is for the
-- planner to notice and put to a manager — a later task, not this rule.
-- Her OWN JOBS are the jobs she has a trip on, of any status and
-- any age. She SERVES the customers of her own jobs that are not terminal. In
-- view: her own jobs, every non-terminal job of a served customer, and what a
-- live grant opens. Customers in view: the customers of her own jobs, and granted.
-- And ALWAYS her own notes (operator, 2026-09-15, Phase 1 review): a note she
-- wrote is in scope wherever it sits, filed or not — authorship lifts the SCOPE
-- check only; the firm's content rules still apply to it. "A note she wrote" is a
-- TECHNICIAN-CHANNEL capture stamped with her ref: other writers stamp the same ref
-- on things she did not write (inbound mail to her paired mailbox, her send and
-- action audit rows), and those must stay behind the scope rule.
--
-- FAIL CLOSED, everywhere: a technician read with no viewer, an unknown or
-- other-firm technician, or an unknown tier sees nothing. The plan-1 readers are
-- rebuilt with the viewer as a trailing defaulted parameter, so code still on
-- the old signature during a deploy window passes no viewer and sees nothing —
-- never an error, never a wider view.

-- ---------------------------------------------------------------------------
-- 1. The firm's own rule.
create table technician_view_rules (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  -- own_trips        only the jobs she has a trip on
  -- serving          + every unfinished job of a customer she serves (default)
  -- serving_history  + every job of a customer she serves, finished ones too
  -- whole_firm       every customer and job on the firm
  job_scope text check (job_scope in ('own_trips', 'serving', 'serving_history', 'whole_firm')),
  -- May a technician be told MONEY AMOUNTS here? 'status' (the default) is words
  -- only — "invoiced, not yet paid"; 'amounts' adds the figures. Operator
  -- 2026-09-15: status-only is a DEFAULT, never a ceiling — some firms do want
  -- their technicians to know the amount (collecting payment on site).
  money text check (money in ('status', 'amounts')),
  technician_channels capture_channel[],
  hidden_tags text[],
  set_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger technician_view_rules_set_updated_at
  before update on technician_view_rules
  for each row execute function set_updated_at();

-- The tenant_settings posture (20260829120000): service_role bypasses RLS, the
-- REST roles get nothing — a forged write here would widen a firm's technicians.
alter table technician_view_rules enable row level security;
revoke all on technician_view_rules from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The grants ledger (access ruling 7: who asked, who granted, scope, expiry, why).
create table access_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  technician_id uuid not null references technicians(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  job_id uuid references jobs(id) on delete cascade,
  -- record            the job/customer as if she served it; the content gate still applies
  -- record_and_notes  every capture in it, as a manager sees it
  opens text not null check (opens in ('record', 'record_and_notes')),
  -- …and, independently of the record/notes axis, MONEY AMOUNTS on what this
  -- grant covers (operator 2026-09-15). A manager opening one job's numbers for
  -- one technician is the "she is collecting payment there" case.
  opens_money boolean not null default false,
  expires_at timestamptz, -- null = standing
  requested_by text,
  granted_by text not null,
  reason text not null check (btrim(reason) <> ''),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text,
  constraint access_grants_one_scope check (num_nonnulls(customer_id, job_id) = 1),
  constraint access_grants_revoked_pair check ((revoked_at is null) = (revoked_by is null))
);

create index idx_access_grants_tenant_technician on access_grants (tenant_id, technician_id);

-- A LEDGER: the one change a grant may undergo is its revocation stamp, once.
-- A direct DELETE is refused; a delete CASCADING from a deleted technician,
-- customer, job or tenant is allowed (pg_trigger_depth() > 1: the foreign key's
-- own trigger is running it) — otherwise every eval-world rebuild that deletes a
-- roster would die on the first grant.
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
     and new.opens = old.opens
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

create trigger access_grants_ledger
  before update or delete on access_grants
  for each row execute function access_grants_ledger();

alter table access_grants enable row level security;
revoke all on access_grants from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The content-tag hook. Never on the immutable raw_captures row.
create table capture_tags (
  tenant_id uuid not null references tenants(id) on delete cascade,
  capture_id uuid not null references raw_captures(id),
  tag text not null check (tag ~ '^[a-z][a-z0-9_]{0,39}$'),
  source text not null check (source in ('extractor', 'manager')),
  reason text,
  created_at timestamptz not null default now(),
  primary key (capture_id, tag, source)
);

alter table capture_tags enable row level security;
revoke all on capture_tags from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The view, computed once per read.
create type technician_view as (
  tenant_id uuid,
  all_scope boolean,
  job_ids uuid[],
  customer_ids uuid[],
  notes_job_ids uuid[],
  notes_customer_ids uuid[],
  channels capture_channel[],
  hidden_tags text[],
  -- Her roster ref: a capture she authored is always in her scope.
  technician_ref text,
  -- MAY SHE BE TOLD MONEY? The firm's posture, then the jobs and customers a
  -- grant opened the figures on. One question every money gate asks — never a
  -- hardcoded tier test, or the grant could not widen it later.
  money_all boolean,
  money_job_ids uuid[],
  money_customer_ids uuid[]
);

-- p_terminal_statuses is passed IN from src/db/jobs.ts TERMINAL_JOB_STATUSES
-- (plan 1's rule: the database never hand-lists a copy that could drift). Every
-- array in the result is non-null, so `= any(...)` is never NULL.
create or replace function technician_view_of(
  p_tenant uuid,
  p_technician uuid,
  p_terminal_statuses text[]
)
returns technician_view
language plpgsql
stable
security definer
set search_path = public
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

-- ---------------------------------------------------------------------------
-- 5. The predicate. A view is present iff (p_view).tenant_id is not null — NOT
-- `p_view is not null`, which for a composite is false as soon as ANY field is.
create or replace function view_has_job(p_view technician_view, p_job uuid)
returns boolean
language sql
immutable
as $$
  select coalesce((p_view).all_scope, false)
      or coalesce(p_job = any((p_view).job_ids), false);
$$;

-- MAY THIS PERSON BE TOLD MONEY HERE? The one money question, asked of the view:
-- the firm's posture, or a grant that opened this job or this customer. A
-- manager/planner read never reaches here (it has no view and takes the whole
-- summary).
create or replace function view_money_open(p_view technician_view, p_job uuid, p_customer uuid)
returns boolean
language sql
immutable
as $$
  select coalesce((p_view).money_all, false)
      or coalesce(p_job = any((p_view).money_job_ids), false)
      or coalesce(p_customer = any((p_view).money_customer_ids), false);
$$;

create or replace function view_has_customer(p_view technician_view, p_customer uuid)
returns boolean
language sql
immutable
as $$
  select coalesce((p_view).all_scope, false)
      or coalesce(p_customer = any((p_view).customer_ids), false);
$$;

-- SCOPE: did she write it — or is the capture on a job in the view, or, for a
-- capture with no job on any arm (the customer-level pile), on a customer in the
-- view?
create or replace function capture_in_scope(p_capture uuid, p_tier text, p_view technician_view)
returns boolean
language sql
stable
as $$
  select case
    when p_tier in ('manager', 'planner') then true
    when p_tier = 'technician' and (p_view).tenant_id is not null then
      coalesce((p_view).all_scope, false)
      or exists (select 1 from raw_captures c
                  where c.id = p_capture
                    and c.tenant_id = (p_view).tenant_id
                    and c.channel in ('technician_voice', 'technician_note', 'technician_photo')
                    and c.technician_ref = (p_view).technician_ref)
      or exists (select 1 from capture_membership m
                  where m.capture_id = p_capture
                    and m.tenant_id = (p_view).tenant_id
                    and m.job_id = any((p_view).job_ids))
      or (not exists (select 1 from capture_membership m
                       where m.capture_id = p_capture
                         and m.tenant_id = (p_view).tenant_id
                         and m.job_id is not null)
          and exists (select 1 from capture_membership m
                       where m.capture_id = p_capture
                         and m.tenant_id = (p_view).tenant_id
                         and m.customer_id = any((p_view).customer_ids)))
    else false
  end;
$$;

-- CONTENT: inside a record_and_notes grant, everything; otherwise the firm's
-- channels, never a manager_only stamp (NULL-vs-<> trap: most rows are NULL),
-- and no tag the firm hides.
create or replace function capture_content_open(
  p_channel capture_channel,
  p_sensitivity text,
  p_capture uuid,
  p_tier text,
  p_view technician_view
)
returns boolean
language sql
stable
as $$
  select case
    when p_tier in ('manager', 'planner') then true
    when p_tier = 'technician' and (p_view).tenant_id is not null then
      exists (select 1 from capture_membership m
               where m.capture_id = p_capture
                 and m.tenant_id = (p_view).tenant_id
                 and (m.job_id = any((p_view).notes_job_ids)
                      or m.customer_id = any((p_view).notes_customer_ids)))
      or (coalesce(p_channel = any((p_view).channels), false)
          and p_sensitivity is distinct from 'manager_only'
          and not exists (select 1 from capture_tags t
                           where t.capture_id = p_capture
                             and t.tenant_id = (p_view).tenant_id
                             and t.tag = any((p_view).hidden_tags)))
    else false
  end;
$$;

-- THE predicate: in scope AND content open.
create or replace function capture_visible(
  p_channel capture_channel,
  p_sensitivity text,
  p_tier text,
  p_capture uuid,
  p_view technician_view
)
returns boolean
language sql
stable
as $$
  select capture_in_scope(p_capture, p_tier, p_view)
     and capture_content_open(p_channel, p_sensitivity, p_capture, p_tier, p_view);
$$;

-- What a restricted COUNT counts. For a technician: on the record she may open,
-- but closed to her — a note she could ask for. Out-of-scope captures are not
-- "restricted", they are outside the view. Any other tier keeps plan 1's rule
-- (an unknown tier sees nothing, so everything is restricted to it).
create or replace function capture_restricted(
  p_channel capture_channel,
  p_sensitivity text,
  p_tier text,
  p_capture uuid,
  p_view technician_view
)
returns boolean
language sql
stable
as $$
  select case
    when p_tier = 'technician'
      then capture_in_scope(p_capture, p_tier, p_view)
       and not capture_content_open(p_channel, p_sensitivity, p_capture, p_tier, p_view)
    else not capture_visible(p_channel, p_sensitivity, p_tier, p_capture, p_view)
  end;
$$;

-- The plan-1 signature stays (a reader on another branch may still call it for
-- the planner or a manager), but it no longer answers for technicians: a
-- technician read must pass its view to the 5-argument form, and one that
-- forgets sees nothing.
create or replace function capture_visible(p_channel capture_channel, p_sensitivity text, p_tier text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_tier in ('manager', 'planner'), false);
$$;

-- ---------------------------------------------------------------------------
-- 6. The four readers, rebuilt with the viewer. Bodies are plan 1's, plus the
-- view; the new parameters trail and default, so named-argument callers resolve.
drop function customer_contents(uuid, uuid, text, int, int, text[]);
drop function captures_page(uuid, text, uuid, text, timestamptz, uuid, int, int, boolean);
drop function capture_full(uuid, uuid, text, boolean);
drop function search_captures(uuid, text, uuid, text, text, int, int);

create function customer_contents(
  p_tenant uuid,
  p_customer uuid,
  p_caller_tier text,
  p_recent_jobs int default 10,
  p_snippet_chars int default 200,
  p_terminal_statuses text[] default '{}'::text[],
  p_viewer uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_customer customers%rowtype;
  v_recent int := greatest(1, least(coalesce(p_recent_jobs, 10), 50));
  v_snip int := greatest(1, least(coalesce(p_snippet_chars, 200), 2000));
  v_tech boolean := coalesce(p_caller_tier = 'technician', false);
  v_view technician_view;
  v_jobs_all int;
  v_jobs_total int;
  v_jobs jsonb;
  v_level jsonb;
  v_retracted jsonb;
  v_in_view_ids jsonb;
begin
  select * into v_customer from customers where id = p_customer and tenant_id = p_tenant;
  if not found then
    return null;
  end if;

  -- THE VIEW. A technician read with no viewer is "no such customer" — the
  -- shape old code already handles. A customer outside the view is named and
  -- nothing more: the id is what a request for access will carry.
  if v_tech then
    if p_viewer is null then
      return null;
    end if;
    v_view := technician_view_of(p_tenant, p_viewer, p_terminal_statuses);
    if not view_has_customer(v_view, p_customer) then
      return jsonb_build_object(
        'in_view', false,
        'customer', jsonb_build_object('id', v_customer.id, 'name', v_customer.name)
      );
    end if;
  end if;

  select count(*), count(*) filter (where not v_tech or view_has_job(v_view, jobs.id))
    into v_jobs_all, v_jobs_total
    from jobs where customer_id = p_customer and tenant_id = p_tenant;

  -- The jobs block: p_recent_jobs jobs the caller may open, LIVE WORK FIRST, then
  -- the newest finished ones (plan 1's review finding). MONEY NEVER FOLDS
  -- (operator ruling 2026-09-15) — see 20260916120000.
  select coalesce(jsonb_agg(x.job_json order by x.finished, x.created_at desc, x.id desc), '[]'::jsonb)
    into v_jobs
    from (
      select j.finished, j.created_at, j.id,
             jsonb_build_object(
               'job', to_jsonb(j) - 'finished',
               'note_count', stats.note_count,
               'restricted_count', stats.restricted_count,
               'last_capture_at', stats.last_capture_at,
               'newest', newest.snip,
               'last_visit_at', (select max(v.completed_at) from visits v
                                  where v.job_id = j.id and v.tenant_id = j.tenant_id
                                    and v.status = 'completed'
                                    and (v.source_capture_id is null or capture_is_live(v.source_capture_id))),
               'retracted_count', stats.retracted_count,
               -- Whether the CALLER may be told this job's figures; the reader
               -- projects the summary accordingly (src/db/moneyEvents.ts).
               'money_amounts', (not v_tech) or view_money_open(v_view, j.id, p_customer),
               'money_events', (select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb)
                                  from money_events m
                                 where m.job_id = j.id and m.tenant_id = j.tenant_id)
             ) as job_json
        from (select jobs.*, (jobs.status::text = any(coalesce(p_terminal_statuses, '{}'::text[]))) as finished
                from jobs
               where customer_id = p_customer and tenant_id = p_tenant
                 and (not v_tech or view_has_job(v_view, jobs.id))
               order by finished, created_at desc, id desc
               limit v_recent) j
        cross join lateral (
          select count(*) filter (where capture_is_live(c.id)
                                    and capture_visible(c.channel, c.sensitivity, p_caller_tier, c.id, v_view)) as note_count,
                 count(*) filter (where capture_is_live(c.id)
                                    and capture_restricted(c.channel, c.sensitivity, p_caller_tier, c.id, v_view)) as restricted_count,
                 max(c.captured_at) filter (where capture_is_live(c.id)
                                              and capture_visible(c.channel, c.sensitivity, p_caller_tier, c.id, v_view)) as last_capture_at,
                 count(*) filter (where p_caller_tier in ('manager', 'planner')
                                    and c.retracts_capture_id is null
                                    and not capture_is_live(c.id)) as retracted_count
            from capture_scope_members(p_tenant, 'job', j.id) s
            join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
        ) stats
        left join lateral (
          select jsonb_build_object(
                   'id', c.id, 'channel', c.channel, 'captured_at', c.captured_at,
                   'technician_ref', c.technician_ref,
                   'snippet', left(c.raw_text, v_snip),
                   'truncated', coalesce(length(c.raw_text), 0) > v_snip
                 ) as snip
            from capture_scope_members(p_tenant, 'job', j.id) s
            join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
           where capture_is_live(c.id)
             and capture_visible(c.channel, c.sensitivity, p_caller_tier, c.id, v_view)
           order by c.captured_at desc, c.id desc
           limit 1
        ) newest on true
    ) x;

  -- The customer-level pile.
  with lvl as (
    select c.*
      from capture_scope_members(p_tenant, 'customer_level', p_customer) s
      join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
     where capture_is_live(c.id)
  )
  select jsonb_build_object(
           'note_count', (select count(*) from lvl
                           where capture_visible(channel, sensitivity, p_caller_tier, id, v_view)),
           'restricted_count', (select count(*) from lvl
                                 where capture_restricted(channel, sensitivity, p_caller_tier, id, v_view)),
           'newest', (select jsonb_build_object(
                         'id', id, 'channel', channel, 'captured_at', captured_at,
                         'technician_ref', technician_ref,
                         'snippet', left(raw_text, v_snip),
                         'truncated', coalesce(length(raw_text), 0) > v_snip)
                        from lvl
                       where capture_visible(channel, sensitivity, p_caller_tier, id, v_view)
                       order by captured_at desc, id desc
                       limit 1)
         )
    into v_level;

  -- Retracted evidence ids (plan 1, unchanged): the TypeScript reader folds with them.
  with attrs as (
    select v_customer.attributes as attributes
    union all
    select j.attributes from jobs j where j.customer_id = p_customer and j.tenant_id = p_tenant
  ),
  cited as (
    select jsonb_path_query(a.attributes, '$.*.sourceCaptureId') #>> '{}' as v from attrs a
    union all
    select jsonb_path_query(a.attributes, '$.correspondence[*].captureId') #>> '{}' from attrs a
  )
  select coalesce(jsonb_agg(distinct cited.v), '[]'::jsonb)
    into v_retracted
    from cited
   where exists (
           select 1 from raw_captures r
            where r.retracts_capture_id = (
              case when cited.v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                   then cited.v::uuid end));

  -- Every in-view job of this customer (not only the page's ten), so the upcoming
  -- visits the TypeScript reader adds can be kept to the view. NULL = no filter:
  -- managers, the planner, and a whole-firm view.
  if v_tech and not coalesce((v_view).all_scope, false) then
    select coalesce(jsonb_agg(j.id order by j.id), '[]'::jsonb) into v_in_view_ids
      from jobs j
     where j.customer_id = p_customer and j.tenant_id = p_tenant
       and view_has_job(v_view, j.id);
  end if;

  return jsonb_build_object(
    'in_view', true,
    'customer', to_jsonb(v_customer),
    'jobs_total', v_jobs_total,
    'older_jobs', greatest(v_jobs_total - jsonb_array_length(v_jobs), 0),
    'jobs_outside_view', case when v_tech then v_jobs_all - v_jobs_total else 0 end,
    'in_view_job_ids', v_in_view_ids,
    'jobs', v_jobs,
    'customer_level', v_level,
    'retracted_evidence_ids', v_retracted
  );
end;
$$;

-- ---------------------------------------------------------------------------
create function captures_page(
  p_tenant uuid,
  p_scope text,
  p_scope_id uuid,
  p_caller_tier text,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit int default 20,
  p_text_chars int default 600,
  p_include_retracted boolean default false,
  p_terminal_statuses text[] default null,
  p_viewer uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 20), 50));
  v_chars int := greatest(1, least(coalesce(p_text_chars, 600), 4000));
  v_view technician_view;
  v_in_view boolean := true;
  v_rows jsonb;
  v_has_more boolean;
  v_total int;
  v_restricted int;
  v_last jsonb;
begin
  if not capture_scope_found(p_tenant, p_scope, p_scope_id) then
    return jsonb_build_object('scope_found', false, 'in_view', true, 'captures', '[]'::jsonb,
                              'has_more', false, 'total_visible', 0, 'restricted_count', 0);
  end if;

  -- A scope outside a technician's view is still read: the per-capture predicate
  -- then passes only the notes she wrote herself, and in_view says the rest is
  -- closed.
  if coalesce(p_caller_tier = 'technician', false) then
    v_view := technician_view_of(p_tenant, p_viewer, p_terminal_statuses);
    v_in_view := case p_scope when 'job' then view_has_job(v_view, p_scope_id)
                              else view_has_customer(v_view, p_scope_id) end;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'channel', p.channel, 'captured_at', p.captured_at,
           'technician_ref', p.technician_ref, 'via', to_jsonb(p.via),
           'text', left(p.raw_text, v_chars),
           'text_truncated', coalesce(length(p.raw_text), 0) > v_chars,
           'text_chars', coalesce(length(p.raw_text), 0),
           'retracts_capture_id', p.retracts_capture_id,
           'retracted', (select jsonb_build_object('id', r.id, 'reason', r.raw_text,
                                                   'by', r.technician_ref, 'at', r.captured_at)
                           from raw_captures r where r.retracts_capture_id = p.id)
         ) order by p.captured_at desc, p.id desc), '[]'::jsonb)
    into v_rows
    from (
      select c.*, s.via
        from capture_scope_members(p_tenant, p_scope, p_scope_id) s
        join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
       where (p_include_retracted or capture_is_live(c.id))
         and capture_visible(c.channel, c.sensitivity, p_caller_tier, c.id, v_view)
         and (p_before_at is null
              or (p_before_id is null and c.captured_at < p_before_at)
              or (p_before_id is not null and (c.captured_at, c.id) < (p_before_at, p_before_id)))
       order by c.captured_at desc, c.id desc
       limit v_limit + 1
    ) p;

  v_has_more := jsonb_array_length(v_rows) > v_limit;
  if v_has_more then
    select coalesce(jsonb_agg(t.e order by t.n), '[]'::jsonb) into v_rows
      from jsonb_array_elements(v_rows) with ordinality as t(e, n)
     where t.n <= v_limit;
  end if;
  v_last := case when jsonb_array_length(v_rows) > 0 then v_rows -> (jsonb_array_length(v_rows) - 1) end;

  select count(*) filter (where capture_visible(c.channel, c.sensitivity, p_caller_tier, c.id, v_view)),
         count(*) filter (where capture_restricted(c.channel, c.sensitivity, p_caller_tier, c.id, v_view))
    into v_total, v_restricted
    from capture_scope_members(p_tenant, p_scope, p_scope_id) s
    join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
   where (p_include_retracted or capture_is_live(c.id));

  return jsonb_build_object(
    'scope_found', true,
    'in_view', v_in_view,
    'captures', v_rows,
    'has_more', v_has_more,
    'next_before_at', case when v_has_more then v_last -> 'captured_at' end,
    'next_before_id', case when v_has_more then v_last -> 'id' end,
    'total_visible', v_total,
    'restricted_count', v_restricted
  );
end;
$$;

-- ---------------------------------------------------------------------------
create function capture_full(
  p_tenant uuid,
  p_capture uuid,
  p_caller_tier text,
  p_include_retracted boolean default false,
  p_terminal_statuses text[] default null,
  p_viewer uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v raw_captures%rowtype;
  v_view technician_view;
begin
  select * into v from raw_captures where id = p_capture and tenant_id = p_tenant;
  if not found then
    return null;
  end if;
  if coalesce(p_caller_tier = 'technician', false) then
    v_view := technician_view_of(p_tenant, p_viewer, p_terminal_statuses);
  end if;
  -- One answer for wrong tenant, outside the view, closed content and retracted:
  -- a distinct one would confirm the id exists.
  if not capture_visible(v.channel, v.sensitivity, p_caller_tier, v.id, v_view) then
    return null;
  end if;
  if not p_include_retracted and not capture_is_live(v.id) then
    return null;
  end if;
  return jsonb_build_object(
    'id', v.id, 'channel', v.channel, 'captured_at', v.captured_at,
    'technician_ref', v.technician_ref, 'raw_text', v.raw_text,
    'retracts_capture_id', v.retracts_capture_id,
    'memberships', (select coalesce(jsonb_agg(jsonb_build_object(
                        'customer_id', m.customer_id, 'job_id', m.job_id,
                        'visit_id', m.visit_id, 'via', m.via) order by m.via), '[]'::jsonb)
                      from capture_membership m
                     where m.capture_id = v.id and m.tenant_id = p_tenant),
    'retracted', (select jsonb_build_object('id', r.id, 'reason', r.raw_text,
                                            'by', r.technician_ref, 'at', r.captured_at)
                    from raw_captures r where r.retracts_capture_id = v.id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
create function search_captures(
  p_tenant uuid,
  p_scope text,
  p_scope_id uuid,
  p_query text,
  p_caller_tier text,
  p_limit int default 10,
  p_snippet_chars int default 240,
  p_terminal_statuses text[] default null,
  p_viewer uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_q text := btrim(coalesce(p_query, ''));
  v_limit int := greatest(1, least(coalesce(p_limit, 10), 25));
  v_snip int := greatest(1, least(coalesce(p_snippet_chars, 240), 2000));
  v_view technician_view;
  v_in_view boolean := true;
  v_tsq tsquery;
  v_like text;
  v_rows jsonb;
  v_more boolean;
begin
  if v_q = '' then
    return jsonb_build_object('scope_found', true, 'in_view', true, 'query', v_q, 'matches', '[]'::jsonb,
                              'count', 0, 'more', false, 'note', 'empty query');
  end if;
  if not capture_scope_found(p_tenant, p_scope, p_scope_id) then
    return jsonb_build_object('scope_found', false, 'in_view', true, 'query', v_q, 'matches', '[]'::jsonb,
                              'count', 0, 'more', false);
  end if;
  if coalesce(p_caller_tier = 'technician', false) then
    v_view := technician_view_of(p_tenant, p_viewer, p_terminal_statuses);
    v_in_view := case p_scope when 'job' then view_has_job(v_view, p_scope_id)
                              else view_has_customer(v_view, p_scope_id) end;
  end if;

  v_tsq := websearch_to_tsquery('english', v_q);
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'channel', p.channel, 'captured_at', p.captured_at,
           'technician_ref', p.technician_ref,
           'snippet', left(ts_headline('english', p.raw_text, v_tsq,
                                       'MaxWords=40,MinWords=20,MaxFragments=1,StartSel="",StopSel=""'), v_snip),
           'rank', p.rank
         ) order by p.rank desc, p.captured_at desc, p.id desc), '[]'::jsonb)
    into v_rows
    from (
      select c.*, ts_rank(to_tsvector('english', c.raw_text), v_tsq) as rank
        from capture_scope_members(p_tenant, p_scope, p_scope_id) s
        join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
       where capture_is_live(c.id)
         and capture_visible(c.channel, c.sensitivity, p_caller_tier, c.id, v_view)
         and c.raw_text is not null
         and (to_tsvector('english', c.raw_text) @@ v_tsq
              or c.raw_text ilike v_like escape '\')
       order by rank desc, c.captured_at desc, c.id desc
       limit v_limit + 1
    ) p;

  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then
    select coalesce(jsonb_agg(t.e order by t.n), '[]'::jsonb) into v_rows
      from jsonb_array_elements(v_rows) with ordinality as t(e, n)
     where t.n <= v_limit;
  end if;

  return jsonb_build_object(
    'scope_found', true,
    'in_view', v_in_view,
    'query', v_q,
    'matches', v_rows,
    'count', jsonb_array_length(v_rows),
    'more', v_more
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Service-role only, by name (plan 1's posture: Supabase's default privileges
-- grant EXECUTE to anon and authenticated on every new function).
revoke all on function access_grants_ledger() from public, anon, authenticated;
revoke all on function technician_view_of(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function view_has_job(technician_view, uuid) from public, anon, authenticated;
revoke all on function view_money_open(technician_view, uuid, uuid) from public, anon, authenticated;
revoke all on function view_has_customer(technician_view, uuid) from public, anon, authenticated;
revoke all on function capture_in_scope(uuid, text, technician_view) from public, anon, authenticated;
revoke all on function capture_content_open(capture_channel, text, uuid, text, technician_view) from public, anon, authenticated;
revoke all on function capture_visible(capture_channel, text, text, uuid, technician_view) from public, anon, authenticated;
revoke all on function capture_restricted(capture_channel, text, text, uuid, technician_view) from public, anon, authenticated;
revoke all on function customer_contents(uuid, uuid, text, int, int, text[], uuid) from public, anon, authenticated;
revoke all on function captures_page(uuid, text, uuid, text, timestamptz, uuid, int, int, boolean, text[], uuid) from public, anon, authenticated;
revoke all on function capture_full(uuid, uuid, text, boolean, text[], uuid) from public, anon, authenticated;
revoke all on function search_captures(uuid, text, uuid, text, text, int, int, text[], uuid) from public, anon, authenticated;
grant execute on function technician_view_of(uuid, uuid, text[]) to service_role;
grant execute on function view_has_job(technician_view, uuid) to service_role;
grant execute on function view_money_open(technician_view, uuid, uuid) to service_role;
grant execute on function view_has_customer(technician_view, uuid) to service_role;
grant execute on function capture_in_scope(uuid, text, technician_view) to service_role;
grant execute on function capture_content_open(capture_channel, text, uuid, text, technician_view) to service_role;
grant execute on function capture_visible(capture_channel, text, text, uuid, technician_view) to service_role;
grant execute on function capture_restricted(capture_channel, text, text, uuid, technician_view) to service_role;
grant execute on function customer_contents(uuid, uuid, text, int, int, text[], uuid) to service_role;
grant execute on function captures_page(uuid, text, uuid, text, timestamptz, uuid, int, int, boolean, text[], uuid) to service_role;
grant execute on function capture_full(uuid, uuid, text, boolean, text[], uuid) to service_role;
grant execute on function search_captures(uuid, text, uuid, text, text, int, int, text[], uuid) to service_role;
