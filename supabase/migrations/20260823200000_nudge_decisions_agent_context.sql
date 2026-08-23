-- The planner's briefing for the manager's ASSISTANT — the fourth audience,
-- fourth rail (plan ④b, 2026-08-23). handoff_note is the sentence the MANAGER
-- reads; agent_context is machine context for the manager's agent (ids, what
-- was tried, what an answer unblocks), carried onto the escalated review
-- item's detail and pulled via list_pending_reviews. It is NEVER rendered to
-- a human: the agent uses it, it does not quote it.
--
-- Null is the normal case: only an APPLIED planner escalate can carry one;
-- sweep-clock escalations have no model in the loop.
alter table nudge_decisions add column if not exists agent_context text;

comment on column nudge_decisions.agent_context is
  'Planner-written briefing for the manager''s agent on an applied escalate. Machine context only — never shown to a human. Null when the sweep escalated on its own.';
