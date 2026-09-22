---
date: 2026-09-22
branch: work/step-1-technician-seat-on-the-copilot-sd
commit: de8d326
topic: Step 1 of the openclaw retirement — what a technician seat (s5, Ben) is made of today on trades-box-1, and every seam the Copilot SDK engine plus our glue (Telegram long polling, sessions, spine tools, cost rows) must connect to in order to replace s5's openclaw sandbox. Includes the SDK 1.0.14 surface read from its own type definitions, and the Telegram and OpenRouter contracts read from their live docs.
supersedes: nothing
---

Read with: `docs/engineering-memory.md` §2 "Step 0 measured" (lines 1637-1698), the step 0 finding
`thoughts/shared/findings/2026-09-22-step-0-two-hour-test-of-the-github-copil.md`, and
`thoughts/shared/research/2026-09-21-seat-runtime-direction-openrouter-agent-sdk.md` §8 (its Render
framing is superseded; its Copilot SDK facts stand, corrected by step 0). The step-by-step build
sequence lives in memory `openclaw-retirement-plan`; this document does not restate it.

## Summary

A technician "seat" is the AI assistant a technician texts on Telegram. Today each one is an
**OpenClaw agent inside its own Docker container ("sandbox")** on the Lightsail box trades-box-1.
The OpenClaw gateway process in the container polls Telegram, runs the model (Gemini 3.8 Flash via
OpenRouter), and reaches the firm's records (the "spine") through a small proxy on the box called
the **doorman**. The doorman swaps the seat's revocable **badge** for a signed identity header that
Render checks. Step 1 replaces that container, for one seat (s5, the technician Ben), with **one
GitHub Copilot SDK engine process plus a thin program of ours ("the glue")**. The glue polls
Telegram, keeps one conversation (a "session") per seat, lets the engine call the same 17 spine
tools through the same doorman, and writes a cost row per model call. The most important finding
is that **s5's sandbox is load-bearing for more than chat**:
- the planner's questions, push notifications and office messages reach Ben only by a script
  running a command *inside* s5's container (`nudge-runner.sh:135-150`, `office-runner.sh:115-131`);
- the badge the glue needs is installed only into that container's provider store
  (`badge-pull.sh:101-144`);
- the box has **no database credential and no Render route for cost rows or session ownership**.

Retiring the sandbox without those three seams silently cuts Ben off from the office and leaves
the new cost rows with nowhere to go.

## Entry Points

**Today (openclaw), per inbound technician text:**
- The OpenClaw gateway inside the s5 container long-polls Telegram `getUpdates`. The provision step
  proves this by grepping the container log (`Box_Setup_Stuff/bootstrap-box.sh:294-301`).
- Spine tool calls enter Render at the MCP fallthrough in `src/mcp/httpServer.ts:983-988`, after
  the doorman (`Box_Setup_Stuff/doorman.mjs:37-92`).
- Box-to-Render control traffic uses `/control/*` routes (`src/mcp/httpServer.ts:838-889`),
  authenticated by the host bearer token `HOST_PULL_TOKEN` (`httpServer.ts:242-256`).

**Box timers that act on a seat** (installed by hand, not by `bootstrap-box.sh`):

| Unit | Cadence | Entry |
|---|---|---|
| `nudge-runner.timer` | every 10 s (`nudge-runner.timer:38-39`) | `nudge-runner.sh` |
| `office-runner.timer` | every 30 s (`office-runner.timer:32-33`) | `office-runner.sh` |
| `badge-pull.timer` | every 5 min (`bootstrap-box.sh:485-508`) | `badge-pull.sh` |

