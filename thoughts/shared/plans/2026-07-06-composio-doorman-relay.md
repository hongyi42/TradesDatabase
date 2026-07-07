---
date: 2026-07-06
task: "Composio doorman relay — badge-authenticated sandbox access to each person's Composio session, master key stays on Render"
research: thoughts/shared/research/2026-07-06-composio-doorman-relay.md
status: draft
---

## Overview

§0b of the box setup guide is blocked: a person's Composio session MCP URL answers 401 without an
API key, and the only key the SDK supplies is the master project key — which must never enter a
sandbox. This plan builds the agreed relay: the sandbox reuses its existing badge to reach the
doorman; the doorman forwards `/composio/*` to a new route on the Render spine service; Render
verifies the same signed identity it already trusts, looks up that person's
`composio_session_id`, and forwards ONLY to that session, attaching the Composio key server-side.
Zero new sandbox secrets; per-person pinning is the security boundary. Builds BEFORE Feature A
(user decision 2026-07-06).

## Decisions

- **Doorman routing: allowlisted prefix map** (user, 2026-07-06) — only `/composio` +
  `/composio/*` pass the sandbox's path through to Render; every other path forwards to the
  configured upstream path exactly as today. Rejected: blind passthrough (exposes all Render
  routes to badge-holders), second doorman instance (permanent extra box state).
- **Credential on the Render→Composio leg: try a scoped key, fall back to master** (user,
  2026-07-06) — Phase 2 mints a scoped project API key (Sessions area) and probes whether the
  session MCP endpoint accepts it; the relay reads `COMPOSIO_RELAY_API_KEY ?? COMPOSIO_API_KEY`,
  so the swap is an env var either way. Scoped keys have NO per-user isolation
  (live docs 2026-07-06) — pinning stays our boundary regardless.
- **L1 audit: sweeper only for v1** (user, 2026-07-06) — the relay is a dumb pipe; the existing
  15-min log-ingestion sweep remains the only audit writer (it reads Composio's own log — ground
  truth — and covers relay crashes/bypasses/bugs). Instant relay-side capture is a possible later
  project, rejected for v1 (two-writer dedup risk in undeletable L1).
- **Tier access: both tiers** (user, 2026-07-06) — technicians reach their pinned read/draft
  session; Composio's execution enforcement (code 4310) shapes it, send stays spine-only.
- **Route prefix `/composio/` on Render, placed AFTER `allowed()` and BEFORE the MCP fallthrough**
  (mine) — the MCP handler swallows every unknown path, so ordering is load-bearing.
- **Connected-account argument guard ships unconditionally** (mine) — the relay rejects any
  JSON body containing a connected-account key (recursive scan) with 400, regardless of the
  Phase 2 probe outcome. Cheap, fail-closed defense-in-depth; the probe decides whether MORE is
  needed, not whether this is.
- **Session URL fetched per request via `getSessionMcpUrl`** (mine) — one extra Composio call per
  tool call, but always fresh (reactivation mints a new session id + URL). Caching is a recorded
  follow-up once Phase 2 observes URL stability.
- **Missing session → mint-on-demand** (mine) — an active row with no `composio_session_id` gets
  `ensurePersonSession` (idempotent, already exists; web service already holds
  `COMPOSIO_API_KEY`); if it skips (inactive / key unset), respond 503 "session not ready".
- **Relay handler is a new module with injectable deps** (mine) — `httpServer.test.ts` runs the
  real server against the local stack, so Composio-touching logic must be stubbed at the handler
  level (`RelayDeps`, same seam pattern as `SessionDeps`/`ServerDeps`).

## Plain-language walkthrough

**Phase 1 — the relay route on the server.** The Render service (our central server) gets a new
door: requests arriving at `/composio/` are checked for the doorman's signed identity stamp, the
person is looked up in the roster, and the request is passed on to *that person's* Composio
session — the server adds the API key itself. The sandbox never holds the key; it can't pick
whose session it lands on. A guard also rejects any request that tries to name a specific
connected account (someone else's mailbox) in its arguments.

**Phase 2 — proving assumptions against live Composio.** Before deploying, three live probes:
(1) can a request *through* a session act on another person's connected account (if yes, the
Phase 1 guard is load-bearing, and we check nothing deeper is needed); (2) does the session
endpoint accept a new blast-radius-limited "scoped" key instead of the master key; (3) do session
URLs stay stable over time (informs later caching). Results are recorded in the research doc.

