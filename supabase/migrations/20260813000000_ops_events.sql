-- Ops alerting, phase 1: somewhere for box-side health events to land.
--
-- WHY THIS EXISTS. The inference medic tells the truth about whether the model
-- provider is actually serving (v4/v5, PR #128) — and it tells it to
-- `journalctl` on trades-box-1, which nobody reads. That is exactly how SIX
-- agent-outage windows on 2026-08-12 went unnoticed (failover 05:19, 05:24,
-- 20:58; both-dead 14:04, 16:48, 18:00), each a ~4-minute stretch where every
-- user message came back `LLM request failed`. An honest red light in an empty
-- room is barely better than a green one.
--
-- ONE ROW PER INCIDENT, NOT PER TICK. The medic runs every 5 minutes, so a
-- 30-minute outage is six identical observations. Storing all six would make
-- the table a log rather than an incident list, and any future notifier built
-- on it would fire six times and get muted. Instead the box reports its CURRENT
-- status every tick and the server collapses those into transitions: an
-- incident row opens when the status first goes bad and closes when it
-- recovers. `closed_at is null` means "still broken right now".
--
-- WHY THE STATE LIVES HERE AND NOT ON THE BOX. The medic deliberately keeps no
-- state files — a v2 design decision so that flaps stay visible in the journal
-- rather than being smoothed away. Dedup needs state to compare against, and
-- putting it on the box would both break that rule and have to be re-invented
-- for every future producer. The database is where state belongs, so the box
-- stays stateless and dumb: a missed report is harmless and it needs no retry
-- logic.
--
-- `service` is free text, not an enum: the next producers (doorman restarts,
-- cron failures, gateway errors) should not each need a migration. The write
-- path validates the shape instead — see recordOpsEvent.

create table ops_events (
  id         uuid primary key default gen_random_uuid(),
  -- Always taken from the AUTHENTICATED token, never from the request body: a
  -- host must not be able to file incidents against another host.
  host_id    uuid not null references hosts(id),
  service    text not null,                      -- 'inference-medic', later others
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz,                        -- null = still open
  -- Everything a human (or, later, an automated RCA) needs to diagnose this
  -- WITHOUT ssh-ing to the box: the failing unit's message, the inference route
  -- at the time, the exit code, and the tail of the journal. An event that says
  -- only "medic exit 1" is not diagnosable by anyone.
  detail     jsonb not null default '{}'::jsonb,
  -- Set when the incident closes, so "what did recovery look like" survives too.
  resolved_detail jsonb
);

-- Every read is "the latest row for this host+service" (the open-incident
-- lookup on each report), so index exactly that.
create index ops_events_host_service_opened_idx
  on ops_events (host_id, service, opened_at desc);

-- At most ONE open incident per (host, service). This is the real guarantee
-- behind "one row per incident": without it, two reports racing on a flapping
-- provider could both see "no open incident" and both insert, and the incident
-- list would double-count precisely during the noisiest moment.
create unique index ops_events_one_open_per_service_idx
  on ops_events (host_id, service)
  where closed_at is null;

comment on table ops_events is
  'Open/closed incidents reported by hosts. One row per incident, not per observation: the reporter sends current status every tick and the server collapses to transitions.';
