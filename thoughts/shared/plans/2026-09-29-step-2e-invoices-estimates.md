---
date: 2026-09-29
task: Step 2e — invoices and estimates as records, recorded when final, emailed with the PDF attached, and the manager's own sent invoices caught (kept + asked about)
research: thoughts/shared/research/2026-09-29-step-2e-invoices-estimates.md
status: draft
supersedes: thoughts/shared/plans/2026-08-15-invoice-creation-v1.md
---

## Overview

Today an estimate or invoice is one ledger row (kind + amount); there is no document, no number,
no line items, and `send_email` cannot attach anything. 2e adds one record type for both —
a **money document** (kind invoice | estimate) with lines, a total, a number and its PDF —
records it in the ledger **when the manager says it is final** (however it is delivered), lets
the bot email it with the PDF attached, and meets the common case where the manager invoices
from their **own Gmail**: the PDF on their sent work email is kept, and the office asks them once
whether to record it. Supersedes the unbuilt 2026-08-15 invoice plan (its React-PDF render and
record-on-send design predate "the sandbox draws" and the 2026-09-29 ruling below).

## Decisions

Operator, 2026-09-29:
- **Recorded when final, not when sent.** Invoices leave through channels we cannot see (post, a
  text, by hand), so `invoice_issued` is written when the manager says the invoice is final.
  Emailing through us is delivery only and never records again. The bot never records while
  drafting (a rulebook rule). Supersedes in part the 2026-09-23 "recorded when it leaves" ruling
  (memory `invoice-recorded-when-sent`, `docs/engineering-memory.md:1840-1882`).
- **One record type, two kinds** (invoice | estimate) — not two tables.
- **Both are numbered** when issued: `INV-1001…`, `EST-1001…` per firm; drafts carry no number
  (the PDF says DRAFT); each kind's starting number is settable. An invoice made in the
  manager's own system keeps its own number (recorded as the ledger's `external_ref`).
- **Estimates in the ledger:** issuing → `estimate_presented`; the manager says accepted →
  `estimate_approved` (this is what sets `quoted`); declined → `estimate_declined`.
- **Send approval: no new code.** `send_email` keeps its stage → preview → yes; the bot may use
  `ask_user` buttons if it judges them clearer.
- **Manager's own sent Gmail:** (1) the office notices an invoice-looking sent email and asks
  the manager once whether to record it (ask-first; the office judges, code guards);
  (2) attachments on the manager's SENT work email are kept in the file store, linked to the
  customer/job the email was filed on. Silent auto-recording rejected. Received-mail
  attachments stay a later step.
- **One plan, not split** (operator).

Mine (implementation):
- **Table `money_documents`**: `id uuid`, tenant, `kind`, `job_id` (RESTRICT, like the ledger),
  `customer_id`, `status` draft | issued | void, `number_seq int`, `number text`, `lines jsonb`
  (`[{description, quantity, unitCents, amountCents}]`), `total_cents`, `notes`, `money_event_id`
  (the issuing ledger row), `outcome` null | accepted | declined (estimates), timestamps,
  `created_by_ref`. A draft is editable; an issued document changes only by void or outcome.
  Unique `(tenant_id, kind, number_seq)`. RLS on, revoked (the seat_memory pattern).
- **Tax is not ours**: a tax line is just a line. No tax engine, no rates.
- **Numbering** = `max(number_seq)+1` for the firm and kind, or the firm's start; insert retries
  on 23505 (the 2026-08-15 design). Starts live on `tenant_profiles` (`invoice_start`,
  `estimate_start`, default 1001), set through `set_firm_profile`.
- **Ledger writes carry `dedupe_key`** `doc:<id>:issue` / `:void` / `:outcome` so a retried call
  cannot double a row (first live writer of `dedupe_key`). Amount = `total_cents`;
  `external_ref` = the number; `source_capture_id` null.
- **Void**: invoice → `invoice_voided` correcting the issuing row (walks the job status back via
  the existing sync); estimate → status void, plus a `correction` of its `estimate_approved` row
  if it was accepted (else `quoted` would keep it). A second outcome on an estimate is refused.
