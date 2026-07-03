-- Control-plane lifecycle (Plan 2): hosts registry for badge pull, badge
-- fingerprints (sha256 hex — plaintext badges are NEVER stored), the
-- grace-period clock, and the connect-link cooldown timestamp.
create table hosts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  token_hash text not null unique,      -- sha256 hex of the host's pull token
  created_at timestamptz not null default now()
);

alter table technicians
  add column badge_hash text unique,     -- sha256 hex; plaintext NEVER stored
  add column host_id uuid references hosts(id),
  add column offboarding_started_at timestamptz,
  add column link_issued_at timestamptz;
