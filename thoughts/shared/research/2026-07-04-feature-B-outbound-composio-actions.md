---
date: 2026-07-04
branch: main
commit: 3e43535
topic: "Feature B — Outbound Composio actions via NemoClaw (Gmail send/draft + per-tenant connectors), complementing the inbound webhook path"
---

## Summary

This research maps everything the codebase does today around **outbound** actions — the path
by which a NemoClaw agent (a per-technician AI bot) would *act on* a third-party app (send a
Gmail email, create a draft, write a spreadsheet cell) rather than merely *receive* data from
it. Plain-language framing of the pieces:

- **Composio** is a hosted "connector layer." It holds each person's Google/Microsoft OAuth
  login token so our code never touches raw credentials. It offers two complementary directions:
  **inbound** (Composio watches a mailbox and POSTs new messages to us via a webhook) and
  **outbound** (we ask Composio to *perform an action* on the connected account, e.g.
  `GMAIL_SEND_EMAIL`).
- **The inbound path is fully built** (`src/inbound/webhook.ts`, `src/inbound/normalize.ts`,
  `src/inbound/gmail.ts`): Composio → signed webhook → normalizer → classify-before-L1 →
  `recordFieldNote`. This is the "complement" the feature description references.
- **The outbound path is NOT built.** There is exactly **one** outbound Composio action call in
  the whole repo today — `client.tools.execute('GMAIL_GET_PROFILE', …)` inside pairing, used
  only to learn which mailbox a person connected (`src/composio/pairing.ts:145`). No agent-facing
  send/draft/write tool exists anywhere.
- Critically, the **design of record** (`docs/nemoclaw-tech-agent.md` §7) says outbound is
  intended to reach Composio **NOT through our spine server at all** — the agent talks to a
  **separate per-tenant Composio "Tool Router" MCP endpoint** (`mcp.url`) that the control plane
  registers *side-by-side* with `trades-spine` in the gateway. So "build the outbound path" has a
  genuine fork: (A) wire the agent to Composio's own MCP endpoint (mostly control-plane / gateway
  config, little TypeScript in this repo), versus (B) add spine MCP tools that proxy outbound
  actions through `tools.execute` server-side. This document lays out both without recommending
  one (per the research-phase rules).

The problem outbound solves: the product is Telegram-only (no front end) and the agent chat is
the entire UI. For the agent to be useful beyond *reading* the customer record, it must be able
to *do* things — reply to a customer email, draft a quote — on the technician's connected account.

## Entry Points

Where "outbound to a third-party app" begins or would begin today:

- `src/composio/pairing.ts:39-42` — the `tools.execute(slug, body)` seam on the `PairingClient`
  interface. This is the ONLY typed handle in the repo for invoking a Composio action.
- `src/composio/pairing.ts:145-150` — the only live caller: `GMAIL_GET_PROFILE` (outbound *read*,
  used during pairing to discover the connected mailbox address).
- `src/mcp/server.ts:72-158` (`TOOLS`) and `:163-249` (`ADMIN_TOOLS`) — the agent-facing MCP tool
  surface. **No outbound-action tool is present.** A spine-mediated outbound path (option B below)
  would add a tool here and a `case` in `dispatch` (`src/mcp/server.ts:282-712`).
- `docs/nemoclaw-tech-agent.md:196-234` — the "Secret custody + gateway wiring" and "Scopes"
  sub-sections: the design's actual outbound plan (the per-tenant `mcp.url` route).
- `src/db/database.types.ts:605` — the `capture_channel` enum already contains an unused
  `outbound_email` value (see Constraints), the only schema-level trace of outbound intent.

## Key Files

- **`src/composio/pairing.ts`** — the ONLY place the spine talks to Composio at runtime. Defines
  `PairingClient` (the structural SDK surface: `connectedAccounts.{list,link,delete,disable,
  enable}`, `triggers.{listActive,create,delete,disable,enable}`, and **`tools.execute(slug,
  body)`** at `:39-42`). Provides the lazy singleton `getComposioClient()` (`:48-51`) that
  instantiates `new Composio()` — the client an outbound call would reuse. `compositeUserId(tech)`
  (`:61-63`) builds the `"<tenant>:<ref>"` Composio user id that scopes every action to one
  person's connected account. The `GMAIL_GET_PROFILE` call at `:145` is the reference pattern for
  a server-side outbound action: it passes `{ connectedAccountId, userId, arguments, dangerously
  SkipVersionCheck: true }`.
