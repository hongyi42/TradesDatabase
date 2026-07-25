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
                              (holds SUPABASE_* + the model key: INFERENCE_API_KEY for
                               the GLM default, ANTHROPIC_API_KEY when flipped; tenant pinned)
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
          // Model provider for the spine's forced-tool calls (classify/extract/brief/answer).
          // Default 'openai' → GLM-5.2 via DeepInfra (INFERENCE_API_KEY). Set 'anthropic'
          // + ANTHROPIC_API_KEY to run Claude instead — no code change.
          "MODEL_PROVIDER":            "openai",
          "INFERENCE_API_KEY":         { "secretRef": "inference-api-key" },
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
  Secrets (`SUPABASE_*`, the model key `INFERENCE_API_KEY`/`ANTHROPIC_API_KEY`, `GATEWAY_IDENTITY_SECRET`) live **only on this host** —
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
- **Stateless ⇒ horizontally scalable:** the `record_field_note` stage→confirm flow keys off a
  DB-persisted review-item token (`confirmId`, same store as `send_email`'s staged sends), so any
  replica can serve any request — no session affinity behind a load balancer.

The future **Option B** (per-bot JWT / OAuth Resource Server) swaps only the header-verification step
(`resolveIdentityFromHeaders`); the tools and tenant guards are unchanged.

## 4. Restrict the tool surface
Allowlist only the spine tools for the technician profile (`tools.profile` / allowlist) — the
14-tool technician surface: `record_field_note`, `find_customer`, `get_customer_context`,
`get_job`, `resolve_date`, `list_recent_captures`, `brief_customer`, `answer_customer_question`,
`web_search`, `read_webpage`, `send_email`, `retract_capture`, `record_standing_fact`,
`get_schedule`. Outbound network policy should allow only the gateway + our server's host.

**Manager profile (2026-07-02):** an ACTIVE `tier='manager'` roster row (the `technicians`
table, not the badge, is the tier source of truth) gets the technician surface MINUS
`get_schedule` (removed for managers 2026-07-19 — it is the technician route view; a manager's
only schedule read is `get_team_schedule`, which includes visits the manager holds; do NOT pin
get_schedule in the MANAGER profile) plus the 17 seat/lifecycle+scheduling tools, for a 30-tool
manager surface (send_email since 2026-07-04, retract_capture since 2026-07-06, web_search and
read_webpage since 2026-07-13, record_standing_fact since 2026-07-14, resolve_date since
2026-07-17; the 4 scheduling tools
`get_team_schedule`/`book_visit`/`move_visit`/`cancel_visit` since 2026-07-14; the 5
schedule-input tools `set_availability`/`add_time_off`/`remove_time_off`/`set_job_duration`/
`set_technician_skills` since 2026-07-20 — all one-shot, no confirm; `set_availability` is the
step that makes a person schedulable, tracked by an `availability_setup` review item opened at
seat confirm): `add_technician_seat`
(two-step confirm since 2026-07-17 — mints a permanent ref + burns a seat, not reversible;
`seatExempt:true` since 2026-07-19 adds a SCHEDULE-ONLY person instead — no seat occupied,
bookable on visits and visible on the board, but `bind_telegram`/`get_connect_link` refuse them:
no assistant, no Telegram, no email, ever),
`deactivate_technician_seat` (two-step confirm; starts the disable-first grace period),
`reactivate_technician_seat` (the grace-period undo), `get_connect_link` (mint a Gmail
Connect Link; 5-min per-person cooldown), `bind_telegram` (connect a person to their numeric
Telegram user id — auto-claims a cold-pool sandbox if they have none; reaches the box in ~5 min),
`list_team`, `list_pending_reviews`,
`resolve_review` (also carries pairing-verification verdicts: resolved = mailbox confirmed →
active; dismissed = wrong mailbox → pairing torn down). The server both filters `tools/list`
by tier and re-gates every admin call at dispatch — a technician badge structurally has no
admin surface. Seat caps (`tenants.manager_seats`/`technician_seats`) are DB-enforced; the
agent cannot talk past them.

## 5. Conversation contract (stage→confirm since 2026-07-06)

**Confirmation doctrine (2026-07-17, user decision):** confirm only what is **irreversible or
externally visible** (a customer promise at stake); everything reversible happens in ONE call
and the agent reports what it did. Concretely: `book_visit`/`move_visit`/`cancel_visit` act
one-shot when no customer promise is affected (book with `promiseLevel:'none'`, move with
`promiseBroken:false`, cancel of an unpromised visit) and still stage→confirm when one is;
`add_technician_seat` is now two-step (permanent ref + a seat — still two-step with
`seatExempt:true`, where no seat burns but the ref mint stays permanent); `book_visit` has NO default
times (2026-07-18, user decision — the 2h job-length default was removed after it overrode a
stated "12–1pm" in the pilot): `startTime` and `endTime` are required, the agent passes
exactly what the manager stated and asks when a time is missing.

**Board link (2026-07-18):** scheduling results carry `boardLink` — the Telegram Mini App
dispatch board (`t.me/<board-bot>?startapp`, decorated server-side from `BOARD_BOT_HANDLE`,
absent when unset). The agent ends every schedule-change report with it ("See it on the
board: …"), relayed exactly — never an invented or remembered URL.
- The agent calls `record_field_note({ text, channel })`. **Nothing is recorded by this call** —
  the note is staged server-side (a review-item token) and the response carries a `confirmId`.
- If the result `status` is `needs_identity`, the agent asks the technician which customer
  (a `suggestion` carries the scheduled address when there is one), then calls again with
  `confirmId` + `confirmed: { customerId }` (or `{ address }`).
- On `needs_confirmation` the response includes a `preview` (customer name, new-customer flag,
  note text). The agent shows the technician exactly that preview and waits for an explicit yes,
  then calls again with **ONLY `confirmId`** — that final call writes L1 + L2 in one step and
  returns `status: 'recorded'`. The STAGED copy is what commits; fresh args are ignored.
- Staged notes expire after 15 minutes; one staged note per person (a re-stage supersedes).
- **Fixing a mistake:** the record is append-only — nothing is ever deleted. The agent records
  the corrected note first, then calls `retract_capture({ captureId, reason })` on the wrong
  capture (also two-step: stage → show → confirm with only `confirmId`). Retracted captures,
  their visits, AND any standing fact citing the capture as evidence disappear from
  briefings/context/lists; managers can pass
  `includeRetracted: true` to `list_recent_captures` for the full labeled trail. Only the
  capture's author or a manager may retract; agent-action audit rows (`outbound_email`,
  `agent_action`) are manager-only, even for their author. Facts a note already wrote onto the
  job/customer record (e.g. a status change) are not auto-reverted by a retraction.
- **Retraction blast radius (2026-07-14):** the retraction stage response carries
  `willAlsoRemove` — the server-computed list of standing facts and visits that fold with the
  capture. The agent must show that list as part of the confirmation. The confirm response
  echoes the final list as `alsoRemoved` plus a `restoreHint` when facts folded; the agent then
  offers to restore still-true facts by **staging** `record_standing_fact` (the preview is the
  offer — no "want me to?" pre-ask; AGENTS.md rule 3 "propose by staging"), one target at a
  time. If `alsoRemoved` is absent, the post-commit scan failed — fall back to the staged
  `willAlsoRemove`.
- For questions ("what did the last tech do here?"), the agent uses `find_customer` →
  `get_customer_context` / `list_recent_captures`.
- **Web tools (2026-07-13, all tiers):** `web_search` (Brave snippets via Render — the key never
  reaches a sandbox) and `read_webpage` (hardened reader: URLs from the person or from search
  results only per the §0e rules; server enforces SSRF guard, a length cap on non-search URLs,
  per-person daily caps, and logs every request to `web_requests`). Content comes back labeled
  untrusted; the §0e AGENTS.md block (Box_Setup_Stuff setup guide) carries the behavior rules.

## 6. Email ingestion (Phase 4 — separate from the chat channel)
A second input channel pulls the technician's email and feeds **only work-related** mail through the
same write-path (`channel: 'email'`). This does **not** require NemoClaw — `ingestEmail`
([src/email/ingest.ts](../src/email/ingest.ts)) calls Gmail directly via `googleapis`:

> **Note — under Option B (§7) this fetcher is superseded by Composio's Gmail trigger.** The per-tenant
> `googleapis` creds below are replaced by Composio-managed OAuth; the **classifier + write-path are
> unchanged**. Keep the direct creds only for the single-mailbox dev/test path.
- Provide Gmail OAuth2 creds in env: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`
  (or swap in a Workspace service account with domain-wide delegation).
- A classifier ([src/email/classify.ts](../src/email/classify.ts)) — GLM-5.2 by default,
  `MODEL_PROVIDER`-switchable — drops personal/marketing mail before anything is written; only work
  mail reaches L1/L2.
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
[the overview](Three-Layer-Context-Spine-Overview.md): hardcode identity matching / permission
boundaries; outsource only the plumbing).

**Composio is complementary to `trades-spine`, not a replacement.** The spine MCP stays the only writer
to the canonical record (holds Supabase keys; does identity-match + provenance + tenant guards). Both
register side-by-side in the gateway's `mcp.servers`.

### Outbound architecture of record (amended 2026-07-04 — implemented)
**Per-PERSON Composio sessions (Tool Router GA) carry outbound**, superseding the per-tenant
`mcp.url` sketch below (kept for history). User decisions 2026-07-04:
- **One session per person**, keyed by the composite `"<tenantUuid>:<technicianRef>"` user id and
  created by the lifecycle cron for every ACTIVE roster row (`src/composio/sessions.ts` —
  `ensurePersonSession`; id persisted as `technicians.composio_session_id`, deleted at offboarding
  expiry, kept as a column for audit). Session restrictions are **execution-enforced** (verified —
  see the "Verified 2026-07-04" block in *Secret custody* below; match error code `4310`, not HTTP
  status).
- **Manager tier = the ENTIRE catalog + self-serve pairing** (`manageConnections: true`): managers
  pair new connectors themselves via OAuth links from their agent. NO structural block on
  destructive tools — safety = the "AI can make errors" disclosure + confirmation behavior
  context-engineered into the manager agent's instructions (Box_Setup_Stuff setup guide §0b).
  Deliberate, accepted risk (user decision).
- **Every sandbox (both tiers) also carries the accuracy-rules block** (setup guide §0c, since
  2026-07-05): copy user-given values (email addresses, amounts, dates…) character-for-character
  into tool arguments and self-check the staged copy against the user's message BEFORE showing
  the confirmation. Origin: the first live send E2E staged a mistyped recipient address — caught
  by the user at the confirm step, which is one step later than it should be. NOTE: the block
  lives in the sandbox's workspace `AGENTS.md`, which a container rebuild resets — re-append
  after any rebuild (bootstrap-box.sh `wire` phase does this).
- **Every sandbox also carries the batching block** (setup guide §0d, since 2026-07-09): for any
  large/long task the agent works in bounded, resumable batches — read a `task-progress/<task>.md`
  cursor first, process ~300–500 items, commit the outcome to the cursor, stop cleanly before the
  per-run timeout, resume in a fresh small-context turn, and on completion distill terse learnings
  into `MEMORY.md` while routing lasting customer/job facts to `record_field_note`. Origin: a
  ~38k-email cleanup ran the full 600s timeout and overflowed context by keeping every touched
  email in-context (research: `thoughts/shared/research/2026-07-08-long-running-agent-tasks.md`).
  Same workspace-`AGENTS.md` lifecycle as §0c — reset by rebuild, re-appended by the `wire` phase.
  Caveat: prompting steers but does not ENFORCE — verify on a real large-inbox run.
- **Credential lifecycle (verified 2026-07-11, recurring-outage class):** each sandbox's
  secrets (Telegram bot token, spine badge) live in an attached OpenShell provider. At **process
  launch** the env gets only a version-scoped placeholder REGISTRATION per credential; the real
  value resolves **in-process at component init** (bridge start / MCP connect) against the
  provider store — the egress proxy does NOT substitute per-request, and an unregistered
  credential means the component dies silently. Two standing consequences: (a) seat provisioning must have
  `TELEGRAM_BOT_TOKEN` in the onboard process env (`bootstrap-box.sh provision` handles it —
  a bare non-interactive onboard silently builds a deaf bot; bit s2 2026-07-05 and s4
  2026-07-10); (b) **any provider-credential write (badge install/rotation, token change)
  needs a container restart to take effect** — bit s3/Judy 2026-07-07→11 (spine MCP dead 4
  days: badge in store, absent from env). Drift probe: `bootstrap-box.sh verify` credential-
  freshness check. Details: setup guide §4b + §5b credential-lifecycle box.
- **Technician tier = pinned `direct_tools` list** (`TECHNICIAN_GMAIL_TOOLS`: fetch/draft/profile;
  product-configurable), `manageConnections: false`, **send structurally impossible** (4310).
  Technician send goes through the spine's `send_email` tool: persisted two-step confirm
  (stage → confirmId → consume-token-then-send, at-most-once) + synchronous L1 capture
  (`outbound_email`).
- **Manager actions are audited asynchronously**: the lifecycle cron pulls the v3.1 execution logs
  (`src/composio/logIngest.ts`, 60-min overlapping window) into L1 — email sends as
  `outbound_email` (verbatim, business correspondence), other state-changing calls as
  `agent_action` with **keys-only redaction** (argument key names, never values — L1 is
  undeletable) and `sensitivity='manager_only'` (filtered out of technician-tier spine reads).
  Reads are skipped; when unsure, capture. **Capture-all, no work/personal classifier** — recorded
  exception in CLAUDE.md.
- **mcp.url delivery: via the composio-doorman RELAY, no operator step (since 2026-07-06).** The
  session `mcp.url` is NOT distributed to sandboxes; the sandbox's `composio` MCP entry points at
  the doorman `/composio/` path (same badge) and Render pins each request to the person's session
  (see *Secret custody + gateway wiring* below). `scripts/provision-session.mjs` is diagnostics-only.
  Consequence for Feature A: a chat-only hire's auto-claimed sandbox gets Composio access with NO
  operator wiring — the relay reads `composio_session_id` per request.
- **Sandbox recycling (2026-07-12, zero-operator member replacement):** a manager's CONFIRMED
  `deactivate_technician_seat` (the one confirmation now warns that the person's assistant and
  its chat memory are destroyed) marks the sandbox for retirement; the box's 5-min badge pull
  carries it (`retirements[]`), badge-pull queues it, and `sandbox-recycler.service` runs
  destroy → re-provision a fresh cold blank under the NEXT ref **reusing the same Telegram bot**
  → `POST /control/sandboxes` (host pull-token) so the server retires the old pool row, racks
  the new blank, and clears the roster residue. Pool refills ~15 min after a swap; badge install
  for the NEXT hire is also automatic now (badge-pull installs + restarts the container, pending
  file = failure fallback only). **Reactivation during the grace period cancels a still-pending
  retirement (assistant intact); after destruction the person reactivates to a note routing the
  manager to `bind_telegram`, which claims a fresh blank — the agent's memory does not survive a
  recycle.** Failure surfaces: `/var/lib/sandbox-recycler/failed/` = parked entries needing an
  operator (dead bot token, server 409) — `bootstrap-box.sh verify` flags them. Details: setup
  guide §10.

**Phase-5 live verification (2026-07-04, fresh-context probe against the live project):**
- **Enforcement re-confirmed with the production configs**: technician session rejects
  `GMAIL_SEND_EMAIL` with HTTP **400** `code 4310 / ToolRouterV2_ToolNotInEnabledList` (docs say
  403 — match code/slug); pinned tools pass the gate (4302 downstream); the restriction is stored
  server-side (`tool_router_tools` = exactly the three pinned slugs, `manage_connections.enabled
  = false`).
- **DIRECT_TOOLS surface**: the technician MCP endpoint exposes EXACTLY the three pinned tools —
  no meta-tools at all. Adversarial connection-minting attempts (`COMPOSIO_MANAGE_CONNECTIONS`,
  `COMPOSIO_INITIATE_CONNECTION`, search, multi-execute, direct `tools/call GMAIL_SEND_EMAIL`)
  all `-32602 not found` — **no connection-minting route exists**; the
  `manageConnections:{enable:false}` contingency is not needed. All three
  `TECHNICIAN_GMAIL_TOOLS` slugs exist in the current catalog, `is_deprecated:false`.
- **Manager session**: full meta-tool set incl. `COMPOSIO_MANAGE_CONNECTIONS`; catalog breadth
  proven (search plans cite `GOOGLESHEETS_*`/`GOOGLEDRIVE_*`); self-serve pairing mints a real
  `connect.composio.dev/link/...` redirect (10-min expiry).
- **Logs API v3.1 (the ingestion contract)**: envelope rows under **`logs`** (not items/data);
  `next_cursor` epoch-ms string, `null` when exhausted, request field `cursor`; `time_range`
  MUST be epoch-ms numbers (ISO strings → 400). Item: `{id, timestamp, type, status, level,
  metadata, metrics, parent}` — `status` top-level; `metadata.user_id` (string, composite);
  **`metadata.tool` is an object `{slug, version, is_deprecated}`**; `metadata.toolkit` an object
  `{slug, icon}`. Detail `GET …/{id}` adds `data = {success, request:{payload:{…}},
  response:{status_code, body:{…}}, logs}`. **Permission-gate rejections (4310) are NOT logged**
  — the audit sweep sees only executions that ran. Retention: windows back to 400 days accepted
  (no upper bound observed; sparse data today, so depth is unproven — the 60-min sweep window is
  safely inside any plausible retention). `src/composio/logIngest.ts` parses these verified
  shapes with the older assumed spellings kept as fallbacks.

### Multi-tenant model
- **One business = one tenant UUID; Composio `user_id` is per PERSON (revised 2026-07-01):**
  `user_id = "<tenantUuid>:<technicianRef>"` — one connected account + one trigger per person, so ten
  employees' personal inboxes pair to ten isolated connected accounts under one shared spine tenant.
  The inbound webhook splits on the FIRST colon (`src/inbound/webhook.ts`) → tenant scopes the spine
  rows, ref becomes the capture/visit attribution. The webhook also consults the `technicians`
  roster: an offboarding/offboarded person's mail is dropped with a receipt (never ingested); an
  unknown ref is ingested AND flagged for manager review (`review_items`) — mail is never lost to
  a provisioning slip. **Bare-uuid `user_id`s were retired 2026-07-02**
  (the webhook rejects them `bad_payload`; the last legacy pairing was deleted the same day —
  every pairing is per-person now). A person's handle can only reach their
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
  matching is dead for that person and L1↔badge joins fail. *(The schedule sheet retired
  2026-07-15 with the Telegram-schedule series Plan 1 — the DB owns the schedule
  (`assignments`, keyed to the roster row by UUID), so the vocabulary contract is now just
  badge ref ⇔ roster ref ⇔ Composio user_id; there is no sheet column to keep in sync.)*
  The `connector:` prefix is reserved (webhook rejects composite refs that use it). (4) **Refs are unique per tenant — mint
  from full-name slugs or employee ids, never bare first names** (two Janes as `…:jane` would merge
  both inboxes into one identity, permanently — L1 is append-only). **DB-enforced since 2026-07-02:**
  the `technicians` roster's `unique (tenant_id, ref)` spans ALL rows (offboarded included), so a
  ref is never reused across humans. The reconnect script's `--replace` guard remains as the
  Composio-side complement (it checks live connections, not the roster).
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
- **Outbound custody of record (relay, since 2026-07-06):** the Composio session **`mcp.url` is
  NOT distributed to sandboxes at all** — neither the url nor any Composio key ever leaves the
  control plane. A sandbox reaches Composio through a `composio` MCP entry pointing at the
  doorman's `/composio/` path, authenticated by the **same badge** it already holds. The doorman
  forwards to the Render relay (`src/composio/relayHandler.ts`), which verifies the signed
  identity, looks up `composio_session_id`, and forwards ONLY to that session with the Composio
  key (`COMPOSIO_RELAY_API_KEY`, scoped; master fallback) attached **server-side**. Per-person
  pinning is the boundary; the caller controls request content, never the destination or credential.
  ```jsonc
  { "mcp": { "servers": {
      "trades-spine": { /* HTTP server + signed x-tenant-id headers (§3b) */ },
      "composio":     { "transport": "streamable-http",
                        "url": "http://host.openshell.internal:3001/composio/",
                        "headers": { "Authorization": "Bearer openshell:resolve:env:TRADES_SPINE_BADGE" } }
  }}}
  ```
  *Why not the direct session url (the retired secretRef wiring):* the url alone 401s
  (`require_mcp_api_key`) and the SDK's session auth header IS the master key — putting it in a
  sandbox would grant any-user access. **Live-probed 2026-07-06:** Composio pins the connected
  account to the session (a forged `connectedAccountId` in tool args is ignored — the relay's
  arg guard is defense-in-depth, not load-bearing), the scoped key is accepted, and the session
  MCP responds SSE. `scripts/provision-session.mjs` is now diagnostics-only.
- Allowlist only the actions each tier needs (e.g. `GMAIL_SEND_EMAIL`, `GOOGLESHEETS_BATCH_GET`) — mirror §4.
- **Per-person capability control lives at the gateway, not in Composio (decided 2026-07-01):** the
  doorman badge already resolves `{tenantId, technicianRef}` per bot, and a future per-tier tool
  allowlist attaches there. Composio's **Execution Allowlist** is configured per auth config
  (dashboard-observed 2026-07-01: "Restrict which tools agents can execute. Leave empty to allow
  all"), and our shared-config model means one config serves every tenant and person — so it is only
  the **global ceiling** (e.g. "no send anywhere"), never per-person policy.
- **Verified 2026-07-04 (docs research + live probe) — this changes the premise above; decision under
  review with the user:**
  - **Auth-config Execution Allowlist: still UNVERIFIED as an enforcement boundary.** The API field is
    `tool_access_config.tools_available_for_execution` (live OpenAPI,
    https://backend.composio.dev/api/v3/openapi.json); the prose docs never state that executing a
    non-allowlisted tool fails — the only blocking claim is marketing
    (https://composio.dev/protection). Treat as defense-in-depth only, never the boundary. Note: before
    the Jan 14, 2026 "True PATCH Semantics" fix, omitting `tool_access_config` on an auth-config update
    silently reset it to `{}` (https://docs.composio.dev/reference/changelog).
  - **Composio SESSIONS (Tool Router GA, Dec 2025) ARE an execution-time enforcement boundary —
    live-verified 2026-07-04 against our project.** A session is created per user
    (`composio.sessions.create(userId, { toolkits, tools:{gmail:[...]}, mcp: true })`,
    SDK ≥0.13.1) and its restriction is enforced at execution on BOTH paths: session execute returns
    HTTP 400 `code 4310 / slug "ToolRouterV2_ToolNotInEnabledList"` ("[Session Restriction] Tool
    'GMAIL_GET_PROFILE' is not enabled for this session"), and the session's MCP endpoint (meta-tool
    `COMPOSIO_MULTI_EXECUTE_TOOL` route) rejects identically, while a control session with the tool
    enabled passes the gate (fails later at connection resolution, `4302 /
    ToolRouterV2_NoActiveConnection` — proving the layers). Docs:
    https://docs.composio.dev/docs/configuring-sessions, https://docs.composio.dev/docs/sessions-via-mcp.
    ⚠ Doc discrepancy: docs say 403; live API returns 400 with code `4310` — match on the code/slug,
    not HTTP status. ⚠ Default session preset exposes only six meta-tools over MCP `tools/list`
    (app tools run via `COMPOSIO_MULTI_EXECUTE_TOOL`); a fixed direct list needs the `DIRECT_TOOLS`
    preset. Consequence: per-person AND per-tier policy CAN live in Composio session config (one
    session per person, keyed by our composite `"<tenant>:<ref>"` user id) — the 2026-07-01 "only the
    gateway can do per-person" premise no longer holds. Caveats before relying on it as the ONLY
    boundary: over MCP our code is not in the request path ("you can't intercept, reshape, log, or
    gate calls" — sessions-via-mcp docs), and Composio had a tool-execution-sandbox breach May 21–25,
    2026 (https://composio.dev/blog/composio-may-2026-security-incident). If tool slugs are pinned in
    session configs, re-check them after Composio catalog releases (May 2026 consolidation renamed
    tools; a stale slug silently enables nothing).

### Scopes (least privilege)
- **Managed OAuth means one broad token per connected account** — the managed app grants
  `https://mail.google.com/` (read + compose + send together; dashboard-observed 2026-07-01), so a
  send-only-token split is not available. Least privilege moves to the **action layer**: per-person
  Composio **session** tool configs (execution-enforced — verified 2026-07-04, see gateway bullet
  above) with the per-auth-config Execution Allowlist as unverified defense-in-depth, plus the
  per-tier gateway allowlist (§4). ⚠ **Interim gap, accepted:** the per-tier
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
3. **Model classifier** ([src/email/classify.ts](../src/email/classify.ts)) — the real work/personal
   call (GLM-5.2 by default; `MODEL_PROVIDER` selects the provider).
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
