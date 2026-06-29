-- Capture-level external-id idempotency for inbound connectors.
-- raw_captures gains a per-tenant external id (the source's stable message/event id)
-- so a re-delivered webhook / overlapping Gmail window dedups to a no-op instead of
-- writing a duplicate L1 row. The PARTIAL unique index is required because
-- technician/MCP captures have no external id (external_id is null for them) — unlike
-- schedule_entries.external_row_key which is NOT NULL and uses a plain unique index.
-- Insert-only path, so the append-only trigger (context_spine :117-119) is unaffected.
alter table raw_captures add column external_id text;
create unique index uq_raw_captures_external_id
  on raw_captures (tenant_id, external_id) where external_id is not null;
create index idx_raw_captures_external_id on raw_captures(external_id);
