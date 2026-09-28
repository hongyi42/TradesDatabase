---
date: 2026-09-28
branch: main
commit: 217f1c8
topic: Step 2d — files (photos, PDFs, audio): how they enter, where they are stored, what they could attach to, who may see them
supersedes: nothing
---

# Step 2d research — files

Read at `217f1c8` (= `origin/main`). Operator scoping, 2026-09-28 (recorded here because it
bounds the research, not as a finding): 2d = a file store linked to L2 objects and to any ledger
entry; file bytes are deletable; technicians never see money files, and see photos on their own
jobs. Invoices and estimates as their own records, email attachments and record-on-send are step
2e, not this one.

## Summary

Today the system keeps almost no files. **Phone-call audio is the only file stored in the
database's world**: it is copied into a private Supabase Storage bucket (Supabase's built-in file
store, S3-like) called `call-audio`, pointed at from the call's permanent L1 record, and deleted
by a nightly purge after 30 days. **Everything else is transient or dropped**: a photo or voice
note a technician sends on Telegram is shown to the AI model and kept on the box for 7 days, then
deleted; documents (PDFs, files) sent to a bot are refused; email attachments are silently
dropped on the way in, and outbound email cannot carry one; files the manager's bot makes live
only in its E2B sandbox and leave only as a Telegram document to the manager. There is no files
table, no upload route from a seat to the spine, and no UI that shows a picture. What does exist:
the L1 column `raw_captures.blob_path` (a pointer slot, written only by the call worker), a
working private-bucket + signed-URL + purge pattern, a `technician_photo` capture channel nobody
writes, and a detailed technician-visibility rule (in SQL) that any new attachment would have to
pass through.

## Entry Points

- Telegram media into a seat: `src/seatGlue/inbound.ts:18-56` (classify), `src/seatGlue/seat.ts:328-358` (photo / voice handling).
- Call audio into storage: `src/calls/worker.ts:77-131` (`processNextCall`), process `calls:worker` (`package.json:15`).
- Audio purge: `src/calls/purgeAudio.ts:36-54`, cron `calls:purge` (`package.json:16`; Render `Calls-purge`, `0 4 * * *`, `docs/engineering-memory.md:3105`).
- Inbound email: `src/inbound/gmail.ts`, `src/inbound/gmailSent.ts` → `src/inbound/webhook.ts:447`.
- Outbound email: `send_email`, `src/mcp/tools/comms.ts:49-77`, `:200-409` → `src/composio/outbound.ts:44-56`.
- Manager files: `src/seatGlue/fileTools.ts:276-331` (`share_file`, `export_query`); Render `/seat/*` routes `src/mcp/httpServer.ts:1385-1408`.
- L1 pointer: `raw_captures.blob_path` (`supabase/migrations/20260620005307_context_spine.sql:100`), written via `appendRawCapture` (`src/db/rawCaptures.ts:21,73`).

## Key Files

