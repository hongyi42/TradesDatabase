-- Step 4 (plan 2026-09-23-step-4-per-seat-tokens): a seat exists without the
-- sandbox pool.
--
-- seat_bots: a Telegram bot and the box whose glue polls it. Its own record,
-- not a column on a seat, so one bot per person, per firm, or one for all can
-- all be expressed later (the operator kept bot granularity open). tenant_id
-- null = any firm may claim it. The token is NOT here — bot tokens stay on the
-- box; only the id (public half) and the handle are stored.
--
-- seats: a person's GLUE assistant. OpenClaw seats are deliberately absent: they
-- stay in sandbox_pool + technicians.sandbox_ref until step 5 moves each one and
-- creates its row here (plan review: mirroring them meant keeping two records in
-- step through recycles, rebinds and rollbacks). token_hash is the sha256 of the
-- seat's bearer token — the plaintext exists once, in the mint response.
--
-- Every FK cascades so existing test cleanups (delete technicians / hosts) and
-- the eval resets keep working; bot_ref is set null so deleting a bot never
-- deletes a person's seat.

create table seat_bots (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete cascade,
  host_id       uuid not null references hosts(id) on delete cascade,
  bot_id        text unique check (bot_id ~ '^[0-9]{1,20}$'),
  bot_username  text not null,
  created_at    timestamptz not null default now(),
  retired_at    timestamptz,
  unique (host_id, bot_username)
);

create table seats (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  technician_id    uuid not null references technicians(id) on delete cascade,
  host_id          uuid not null references hosts(id) on delete cascade,
  seat_ref         text not null check (seat_ref ~ '^[a-z0-9_]+$'),
  bot_ref          uuid references seat_bots(id) on delete set null,
  token_hash       text unique,
  token_minted_at  timestamptz,
  created_at       timestamptz not null default now(),
  retired_at       timestamptz
);

-- Named, so the application can tell a lost bot race from a person who already
-- has a seat (both are 23505).
create unique index seats_live_technician_key on seats (technician_id) where retired_at is null;
create unique index seats_live_host_ref_key on seats (host_id, seat_ref) where retired_at is null;
-- One live seat per bot: today's model. Step 5 drops this if bots go per firm.
create unique index seats_live_bot_key on seats (bot_ref) where retired_at is null;
create index seats_tenant_idx on seats (tenant_id);

alter table seat_bots enable row level security;
revoke all on seat_bots from anon, authenticated;
alter table seats enable row level security;
revoke all on seats from anon, authenticated;
