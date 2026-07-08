-- Feature A (manager Telegram binding): the roster row learns which Telegram
-- account its sandbox should answer, and the cold-sandbox rack becomes a table.
--
-- telegram_user_id: numeric Telegram account id (stored as text — JSON/JS number
-- precision, and it is only ever compared). Nullable; set by the bind_telegram
-- manager tool. No DB uniqueness — the tool rejects an id already bound to
-- another non-inactive row (residual concurrent race accepted, same rationale as
-- the seat-cap trigger).
alter table technicians add column telegram_user_id text;

-- The pre-built, identity-empty agent sandboxes on each host — the "rack of
-- blanks" the operator registers once at box setup. bind_telegram claims the
-- next free one (technician_id null = free/cold) when a new hire has no sandbox.
-- Seats are reusable, refs never: a claim is a point-in-time assignment; a
-- claimed row is never reassigned to a different person.
create table sandbox_pool (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  host_id       uuid not null references hosts(id),
  sandbox_ref   text not null,
  technician_id uuid unique references technicians(id), -- null = free (cold)
  created_at    timestamptz not null default now(),
  unique (host_id, sandbox_ref)
);
create index idx_sandbox_pool_tenant on sandbox_pool(tenant_id);
