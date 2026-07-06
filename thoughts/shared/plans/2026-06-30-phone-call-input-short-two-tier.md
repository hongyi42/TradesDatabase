---
date: 2026-06-30
task: Inbound phone-call capture — record → transcribe → spine, short two-tier audio retention
research: thoughts/shared/research/2026-06-30-phone-call-input-feature.md
status: draft
---

## Overview
Add an inbound phone-call channel that lands recorded calls into the spine. Vapi records (dual-channel,
with a non-skippable "this call is recorded" announcement) and writes audio to Supabase Storage; a fast
webhook acks and **enqueues** the call; an out-of-band worker transcribes via AssemblyAI, redacts only
sensitive-auth data, and runs the existing channel-agnostic `recordFieldNote` (channel `'phone_call'`).
Audio is auto-deleted after a configurable window (default 30d; `0` = transcript-only), suspendable by a
legal-hold flag. Reuses the spine seam end-to-end; no voiceprints (channel-based diarization only).
**Out of scope:** conversational AI receptionist, press-1/queue routing, outbound calling.

## Phase 1: Schema, storage bucket, DB layer

### What this phase does
Adds the number↔tenant routing table, a durable `call_ingest` table (work queue + audio lifecycle +
consent log in one), and a private Supabase Storage bucket; exposes typed DB helpers.

### Changes required

**`supabase/migrations/20260630NNNNNN_phone_call_ingest.sql`** (new)
- `create table call_numbers (id uuid pk default gen_random_uuid(), tenant_id uuid not null references tenants(id), phone_number text not null, created_at timestamptz default now());` + `create unique index uq_call_numbers_phone on call_numbers(phone_number);` (E.164; the dialed `To` resolves the tenant).
- `create table call_ingest (id uuid pk default gen_random_uuid(), tenant_id uuid not null references tenants(id), external_id text not null, caller_phone text, audio_ref text, status text not null default 'pending', match_status text, attempts int not null default 0, capture_id uuid references raw_captures(id), consent_announced boolean not null default false, occurred_at timestamptz, audio_delete_after timestamptz, legal_hold boolean not null default false, audio_deleted_at timestamptz, payload jsonb not null default '{}'::jsonb, last_error text, created_at timestamptz default now(), updated_at timestamptz default now());`
  - `caller_phone` = the dialed-in caller-ID (`from`), the strong identity key (see Phase 3). `audio_ref` = the storage object path; **always set even when L1 `blob_path` is nulled** (transcript-only), so purge can still find the object. `match_status` records the `recordFieldNote` outcome (`matched`/`needs_confirmation`/…) for later follow-up.
- `create unique index uq_call_ingest_external on call_ingest(tenant_id, external_id);` (idempotent webhook dedup; non-partial, both cols NOT NULL — insert-then-catch-23505).
- `create index idx_call_ingest_status on call_ingest(status);` and `create index idx_call_ingest_purge on call_ingest(audio_delete_after) where audio_deleted_at is null and not legal_hold;` — **do NOT put `now()` in the predicate** (non-IMMUTABLE → rejected); the `< now()` filter lives in `listExpiredAudio`'s WHERE.
- Reuse the existing `set_updated_at` trigger (migration `20260620012321`, already reused by `schedule_entries`) on `call_ingest`.
- **Atomic claim function** (Blocker fix — supabase-js/PostgREST cannot express `UPDATE … LIMIT … FOR UPDATE SKIP LOCKED`, and the repo has no `.rpc`/`pg` precedent, so add it here):
  ```sql
  create function claim_next_call() returns call_ingest language sql as $$
    update call_ingest set status='processing', updated_at=now()
    where id = (select id from call_ingest where status='pending' and attempts < 5
                order by created_at for update skip locked limit 1)
    returning *; $$;
  ```
- **Storage bucket:** `insert into storage.buckets (id, name, public) values ('call-audio','call-audio', false) on conflict do nothing;` — **UNCERTAINTY:** the migration role may lack INSERT on `storage.buckets`. If the Phase-1 bucket-exists check (below) fails, create it via the Storage API / dashboard instead and keep the insert as a no-op. Verify, don't assume.
- NOTE in a comment: `call_ingest` is a normal mutable table (NOT append-only) — the lifecycle/queue record; the immutable evidence stays in `raw_captures`.

**`src/db/callNumbers.ts`** (new) — `resolveTenantByNumber(phoneNumber: string): Promise<string | null>` (select tenant_id where phone_number = …).