(The scripts' headers still say "every 5 min"; the timers are faster.)

**Nothing of step 1 exists in the repo yet.** No package dependency on `@github/copilot-sdk`
(`package.json:54-57` lists `@anthropic-ai/sdk`, `@composio/core`, `@modelcontextprotocol/sdk`,
`@supabase/supabase-js`). Step 0's probe scripts live only on the box in `~/copilot-sdk-test/`
(engineering-memory.md:1696).

## Key Files

**On the box (`Box_Setup_Stuff/`)**
- `doorman.mjs` (95 lines) is the badge → identity proxy. It:
  - hashes the Bearer badge with sha256 and looks it up in `/etc/doorman/badges.json`, re-read on
    every request (:34-44);
  - builds a fresh header set with `x-tenant-id`, `x-technician-ref`, and
    `x-identity-signature = HMAC-SHA256(GATEWAY_IDENTITY_SECRET, "t.r")` (:33, :56-63);
  - keeps the caller's path only for `/composio` (:26-31, :72), sending every other path to
    `MCP_UPSTREAM_URL`'s path;
  - passes `mcp-session-id` through only on the `/composio` branch (:64-70);
  - streams the reply with `pipeline` (:73-76);
  - sets no timeout and no body cap (:50-53).
- `bootstrap-box.sh` (1964 lines) provisions and wires seats:
  - Telegram polling assert: :294-301.
  - Inference route: `openshell inference set -g nemoclaw --provider openrouter-prod --model
    @preset/trades-seats` (:303-306).
  - Per-seat token file `/root/seats/<seat>.env`, mode 0600, holding `TELEGRAM_BOT_TOKEN`,
    `BOT_USERNAME`, `BOT_ID` (:321-331).
  - The doorman unit: :410-441.
  - `wire` appends the AGENTS.md doctrine blocks (:675-1305) and sets the 2000 ms debounce (:1571).
  - Seat model entry: `input:["text","image"]` at :1503 and :1587.
  - Per-seat revive unit `nemoclaw-agent-<seat>.service` with `Restart=always` (:1710-1730).
- `badge-pull.sh` runs every 5 min. It:
  - pulls `GET /control/badges` (:151) and replaces `badges.json` atomically (:187-206);
  - installs each new badge plaintext into the seat's OpenShell provider `<seat>-telegram-bridge`
    as `TRADES_SPINE_BADGE`, then runs `docker restart` (:101-144, :208-249);
  - applies Telegram bindings (:251-309);
  - queues retirements for the recycler (:311-358);
  - calls `seat-sync.sh` (:377-379).
- `apply-binding.sh` writes the Telegram allowlist in two places:
  - `~/.nemoclaw/sandboxes.json` → `allowedIds` (:36-52);
  - `openclaw.json` → `channels.telegram.accounts[].allowFrom = [id]` (:58-76);
  - then restarts the gateway (:78-86).
- `nudge-runner.sh` (164 lines) delivers queued nudges and person pushes verbatim. It:
  - pulls `GET /control/nudges` (:74);
  - stages the body inside the seat's container (:134-140);
  - sends it with `openclaw message send --channel telegram --target <replyTo>` run *in the
    container* (:148-150);
  - keeps idempotence markers in `/var/lib/nudge-runner/sent-<id>` (:111-118, :155).
- `office-runner.sh` (143 lines) injects planner/office messages as agent turns. It pulls
  `GET /control/office` (:67) and runs `openclaw agent --session-key main --message-file … --json`
  *in the container*, with no `--deliver`, so the person sees nothing (:129-131). Client timeout is
  630 s (:124-128).
- `nemoclaw-inference-medic.sh` checks the OpenRouter balance via `GET /key` and `/credits`
  (:195-196). Each tick it re-asserts the preset route; each hour it probes a turn-shaped tool call
  "from inside a sandbox" (:37-47).
- `plugins/trades-weekday-guard/` is an observe-only, fail-open OpenClaw plugin on
  `message_sending` and `reply_payload_sending` (`index.js:13-21`, :318-330). It logs to
  `/sandbox/.openclaw/logs/weekday-guard.jsonl`.

**On Render (`src/`)**
- `src/mcp/identity.ts` (63 lines): `resolveIdentityFromHeaders` recomputes the HMAC and returns
  `{tenantId, technicianRef}` (:41-63). `RequestIdentity.scopes?` exists but nothing fills it (:13-17).
- `src/mcp/httpServer.ts` (1018 lines) routes, in order:
  1. `/health`;
  2. phone webhooks;
  3. `/control/*` via the host token (:838-889);
  4. board, console and admin;
  5. the IP allowlist, if `ALLOWED_CLIENT_IPS` is set (:969-973, :44-50);
  6. `/composio` (:977-980);
  7. the MCP fallthrough (:983-988). It is **stateless**: `sessionIdGenerator: undefined`, a fresh
     `Server` per request, and any throw returns a bare 401 (:989-995).
- `src/mcp/server.ts`:
  - `ListTools` serves `TOOLS` (17) or `MANAGER_TOOLS` (45) depending on `isActiveManager`
    (:922-937).
  - Every dispatched call writes one `cost_events` row `provider:'spine', sku:'tool_call'`, stamped
    with the caller's `technicianRef` (:624-639).
  - Results are JSON inside one text block, with a firm-local `now` line added (:891-914,
    :939-1023).
  - The expected technician surface is `src/mcp/tools/surface.expected.ts:26-44`.
- `src/mcp/resultCap.ts`: a tool result is capped at 20,000 characters by default
  (`DEFAULT_RESULT_CAP_CHARS`, :16; env `SPINE_RESULT_CAP_CHARS`, :21-22).
- `src/control/badgeFile.ts`: a badges.json entry is `{tenantId, technicianRef, revoked}` (:13-17).
  `bindings[]` is served for active rows with both a `sandbox_ref` and a `telegram_user_id`
  (:27-31, :85-95).
- `src/control/nudgeQueue.ts`: nudges, chat-kind office rows and person pushes are served per host
  (`hostId` from the token) and addressed by the person's `technicians.sandbox_ref` (:110-323,
  e.g. :177, :210). An item is skipped when the person has no `sandbox_ref` or no
  `telegram_user_id` (:177, :242, :290).
- `src/control/officeQueue.ts`: agent-addressed office messages, wrapped `OFFICE QUESTION` /
  `OFFICE NOTE` / `NOTE FROM X's assistant` (:51-83, :88-152).
- `src/db/costs.ts` (650 lines):
  - `appendCostEvents(rows)` is the only `cost_events` writer. It upserts on
    `tenant_id,provider,sku,source_ref` with `ignoreDuplicates` (:48-75).
  - `recordModelUsage(vendor, usage, ctx)` turns token counts into rows (:207-272).
  - `MODEL_SKUS.openrouter` maps to the **GLM-5.3** SKUs only (:185-194).
  - The file header calls rows "UNITS, never dollars" (:21-24).
