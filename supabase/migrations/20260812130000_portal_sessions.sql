-- Portal browser sessions (Phase 2).
--
-- Plan: thoughts/shared/plans/2026-08-12-portal-real-data.md (D1, D3a).
--
-- WHY A TABLE RATHER THAN A SIGNED STATELESS COOKIE. A signed cookie carrying
-- account id + expiry would need no storage, and cannot be revoked. Both of the
-- cases we actually expect are revocations: a manager's phone is lost, and an
-- account is offboarded. Sessions here last 30 days on a sliding window (owner
-- decision 2026-08-12), so an unrevokable 30-day bearer is not something to hand
-- out. A row lets sign-out, an operator kill, and expiry all be one mechanism.
--
-- WHY ONLY A FINGERPRINT. `data-security` §3: fingerprints only, never plaintext
-- — the rule the 2026-07-03 badge leak bought. The cookie value is a 256-bit
-- random token that exists ONLY in the customer's cookie jar; this table stores
-- its sha256, exactly as `technicians.badge_hash` does. A dump of this table
-- therefore grants nobody a session. There is deliberately no column that could
-- hold the token itself.
--
-- The token is random, NOT derived from the account — so it carries no
-- information about who it belongs to and cannot be forged by someone who knows
-- an email address.

create table portal_sessions (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references portal_accounts(id) on delete cascade,
  -- sha256 of the cookie token, hex. Unique so a (vanishingly unlikely)
  -- collision is a hard error rather than two accounts sharing a session.
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz not null default now(),
  -- Sliding window: bumped on use, which is what makes 30 days mean "30 days
  -- since you last used it" rather than "30 days since you signed in".
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  -- Set on sign-out or an operator kill. Kept rather than deleted so "was this
  -- session revoked, or did it merely expire?" stays answerable after the fact.
  revoked_at   timestamptz,
  -- Coarse forensics for "where was this signed in from". Deliberately NOT an
  -- IP address: that is customer personal data with a retention obligation, and
  -- it buys us nothing we would act on.
  user_agent   text
);

create index portal_sessions_account_idx on portal_sessions (account_id);
-- The expiry sweep's access path.
create index portal_sessions_expires_idx on portal_sessions (expires_at)
  where revoked_at is null;

-- Same posture as portal_accounts and the cost tables: RLS on, NO policy, and
-- the Data-API grants revoked. This table is session material for the first
-- surface outsiders use — if the anon key could read it, a leaked publishable
-- key would become "list every live session"; if it could write, it would become
-- "mint yourself one".
alter table portal_sessions enable row level security;
revoke all on portal_sessions from anon, authenticated;
