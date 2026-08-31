-- Observations (plan 2026-08-31 "a gap is not an ask", Phase 1): the record of
-- the system NOTICING something, split from the question it used to imply.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the code. Deploys run no
-- migrations (docs/engineering-memory.md), and the sweep and planner read this
-- table unconditionally — a missing relation fails EVERY tenant's pass, taking
-- the pre-existing escalation/expiry sweeps down with it, not just minting.
--
-- Until now a detector's act of noticing WAS the act of asking: createNudge
-- minted a question addressed to a person (nudges.sql:2 — "One row = one
-- question"), and a finding past the per-tick cap was not stored at all. This
-- table is the noticing, kept on its own: one row per thing noticed per firm,
-- no addressee obligation, no delivery clock, no answer clock. A question comes
-- into existence only when the planner chooses `send` (user direction
-- 2026-08-31, docs/engineering-memory.md §6a entry 4).
--
-- ONE GAP, ONE ID, TWO STAGES — read this before touching either table. When
-- the planner sends, the nudge is created WITH THE OBSERVATION'S OWN uuid, so
-- one id names the gap across its whole life: nudge_decisions rows keyed by it
-- span pre-ask and post-ask, ask_group_id = lead id still works, and every
-- consumer that keys history by "the gap's id" needs no mapping. The cost is
-- that observations.id and nudges.id share an id space for sent gaps — a row
-- with the same uuid in both tables is the SAME gap at two stages, not a
-- collision. Do not add a cross-table FK: the observation outlives (and
-- predates) the ask, and the ask may exist without an observation (pre-split
-- relic rows).
--
-- Lifecycle: open      (a detector noticed; the planner sees it every tick)
--         -> dismissed (the planner judged it inconsequential — REVISABLE, the
--                       planner can recover it; the detector stops re-noticing
--                       either way, see the unique index)
--         -> asked     (the planner sent a question; the nudge row with this
--                       same id owns the gap from here)
create table observations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  -- Same vocabulary as nudges.kind / review_items.kind — one gap, one name.
  kind           text not null,
  -- The gap's subject (assignment id for overdue_visit_gap, job id for
  -- job_cost_gap) — the same key both once-ever stores use.
  subject_ref    text not null,
  -- ADVISORY: who the detector thinks could answer, when it knows. Never an
  -- obligation — that is the difference between this table and nudges.
  technician_id  uuid references technicians(id),
  -- Detector-written evidence (customerName, jobTitle, jobId, startsAtLocal…),
  -- exactly the shape nudges.context carries; the send copies it across.
  context        jsonb not null default '{}'::jsonb,
  status         text not null default 'open'
    check (status in ('open','dismissed','asked')),
  -- The planner's words, and manager-visible through v_observations (the
  -- nudges.resolution posture: written to stand alone).
  dismiss_reason text,
  dismissed_at   timestamptz,
  -- The planner's own "not before" note. ADVISORY — nothing enforces it but
  -- the planner's next look; there is no compose step left to gate.
  not_before     timestamptz,
  noticed_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger observations_set_updated_at
  before update on observations
  for each row execute function set_updated_at();

-- Noticed once per subject, EVER — the semantics MOVED here from the ask.
-- uq_nudges_subject_ever said "ask once, ever" and doubled as the detector's
-- dedup; splitting the objects splits the rules. This index is the detector's
-- half: a subject enters the record once, whatever later happens to the row —
-- and the DISMISSAL is what stops re-surfacing, made by the planner and
-- revisable, where the old dedup was made by code, permanently, at first
-- sight. createObservation treats 23505 as "already noticed".
alter table observations
  add constraint uq_observations_subject_ever unique (tenant_id, kind, subject_ref);

-- The planner reads open rows per tenant every tick.
create index idx_observations_tenant_status on observations (tenant_id, status);

-- RLS-with-no-policy + explicit revoke (the nudges posture): service_role
-- bypasses RLS so the app is unaffected; anon/authenticated get zero rows and
-- no writes. A forged observation would put attacker-chosen "evidence" in
-- front of the planner, whose send turns it into a message delivered AS the
-- firm — this table must never be publishable-key writable.
alter table observations enable row level security;
revoke all on observations from anon, authenticated;

-- The read surface (the v_nudges pattern, including the guarded jobId cast —
-- context is detector-written JSON and a bare ::uuid over a malformed value
-- would throw for the WHOLE query). Shared catalog: spine_read AND the
-- manager's query_spine see this, dismiss_reason included — accepted in the
-- plan, same posture as nudges.resolution.
create view v_observations as
  select o.id,
         o.kind,
         o.status,
         o.subject_ref,
         t.ref          as technician_ref,
         t.display_name as technician_name,
         case when o.context->>'jobId'
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (o.context->>'jobId')::uuid end as job_id,
         o.dismiss_reason,
         o.dismissed_at,
         o.not_before,
         o.noticed_at
    from observations o
    left join technicians t on t.id = o.technician_id
   where o.tenant_id = current_setting('spine.tenant_id')::uuid;

