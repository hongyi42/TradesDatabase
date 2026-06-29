---
date: 2026-06-25
task: Build the testable-now Composio inbound connector seam (capture idempotency + normalizer + webhook)
research: thoughts/shared/research/2026-06-25-composio-connector-layer.md
status: complete
---

## Post-review remediation (2026-06-28)

A high-effort `/code-review` over the full diff surfaced bugs (none caught by the
per-phase reviews because they only manifest with `ALLOWED_CLIENT_IPS` set + a live
Composio sender). All fixed, with tests; gates green (78 tests):

- **#1 webhook unreachable in prod** — the IP allowlist 403'd `/inbound/` before HMAC.
  Moved the `/inbound/` branch above `allowed()` in `httpServer.ts`; webhooks now auth
  by HMAC, the MCP path keeps the IP allowlist + identity header unchanged.
- **#2 retry storm** — the catch-all mapped every throw to 401. `handleInboundWebhook`
  now returns discriminated statuses; `httpServer` maps them with correct retry
  semantics (200 ack / 401 bad_signature / 400 bad_payload / 422 unknown_tenant /
  503 transient / 500 server fault). Deterministic failures don't retry; transient do.
- **#3 partial-failure healing** — the `external_id` dedup no-op'd orphans (L1 written,
  L2 build failed). `recordFieldNote` now checks `captureHasLinkedL2`: linked → real
  duplicate; orphan → reuse the L1 row and re-run extract→L2 on redelivery.
- **#4 unvalidated tenant** — webhook now `tenantExists()`-pre-checks `userId` →
  `unknown_tenant` (422) before any write; FK 23503 is the backstop.