- `src/telegram/`: `boardApi.ts`, `boardNotify.ts`, `opsNotify.ts`, `botIds.ts`, `initData.ts`,
  `rosterCache.ts`, `boardWorker.ts` (4,809 lines total). No module polls `getUpdates`. The one-bot-
  per-person rule is stated at `opsNotify.ts:27-33`: a person-facing message goes on the queue and
  is "delivered by the box through the operator's own assistant".

**Database (`supabase/migrations/`)**
- `20260725120000_cost_ledger.sql`:
  - `cost_events` (:52-68) with the idempotency key `unique (tenant_id, provider, sku, source_ref)`
    (:94-95; a NULL `source_ref` never conflicts);
  - `cost_rates` with one open rate per SKU (:20-46).
- `20260725140000_cost_tables_rls.sql`: RLS on, no policies, and "the service-role key … is the
  only key the server ever holds" (:21-22, :31-41).
- `20260906130000_openrouter_seat_model_rates.sql`:
  - Seeds `openrouter` rates for `gemini-3.8-flash-{input,output,cached-input,cache-write}` and
    `muse-spark-1.3-*` (:40-48).
  - "WHY THESE ROWS EXIST WHEN NOTHING STAMPS THEM. Seat inference never passes through
    recordModelUsage … Seat spend is ACCOUNT-LEVEL" (:13-16).
- `20260915100000_ops_secrets_bot_tokens.sql`: `ops_secrets.bot_tokens (host, sandbox_ref,
  bot_username, bot_id, token)` (:38-59). Operator-only and "never read by application code"
  (:25-28, :45).
- `20260707000000_telegram_binding_and_sandbox_pool.sql`, `20260711200000_…`,
  `20260909120000_sandbox_pool_bot_id.sql`: `technicians.telegram_user_id`, and the `sandbox_pool`
  public halves (`bot_username`, `bot_id`).
- `20260704210155_scheduling_foundation.sql:11`: `tenants.timezone text not null default
  'America/Los_Angeles'`.

## Data Flows

### A. Today: one technician text on s5

```
Ben's phone ──Telegram──► @ragisan03_bot
                               │ getUpdates (long poll)
                               ▼
  trades-box-1 ┌─ s5 Docker container (openclaw 2026.6.34) ──────────────────────┐
               │  telegram plugin: allowFrom=[8991633730] → debounce 2000 ms     │
               │  agent turn (AGENTS.md doctrine, 17 spine tools, native vision) │
               │     │ model call: provider "inference" (inference.local)        │
               │     │   → OpenShell gateway route → OpenRouter @preset/trades-seats│
               │     │ tool call: MCP "trades-spine" http://host.openshell.internal:3001/
               │     │   Authorization: Bearer <s5 badge>                         │
               └─────┼──────────────────────────────────────────────────────────┘
                     ▼
               doorman :3001  badge → sha256 → badges.json → {tenantId, technicianRef}
                     │  + x-identity-signature (HMAC)
                     ▼ https
  Render  httpServer.ts:983  resolveIdentityFromHeaders → createServer({identity})
          → dispatch → cost_events 'spine/tool_call' row → Supabase (pilot DB)
```

- The model's spend is **not** recorded per seat. Seat spend exists only as the OpenRouter account
  total ("untitled = the fleet", engineering-memory.md:7934-7937).
- **Photos** reach the model only as native vision input. The file stays inside the container as
  `MediaPath`, and a follow-up turn re-finds it with `exec` plus the `image` tool (44 s in one
  measured case, engineering-memory.md:7984-7990).
- Nothing uploads Telegram media anywhere. No `getFile` or `file_id` code exists in `src/`.
- `record_field_note` accepts `blobPath` ("object-store pointer for audio/photo",
  `src/mcp/tools/captures.ts:122`) and stores it verbatim in `raw_captures.blob_path`
  (`src/db/rawCaptures.ts:21,73`). No caller fills it.

### B. Today: the office reaches Ben (planner → seat)

```
Render queues (office_messages, nudges, person_pushes)
   ▲ GET/POST /control/office, /control/nudges  (HOST_PULL_TOKEN, per host)
   │
trades-box-1: office-runner (30 s) / nudge-runner (10 s), as root
   │ nemoclaw s5 exec -- cat > /tmp/<id>.txt                  (stage body in container)
   │ nemoclaw s5 exec -- openclaw agent --session-key main …  (office: silent injected turn)
   │ nemoclaw s5 exec -- openclaw message send --target <tg>  (nudge/push: verbatim send)
   ▼
s5 container → Telegram
```

Both runners address the seat by `sandboxRef` and treat a failed `exec` as a failure. The
failure is reported to Render as "could not stage message in sandbox" (`nudge-runner.sh:138`,
`office-runner.sh:118`), and Render owns retries.

### C. The badge's path to the seat

- `GET /control/badges` mints the plaintext in `newBadges` (`src/control/badgeFile.ts:96-119`).
  Only its sha256 is stored in `technicians.badge_hash` (`src/control/badges.ts:18-21`).
