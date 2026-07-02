---
date: 2026-07-01
branch: main
commit: a82ec44
topic: Identity propagation for the Composio pairing model — how user_id / tenantId / technicianRef flow through the inbound seam, gateway, doorman, write-path, and DB
---

## Summary

This documents how identity — *which business* (`tenantId`) and *which person* (`technicianRef`) — is established and propagated through every layer of the system today: the Composio inbound webhook seam, the central MCP HTTP server, the host-side doorman proxy, the shared write-path, and the database schema. The system has **two distinct identity models running side by side**: the MCP tool-call path carries a two-level `{tenantId, technicianRef}` identity end-to-end (badge → doorman → signed headers → tools), while the Composio inbound path carries a **single-level** identity — Composio's `user_id` is used *verbatim* as `tenant_id`, and the person dimension is synthesized as the constant `connector:gmail`. This asymmetry is the exact surface a per-person pairing model (N people × N inboxes per business) would touch.

## Entry Points

- `src/mcp/httpServer.ts:110-137` — `handle()`: the single HTTP entrypoint. Routes `/inbound/*` to the webhook handler **before** the IP allowlist (`httpServer.ts:113-115`); all other paths require the gateway's signed identity headers (`httpServer.ts:125`).
- `src/inbound/webhook.ts:109` — `handleInboundWebhook(rawBody, headers, deps)`: the Composio trigger entry point (verify → parse → route → tenant-validate → classify → write).
- `Box Setup Stuff/doorman.mjs:20` — the doorman HTTP server: sandbox badge in → signed identity headers out, forwarded to the Render MCP server.
- `src/mcp/server.ts:268` — stdio entrypoint; pins one identity for the whole process via `identityFromEnv()`.

## Key Files

| File | Role | Key exports / details |
|---|---|---|
| `src/mcp/identity.ts` | Identity type + both resolution sources | `RequestIdentity {tenantId, technicianRef, scopes?}` (`:13-17`); `identityFromEnv()` (`:21-27`, reads `DEFAULT_TENANT_ID`/`DEFAULT_TECHNICIAN_REF`); `resolveIdentityFromHeaders()` (`:41-63`, HMAC-verifies `x-tenant-id`/`x-technician-ref`/`x-identity-signature`) |
| `src/mcp/httpServer.ts` | Central HTTP server | `INBOUND_STATUS_CODES` (`:45-54`); webhook bypasses allowlist + identity headers (`:56-60` comment, `:113`) |
| `src/inbound/webhook.ts` | Composio webhook handler | `verifyWebhookSignature()` (`:29-64`); `handleInboundWebhook()` (`:109-199`); `tenantId = userId` at `:148`; `technicianRef: 'connector:' + toolkit` at `:184` |
| `src/inbound/normalize.ts` | Connector-agnostic envelope + registry | `InboundEnvelope` (`:7-21`) — **carries no identity fields**; identity comes only from the webhook envelope's `metadata.user_id` |
| `src/inbound/gmail.ts` | Gmail normalizer | Maps `data.{message_id,sender,subject,message_text,message_timestamp}` → envelope; self-registers `GMAIL:GMAIL_NEW_GMAIL_MESSAGE` (`:40`) |
| `src/writePath/recordFieldNote.ts` | Shared L1→L2/L3 write-path | `RecordFieldNoteInput` requires `tenantId` + `technicianRef` (`:24-25`); technicianRef flows to `matchIdentity` (`:134-140`) and `visits.technician_name` (`:190`) |
| `src/writePath/identityMatch.ts` | Deterministic customer/job resolution | `matchIdentity()` (`:44`) uses `technicianRef` **only** for the schedule lookup `listScheduleForTechnicianOnDate(tenantId, technicianRef, capturedAt)` (`:67`) |
| `src/db/tenants.ts` | Tenant pre-validation | `tenantExists(tenantId)` (`:7-15`) — the webhook calls this on Composio's `user_id` **verbatim** |
| `src/db/rawCaptures.ts` | L1 access | `appendRawCapture()` (`:24`) — input has **no technician field**; dedup key is `(tenant_id, external_id)` (`:60-72`) |
| `Box Setup Stuff/doorman.mjs` | Badge→identity translator | Badge table entry = `{tenantId, technicianRef, revoked}` (`:23-24`, `:35-37`); signs `HMAC(secret, "<tenantId>.<technicianRef>")` (`:16`) |
| `scripts/composio-reconnect.mjs` | Dev: connect a Gmail account | `TENANT = '82bbc6f8-…'` used directly as the Composio `user_id` (`:9`, `:36`: `link(TENANT, AUTH_CONFIG)`) |
| `scripts/composio-trigger.mjs` | Dev: create the Gmail trigger | `triggers.create(USER_ID, 'GMAIL_NEW_GMAIL_MESSAGE', {triggerConfig})` (`:33-39`); `USER_ID` defaults to the same tenant uuid (`:14-15`) |
| `supabase/migrations/20260620005307_context_spine.sql` | Schema | `tenants` (`:35-39`); `visits.technician_name text` (`:79`); `raw_captures` has **no technician column** (`:92-104`) |
| `supabase/migrations/20260620013000_schedule_entries.sql` | Schedule | `schedule_entries.technician_ref text not null` (`:9`), indexed (`:30`) |
| `supabase/migrations/20260628213156_raw_capture_external_id.sql` | Dedup | partial unique index `(tenant_id, external_id) where external_id is not null` |