- **`src/composio/offboarding.ts`** — grace-period enable/disable/teardown of a pairing. Relevant
  to outbound because outbound must respect the same lifecycle: a disabled/offboarded pairing must
  not be able to send. `disablePairing` (`:41-57`) disables the connected account; the roster
  `state` is the source of truth for "may this person act."
- **`src/inbound/webhook.ts`** — the inbound counterpart outbound complements. Shows the shape of
  the existing Composio integration: HMAC-verify (`verifyWebhookSignature` `:38-73`), route by
  `toolkit`+`triggerType`, classify-before-L1, `recordFieldNote`. **The inbound roster gate
  (`:199-214`) is the model for an outbound authorization gate** — it reads the technician row and
  drops the action if `isInactiveState`.
- **`src/inbound/normalize.ts`** — the connector-agnostic *inbound* envelope + normalizer registry.
  There is **no outbound analogue** (no "action registry"); outbound today would be a direct
  `tools.execute` call, not a registered transformer.
- **`src/inbound/gmail.ts`** — the Gmail inbound normalizer. Confirms the live Composio Gmail
  trigger field names. No outbound Gmail helper exists.
- **`src/mcp/server.ts`** — the single agent boundary (MCP server). All agent tools live here;
  outbound-via-spine (option B) plugs in here. Contains the tenant-guard and manager-tier gate
  patterns any outbound tool would reuse (`isActiveManager` `:277-280`, the dispatch roster gate
  `:299-308`).
- **`src/mcp/httpServer.ts`** — the central stateless HTTP entrypoint. Registers `/inbound/*`
  (Composio webhooks) and the MCP transport. An outbound-via-spine tool needs no new route; an
  outbound-via-Composio-MCP path needs no code here at all (the agent connects to Composio's URL
  directly, not to this server).
- **`src/mcp/identity.ts`** — `RequestIdentity` (`tenantId`, `technicianRef`, optional `scopes`).
  The `scopes?: string[]` field (`:16`) is defined but **currently unused** — it is the natural
  hook for a per-tier outbound allowlist (see Decision Points).
- **`src/db/technicians.ts`** — the roster row. Carries `composio_connected_account_id`,
  `composio_trigger_id`, `connected_email`, `state`, `tier`. Any outbound call must resolve the
  acting person's `composio_connected_account_id` here (the same field the inbound stamp and
  offboarding teardown read). Note the ids are **kept** after offboarding (`offboarding.ts:18-20`),
  so presence of an id does NOT imply "allowed to send" — `state` does.
- **`src/email/format.ts`** — `formatEmailRawText({from,subject,body})`, the single L1 storage
  form for email. If an outbound send is to be logged into L1 as evidence (see Decision Points),
  this is the existing formatter to reuse.
- **`docs/nemoclaw-tech-agent.md`** — §7 is the design source of truth for the whole connector
  layer, including the outbound architecture, secret custody, scopes, and the accepted interim
  gap. **Load-bearing:** read §7 before building.
- **`scripts/composio-reconnect.mjs`** — dev helper that deletes+recreates a Gmail connection and
  reads back the granted scope. Confirms the connected account carries the full
  `https://mail.google.com/` scope (read + compose + **send**) — i.e. the token is *already
  capable* of outbound; nothing new needs to be granted for send/draft.

## Data Flows

### Inbound (built) — the complement, for contrast

```
Composio (watches mailbox)
  → POST /inbound/composio (signed)                 httpServer.ts:handleInbound
  → verifyWebhookSignature (HMAC over id.ts.body)   webhook.ts:38
  → resolveNormalizer(toolkit, triggerType)         normalize.ts:37
  → normalizer(data) → InboundEnvelope              gmail.ts:18
  → roster gate (drop if inactive/offboarded)       webhook.ts:199-214
  → classify-before-L1 (work vs personal)           webhook.ts:219-250
  → recordFieldNote → L1 → extract → L2/L3          writePath/recordFieldNote.ts
```

### Outbound (the ONE existing call — a read, during pairing)