- `badge-pull.sh` writes the plaintext into the container's provider and restarts the container
  (:101-144).
- Only fingerprints reach `badges.json`.
- The plaintext exists on the box in two places only: the OpenShell provider store for
  `s5-telegram-bridge`, and the container env, from which a boot-time fallback substitutes it into `openclaw.json` (`apply-bakein.py:301-318`).
  Before a successful install it may also sit in `/root/pending-badges.jsonl` (:213-249).

### D. What step 0 proved about the engine side (engineering-memory.md:1637-1698)

```
glue (node) ──JSON-RPC stdio──► Copilot engine (mode:"empty", env TZ, baseDirectory)
   │  createSession({sessionId, model, provider:{type:"openai",
   │     baseUrl:"https://openrouter.ai/api/v1", apiKey, wireApi:"responses"},
   │     mcpServers:{spine:{type:"http", url:<doorman>, headers:{Authorization:"Bearer <badge>"}}},
   │     onPermissionRequest, availableTools})
   │  session.send({prompt, mode, attachments}) / session.abort()
   │◄── events: assistant.message, assistant.usage{apiCallId}, session.idle, session.error …
   ▼
OpenRouter (model call)            doorman → Render (spine tools, 17 for a technician)
```

Measured in step 0:
- Technician session: 17 tools, as `spine-<tool>`. First-call prompt 5.7K tokens, against
  openclaw's ~30.5K.
- Engine RAM: 46–62 MB idle with 8 sessions; 116–124 MB with 1–8 concurrent turns.
- `apiCallId` **is** the OpenRouter generation id.
- On `wireApi:"responses"`, a trailing empty `assistant.message` appears about one turn in four.
- `send({mode:"immediate"})` steers only at a tool-call boundary. A plain double-text gets two
  replies.
- `abort()` → idle in 4–5 ms, with history kept.
- The engine stamps `<current_datetime>` in its own process timezone.
- Sessions resume after an engine restart.

The MCP wiring was tested on the laptop against the local stack, not through the real doorman →
Render hop.

## External Dependencies

### GitHub Copilot SDK `@github/copilot-sdk` 1.0.14

Read from the published tarball's type definitions (`npm pack @github/copilot-sdk@1.0.14`,
2026-09-22). `latest` = 1.0.14; `prerelease` = 1.0.15-preview.0. Dependencies are `zod`, `koffi` and
`vscode-jsonrpc`. It requires Node `^20.19.0 || >=22.12.0` (`package.json` `engines`); the box runs
node v22.23.1 at `/usr/local/bin/node` (`doorman-nemoclaw-setup-guide.md:243`).

**Client** (`dist/types.d.ts`):
- `CopilotClientOptions` (:248-414): `mode`, `baseDirectory` (sets `COPILOT_HOME`), `env`,
  `sessionIdleTimeoutSeconds` (in-memory cleanup; default disabled), and an experimental
  `requestHandler` that intercepts every outbound model request.
- `mode:"empty"` requires `baseDirectory` or `sessionFs`, plus `availableTools` on every session.
  It "flip[s] tool filter precedence to deny-wins" (:255-263).

**Session config** (`SessionConfigBase`, :1877-2444):

| Option | What it does |
|---|---|
| `model` | The model string |
| `provider` | The BYOK provider |
| `modelCapabilities` | Deep-partial override, e.g. `supports.vision` |
| `systemMessage` | `append`, `replace` or `customize` modes |
| `availableTools` / `excludedTools` | Tool filters |
| `mcpServers` | Remote MCP servers |
| `onPermissionRequest` | Per-call permission gate |
| `infiniteSessions` | Automatic compaction: background at 0.80 of context, blocking at 0.95 (:1528-1546) |
| `largeOutput` | Tool output over 51,200 bytes is written to a temp file and a reference returned (:1564-1580) |
| `toolSearch` | Tools are deferred behind search only above 30 total (:600-605) |
| `skipCustomInstructions` | Defaults to true in `"empty"` mode |
| `providers` / `models` | Experimental multi-provider BYOK |
| `sessionLimits` | Experimental |

**`ProviderConfig`** (:2528-2625): `type`, `wireApi` (default `"completions"`), `baseUrl`, `apiKey`,
`headers`, `modelId`/`wireModel`, `maxPromptTokens` (triggers compaction), `maxOutputTokens`.

**`MessageOptions`** (:2743-2805):
- `prompt`, `source`;
- `attachments`, including `{type:"blob", data, mimeType, displayName?}` (base64);
- `mode: "enqueue" | "immediate"` (default enqueue);
- `requestHeaders`, sent on the outbound model requests for that turn.

**`CopilotSession`** (`dist/session.d.ts`):

| Method | What it does |
|---|---|
| `send` | Sends a message |
| `sendAndWait` | Sends and waits; default timeout 60 s, which "does not abort in-flight agent work" (:154) |
| `on` | Subscribes to events |
| `getEvents` | Returns the session's events |
| `disconnect` | Keeps state on disk for `resumeSession` (:273) |
| `abort` | Stops the current turn (:296) |
| `setModel(model, {modelCapabilities?})` | "takes effect for the next message. Conversation history is preserved" (:298-330) |