## Data Flows

### Flow 1 — MCP tool call (two-level identity, per person)

1. Sandbox agent sends `Authorization: Bearer <badge>` to the doorman (`doorman.mjs:18-22`). The badge is an opaque token; `badges.json` is re-read per request so revocation is instant (`doorman.mjs:23`).
2. Doorman looks up `badge → {tenantId, technicianRef}` and builds fresh headers — it never forwards the badge: `x-tenant-id`, `x-technician-ref`, `x-identity-signature = HMAC-SHA256(GATEWAY_IDENTITY_SECRET, "<tenantId>.<technicianRef>")` hex (`doorman.mjs:31-38`).
3. `httpServer.ts:125` calls `resolveIdentityFromHeaders()`, which recomputes the HMAC and rejects mismatches (`identity.ts:54-60`). The resulting `RequestIdentity` is injected as a server dependency (`httpServer.ts:127`), never read from tool arguments (`identity.ts:3-5`).
4. `server.ts:161` passes `identity.technicianRef` into `recordFieldNote`; `server.ts:136` scopes reads by `identity.tenantId`.

**The MCP path is already per-person capable**: N people = N badges, each mapping to the same `tenantId` with a distinct `technicianRef`. Nothing on this path assumes one person per tenant.

### Flow 2 — Composio inbound webhook (single-level identity, per tenant)

1. Composio POSTs the V3 envelope `{id, type, metadata: {user_id, trigger_slug}, data}` to `/inbound/*` (`webhook.ts:95-98`).
2. HMAC verification via `COMPOSIO_WEBHOOK_SECRET` (`webhook.ts:116`).
3. `userId = event.metadata.user_id` (`webhook.ts:133`); toolkit derived from `trigger_slug.split('_')[0]` (`webhook.ts:135`).
4. **`const tenantId = userId;`** (`webhook.ts:148`) — the Composio `user_id` is the tenant uuid, verbatim, with no parsing or splitting.
5. `tenantExists(tenantId)` pre-validates it against the `tenants` table (`webhook.ts:158`, `tenants.ts:7-15`); unknown → `unknown_tenant` (422, no retry).
6. Classify-before-L1 gate for `requiresWorkClassifier` envelopes (`webhook.ts:163-180`); drops write a content-free `dropped_audit` receipt keyed by `{tenantId, externalId}`.
7. `recordFieldNote({tenantId, technicianRef: 'connector:gmail', …})` (`webhook.ts:182-193`). The person dimension is a **synthetic constant** — `connector:<toolkit>` — not a human identity.

### Flow 3 — technicianRef consumption inside the write-path

`recordFieldNote` uses `technicianRef` in exactly two places:
- `matchIdentity` (`recordFieldNote.ts:134-140`) → `listScheduleForTechnicianOnDate(tenantId, technicianRef, capturedAt)` (`identityMatch.ts:67`), matching against `schedule_entries.technician_ref`. For inbound email, `technicianRef = 'connector:gmail'` will match no schedule rows, so the schedule branch (2/2a/2b) is inert on that path; matching succeeds only via unique phone/address (`identityMatch.ts:55-64`).
- `visits.technician_name` (`recordFieldNote.ts:190`): the created visit records `technician_name = technicianRef` — for inbound email, the literal string `connector:gmail`.

**L1 attribution:** `raw_captures` has no technician column and `appendRawCaptureInput` has no technician field. An L1 capture's person attribution exists nowhere; only the derived visit carries `technician_name`.

### Flow 4 — Composio-side pairing (dev scripts, as exercised live)

- Connect: `connectedAccounts.link(TENANT, 'ac_5CdPk4l3GV2V')` (`composio-reconnect.mjs:36`) — one connected account, keyed by `user_id = <tenant uuid>`, under the shared **Composio Managed** auth config.
- Trigger: `triggers.create(USER_ID, 'GMAIL_NEW_GMAIL_MESSAGE', {triggerConfig: {interval: 1, labelIds: 'INBOX', userId: 'me'}})` (`composio-trigger.mjs:33-39`) — one trigger **per user_id/connected account**; triggers are SDK-only (dashboard cannot create this one, `composio-trigger.mjs:2`).
- Both scripts hardcode the single test tenant `82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18` as the `user_id`.

## External Dependencies

