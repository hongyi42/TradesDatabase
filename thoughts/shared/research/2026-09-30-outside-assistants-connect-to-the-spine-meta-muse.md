---
date: 2026-09-30
branch: main
commit: 3a3724a
topic: Outside assistants (Meta Muse first) connecting to our server as an "app" — what Muse's connector model is, what our server exposes today, what survives if the Telegram seats are replaced
supersedes: nothing
---

# Outside assistants connect to the spine — Meta Muse first

Read at `3a3724a` (= `origin/main`, re-fetched while writing). The main checkout's local `main` sat 21
commits behind at `a6223d3` with another session's uncommitted edits, so every code path below was
read from a clean detached worktree of `origin/main`. Vendor facts were read live on 2026-09-30;
each carries its URL and says whether it comes from **Meta itself** or from a **third party**.

Operator's question (2026-09-30, paraphrased): customers will increasingly bring their own
general-purpose agent (Meta Muse is the example), the way social apps consolidated into a few
platforms. That erases our Telegram chat seats, but the database, the office/planner and memory
would still be worth something. How would we connect to Muse and platforms like it, how would a
Muse *custom connector* talk to our server, and what does a slow remodel into an "app" that
Muse agents connect to look like?

## Summary

**Meta Muse** is Meta's personal AI agent (launched 2026-09-08). Each user gets a cloud computer
(a VM with a browser, files and a terminal), memory files, scheduled tasks, and **connectors** —
integrations with outside services. There are two ways a service gets into Muse: a **directory
connector**, which the service submits to Meta at muse.ai/platform for review, or a **custom
connector**, which a user asks Muse to build on the spot, which Meta does not review, and which
Muse writes against whatever the service exposes (a remote MCP server, a REST API, or a
command-line tool). **MCP (Model Context Protocol)** is the open standard for how an AI agent
discovers and calls a service's tools; ChatGPT and Claude use the same standard for their
"apps"/"connectors", with sign-in over **OAuth** (the standard "Sign in with X → allow access"
handshake that gives the agent a token instead of a password).

**Our server is already an MCP server** — one endpoint on Render (`trades-spine`, 20 tools for
technicians, 56 for managers) whose tools write and read the three-layer record and wake the
office. What it lacks is the front door an outside agent expects: it accepts only two kinds of
credential — a per-seat token the box's seat glue carries, and HMAC-signed headers (headers stamped
with a shared-secret checksum) that the box's doorman adds — and it has no OAuth sign-in, no
discovery documents, and no notion of "this person connected from Muse". The parts the operator
expects to survive are, in the code, already independent of Telegram: the record (L1/L2/L3), the
tier and technician-view rules (enforced in the database and at each tool door), memory (database
tables), and the office/planner (it never talks to Telegram — it queues rows that the box pulls).
The parts that are Telegram-shaped are the seat glue on the box: the Telegram long-poll, the
seat's rulebook (system prompt), the approve/deny buttons, the manager's sandbox file tools, and
the delivery of queued messages to a person's phone.

## Entry Points

| Where | What an outside agent would hit |
|---|---|
| `src/mcp/httpServer.ts:1738` | `http.createServer` — raw `node:http`, no web framework |
| `src/mcp/httpServer.ts:1493` | `handle()` — the one router; order matters |
| `src/mcp/httpServer.ts:1706-1711` | **every unrouted path is the MCP endpoint** (stateless Streamable HTTP); production base URL is `/` |
| `src/mcp/httpServer.ts:1712-1720` | identity failure → bare `401` with no body and no `WWW-Authenticate` header; seat-lookup outage → `503` |
| `src/mcp/identity.ts:86` | `resolveIdentity(headers)` — seat token (`Bearer st_…`) or the HMAC header triple |
| `src/mcp/server.ts:946-951` | `createServer` — `{ name: 'trades-spine', version: '0.1.0' }`, capabilities `{ tools: {} }` only (no `instructions`, no resources, no prompts) |
| `src/mcp/httpServer.ts:1539-1573` | `/seat/*` — per-person REST beside MCP (whoami, export, files, inbox, conversation) |
| `src/composio/relayHandler.ts` | `/composio` — the person's own Composio MCP session, proxied |

## Key Files