```
checkPairing(tech)                                  pairing.ts:105
  → client.tools.execute('GMAIL_GET_PROFILE', {     pairing.ts:145
        connectedAccountId: active.id,
        userId: compositeUserId(tech),   // "<tenant>:<ref>"
        arguments: {},
        dangerouslySkipVersionCheck: true })
  → reads emailAddress from profile.data            pairing.ts:151-153
```

`dangerouslySkipVersionCheck: true` is **required** — without a pinned toolkit version the SDK
throws `ComposioToolVersionRequiredError` (documented at `pairing.ts:139-141`). Any new outbound
`tools.execute` call would hit the same requirement.

### Outbound (NOT built) — the two candidate shapes

**Option A — agent → Composio Tool Router MCP directly (the documented design).** The agent's
gateway registers TWO MCP servers side-by-side; outbound never transits our TypeScript:

```
NemoClaw agent (in sandbox)
  ├── mcp "trades-spine"  → our HTTP server (reads/writes the canonical record)
  └── mcp "composio"      → per-tenant Tool Router mcp.url  (GMAIL_SEND_EMAIL, GOOGLESHEETS_*, …)
                             created by control plane: composio.create(tenantId) → { mcp }
                             (docs/nemoclaw-tech-agent.md:200-207)
```

Here the repo-side work is: control-plane onboarding endpoint + `mcp.url` injection + per-tier
allowlist — **most of which is gateway/control-plane, not `src/`**. The spine `tools.execute`
seam is not used. Verified against live docs: for an agent, Composio recommends the **Sessions /
Tool Router** pattern over manual `tools.execute` (docs.composio.dev/docs/executing-tools).

**Option B — agent → spine MCP tool → server-side `tools.execute` (proxy through the spine).**
A new tool on `src/mcp/server.ts` mirrors the `GMAIL_GET_PROFILE` pattern:

```
agent calls e.g. send_email tool
  → dispatch case in server.ts (tenant + tier + roster-state gate)
  → resolve tech.composio_connected_account_id from the roster
  → getComposioClient().tools.execute('GMAIL_SEND_EMAIL', {
        connectedAccountId, userId: "<tenant>:<ref>", arguments:{recipient_email,subject,body},
        dangerouslySkipVersionCheck: true })
  → (optional) log the sent message into L1 as channel 'outbound_email'
```

Outbound action slugs (verified live 2026-07-04, docs.composio.dev/toolkits/gmail):
- **`GMAIL_SEND_EMAIL`** — `recipient_email`/`to`, `cc`, `bcc`, `subject`, `body`, `is_html`,
  `attachment`, `from_email`. "Sends immediately and is irreversible."
- **`GMAIL_CREATE_EMAIL_DRAFT`** — `recipient_email`, `extra_recipients`, `cc`, `bcc`, `subject`,
  `body`, `is_html`, `thread_id` (for a reply draft; leave subject empty to stay in-thread).
- **`GMAIL_REPLY_TO_THREAD`** — `thread_id`, `recipient_email`, `message_body`, `cc`, `bcc`,
  `attachment` (uses the original thread subject; do not supply a subject).

## External Dependencies

- **Composio** (`@composio/core`, ~0.13) — the connector layer. Outbound uses the same
  `tools.execute` method already used for `GMAIL_GET_PROFILE`, or the per-tenant Tool Router MCP
  URL for the agent-direct path. API key custody: **central control plane / host only**, never in
  a sandbox (docs §7, "Secret custody"). One **Composio-managed** Auth Config per platform
  (`gmail-test` / `ac_5CdPk4l3GV2V`), 11 scopes incl. `https://mail.google.com/` — the connected
  token already permits send + compose + read (verified via the reconnect script's scope readback
  and dashboard notes in the connector-layer memory).
- **Gmail toolkit actions** — slugs verified above against docs.composio.dev/toolkits/gmail
  (2026-07-04).
- **`@modelcontextprotocol/sdk`** — the MCP `Server`/`StreamableHTTPServerTransport` the spine
  uses; relevant only to option B (adding a spine tool).
- **Supabase (`technicians` table)** — resolves the acting person's `composio_connected_account_id`
  and `state`. No new table is implied by outbound.

## Constraints and Invariants

