---
date: 2026-08-11
branch: fix/doorman-crash-on-upstream-error
commit: 25f6a12
topic: Composio relay per-request latency — what getSessionMcpUrl costs, what is cacheable, and what the security model requires
---

## Summary

Every time a NemoClaw agent uses a Composio tool (Gmail, Sheets, …), the request travels
sandbox → doorman (on trades-box-1) → **this repo's relay on Render** → that person's
Composio-hosted MCP endpoint. "MCP" (Model Context Protocol) is the standard by which the
agent discovers and calls tools; a "session" here is a Composio-side object that pins which
tools one person is allowed to use.

The relay's job is safety, not speed: the caller controls only the request *body*. Which
Composio session the request reaches, and which credential is used, are both chosen
server-side from a cryptographically signed identity header. That means a badge can only
ever reach its own person's session.

The performance question in scope is that **the relay does real work on every single
request** — one database read plus one live Composio API call — before it forwards
anything. A Model Context Protocol handshake is four requests (`initialize`,
`notifications/initialized`, a GET stream open, `tools/list`), so a single agent turn pays
that per-request work four times before the model is even called. Measured externally:
manager turns spend ~2.82s before the model call versus ~0.54s on sandboxes with no
Composio server bundled.

## Entry Points

- [src/mcp/httpServer.ts:420-423](../../../src/mcp/httpServer.ts#L420-L423) — the route.
  `isRelayPath(req.url)` matches and calls `handleComposioRelay(req, res, rawBody)`. It is
  deliberately placed *before* the MCP fallthrough, which serves every unrouted path.
- [src/composio/relayHandler.ts:124](../../../src/composio/relayHandler.ts#L124) —
  `handleComposioRelay`, the whole per-request path.
- [src/composio/relayHandler.ts:50-53](../../../src/composio/relayHandler.ts#L50-L53) —
  `isRelayPath` matches three forms: `/composio`, `/composio/*`, `/composio?*`. The comment
  records why all three must route here: a query string on the bare path would otherwise
  fall through to the spine MCP handler as a malformed MCP request.

## Key Files

| Path | Role | Key exports |
|---|---|---|
| [src/composio/relayHandler.ts](../../../src/composio/relayHandler.ts) | The relay itself: identity → roster → session → forward | `handleComposioRelay`, `isRelayPath`, `ForwardFn`, `RelayDeps` |
| [src/composio/sessions.ts](../../../src/composio/sessions.ts) | Per-person Composio sessions; the tier boundary | `sessionConfigForTier`, `ensurePersonSession`, `teardownPersonSession`, `getSessionMcpUrl`, `TECHNICIAN_GMAIL_TOOLS` |
| [src/composio/pairing.ts](../../../src/composio/pairing.ts) | The only place the spine talks to Composio at runtime; holds no state | `getComposioClient`, `compositeUserId`, `PairingClient`, `createConnectLink`, `checkPairing`, `deleteComposioPairing`, `unpair` |
| [src/mcp/identity.ts](../../../src/mcp/identity.ts) | Per-request identity from the gateway's signed headers | `resolveIdentityFromHeaders`, `identityFromEnv`, `RequestIdentity` |
| [src/mcp/httpServer.ts](../../../src/mcp/httpServer.ts) | Central HTTP entrypoint; routes relay vs spine MCP | `createHttpServer` |
| [src/db/technicians.ts](../../../src/db/technicians.ts) | Roster row accessors and the lifecycle-state predicate | `getTechnician`, `isInactiveState`, `Technician`, `TechnicianTier` |
| [src/jobs/lifecycle.ts](../../../src/jobs/lifecycle.ts) | The cron sweep that provisions sessions | `runLifecycle` |
| [src/composio/sessions.test.ts](../../../src/composio/sessions.test.ts) | Pins both tier configs | — |

## Data Flows

### One relayed request, end to end

```
sandbox (agent)
   │  Authorization: Bearer <badge>
   ▼
doorman on trades-box-1  (badge → signed identity headers; badge never forwarded)
   │  x-tenant-id / x-technician-ref / x-identity-signature
   ▼
httpServer.ts:420  isRelayPath → handleComposioRelay
   │
   ├─ :132  resolveIdentityFromHeaders   ── HMAC verify (no I/O)
   ├─ :134  getTechnician(tenant, ref)   ── ①  DATABASE ROUND TRIP
   ├─ :136  isInactiveState → 403
   ├─ :143  mint-on-demand if no session id (rare; steady state skips)
   ├─ :159  JSON.parse + connected-account key guard
   ├─ :175  getSessionMcpUrl(...)        ── ②  LIVE COMPOSIO API CALL
   ├─ :189  build fresh headers (master x-api-key injected here)
   ├─ :203  bill only if method === 'tools/call'
   └─ :217  forward                      ── ③  PROXY TO COMPOSIO MCP
```

Every relayed request pays ①, ②, and ③. Nothing between them is memoised.

`getSessionMcpUrl` ([sessions.ts:119-132](../../../src/composio/sessions.ts#L119-L132)) is
where ② happens:

```ts
const used = await client.sessions.use(tech.composio_session_id, { mcp: true });
const url = pickString(mcp ?? {}, 'url') ?? pickString(used, 'mcpUrl', 'mcp_url');
```

Its return value is the session's MCP endpoint URL. It takes `(tech, deps)` and returns
`Promise<string>`; it throws if the row has no `composio_session_id`.

### An MCP handshake multiplies that by four

The relay explicitly proxies non-billable protocol traffic
([relayHandler.ts:155-157](../../../src/composio/relayHandler.ts#L155-L157)): "the relay
also proxies initialize / notifications/initialized / tools/list and bare GET SSE opens,
none of which are billable Composio tool calls." Only `tools/call` increments the counter
([:39-45](../../../src/composio/relayHandler.ts#L39-L45), [:203](../../../src/composio/relayHandler.ts#L203)).

So one handshake = 4 × (DB read + Composio API call + forward). Billing is unaffected, but
latency is not: the ① and ② work is per request regardless of method.

### Where a person's catalog is decided

[sessions.ts:32-43](../../../src/composio/sessions.ts#L32-L43):

```ts
if (tier === 'manager') {
  return { manageConnections: true, mcp: true };   // no toolkit/tool restriction
}
return {
  sessionPreset: 'direct_tools',
  toolkits: ['gmail'],
  tools: { gmail: TECHNICIAN_GMAIL_TOOLS },        // 3 tools
  manageConnections: false,
  mcp: true,
};
```

The module header states the rule as a HARD RULE ([:9-12](../../../src/composio/sessions.ts#L9-L12)):
sessions are ALWAYS created with an explicit per-tier config, because "a bare session
defaults to the ENTIRE catalog with manageConnections enabled," and no code path may call
`client.sessions.create` except through this module. `sessions.test.ts:125-126` pins the
manager shape and annotates it `// full catalog is intentional`.

Tool restrictions are **execution-enforced by Composio**, not by us — live-verified
2026-07-04 as HTTP 400 with code `4310` / slug `ToolRouterV2_ToolNotInEnabledList`
([sessions.ts:4-7](../../../src/composio/sessions.ts#L4-L7)). The header notes the docs say
403 and instructs matching on code/slug, never HTTP status.

## External Dependencies

- **`@composio/core`** — `getComposioClient()` is a lazy singleton
  ([pairing.ts:56-60](../../../src/composio/pairing.ts#L56-L60)) so importing the module
  never requires the key. The `PairingClient` interface
  ([pairing.ts:25-51](../../../src/composio/pairing.ts#L25-L51)) is a minimal structural
  view of the SDK surface, verified against `@composio/core` 0.13 typings plus a live probe
  2026-07-02; `sessions.create/use/delete` verified in installed typings 2026-07-04.
- **Composio Tool Router / Sessions API** — reached via `sessions.use`, `sessions.create`,
  `sessions.delete`.
- **Supabase** — the roster read on every relayed request.
- **Render** — hosts this HTTP server. `MCP_UPSTREAM_URL` on the doorman points at it.
- Credentials: `COMPOSIO_RELAY_API_KEY ?? COMPOSIO_API_KEY`
  ([relayHandler.ts:184](../../../src/composio/relayHandler.ts#L184)); a missing key answers
  503 explicitly rather than letting Composio return a 401 that would be indistinguishable
  from a badge/HMAC failure ([:185-188](../../../src/composio/relayHandler.ts#L185-L188)).

Vendor documentation consulted (2026-08-11): Composio states that sessions persist
server-side and do not expire, that `mcp: true` at create time exposes the hosted MCP
server, and that a stored session id should be reused via `use(sessionId, { mcp: true })`
rather than re-creating. Sources: [Using sessions via MCP](https://docs.composio.dev/docs/sessions-via-mcp),
[Session SDK reference](https://docs.composio.dev/reference/sdk-reference/typescript/session),
[How Composio works](https://docs.composio.dev/docs/how-composio-works#users).

## Constraints and Invariants

1. **The per-request roster read is the instant-revocation mechanism, by design.** The
   parallel gate in the spine dispatcher states it plainly
   ([server.ts:1612-1619](../../../src/mcp/server.ts#L1612-L1619)): "ONE roster read gates
   every call. Badge revocation propagates to hosts on the ≤5-min pull, so a deactivated
   person's badge can briefly outlive their roster state — this check makes 'deactivation
   cuts access instantly' true server-side for ALL tools." The relay performs the equivalent
   check at [:134-138](../../../src/composio/relayHandler.ts#L134-L138). Any change that
   lets a request reach Composio without consulting current roster state removes that
   property.

2. **`isInactiveState` covers only two states.**
   [technicians.ts:462-464](../../../src/db/technicians.ts#L462-L464) returns true for
   `offboarding` and `offboarded`. The enum also contains `invited`,
   `pending_verification`, `active`. It is described as "the single definition of 'this
   roster row no longer participates'" and is consulted by the webhook drop, sheet
   validation, and the deactivate guard.

3. **Per-person pinning is the security boundary, not a convenience.**
   [relayHandler.ts:8-13](../../../src/composio/relayHandler.ts#L8-L13): "destination
   (which session) and credential (x-api-key) are chosen here from the signed identity, so
   the master key never leaves the control plane and a badge can only ever reach its own
   person's session (design of record 2026-07-05, plan 2026-07-06)."

4. **The session MCP URL is marked SENSITIVE.**
   [sessions.ts:116-118](../../../src/composio/sessions.ts#L116-L118): "SENSITIVE — grants
   the person's whole session; print/inject via the control plane only, never log or store
   it (custody rule, docs §7)." The word *store* is explicit.

5. **Tier changes require session teardown.**
   [server.ts:1587-1594](../../../src/mcp/server.ts#L1587-L1594): "⚠ Demotion procedure
   MUST also tear down the person's Composio session (`teardownPersonSession` — nulls
   `composio_session_id` so the sweep re-mints at the new tier): `ensurePersonSession`
   short-circuits on an existing id, so a stale manager session otherwise keeps the full
   catalog + manageConnections indefinitely." `teardownPersonSession`
   ([sessions.ts:100-114](../../../src/composio/sessions.ts#L100-L114)) NULLs the column on
   success, which is what lets the sweep re-mint with the current tier config.

6. **The spine HTTP server is stateless per request.**
   [httpServer.ts:24-27](../../../src/mcp/httpServer.ts#L24-L27) and
   [:428-431](../../../src/mcp/httpServer.ts#L428-L431): a fresh
   `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` and a fresh
   `createServer({ identity })` are built per request, "so any replica can serve any
   request (the captureId resume keeps no in-memory state)."

7. **There is no cross-request cache anywhere in `src/` today.** Every `Map` used as a
   cache is created inside a function body and dies with the request —
   [booking.ts:1316](../../../src/schedule/booking.ts#L1316),
   [fit.ts:471](../../../src/schedule/fit.ts#L471),
   [fit.ts:555](../../../src/schedule/fit.ts#L555). A process-lifetime cache would be a new
   pattern for this codebase.

8. **Composio's stateful MCP needs its protocol headers relayed.**
   [relayHandler.ts:195-198](../../../src/composio/relayHandler.ts#L195-L198) whitelists
   `mcp-session-id` and `mcp-protocol-version`, with the comment "whitelist the MCP protocol
   headers a stateful streamable-HTTP server needs post-initialize." The response is piped
   headers-and-all ([:109-114](../../../src/composio/relayHandler.ts#L109-L114)) because
   that is what carries SSE streams and the `Mcp-Session-Id` back to the agent.

9. **Identity headers are never forwarded to Composio**
   ([relayHandler.ts:180-183](../../../src/composio/relayHandler.ts#L180-L183)); a fresh
   header set is constructed on every request.

10. **A connected-account argument guard runs on every parsed body.**
    [relayHandler.ts:56-78](../../../src/composio/relayHandler.ts#L56-L78) rejects any body
    containing a key matching `/connected_?account/i` at any depth, as fail-closed
    defence-in-depth against a request naming another person's connected account.

11. **Billing must stay attached to `tools/call` only.** The counter sits at the forward,
    not at the roster read, "not at the roster read, where it would count requests that
    never billed" ([:200-203](../../../src/composio/relayHandler.ts#L200-L203)).

## Decision Points

**1. What gets cached — the resolved URL, the `tools/list` body, or both.**
The URL resolution (② above) happens on *every* relayed request including every tool call;
the `tools/list` body is one request per handshake. Caching the URL would shorten all four
handshake legs plus every subsequent tool call. Caching the `tools/list` body would shorten
one leg but is the leg carrying the manager's full catalog. The two have different
invalidation triggers (see 4) and different sensitivity: the URL is explicitly marked
SENSITIVE and "never store"; the tool catalog is not so marked.

**2. Where a cache lives — in-process or shared.**
The server is written to be replica-agnostic (invariant 6). An in-process `Map` would be
per-Render-instance, so hit rate depends on instance count, which is not declared anywhere
in this repo (no `render.yaml`; see Open Questions). A shared store would be a new external
dependency for this path. The codebase currently has no cross-request cache of either kind
(invariant 7).

**3. Whether the per-request roster read stays.**
It is currently what makes deactivation instant server-side (invariant 1). A design that
caches the roster row alongside the URL would fold that read into the cache and change the
revocation timing; a design that caches only the URL and keeps the roster read would retain
it at the cost of one DB round trip per request.

**4. Invalidation triggers that exist in the code today.**
Each of these changes what a cached entry should contain:
- `teardownPersonSession` NULLs `composio_session_id` (deactivation, tier change)
- tier demotion, which relies on that NULL to re-mint (invariant 5)
- `isInactiveState` flipping to `offboarding`/`offboarded`
- `unpair` ([pairing.ts:290-303](../../../src/composio/pairing.ts#L290-L303)) clearing
  connected-account ids and returning the row to `invited`
- a manager pairing a *new* connector via `manageConnections`, which changes what
  Composio's catalog returns for an unchanged session id

**5. Cache key composition.**
The relay's security property is that a badge reaches only its own person's session
(invariant 3). The identity available at that point is `{ tenantId, technicianRef }` from
the verified HMAC header, and the roster row additionally carries `composio_session_id` and
`tier`. Which of these compose the key determines whether a stale or mis-scoped entry could
serve one person's session URL to another.

## Open Questions

1. **What does `sessions.use` actually cost in production?** The ~0.6s per relayed request
   is inferred from gaps between consecutive requests in the sandbox network log, not from
   instrumentation inside the relay. No timing is recorded around
   [relayHandler.ts:175](../../../src/composio/relayHandler.ts#L175) today. Splitting ① from
   ② from ③ requires either instrumentation or a controlled probe.

2. **Is the real Composio `mcp.url` stable for a given session id?**
   `sessions.test.ts:188` expects `https://mcp.composio.example/trs_new1` — a URL that
   embeds the session id — but that is our own stub, not evidence about the live service.
   Composio's docs say sessions do not expire; they do not state whether the returned URL is
   deterministic, rotated, or signed with an expiry. This determines whether the URL is
   cacheable at all, and for how long.

3. **How many Render instances serve this?** Not declared in the repo — there is no
   `render.yaml`, so the service topology is dashboard-configured. This decides the hit rate
   of any in-process cache.

4. **Does a manager pairing a new connector change `tools/list` output for an existing
   session id?** `manageConnections: true` lets managers self-serve new connectors. Whether
   Composio's catalog for an unchanged session reflects that immediately, and by what
   mechanism a cache would learn of it, is not determinable from this repo.

5. **Does the "never store" custody rule in
   [sessions.ts:116-118](../../../src/composio/sessions.ts#L116-L118) extend to in-memory
   caching, or only to logs and persistence?** The comment says "print/inject via the
   control plane only, never log or store it," citing docs §7. The intended scope of
   *store* needs confirming against that document and its author.