**Phase 3 — teaching the doorman and deploying.** The doorman on trades-box-1 learns one new
rule: paths starting with `/composio` keep their path when forwarded; everything else behaves
exactly as today. Then the code deploys (Render + box) and a host-side check proves the full
chain: badge in → person's Composio tools out.

**Phase 4 — wiring a sandbox and closing the loop.** The manager's sandbox gets a second tool
connection pointing at the doorman's `/composio/` path, using the same badge it already holds.
The setup guide's blocked §0b section is rewritten to describe the relay, and a real Telegram
conversation proves a manager can use a Composio tool end-to-end.

```
sandbox agent ──badge──► doorman ──/composio/* + signed identity──► Render relay route
                            │                                          │ roster lookup:
                            └─every other path──► Render spine MCP     │ THAT person's session
                                                                       ▼
                                                        Composio session MCP (x-api-key
                                                        added server-side; tier enforced
                                                        by Composio at execution)
```

## Secrets & env preflight

- **Phase 1:** none new — local stack + stubs only (`.env.test`, `already required`).
  `COMPOSIO_API_KEY` deliberately UNSET in tests (the 503 path depends on it).
- **Phase 2:** `COMPOSIO_API_KEY` in `.env` (`already required`); NEW `COMPOSIO_RELAY_API_KEY` —
  user mints a scoped project API key in the Composio dashboard (Settings → API keys → scoped:
  Sessions read+write, Tool execution write) and adds it to `.env` for the probe.
- **Phase 3:** Render dashboard access (set `COMPOSIO_RELAY_API_KEY` on the web service);
  `ssh tradesbox`. **⚠ DEPLOY GATE (pre-existing, memory 2026-07-06): the retraction migration
  (`20260706090000_retraction_rows.sql`) must be applied to the pilot DB BEFORE the pilot Render
  service redeploys from main — landing this plan's code on main triggers that redeploy.**
- **Phase 4:** `ssh tradesbox`; a Telegram phone (manager chat); `supabase-test` MCP for
  READ-ONLY pilot read-backs.

## Phase 1: Render relay route

### What this phase does
Adds the relay handler (identity → roster → session → guarded proxy) and routes `/composio/*` to
it in `httpServer.ts`, fully covered by local tests. Codebase stays working: the route is
additive; nothing else changes.

### Changes required

**`src/composio/relayHandler.ts`** (new)
```ts
export interface RelayDeps {
  getTech?: typeof getTechnician;
  ensureSession?: typeof ensurePersonSession;
  getMcpUrl?: typeof getSessionMcpUrl;
  forward?: (url: string, method: string, headers: Record<string, string>,
             body: Buffer, res: ServerResponse) => Promise<void>;
}
export async function handleComposioRelay(req, res, rawBody: string, deps: RelayDeps = {})
```
1. `resolveIdentityFromHeaders(req.headers)` — throw → caller's bare 401. **The bare 401 is
   reserved for identity failures**: every later step catches its own errors and answers
   502/503 with a distinct JSON body, so a Composio-side fault is never mistaken for a badge/HMAC
   problem (review finding 7).
2. `getTech(tenantId, technicianRef)`: null → 403 `no roster row`; `isInactiveState(state)` →
   403 (deactivation cuts access instantly — mirrors `dispatch`, `src/mcp/server.ts:469`).
3. Session id: `tech.composio_session_id`. If null: **gate on `COMPOSIO_API_KEY` first** — unset
   → 503 `{"error":"session not ready"}` WITHOUT calling `ensureSession` (the key-unset skip
   lives in `lifecycle.ts:125-127`, NOT inside `ensurePersonSession` — calling it keyless throws
   from `new Composio()`; review finding 2). Key present → `ensureSession(tech)`:
   `created`/`exists` → use `result.sessionId`; `skipped` or throw → 503.