**`src/db/callIngest.ts`** (new) — typed row type + helpers:
- `enqueueCall(input: { tenantId; externalId; callerPhone?; audioRef?; consentAnnounced; occurredAt?; payload }): Promise<{ id: string; deduped: boolean }>` — insert; on `23505` (uq_call_ingest_external) return existing id with `deduped: true`.
- `claimNextPendingCall(): Promise<CallIngest | null>` — calls `getClient().rpc('claim_next_call')` (the `SKIP LOCKED` function above); returns the claimed row or null. **New `.rpc` pattern for the repo** — type the result by casting to the generated `Database['public']['Functions']['claim_next_call']['Returns']` (regenerated in Phase 1) or a hand-written `CallIngest`.
- `markCallIngested(id, { captureId, matchStatus, audioDeleteAfter })`, `markCallError(id, message)` (increments attempts; status back to `'pending'` while `attempts < 5`, else `'error'`).
- `listExpiredAudio(): Promise<CallIngest[]>` (audio_delete_after < now(), not legal_hold, audio_deleted_at null), `markAudioDeleted(id)`, `setLegalHold(id, on: boolean)`.

**`src/db/index.ts`** — add `export * from './callNumbers.js';` and `export * from './callIngest.js';`

**`.env.example`** — append: `VAPI_WEBHOOK_SECRET=` (🔒), `ASSEMBLYAI_API_KEY=` (🔒), `CALL_AUDIO_BUCKET=call-audio`, `CALL_AUDIO_RETENTION_DAYS=30` (0 = transcript-only).

### Automated verification
- [ ] migration applies on **test** Supabase (`mcp__supabase-test__apply_migration`), then `mcp__supabase-test__list_tables` shows `call_numbers` + `call_ingest`
- [ ] bucket exists: `execute_sql` `select id from storage.buckets where id='call-audio'` returns the row (if not, create via Storage API/dashboard per the migration note)
- [ ] `mcp__supabase-test__generate_typescript_types` → overwrite `src/db/database.types.ts` **after** the migration applied (order is load-bearing — types must include `call_ingest` + `claim_next_call`)
- [ ] `npm run typecheck` · `npm run lint` pass

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP
- [ ] insert a `call_numbers` row + a `call_ingest` row via `execute_sql`; confirm `uq_call_ingest_external` rejects a duplicate `(tenant_id, external_id)`; call `select * from claim_next_call()` and confirm it returns the pending row with `status='processing'`; self-clean the rows

### Manual verification
- [ ] (none)

---

## Phase 2: Telephony webhook — verify, route by number, enqueue, fast ack

### What this phase does
Adds a Vapi end-of-call webhook that authenticates the call, resolves the tenant from the dialed number,
enqueues into `call_ingest`, and returns immediately — **no STT or write-path on the request thread**.

### Changes required

**`src/inbound/phone.ts`** (new) — `parseVapiEndOfCall(payload: unknown): { externalId; toNumber; fromNumber; audioRef?; occurredAt?; consentAnnounced }`. `externalId` = Vapi call id; `audioRef` = the Supabase Storage object path Vapi wrote (BYO-bucket) **or** a `recordingUrl` the worker will fetch. Throws if call id or `toNumber` absent.

**`src/inbound/phoneWebhook.ts`** (new) — mirrors `webhook.ts` structure but Vapi-specific and async:
- `verifyVapiSignature(rawBody, headers, secret)` — **UNCERTAINTY:** confirm Vapi's scheme against live headers (use `INBOUND_DEBUG` in httpServer). Option A: shared-token header `x-vapi-secret` constant-time compared to `VAPI_WEBHOOK_SECRET`. Option B: HMAC-SHA256 over the raw body. Implement A now; leave a typed seam for B. Document which once a live event is captured.
- `handlePhoneWebhook(rawBody, headers, deps?): Promise<{ status; callIngestId? }>` — statuses: `enqueued | duplicate | unknown_number | bad_signature | bad_payload | transient_error`. Flow: verify → JSON.parse → `parseVapiEndOfCall` → `resolveTenantByNumber(toNumber)` (null → `unknown_number`, 200, no retry) → `enqueueCall({ ..., callerPhone: fromNumber })` (dedup → `duplicate`). Deterministic failures `return`; DB blips `throw`→caught→`transient_error`.

**`src/mcp/httpServer.ts`** — in `handle()` (line 113), branch the phone path **before** the Composio handler:
```ts
if (req.url?.startsWith('/inbound/phone')) { await handlePhone(req, res); return; }
if (req.url?.startsWith('/inbound/')) { await handleInbound(req, res); return; }
```
Add `handlePhone` (mirrors `handleInbound` lines 61-108) with a `PHONE_STATUS_CODES` map: `enqueued/duplicate/unknown_number → 200`, `bad_signature → 401`, `bad_payload → 400`, `transient_error → 503`. Fast ack — enqueue only.