**The server an outside agent would connect to**
- `src/mcp/httpServer.ts` — the only HTTP server. Routes before the IP allowlist (`allowed()`,
  :70-76, open when `ALLOWED_CLIENT_IPS` is unset): `/health`, inbound webhooks (SignalWire,
  Composio), `/control/*` (box host token), `/seat/*` (seat token), `/board/*` and `/console/*`
  (Telegram Mini App sign-in slip), `/admin/*` (one shared operator token). After the allowlist:
  `/composio` relay, then MCP for everything else.
- `src/mcp/identity.ts` — `RequestIdentity { tenantId, technicianRef, scopes?, seatRef? }`
  (:15-21). `resolveIdentityFromHeaders` (:45-67) checks an HMAC of `"${tenantId}.${technicianRef}"`
  (:58) — no timestamp, no expiry. `SEAT_BEARER = /^[Bb]earer\s+(st_[0-9a-f]{64})$/` (:71).
  `resolveIdentity` (:86-106) looks the token's sha256 up in `seats.token_hash`, no cache.
  `scopes` is declared (:18) and **never read** anywhere in `src/`. The comment at :44 records the
  standing intent: "Swapping this one function for JWT validation is the future Option B migration."
- `src/mcp/server.ts` — the tool hub. `tools/list` is tier-filtered (:953-968). `dispatch` reads the
  caller's roster row on every call (:633-640): refuses a deactivated person, computes
  `activeManager`, then runs the gates (namespace ceiling, team-lead-only tools, `ADMIN_TOOL_NAMES`
  manager-only, managers refused `get_schedule`/`search_captures`, `dropSensitive`). Role is **not**
  in the credential; it is re-read from the roster each call.
- `src/mcp/tools/*.ts` — the tool definitions; canonical name lists in `surface.expected.ts`.
  No tool carries MCP annotations (`readOnlyHint`/`destructiveHint`): `grep -rn` over `src/` finds 0.
- `src/mcp/tools/comms.ts:57-67` — `send_email` is two-step inside the tool: call 1 returns
  `{status:"needs_confirmation", confirmId}`, call 2 with only `confirmId` sends the staged copy.
  `record_field_note` and `retract_capture` have the same staged-confirm shape (`captures.ts:503, 608`).
- `supabase/migrations/20260923200000_seats.sql` — `seats` table; `seats_live_technician_key`
  (:46) = **one live seat per person**; `token_hash` unique (:38).

**The Telegram seat layer (on the box, not on Render)**
- `src/seatGlue/engine.ts` — `sessionConfig` (:151): model via OpenRouter, `systemMessage` mode
  `replace` with `MANAGER_DOCTRINE` or `TECHNICIAN_DOCTRINE` (:195), `mcpServers` = `spine` (+
  `composio` for managers) with the seat token as header (:223), `onPermissionRequest` (:231).
- `src/seatGlue/doctrine.ts` — `TECHNICIAN_DOCTRINE` (:113), `MANAGER_DOCTRINE` (:179): the seat's
  rulebook (dates via `resolve_date`, two-step sends, what to show a technician about money, …).
  It lives in the glue's prompt; **the MCP server sends none of it**.
- `src/seatGlue/telegram.ts:104, 197, 213, 231` — the **only** `api.telegram.org` calls in `src/`.
- `src/seatGlue/inbox.ts` — pulls `GET /seat/inbox` with the seat token. Two kinds of item (:7-12):
  `phone` = "texted to the person word for word", `note` = "for the assistant only, never shown to
  the person".
- `src/seatGlue/fileTools.ts` (`run_command` :178, `read_file` :272, `write_file` :300,
  `share_file` :315, `export_query` :336, `save_file` :374, `open_file` :400),
  `batchProgress.ts:154` — glue-local tools (manager sandbox on E2B, batching). An outside agent
  connecting to `/` gets none of these.
- `src/seatGlue/prompts.ts` — Telegram inline-button questions and plans (`ask_user`,
  `exit_plan_mode` builtins, `engine.ts:131`).

**The parts that do not touch Telegram**
- `src/control/nudgeQueue.ts:24-28` — "The spine NEVER reaches into the agent box — … queued nudges
  ride the same posture: served on a host-token pull until the box ACKS delivery".
- `src/control/officeQueue.ts` — agent-addressed office messages, same pull posture.
- `src/telegram/boardNotify.ts:272-281` — schedule changes are "QUEUED, not sent": Render holds no
  person's bot token; the box texts each person through their own assistant.