| File | Role |
|---|---|
| `supabase/migrations/20260804120000_phone_call_ingest.sql` | `call_ingest` table (`audio_ref`, `audio_delete_after`, `legal_hold`, `audio_deleted_at`, `:35-49`); creates private bucket `call-audio` (`:97-99`; may no-op on some stacks, `:94-96`); RLS on (`:109-113`). |
| `src/calls/fetchRecording.ts` | `downloadAndStore` (SignalWire → bucket, `upsert:true`, `:12-31`); `signAudioUrl` (default TTL 3600 s, `:37-49`). |
| `src/calls/worker.ts` | object path `audio/<tenant_id>/<external_id>.wav` (`:84`); rewrites `audio_ref` (`:86`); passes `blobPath` into `recordFieldNote` (`:131`); retention `CALL_AUDIO_RETENTION_DAYS` default 30 (`:79`). |
| `src/calls/purgeAudio.ts` | deletes expired objects, stamps only `call_ingest.audio_deleted_at` (`:36-54`); `CALL_AUDIO_BUCKET` read again here (`:36`). |
| `src/db/callIngest.ts` | `listExpiredAudio` (all tenants, skips `legal_hold`, `:126-135`); `markAudioDeleted` (`:138-144`); `setLegalHold` (`:148-151`, no caller outside tests). |
| `src/db/client.ts` | one service-role Supabase client (bypasses RLS, server-side only, `:9-17`); storage reuses it. |
| `src/db/rawCaptures.ts` | `appendRawCapture` — the only low-level writer of `blob_path`. |
| `src/mcp/tools/captures.ts` | `record_field_note` accepts `blobPath` (any string, `:122`, `:380`); channel options incl. `technician_photo` (`:123`). |
| `src/seatGlue/telegram.ts` | message types (`:41-50`); `download` ≤ 20 MB (`:12`, `:207-218`); `sendDocument` ≤ 50 MB (`:84-89`, `:186-201`). |
| `src/seatGlue/inbound.ts` | photo → largest size (`:45-48`); voice (`:51-53`); everything else `unsupported` (`:55`). |
| `src/seatGlue/media.ts` | `saveMedia` → `<stateDir>/media/<YYYY-MM-DD>/<uuid>.<ext>` 0600 (`:12-19`); `sweepMedia` (`:22-51`); the path guard comment (`:8-11`). |
| `src/seatGlue/voice.ts` | voice → OpenRouter chat/completions, Gemini (`:8`, `:35-70`). |
| `src/seatGlue/doctrine.ts` | "Never set `blobPath` … photos and voice notes are not stored in the permanent record yet" (`:30-31`, `:150-151`). |
| `src/seatGlue/fileTools.ts`, `sandbox.ts` | manager E2B sandbox, `/home/user/files` (`sandbox.ts:25`); `share_file` → Telegram (`fileTools.ts:276-296`); `export_query` → `/seat/export` (`:297-331`). |
| `src/mcp/httpServer.ts` | `/seat/*` routes — JSON text only, no binary route (`:419-476`, `:604`, `:655-656`, `:1385-1408`). |
| `src/inbound/gmail.ts`, `gmailSent.ts`, `normalize.ts` | `attachment_list` dropped (`gmail.ts:17`; not read in `gmailSent.ts:22,25-36`); envelope `blobRef` (`normalize.ts:13`) never set. |
| `src/composio/outbound.ts` | `GMAIL_SEND_EMAIL` with `{recipient_email, subject, body}` only (`:44-56`). |
| `supabase/migrations/20260815160000_money_events.sql` + `src/db/moneyEvents.ts` | the ledger: `bigint` id, `job_id` RESTRICT, append-only, `detail jsonb`. |
| `supabase/migrations/20260917120000_technician_view.sql` (+ `20260919120000_person_wide_money_grant.sql`) | `technician_view_of`, `capture_visible`, `view_money_open`, `access_grants`. |
| `supabase/migrations/20260916120000_retrieval_layer_core.sql` | `capture_membership` (9 arms, `:53-95`), `capture_is_live` (`:103-115`), `capture_scope_members` (`:151-170`). |

## Data Flows

### Today's file paths

```
 PHONE (Telegram)                                          ^ sendDocument ≤50 MB (manager's own chat)
   | photo / voice ≤20 MB; documents REFUSED              |
   v                                                       |
 [BOX: seat glue] ─ download ─> bytes                      |
   ├─ saveMedia → box disk, swept after 7 days             |
   ├─ photo: base64 → Copilot engine → model (vision)      |
   ├─ voice: → OpenRouter Gemini → text → model            |
   └─ transcript: caption / "(photo)" / "[voice note] …" (text only; manager turns not stored)
                                                           |
 [E2B sandbox, manager only] /home/user/files ── share_file┘
        ^ export_query: Render POST /seat/export (JSON/CSV text)

 [RENDER spine] record_field_note(text, blobPath?) → raw_captures.blob_path   (prompt: never set)

 EMAIL in:  Composio Gmail trigger → /inbound → normalizer (attachment_list DROPPED) → L1 text
 EMAIL out: send_email (stage → confirm) → Composio GMAIL_SEND_EMAIL {to, subject, body} → L1 text

 PHONE CALL: SignalWire recording → worker → Supabase Storage call-audio/audio/<tenant>/<id>.wav
             → signed URL (1 h) → AssemblyAI → transcript → recordFieldNote(blobPath = object path)
             → nightly purge after 30 d: object deleted, call_ingest.audio_deleted_at stamped,
               raw_captures.blob_path left pointing at the deleted object
```

### The one stored-file flow, step by step (call audio)

