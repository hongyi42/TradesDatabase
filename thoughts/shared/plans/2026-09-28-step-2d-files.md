---
date: 2026-09-28
task: Step 2d — a file store: photos and documents kept, linked to customers/jobs/visits/ledger entries, deletable, seen per the technician view
research: thoughts/shared/research/2026-09-28-step-2d-files.md
status: complete
supersedes: nothing
---

## Overview

Today only call audio is stored; a photo sent to a seat lives 7 days on the box, a document is
refused, and a file the manager's bot makes never reaches the database (research §Summary). 2d
adds one private file store behind the spine: every photo and document sent to any seat is kept,
the bot links it to the customer, job, visit or ledger entry it belongs to, a seat can send a
stored file back to its person, the manager's bot can save a sandbox file into the store (and
open one back into the sandbox), and a file can be deleted. Invoices/estimates as records, email
attachments out, and record-on-send are 2e; inbound email attachments are a later step.

## Decisions

Operator, 2026-09-28:
- **Keep every photo** sent to a seat, the moment it arrives; the bot links it when it knows
  where it belongs and asks when unsure. (Alternative: only what the bot files — rejected.)
- **Documents are accepted** (PDF, a photo sent "as a file", any file ≤ 20 MB), stored like photos.
- **Files the bot makes are stored and linked too.** 2d builds the general `save_file`
  (sandbox → store, with links); linking an invoice PDF to an invoice record waits for 2e.
- **Retention: kept until someone deletes.** No auto-delete (cost measured below is not a
  reason: $0.0213/GB-month storage, $0.09/GB egress, Pro includes 100 GB / 250 GB —
  https://supabase.com/docs/guides/platform/manage-your-usage/storage-size, …/egress).
- **Email attachments: a later step of their own** (inbound stays dropped in 2d).
- Earlier rulings (memory `files-and-money-records`): invoices + estimates become their own
  records (2e); files link to L2 AND any ledger entry; photo/PDF bytes are deletable;
  technicians never see money files, and see photos on their own jobs.
- **"Her jobs" = her existing view** (operator 2026-09-28, asked after the plan was written): a
  technician's files follow the same job-level view as her notes — under the default `serving`
  scope that includes other open jobs of customers she serves, plus grants; a firm wanting it
  tighter uses `own_trips`. (Alternative: strictly jobs she has a trip on — rejected: photos would
  follow a different rule from notes and grants would not open them.)

Mine (implementation):
- **A new `files` table, not L1** (research Decision 1). L1 cannot be deleted or re-pointed and
  cannot reference a `bigint` ledger id; `blob_path` stays unused for seat media, and the
  doctrine keeps "never set blobPath".
- **One `file_links` table with one nullable FK column per target** (`customer_id`, `job_id`,
  `visit_id`, `money_event_id`) and a check that exactly one is set (research Decision 2): FK
  integrity per target, `on delete cascade` from L2 so links never pin a customer (the
  `job_captures` precedent), and 2e adds `invoice_id` / `estimate_id` columns the same way.
- **Delete = stamp the row, then remove the object** (`deleted_at`, `deleted_by_ref`; a failed
  remove leaves hidden orphan bytes, never a visible row with no bytes); the row and
  its links stay for the audit trail and every reader filters `deleted_at is null`. Who may
  delete: the uploader or an active manager (the `retract_capture` rule). One step, no confirm:
  deletion is what the person asked for, and nothing else depends on the bytes.
- **Visibility is checked in TypeScript with the existing view** (`getTechnicianView`,
  `viewHasJob`, `viewHasCustomer`, `viewShowsMoney`): manager/planner see all; a technician sees
  a live file she uploaded, or one with at least one link she may see — customer in view; job in
  view; visit whose job is in view; ledger entry whose job is in view AND `viewShowsMoney` — and a
  file on a ledger entry whose money is closed to her stays hidden even if it also hangs on a job
  she can see (phase 1 review); her own upload stays hers either way. An
  unlinked file is her own or nobody's (managers aside). Job-level, like the chat rule (the board's
  visit rule is not used). A file outside her view reads as NOT FOUND, never "forbidden".