- `src/teamLead/` — the office and planner (19k lines). They reach people only by queuing rows.
- `src/mcp/tools/memory.ts` — manager's own notes (`list_my_memory`, `read_my_memory`,
  `write_my_memory`), table from `supabase/migrations/20260924140000_seat_memory.sql`; scope is
  always the caller. Planner/firm memory: `src/teamLead/memory.ts`, table from
  `20260830120000_planner_memory.sql`.
- `src/db/technicianView.ts:4-9` — "The RULE lives in the database — technician_view_of …"; the
  one money question at :71-79. So the technician limited view and money-hiding apply to **any**
  caller that arrives with a technician identity.
- `src/db/database.types.ts:4897-4915` — L1 `capture_channel` values are by role and source
  (`technician_note`, `manager_assistant`, `chat`, `agent_action`, …), not by chat app.
- `src/composio/sessions.ts` — manager session `{ manageConnections: true, mcp: true }` (:34);
  technician `direct_tools`, Gmail-only (:20-24, :36-42).

## Data Flows

### Today: a technician texts a note

```
 phone (Telegram app)
   │  message
   ▼
 trades-box-1 ── seat glue (src/seatGlue, Copilot SDK engine, OpenRouter model)
   │  rulebook = TECHNICIAN_DOCTRINE (system prompt, on the box)
   │  MCP call  Authorization: Bearer st_…
   ▼
 Render ── httpServer.handle → resolveIdentity → createServer({identity}) → dispatch
   │  roster re-read, tier gates, technician_view_of
   ▼
 Supabase ── L1 raw_captures (append-only) → L2 jobs/visits/customers → L3 attributes
   │
   └── wakes the OFFICE (src/teamLead) when something needs judgment
```

### Today: the office or planner needs to reach a person

```
 office / planner (Render)
   │  `send` verb → queue row (nudges / office messages / person pushes)
   ▼
 Supabase queue tables ◄───────────────── pull every ~1 min ─────────────┐
                                                                          │
 seat glue (box) ── GET /seat/inbox (seat token) ─────────────────────────┘
   │  item.leg = 'phone' → Telegram sendMessage, word for word
   │  item.leg = 'note'  → attached to the person's next message, for the assistant only
   ▼
 person's Telegram chat
```

Render never pushes to a person. Every "the office texts the manager" path is: write a row, the box
pulls it, the box delivers it.

### What the MCP authorization standard asks for (not built)

The shape every OAuth-capable MCP client (Claude, ChatGPT, and — per third-party reports — Muse's
custom connectors) follows, from the MCP spec 2026-07-28:

```
 outside agent (Muse VM / ChatGPT / Claude)          our Render server          sign-in server
   │ 1. POST /mcp  (no token)  ─────────────────────►│
   │ ◄──── 401 + WWW-Authenticate: resource_metadata=…   (today: bare 401, no header)
   │ 2. GET /.well-known/oauth-protected-resource ──►│   (today: falls through to MCP → 401)
   │ ◄──── { authorization_servers: [...] }
   │ 3. GET /.well-known/oauth-authorization-server ─────────────────────────────►│
   │ 4. browser: person signs in, sees consent, approves ────────────────────────►│
   │ ◄──── code  →  5. token request (PKCE, resource=<our URL>) ─────────────────►│
   │ ◄──── access token (+ refresh token)
   │ 6. POST /mcp  Authorization: Bearer <token> ───►│  validate issuer, audience, expiry
   │                                                  │  → tenant + person → same dispatch as today
```

## External Dependencies

### Meta Muse — primary sources (Meta's own pages), read 2026-09-30

- **What Muse is** — <https://introducing.muse.ai/>: "an Agent that Can Actually Do Things" with
  "its own computer, with a file system and a terminal" and "access to a full web browser". "Muse is
  always working. Once you've set a goal or a task, Muse continues to work on a schedule and in
  response to relevant events." Memory "persists across your conversations"; "Memory files, which
  you can read and edit directly". Muse can "send you messages without you prompting it".
- **Plans** — <https://www.meta.com/help/subscriptions/1021145227643680/>: free "with a usage
  limit"; Power "$20/month" with "500M Muse tokens per week"; Maximum "$100/month" with "3B Muse
  tokens per week". "Muse and Muse subscriptions are in limited testing and aren't available in all
  locations yet." Subscribers "must be 18 or the age of majority". No business/team plan mentioned.