### Automated verification
- [ ] new Vitest `src/inbound/phoneWebhook.test.ts`: valid event → `enqueued` (+ row in injected fake); bad signature → `bad_signature`; unknown `toNumber` → `unknown_number`; redelivered same call id → `duplicate`; malformed payload → `bad_payload`
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass

### Live verification (agent-executable)
- Prerequisites: the HTTP server running locally + `supabase-test` MCP
- [ ] POST a captured Vapi sample to `/inbound/phone`; confirm 200 within ~1s and one `call_ingest` row in `status='pending'`; self-clean

### Manual verification
- [ ] (none)

---

## Phase 3: Async worker — transcribe, redact, write-path

### What this phase does
Drains `call_ingest`: signs the audio, gets a diarized transcript (AssemblyAI), redacts sensitive-auth
data only, and runs `recordFieldNote` with `channel:'phone_call'` — landing L1 transcript + audio pointer
and structuring L2/L3 via the existing pipeline.

### Identity-resolution design (Blocker-1 fix — decide here, not in code)
`matchIdentity` matches on `extracted.phone` (pulled from the *transcript*), never the envelope `from`,
and `recordFieldNote` returns `needs_confirmation`/`needs_disambiguation` **without writing L2** when
nothing resolves (recordFieldNote.ts:143-145). That L1-only outcome is the *same accepted behavior the
email connector already has* (webhook.ts:194 labels it `ingested`) — the transcript is retained, L2 fills
in later. The improvement worth making (caller-ID is a strong key the matcher currently ignores):
- **Add `fallbackPhone?: string | null` to `RecordFieldNoteInput`** and, after `extract()` (recordFieldNote.ts:131), `if (!extracted.phone && input.fallbackPhone) extracted.phone = input.fallbackPhone;` — so a *repeat* caller auto-matches by caller-ID. Additive and inert for email (field unset). This is the only change to the shared write-path.
- **Genuinely-new callers stay L1-only by design** (mirrors email) — the worker records `matchStatus` on `call_ingest` for later follow-up and still marks the call `ingested` (the capture IS stored). Full auto-create-new-customer-from-caller-ID is an explicit **follow-up**, not this plan.

### Changes required

**`src/writePath/recordFieldNote.ts`** — add optional `fallbackPhone` to `RecordFieldNoteInput`; inject it as the `extracted.phone` fallback (above). No behavior change when unset.

**`src/calls/transcribe.ts`** (new) — `Transcriber` interface + `assemblyAiTranscriber`: submit `audio_url`, poll to completion with `speaker_labels:true`, return diarized text (`Speaker A/B`, from the dual channels). Decoupled so STT is swappable/re-runnable.

**`src/calls/redact.ts`** (new) — `redactSensitive(text: string): string`. Regex-replace card numbers (Luhn-ish 13–19 digit groups) → `[CARD]`, CVV-in-context, SSN (`\d{3}-\d{2}-\d{4}`) → `[SSN]`, bank/routing → `[BANK]`. **Keep** names/addresses/phones/job details. Unit-tested with positive + negative cases (a 5-digit ZIP must NOT match SSN/card).

**`src/calls/worker.ts`** (new) — `processNextCall(deps?): Promise<'idle'|'ingested'|'error'>`:
1. `claimNextPendingCall()`; null → `idle`.
2. Resolve `audio_ref`→ingestable URL: storage path → `client.storage.from(bucket).createSignedUrl(path, ttl)`; else use the URL as-is.
3. `transcribe(url)` → `redactSensitive(...)`.
4. `retentionDays = Number(CALL_AUDIO_RETENTION_DAYS ?? 30)`. `recordFieldNote({ tenantId, technicianRef:'connector:phone', channel:'phone_call', text: redacted, blobPath: retentionDays===0 ? null : row.audio_ref, fallbackPhone: row.caller_phone, externalId, occurredAt, sourceMeta:{ fromNumber: row.caller_phone, durationSec, recordingProvider:'vapi', consentAnnounced } })`.
5. `markCallIngested(id, { captureId: r.captureId, matchStatus: r.status, audioDeleteAfter: now + retentionDays*1d })` — **any** non-throwing `r.status` (`matched`/`needs_confirmation`/`needs_disambiguation`/`duplicate`) counts as `ingested` (L1 stored), mirroring the email path. Retention `0` → `audioDeleteAfter = now` (purge deletes the transient audio next run; `blob_path` already null, but `audio_ref` on the row still points the purge at the object).
6. On throw → `markCallError(id, msg)`. Injectable deps `{ transcribe, recordFieldNote, signUrl }` for tests.

