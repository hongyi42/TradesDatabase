---
date: 2026-06-30
task: Inbound phone-call capture — record → transcribe → spine, short two-tier audio retention
research: thoughts/shared/research/2026-06-30-phone-call-input-feature.md
status: superseded (see 2026-08-04-phone-call-signalwire.md)
---

> **⛔ SUPERSEDED 2026-08-04 by [`2026-08-04-phone-call-signalwire.md`](2026-08-04-phone-call-signalwire.md).**
> The provisioned provider is **SignalWire**, not Vapi, and the fresh plan re-planned the webhook path
> around SignalWire's two-webhook + fetch-and-copy model. Implement from the SignalWire plan; this June
> draft is kept for history. The reconciliation notes below explain the drift.

> ## ⚠ Reconciliation update — 2026-08-04 (re-check before implementing)
> This plan is a 2026-06-30 draft, never implemented (no `src/calls/`, no `phone.ts`, no phone
> migration exist). The seam design is sound, but several steps drifted or are now unsafe. Per
> `build-schedule.md` and CLAUDE.md, re-run `/research` → `/plan` before `/implement`. Verified
> against current code 2026-08-04:
>
> 1. **🛑 SAFETY — the `mcp__supabase-test__*` / "`supabase-test` MCP" steps in EVERY phase are
>    superseded and dangerous.** The hosted "test" project (`daqapdlkgxfrhquacprv`) **IS the
>    deployed pilot's LIVE customer database** (CLAUDE.md; a test run truncated the pilot roster
>    2026-07-03). Applying this migration or mutating rows through that MCP would hit real
>    customer data. The available Supabase MCP is also a *different account* (HANDOFF.md).
>    **Correct workflow for all phases:** run migrations on the **local** Docker stack
>    (`npx supabase start`; `npx supabase db reset` — use `migration up --include-all` because the
>    cost_* migrations are timestamped out of order); tests only against local (`.env.test`,
>    `testEnvGuard`); regenerate types with **`npm run gen:types:local`** (NOT `gen:types`, which
>    is `--linked` → pilot); pilot DDL, if/when it ships, is applied deliberately BY HAND via the
>    Supabase SQL editor and recorded in `schema_migrations`. Read every "supabase-test MCP" /
>    `execute_sql` / `apply_migration` / `generate_typescript_types` line below as "local stack".
> 2. **Model.** The write-path extractor + classifier now run **GLM-5.2 via DeepInfra** by default
>    (`src/model/forcedTool.ts`, `MODEL_PROVIDER` unset → `'openai'`; `INFERENCE_API_KEY`), not
>    Sonnet. AssemblyAI (STT) is unaffected; the transcript is still text-only into `extract()`.
> 3. **Attribution.** `webhook.ts` now derives a per-person composite `user_id` and **REJECTS**
>    `connector:`-prefixed refs (`webhook.ts:176-179`). The Phase-3 `technicianRef:'connector:phone'`
>    will be rejected as-is — phone attribution must be re-decided (a phone call has no per-person
>    Telegram user). Options to weigh at re-plan: a reserved non-`connector:` system ref per tenant,
>    or resolve attribution purely from the tenant + caller-ID.
> 4. **Line anchors moved** (same files, no renames): `RecordFieldNoteInput` is `recordFieldNote.ts:34-52`;
>    `extract()` at `:153`; the L2-skip early-return at `:173-175`; httpServer `handle()` at
>    `httpServer.ts:238` and the `/inbound/` branch at `:241` — which **already catches
>    `/inbound/phone`** and dispatches to `handleInboundWebhook`→`resolveNormalizer`, so a separate
>    `handlePhone` branch (Phase 2) is optional, only needed if phone wants distinct auth/body handling.
> 5. **Cost tracking (new since 2026-06-30 — add to scope).** A per-tenant cost ledger now exists.
>    Telephony (Vapi/Twilio) + STT (AssemblyAI) are **per-minute metered with free tiers**, so they
>    follow the **counter + bill-driven `infra_costs`** pattern (like Brave/Composio), NOT a
>    `cost_rates` per-minute SKU: write per-tenant `cost_events` (units, `provider='telephony'`/`'stt'`,
>    no rate row → render as `—`) for attribution, and hand-enter the monthly invoice dollars into
>    `infra_costs`. There is NO dollar auto-collector (neither vendor exposes a billing API). A
>    per-tenant minute split needs a NEW `infra_costs.allocation` value + weight branch (the existing
>    `per_spine_tool_call` weight is hardcoded `provider='spine'`). Note: a provider with no rate rows
>    is silently counted with no alarm — add a crossover check if these can incur real spend.
>
> Still TRUE and load-bearing: inbound is **synchronous** (async-worker rationale holds);
> `fallbackPhone` is still absent from `RecordFieldNoteInput` (Phase 3's additive change is still
> needed); caller-ID phone match is live (`identityMatch.ts:62`); inbound callers bypass the
> stage→confirm gate and write L1-first (Phase 3's identity note is correct).

> ## 🛑 Provider correction — 2026-08-04: it's **SignalWire + AssemblyAI**, not Vapi
> `.env` (not `.env.example`) ALREADY provisions **SignalWire** (`SIGNALWIRE_SPACE_URL`,
> `SIGNALWIRE_PROJECT_ID`, `SIGNALWIRE_API_TOKEN`) and **AssemblyAI** (`ASSEMBLYAI_API_KEY`). There
> is **no Vapi key**. The provider this plan left "leaning Vapi" is already chosen — and it's a
> different architecture. SignalWire is a **Twilio-API-compatible CPaaS** (LaML/cXML), verified
> against live docs 2026-08-04:
> - **Record via LaML** (Twilio-identical): `<Say>`/`<Play>` consent → `<Dial
>   record="record-from-answer-dual">` (or `<Record>`); SignalWire fires a **`RecordingStatusCallback`**
>   POST when the recording is ready, carrying the media URL + a Twilio-style `RecordingSid` (→ the
>   `externalId` dedup key).
> - **Signature = Twilio-compatible `validateRequest`** over header **`X-SignalWire-Signature`** (HMAC
>   with the SignalWire API token). So Phase-1's proposed `VAPI_WEBHOOK_SECRET` is WRONG — there is no
>   separate webhook secret; the SignalWire token IS the validation key.
> - **No native "BYO-bucket → Supabase".** Vapi could write audio straight to our bucket; SignalWire
>   cannot. **New required step:** fetch the recording from SignalWire's media URL (project/token auth)
>   and copy it into the Supabase `call-audio` bucket before purge/lifecycle can own it. This is exactly
>   the "assemble-it-yourself / Twilio" path the research doc named as the alternative — now the real one.
>
> **Consequence for the phases below:** every "Vapi" reference re-points to SignalWire. Phase 2's
> `parseVapiEndOfCall` / `verifyVapiSignature` / BYO-bucket become `parseSignalWireRecordingCallback` /
> `validateRequest(X-SignalWire-Signature)` / an explicit fetch-and-copy. AssemblyAI can transcribe from
> the SignalWire media URL directly or from the copied Supabase object. Because this reshapes Phase 2,
> re-`/plan` it specifically before implementing. (My readiness note was also wrong: Phases 2–3 are NOT
> account-blocked — the creds already exist; the real gap is this Vapi→SignalWire re-point.)

## Overview
Add an inbound phone-call channel that lands recorded calls into the spine. **SignalWire** records
(dual-channel, with a non-skippable "this call is recorded" LaML announcement); the webhook **fetches
the recording and copies it to Supabase Storage** (SignalWire has no native bucket write — see the
2026-08-04 provider correction above); a fast webhook acks and **enqueues** the call; an out-of-band worker transcribes via AssemblyAI, redacts only
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

**`.env.example`** — *(2026-08-04: `.env` ALREADY sets `SIGNALWIRE_SPACE_URL`/`SIGNALWIRE_PROJECT_ID`/`SIGNALWIRE_API_TOKEN` + `ASSEMBLYAI_API_KEY`; mirror these as blank keys in `.env.example`.)* There is **no** `VAPI_WEBHOOK_SECRET` — SignalWire webhooks verify via `validateRequest` over `X-SignalWire-Signature` using the SignalWire token. Still to add: `CALL_AUDIO_BUCKET=call-audio`, `CALL_AUDIO_RETENTION_DAYS=30` (0 = transcript-only).

### Automated verification
> *(2026-08-04: rewritten off the removed `supabase-test` MCP onto the local stack — see top update.)*
- [ ] migration applies on the **local** stack: `npx supabase db reset` (or `migration up --include-all`) replays cleanly, then `\dt` / a local `select` shows `call_numbers` + `call_ingest`
- [ ] bucket exists locally: `select id from storage.buckets where id='call-audio'` returns the row (if the migration role lacks INSERT on `storage.buckets`, create it via the local Storage API/Studio per the migration note)
- [ ] regenerate types with **`npm run gen:types:local`** → overwrites `src/db/database.types.ts` **after** the migration applied (order is load-bearing — types must include `call_ingest` + `claim_next_call`). Do NOT use `npm run gen:types` (`--linked` → the pilot)
- [ ] `npm run typecheck` · `npm run lint` pass

### Live verification (agent-executable)
- Prerequisites: the **local** Supabase stack (NOT any hosted/`supabase-test` project — see top update)
- [ ] against the local DB, insert a `call_numbers` row + a `call_ingest` row; confirm `uq_call_ingest_external` rejects a duplicate `(tenant_id, external_id)`; call `select * from claim_next_call()` and confirm it returns the pending row with `status='processing'`; self-clean the rows

### Manual verification
- [ ] (none)

---

## Phase 2: Telephony webhook — verify, route by number, enqueue, fast ack

### What this phase does
> *(2026-08-04: re-point Vapi→SignalWire per the provider correction. This is a `RecordingStatusCallback`
> webhook verified with `validateRequest`/`X-SignalWire-Signature`, plus a fetch-and-copy of the recording
> media URL into the `call-audio` bucket. Re-`/plan` the specifics below.)*
Adds a SignalWire `RecordingStatusCallback` webhook that authenticates the call, resolves the tenant from the dialed number,
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
- Prerequisites: the HTTP server running locally + the **local** Supabase stack (not `supabase-test` — see top update)
- [ ] POST a captured Vapi sample to `/inbound/phone`; confirm 200 within ~1s and one `call_ingest` row in `status='pending'`; self-clean

### Manual verification
- [ ] (none)

---

## Phase 3: Async worker — transcribe, redact, write-path

### What this phase does
Drains `call_ingest`: signs the audio, gets a diarized transcript (AssemblyAI), redacts sensitive-auth
data only, and runs `recordFieldNote` with `channel:'phone_call'` — landing L1 transcript + audio pointer
and structuring L2/L3 via the existing pipeline.

### Identity-resolution design (Blocker-1 — RESOLVED 2026-08-04)

> **✅ Decisions (2026-08-04) — closes Blocker 1 (source/attribution + new-caller handling):**
>
> 1. **Source `technician_ref` = the constant `'phone-line'` ("A2-lite").** A call's source is the
>    business line, not a person. The old `connector:phone` value is now REJECTED by the webhook
>    (`webhook.ts:176-179`, banned `connector:` prefix); `'phone-line'` sidesteps it. `technician_ref`
>    is a plain text column (`rawCaptures.ts:16`, nullable; email already ingests unknown refs), so a
>    sentinel is accepted with no FK fight. **Ship the bare string; add a `technicians` roster row**
>    (`ref='phone-line'`, a system/seat-exempt kind — non-bookable, never a manager) **ONLY where a
>    read/audit path INNER-joins `technician_ref`→roster** and would otherwise drop or blank the phone
>    row. Audit these first (Phase-3 sub-task): `list_team`, briefing bylines, any `join technicians on
>    ref`, tier resolution. Do NOT pre-create the roster row — check, then add only if a join needs it.
>    (Rejected Option B "no ref / null": the write-path requires a ref — `RecordFieldNoteInput.technicianRef`
>    is `string`, not nullable, `recordFieldNote.ts:36` — so null-ref forces a system-wide contract change
>    across every channel and leaves phone captures unfilterable. A named sentinel is smaller and cleaner.)
>
> 2. **New/unmatched callers: L1-only + a manager review item (auto-create deferred).** A repeat caller
>    auto-matches by caller-ID (the `fallbackPhone` fix below). A first-time caller matches nothing → the
>    transcript is stored **L1-only** (already the behavior) AND the worker opens a `review_items` row
>    (`kind='unlinked_call'`, carrying caller # + `captureId` + a snippet) so a manager can link-to-existing
>    or create-new via the existing `resolve_review` path. The phone path is **agentless** — there is no
>    live chat to ask "which customer?", so the review item is how an unmatched call reaches a human.
>    **Auto-creating a customer from a call is NOT done here** (trades lines draw spam/wrong-numbers →
>    junk L2 in an append-only store); explicit follow-up, gated on proven transcript quality.

`matchIdentity` matches on `extracted.phone` (pulled from the *transcript*), never the envelope `from`,
and `recordFieldNote` returns `needs_confirmation`/`needs_disambiguation` **without writing L2** when
nothing resolves (now `recordFieldNote.ts:173-175`; L1 is already appended before this by `:114`). That L1-only outcome is the *same accepted behavior the
email connector already has* (webhook.ts:194 labels it `ingested`) — the transcript is retained, L2 fills
in later. The improvement worth making (caller-ID is a strong key the matcher currently ignores):
- **Add `fallbackPhone?: string | null` to `RecordFieldNoteInput`** (type now at `recordFieldNote.ts:34-52`) and, immediately after `extract()` (now `recordFieldNote.ts:153`, before `matchIdentity` at `:163`), `if (!extracted.phone && input.fallbackPhone) extracted.phone = input.fallbackPhone;` — so a *repeat* caller auto-matches by caller-ID. Additive and inert for email (field unset). This is the only change to the shared write-path.
- **Genuinely-new callers stay L1-only by design** (mirrors email) — the worker records `matchStatus` on `call_ingest`, **opens an `unlinked_call` review item** (decision 2 above; this is the agentless replacement for the "ask which customer?" step technicians get), and still marks the call `ingested` (the capture IS stored). Full auto-create-new-customer-from-caller-ID is an explicit **follow-up**, not this plan.

### Changes required

**`src/writePath/recordFieldNote.ts`** — add optional `fallbackPhone` to `RecordFieldNoteInput`; inject it as the `extracted.phone` fallback (above). No behavior change when unset.

**`src/db/reviewItems.ts`** — add a `kind='unlinked_call'` value + `openUnlinkedCallReview({ tenantId, captureId, callerPhone, snippet })` (idempotent per `captureId` so a re-processed call doesn't stack duplicates). The manager sees it via the existing `list_pending_reviews`; **`resolve_review` (`src/mcp/server.ts`) gains an `unlinked_call` branch** — resolve = link the stored capture to a chosen/created customer (stamp L2 with `source_capture_id` = the parked L1 row), dismiss = spam/wrong-number (leaves the transcript in L1, no L2). Reuses the existing review-item + resolver machinery; no new surface.

**Read-path audit for the `'phone-line'` sentinel (decision 1)** — before shipping, grep the paths that turn `technician_ref` into a person (`list_team`, briefing bylines, any `join technicians ... on ... ref`, tier resolution in `src/mcp/server.ts`). If any INNER-joins the roster and would drop/blank a `phone-line` capture, add the one seat-exempt `technicians` row (`ref='phone-line'`) in the Phase-1 migration; otherwise ship the bare string.

**`src/calls/transcribe.ts`** (new) — `Transcriber` interface + `assemblyAiTranscriber`: submit `audio_url`, poll to completion with `speaker_labels:true`, return diarized text (`Speaker A/B`, from the dual channels). Decoupled so STT is swappable/re-runnable.

**`src/calls/redact.ts`** (new) — `redactSensitive(text: string): string`. Regex-replace card numbers (Luhn-ish 13–19 digit groups) → `[CARD]`, CVV-in-context, SSN (`\d{3}-\d{2}-\d{4}`) → `[SSN]`, bank/routing → `[BANK]`. **Keep** names/addresses/phones/job details. Unit-tested with positive + negative cases (a 5-digit ZIP must NOT match SSN/card).

**`src/calls/worker.ts`** (new) — `processNextCall(deps?): Promise<'idle'|'ingested'|'error'>`:
1. `claimNextPendingCall()`; null → `idle`.
2. Resolve `audio_ref`→ingestable URL: storage path → `client.storage.from(bucket).createSignedUrl(path, ttl)`; else use the URL as-is.
3. `transcribe(url)` → `redactSensitive(...)`.
4. `retentionDays = Number(CALL_AUDIO_RETENTION_DAYS ?? 30)`. `recordFieldNote({ tenantId, technicianRef:'phone-line' /* source sentinel, decision 1 — NOT the banned 'connector:phone' */, channel:'phone_call', text: redacted, blobPath: retentionDays===0 ? null : row.audio_ref, fallbackPhone: row.caller_phone, externalId, occurredAt, sourceMeta:{ fromNumber: row.caller_phone, durationSec, recordingProvider:'signalwire', consentAnnounced } })`.
5. `markCallIngested(id, { captureId: r.captureId, matchStatus: r.status, audioDeleteAfter: now + retentionDays*1d })` — **any** non-throwing `r.status` (`matched`/`needs_confirmation`/`needs_disambiguation`/`duplicate`) counts as `ingested` (L1 stored), mirroring the email path. Retention `0` → `audioDeleteAfter = now` (purge deletes the transient audio next run; `blob_path` already null, but `audio_ref` on the row still points the purge at the object).
5b. If `r.status !== 'matched'` (new/unmatched caller) → `openUnlinkedCallReview({ tenantId, captureId: r.captureId, callerPhone: row.caller_phone, snippet: redacted.slice(0, 200) })` (decision 2; idempotent per `captureId`). A `matched` repeat caller skips this — no review item.
6. On throw → `markCallError(id, msg)`. Injectable deps `{ transcribe, recordFieldNote, signUrl, openUnlinkedCallReview }` for tests.

**`src/calls/runWorker.ts`** (new) — loop calling `processNextCall` with backoff; `package.json` script `"calls:worker": "node dist/calls/runWorker.js"`. (Durable queue → safe across the stateless replicas; an alternative pg_cron+Edge-Function trigger is noted but not built.)

### Automated verification
- [ ] `src/calls/redact.test.ts`: card/SSN/CVV redacted; ZIP, phone, name, street address preserved
- [ ] `src/calls/worker.test.ts`: stubbed `transcribe`+`recordFieldNote` → `call_ingest` goes `processing→ingested`, `capture_id`+`match_status` set, `audio_delete_after ≈ now+30d`; `retentionDays=0` → `blobPath` null passed to recordFieldNote **but `audio_ref` still set** on the row; **`recordFieldNote` returning `needs_confirmation` → still `ingested` (NOT mislabeled/`error`) AND `openUnlinkedCallReview` called once**; a `matched` status → `openUnlinkedCallReview` NOT called; transcriber throw → `error` + `attempts` incremented
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass

### Live verification (agent-executable)
- Prerequisites: `ASSEMBLYAI_API_KEY` + a sample audio object in the local test bucket + the **local** Supabase stack (not `supabase-test` — see top update). **If unavailable, declare and defer** (per `verifying-behavior`).
- [ ] seed a row whose `caller_phone` matches an existing test customer; run `processNextCall`; read back the new `raw_captures` row (channel `phone_call`, redacted `raw_text`, `blob_path` set) **and** the linked customer/job/visit (proves caller-ID match). Separately, a row with an unknown `caller_phone` → L1 capture written + `match_status='needs_confirmation'`, no L2, **and one `review_items` row `kind='unlinked_call'`** referencing the capture (expected L1-only + flagged). Self-clean

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
- Prerequisites: the **local** Supabase stack (not `supabase-test` — see top update) + local test bucket
- [ ] seed a row with `audio_delete_after` in the past + a dummy object; run `purgeExpiredAudio`; confirm object gone + `audio_deleted_at` set; seed a `legal_hold` row and confirm it survives; self-clean

### Manual verification
- [ ] confirm the cron schedules for `calls:worker` and `calls:purge` are live in the deploy environment (human-judged infra step)

---
*Pause after Phase 3 and Phase 4 (non-empty Manual lists); Phases 1–2 continue automatically.*
