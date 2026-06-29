---
date: 2026-06-29
branch: main
commit: 8599a88
topic: async webhook ingestion — how recordFieldNote couples the Composio webhook and email pull paths, what an appendInboundCapture/extractCaptureToL2 split would touch, worker seams, and Composio's retry/timeout behavior
---

## Summary
The inbound write-path turns an external capture (a Composio Gmail webhook, a Gmail pull, an MCP
field note) into the three-layer spine: raw text lands in L1 (`raw_captures`, append-only), then an
AI extraction + a deterministic identity match build L2 (`customers`/`jobs`/`visits`). The single
function `recordFieldNote` (`src/writePath/recordFieldNote.ts`) performs **all of this synchronously
in one call** — L1 append/dedup/heal, then two live Sonnet calls' worth of work downstream
(extraction; classification happens in the callers). The Composio webhook handler
(`src/inbound/webhook.ts`) calls `recordFieldNote` inline on the HTTP request thread, so the `200`
ack is delayed by the model latency. This document maps that path, the three callers that share
`recordFieldNote`, and the seams a fast-ack/background-worker design would cross. It makes no
recommendations.

## Entry Points
- **HTTP webhook entry:** `src/mcp/httpServer.ts:76` `handle()` → routes `/inbound/*` to
  `handleInbound()` at `src/mcp/httpServer.ts:61` (before the IP allowlist at `:83`).
- **Inbound handler:** `src/inbound/webhook.ts:108` `handleInboundWebhook(rawBody, headers, deps)`.
- **Pull entry:** `src/email/ingest.ts:75` `ingestEmail(tenantId, technicianRef, deps)`.
- **MCP tool entry:** `src/mcp/server.ts:158` (the `record_field_note` tool dispatch).
- **Shared core:** `src/writePath/recordFieldNote.ts:60` `recordFieldNote(input, deps)`.
- **HTTP status mapping:** `src/mcp/httpServer.ts:45` `INBOUND_STATUS_CODES` and `:61-74` `handleInbound`.

## Key Files
- `src/writePath/recordFieldNote.ts` — the shared write-path core. Exports `recordFieldNote`,
  `RecordFieldNoteInput`, `RecordFieldNoteResult`. Does L1 append/dedup/heal (`:67-128`), extraction
  (`:131`), identity match (`:134-140`), and L2 build / ask-return (`:142-202`).
- `src/inbound/webhook.ts` — Composio webhook handler. `verifyWebhookSignature` (`:28`),
  `handleInboundWebhook` (`:108`). Verifies HMAC, parses the V3 envelope (`:126-136`), `tenantExists`
  pre-check (`:155`), classify-before-L1 (`:160-177`), then `recordFieldNote` (`:182`). Maps the
  result to `ingested|duplicate` (`:191`). Returns a discriminated `InboundWebhookStatus` (`:82-90`).
- `src/mcp/httpServer.ts` — `node:http` server. `handleInbound` (`:61`) reads the raw body, calls
  `handleInboundWebhook`, maps status→HTTP code via `INBOUND_STATUS_CODES` (`:45-54`). `INBOUND_DEBUG`
  block (`:78-` of `handle`/`handleInbound`) logs + writes `inbound-last.json`.
- `src/email/ingest.ts` — Gmail pull. `ingestEmail` (`:75`) loops fetched emails, classifies
  (`:87`), drops non-work to `upsertDroppedAudit` (`:92`), and feeds work mail to `recordFieldNote`
  (`:102`). Default `gmailFetcher` (`:33`) uses `newer_than:7d`, `maxResults:25`.
- `src/email/classify.ts` — `sonnetClassifier` (`:39`), `WorkClassifier` type. One forced-tool Sonnet
  call (`claude-sonnet-4-6`, `max_tokens:256`).
- `src/writePath/extract.ts` — `sonnetExtractor` (`:73`), `Extractor` type. One forced-tool Sonnet
  call (`claude-sonnet-4-6`, `max_tokens:1024`).
- `src/writePath/identityMatch.ts` — `matchIdentity` (`:44`). Deterministic, DB-reading (phone/
  address/schedule); returns `matched|needs_confirmation|needs_disambiguation` + optional
  `createFrom`/`suggestion`.
