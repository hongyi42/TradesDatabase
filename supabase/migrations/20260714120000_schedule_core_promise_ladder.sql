-- Schedule core (Plan 1 of the Telegram-schedule series): the commitment ladder
-- and the versioned event log on the DB-owned schedule.
--
-- promise_level records what the CUSTOMER was told (none | a day | a day+time);
-- it is orthogonal to assignment_status (the booking lifecycle) so the
-- no_confirmed_overlap guard is untouched. promised_day is stored explicitly —
-- "did the promised day move?" must survive time edits and needs no timezone
-- math (date-string compare). locked marks a manual manager placement the
-- auto-scheduler (Plan 3) must route around.
--
-- NOTE (recorded convention): assignment timestamps are stored NAIVE-LOCAL —
-- the firm's wall-clock time written as if UTC, the same convention the
-- schedule_entries sheet mirror established. Every UTC-day reader stays
-- correct; availability checks interpret these timestamps with timezone 'UTC'.
-- Revisit when a tenant's team spans timezones.

create type promise_level as enum ('none', 'day', 'time');

alter table assignments
  add column promise_level promise_level not null default 'none',
  add column promised_day date,
  add column locked boolean not null default false,
  add constraint promised_day_when_promised
    check (promise_level = 'none' or promised_day is not null);

-- Append-only schedule change log. The tenant's schedule VERSION is its latest
-- event id (monotonic, concurrent-writer safe — no counter column to race on).
-- Doubles as the Mini App's notification feed (Plan 2) and the audit trail:
-- history = the rows themselves, house style.
create table schedule_events (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references tenants(id),
  assignment_id uuid references assignments(id) on delete set null,
  kind          text not null, -- booked|moved|move_failed|cancelled|completed|backfilled (Plan 2+ adds more)
  actor_ref     text,          -- roster ref of the person who drove it, or 'system'
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index idx_schedule_events_tenant on schedule_events(tenant_id, id desc);

-- Append-only enforced by the DATABASE, not convention (raw_captures
-- precedent — reuses its raise_append_only() guard): the log IS the version
-- history and the audit trail; a rewritten row could make a tenant's version
-- go backwards and silently falsify "what changed since you looked".
create trigger schedule_events_append_only
  before update or delete on schedule_events
  for each row execute function raise_append_only();
