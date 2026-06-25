---
date: 2026-06-25
branch: centralized_mcp_server_architecture
commit: bfe32de
topic: Composio connector layer — existing integration surfaces (write-path, current connectors, identity seam) and recorded design
---

## Summary
This documents the codebase surfaces a Composio connector layer would plug into. **Composio is not in
the repo** — there is no `composio` dependency and no Composio code (deps are `@anthropic-ai/sdk`,
`@modelcontextprotocol/sdk`, `@supabase/supabase-js`, `dotenv`, `googleapis`). What exists today is: a
**channel-agnostic write-path** (`recordFieldNote`) that lands any input verbatim in L1 then extracts →
identity-matches → writes L2/L3 with linked provenance; **two existing third-party connectors**, both
built directly on `googleapis` — an inbound Gmail pull (`src/email/ingest.ts`) and a one-way Google
Sheets→spine schedule sync (`src/schedule/sheetSync.ts`); the **MCP identity seam** (`RequestIdentity`,
resolved per request) that the central HTTP server (Architecture A) uses to assert `(tenant, technician)`;
and a **recorded design** for the Composio layer in `docs/nemoclaw-tech-agent.md` §7 plus the
`composio-connector-layer` memory. The Composio onboarding control plane, the per-tenant Tool Router
`mcp.url` wiring, outbound (agent-action) tooling, and the inbound trigger/webhook path are **design
intent only — no code exists for them yet**.

