-- Step 3 (plan 2026-09-23-step-3-office-reaches-glue-seats): what a glue seat's
-- assistant and its person said to each other, uploaded live by the glue, so the
-- office READS what an assistant knows instead of asking it (operator, 2026-09-23).
--
-- OPERATIONAL, NOT L1. This is a copy of a conversation, not a capture: nothing
-- here is evidence a structured field cites, and it is DELETABLE on purpose — a
-- technician's chat with their assistant must never become permanent the way
-- raw_captures is. The lifecycle job prunes rows older than 90 days
-- (operator, 2026-09-23; SEAT_TURN_RETENTION_DAYS overrides).
--
-- What a row holds (operator: "words + tool calls"):
--   person    — what the person wrote (a voice note's transcript; "(photo)" or
--               its caption — never bytes)
--   assistant — a reply that reached the person
--   tool      — a spine tool the assistant called: its name, its arguments
--               (capped; the RESULT is never stored — it is record data the
--               office already reads) and whether it succeeded
--
-- id is minted by the glue, so a re-upload after a lost response is a no-op
-- (insert … on conflict do nothing). Tenant, person and seat come from the
-- seat's TOKEN at upload, never from the body.
--
-- Readers (operator, 2026-09-23): the planner, and the office door a MANAGER
-- faces (read_conversation). Never the door a technician faces. The seat tells
-- its person, once, that the office can read these chats.

create table seat_turns (
  id             uuid primary key,
  tenant_id      uuid not null references tenants(id) on delete cascade,
  technician_id  uuid not null references technicians(id) on delete cascade,
  seat_id        uuid not null references seats(id) on delete cascade,
  session_id     text not null check (char_length(session_id) between 1 and 200),
  at             timestamptz not null,
  role           text not null check (role in ('person', 'assistant', 'tool')),
  text           text check (char_length(text) <= 8000),
  tool           text check (char_length(tool) <= 200),
  args           jsonb,
  ok             boolean,
  created_at     timestamptz not null default now()
);

create index seat_turns_person_at_idx on seat_turns (tenant_id, technician_id, at desc);
-- The prune's range scan.
create index seat_turns_at_idx on seat_turns (at);

alter table seat_turns enable row level security;
revoke all on seat_turns from anon, authenticated;