- **Connectors (help center)** — <https://www.meta.com/help/artificial-intelligence/1687253048996149/>:
  connectors are "apps and services from Meta or third-parties"; added from Settings → Connectors
  or by asking. **Custom connectors:** "If you want to connect to a service not yet available in
  the Connector list, you can ask Muse to create a Custom Connector. Muse will guide you through the
  process, which can involve retrieving API information from the service." "Meta doesn't review
  custom connectors or how they use your information, so grant access with caution and review the
  provider's privacy policies." Credentials go in Muse's "Secure Credentials Store". "By default,
  Muse will not take many important actions, like sending an email, without your approval."
- **Security design** — <https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse>
  (2026-09-08): third-party credentials are "stored in your VM, not in centralized Meta
  infrastructure"; code in the agent only sees a "'surrogate' token, minted by authd"; "Sentinel
  will replace any surrogate tokens with the real credential … at the network boundary. The agent
  never sees real tokens." Sentinel "evaluates the connector policy, which has been set by the user,
  and decides whether the action should be allowed, denied, or to ask the user." "Muse can also
  write its own custom connectors for other services you care about if they have their own APIs or
  CLIs." Built-in connectors run in privilege-separated workers; "CLI-based connectors … run in the
  runtime cell".
- **Directory submission** — <https://muse.ai/platform>: "A connector brings what you've built into
  the everyday tasks people ask Muse to help with." Three steps: describe your product; submit for
  review (functional, security, legal requirements, end-to-end testing); appear in the directory
  (editors choose featured placement). "we've partnered with Stripe to make accepting payments easy
  with Link". **The page publishes no technical requirements** (protocol, auth, transport), no fee,
  no review timeline, no developer terms.
- **Meta AI Connectors (a separate developer preview)** — <https://dev.meta.ai/products/connectors/>:
  "A connector turns your existing API into tools Meta AI can call." Onboarding by REST
  (OpenAPI), GraphQL, "guided UI or MCP onboarding"; "Use OAuth account linking so people can
  securely connect their existing account to your service." Limited preview, "selecting developers
  in waves"; connectors "aren't yet available to the public"; requires a live REST API. The page
  does not say whether this program and the Muse directory are the same pipeline.
- **Muse Code (Meta's coding agent, not the consumer app)** —
  <https://dev.meta.ai/docs/muse-code/extending>: MCP over `stdio` or `streamable_http`; OAuth 2.1
  via `muse mcp login <server>`; "Muse Code keeps and refreshes the tokens for you"; a
  `mcp_oauth_dynamic_client_registration` setting. Evidence that Meta's own MCP client speaks OAuth
  2.1 — for the coding agent.
- **Model API** — <https://dev.meta.ai/docs/>: `muse-spark-1.3/1.2/1.1`. This is the *model* already
  in our OpenRouter preset as the Gemini fallback (`@preset/trades-seats`); unrelated to the agent
  platform question except by name.

### Meta Muse — third-party reports (not confirmed on a Meta page)

- **Custom connector to a remote MCP server works.** <https://parallel.ai/articles/meta-muse-custom-integrations>:
  "For an MCP server that is the server URL. For a REST API it is the OpenAPI document or the docs
  page. For a CLI it is the package name." Muse "builds an MCP client on its own VM using the
  official SDK, connects to the server over streamable HTTP, and saves the integration as a skill."
  "Bearer tokens and API-key headers" fit the credential flow directly; "OAuth-only services may
  still work through Muse's browser, but expect more back and forth." "A server on your own laptop
  is not reachable from Meta's cloud." Custom connector code runs "inside Muse's own runtime cell".
- **A vendor's live setup guide does exactly this.** <https://sealgate.ai/docs/connect-clients/muse>:
  the user tells Muse "Create a Custom Connector for a new remote MCP server", gives
  `https://mcp.sealgate.ai/mcp`, "Remote streamable HTTP", "Auth: OAuth (sign in when prompted -
  there is no API key to paste)"; the vendor "issues Muse a token tied to **your** user, so every
  call Muse makes is attributed to you"; the connector is saved as a reusable skill.
- **What the directory form accepts is contested.** <https://www.howdoiuseai.com/blog/2026-09-26-what-meta-s-muse-connectors-mean-for-anyone-buildi>:
  "either an existing MCP server or a raw API"; 2,000+ submissions "in the first few days",
  approvals "in waves". Versus <https://cellcog.ai/blog/muse-connector-platform/>: "The form asks
  for a description of the product, not code"; "No published fee, revenue share, review timeline,
  SDK, or developer terms." Also <https://www.aiagentslibrary.com/blog/meta-muse-mcp/> (verified
  2026-09-26): "Meta does not document any user-facing MCP setup in the consumer Meta Muse app."