The client also has `createSession`, `resumeSession(id, config)`, `deleteSession`, `listSessions`
and `stop` (`dist/client.d.ts:215-335`).

**Tools** (:484-592): a handler receives `ToolInvocation {sessionId, toolCallId, toolName,
arguments, signal?}`; the `signal` is "Aborted when the runtime completes this request or the
session disconnects". `Tool` accepts `skipPermission`, `defer`, `isTerminal`.

**Events** (`dist/generated/session-events.d.ts`):
- `assistant.usage` (:5270+) carries `apiCallId`, `model`, `inputTokens`, `outputTokens`,
  `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `cost`, `isByok`, `duration`. It is
  `ephemeral: true`: "not persisted to the session event log on disk".
- `model.call_failure` carries `apiCallId`, `statusCode`, `errorMessage` and a request
  fingerprint (image parts, tool calls).
- `model.call_finished`: one logical dispatch, which "may include internal reconnect or fallback
  work".
- `session.error` carries `errorType` and `statusCode`.
- `abort`, and `assistant.idle {aborted?}`.
- `session.compaction_start` / `_complete`.

### OpenRouter

- **Generation record:** `GET https://openrouter.ai/api/v1/generation?id=<id>`
  (openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation.md,
  read 2026-09-22).
  - Response `data` fields include `id`, `model`, `provider_name`, `total_cost`, `usage`,
    `upstream_inference_cost`, `tokens_prompt`, `tokens_completion`, `native_tokens_prompt`,
    `native_tokens_completion`, `native_tokens_cached`, `native_tokens_reasoning`,
    `cache_discount`, `is_byok`, `preset_id`, `session_id`, `external_user`, `created_at`,
    `latency`, `generation_time`, `finish_reason`, `provider_responses`.
  - Documented errors: 401, 402, 404 ("Resource not found"), 429, 500, 502.
  - The page says nothing about how soon after a call the record becomes readable.
- **Model fallbacks** (openrouter.ai/docs/guides/routing/model-fallbacks.md): a `models` array in
  priority order; "If the first model returns an error, OpenRouter will automatically try the next
  model in the list." Today's seats use the preset `@preset/trades-seats` (Gemini 3.8 Flash, then
  Muse Spark 1.3). Step 0 measured its fallback as sticky and invisible to the engine
  (engineering-memory.md:1658-1663).
- **Key:** `/etc/nemoclaw/openrouter.env` (`OPENROUTER_API_KEY`, 0600 root) on the box. The planner
  shares the same key (`doorman-architecture-memory.md:152-154`).

### Telegram Bot API (core.telegram.org/bots/api, read 2026-09-22)

- "There are two mutually exclusive ways of receiving updates for your bot - the getUpdates method
  on one hand and webhooks on the other."
- `getUpdates`: "This method will not work if an outgoing webhook is set up." `timeout` is in
  seconds, and 0 means short polling. "An update is considered confirmed as soon as getUpdates is
  called with an offset higher than its update_id."
- "Incoming updates are stored on the server until the bot receives them either way, but they will
  not be kept longer than 24 hours."
- `getFile`: "bots can download files of up to 20MB in size … https://api.telegram.org/file/bot<token>/<file_path>
  … valid for at least 1 hour … may not preserve the original file name and MIME type".
- `sendChatAction`: "The status is set for 5 seconds or less".
- `sendMessage` text: "1-4096 characters after entities parsing".
- `answerCallbackQuery` answers inline-keyboard presses.
- **Two pollers on one bot conflict.** This is recorded in-repo (`bootstrap-box.sh:191-193`,
  `recycle-sandbox.sh:183,194`) but not stated on the docs page.

### Render

The spine MCP (`TradesDatabase` web, a free-plan service with autoDeploy off; memory
`render-web-service-is-free-plan`), and `/control/*`.

## Constraints and Invariants

1. **Identity is established at the boundary, never from a tool argument** (`identity.ts:3-6`).
   Render trusts only a valid HMAC over `tenantId.technicianRef`, and only the box holds
   `GATEWAY_IDENTITY_SECRET`. A badge is only as good as its `badges.json` entry. Revoking it is
   instant because the file is re-read on every request (`doorman.mjs:43`).
2. **One poller per bot token.** s5's openclaw gateway must stop polling `@ragisan03_bot` before
   the glue starts, or both go deaf. `nemoclaw-agent-s5.service` has `Restart=always`
   (`bootstrap-box.sh:1710-1730`), so it revives the agent. `badge-pull.sh` restarts s5's container
   on a new badge (:101-144).
3. **The allowlist today lives inside openclaw** (`dmPolicy:"allowlist"` + `allowFrom`,
   `apply-binding.sh:58-76`). Messages from other ids are silently ignored. The source of truth is
   `technicians.telegram_user_id`, shipped to the box as `bindings[]` (`badgeFile.ts:85-95`). The
   glue has no allowlist of its own until it reads that.
4. **Bot tokens never live on Render** (`src/mcp/httpServer.ts:425-433`; migration
   `20260909120000:5-12`). s5's token is on the box in:
   - `/root/seats/s5.env` (0600 root);
   - the OpenShell provider store;
   - `~/.nemoclaw/sandboxes.json`.

   The pilot DB's `ops_secrets.bot_tokens` holds an operator-only copy that application code never
   reads.
