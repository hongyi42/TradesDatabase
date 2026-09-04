-- ONE VERB, TWO LEGS (plan 2026-09-02 "one send verb", build 6.5 Phase 4;
-- user ruling 2026-09-02, choosing both delivery routes over assistant-only).
--
-- DEPLOY ORDER: apply BEFORE deploying the code. Deploys run no migrations
-- (docs/engineering-memory.md), and the serve loop reads this column on the
-- first pull after the code ships.
--
-- WHAT `via` DECIDES: which PULL serves the row, not which table holds it.
--   'assistant' — the office pull (/control/office). The box runs
--                 `openclaw agent --session-key main`, NO --deliver: the turn
--                 lands silently in the agent's session and nothing pings the
--                 human. This is every row that existed before today.
--   'chat'      — the NUDGE pull (/control/nudges). The box runs
--                 `openclaw message send --channel telegram`, so the words
--                 arrive on the person's phone verbatim.
--
-- THE CHAT LEG NEEDS NO BOX CHANGE, which is why it is affordable here.
-- Probed while planning: nudge-runner.sh reads only id/sandboxRef/replyTo/
-- directMessageB64 and never names a table; the report endpoint only
-- uuid-checks the id; and the office host-pull embed already carries
-- telegram_user_id. So a gap-less chat message rides the EXISTING runner, and
-- the spine routes the report back to whichever table owns the id.
--
-- DEFAULT 'assistant' because every existing row is one — this is a widening,
-- and no backfill is needed or wanted.
alter table office_messages add column if not exists via text not null default 'assistant';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'office_messages'::regclass
       and conname = 'office_messages_via_check'
  ) then
    alter table office_messages add constraint office_messages_via_check
      check (via in ('assistant', 'chat'));
  end if;
end $$;

-- ONE MESSAGE, SEVERAL PEOPLE — reserved, unused, and deliberately so.
--
-- Build 8's ruling is that a visit assigned two technicians counts as ONE
-- visit ("a crew has no lead", docs/engineering-memory.md §6a entry 8). When
-- that lands, one message will go to several people, and there will need to be
-- a way to say afterwards that those rows WERE one message. `nudges` already
-- has `ask_group_id` for the transpose — several gaps, one person — and there
-- is no analogue for the other direction.
--
-- Adding the column now costs nothing; adding it later is a backfill over live
-- rows that can never recover which historic sends belonged together. Nullable,
-- no FK, no index, and NOTHING reads or writes it in build 6.5 — a reader that
-- finds it empty is seeing the truth.
alter table office_messages add column if not exists message_group_id uuid;

comment on column office_messages.via is
  'Which pull serves this row: assistant (the office pull, a silent injected '
  'agent turn) or chat (the nudge pull, verbatim to the person''s phone).';
comment on column office_messages.message_group_id is
  'Reserved for build 8: the id shared by rows that were ONE message to '
  'several people. Nothing writes it in 6.5.';

-- The chat leg's serve read is (status='queued', via='chat', host), and the
-- existing partial index on queued rows already carries it — the table is tiny
-- by design (a message is served until acked, then leaves the queue), so a
-- second index would cost writes to save nothing measurable.