- **Directory contents.** <https://www.sprites.ai/muse/connectors> (after Connect, 2026-09-23): ~56
  connectors, including Gmail/Google Workspace, Outlook, Notion, Calendly, **Telegram**, Shopify,
  Stripe Link, Plaid, PayPal; "No field service, home services, QuickBooks, Jobber, Housecall Pro,
  ServiceTitan, or booking connectors exist beyond Calendly." Muse's Telegram connector runs
  through a user-supplied bot token (<https://opentools.ai/muse-connectors/community-telegram>).
  Directory reach "US and Canada only" (<https://technspire.com/en/blog/muse-connectors-decoded-meta-directory-vs-open-mcp>).
- **Push into Muse.** "Most Connectors are pull-only with Muse reaching for information when a task
  needs it, though some like calendars can update Muse automatically" (search summary of
  dev.to / aiagentslibrary). No source — Meta or third party — documents a way for a third-party
  connector to push an event or message into a user's Muse.
- **Muse inside other chat apps.** <https://www.testingcatalog.com/meta-prepares-muse-for-messenger-and-telegram/>:
  interface traces suggest Muse being prepared to work through Messenger and Telegram; "no release
  timing has been confirmed". Unconfirmed by Meta.
- **Scale.** 642,000 US mobile daily users within 12 days (howdoiuseai); #1 on the US App Store ten
  days after launch (search summaries). Not verified against Meta.

### The shared standard other platforms use — primary sources, read 2026-09-30

- **MCP authorization, spec 2026-07-28** —
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>. An MCP server
  "acts as an OAuth 2.1 resource server". "MCP servers **MUST** implement OAuth 2.0 Protected
  Resource Metadata (RFC9728)", advertised via a `WWW-Authenticate: Bearer resource_metadata=…`
  header on the 401 or at `/.well-known/oauth-protected-resource`. Client registration: Client ID
  Metadata Documents **SHOULD**; Dynamic Client Registration **MAY** and "is deprecated and retained
  for backwards compatibility"; pre-registration. PKCE `S256` required; clients **MUST** send
  `resource=<canonical server URI>` (RFC 8707); servers **MUST** validate the token was issued for
  them; "MCP servers **MUST NOT** accept or transit any other tokens". New in this version: RFC 9207
  issuer check on the authorization response. The latest spec index
  (<https://modelcontextprotocol.io/specification/latest>) also lists optional extensions: Tasks
  (long-running operations), Skills over MCP, MCP Apps (inline UI).
- **Claude Connectors Directory** — <https://claude.com/docs/connectors/building/submission>: remote
  HTTPS; "OAuth 2.0 if your tools act on a user's account"; "Every tool has a `title` and a
  `readOnlyHint` or `destructiveHint` annotation"; auth modes "OAuth with dynamic client
  registration, client ID metadata documents, or Anthropic-held client credentials"; supports
  "Users connect to different URLs" (multiple URLs or a URL pattern).
- **ChatGPT apps** — <https://developers.openai.com/apps-sdk/build/auth>: OAuth 2.1; metadata at
  `/.well-known/oauth-protected-resource`; CIMD preferred, DCR as alternative; PKCE `S256`; the
  server must "verify the token's signature and `iss`, deny tokens that have expired …, confirm the
  token was minted for your server (`aud` or the `resource` claim)". (A search summary adds a
  domain-verification file at `/.well-known/openai-apps-challenge` for submission — page not read.)
- **MCP TypeScript SDK 1.29.0** (our dependency, `package.json`): ships
  `server/auth/router` (`mcpAuthRouter`, `mcpAuthMetadataRouter`,
  `getOAuthProtectedResourceMetadataUrl`) and `middleware/bearerAuth` (`requireBearerAuth`). These
  are typed as Express `RequestHandler`s; our server is raw `node:http` and imports none of them.
- **Supabase OAuth 2.1 Server** — <https://supabase.com/docs/guides/auth/oauth-server>: "Turn your
  Supabase project into an OAuth 2.1 and OpenID Connect identity provider"; "Dynamic client
  registration: Automatic registration for MCP-compatible clients"; PKCE; JWKS; "Access tokens are
  standard Supabase JWTs that include user_id, role, and client_id claims"; "redirects to your
  custom authorization UI"; users "must authenticate via enabled Supabase Auth methods"; no separate
  charge, sign-ins count toward MAUs. Sub-page `/docs/guides/auth/oauth-server/mcp-authentication`
  not read. `supabase/config.toml:373-379` carries `[auth.oauth_server] enabled = false` (the CLI
  default).

## Constraints and Invariants

1. **No person has a login.** A person is a `technicians` row identified by `telegram_user_id` and
   (if paired) `connected_email` (`database.types.ts`, technicians Row). The code never uses Supabase
   Auth (`src/db/client.ts:12-15`, service-role key). There is no password, no email-verified
   account, no phone number column. Anything that asks a person to "sign in" needs a way to prove
   they are that roster row.
2. **One live seat per person** (`seats_live_technician_key`, seats migration :46) and one badge per
   person (`technicians.badge_hash`). A second credential for the same person (their Telegram seat
   AND their Muse) cannot exist in today's schema.
3. **Role is re-read, not carried.** Tier and active state come from the roster on every call
   (`server.ts:633-640`), so a revoked or demoted person is refused on the next call whatever the
   credential. `RequestIdentity.scopes` exists but nothing reads it.
4. **The rulebook is not on the server.** The MCP server sends no `instructions`
   (`server.ts:946-951`). Rules the seats follow — resolve dates with `resolve_date`, show the
   person the exact email before confirming, what a technician may be told about money, the
   manager's plan-first behaviour — live in `MANAGER_DOCTRINE`/`TECHNICIAN_DOCTRINE` on the box.
   What an outside agent would get is the tool descriptions alone. Recorded lesson,
   `docs/engineering-memory.md:2063`: "A new tool surface silently bypasses whatever doctrine rule
   did not name it — twice now."
5. **What is enforced regardless of caller:** tenant scoping (`.eq('tenant_id', …)` in `src/db/`),
   the tier gates in `dispatch`, the technician limited view and money question (database function
   `technician_view_of`, `technicianView.ts`), manager-only sensitivity (`dropSensitive`), and the
   two-step `send_email` / `record_field_note` / `retract_capture` confirmations (inside the tools).
6. **Push is pull.** Render never sends to a person (`nudgeQueue.ts:24-28`,
   `boardNotify.ts:272-281`). Every outbound message is a queued row that a seat pulls from
   `/seat/inbox`. No Muse source documents a way for a third-party connector to push into Muse; a
   Muse user can set a scheduled task that calls a connector.
7. **Unknown paths are the MCP endpoint.** `/.well-known/*` falls through to MCP and gets a bare 401
   (`httpServer.ts:1706-1720`), so a standards-following client's discovery step fails today.
8. **The IP allowlist would block a vendor cloud.** `ALLOWED_CLIENT_IPS` (`httpServer.ts:70-76`) is
   open when unset; `docs/prod-migration-checklist.md:123` lists that as "spine open to the
   internet", and :137-139 is an unticked item to make prod "refuse to boot" when it is empty.
   Muse, ChatGPT and Claude call from their own clouds, from IPs we do not control. The
   check reads `req.socket.remoteAddress`, which behind Render's proxy is probably the proxy hop
   (inferred, not measured).
9. **L1 is append-only, and outbound agent actions are captured with no filter** (CLAUDE.md
   recorded exception 2026-07-04). A write arriving from an outside agent lands in the same
   permanent record; the L1 channel is by role (`technician_note`, `manager_assistant`, …), not by
   which chat app sent it.
10. **A manager's conversation is private** (#285): `/seat/conversation` drops managers' transcripts
    (`httpServer.ts` handler near :925-928). With an outside agent, the conversation lives in the
    vendor's product and never reaches us at all; the office's `read_conversation` tool would have
    nothing to read for that person.
11. **Muse custom connectors are unreviewed and run in the user's VM.** Whatever Muse writes to call
    us is code we never see; Meta tells users to read the provider's privacy policy.
12. **No tool carries annotations.** Claude's directory requires `title` + `readOnlyHint` or
    `destructiveHint` on every tool; Muse's Sentinel classifies actions as allow/deny/ask by a
    policy the user sets — what it keys on for a custom connector is not documented.

### Standing rulings this question touches (from the operator's memory and the repo)

These are recorded decisions, quoted so the fork below is visible — not re-argued here.

- **Telegram is the entire UI** (2026-07-03; `docs/engineering-memory.md:655-664`,
  `docs/onboarding.md:73-76`). Why Telegram mattered: "Zero learning curve + push initiation =
  adoption rate … we ping them and wait for a reply" (`engineering-memory.md:1424-1432`).
- **Manager seats are Cowork-shaped** (2026-09-20/21; `engineering-memory.md:1618-1669`): "For
  technician seats, it is a simple chat agent. For manager seats, it should aim to be claude cowork
  with access to the firm's data." "Telegram stays the UI, approvals as inline buttons." The harness
  is BOUGHT, not written.
- **The seat proposes, the planner records** (2026-09-02; `engineering-memory.md:5272-5279`) and
  **the office judges, code guards** (2026-09-22; `:5061-5070`).
- **The product is the fit** (2026-09-15; `engineering-memory.md:1398-1489`): "Time saved is our
  OUTPUT"; "Intelligence is rented; expertise is ours"; "When a plan conflicts with this, this
  outranks the plan."
- **Coexist with the incumbent FSM** (2026-09-06; `engineering-memory.md:1303-1335`) — the spine is
  our record, fed from theirs.
- **Option B is the only recorded OAuth mention**: `thoughts/shared/build-schedule.md:142-147`,
  "Per-bot scoped JWT / OAuth Resource Server (deferred migration path, 2026-06-23) … Swaps only the
  header-verification step; tools and tenant guards unchanged." Trigger recorded: "multi-box
  scale-out or a security review demanding badge-independent identity."
- No document in `thoughts/` studies a customer's own assistant connecting to us (survey of
  `thoughts/INDEX.md`, research, plans, findings: none on ChatGPT apps, Claude connectors, Muse as a
  platform, remote MCP for third parties, or OAuth for MCP).