- **`user_id` scoping is the tenant/person safety boundary.** Every Composio action MUST pass
  `userId = "<tenantUuid>:<technicianRef>"` (`compositeUserId`, `pairing.ts:61-63`). Composio
  scopes credentials per `user_id`, so a correct user id makes "A's agent can't touch B's mail"
  structurally true. `user_id="default"` is forbidden (docs §7).
- **Never trust a model-supplied identity.** `dispatch` derives `{tenantId, technicianRef}` from
  the gateway-signed header only (`server.ts:47-52`, `:287-289`), never from tool args. An
  outbound tool must resolve the connected account from the roster by that identity — the model
  must not be able to name an arbitrary `connectedAccountId` or another person's `user_id`.
- **`dangerouslySkipVersionCheck: true` is mandatory** on `tools.execute` (see Data Flows) — the
  SDK otherwise throws `ComposioToolVersionRequiredError`.
- **The connected-account id persists after offboarding** (`offboarding.ts:18-20`): its presence
  does NOT mean "may act." The authority check is `state` — reuse `isInactiveState`
  (`technicians.ts:197-199`) exactly as the inbound roster gate does (`webhook.ts:204`).
- **`GMAIL_SEND_EMAIL` is irreversible** (docs: "sends immediately"). There is no L1 append-only
  concern here (that rule is about *incoming* captures), but there is a no-undo user-safety
  concern — relevant if the tool auto-sends vs. drafts (Decision Points).
- **The per-tier gateway allowlist does not exist yet — accepted interim gap** (docs §7,
  `:223-227`): today any agent holding a tenant's `mcp.url` can both read the full mailbox and
  (if the Composio-side ceiling permits) send. The doc's stated interim mitigation is to set the
  Composio **Execution Allowlist ceiling to draft-only** until the gateway tier allowlist ships.
  Whether that allowlist blocks *execution* or only hides tools from *discovery* is flagged
  **unverified** in the doc (`:214-216`) — to be confirmed during outbound live-verification.
- **`outbound_email` capture channel already exists but is unreferenced.** The `capture_channel`
  enum has `outbound_email` (`database.types.ts:605,765`), but no code writes it. So the schema
  anticipates logging sent mail into L1, yet nothing does — a latent, half-provisioned decision
  (see Decision Points on whether outbound sends should be captured).
- **Tier gates admin, not (yet) connectors.** `tier` (`manager`/`technician`) currently gates
  only the `ADMIN_TOOLS` seat-management surface (`server.ts:263,306-308`). The pricing/access
  design says managers get *broader connector access* (memory: pricing-access-tiers), but no
  connector-level tier gate is implemented — outbound is where that gate would first be needed.
- **Stateless server.** The HTTP MCP server keeps no in-memory state (`httpServer.ts:11-19`); an
  outbound tool must not rely on session state (matches the existing captureId-resume design).

## Decision Points

1. **Where does outbound live — the Composio Tool Router MCP (A) or a spine-proxied tool (B)?**
   - *Option A (the documented design):* the control plane creates a per-tenant `mcp.url` via
     `composio.create(tenantId)` and registers it beside `trades-spine` in the agent's gateway
     config (docs §7 `:200-207`). The agent calls Composio's own `GMAIL_SEND_EMAIL` etc. directly.
     Given the code today, this means **almost no `src/` changes** — the work is control-plane
     onboarding + `mcp.url` injection + the per-tier allowlist, most of which lives outside this
     repo's `src/`. It matches Composio's recommended "Sessions/Tool Router for agents" guidance.
     It keeps "let Composio carry the credential, never the judgment" clean: the spine stays a
     pure reader/writer of the canonical record.
   - *Option B (spine-proxied):* add outbound tools to `src/mcp/server.ts`, each resolving the
     roster's `composio_connected_account_id` and calling `getComposioClient().tools.execute(...)`
     server-side (mirroring the `GMAIL_GET_PROFILE` pattern at `pairing.ts:145`). This gives the
     spine a **server-side enforcement point** for tenant/tier/state gates and a natural place to
     log sends into L1, but it puts the Composio API key on the request path of the spine (it is
     already imported there via `getComposioClient`) and grows the spine's tool surface. It also
     duplicates capability Composio's Tool Router already exposes.
   - The two are not mutually exclusive per action (e.g. read-profile already goes through B),
     but "the outbound path" as a whole picks a primary shape here.

