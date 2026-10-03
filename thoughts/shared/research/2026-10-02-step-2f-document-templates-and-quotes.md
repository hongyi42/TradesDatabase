---
date: 2026-10-02
branch: (detached at origin/main)
commit: 478faf8
topic: Step 2f — invoice, estimate and quote templates, and a binding QUOTE kind
supersedes: nothing
---

# Step 2f — document templates and quotes (research)

## Summary

Today a manager's assistant makes an invoice or estimate PDF by **writing a fresh Python
program every time**. The bot's rulebook gives it a five-line recipe ("read the firm's details,
draw it with reportlab marked DRAFT, show it, then draw it again with its number, save it and
attach it"), and the model writes its own reportlab layout code inside the manager's E2B sandbox
(E2B = a hosted throwaway Linux computer, one per manager, with no internet). There is no stored
layout, no helper script, no logo, and nothing that makes two invoices from the same firm look
alike. The **record** behind the PDF is solid and separate: `money_documents` (step 2e) holds the
kind (`invoice` | `estimate`), the lines, the total, the number (INV-/EST-, per firm and kind), the
status (draft → issued → void) and an estimate's outcome; issuing writes the money ledger. The
firm's letterhead details live in `tenant_profiles`. Files (the finished PDF) live in the 2d file
store and hang on the document through `file_links.document_id`. **The closest existing pattern
for "a house style everyone gets" is the `spreadsheet` skill**: a folder of instructions plus a
helper script, copied into every manager's sandbox, that turns data into a styled file. Quotes do
not exist anywhere in the code: "quoted" today is a *ledger figure* (the job's last approved
estimate), not a document kind.

## Entry Points

- `src/seatGlue/doctrine.ts:201-205` — the DRAWING AN INVOICE OR ESTIMATE recipe (in
  `FILES_SECTION`, said only to a manager seat that has the sandbox).
- `src/seatGlue/doctrine.ts:161-176` — MANAGER_PREAMBLE's INVOICES AND ESTIMATES paragraph (when
  to draft, issue, record an outcome, void; the sent-invoice rules).
- `src/mcp/tools/documents.ts:32-136` — the five manager-only tools: `draft_document`,
  `issue_document`, `void_document`, `record_estimate_outcome`, `list_documents`.
- `src/mcp/tools/roster.ts:204` — `set_firm_profile` (reads with no args, patches with args).
- `src/seatGlue/fileTools.ts:178-420` — sandbox tools `run_command`, `read_file`, `write_file`,
  `share_file`, `export_query`, `save_file`, `open_file`.
- `Box_Setup_Stuff/seat-glue/skills/` — the skill folders (`spreadsheet/`, `batching/`).

## Key Files

