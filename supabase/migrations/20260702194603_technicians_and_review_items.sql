-- Technician roster + lifecycle (Plan 1 of the self-serve onboarding cycle).
-- A technician's ref is the vocabulary-contract string: Composio composite
-- user_id ref = doorman badge ref = schedule sheet technician column, byte-equal.
create type technician_tier  as enum ('manager', 'technician');
create type technician_state as enum ('invited', 'pending_verification', 'active',
                                      'offboarding', 'offboarded');

create table technicians (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  ref          text not null,           -- the vocabulary-contract string (badge/user_id/sheet)
  display_name text not null,
  tier         technician_tier  not null default 'technician',
  state        technician_state not null default 'invited',
  sandbox_ref  text,                    -- operator-assigned cold-sandbox handle
  composio_connected_account_id text,   -- ca_* (written by the pairing flow)
  composio_trigger_id           text,   -- ti_*
  connected_email               text,   -- verified mailbox address
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, ref)               -- across ALL rows: refs are never reused across humans
);
create index idx_technicians_tenant on technicians(tenant_id);

create trigger technicians_set_updated_at
  before update on technicians
  for each row execute function set_updated_at();

-- Seat-based licensing: purchased capacity per tier.
alter table tenants
  add column manager_seats    integer not null default 1,
  add column technician_seats integer not null default 0;

-- Server-side seat cap (structural, never agent-trusted). Residual concurrent-insert
-- race under read committed is accepted (one manager per tenant, chat cadence).
-- 'offboarding'/'offboarded' rows do NOT occupy a seat: confirmed deactivation frees
-- the seat immediately; reactivating at cap is blocked by this same trigger.
create function enforce_seat_cap() returns trigger language plpgsql as $$
declare cap integer; used integer;
begin
  select case when new.tier = 'manager' then manager_seats else technician_seats end
    into cap from tenants where id = new.tenant_id;
  select count(*) into used from technicians
    where tenant_id = new.tenant_id and tier = new.tier
      and state not in ('offboarding', 'offboarded') and id <> new.id;
  if used >= cap then raise exception 'seat_cap_exceeded'; end if;
  return new;
end $$;
create trigger technicians_seat_cap before insert or update of state, tier on technicians
  for each row when (new.state not in ('offboarding', 'offboarded'))
  execute function enforce_seat_cap();

-- Tenant-scoped review queue (loose accept-and-flag enforcement; the manager's
-- agent surfaces and resolves these — nobody reads this table by hand).
create type review_status as enum ('open', 'resolved', 'dismissed');
create table review_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  kind        text not null,   -- 'sheet_ref_mismatch' | 'unknown_ref_capture'
                               -- | 'pairing_verification' | 'pending_deactivation'
  subject_ref text not null,
  suggestion  text,            -- fuzzy-match candidate, if any
  detail      jsonb not null default '{}'::jsonb,
  status      review_status not null default 'open',
  resolution  text,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
-- One OPEN item per (kind, subject): repeat flags return the existing row.
create unique index uq_review_items_open on review_items (tenant_id, kind, subject_ref)
  where status = 'open';
create index idx_review_items_tenant on review_items(tenant_id);