5. **The box has no Supabase credential.** Everything goes to `/control/*` with `HOST_PULL_TOKEN`
   (`/etc/doorman/badge-pull.env`, 0600 root). There is no `/control` route for cost events,
   sessions or seat state. `cost_events` accepts inserts only from the service role
   (`cost_tables_rls.sql:21-22`).
6. **Cost rows are units, not dollars.** Dollars come from `cost_rates` at read time
   (`costs.ts:21-24`). The rollup INNER-joins rates, so a row with an unknown `(provider, sku)` is
   dropped from dollar totals. `MODEL_SKUS` is keyed by vendor, not model (`costs.ts:135-194`).
   `openrouter` maps to GLM-5.3 SKUs, while the Gemini and Muse rate rows exist unused
   (`20260906130000:40-48`). Idempotency comes only from a non-null `source_ref`
   (`cost_ledger.sql:94-95`); no model-cost writer passes one today.
7. **`assistant.usage` is ephemeral** (SDK types), so a glue that is down when the event fires
   loses that call's `apiCallId`. The generation record is the durable source, keyed by id.
8. **Step 0's four conditions** (engineering-memory.md:1689-1691, task notes):
   - `wireApi:"responses"`;
   - the served model and cost come from the generation record, never `assistant.usage`;
   - a double-text policy in the glue;
   - engine `TZ` = the firm's timezone.

   Also from step 0:
   - read the last *non-empty* assistant message;
   - photos need a `modelCapabilities` vision override (inferred from the types, untested);
   - honor `invocation.signal` in tool calls.
9. **Engine `TZ` is per process.** The firm timezone lives in `tenants.timezone`
   (`20260704210155:11`). Nothing sends it to the box today: `badgeFile.ts:13-17` entries carry
   only `tenantId` and `technicianRef`.
10. **Tool names change on the wire.** The engine presents MCP tools as `spine-<tool>`
    (engineering-memory.md:1678). The seat doctrine names them bare, e.g. `record_field_note`
    and `resolve_date` (`bootstrap-box.sh:710-753`, :1035-1074). Tool *descriptions* also carry
    doctrine (`captures.ts:92-117`).
11. **The doctrine is openclaw-shaped.** AGENTS.md blocks are appended by `bootstrap-box.sh wire`
    (:675-1305) into `/sandbox/.openclaw/workspace/AGENTS.md`. Blocks that assume openclaw:
    - the conversation-info UTC trap (:1057-1060);
    - isolated cron `agentTurn` jobs (:1101-1126);
    - `OFFICE QUESTION` turns injected via `--session-key main` (:1225-1305).

    The MCP server sends no `instructions` (`server.ts:916-920`). The glue therefore needs a system
    message from some source.
12. **Result sizes.** Spine results are capped at 20,000 characters (`resultCap.ts:16`). The SDK's
    `largeOutput` spill threshold is 51,200 *bytes*. Mostly-ASCII results stay under it; a result
    heavy in 3–4-byte characters could exceed it. In `mode:"empty"` the technician session has no
    file tool with which to read a spill file.
13. **Tool search.** The SDK defers MCP tools only above 30 (`types.d.ts:600-605`). The technician
    surface is 17. Memory `tool-search-hides-mandated-tools` records openclaw's tool search as OFF
    on all seats for that reason.
14. **The MCP side is stateless.** A fresh server per HTTP request (`httpServer.ts:985-986`). The
    doorman drops `mcp-session-id` on the spine branch (`doorman.mjs:64-70`). Any MCP session state
    lives only in the engine.
15. **L1 is append-only.** A `record_field_note` capture is permanent, stamped with the caller's
    `technicianRef` (`captures.ts:374`; `recordFieldNote.ts:256-263`). The glue's identity choice
    therefore decides whose name is on permanent rows.
16. **The runners depend on the sandbox.** `nudgeQueue.ts` and `officeQueue.ts` address items by
    `technicians.sandbox_ref`. The runners resolve that to a container. Items for a person with no
    `sandbox_ref` are skipped server-side (`nudgeQueue.ts:177,242,290`).
17. **The weekday and link guard is observe-only** (`plugins/trades-weekday-guard/index.js:13-21`).
    It runs as an openclaw hook, so it does not exist outside openclaw.
18. **Ben's roster state is `invited`** (engineering-memory.md:2873, as of 2026-08-24; a 2026-08-25
    note says his roster id had to be corrected, :7715-7720). The live values were not read for this
    document.

## Decision Points

Each is a fork the current code creates. The first four were named in the task notes; the rest
surfaced in this research.

1. **The double-text rule.**
   - The SDK folds a second text into a running turn only at a tool-call boundary. A plain
     double-text draws two replies (engineering-memory.md:1664-1668).
   - *Abort + resend:* on a second text during a turn, `session.abort()` (4–5 ms, history kept),
     then send both texts as one message. No added wait on single texts; costs a restarted model
     call.
   - *Short debounce in the glue:* hold each text N ms before sending, as openclaw does today with
     2000 ms (`bootstrap-box.sh:1571`). Every single text is delayed N ms.
   - *Enqueue:* send each text as its own turn. Two replies, the SDK's default.
   - Photos flush immediately under openclaw's debounce (`bootstrap-box.sh:1553-1558`). That rule
     would need restating for whichever option is chosen.