| File | Role |
|---|---|
| `supabase/migrations/20260929120000_money_documents.sql` | `money_documents` table (`:10-44`): `kind check in ('invoice','estimate')` (`:13`), `status draft/issued/void` (`:18`), `number_seq`/`number` (`:20-21`), `lines jsonb` (`:23`), `total_cents` (`:24`), `notes` (`:25`), `progress` (`:31`), `outcome` only for estimates, `accepted`/`declined` (`:40-41`); number iff issued (`:42`); unique `(tenant_id, kind, number_seq)` (`:46-48`). Adds `tenant_profiles.invoice_start` / `estimate_start` default 1001 (`:59-61`); `file_links.document_id` (`:64-71`); `files.source 'email'`, `source_ref`, `manager_only` (`:76-83`). |
| `src/db/moneyDocuments.ts` | Typed layer. `MoneyDocumentKind = 'invoice' \| 'estimate'` (`:26`); `DOCUMENT_KINDS` (`:44`); `PREFIX = {invoice:'INV', estimate:'EST'}` (`:46`); `normalizeLines` (`:60-97`, line = `{description, quantity, unitCents, amountCents}`, ≤100 lines, total worked out); `saveDraft` (`:182`); `nextNumberSeq` = `max(start, highest+1)` (`:241-255`); `issueDocument` (`:307`) writes `invoice_issued` or `estimate_presented` (`:375`); `voidDocument` (`:492`); `recordEstimateOutcome` (`:538-600`) writes `estimate_approved` for the total ("this is what sets `quoted`", `:532-533`) or `estimate_declined`; `numberCandidates` adds `INV-`/`EST-` variants of a bare number (`:625-640`); `namesIssuedNumber` (`:657`). |
| `src/mcp/tools/documents.ts` | Tool schemas and replies. `kind` enum `['invoice','estimate']` (`:46`); issue's reply tells the model to "draw the final PDF with this number, save_file it and link_file it" (`:243-245`); `recorded` wording per kind (`:237`). All in `admin` (managers only, `:309-318`). |
| `src/db/moneyEvents.ts` | Ledger. `MONEY_EVENT_KINDS` (`:11-29`) has `estimate_presented/approved/declined`, `change_order`, no quote kinds. `summarizeMoney` (`:483-525`): `quotedCents` = the last live `estimate_approved` plus later `change_order`s (`:489-500`). Status word "quoted, nothing invoiced yet" (`:668`, `:706`). |
| `supabase/migrations/20260815160000_money_events.sql` | `money_event_kind` is a Postgres **enum** (`:12-25`) — adding a kind is an `alter type … add value`. |
| `src/db/tenantProfiles.ts` | Firm letterhead: display/legal name, address, phone, email, `license_numbers` list, `disclosure_footer` (`:22-38`), plus `invoiceStart`/`estimateStart` (`:62-65`). `documentStart(tenantId, kind: 'invoice' \| 'estimate')` (`:224-228`). `profileGaps` (`:236-264`). No logo, colour, font, terms or template field. |
| `supabase/migrations/20260815180000_tenant_profiles.sql` | The table (`:10-28`). |
| `src/db/files.ts` | File store. A target is one of customer / job / visit / money event / document (`:31`, `:48`); a document link resolves as kind `money` (`:30`) — technicians never see it. |
| `src/mcp/tools/files.ts` | `link_file` takes `documentId` ("An invoice or estimate id (managers only)", `:30`). |
| `src/seatGlue/fileTools.ts` | `save_file` (`:374-397`): sandbox file → file store, returns a file id; `open_file` (`:399-420`): stored file → `/home/user/files/<id8>-<name>`; `export_query` (`:336-365`): firm data → CSV in the sandbox. |
| `src/seatGlue/sandbox.ts` | One E2B sandbox per manager, pauses when idle, no internet (`:156-162`). `syncSkills` (`:180-200`) copies the box's skill folders **as bytes** into `/home/user/skills` when their fingerprint changes ("a binary file (a template, a font) must arrive intact", `:193`). |
| `src/seatGlue/engine.ts` | Lists skills in the rulebook (`skillsSection`, `:109-116`) and enables them only for a seat with sandbox tools (`:201`, `:214`, `:221`). |
| `Box_Setup_Stuff/seat-glue/skills/spreadsheet/` | `SKILL.md` (house style + steps) and `csv_to_xlsx.py` (the helper that applies it). The precedent for a house-style document skill. |
| `Box_Setup_Stuff/seat-glue/stage.sh:32-34`, `install.sh:70` | Skills are staged with the glue and installed on the box per seat. |
| `Box_Setup_Stuff/seat-glue/e2b-template.mjs:27-29` | Sandbox image: Python 3.12 + `openpyxl, xlsxwriter, reportlab, pypdf, pandas`. No `python-docx`, no LibreOffice, no extra fonts. Rebuilt from a laptop. |
| `src/inbound/outboundInvoice.ts` | The sent-mail detector: `looksLikeInvoice` = a PDF attached or the word "invoice" (`:24-33`); raises `outbound_invoice` only. |

## Data Flows

**Making an invoice today (manager on Telegram):**

```
manager: "invoice Tom for the inspection"
  → model: spine-draft_document(kind, jobId, lines)        → money_documents row (draft, no number)
  → model: spine-set_firm_profile()  (read)                  → letterhead fields
  → model: write_file / run_command  "python3 <its own reportlab script>"   (in E2B)
  → model: share_file(draft.pdf)                             → PDF in the chat, marked DRAFT
manager: "final"
  → model: spine-issue_document(documentId)                  → number INV-1001 + ledger invoice_issued
  → model: run_command again (re-draw with the number)
  → model: save_file(final.pdf) → file id → spine-link_file(fileId, documentId)
  → optional: spine-send_email(fileId) — delivery only
```

The layout code is written by the model. Nothing on the box or in the database keeps it as a
template; a script it wrote may happen to survive in that manager's sandbox (`/home/user/files`
persists across pauses, `sandbox.ts:5-11`), but nothing tells the model to reuse it, and a new
sandbox starts without it. The deliberate persistent influences are the profile row and the
manager's seat memory notes ("invoices are due in 14 days", doctrine `:130-134`).

**Estimate outcome → quoted:** `record_estimate_outcome(accepted)` →
`estimate_approved(amount = total, externalRef = EST-…)` → `summarizeMoney` makes it the job's
`quotedCents`; a later approval replaces it; `change_order`s add after it.

**Skills reaching the sandbox:** repo `Box_Setup_Stuff/seat-glue/skills/<name>/` → `stage.sh` →
box `/opt/seat-glue/…/skills` (`install.sh:70`) → on first tool use per process, `syncSkills`
copies the bytes to `/home/user/skills/<name>/` → the model runs
`python3 /home/user/skills/<name>/<script>.py …`. The same set reaches **every** manager of
**every** firm; there is no per-firm skill.

**A firm's own file reaching the sandbox:** the manager sends it on Telegram (kept in the file
store as it arrives) → `open_file(fileId)` writes it under `/home/user/files/`. Per firm, but
only on demand, and named `<id8>-<name>`.

## External Dependencies

- **E2B** sandbox SDK 2.51.0 (template `trades-manager`; no internet inside).
- **reportlab** (drawing) and **pypdf** (reading) in the template; reportlab ships only the
  standard 14 PDF fonts unless a font file is supplied.