- **Bytes go glue → Render → Storage** over two new seat-token routes; Render is the only
  holder of the service key (research Decision 5). Cap **20 MB** per file (Telegram's download
  limit, "bots can download files of up to 20MB", https://core.telegram.org/bots/api#getfile;
  under Supabase Free's 50 MB). A sandbox file over 20 MB is refused in words.
- **Bucket `files`, private, path `<tenant_id>/<file_id>`**; the original name lives in the row.
- **The glue tells the model a file's id in the message**: `[photo saved as file <id>]` /
  `[document "<name>" saved as file <id>]`; a failed save says `[photo could not be saved]` and
  never blocks the reply. The 7-day box copy is left as it is.
- **Known limits (phase 3 review):** updates are handled one at a time, so a Stop behind a 20 MB
  document can wait up to ~2 min (60 s Telegram download + 60 s upload, and a retry doubles the
  upload's share); nothing waits forever. A save is retried ONCE (Render may be waking from its
  free-plan sleep); a photo that still fails is not kept — the model is told, and there is no later
  retry. Stored Telegram photos are all named `photo.jpg`; `open_file` prefixes the id so two never
  collide.
- **Discovery is a tool, not a context change**: `list_files` (by target); get_job /
  get_customer_context are not touched in 2d.

## Plain-language walkthrough

```
phone ─photo/PDF─► seat glue (box) ──POST /seat/files──► spine (Render) ──► Supabase Storage "files"
                        │  tells the bot "saved as file F"        │ files row + who uploaded
                        ▼                                         ▼
                 bot: link_file(F, job) ───────────────► file_links row (job / visit / customer / ledger)
later: "send me the Lee before photos"
       bot: list_files(job) → send_file(F) ──GET /seat/files/F──► spine checks she may see it ─► bytes ─► phone
manager's bot: save_file(sandbox path, links)  /  open_file(F) → into the sandbox
```

**Phase 1 — the store.** A new database table records each file (whose firm, who sent it, name,
type, size, deleted or not) and a second table records what it is attached to. The bytes go in a
private Supabase Storage bucket (Supabase's built-in file store). A small typed layer does
save / link / list / fetch / delete and decides who may see what. You'd notice it only in tests.

**Phase 2 — the spine's doors.** Two web routes let a bot upload a file and download one it may
see, using the bot's existing login. Three tools let the AI list files on a job (or visit,
customer, ledger entry), attach a file, and delete one. A technician asking for a file outside
her jobs gets "not found".

**Phase 3 — the bots.** Every photo and document sent to any bot is saved on arrival, and the bot
is told its file id so it can attach it ("which job is this for?" if unsure). Every bot gets a
`send_file` tool to send a stored file back to the phone. The manager's bot gets `save_file` (put
a sandbox file in the store, attached) and `open_file` (bring a stored file into the sandbox).

**Phase 4 — live.** Migration on the pilot (run by you), deploy Render, install the glue on s2 and
s5, then a phone test: send a photo, attach it, ask for it back, delete it.

## Secrets & env preflight

