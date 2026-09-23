---
date: 2026-09-23
branch: work/step-2-manager-seat-s2-on-the-seat-glue
commit: c655f91
topic: Step 2 of the openclaw retirement — the manager seat (s2) on the seat glue, with a sandbox vendor
supersedes: nothing (corrects §8 "sandbox vendors" of thoughts/shared/research/2026-09-21-seat-runtime-direction-openrouter-agent-sdk.md on three facts — see "Constraints" C1–C3; the rest of that document stands)
---

# Step 2: the manager seat on the seat glue

## Summary

The **seat glue** (`src/seatGlue/`) is the small program on trades-box-1 that step 1 built: it
long-polls one Telegram bot, hands each message to the **Copilot SDK engine** (GitHub's bought
agent loop, `@github/copilot-sdk` 1.0.14), and lets that engine call the **spine** (our Render MCP
server — MCP = Model Context Protocol, the standard way an AI model calls tools). Today it serves
exactly one seat, Ben's technician seat s5, and every part of it is technician-shaped: the
technician doctrine is hard-wired, only spine tools are allowed, and no local file or shell tool
exists. Step 2 moves the owner's **manager seat s2** (roster ref `manager-sam`, bot `@ragisan_bot`)
off openclaw onto the same glue, and grows it toward the operator's goal — a Claude-Cowork-like
manager agent that works for minutes, produces files (PDF invoices, spreadsheets), and asks before
anything irreversible. This document maps what exists today on each side of that move: the glue,
the spine's manager catalog, how s2 runs on openclaw now, the SDK hooks the task names (permission
requests, tool search, plan mode, custom tools), and the three candidate sandbox vendors as their
**live docs** describe them on 2026-09-23. The headline facts: nothing in the repo produces an
invoice document or an export file yet; the SDK already has the hooks the task needs (a
permission handler that can wait on a person, custom in-process tools, plan mode) but none is
wired; and the three vendors differ exactly on the step's gate — what survives when the sandbox
goes idle.

## Entry Points

| Entry | Where | What starts there |
|---|---|---|
| Glue process | `src/seatGlue/main.ts:74-107` | `node app/main.js` under `seat-glue@<seat>.service`; loads config, starts engine, runs `Seat` |
| Glue selfcheck | `src/seatGlue/main.ts:61-72` | `--selfcheck`: engine start + ping + stop (used by `install.sh:102`) |
| Local driver | `src/seatGlue/drive.ts:116-144` | scripted "technician" against the real engine, local stack only |
| Session config | `src/seatGlue/engine.ts:83-138` | everything the engine is told per session (model, doctrine, tools, MCP, permission handler) |
| Spine MCP | `src/mcp/httpServer.ts` fall-through (~`:983-988`) | every non-reserved path → `resolveIdentityFromHeaders` → stateless MCP server |
| Tool dispatch | `src/mcp/server.ts:594-735` | the real gates (tier, state, admin, inverse gates) |
| Catalog listing | `src/mcp/server.ts:940-955` | `tools/list`: `MANAGER_TOOLS` for an active manager, `TOOLS` otherwise |
| Composio relay | `src/composio/relayHandler.ts:481-585` | `/composio` path on the same Render host |
| Box install | `Box_Setup_Stuff/seat-glue/install.sh` → `cutover.sh` → (undo) `rollback.sh` | per-seat install, bot move, bot give-back |
| Office/nudge delivery (openclaw) | `Box_Setup_Stuff/nudge-runner.sh:95-150`, `office-runner.sh:88-131` | `nemoclaw <seat> exec` INTO the seat's container |

## Key Files

**The glue (`src/seatGlue/`, self-contained — imports only `node:*` and the SDK; `selfContained.test.ts` enforces it, `config.ts:6-8`)**

- `engine.ts` (164 lines) — the ONLY file that loads the SDK, through a non-literal specifier
  (`:5-12`) because the SDK is not a root dependency (Render would download the engine binary).
  Typed by small hand-written interfaces checked against the 1.0.14 `.d.ts` (`:14-48`).
  `startEngine` (`:68-81`): `mode:'empty'`, `baseDirectory`, an **env allowlist** of
  `PATH, HOME, LANG, TZ` only (`:73-76`) so the bot token, identity secret and OpenRouter key never
  reach the engine process. `sessionConfig` (`:83-138`) — see Data Flows. `openSession`
  (`:145-162`): resume by id, else create `<seatRef>-<epoch ms>`; a failed resume starts fresh.
