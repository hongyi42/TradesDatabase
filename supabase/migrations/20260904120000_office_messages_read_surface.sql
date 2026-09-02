-- THE PLANNER CAN READ ITS OWN INBOX (user ruling 2026-09-02, during build 7
-- Phase 3: "Shouldn't the planner be able to read anything?").
--
-- DEPLOY ORDER: apply BEFORE deploying the code. Deploys run no migrations, and
-- the spine_read catalog names this view the moment build 7 ships.
--
-- WHY IT WAS MISSING, stated honestly: nothing. Build 5.5 built office_messages
-- as a drain-once bucket and nobody asked whether the planner should be able to
-- look back at it. There is no safety reason — the table carries no sensitivity
-- column and no manager_only concept, and its bodies are less sensitive than
-- v_captures, which exposes what people actually SAID and is already granted.
-- It was simply the one thing the planner could not look back at:
--
--     recall_decisions  its own decisions   ✓      v_nudges        its questions  ✓
--     read_memory       its own notes       ✓      v_observations  its noticings  ✓
--     office_messages   its own inbox       ✗   ← the odd one out
--
-- WHAT THIS ALSO DOES, and it is the larger half of the ruling: `spine_read` is
-- a CITABLE tool (planner.ts CITABLE_TOOLS), so exposing this view makes a seat
-- agent's words quotable in an evidence-basis close. That is deliberate and it
-- SUPERSEDES the build-5.5 rule that office-channel answers never fill the
-- record (docs/engineering-memory.md §6a entry 6.5). The user's reasoning,
-- recorded because the rule it replaces was itself deliberate:
--
--   "The planner already gets to consider whether or not a gap should exist.
--    Then they should naturally get to just close the gap with any information,
--    even the messages from the seats, because they already get to kill a gap
--    with no information. Also, when a planner needs information from the seat
--    agents, chances are the information is not obtainable from the record, or
--    else the planner would've just gotten it from the record."
--
-- WHAT DOES NOT CHANGE: a citation from a lookup stamps NO capture id (build 6
-- Phase 4 — "widening what may be CITED must never widen what may be COUNTED"),
-- so a gap closed on a seat's message is closed, but is NOT counted as
-- `closed_by_technician` in mv_gap_outcomes. The metric stays honest for free.
--
-- COLUMNS: the readable half. `technician_id` is the addressee FK and adds
-- nothing a ref does not already say; the delivery ledgers (serve_count,
-- attempts) are the host pull's bookkeeping and are already summarised for the
-- planner in the outbound block, so they stay out rather than inviting the
-- model to reason about counters it cannot act on.
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
   where m.tenant_id = current_setting('spine.tenant_id')::uuid;

grant select on v_office_messages to spine_reader;
-- auto_expose_new_tables grants the publishable keys SELECT on every new entity,
-- views included, unless the migration says otherwise. Every spine view is
-- revoked; the Phase-1 ACL probe caught v_roster_events being the outlier once
-- already, so this is stated rather than assumed.
revoke all on v_office_messages from anon, authenticated;