**`src/calls/runWorker.ts`** (new) — loop calling `processNextCall` with backoff; `package.json` script `"calls:worker": "node dist/calls/runWorker.js"`. (Durable queue → safe across the stateless replicas; an alternative pg_cron+Edge-Function trigger is noted but not built.)

### Automated verification
- [ ] `src/calls/redact.test.ts`: card/SSN/CVV redacted; ZIP, phone, name, street address preserved
- [ ] `src/calls/worker.test.ts`: stubbed `transcribe`+`recordFieldNote` → `call_ingest` goes `processing→ingested`, `capture_id`+`match_status` set, `audio_delete_after ≈ now+30d`; `retentionDays=0` → `blobPath` null passed to recordFieldNote **but `audio_ref` still set** on the row; **`recordFieldNote` returning `needs_confirmation` → still `ingested` (NOT mislabeled/`error`)**; transcriber throw → `error` + `attempts` incremented
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass

### Live verification (agent-executable)
- Prerequisites: `ASSEMBLYAI_API_KEY` + a sample audio object in the test bucket + `supabase-test` MCP. **If unavailable, declare and defer** (per `verifying-behavior`).
- [ ] seed a row whose `caller_phone` matches an existing test customer; run `processNextCall`; read back the new `raw_captures` row (channel `phone_call`, redacted `raw_text`, `blob_path` set) **and** the linked customer/job/visit (proves caller-ID match). Separately, a row with an unknown `caller_phone` → L1 capture written + `match_status='needs_confirmation'`, no L2 (expected L1-only). Self-clean

### Manual verification
- [ ] spot-check one real diarized transcript for redaction quality (judgment)

---

## Phase 4: Retention purge, legal hold, regulatory/ops setup

### What this phase does
Builds the Supabase-Storage auto-delete the platform won't do natively, makes it litigation-hold-aware,
and records the operational/regulatory tasks that gate go-live.

### Changes required

**`src/calls/purgeAudio.ts`** (new) — `purgeExpiredAudio(deps?): Promise<{ deleted: number }>`: `listExpiredAudio()` (WHERE `audio_delete_after < now()` and not `legal_hold` and `audio_deleted_at is null`) → for each, `client.storage.from(bucket).remove([row.audio_ref])` (the object path, **sourced from `call_ingest.audio_ref`, not L1 `blob_path` — which is null in transcript-only mode**) → `markAudioDeleted(id)`. Skips `legal_hold=true`. Idempotent (`audio_deleted_at` guards re-runs). `package.json` script `"calls:purge": "node dist/calls/purgeAudio.js"` — run by cron (e.g. Render Cron / pg_cron). NOTE: Supabase Storage has no native object-expiry; this script IS the lifecycle.

**`docs/phone-call-runbook.md`** (new) — operational/regulatory checklist (from research §D), explicitly:
- Vapi assistant config: non-skippable "this call is recorded" disclosure before recording; dual-channel recording; record-to-Supabase-bucket. (Config, not code — but the consent record is logged via `consent_announced`.)
- Documented retention schedule (audio = `CALL_AUDIO_RETENTION_DAYS`, transcript = long-term); how to set `legal_hold` (call `setLegalHold(id, true)`) to suspend purge.
- DPAs to sign (Supabase, Vapi, AssemblyAI); AssemblyAI no-train opt-out + DELETE.
- Controller/processor split: tenant = controller for its callers; SaaS = processor (provides announcement + deletion tooling).
- Cron wiring for `calls:purge` and `calls:worker`.

### Automated verification
- [ ] `src/calls/purgeAudio.test.ts`: expired non-held row → storage `remove` called + `audio_deleted_at` set; `legal_hold=true` row → NOT removed; already-deleted row → skipped
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP + test bucket
- [ ] seed a row with `audio_delete_after` in the past + a dummy object; run `purgeExpiredAudio`; confirm object gone + `audio_deleted_at` set; seed a `legal_hold` row and confirm it survives; self-clean

### Manual verification
- [ ] confirm the cron schedules for `calls:worker` and `calls:purge` are live in the deploy environment (human-judged infra step)

---
*Pause after Phase 3 and Phase 4 (non-empty Manual lists); Phases 1–2 continue automatically.*
