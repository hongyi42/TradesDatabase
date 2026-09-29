-- The file store (plan 2026-09-28-step-2d-files, Phase 1).
--
-- A photo or document a person sends a seat, or a file the manager's bot makes,
-- is KEPT: the bytes in the private Storage bucket `files`, one row here per
-- file, and one `file_links` row per thing it is attached to. NOT L1: a file's
-- bytes are deletable (operator 2026-09-28) and L1 can be neither deleted nor
-- re-pointed; and a link must reach a ledger entry (bigint id), which a capture
-- stamp cannot.
--
-- Delete = stamp `deleted_at` FIRST, then remove the object: a failed removal
-- leaves hidden orphan bytes, never a visible row whose bytes are gone. The row
-- and its links stay as the audit trail; every reader filters deleted_at is null.

create table files (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  kind            text not null check (kind in ('photo', 'document')),
  file_name       text not null check (length(file_name) between 1 and 255),
  mime_type       text not null,
  -- 20 MB: Telegram's bot download limit (Bot API getFile), and the cap on a
  -- sandbox save — one ceiling for every way in.
  size_bytes      integer not null check (size_bytes > 0 and size_bytes <= 20971520),
  storage_path    text not null unique,
  uploaded_by_ref text not null,
  -- The roster row, for the technician rule "she sees what she sent". SET NULL:
  -- a file never blocks removing a person; uploaded_by_ref keeps who it was.
  uploaded_by     uuid references technicians(id) on delete set null,
  source          text not null check (source in ('telegram', 'sandbox')),
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  deleted_by_ref  text
);

create index idx_files_tenant_created on files (tenant_id, created_at desc);

-- One row per (file, target). Exactly one target column is set. CASCADE from
-- L2 so a link never pins a customer/job/visit (the job_captures precedent);
-- the file row itself is kept. 2e adds invoice_id / estimate_id the same way.
create table file_links (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null references tenants(id),
  file_id        uuid not null references files(id) on delete cascade,
  customer_id    uuid references customers(id) on delete cascade,
  job_id         uuid references jobs(id) on delete cascade,
  visit_id       uuid references visits(id) on delete cascade,
  money_event_id bigint references money_events(id),
  linked_by_ref  text not null,
  created_at     timestamptz not null default now(),
  constraint file_links_one_target check (num_nonnulls(customer_id, job_id, visit_id, money_event_id) = 1)
);

create unique index uq_file_links_customer on file_links (file_id, customer_id) where customer_id is not null;
create unique index uq_file_links_job on file_links (file_id, job_id) where job_id is not null;
create unique index uq_file_links_visit on file_links (file_id, visit_id) where visit_id is not null;
create unique index uq_file_links_money on file_links (file_id, money_event_id) where money_event_id is not null;
create index idx_file_links_file on file_links (file_id);
create index idx_file_links_customer on file_links (customer_id) where customer_id is not null;
create index idx_file_links_job on file_links (job_id) where job_id is not null;
create index idx_file_links_visit on file_links (visit_id) where visit_id is not null;
create index idx_file_links_money on file_links (money_event_id) where money_event_id is not null;

-- Server-only, like every business table: RLS on with no policy, and no grant
-- to the Data-API roles (the seat_memory pattern).
alter table files enable row level security;
alter table file_links enable row level security;
revoke all on files from anon, authenticated;
revoke all on file_links from anon, authenticated;

-- ── Private bucket ──────────────────────────────────────────────────────────
-- Path <tenant_id>/<file_id>. NOTE (the call-audio precedent): the migration
-- role may lack INSERT on storage.buckets on some stacks — if this is a no-op,
-- create the bucket via the Storage API / Studio and verify it exists. Never public.
insert into storage.buckets (id, name, public)
values ('files', 'files', false)
on conflict (id) do nothing;
