-- The manager-facing sentence the planner writes when it escalates a gap
-- (plan ② Phase 3, 2026-08-22).
--
-- Deliberately NOT `reason`. That column is written for REFUSED and SHADOW
-- decisions too — "extend refused: the instant is not in the future" — which
-- would be nonsense on a manager's queue. `reason` stays diagnostic and stays
-- the corpus continual learning will read; this is product copy, and only an
-- APPLIED escalate ever has one.
--
-- Null is the normal case: the sweep escalates on the 24h clock and expires
-- undelivered nudges with no model in the loop, and those keep the code-written
-- template. Null therefore means "nobody wrote one", never "it was lost".
alter table nudge_decisions add column if not exists handoff_note text;

comment on column nudge_decisions.handoff_note is
  'Manager-facing copy written by the planner for an applied escalate. Null when the sweep escalated on its own. Distinct from `reason`, which is diagnostic and covers refusals too.';
