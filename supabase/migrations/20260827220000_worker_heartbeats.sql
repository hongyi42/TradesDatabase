-- Worker heartbeats — let a headless worker say "I am still cycling" in the one
-- place a monitor can already read.
--
-- WHY. Board_Worker writes nothing today (its cursor is an in-memory Map), so
-- nothing outside the process can tell whether it is working. Render's API can
-- only report that a process EXISTS, and its loop swallows every failure:
--
--     try   { const sent = await pollOnce(lastSeen); }
--     catch (err) { console.error('board worker: poll failed (will retry):', err); }
--
-- so a poll that throws on every tick leaves the process up, the loop spinning,
-- notifications silently stopped, and the only evidence on a stderr stream
-- nobody reads. That is the exact failure this table exists to surface.
--
-- WHY NOT A HEALTHCHECKS PING. The rule the estate is built on: Healthchecks
-- holds ONLY dead-man's switches, one per thing that can die WITHOUT being able
-- to say so — machines and crons. A worker with a database connection can say
-- so. Routing it through here keeps the check count at six and folds the signal
-- into the probe that already runs. The cost, stated: the alert now travels
-- through Postgres and n8n rather than on an independent path.
--
-- NO tenant_id, deliberately. Every other table here is tenant-scoped because it
-- holds tenant data; this holds none — one row per PROCESS, infra only. Adding a
-- tenant column to satisfy the pattern would invent a tenant boundary that does
-- not exist and make the leak test lie.

create table if not exists worker_heartbeats (
  service    text primary key,
  -- Written every loop iteration, pass or fail. Answers "did the loop cycle".
  beat_at    timestamptz not null default now(),
  -- Written only when the iteration completed WITHOUT throwing. Answers "did the
  -- cycle actually work" — the swallowed-exception case above, which beat_at
  -- alone reports as perfectly healthy.
  last_ok_at timestamptz,
  -- Written only when the iteration did real work (sent > 0). CONTEXT, never a
  -- condition: zero work is the normal state most of the day, and alarming on it
  -- would page on every quiet afternoon.
  work_at    timestamptz,
  -- Small counters for the alert body: {"sent": 3, "cycles": 120}. No PII —
  -- this table must never grow a customer-shaped field.
  detail     jsonb not null default '{}'::jsonb,

  -- The SAME shape ops_events enforces at the app layer (SERVICE_RE in
  -- src/db/opsEvents.ts). Encoded as a CONSTRAINT here on purpose: when that
  -- rule lived only in the app, box-report.sh sent 17 reports that were all
  -- rejected with HTTP 400 and silently discarded while the script logged
  -- success. A structural rule fails loudly at the write.
  constraint worker_heartbeats_service_shape
    check (service ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(service) <= 64)
);

comment on table worker_heartbeats is
  'One row per headless worker process. Infra only — no tenant data, no PII. '
  'beat_at = the loop cycled; last_ok_at = the cycle did not throw; work_at = it '
  'did something. Read through monitoring.health, never directly by a monitor.';

-- Never reachable from the Data API. RLS on with no policies is deny-all for
-- everyone except service_role (which bypasses it) — matching the posture of
-- 20260824120000_rls_denyall_business_tables.sql, which enumerates pg_tables at
-- APPLY time and so would not have covered a table created afterwards.
alter table worker_heartbeats enable row level security;
revoke all on worker_heartbeats from anon, authenticated;

-- ── expose it to the monitor ────────────────────────────────────────────────
-- Appended as ONE jsonb column rather than three per-worker columns, so a new
-- worker starts showing up with NO migration: it writes a row, and it appears.
-- Per-worker columns would mean pilot DDL every time a process is added, which
-- is exactly the cost that stops people from adding monitoring at all.
--
-- CREATE OR REPLACE VIEW can only APPEND columns — existing ones must keep their
-- name, type and order — so `workers` goes last, after observed_at.
create or replace view monitoring.health
with (security_invoker = false) as
select
  (select count(*) from public.call_ingest where status = 'pending')::bigint
    as calls_pending,
  (select extract(epoch from (now() - min(created_at)))::int
     from public.call_ingest where status = 'pending')
    as calls_pending_oldest_s,
  (select count(*) from public.call_ingest where status = 'processing')::bigint
    as calls_processing,
  (select extract(epoch from (now() - min(updated_at)))::int
     from public.call_ingest where status = 'processing')
    as calls_processing_oldest_s,
  (select count(*) from public.call_ingest
     where status = 'error' and updated_at > now() - interval '1 hour')::bigint
    as calls_error_1h,
  (select coalesce(max(attempts), 0) from public.call_ingest
     where status in ('pending', 'processing'))::int
    as calls_max_attempts,
  (select count(*) from public.call_ingest
     where audio_delete_after < now()
       and audio_deleted_at is null
       and not legal_hold)::bigint
    as calls_purge_backlog,
  (select extract(epoch from (now() - max(computed_at)))::int
     from public.cost_rollup_monthly)
    as cost_rollup_age_s,
  (select extract(epoch from (now() - min(queued_at)))::int
     from public.nudges where status in ('pending', 'queued'))
    as nudges_queued_oldest_s,
  (select extract(epoch from (now() - min(asked_at)))::int
     from public.nudges where status = 'asked')
    as nudges_asked_oldest_s,
  (select extract(epoch from (now() - max(created_at)))::int
     from public.raw_captures)
    as l1_capture_age_s,
  now() as observed_at,
  -- {"board-worker": {"beat_age_s": 12, "ok_age_s": 12, "work_age_s": 3600,
  --                   "detail": {"sent": 0}}}
  -- NULL when the table is empty. The caller keeps the list of workers it
  -- EXPECTS: a worker missing from this object has never reported at all, which
  -- is a different failure from a stale one and must not read as healthy.
  (select jsonb_object_agg(
            service,
            jsonb_build_object(
              'beat_age_s', extract(epoch from (now() - beat_at))::int,
              'ok_age_s',   case when last_ok_at is null then null
                                 else extract(epoch from (now() - last_ok_at))::int end,
              'work_age_s', case when work_at is null then null
                                 else extract(epoch from (now() - work_at))::int end,
              'detail',     detail))
     from public.worker_heartbeats)
    as workers;

comment on view monitoring.health is
  'One row of aggregate worker-liveness metrics. Ages are seconds; NULL means the '
  'relevant set is empty (no pending calls, no captures yet), which the caller must '
  'treat as "nothing to say", never as zero. `workers` is one entry per registered '
  'heartbeat; a worker ABSENT from it has never reported. Thresholds live in the '
  'monitoring workflow, not here.';

-- monitor_ro already holds SELECT on this view; CREATE OR REPLACE keeps grants.
-- It gains NO privilege on worker_heartbeats itself — the view reads it as owner.