1. `processNextCall` claims a `call_ingest` row; `downloadAndStore` fetches from SignalWire (Basic auth) and uploads with the service-role client to `audio/<tenant_id>/<external_id>.wav` (`worker.ts:77-86`, `fetchRecording.ts:12-31`).
2. `setAudioRef` rewrites `call_ingest.audio_ref` from the remote URL to the object path (`callIngest.ts:115-121`).
3. `signAudioUrl(bucket, path)` makes a 1-hour signed URL for AssemblyAI only (`worker.ts:89-90`). No signed URL reaches a person or a model anywhere.
4. `recordFieldNote({..., blobPath: retentionDays === 0 ? null : objectPath})` writes the L1 capture (`worker.ts:131`).
5. `markCallIngested` stamps `audio_delete_after = now + retentionDays` (`worker.ts:204-209`). With retention 0 the audio is still uploaded (transcription needs it) and purged next run.
6. `calls:purge`: `listExpiredAudio` (expired, not on legal hold, not yet deleted) → `storage.remove([audio_ref])` → `markAudioDeleted` (`purgeAudio.ts:39-54`). `raw_captures` is not touched — the append-only trigger forbids it.

### What a file could attach to (link targets)

```
customers (uuid) ─(1:N, cascade)─ jobs (uuid) ─(1:N, cascade)─ visits (uuid) ─ visit_participants (crew)
                                    │
                                    └─(1:N, RESTRICT)─ money_events (bigint, append-only, no customer/visit column)
raw_captures (uuid, append-only) ── stamps customer_id / job_id / visit_id (set null → refused → "L1 pins L2")
link tables (visit_notes, job_captures, customer_captures): cascade from L2, refuse UPDATE only
```

- L2 keys: `uuid` + `tenant_id`, no cascade from tenant (`context_spine.sql:42-72`; visits = renamed `assignments`, `scheduling_foundation.sql:55-73`, `the_visit_is_one_object.sql:47-50`).
- Deleting a customer/job/visit that any capture is stamped with fails: Postgres runs `on delete set null` as an UPDATE, which the append-only trigger refuses (`context_spine.sql:95-97,117-119`; mechanism stated `the_visit_is_one_object.sql:16-19`).
- The link tables escape the pin: they cascade from the L2 row and refuse only UPDATE (`the_visit_is_one_object.sql:114-134`; `20260908100000_inbound_asks_and_job_captures.sql:57-75`; `20260912100000_customer_captures.sql:29-49`).
- `money_events`: `id bigint generated always as identity`; `job_id not null … on delete restrict`; `source_capture_id → raw_captures`; `corrects_event_id → money_events`; `detail jsonb`; append-only trigger; RLS on, grants revoked (`money_events.sql:27-59,95-97`). 13 kinds (12 + `material_cost`, `20260819120000_material_cost_kind.sql:27`; `MONEY_EVENT_KINDS`, `moneyEvents.ts:11-29`). Written only by `record_money_event`, manager-only (`money.ts:30-111,207-213`; `server.ts:634,712-714`).
- Estimates and invoices are single rows (one amount each; `external_ref` for an invoice/check number, `money.ts:83-86`). No line-item structure exists anywhere (0 hits for `line_item` / `lineItem`). The draft `thoughts/shared/plans/2026-08-15-invoice-creation-v1.md` (line items, `INV-1001`, PDF on the Gmail send) is `draft`, `drift 87`, "describes 3 deleted files" (`thoughts/INDEX.md:219`).
- `detail` holds `{note?, progress?}` (`money.ts:142-145`); only `progress` is read (`isProgress`, `moneyEvents.ts:429-431`); `note` is never surfaced.

### How "things on a job" are listed (the pattern an attachment list would sit beside)

`capture_membership` unions nine arms (three stamps, three `source_capture_id` parents, three link tables), tenant re-checked each hop (`retrieval_layer_core.sql:53-95`); `capture_scope_members` groups them per capture for scope `job` / `customer` / `customer_level` (`:140-170`) — there is no visit scope. The readers `customer_contents`, `captures_page`, `capture_full`, `search_captures` (`technician_view.sql:498-920`) filter `capture_is_live(...) AND capture_visible(..., view)` and are called over RPC from `src/db/context.ts:221-290,531-545`. `capture_full` and `v_captures` deliberately omit `blob_path` (`retrieval_layer_core.sql:428-429`; `20260823120000_planner_read_surface.sql:16`).

