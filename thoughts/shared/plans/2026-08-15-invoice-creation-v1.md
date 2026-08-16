---
date: 2026-08-15
task: Invoice creation v1 — firm profile, ledger-drafted invoices, PDF render, delivery via the audited Gmail send, synchronous invoice_issued event
research: thoughts/shared/research/2026-08-15-invoice-creation.md
status: draft
depends: 2026-08-15-money-ledger-v1.md (part A, hard) + 2026-08-15-firm-profile-v1.md (tenant_profiles); stacks after part B (same send seam — re-check anchors after it lands)
---

## Overview

Generate a customer-facing invoice from a job's money ledger and deliver it as a PDF attached
to the existing staged, audited Gmail send — recording its own `invoice_issued` event
synchronously. Includes the firm-identity profile the document legally needs, per-firm
sequential numbering, and per-line taxability. The spine's first customer-facing artifact.

## Decisions

- **Delivery: PDF attached to the existing Gmail send (user choice, 2026-08-15).** Hosted
  pay-link pages deferred (would be the first customer-facing route + capability-URL design).
- **Line items: ledger-drafted, manager-edited (user choice).** Drafted from the job's money
  events; the manager edits lines and per-line tax before confirming. Superset of free-form
  (empty ledger = empty draft); the final edited total is what `invoice_issued` records.