grant select on v_observations to spine_reader;
-- auto_expose_new_tables (supabase/config.toml) grants the publishable keys
-- SELECT on every new entity — including views — unless the migration says
-- otherwise. Every spine view is revoked; this one must not be the outlier
-- (caught by the Phase-1 ACL probe, observations.test.ts).
revoke all on v_observations from anon, authenticated;

-- ── nudge_decisions learns to point at an observation ────────────────────────
--
-- Pre-ask decisions (dismiss, recover, a hold on an observation, a send that
-- creates the ask) are decisions about a row that does not exist in `nudges`
-- yet. The log gains a second subject column rather than a second table: the
-- reads, the chunked writer, and the recall tool all stay one surface.
-- EXACTLY ONE of nudge_id / observation_id is set per row by the writer; the
-- CHECK enforces at least one, which is what matters for integrity (both-set
-- would be harmless under the same-id design but the writer never does it).
alter table nudge_decisions alter column nudge_id drop not null;
alter table nudge_decisions add column if not exists observation_id uuid
  references observations(id) on delete cascade;
alter table nudge_decisions add constraint nudge_decisions_subject_check
  check (nudge_id is not null or observation_id is not null);

-- The verbs. Third amendment of this constraint (20260821180000, then
-- 20260822140000): dismiss and recover join. Every existing row satisfies the
-- superset; drop/re-add is the established shape.
alter table nudge_decisions drop constraint if exists nudge_decisions_action_check;
alter table nudge_decisions add constraint nudge_decisions_action_check
  check (action in ('send', 'hold', 'close', 'escalate', 'extend', 'leave', 'unmentioned',
                    'dismiss', 'recover'));

-- Pre-ask history reads, newest first. Partial: the overwhelming majority of
-- rows are ask-stage (observation_id null) and must not be indexed — the
-- idx_nudges_ask_group precedent.
create index idx_nudge_decisions_observation
  on nudge_decisions (observation_id, decided_at desc)
  where observation_id is not null;

-- ── mv_whiplash learns the pre-ask stage ─────────────────────────────────────
--
-- Its window partitions by (tenant_id, nudge_id), and Postgres groups NULLs
-- into ONE partition — so without this, every pre-ask decision row of a tenant
-- (dismiss, recover, a send that created the ask) would form a single ordered
-- stream ACROSS unrelated gaps, fabricating cross-gap whiplash pairs and
-- splitting real per-gap arcs (code-review). Same definition as
-- 20260824020000_planner_metrics_v2.sql, with the partition and the exposed id
-- coalesced over both subject columns — one gap, one id, two stages.
create or replace view mv_whiplash as
  with real_decisions as (
    select d.tenant_id,
           coalesce(d.nudge_id, d.observation_id) as nudge_id,
           d.job_id, d.action, d.decided_at,
           lag(d.action)     over w as prev_action,
           lag(d.decided_at) over w as prev_at
      from nudge_decisions d
     where d.action not in ('unmentioned', 'leave')
       and d.outcome in ('applied', 'shadow')
    window w as (partition by d.tenant_id, coalesce(d.nudge_id, d.observation_id)
                 order by d.decided_at)
  )
  select r.tenant_id, r.nudge_id, r.job_id,
         r.prev_action, r.action,
         r.prev_at, r.decided_at,
         round((extract(epoch from (r.decided_at - r.prev_at)) / 3600.0)::numeric, 2)
           as hours_between
    from real_decisions r
   where r.prev_action is not null
     and r.prev_action <> r.action
     and r.job_id is not null
     and not exists (
           select 1 from raw_captures rc
            where rc.tenant_id = r.tenant_id
              and rc.job_id = r.job_id
              and rc.captured_at > r.prev_at and rc.captured_at < r.decided_at
              and rc.retracts_capture_id is null
              and coalesce(rc.sensitivity, '') <> 'manager_only'
              and not exists (select 1 from raw_captures rr
                               where rr.tenant_id = rc.tenant_id
                                 and rr.retracts_capture_id = rc.id))
     and not exists (
           select 1 from visits v
            join raw_captures vc on vc.id = v.source_capture_id
           where v.tenant_id = r.tenant_id
              and v.job_id = r.job_id
              and v.created_at > r.prev_at and v.created_at < r.decided_at
              and vc.retracts_capture_id is null
              and coalesce(vc.sensitivity, '') <> 'manager_only'
              and not exists (select 1 from raw_captures vr
                               where vr.tenant_id = vc.tenant_id
                                 and vr.retracts_capture_id = vc.id));

-- Re-assert the metric views' posture for the replaced view (the v2 migration's
-- own revoke covered the old definition; create-or-replace preserves grants,
-- but stating it keeps the file self-contained for a fresh replay).
revoke all on mv_whiplash from anon, authenticated;
