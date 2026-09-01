-- The outbound office verbs (plan 2026-08-31 "the planner's inbox", build 5.5
-- Phase 3): `ask_agent` and `inform_agent` join the planner's action
-- vocabulary — a question/note to a PERSON'S ASSISTANT, not the person.
--
-- FOURTH amendment of nudge_decisions_action_check (20260821180000, then
-- 20260822140000, then 20260901130000): drop/re-add is the established shape.
-- The list is the SUPERSET, deliberately: 'extend' retired with the
-- escalation clock (build 5) and 'unmentioned' is code's own filler verb, but
-- HISTORIC ROWS carry both and must keep validating — a CHECK is applied to
-- every row, not just new ones (plan review F9).
--
-- DEPLOY ORDER: apply BEFORE deploying the code — an applied ask_agent writes
-- its decision row through the existing recorder, and an unamended CHECK
-- would 23514 the tick's entire chunked insert.
alter table nudge_decisions drop constraint if exists nudge_decisions_action_check;
alter table nudge_decisions add constraint nudge_decisions_action_check
  check (action in ('send', 'hold', 'close', 'escalate', 'extend', 'leave', 'unmentioned',
                    'dismiss', 'recover', 'ask_agent', 'inform_agent'));