2. **Where s5's bot token lives for the glue.**
   - It is already on the box in `/root/seats/s5.env` (0600 root, `bootstrap-box.sh:321-331`), in
     the OpenShell provider store, and in `sandboxes.json`.
   - *Read `/root/seats/s5.env`:* the glue runs as root or gets a copy with its own ownership.
   - *A new file of the glue's own:* a second copy to keep in step with `seat-sync.sh`.
   - Moving tokens to Render reverses the "no bot token on Render" rule (Constraint 4) and is
     step 4's territory.

3. **Where the glue's code lives.**
   - *`src/` (TypeScript, typed, run by vitest):* reuses `src/db` types and the gates. But the box
     has no build step: bootstrap copies scripts, and npm is absent (step 0 used a tarball's npm
     under `~/copilot-sdk-test/.tools`). A compiled bundle or `dist/` would have to be shipped to
     the box.
   - *`Box_Setup_Stuff/` (plain `.mjs` like `doorman.mjs`):* deploys like the doorman (copy plus a
     unit). Tested the way `src/control/doorman.test.ts` tests the doorman: a test in `src/` spawns
     the box script.
   - The seven-copies drift trap applies to any file the box keeps a copy of (memory
     `bootstrap-copy-drift-trap`).

4. **Model fallback: the preset vs the glue's own.**
   - *Keep `@preset/trades-seats`:* no code. Its fallback is sticky and silent: one Google 504 moved
     2 of 4 sessions to Muse for good, at 3–10× the per-call price (engineering-memory.md:1658-1663).
     This is likely linked to open finding `20260920-seats-hit-all-models-are-temporarily-rat`
     (inferred).
   - *Glue-owned:* send `google/gemini-3.8-flash` direct. On a `model.call_failure` or
     `session.error`, `session.setModel("meta/muse-spark-1.3")` for the next message, then switch
     back later. The glue decides and logs the switch. Cost: a policy to write.
   - The generation record shows the served model either way, so cost rows are correct under both.

5. **Nudges and office messages to s5 after cut-over.** Both runners exec into s5's container
   (Data Flow B). The plan orders "office + nudges through the glue" as step 3, after step 1.
   - *Step 1 takes over s5's two queues:* the glue pulls `/control/office` and `/control/nudges`,
     with its own filter or a host split. It would need the bash runners to skip s5. Today both
     would pull the same items; Render serves per host, not per seat.
   - *Keep s5's container alive but not polling:* for delivery only. `openclaw message send` is a
     `sendMessage` call, which works without being the poller. But office injection would land in
     the container's session, not the glue's.
   - *Accept a gap:* Ben receives no planner questions or pushes until step 3. Those items report
     `failed` and Render's retry caps apply.

6. **The cost-row path.** The box cannot write `cost_events` (Constraint 5).
   - *A new `/control/costs` route on Render* (host token, body cap like `/control/metrics`'s
     64 KiB): the glue posts `{apiCallId, sessionId, technicianRef, …}`. Render fetches the
     generation record with its own OpenRouter key, or the box sends the record it fetched.
     Rows are keyed `source_ref = generation id`, which makes them idempotent.
   - *Render pulls later:* the glue reports only ids, and a lifecycle-heart step resolves them.
     This tolerates a generation record that is not ready yet (its delay is undocumented).
   - *Give the box a service-role key:* changes the custody model (Constraint 5).
   - Under every option, `MODEL_SKUS`'s single `openrouter` entry (GLM-5.3) cannot price Gemini or
     Muse rows. Either SKUs become per-model, or the row carries the generation record's
     `total_cost` in a form the ledger does not model today (it stores units only).

7. **Session ownership "in Supabase".** No table holds chat sessions. The only session concept is
   openclaw's `--session-key main` (`office_messages.via`, `20260903130000:9-12`).
   - *A new table plus a `/control` route:* the box cannot write the DB directly.
   - *The engine's own files on the box:* sessions persist under `baseDirectory` and resume after a
     restart. Ownership would be the glue's map from Telegram chat to session id, on disk.
   - Also open: when a technician session ends and a new one starts. The SDK's
     `sessionIdleTimeoutSeconds` frees memory only; state stays on disk. No openclaw
     session-rotation setting appears in `bootstrap-box.sh`.

8. **The badge the glue presents (phase 1: "through the doorman with s5's badge").**
   - s5's plaintext badge exists only inside s5's provider store and container (Data Flow C).
   - *Extract it from the provider store:* step 0 declined to do this unasked.
   - *Rotate s5's badge* (`rotate-badge` exists; memory `orphaned-sandbox-badge`): the new
     plaintext arrives in the next `/control/badges` pull. Today `badge-pull.sh` installs it into
     the container and restarts it (:101-144), so it would need to hand the badge to the glue
     instead.
   - *Skip the doorman:* the glue signs HMAC headers itself with `GATEWAY_IDENTITY_SECRET`. This is
     step 4's direction, but it would put the identity secret in the glue's process.

