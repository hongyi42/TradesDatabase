-- A DECISION MAY BE ABOUT NOBODY'S GAP (plan 2026-09-02 "one send verb", build
-- 6.5 Phase 3; user ruling 2026-09-01: "a generalized send verb where the
-- planner can send a message to anyone … and it doesn't have to be hardcoded
-- to be related to the gap").
--
-- DEPLOY ORDER: apply BEFORE deploying the code. Deploys run no migrations
-- (docs/engineering-memory.md), and the planner writes these rows the moment
-- it ships.
--
-- WHAT A BOTH-NULL ROW MEANS, and it is not "we lost the subject": it is a
-- MESSAGE TO A PERSON that was not about any gap — the planner telling a
-- manager something, or asking somebody a question the record never raised.
-- Until now every decision named a nudge or an observation, enforced in four
-- places ending at this CHECK, and a gap-less message had no row shape at all.
-- That was the real work of build 6.5; the verb was the easy half.
--
-- WHY THE LOG AND NOT JUST office_messages. The decision log is the corpus the
-- evals read and continual learning trains on. A send that never lands here is
-- a send nobody can grade, and the one class of action this build adds would
-- be the one class invisible to the safety budget that replaced the rails.
--
-- NOT for `recall_decisions`, and that is worth stating because it is the
-- obvious assumption: that tool takes a gapId or a jobId, and these rows carry
-- neither, so it is precisely the reader that CANNOT serve them back. The
-- planner sees its own recent messages through Phase 5's outbound block, built
-- from office_messages. This row is for the graders.
--
-- Re-runnable throughout (`if exists` / `if not exists` / `or replace`), the
-- discipline every CHECK-widening migration in this family follows.
alter table nudge_decisions drop constraint if exists nudge_decisions_subject_check;

-- NO REPLACEMENT CHECK. The previous one (20260901130000:128-129) required at
-- least one subject; there is now no invariant left for the database to hold,
-- because "both null" is a legal, meaningful row. What still holds is the
-- WRITER's rule, unchanged and untouched by this migration: at most one of the
-- pair is ever set, keyed by stage. A row with BOTH set would be meaningless
-- and nothing writes one.
alter table nudge_decisions add column if not exists to_ref text;
alter table nudge_decisions add column if not exists via text;

comment on column nudge_decisions.to_ref is
  'The person a gap-less message was addressed to, as a roster ref. NULL on '
  'every decision about a gap — those are addressed by the gap itself.';
comment on column nudge_decisions.via is
  'How a message was sent. NULL until build 6.5 Phase 4 gives `send` its two '
  'legs; the column lands here so the log shape stops moving.';

-- NO INDEX on either, deliberately: both are payload, never a predicate. The
-- per-gap and per-job reads are unchanged, and a gap-less row is found by
-- neither — it is corpus, read in bulk by the evals.

-- mv_whiplash PARTITIONS BY THE SUBJECT, and a both-null row would put every
-- gap-less decision in the firm into ONE partition, making consecutive
-- messages to different people look like a single subject oscillating between
-- verbs. Whiplash is a claim about one gap being handled inconsistently; a row
-- with no gap cannot make that claim and must not be counted in it.
--
-- NOTE the outer `r.job_id is not null` already drops today's gap-less rows,
-- because the writer stamps no job on them — so this filter is belt, not
-- braces, and it is here because that outer filter is about SCOPE, not about
-- subjects, and could reasonably change without anybody thinking about this.
--
-- These are PLAIN VIEWS despite the `mv_` prefix (`create view`,
-- 20260823230000 / 20260824020000). There is no refresh; `select` sees the
-- change immediately.
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
       and coalesce(d.nudge_id, d.observation_id) is not null
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

-- WHAT THE OTHER METRIC VIEWS DO WITH A BOTH-NULL ROW, checked against their
-- definitions rather than assumed — and one of these was wrong on the first
-- writing, which is why the reason is spelled out for each:
--   mv_gap_outcomes        selects `from nudges`; never reads this table.
--   mv_escalation_fates    selects `from nudges`, with a correlated EXISTS on
--                          `d.nudge_id = n.id` — NULL satisfies neither.
--   mv_extend_effectiveness  INNER JOINs `n.id = d.nudge_id`, which NULL can
--                          never satisfy. (The first draft said "reads
--                          action = 'extend', a verb no writer produces" —
--                          false: plannerCorpus.ts and plannerSim.ts both seed
--                          `extend` history rows. Right conclusion, wrong
--                          reason, which is the kind of comment that survives
--                          until somebody trusts it.)
-- None needed changing.