- **Phase 1–2:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — already required (Render + `.env.test`).
- **Phase 3:** none new (the glue's `SEAT_TOKEN`, `SPINE_MCP_URL`, `E2B_API_KEY` — already required).
- **Phase 4:** none; the pilot bucket is created by the migration or by hand (see Phase 4).

## Phase 1: the store

### Changes required

**`supabase/migrations/20260928120000_files.sql`** (new)
- `create table files (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), kind text not null check (kind in ('photo','document')), file_name text not null, mime_type text not null, size_bytes integer not null check (size_bytes > 0 and size_bytes <= 20971520), storage_path text not null unique, uploaded_by_ref text not null, uploaded_by uuid references technicians(id) on delete set null, source text not null check (source in ('telegram','sandbox')), created_at timestamptz not null default now(), deleted_at timestamptz, deleted_by_ref text)`; index `(tenant_id, created_at desc)`.
- `create table file_links (id bigint generated always as identity primary key, tenant_id uuid not null references tenants(id), file_id uuid not null references files(id) on delete cascade, customer_id uuid references customers(id) on delete cascade, job_id uuid references jobs(id) on delete cascade, visit_id uuid references visits(id) on delete cascade, money_event_id bigint references money_events(id), linked_by_ref text not null, created_at timestamptz not null default now(), check (num_nonnulls(customer_id, job_id, visit_id, money_event_id) = 1))`; unique partial indexes per target `(file_id, <target>) where <target> is not null`; indexes on each target column.
- `alter table … enable row level security; revoke all on … from anon, authenticated;` for both (the `seat_memory` pattern, `20260924140000_seat_memory.sql:55-58`).
- `insert into storage.buckets (id, name, public) values ('files','files',false) on conflict (id) do nothing;` with the call-audio comment: may no-op on some stacks — verify (Phase 4).

**`src/db/database.types.ts`** — regenerate with `npm run gen:types:local` (never `gen:types`: it targets the pilot).

**`src/storage/fileStore.ts`** (new) — the only Storage caller for files, service-role client (`src/db/client.ts`):
`FILES_BUCKET = process.env.FILES_BUCKET ?? 'files'`; `putObject(path, bytes, mimeType)` (`upsert: false`); `getObject(path): Promise<Buffer>`; `removeObject(path)`.

**`src/db/files.ts`** (new) — typed layer, re-exported from `src/db/index.js` (httpServer.test mocks that module, `httpServer.test.ts:14`), so route tests never touch Storage:
- `type FileTarget = { customerId } | { jobId } | { visitId } | { moneyEventId: number }`.
- `createFile(input: {tenantId, kind, fileName, mimeType, bytes: Buffer, uploadedByRef, uploadedBy: string|null, source}) → FileRow` — id first, object put at `<tenantId>/<id>`, then the row; if the insert fails, remove the object (best effort).
- `linkFile(tenantId, fileId, target, linkedByRef)` — loads the target, refuses a target in another tenant ("not found"), a deleted file, or an unknown money event; a duplicate link returns the existing one (insert, catch 23505, re-select — PostgREST `upsert` cannot target a partial unique index).
- `listFiles(tenantId, target) → FileRow[]` (live only, newest first) and `getFile(tenantId, id) → FileRow | null`, `linksOf(tenantId, fileId)`.
- `readFileBytes(row) → Buffer`; `deleteFile(tenantId, id, byRef)` — stamp first, then `removeObject` (a failed remove is logged, not an error); an already-deleted file answers `already deleted`.
- `fileVisibleTo(file, links, who: {tier, ref, view: TechnicianView | null}) → boolean` — the rule in Decisions; visit links resolve their job with one query; money links resolve `money_events.job_id` and the job's `customer_id` for `viewShowsMoney`.

**`src/db/files.test.ts`** (new, local stack — the FIRST test to touch real Supabase Storage; the local stack runs Storage, `config.toml [storage]`, kept by `second-stack.sh:101`) — create → get → bytes round-trip; tenant guard on link and get; `num_nonnulls` check; duplicate link; delete removes the object and hides the row from `listFiles`/`getFile`; deleting a job cascades its links but not the file; visibility table: manager, uploader, job-in-view, job-out-of-view, visit→job, customer, money link with and without `viewShowsMoney`, unlinked file of someone else.

### Automated verification
- [x] `npx supabase migration up` (local) applies; `select id, public from storage.buckets where id='files'` on the local stack returns one private row; `npm run gen:types:local`
      — applied; `[ { id: 'files', public: false } ]`; types added only `files` + `file_links`.
- [x] `npm run typecheck`, `npm run lint`, `npm test`
      — 3917 passed (phase 1 commit 6e0451a; review fixes 975d3b1).
- [x] `files.test.ts` passes, including the object really gone from the bucket after delete (read-back through Storage, not the row)
      — 12 passed: `objectExists` true before, false after, and `storage.download` errors after delete.

## Phase 2: the spine's doors

### Changes required

**`src/mcp/httpServer.ts`**
- `readBinaryBody(req, maxBytes): Promise<Buffer>` beside `readRawBody` (`:75`), same cap/abort idiom.
- `POST /seat/files?kind=photo|document&name=<urlencoded>` — body = raw bytes, `content-type` = mime. Identity via `seatOfRequest` (`:497-506`): 401 unknown token, **403 inactive person** (`resolveIdentity` alone checks only `retired_at`, `db/seats.ts:45-58`); it yields `person.id` (→ `uploaded_by`, `getTechnicianView`) and `person.tier`; 413 over 20 MB; 400 bad kind/empty name/empty body; `source` = `sandbox` when header `x-file-source: sandbox`, else `telegram`. Answers `{id, fileName, sizeBytes}`.
- `GET /seat/files/<uuid>` — resolve identity, `getFile`, `linksOf`, `fileVisibleTo`; not visible or deleted → 404; else 200 with the bytes, `content-type`, `x-file-name` (URL-encoded), `cache-control: no-store`.
- Route both before `allowed()` beside `/seat/export` (`:1389`), matching on `new URL(req.url, 'http://internal').pathname` (as `:232` does) — `req.url ===` would miss the query string; the GET matches `^/seat/files/[0-9a-f-]{36}$`.
- Visibility from `seatOfRequest`'s person: manager → all; else `getTechnicianView(tenantId, person.id)`.

**`src/mcp/tools/files.ts`** (new domain module, `base` tier — every badge; each handler applies the view itself):
- `list_files {customerId|jobId|visitId|moneyEventId}` → `{files:[{id, kind, fileName, mimeType, sizeBytes, uploadedBy, createdAt}]}` filtered by `fileVisibleTo`; a target outside a technician's view → `outsideView` message (`shared.ts` pattern); a `moneyEventId` target from a technician without money open → not found.
- `link_file {fileId, customerId|jobId|visitId|moneyEventId}` → `{status:'linked'}`; the caller must see the file AND the target (technician: target in view; money targets manager-only).
- `delete_file {fileId}` → uploader or active manager; `{status:'deleted'}`.
- Descriptions say: a photo or document the person sent arrives with its file id; attach it where it belongs; ask which job/visit when unsure; `send_file` (a seat tool) sends one back.

**`src/mcp/server.ts`** — import `filesTools`, spread into `TOOLS` and the handler map (the `moneyTools` pattern, `:340`, `:582`).
**`src/mcp/tools/surface.expected.ts`** — add the three names to `TECHNICIAN_TOOLS` (flows into the manager list).
**`src/eval/toolCases.ts`** — a tier-1 case each for `list_files`, `link_file`, `delete_file` (`toolCases.test.ts:67-71` requires every spine tool touched); seed the file with `createFile` in the case setup.

**Tests** — `src/mcp/server.test.ts` new `describe('files (step 2d)')`: tool tiers + visibility cases through `call`; `src/mcp/httpServer.test.ts`: upload (401/400/413/200) and download (404 outside view / deleted, 200 bytes + headers), round-trip bytes identical.

### Automated verification
- [x] typecheck, lint, `npm test`; the new suites pass
      — 3926 passed (52faf9c); review fixes 17f28b0 (a real 413, active-manager downloads, malformed ids, ownership by roster row).
- [x] against the local spine (`MCP_HTTP_PORT` + a minted seat token): `curl --data-binary @photo.jpg` → id; `curl GET` → identical bytes (`cmp`)
      — 300 KB random bytes up → id → GET 200 → `cmp` BYTES IDENTICAL.

## Phase 3: the bots

### Changes required

**`src/seatGlue/telegram.ts`** — `TgMessage.document?: {file_id, file_name?, mime_type?, file_size?}`; `sendPhoto(chatId, bytes, caption?)` (multipart, like `sendDocument` `:186-201`) on `TelegramApi`, implemented also in `ScriptedTelegram` (`drive.ts:41`, recording bytes like `documents`) and `FakeTelegram` (`seat.test.ts:61`) — else typecheck fails.
**`src/seatGlue/inbound.ts`** — new kind `{kind:'document', fileId, fileName, mimeType, size, caption?}` before `unsupported` (`:55`); a document over 20 MB is `{kind:'tooBig'}` → "That file is over 20 MB, too big for me to keep."
**`src/seatGlue/files.ts`** (new) — `uploadFile(cfg, {kind, name, mime, bytes, source})` and `downloadFile(cfg, id) → {bytes, name, mime}` against `/seat/files` with the seat token (the `exportRows` pattern, `main.ts:83`), each with `AbortSignal.timeout(60_000)`: updates are handled one at a time (`seat.ts:274-287`), so a hung upload would hold every later message, Stop included. Plus `sendFileTool({downloadFile, sendPhoto, sendDocument})`, built HERE, not in `fileTools()` (every tool there opens the sandbox via `withBox`, `fileTools.ts:119-131`), so every seat gets it with or without E2B.
**`src/seatGlue/seat.ts`** — `SeatDeps.uploadFile?` (wired in `seatDeps()` in `main.ts`; absent → "could not be saved"). The decision/prompt checks (`:308-310`) treat `document` like `photo` (own `cancelPrompts` reason). Photo (`:328-336`): after download, `uploadFile`; the message becomes `${caption ?? '(photo)'}\n[photo saved as file ${id}]` (or `[photo could not be saved]`), attachment unchanged. New `document` case: download, upload, message = caption (if any) + `[document "<name>" saved as file <id>]`; if jpeg/png also attach it as an image. Upload failures are logged and said to the model, never block the turn. `TEXT.unsupported` → "I can read texts, photos, voice notes and files."
**`src/seatGlue/fileTools.ts`** — `send_file` (download → `sendPhoto` for image/jpeg|png, else `sendDocument`) lives in `files.ts`, NOT here; `FILE_TOOL_NAMES` gains only `save_file` and `open_file` (`fileTools.test.ts:132` pins names == `fileTools()` output). Manager-only `save_file {path, links?: [{jobId|visitId|customerId|moneyEventId}]}` (sandbox read ≤ 20 MB → `uploadFile(source:'sandbox')` → `link_file` via the spine MCP is the model's job: the tool returns the id and says to link it) and `open_file {fileId}` (download → write `/home/user/files/<safeName(name)>` via `resolvePath`, `fileTools.ts:63-73`, so a stored name with `/` or `..` cannot escape).
**`src/seatGlue/engine.ts` / `main.ts`** — `engine.ts:155` drops a technician's tools today (`fileTools = manager ? (cfg.tools ?? []) : []`): keep them for both tiers, and gate `FILES_SECTION`, skills (`:211`) and the manager builtins on `manager`, not `fileTools.length`; the permission handler (`:227`) approves `send_file` for both. `main.ts`: every seat gets `sendFileTool`; a manager's list = `[sendFileTool, ...fileTools()]` (fileTools only with E2B, `:122-128`); `skillsDir`/`skills` only for managers (`:48`). Rewrite `engine.test.ts:48-62` and `:124-131` (they pin "technician config unchanged when handed tools"): a technician gets `custom:*` + exactly `send_file`, no skills.
**`src/seatGlue/doctrine.ts`** — SEAT_PREAMBLE (`:27-31`) and the manager preamble (`:147-151`), replacing "photos and voice notes are not stored in the permanent record yet" (it would contradict) while KEEPING "Never set `blobPath`" (`doctrine.test.ts:40`) and never writing "technician" in the manager text (`doctrine.test.ts:87`): photos and files they send are SAVED automatically and arrive with a file id; attach each to the job or visit it belongs to with `spine-link_file` (ask which one when unsure; a photo of nothing work-related is left unattached); `send_file` sends one back; `spine-delete_file` when asked. Keep "Never set `blobPath`". Not a PORTED block, so `bootstrap-box.sh` is untouched (`doctrine.test.ts` stays green).
**`src/seatGlue/drive.ts`** — a `{document: path}` step (photo steps exist, `:20`).

**Tests** — inbound (document, tooBig), seat (photo/document → upload called, id in the message, failed or timed-out upload still delivers; a document closes an open prompt), fileTools (send_file picks sendPhoto/sendDocument; save_file size refusal; open_file writes), engine (technician gets `custom:*` + `send_file` only), doctrine (manager and technician text mention link_file).

### Automated verification
- [x] typecheck, lint, `npm test`, `npm run build`
      — 3941 passed, build clean (d85f70e).
- [x] **Live, local rig** (the 2c rig: local spine on 8791, `setup-local-seat.mjs`, driver): drive a photo, then "attach that to the Lee job", then "send it back to me" — evidence: a `files` row + a `file_links` row with the job id (read back with SQL), the driver's `documents`/photo send with identical bytes (`cmp`), and a second seat (technician not on that job) gets "not found" from `send_file`
      — driver on s2: photo in → "I've attached the photo to Tom Becker's furnace inspection job." → "send me that photo back" → photo out; `cmp` identical (63,280 bytes); SQL: files row (photo, manager-sam, telegram) + file_links → Furnace inspection. Technician seat s9 (not on that job): GET → 404; the manager: 200. (Used the seeded Becker job, not "Lee".)

## Phase 4: live on the pilot

1. PR → merge. **Migration on the pilot run by the operator** (never `db push`); then check `select id, public from storage.buckets where id = 'files'` — create it by hand in Studio if the insert no-op'd (research: the call-audio insert can).
2. Render web: manual deploy (it does not auto-deploy). Glue: stage → rsync → `install.sh s2`, then `install.sh s5` (operator runs the box commands the classifier refuses).
3. `journalctl -u seat-glue@s2/s5`: polling.

### Live verification (agent-executable)
- [x] After the phone test: pilot `files` + `file_links` rows for the photo (read-only SQL via the supabase-test MCP), and after the delete, `deleted_at` set and the object gone (Storage list shows no `<tenant>/<id>`)
      — 2026-09-29: 3 rows. Sam's photo → link job "Furnace inspection" (Tom Becker); Sam's PDF deleted_at 16:53:24 by manager-sam, no links; Ben's photo → link visit on "Visit for Maria Gonzalez". storage.objects in `files` holds only the two photos: the PDF's bytes are gone.

### Manual verification
- [x] From Sam's phone (s2): send a job photo → the bot asks or says which job it attached it to; "send me that photo" → it comes back; send a PDF → saved and attached; "delete that photo" → gone
      — asked with buttons, attached to Tom Becker's furnace inspection, sent back; the PDF (a driving-school receipt) was opened in the sandbox, read, left unattached on the operator's say, then deleted. Note: the sandbox has no PDF reader (pypdf / pdftotext); the bot decoded the streams with zlib.
- [x] From Ben's phone (s5): a photo on his job is kept and attached; asking for a photo from a job he is not on → "can't find that"
      — kept, attached, sent back; Tom Becker's photo → "outside your view", offered the access ask. The photo landed on "Visit for Maria Gonzalez" (the pilot has two open "HVAC inspection" jobs for her; record_field_note routed the note there and minted a trip) — operator: the bot handled it fine; the pilot's unresolved open jobs are the cause. Left as is.

*Pause after Phase 4 (phone checks).*
