-- Monitoring read surface — a login role that can see whether the workers are
-- working, and nothing else.
--
-- WHY. Every monitor we have answers "is this process running". None can answer
-- "is it doing its job", and nothing outside the database can: from outside a
-- worker, "zero rows processed because none arrived" and "zero rows processed
-- because it is wedged" are the same observation. Only our own data separates
-- them, so the monitor has to be able to read it.
--
-- WHY NOT service_role. That key bypasses RLS and reads every table including
-- raw_captures and call_ingest.caller_phone. Handing it to n8n would put the
-- crown jewel in a workflow engine to answer eleven integers. This role instead
-- starts with nothing and is granted exactly one aggregate view.
--
-- WHY A SEPARATE SCHEMA. Grants are then scoped by construction rather than by
-- remembering to revoke: `monitoring` is not in PostgREST's exposed-schema list,
-- so nothing here reaches the Data API, and the public-schema auto-expose
-- machinery cannot reach in.
--
-- HOW THE READ ACTUALLY WORKS. monitor_ro has NO privilege on public at all —
-- it cannot SELECT raw_captures or call_ingest. The view is owned by postgres
-- and runs with the OWNER's rights (security_invoker = false, stated explicitly
-- rather than inherited from a default that could change), so the view reads the
-- base tables and the role reads only the view's output. That is the entire
-- boundary: verify it by trying to read a base table AS monitor_ro and getting
-- "permission denied". If that ever succeeds, this migration has failed open.
--
-- NO THRESHOLDS HERE, ON PURPOSE. Every column is a raw count or an age in
-- seconds; "15 minutes is too long" lives in the n8n workflow. A threshold in a
-- view can only be retuned by running DDL against the pilot database, which
-- makes retuning expensive enough that nobody does it, and a monitor nobody
-- retunes gets muted instead. It also stops the view from silently drifting out
-- of step with code constants like NUDGE_ESCALATE_HOURS.
--
-- AGGREGATE ONLY. Counts and ages across all tenants, never a row, never an id,
-- never caller_phone. Deliberately not per-tenant: infra monitoring does not need
-- to know which firm is busy, and per-tenant rows would leak activity patterns to
-- every future reader of this view.

create schema if not exists monitoring;
comment on schema monitoring is
  'Aggregate operational metrics for external monitors. No tenant data, no rows, '
  'no identifiers. Not exposed via PostgREST.';

revoke all on schema monitoring from public;

-- One row, one query, one round trip. n8n asks a single question per tick.
create or replace view monitoring.health
with (security_invoker = false) as
select
  -- ── phone-call pipeline ───────────────────────────────────────────────────
  -- Pending is the queue depth; the OLDEST pending is the wedge signal. Depth
  -- alone cannot distinguish a busy minute from a stopped worker.
  (select count(*) from public.call_ingest where status = 'pending')::bigint
    as calls_pending,
  (select extract(epoch from (now() - min(created_at)))::int
     from public.call_ingest where status = 'pending')
    as calls_pending_oldest_s,
  -- A row stuck in 'processing' is the strongest wedge evidence there is: some
  -- worker claimed it and never finished, so this cannot be explained by an
  -- empty inbox.
  (select count(*) from public.call_ingest where status = 'processing')::bigint
    as calls_processing,
  (select extract(epoch from (now() - min(updated_at)))::int
     from public.call_ingest where status = 'processing')
    as calls_processing_oldest_s,
  (select count(*) from public.call_ingest
     where status = 'error' and updated_at > now() - interval '1 hour')::bigint
    as calls_error_1h,
  -- Retry storm: rows re-attempted over and over look like progress in a log and
  -- like a stall in the data.
  (select coalesce(max(attempts), 0) from public.call_ingest
     where status in ('pending', 'processing'))::int
    as calls_max_attempts,

  -- ── audio retention (Calls-purge) ─────────────────────────────────────────
  -- Past its delete-after, not deleted, not on legal hold. Any non-zero value is
  -- a retention-promise breach, so there is no threshold to tune here.
  (select count(*) from public.call_ingest
     where audio_delete_after < now()
       and audio_deleted_at is null
       and not legal_hold)::bigint
    as calls_purge_backlog,

  -- ── lifecycle-heart ───────────────────────────────────────────────────────
  -- The rollup's freshness is the only externally visible proof that the cost
  -- lifecycle cron still runs.
  (select extract(epoch from (now() - max(computed_at)))::int
     from public.cost_rollup_monthly)
    as cost_rollup_age_s,

  -- ── nudge pipeline ────────────────────────────────────────────────────────
  -- Two different stalls. A nudge sitting 'queued' means the composer/delivery
  -- side stopped; one sitting 'asked' means the escalation sweep stopped. Both
  -- are reported as ages so the deadline policy stays in code, not in this view.
  (select extract(epoch from (now() - min(queued_at)))::int
     from public.nudges where status in ('pending', 'queued'))
    as nudges_queued_oldest_s,
  (select extract(epoch from (now() - min(asked_at)))::int
     from public.nudges where status = 'asked')
    as nudges_asked_oldest_s,

  -- ── L1 capture flow ───────────────────────────────────────────────────────
  -- Deliberately just an age: this view has no idea what "business hours" means
  -- for a given firm's timezone, and pretending otherwise would bake a wrong
  -- assumption into DDL. The caller applies a threshold wide enough to survive
  -- a quiet night.
  (select extract(epoch from (now() - max(created_at)))::int
     from public.raw_captures)
    as l1_capture_age_s,

  -- Lets the caller catch a stale/cached read, and stamps the alert body.
  now() as observed_at;

comment on view monitoring.health is
  'One row of aggregate worker-liveness metrics. Ages are seconds; NULL means the '
  'relevant set is empty (no pending calls, no captures yet), which the caller must '
  'treat as "nothing to say", never as zero. Thresholds live in the monitoring '
  'workflow, not here.';

-- ── the role ────────────────────────────────────────────────────────────────
-- NOINHERIT so it can never pick up privileges by future group membership.
-- No password is set here: passwords do not belong in a file that lives in git.
-- Set one by hand, once, in the SQL editor:
--     alter role monitor_ro with password '<generated>';
-- and store it in the password manager next to N8N_ENCRYPTION_KEY.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'monitor_ro') then
    create role monitor_ro with login noinherit;
  end if;
end
$$;

comment on role monitor_ro is
  'Read-only external monitoring. SELECT on monitoring.health and nothing else.';

grant usage on schema monitoring to monitor_ro;
grant select on monitoring.health to monitor_ro;

-- Belt and braces. None of these should have been granted; revoking is cheap and
-- makes the intent unambiguous to the next reader.
revoke all on schema public from monitor_ro;
revoke all privileges on all tables in schema public from monitor_ro;
revoke all privileges on all sequences in schema public from monitor_ro;
revoke all privileges on all functions in schema public from monitor_ro;
revoke all on schema monitoring from public;

-- Keep it from ever gaining access to something added later.
alter default privileges in schema public revoke all on tables from monitor_ro;
