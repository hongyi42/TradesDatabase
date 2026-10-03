---
date: 2026-10-02
task: Step 2f — a house template and a firm's own template for invoices, estimates and quotes; quotes as a binding third kind
research: thoughts/shared/research/2026-10-02-step-2f-document-templates-and-quotes.md
status: draft
supersedes: nothing
---

## Overview

Today the assistant writes a new drawing program for every invoice or estimate, so documents
look different each time and drafting is slow. This plan adds a **house template**, lets a firm
switch to **its own template** (built once from its current invoice, approved, reused), and adds
**quotes**: binding, numbered QUO-, and the first source of the job's quoted price.

## Decisions

- **Default template = a script on the sandbox** (operator, 2026-10-02). A `documents` skill
  folder (like `spreadsheet/`) holding `render_document.py`; the assistant runs it instead of
  writing layout code. Rejected: a PDF maker on Render (a second PDF path to build; a seat
  without the sandbox cannot draw today either).
- **Custom template = the assistant copies the firm's sample** (operator, 2026-10-02). Built once
  as a Python module, shown as a sample, saved only after the manager approves, recorded on the
  firm profile, then used for every document. Rejected: settings on our layout; a fillable PDF
  form. Operator asked about speed: once built, a custom template is as fast as the default (the
  drawing is ~1–2 s; the turn is mostly the model).
- **Quoted price: an accepted quote first, else an accepted estimate** (operator, 2026-10-02).
  Quotes get their own ledger kinds, so the books tell a binding price from a ballpark.
- **Quote vs estimate on paper: the title only** (operator, 2026-10-02). Same layout, titled
  QUOTE and numbered QUO-; no validity date, no signature line.
- **One custom template covers all three kinds** (implementation): the module receives `kind` and
  prints the title; a firm with one invoice look gets matching estimates and quotes.
- **The document's data reaches the sandbox as a JSON file, written by a glue tool**
  (implementation): `document_file(documentId)` → Render `GET /seat/documents/:id` → the glue
  writes `/home/user/files/doc-<number|draft-id8>.json`. Never retyped by the model (the 2b
  lossy-copy lesson). Dates arrive already formatted in the firm's timezone (dates are code's job).
- **A custom template is a `.py` file in the file store; `tenant_profiles.template_file_id`
  points at it** (implementation). `set_firm_profile(templateFileId)` sets it, `null` returns to
  the house template. A plain uuid column, **no foreign key**: files are soft-deleted, so an FK's
  `on delete` would never fire, and an FK to `files` would pull `tenant_profiles` into the test
  suites' `truncate technicians … cascade` (plan review). Instead `deleteFile` clears the pointer
  when the deleted file is the firm's template, so a deleted template reads as "none" everywhere.
- **The assistant must SEE the sample to copy it** (implementation): photos reach the model as
  images, a PDF does not. The skill asks for a screenshot or photo when the firm sends a PDF
  (the PDF's words are still read with pypdf).
- **`record_estimate_outcome` keeps its name and also takes quotes** (implementation).
- **Out of scope:** noticing estimates/quotes a manager emails from Gmail (the detector stays
  invoice-only); fonts beyond reportlab's built-ins; the office's duplicate-invoice blind spot.

## Plain-language walkthrough

**Phase 1 — quotes become a real kind.** The database learns a third kind of document, `quote`,
numbered QUO-1001 and up (its own counter, settable like the others). Issuing a quote records
"quote presented" in the books; the customer accepting it records "quote approved", and that
becomes the job's quoted price — beating any accepted estimate. You'd notice it when "make a
quote for Tom, $6,000" comes back as QUO-1001 and the job shows $6,000 quoted.

**Phase 2 — the house template.** A new tool puts the document's data (lines, totals, customer,
the firm's letterhead, dates in the firm's timezone) into a file on the manager's sandbox
computer, and a ready-made script draws the PDF from it. The assistant stops writing drawing code.

