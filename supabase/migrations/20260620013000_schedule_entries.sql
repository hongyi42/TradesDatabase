-- Phase 2: the firm schedule as a queryable spine table.
-- Managers edit a per-firm Google Sheet; sheetSync mirrors rows here (one-way,
-- idempotent on (tenant_id, external_row_key)). Identity matching consults this
-- to propose "Is this the address: <X>?" before writing a technician's note.

create table schedule_entries (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  technician_ref   text not null,
  customer_id      uuid references customers(id) on delete set null,
  job_id           uuid references jobs(id) on delete set null,
  customer_name    text,
  address_line1    text,
  city             text,
  state            text,
  postal_code      text,
  phone            text,
  scheduled_start  timestamptz,
  scheduled_end    timestamptz,
  external_row_key text not null,
  source           text not null default 'google_sheet',
  attributes       jsonb not null default '{}'::jsonb,  -- L3 long-tail
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One row per source sheet row, per tenant — makes sync an idempotent upsert.
create unique index uq_schedule_entries_rowkey on schedule_entries(tenant_id, external_row_key);
create index idx_schedule_entries_tenant     on schedule_entries(tenant_id);
create index idx_schedule_entries_technician on schedule_entries(technician_ref);
create index idx_schedule_entries_customer   on schedule_entries(customer_id);
create index idx_schedule_entries_job        on schedule_entries(job_id);

-- Reuse the shared set_updated_at() fn (defined in 20260620012321). schedule_entries
-- has updated_at; do not copy this onto tables without the column (e.g. visits).
create trigger schedule_entries_set_updated_at
  before update on schedule_entries
  for each row execute function set_updated_at();
