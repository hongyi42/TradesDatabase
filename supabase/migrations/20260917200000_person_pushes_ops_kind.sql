-- Ops alerts join the person-push queue, so the fleet needs no extra bot.
--
-- WHY. @DashboardMan_bot was kept alive after the one-bot merge by exactly one
-- job: sending ops alerts from Render with BOARD_BOT_TOKEN, the one bot token
-- Render holds. The owner's goal is not "a bot per purpose" but ONE bot per
-- person -- no board bot, and no ops bot standing in for it either. So the last
-- Render-side send has to go where every other person-facing message already
-- goes: queued here, delivered by the box through that person's own assistant.
--
-- WHY 'ops' IS A KIND AND NOT A NEW TABLE. `kind` was documented at creation as
-- "not authority, not routing -- it exists so an operator reading the table
-- knows why a message was owed". An ops alert is owed for a different reason
-- than a schedule change, and that is the whole difference: same addressee
-- shape (one person), same verbatim body, same serve/ack ledgers, same delivery
-- leg. A separate table would duplicate all of it to record one word.
--
-- WHAT THIS DELIBERATELY GIVES UP. Ops alerts used to be sent straight from
-- Render and therefore always arrived. They now travel box -> seat gateway ->
-- seat bot, which are among the things an ops alert reports on: an alert about
-- a dead box cannot be delivered BY that box. That class of failure is covered
-- by inverted monitoring instead -- a healthchecks.io dead-man switch that
-- fires when pings STOP, off-box and off-Render (deploy/n8n/README.md). No
-- transport a box controls can report its own death, so this is not a
-- regression that a bot would have fixed.
--
-- The addressee is still a technician row: ops alerts go to each operator's
-- OWN private chat, named by Telegram user id in OPS_ALERT_TELEGRAM_IDS and
-- resolved through findRosterByTelegramUserIdGlobal (tenant-agnostic, because
-- an ops incident belongs to no tenant). The previous OPS_ALERT_CHAT_ID was a
-- GROUP chat (negative id); a group has no roster row and cannot be addressed
-- on this path, so group delivery ends here -- several operators each get it on
-- their own assistant instead, which is what one-bot-per-person means.
alter table person_pushes
  drop constraint if exists person_pushes_kind_check;

alter table person_pushes
  add constraint person_pushes_kind_check
  check (kind in ('schedule', 'call', 'ops'));

comment on column person_pushes.kind is
  'Why the message was owed: schedule change, inbound call, or an ops incident. Not authority, not routing.';