## Decision Points

Stated as forks the code creates; no option is recommended here.

**1. Which door into Muse first — custom connector or directory connector?**
- *Custom connector:* available today to any Muse user. The user tells Muse our MCP URL; Muse
  writes and keeps the integration in their VM. Needs only a public HTTPS MCP endpoint and a
  credential Muse can hold. Meta does not review it; we don't control the code Muse writes.
- *Directory connector:* submitted at muse.ai/platform, reviewed by Meta, listed for discovery,
  Stripe Link payments available. Technical requirements, fees and timeline are unpublished;
  approvals are in waves after 2,000+ submissions; US/Canada reach.
- *Meta AI Connectors preview* (dev.meta.ai): a third, separate program (REST/OpenAPI or MCP, OAuth
  account linking), by application, not public.

**2. How a person proves who they are to our server from someone else's agent.**
- *A pasted bearer token* (like today's `st_` seat token): the lowest-friction fit for Muse's
  credential prompt per third-party reports. Needs a way to hand the person a token (e.g. from
  their Telegram seat or a settings page), a new row type because of the one-seat-per-person index,
  and gives no standard revocation UI on the vendor's side. Claude's and ChatGPT's directories
  expect OAuth for user-account tools.
- *OAuth 2.1 with our own sign-in server:* matches the MCP spec and all three platforms. Needs
  protected-resource metadata and a real `WWW-Authenticate` 401 on our server, an authorization
  server, a consent page, and a login method — which today does not exist (constraint 1). Login
  options the data supports: Telegram Login (we hold `telegram_user_id`), an email link to
  `connected_email`, or a code sent through the person's existing Telegram seat.
- *OAuth via Supabase's OAuth 2.1 Server:* Supabase issues the tokens (JWTs with `user_id`,
  `role`, `client_id`) and supports MCP-style dynamic registration; we build the consent page.
  Requires every person to become a Supabase Auth user (MAU-counted), which the codebase has never
  used, and a mapping from Supabase user → roster row. `resolveIdentity` is the one function that
  would change (the recorded Option B seam).