9. **The glue's allowlist.** openclaw enforces `allowFrom` today (Constraint 3).
   - *Hard-code Ben's id for the canary.*
   - *Read the binding from `/control/badges`'s `bindings[]`*, as `badge-pull.sh` does.
   - *Read `apply-binding.sh`'s output file* `/etc/doorman/bindings-applied.json`.

10. **The system message (doctrine).** The seat doctrine is AGENTS.md text generated by
    `bootstrap-box.sh wire` and openclaw-shaped (Constraint 11).
    - *Port the blocks* into a file the glue passes as `systemMessage` (`replace` or `append`).
    - *Rewrite for the new engine*, dropping the openclaw-only blocks and renaming tools to
      `spine-*`.
    - Either way, the `wire` copy and the glue's copy become two sources of the same rules while
      the other seats stay on openclaw.

11. **Photos (and voice).**
    - Parity with today is vision-only: `getFile` → download (≤20 MB, link ≥1 h) → `attachments:
      [{type:"blob", data, mimeType}]`, plus `modelCapabilities: {supports:{vision:true}}`. Nothing
      is stored.
    - Storing the photo durably (so `record_field_note`'s `blobPath` means something) needs an
      upload path. None exists for Telegram media (Data Flow A).
    - Voice notes: nothing in the repo configures speech-to-text for seats. openclaw's current
      behavior with a voice note is not recorded here.

12. **One reply or several.** openclaw sends one Telegram message per turn. The "two short messages"
    doctrine was ruled unreachable on that stack (memory `seat-agent-texts-like-a-person`). The glue
    owns delivery, so it can send each non-empty `assistant.message` as its own Telegram message.
    It can also split one message.

13. **Where the firm's timezone comes from for `env:{TZ}`.**
    - A value in the glue's config for the canary.
    - A new field in a `/control` response.

## Open Questions

- **The "$0.02 residual" in the gate.** Memory `openclaw-retirement-plan` sets the step-1 gate as
  "cost per turn read off usage vs the $0.02 residual". No line in the repo or its history pairs
  "residual" with a cost. The nearest measured figures:
  - $0.0207 per turn (tool-search experiment on s2, engineering-memory.md:3416);
  - $0.021 per call (Muse date eval, :7953, :8037);
  - $0.031 per question (Gemini, :8013).

  What $0.02 is measured against needs the operator.
- **How soon OpenRouter's generation record is readable after a call.** The docs page says nothing.
  Step 0 read records by hand after the fact.
- **Whether the engine forwards OpenRouter's per-user or per-session identifiers.** The generation
  record has `session_id` and `external_user`. `ProviderConfig.headers` and
  `MessageOptions.requestHeaders` exist, but which header or body field OpenRouter maps to those
  columns, and whether the responses wire carries a `user` field from the engine, is untested.
  Seat requests arrive at OpenRouter "untitled" today (engineering-memory.md:7934-7937).
- **Long-session behavior:** compaction (`infiniteSessions`) on a real technician session, and RAM
  with media. Step 0 used toy sessions of ≤2.3K tokens (engineering-memory.md:1672-1674).
- **Whether `mcpServers` headers survive `resumeSession`,** or must be re-supplied on every resume.
  `ResumeSessionConfig` extends the same base, and the SDK comments say some fields such as
  `managedSettings` and `additionalDirectories` must be re-supplied.
- **The real doorman → Render hop** under the engine's MCP client: step 0's wiring ran locally.
  Also whether the engine's MCP client sends an `Accept` header the stateless server accepts. The
  SDK server requires both `application/json` and `text/event-stream`, else 406.
- **Ben's traffic.** *Answered 2026-09-22 by the operator: there is none — "we're in a testing
  environment. There's no canary week. Ben is just a name and unless manual testing happen, there's
  no regular usage on that account." The gate must be a driven test.* Original question: the gate is
  "a week of Ben's traffic". Memory `ben-shelton-device-e2e` records
  device tests still owed on Ben's phone, and his roster state was `invited`. Whether s5 carries real
  technician traffic, or is driven by the operator, decides what a week of it proves. Volumes are
  not derivable from the pilot box (memory `never-size-from-the-pilot-box`).
- **Box-side consumers of seat state that would misread a missing s5 container.**
  - `box-report.sh` counts seats from `nemoclaw-agent-*.service` units (:455-463).
  - The medic's hourly probe runs "from inside a sandbox" (`nemoclaw-inference-medic.sh:42-43`); it
    is not established here which sandbox it uses.
  - The recycler and `badge-pull.sh`'s retirement queue act on `sandbox_ref`.
- **Doc drift noticed, not acted on:**
  - `nudge-runner.sh` and `office-runner.sh` headers say "every 5 min", but the timers run every
    10 s and 30 s.
  - `box-report.sh:86`'s watched-unit list omits `office-runner.*`.
  - `nemoclaw-tech-agent.md:98-105` describes a spine-only allowlist, but `wire` writes a 10-tool
    deny list.
  - `doorman-architecture-memory.md:372` says 14 technician tools; the code has 17.
  - `doorman-architecture-memory.md:118-124` says a badge swap needs no restart; `badge-pull.sh`
    restarts the container.
