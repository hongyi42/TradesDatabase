---
date: 2026-08-04
task: Inbound phone-call capture via SignalWire (Compatibility/LaML) → AssemblyAI → spine. Supersedes the 2026-06-30 Vapi plan.
research: thoughts/shared/research/2026-06-30-phone-call-input-feature.md (provider section superseded 2026-08-04)
supersedes: thoughts/shared/plans/2026-06-30-phone-call-input-short-two-tier.md
status: SHIPPED — merged to `main` as `7f59a54`; live on the pilot (verified 2026-08-17)
---

> **Merge/deploy resolved (2026-08-17).** The 2026-08-06 status below ("NOT committed, NOT deployed")
> was superseded when the branch landed. `7f59a54` is an ancestor of `origin/main`; the migration is
> applied to the pilot (`call_numbers`, `call_ingest`); 7 calls ingested across 1 number, most recent
> 2026-08-11. The original note is kept below as the point-in-time record it was.

> **Implementation status (2026-08-06).** All 4 phases built; project-wide gates green (typecheck / lint /
> build; 67 phone tests). Verified **live** end-to-end on a SignalWire trial number via an ngrok tunnel →
> local server → local Supabase: real call → consent → forward → record → recording callback → enqueue →
> download (protected media, REST token) → AssemblyAI STT → redact → `recordFieldNote` → spine. **BOTH
> dispositions verified live:** matched caller → L2 job+visit (real diarized transcript "Speaker A: Hi, my
> furnace is out. This is John at 5 PM."), unmatched caller → L1 + `unlinked_call` review. Boxes below are
> ticked to match. **Only deploy-gated work remains:** **deploy** (Render) + **pilot DDL by hand** + prod
> env + provisioning (`call_numbers` rows, point the number's webhook at the prod URL) + the cron schedules
> (`calls:worker`, `calls:purge`). Two credentials required (confirmed live): `SIGNALWIRE_API_TOKEN` = `PSK…` signing
> key (webhook signatures); `SIGNALWIRE_REST_TOKEN` = `PT…` REST token (recording download, needs the
> **Voice + Management** scopes). Media URL Protection stays **ON** (recordings never public). See
> `docs/phone-call-runbook.md`.

## Overview

Land recorded inbound customer calls into the spine as `channel:'phone_call'` captures, using the
**SignalWire + AssemblyAI** stack already provisioned in `.env` (`SIGNALWIRE_SPACE_URL`,
`SIGNALWIRE_PROJECT_ID`, `SIGNALWIRE_API_TOKEN`, `ASSEMBLYAI_API_KEY`). SignalWire is a
Twilio-API-compatible CPaaS (LaML/cXML), which makes this the "assemble-it-yourself" path: SignalWire
records; **we** fetch the media, store it, transcribe it, and write it. Reuses the spine write-path
end-to-end; no voiceprints; audio auto-deletes after a configurable window.

**Out of scope (unchanged from June):** conversational AI receptionist, press-1/queue routing, outbound
calling, auto-create-customer-from-call.

**Deferred — missed/unanswered-call logging (added 2026-08-05).** The capture path keys off the
**recording** callback (`recordingStatusCallback`), which only fires when a call is *answered and
recorded*. An **unanswered / abandoned / no-answer** call produces no recording → it is **invisible** to
the spine (no L1 row, no trace). To log call *attempts* that leave no recording, wire SignalWire's
call-level **Status Change webhook** (the cXML Script's "Status Change Webhook" field, or `statusCallback`
on `<Dial>`) — it posts a JSON call-lifecycle event (initiated/ringing/answered/completed + duration +
who-hung-up) that fires even with no recording. Not needed for the answered-call capture MVP; add when a
tenant wants "log every call, including missed." Same follow-up bucket as `unlinked_call` auto-link.
Note: no new handler exists for this JSON shape — it would need its own webhook route + parser (distinct
from the form-encoded recording callback).

### Why this supersedes the June plan (the SignalWire delta)

The June plan assumed **Vapi**: one `end-of-call` webhook, native BYO-bucket write to Supabase, a
shared `VAPI_WEBHOOK_SECRET`. SignalWire is structurally different (verified against live docs
2026-08-04):

1. **Two webhooks, not one.** SignalWire's Compatibility API splits the flow:
   - **Voice webhook** ("when a call comes in", set on the phone number) — fires as the call starts,
     carries `From`/`To`/`CallSid`, and must **return cXML** telling SignalWire what to do (play
     consent, start recording, connect the call).
   - **RecordingStatusCallback** — fires later when the recording is `completed`, carries
     `RecordingSid`, `RecordingUrl`, `RecordingDuration`, `CallSid`, `RecordingChannels` — **but NOT
     `From`/`To`.** So caller-ID must be threaded from the first webhook into the callback URL.
2. **No native Supabase write.** SignalWire won't put audio in our bucket. The worker must **download
   the recording** (`RecordingUrl`, HTTP Basic `PROJECT_ID:API_TOKEN`) and **copy it into the
   `call-audio` bucket**, then hand AssemblyAI a **Supabase signed URL** (AssemblyAI can only fetch
   public/presigned URLs — the SignalWire media URL is auth-gated, so it can't fetch it directly).
3. **Signature = Twilio-compatible `validateRequest`** over header `X-SignalWire-Signature` (HMAC-SHA1
   of the full request URL + sorted POST params, keyed by `SIGNALWIRE_API_TOKEN`). There is **no**
   separate webhook secret — the API token is the key.

### Current codebase anchors (verified 2026-08-04)

- Inbound HTTP mount: `handle()` at `src/mcp/httpServer.ts:238`; `/inbound/` branch at `:241` (already
  catches `/inbound/phone*`, ahead of the IP allowlist at `:301`). Default port `MCP_HTTP_PORT` `:337`.
- Write-path: `RecordFieldNoteInput` `recordFieldNote.ts:34-52`; `extract()` `:153`; L2-skip early return
  `:173-175`; L1 append (before match) `:114`. Inbound callers write **L1-first, bypassing the
  stage→confirm gate** (that gate lives only in `src/mcp/server.ts`). `technicianRef` is required (`:36`).
- L1: `appendRawCapture` `src/db/rawCaptures.ts:33`, preserves SQLSTATE `23505` for dedup (`:64-69`).
- Identity: `matchIdentity` `identityMatch.ts:51`, unique-phone match `:62-66`.
- Model: extraction/classification run `runForcedTool` (`src/model/forcedTool.ts`), default GLM-5.2/DeepInfra
  — text-only, so unaffected by this feature.
- Review surface: `src/db/reviewItems.ts` + `list_pending_reviews`/`resolve_review` in `src/mcp/server.ts`.

### Decisions carried from the 2026-08-04 reconciliation (blocker 1 — closed)

- **Source `technician_ref` = the constant `'phone-line'`** (not a person; not the banned `connector:`
  prefix). Ship the bare string; add one seat-exempt `technicians` row per tenant ONLY if a read/audit
  path INNER-joins `technician_ref`→roster (audit `list_team`, briefing bylines, tier resolution first).
- **Subject via caller-ID** (`fallbackPhone` = `From`). Repeat callers auto-match.
- **New/unmatched callers → L1-only + a `review_items` `kind='unlinked_call'`** for the manager to
  link/create via `resolve_review` (the phone path is agentless — no live "which customer?"). Auto-create
  deferred.

### Decisions for this plan

1. **Call disposition = FORWARD TO A HUMAN (decided 2026-08-04).** After the consent `<Say>`, `<Dial>`
   connects the caller to the tenant's call-center line (`call_numbers.forward_to`, required in forward
   mode), recording **both legs** (`record="record-from-answer-dual"`). The call rings through to a real
   person; the recording is the spine capture. Voicemail-only is NOT the path. **v1 forwards to ONE
   number** (the call center's main line). Ring-groups / simultaneous-ring / press-1 queue routing are an
   explicit **follow-up** (same bucket as the already-deferred "AI receptionist + queue"): `<Dial>` can
   later take multiple `<Number>` nouns or a SIP/queue target without changing the capture path.

### Open decisions for this plan (flag before Phase 2)

1. **Threading From/To to the recording callback.** Bake them into the `recordingStatusCallback` URL
   query string in the cXML we return (`?tenant=&from=&to=`) — recommended, no DB round-trip — **vs** a
   REST lookup by `CallSid` in the callback. Recommend the query-string bake-in.
3. **DB workflow safety (standing).** All migrations/tests run on the **local** stack
   (`npx supabase db reset`/`migration up --include-all`, `.env.test`, `npm run gen:types:local`). Pilot
   DDL is applied by hand via the SQL editor. Never the hosted "test" project — it is the pilot's LIVE DB.

---

## Data flow (SignalWire)

```
Customer dials tenant's SignalWire number
   │
   ▼  [Webhook 1 — inbound voice]  POST /inbound/phone/voice
   │    validateRequest(X-SignalWire-Signature)  → 403 on fail
   │    To (dialed) → resolveTenantByNumber → tenant   (unknown → cXML <Reject>/<Hangup>)
   │    RETURN cXML:
   │      <Response>
   │        <Say>"This call is recorded."</Say>                    ← non-skippable consent, gates recording
   │        <Dial record="record-from-answer-dual"
   │              recordingStatusCallback="/inbound/phone/recording?tenant=T&from=FROM&to=TO"
   │              recordingStatusCallbackEvent="completed">FORWARD_TO</Dial>
   │      </Response>
   │
   ▼  (call connects + records)
   │  [Webhook 2 — recording completed]  POST /inbound/phone/recording?tenant&from&to
   │    validateRequest → parse RecordingSid, RecordingUrl, RecordingDuration, CallSid, RecordingStatus
   │    enqueueCall(call_ingest): externalId=RecordingSid, caller_phone=from, audio_ref=RecordingUrl(REMOTE),
   │                              consent_announced=true, status='pending'
   │    FAST ACK 200   (no download/STT on the thread)
   │
   ▼  [Worker]  processNextCall
   │    claim → download RecordingUrl (Basic PROJECT_ID:TOKEN) → copy bytes to Supabase call-audio bucket
   │          → audio_ref := storage path (remote→local transition)
   │    AssemblyAI transcribe (Supabase SIGNED URL, speaker_labels) → redactSensitive
   │    recordFieldNote({ channel:'phone_call', technician_ref:'phone-line', fallbackPhone:from,
   │                      blobPath:(retention? path : null), externalId:RecordingSid,
   │                      sourceMeta:{ recordingProvider:'signalwire', fromNumber:from, durationSec, consentAnnounced } })
   │    status != 'matched' → openUnlinkedCallRe view(...)
   │    markCallIngested(+ audioDeleteAfter)
   │
   ▼  [Purge cron]  delete Supabase audio past retention unless legal_hold
```

---

## Phase 1: Schema, storage bucket, DB layer

### What this phase does
Number↔tenant routing (+ optional forward-to), the `call_ingest` durable queue (queue + audio lifecycle +
consent log), a private Storage bucket, typed helpers. **No external vendors — local stack only.**
Self-contained; ship as its own PR.

### Changes required

**`supabase/migrations/20260804NNNNNN_phone_call_ingest.sql`** (new)
- `call_numbers (id uuid pk default gen_random_uuid(), tenant_id uuid not null references tenants(id), phone_number text not null, forward_to text, created_at timestamptz default now())` + `unique index uq_call_numbers_phone on call_numbers(phone_number)` (E.164; the dialed `To` resolves the tenant; `forward_to` = the tenant's real line for `<Dial>`, nullable = voicemail mode).
- `call_ingest (id uuid pk, tenant_id uuid not null references tenants(id), external_id text not null, caller_phone text, call_sid text, audio_ref text, status text not null default 'pending', match_status text, attempts int not null default 0, capture_id uuid references raw_captures(id), consent_announced boolean not null default false, occurred_at timestamptz, audio_delete_after timestamptz, legal_hold boolean not null default false, audio_deleted_at timestamptz, payload jsonb not null default '{}'::jsonb, last_error text, created_at timestamptz default now(), updated_at timestamptz default now())`.
  - `audio_ref` starts as the **remote** SignalWire `RecordingUrl`, rewritten to the Supabase object path after the worker copies it. `call_sid` kept for support/debug + optional REST re-lookup.
- `unique index uq_call_ingest_external on call_ingest(tenant_id, external_id)` (dedup on `RecordingSid`; insert-then-catch-23505).
- `index idx_call_ingest_status on call_ingest(status)`; `index idx_call_ingest_purge on call_ingest(audio_delete_after) where audio_deleted_at is null and not legal_hold` (**no `now()` in the predicate** — non-IMMUTABLE; the `< now()` filter lives in `listExpiredAudio`).
- Reuse the `set_updated_at` trigger (migration `20260620012321`) on `call_ingest`.
- **Atomic claim fn** (PostgREST can't express `FOR UPDATE SKIP LOCKED`):
  ```sql
  create function claim_next_call() returns call_ingest language sql as $$
    update call_ingest set status='processing', updated_at=now()
    where id = (select id from call_ingest where status='pending' and attempts < 5
                order by created_at for update skip locked limit 1)
    returning *; $$;
  ```
- **Storage bucket:** `insert into storage.buckets (id,name,public) values ('call-audio','call-audio',false) on conflict do nothing;` — if the migration role lacks INSERT on `storage.buckets`, create via local Studio/Storage API and keep the insert as a no-op.
- Comment: `call_ingest` is a normal mutable table (queue/lifecycle); the immutable evidence stays in `raw_captures`.
- **(Conditional) `'phone-line'` roster row** — add per-tenant seat-exempt `technicians` rows ONLY if the Phase-3 read-path audit finds an INNER join on `technician_ref` that would drop phone captures. Default: omit.

**`src/db/callNumbers.ts`** (new) — `resolveTenantByNumber(phoneNumber): Promise<{ tenantId: string; forwardTo: string | null } | null>`.

**`src/db/callIngest.ts`** (new) — row type + helpers: `enqueueCall(...)` (insert; 23505 → `{ id, deduped:true }`), `claimNextPendingCall()` (`rpc('claim_next_call')` — new `.rpc` pattern; type via generated `Functions['claim_next_call']['Returns']`), `markCallIngested(id,{captureId,matchStatus,audioDeleteAfter})`, `markCallError(id,msg)` (attempts++, back to `pending` while `<5` else `error`), `setAudioRef(id, storagePath)` (the remote→local rewrite), `listExpiredAudio()`, `markAudioDeleted(id)`, `setLegalHold(id,on)`.

**`src/db/index.ts`** — export both new modules.

**`.env.example`** — mirror the `.env` keys as blanks: `SIGNALWIRE_SPACE_URL=`, `SIGNALWIRE_PROJECT_ID=`, `SIGNALWIRE_API_TOKEN=` (🔒), `ASSEMBLYAI_API_KEY=` (🔒); add `CALL_AUDIO_BUCKET=call-audio`, `CALL_AUDIO_RETENTION_DAYS=30` (0 = transcript-only). **No `VAPI_*`.**

### Automated verification
- [x] `npx supabase db reset` (or `migration up --include-all`) replays cleanly on the **local** stack; `call_numbers` + `call_ingest` present — **DONE**
- [x] local `select id from storage.buckets where id='call-audio'` returns the row (else create via local Studio) — **DONE**
- [x] `npm run gen:types:local` overwrites `src/db/database.types.ts` with `call_ingest` + `claim_next_call` (NOT `npm run gen:types` — that's `--linked` → pilot) — **DONE**
- [x] `npm run typecheck` · `npm run lint` pass — **DONE**

### Live verification (agent-executable)
- Prerequisites: the **local** Supabase stack (never the hosted `supabase-test` project — it is the pilot's LIVE DB)
- [x] insert a `call_numbers` + a `call_ingest` row locally; confirm `uq_call_ingest_external` rejects a dup `(tenant_id, external_id)`; `select * from claim_next_call()` returns the row as `processing`; self-clean — **DONE live** (dedup + `claim_next_call`→processing verified; live recording-callback dedup replay also returned `duplicate`, no 2nd row)

### Manual verification
- [ ] (none)

---

## Phase 2: Two SignalWire webhooks — voice (cXML) + recording callback

### What this phase does
The inbound **voice** webhook (validates, resolves tenant, returns consent+record cXML) and the
**recording-completed** callback (validates, enqueues, fast-acks). No STT/write-path on either thread.

### Changes required

**`src/inbound/signalwire.ts`** (new)
- `validateSignalWireSignature(url, params, header, token)` — Twilio-compatible: HMAC-SHA1 over the full
  request URL + POST params sorted by key, base64, constant-time compare to `X-SignalWire-Signature`.
  **RESOLVED live 2026-08-06:** the documented Twilio scheme is correct. The one gotcha was query-string
  ORDER on the recording callback — SignalWire signs the callback URL verbatim but DELIVERS it with the
  query re-sorted alphabetically, so the received URL differed from the signed one → every recording
  callback 403'd. Fixed at the EMIT side (build the callback query already alphabetical: `from,tenant,to`);
  validation reconstruction (base + `req.url`) then matches. Locked by a round-trip regression test.
- `buildVoiceCxml({ forwardTo, callbackUrl })` — returns the cXML string: `<Say>` consent →
  `<Dial record="record-from-answer-dual" recordingStatusCallback callbackEvent="completed">forwardTo</Dial>`
  (voicemail `<Record>` variant when `forwardTo` is null).
- `parseRecordingCallback(params, query)` — `{ externalId: RecordingSid, recordingUrl, durationSec, callSid, status, tenantId: query.tenant, fromNumber: query.from, toNumber: query.to }`. Throws if `RecordingSid`/`RecordingStatus` absent; ignore non-`completed` statuses.

**`src/inbound/phoneWebhook.ts`** (new)
- `handleVoiceWebhook(url, rawBody, headers): { cxml }` — validate → parse `To` → `resolveTenantByNumber` (null → `<Reject>` cXML, logged) → `buildVoiceCxml` with the callback URL carrying `?tenant=&from=&to=`. Returns cXML (Content-Type `application/xml`).
- `handleRecordingWebhook(url, rawBody, headers, query): { status; callIngestId? }` — statuses `enqueued | duplicate | unknown_number | bad_signature | bad_payload | ignored_status | transient_error`. Validate → parse → `enqueueCall({ tenantId, externalId, callerPhone: from, callSid, audioRef: recordingUrl, consentAnnounced: true, occurredAt })` (dedup → `duplicate`; non-completed → `ignored_status`).

**`src/mcp/httpServer.ts`** — inside `handle()` (`:238`), **before** the generic `/inbound/` branch (`:241`):
```ts
if (req.url?.startsWith('/inbound/phone/voice'))     { await handlePhoneVoice(req, res); return; }
if (req.url?.startsWith('/inbound/phone/recording')) { await handlePhoneRecording(req, res); return; }
```
`handlePhoneVoice` returns 200 + `application/xml` (the cXML). `handlePhoneRecording` maps a
`PHONE_STATUS_CODES` set: `enqueued/duplicate/unknown_number/ignored_status → 200`, `bad_signature → 403`,
`bad_payload → 400`, `transient_error → 503`. Fast ack.

### Automated verification
- [x] `src/inbound/phoneWebhook.test.ts`: valid voice event → cXML contains `<Say>` before `<Dial record=...>` + the callback URL with tenant/from/to; unknown `To` → `<Reject>`; bad signature → `bad_signature`; valid recording event → `enqueued` (+ row in fake); redelivered `RecordingSid` → `duplicate`; `RecordingStatus!=completed` → `ignored_status`; malformed → `bad_payload` — **DONE** (52 inbound tests, incl. the query-order signature regression lock)
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass — **DONE**

### Live verification (agent-executable)
- Prerequisites: the local HTTP server + local Supabase stack. **SignalWire live-fire needs a provisioned number pointed at the deployed URL — declare and defer if unavailable** (per `verifying-behavior`).
- [x] POST a captured SignalWire voice sample to `/inbound/phone/voice`; assert the cXML shape. POST a recording-completed sample to `/inbound/phone/recording?...`; confirm 200 <~1s + one `pending` `call_ingest` row; self-clean — **DONE, exceeded** (real SignalWire events, not captured samples: voice→200+cXML, recording→200+enqueue)

### Manual verification
- [x] Point a test SignalWire number's voice webhook at the deployed `/inbound/phone/voice`; place one real call; confirm consent plays, the call connects (forward mode), and a recording callback lands (human-judged infra step) — **DONE LIVE 2026-08-06** (real call via ngrok tunnel + trial number; consent `<Say>` played, forwarded to a second line, recording callback landed → `call_ingest` row). Note: exposed the query-order signature bug (recording callback 403), fixed by emitting the callback query alphabetically.

---

## Phase 3: Async worker — fetch+copy, transcribe, redact, write-path

### What this phase does
Drains `call_ingest`: downloads the SignalWire recording, copies it to Supabase, transcribes (AssemblyAI
via a signed URL), redacts sensitive-auth data, runs `recordFieldNote`, and flags unmatched callers.

### Changes required

**`src/writePath/recordFieldNote.ts`** — add optional `fallbackPhone?: string | null` to
`RecordFieldNoteInput` (`:34-52`); immediately after `extract()` (`:153`, before `matchIdentity` `:163`):
`if (!extracted.phone && input.fallbackPhone) extracted.phone = input.fallbackPhone;`. Inert when unset.

**`src/db/reviewItems.ts`** — add `kind='unlinked_call'` + `openUnlinkedCallReview({ tenantId, captureId, callerPhone, snippet })` (idempotent per `captureId`). **`resolve_review` (`src/mcp/server.ts`) gains an `unlinked_call` branch** — resolve = link the parked capture to a chosen/created customer (stamp L2 `source_capture_id`), dismiss = spam/wrong-number (transcript stays L1, no L2).

**Read-path audit for `'phone-line'`** — grep paths turning `technician_ref` into a person (`list_team`, briefing bylines, `join technicians ... ref`, tier resolution). Any INNER join that drops/blanks → add the seat-exempt roster row in Phase 1; else ship the bare string.

**`src/calls/fetchRecording.ts`** (new) — `downloadAndStore({ recordingUrl, bucket, objectPath }): Promise<string>` — GET `recordingUrl` with HTTP Basic `PROJECT_ID:TOKEN`, stream into `client.storage.from(bucket).upload(objectPath, bytes)`, return the object path. (SignalWire media is auth-gated; AssemblyAI can't fetch it, so we copy first.)

**`src/calls/transcribe.ts`** (new) — `Transcriber` + `assemblyAiTranscriber`: submit `audio_url` = a Supabase **signed URL** (`createSignedUrl`, short TTL), poll with `speaker_labels:true`, return diarized text. Decoupled/re-runnable.

**`src/calls/redact.ts`** (new) — `redactSensitive(text)`: card (Luhn-ish 13–19), CVV-in-context, SSN (`\d{3}-\d{2}-\d{4}`) → `[CARD]`/`[SSN]`/`[BANK]`. Keep names/addresses/phones/job details. Tested incl. a 5-digit ZIP must NOT match.

**`src/calls/worker.ts`** (new) — `processNextCall(deps?): 'idle'|'ingested'|'error'`:
1. `claimNextPendingCall()`; null → `idle`.
2. `objectPath = 'audio/'+tenantId+'/'+externalId+'.wav'`; `downloadAndStore(...)` → `setAudioRef(id, objectPath)`.
3. `signed = createSignedUrl(objectPath, ttl)`; `transcribe(signed)` → `redactSensitive(...)`.
4. `retentionDays = Number(CALL_AUDIO_RETENTION_DAYS ?? 30)`; `recordFieldNote({ tenantId, technicianRef:'phone-line', channel:'phone_call', text:redacted, blobPath: retentionDays===0?null:objectPath, fallbackPhone: row.caller_phone, externalId, occurredAt, sourceMeta:{ fromNumber: row.caller_phone, durationSec, recordingProvider:'signalwire', consentAnnounced } })`.
5. `r.status !== 'matched'` → `openUnlinkedCallReview({ tenantId, captureId:r.captureId, callerPhone:row.caller_phone, snippet: redacted.slice(0,200) })`.
6. `markCallIngested(id,{ captureId:r.captureId, matchStatus:r.status, audioDeleteAfter: now + retentionDays*1d })` — any non-throwing `r.status` counts as `ingested` (L1 stored), mirroring email. Retention `0` → `audioDeleteAfter = now`.
7. throw → `markCallError`. Injectable deps `{ download, transcribe, recordFieldNote, signUrl, openUnlinkedCallReview }`.

**`src/calls/runWorker.ts`** (new) — loop `processNextCall` with backoff; `package.json` `"calls:worker"`.

### Automated verification
- [x] `src/calls/redact.test.ts`: card/SSN/CVV redacted; ZIP/phone/name/address preserved — **DONE**
- [x] `src/calls/worker.test.ts`: stubbed deps → `pending→ingested`, `capture_id`+`match_status` set, `audio_ref` rewritten to the object path, `audio_delete_after ≈ now+30d`; `retentionDays=0` → `blobPath` null but `audio_ref` set; `needs_confirmation` → `ingested` AND `openUnlinkedCallReview` called once; `matched` → NOT called; download/transcriber throw → `error` + attempts++ — **DONE**
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass — **DONE** (15 calls tests)

### Live verification (agent-executable)
- Prerequisites: `SIGNALWIRE_*` + `ASSEMBLYAI_API_KEY` + a sample recording + local stack + local bucket. Declare-and-defer if a live recording is unavailable.
- [x] seed a row whose `caller_phone` matches a test customer; `processNextCall`; read back the `raw_captures` row (channel `phone_call`, redacted `raw_text`, `blob_path` set, `technician_ref='phone-line'`) + the linked customer/job/visit. Separately an unknown `caller_phone` → L1 written + `match_status='needs_confirmation'` + one `unlinked_call` review item, no L2. Self-clean
  - **DONE — BOTH dispositions verified live end-to-end (2026-08-06):** **Matched:** seeded a customer with the caller's number, ran `processNextCall` on a real recording → protected-media download (REST token) → AssemblyAI STT → redact → `recordFieldNote` → `match_status='matched'`, L2 **job + visit created** (both `source_capture_id`→the capture), **no** `unlinked_call` review. **Unmatched:** an unknown caller → L1 only + `match_status='needs_disambiguation'` + one `unlinked_call` review, no L2. Real diarized transcript landed: `"Speaker A: Hi, my furnace is out. This is John at 5 PM."`

### Manual verification
- [x] spot-check one real diarized transcript for redaction quality (judgment)
  - **DONE (2026-08-06):** transcript `"Speaker A: Hi, my furnace is out. This is John at 5 PM."` — redaction correctly **kept** the name/issue/time (no card/CVV/SSN present → nothing scrubbed, `len 55→55`), matching the keys-only intent (scrub sensitive-auth data, preserve job details).

---

## Phase 4: Retention purge, legal hold, regulatory/ops setup

### What this phase does
The Supabase-Storage auto-delete SignalWire+Supabase won't do natively, litigation-hold-aware, plus the
ops/regulatory checklist.

### Changes required

**`src/calls/purgeAudio.ts`** (new) — `purgeExpiredAudio(deps?): { deleted:number }`: `listExpiredAudio()` → `client.storage.from(bucket).remove([row.audio_ref])` (object path from `call_ingest.audio_ref`, not L1 `blob_path`) → `markAudioDeleted(id)`. Skips `legal_hold`; idempotent (`audio_deleted_at`). `package.json` `"calls:purge"`. NOTE: Supabase Storage has no native object-expiry — this script IS the lifecycle.

**`docs/phone-call-runbook.md`** (new) — from research §D, SignalWire-specific:
- SignalWire number config: voice webhook → `/inbound/phone/voice`; the cXML plays a non-skippable "this call is recorded" `<Say>` before `<Dial record="record-from-answer-dual">`; consent logged via `consent_announced`.
- Retention schedule (audio = `CALL_AUDIO_RETENTION_DAYS`, transcript long-term); `setLegalHold(id,true)` to suspend purge.
- DPAs: Supabase, **SignalWire**, AssemblyAI; AssemblyAI no-train opt-out + DELETE.
- Controller/processor split: tenant = controller; SaaS = processor.
- Cron wiring for `calls:worker` + `calls:purge` (Render Cron / pg_cron).
- **Cost:** SignalWire (per-minute) + AssemblyAI (per-minute) = counter + bill-driven `infra_costs` (see the cost-ledger model); no dollar auto-collector; hand-enter monthly invoices; a per-tenant minute split needs a new allocation branch. Add a crossover check if spend can grow.

### Automated verification
- [x] `src/calls/purgeAudio.test.ts`: expired non-held → `remove` called + `audio_deleted_at` set; `legal_hold` → NOT removed; already-deleted → skipped — **DONE**
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass — **DONE**

### Live verification (agent-executable)
- Prerequisites: local stack + local bucket
- [x] seed an expired non-held row + a dummy object; `purgeExpiredAudio`; object gone + `audio_deleted_at` set; a `legal_hold` row survives; self-clean — **DONE (live-filter + unit):** the `listExpiredAudio` worklist filter was verified live against seeded rows (excludes `legal_hold` + already-`audio_deleted_at`, includes the expired non-held row); the object `.remove()` + `markAudioDeleted` half is covered by `purgeAudio.test.ts` (deterministic Storage call), not re-run live.

### Manual verification
- [ ] confirm `calls:worker` + `calls:purge` cron schedules are live in the deploy env (human-judged)
  - **DEFERRED:** needs the deploy (Render Cron / pg_cron) — not reachable from local.

---
*Pause after Phase 2 (Manual: place a real test call), Phase 3, and Phase 4 (non-empty Manual lists). Phase 1 continues automatically. Per CLAUDE.md this plan is the human-review gate — approve before `/implement`.*