```
"invoice Tom"  →  draft_document  →  document_file  →  render_document.py  →  PDF in chat
                    (the record)      (data → JSON)      (house layout)       (share_file)
```

**Phase 3 — the firm's own template.** The manager sends their current invoice (a photo or
screenshot). The assistant writes a template that copies that look, shows a sample, and on the
manager's yes saves it as the firm's template. From then on the same script runs with
`--template`, and every invoice, estimate and quote comes out in the firm's own look.

**Phase 4 — deploy.** Pilot migration, Render deploy, glue install on s2 and s5.

## Secrets & env preflight

- **Phase 1–3:** none new. Local stack for tests (`.env.test`, already required).
- **Phase 4:** `.env` pilot keys for `scripts/apply-pilot-migration.mjs` (already required);
  Render MCP access (already used); `ssh tradesbox` (already used).

## Phase 1: Quotes as a third document kind

### Changes required

**`supabase/migrations/20261002120000_quotes.sql`** (new)
- `alter type money_event_kind add value if not exists 'quote_presented'`; same for
  `quote_approved`, `quote_declined` (unused in this file, so safe in one transaction; the
  convention note in `20260819120000_material_cost_kind.sql:21-26` explains why that matters).
- `money_documents`: drop `money_documents_kind_check` (the auto-named inline check) and re-add
  it as `('invoice','estimate','quote')`; re-add `money_documents_outcome_check` as
  `outcome is null or (kind in ('estimate','quote') and outcome in ('accepted','declined'))`.
- `tenant_profiles add column quote_start integer not null default 1001 check (quote_start > 0)`,
  and `add column template_file_id uuid` (used in Phase 3; one migration, no FK — see Decisions).
- Regenerate types: `npm run gen:types:local` (never `gen:types` — it points at the pilot).

**`src/db/moneyEvents.ts`**
- `MONEY_EVENT_KINDS` (`:11-29`): add the three quote kinds after `estimate_declined`.
- `summarizeMoney` (`:489-500`): find the last live `quote_approved`; if none, the last live
  `estimate_approved`; `quoted` = its amount plus `change_order`s after it. Update the
  `quotedCents` doc comment (`:443`).
- `src/mcp/tools/money.ts:78` amount rule: `quote_declined` needs no amount, like
  `estimate_declined` (check `appendMoneyEvent`'s amount rule in `moneyEvents.ts` and add it there).

**`src/db/moneyDocuments.ts`**
- `MoneyDocumentKind` (`:26`) and `DOCUMENT_KINDS` (`:44`) gain `'quote'`; `PREFIX` (`:46`)
  gains `quote: 'QUO'`.
- `issueDocument` (`:375`): kind → `invoice_issued` / `estimate_presented` / `quote_presented`
  (a small `ISSUE_KIND` map, not a nested ternary).
- `recordEstimateOutcome` (`:538-600`): allow `estimate` and `quote` (`:549`); the wanted kind
  maps per document kind (`quote_approved` / `quote_declined`); the race branch (`:568`)
  compares against the right approved kind.
- `writeVoidLedger` (`:456-478`) and `unsettledVoidIds` (`:117-148`): a quote cancels its
  `quote_approved` row by `doc:<id>:outcome`, like an estimate; the `.in('kind', …)` list gains
  `quote_approved`.
- `numberCandidates` (`:625-640`): a bare number also tries `QUO-<n>`; `namesIssuedNumber`
  (`:680`) kinds gain `quote_presented`.

**`src/db/tenantProfiles.ts`**
- `TenantProfilePatch` gains `quoteStart`; `INTEGER_COLUMNS` gains `quoteStart: 'quote_start'`;
  `documentStart` (`:224-228`) takes `MoneyDocumentKind` and maps all three.

**`src/mcp/tools/documents.ts`**
- `kind` enum (`:46`) gains `quote`, AND the handler's own check (`:199`) accepts it (it is
  separate from the schema; error text becomes "kind must be 'invoice', 'estimate' or 'quote'").
