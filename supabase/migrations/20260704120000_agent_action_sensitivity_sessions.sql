-- Feature B (outbound Composio sessions) schema needs, one migration:
--   1. capture_channel gains 'agent_action' — L1 audit rows for state-changing
--      Composio executions ingested from the v3.1 logs API (manager tier).
--   2. raw_captures.sensitivity — nullable marker ('manager_only' in v1);
--      technician-tier spine reads filter marked rows out in dispatch.
--   3. technicians.composio_session_id — the per-person Composio session id
--      (Tool Router GA), kept after offboarding like ca_*/ti_* (audit).
-- NOT here (recorded follow-up from the 2026-07-04 pilot data-wipe): a
-- TRUNCATE-blocking trigger on raw_captures. The row-level raise_append_only()
-- trigger doesn't fire on TRUNCATE — but the test suite's cleanup and
-- scripts/seed.mjs both rely on truncating L1 in disposable/reset flows, so
-- the block needs a deliberate carve-out design, not a drive-by trigger.
alter type capture_channel add value if not exists 'agent_action';

alter table raw_captures add column if not exists sensitivity text; -- v1 value: 'manager_only'
alter table technicians  add column if not exists composio_session_id text;
