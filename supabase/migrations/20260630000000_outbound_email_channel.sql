-- Reconstructed migration file for a ledger entry that had no file in the repo:
-- version 20260630000000 ('outbound_email_channel') exists in the test project's
-- supabase_migrations.schema_migrations (applied via MCP during the reverted
-- PR #7 work and never rolled back), and generated types have carried the enum
-- value since. Recorded here so a fresh environment built from supabase/migrations
-- matches the live schema. IF NOT EXISTS keeps it a no-op where already applied.
alter type capture_channel add value if not exists 'outbound_email';