- **Sender: the manager's connected Gmail (user choice).** Firm-mailbox = recorded upgrade path
  (sentinel roster row via the phone-line + `seat_exempt` precedents, or pair a firm Gmail as
  the manager's account today) — not built now.
- **Numbering: per-firm sequential `INV-1001` (user choice).** `number_seq int` +
  `unique (tenant_id, number_seq)`; mint = max+1 with insert-retry on 23505
  ([20260804120000:55-58](supabase/migrations/20260804120000_phone_call_ingest.sql#L55-L58)
  idiom), starts 1001, minted at CONFIRM — abandoned drafts leave no gaps.
- **Attachment capability stays internal.** `SendEmailInput` gains an optional attachment; the
  agent-facing `send_email` tool schema is NOT widened — only the invoice flow attaches files.
- **Renderer: `@react-pdf/renderer` (+ `react`, headless).** Active, native ESM, no native
  build, declarative layout for variable-length tables; alternatives lose (pdfkit = manual x/y,
  pdf-lib dormant, browser engines ~300 MB). Needs `"jsx": "react-jsx"` in tsconfig.
  Render-verification parses the PDF back with the existing `pdf-parse` dependency.
- **Firm identity lives in `tenant_profiles`** — split into its own prerequisite plan for size
  ([2026-08-15-firm-profile-v1.md](2026-08-15-firm-profile-v1.md)); rendering warns on profile
  gaps, never blocks.
- **Invoice document: own `invoices` table** (number, recipient, line-items JSONB, totals, PDF
  path, sent message id, money-event link). Mutable artifact record; money *truth* stays in the
  append-only ledger.
- **Tax: per-line, manager-entered cents. No rate engine.** The domain requires per-line
  taxability (TX/FL/NY split labor vs parts); computing rates is out of scope.
- **PDF storage: new private bucket `invoice-docs`** (env-overridable, `call-audio` precedent),
  path `invoices/<tenant_id>/<invoice_number>.pdf`. **Kept forever** — business records; no
  purge wiring, unlike call audio.
- **Composio attachment: manual `composio.files.upload` staging** (`{name, mimetype, s3key}`),
  not the `dangerouslyAllowAutoUploadDownloadFiles` flag. First implementation step: the
  one-shot `tools.get('GMAIL_SEND_EMAIL')` schema dump the research flagged.
- **Crash convergence covers BOTH windows** (review finding — the post-send tail was
  unrepairable): order = consume → mint → render/upload → send → `markInvoiceSent` → money
  event → L1. The stage-time probe `findIncompleteInvoiceForJob` catches `sent_message_id
  null` (resend flow) AND sent-but-`money_event_id`-null (complete the bookkeeping WITHOUT
  re-sending). Event append catches 23505 on `dedupe_key 'invoice:<invoiceId>'` and re-reads
  the existing event; the L1 `externalId sent:<messageId>` dedupes.
- **Part B never double-records a spine invoice** (review finding: the dedupe keys differ, so
  collapse was a false claim): `applyMoneyInference` skips captures stamped
  `metadata.invoiceNumber` — amendment recorded in part B's plan.
- **Un-sendable invoices have an exit** (review finding: a bad recipient looped forever and
  blocked the job): outbound capability + recipient sanity are checked at STAGE; re-staging an
  unsent invoice may override `to`/`lines`; `discardUnsent: true` stamps `discarded_at` and
  frees the job for a fresh invoice (the dead number is an accepted crash-style gap).
- **`create_invoice` takes `progress?`** threaded into the event — a deposit/milestone invoice
  must not walk status (part A's guard applies to spine-issued invoices too).
- **No AI anywhere in this flow** — drafting is pure code; amounts are manager-confirmed.
- **Migration timestamps below are illustrative** — pick real ones at implementation time,
  sorting after part A's landed filenames (`20260815120000` is already taken).

## Plain-language walkthrough

*(The firm's letterhead data — `tenant_profiles` + `set_firm_profile` — is its own
prerequisite plan, split out for size.)*

**Phase 1 — the invoice record and the draft.** An `invoices` table with per-firm sequential
numbers, plus a pure drafting function turning the job's money events into editable lines.
Payments aren't lines — the PDF shows totals, then payments-to-date and balance due (part A fold).

**Phase 2 — the document itself.** A React-PDF template renders header, license numbers, lines,
totals, and footer to a PDF buffer (a test parses it back to prove the content landed), stored
in a private `invoice-docs` bucket, forever.

**Phase 3 — sending it, and closing the loop.** A staged `create_invoice` tool: stage drafts
lines and shows a full preview (recipient defaults to the customer's email on file); the manager
edits by re-staging; confirm mints the number, renders, uploads, sends with the PDF attached,
records `invoice_issued` (walking job status via part A), and lands the L1 capture. Part B never
infers it — spine-issued send captures are stamped and skipped.

```
STAGE ──► draft lines from ledger ──► preview + confirmId (edit = re-stage)
CONFIRM ─► consume ─► mint INV-#### ─► render PDF ─► upload ─► Gmail send + attachment
         ─► invoice_issued event (status walks) ─► L1 outbound_email capture
```

## Secrets & env preflight

- **Phases 1–2:** none new. Optional env: `INVOICE_DOCS_BUCKET` (defaults `invoice-docs`).
- **Phase 3:** `COMPOSIO_API_KEY` (`already required`) — optional live-send E2E only (needs a
  paired manager account); tests inject `deps.sendEmail`.

## Phase 1: `invoices` table, numbering mint, ledger drafting

### What this phase does
The invoice record with race-safe per-firm numbering, and the pure draft-from-ledger function.

### Changes required

**`supabase/migrations/20260815140000_invoices.sql`** (new; timestamp illustrative)
- `create table invoices (id uuid primary key default gen_random_uuid(), tenant_id uuid not
  null references tenants(id), job_id uuid not null references jobs(id) on delete restrict,
  number_seq integer not null, invoice_number text not null, recipient_email text not null,
  line_items jsonb not null, subtotal_cents integer not null, tax_cents integer not null
  default 0, total_cents integer not null, money_event_id bigint references money_events(id),
  pdf_path text, sent_message_id text, discarded_at timestamptz, issued_at timestamptz not
  null default now(), created_at timestamptz not null default now(), updated_at timestamptz
  not null default now());` + `unique (tenant_id, number_seq)`, `unique (tenant_id,
  invoice_number)`, index `(tenant_id, job_id)`, `set_updated_at` trigger.
- View `v_invoices` (tenant-GUC filtered) + `spine_reader` grant
  ([20260812110000:60-89](supabase/migrations/20260812110000_v_schedule_excludes_cancelled.sql#L60-L89) pattern), documented in the `query_spine` tool description + view count (part A's
  convention for any new `spine_reader` view).

**`src/db/invoices.ts`** (new)
- `InvoiceLine { description: string; amountCents: number; taxable: boolean;
  taxCents: number }`; totals helper `computeTotals(lines)` (pure; `total = Σamount + Σtax`).
- `mintInvoice(input)` — reads `max(number_seq)` for the tenant (default 1000), inserts with
  `number_seq = max+1`, `invoice_number = 'INV-' + seq`; on 23505 re-read and retry (cap 5).
- `getInvoice`, `listInvoicesForJob`, `findIncompleteInvoiceForJob(tenantId, jobId)`
  (`discarded_at is null AND (sent_message_id is null OR money_event_id is null)` — the
  recovery probe), `updateUnsentInvoice(id, {recipientEmail?, lineItems?, totals?})` (refuses
  once sent), `discardUnsentInvoice(id)`, `markInvoiceSent`, `setInvoicePdfPath`,
  `setInvoiceMoneyEvent`. Export from [src/db/index.ts](src/db/index.ts). Regenerate
  `database.types.ts` (`npx supabase db reset` + `npm run gen:types:local`).

**`src/money/draftInvoice.ts`** (new) — pure `draftInvoiceLines(events: MoneyEvent[]):
InvoiceLine[]`. Drafts only the **uninvoiced tail**: events after the latest `invoice_issued`
(all events if none — review finding: progress-billed invoice #2 must not re-draft the whole
contract). Within that window, part A's fold semantics: last `estimate_approved` → one line,
change orders only AFTER that approval, each `fee_charged` → a line; voided/corrected folded
out; payments/credits/write-offs are NOT lines. Draft lines start `taxable: false,
taxCents: 0` — tax is the manager's edit.

### Automated verification
- [ ] Gates pass; `invoices.test.ts`: mint 1001→1002; concurrent-mint race → distinct seqs,
  one retried; totals math incl. per-line tax
- [ ] `draftInvoice.test.ts`: the five part-A archetype event lists → expected lines; voided
  estimate excluded; superseded change order excluded; progress-billed invoice #2 drafts only
  the uninvoiced tail; empty ledger → empty draft

### Live verification (agent-executable)
- Prerequisites: local stack.
- [ ] Mint via typed layer → psql read-back; evidence: rows with consecutive numbers.

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 2: PDF template + storage

### What this phase does
Renders the invoice PDF (headlessly, no AI) and stores it in a private bucket, forever.

### Changes required

**`package.json` / `tsconfig.json` / `eslint.config.js`** — add `@react-pdf/renderer` +
`react` + **`@types/react` (devDep — typecheck fails without it under `react-jsx`)**; set
`"jsx": "react-jsx"`; widen the eslint `files` glob to `src/**/*.{ts,tsx}` (it currently
covers only `.ts`, so the template would be silently unlinted).

**`supabase/migrations/20260815150000_invoice_docs_bucket.sql`** (new) — `insert into
storage.buckets (id, name, public) values ('invoice-docs','invoice-docs', false) on conflict
do nothing;` (same migration-role caveat comment as
[20260804120000:93-96](supabase/migrations/20260804120000_phone_call_ingest.sql#L93-L96)).

**`src/money/invoicePdf.tsx`** (new) — `renderInvoicePdf(input: {profile, customer,
invoiceNumber, lines, totals, paymentsToDateCents, balanceDueCents, issuedAtISO}):
Promise<Buffer>` via `@react-pdf/renderer`'s `renderToBuffer`. Caller computes
`balanceDueCents = thisInvoiceTotal + fold.invoicedCents − fold.paidCents − credits −
write-offs` (pre-issuance fold **plus this invoice** — review finding: the raw fold alone
reads $0 on a firm's first invoice and negative on deposit-then-final). Layout: profile header (name,
address, phone, email), license numbers line, customer + job-site block, invoice number/date,
line table (description, amount, tax), subtotal/tax/total, payments-to-date + balance due,
`disclosure_footer` verbatim at the bottom. Missing profile fields render as blanks (gaps are
warned at the tool layer, never block).

**`src/money/invoiceStorage.ts`** (new) — `uploadInvoicePdf(tenantId, invoiceNumber, buf)` →
`getClient().storage.from(bucket).upload('invoices/<tenantId>/<invoiceNumber>.pdf', buf,
{contentType: 'application/pdf', upsert: true})` ([fetchRecording.ts:29-33](src/calls/fetchRecording.ts#L29-L33) pattern); bucket = `process.env.INVOICE_DOCS_BUCKET ?? 'invoice-docs'`.
No purge, no retention columns — permanent by decision.

### Automated verification
- [ ] Gates pass (build now compiles `.tsx`)
- [ ] `invoicePdf.test.ts` smoke: render a fixture → parse the buffer back with the existing
  `pdf-parse` dependency → assert invoice number, a line description, total, license number,
  and footer text all present; second render with empty profile → still a valid PDF
- [ ] `invoiceStorage.test.ts` (local stack): upload → `createSignedUrl` → fetch → byte-length
  matches

### Live verification (agent-executable)
- Prerequisites: local stack (storage enabled).
- [ ] Upload then psql `select * from storage.objects where bucket_id='invoice-docs'`;
  evidence: object row + signed-URL fetch status 200.

### Manual verification
- [ ] Open one rendered PDF and judge the layout (spacing, wrapping of a long line
  description, footer legibility) — first customer-facing artifact; a human must look at it.

---
*Pause after this phase — the PDF layout check is genuinely human.*

## Phase 3: `create_invoice` tool — stage, edit, send, record

### What this phase does
The end-to-end flow: draft → preview → confirm → mint → render → upload → send with attachment
→ `invoice_issued` → L1 capture → status walk. Plus docs.

### Changes required

**`src/composio/outbound.ts`** — extend `SendEmailInput`
([outbound.ts:16-20](src/composio/outbound.ts#L16-L20)) with
`attachment?: { filename: string; mimetype: string; content: Buffer }`. In
`liveSendGmailEmail`: when present, stage via `composio.files.upload({file: new File([content],
filename, {type: mimetype}), toolSlug: 'GMAIL_SEND_EMAIL', toolkitSlug: 'gmail'})` and pass the
returned `{name, mimetype, s3key}` as `arguments.attachment`
([outbound.ts:49-54](src/composio/outbound.ts#L49-L54)). **First implementation step:** one-shot
`client.tools.get(...,'GMAIL_SEND_EMAIL')` schema dump to confirm the parameter name/shape
(research caveat); record the output in the PR description. The agent-facing `send_email` tool
schema ([server.ts:474-492](src/mcp/server.ts#L474-L492)) is NOT changed.

**`src/db/reviewItems.ts`** — add `'pending_invoice'` to `ReviewKind` (staged token).

**`src/mcp/server.ts`**
- `create_invoice` in `ADMIN_TOOLS`: args `jobId`, optional `lines`
  (`{description, amountCents, taxable, taxCents}[]`), `to`, `progress`, `discardUnsent`,
  `confirmId?`.
  - STAGE (no `confirmId`): tenant-guard job → `requireOutboundCapable(caller)` + recipient
    format sanity HERE, not only inside the send (review finding: an unpaired mailbox or bad
    address must fail before a number is minted) → `findIncompleteInvoiceForJob`: unsent →
    preview THAT invoice (`to`/`lines` args override it via `updateUnsentInvoice`;
    `discardUnsent: true` stamps `discarded_at` and falls through to a fresh draft);
    sent-but-unrecorded → preview "completing bookkeeping only". Else lines = caller `lines`
    ?? `draftInvoiceLines(events)`; recipient = `to` ?? `customer.email` (absent ⇒
    instructive error); reply = full preview + `profileGaps` + `confirmId`. Re-stage
    supersedes the token ([server.ts:2355-2361](src/mcp/server.ts#L2355-L2361) idiom); the
    staged copy is the record.
  - CONFIRM: token lookup + 15-min TTL ([server.ts:2385-2399](src/mcp/server.ts#L2385-L2399)
    idiom) → consume → if sent-but-unrecorded, skip straight to bookkeeping. Else mint (skip
    when resending) → `getTenantProfile` + `renderInvoicePdf` → `uploadInvoicePdf` +
    `setInvoicePdfPath` → `sendGmailEmail` (the outbound.ts export; `liveSendGmailEmail` is
    its server.ts import alias) with subject `Invoice <number> — <firm name>`, plain-text
    summary body, attachment → `markInvoiceSent`. Bookkeeping:
    `appendMoneyEvent({kind:'invoice_issued', amountCents: total, progress, externalRef:
    invoice_number, dedupe_key: 'invoice:<invoiceId>', detail:{invoiceId}})` **catching 23505
    → re-read the event by dedupe_key and continue** → `setInvoiceMoneyEvent` →
    `syncJobStatusForMoney` → L1 capture ([server.ts:2437-2456](src/mcp/server.ts#L2437-L2456)
    idiom; metadata incl. `invoiceNumber` — part B's skip stamp) → reply: sent, number, total,
    status move, gaps. Send failure after mint: reply names the number; re-stage resends.
- `resolve_review`: add `pending_invoice` to `STAGED_ACTION_KINDS`
  ([server.ts:6345-6356](src/mcp/server.ts#L6345-L6356)) so `resolved` is refused with a
  pointer at `create_invoice`.

**Docs** — [docs/customer-onboarding-runbook.md](docs/customer-onboarding-runbook.md) +
[docs/getting-started-for-firms.md](docs/getting-started-for-firms.md): invoices exist
(PDF via the manager's Gmail; still no payment processing); firm-profile setup step;
[docs/engineering-memory.md](docs/engineering-memory.md) live-state entry.

### Automated verification
- [ ] Gates pass. `server.test.ts` (`deps.sendEmail` injected): stage→preview with drafted
  lines; edited re-stage supersedes; confirm mints + "sends" + money event + L1 + status walk,
  all read back; TTL expiry; technician refused; `progress: true` → event recorded, NO status
  walk; PDF balance: first invoice = total, deposit-then-final = total − deposit
- [ ] Crash paths: send-failure after mint → re-stage previews unsent, confirm resends without
  re-minting; failure after `markInvoiceSent` → re-stage completes bookkeeping with NO resend;
  double-confirm converges (23505 caught); bad recipient / unpaired mailbox rejected at STAGE
  (nothing minted); `discardUnsent` frees the job for a fresh invoice
- [ ] Money event carries `externalRef` = invoice number; L1 capture carries
  `metadata.invoiceNumber` (part B's skip stamp)

### Live verification (agent-executable)
- Prerequisites: local stack; OPTIONAL live send needs `COMPOSIO_API_KEY` + a paired account —
  if absent, STOP and name it (missing-capability rule), don't fake it.
- [ ] Full flow with injected sender on local stack: psql read-backs of `invoices`,
  `money_events`, `raw_captures`, `jobs.status`; evidence: rows + the tool replies.
- [ ] (If live capability present) one real send to a test mailbox; evidence: received email
  with PDF attached + `sent_message_id` stamped.

### Manual verification
- [ ] Read the preview and sent email as a manager would: is the edit loop obvious? Does the
  plain-text body read well next to the PDF?

---
*Pause after Phase 3 for the manual read-through.*