2. **Auto-send vs. draft-only, given the interim gap.** `GMAIL_SEND_EMAIL` is irreversible and the
   per-tier gateway allowlist that would scope send permission is unbuilt (docs §7 `:223-227`).
   The doc's own interim guidance is **draft-only** (`GMAIL_CREATE_EMAIL_DRAFT` /
   `GMAIL_REPLY_TO_THREAD` draft) until the tier allowlist exists. Choosing send now means either
   accepting the gap or building the tier allowlist first.

3. **Do outbound sends get captured into L1?** The `outbound_email` channel exists but is unused.
   - *Capture them:* a sent email becomes L1 evidence (channel `outbound_email`), so the customer
     record reflects what the business *said*, not just what it *received*; reuse
     `formatEmailRawText`. Cost: outbound then also touches the append-only write path and its
     dedup/idempotency rules.
   - *Don't capture them:* simpler; the record stays inbound-only, and the sent message lives only
     in Gmail. The enum value stays latent.

4. **Where the per-tier connector allowlist attaches.** The design says the gateway (doorman
   badge) is the enforcement point (docs §7 `:209-216`), and `RequestIdentity.scopes` (`identity.ts:16`)
   is the unused field built for it. If outbound is spine-proxied (B), the gate could alternatively
   live in `dispatch` keyed on the caller's `tier` (like the existing admin gate). If outbound is
   Composio-direct (A), the gate must live at the gateway/allowlist — the spine never sees the call.

5. **Connector-agnostic outbound vs. Gmail-first.** The design warns against overfitting to Gmail
   and asks to "prove the seam" with two differently-shaped connectors (Gmail outbound +
   Sheets/Excel outbound) but also invokes YAGNI against a speculative framework (docs §7
   `:258-269`). The choice is whether feature B ships Gmail send/draft alone, or also a
   spreadsheet-write action to exercise the connector-agnostic claim now.

## Open Questions

- **Does Composio's Execution Allowlist actually block execution, or only hide tools from
  discovery?** Flagged unverified in docs §7 (`:214-216`). This determines whether the "draft-only
  ceiling" interim mitigation is a real enforcement boundary or advisory. Needs a live check
  against a connected account (per `verifying-behavior`), not just doc reading.
- **Exact `tools.execute` response shape for `GMAIL_SEND_EMAIL` / `_CREATE_EMAIL_DRAFT`** (message
  id, thread id) — needed if outbound sends are logged into L1 with a stable `external_id`. The
  `GMAIL_GET_PROFILE` call reads `profile.data.response_data ?? profile.data` (`pairing.ts:151-153`);
  the send actions' envelope must be confirmed live.
- **Is there an existing control-plane onboarding endpoint / `mcp.url` injection in this repo?**
  Searched `src/` and `scripts/` — found only the *design* (docs §7) and the reconnect dev helper;
  no `composio.create` call or `mcp.url` wiring exists in code yet. If option A is chosen, that
  plumbing is net-new and may live outside this repo (Box_Setup_Stuff / control plane).
- **Idempotency for outbound.** Inbound dedups by Gmail message id (external_id). An outbound send
  has no pre-existing id; whether/how to guard against a retried tool call double-sending an
  irreversible email is unresolved and has no analogue in the current code.

## Assumptions

Recorded because this is a non-interactive run (could not confirm with the user):

- **Interpreted "outbound path" broadly** as "any mechanism by which a NemoClaw agent performs a
  Composio *action* (send/draft/write) on a per-tenant connected account," and documented both the
  Composio-direct (A) and spine-proxied (B) shapes without recommending one — the research phase
  forbids recommendations and the design doc genuinely leaves the primary shape open.
- **Treated `docs/nemoclaw-tech-agent.md` §7 as the design source of truth** and reconciled the
  feature phrasing ("through the Composio connector layer") against it; where the phrasing and the
  documented architecture diverge (the doc routes outbound around the spine), I surfaced the
  divergence as Decision Point 1 rather than silently picking one.
- **Did not run the app, tests, or any DB write** (per the ground rules and CLAUDE.md). Composio
  action slugs and SDK signatures were verified against live vendor docs (cited inline) rather
  than executed.
- **Assumed Gmail send/draft is the concrete first deliverable** (it is the only connector with a
  live pairing today), while noting the design's connector-agnostic ambition as Decision Point 5.
