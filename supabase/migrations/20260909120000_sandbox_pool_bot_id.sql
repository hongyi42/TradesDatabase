-- One-bot-per-person merge (2026-09-09): the Mini App is moving from the single
-- global board bot onto each person's OWN assistant bot, so the console must
-- accept a launch slip signed for any of our bots.
--
-- Telegram offers two ways to check such a slip. The HMAC needs the bot's
-- TOKEN, which would mean copying every assistant's token to Render — exactly
-- the secret concentration the box design avoids (a sandbox holds a revocable
-- badge, never a token). The Ed25519 scheme (Bot API 7.10) needs only
-- Telegram's public key and the bot's NUMERIC ID, which is not a secret: it is
-- the part of the token before the colon, and it appears in the bot's public
-- API identity.
--
-- So the id is what we store. bot_username already lives on this row for the
-- same reason (captured at provisioning, known nowhere later); bot_id is its
-- machine-readable twin and is captured the same way, from the provision
-- phase's getMe, on the box where the token lives.
--
-- Nullable: rows registered before this column, or seats whose bot has not
-- been re-inspected, simply do not contribute to the allowlist. A missing id
-- means "this bot cannot open the app yet", never "let it in".
alter table sandbox_pool add column bot_id text;

-- Digits only, so a token pasted here by mistake cannot become an allowlist
-- entry (and so nobody stores the secret half in a public-by-design column).
alter table sandbox_pool
  add constraint sandbox_pool_bot_id_numeric
  check (bot_id is null or bot_id ~ '^[0-9]{1,20}$');

-- The allowlist read is "every live seat's bot id", so index the column rather
-- than scanning the pool on every cache refresh.
create index if not exists sandbox_pool_bot_id_idx on sandbox_pool (bot_id)
  where bot_id is not null;
