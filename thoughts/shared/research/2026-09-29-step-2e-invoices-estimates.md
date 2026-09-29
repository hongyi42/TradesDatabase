---
date: 2026-09-29
branch: main
commit: 1f5639a
topic: Step 2e — invoices and estimates as their own records, email attachments, recording an invoice when it is sent
supersedes: nothing
---

# Step 2e research — invoices, estimates, attachments, record-on-send

Read at `1f5639a` (= `origin/main`). Operator scope (2026-09-28, memory `files-and-money-records`,
`invoice-recorded-when-sent`): invoices and estimates become their own records; files link to
them; `send_email` must carry attachments; `invoice_issued` is written when the invoice LEAVES
(Approve on the send is the one yes; mistakes → `invoice_voided`); the invoice TEMPLATE is not
important (firms bring their own). Earlier rulings (2026-09-23, `docs/engineering-memory.md:1840-1882`):
the sandbox draws the invoice from spine data; numbering is a per-firm sequence assigned AT SEND
(drafts say DRAFT, no number), default INV-1001, starting number in tenant_profiles; the bot says
"sent and recorded".

## Summary

Money today is a **ledger of events on a job** (`money_events`: one row per fee, estimate,
invoice, payment…), append-only, with the job's money state (quoted / invoiced / paid / balance)
**folded** from those rows in code. An estimate or an invoice is just one such row — a kind, an
amount, an optional external reference — with **no line items, no number, no document, no
recipient**. There is no invoices or estimates table (the 2026-08-15 invoice plan that proposed one
was never built). The manager's bot can already **draw** a PDF (reportlab and pypdf in its E2B
sandbox) and **keep** it (step 2d's file store, which can link a file to a ledger entry), but it
cannot **send** one: `send_email` is text-only end to end, and nothing records an invoice on send.
Composio's Gmail send does take attachments, but only as a file first **uploaded to Composio's
storage** (`{name, mimetype, s3key}`). Approvals today are a typed "yes" the model reads — no
button is tied to a specific staged action. Two side doors matter for "record when sent": the
manager can call Gmail directly through Composio (no staging, no invoice write), and
`record_money_event` commits `invoice_issued` in one call whenever the model chooses.

## Entry Points

- Ledger write: `record_money_event` (manager only), `src/mcp/tools/money.ts:30-212` → `appendMoneyEvent`, `src/db/moneyEvents.ts:92-209`.
- Ledger fold: `summarizeMoney` `src/db/moneyEvents.ts:450-498`; status walk `deriveStatusTarget` / `syncJobStatusForMoney` `:510-601`.
- Email send: `send_email` `src/mcp/tools/comms.ts:49-409` → `sendGmailEmail` `src/composio/outbound.ts:44-87`.
- Manager's direct Composio door: `/composio` relay `src/composio/relayHandler.ts:507-624`; log capture `src/composio/logIngest.ts`.
- Firm profile: `set_firm_profile` `src/mcp/tools/roster.ts:203-…, 955-1000`; `src/db/tenantProfiles.ts`.
- File store (2d): `src/db/files.ts`, `supabase/migrations/20260928120000_files.sql`; seat tools `src/seatGlue/fileTools.ts` (save_file, open_file, share_file), `src/seatGlue/files.ts` (send_file).
- Approvals on the glue: `src/seatGlue/seat.ts:866-933` (ask_user buttons, plan Go/Change), `src/seatGlue/prompts.ts`.

## Key Files

| File | Role |
|---|---|
| `supabase/migrations/20260815160000_money_events.sql` | The ledger: `bigint` id, `job_id` RESTRICT, 12 kinds (+ `material_cost`, `20260819120000`), `amount_cents ≥ 0`, `external_ref`, `dedupe_key` (partial unique), `detail jsonb`, append-only trigger, RLS on (`:12-97`). |
| `src/db/moneyEvents.ts` | Write rules (amountless kinds `:38-42`; void/correction one level, same job `:143-182`); fold (`:450-498`); status walk (`:510-601`); `technicianMoneyView` words-only (`:619-674`). |
| `src/mcp/tools/money.ts` | `record_money_event`: admin tier; args jobId, kind, amountCents, occurredAt, method, externalRef, note, progress, sourceCaptureId, correctsEventId; "ONE call — it commits immediately" (`:41`, `:146`); never sets `dedupeKey`. |
| `src/db/jobs.ts` | Status machine (`:31-39`), `TERMINAL_JOB_STATUSES` = paid/cancelled/declined (`:48-52`); `price_cents` written only by the seed (`:63,89`). |
| `supabase/migrations/20260815180000_tenant_profiles.sql`, `src/db/tenantProfiles.ts` | Firm profile: names, address, phone, email, license numbers, disclosure footer; `profileGaps` (`:200-228`). No terms, tax, logo or numbering fields. |
| `src/mcp/tools/comms.ts` | `send_email`: to/subject/body/jobId; stage → `pending_outbound_send` review item → confirm with confirmId within 15 min, token consumed before the send (at-most-once) (`:207-317`); files the copy on a customer/job (`:334-374`); L1 `outbound_email` (`:377-401`). |
| `src/composio/outbound.ts` | `GMAIL_SEND_EMAIL` with `{recipient_email, subject, body}` only, from the PERSON's own paired Gmail (`:44-87`). |
| `src/composio/relayHandler.ts`, `sessions.ts`, `logIngest.ts` | Manager session = whole catalog (`sessions.ts:32-43`); relay blocks only the workbench/bash by top-level name (`relayHandler.ts:60-76`); logIngest stores GMAIL sends verbatim (no job stamp, no threadId) (`logIngest.ts:23, 243-291`). |
| `supabase/migrations/20260928120000_files.sql`, `src/db/files.ts` | `file_links.money_event_id` (`:39-50`); comment "2e adds invoice_id / estimate_id the same way" (`:38`); technician money-file rule (`files.ts:96-122`). |
| `src/seatGlue/doctrine.ts` | Manager rules: staged tools = send_email, retract_capture (`:71`); FILES section names invoices + save_file (`:180-182`); **no invoice/estimate/money rule**. |
| `Box_Setup_Stuff/seat-glue/e2b-template.mjs` | Sandbox libraries: openpyxl, xlsxwriter, reportlab, pypdf, pandas (`:29`). |
| `thoughts/shared/plans/2026-08-15-invoice-creation-v1.md` | Draft, NOT landed: `invoices` table (number_seq, `INV-<seq>`, line_items jsonb, totals, money_event_id, pdf_path, sent_message_id), React-PDF, staged `create_invoice`, Composio `files.upload` attachment, `invoice_issued` with `dedupe_key 'invoice:<id>'`. Predates "the sandbox draws". |

## Data Flows

### Money today

```
manager: "Lee paid $450"  → record_money_event(kind=payment_received, 45000)  → money_events row (append-only)
                                                                             ↓
get_job / get_customer_context / planner  ←  summarizeMoney(rows)  →  quoted · invoiced · paid · balance
                                                                             ↓
                                              syncJobStatusForMoney → job status invoiced / paid
```

- **quoted** = the last live `estimate_approved` + later `change_order`s; **invoiced** = Σ `invoice_issued`; **paid** = received − refunded; **balance** = invoiced − paid − credits − write-offs (`moneyEvents.ts:458-493`).
- `fee_charged`, `estimate_presented`, `estimate_declined` feed no total (only `lastEventAt`).
- A non-progress `invoice_issued` walks the job `completed → invoiced`; balance ≤ 0 walks it to `paid`; a void walks back; `paid` never walks back; a `progress: true` invoice never moves status (`:510-601`).
- Readers: get_job (managers: summary + last 10 entries), get_customer_context (full rows incl. `detail`), the planner's evidence lines, the cost-gap detector, `v_money_events` for query_spine / export_query. The board/console/admin UIs read no money.

### Sending email today

```
bot: send_email(to, subject, body, jobId)  → review_items pending_outbound_send  → {needs_confirmation, confirmId, preview}
model shows the preview as text; manager types "yes"
bot: send_email(confirmId)  → token consumed → Composio GMAIL_SEND_EMAIL {recipient_email, subject, body}
                            → L1 outbound_email (sent:<messageId>, threadId), filed on the customer/job
```

- Callable by any active roster member with a paired mailbox (`requireOutboundCapable`, `outbound.ts:29-37`); technicians' Composio sessions cannot send (`sessions.ts`).
- The server cannot tell a human yes from the model calling again with the confirmId.
- Replies thread back by `threadId` (`inbound/gmail.ts:54-56`, `findCustomersByThread` `rawCaptures.ts:375-440`).

### Attachments (vendor, today)

- Composio `GMAIL_SEND_EMAIL` documents `attachment` ("a single file or a list of files … total message size must not exceed ~25 MB after base64") and `is_html`, `cc`, `bcc`, `extra_recipients` — https://docs.composio.dev/toolkits/gmail. `GMAIL_CREATE_EMAIL_DRAFT` and `GMAIL_REPLY_TO_THREAD` take `attachment` too; `GMAIL_SEND_DRAFT` takes only `draft_id`.
- The attachment is a staged descriptor `{name, mimetype, s3key}`; `composio.files.upload(...)` (local path, URL or File) makes one — https://docs.composio.dev/docs/tools-direct/executing-tools. Auto-upload is "off by default" there; the Gmail page's FAQ says "enabled by default" (**the vendor docs contradict each other**). Installed `@composio/core` 0.13.1 (latest 0.22.0): auto-upload only with `dangerouslyAllowAutoUploadDownloadFiles: true` (`index.mjs:1202`); `files.upload` → `POST /api/v3.1/files/upload/request` then a presigned S3 PUT (`fileUtils.node-*.mjs:308-327`). **An attachment puts the PDF's bytes in Composio's S3.** No TTL or size limit documented for the upload itself — https://docs.composio.dev/reference/api-reference/files.
- Our file store caps files at 20 MB (under Gmail's ~25 MB after base64).

### What the seat can do today

draw a PDF (run_command + reportlab) → `save_file` → file id → `spine-link_file` (customer/job/visit/ledger entry) → `send_file` / `share_file` to the manager's chat. It cannot attach the file to an email, and nothing ties a sent email to an invoice.

### What a technician sees

Money status in words (`technicianMoneyView`), amounts only when `viewShowsMoney` (firm rule, job/customer grant, person-wide grant); the job's `invoiced`/`paid` status; a PDF linked only to a job/visit/customer in her view **is visible** — hidden only when linked to a ledger entry closed to her (`files.ts:114-122`).

## External Dependencies

- Composio (Gmail toolkit; file upload to Composio S3), `@composio/core` 0.13.1.
- Gmail API limits (~25 MB per message after base64).
- Supabase Storage (`files` bucket) for the PDF itself.
- E2B sandbox (reportlab to draw, pypdf to read).

## Constraints and Invariants

- `money_events` is append-only; corrections are new rows (`correction`, `invoice_voided`, one level). `job_id` RESTRICT. The ledger is "memory reconciled against the firm's books, not the books" (`engineering-memory.md:632-643`) and **workflow-agnostic** (`:645-654`): estimate-first, deposits, progress billing are orderings of the same kinds.
- `dedupe_key` exists (partial unique) but no live writer sets it; `record_money_event` always reports success once a row lands.
- `send_email`'s confirm is at-most-once (token consumed before the send); a failed send must be re-staged.
- Email goes from the PERSON's paired Gmail (per-person Composio connected account), never a firm address.
- Technicians never see amounts by default; the money rule for the office/planner is prompt-only ("nothing downstream checks it").
- The 2d file store's link table has one FK column per target and "2e adds invoice_id / estimate_id the same way" (`files.sql:38`).

## Decision Points

1. **What an invoice/estimate record is.** (a) New `invoices` and `estimates` tables (number, status draft/sent/void, customer, job, line items, totals, recipient, the PDF's file id, the ledger entry it produced). (b) One `documents` table with a kind column. (c) Keep them as ledger rows only, with the lines in `detail`. The 2026-08-15 draft chose (a) for invoices.
2. **Line items.** Stored as JSON on the record vs a `…_lines` table; whether tax is a line, a rate, or not ours (the firm's template/books decide).
3. **Numbering.** Per-firm sequence assigned at send (the 2026-09-23 ruling) — needs a place for the next number and the starting number (tenant_profiles has none); estimates numbered the same way or not at all.
4. **How the ledger is written.** Sending an invoice writes `invoice_issued` (amount = the record's total, `external_ref` = its number, a `dedupe_key` so a retry cannot double it). Whether presenting/sending an estimate writes `estimate_presented`, and whether "the customer accepted" writes `estimate_approved` (which is what `quoted` reads). What happens to a direct `record_money_event(invoice_issued)` for an invoice sent another way (the ruling allows it, with `external_ref`).
5. **The Approve.** Today a typed yes. Options: keep the staged-preview + typed yes (as send_email works); a dedicated Approve button on the send (the ruling's wording; would need the glue to recognise a staged send — nothing does today); or the plan's Go.
6. **Attachments.** Extend `send_email` with a file id (the spine reads the bytes from Storage, uploads to Composio with `files.upload`, passes the descriptor) vs a separate `send_invoice`/`send_document` tool that does send + record in one step. Either way the bytes go to Composio's S3. Whether to upgrade `@composio/core` (0.13.1 → 0.22.0) first.
7. **The side doors.** The manager can send Gmail directly via Composio (no staging, no invoice write, sends captured without job/thread). Options: leave it (the rulebook says to use the spine for invoices), or block `GMAIL_SEND_EMAIL` on the relay as the workbench is blocked. And whether the rulebook forbids `record_money_event(invoice_issued)` while drafting.
8. **What the bot draws from.** The firm profile (the pilot firm reportedly has none — `engineering-memory.md:1935-1936`), the customer, the job, line items the manager gives or the ledger's uninvoiced amounts; payment terms today live only in seat memory.
9. **Who sees an invoice/estimate record.** Managers; technicians status-only by default — the record, its lines and its PDF follow `viewShowsMoney`.

## Open Questions

- Which Composio doc is right about auto-upload (the installed 0.13.1 code has it off) — and whether 0.22.0 changes `files.upload`.
- Whether the Composio execution log reports an inner `GMAIL_SEND_EMAIL` or `COMPOSIO_MULTI_EXECUTE_TOOL` for a manager's direct send (if the latter, logIngest skips it as a read and the send is never captured).
- Whether the pilot firm has a firm profile now (read-only check).
- Whether HTML bodies are wanted (Composio supports `is_html`; today plain text only).
