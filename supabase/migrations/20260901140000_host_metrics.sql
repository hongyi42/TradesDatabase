-- host_metrics — keep the capacity numbers the boxes already measure.
--
-- WHY. box-report.sh has read MemAvailable off every box every 5 minutes since
-- it shipped, and every healthy reading is discarded: recordOpsEvent folds
-- observations into INCIDENTS, so `ok` with nothing open writes no row at all.
-- That is correct for an incident log and useless for capacity, which needs the
-- healthy readings precisely because they are the normal case. Nothing was
-- missing from collection; there was nowhere to put it.
--
-- WHAT IT IS FOR. One unknown decides how many agents fit on a box:
-- turns-per-seat-per-hour. Every other term in the sizing model is measured
-- (see thoughts/shared/plans/2026-08-26-seat-capacity-and-overflow-safety.md).
-- The per-sandbox CPU odometer below is how that term gets measured, and
-- peak/off-peak and cross-box burst correlation fall out of the same series.
--
-- ODOMETERS, NEVER DELTAS. oom_kills, cpu_usage_usec and the psi_* columns are
-- CUMULATIVE counters stored raw. A cumulative counter that misses a sample
-- self-heals: the next delta spans 10 minutes instead of 5 and is still
-- arithmetically correct. A stored delta loses that interval permanently. The
-- monitoring view below derives the deltas; the table never does.
--
-- WHY CUMULATIVE COUNTERS AND NOT SAMPLES. A turn lasts 16-45 s. Sampling an
-- instantaneous value every 5 minutes catches one maybe 5-15% of the time, so a
-- sampled series would systematically under-report activity. A counter cannot
-- miss what happened between two reads.
--
-- WHY NOT READ THE AGENTS' OWN SESSION FILES, which record every turn exactly:
-- a script that parses session files is a script that can read customer
-- conversations, running on every box, forever. The cgroup counters are
-- content-blind by construction -- they see microseconds, never words.
--
-- NO tenant_id, deliberately -- the same reasoning as worker_heartbeats. This
-- holds no tenant data: one row per HOST per tick, infra only. Inventing a
-- tenant column to satisfy the pattern would create a boundary that does not
-- exist and make the 2-tenant leak test lie.