- `issue_document` description (`:71`) says INV-/EST-/QUO-; the void reply (`:257-260`) says
  "quote approval cancelled" for a quote.
- Issue records "quote presented" (`:237`); `record_estimate_outcome` (`:107-120`) says "an
  estimate or quote" (an accepted quote = the quoted price, beating an estimate); `:289` per kind.
- `roster.ts`: `set_firm_profile` schema gains `quoteStart` (the key roster is derived, `:974`).

**`src/seatGlue/doctrine.ts`** — the INVOICES AND ESTIMATES paragraph (`:161-169`) becomes
INVOICES, ESTIMATES AND QUOTES: an estimate is a rough ballpark, not binding; a quote is the
price the firm will charge; "they accepted the quote/estimate" → `spine-record_estimate_outcome`.
Update `doctrine.test.ts` expectations (`:84-87`).

Other readers of the kind lists: checked in review, none break (fixtures only).
**Tests whose pinned strings/rows change:** `server.test.ts:11775` (the kind error text) and
`:11739` (`'only an estimate has an outcome'` → "only an estimate or a quote has an outcome");
`tenantProfiles.test.ts:181-198` builds a full `TenantProfile` row — add `quote_start` and
`template_file_id` or `tsc` fails.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.
- [ ] `src/db/moneyDocuments.test.ts`: a quote issues as QUO-1001 independent of EST-/INV-
  counters; a firm `quoteStart` of 500 → QUO-500; issue writes one `quote_presented`; accepted
  → `quote_approved` for the total; declined → `quote_declined`, no amount; a second outcome is
  refused; voiding an accepted quote writes a `correction` and the quoted price falls back.
- [ ] `src/db/moneyEvents.test.ts`: `summarizeMoney` — an accepted quote beats a later accepted
  estimate; with no quote the estimate sets it; a change order after the quote adds to it.
- [ ] `numberCandidates('quote #1001')` includes `QUO-1001`.

### Live verification
None (deployed in Phase 4).

---

## Phase 2: The document's data on the computer, and the house template

### Changes required

**`src/db/moneyDocuments.ts`** — `documentForRender(tenantId, id)` returns `{ kind, title
('INVOICE'|'ESTIMATE'|'QUOTE'), number|null, status, draft, dateLocal, lines, totalCents, notes,
progress, customer {name, address fields, email, phone}, job {title}, firm, templateFileId:
null }` (Phase 3 fills the last). `firm` = `profileEcho` minus the start numbers, or `{}` with no
profile row (`profileEcho` needs a row). `dateLocal` = `issued_at`, else `spineNowIso(tenantId)`
(`src/evalClock.ts:13`, so eval clocks hold), formatted in `tenants.timezone` as "October 2,
2026". No helper exists for that format (it is written inline at `src/mcp/server.ts:939-945`):
add `longDateInTz(iso, tz)` to `src/schedule/availability.ts` beside `localDateISO` (`:77-87`)
with `toLocaleDateString('en-US', {timeZone, month:'long', day:'numeric', year:'numeric'})`
and a unit test (a UTC instant after midnight UTC that is still the previous day in Los Angeles).

**`src/mcp/httpServer.ts`** — `GET /seat/documents/:id` beside `/seat/files/:id` (route table
`:1543-1560`). Seat token → identity (the `handleSeatExport` pattern, `:449-470`); 403 unless
`isActiveManager`; 404 for a missing / other-firm id; 200 JSON from `documentForRender`.

**`src/seatGlue/main.ts`** — `documentData(cfg, id)` fetch helper beside `exportRows` (`:87-100`),
wired into the file-tool deps (`:142`).

