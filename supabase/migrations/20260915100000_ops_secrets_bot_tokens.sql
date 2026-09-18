-- An operator-only store for seat bot tokens, out of reach of the application.
--
-- WHY A SEPARATE SCHEMA AND NOT RLS. The service does all its data access
-- through PostgREST with the service-role key (src/db/client.ts), and
-- service_role bypasses RLS by design — a policy would protect nothing here.
-- PostgREST only ROUTES to the schemas it is configured to expose, so a schema
-- left off that list has no URL at all: there is no request to authorize.
-- Verified 2026-09-15 that neither Render service carries a DATABASE_URL,
-- POSTGRES_URL or PG* connection string, and that neither has a secret file —
-- a direct Postgres connection would ignore schema exposure entirely.
--
-- WHAT THIS BUYS. Today a leaked service-role key exposes the schedule. With
-- the tokens here it keeps exposing only the schedule: a seat bot token — which
-- reads every message sent to that assistant and can send as it — sits behind a
-- different door with a different key.
--
-- AFTER APPLYING, CHECK THE DASHBOARD: Settings → API → Exposed schemas must
-- stay `public, graphql_public`. Adding this schema there undoes the whole
-- point, silently.
--
-- THE FAILURE MODE TO WATCH IN REVIEW: a SECURITY DEFINER function in `public`
-- that reads this table. RPC is exposed, so anything such a function touches is
-- effectively exposed too. There is no legitimate reason for one to exist.
--
-- NOT the delivery channel. The box still holds its own copy of every token
-- because it has to run the bots; this is the operator's way back to a token
-- without visiting BotFather, which is exactly what was missing when five
-- already-provisioned seats needed wiring (2026-09-12).
create schema if not exists ops_secrets;

-- Belt and braces. PostgREST cannot route here regardless, but this also
-- refuses a direct connection that authenticates as one of the API roles.
revoke all on schema ops_secrets from anon, authenticated, service_role;
revoke all on all tables in schema ops_secrets from anon, authenticated, service_role;
alter default privileges in schema ops_secrets
  revoke all on tables from anon, authenticated, service_role;

create table if not exists ops_secrets.bot_tokens (
  -- Keyed the way a seat is keyed everywhere else: (host, sandbox_ref). The
  -- pool's own uniqueness is (host_id, sandbox_ref) because two hosts on one
  -- tenant can each have an 's1'; host NAME is used here rather than the id so
  -- an operator reading this table by hand does not have to join to understand
  -- it. This table is never read by application code.
  host         text not null,
  sandbox_ref  text not null,
  bot_username text,
  -- The public half, duplicated from sandbox_pool.bot_id on purpose: it makes
  -- this table self-explanatory to a human, and it is not a secret.
  bot_id       text,
  token        text not null,
  note         text,
  updated_at   timestamptz not null default now(),
  primary key (host, sandbox_ref),
  -- A token is <digits>:<35+ chars>. Catches the two mistakes that matter: a
  -- bot id pasted where a token belongs, and an empty string.
  constraint bot_tokens_token_shape check (token ~ '^[0-9]{1,20}:[A-Za-z0-9_-]{30,}$'),
  constraint bot_tokens_bot_id_numeric check (bot_id is null or bot_id ~ '^[0-9]{1,20}$'),
  constraint bot_tokens_handle_shape check (bot_username is null or bot_username ~ '^@[A-Za-z0-9_]{5,32}$')
);

-- DEFENCE IN DEPTH, not the boundary. Schema exposure is what keeps this table
-- unreachable; RLS with no policies is the second lock, for the day somebody
-- adds ops_secrets to Exposed schemas without reading the comment above. Note
-- what it does NOT cover: service_role bypasses RLS, so an exposed schema would
-- still be readable by the application's own key. Superusers bypass it too,
-- which is why the SQL editor still works.
alter table ops_secrets.bot_tokens enable row level security;

comment on schema ops_secrets is
  'Operator-only. NEVER add to PostgREST exposed schemas; the application must not be able to read it.';
comment on table ops_secrets.bot_tokens is
  'Seat bot tokens, for operator lookup. Rotate via BotFather /revoke and update the row.';
comment on column ops_secrets.bot_tokens.token is
  'Full Telegram bot token. Present in backups and PITR snapshots in the clear — see the plan doc before deciding that is acceptable at a larger scale.';