create table if not exists host_metrics (
  host_id        uuid        not null references hosts(id) on delete cascade,
  -- Supplied by the reporter, not defaulted to now(): it is the moment the box
  -- READ its counters, and it is the axis every delta below is divided by.
  observed_at    timestamptz not null,

  -- ── point-in-time values ────────────────────────────────────────────────
  mem_avail_mb   int,
  mem_total_mb   int,
  disk_used_pct  int,
  -- Seat count comes from enumerating systemd units on the box, NEVER from
  -- sandbox_pool: that ledger is partial in both directions (it holds rows for
  -- sandboxes that are not running, and misses ones that are), so a seat count
  -- read from it would silently mis-scale every per-seat figure derived here.
  seats          int,
  cpu_cores      int,
  -- Kept as CONTEXT, never a threshold. Linux load counts uninterruptible-sleep
  -- tasks alongside runnable ones, so a disk-heavy backup and a real CPU
  -- shortage produce the same number. psi_cpu_some_us below separates them.
  -- load1 is deliberately absent: sampled every 5 minutes it describes a 1-minute
  -- window, so four minutes in five are never observed -- a twitchier number
  -- with holes in it, answering nothing load5 does not answer better.
  load5          numeric,

  -- ── cumulative counters (deltas derived at read time) ───────────────────
  -- /proc/vmstat oom_kill. HOST-level on purpose. The per-container counter in
  -- memory.events only counts kills against a container's OWN limit, and five
  -- of six sandboxes currently run unlimited -- so that counter is structurally
  -- incapable of incrementing for them, and an alarm on it would read as
  -- coverage while watching nothing.
  oom_kills      bigint,
  -- /sys/fs/cgroup/cpu.stat usage_usec. THE turn counter: delta / cores-per-turn
  -- is how many turns happened in the window.
  cpu_usage_usec bigint,
  -- /proc/pressure/*. Microseconds during which at least one task ("some") or
  -- every task ("full") was stalled waiting for the resource. Cumulative, so it
  -- has the same cannot-miss property as the counters above.
  --
  -- This is the metric that moves in the failure mode actually observed: under
  -- a driven concurrency ladder the box degrades by QUEUEING -- turns went
  -- 16 s -> 85 s at 16 concurrent -- with 0 OOM kills and 29% of memory still
  -- available. Every quantity-based alarm stays silent through that; every user
  -- waits 5x longer. Pressure is the only thing that changes.
  psi_mem_some_us bigint,
  psi_mem_full_us bigint,
  psi_cpu_some_us bigint,

  -- ── per-sandbox ─────────────────────────────────────────────────────────
  -- {"openshell-s3-<uuid>": {"mem_mb": 412, "cpu_usec": 73412892231,
  --                          "psi_mem_some_us": 35839, "oom_kill": 0, "max": 0}}
  -- One jsonb column rather than a child table: a new sandbox starts being
  -- recorded with NO migration, exactly as workers do in monitoring.health.
  -- Per-seat attribution -- "which seat costs what" -- lives here and nowhere
  -- else; the host columns above cannot answer it.
  sandboxes      jsonb       not null default '{}'::jsonb,

  -- One reading per host per tick. A retried POST is therefore idempotent, and
  -- the reporter needs no delivery guarantee: a dropped tick is a 10-minute
  -- delta instead of a 5-minute one, which is still correct.
  primary key (host_id, observed_at)
);

comment on table host_metrics is
  'One row per host per 5-minute tick. Infra only -- no tenant data, no PII. '
  'oom_kills, cpu_usage_usec and psi_* are CUMULATIVE counters stored raw; take '
  'deltas at read time. seats comes from systemd, never from sandbox_pool. '
  'Thresholds live in the monitoring workflow, not here.';

-- The read this table exists for is "one host, a window of time".
create index if not exists host_metrics_host_time_idx
  on host_metrics (host_id, observed_at desc);

-- Never reachable from the Data API. RLS on with no policies is deny-all for
-- everyone except service_role (which bypasses it), matching worker_heartbeats.
-- The monitor reads it only through monitoring.health, which runs as owner.
alter table host_metrics enable row level security;
revoke all on host_metrics from anon, authenticated;

-- ── expose the capacity signals to the monitor ──────────────────────────────
-- CREATE OR REPLACE VIEW can only APPEND columns -- existing ones must keep
-- their name, type and order -- so `boxes` goes last, after lifecycle_ok_age_s.
--
-- Host-level only, deliberately. Per-sandbox detail stays in the table for the
-- monthly capacity query; an alert does not need to know WHICH seat until
-- someone is already looking, and putting it here would put every sandbox name
-- into every probe response.
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
    as workers,
  (select extract(epoch from (now() - max(started_at)))::int
     from public.lifecycle_runs)
    as lifecycle_run_age_s,
  (select extract(epoch from (now() - max(started_at)))::int
     from public.lifecycle_runs where ok)
    as lifecycle_ok_age_s,

  -- {"trades-box-1": {"age_s": 42, "seats": 7, "mem_avail_mb": 12185,
  --                   "mem_avail_pct": 77, "window_s": 300, "oom_kills_delta": 0,
  --                   "cpu_busy_cores": 0.24, "cpu_cores": 4,
  --                   "psi_mem_some_pct": 0.0, "psi_cpu_some_pct": 0.61}}
  --
  -- NULL when no box has reported yet. Keyed by host NAME so the alert body can
  -- say which box without a second lookup, and so a new box appears with no
  -- migration -- the same reason `workers` is shaped this way.
  --
  -- The *_delta and *_pct fields are NULL when there is no preceding row to
  -- difference against (a box's first-ever tick, or a gap longer than the
  -- window below). NULL means "cannot say", and the caller must treat it as
  -- such: numeric comparison reads NULL as 0 and would turn "no data" into a
  -- silent pass.
  (select jsonb_object_agg(
            h.name,
            jsonb_build_object(
              'age_s',        extract(epoch from (now() - r.observed_at))::int,
              'seats',        r.seats,
              'cpu_cores',    r.cpu_cores,
              'mem_avail_mb', r.mem_avail_mb,
              'mem_avail_pct',
                case when coalesce(r.mem_total_mb, 0) > 0
                     then round(100.0 * r.mem_avail_mb / r.mem_total_mb)::int end,
              'disk_used_pct', r.disk_used_pct,
              'load5',         r.load5,
              'window_s',      r.window_s,
              'oom_kills',     r.oom_kills,
              -- greatest(...,0) because a reboot resets every counter to zero;
              -- a negative delta means "counters restarted", not "work undone".
              'oom_kills_delta',
                case when r.prev_oom is null or r.oom_kills is null then null
                     else greatest(r.oom_kills - r.prev_oom, 0) end,
              -- Mean cores busy over the window. Divide by cpu_cores for a
              -- utilisation fraction; multiply the window by it for core-seconds,
              -- which is what converts to a turn count.
              'cpu_busy_cores',
                case when r.prev_cpu is null or r.cpu_usage_usec is null
                          or coalesce(r.window_s, 0) <= 0 then null
                     else round(greatest(r.cpu_usage_usec - r.prev_cpu, 0)::numeric
                                / (r.window_s * 1000000.0), 3) end,
              -- Percentage of wall-clock time in the window during which at
              -- least one task was stalled waiting for the resource.
              'psi_mem_some_pct',
                case when r.prev_psi_mem is null or r.psi_mem_some_us is null
                          or coalesce(r.window_s, 0) <= 0 then null
                     else round(100.0 * greatest(r.psi_mem_some_us - r.prev_psi_mem, 0)::numeric
                                / (r.window_s * 1000000.0), 2) end,
              'psi_mem_full_pct',
                case when r.prev_psi_mem_full is null or r.psi_mem_full_us is null
                          or coalesce(r.window_s, 0) <= 0 then null
                     else round(100.0 * greatest(r.psi_mem_full_us - r.prev_psi_mem_full, 0)::numeric
                                / (r.window_s * 1000000.0), 2) end,
              'psi_cpu_some_pct',
                case when r.prev_psi_cpu is null or r.psi_cpu_some_us is null
                          or coalesce(r.window_s, 0) <= 0 then null
                     else round(100.0 * greatest(r.psi_cpu_some_us - r.prev_psi_cpu, 0)::numeric
                                / (r.window_s * 1000000.0), 2) end))
     from (
       select
         m.*,
         row_number() over w                                as rn,
         -- DESCENDING order, so lead() is the OLDER row -- the one to difference
         -- against. lag() here would reach forward in time and silently produce
         -- negative deltas that greatest(...,0) would then flatten to zero,
         -- making a busy box look idle.
         lead(m.oom_kills)       over w                     as prev_oom,
         lead(m.cpu_usage_usec)  over w                     as prev_cpu,
         lead(m.psi_mem_some_us) over w                     as prev_psi_mem,
         lead(m.psi_mem_full_us) over w                     as prev_psi_mem_full,
         lead(m.psi_cpu_some_us) over w                     as prev_psi_cpu,
         extract(epoch from (m.observed_at - lead(m.observed_at) over w))::int
                                                            as window_s
       from public.host_metrics m
       -- Bounded so the window scan stays small as the table grows, and wide
       -- enough that one missed tick still finds a predecessor. A box silent
       -- longer than this reports NULL deltas and a large age_s -- which is the
       -- honest answer, and the `age_s` staleness check is what catches it.
       where m.observed_at > now() - interval '2 hours'
       window w as (partition by m.host_id order by m.observed_at desc)
     ) r
     join public.hosts h on h.id = r.host_id
     where r.rn = 1)
    as boxes;

comment on view monitoring.health is
  'One row of aggregate worker-liveness and box-capacity metrics. Ages are seconds; '
  'NULL means the relevant set is empty (no pending calls, no captures yet), which '
  'the caller must treat as "nothing to say", never as zero. `workers` is one entry '
  'per registered heartbeat; a worker ABSENT from it has never reported. `boxes` is '
  'one entry per host that has reported in the last 2 hours, with cumulative counters '
  'already differenced against the preceding tick -- its *_delta and *_pct fields are '
  'NULL when there is no predecessor to difference against. Thresholds live in the '
  'monitoring workflow, not here.';

-- monitor_ro already holds SELECT on this view; CREATE OR REPLACE keeps grants.
-- It gains NO privilege on host_metrics itself -- the view reads it as owner.
