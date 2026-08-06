-- Inbound phone-call capture (plan 2026-08-04-phone-call-signalwire).
-- SignalWire records → RecordingStatusCallback enqueues → an out-of-band worker
-- downloads+transcribes (AssemblyAI) → the channel-agnostic recordFieldNote lands
-- it as channel='phone_call'. This migration adds the routing table, the durable
-- ingest queue, the atomic claim function, and the private audio bucket.
--
-- Two tables, distinct roles:
--   call_numbers — maps a dialed SignalWire number -> its tenant (+ the real line
--                  to <Dial>-forward to). The webhook's tenant entry point.
--   call_ingest  — the per-call work queue + audio-lifecycle + consent record.
--                  A NORMAL mutable table (queue bookkeeping); the immutable
--                  evidence stays in raw_captures.

-- ── Number -> tenant routing ────────────────────────────────────────────────
create table call_numbers (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  phone_number text not null,           -- the SignalWire number customers dial (E.164)
  forward_to   text,                    -- the tenant's real call-center line for <Dial> (null = voicemail mode)
  created_at   timestamptz not null default now()
);
-- A dialed number resolves to exactly one tenant (global, not per-tenant): the
-- recording callback only carries the number, so this must be unambiguous.
create unique index uq_call_numbers_phone on call_numbers (phone_number);

-- ── Ingest queue + audio lifecycle + consent record ─────────────────────────
create table call_ingest (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  -- SignalWire RecordingSid — the at-least-once dedup key (callbacks retry).
  external_id        text not null,
  caller_phone       text,             -- the inbound caller-ID (From) — the identity key (see identityMatch)
  call_sid           text,             -- SignalWire CallSid — support/debug + REST re-lookup fallback
  -- Starts as the REMOTE SignalWire RecordingUrl; the worker rewrites it to the
  -- Supabase object path after copying the audio in. Always set (even in
  -- transcript-only mode) so the purge can still find the object.
  audio_ref          text,
  status             text not null default 'pending'
                       check (status in ('pending', 'processing', 'ingested', 'error')),
  match_status       text,             -- the recordFieldNote outcome (matched/needs_confirmation/…) for follow-up
  attempts           int  not null default 0,
  capture_id         uuid references raw_captures(id),
  -- The consent record: our voice webhook always returns a <Say> before <Dial
  -- record>, so a recording implies the announcement played. Logged here.
  consent_announced  boolean not null default false,
  occurred_at        timestamptz,
  audio_delete_after timestamptz,      -- when the purge may delete the stored audio
  legal_hold         boolean not null default false,   -- suspends the purge (litigation hold)
  audio_deleted_at   timestamptz,      -- set once the object is removed (guards re-runs)
  payload            jsonb not null default '{}'::jsonb,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- Idempotent webhook dedup: a redelivered RecordingSid insert hits this and is
-- turned into a no-op by the accessor (insert-then-catch-23505). Both cols NOT
-- NULL, so this is a plain (non-partial) unique index.
create unique index uq_call_ingest_external on call_ingest (tenant_id, external_id);
-- Worker claim scan: find the oldest pending row.
create index idx_call_ingest_status on call_ingest (status);
-- Purge scan: rows still holding audio that is eligible to delete. The `< now()`
-- filter lives in listExpiredAudio's WHERE — now() is NOT IMMUTABLE, so it cannot
-- go in a partial-index predicate (Postgres rejects it).
create index idx_call_ingest_purge on call_ingest (audio_delete_after)
  where audio_deleted_at is null and not legal_hold;

-- Reuse the shared updated_at trigger (migration 20260620012321).
create trigger call_ingest_set_updated_at
  before update on call_ingest
  for each row execute function set_updated_at();

-- ── Atomic claim (the worker's queue pop) ───────────────────────────────────
-- supabase-js/PostgREST cannot express `UPDATE … LIMIT … FOR UPDATE SKIP LOCKED`,
-- so the concurrency-safe claim lives in SQL: two workers never grab the same row.
-- attempts < 5 is the retry cap (markCallError bumps attempts; a 5th failure parks
-- the row in 'error' and this stops re-serving it).
create function claim_next_call() returns call_ingest
language sql
as $$
  update call_ingest set status = 'processing', updated_at = now()
  where id = (
    select id from call_ingest
    where status = 'pending' and attempts < 5
    order by created_at
    for update skip locked
    limit 1
  )
  returning *;
$$;

-- ── Private audio bucket ────────────────────────────────────────────────────
-- Recordings are copied here from SignalWire; served to AssemblyAI via a
-- short-lived signed URL; deleted by the purge cron (Supabase Storage has no
-- native object-expiry). NOTE: the migration role may lack INSERT on
-- storage.buckets on some stacks — if this is a no-op, create the bucket via the
-- Storage API / Studio and verify it exists. Never public.
insert into storage.buckets (id, name, public)
values ('call-audio', 'call-audio', false)
on conflict (id) do nothing;

-- ── Fail closed: no client-side reader ──────────────────────────────────────
-- Both tables hold cross-tenant caller PII (numbers, transcript pointers) and,
-- like every table here, inherit rls=false via auto_expose_new_tables
-- (supabase/config.toml) — i.e. reachable by the anon/authenticated Data-API
-- keys. The server only ever uses the service-role key (bypasses RLS), so
-- enabling RLS with no policy closes the Data-API door with zero impact on the
-- app. Mirrors the cost-tables closure (20260725140000) and pays down a slice of
-- the auto_expose_new_tables debt (engineering-memory §4, due before 2026-10-30).
alter table call_numbers enable row level security;
alter table call_ingest  enable row level security;
revoke all on call_numbers, call_ingest from anon, authenticated;
-- claim_next_call mutates the queue — no client role should call it.
revoke all on function claim_next_call() from public, anon, authenticated;