- **#5 inconsistent classifier input** — webhook fed the classifier the header-prefixed
  `rawText`; now feeds the clean body via `sourceMeta.body`, matching the pull path.
  `formatEmailRawText` is the single source of the L1 storage string (was #9 too).
- **Privacy — content-free drop audit** — non-work drops now write a metadata-only
  `dropped_audit` receipt (tenant/channel/external_id/sender_domain/reason — NO body,
  subject, or full address) so a mis-drop is detectable/recoverable from the source
  without retaining personal mail. Both the pull and webhook paths write it.

Deferred (still capability-blocked): the live Composio webhook E2E (Phase 3 live check).
Noted for later (not done): FP/erasure-vs-append-only (crypto-shred), a relationship-
judge override (known-customer cross-check), and a local DLP/redaction stage.

---

## Overview
Composio is **not** in the repo and **cannot be tested live** (no Composio account, no throwaway
Google/MS accounts — research doc "Testability split"). So this plan builds only the **inbound seam
Composio plugs into**, which is fully testable now with stubs + the test Supabase project: (1)
capture-level external-id idempotency in the schema + shared write-path, (2) a connector-agnostic
inbound **normalizer** registry (Gmail first), (3) a generic **webhook handler** that HMAC-verifies the
payload, routes by `toolkit`+`triggerType`, runs classify-before-L1, and lands the note through
`recordFieldNote`. It also closes the documented idempotency gap in the existing Gmail connector.

**Explicitly out of scope (live-Composio-dependent, deferred per the missing-capability rule + YAGNI):**
the Composio SDK, the onboarding/Connect-Link control-plane endpoint, per-tenant Tool Router `mcp.url`
injection, and outbound (agent-action) tooling. None has a code-testable surface without a live account.

## Phase 1: Capture-level idempotency (schema + write-path)

### What this phase does
Gives `raw_captures` a per-tenant external id with a unique index, threads `externalId`/`occurredAt`/
`sourceMeta` through `recordFieldNote` → `appendRawCapture`, and short-circuits a duplicate `externalId`
to a no-op. Proven end-to-end by making the existing Gmail connector dedup on the message id (its
documented gap, [src/email/ingest.ts:63-66](../../../src/email/ingest.ts#L63-L66)).

### Changes required

**`supabase/migrations/<new-timestamp>_raw_capture_external_id.sql`** (create via `npx supabase migration new raw_capture_external_id`)
- Add the column + a **partial** unique index. (`uq_schedule_entries_rowkey` at migration `:28` is the
  per-tenant-external-id *idea*, but it is a *plain* unique index because `external_row_key` is `not null`;
  the `where external_id is not null` clause is **new and required here** because technician/MCP captures
  have no external id.)
  ```sql
  alter table raw_captures add column external_id text;
  create unique index uq_raw_captures_external_id
    on raw_captures (tenant_id, external_id) where external_id is not null;
  create index idx_raw_captures_external_id on raw_captures(external_id);
  ```
  Append-only trigger ([:117-119](../../../supabase/migrations/20260620005307_context_spine.sql#L117-L119)) is unaffected (insert-only path).

**`src/db/rawCaptures.ts`**
- Add `externalId?: string | null` to `AppendRawCaptureInput` ([:7](../../../src/db/rawCaptures.ts#L7)); insert `external_id: input.externalId ?? null` in `appendRawCapture` ([:24-33](../../../src/db/rawCaptures.ts#L24-L33)).
- Add `getRawCaptureByExternalId(tenantId, externalId): Promise<RawCapture | null>` — `.eq('tenant_id', …).eq('external_id', …).maybeSingle()`.
- Export a Postgres-unique-violation detector (`isUniqueViolation(error): boolean` — Supabase surfaces it as `error.code === '23505'`) for the conflict backstop below.

**`src/writePath/recordFieldNote.ts`**
- `RecordFieldNoteInput` ([:19](../../../src/writePath/recordFieldNote.ts#L19)): add `externalId?: string | null; occurredAt?: string | null; sourceMeta?: Json`.
- `RecordFieldNoteResult.status` ([:33](../../../src/writePath/recordFieldNote.ts#L33)): add `'duplicate'`.
- Before the L1 append, on a **fresh** call only (`!input.captureId && input.externalId`), look up
  `getRawCaptureByExternalId(tenantId, input.externalId)`; if found `return { status: 'duplicate', captureId: dup.id }`.
  This pre-check is a cheap fast-path, **not** the authoritative guard.
- **The unique index is the authoritative dedup** (the pre-check has a TOCTOU gap: two concurrent webhook
  retries of the same message both miss the lookup and both insert). Wrap the `appendRawCapture` call: if
  it fails with `isUniqueViolation`, re-read via `getRawCaptureByExternalId` and `return { status:'duplicate',
  captureId }` instead of throwing — so a concurrent retry resolves to a no-op, not a 500 that makes Composio
  retry forever. (Append-only forbids upsert, so insert-then-catch-23505 is the only correct path here.)
- In the `appendRawCapture` call ([:69-74](../../../src/writePath/recordFieldNote.ts#L69-L74)) pass `externalId: input.externalId`
  and `metadata: { ...(sourceMeta object), occurredAt }` (omit undefined keys). `occurredAt`/`sourceMeta`
  live in `metadata` JSONB (no new columns) — their schema home per the research doc.

**`src/email/ingest.ts`**
- In the `recordFieldNote` call ([:84-92](../../../src/email/ingest.ts#L84-L92)) pass `externalId: email.id` (the Gmail message id,
  carried but never persisted today) and `sourceMeta: { from: email.from, subject: email.subject }`.

**Strict ordering** (else the tree is broken mid-phase): (a) write the migration → (b) apply it to the
**test** project (`--linked` ref must be `daqapdlkgxfrhquacprv`, never prod) → (c) `npm run gen:types`
(so `database.types.ts` gains `raw_captures.external_id`) → (d) write the `rawCaptures`/`recordFieldNote`/
`ingest` edits → (e) run the gates below. Running `typecheck` before (c) will fail on the new column.
- [x] `npm run typecheck` && `npm run lint` && `npm run build` pass.
- [x] `npm test` passes, incl. new cases in [recordFieldNote.test.ts](../../../src/writePath/recordFieldNote.test.ts): (a) a note with `externalId` persists `external_id` + `metadata.occurredAt` (pg read-back); (b) a second call with the same `(tenant, externalId)` returns `status:'duplicate'`, **no** second L1 row and **no** second job/visit (assert via `select count(*) from raw_captures where external_id = $1` → 1, and job/visit counts unchanged).
- [x] Updated [ingest.test.ts](../../../src/email/ingest.test.ts): within **one** test, run `ingestEmail` twice over the same `Email.id` set; assert `count(*) from raw_captures where channel='email'` is unchanged between pass 1 and pass 2 (the **load-bearing** assertion — `result.ingested` is incremented unconditionally at [ingest.ts:93](../../../src/email/ingest.ts#L93) and proves nothing on its own).

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP (or `DATABASE_URL` + `npm run db:push`) — test project ref `daqapdlkgxfrhquacprv`.
- [x] Apply the migration to the **test** project and confirm `external_id` + `uq_raw_captures_external_id` exist (`list_tables` / `information_schema`). **Never touch prod (read-only).** — applied via `supabase db push` to linked test ref `daqapdlkgxfrhquacprv`; `information_schema` read-back confirmed column `external_id` (text) + indexes `uq_raw_captures_external_id`, `idx_raw_captures_external_id`.

### Manual verification
- None.

---
*Manual list empty → continue.*

## Phase 2: Inbound normalizer registry (Gmail first)

### What this phase does
Adds the connector-agnostic `payload → InboundEnvelope` seam: a normalizer registry keyed by
`toolkit`+`triggerType`, plus the Gmail normalizer. Pure functions, no DB/network — fully unit-testable.
Keeps the design connector-agnostic (research doc "Stay connector-agnostic") rather than Gmail-shaped.

### Changes required

**`src/inbound/normalize.ts`** (new)
- `InboundEnvelope` = `{ channel: CaptureChannel; rawText?: string | null; blobRef?: string | null; externalId: string; occurredAt?: string; sourceMeta?: Json; requiresWorkClassifier?: boolean }`.
  `channel` is constrained to the `capture_channel` enum (migration [:16-22](../../../supabase/migrations/20260620005307_context_spine.sql#L16-L22)) — `'email'` reuses an existing value, no enum migration.
- `type Normalizer = (payload: unknown) => InboundEnvelope`.
- `registerNormalizer(toolkit, triggerType, fn)` / `resolveNormalizer(toolkit, triggerType): Normalizer | null`,
  keyed `\`${toolkit}:${triggerType}\`.toUpperCase()`.

**`src/inbound/gmail.ts`** (new)
- `gmailNewMessageNormalizer`: maps the `GMAIL_NEW_GMAIL_MESSAGE` payload → `{ channel:'email',
  rawText: \`Subject: …\nFrom: …\n\n<body>\`, externalId: <messageId>, occurredAt, sourceMeta:{from,subject},
  requiresWorkClassifier:true }`. Same text shape as [ingest.ts:89](../../../src/email/ingest.ts#L89). Throws if `messageId` is missing.
- `registerNormalizer('GMAIL', 'GMAIL_NEW_GMAIL_MESSAGE', gmailNewMessageNormalizer)`.
- **Uncertainty:** exact Composio payload field names (`messageId`/`sender`/`messageText`/`messageTimestamp`)
  are a best-effort mapping — unverifiable without a live trigger. The normalizer is unit-tested against a
  fixture (seam proven regardless); confirm field names during Phase 3's deferred live check and adjust the
  one mapping function if needed.

### Automated verification
- [x] `npm run typecheck` && `npm run lint` && `npm run build` pass.
- [x] `npm test` passes, incl. new `src/inbound/normalize.test.ts`: a fixture Gmail payload → the expected
  envelope (channel `'email'`, `externalId`, `requiresWorkClassifier:true`, text shape); `resolveNormalizer`
  round-trips a registered key and returns `null` for an unknown `toolkit`/`triggerType`.

### Live verification (agent-executable)
- None (pure functions).

### Manual verification
- None.

---
*Manual list empty → continue.*

## Phase 3: Generic inbound webhook handler

### What this phase does
Adds the entry point Composio's triggers call: HMAC-verify the payload (`webhook-signature`), route by
`toolkit`+`triggerType` to a normalizer, run the **classify-before-L1** work/personal gate (reusing the
existing classifier) for sources that need it, then land the note via `recordFieldNote`. Resolves the
research doc's open questions: tenant comes from the signed payload's Composio `user_id`; connector-sourced
identity is the convention `connector:<toolkit>`.

### Changes required

**`src/inbound/webhook.ts`** (new)
- `verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean` —
  HMAC-SHA256 over the **raw body bytes**, length-guard then `timingSafeEqual` (mirror [identity.ts:54-60](../../../src/mcp/identity.ts#L54-L60); return `false` instead of throwing on bad hex/length).
- `handleInboundWebhook(rawBody: string, signature: string | undefined, deps?)`:
  - Read `COMPOSIO_WEBHOOK_SECRET` from env (throw if unset, like `GATEWAY_IDENTITY_SECRET`); if `verifyWebhookSignature(...)` returns `false`, **throw** (the httpServer maps the throw to `401`).
  - `JSON.parse(rawBody)` → `{ userId, toolkit, triggerType, data }`. `tenantId = userId` (Composio `user_id` == tenant uuid; trustworthy **because** the HMAC verified).
  - `resolveNormalizer(toolkit, triggerType)`; if `null` → `{ status: 'unrouted' }`.
  - If `envelope.requiresWorkClassifier`: run `classify({ from, subject, body })` (from `sourceMeta`/`rawText`); if `!isWork` → `{ status: 'skipped_non_work' }` **before** any `recordFieldNote`/L1 write.
  - Else call `recordFieldNote({ tenantId, technicianRef: \`connector:${toolkit.toLowerCase()}\`, channel, text: rawText, blobPath: blobRef, externalId, occurredAt, sourceMeta })`; return `{ status: r.status==='duplicate'?'duplicate':'ingested', captureId: r.captureId }`.
  - Injectable `deps`: `{ recordFieldNote?, classify?, resolveNormalizer? }` (defaults = live impls); `import './gmail.js'` so the Gmail normalizer self-registers.

**`src/mcp/httpServer.ts`**
- In `handle` ([:34](../../../src/mcp/httpServer.ts#L34)), inside the existing `try` and **after** `allowed(req)` but **before** `resolveIdentityFromHeaders`,
  branch on `req.url?.startsWith('/inbound/')`. Read the **raw** body string (a new `readRawBody` that returns the
  string — do **not** also call the JSON `readBody` at [:27-32](../../../src/mcp/httpServer.ts#L27-L32); the stream is consumable once), call
  `handleInboundWebhook(raw, req.headers['webhook-signature'], {})`, respond `200` with the result JSON
  (`unrouted`/`skipped_non_work` still `200` — acknowledge so Composio doesn't retry), and `return` before the
  MCP path. A throw falls through to the existing `catch` → `401`. The MCP branch (non-`/inbound/` URLs) keeps using `readBody`, unchanged.

**`.env.example`** — add `COMPOSIO_WEBHOOK_SECRET=` under a new "Composio inbound webhook" section.

### Automated verification
- [x] `npm run typecheck` && `npm run lint` && `npm run build` pass.
- [x] `npm test` passes, incl. new `src/inbound/webhook.test.ts` (HMAC cases mirror [identity.test.ts](../../../src/mcp/identity.test.ts)):
  valid signature + Gmail payload + stub `classify`(isWork:true) + stub `recordFieldNote` → `ingested` and `recordFieldNote` called with channel `'email'`, `externalId`, `technicianRef:'connector:gmail'`;
  missing/tampered/wrong-length signature → throws;
  stub `classify`(isWork:false) → `skipped_non_work` **and `recordFieldNote` NOT called** (classify-before-L1 proven);
  unknown `toolkit` → `unrouted`;
  duplicate `externalId` (real `recordFieldNote` vs test DB, or stub returning `duplicate`) → `duplicate`.

### Live verification (agent-executable — DEFERRED)
- Prerequisites (**none available now → deferred per the `verifying-behavior` missing-capability rule**):
  a live Composio account, a connected test Gmail, a publicly reachable webhook URL.
- [ ] Real `GMAIL_NEW_GMAIL_MESSAGE` trigger → webhook → an L1 `raw_captures` row `channel='email'`,
  `external_id`=Gmail message id (read back over `pg`); a non-work email produces no row; confirm the
  Phase-2 field-name mapping; a second tenant's connected account cannot surface in tenant A (the
  `user_id`=tenant isolation check from `docs/nemoclaw-tech-agent.md` §"Live verification").

### Manual verification
- None (all remaining checks are agent-executable once the Composio capability exists).

---
*Manual list empty; the only outstanding checks are capability-blocked (deferred), not human-judgment.*
