---
date: 2026-07-04
task: "Feature B — Outbound Composio actions via NemoClaw: per-person Composio SESSIONS (tiered), spine send_email for technicians, and a log-ingestion audit job into L1"
research: thoughts/shared/research/2026-07-04-feature-B-outbound-composio-actions.md
status: draft
supersedes: thoughts/shared/plans/2026-07-04-feature-B-outbound-composio-actions.md
---

## Overview

Give NemoClaw agents an outbound path with the architecture the user decided on 2026-07-04:
each person gets their own **Composio session** (Tool Router GA) whose tool restrictions are
**execution-enforced** (live-verified today: HTTP 400, code `4310`, slug
`ToolRouterV2_ToolNotInEnabledList` — docs wrongly say 403; match on code/slug). Managers get the
full catalog + self-serve pairing; technicians get a pinned read/draft list with send structurally
impossible. Technician **send** goes through ONE spine MCP tool (`send_email`) with a persisted
two-step confirm and synchronous L1 capture. Manager actions are audited asynchronously by a new
**ingestion job** that pulls Composio's server-side tool-execution logs into L1. This supersedes
the spine-proxied-everything draft plan (no spine `draft_email` tool; the Tool Router shape won).

## Decisions

All starred items are **user decisions (2026-07-04, fixed — do not re-litigate)**:
- ★ **Mechanism: per-person Composio sessions** — `composio.sessions.create(userId, {...})`
  (@composio/core 0.13.1 has `sessions.create/use/delete`; verified in installed typings), keyed by
  our composite `"<tenant>:<ref>"` user id. Restrictions are execution-enforced (live probe today).
- ★ **Manager tier: entire catalog, no toolkit restriction, `manageConnections` enabled** (self-serve
  pairing via the connection-management meta-tool). NO structural block on destructive tools —
  safety = disclosure ("the AI can make errors") + confirmation behavior context-engineered into the
  manager agent's instructions (NemoClaw manifest / Box_Setup_Stuff). Deliberate, accepted risk.
- ★ **Technician tier: curated pinned list**, starter (product-configurable): `GMAIL_FETCH_EMAILS`,
  `GMAIL_CREATE_EMAIL_DRAFT`, `GMAIL_GET_PROFILE` — slugs re-verified live in Phase 5 (May-2026
  catalog consolidation renamed tools; stale slug enables nothing). **`GMAIL_SEND_EMAIL` is NEVER
  in a technician session** (enforced by Composio — verified). Use the `DIRECT_TOOLS` preset (fixed
  list; disables search/multi-execute/manage-connections/sandbox by default — SDK typings). Phase 5
  probes that a technician session cannot initiate out-of-scope connections; if it can,
  `manageConnections:{enable:false}` is added explicitly.
- ★ **Technician send = spine `send_email`** with the persisted two-step confirm (stage → confirmId
  → consume-token-then-send, at-most-once) + synchronous L1 capture (`outbound_email`) — the old
  plan's Phases 1+3 carried over. **No spine `draft_email` tool** — technicians draft via session.
- ★ **Manager sends: Composio-direct via session; captured by the ingestion job**, not synchronously.
- ★ **Ingestion job**: pull `POST /api/v3.1/logs/tool_execution` (endpoint verified in the live
  OpenAPI, https://backend.composio.dev/api/v3.1/openapi.json — filters incl. `user_id`/`tool_slug`/
  `status`, `time_range` epoch-ms, cursor paging; list items `{id, timestamp, type, status,
  metadata}`, detail adds untyped `data`/`context`/`source` — **payload key names + retention window
  need live verification, Phase 5**). Email sends → `outbound_email`; other STATE-CHANGING
  executions → new enum value **`agent_action`** (migration). Skip pure reads; **when unsure,
  CAPTURE** (a wrongly-captured read is noise; a skipped payment is a lost record —
  `readOnlyHint`/`destructiveHint` tag coverage unverified). Per-toolkit **redaction** before
  writing (L1 undeletable). ★ **Capture-all: NO work/personal classifier on outbound** — recorded
  CLAUDE.md exception carries over from the old plan.
- ★ **Sensitivity**: manager-only captures get a marker; technician-tier spine reads filter them out.
  **Mechanism chosen: a nullable `sensitivity` text column** on `raw_captures` (not a metadata
  field) — a migration is needed for `agent_action` anyway, and a real column keeps the read-side
  filter explicit and indexable; filtering happens in `dispatch` post-fetch (in-memory), avoiding
  PostgREST's NULL-vs-`neq` filter trap entirely.
- ★ **L2 unchanged in v1** — ingestion is L1-only audit: direct `appendRawCapture`, never
  `recordFieldNote` (no extraction, no visits). Payments→L3 and agent memory are deferred.
- ★ **Session provisioning by the control plane**, mcp.url injected into the sandbox's gateway config
  beside `trades-spine`. **HARD RULE (tested): sessions are ALWAYS created with an explicit per-tier
  config, never bare** — a bare session defaults to the entire catalog AND `manageConnections:true`
  (SDK typings confirm the default). Secret custody: API key + mcp.urls only on control plane/host,
  never in sandboxes (docs §7).
- **Session lifecycle hooks (implementation detail):** created by a new lifecycle-sweep step for
  `active` rows missing a session id (self-healing, ≤15-min latency, one call site — mirrors the
  pairing sweep); deleted in `expireOffboarding`'s expired branch, after the CAS claim, alongside
  its `deleteComposioPairing` call (`offboarding.ts:126-136`) — **NOT inside `deleteComposioPairing`
  itself**, which `unpair` also calls for a still-rostered person returning to `invited` (their
  session must survive a wrong-mailbox re-pair). `sessions.delete` exists in the SDK; id kept on
  the row like `ca_*`/`ti_*`. During the grace period the disabled connected account already fails
  execution (`4302`), so no session-disable step is needed.
