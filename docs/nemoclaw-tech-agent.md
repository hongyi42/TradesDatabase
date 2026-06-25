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
- Provide Gmail OAuth2 creds in env: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`
  (or swap in a Workspace service account with domain-wide delegation).
- A Sonnet classifier ([src/email/classify.ts](../src/email/classify.ts)) drops personal/marketing
  mail before anything is written; only work mail reaches L1/L2.
- Run it on a schedule (cron/worker), or expose it as another connector on the agent.
- **Before enabling the cron, add idempotency:** `ingestEmail` does not dedup by message id and the
  default fetcher uses an overlapping `newer_than:7d` window, so repeated runs would create duplicate
  L1/L2 rows. Advance a watermark or skip already-seen message ids first.

## Live verification (run once provisioned)
- **Chat channel:** send a Telegram voice note → confirm the address in chat → read back over `pg`
  that an L1 `raw_captures` row (`channel='technician_voice'`) exists **and** an L2 job/visit links
  to it via `source_capture_id`. Then ask the bot a question and confirm it answers from
  `get_customer_context`.
- **Email channel:** send a real **work** email → it appears in the spine (L1 `channel='email'` + L2
  when it matches a customer); send a **non-work** email → it is filtered out (no rows). Spot-check
  the classifier's precision on a sample of real inbox mail.
