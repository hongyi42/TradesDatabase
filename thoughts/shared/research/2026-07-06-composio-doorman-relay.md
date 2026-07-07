---
date: 2026-07-06
branch: main
commit: 215e2e5
topic: Composio doorman relay — everything that exists today between a sandbox and a person's Composio session, as input to planning the relay (sandbox → doorman → Render → Composio, per-person session pinning)
---

## Summary

Managers are sold "the full Composio catalog from their Telegram agent," but today their sandbox
has **no working path to Composio at all**. The intended wiring (§0b of the setup guide) — put the
person's Composio session MCP URL (a Model Context Protocol endpoint that exposes their
third-party tools: Gmail, Sheets, Excel, …) directly into the sandbox — is **blocked as designed**:
the URL alone answers HTTP 401, and the only authentication header the Composio SDK supplies with
a session is the **master project API key**, which can act as any user and must never enter a
sandbox. The agreed replacement design (recorded 2026-07-05, this document is its research phase)
is a **relay**: the sandbox talks to the doorman it already trusts with its badge; the doorman
forwards to a new route on the Render control-plane service; Render — which already holds the
master key and the roster — looks up *that person's* session and forwards only there. The caller
controls request content, never destination or credential. This document maps every component the
relay would touch as it exists today: the doorman (which currently hardcodes ONE upstream path —
a second endpoint does *not* ride the same pipe), the Render HTTP server and its signed-identity
scheme, the per-person session model and its tier enforcement, the L1 audit-capture rules for
agent actions, and what Composio's live docs now say about MCP authentication and the new scoped
API keys.

## Entry Points