- **Ingestion idempotency: overlapping window + external-id dedup**, no cursor table — window =
  last 60 min each 15-min tick; email sends reuse `sent:<gmail message id>` (colliding with the
  spine's synchronous capture on the per-tenant unique index), everything else
  `composio-exec:<log id>`. The id collision alone is NOT sufficient (the spine capture falls back
  to `sent:confirm:<confirmId>` when the execute response has no parseable message id — L1 is
  undeletable, so a miss is permanent), so a **tier guard** backs it: send-slug logs whose composite
  ref resolves to a **technician-tier** roster row are skipped outright — technician sessions
  structurally cannot send (4310), so any technician-attributed send execution is by definition the
  spine's own `tools.execute`, already captured synchronously. Failed executions
  (`status:'failed'`) are skipped — nothing changed state.
- **Two-step confirm + tolerant response parsing + roster-state authorization** reused verbatim from
  the old plan: `state` is the authority (ids persist after offboarding), never trust model-supplied
  identity, `dangerouslySkipVersionCheck:true` mandatory, parse `data.response_data ?? data`.

## Plain-language walkthrough

**Phase 1** lays the foundations: a database migration (new capture channel `agent_action`, a
`sensitivity` column for manager-only rows, a `composio_session_id` column on the roster) and a
small module that can send a Gmail email via Composio *as one specific active person*.

**Phase 2** gives technicians a safe send button: a `send_email` tool on the spine (our one MCP
server). First call stages the email and returns a ticket; the agent shows the technician exactly
what will go out; only the second call with the ticket sends. Single-use ticket → a retry can never
double-send. Every send is recorded into L1 (append-only evidence).

**Phase 3** builds the per-person session layer: for every active person the control-plane
heartbeat creates a Composio session with their tier's config (manager = everything + self-serve
pairing; technician = pinned read/draft list, send impossible). An operator script prints each
person's session `mcp.url` for gateway registration next to `trades-spine`.

**Phase 4** builds the auditor: every 15 minutes the heartbeat pulls Composio's own execution logs
and appends state-changing actions into L1 — manager email sends as `outbound_email`, everything
else as `agent_action` with per-toolkit redaction. Manager-only rows get `sensitivity=
'manager_only'` and technician-facing read tools stop returning them.

**Phase 5** updates the docs of record (design doc §7, Box_Setup_Stuff — same-change sync rule,
CLAUDE.md exception) and runs the live probes: the 4310 enforcement check, the
connection-management probe, the logs-API payload/retention check, and the send E2E.

```
Manager agent ──MCP──> composio session (FULL catalog + manage-connections) ──> Gmail/Sheets/…
Technician agent ─MCP─> composio session (pinned: fetch/draft; send BLOCKED 4310)
                 └MCP─> trades-spine ── send_email (stage→confirm) ─> GMAIL_SEND_EMAIL
                                                       └─ L1 raw_captures (outbound_email, sync)
Render cron (15 min) ─> logs API v3.1 ─> classify state-changing ─> L1 (outbound_email/agent_action,
                                                                      redacted, sensitivity-marked)
```

## Secrets & env preflight

- **Phase 1–2:** none (tests stub the Composio client; local stack via `.env.test`).
- **Phase 3:** none for tests. Deploy note: docs/control-plane.md (Render setup §2) already lists
  `COMPOSIO_API_KEY` as required cron env, but the sessions sweep must not assume the deployed cron
  actually has it — the step is **gated on the var being set** (skips cleanly, like the sheet-sync
  skip), so a missing key can never turn the pilot heartbeat permanently red. Only `.env.example`'s
  stale "dev helper scripts only" comment is corrected.
- **Phase 4:** none for tests (log fetcher injectable).
- **Phase 5 (live):** `COMPOSIO_API_KEY` + `COMPOSIO_GMAIL_AUTH_CONFIG_ID` in `.env` (Composio
  dashboard; `already required` by pairing). **The live Composio project has ZERO connected accounts
  (verified 2026-07-04)** — every live check marked *(needs pairing)* has "pair one mailbox via the
  existing connect-link flow" as an explicit prerequisite; the session-restriction probes do NOT
  need one (the 4310 gate fires before connection resolution — live-verified today).

## File footprint

