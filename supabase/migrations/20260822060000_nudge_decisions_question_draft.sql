-- The TECHNICIAN-facing question the planner wrote when it decided to send
-- (plan 2026-08-22, stage 1 of the collapse).
--
-- Its own column beside handoff_note, and for the same reason handoff_note is
-- not `reason`: three different audiences, three different rails. `reason` is
-- diagnostic and covers refusals; handoff_note is read by a MANAGER in their
-- queue; this is read by a TECHNICIAN, outside the office, in their own
-- assistant's voice.
--
-- Null is the normal case: compose still writes the question for every gap the
-- planner did not decide to send.
alter table nudge_decisions add column if not exists question_draft text;

comment on column nudge_decisions.question_draft is
  'Technician-facing question written by the planner for an applied send. Null when compose wrote it instead. Distinct from handoff_note (manager-facing) and reason (diagnostic).';