- **Composio** (`@composio/core ^0.13.1`, devDependency only; never imported in `src/`): webhook envelope shape, Standard-Webhooks HMAC scheme, `connectedAccounts.link()`, `triggers.create()`. Auth config `ac_5CdPk4l3GV2V` (`gmail-test`) is dashboard-verified as "Composio Managed" with 11 scopes including `https://mail.google.com/`.
- **Supabase** (`@supabase/supabase-js`): all identity-bearing tables (`tenants`, `raw_captures`, `visits`, `schedule_entries`, `dropped_audit`).
- **Anthropic** (`@anthropic-ai/sdk`): the work/personal classifier and extractor — identity-agnostic; they see only text.
- **Doorman host env**: `GATEWAY_IDENTITY_SECRET`, `/etc/doorman/badges.json`, `MCP_UPSTREAM_URL` (`doorman.mjs:6-13`).

## Constraints and Invariants

1. **`user_id` = tenant uuid, verbatim** (`webhook.ts:148` + `tenants.ts:3-6` comment). `tenantExists` runs an exact `eq('id', tenantId)` lookup — any `user_id` that is not a bare provisioned tenant uuid (e.g. a composite `"<tenant>:<person>"` string) returns `unknown_tenant` → 422 today.
2. **Identity is never model-supplied** (`identity.ts:3-5`): on the MCP path it comes from signed headers; on the inbound path from the HMAC-verified webhook body. Tool arguments cannot set it.
3. **Two different HMAC trust roots**: gateway identity (`GATEWAY_IDENTITY_SECRET`, payload `"<tenantId>.<technicianRef>"`, hex) vs. Composio webhooks (`COMPOSIO_WEBHOOK_SECRET`, payload `"${id}.${timestamp}.${rawBody}"`, base64). The webhook HMAC authenticates the *body*, not the tenant — hence the explicit `tenantExists` pre-check (`webhook.ts:155-158`).
4. **The webhook's HMAC proves authenticity, not authorization for a tenant** (`webhook.ts:155` comment): any valid Composio webhook can name any `user_id`; the tenant check + FK are the guards.
5. **`technicianRef` on inbound is a channel label, not a person**: the constant `connector:<toolkit>` (`webhook.ts:184`). Consequences: (a) `visits.technician_name = 'connector:gmail'`; (b) the schedule-matching branch of `matchIdentity` can never fire for inbound email.
6. **L1 carries no person attribution** — `raw_captures` has `tenant_id` but no technician column (`context_spine.sql:92-104`); person context for a capture would live only in `metadata` JSONB (not currently written) or the derived visit.
7. **Dedup is per-tenant**: `uq_raw_captures_external_id (tenant_id, external_id)`. Two different tenants receiving the same Gmail `message_id` are independent rows; the same tenant receiving it twice (e.g. two connected inboxes both receiving one thread — not possible today with one account per tenant, but relevant to any multi-inbox-per-tenant shape) would collide as a `duplicate`.
8. **One trigger per connected account**: the live setup has exactly one Gmail connected account and one trigger, both keyed by the single test tenant uuid.
9. **Single-tenant assumptions in dev config**: `DEFAULT_TENANT_ID`/`DEFAULT_TECHNICIAN_REF` pin the stdio server to one identity (`identity.ts:21-27`); both dev scripts hardcode the test tenant.
10. **`InboundEnvelope` is identity-free by design** (`normalize.ts:7-21`): normalizers translate payload content only; identity is resolved once, in the webhook handler, from `metadata.user_id`.
11. `raw_captures` is append-only (DB trigger, `context_spine.sql:117-119`) — any identity/attribution written at L1 insert time is permanent.

## Open Questions

1. **Composio `user_id` format freedom**: the repo treats `user_id` as an opaque string it chooses (`link(TENANT, …)`), and dashboard guidance says only "avoid email addresses and `default`". Whether any Composio-side constraint (length, charset) would affect a composite id like `"<uuid>:<ref>"` is unverified against their API.
2. **Trigger payload with multiple connected accounts under one auth config**: the live envelope was captured with a single connected account. Whether `metadata` carries a `connected_account_id` (or similar) that would let one `user_id` own several inboxes and still disambiguate the source inbox is unobserved — only `metadata.user_id` and `metadata.trigger_slug` are read today (`webhook.ts:101`).
3. **`dropped_audit` person attribution**: drops are keyed `{tenantId, externalId}` with `sender_domain` only; whether a per-person pairing model needs drops attributed to a person is a design question, not answerable from the code.
4. **`visits.technician_name` semantics**: it stores whatever `technicianRef` string arrives (badge-mapped ref on the MCP path, `connector:gmail` on the inbound path). There is no `technicians` table — the ref is a free string with no FK anywhere (`schedule_entries.technician_ref` is likewise free text).
5. **Trigger lifecycle management**: `composio-trigger.mjs` creates a trigger imperatively and is not idempotent (`--create` twice errors, per its comment). How N triggers (one per person) would be provisioned/audited/removed has no code surface yet.
