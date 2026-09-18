-- Verbatim system messages to a person's phone, delivered through their OWN bot.
--
-- WHY THIS EXISTS. Schedule pushes ("your 2pm moved to 4pm") and inbound-call
-- alerts are sent today with BOARD_BOT_TOKEN — the one bot token Render holds.
-- That is the last thing keeping @DashboardMan_bot alive after the one-bot
-- merge: wire every seat perfectly and those messages still stop the moment
-- that bot dies. Sending as someone's own assistant needs that assistant's
-- token, and the whole point of the Ed25519 scheme is that those never reach
-- Render. So the send moves to where the tokens already are: the box.
--
-- WHY NOT office_messages. Its chat leg already does exactly this transport,
-- and reusing it was the first instinct. But every row there is written by the
-- planner or the office tool, carries a roster ref as its sender, and is read
-- back by the planner as its own outbound record. A schedule push has no
-- sender and is none of the planner's business; filing it there would
-- contaminate what the planner reasons about. nudgeQueue's own comment says
-- the box runner "never asks what table an id came from" — which makes a
-- separate table with its own leg the intended shape, not a workaround.
--
-- THE DELIVERY CONTRACT, inherited wholesale from the nudge/chat legs:
--   * served on a host-token pull until the box acks, so a lost tick self-heals
--   * serve_count and attempts are the two freeze ledgers — a row past either
--     cap is FROZEN (never re-served, never failed), which is an operator
--     condition, not a firm decision
--   * liveness is re-checked at serve time: someone who went inactive or lost
--     their sandbox between queue and serve is SKIPPED, not failed
create table if not exists person_pushes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  -- The ADDRESSEE. The host pull joins on this to find whose box to serve the
  -- row to, so it is required — unlike office_messages, where a to_planner row
  -- has none.
  technician_id uuid not null references technicians(id),
  -- What kind of event produced it. Not authority, not routing — it exists so
  -- an operator reading the table knows why a message was owed.
  kind         text not null check (kind in ('schedule', 'call')),
  -- Verbatim. What is stored is what the person receives; no model runs on the
  -- delivery leg. Capped like office_messages' body, and for the same reason:
  -- by the time a caller reaches here the words already exist.
  body         text not null check (length(body) between 1 and 2000),
  status       text not null default 'queued' check (status in ('queued', 'delivered', 'failed')),
  serve_count  integer not null default 0 check (serve_count >= 0),
  attempts     integer not null default 0 check (attempts >= 0),
  -- The box's last word on a failure, for the operator reading the row.
  detail       text,
  created_at   timestamptz not null default now(),
  delivered_at timestamptz
);

-- The pull's own shape: queued rows, oldest first. Frozen rows deliberately
-- KEEP status 'queued' and sort first, so the read is paged by its caller for
-- the same reason the office queue is — an unpaged read under PostgREST's
-- silent row cap would eventually show a host only its frozen backlog.
create index if not exists person_pushes_queued_idx
  on person_pushes (status, created_at, id)
  where status = 'queued';

-- The addressee join, which every serve does.
create index if not exists person_pushes_technician_idx
  on person_pushes (technician_id);

comment on table person_pushes is
  'Verbatim system messages to a person''s Telegram, delivered by the box through their own seat bot. Served on the nudge pull until acked.';