- `src/db/rawCaptures.ts` — `appendRawCapture` (insert-only), `getRawCaptureByExternalId`,
  `captureHasLinkedL2` (`:100`), `isUniqueViolation`/`isForeignKeyViolation`. L1 append-only.
- `src/db/droppedAudit.ts` — `upsertDroppedAudit` (`:28`), `senderDomain` (`:17`). Content-free drop
  receipt, idempotent on `(tenant_id, external_id)`.
- `src/inbound/normalize.ts` / `src/inbound/gmail.ts` — normalizer registry + Gmail normalizer
  (payload → `InboundEnvelope`).
- `src/mcp/server.ts` — `record_field_note` MCP tool dispatch (`:158`) → `recordFieldNote`.

## Data Flows

### Composio webhook (latency-bound path)
`httpServer.handle` (`:76`) → `req.url` starts `/inbound/` → `handleInbound` (`:61`) reads raw body,
picks `webhook-id`/`webhook-timestamp`/`webhook-signature`, calls
`handleInboundWebhook(raw, headers, {})`. Inside (`webhook.ts:108`):
1. `COMPOSIO_WEBHOOK_SECRET` required (`:113`, throw→500).
2. `verifyWebhookSignature` (`:115`) — HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`, raw secret as
   key, base64, `v1,<b64>` header, ±300s replay guard. Fail → `bad_signature` (401).
3. `JSON.parse` → V3 envelope; `userId = metadata.user_id`, `triggerType = metadata.trigger_slug`,
   `toolkit = triggerType.split('_')[0]` (`:126-133`). Missing → `bad_payload` (400).
4. `resolveNormalizer(toolkit, triggerType)` (`:135`); null → `unrouted` (200).
5. `normalizer(event.data)` → `InboundEnvelope` (`:138-143`); throw → `bad_payload`.
6. `tenantExists(userId)` (`:155`) — false → `unknown_tenant` (422).
7. If `requiresWorkClassifier`: `classify(...)` (`:160`, **Sonnet call #1**). Non-work →
   `upsertDroppedAudit` + `skipped_non_work` (200).
8. `recordFieldNote({...})` (`:182`, contains **Sonnet call #2** = extract) → result mapped to
   `ingested|duplicate` (`:191`). DB/model throw → `transient_error` (503); FK 23503 →
   `unknown_tenant` (422).
`handleInbound` maps the status to an HTTP code (`INBOUND_STATUS_CODES`) and ends the response. The
ack is therefore emitted **after** both Sonnet calls + the L2 writes complete.

### recordFieldNote internals (`:60-203`)
- (1) L1 (`:67-128`): if `input.captureId` set → reload existing capture (resume). Else: if
  `externalId` set, `getRawCaptureByExternalId`; if found and `captureHasLinkedL2` → return
  `duplicate`; if found orphan → reuse; else `appendRawCapture`, with a 23505 insert-then-catch TOCTOU
  backstop (`:109-122`).
- (2-3) `extract(rawText)` (`:131`) — Sonnet.
- (4) `matchIdentity(...)` (`:134`).
- (6) If `match.status !== 'matched'` and no `confirmed` → return `{status, captureId, suggestion}`
  WITHOUT building L2 (`:143-145`).
- (5) Else resolve/create customer (`:149-167`), resolve/create job (`:171-184`), create visit
  (`:187-194`), legal status transition (`:198-200`), return `matched`.
- Returns `RecordFieldNoteResult` with `status: matched|needs_confirmation|needs_disambiguation|
  duplicate` (`:42`).

### Gmail pull (batch path, not latency-bound)
`ingestEmail` (`:75`) → `fetch()` → per email: `classify` (`:87`, Sonnet) → non-work →
`upsertDroppedAudit` (`:92`); work → `recordFieldNote` (`:102`) with `externalId: email.id`. Counts
`ingested` unless `duplicate` (`:113`). Runs as a loop, no HTTP deadline.

### MCP tool (interactive path)
`server.ts:158` calls `recordFieldNote` and returns its full result to the agent — including
`needs_confirmation`/`needs_disambiguation` + `suggestion` + `captureId`, which the agent uses to ask
the technician and then **resume** by re-calling with `captureId` + `confirmed`. This path depends on
the synchronous extract→match→ask round-trip.

## recordFieldNote coupling (the split question)
Three production callers share `recordFieldNote`:
- `src/inbound/webhook.ts:182` — uses only `duplicate` vs (everything-else→`ingested`); ignores the
  `needs_confirmation`/`needs_disambiguation` distinction and `suggestion`.
- `src/email/ingest.ts:102` — uses only `status !== 'duplicate'` to count; ignores match outcome.
- `src/mcp/server.ts:158` — uses the **full** result, including the ask/resume machinery and `captureId`.

A natural seam exists inside `recordFieldNote` between step (1) (L1 append/dedup/heal, ending at
`:128` with `captureId`/`rawText`/`capturedAt`) and steps (2-6) (extract→match→L2/ask). An
`appendInboundCapture` would be step (1); an `extractCaptureToL2(captureId, {confirmed?})` would be
steps (2-6). Observations relevant to such a split:
- The **resume** path (`input.captureId` + `confirmed`) lives in both halves: step (1) reloads the
  capture, steps (2-6) consume `confirmed`. The MCP caller is the only one exercising resume.
- The webhook and pull callers never use `confirmed`/`suggestion`; for them step (2-6)'s only outputs
  that matter are "did L2 build / was it a duplicate."
- `recordFieldNote.test.ts` has 8 tests (`:43,:93,:101,:128,:142,:150,:183,:221,:227,:263,:272,:283`)
  asserting the combined flow, including the orphan-heal path (`:263-283`) where a flaky extractor
  throws on first call and heals on redelivery. Those tests target the combined function.
- `webhook.test.ts` injects a stub `recordFieldNote` via `InboundWebhookDeps.recordFieldNote`
  (`webhook.ts:67`), so the handler is already decoupled from the real implementation at the seam of
  that dependency.
- There is **no** `processed_at` marker anywhere: L1 is append-only (`appendRawCapture` is insert-only;
  DB trigger blocks UPDATE), so a "needs reprocessing vs done vs terminally-unmatched" state has no
  home today. `captureHasLinkedL2` (`rawCaptures.ts:100`) infers "done" only by the presence of a
  linking L2 row; it cannot distinguish a work-but-unmatched capture (`needs_disambiguation`, will
  never gain L2 without confirmation) from an orphan whose extract failed (should be retried). Both
  re-run extract on every redelivery (documented at `recordFieldNote.ts:84-88` and `ingest.ts:70-74`).

## Worker-mechanism options present in the codebase today
- No background-job infrastructure exists: grep for `capture_processing|processed_at|worker|setInterval`
  returns **no matches** in `src/`. There is no queue table, no cron, no interval loop.
- The HTTP server (`httpServer.ts`) is `node:http`, stateless (`sessionIdGenerator: undefined`,
  comment at `:9-12`), started by `main()` (`:111`) only when run directly (`:120`).
- Existing periodic-ish jobs: `src/schedule/sheetSync.ts` (`syncScheduleFromSheet`) is invoked
  externally (no scheduler in-repo). Migrations show no `pg_cron`.
- Durable stores available: Postgres (Supabase) via `src/db/`. No Redis/SQS/queue dependency in
  `package.json`.
- `package.json` scripts: `mcp:serve`, `mcp:serve:http`, `seed`, `db:push`, `gen:types` — no worker
  script.

## External Dependencies
- **Anthropic** (`@anthropic-ai/sdk`) — `claude-sonnet-4-6` for both `sonnetClassifier`
  (classify.ts:46) and `sonnetExtractor` (extract.ts:79). These are the two latency sources on the
  webhook path.
- **Composio** — posts the V3 webhook (`@composio/core` is a devDependency, used only by the helper
  scripts `scripts/composio-trigger.mjs` / `composio-reconnect.mjs`, not by `src/`). Signing scheme
  per `docs.composio.dev/docs/webhook-verification`.
- **Supabase/Postgres** (`@supabase/supabase-js`, `pg`) — all L1/L2/audit storage.
- **Google APIs** (`googleapis`) — the pull-path `gmailFetcher` and Sheet sync.

## Composio retry / timeout behavior (documented vs observed)
- **Documented:** `docs.composio.dev/docs/webhook-verification` covers signing/verification only; it
  does NOT state a per-attempt timeout, retry count, backoff schedule, success-vs-retry status codes,
  or auto-disable policy (confirmed by fetch). A web search for Composio's specific policy returned
  only general webhook-retry articles, no Composio numbers. Composio uses a Standard-Webhooks-style
  scheme; the SDK exposes `triggers.verifyWebhook`/`parseWebhookPayload`/`validateWebhookTimestamp`
  (observed via SDK prototype introspection on 2026-06-28).
- **Observed (live test 2026-06-28, captured in `INBOUND_DEBUG` logs):** for one email, Composio sent
  `x-composio-delivery-attempt` 1→4 with `webhook-timestamp` 1782701462, 1782701467, 1782701474,
  1782701485 (deltas ≈ 5s, 7s, 11s). The `x-composio-webhook-version` header is `V3`. A
  `composio.trigger.disabled` event type exists in the webhook subscription options (seen in the
  dashboard webhook setup), indicating Composio can disable a trigger after failures. The exact
  threshold/timeout are not documented.

## Constraints and Invariants
- **L1 append-only** (`appendRawCapture` insert-only; DB trigger blocks UPDATE/DELETE). No
  `processed_at` can be added to `raw_captures` rows after insert. Cleanup is TRUNCATE, not DELETE.
- **classify-before-L1** (CLAUDE.md; `webhook.ts:157-159`, `ingest.ts:88-91`): non-work mail must be
  judged BEFORE any L1 write, because L1 cannot be deleted. Non-work → content-free `dropped_audit`
  only; the raw email is never persisted.
- **External-id idempotency**: `uq_raw_captures_external_id` partial unique index dedups L1 per
  tenant; the write-path uses a pre-check + 23505 insert-then-catch TOCTOU backstop. Verified live:
  4 webhook deliveries → 1 L1 row.
- **Provenance via `source_capture_id` on L2** (never back-written onto L1).
- **Identity matching is deterministic and may return needs_confirmation/needs_disambiguation**; the
  caller (agent) confirms. The webhook/pull callers have no human in the loop, so an unmatched work
  email stays L1-only by design.
- **The HTTP ack currently waits on both Sonnet calls.** `handleInbound` cannot respond until
  `handleInboundWebhook` returns, which awaits `classify` then `recordFieldNote` (extract + L2).
- **MCP `record_field_note` depends on the synchronous flow** to drive the confirmation/resume UX.

## Open Questions
- **Composio's exact per-attempt timeout and retry/backoff schedule, and the auto-disable threshold.**
  Not documented; only the observed deltas (~5/7/11s for the first 4 attempts) are known. Would need a
  controlled probe (respond slowly with known delays, watch attempt deltas) or Composio support to pin
  down. Determines how tight the ack budget is.
- **`sonnetClassifier` and `sonnetExtractor` real latency (p50/p95)** on representative emails — not
  measured here (research is read-only, no runs). Determines whether classify can stay synchronous
  inside any future ack budget.
- **Whether the MCP `record_field_note` resume flow can or should share an async path** or must remain
  fully synchronous (it is the only caller using `confirmed`/`suggestion`/`captureId` resume).
- **Where a worker would run** given the stateless `node:http` server: in-process interval, separate
  process, or pg-cron/Supabase scheduled function — each has different operational coupling; no
  precedent exists in-repo.
- **How a future processing-state store would distinguish** terminally-unmatched (`needs_disambiguation`)
  captures from retryable orphans, given L1 cannot hold the flag and `captureHasLinkedL2` cannot tell
  them apart.

## Sources (external)
- Composio webhook verification doc: https://docs.composio.dev/docs/webhook-verification
- Svix retry strategies (Standard Webhooks background): https://www.svix.com/resources/webhook-university/reliability/webhook-retry-strategies/
