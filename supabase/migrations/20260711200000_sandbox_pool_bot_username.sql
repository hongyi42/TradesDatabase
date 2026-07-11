-- Feature A follow-up (2026-07-11): the bind is chat-reachable but its outcome
-- wasn't usable — bind_telegram claimed a sandbox and told the manager "s4",
-- but the technician needs the sandbox's Telegram BOT HANDLE (@...) to open a
-- chat (bots cannot message first), and the handle lived only in the
-- operator's provisioning terminal. Store it on the pool row at registration
-- (the operator has just seen it: the provision phase's getMe prints it), so
-- bind_telegram can return it and the manager can relay "open @bot, hit
-- /start". Nullable: rows registered before this column (or via the legacy
-- assign path) surface "ask your operator" instead of a guess.
alter table sandbox_pool add column bot_username text;