- [Box_Setup_Stuff/doorman.mjs:20-49](Box_Setup_Stuff/doorman.mjs#L20-L49) — the doorman's entire
  request handler: badge → fingerprint lookup → header mint → forward to the single upstream.
- [src/mcp/httpServer.ts:139-171](src/mcp/httpServer.ts#L139-L171) — `handle()`, the Render
  service's router: `/inbound/*` (webhook HMAC), `GET /control/badges` (host pull token),
  everything else = MCP with signed-identity headers. A relay route would be added here.
- [src/composio/sessions.ts:119-132](src/composio/sessions.ts#L119-L132) — `getSessionMcpUrl()`:
  the only code that reads a session's MCP URL back from Composio (via `sessions.use(id, {mcp:true})`).
- [scripts/provision-session.mjs](scripts/provision-session.mjs) — the operator script the relay
  would make obsolete: prints the session `mcp.url` + secretRef snippet for manual sandbox wiring.
- [src/jobs/lifecycle.ts](src/jobs/lifecycle.ts) — Render cron; step 4 mints per-person sessions
  (`ensurePersonSession`), step 5 runs the execution-log audit sweep (`runLogIngestion`).
- [Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md](Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md)
  §0b (lines 31-86) — the blocked wiring, the block evidence, and the three options recorded at
  block time (relay = option (a), marked RECOMMENDED).

## Key Files

**Box side (trades-box-1):**
- `Box_Setup_Stuff/doorman.mjs` — 49-line Node proxy. Binds `172.18.0.1:3001` (docker bridge
  gateway). Per request: extract `Bearer <badge>`, sha256 it, look up
  `/etc/doorman/badges.json` (re-read every request — revocation is instant), reject 401/403, then
  forward with a **fresh** header set: `x-tenant-id`, `x-technician-ref`,
  `x-identity-signature = HMAC-SHA256(GATEWAY_IDENTITY_SECRET, "tenantId.technicianRef")`. The
  badge and all sandbox headers are dropped. Response is piped (`upRes.pipe(res)`) — SSE streams
  work on this leg.
- `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` — §0b (blocked Composio wiring + manager
  instruction block + session lifecycle gotchas), §5a (egress policy: sandbox may dial
  `host.openshell.internal:3001` only, RFC1918 allowlist mandatory), §5b/§6 (badge as provider
  credential + placeholder mechanics), §4b (non-interactive seat onboard).
- `Box_Setup_Stuff/doorman-architecture-memory.md` — the portable mental model; records the
  Option-A invariants ("the secret never leaves the host; the sandbox NEVER talks to Render
  directly") and, at line 244, the current §0b state (second `mcp.servers` entry per sandbox =
  the person's session `mcp.url`, operator-wired — the thing the relay replaces).

**Render control plane:**
- `src/mcp/httpServer.ts` — stateless per-request server. Routing is by URL path for exactly two
  non-MCP surfaces (`/inbound/*`, `/control/badges`), each with its own auth; every other path
  falls through to the MCP handler (the MCP endpoint "is the service root `/` … the server
  ignores the request path entirely" — `docs/doorman-runbook.md:92-94`). Identity/parse failures
  → bare 401 (`httpServer.ts:164-170`).
- `src/mcp/identity.ts:41-63` — `resolveIdentityFromHeaders()`: recomputes the HMAC over
  `"tenantId.technicianRef"`, timing-safe compare, returns `{tenantId, technicianRef}`. The
  comment at lines 34-40 marks this one function as the future Option-B (JWT) swap point. A relay
  route on Render can call this same function to get the same tamper-evident identity the MCP
  path trusts.
- `src/mcp/server.ts` — the spine tool surface and the tier gate:
  - `TOOLS` (9, lines 91-234) and `ADMIN_TOOLS` (7, lines 239-325); `ADMIN_TOOL_NAMES` set
    (line 339) gates dispatch by name so no admin tool can be added without its guard.
  - `dispatch()` lines 468-488: **one roster read gates every call** — inactive state throws;
    `activeManager` (tier + state from the roster row, never the badge) gates admin tools and the
    `manager_only` sensitivity filter. `ListTools` filtering (lines 1444-1454) is cosmetic;
    dispatch re-gates.
  - `send_email` case (lines 830-958): the technician send path — two-step stage→confirm
    (consume-token-then-send, at-most-once), then **synchronous** L1 capture (`outbound_email`,
    verbatim body, lines 929-950).
- `src/composio/sessions.ts` — `sessionConfigForTier()` (lines 32-43): manager =
  `{manageConnections:true, mcp:true}` (entire catalog); technician = `direct_tools` preset pinned
  to `TECHNICIAN_GMAIL_TOOLS` (fetch/draft/profile — send structurally impossible).
  `ensurePersonSession()` (lines 58-91): idempotent, ACTIVE rows only, id persisted as
  `technicians.composio_session_id`, compensating delete on a failed persist.
  `teardownPersonSession()` (lines 100-114): deletes the session and NULLs the column
  (deactivation + tier-change hygiene). `getSessionMcpUrl()` (lines 119-132): SENSITIVE — the URL
  grants the whole session.
- `src/composio/pairing.ts` — `compositeUserId()` (lines 71-73): `"${tenant_id}:${ref}"`, the one
  definition shared by webhook/outbound/sessions. `PairingClient` interface (lines 24-50): the
  structural SDK surface incl. `sessions.create/use/delete`. `getComposioClient()` (lines 55-59):
  lazy singleton over the master `COMPOSIO_API_KEY`.
- `src/composio/outbound.ts` — `sendGmailEmail()`: server-side `tools.execute('GMAIL_SEND_EMAIL')`
  **pinned to the roster row's `composio_connected_account_id`** — the agent never names an
  account id; the roster row resolved from the badge identity is the only reachable account.
  This is the existing in-repo example of "per-person pinning done server-side."
- `src/composio/logIngest.ts` — the async audit sweep (details under Data Flows).
- `scripts/provision-session.mjs` — refuses any `SUPABASE_URL` that isn't the pilot ref
  (lines 17-22); hardcodes the pilot tenant UUID as its default (line 40).

**Docs:**
- `docs/nemoclaw-tech-agent.md` §7 — the outbound architecture of record (amended 2026-07-04) and
  the Phase-5 live-verification block: 4310 enforcement evidence, DIRECT_TOOLS adversarial probes
  (no connection-minting route on a technician session), manager session breadth, logs API v3.1
  envelope shapes. Also the "Secret custody + gateway wiring" section: master key + session URLs
  are control-plane/host-only; sessions ARE an execution-time boundary (verified), with the caveat
  quote "you can't intercept, reshape, log, or gate calls" over MCP.
- `docs/doorman-runbook.md` — cold-start doorman deployment; Invariants 1-4 (no secret in a
  sandbox, byte-exact signing, fail closed, verify before done); the permanent-signature note
  (HMAC has no timestamp/nonce — contained because only the doorman holds signatures).
- `docs/control-plane.md` — the five cron sweeps and the Render env contract (web:
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GATEWAY_IDENTITY_SECRET`,
  `COMPOSIO_WEBHOOK_SECRET`, `COMPOSIO_API_KEY`, `COMPOSIO_GMAIL_AUTH_CONFIG_ID`,
  `ANTHROPIC_API_KEY`; cron: `SUPABASE_URL`, key, `COMPOSIO_API_KEY`).

## Data Flows

**Today's spine path (works, unchanged by the relay):**

```
Telegram user
   │
   ▼
sandbox agent (holds ONLY the badge, as provider credential)
   │  POST http://host.openshell.internal:3001/   Authorization: Bearer <badge>
   ▼
doorman @172.18.0.1:3001
   │  drops badge; mints x-tenant-id / x-technician-ref / x-identity-signature
   ▼
Render httpServer  ──(resolveIdentityFromHeaders → createServer({identity}) → dispatch)──►
   per-call roster read → tier gate → tool logic → Supabase (pilot DB)
```

**Today's Composio paths (no sandbox leg exists):**

```
technician send:  sandbox → doorman → Render spine tool send_email (two-step)
                  → outbound.ts tools.execute(master key, PINNED connectedAccountId)
                  → synchronous L1 capture (outbound_email, verbatim)

manager catalog:  ✗ NO PATH — §0b blocked. Sessions exist server-side (cron mints them),
                  but the sandbox has no credential that can reach them.

audit:            Render cron (15 min) → Composio v3.1 execution-logs API (master key)
                  → runLogIngestion → L1 (outbound_email verbatim / agent_action keys-only,
                  manager_only) — 60-min overlapping window, per-tenant externalId dedup
```

**The agreed relay (design of record, 2026-07-05 — what the plan phase will detail):**

```
sandbox (2nd mcp.servers entry, SAME badge, zero new secrets)
   │  Bearer <badge>
   ▼
doorman (badge validation unchanged)
   │  signed identity headers, as today
   ▼
Render — NEW route: verify identity (same resolveIdentityFromHeaders)
   → roster lookup: technicians.composio_session_id for {tenantId, technicianRef}
   → forward ONLY to that session's MCP endpoint, adding x-api-key: <master key>
   ▼
Composio session MCP (tier enforced INSIDE the session config — 4310)
```

Caller controls request content, never destination or credential. Manager reaches the full
catalog because THEIR session is full-catalog; a technician would land on the pinned read/draft
session.

**The doorman's one-upstream constraint (named research question #1 — ANSWERED from code):**
[doorman.mjs:43](Box_Setup_Stuff/doorman.mjs#L43) builds the upstream request with
`path: up.pathname + up.search` — the path comes from the `MCP_UPSTREAM_URL` env var, and the
sandbox's own request path (`req.url`) is **ignored entirely**. So today a second endpoint does
NOT ride the same pipe: a sandbox POSTing to `http://host:3001/composio` still lands on the
configured upstream path (`/`). The doorman also has exactly one badges file and one env file per
instance (`/etc/doorman/doorman.env`, systemd `doorman.service`). Passing the path through is a
one-line change to `doorman.mjs` — but it would forward *any* path a badge-holder names,
including Render's non-MCP routes (`/inbound/*`, `/control/badges`; both carry their own auth and
would reject doorman-signed traffic, but they would newly be *reachable* from a sandbox).

**Session lifecycle interaction:** on deactivation the session is deleted and
`composio_session_id` NULLed; on reactivation the sweep mints a FRESH session (new id, new URL).
Under the current §0b design that forces an operator to re-provision the sandbox's secretRef
(setup guide §0b "Session lifecycle gotchas"). Under the relay, Render reads
`composio_session_id` per request — a re-minted session is picked up automatically and the
re-provisioning step disappears.

## External Dependencies

All Composio claims below were re-verified against live vendor docs on 2026-07-06 (CLAUDE.md
external-services rule):

- **Composio MCP authentication (`require_mcp_api_key`).** "Pass an `x-api-key` header when
  connecting to Composio MCP. This is required when `require_mcp_api_key` is enabled (default for
  newly created organizations)" — [MCP quickstart](https://docs.composio.dev/docs/mcp-quickstart).
  Per the changelog (surfaced via search; the changelog page itself returned 404 to direct fetch
  on 2026-07-06 — URL drift, content confirmed via search index): default-on for orgs created
  from **March 5, 2026**; requests without the header → 401; opt-out is a project setting
  (`require_mcp_api_key: false`). This matches the live-verified §0b block (2026-07-05: session
  `mcp.url` alone → 401; the SDK's `session.mcp.headers` auth value is the master key). Option
  (b) from §0b — disabling the setting project-wide — is the documented opt-out, recorded at
  block time as vendor-discouraged.
- **Scoped project API keys — status CHANGED since the 2026-07-05 finding.** The §0b note said
  scoped keys were "still rolling out." As of 2026-07-06 they are documented as shipped ("· New"):
  same `x-api-key` header, "a chosen subset of a single project's resources"
  ([Authenticating to Composio](https://docs.composio.dev/reference/authenticating-to-composio)).
  Permission areas include **"Tool execution: Execute predefined Composio tools" (write-only,
  `POST /api/v3.1/tools/execute/{tool_slug}`)**, **"Proxy execute" (separate area)**, and
  **"Sessions: Create and operate sessions and MCP servers" (read and write,
  `/api/v3.1/tool_router/session` endpoints)** —
  [Project API key permissions](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions).
  **Limit:** permissions are per-area, **not per user_id or session_id** — no per-person
  isolation; a key's permissions are fixed at creation. So a scoped key can shrink the relay's
  blast radius (e.g. a key that can operate sessions but not manage connected accounts or read
  logs) but **cannot replace Render-side per-person pinning** as the security boundary (named
  research question #4: partially answered — a swap is possible now, pinning stays ours).
- **Sessions over MCP are outside our request path today.** "Over MCP you can't intercept,
  reshape, log, or gate calls … `beforeExecute`/`afterExecute` hooks … live in the SDK's
  execution path. Over MCP the client executes tools against the server and bypasses them" —
  [Sessions via MCP](https://docs.composio.dev/docs/sessions-via-mcp). This is why the manager
  audit is an async log sweep. **The relay changes this premise**: with Render forwarding every
  session request, our code is back in the path (see Decision Points).
- **Session config binds user and (optionally) connected accounts at creation.** Sessions are
  created pinned to a `user_id`; when a user has multiple connected accounts, `connectedAccounts`
  in the session config selects which one the session uses —
  [Configuring sessions](https://docs.composio.dev/docs/configuring-sessions). The docs do NOT
  state whether a `tools/call` *through* a session can name a different `connectedAccountId` in
  its arguments when the backing key is the master key — named research question #2 (cross-account
  injection) remains open and needs a live probe.
- **Session restriction enforcement**: execution-time, HTTP 400 with code `4310` /
  `ToolRouterV2_ToolNotInEnabledList` (docs say 403 — match code/slug, never HTTP status);
  live-verified 2026-07-04 against this project (`docs/nemoclaw-tech-agent.md` §7, with
  [Configuring sessions](https://docs.composio.dev/docs/configuring-sessions) and
  [Sessions via MCP](https://docs.composio.dev/docs/sessions-via-mcp) as the doc base).
- **Render** — free tier today: cold start ~32s exceeds the agent's 30s MCP connect timeout
  (setup guide §8); the relay adds Render to EVERY outbound tool call's path (accepted cost in
  the design record: latency + single choke point; user plans paid/always-on).
- **Supabase** — the roster (`technicians.composio_session_id`) is the relay's per-request lookup
  table; one DB per control plane.
- **OpenShell/NemoClaw** — sandbox egress is allowlisted to `host.openshell.internal:3001` only
  (§5a); the OCSF egress log attributes and logs every allowed dial. A second MCP entry pointing
  at the SAME host:port needs no new egress policy; a second doorman on a NEW port would.

## Constraints and Invariants

- **The master `COMPOSIO_API_KEY` never enters the box or a sandbox** (custody rule,
  `docs/nemoclaw-tech-agent.md` §7). It already lives on Render (web + cron). Box compromise must
  keep yielding only revocable badges.
- **A session's `mcp.url` grants the whole session** — sensitive even without the header
  requirement; never in sandbox filesystem, logs, or the repo (`sessions.ts:117-119`,
  `provision-session.mjs` custody notes).
- **Per-person pinning is the intended security boundary, not the key** (design record): the
  caller must control request content only — destination (which session) and credential must be
  chosen server-side from the signed identity. The in-repo precedent is `outbound.ts` (account id
  pinned from the roster row, never from model args).
- **Identity is established at the boundary, never from model-supplied arguments**
  (`identity.ts:3-6`). The relay inherits this: its identity input is the same signed header
  triple the MCP path trusts.
- **One upstream, one badges file, one env per doorman instance**; the upstream path is
  env-configured and request-path-blind (`doorman.mjs:9,43`).
- **`GATEWAY_IDENTITY_SECRET` pairs a doorman with a Render service** — the relay route, living
  on the same Render service, reuses the existing pairing; no new secret.
- **Tier lives in the roster row, not the badge** — and for Composio, tier lives in the SESSION
  CONFIG, enforced by Composio at execution (4310). A tier change without session teardown leaves
  the old tier live (`sessions.ts:93-99`, setup guide §0b gotchas).
- **Sessions exist only for ACTIVE rows** (`ensurePersonSession` skips others; deactivation
  tears down). A relay request for a person with no `composio_session_id` has nothing to forward
  to — the failure mode needs defining (the sweep can lag a reactivation by up to 15 min).
- **L1 is append-only and undeletable.** Outbound/agent-action captures are classifier-free
  (recorded exception 2026-07-04); non-send captures store argument KEY NAMES only
  (`logIngest.ts:254-266`); Excel READ slugs are excluded from capture entirely (user decision
  2026-07-05, `logIngest.ts:35-41` — the memory record notes the observed live slugs still need
  to be appended to `READ_SLUG_PREFIXES` once re-observed; the current prefixes `EXCEL_GET_/
  EXCEL_LIST_/EXCEL_SEARCH_` already cover the slugs listed in the comment). Manager
  `agent_action` rows carry `sensitivity='manager_only'` and are filtered from technician-tier
  spine reads (`server.ts:481-488`). Audit-channel rows are manager-only-retractable even for
  their author (`server.ts:341-347,979-985`).
- **Disclosure obligation**: managers AND technicians must be told "emails sent via the assistant
  are logged" (CLAUDE.md recorded exception; setup guide §0b).
- **The known duplicate-capture limitation** (`logIngest.ts:203-210`): a manager using the spine
  `send_email` whose message ids fail to parse on both sides can produce a duplicate
  `outbound_email` row — the structural discriminator (log detail `context.session_id`,
  session-originated vs API-key execute) was left unadopted pending live verification. A relay
  that adds a third capture producer would interact with this dedup story.
- **Streaming**: the doorman leg pipes responses (SSE-capable). The Render MCP path uses
  `StreamableHTTPServerTransport` to SERVE MCP — it is not a proxy; a relay route on Render is a
  new raw HTTP proxy leg whose SSE behavior is unbuilt and unverified (named research question #3
  — open).
- **Test seams**: every Composio touchpoint is dependency-injected (`PairingClient`,
  `SessionDeps`, `LogIngestDeps`, `ServerDeps`) so the suite never needs `COMPOSIO_API_KEY`;
  tests run only against the local stack (`testEnvGuard`). A relay route would need the same
  injectable shape to be testable.

## Decision Points

Factual forks the current code creates for the plan phase — no recommendations:

1. **How relay traffic is distinguished at the doorman.** The doorman is request-path-blind
   today. Options given the code: (a) pass the sandbox's path through (`path: req.url` or a
   prefix map in `doorman.mjs`) so one doorman serves both surfaces — this newly exposes ALL
   Render paths to badge-holders (each Render route still carries its own auth); (b) a mapped
   passthrough (only an allowlisted prefix, e.g. `/composio/*`, is forwarded; everything else
   goes to `/`); (c) a second doorman instance (own port/env/badges file/systemd unit) with
   `MCP_UPSTREAM_URL` pointing at the relay route — no doorman code change, but a second port
   means a new §5a egress policy entry and more box state.
2. **Where the relay terminates on Render.** `httpServer.ts` routes by path prefix before the
   MCP fallthrough; a relay route would slot in like `/inbound/` does, calling
   `resolveIdentityFromHeaders` and then proxying. The MCP fallthrough currently swallows every
   unknown path — a relay path must be routed BEFORE it, or requests silently become spine MCP
   calls.
3. **What Render forwards to.** `getSessionMcpUrl()` calls Composio (`sessions.use`) per
   invocation. Per-request lookup = one extra Composio API call per tool call but always-fresh
   URLs (reactivation-safe); caching the URL (in memory or on the roster row) trades staleness
   for latency. The session URL's stability across `sessions.use` calls is unverified.
4. **Which credential backs the forward leg.** The master key works today. Scoped project keys
   are now documented (Sessions + Tool-execution permission areas) and use the same header — a
   relay-dedicated scoped key would shrink blast radius, but scoped keys have NO per-user
   isolation, so Render-side pinning remains the boundary either way. Swap point is one header
   value.
5. **Whether the relay captures to L1 synchronously.** Today manager actions are audited only by
   the 60-min async log sweep because "over MCP you can't intercept" — the relay puts our code
   back in the request path, making synchronous capture (like `send_email`'s) possible for the
   first time. Forks: keep sweep-only (relay stays a dumb pipe; simplest; audit lag unchanged),
   or capture at the relay (immediate, but a SECOND producer of `outbound_email`/`agent_action`
   rows whose externalIds must reconcile with the sweep's `composio-exec:<logId>` /
   `sent:<messageId>` stamps — see the known duplicate limitation), or capture at the relay and
   narrow the sweep. The keys-only redaction policy applies to whatever captures.
6. **Whether the relay sanitizes request arguments.** If the cross-account injection probe
   (Open Questions) shows Composio does NOT pin `connectedAccountId` server-side under a
   master-key-backed session call, Render must strip/rewrite account-id arguments in the
   forwarded body — which requires parsing MCP `tools/call` payloads rather than blind piping.
   The probe result decides whether the relay can be a byte-blind proxy.
7. **What a technician's relay access is.** The technician session (read/draft, send-impossible)
   exists and is execution-enforced. The relay could serve both tiers (technicians get their
   pinned session — Composio enforces the shape) or be manager-only at the Render route (roster
   tier check, like `ADMIN_TOOL_NAMES`). Both gates already exist in code precedent.
8. **What happens on a missing/stale session.** A reactivated person can be session-less for up
   to one 15-min sweep tick; `ensurePersonSession` is idempotent and callable outside the cron.
   The relay route can 503-until-sweep, mint-on-demand, or surface a distinct error to the agent.
9. **Bake-in and box wiring for the second MCP entry.** The trades-spine entry is baked via §6
   (generator gated on `NEMOCLAW_TRADES_SPINE_ENABLED`, placeholder header). A `composio` entry
   pointing at the doorman (same badge placeholder) would follow the same mechanism — or start as
   a §5c-style manual writable-layer edit (wiped on recreate). The §0b operator step and
   `provision-session.mjs`'s sandbox-wiring purpose disappear under the relay; the script's
   session read-back may remain useful for diagnostics.

## Probe results (2026-07-06, live against the pilot Composio project)

Run via a scratch script using the master key + the three live pilot sessions (`manager-sam`
manager; `office-dispatch` + `tech-jane` technicians — only `tech-jane` owns a connected account,
`ca_B6A_2oM4TqL-`, mailbox `hongyi23360228@gmail.com`). All six resolved the way the plan needs:

1. **Cross-account injection → OUTCOME A (Composio pins the account to the session; the argument
   is ignored).** `office-dispatch`'s session (which owns NO connected account) issued
   `tools/call GMAIL_GET_PROFILE` with `arguments.connectedAccountId = ca_B6A_2oM4TqL-`
   (tech-jane's). Composio returned `successful:false, "No active connection found for
   toolkit(s) 'gmail' in this session."` — it resolved the connection from the SESSION's user, not
   the argument, and never touched Jane's account (her email did not leak). **Consequence:** the
   relay's connected-account guard is defense-in-depth, NOT load-bearing; it stays as a blanket
   400 (no narrowing needed — see probe 6). The relay can remain a byte-blind proxy (Decision
   Point 6 resolved).
2. **Scoped-key acceptance → YES.** The session MCP endpoint returned 200 on `initialize` with
   `x-api-key = COMPOSIO_RELAY_API_KEY` (the scoped key), same as with the master key. The relay
   deploys with `COMPOSIO_RELAY_API_KEY`; the master key stays the fallback.
3. **Session URL stability → immediate-identical.** Two `sessions.use(id,{mcp:true})` calls
   returned the same URL (`https://backend.composio.dev/tool_router/<tok>/mcp`). Per-request
   lookup stays for v1 (safe regardless); a ≥10-min-spaced re-check before caching remains a
   recorded follow-up.
4. **SSE shape → `text/event-stream`.** Both `initialize` and `tools/list` responded as SSE. The
   relay's piping (headers + body, no buffering) already preserves this; the doorman leg already
   pipes too.
5. **Statefulness → stateless (no `Mcp-Session-Id`).** `initialize` returned NO `Mcp-Session-Id`
   header, and `tools/list` succeeded without one (the session is carried in the URL token, server
   `mcp-typescript server on vercel`). The plan's `mcp-session-id`/`mcp-protocol-version`
   whitelist-forwarding is therefore harmless-but-not-load-bearing here — kept for robustness
   against a future stateful endpoint.
6. **Manager meta-tool argument shapes → no false positives.** The manager session lists 6
   meta-tools (`COMPOSIO_MANAGE_CONNECTIONS`, `MULTI_EXECUTE_TOOL`, `REMOTE_BASH_TOOL`,
   `REMOTE_WORKBENCH`, `SEARCH_TOOLS`, `GET_TOOL_SCHEMAS`); NONE carry a `connected_?account` key
   in their input schema. The blanket guard will not 400 the sold manager self-serve-pairing flow.
   (Technician session lists exactly the 3 pinned Gmail tools, as expected.)

Also confirmed at the boundary: the header the SDK supplies with a session is a single `x-api-key`
= the master key (the §0b block premise), so putting it in a sandbox would indeed grant master
access — the relay is the right shape.

## Open Questions

*(#2 cross-account, #3 SSE, session-URL stability, and scoped-key fit are RESOLVED above — see
Probe results. Remaining:)*

- **SSE through two proxy legs end-to-end at the timeout boundary:** the endpoint responds SSE
  (probe 4) and both legs pipe, but the FULL sandbox→doorman→Render→Composio chain under Render's
  ~32s cold start vs the agent's 30s connect timeout is only provable in the Phase 3/4 live E2E,
  not the probe.
- **Session URL caching:** URLs are immediate-identical (probe 3); a ≥10-min-spaced re-check is
  still wanted before switching from per-request lookup to caching (deferred follow-up).
- **Whether `require_mcp_api_key` opt-out (option (b)) has changed shape** — the changelog page
  itself 404'd on direct fetch (docs-site restructuring); the setting's current dashboard/API
  location should be re-confirmed at plan time if option (b) is ever reconsidered.
- **Per-tool-call latency budget:** sandbox→doorman→Render(→Composio-lookup)→Composio adds two
  managed-service hops to every catalog tool call; no measurement exists. The §8 cold-start
  interaction (32s > 30s timeout) applies to the relay's FIRST call after idle too.
- **Composio-side rate limits on the relay pattern** (one server IP funneling all tenants'
  session traffic): [rate limits reference](https://docs.composio.dev/reference/rate-limits)
  exists but plan-time reading is needed against expected call volume.