4. Connected-account guard: if `rawBody` non-empty, `JSON.parse` (unparseable → 400); recursive
   key scan case-insensitively matching `/connected_?account/i` anywhere in object keys → 400
   naming the offending key. Empty body (SSE GET) skips the guard. *Phase 2 probe 6 may narrow
   this to an allowlist + own-account pin check if manager meta-tools legitimately carry such
   keys (review finding 6).*
5. `const url = await getMcpUrl({ ...tech, composio_session_id: sessionId })` — the SPREAD is
   load-bearing: after mint-on-demand the original row still has a null id and `getSessionMcpUrl`
   throws on it (review finding 1). Throw here (stale/deleted session, network) → 502, not 401.
6. Build the outbound header set IN THE HANDLER (so stubs can assert it — review finding 3):
   `content-type`, `accept` (echo or default `application/json, text/event-stream`),
   `content-length`, `x-api-key: process.env.COMPOSIO_RELAY_API_KEY ?? COMPOSIO_API_KEY`, and
   **whitelist-forwarded `mcp-session-id` + `mcp-protocol-version` from the incoming request**
   (a stateful streamable-HTTP server rejects post-initialize calls without them — review
   finding 4; Phase 2 probe 5 confirms whether Composio's endpoint is stateful). Never forward
   the identity headers. Pass to `forward(url, req.method, headers, Buffer.from(rawBody), res)`;
   the default `forward` picks `node:http`/`node:https` by URL protocol (testable against a
   local listener), pipes the response INCLUDING response headers (`writeHead(status,
   upRes.headers)` — the return path for `Mcp-Session-Id`), upstream error → 502.

**`src/mcp/httpServer.ts`**
- In `handle()` after the `allowed()` check (line 151) and BEFORE `readBody` (line 158): if
  `isRelayPath(req.url)` → `await handleComposioRelay(req, res, await readRawBody(req))` and
  return. `isRelayPath` (exported from relayHandler.ts): `url === '/composio' ||
  url.startsWith('/composio/') || url.startsWith('/composio?')` — the query-string form must not
  silently fall through to the spine MCP handler (review finding 9).

**`src/composio/relayHandler.test.ts`** (new) — stub-deps unit tests (headers now assertable on
the stub `forward` per the seam above): unknown ref → 403; inactive → 403; no session + key
unset → 503 with `ensureSession` NOT called; no session + key set → `ensureSession` called and
its `sessionId` reaches `getMcpUrl` on the spread copy; guard rejects nested
`connectedAccountId`/`connected_account_id` (incl. inside arrays) → 400 and `forward` NOT called;
clean POST forwards with `x-api-key` set, identity headers absent, and incoming
`mcp-session-id` whitelist-forwarded; env fallback order (`COMPOSIO_RELAY_API_KEY` wins);
`getMcpUrl` throw → 502 (not 401); `isRelayPath` matches `/composio`, `/composio/x`,
`/composio?x` and rejects `/composiox`.

**`src/mcp/httpServer.test.ts`** — routing-level (real server, local stack, no Composio):
`/composio/` without identity headers → 401; with valid signed headers for an ACTIVE roster row
lacking a session (key unset in tests) → 503; an unknown path (`/nope`) still reaches the MCP
handler (regression: route ordering). NOTE: these tests must set `GATEWAY_IDENTITY_SECRET` via
`process.env` in `beforeAll` — it is not in `.env.test.example`; follow `identity.test.ts`'s
pattern (review finding 2).

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass (suite pinned local by testEnvGuard) —
      2026-07-06: 32 files / 249 tests green
- [x] new `relayHandler.test.ts` + `httpServer.test.ts` cases above pass (13 + 3 cases)

### Live verification (agent-executable)
- Prerequisites: local stack only.
- [ ] none beyond the integration tests (they span HTTP → DB already).

### Manual verification
- [ ] none — continue to Phase 2.

## Phase 2: Live Composio probes (assumption gate)

### What this phase does
Runs the research doc's open-question probes against the live Composio project BEFORE any deploy,
and records results in the research doc. No repo behavior changes except possible guard
hardening.

### Changes required

**Probe script (scratchpad, not committed)** using `.env`'s `COMPOSIO_API_KEY` + the two existing
pilot sessions (manager + technician; read back via `technicians.composio_session_id`,
`supabase-test` SELECT only):
1. **Cross-account injection (named research item #2):** through the technician session's MCP
   endpoint (master key header), issue a `tools/call` for a pinned tool (`GMAIL_GET_PROFILE`)
   whose arguments name the MANAGER's `composio_connected_account_id`. Outcome A (Composio pins
   to the session's account / rejects) → guard is defense-in-depth, done. Outcome B (it acts on
   the named account) → the Phase 1 guard is load-bearing: extend `relayHandler.test.ts` with the
   exact live-observed argument shape, and record in `docs/nemoclaw-tech-agent.md` §7 that the
   relay guard is the enforcement point.
2. **Scoped-key acceptance:** repeat a benign session MCP request with `x-api-key` =
   `COMPOSIO_RELAY_API_KEY`. Accepted → keep; 401 → relay stays on the master key; record either
   way (+ follow-up note if rejected).
3. **Session URL stability:** two `getSessionMcpUrl` calls ≥10 min apart; identical → caching is
   a viable follow-up; different → per-request lookup is mandatory (record).
4. **SSE shape (named research item #3, first half):** observe whether session MCP responses to
   `tools/list`/`tools/call` are `text/event-stream` or plain JSON; record for Phase 3's E2E.
5. **Statefulness (review finding 4):** does the endpoint return `Mcp-Session-Id` on initialize
   and REQUIRE it on subsequent requests? (If yes, the whitelist-forwarding of that header on
   both legs — already specced — is load-bearing; a single-request curl in Phase 3 would pass
   while a real agent chain fails. Design the Phase 3 curl check as initialize THEN tools/list.)
6. **Manager meta-tool false positives (review finding 6):** `tools/list` the MANAGER session and
   inspect which meta-tools (esp. `COMPOSIO_MANAGE_CONNECTIONS`) take connected-account-shaped
   arguments. If any legitimately do, the Phase 1 blanket guard would 400 a sold manager feature
   (self-serve pairing) — narrow it to: those specific tool names allowed IF the argument value
   equals the caller's own `composio_connected_account_id`; everything else still rejected.

**`thoughts/shared/research/2026-07-06-composio-doorman-relay.md`** — record all four results
with dates (the Feature-A pattern: the research doc carries the experiment record).

### Automated verification
- [ ] `npm test` still green if the guard/tests changed; otherwise no code gates.

### Live verification (agent-executable)
- Prerequisites: `.env` with `COMPOSIO_API_KEY` + `COMPOSIO_RELAY_API_KEY`; `supabase-test` MCP
  (read-only). Missing any → stop and name it.
- [x] Probe 1 (cross-account) → OUTCOME A: Composio pins account to the session, ignores the
      forged `connectedAccountId`; Jane's email did not leak. Guard is defense-in-depth. (2026-07-06)
- [x] Probes 2–6 recorded in the research doc "Probe results" section: scoped key accepted (2),
      URL immediate-identical (3), responses are SSE (4), endpoint stateless (5), no manager
      meta-tool takes a connected-account arg (6). (2026-07-06)

### Manual verification
- [ ] User mints the scoped key (dashboard) — the one step only they can do.

---
*Pause after this phase — Outcome B on probe 1 re-scopes the guard, and the user should see the
probe results before anything deploys.*

## Phase 3: Doorman prefix map + deploy

### What this phase does
Teaches the doorman the `/composio` prefix, deploys doorman + Render, and proves the full chain
host-side. The deploy gate (retraction migration) is cleared first.

### Changes required

**`Box_Setup_Stuff/doorman.mjs`** — replace the fixed `path:` (line 43) with:
```js
const RELAY_PREFIX = '/composio';
const u = req.url || '';
const relayed = u === RELAY_PREFIX || u.startsWith(RELAY_PREFIX + '/') || u.startsWith(RELAY_PREFIX + '?');
// in the request options:
path: relayed ? req.url : up.pathname + up.search,
```
(same three-form match as Render's `isRelayPath` — review finding 9). On the relayed branch,
additionally whitelist-forward the incoming `mcp-session-id` and `mcp-protocol-version` headers
into the fresh header set (review finding 4); the response side already passes headers through
(`writeHead(status, upRes.headers)` + pipe). Everything else (badge check, identity mint)
unchanged. Update the setup guide's inline copy of doorman.mjs (§3c) — byte-consistent.

**Deploy sequence (operator-run, in order):**
1. Apply `20260706090000_retraction_rows.sql` to the pilot DB + run the deferred manager
   retraction of Maria's $1,280 row (the pre-existing deploy gate — its own verification).
2. Set `COMPOSIO_RELAY_API_KEY` on the Render web service (if probe 2 passed); merge → Render
   deploys.
3. Box: `sudo cp doorman.mjs /opt/doorman/ && sudo systemctl restart doorman` (badges.json
   untouched — ownership rules from the runbook apply).

### Automated verification
- [x] `npm run typecheck && npm run lint && npm test && npm run build` before the PR — 2026-07-06:
      all green (249 tests); `node --check doorman.mjs` OK; `isRelayed` asserted against 9 path
      cases (matches Render's `isRelayPath`, excludes `/composiox` + all reserved routes)

### Live verification (agent-executable)
- Prerequisites: `ssh tradesbox`; a minted badge available per the §3f procedure (never pasted
  into chat).
- [x] Doorman deployed to trades-box-1 (2026-07-07 UTC): old version backed up
      `/opt/doorman/doorman.mjs.bak-prerelay`, new installed (`node --check` OK, `RELAY_PREFIX`
      present), `systemctl restart` → active, log shows `doorman 172.18.0.1:3001 -> …onrender.com/`.
- [x] Bogus badge on `/composio/` → **403** at the doorman (never reaches Render); no badge →
      **401**; bogus badge on `/` (spine) → **403** — fail-closed proven both branches. Render
      pre-warm reachable.
- [→] **Positive round-trip (spine regression + `/composio` initialize+tools/list) DEFERRED to
      Phase 4's agent E2E.** `pending-badges.jsonl` is empty (all badges installed into
      sandboxes), and minting a throwaway badge would churn the pilot roster (the 2026-07-03
      incident surface). The plaintext-free way to present a valid badge is a real agent turn —
      the manager sandbox does exactly that once wired in Phase 4, which also surfaces the Render
      relay-route log hit. Triaged per `verifying-behavior` (avoid handling badge plaintext).

### Manual verification
- [ ] none — the Telegram-visible behavior is Phase 4's.

## Phase 4: Sandbox wiring + docs + E2E

### What this phase does
Registers the relay as each sandbox's second MCP server (same badge placeholder), extends the
bake-in so it survives rebuilds, rewrites the blocked docs, and closes with a real Telegram E2E.

### Changes required

**Sandbox config (live, §5c pattern)** — add beside `trades-spine` in `mcp.servers`:
`{"transport":"streamable-http","url":"http://host.openshell.internal:3001/composio/",
"headers":{"Authorization":"Bearer openshell:resolve:env:TRADES_SPINE_BADGE"}}`. Same host:port →
NO new egress policy. Apply to the manager sandbox first, then the technician sandbox.

**`Box_Setup_Stuff/apply-bakein.py`** — add the `composio` server block as its OWN edit with its
OWN idempotency sentinel (`"NEMOCLAW_COMPOSIO_RELAY_URL" in c`), NOT an extension of edit 2:
edit 2's sentinel (`"NEMOCLAW_TRADES_SPINE_ENABLED" in c`, lines 143/156) already matches on
trades-box-1's baked source, so an extended edit 2 would silently no-op on exactly the live box
(review finding 5). Block: gated on `NEMOCLAW_TRADES_SPINE_ENABLED`, URL from
`NEMOCLAW_COMPOSIO_RELAY_URL` default `http://host.openshell.internal:3001/composio/`. Also
extend Dockerfile edit 4 with `ARG/ENV NEMOCLAW_COMPOSIO_RELAY_URL` so an operator override
actually reaches the build-time generator (the default works without it, but a set-and-ignored
env var is a trap).

**Docs (same change set — Box_Setup_Stuff sync rule):**
- `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` §0b — rewrite: BLOCKED notice → the relay is
  the shipped path; delete the secretRef wiring steps; keep the manager instruction block +
  session-lifecycle gotchas (minus the re-provision step, which the relay obsoletes).
- `Box_Setup_Stuff/doorman-architecture-memory.md` line 244 section — second MCP entry now points
  at the doorman relay; zero sandbox secrets.
- `docs/nemoclaw-tech-agent.md` §7 "Secret custody + gateway wiring" — mcp.url no longer
  distributed at all; relay route + key custody described; probe-1 outcome noted.
- `docs/control-plane.md` — env contract gains `COMPOSIO_RELAY_API_KEY` (web, optional).
- `docs/doorman-runbook.md` — lines 92-94 ("the server ignores the request path entirely") and
  the one-upstream wording become false once `/composio*` routes differently on both hops —
  update both statements (review finding 8).
- `scripts/provision-session.mjs` — header + printout: diagnostics-only now (review finding 2 —
  the body's secretRef snippet was replaced with a relay explanation so it no longer contradicts
  the header).
- `docs/nemoclaw-tech-agent.md` §5 bullet (line 191) — the "mcp.url delivery is operator-run"
  note repointed at the relay (review finding 3 — it contradicted the §7 rewrite).

### Automated verification
- [x] `npm run typecheck && npm run lint && npm test && npm run build` — 2026-07-06: all green
      (249 tests); `apply-bakein.py` py_compile OK + simulated against an already-baked (edits
      2/4 present) tree AND a decoy-early-`return config` tree → edits 5/6 land beside
      trades-spine, idempotent on rerun (review findings 1 + 5 covered).

### Live verification (agent-executable)
- Prerequisites: `ssh tradesbox`; `supabase-test` MCP (read-only); OCSF log access on the box.
- [x] Both sandboxes wired (2026-07-07 UTC): `composio` MCP entry added to s2 (manager-sam) and
      s1 (tech-jane) `/sandbox/.openclaw/openclaw.json` beside `trades-spine` (same badge
      placeholder, zero new secrets); backups at `openclaw.json.bak-prerelay`. Agents restarted
      via `nemoclaw-agent-sN.service` (up in ~5s each); s2 log shows `[reload] config hot reload
      applied (mcp.servers.composio)` — clean, no MCP load error.
- [→] Per-tier surface + the L1 audit-row read-back are confirmed by the Telegram E2E below (the
      composio MCP connects lazily on the first agent turn, so the credentialed sandbox→doorman
      →Render→Composio round-trip is proven there rather than by a startup handshake).

### Manual verification
- [ ] Telegram E2E: manager asks their agent to read a real spreadsheet/inbox item via Composio;
      the reply contains real data; the confirmation UX follows the one-confirmation rule.

---
*Pause after this phase — manual list non-empty (pilot-facing E2E).*

## File footprint

- N `src/composio/relayHandler.ts`, N `src/composio/relayHandler.test.ts`
- M `src/mcp/httpServer.ts`, `src/mcp/httpServer.test.ts`
- M `Box_Setup_Stuff/doorman.mjs`, `Box_Setup_Stuff/apply-bakein.py`
- M `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`, `Box_Setup_Stuff/doorman-architecture-memory.md`
- M `docs/control-plane.md`, `docs/nemoclaw-tech-agent.md`, `docs/doorman-runbook.md`
- M `scripts/provision-session.mjs` (comment only)
- M `thoughts/shared/research/2026-07-06-composio-doorman-relay.md` (probe results)
- N `thoughts/shared/plans/2026-07-06-composio-doorman-relay.md` (this plan)

Feature-A intersection (stacked after this plan): `src/mcp/httpServer.test.ts`,
`doorman-nemoclaw-setup-guide.md`, `doorman-architecture-memory.md`, `docs/control-plane.md`,
`docs/nemoclaw-tech-agent.md` — Feature A re-locates its doc anchors after this lands (already
noted in its plan).
