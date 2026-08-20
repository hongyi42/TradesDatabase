-- The team-lead planner's decision log (plan 2026-08-19, Phase 4, amended
-- 2026-08-20). One row = one decision the planner made about one gap on one
-- tick, plus what actually happened when the code tried to apply it.
--
-- WHY THIS EXISTS. Until now the planner's decisions went to console.log and
-- aged out of Render's log stream, so every tick's experience was discarded —
-- the planner woke up every 30 minutes having never run before, and nothing
-- downstream could ask "what have we already decided about this gap". That is
-- the amnesia behind the observed send->escalate whiplash, and it is also why
-- no corpus exists for a planner eval or for any later memory work.
--
-- WHAT IT IS NOT. This is agent-process data, not business record. It stays out
-- of jobs.attributes (L3) deliberately: `get_job` renders L3 to managers as
-- fact, and a model's deliberations are the weakest evidence class there is.
-- The spine is the customer/job record; this is the planner's notebook.
--
-- APPEND-ONLY IN SPIRIT. Rows are inserted, never updated — there is no
-- updated_at and no trigger. The rule matters because the accumulated history
-- is read back INTO the model's context, and a context that gets rewritten in
-- place erodes (ACE's "context collapse"). No enforcement trigger is added
-- because the model has no write tool that could reach this table at all; the
-- rule binds the code, and the code is here.
create table nudge_decisions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  -- Cascade: a deleted nudge's deliberations have nothing left to be about.
  nudge_id       uuid not null references nudges(id) on delete cascade,
  -- Denormalised from nudges.context->>'jobId' so history can be recalled by
  -- JOB as well as by gap — a job's gaps are the unit a person actually thinks
  -- in. No FK on purpose: this is a trace, and it must not constrain or be
  -- constrained by the job lifecycle.
  job_id         uuid,
  decided_at     timestamptz not null default now(),
  -- 'shadow' rows are recorded too. That is the point: the corpus (and the
  -- planner's own history) starts accumulating BEFORE anything is applied.
  mode           text not null check (mode in ('shadow','live')),
  action         text not null check (action in ('send','hold','close','escalate')),
  not_before     timestamptz,
  basis          text check (basis in ('evidence','record')),
  citation       text,
  confidence     text not null check (confidence in ('low','medium','high')),
  reason         text not null default '',
  -- What the CODE did, not what the model asked for. 'refused' is the load-
  -- bearing value: a decision the rails rejected must be visible, or a silent
  -- no-op (a `send` on a row that was already asked) reads as success forever.
  outcome        text not null check (outcome in ('shadow','applied','refused')),
  outcome_detail text
);

-- The primary read: this gap's history, newest first.
create index idx_nudge_decisions_nudge on nudge_decisions (nudge_id, decided_at desc);
-- The job-keyed recall the planner reaches for when a job has several gaps.
create index idx_nudge_decisions_job on nudge_decisions (tenant_id, job_id, decided_at desc);

-- Same posture as nudges: RLS on with no policy + explicit revoke. service_role
-- bypasses RLS so the app is unaffected; anon/authenticated get nothing. These
-- rows quote technicians' own words in `citation` and name who was chased about
-- what — never publishable-key readable.
alter table nudge_decisions enable row level security;
revoke all on nudge_decisions from anon, authenticated;