### Who may see what (technician view)

`technician_view_of` (`technician_view.sql:200-337`, re-created with a person-wide money grant in `20260919120000_person_wide_money_grant.sql:63+,116-130`), fetched once into Sets by `getTechnicianView` (`src/db/technicianView.ts:83-104`):

1. Her trips: `visit_participants` rows for her on non-cancelled visits not minted by a technician-channel capture (`:265-274`).
2. Her own jobs (any status); served customers = customers of those jobs that are non-terminal.
3. Jobs in view by the firm's `technician_view_rules.job_scope` (default `serving`, `:256`): `own_trips` | `serving` (own + served customers' non-terminal jobs) | `serving_history` (+ all their jobs) | `whole_firm` (`all_scope`).
4. Live `access_grants` add a job or a customer's jobs (`:296-327`); grants open `record` or `record_and_notes`, optionally `opens_money`, may expire; revoke-only ledger (`:91-156`).
5. Visibility is job-level: no per-visit rule; she sees other crews' trips on an in-view job (`context.ts:241-242`).
6. Captures: `capture_visible = capture_in_scope ∧ capture_content_open` (`:377-453`); content open needs a channel in the firm's list (default `technician_voice`, `technician_note`, `technician_photo`, `:233-236`), not `manager_only`, no hidden tag — or a `record_and_notes` grant.
7. Money: `view_money_open` = firm `money='amounts'` or a money grant (`:355-363`); TS twin `viewShowsMoney` (`technicianView.ts:73-79`); `technicianMoneyView` returns status words unless open (`moneyEvents.ts:619-674`); `withoutPrice` strips `jobs.price_cents` (`customers.ts:368-375`).
8. Tier: `spine:` ref → planner; active manager → manager; otherwise technician (`shared.ts:60-65`).
9. The web board uses a different, visit-participant rule for technicians (`src/telegram/boardApi.ts:290-316`); some endpoints are manager-only (`:335-336`). No UI renders media anywhere (`web/board`, `web/console`, `web/admin`, `src/console/consoleApi.ts`, `src/schedule/boardRead.ts`).

### Retraction and money

`retract_capture` (two-step, author or manager, audit channels manager-only; `captures.ts:212-245,820-1033`) appends a `retraction` row that copies the target's stamps and follows it onto every link row (`:944-986`). Reads then drop the capture, facts/correspondence citing it, and visits it minted (`context.ts:255-263`; `technician_view.sql:564-567`). Money entries recorded from a retracted capture keep counting and are only reported as `moneyLosingEvidence` (`src/db/foldImpact.ts:55-77,155-163`).

## External Dependencies

- **Supabase Storage** (private bucket, service-role client, `createSignedUrl`, `remove`). Local stack `[storage]`: enabled, `file_size_limit = "50MiB"`, no buckets declared in config, S3 protocol enabled, image transformation commented out (Pro plan) — `origin/main:supabase/config.toml:122-136`.
- **Telegram Bot API**: `getFile` + file download (glue caps at 20 MB), `sendDocument` (glue caps at 50 MB).
- **SignalWire** (recordings), **AssemblyAI** (transcription via signed URL).
- **OpenRouter** (photo to the model via the engine; voice transcription via Gemini).
- **Composio** Gmail triggers (inbound, `attachment_list` present but dropped) and `GMAIL_SEND_EMAIL` (outbound, called without attachments).
- **E2B** sandbox (manager files; no internet).

## Constraints and Invariants