- `seat.ts` (535) — one seat's loop. Updates handled one at a time (`:12-15`); offset saved BEFORE
  handling (at-most-once, `:131-150`, because a re-sent "file a note" duplicates L1). Photos → blob
  attachments, voice → transcribed text (`:174-201`). Holds model text until the model call ends
  without a tool request (`:364-377`, `:432-442`) — the only defence against Gemini narrating tool
  calls. Stop and `/new` wait for pending spine tools (`:258-323`, `:496-504`). `TEXT` constants
  are technician-worded (`:17-23`, "I can read texts, photos and voice notes.").
- `turnPolicy.ts` (177) — double-texting: idle → send; busy with a tool pending → steer
  (`mode:'immediate'`); busy without → abort then send only the new text (`:7-12`). A tool is
  "pending" from the **permission handler**, not from `tool.execution_start` (`:19-23`). Only
  `ask_team_lead` may be interrupted by Stop (`ABORT_SAFE_TOOLS`, `:35`).
- `doctrine.ts` (96) — `TECHNICIAN_DOCTRINE` (`:96`) = `SEAT_PREAMBLE` ("# Trades technician
  assistant", `:20-36`) + eight blocks copied verbatim from `bootstrap-box.sh`'s AGENTS.md heredocs
  (`:52-61`) + three sentence rewrites (`:77-90`). `doctrine.test.ts` fails on drift. The ported
  blocks already contain the manager branches ("YOU HAVE IT (manager seats)" — `record_caller`,
  `grant_access`, Composio connections).
- `config.ts` (93) — required env (`:26-36`); no tier, no vendor, no second MCP server. Model
  defaults to `@preset/trades-seats` (`:82`); state dir `/var/lib/seat-glue` (`:83`).
- `telegram.ts` (175) — Bot API client. Long polling with `allowed_updates:['message','callback_query']`
  (`:97`). The one inline keyboard is the Stop button (`:23`), posted on a "Working…" line that
  exists only while working (`:124-133`). `send` converts Markdown to Telegram HTML and falls back
  to plain text (`:109-122`). No `sendDocument` / `sendPhoto` / `editMessageReplyMarkup` method.
- `inbound.ts` (50) — allowlist: private chat from the one `allowedUserId` only (`:26-27`); a
  callback is accepted only when `data === 'stop'` (`:20`).
- `identity.ts` (21) — `signedHeaders`: HMAC-SHA256 of `${tenantId}.${technicianRef}` with
  `GATEWAY_IDENTITY_SECRET` — the same three headers the doorman stamps.
- `state.ts` (32) — `state.json` = `{sessionId, offset}` only.
- `costLog.ts` (165) / `costReport.ts` (79) — one JSONL line per model call, priced from
  OpenRouter's generation record (`/api/v1/generation?id=`), because the engine's own usage
  echoes the requested model and reports cost 0 (`costLog.ts:5-13`). `costReport` checks average
  cost per reply against $0.02 (`:5-8`, `:60`).
- `media.ts`, `voice.ts`, `format.ts`, `http.ts` — 7-day media copies with the path guard (a box
  path must never reach the model or L1, `media.ts:8-11`), transcription, Markdown→HTML, fetch seam.

**Box scripts (`Box_Setup_Stuff/seat-glue/`)**

- `package.json` — pins `@github/copilot-sdk` 1.0.14 and nothing else.
- `stage.sh` — builds `dist/seatGlue/*.js` (minus tests) + package files into a staging dir.
- `install.sh` — per seat; four non-secret settings in env (`:5-6`, `:22`) — **no tier setting**.
  Secrets assembled from files already on the box (`:73-76`): bot token from
  `/root/seats/<seat>.env`, identity secret + spine URL from `/etc/doorman/doorman.env`, OpenRouter
  key from `/etc/nemoclaw/openrouter.env`. Builds in `/opt/seat-glue.next`, selfchecks as
  `seatglue`, swaps in (`:98-107`). ONE code tree (`/opt/seat-glue`) serves every `seat-glue@*`
  instance (`seat-glue@.service:24`), and an upgrade restarts only the named seat (`:111-116`).
- `cutover.sh` — disable `nemoclaw-agent-<seat>` revive unit, put a dead token in the
  `<seat>-telegram-bridge` provider, stop the container, start the glue (`:5-16`); records the
  accepted office/nudge gap (`:23-26`).
- `rollback.sh` — reverse, restoring the real token from `/root/seats/<seat>.env`.
- `seat-glue@.service` — `User=seatglue`, `ProtectSystem=strict`, `ProtectHome=true`,
  `ReadWritePaths=/var/lib/seat-glue`, `PrivateTmp=true`, `RestartPreventExitStatus=3` (Telegram 409).

**The spine (Render)**

- `src/mcp/tools/types.ts:63-74` — each tool module declares tiers `base` / `admin` / `teamLead`.
- `src/mcp/server.ts` — `TOOLS` (`:105-…`), `ADMIN_TOOLS` (`:330-…`), `ADMIN_TOOL_NAMES` (`:458`),
  `SEAT_SHARED_TEAM_LEAD_TOOLS` (`:470`), `MANAGER_TOOLS` (`:499-503`), dispatch gates (`:594-735`),
  `tools/list` (`:940-955`, commented "cosmetic" — the gates are in dispatch).
- `src/mcp/tools/surface.expected.ts` — the independent name lists: technician 17 (`:26-44`),
  manager-only 29 (`:47-77`), manager catalog 45 (`:117-121`), planner-only (`:84-92`).
- `src/mcp/identity.ts:41-63` — `resolveIdentityFromHeaders`, timing-safe HMAC check.
- `src/mcp/tools/money.ts` — one tool, `record_money_event` (admin tier, `:30`, `:207-213`).
- `src/db/moneyEvents.ts` — append-only `money_events` ledger (`:92-186`), 13 kinds (`:11-29`),
  `summarizeMoney`, `syncJobStatusForMoney` (`:578-618`), `technicianMoneyView` (`:619-630`).
- `src/db/tenantProfiles.ts:195-235` — `profileGaps()`: the invoice-header fields a firm profile lacks.
- `src/mcp/tools/comms.ts:206-280` — `send_email`'s stage → `confirmId` (15-minute token) → send.
- `src/composio/sessions.ts:32-43` — per-person Composio sessions; manager = whole catalog +
  `manageConnections`, technician = three Gmail tools.
- `src/composio/relayHandler.ts:52-55`, `:481-585` — `/composio` relay, same HMAC identity.
- `src/composio/logIngest.ts:10-30` — manager Composio actions swept from Composio's logs into L1
  (classifier-free, keys-only for non-sends).
- `src/control/nudgeQueue.ts:110-…`, `src/control/officeQueue.ts:88-140` — delivery rows
  addressed by `technicians.sandbox_ref` + `telegram_user_id`.

## Data Flows

### A. One turn through the glue today (s5)

```
Telegram ──getUpdates──► Seat.handleUpdate (save offset first)
                             │ classify(): text | photo | voice | stop | /new
                             ▼
                        TurnPolicy.route() ── send | steer | abort-then-send
                             │
                             ▼
             EngineSession.send({prompt, attachments?, mode?})
                             │   (Copilot engine process, mode "empty")
                             ▼
          model call ──► OpenRouter (@preset/trades-seats, wireApi "responses")
                             │ tool request "spine-<tool>"
                             ▼
          onPermissionRequest {kind:'mcp', serverName:'spine', toolName, toolCallId, args}
             ├─ policy.onToolPending(id, name) ; return {kind:'approve-once'}
             └─ anything else → {kind:'reject'}
                             ▼
          HTTP MCP call ──► Render spine (signed x-tenant-id / x-technician-ref / x-identity-signature)
                             ▼
          events: assistant.message (held) · tool.execution_complete · assistant.usage (→ cost log)
                             ▼
          session.idle ──► held text released ──► TelegramClient.send (HTML, split at 4096)
```

Session config today (`engine.ts:83-138`): `model` = config model; `provider` = OpenRouter,
`wireApi:'responses'`, `maxPromptTokens:100_000`; vision on for jpeg/png; `largeOutput` off;
`systemMessage:{mode:'replace', content:TECHNICIAN_DOCTRINE}`; `availableTools:['mcp:*']`;
`toolSearch:{enabled:false}`; one MCP server `spine` (`timeout:300_000`, `tools:['*']`, signed
headers). Not set: `tools` (custom tools), `infiniteSessions` (SDK default = on), `workingDirectory`,
`onUserInputRequest`, `onElicitationRequest`, `onExitPlanModeRequest`, hooks.

### B. How the manager catalog is chosen

The glue sends no tier. The spine reads the roster row named by `x-technician-ref`
(`server.ts:620-627`); an active `manager` row gets `MANAGER_TOOLS` (45) on `tools/list` and passes
the admin gate in dispatch (`:705-707`). So the same glue code pointed at `SEAT_TECHNICIAN_REF=manager-sam`
already gets the manager catalog — step 0 observed exactly this (engineering-memory `:1695-1698`).
Managers are refused `get_schedule` (`:712`) and `search_captures` (`:721`) — the manager catalog is
technician 17 − those 2 + 29 admin + `record_caller` = 45.

### C. How s2 runs today on openclaw

```
Sam's Telegram ─► @ragisan_bot ─► openclaw container openshell-s2-*  (nemoclaw sandbox)
                                     │ AGENTS.md = bootstrap-box.sh wire blocks (tier-agnostic,
                                     │   manager branches inline); context window 262144 (manager)
                                     ├─► spine MCP  ─► doorman (badge → signed headers) ─► Render
                                     ├─► Composio MCP ─► doorman /composio ─► Render relay ─► Composio session (manager: whole catalog)
                                     └─► openclaw native tools minus a deny list (bootstrap-box.sh:1449);
                                         cron, process, edit, sessions_* kept (:1440-1445)
box timers ─► nudge-runner / office-runner ─► `nemoclaw s2 exec` INSIDE that container
```

Pilot roster (read 2026-09-23, SELECT only): `manager-sam`, tier `manager`, active, `sandbox_ref` s2,
`telegram_user_id` 5801703167, tenant `82bbc6f8-…`; `sandbox_pool` s2 bot `@ragisan_bot`
(`bot_id` 8952871389). The same Telegram user id is on Ben's s5 row (`ben-shelton`) — the operator
holds both seats through two different bots. Other managers on that tenant: s7 `yutao`, s8 `manager-joy`.

### D. Approvals today

All confirmations are **server-side**, not a harness feature: a staged tool returns
`{status:'needs_confirmation', confirmId}`, the seat shows the preview, and a second call with only
the `confirmId` executes (`send_email`: `comms.ts:206-280`, stored as a `review_items` row of kind
`pending_outbound_send`, 15-minute expiry). Doctrine names the two-step set: `send_email`,
`retract_capture`, `record_standing_fact`, `unschedule_visit` (placed only), `cancel_job`,
`add_technician_seat` (`doctrine.ts:54-55`). One-shot: `book_visit`, `move_visit`, `record_field_note`,
`record_money_event` (`money.ts:146`). Manager Composio actions have **no** server-side approval —
"disclosure + context-engineered confirmation" (`sessions.ts:27-29`) — only after-the-fact L1 capture.

### E. Office and nudge delivery (what breaks at cutover)

```
Render queues (sandbox_ref + telegram_user_id) ─► /control/nudges, /control/office
      ─► box runner ─► nemoclaw s2 exec -- openclaw message send   (nudges, person pushes)
                    ─► nemoclaw s2 exec -- openclaw agent --session-key main   (office turns)
```

After `cutover.sh s2` stops the container, every exec fails; rows report `failed` and freeze after
`MAX_DELIVERY_ATTEMPTS = 3` or `MAX_SERVE_COUNT = 10` (`nudgeQueue.ts:48-58`). For s2 this covers
more than for s5: inbound-call notices (`src/calls/notify.ts:10-29`, `kind:'call'`), access asks
texted to managers (`src/mcp/tools/access.ts:369`, `kind:'access'`), schedule pushes
(`src/telegram/boardNotify.ts:281`), and the office's "a customer got in touch" and caller-identity
notes that doctrine rule 7 expects "above in this chat". Other managers on the tenant (s7, s8) still
receive their own pushes — the fan-out is per manager row.

## External Dependencies

### Copilot SDK — `@github/copilot-sdk` 1.0.14 (pinned; latest release 2026-09-16; previews 1.0.15-preview.0/.1 exist)

Not installed in any repo `node_modules`; the copy read is in a step-1 scratchpad. `$SDK` = its
package root. Upstream: https://github.com/github/copilot-sdk (README permission section on `main`
is byte-identical to 1.0.14's).

| Hook the task names | What 1.0.14 provides | Cite |
|---|---|---|
| **Custom in-process tools** (run_command, read/write_file, share_file) | `defineTool(name,{description, parameters (zod or JSON schema), handler, skipPermission?, defer?, overridesBuiltInTool?, isTerminal?})`; handler `(args, invocation) => result`; `invocation.signal` aborts on completion/disconnect; result = string or `ToolResultObject {textResultForLlm, binaryResultsForLlm?: [{data (base64), mimeType, type:'image'\|'resource'}], resultType}` | `$SDK/dist/types.d.ts:484-578`, `:415-435`; `session.js:720-790` |
| Tool filters | `availableTools` / `excludedTools` with `builtin:*`, `mcp:*`, `custom:*`, `custom:<name>`; excluded wins; `mode:'empty'` REQUIRES `availableTools` | `types.d.ts:1995-2021`; `client.js:940-966` |
| **Permission handler** (→ Telegram buttons) | `onPermissionRequest(request, {sessionId})` may be async; SDK awaits it with **no SDK-side timeout**; a throw answers `user-not-available`. Kinds: `shell, write, read, mcp, url, memory, custom-tool, hook, …`. `mcp` carries `serverName, toolName, toolTitle, args, readOnly, toolCallId`; `custom-tool` carries `toolName, toolDescription, args, toolCallId`. Results: `approve-once`, `approve-for-session`, `approve-for-location`, `approve-permanently`, `reject {feedback?}` (feedback shown to the agent), `user-not-available`, `no-result` | `types.d.ts:947-979`, `:2131-2135`; `generated/session-events.d.ts:675`, `:7857-7895`, `:7991-8019`; `generated/rpc.d.ts:2617`, `:13543-14000`; `session.js:648-655`, `:811-846` |
| Resume with a pending approval | `ResumeSessionConfig.continuePendingWork` (default false = pending work treated as interrupted; true re-emits `permission.requested`) | `types.d.ts:2466-2480` |
| **Tool search** | `toolSearch {enabled?, deferThreshold?}`; above the threshold (default **30**) MCP and external tools are deferred behind `tool_search_tool`; per-tool `defer:'never'`; the search tool itself is overridable | `types.d.ts:540-546`, `:580-605` |
| **Plan mode** | session mode `interactive \| plan \| autopilot` via `session.rpc.mode.set` (experimental); per-message `agentMode`; `onExitPlanModeRequest({summary, planContent?, actions, recommendedAction}) → {approved, selectedAction?, feedback?}`; plan stored as `plan.md` in the session workspace; `exit_plan_mode` is a built-in in `BuiltInTools.Isolated` | `session-events.d.ts:78-84`; `rpc.d.ts:24776-24845`; `types.d.ts:1023-1051`, `:2196-2200`, `:2792-2796`; `toolSet.js:66-77` |
| Ask the user | `onUserInputRequest({question, choices?, allowFreeform?}) → {answer, wasFreeform}`; `onElicitationRequest` (form/url); async, no SDK timeout | `types.d.ts:739-822`, `:990-1022`, `:2143-2161` |
| Sessions | stored under `baseDirectory` (`COPILOT_HOME`) `session-state/{id}/` with `checkpoints/`, `plan.md`, `files/`; provider keys NOT persisted (re-supplied on resume); `sessionIdleTimeoutSeconds` off by default; `infiniteSessions` on by default (compaction at 0.80 / 0.95) | `types.d.ts:272-278`, `:386-393`, `:1528-1546`, `:2461-2486`; https://github.com/github/copilot-sdk/blob/main/docs/features/session-persistence.md |
| Attachments to a message | `file`, `directory`, `selection`, `blob` | `types.d.ts:2754-2786` |
| MCP servers | per-session `headers`, `timeout` (ms; default not stated in types or https://github.com/github/copilot-sdk/blob/main/docs/features/mcp.md) | `types.d.ts:1403-1449` |

No tool-search or plan-mode measurement exists in either step-0 or step-1 findings.

### Sandbox vendors (live docs, 2026-09-23)

| | **Google Agent Platform — Code Execution sandbox** | **Vercel Sandbox** | **E2B** |
|---|---|---|---|
| Status | Announced "now in Preview" ([release notes](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/release-notes)); no GA note found. The separate **Shell sandbox** + pause/resume went GA 2026-09-09 ([release notes](https://docs.cloud.google.com/gemini-enterprise-agent-platform/release-notes)) | GA ([docs](https://vercel.com/docs/vercel-sandbox)) | GA; pause-refused error being rolled out region by region ([persistence](https://docs.e2b.dev/sandbox/persistence.md)) |
| Create / address / reconnect | Needs an Agent Platform instance first (`client.runtimes.create()`); sandbox = resource name `projects/…/reasoningEngines/I/sandboxEnvironments/S`, `sandboxes.get(name)` ([quickstart](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/code-execution-quickstart), [REST](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.reasoningEngines.sandboxEnvironments)) | user-set `name` per project; `Sandbox.get({name})` / `getOrCreate({name, onCreate, onResume})` from any process ([SDK ref](https://vercel.com/docs/sandbox/sdk-reference), [persistent](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)) | `sbx.sandboxId`; `Sandbox.connect(id)` resumes a paused one; "save the sandbox ID in your database" ([connect](https://docs.e2b.dev/sandbox/connect.md)) |
| Idle / lifetime | No idle sleep documented; TTL up to 14 days, each `execute_code` resets it; REST says no TTL = never auto-deleted ([overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/code-execution-overview)) | session timeout default 5 min, extendable to 45 min (Hobby) / 24 h (Pro) per session; lifetime across sessions unbounded ([pricing](https://vercel.com/docs/sandbox/pricing)) | default timeout 5 min and default `onTimeout:'kill'` — "state is gone"; `lifecycle:{onTimeout:'pause', autoResume:true}` pauses instead ([lifetime FAQ](https://docs.e2b.dev/faq/sandbox-lifetime.md), [auto-resume](https://docs.e2b.dev/sandbox/auto-resume.md)) |
| What survives idle | Memory/state kept between calls within TTL; snapshots "not supported for Code Execution" ([snapshots](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/manage-snapshots)) | **filesystem only** — auto-snapshot at stop/timeout; processes do not survive, `onResume` restarts them ([snapshots](https://vercel.com/docs/sandbox/concepts/snapshots)) | with pause: filesystem **and memory** incl. running processes; pause ≈4 s/GiB, resume ≈1 s; paused kept indefinitely, unbilled |
| Run a command | `execute_code({code, files})` → output chunks (`msg_out`/`msg_err`, file chunks); Python or JavaScript only; no exit code / background job documented; ≤100 MB files per call | `runCommand` → `exitCode`, `stdout()`, `stderr()`; `detached:true` + `logs()`/`wait()` | `commands.run` → `exitCode`, `stdout`, `stderr` (throws on non-zero); `background:true`, reattach by pid; per-command timeout default 60 s |
| Files in/out | files ride in the request/response chunks | `writeFiles`, `readFileToBuffer`, `downloadFile`, `sandbox.fs` | `files.write`, `files.read({format:'bytes'})`, pre-signed URLs with `secure:true` |
| Runtimes / libraries | fixed set incl. openpyxl, XlsxWriter, reportlab, fpdf, pandas; **no pip install, no network** ([overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/code-execution-overview)) | Ubuntu, Node LTS, Python 3.14, root; custom OCI images; `networkPolicy` default `allow-all` | template `code-interpreter` has openpyxl, pandas; reportlab needs pip (runtime pip works); internet on by default, `allowInternetAccess:false` or allow/deny rules ([network](https://docs.e2b.dev/network/internet-access.md)) |
| Node SDK | none documented (Python SDK; REST is language-neutral) | `@vercel/sandbox` 3.5.0 | `e2b` 2.51.0 |
| Price | $0.085/vCPU-h + $0.009/GiB-h, per second, **billed while the sandbox exists**; free tier 50 vCPU-h + 100 GiB-h/month ([pricing](https://cloud.google.com/products/gemini-enterprise-agent-platform/pricing), [manage](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/manage-sandboxes)) | iad1: active CPU $0.128/h (only while using CPU), memory $0.0212/GB-h (1-min minimum), snapshots $0.08/GB-month; Hobby includes 5 CPU-h | $0.0504/vCPU-h + $0.0162/GiB-h while running; paused unbilled; Hobby $0 + one-time $100 credit; Pro $150/mo ([price calc](https://docs.e2b.dev/faq/calculate-sandbox-price.md), [pricing](https://e2b.dev/pricing)) |
| Auth from a plain VM (the Lightsail box) | Application Default Credentials / GCP service-account credentials (not stated for non-GCP hosts explicitly) | access token `VERCEL_TOKEN` + team id + project id ("Non-Vercel hosting"); a Vercel project must exist ([auth](https://vercel.com/docs/sandbox/concepts/authentication)) | one API key, any host ([api key](https://docs.e2b.dev/api-key.md)) |
| Region | us-east1 among others; `us`/`eu` multi-region for Code Execution | 19 regions | GCP `us-west1` default |

## Constraints and Invariants

**Corrections to the 2026-09-21 direction doc §8 (lines 265–270), from the live docs above:**
- **C1.** "Google Code Execution: idle between turns not billed" is wrong for sandboxes — that
  sentence on the pricing page is scoped to *Runtime*; sandboxes "are billed while they exist".
- **C2.** §8 omits that Google Code Execution has **no network and no library installs**, and no
  snapshots. "Usable without deploying an agent" is true, but an Agent Platform instance must exist.
- **C3.** §8's Vercel line had no citation (the rates hold for iad1 on Pro); "resumable" restores
  the filesystem only. E2B was "not checked" there; its default timeout **kills** the sandbox.

**Glue invariants the manager seat inherits:**
1. **One poller per bot.** A second poller makes both deaf; the glue exits 3 on a 409
   (`telegram.ts:4-7`, `main.ts:17-21`). s2's openclaw container must lose its token first (`cutover.sh`).
2. **Offset before handling** (`seat.ts:131-150`) — at-most-once, because L1 has no delete.
3. **Never abort mid-tool** except `ask_team_lead` (`turnPolicy.ts:30-35`; `seat.ts:269-275`). The
   "pending" signal comes from the permission handler (`turnPolicy.ts:19-23`, `engine.ts:129-132`);
   any new tool kind that bypasses `onToolPending` is abortable mid-call by Stop/double-text.
4. **The permission handler is the only allowlist.** Everything that is not a spine MCP call is
   rejected (`engine.ts:124-136`), and it is also the turn policy's timing signal.
5. **Engine env allowlist** — secrets never reach the engine process (`engine.ts:73-76`).
6. **Held text** — text from a model call ending in a tool request is never sent (`seat.ts:364-377`);
   a long multi-step job produces no chat output until a call ends without a tool.
7. **Self-contained** — nothing in `src/seatGlue` imports another `src/` module (`config.ts:6-8`).
8. **One code tree for all seats** on the box (`seat-glue@.service:24`); an upgrade for s2 changes
   s5's code on its next restart.
9. **`seat-glue@.service` sandboxing** — `ProtectSystem=strict`, writable only `/var/lib/seat-glue`
   (`:28-33`); any local file work would live under the seat's state dir.
10. **Media path guard** — a box path must never reach the model or an L1 row (`media.ts:8-11`).

**Spine / record invariants:**
11. Tier is decided server-side from the roster row; the listing is cosmetic, dispatch gates are
    real (`server.ts:594-735`, `:940-955`).
12. `money_events` is append-only; corrections are new rows (`moneyEvents.ts:92-186`).
13. Outbound/agent-action captures are classifier-free and keys-only for non-sends (CLAUDE.md
    2026-07-04 exception); a file the manager's agent shares or sends would fall under that rule
    if captured.
14. Spine results are capped at 20,000 chars (step-1 research constraint 12, `resultCap.ts:16`);
    `largeOutput` is off in the glue because there is no file tool to read a spill (`engine.ts:101-103`).
15. `query_spine` is the managers' free-form read; its date rules (resolve_date) are doctrine.

**Measured, binding (step 0 / step 1):** `wireApi:'responses'` (completions lost reasoning after tool
calls); cost from the generation record only; engine TZ per firm; manager first-call prompt **17.8K
tokens** vs technician 5.7K bare (engineering-memory `:1698`); technician live prompt ~16K with
doctrine, $0.0225/reply live; a manager turn ≈ $0.05 on openclaw (direction doc `:126-127`); the
preset's Muse fallback is sticky and silent (2 of 4 sessions, 3–10× price); abort reaches idle in
4–5 ms. Openclaw's tool search, measured on s2: 32–139 s per turn and $0.06–0.077
(`bootstrap-box.sh:1470-1478`) — openclaw's, not the SDK's.

## Decision Points

1. **Sandbox vendor.** The gate is "an invoice job that outlives the sandbox's idle sleep", and the
   three differ on what survives:
   - *Google Code Execution* — no idle sleep at all (TTL up to 14 days, reset per call), memory kept
     between calls; but Python/JS snippets only, fixed libraries (openpyxl/reportlab are there), no
     network, no exit codes or background jobs, billed while it exists, Preview, no Node SDK (REST
     from the glue). The Shell sandbox (GA) adds bash + installs but is a different API.
   - *Vercel Sandbox* — full Ubuntu + root, Node SDK, named reconnect; idle = filesystem snapshot,
     processes die; needs a Vercel project and token; bills active CPU only.
   - *E2B* — Node SDK, one API key, pause keeps memory and processes, paused is free; but the
     DEFAULT is kill-on-timeout, so `onTimeout:'pause'` must be set on every create; reportlab needs pip.
2. **Where the file tools come from.** (a) *Custom in-process tools* (`defineTool` in the glue,
   calling the vendor SDK from the box) — the glue keeps its env allowlist, the permission handler
   sees `kind:'custom-tool'` with args; or (b) *the engine's native built-ins* (`builtin:*` shell/
   write/read) — these act on the BOX's filesystem where the engine runs, so they only reach a
   sandbox if the engine itself runs inside it (Vercel/E2B only; sessions would then live there).
   Today `availableTools:['mcp:*']` excludes both.
3. **Approval surface.** The permission handler can await a Telegram tap (no SDK timeout found) —
   but today the spine's own two-step `confirmId` already gates `send_email`, `cancel_job`, etc.
   Options: buttons for the *new* kinds only (custom tools / Composio), buttons replacing the chat
   "yes" for the existing `confirmId` tools, or both. A button press arrives as a `callback_query`;
   `inbound.ts:20` accepts only `stop` today, and there is no `editMessageReplyMarkup` in `telegram.ts`.
   Whether the ENGINE (the bundled binary) times out a permission left pending for minutes is unverified.
4. **Composio from the glue.** s2 on openclaw has the Composio relay; the glue has no second MCP
   server and the permission handler rejects any non-`spine` server. Adding it = a second
   `mcpServers` entry at `<render>/composio` with the same signed headers, plus admitting that
   server name — and its actions would go through the same permission handler (Decision 3).
5. **Doctrine for the manager.** `TECHNICIAN_DOCTRINE` is hard-wired in `engine.ts:109`. The ported
   blocks already carry manager branches; what differs is the preamble ("Trades technician
   assistant") and the blocks the port dropped ("Long or bulk tasks", "Scheduled / recurring work"),
   which are exactly the Cowork-shaped ones. Options: a tier setting that picks a second preamble
   over the same blocks, or a separate manager doctrine; drift-test implications either way
   (`doctrine.test.ts` pins the port).
6. **Tool search for 45 tools.** Off today (`engine.ts:111`). Off = all 45 schemas every call
   (17.8K-token first call, before doctrine and before any new file tools). On = the SDK defers
   above 30 behind `tool_search_tool`; per-tool `defer:'never'` can keep the mandated ones
   (`resolve_date`, `record_field_note`) loaded. The memory "tool search hides mandated tools" is
   from openclaw; no SDK measurement exists.
7. **Plan mode as the managers' default.** The SDK has it (experimental RPC + `onExitPlanModeRequest`),
   and its approval could be a Telegram button like any other. Default-on adds a round-trip before
   every long job; off leaves it to doctrine.
8. **Seat memory.** Nothing exists for seats (the glue's `state.json` is two fields; SDK `memory` is
   off in empty mode). The planner's `planner_memory` .md store (`src/db/plannerMemory.ts`) is the
   one existing model: a new table on Render reached by a spine tool, vs files in the sandbox, vs
   the engine's own session workspace.
9. **Getting a file to the manager.** Telegram's `sendDocument` is not in `telegram.ts`. Options:
   the glue downloads from the sandbox and sends the bytes as a document, or the file goes to
   storage (Supabase Storage is the named future home for media) and a link is sent. Whether an
   invoice PDF is also recorded (L1 is permanent; `blob_path` must never be a box path) is open.
10. **Export and invoice verbs on the spine.** Nothing produces a document today; the ledger and
    `tenant_profiles` letterhead exist; `2026-08-15-invoice-creation-v1.md` (draft, drift 82)
    proposed `@react-pdf/renderer` on Render + an `invoices` table + `INV-1001` numbering. Options:
    the spine returns *data* (rows, the ledger summary, the letterhead) and the sandbox renders the
    file; or the spine renders the file itself; and whether issuing an invoice writes an
    `invoice_issued` ledger row.
11. **The office/nudge gap for s2.** Same trap as s5 (decision 5 = C), but wider: call notices,
    access asks and the office's "open the job?" asks all ride it, and those are what the manager-only
    tools (`record_caller`, `grant_access`) exist to answer. Options: accept until step 3 (s7/s8 still
    receive theirs), or land step 3 first / together.
12. **Box packaging.** `install.sh` takes no tier and the unit has one code tree. The vendor's SDK
    (and key) would be a second dependency in `Box_Setup_Stuff/seat-glue/package.json` and a new
    secret in the env file (`install.sh:73-93`).

## Open Questions

1. Does the Copilot engine binary time out a permission request that stays pending for minutes
   (a manager away from the phone)? The SDK has no timeout; the binary's behaviour is untested.
2. Does `/root/seats/s2.env` hold s2's real bot token on trades-box-1 (install.sh reads it)?
   Written by `seat-sync.sh`, not verified for s2.
3. Does Google Code Execution support pause, and what does an idle Code Execution sandbox cost per
   day at the default machine size? Docs say "billed while they exist" but not whether pause applies.
4. E2B's default RAM is 512 MiB in the docs and 4 GiB on the pricing page — which applies to a
   code-interpreter sandbox?
5. How does the manager's 17.8K-token catalog prompt grow with the manager doctrine and four file
   tools added, and what does a manager reply cost on the glue (no measurement exists)?
6. Does Gemini 3.8 Flash through OpenRouter hold a multi-minute, many-tool job without the
   narration hold starving the chat (no output until a tool-free call)?
7. Does compaction (`infiniteSessions`, on by default) behave on a long manager session with file
   results in history? Step 0 did not test compaction.
8. Where does the manager's Composio-connected output (a Google Sheet) meet a sandbox file — does
   the file travel through the glue, or does the sandbox reach Composio directly (and with whose
   credential — the doctrine says the seat never holds one)?
9. The operator holds s2 and s5 with one Telegram id through two bots — any interaction between the
   two glue instances (separate bots → separate pollers) needs confirming only if a shared state dir
   were ever used; the unit gives each seat its own.