**`src/seatGlue/fileTools.ts`** — `FileToolDeps.documentData(id)`; new tool `document_file`
(added to `FILE_TOOL_NAMES`, `:13-22` — `fileTools.test.ts:147` requires the tool set to equal
it; the engine approves any glue tool by name already, `engine.ts:243`): writes the JSON to
`${FILES_DIR}/doc-<number or draft-id8>.json` and returns the path, the kind, the number and
`templateFileId`. Errors are words, never throws (the file tools' rule).

**`Box_Setup_Stuff/seat-glue/skills/documents/`** (new)
- `render_document.py <data.json> <out.pdf> [--template <path.py>]`: reportlab, letter, built-in
  Helvetica. House layout: letterhead (names, address, phone, email, licenses), title + number
  (or a DRAFT watermark and "DRAFT"), date, BILL TO, JOB, lines (description, qty, unit, amount),
  total, notes, disclosure footer; "Deposit / progress invoice" when `progress`; money from cents
  with separators. `--template` loads the module with `importlib.util.spec_from_file_location`
  (`open_file` names it `<id8>-firm_template.py`; a plain `import` cannot) and calls
  `render(data, out_path)`; an exception exits non-zero (never a silent house-look fallback).
- `sample.json`: a realistic document for trying a template.
- `SKILL.md`: making any document = `spine-draft_document` → `document_file` → run the script →
  `share_file` (drafts) / after issue: `document_file` again → run → `save_file` →
  `spine-link_file(documentId)`. Use `--template` whenever `document_file` returns a
  `templateFileId` (bring it in with `open_file` first). Never write layout code for an ordinary
  document.

**`src/seatGlue/doctrine.ts`** — FILES_SECTION's DRAWING paragraph (`:201-205`) shrinks to:
"INVOICES, ESTIMATES AND QUOTES. Load the `documents` skill and follow it: the firm's template
draws them; never write your own layout." Read the profile/ask-once sentence stays. Update
`doctrine.test.ts:88` (it pins `'DRAWING AN INVOICE OR ESTIMATE.'`).

### Automated verification
- [ ] Gates pass (typecheck, lint, test, build).
- [ ] `src/mcp/httpServer.test.ts` (or the seat-route test file that covers `/seat/export`): a
  manager seat gets 200 with the shape above and a firm-local `dateLocal`; a technician seat 403;
  another firm's id 404; a draft has `number: null, draft: true`.
- [ ] `src/seatGlue/fileTools.test.ts`: `document_file` writes the JSON at the expected path via
  the fake sandbox; a 404 reads "No such document." The `fakeBox` deps (`~:100-140`) gain
  `documentData`.
- [ ] `src/seatGlue/managerTools.test.ts:73-84` pins the ordered manager tool list: add
  `document_file`; add a `documentData` fetch test beside the `exportRows` one.
- [ ] `scripts/sandbox-gate/test_render_document.py` (new, the `test_csv_to_xlsx.py` precedent —
  a Python unittest, never silently skipped): renders `sample.json` for each kind; the PDF's
  text (pypdf) has the title, the number, every line and the total; a draft says DRAFT and no
  number. Run: `python3 -m unittest scripts/sandbox-gate/test_render_document.py`.

### Live verification
None (deployed in Phase 4).

---

## Phase 3: The firm's own template

### Changes required

**`src/db/tenantProfiles.ts`** — `TenantProfilePatch.templateFileId?: string | null`. Validated
in `upsertTenantProfile`: UUID-shaped first (a malformed id would raise 22P02 from `getFile`),
then a live file of THIS firm (`getFile(tenantId, id)`, `files.ts:237-241`, live rows only) whose
name ends `.py`; else an instructive error. `null` clears. Export `PROFILE_FILE_FIELDS =
['templateFileId']` and add it to `profileEcho` (`:215-221`) by hand — it is built only from the
string/integer rosters.

**`src/db/files.ts`** — `deleteFile` (`:335`): after a successful delete, `update tenant_profiles
set template_file_id = null where tenant_id = $t and template_file_id = $id`.

**`src/mcp/tools/roster.ts`** — `set_firm_profile` schema gains `templateFileId`
(`['string','null']`, "the firm's own document template — a .py file saved with save_file;
null = back to the house template"). The handler (`:974-993`): `knownKeys` gains
`...PROFILE_FILE_FIELDS`, AND a copy loop puts it into the patch (without it the call reads as a
no-field READ and says "nothing changed"). `server.test.ts:7533-7536` pins the schema keys to the
rosters: add `...PROFILE_FILE_FIELDS` there.

**`src/db/moneyDocuments.ts`** — `documentForRender` sets `templateFileId` from the profile.

**`Box_Setup_Stuff/seat-glue/skills/documents/SKILL.md`** — new section "A FIRM'S OWN TEMPLATE":
1. Ask for the firm's current invoice as a photo or screenshot (you cannot see a PDF; its words
   can still be read with pypdf).
2. Write `firm_template.py` with `def render(data: dict, out_path: str) -> None`, copying the
   sample's layout, fonts (closest built-in), colours and wording; it must print `data['title']`
   so one template serves invoices, estimates and quotes, and DRAFT for drafts.
3. Run it on `sample.json` and `share_file` the result; ask the manager with `ask_user` whether
   it looks right; fix and repeat until they say yes.
4. Only on their yes: `save_file firm_template.py`, then `spine-set_firm_profile(templateFileId)`.
   To go back to the house template: `templateFileId: null`.

**`src/seatGlue/doctrine.ts`** — one sentence in **FILES_SECTION** (not the preamble — a seat
without the sandbox has no skills and must not be told it has a computer, `doctrine.ts:184-188`):
"If the manager wants their own look, the `documents` skill says how to build their template."

### Automated verification
- [ ] Gates pass.
- [ ] `src/db/tenantProfiles.test.ts` (or `server.test.ts` set_firm_profile block): another
  firm's file refused; a deleted file refused; a `.pdf` refused; a live `.py` saved and echoed;
  `null` clears.
- [ ] `documentForRender` carries `templateFileId`; deleting that file clears the profile
  pointer (read back with `set_firm_profile` and no args) and the next render has `null`.
- [ ] `test_render_document.py`: `--template` with a tiny test module named like `open_file`'s
  output (`1a2b3c4d-firm_template.py`) that writes a PDF reading
  "CUSTOM <title> <number>" is used; a module that raises exits non-zero with its message.

### Live verification
None (deployed in Phase 4).

---

## Phase 4: Deploy

### Changes required
1. PR → merge → `gh repo sync Yu-C1/TradesDatabase --branch main`.
2. Pilot migration: `node scripts/apply-pilot-migration.mjs supabase/migrations/20261002120000_quotes.sql`
   (dry run), then `--apply`. Never `db push`.
3. Render web `srv-d8uqmdegvqtc73bfn83g`: manual deploy (workspace `tea-d69903h5pdvs738dm81g`).
4. Glue: `stage.sh` (picks up `skills/documents/`), rsync, `who`, `install.sh s2`, `install.sh s5`.
   No E2B template rebuild (reportlab and pypdf are already in it).

### Live verification (agent-executable) — gates already passed on the merge commit
- Prerequisites: Supabase test MCP (pilot read-only SQL), Render MCP, `ssh tradesbox`.
- [ ] Pilot: `money_event_kind` lists the three quote values; `tenant_profiles` has
  `quote_start` and `template_file_id`; `money_documents` accepts kind `quote` (read the check
  definition, write nothing).
- [ ] Render deploy live on the merge commit; from the box, `GET /seat/documents/<random uuid>`
  with s2's seat token → 404 (an unrouted path would answer 401/403, so 404 proves the route).
- [ ] Both glue units `active`; each seat's INSTALLED `skills/documents/render_document.py`
  (the copy `install.sh:70` makes and `syncSkills` pushes) has the repo's md5.

### Manual verification
None gating: the operator tests with real use once all features are built (2026-10-02).