- **Deposits**: `issue_document` takes `progress` (as `record_money_event` does); a non-progress
  invoice walks an open job to `invoiced` through `completed` (today's ledger behaviour, kept).
- **Issue is safe to retry**: the number is set with a compare-and-set on `status='draft'`; an
  issued document with no `money_event_id` retries its ledger write (the dedupe key makes it safe).
- **Files link to documents**: `file_links.document_id` (the 2d pattern, cascade); a document's
  file is visible to a technician only where money is open to her (as ledger links).
- **Technicians never see documents**: all document tools are manager-only (`admin` tier).
- **The PDF carries the number**, so the order is: draft → manager OKs → `issue_document` (number
  + ledger row) → bot renders the final PDF → `save_file` → `link_file(document)` → deliver.
- **Attachment out** (≤ 18 MB — base64 adds a third and Gmail caps a message at ~25 MB): `send_email.fileId` (one file — the safe shape without pinning the tool
  version); on confirm Render reads the bytes, uploads with `composio.files.upload(new File(…))`
  (`toolSlug:'GMAIL_SEND_EMAIL'`, `toolkitSlug:'gmail'`) and passes `attachment:{name,mimetype,s3key}`
  (https://docs.composio.dev/docs/tools-direct/executing-tools; `@composio/core` 0.13.1, no upgrade).
  The bytes go to Composio's S3 — inherent to the vendor.
- **Sent-mail attachments in**: after the classifier passes and the capture is filed, fetch each
  attachment (≤ 20 MB) with `GMAIL_GET_ATTACHMENT` → `data.file.s3url` → `fetch` (auto-download is
  off in our client), store with `source 'email'` and a `source_ref` `gmail:<messageId>:<attachmentId>`
  (unique per firm — a redelivered webhook cannot store twice), link to the capture's job, else
  customer. Best-effort: a failure logs, never fails the capture. The item shape of
  `attachment_list` is undeclared by Composio (live trigger schema), so read it tolerantly and fall
  back to `payload.parts[]` (Gmail `MessagePart`: `filename`, `mimeType`, `body.attachmentId`,
  `body.size` — https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages).
- **The ask**: a new observation kind `outbound_invoice`, raised by code for a MANAGER's sent work
  email that has a PDF attachment or says "invoice" (a cheap guard; the office decides), pinged
  like `inbound_new_job` (`PINGED_KINDS`). The planner's focused pass sends the manager's seat a
  note; the SEAT asks and, on yes, records with `record_money_event(invoice_issued, amount,
  externalRef = their number, sourceCaptureId = the email)`. `capture_records` gains a money arm
  (ledger rows citing the capture) so the office sees the question answered. **No double ask**:
  code skips the observation when the email names a number this firm already issued (INV-/EST-,
  or a ledger `external_ref`), and when the capture was a duplicate or agent-written.
- **Attachments are kept off the request path**: the webhook answers Composio first; the fetch
  runs after, bounded (60 s total), best-effort.

## Plain-language walkthrough

```
BOT-MADE                                         MANAGER'S OWN GMAIL
"invoice the Lee bathroom job"                   manager emails an invoice PDF from Gmail
 → draft (lines, total, no number)                → sent email captured (as today)
 → PDF marked DRAFT → manager: "looks good"        → the PDF is KEPT on the job/customer   (new)
 → issue: INV-1004 + "invoice issued" in the log  → office: "Looks like you invoiced Lee $450.
 → final PDF with the number, kept on the job        Record it?" → yes → recorded with their number
 → email it with the PDF attached (preview + yes)
   or the manager sends it their own way
```

**Phase 1 — the records.** A new table holds estimates and invoices (lines, total, number,
status). Issuing gives the next number and writes the ledger row; voiding cancels it; an
estimate's accepted/declined is logged. Files can hang on a document. Seen only in tests.

**Phase 2 — the tools.** The manager's bot gets five tools: draft/update, issue, void, record an
estimate's outcome, list. The firm profile gains the two starting numbers.

**Phase 3 — the PDF on an email.** `send_email` takes a stored file and sends it attached, from
the person's own Gmail, after the same preview-and-yes as today.

**Phase 4 — the manager's own sent invoices.** PDFs on the manager's sent work email are kept and
attached to the job; an invoice-looking one makes the office ask the manager, once.

**Phase 5 — the rules and live.** The manager's rulebook learns the document flow; migration on
the pilot (you), Render deploy, glue installs, then a phone test of both paths.

## Secrets & env preflight

- **Phases 1–2:** none new (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — already required).
- **Phases 3–4:** `COMPOSIO_API_KEY` — already required (Render).
- **Phase 5:** none.

## Phase 1: the records

**`supabase/migrations/20260929120000_money_documents.sql`** (new)
- `create table money_documents (…)` per Decisions; `check (kind in ('invoice','estimate'))`,
  `check (status in ('draft','issued','void'))`, `check (outcome is null or (kind = 'estimate' and outcome in ('accepted','declined')))`,
  `check ((status = 'draft') = (number_seq is null))`; unique partial index `(tenant_id, kind, number_seq) where number_seq is not null`;
  index `(tenant_id, job_id)`; RLS on + revoke.
- `alter table tenant_profiles add column invoice_start integer not null default 1001 check (invoice_start > 0), add column estimate_start integer not null default 1001 check (estimate_start > 0);`
- `alter table file_links add column document_id uuid references money_documents(id) on delete cascade;` drop and re-add `file_links_one_target` UNDER THE SAME NAME (`files.test.ts:118,124` match it) with `num_nonnulls(customer_id, job_id, visit_id, money_event_id, document_id) = 1`; partial unique `(file_id, document_id)`.
- `files`: drop `files_source_check`, re-add with `('telegram','sandbox','email')`; `add column source_ref text`; unique partial `(tenant_id, source_ref) where source_ref is not null`.
- Re-create `capture_records` (defined in `20260917130100_planner_capture_readers.sql:139`) with a money arm INSIDE the function (a union over `money_events.source_capture_id`, `via = 'money'`) — not in the `capture_membership` view (the seat readers use it). Tested in Phase 4.
- `npm run gen:types:local` (never `gen:types`).

**`src/db/moneyDocuments.ts`** (new; re-exported from `src/db/index.ts`)
- `saveDraft({tenantId, kind, jobId, lines, notes, byRef, documentId?})` — validates lines (1–100, quantity > 0, whole cents ≥ 0, `amountCents = quantity × unitCents` rounded), recomputes the total, refuses a non-draft, stamps `customer_id` from the job (tenant-checked).
- `issueDocument(tenantId, id, byRef, {progress?})` — number (max+1 or start, retry 23505) set by `update … where status = 'draft'` (compare-and-set: a racing second issue gets the first's number back); then `appendMoneyEvent({kind: invoice ? 'invoice_issued' : 'estimate_presented', amountCents: total, externalRef: number, dedupeKey: 'doc:<id>:issue', progress → detail.progress, jobId, actorRef})` and `syncJobStatusForMoney(tenantId, jobId)`; stores `money_event_id`. Issued with `money_event_id` null → retry the ledger write. A 23505 on the dedupe key → `getMoneyEventByDedupeKey` (new accessor in `moneyEvents.ts`).
- `voidDocument(tenantId, id, reason, byRef)` — invoice: `invoice_voided` correcting `money_event_id` (`dedupeKey :void`) + sync; estimate: status void + a `correction` of its `estimate_approved` row if accepted (`dedupeKey :void`).
- `recordEstimateOutcome(tenantId, id, 'accepted' | 'declined', byRef)` — issued estimates with no outcome only (a second is refused in words); `estimate_approved` (amount = total) / `estimate_declined`, `dedupeKey :outcome`.
- `getDocument`, `listDocuments(tenantId, {jobId? , customerId?})`.
- `appendMoneyEvent` already accepts `dedupeKey` (`moneyEvents.ts:72-77`); on 23505 re-read the row by key.

**`src/db/files.ts`** — `FileTarget` gains `{documentId}` in `targetColumn`, `resolveTarget` (a document resolves to its job/customer as kind `'money'`, so the money rule applies), `linksOf` (select + map `document_id` — else a PDF on a job and a document looks like a plain job file to a technician), and `linkFile`'s insert; `FileSource` gains `'email'`; `createFile` takes an optional `sourceRef` and on 23505 returns the existing row.
**`src/mcp/tools/files.ts`** — `documentId` in `TARGET_PROPS`, `targetOf` and `wellFormed` (UUID-checked); export `visibleFile` / `viewerOf` for `send_email`.
**`src/db/tenantProfiles.ts`** — integer branch for `invoiceStart` / `estimateStart` in the patch and echo; no profile row → 1001; update the `TenantProfile` fixture in `tenantProfiles.test.ts:164`.

**Tests** — `src/db/moneyDocuments.test.ts` (local stack): draft → update → issue (INV-1001, then 1002; a firm's start of 5000 → INV-5000; estimates count separately); issue writes one `invoice_issued` with the total and moves `completed → invoiced`; a repeated issue writes nothing new; void writes `invoice_voided` and walks the status back; issuing on an OPEN job walks it to `invoiced`, and with `progress` leaves it open; a failed ledger write is retried by a second issue; two concurrent issues of the same draft end with ONE number and one ledger row; two drafts issued together get two numbers; estimate issue → `estimate_presented`, accepted → `estimate_approved` and `quotedCents` = total, a second outcome refused, voiding an accepted estimate clears `quotedCents`; an issued document refuses edits; tenant guard. `files.test.ts`: a document link; a file linked to a job AND a document stays hidden from a technician without money; `sourceRef` dedupe.

### Automated verification
- [x] local `npx supabase migration up`; `npm run gen:types:local`; typecheck, lint, `npm test`
      — 55d8a69 + review rounds 690da8c, 9056bff (races between issue / void / outcome, progress stored, a void heals); 3984 passed.

## Phase 2: the tools

**`src/mcp/tools/documents.ts`** (new domain module, `admin` tier — manager-only)
- `draft_document {kind, jobId, lines, notes?, documentId?}` → `{documentId, status:'draft', lines, totalCents}`.
- `issue_document {documentId}` → `{number, totalCents, recorded: 'invoice issued' | 'estimate presented', money}`.
- `void_document {documentId, reason}`; `record_estimate_outcome {documentId, outcome}`; `list_documents {jobId | customerId}`.
- Descriptions carry the rules: issue ONLY when the manager says it is final; the PDF is drawn after issuing so it carries the number; an invoice made elsewhere is `record_money_event(invoice_issued, externalRef = their number)`, not a document.

**`src/mcp/server.ts`** — spread `documentsTools.admin` into `ADMIN_TOOLS` and the handlers.
**`src/mcp/tools/surface.expected.ts`** — the five names in `MANAGER_ONLY_TOOLS`.
**`src/mcp/tools/roster.ts`** — `set_firm_profile` input schema (`additionalProperties:false`) and `knownKeys` (`:960`) gain `invoiceStart`, `estimateStart` (positive integers); the read echoes them. `issue_document` takes `progress?`.
**`src/eval/toolCases.ts`** — a tier-1 case per new tool (the coverage gate, `toolCases.test.ts:67-71`); write cases on a disposable job.
**Tests** — `server.test.ts` `describe('money documents (step 2e)')`: a manager drafts, issues, lists, voids; a technician is refused every tool; `set_firm_profile` round-trips the starts.

### Automated verification
- [x] typecheck, lint, `npm test` (surface + eval coverage pass)
      — d3472e3 + 40fe5b0 (null args, repeated issue retries the status walk, cross-firm test); 3993 passed.

## Phase 3: the PDF on an email

**`src/composio/pairing.ts`** — widen `PairingClient` with an OPTIONAL `files?: { upload(input: {file: File; toolSlug: string; toolkitSlug: string}): Promise<{name: string; mimetype: string; s3key: string}> }`.
**`src/composio/outbound.ts`** — `SendEmailInput.attachment?: {name: string; mime: string; bytes: Buffer}`; when present, `client.files.upload({file: new File([bytes], name, {type: mime}), toolSlug:'GMAIL_SEND_EMAIL', toolkitSlug:'gmail'})` and pass `attachment: {name, mimetype, s3key}` (single object).
**`src/mcp/tools/comms.ts`** — `send_email.fileId?`: at stage, the file must be visible to the caller (`visibleFile`) and ≤ 18 MB; stage detail stores `fileId` and the preview shows `attachment: <file name>`; at confirm read the bytes BEFORE the token is consumed (`comms.ts:271-279`) — a file deleted since staging refuses in words and keeps the token; the L1 `outbound_email` metadata adds `attachment: {fileId, name}`. Description: attach one stored file by id.
**Tests** — `server.test.ts` (it fakes `deps.sendEmail`, `:2625`): stage with a fileId shows the name; confirm passes `attachment` to `sendEmail`; an invisible or over-18 MB file is refused at stage; a deleted-since-staging file refuses at confirm and the token survives. `outbound.test.ts`: the upload call and the descriptor. The four `PairingClient` fakes (`offboarding.test.ts:51`, `outbound.test.ts:44`, `sessions.test.ts:53`, `pairing.test.ts:112`) keep compiling because `files` is optional.

### Automated verification
- [x] typecheck, lint, `npm test`
      — ad14449 (review clean; the attachment's exact shape is confirmed by the Phase 5 phone send); 4006 passed.

## Phase 4: the manager's own sent invoices

**`src/inbound/gmailSent.ts`** — read `attachment_list` tolerantly (`attachmentId|attachment_id|id`, `filename|file_name|name`, `mimeType|mime_type|mimetype`, `size`), else walk `payload.parts[]` recursively for parts with a `filename` and `body.attachmentId`; carry them in `sourceMeta.attachments` (not stored in L1 metadata beyond `{name, mime, size}`).
**`src/inbound/sentAttachments.ts`** (new) — `keepSentAttachments({tech, messageId, attachments, target, deps})`: for each ≤ 20 MB, `GMAIL_GET_ATTACHMENT {message_id, attachment_id, file_name}` → `data.file.s3url` → `fetch` (20 s each) → `createFile({source:'email', sourceRef:'gmail:<messageId>:<attachmentId>'})` → `linkFile` (job, else customer, else unlinked). Never throws.
**`src/inbound/webhook.ts`** — after `recordFieldNote` for an `outbound_email` that passed the classifier and is NOT `duplicate` / agent-written: keep its `{customerId, jobId}` (today discarded, `:515`); once the capture is fully filed (`captureHasLinkedL2` treats any observation as "processed", `rawCaptures.ts:216-221`), if the mailbox owner is an active MANAGER, the email has a PDF or says "invoice", and it names no number this firm already issued (documents or ledger `external_ref`), `createObservation('outbound_invoice', subjectRef = captureId, context = {outbound:true, words, customerId, jobId, jobTitle, captureId, sentTo, attachments})`. Respond, then run `keepSentAttachments` detached (bounded 60 s total). Both are new `InboundWebhookDeps` seams (`webhook.ts:84`) so existing webhook tests stay off Composio and the DB.
**`src/db/reviewItems.ts` / `src/db/observations.ts`** — add `outbound_invoice` to `ReviewKind` and `PINGED_KINDS`; check whether a DB constraint lists observation kinds and extend it in the Phase 1 migration if so.
**`src/teamLead/plannerPrompt.ts`** — a short paragraph for `outbound_invoice`: if the manager's sent email is an invoice the firm issued and it is not already in the ledger, send their seat a note (the assistant leg) naming customer, job, amount and their invoice number, asking whether to record it; else dismiss. What, not how.
**`src/teamLead/planner.ts`** — a kind branch for `outbound_invoice` in the gap block (`:1605-1720`: not "the caller's words", no "a job would have to be opened", no "agreed to come out"), in `mootFactFor` (`:4869-4921`: closed by a ledger row citing the capture), and in `inboundAskFor` (`src/mcp/tools/shared.ts:711`: a booking must not cite it).
**`src/db/captureMembership.ts`** — `readCaptureRecords` (`:152-176`) maps `via = 'money'`; `L2CitingCapture.kind` gains `'money'` (numeric ids as strings).
**Tests** — normalizer: both attachment shapes and none; `sentAttachments.test.ts` with fake Composio + fetch (fetch, store, link to job, dedupe on a second delivery, over-20 MB skipped, a failure logged not thrown); webhook: a manager's invoice email raises one `outbound_invoice`, a technician's does not, a non-invoice does not, a duplicate does not, one naming an already-issued INV number does not; capture_records returns a `money` record for a ledger row citing the capture and `mootFactFor` closes the observation; the planner gap text for `outbound_invoice`.

### Automated verification
- [x] typecheck, lint, `npm test`
      — e94ff24 + f88123b (manager-only files, the note only to the mailbox owner and asked once, number cue, detached work); 4043 passed.

## Phase 5: the rules and live

**`src/seatGlue/doctrine.ts`** — MANAGER_PREAMBLE (every manager) gains the TOOL rules: draft with `spine-draft_document`; issue with `spine-issue_document` ONLY when the manager says it is final, never while drafting; deliver with `spine-send_email` + `fileId`, or they send it themselves; an invoice made elsewhere → `spine-record_money_event(invoice_issued, …, externalRef)`; estimate accepted/declined → `spine-record_estimate_outcome`; a note from the office about their sent email → ask once, then record or say no. FILES_SECTION (only seats with a computer, the 2b rule) gains the DRAWING steps: read the firm profile (`spine-set_firm_profile`, ask once for missing details and save them; payment terms from memory), draw the DRAFT PDF and show it, after issuing draw the final PDF with the number, `save_file`, `spine-link_file` to the document.
**`src/seatGlue/doctrine.test.ts`** — both texts name their tools; the preamble still excludes the computer (`:81`) and "technician".

### Automated verification
- [x] typecheck, lint, `npm test`, `npm run build`
      — fb81c5e; 4043 passed, build clean.
- [x] local rig: drive "draft an invoice for the Becker furnace job: inspection $180, filter $25" → a draft; "that's final" → INV-1001, one `invoice_issued` of 20500, job `invoiced`; a PDF saved and linked to the document (SQL read-back)
      — driven 2026-09-29: firm profile saved from the message; DRAFT PDF shown ("INVOICE (DRAFT)", no number, due in 14 days); "final" → INV-1001, total 20500 (2 lines), one invoice_issued 20500 keyed doc:<id>:issue, job completed → invoiced; final PDF reads "INVOICE INV-1001 … Due Date: October 13, 2026", kept (source sandbox) and linked to the document.

### Deploy (operator steps marked)
1. PR → merge → sync the fork (`gh repo sync Yu-C1/TradesDatabase --branch main`).
2. Pilot migration (`scripts/apply-pilot-migration.mjs … --apply`; operator if the classifier refuses).
3. Render web: manual deploy. Glue: `install.sh s2`, `install.sh s5`.
4. Operator check: the pilot manager's Gmail has `GMAIL_EMAIL_SENT_TRIGGER` provisioned (`ensureTriggers`).

### Live verification (agent-executable)
- [ ] After the phone test, read-only SQL on the pilot: the document row (number, total, status), its `invoice_issued` row (dedupe key, external_ref), the file link, the kept sent-mail PDF (`source 'email'`, linked to the job), the `outbound_invoice` observation and the ledger row that closed it.

### Manual verification
- [ ] Sam: "make an invoice for Tom Becker's furnace inspection, $180 inspection + $25 filter" → DRAFT PDF → "final" → INV number, recorded → "email it to <your address>" → preview → yes → the email arrives with the PDF.
- [ ] Sam: from Gmail directly, email a PDF invoice for a customer job → the PDF appears on the job; the bot asks once whether to record it → yes → recorded with that invoice's number.
- [ ] Sam: an estimate → issued (EST number) → "they accepted" → quoted price set.

*Pause after Phase 5 (phone checks).*
