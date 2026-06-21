-- Three-layer context spine: basic structure.
--   L1  raw_captures   — verbatim, append-only capture (lossless ground truth)
--   L2  customers / jobs / visits — the typed fields the business acts on
--   L3  attributes JSONB column on each L2 row — the long tail
-- Every table carries tenant_id (single-tenant to start; no RLS yet).
-- Object order matters: enums → guard function → tenants → L2 tables →
-- raw_captures → back-link FKs → trigger → indexes → seed.

-- ── Enums ────────────────────────────────────────────────────────────────────
-- job.status as a state machine, not a boolean (see overview §3).
create type job_status as enum (
  'open', 'in_progress', 'completed', 'invoiced', 'paid', 'cancelled', 'declined'
);

-- One value per input channel the spine can be written from (overview §4).
create type capture_channel as enum (
  'technician_voice', 'technician_photo', 'technician_note',
  'phone_call', 'web_form', 'sms', 'email', 'chat',
  'manager_assistant', 'manual_correction',
  'sales_note', 'quote',
  'crm_import', 'accounting_event', 'iot'
);

-- ── Append-only guard (defined before the trigger that uses it) ───────────────
create or replace function raise_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'raw_captures is append-only';
end;
$$;

-- ── Tenants ──────────────────────────────────────────────────────────────────
create table tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- ── L2: customers ────────────────────────────────────────────────────────────
create table customers (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  name              text not null,
  phone             text,
  email             text,
  address_line1     text,
  address_line2     text,
  city              text,
  state             text,
  postal_code       text,
  attributes        jsonb not null default '{}'::jsonb,  -- L3
  source_capture_id uuid,                                -- back-link FK added below
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ── L2: jobs ─────────────────────────────────────────────────────────────────
create table jobs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  customer_id       uuid not null references customers(id) on delete cascade,
  title             text,
  job_type          text,
  status            job_status not null default 'open',
  price_cents       integer,
  attributes        jsonb not null default '{}'::jsonb,  -- L3
  source_capture_id uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ── L2: visits ───────────────────────────────────────────────────────────────
create table visits (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  job_id            uuid not null references jobs(id) on delete cascade,
  technician_name   text,
  scheduled_at      timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  labor_hours       numeric,
  attributes        jsonb not null default '{}'::jsonb,  -- L3
  source_capture_id uuid,
  created_at        timestamptz not null default now()
);

-- ── L1: raw_captures (append-only; provenance FKs nullable) ──────────────────
-- Each capture links back to whichever entity it informed, as known at capture
-- time. No updated_at — the row is immutable once written.
create table raw_captures (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  customer_id uuid references customers(id) on delete set null,
  job_id      uuid references jobs(id) on delete set null,
  visit_id    uuid references visits(id) on delete set null,
  channel     capture_channel not null,
  raw_text    text,
  blob_path   text,
  metadata    jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- ── Back-link FKs: L2.source_capture_id → raw_captures ───────────────────────
-- Added after raw_captures exists (circular reference). Set on the mutable L2
-- side so it survives the append-only trigger on raw_captures.
alter table customers add constraint customers_source_capture_fk
  foreign key (source_capture_id) references raw_captures(id) on delete set null;
alter table jobs add constraint jobs_source_capture_fk
  foreign key (source_capture_id) references raw_captures(id) on delete set null;
alter table visits add constraint visits_source_capture_fk
  foreign key (source_capture_id) references raw_captures(id) on delete set null;

-- ── Append-only enforcement on raw_captures ──────────────────────────────────
create trigger raw_captures_append_only
  before update or delete on raw_captures
  for each row execute function raise_append_only();

-- ── Indexes on every FK column ───────────────────────────────────────────────
create index idx_customers_tenant         on customers(tenant_id);
create index idx_customers_source_capture on customers(source_capture_id);
create index idx_jobs_tenant              on jobs(tenant_id);
create index idx_jobs_customer            on jobs(customer_id);
create index idx_jobs_source_capture      on jobs(source_capture_id);
create index idx_visits_tenant            on visits(tenant_id);
create index idx_visits_job               on visits(job_id);
create index idx_visits_source_capture    on visits(source_capture_id);
create index idx_raw_captures_tenant      on raw_captures(tenant_id);
create index idx_raw_captures_customer    on raw_captures(customer_id);
create index idx_raw_captures_job         on raw_captures(job_id);
create index idx_raw_captures_visit       on raw_captures(visit_id);

-- ── Seed a single tenant to start (overview: one tenant, widen later) ────────
insert into tenants (name) values ('Default Tenant');
