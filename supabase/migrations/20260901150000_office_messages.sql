-- The office_messages bucket (plan 2026-08-31 "the planner's inbox", build
-- 5.5, Phase 1): the ONE home for planner<->seat-agent traffic. Four flows
-- share it — a seat agent informs the planner (kind 'inform'), a seat agent's
-- question to the Q&A desk and the desk's answer (kinds 'ask'/'desk', Phase
-- 2), the planner's outbound ask_agent/inform_agent verbs (direction
-- 'to_agent', Phase 3), and replies to those asks (kind 'reply').
--
-- OPERATIONAL TABLE, NOT L1 (user ruling 2026-08-31, the agentContext
-- precedent): inbox traffic informs the planner's judgment and gets no L1
-- echo — it is not the firm's record, and answers on this channel never fill
-- a gap by themselves (the ledger still closes a cost gap).
--
-- DEPLOY ORDER: apply BEFORE deploying the code — deploys run no migrations
-- (docs/engineering-memory.md), and the planner reads this table on every
-- tick once the code ships.
--
-- Build 6 may point escalation at this channel (escalate = ask(manager));
-- `nudge_id` is the hook it would use, kept FK-free on purpose — the same-id
-- design spans nudges AND observations, so a single-table FK cannot hold it.
create table office_messages (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  -- Which way this row travels. 'to_planner' rows use the unread/read half of
  -- the status vocabulary; 'to_agent' rows use queued/delivered/failed.
  direction     text not null check (direction in ('to_planner','to_agent')),
  kind          text not null check (kind in ('ask','inform','reply','desk')),
  -- Display refs: a seat is its technician ref, the planner is
  -- 'spine:team-lead'. These are for READING; the join key is technician_id.
  from_ref      text not null,
  to_ref        text not null,
  -- The ADDRESSEE's roster row, for 'to_agent' rows: the FK is what makes the
  -- host pull's technicians!inner embed (and its host-scoped report guard)
  -- possible — a bare text ref cannot join (plan review F1). NULL on
  -- 'to_planner' rows: the planner has no roster row, and the SENDER is
  -- already named by from_ref.
  technician_id uuid references technicians(id),
  body          text not null check (char_length(body) <= 2000),
  -- The SENDER's tier at write time. Metadata only, never authority: nothing
  -- on this channel is an instruction (user ruling — inform never directs).
  tier          text,
  -- The gap an outbound verb was about. No FK — see the header.
  nudge_id      uuid,
  in_reply_to   uuid references office_messages(id),
  status        text not null default 'unread'
    check (status in ('unread','read','queued','delivered','failed')),
  -- The delivery ledgers Phase 3's freeze semantics read (plan review F1) —
  -- the nudges twins: serves are counted before shipping, attempts on the
  -- box's failure report, and a row past either cap is frozen, never failed.
  serve_count   int not null default 0,
  attempts      int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  read_at       timestamptz,
  delivered_at  timestamptz,
  constraint office_messages_addressee_check
    check (direction = 'to_planner' or technician_id is not null)
);

create trigger office_messages_set_updated_at
  before update on office_messages
  for each row execute function set_updated_at();

-- The planner's per-tick unread read, and every status listing.
create index idx_office_messages_tenant_status
  on office_messages (tenant_id, status, created_at);
-- The host pull's serve read (Phase 3): queued rows only, tiny by design.
create index idx_office_messages_queued
  on office_messages (status) where status = 'queued';

-- RLS-with-no-policy + explicit revoke (the observations posture, 20260824120000):
-- service_role bypasses RLS so the app is unaffected; anon/authenticated get
-- zero rows and no writes. A forged row here would put attacker-chosen words
-- in front of the planner — and auto_expose_new_tables still publishes every
-- new table to the publishable key unless this says otherwise.
alter table office_messages enable row level security;
revoke all on office_messages from anon, authenticated;
