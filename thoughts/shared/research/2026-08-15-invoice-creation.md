---
date: 2026-08-15
branch: feat/agent-turn-hardening
commit: f1ba77f
topic: Invoice creation — generating and delivering the customer-facing invoice on top of the planned money event ledger (parts A/B). Domain: US trades invoice content law, delivery practice, Composio Gmail attachments, Node PDF options. Codebase: the send path, storage, tenants gap, rendering and numbering precedents.
---

## Summary

This researches what it would take for the spine to *create and deliver* an actual invoice — the
document a homeowner receives — on top of the money event ledger planned in
[2026-08-15-money-ledger-v1.md](../plans/2026-08-15-money-ledger-v1.md) (part A) and its
inference companion (part B). Three headline findings. **Domain:** there is no federal law about
invoice contents and no US e-invoicing mandate — the real requirements are state
contractor-licensing rules (Texas *names invoices explicitly*: TACL license number on all
invoices plus a mandatory TDLR disclosure paragraph, $500–$1,000 fines; California requires the
CSLB number on contracts/bids/advertising; New Jersey requires the HIC registration number and a
consumer-hotline line on invoices), and sales-tax treatment varies by state *per line* (labor vs
parts), so an invoice engine needs per-line taxability and a per-state footer, not a single tax
toggle. Delivery-wise the industry default is a hosted invoice page reached by emailed/texted
link with a pay button; a PDF attachment is the simpler minority pattern. **Rails:** Composio's
`GMAIL_SEND_EMAIL` *does* support an optional `attachment` parameter (file path / URL / staged
upload; Gmail's ~25 MB cap) — verified against live docs, one SDK schema confirmation still
recommended. **Codebase:** the gap is wider than the send path — our Composio call currently
passes exactly three arguments (no attachment, no HTML anywhere in the repo), the `tenants` table
has **zero business-identity fields** (no address/phone/license/tax-id/logo — nothing
firm-identifying is customer-facing today, and outbound email comes from the technician's own
mailbox), there is **no document-generation machinery and no per-tenant numbering facility** of
any kind, and no customer-facing route or capability-URL precedent exists. An invoice would be
the spine's **first customer-facing artifact ever**.

## Domain findings (cited)

### What must be on a US trades invoice

- Standard contents are convention, not statute: business + client identity, unique invoice
  number, dates, itemized lines, tax, total, terms
  ([Xero](https://www.xero.com/us/guides/what-to-include-on-invoice/),
  [Billdu](https://www.billdu.com/blog/advice/essential-invoice-elements/)).
- **License-number display is the real legal layer**, state- and trade-specific:
  - **Texas HVAC (TDLR):** TACL license number **must appear on all invoices and proposals**; an
    invoice must be provided for all ACR work; a mandatory disclosure paragraph ("Regulated by
    The Texas Department of Licensing and Regulation…") must appear on proposals, invoices, and
    contracts (16 TAC §75.71, [Justia](https://regulations.justia.com/states/texas/title-16/part-4/chapter-75/section-75-71/);
    [TDLR ACR](https://www.tdlr.texas.gov/acr/)). Missing it: Class A violation, $500–$1,000
    ([TDLR sanctions](https://www.tdlr.texas.gov/enforcement/acrsanctions.htm)).
  - **California (CSLB):** BPC §7030.5 requires the license number on *contracts, subcontracts/
    bids, and advertising* — the statute does not say "invoices," though secondary sources and
    universal practice include them
    ([leginfo](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=7030.5.&lawCode=BPC)).
  - **New Jersey:** HIC registration number on all business documents and consumer
    correspondence, plus the Consumer Affairs hotline **on all invoices**
    ([NJ HIC FAQ](https://www.njconsumeraffairs.gov/hic/Pages/FAQ.aspx)).
  - Pattern: treat **license number + per-state disclosure footer as required template fields**.
- **CA home-improvement contract regime** (BPC §7159: written contract, 10%-or-$1,000 deposit
  cap, 3-day right to cancel) attaches to *contracts/estimates*, not invoices — a collision the
  moment the system also generates proposals
  ([CSLB](https://www.cslb.ca.gov/Consumers/Hire_A_Contractor/Home_Improvement_Contracts/Warnings_And_Exceptions.aspx)).
- **Sales tax varies by state per line**: TX — residential repair labor not taxable, materials
  taxable ([Comptroller 94-116](https://comptroller.texas.gov/taxes/publications/94-116.php));
  FL — parts+labor fully taxable, labor-only not
  ([GT-800010](https://floridarevenue.com/Forms_library/gt800010.pdf)); NY — full charge taxable
  ([TB-ST-129](https://tax.ny.gov/pubs_and_bulls/tg_bulletins/st/repair_maintenance.htm)).
- **No US e-invoicing mandate** (B2C/B2B); PDF or hosted page is legally sufficient
  ([Basware](https://www.basware.com/en/compliance-map/united-states),
  [Comarch](https://www.comarch.com/trade-and-services/data-management/e-invoicing/e-invoicing-in-usa/)).

### How invoices are delivered

Industry default = **hosted invoice page via link, with a pay button**: Jobber emails a
client-hub link (PDF attach is an opt-in checkbox; SMS links expire in 24 h)
([Jobber help](https://help.getjobber.com/hc/en-us/articles/115009685047-Invoice-Basics));
Housecall Pro sends email *or* text with a pay link
([HCP help](https://help.housecallpro.com/en/articles/2876243-how-to-send-an-invoice));
ServiceTitan embeds a single-invoice pay link that expires after 60 days
([ST help](https://help.servicetitan.com/how-to/online-payments)). PDF-attachment-only is the
minority pattern but needs no hosted-page infrastructure. Paper = print the same PDF.

### Rails

- **Composio Gmail attachments: supported.** `GMAIL_SEND_EMAIL` and `GMAIL_REPLY_TO_THREAD` each
  take an optional `attachment` (single file or list; mimetype must contain `/`; ~25 MB Gmail
  cap). Accepted inputs: local file path, URL, File object (TS auto-upload gated by
  `dangerouslyAllowAutoUploadDownloadFiles: true`), or manual staging via
  `composio.files.upload(...)` → `{name, mimetype, s3key}`
  ([toolkit docs](https://docs.composio.dev/toolkits/gmail),
  [file handling](https://docs.composio.dev/docs/tools-direct/executing-tools)). Base64 is NOT a
  documented input. *Caveat: JS-rendered doc pages — do a one-shot `tools.get` schema dump before
  building.*
- **PDF generation (npm-verified 2026-08-15):** `@react-pdf/renderer` 4.6.1 (active, native ESM,
  declarative layout, React peer dep, no native build); `pdfkit` 0.19.1 (active, pure-JS,
  imperative x/y layout); `pdf-lib` dormant since 2022 (modify/merge use-case);
  puppeteer/playwright = full Chromium (~300 MB) for HTML fidelity; Typst node bindings =
  community-run native binaries. Pure-JS zero-native-dep options: react-pdf, pdfkit, pdf-lib.

## Entry Points

- **The audited send** — tool schema [server.ts:474-492](src/mcp/server.ts#L474-L492) (`to`,
  `subject`, `body`, `confirmId` — nothing else); staged handler
  [server.ts:2340-2462](src/mcp/server.ts#L2340-L2462) (15-min TTL, consume-first-then-send,
  advisory L1 capture); Composio call [outbound.ts:49-54](src/composio/outbound.ts#L49-L54) —
  `arguments: { recipient_email, subject, body }` and **nothing more**. Adding an attachment
  touches exactly three sites: the tool schema, the staged detail + send call, and
  `SendEmailInput`/the arguments object ([outbound.ts:16-20](src/composio/outbound.ts#L16-L20),
  [:52](src/composio/outbound.ts#L52)).
- **Storage precedent** — the single private bucket `call-audio`
  ([20260804120000_phone_call_ingest.sql:91-99](supabase/migrations/20260804120000_phone_call_ingest.sql#L91-L99)):
  upload [fetchRecording.ts:29-33](src/calls/fetchRecording.ts#L29-L33), signed URL (3600 s
  default) [fetchRecording.ts:37-49](src/calls/fetchRecording.ts#L37-L49), purge cron
  [purgeAudio.ts:35-56](src/calls/purgeAudio.ts#L35-L56) with `audio_delete_after` /
  `legal_hold` / `audio_deleted_at` machinery. `getPublicUrl` is never used; no bucket RLS —
  service-role + signed URLs only.
- **Tenant identity** — `tenants` is exactly 8 columns
  ([database.types.ts:1357-1389](src/db/database.types.ts#L1357-L1389)): id, name, created_at,
  timezone, seats ×2, default_job_minutes, horizon. **No address, phone, license, tax-id, logo,
  or attributes column.** `tenants.name` is read in exactly two places, both operator-facing
  ([adminApi.ts:214](src/admin/adminApi.ts#L214), [:285](src/admin/adminApi.ts#L285)); outbound
  email From is the technician's own mailbox
  ([server.ts:2443-2447](src/mcp/server.ts#L2443-L2447)).
- **Money plans this sits on** — part A's `record_money_event` + `syncJobStatusForMoney`; part
  B's `applyMoneyInference` with content-keyed dedupe
  ([2026-08-15-money-inference-v1.md](../plans/2026-08-15-money-inference-v1.md)).

## Key Files

| File | Relevance |
|---|---|
| [src/composio/outbound.ts](src/composio/outbound.ts) | The whole Gmail send wrapper: gate (:29-35), execute payload (:49-54), `dangerouslySkipVersionCheck` requirement (:38-41), cost event (:60-67), tolerant messageId extraction (:68-84). Connected-account-pinned, not session-pinned (:4-9); sessions deliberately exclude `GMAIL_SEND_EMAIL` from technician tools ([sessions.ts:15-24](src/composio/sessions.ts#L15-L24)) |
| [src/mcp/server.ts:2340-2462](src/mcp/server.ts#L2340-L2462) | Staged send: stage (:2346-2382), confirm+TTL (:2385-2410), send (:2413-2417), failure re-annotation (:2418-2434), L1 capture (:2437-2456) |
| [src/email/format.ts](src/email/format.ts) | 14 lines — `formatEmailRawText({from,subject,body})`, the single L1 email representation |
| [src/calls/fetchRecording.ts](src/calls/fetchRecording.ts), [src/calls/purgeAudio.ts](src/calls/purgeAudio.ts), [src/db/callIngest.ts:115-150](src/db/callIngest.ts#L115-L150) | The complete store-sign-retain-purge lifecycle for generated artifacts |
| [src/telegram/boardApi.ts:124-149](src/telegram/boardApi.ts#L124-L149), [src/admin/adminApi.ts:77-102](src/admin/adminApi.ts#L77-L102) | The only static-serving precedents: flat whitelisted dirs, unauthenticated shell, **no dynamic document route, no capability-URL pattern** |
| [src/web/fetchPage.ts:274-297](src/web/fetchPage.ts#L274-L297) | `pdf-parse` — a PDF *reader* exists; no writer anywhere |
| [supabase/migrations/20260714120000_schedule_core_promise_ladder.sql:31](supabase/migrations/20260714120000_schedule_core_promise_ladder.sql#L31) | The only identity/sequence in the schema (global, gappy per tenant); the alternative idiom is `unique (tenant_id, <text key>)` + insert-catch-23505 ([20260804120000:55-58](supabase/migrations/20260804120000_phone_call_ingest.sql#L55-L58)) |

## Data Flows

Today's send flow (the seam an invoice send would extend):

```
manager: "send the invoice email"
  └► send_email STAGE (server.ts:2346) ─► review_items pending_outbound_send {to,subject,body}
  └► send_email CONFIRM (server.ts:2385) ─► consume token (:2402)
        └► liveSendGmailEmail (outbound.ts:44) ─► client.tools.execute('GMAIL_SEND_EMAIL',
              {connectedAccountId, userId, arguments:{recipient_email,subject,body}})
        └► L1 capture channel:'outbound_email' (server.ts:2440) — full body, metadata {to,subject,threadId}
        └► [part B, planned] applyMoneyInference reads this capture → invoice_issued event
```

A generated-document flow has no precedent; the nearest analogue is call audio:
download → `storage.upload(objectPath)` → `createSignedUrl(ttl)` → machine consumer → retention
stamp → purge cron. No human-facing signed link exists anywhere.

## External Dependencies

- Today: Composio SDK (`client.tools.execute`, `composio.files.upload` unused), Supabase storage,
  `pdf-parse` (read-only). No PDF writer, no templating engine, no HTML email.
- Candidate new: one PDF library (see Domain §Rails). Any choice is a new production dependency —
  the repo currently generates no documents of any kind.
- Per CLAUDE.md, Composio attachment behavior must be re-verified against live docs/SDK at
  implementation time; citations above are the point-in-time record.

## Constraints and Invariants

1. **Outbound sends are staged, at-most-once, and L1-captured** — any invoice send inherits the
   consume-first-then-send contract and the full-body capture policy (2026-07-04 exception).
2. **The sender identity is a person's mailbox** — `connected_account_id` from the roster; there
   is no firm mailbox concept. Sessions exclude send from technician tool lists; sends are
   manager/outbound-capable-gated ([outbound.ts:29-35](src/composio/outbound.ts#L29-L35)).
3. **Nothing firm-identifying exists to print** — an invoice header requires business identity
   data (legal name, address, phone, license #, disclosure footer) that no table holds.
4. **No customer-facing surface exists** — every route is webhook/operator/roster-authenticated.
   The Telegram-only product principle governs *manager/tech* UI; customers have never had any
   artifact. An invoice is the first.
5. **Per-line taxability is a domain requirement** (TX/FL/NY examples above) — a single
   invoice-level tax field cannot represent it.
6. **A spine-sent invoice must not depend on part B inference** — the send path can record its
   own `invoice_issued` event synchronously (it knows the job and amount); part B's content-keyed
   dedupe (`money:<jobId>:<kind>:<amountCents>:<date>`) would also collapse the duplicate if
   both fire.
7. **Storage artifacts get retention machinery** — the call-audio lifecycle is the precedent;
   invoices are business records (the domain expectation is keep-forever, unlike audio).
8. **L1 is undeletable** — an invoice PDF stored in a bucket is deletable/retainable by policy;
   anything written into `raw_captures` (e.g. the send capture's body) is permanent.

## Decision Points

1. **Delivery artifact.** (a) PDF attached to the existing Gmail send — smallest build (three
   edit sites + a renderer), matches the audited-send contract, minority industry pattern;
   (b) hosted invoice page via link — the industry default, but requires the repo's first
   customer-facing route, a capability-URL/expiry design, and public-serving posture that
   doesn't exist; (c) both (attachment now, hosted later).
2. **Renderer.** `@react-pdf/renderer` (active, ESM-native, declarative, React peer dep) vs
   `pdfkit` (active, smallest, imperative) vs HTML-to-PDF via headless Chromium (fidelity, ~300
   MB deploy weight) vs Typst bindings (community/native risk).
3. **Where firm identity lives.** New `tenants` columns vs a `tenant_profiles` table vs
   introducing a `tenants.attributes` JSONB. Includes license number(s) and the per-state
   disclosure footer; also *who enters it* (onboarding is operator-driven today).
4. **Invoice numbering.** Global identity ordered per tenant (schedule_events idiom — gappy
   display numbers) vs per-tenant minted key with `unique (tenant_id, key)` + retry (schedule
   entries/call_ingest idiom — allows `INV-1001` style sequences, needs a race-safe mint).
5. **Line-item source.** Compose from ledger events (change orders/fees become lines
   automatically) vs free-form lines at creation (flexible, duplicates data) vs hybrid
   (ledger-suggested, manager-edited). Per-line taxability applies in every variant.
6. **Sending identity.** Manager's own connected Gmail (exists today; invoice appears from a
   personal mailbox) vs a per-firm mailbox (new pairing concept) — nothing firm-branded exists.
7. **Compliance scope v1.** Which states' footer/disclosure sets ship first (TX names invoices
   explicitly; CA/NJ near-certain in practice), and whether license fields are required or
   optional at profile setup.
8. **Ledger interaction.** Synchronous `invoice_issued` on send (constraint 6) — and whether the
   invoice *document* (number, line items, PDF path) becomes its own table or lives in the money
   event's `detail`/storage pointer.

## Open Questions

1. Which state(s) the pilot and near-term firms operate in — decides the v1 disclosure-footer
   set and whether the TX TDLR paragraph must ship day one.
2. Whether estimates/proposals are close behind invoices — CA §7159's contract regime (deposit
   caps, cancellation notice) binds *those*, and template work overlaps heavily.
3. Whether a pay button is ever in scope for a hosted page — payment *processing* is explicitly
   out of scope in v1 money plans; a hosted page without payment is just a document.
4. The one-shot SDK schema confirmation of `GMAIL_SEND_EMAIL`'s `attachment` parameter (5-minute
   check the Composio docs caveat requires).
5. Whether firms want the tech-at-the-door to trigger invoice creation (tier question — sends
   are currently manager/outbound-capable-gated).
6. Sales-tax rates: does v1 require rate lookup at all, or manager-entered per-line tax amounts
   (no tax-rate engine exists and none is planned)?