Created (N) / modified (M) — feeds the parallel-vs-stack comparison against feature A:
- `supabase/migrations/20260704120000_agent_action_sensitivity_sessions.sql` (N — 14-digit
  timestamp; the CLI's `<timestamp>_<name>.sql` pattern, matching the existing files)
- `src/db/database.types.ts` (M — regenerate from the LOCAL stack: `npx supabase gen types
  typescript --local`; the `gen:types` npm script is `--linked` = pilot, do not use it)
- `src/db/rawCaptures.ts` (M) · `src/db/technicians.ts` (M) · `src/db/reviewItems.ts` (M)
- `src/composio/pairing.ts` (M — export `compositeUserId`; add `sessions` to `PairingClient`)
- `src/composio/pairing.test.ts` (M — Phase 1: `sessions` stub on the typed client literal at :81)
- `src/composio/outbound.ts` (N) · `src/composio/outbound.test.ts` (N)
- `src/composio/sessions.ts` (N) · `src/composio/sessions.test.ts` (N)
- `src/composio/logIngest.ts` (N) · `src/composio/logIngest.test.ts` (N)
- `src/composio/offboarding.ts` (M) · `src/composio/offboarding.test.ts` (M — touched twice:
  Phase 1 `sessions` stub at :45, Phase 3 behavior tests)
- `src/mcp/server.ts` (M) · `src/mcp/server.test.ts` (M)
- `src/jobs/lifecycle.ts` (M) · `src/jobs/lifecycle.test.ts` (M)
- `scripts/provision-session.mjs` (N) · `.env.example` (M — COMPOSIO_API_KEY comment)
- `docs/nemoclaw-tech-agent.md` (M) · `docs/doorman-runbook.md` (M — tool counts :242,308,321,367)
- `docs/control-plane.md` (M — "what the job does" gains steps 4 sessions + 5 log-ingest; cron
  env notes)
- `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` (M) ·
  `Box_Setup_Stuff/doorman-architecture-memory.md` (M) ·
  `Box_Setup_Stuff/migration-runbook-lightsail.md` (M) ·
  `Box_Setup_Stuff/bootstrap-box.sh` (M — tool count in the verification comment at :423) ·
  `CLAUDE.md` (M)
- `thoughts/shared/plans/2026-07-04-feature-B-outbound-composio-sessions.md` (N — this plan) ·
  `thoughts/shared/plans/2026-07-04-feature-B-outbound-composio-actions.md` (M — superseded marker)

**Scope flag (plan.md 300-line rule):** this plan exceeds 300 lines because the user fixed a
four-component scope (sessions + spine send + ingestion + doc sync) as ONE feature; splitting
would orphan the cross-component decisions. Flagged rather than split — the reviewer may split at
the Phase 2/3 boundary if preferred (Phases 1–2 and 3–5 are separable).

## Phase 1: Migration + outbound send seam

### What this phase does
One migration for all three schema needs, regenerated types, and the module that performs a
server-side Composio send for one active, paired person.

### Changes required

**`supabase/migrations/20260704120000_agent_action_sensitivity_sessions.sql`** (new; the filename
MUST match the CLI's `<14-digit-timestamp>_<name>.sql` pattern or `db reset` silently skips it;
local `npx supabase db reset` applies it — never `db push` to hosted from this work)
```sql
alter type capture_channel add value if not exists 'agent_action';
alter table raw_captures add column if not exists sensitivity text;  -- v1 value: 'manager_only'
alter table technicians  add column if not exists composio_session_id text;
```
Regenerate `src/db/database.types.ts` from the local stack (see footprint note).

**`src/db/rawCaptures.ts`** — `AppendRawCaptureInput`: add `sensitivity?: string | null`; pass it in
the insert (`sensitivity: input.sensitivity ?? null`).

**`src/db/technicians.ts`** — `TechnicianPatch`: add `composio_session_id?: string | null`.

**`src/composio/pairing.ts`** — export `compositeUserId` (line 61); extend `PairingClient` with
`sessions: { create(userId, config): Promise<Record<string,unknown>>; use(id, opts?):
Promise<Record<string,unknown>>; delete(id): Promise<unknown> }` (structural, tolerant — same
style as the existing surface; kept REQUIRED so Phase 3 code needs no runtime guard).

**`src/composio/pairing.test.ts` + `src/composio/offboarding.test.ts`** — both declare typed
`PairingClient` stub literals (`pairing.test.ts:81`, `offboarding.test.ts:45`) that break
`typecheck` the moment `sessions` lands on the interface: add a minimal throwing `sessions` stub
to each IN THIS PHASE (behavior tests for sessions come later — Phase 3).

**`src/composio/outbound.ts`** (new)
- `requireOutboundCapable(tech: Technician | null)` — throws `'no roster row for this badge'` /
  `'not active'` (unless `state === 'active'`) / `'no paired mailbox'` (unless
  `composio_connected_account_id`).
- `sendGmailEmail(tech, { to, subject, body }, deps: { client?: PairingClient } = {})` →
  `client.tools.execute('GMAIL_SEND_EMAIL', { connectedAccountId, userId: compositeUserId(tech),
  arguments: { recipient_email: to, subject, body }, dangerouslySkipVersionCheck: true })`;
  `successful === false` → throw with Composio's error text; return `{ messageId, threadId }`
  parsed tolerantly (`response_data ?? data`; `id`/`messageId`/`message_id`, `threadId`/`thread_id`).

**`src/composio/outbound.test.ts`** (new — stub-client pattern from `pairing.test.ts`): correct slug
+ skip flag; ids come from the roster row never args; gate throws for null row / every non-active
state / active-unpaired; `successful:false` throws; both envelope nestings parse.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (local stack); new tests cover the above
      *(2026-07-04: 28 files / 171 tests green)*
- [x] `docker exec supabase_db_TradesDatabase psql -U postgres -c "\d raw_captures"` shows
      `sensitivity`; `… -c "\dT+ capture_channel"` lists `agent_action` (`\d` on the table cannot
      show enum values) *(2026-07-04: all three schema items confirmed)*

### Live verification — none (Phase 5). ### Manual verification — none.

---

## Phase 2: `send_email` spine tool (technician send path)

### What this phase does
The two-step-confirm send tool + synchronous L1 capture, exactly the superseded plan's design.
Tool counts: technician 7→8, manager 14→15.

### Changes required

**`src/db/reviewItems.ts`** — add `'pending_outbound_send'` to `ReviewKind` (line 10; plain string
column, no migration).

**`src/mcp/server.ts`**
- `ServerDeps`: add `sendEmail?: typeof liveSendGmailEmail` (import from `../composio/outbound.js`).
- Append `send_email` to `TOOLS` (line 158): schema `to`/`subject`/`body`/`confirmId` (all optional
  in-schema, validated in dispatch). Description: two-step; first call returns
  `{status:'needs_confirmation', confirmId}` — show exactly what will be sent, then call again with
  ONLY `confirmId`; the staged copy is what gets sent.
- Dispatch **stage** (no `confirmId`): `requireOutboundCapable(caller)` (reuse the caller row from
  line 299); require `to`/`subject`/`body`; supersede a differing open item
  (`resolveOpenReviewItemFor(…,'dismissed','superseded by a new send request')`), then
  `upsertOpenReviewItem({ tenantId, kind:'pending_outbound_send', subjectRef: caller.ref,
  detail:{ to, subject, body, stagedAt } })` → `{status:'needs_confirmation', confirmId: item.id}`.
- Dispatch **confirm**: `requireOutboundCapable(caller)` FIRST (a roster-less badge sending only
  `confirmId` must get the clean `'no roster row'` error, not a TypeError on `caller.ref`); then
  `getOpenReviewItem(confirmId, tenantId, { kind, subjectRef: caller.ref })`
  (forged/cross-person ids match nothing); >15-min `stagedAt` → dismiss + `'confirmation expired'`;
  **consume first** via `resolveReviewItem(...)` — null = lost race → `'already confirmed or
  cancelled'`; then `(deps.sendEmail ?? liveSendGmailEmail)(caller, detail)` — on throw report NOT
  sent, restage (at-most-once); on success advisory L1 capture:
  `appendRawCapture({ tenantId, channel:'outbound_email', technicianRef: caller.ref,
  rawText: formatEmailRawText({ from: caller.connected_email ?? caller.ref, subject, body }),
  externalId: messageId ? \`sent:${messageId}\` : \`sent:confirm:${confirmId}\`,
  metadata:{ to, subject, sentVia:'GMAIL_SEND_EMAIL', threadId } })` → `{status:'sent', …, captured}`.
- `resolve_review` (line 678): `pending_outbound_send` may be `dismissed` (cancel); `resolved`
  rejected with `'confirm it via send_email, or dismiss it to cancel'`.

**`src/mcp/server.test.ts`** — stage→confirm sends the STAGED payload, ignoring fresh args; forged/
other-person confirmId rejected; double-confirm → stub called exactly once; supersede-on-restage;
expiry; send-throw → no L1 row + clear error; success → `raw_captures` row (`outbound_email`,
`sent:<id>`, correct ref); capture failure still `status:'sent'`; resolve_review guard; tools/list
counts 8 technician / 15 manager.

**Docs (counts only — EVERY count site updates in this phase so the grep gate below can pass):**
`docs/doorman-runbook.md` (:242,308,321,367), `docs/nemoclaw-tech-agent.md` (:92 "7 of them, for a
14-tool manager surface" — the count only; the §7 architecture amendment stays Phase 5),
`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` (:20,24,269,413,694),
`doorman-architecture-memory.md` (:97,227, AND :237 "Manager badge — 14 (since 2026-07-02)"),
`migration-runbook-lightsail.md` (:114), `Box_Setup_Stuff/bootstrap-box.sh` (:423 "shows 7 tools
(14 if the ref is an active manager row)").

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test`; all new cases pass
      *(2026-07-04: 28 files / 172 tests green)*
- [x] `grep -rnE "7 tools|14-tool|14 tools|14 if|— 14 \(" docs Box_Setup_Stuff` shows no stale
      counts (the alternation covers all six files' phrasings above) *(2026-07-04: grep exit 1)*

### Live verification — Phase 5. ### Manual verification — none.

---

## Phase 3: Per-person sessions (control plane)

### What this phase does
The tiered session layer + provisioning sweep + operator mcp.url script.

### Changes required

**`src/composio/sessions.ts`** (new)
- `export function sessionConfigForTier(tier: TechnicianTier)`: **manager** → `{ manageConnections:
  true, mcp: true }` (explicit; intentionally NO toolkit/tool restriction = entire catalog);
  **technician** → `{ sessionPreset: 'direct_tools', toolkits: ['gmail'], tools: { gmail:
  TECHNICIAN_GMAIL_TOOLS }, manageConnections: false, mcp: true }` with
  `export const TECHNICIAN_GMAIL_TOOLS = ['GMAIL_FETCH_EMAILS','GMAIL_CREATE_EMAIL_DRAFT',
  'GMAIL_GET_PROFILE']` (product-configurable; slugs live-verified Phase 5). No code path may call
  `sessions.create` except through this module (hard rule).
- `ensurePersonSession(tech, deps)`: no-op unless `state === 'active' && !composio_session_id`;
  `client.sessions.create(compositeUserId(tech), sessionConfigForTier(tech.tier))`; persist the
  returned id via `updateTechnician(tech.id, { composio_session_id: id })` (tolerant id parse:
  `id`/`sessionId`/`session_id`). Returns `{ status: 'created'|'exists'|'skipped' }`.
- `getSessionMcpUrl(tech, deps)`: `sessions.use(id, { mcp: true })` → `mcp.url` (never logged/stored).

**`src/composio/sessions.test.ts`** (new): **the hard rule** — every `sessions.create` call carries
an explicit config object for BOTH tiers (a bare/undefined config fails the test);
`TECHNICIAN_GMAIL_TOOLS` never contains `GMAIL_SEND_EMAIL` and technician config always pins
`sessionPreset:'direct_tools'` + `manageConnections:false`; manager config sets
`manageConnections:true`; ensure is idempotent (existing id → no create call); non-active states
skipped; composite userId used.

**`src/composio/offboarding.ts`** — in `expireOffboarding`'s expired branch (after the CAS claim,
next to the `deleteComposioPairing` call, `:126-136`): `sessions.delete(composio_session_id)` with
the `isGoneError` 404-is-success idiom; keep the column value (audit, same as `ca_*`/`ti_*`). Do
NOT put this inside `deleteComposioPairing` — `unpair` reuses it for people who stay on the roster.
Update `offboarding.test.ts` (incl. "unpair never deletes the session").

**`src/jobs/lifecycle.ts`** — step 4 `sessions`: **skipped cleanly when `COMPOSIO_API_KEY` is
unset** (`{ skipped: 'COMPOSIO_API_KEY unset' }`, the sheet-sync pattern — otherwise a cron
deployed without the key fails every attempt, trips all-attempts-failed → `ok:false`, and the
pilot's 15-min heartbeat goes permanently red from this deploy); when set: sweep
`listTechniciansInStates(['active'])`, run `ensurePersonSession` per row; per-row failures counted,
all-attempts-failed → `ok:false` (same shape as the pairing step). Summary gains
`sessions: { checked, created, rowErrors } | { skipped } | { stepError }`. Update
`lifecycle.test.ts` (incl. the unset-key skip).

**`scripts/provision-session.mjs`** (new, dev/operator helper like `assign-host.mjs`): given
`tenant=<uuid> ref=<ref>`, prints the session `mcp.url` (via `getSessionMcpUrl`) + the gateway
registration snippet (secretRef, beside `trades-spine`) for the operator's one-time sandbox wiring.
Runs only with `.env` `COMPOSIO_API_KEY` (control-plane custody).

**`.env.example`** — update the `COMPOSIO_API_KEY` comment: also required by the Render cron
(session provisioning + log ingestion), still never in a sandbox.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test`; sessions + offboarding + lifecycle tests pass
      *(2026-07-04: 29 files / 190 tests green)*

### Live verification — Phase 5. ### Manual verification — none.

---

## Phase 4: Log-ingestion audit job + sensitivity filtering

### What this phase does
The 15-min sweep that turns Composio execution logs into L1 audit rows, and the technician-tier
read filter.

### Changes required

**`src/composio/logIngest.ts`** (new)
- `fetchExecutionLogs` (injectable): raw `fetch` `POST https://backend.composio.dev/api/v3.1/logs/
  tool_execution` (`x-api-key: COMPOSIO_API_KEY`), body `{ time_range: { from, to }, limit, cursor }`,
  follow `next_cursor`; per-item detail `GET …/logs/tool_execution/{id}` only for items that will be
  captured (payloads live in the detail's `data`). Exact payload keys are tolerant-parsed and
  live-verified (Phase 5).
- `runLogIngestion(nowIso, deps)`: window = last 60 min (overlap ≥4 ticks); for each `status:
  'success'` item: parse composite `user_id` (first-colon split, same rules as `webhook.ts:169-179`;
  non-composite/`default` → skip with a counter); classify: slug in `EMAIL_SEND_SLUGS`
  (`GMAIL_SEND_EMAIL`, `GMAIL_REPLY_TO_THREAD`) → `outbound_email`; slug matches
  `READ_SLUG_PATTERNS` (conservative prefixes `GMAIL_FETCH_`, `GMAIL_GET_`, `GMAIL_LIST_`,
  `GMAIL_SEARCH_`, plus meta-tools `COMPOSIO_*` except `COMPOSIO_MANAGE_CONNECTIONS`… — explicit
  exported lists, product-configurable) → skip; **everything else → capture as `agent_action`**
  (capture-when-unsure ★).
- Redaction (★, per-toolkit policy map): `gmail` sends → `formatEmailRawText` (subject/body/to are
  business correspondence); **default policy for any other toolkit → store tool slug, toolkit,
  timestamps, and argument KEY NAMES only — never argument/response VALUES** (values may carry
  legally-deletable data; L1 is undeletable). Adding value capture for a toolkit = a reviewed
  policy entry.
- **Technician-send guard (double-capture backstop):** BEFORE writing an `EMAIL_SEND_SLUGS` log,
  resolve the composite ref's roster row — if it is **technician-tier, SKIP** (technician sessions
  structurally cannot send, so a technician-attributed send execution is by definition the spine's
  own `tools.execute` from Phase 2, already captured synchronously). The `sent:<id>` external-id
  collision alone cannot guarantee dedup: Phase 2 falls back to `sent:confirm:<confirmId>` when the
  execute response has no parseable message id, which never collides with the ingestion side's ids —
  and L1 is undeletable, so that miss would be a permanent duplicate.
- Write: `appendRawCapture({ tenantId, channel, technicianRef: ref, rawText, externalId, metadata:
  { toolkit, toolSlug, logId, status }, sensitivity })` — dedup via existing per-tenant unique
  `external_id` (`isUniqueViolation` → skip): sends use `sent:<gmail message id>` (fallback
  `composio-exec:<logId>` if no message id), others `composio-exec:<logId>`.
  `sensitivity: 'manager_only'` when the actor's roster tier is `manager` OR the ref is unknown
  (safe default) and `channel === 'agent_action'`; `outbound_email` rows stay unmarked (business
  correspondence — see Assumptions).
- Summary `{ scanned, captured, skippedReads, deduped, rowErrors }`; no cursor table (Decisions).

**`src/jobs/lifecycle.ts`** — step 5 `logIngest`: skipped cleanly when `COMPOSIO_API_KEY` unset
(like the sheet-sync skip); failures → `ok:false`.

**`src/mcp/server.ts`** — sensitivity filter: in `dispatch`, `const canSeeSensitive = caller?.tier
=== 'manager' && caller.state === 'active'`; for `list_recent_captures` results and
`getCustomerContext(...).recentCaptures` (also the ctx fed to `brief_customer` /
`answer_customer_question`), drop rows with `sensitivity === 'manager_only'` when
`!canSeeSensitive` (in-memory post-filter).

**Tests** (`logIngest.test.ts` + `server.test.ts` + `lifecycle.test.ts`): manager send log →
`outbound_email` row with `sent:<id>` external id; pre-existing `sent:<id>` → deduped;
**technician-attributed send log → SKIPPED even when its message id is unparseable** (the
double-capture backstop); unknown slug →
captured `agent_action` with keys-only redaction (assert NO argument values in `raw_text`/
`metadata`); read slugs skipped; failed executions skipped; non-composite user_id skipped; manager
actor → `sensitivity='manager_only'`; unknown ref → captured + marked; technician-badge
`list_recent_captures`/`get_customer_context` omit marked rows, manager badge sees them; briefer
stub receives filtered ctx.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test`; all cases above pass
      *(2026-07-04: 30 files / 202 tests green)*

### Live verification — Phase 5. ### Manual verification — none.

---

## Phase 5: Docs of record + live verification

### What this phase does
Same-change doc sync (Box_Setup_Stuff rule) and every live probe, per `verifying-behavior` (fresh
verification subagent, cross-channel read-backs, evidence).

### Changes required
- **`docs/nemoclaw-tech-agent.md` §7** — dated amendment: sessions are the outbound architecture of
  record (per-person, per-tier configs, execution-enforced, 4310 match-on-code); technician send via
  spine `send_email`; ingestion-job audit; record Phase-5 findings with citations. (The §4/:92 tool
  COUNT was already updated in Phase 2 — this phase is the architecture prose only.)
- **`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` + `doorman-architecture-memory.md`** — gateway
  registration of the per-person session `mcp.url` beside `trades-spine` (secretRef, custody rule,
  `provision-session.mjs` flow); manager-agent instruction block: destructive-action confirmation
  behavior + "the AI can make errors" disclosure (★ context-engineered safety); update
  `migration-runbook-lightsail.md` counts.
- **`CLAUDE.md`** — second recorded exception under L1 append-only: outbound/agent-action captures
  are classifier-free by user decision (2026-07-04); disclosure obligation noted.
- **Old plan** — frontmatter `status: superseded` + pointer (already done alongside this plan).

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` (pre-PR gate)
      *(2026-07-04: all four green — 30 files / 202 tests)*

### Live verification (agent-executable — evidence required for each)
Prerequisites: `.env` `COMPOSIO_API_KEY` (+ `COMPOSIO_GMAIL_AUTH_CONFIG_ID` for paired checks);
`supabase-test` MCP for **SELECT-only** read-backs (pilot LIVE DB — never write/seed). *(needs
pairing)* items additionally require one mailbox paired via the connect-link flow first — the
project has ZERO connected accounts today.
- [x] **Session enforcement (no pairing needed):** create a technician session via
      `sessionConfigForTier`; execute `GMAIL_SEND_EMAIL` → expect HTTP 400, `code 4310` /
      `ToolRouterV2_ToolNotInEnabledList` (match code/slug, NOT status); pinned tool passes the
      gate (then `4302 NoActiveConnection` is acceptable proof). Read the session back
      (`sessions.use`) and confirm the restriction config stuck.
      *(2026-07-04 probe, session trs_e-hAakf0rj7g: 400/4310 verbatim; GET_PROFILE → 4302;
      read-back showed the three pinned slugs + manage_connections.enabled=false. Deleted.)*
- [x] **DIRECT_TOOLS surface + connection-management probe (no pairing needed):** MCP `tools/list`
      on the technician session shows ONLY the pinned tools (no `COMPOSIO_MANAGE_CONNECTIONS`);
      attempt a connection-initiation anyway — if anything can still mint a connect flow, add
      `manageConnections:{enable:false}` explicitly and re-verify (★ decision's contingency).
      Verify the three pinned slugs exist in the current catalog (stale-slug caveat).
      *(2026-07-04 probe: exactly 3 tools exposed; 5 adversarial connect routes all -32602;
      contingency NOT needed; all 3 slugs live, is_deprecated:false.)*
- [x] **Manager session:** full catalog reachable + connection-management meta-tool present;
      self-serve pairing link mints (stop before completing OAuth unless doing the pairing prereq).
      *(2026-07-04 probe, session trs_xNt5FaxpNW0P: 6 meta-tools incl. MANAGE_CONNECTIONS;
      Sheets/Drive reachable via search; pairing link minted + abandoned. Deleted.)*
- [x] **Logs API shape + retention:** run one benign execution *(needs pairing for a Gmail slug;
      otherwise any no-auth toolkit)*, pull it via v3.1 within the hour; record: exact
      `metadata`/`data` key names (tool slug, user_id, connected account, arguments/response
      presence), whether the DETAIL call is required for payloads, and the retention window (query
      with `time_range.from` pushed back until results stop) → fix `logIngest` parsers if needed +
      cite in docs §7.
      *(2026-07-04 probe: envelope key is `logs`; `metadata.tool` is an OBJECT {slug,...};
      detail data.request.payload / data.response.body; epoch-ms mandatory; 4310 rejections not
      logged; windows to 400 days accepted. TWO CRITICAL parser fixes applied to logIngest.ts
      (envelope key, tool.slug path) + toolkit/detail-shape fixes; tests rewritten to the real
      shapes with flat fallbacks kept; recorded in docs §7.)*
- [ ] **Send E2E *(needs pairing)*:** spine `send_email` stage→confirm → message arrives at a
      controlled recipient; `supabase-test` SELECT shows ONE `outbound_email` row (`sent:<id>`);
      after the next cron tick, STILL one row (ingestion dedup proven live).
- [ ] **Ingestion E2E *(needs pairing)*:** a manager-session action (e.g. a draft via full-catalog
      session) appears as an L1 row per policy; a technician badge's `list_recent_captures` omits a
      `manager_only` row, a manager badge sees it (read back both ways).

### Manual verification
- [ ] Confirmation/error wording (`needs_confirmation`, not-sent, disclosure text) reads sensibly in
      a real Telegram conversation.

---
*Pause after Phase 5 (manual check non-empty); Phases 1–4 continue on green automated gates.*

## Assumptions

Non-interactive run — recorded instead of asked:
- **Session creation trigger = the lifecycle sweep on `active` rows** (not inline in
  `resolve_review`): one call site, self-healing, ≤15-min latency is acceptable because sandbox
  gateway wiring is operator-time work anyway. Inline creation can be added later without redesign.
- **mcp.url delivery to the host is operator-run in v1** (`provision-session.mjs` + Box_Setup_Stuff
  instructions) — fits "operators appear at initial setup"; automated injection (e.g. via
  badge-pull) is future work and is called out in the docs, not built here.
- **Manager `outbound_email` rows are NOT sensitivity-marked** (business correspondence useful to
  technicians); only `agent_action` rows are. If the reviewer wants manager sends hidden too, it is
  a one-line change in `logIngest.ts`.
- **Failed executions are not captured** (no state changed). Revisit if partial-failure toolkits
  appear.
- **`GMAIL_REPLY_TO_THREAD` is treated as a send** (it sends immediately — research doc) and is
  excluded from the technician list.
- **Retention window unknown until Phase 5**; the 60-min ingestion window assumes the cron isn't
  down longer than retention — Phase 5 records the real number and the plan's window can widen.
- **No live docs page for the logs API was reachable** (docs 404); the live OpenAPI spec
  (https://backend.composio.dev/api/v3.1/openapi.json, fetched 2026-07-04) is the citation of
  record for the endpoint/filters/response envelope; payload key names stay flagged live-verify.
- **Adversarial plan review ran twice** — a self-review pass (caught: the `deleteComposioPairing`
  session-deletion hook that `unpair` would have triggered for still-rostered people; the stale
  cron-env note; `docs/control-plane.md` missing from the footprint) and the fresh-context review
  subagent, which verified all cited line numbers and found five blocking gaps, all applied:
  (1) the required `sessions` member breaks the typed stub literals in `pairing.test.ts:81` /
  `offboarding.test.ts:45` → both stubs now update in Phase 1; (2) the migration filename lacked a
  valid 14-digit timestamp (`db reset` would silently skip it); (3) three tool-count sites the
  Phase 2 gate missed or couldn't pass (`nemoclaw-tech-agent.md:92` deferred to Phase 5,
  `bootstrap-box.sh:423` absent, `doorman-architecture-memory.md:237` unmatched by the grep) → all
  counts now update in Phase 2 under a widened grep; (4) the sessions lifecycle step would turn the
  pilot heartbeat permanently red if the cron lacks `COMPOSIO_API_KEY` → gated skip; (5) the
  `sent:confirm:<confirmId>` fallback broke the ingestion dedup collision → technician-tier send
  logs are now skipped outright (double-capture backstop). Plus two minor fixes (`\dT+` for the
  enum check; `requireOutboundCapable` restated on the confirm branch).

## Final-review amendments (2026-07-04, 8-angle review — all findings verified CONFIRMED)

Deviations from the plan's letter, driven by confirmed review findings:
- **Session id column is NULLED on successful deletion** (not "kept like ca_*/ti_*" as planned):
  a non-null id on an offboarded row now marks a LEAKED session, which the expiry sweep retries
  every tick (`sessionsCleaned` counter). Rationale: a leaked live session is not inert clutter —
  a manager session can mint new connected accounts.
- **Sessions are torn down at DEACTIVATION** (new `teardownPersonSession`, called from the
  deactivate confirm branch): the plan's "no session-disable step needed (4302)" held for
  technicians only — a manager session's manageConnections bypasses the disabled-account
  backstop for the whole grace period. Reactivation re-mints at the CURRENT tier (also the
  documented demotion mitigation); the sandbox mcp.url must be re-wired (setup guide §0b).
- **`ensurePersonSession` compensating delete**: a failed roster persist now deletes the
  just-created session instead of orphaning it (the sweep would otherwise mint one per tick).
- **`appendRawCapture` names the `sensitivity` column only when set** — deploy-order resilience
  (PGRST204 would otherwise kill ALL L1 inserts if code ships before the migration; empirically
  verified). **Deploy sequence remains: migration → code.**
- **send_email**: the stage response now echoes the ITEM's staged detail (double-stage race);
  a send failure after token consumption re-annotates the consumed item
  (`annotateResolvedReviewItem`) so the durable record never reads as a completed send.
- **Accepted limitation (documented in logIngest.ts):** a manager using the spine send with
  unparseable ids on both paths can produce a duplicate outbound_email audit row; the
  context.session_id discriminator is deferred to a live verification pass.

## Parallel/stack verdict (plan-two)

*Recomputed 2026-07-04 against this rewritten plan; the matching (superseding) verdict lives in
Plan A (`2026-07-04-feature-A-manager-telegram-binding.md`) — the two sections are identical.*

**Recommendation: STACK — implement Plan B (this plan) first, then re-check/rebase Plan A on the
landed result.** Do not run the two plans as parallel worktree sessions.

**Shared files (exact-path intersection of the two File footprints):**
- `src/db/database.types.ts`
- `src/db/technicians.ts`
- `src/mcp/server.ts`
- `src/mcp/server.test.ts`
- `src/composio/pairing.test.ts` (added post-verdict: the adversarial-review fixes put it in Plan B's Phase 1; Plan A already patches its fixtures)
- `src/composio/offboarding.test.ts`
- `src/jobs/lifecycle.test.ts`
- `docs/nemoclaw-tech-agent.md`
- `docs/control-plane.md`
- `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`
- `Box_Setup_Stuff/doorman-architecture-memory.md`

**Reasoning (plain language):** ten files sit in both footprints, and in several of them the two
plans change the same *fact* — each branch would pass all its checks alone and still be wrong once
the other lands:

1. **Same roster table, two migrations, one generated types file.** Both plans add a database
   migration that alters the `technicians` table (A adds `telegram_user_id`, B adds
   `composio_session_id`), and both then update `src/db/database.types.ts` — B by regenerating it
   from the local database. A regeneration run in a worktree that doesn't contain A's migration
   silently produces a types file *without* A's column (and vice versa for A's hand-edit). Both
   also edit the same `TechnicianPatch` interface in `src/db/technicians.ts`.
2. **A widens the roster row type; B writes new code that builds roster rows.** A's new column
   means every "complete technician record" literal in tests must list it. A patches every such
   fixture that exists *today* — but B creates brand-new test files (`src/composio/outbound.test.ts`,
   `sessions.test.ts`, `logIngest.test.ts`) and expands `server.test.ts` / `lifecycle.test.ts` /
   `offboarding.test.ts` with fixtures A's list cannot know about. Merged, those fresh fixtures
   fail `npm run typecheck` until reconciled.
3. **Tool counts are asserted as absolute numbers.** `src/mcp/server.test.ts` asserts the manager
   surface is exactly 14 tools and the technician surface 7 today. A makes the manager count 15
   (`bind_telegram` in `ADMIN_TOOLS`); B *also* makes it 15 and technician 8 (`send_email` on the
   shared `TOOLS` list). Combined, the truth is **manager 16 / technician 8** — both branches'
   assertions pass alone and are wrong together. The same counts are hand-edited prose in the four
   shared docs, sometimes on the very lines both plans cite.
4. **Same hot region of `src/mcp/server.ts`.** Both add tool-table entries and dispatch cases, and
   both lean on the caller-roster read around line 299 (A for its state guards, B for `send_email`
   staging and the sensitivity filter). Whichever lands first shifts every line number the other
   plan cites — the second plan needs a re-check pass regardless, which is exactly the stacked
   workflow.
5. **The two features meet in the onboarding flow.** A's `bind_telegram` auto-claims a cold
   sandbox for a new hire with *no operator involved*; B assumes an operator wires each person's
   Composio session `mcp.url` into their sandbox's gateway at setup time
   (`scripts/provision-session.mjs`). Combined, a chat-only hire gets a working spine connection
   but no personal Composio session until an operator steps in — not a code conflict, but a
   product-flow gap the second plan must acknowledge (doc note or follow-up) when rebased.

No shared live-database semantics are at risk (A's `sandbox_pool` + badge-pull channel is
untouched by B; B's sessions/log-ingestion/review-items are untouched by A, and B's sensitivity
filter reads captures A never writes) — but the merge-time interaction risk is clearly not
"genuinely low", so per CLAUDE.md the stacked path applies.

**Order — B first, then A, because of how each plan can stall:**
- Plan A's Phase 4 is **gated on an unresolved experiment** (whether a running sandbox's Telegram
  allowlist can be re-bound without a rebuild — still `PENDING`). If the answer is
  "build-time-only", A pauses mid-feature and gets re-scoped. Landing A first risks rebasing
  finished work (B) onto a half-landed feature.
- Plan B's Phases 1–4 are fully local-testable, and the Phase 5 probes that need nothing extra
  (the 4310 session-restriction checks) can run today. Its *(needs pairing)* items have an
  explicit, achievable prerequisite — pair one mailbox via the existing connect-link flow (the
  live project has zero connected accounts) — whereas A's blocker is an experiment with a possibly
  bad outcome.
- B also rewrites more of the shared infrastructure (lifecycle job steps, offboarding, pairing
  client, server dispatch); landing it first means A's rebase is mostly re-checking line numbers,
  counts, and fixtures rather than redesigning.

**Risk areas to re-verify when rebasing Plan A after B lands:**
- `src/db/database.types.ts` — regenerate from a local stack containing BOTH migrations so both
  new `technicians` columns are present; check the two migration timestamps order cleanly.
- `src/db/technicians.ts` — `TechnicianPatch` will already carry `composio_session_id`; add
  `telegram_user_id` beside it (same interface, adjacent lines).
- `Technician` full-literal fixtures — extend A's Phase-1 fixture list with B's new/expanded test
  files: `src/composio/outbound.test.ts`, `src/composio/sessions.test.ts`,
  `src/composio/logIngest.test.ts`, plus B's additions in `src/mcp/server.test.ts`,
  `src/jobs/lifecycle.test.ts`, `src/composio/offboarding.test.ts`.
- `src/mcp/server.test.ts` — absolute tool-count assertions: after both land, manager = 16,
  technician = 8.
- `src/mcp/server.ts` — all of A's cited line numbers (tool tables, `ADMIN_TOOL_NAMES`, dispatch
  switch, caller read ~299) shift after B's `send_email` + sensitivity filter; re-locate before
  editing.
- Tool-count prose in `docs/nemoclaw-tech-agent.md`, `docs/control-plane.md`,
  `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`,
  `Box_Setup_Stuff/doorman-architecture-memory.md` — and B's additional count sites in
  `docs/doorman-runbook.md` and `Box_Setup_Stuff/migration-runbook-lightsail.md`.
- Onboarding interaction — decide/document how a `bind_telegram` auto-claimed sandbox gets its
  person's session `mcp.url` (operator step per B's `provision-session.mjs`, or a noted follow-up
  automation).
