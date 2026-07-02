# Technician agent runbook (NemoClaw + Telegram)

How to wire a per-technician agent to the spine. The agent is the **channel + collector**;
our MCP server ([src/mcp/server.ts](../src/mcp/server.ts)) is the **only thing that touches the
spine** and the only thing that holds the Supabase / Anthropic keys. The agent never sees those
secrets — it calls our tools, we do the rest (L1 → extract → identity match → L2/L3 + provenance).

> Status: this is the deployment guide for the still-to-be-provisioned agent stack. The MCP server
> and its tools are built and tested (in-memory + stdio smoke). The live Telegram E2E below is the
> remaining setup milestone.

## Architecture

```
Telegram (per-tech bot)  ──voice/text──▶  NemoClaw sandbox (OpenClaw runtime)
   voice auto-transcribed (cloud STT)         │  calls our MCP tools over stdio
                                              ▼
                              trades-spine MCP server  ──▶  Supabase (the spine)
                              (holds SUPABASE_* + ANTHROPIC_API_KEY; tenant pinned)
```

- **Per technician:** one named NemoClaw sandbox (`nemoclaw tech-<name>`), lighter policy than the
  manager tier — for v1 it only needs our spine tool (email/SMS connectors come later).
- **Manager agent (full sandbox + broad connectors) is a separate plan**, not covered here.

## 1. Telegram bridge
- Create a bot via **BotFather**; the bot token is registered with the **OpenShell gateway**, not
  placed in this repo or the sandbox (NemoClaw keeps the token out of the model context).
- Restrict the bot to the technician's sender id (per-user allowlist).
- **iMessage is not supported** (Apple does not permit bots) — Telegram only for v1.

## 2. Voice → text (STT)
- Enable cloud STT (Whisper / Deepgram) in the bridge so a Telegram **voice message is transcribed
  before the agent sees it**. The agent then passes the transcript as `text` to `record_field_note`
  with `channel: "technician_voice"`.

## 3. Register the spine MCP server
Add our server under the gateway's `mcp.servers` (stdio `command`/`args`). The gateway injects the
secrets via env/SecretRef so they never enter the model context:

```jsonc
{
  "mcp": {
    "servers": {
      "trades-spine": {
        "command": "node",
        "args": ["/abs/path/to/TradesDatabase/dist/mcp/server.js"],
        "env": {
          "SUPABASE_URL":              { "secretRef": "supabase-url" },
          "SUPABASE_SERVICE_ROLE_KEY": { "secretRef": "supabase-service-role-key" },
          "ANTHROPIC_API_KEY":         { "secretRef": "anthropic-api-key" },
          "DEFAULT_TENANT_ID":         "<this firm's tenant uuid>"
        }
      }
    }
  }
}
```

Build first (`npm run build`); the entrypoint is `npm run mcp:serve` → `node dist/mcp/server.js`.

## 3b. Centralized deployment (Architecture A)
The stdio registration above is **one server per sandbox** (the server runs inside each box, pinned to
one identity via `DEFAULT_TENANT_ID`/`DEFAULT_TECHNICIAN_REF`). The central alternative is **one shared
HTTP server every bot calls**, with identity asserted per request by the gateway:

- One host runs `npm run mcp:serve:http` → `node dist/mcp/httpServer.js` (Streamable HTTP, **stateless**).
  Secrets (`SUPABASE_*`, `ANTHROPIC_API_KEY`, `GATEWAY_IDENTITY_SECRET`) live **only on this host** —
  no sandbox holds them, which closes the per-box key-exfiltration risk.
- The gateway reaches it over **mTLS on a private network** + an optional IP allowlist (`ALLOWED_CLIENT_IPS`).
  This restricts *who may connect*; it is **deploy-time infra, not in this repo**.
- On every request the gateway sets identity headers and signs them with the shared secret:
  - `x-tenant-id`, `x-technician-ref`
  - `x-identity-signature` = `HMAC-SHA256(GATEWAY_IDENTITY_SECRET, "<tenantId>.<technicianRef>")` (hex)
  - **and** `Accept: application/json, text/event-stream` + `Content-Type: application/json` — the
    stateless transport returns `406`/`415` without both. (The MCP SDK client sets these automatically.)
- The server rejects a missing/forged signature with `401`, then resolves `(tenant, technician)` from the
  verified header — never from tool args. `record_field_note` no longer accepts a `technicianRef` arg.
- **Stateless ⇒ horizontally scalable:** the `record_field_note` confirmation resume keys off a
  DB-persisted `captureId`, so any replica can serve any request — no session affinity behind a load balancer.