**3. Where the seat's rules live when we don't own the prompt.**
- *Leave them in the glue:* outside agents get tool descriptions only; the rules that are prompt-
  only (date discipline, what to tell a technician, plan-first) do not reach them.
- *Move them onto the server:* MCP `instructions` on `initialize`, richer tool descriptions, or the
  "Skills over MCP" extension — the vendor's model decides how much weight they get.
- *Move them into the tools:* the pattern already used for two-step sends and the technician view —
  enforced whoever calls, at the cost of more code deciding (the "code decides little" doctrine).

**4. How the office reaches a person who lives in Muse.**
- *Keep Telegram for pushes:* the office's queued `phone` items still go out through a Telegram seat;
  Muse is only for the person's own requests. Two chats per person.
- *An inbox tool Muse polls:* expose `/seat/inbox` as an MCP tool (e.g. "what does the office need
  from me?") that the person sets up as a Muse scheduled task. Delivery depends on the person
  creating and keeping that task; no documented push path exists.
- *Email/SMS:* the office already sends email; delivery lands in the person's inbox, which Muse can
  read through its Gmail/Outlook connectors.

**5. What happens to the manager "Cowork" seat.**
- *Muse is the manager's Cowork:* Muse already has a VM, files, a terminal, scheduled tasks, memory
  and Gmail/Sheets connectors — the list in `manager-seat-is-cowork-shaped`. Our side becomes the
  spine tools plus the deterministic verbs (`export_query`, invoices, files). The per-manager E2B
  sandbox, batching and plan prompts in `src/seatGlue` are the parts Muse would replace.
- *Keep our seat and add Muse beside it:* both call the same `/` endpoint with different
  credentials; the rulebook and the private-conversation rule differ per door.

**6. Technicians.**
- The technician seat is a capture channel ("we only need them as data input channels"). A
  technician on Muse would need their own Muse account (18+, US, a payment card even on the free
  tier per third-party reports) and their own sign-in. Whether technicians move at all, or stay on
  the Telegram seat while managers move, is open.

**7. One connector for many platforms, or a Muse-specific one.**
- The MCP authorization spec is what Claude, ChatGPT and Muse Code implement, and third-party
  reports say Muse's custom connectors use the official MCP SDK over streamable HTTP. A single
  standards-following endpoint would serve all of them; a Muse-only path (e.g. a REST API with an
  OpenAPI document, the dev.meta.ai preview's format) would be Muse-specific.

**8. Where the endpoint sits.**
- *The existing `/` fallthrough:* shares `dispatch` and every guard; discovery paths must be routed
  above the fallthrough; the IP allowlist cannot apply.
- *A separate path or host (e.g. `/mcp`, `mcp.<domain>`):* lets outside traffic have its own
  canonical URI (the `resource` value in RFC 8707), its own rate limits and logging, while calling
  the same `createServer`.

## Open Questions

1. Does the Muse directory form ask for an MCP URL/API spec, or only a description? Third-party
   reports disagree; muse.ai/platform shows neither. Needs a look at the actual form.
2. Does a Muse custom connector complete a full OAuth 2.1 flow (PRM discovery → consent → token
   refresh) against a standards-following server, or does it prefer a pasted bearer token? One
   vendor guide (SealGate) says OAuth works; parallel.ai says OAuth means "more back and forth".
   Needs a live test with a Muse account.
3. Can a third-party connector push anything into Muse (an event that wakes a scheduled task)?
   Nothing found says yes; "calendars can update Muse automatically" is only for built-ins.
4. How does Sentinel decide allow/ask/deny for a custom connector's calls — tool annotations, HTTP
   method, the connector's own description, or only the user's policy?
5. Is there, or will there be, a business/team Muse (one firm, several people, shared connectors)?
   Nothing found on any Meta page.
6. How are Muse's "Meta AI Connectors" preview (dev.meta.ai) and the Muse directory
   (muse.ai/platform) related — one pipeline or two?
7. Does Muse's custom-connector code keep MCP session state or call statelessly? Our server is
   stateless (`sessionIdGenerator: undefined`), which the MCP spec permits.
8. What is `ALLOWED_CLIENT_IPS` set to on the Render web service right now? The step-4 finding
   assumed unset and did not check; the prod checklist requires it set.
9. Does `req.socket.remoteAddress` behind Render's proxy show the client or the proxy? (Affects
   whether the allowlist does anything today.)
10. Muse terms of service for commercial use of the consumer app, and what a firm's customer data
    passing through a Muse VM means for the "emails sent via the assistant are logged" disclosure
    and the no-training promise — not researched.
11. Supabase OAuth Server's MCP guide (`/docs/guides/auth/oauth-server/mcp-authentication`) and its
    support for Client ID Metadata Documents (the MCP spec's preferred registration) — not read.
