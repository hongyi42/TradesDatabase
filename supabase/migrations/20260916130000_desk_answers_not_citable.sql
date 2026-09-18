-- The planner can no longer quote its own desk answers as evidence (2026-09-15,
-- research 2026-09-15-the-retrieval-and-delivery-layer Finding 2).
--
-- 20260904120000_office_messages_read_surface made v_office_messages the INBOX
-- only (`direction = 'to_planner'`), so the planner could not read its own words
-- back through `spine_read` (CITABLE_TOOLS) and cite them. Its comment said the
-- desk answers were among the `to_agent` rows that filter drops. They are not:
-- the desk writes its answer as `direction 'to_planner', kind 'desk'`
-- (src/teamLead/desk.ts), so every desk answer was citable. It cannot move to
-- `to_agent` instead — office_messages' CHECK requires a technician_id on every
-- non-`to_planner` row and a desk answer carries none, and desk.ts's catch would
-- drop the model's answer silently. So the view drops the kind.
--
-- The seat's QUESTION (`kind 'ask'`) stays: those are a person's words.
-- `is distinct from` rather than `<>` so the filter never quietly drops a row
-- whose kind is null (kind is NOT NULL today; the filter should not depend on it).
--
-- Same column list as 20260904120000: create or replace view cannot reorder or
-- drop columns. Hand-applied to the pilot BEFORE merge (deploy does not migrate).
create or replace view v_office_messages as
  select m.id,
         m.direction,
         m.kind,
         m.from_ref,
         m.to_ref,
         m.body,
         m.tier,
         m.nudge_id,
         m.in_reply_to,
         m.status,
         m.via,
         m.created_at,
         m.read_at,
         m.delivered_at
    from office_messages m
   where m.tenant_id = current_setting('spine.tenant_id')::uuid
     -- THE INBOX ONLY: the planner's `to_agent` send text is its own words.
     and m.direction = 'to_planner'
     -- AND NOT THE DESK: its answers are the planner's own words written in
     -- its name, stored `to_planner`.
     and m.kind is distinct from 'desk';

grant select on v_office_messages to spine_reader;
revoke all on v_office_messages from anon, authenticated;