## Entry Points
- **Shared write-path seam (the inbound landing point):** [src/writePath/recordFieldNote.ts:51](../../../src/writePath/recordFieldNote.ts#L51) — `recordFieldNote(input, deps)`.
- **Current inbound connector (Gmail):** [src/email/ingest.ts:67](../../../src/email/ingest.ts#L67) — `ingestEmail(tenantId, technicianRef, deps)`; default fetcher at [:31](../../../src/email/ingest.ts#L31).
- **Current read connector (Sheets):** [src/schedule/sheetSync.ts:78](../../../src/schedule/sheetSync.ts#L78) — `syncScheduleFromSheet(tenantId, spreadsheetId, deps)`; default reader at [:29](../../../src/schedule/sheetSync.ts#L29).
- **MCP tool surface (the agent boundary):** [src/mcp/server.ts:243](../../../src/mcp/server.ts#L243) `createServer`; `dispatch` at [:129](../../../src/mcp/server.ts#L129); stdio `main` at [:267](../../../src/mcp/server.ts#L267).
- **Central HTTP entrypoint (Architecture A):** [src/mcp/httpServer.ts:34](../../../src/mcp/httpServer.ts#L34) `handle`; [:58](../../../src/mcp/httpServer.ts#L58) `createHttpServer`.
- **Identity seam:** [src/mcp/identity.ts:41](../../../src/mcp/identity.ts#L41) `resolveIdentityFromHeaders`; [:21](../../../src/mcp/identity.ts#L21) `identityFromEnv`.
- **L1 insert:** [src/db/rawCaptures.ts:21](../../../src/db/rawCaptures.ts#L21) `appendRawCapture`.
- **Recorded design (not code):** `docs/nemoclaw-tech-agent.md` §7 ("Third-party app connectors (Composio — Option B)") and §"Stay connector-agnostic"; the `composio-connector-layer` auto-memory.

## Key Files
- **src/writePath/recordFieldNote.ts** — the channel-agnostic write-path. `RecordFieldNoteInput` ([:19](../../../src/writePath/recordFieldNote.ts#L19)) = `{ tenantId, technicianRef, text?, blobPath?, channel: CaptureChannel, confirmed?, captureId? }`. Sequence: L1 append (or reload on resume) [:58-78](../../../src/writePath/recordFieldNote.ts#L58-L78) → `extract(rawText)` [:81](../../../src/writePath/recordFieldNote.ts#L81) → `matchIdentity(...)` [:84](../../../src/writePath/recordFieldNote.ts#L84) → create/resolve customer/job/visit with `sourceCaptureId` [:106-144](../../../src/writePath/recordFieldNote.ts#L106-L144). Returns `{status, captureId, customerId?, jobId?, visitId?, suggestion?}`. Injectable `deps.extract` only.
- **src/writePath/extract.ts** — `Extractor = (rawText: string) => Promise<ExtractedFields>` ([:28](../../../src/writePath/extract.ts#L28)). `sonnetExtractor` ([:73](../../../src/writePath/extract.ts#L73)) forces Claude `claude-sonnet-4-6` through a single `record_extraction` tool. Input is **plain text only** — no channel/source awareness.
- **src/writePath/identityMatch.ts** — deterministic resolution: confirmed customer → unique phone/address → schedule confirmation → ask ([:44-109](../../../src/writePath/identityMatch.ts#L44-L109)). Consumes the schedule (`listScheduleForTechnicianOnDate`).
- **src/email/ingest.ts** — current Gmail connector (the path Option B supersedes per the recorded design). `gmailFetcher` ([:31](../../../src/email/ingest.ts#L31)) uses OAuth2 `GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN`, query `newer_than:7d`, `maxResults:25`. `ingestEmail` ([:67](../../../src/email/ingest.ts#L67)) loops: `classify` → if `!isWork` skip, else `recordFieldNote({ channel:'email', text:"Subject..\nFrom..\n\n<body>" })`. Injectable deps `{ fetch, classify, extract }`. **Documented idempotency gap** ([:63-66](../../../src/email/ingest.ts#L63-L66)): no dedup by message id; overlapping window re-ingests duplicates.
- **src/email/classify.ts** — `WorkClassifier = (email: EmailInput) => Promise<{isWork, reason}>` ([:15](../../../src/email/classify.ts#L15)). `EmailInput = {subject, body, from}` ([:3](../../../src/email/classify.ts#L3)) — **Gmail-shaped**. `sonnetClassifier` ([:39](../../../src/email/classify.ts#L39)) forces `classify_email`; system prompt is email-specific ("work vs personal/marketing", default `isWork=false`).
- **src/schedule/sheetSync.ts** — current Google Sheets connector. `SheetReader = (spreadsheetId) => Promise<ScheduleRow[]>` ([:20](../../../src/schedule/sheetSync.ts#L20)). `googleSheetReader` ([:29](../../../src/schedule/sheetSync.ts#L29)) uses `GoogleAuth` ADC (`GOOGLE_APPLICATION_CREDENTIALS`), scope `spreadsheets.readonly`, range `A1:Z10000`, header-substring column mapping. `syncScheduleFromSheet` ([:78](../../../src/schedule/sheetSync.ts#L78)) is **one-way read (Sheet→spine), idempotent** via `upsertScheduleEntry` on `(tenant_id, external_row_key)`. Injectable dep `{ read }`. Write-back to the sheet is "deferred to a later phase" ([:77](../../../src/schedule/sheetSync.ts#L77)).
- **src/db/scheduleEntries.ts** — `upsertScheduleEntry` ([:27](../../../src/db/scheduleEntries.ts#L27)) with `onConflict: 'tenant_id,external_row_key'` ([:48](../../../src/db/scheduleEntries.ts#L48)) — the repo's **only external-id-keyed idempotency precedent**. `external_row_key` ([:9](../../../src/db/scheduleEntries.ts#L9)) is the stable source id.
- **src/db/rawCaptures.ts** — `appendRawCapture` ([:21](../../../src/db/rawCaptures.ts#L21)) inserts L1. `AppendRawCaptureInput` ([:7](../../../src/db/rawCaptures.ts#L7)) accepts `metadata: Json` and provenance `customerId/jobId/visitId`. Insert-only (append-only). `getRawCapture` ([:42](../../../src/db/rawCaptures.ts#L42)) read for resume.
- **src/mcp/server.ts** — the 7 MCP tools ([:41-127](../../../src/mcp/server.ts#L41-L127)): `record_field_note`, `find_customer`, `get_customer_context`, `get_job`, `list_recent_captures`, `brief_customer`, `answer_customer_question`. `dispatch` ([:129](../../../src/mcp/server.ts#L129)) reads `(tenantId, technicianRef)` from `deps.identity` ([:134-136](../../../src/mcp/server.ts#L134-L136)), tenant-guards every read and the write [:152-157,181-235](../../../src/mcp/server.ts#L152-L157). **All 7 tools are spine read/write — none call an external app.**
- **src/mcp/identity.ts** — `RequestIdentity = {tenantId, technicianRef, scopes?}` ([:13](../../../src/mcp/identity.ts#L13)). `resolveIdentityFromHeaders` ([:41](../../../src/mcp/identity.ts#L41)) HMAC-verifies `x-tenant-id`/`x-technician-ref`/`x-identity-signature` against `GATEWAY_IDENTITY_SECRET`. Comment ([:40](../../../src/mcp/identity.ts#L40)) names JWT/Option B as a one-function swap.
- **src/db/context.ts** — `getCustomerContext(customerId)` ([:18](../../../src/db/context.ts#L18)) aggregates customer/jobs/visits/captures, unioning captures linked via `source_capture_id`.
- **supabase/migrations/20260620005307_context_spine.sql** — schema. `capture_channel` enum ([:16-22](../../../supabase/migrations/20260620005307_context_spine.sql#L16-L22)) and the append-only trigger ([:117-119](../../../supabase/migrations/20260620005307_context_spine.sql#L117-L119)).

## Data Flows

**Current inbound (Gmail), end-to-end:** `ingestEmail(tenantId, technicianRef, {fetch?,classify?,extract?})`
→ `fetch()` returns `Email[]` (`{id, from, subject, body}`) → per email `classify({subject,body,from})`
→ if `isWork`, `recordFieldNote({tenantId, technicianRef, channel:'email', text})` → L1 append →
`extract(text)` → `matchIdentity` → on a match, L2 customer/job/visit created with
`source_capture_id = captureId`. Unmatched work email still lands in L1 (verbatim preserved), gains no L2
([src/email/ingest.ts:58-61](../../../src/email/ingest.ts#L58-L61)). The Gmail message `id` is **carried
into `ingestEmail` (`Email.id`) but never persisted** — it is not passed to `recordFieldNote`, which has
no field for it.

**Current read connector (Sheets):** `syncScheduleFromSheet(tenantId, spreadsheetId, {read?})` →
`read()` returns `ScheduleRow[]` (each with a stable `rowKey`) → `upsertScheduleEntry` keyed on
`(tenant_id, external_row_key)`. This populates `schedule_entries`, which `identityMatch` later consults.

**Agent → spine (MCP):** gateway → `httpServer.handle` → `resolveIdentityFromHeaders` → fresh
`createServer({identity})` → `dispatch` → write-path / reads. `record_field_note` restricts `channel` to
`TECH_CHANNELS` only (`technician_voice|note|photo`) ([src/mcp/server.ts:38,142-146](../../../src/mcp/server.ts#L38)) — the `'email'` channel is reachable only via `ingestEmail`, not via the MCP tool.

**Identity divergence (relevant to inbound webhooks):** the MCP path resolves `(tenant, technician)` per
request from a signed header. The Gmail path instead takes `tenantId` + a **synthetic** `technicianRef`
as direct function arguments (the tests pass `'tech-email'`; [ingest.test.ts:45](../../../src/email/ingest.test.ts#L45)). There is no gateway-style identity object on the
ingestion path — provenance for a non-technician channel is just whatever string is passed.

**Recorded (not implemented) Composio flows**, per `docs/nemoclaw-tech-agent.md` §7: per-tenant
`composio.create(tenantId)` (user_id = tenant uuid) + Connect Link onboarding; per-tenant Tool Router
`mcp.url` registered in the gateway next to `trades-spine`; outbound = whatever toolkits the tenant
connected appear as agent-callable tools; inbound = Composio triggers → a generic webhook (verify HMAC
`webhook-signature`, route by `toolkit`+`triggerType`) → per-source normalizer
(`payload → {channel, rawText|blobRef, externalId, occurredAt, sourceMeta}`) → the shared
dedup/classify-before-L1/extract pipeline. No code for any of this exists.

## External Dependencies
- **Present:** `googleapis` ^173 (Gmail + Sheets, both connectors), `@anthropic-ai/sdk` ^0.105 (extractor + classifier, `claude-sonnet-4-6`), `@modelcontextprotocol/sdk` ^1.29 (MCP server + Streamable HTTP transport), `@supabase/supabase-js` ^2.108 (service-role DB client), `pg` (tests' direct read-back), `supabase` CLI (migrations).
- **Absent:** no `composio` SDK; no Microsoft Graph / Azure SDK; no webhook/HTTP framework beyond `node:http` used in `httpServer.ts`.
- **Auth models in code:** Gmail = OAuth2 refresh token from env (single mailbox); Sheets = GoogleAuth ADC service account (single credential). **Neither is per-tenant** — both are one set of credentials for the process. The recorded design's per-tenant connected-account model (Composio `user_id` = tenant) has no code equivalent yet.

## Constraints and Invariants
- **L1 is append-only**, enforced by the `raw_captures_append_only` trigger on UPDATE/DELETE ([migration:117-119](../../../supabase/migrations/20260620005307_context_spine.sql#L117-L119)) and mirrored in `rawCaptures.ts` exposing insert-only. Consequence (recorded as a rule in CLAUDE.md): any filtering/classification must gate the L1 insert, since a written row cannot be removed.
- **`capture_channel` is a Postgres enum** with a fixed value set ([migration:16-22](../../../supabase/migrations/20260620005307_context_spine.sql#L16-L22)): `technician_voice, technician_photo, technician_note, phone_call, web_form, sms, email, chat, manager_assistant, manual_correction, sales_note, quote, crm_import, accounting_event, iot`. Several plausible Composio sources map to existing values (`email`, `crm_import`, `accounting_event`, `chat`, `sms`); a genuinely new channel value requires a **migration** (enum alter). The normalizer's `channel` output is constrained to this enum.
- **No external-id dedup for captures.** `raw_captures` has no message-id/external-id column and no unique constraint; the idempotency gap is explicit in `ingest.ts`. The only external-id idempotency in the repo is `schedule_entries.(tenant_id, external_row_key)` via `upsertScheduleEntry` — captures have no such mechanism.
- **`recordFieldNote` does not thread `metadata`.** `appendRawCapture` accepts `metadata` and provenance ids, but `recordFieldNote` ([:69-74](../../../src/writePath/recordFieldNote.ts#L69-L74)) passes only `tenantId, channel, rawText, blobPath`. A normalizer envelope's `externalId`/`occurredAt`/`sourceMeta` has a schema home (`raw_captures.metadata`) but **no code path** through the shared write-path today.
- **The extractor is text-only and trade-note-shaped.** `sonnetExtractor` takes `rawText` and a HVAC/plumbing field-note system prompt; it has no notion of source/channel. The classifier is email-shaped (`{subject,body,from}`, "work vs personal").
- **Identity on the write-path is a free string.** `technicianRef` flows straight to `visits.technician_name`; the MCP path pins it from a signed header, the ingestion path passes a literal. Nothing constrains its form for a non-technician channel.
- **Injectable-deps is the universal testability seam.** Every connector/AI boundary exposes a `deps` object with the live impl as default (`fetch`/`classify`/`extract`/`read`/`brief`/`answer`/`identity`). Tests inject stubs and read back over `pg` against the test project (`ingest.test.ts`, `server.test.ts`).
- **MCP `record_field_note` channel allowlist** is narrower (`TECH_CHANNELS`) than the DB enum; the non-technician channels are written only by code paths outside the MCP tool surface.

## Testability split (stubs vs live)
- **Testable now with stubs + test Supabase** (no Composio): a normalizer (`payload → envelope`), dedup logic (if a key/constraint is added), `recordFieldNote` threading `metadata`, webhook HMAC verification (same pattern already unit-tested for `resolveIdentityFromHeaders` in `identity.test.ts`), and routing by `toolkit`+`triggerType`. These mirror the existing `ingest.test.ts` (stub `fetch`/`classify`/`extract`) and `identity.test.ts` patterns.
- **Requires a live Composio connection** (deferred per the `verifying-behavior` missing-capability rule — no Composio account or throwaway Google/MS accounts exist): Connect Link OAuth round-trip, a real Gmail trigger firing a webhook, scope behavior, `session.toolkits()` reflecting connected apps, and cross-tenant isolation at Composio's layer.

## Open Questions
- **Where does the inbound `externalId` get persisted and de-duplicated?** No capture-level external-id column or unique constraint exists; `recordFieldNote` doesn't accept metadata. Resolving inbound idempotency touches schema + the shared write-path signature — both currently absent. (Schedule sync's `external_row_key` is the only existing model.)
- **What identity does a webhook-sourced capture carry?** The write-path expects a `technicianRef`; an inbound CRM/email event has no technician. The current Gmail path uses a synthetic literal (`'tech-email'`); there is no defined convention for connector-sourced identity, and the MCP signed-header identity seam does not cover non-agent ingestion.
- **Which Composio source types reuse existing `capture_channel` enum values vs. require a migration?** Determinable only against the actual Composio toolkits/trigger types to be enabled.
- **Does outbound need any repo code at all, or is it entirely gateway/Composio config?** No outbound (agent-action) code exists; the recorded design says the Tool Router `mcp.url` exposes tools "for free," which is unverified against an actual Composio MCP endpoint.
- **Microsoft Excel path** has no code or dependency (no Graph/Azure SDK); the only spreadsheet code is Google Sheets read-only via service account — a different auth and direction than the recorded per-tenant OAuth read/write design.