The future **Option B** (per-bot JWT / OAuth Resource Server) swaps only the header-verification step
(`resolveIdentityFromHeaders`); the tools and tenant guards are unchanged.

## 4. Restrict the tool surface
Allowlist only the spine tools for the technician profile (`tools.profile` / allowlist):
`record_field_note`, `find_customer`, `get_customer_context`, `get_job`, `list_recent_captures`.
Outbound network policy should allow only the gateway + our server's host.

## 5. Conversation contract
- The agent calls `record_field_note({ technicianRef, text, channel })`.
- If the result `status` is `needs_confirmation` (a scheduled address to confirm) or
  `needs_disambiguation` (no match — ask which address), the agent asks the technician, then calls
  again with the **same `captureId`** plus `confirmed: { address }` (or `{ customerId }`).
- The L1 note is already saved on the first call; the resume never writes a second capture.
- For questions ("what did the last tech do here?"), the agent uses `find_customer` →
  `get_customer_context` / `list_recent_captures`.

## 6. Email ingestion (Phase 4 — separate from the chat channel)
A second input channel pulls the technician's email and feeds **only work-related** mail through the
same write-path (`channel: 'email'`). This does **not** require NemoClaw — `ingestEmail`
([src/email/ingest.ts](../src/email/ingest.ts)) calls Gmail directly via `googleapis`:

> **Note — under Option B (§7) this fetcher is superseded by Composio's Gmail trigger.** The per-tenant
> `googleapis` creds below are replaced by Composio-managed OAuth; the **classifier + write-path are
> unchanged**. Keep the direct creds only for the single-mailbox dev/test path.
- Provide Gmail OAuth2 creds in env: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`
  (or swap in a Workspace service account with domain-wide delegation).
- A Sonnet classifier ([src/email/classify.ts](../src/email/classify.ts)) drops personal/marketing
  mail before anything is written; only work mail reaches L1/L2.
- Run it on a schedule (cron/worker), or expose it as another connector on the agent.
- **Before enabling the cron, add idempotency:** `ingestEmail` does not dedup by message id and the
  default fetcher uses an overlapping `newer_than:7d` window, so repeated runs would create duplicate
  L1/L2 rows. Advance a watermark or skip already-seen message ids first.

## 7. Third-party app connectors (Composio — Option B, decided 2026-06-25)
The agent reaches third-party apps (Gmail, Google Sheets, Microsoft Excel, calendar, …) through
**Composio** as a per-tenant connector layer. **Decision: Option B — Composio manages *all* OAuth tokens
(inbound + outbound).** Composio delivers raw data; **our classifier + write-path stay the system of
record**. Guiding rule: **let Composio carry the credential, never the judgment** — it never decides
what's "work mail" and never writes to the spine (see §5 of
[the overview](../Three-Layer-Context-Spine-Overview.md): hardcode identity matching / permission
boundaries; outsource only the plumbing).

**Composio is complementary to `trades-spine`, not a replacement.** The spine MCP stays the only writer
to the canonical record (holds Supabase keys; does identity-match + provenance + tenant guards). Both
register side-by-side in the gateway's `mcp.servers`.

### Multi-tenant model
- **One business = one tenant UUID; Composio `user_id` is per PERSON (revised 2026-07-01):**
  `user_id = "<tenantUuid>:<technicianRef>"` — one connected account + one trigger per person, so ten
  employees' personal inboxes pair to ten isolated connected accounts under one shared spine tenant.
  The inbound webhook splits on the FIRST colon (`src/inbound/webhook.ts`) → tenant scopes the spine
  rows, ref becomes the capture/visit attribution. Bare-uuid `user_id`s stay valid (legacy
  whole-business pairing; attributed `connector:<toolkit>`). A person's handle can only reach their
  own connected account → A's agent structurally cannot touch B's mail or another tenant's spine
  (Composio scopes credentials and data per `user_id`: "User A's agent never touches user B's data" —
  [Authentication](https://docs.composio.dev/docs/authentication)). Never use Composio `user_id="default"`.
- **Pairing rules (consequences of per-tenant dedup + append-only L1):** (1) **One pairing per
  mailbox** — when migrating a mailbox from bare-uuid to composite, delete the legacy connected
  account + trigger first; if both fire, both deliveries share one Gmail `message_id`, whichever
  lands first permanently stamps the capture's `technician_ref` (L1 has no update path) and the
  other is discarded as a duplicate. (2) An email CC'd to N paired people yields N captures (Gmail
  message ids are mailbox-local) — accepted: each person really received it; identity-match reuses
  the customer/job. (3) **Vocabulary contract:** the `technicianRef` minted into the `user_id` must
  byte-equal the doorman badge ref and the schedule sheet's technician column
  (`schedule_entries.technician_ref`, exact case-sensitive match) — otherwise schedule-assisted
  matching is silently dead for that person and L1↔badge joins fail. The `connector:` prefix is
  reserved (webhook rejects composite refs that use it).
- **One Auth Config per platform, not per company — Composio-managed (decided 2026-07-01, supersedes
  the earlier custom-Auth-Config plan).** We ride Composio's own pre-verified OAuth app: no Google OAuth
  client of ours, no Google CASA verification, no creds in our env. Verified in the dashboard: auth config
  `gmail-test` (`ac_5CdPk4l3GV2V`) is **Composio Managed** with 11 scopes including
  `https://mail.google.com/` (full read + compose + send), so inbound full-mailbox read and outbound
  draft/send are all covered by the managed defaults. Each company authorizes *their* account against
  this shared config via a **Connect Link** → a per-company **connected account** keyed by `user_id`.
  Onboarding company #N = send a Connect Link.
  Accepted tradeoffs (per [Managed vs custom auth](https://docs.composio.dev/docs/custom-app-vs-managed-app)
  and the [Gmail toolkit FAQ](https://docs.composio.dev/toolkits/gmail)): Google's consent screen says
  "Composio" (not our brand), quota is shared ("managed apps share quota across all Composio users"),
  and scopes are pinned to Composio's verified defaults (adding scopes beyond them breaks — "scopes
  that Google hasn't verified for that client"). If branding/quota/scopes ever bite, the switch path
  is a custom **Auth Config** (our own Google OAuth client + CASA verification) — a dashboard-level
  change; no repo code assumes either mode.
- Use **Connect Link / hosted auth** (`composio.connectedAccounts.link()` / `session.authorize()`). Only the
  `initiate()` **method** (`POST /connected_accounts`) for **Composio-managed** OAuth is being retired — it
  returns `400 BadRequest` starting **2026-05-08** (new orgs) / **2026-07-03** (all orgs). `link()` is
  unaffected and works with managed OAuth; custom Auth Configs and non-OAuth schemes (API key/bearer/basic)
  are exempt. Managed OAuth as a *strategy* is not going away — only the `initiate()` call is; migrate any
  `initiate()` usage to `link()`. Source: [Composio changelog](https://docs.composio.dev/docs/changelog) and
  [Connected Accounts](https://docs.composio.dev/docs/auth-configuration/connected-accounts).

### Secret custody + gateway wiring
- The **Composio API key** (mints access for all tenants) and each tenant's Tool Router **`mcp.url`** live
  **only on the central control plane / host** — never in a sandbox (same rule as `GATEWAY_IDENTITY_SECRET`,
  §3b).
- The control plane runs `composio.create(tenantId)` → `{ mcp }` and injects that tenant's `mcp.url` into
  its sandbox, registered next to `trades-spine`:
  ```jsonc
  { "mcp": { "servers": {
      "trades-spine": { /* HTTP server + signed x-tenant-id headers (§3b) */ },
      "composio":     { "url": { "secretRef": "composio-mcp-url-<tenantId>" } }
  }}}
  ```
- Allowlist only the actions each tier needs (e.g. `GMAIL_SEND_EMAIL`, `GOOGLESHEETS_BATCH_GET`) — mirror §4.
- **Per-person capability control lives at the gateway, not in Composio (decided 2026-07-01):** the
  doorman badge already resolves `{tenantId, technicianRef}` per bot, and a future per-tier tool
  allowlist attaches there. Composio's **Execution Allowlist** is configured per auth config
  (dashboard-observed 2026-07-01: "Restrict which tools agents can execute. Leave empty to allow
  all"), and our shared-config model means one config serves every tenant and person — so it is only
  the **global ceiling** (e.g. "no send anywhere"), never per-person policy. ⚠ Whether the allowlist
  blocks *execution* or merely hides tools from *discovery* is unverified against Composio docs —
  confirm during outbound live-verification before treating it as an enforcement boundary.

### Scopes (least privilege)
- **Managed OAuth means one broad token per connected account** — the managed app grants
  `https://mail.google.com/` (read + compose + send together; dashboard-observed 2026-07-01), so a
  send-only-token split is not available. Least privilege moves to the **action layer**: Composio's
  per-auth-config **Execution Allowlist** (global ceiling — see gateway bullet above, semantics
  to-verify) plus the per-tier gateway allowlist (§4). ⚠ **Interim gap, accepted:** the per-tier
  gateway allowlist is not built yet, so until it ships, any agent holding a tenant's Tool Router
  `mcp.url` can both read the full mailbox and (if the ceiling permits) send — a capability the old
  send-only-token design made structurally impossible. Set the dashboard ceiling to draft-only until
  the gateway tier allowlist exists.
- **Inbound needs full-mailbox read** (Gmail read scope is all-or-nothing; no "work-only" scope exists),
  and that read-capable token lives in **Composio's** storage — a trust boundary to note in any customer
  data-handling review. The managed defaults also include profile/contacts read scopes — list them in any
  customer-facing privacy summary.
- *(Only if we switch to a custom Auth Config:)* outbound could then use send-only scopes (`gmail.send`)
  so the stored token literally cannot read the inbox; restricted read scopes would need one-time Google
  app verification (per client, not per company).

### "Both" spreadsheets
- **Google Sheets** — existing GCP OAuth client + Sheets API.
- **Microsoft Excel** — separate **Azure app registration** + Microsoft Graph delegated perms
  (`Files.ReadWrite`, `offline_access`); the workbook must live in **OneDrive/SharePoint** (a work/Entra
  account is the smooth path). One client each — not per company.
- The agent sees `googlesheets` *or* `excel` tools via `session.toolkits()` based on what the tenant
  connected; normalize behind a thin spine tool so prompts aren't app-specific (cell/range vs Graph-object
  shapes differ).

### Inbound email filtering (work vs personal)
Filtering is downstream of the token (read scope can't restrict to "work only"), so it's the same
classifier path we already have — now fed by Composio's Gmail trigger. Defense-in-depth, cheapest first:
1. **Trigger-side** (`GMAIL_NEW_GMAIL_MESSAGE` `query`/`labelIds`) — only fire for matching mail; also
   minimizes personal mail transiting our infra.
2. **Cheap deterministic drop** in the webhook handler (list/marketing headers, sender denylist).
3. **Sonnet classifier** ([src/email/classify.ts](../src/email/classify.ts)) — the real work/personal call.
- **Classify _before_ the L1 insert.** `raw_captures` is append-only (no delete path), so personal mail
  written to L1 is retained forever — the classifier must gate the insert, never run after it.
- Bias low-confidence to a **review bucket**, not a silent drop (dropping a real work email is costlier).
- **Dedup by Gmail message id** before insert — Composio's trigger doesn't dedup, and managed-auth polling
  is **≥15 min** (not real-time).

### Stay connector-agnostic (don't overfit to Gmail)
Gmail + spreadsheets are the first connectors, **not** the design center. **Outbound** generalizes for
free — the per-tenant Tool Router `mcp.url` exposes whatever toolkits the tenant connected (allowlist is
per-tenant policy; keep agent prompts provider-neutral). **Inbound** is just more channels into the
already channel-agnostic write-path (overview §4): a generic webhook routes by `toolkit`+`triggerType` →
a per-source **normalizer** (`payload → { channel, rawText|blobRef, externalId, occurredAt }`) → the
**shared** dedup-by-externalId / classify-before-L1 / extract pipeline. The "work vs personal" classifier
is a Gmail-specific, *optional* per-source filter — other sources (e.g. a dispatch Slack channel) may need
none. Prove the seam by shipping **two differently-shaped connectors** (Gmail inbound+outbound;
Sheets/Excel outbound); don't build a speculative framework for connectors you don't have yet (YAGNI).
Adding connector #N should then be: a Composio Auth Config + a config entry + (inbound) one normalizer —
no pipeline change.

### Build note
The code-touching pieces — control-plane onboarding endpoint, per-tenant `mcp.url` injection, the inbound
trigger webhook handler (verify Composio's HMAC `webhook-signature`) — are non-trivial: run them through
**/research → /plan → /implement** (CLAUDE.md).

## Live verification (run once provisioned)
- **Chat channel:** send a Telegram voice note → confirm the address in chat → read back over `pg`
  that an L1 `raw_captures` row (`channel='technician_voice'`) exists **and** an L2 job/visit links
  to it via `source_capture_id`. Then ask the bot a question and confirm it answers from
  `get_customer_context`.
- **Email channel:** send a real **work** email → it appears in the spine (L1 `channel='email'` + L2
  when it matches a customer); send a **non-work** email → it is filtered out (no rows). Spot-check
  the classifier's precision on a sample of real inbox mail.
- **Connector isolation (Option B):** create a second test tenant with a *different* connected Google
  account and confirm tenant A's `mcp.url` cannot see tenant B's mail/sheets — the one test that proves
  the `user_id`=tenant invariant holds.