- **Supabase Storage** bucket `files` (via Render's `/seat/files`).
- **Composio Gmail** for `send_email` with `fileId` (delivery).

## Constraints and Invariants

- **The kind list is closed in four places:** the SQL check (`money_documents.sql:13`), the TS
  union and `DOCUMENT_KINDS` (`moneyDocuments.ts:26,44`), `PREFIX` (`:46`), and the tool enum
  (`documents.ts:46`). `documentStart` and the profile only know `invoice_start` /
  `estimate_start`; `numberCandidates` only adds `INV-`/`EST-`.
- **Outcome is estimate-only** (`money_documents.sql:40-41`; `moneyDocuments.ts:549`).
- **Issuing writes exactly one ledger kind per document kind** (`moneyDocuments.ts:375`); the
  ledger kinds are a Postgres enum, and `summarizeMoney` derives `quoted` from
  `estimate_approved` only.
- **Numbers are never reused** (void keeps its number; `max(start, highest+1)`), unique per
  `(tenant, kind)`.
- **Drawing needs the sandbox.** A manager seat without the E2B key gets no FILES section and no
  skills (`engine.ts:157`, `:201`), so it cannot draw any document.
- **No internet in the sandbox:** fonts, logos and libraries must be baked into the template,
  copied in as a skill, or opened from the file store.
- **Technicians never see documents** (admin-tier tools; document links resolve as money).
- The sent-mail detector recognises invoices only (`outboundInvoice.ts`); an estimate or quote a
  manager emails from Gmail is captured as an email but raises nothing money-related.

## Decision Points

1. **What "the default template" is.**
   (a) A skill folder like `spreadsheet/`: `SKILL.md` + a Python script taking the document's
   data (lines, totals, number, profile) and drawing a fixed house layout with reportlab — the
   model calls it instead of writing layout code. (b) A renderer on Render (Node) that produces
   the PDF from the record and stores it directly, outside the sandbox. (a) reuses the sandbox,
   the skill copy and `save_file`; (b) would make drawing independent of E2B (a seat without the
   sandbox could produce documents) but is a new server-side PDF path.
2. **How the template gets the document's data.** Today nothing hands a document to the sandbox
   except the model typing values or `export_query` (CSV over `v_*` views — there is no
   `v_money_documents` view). Options: a view so `export_query` can pull it; a new glue tool that
   writes the document + profile as JSON into the sandbox; or the model passes values on the
   script's command line.
3. **What a "custom template" is**, given what the sandbox can read: (a) a sample PDF or image of
   the firm's current invoice that the model imitates in its own reportlab code (pypdf reads the
   text, not the layout); (b) settings on the house template (logo file, colour, fonts, terms,
   footer) stored per firm; (c) a fillable file — a PDF form (pypdf can fill AcroForm fields) or a
   Word file (needs `python-docx` plus a converter such as LibreOffice, neither installed, and
   the template rebuild). Each needs a place to keep the firm's choice: today there is no field on
   `tenant_profiles` and no per-firm skill.
4. **Where a firm's template assets live.** The file store (per firm, deletable, `open_file`
   brings them in) vs new `tenant_profiles` columns (logo file id, colours, terms) vs a per-firm
   folder copied in like skills (the skill copy is box-wide today, not per firm).
5. **Quote as a kind.** Adding `quote` touches: the SQL check (`:13`), the outcome check
   (`:40-41`, if quotes are accepted/declined), the TS union/`DOCUMENT_KINDS`/`PREFIX` (QUO-), a
   `quote_start` column + `documentStart` + `set_firm_profile`, the tool enum and wording,
   `numberCandidates`, the doctrine, and `list_documents`. **Which ledger kinds a quote writes** is
   open: reuse `estimate_presented/approved/declined` (then `quoted` cannot tell a ballpark from a
   binding price), or add `quote_presented/approved/declined` to the enum and decide in
   `summarizeMoney` whether an accepted quote, an accepted estimate, or both set `quotedCents`.
6. **Whether an accepted estimate keeps setting `quoted`.** The operator's definition (estimate =
   ballpark, not binding; quote = the price) and today's code (an accepted estimate becomes the
   job's quoted amount) point in different directions once quotes exist.
7. **Estimate vs quote templates:** one layout with a different title/terms, or separate
   layouts (a quote typically carries binding terms, validity date, acceptance signature line).
8. **Manager-sent quotes/estimates from Gmail:** the detector only knows invoices; whether 2f
   widens it is open.

## Open Questions

- Do the pilot managers already have a template in another tool (Jobber, QuickBooks), and in what
  form would they hand it over (PDF, Word, a screenshot)? The operator's Jobber screenshot
  (2026-09-30) was never readable from the session.
- Does a quote expire (a "valid until" date), and is that a field on the record or text on the
  PDF?
- Can reportlab, with only the built-in fonts, produce a house layout the operator accepts, or
  does the template need font files (which then ride in the skill folder or the E2B image)?
- Should the finished PDF be re-drawn from the record whenever asked (deterministic template) or
  kept as the one saved file (today's behaviour)?