- **L1 is append-only** (trigger). A pointer written into `raw_captures.blob_path` can never be changed or cleared; after a purge it names a deleted object. Today the only marker of deletion is `call_ingest.audio_deleted_at`, joined through `call_ingest.capture_id`.
- **The seat path guard** (`media.ts:8-11`, `seat.ts:60`): a box path must never reach the model or `blob_path`. Enforced by `seat.ts` never using `saveMedia`'s return value, and by the doctrine line — not by the spine: `record_field_note` accepts any `blobPath` string, with no bucket, tenant-prefix or existence check (`captures.ts:122,380`; `server.ts:606-607`), and `blobPath` is part of the note's idempotency hash (`shared.ts:199,214`).
- **L1 pins L2**: a stamped capture makes its customer/job/visit undeletable; `money_events` RESTRICT makes a job with any ledger row undeletable.
- **Access control for storage is bucket-private + service-role only**: no `storage.objects` policies exist in any migration.
- **Every table created since the RLS sweep enables RLS itself** (28 migrations); `auto_expose_new_tables = true` goes away 2026-10-30 — new tables stop being auto-granted, existing grants unaffected (`docs/engineering-memory.md:2974-2976`, `4020-4023`; `20260824120000_rls_denyall_business_tables.sql:21-26,59-71`). Whether that sweep is applied to the pilot is not confirmed (`docs/prod-migration-checklist.md:31-41` unticked).
- **Retention is per process**, from env (`CALL_AUDIO_RETENTION_DAYS`, `MEDIA_RETENTION_DAYS`), not per tenant; `CALL_AUDIO_BUCKET` is read independently in two files.
- **Size ceilings in play**: Telegram in 20 MB / out 50 MB (glue caps); local storage 50 MiB; relay 16 MB (`relayHandler.ts:171-173`); `read_file` 256 KiB text only; `/seat/export` request body read uncapped (`httpServer.ts:447`).
- **Transcripts hold no bytes** (`transcript.ts:14`; `20260924130000_seat_turns.sql:12-13`); manager conversations are not stored at all (`httpServer.ts:490,765-770`).

## Decision Points

1. **Where the file record lives.** (a) Reuse `raw_captures.blob_path`: a file is an L1 capture (e.g. channel `technician_photo`) whose pointer names the object — it inherits capture membership, retraction and the technician capture rule, but the pointer can never change and L1 pins the L2 row. (b) A new `files` table (tenant, storage path, kind, uploader, deleted-at) with link rows — deletable metadata, its own visibility rule, and it can point at a `money_events` row, which captures cannot today.
2. **How a file links to many kinds of object.** Link targets have different id types (uuid for customers/jobs/visits/captures, `bigint` for `money_events`, and 2e's future invoice/estimate records). Options: one link table with a nullable FK per target type; a polymorphic `(target_kind, target_id text)` pair (no FK integrity); or per-target link tables like the existing `visit_notes` / `job_captures` / `customer_captures` (which cascade from L2 and so escape the pin).
3. **What "deletable" means.** The call-audio precedent deletes the object and stamps a separate row, leaving any L1 pointer dangling. A file record outside L1 can be stamped deleted (or removed) along with the object; a pointer inside L1 cannot.
4. **Who may see a file.** Options map onto existing machinery: route photos through `capture_visible` (job-level, channel list, grants); give files their own rule keyed on the linked object; and for money-linked files reuse `view_money_open` / `viewShowsMoney`. The chat (job-level) and board (visit-participant) technician rules already differ, so which one a file follows is a choice.
5. **How bytes reach storage from a seat.** No `/seat/*` route carries binary today. Options: the glue uploads Telegram bytes to Render (a new binary route under the seat token), or Render issues a signed upload URL to the glue; the manager sandbox has no internet, so sandbox files would go sandbox → glue → Render.
6. **What happens to technician Telegram photos.** Today: model + 7-day box copy. A file store makes "keep it and link it to the job/visit" possible; the doctrine's "never set blobPath" line and the box sweep are the two things that currently stop it.
7. **Documents and email attachments.** Documents sent to a bot are refused (`inbound.ts:55`); inbound `attachment_list` is dropped (`gmail.ts:17`). Accepting either is a separate switch from building the store.
8. **Per-tenant retention / legal hold.** Today one env value per process and an unused `setLegalHold`.

## Open Questions

- Supabase Storage limits and pricing on the pilot's hosted plan (max object size, signed-URL options, whether image transformation is available) — verify against current Supabase docs before planning.
- Telegram Bot API current limits for `getFile` downloads and `sendDocument` uploads — verify against current Telegram docs (the glue's 20/50 MB caps are the repo's assumptions).
- Composio `GMAIL_SEND_EMAIL` attachment parameter and inbound `attachment_list` shape (2e, but it decides whether attachments come from Storage by URL or by bytes) — verify in Composio's current tool schema.
- Whether any openclaw-era capture on the pilot carries a non-null `blob_path` other than call audio (openclaw seats had no rule against it; not checked against pilot data).
- Whether `20260824120000_rls_denyall_business_tables.sql` is applied on the pilot.
- Whether the `call-audio` bucket exists on the pilot as created by migration or by hand (the insert can no-op).
