---
date: 2026-09-21
branch: worktree-deny-openclaw-dev-toolkit-on-the-seats
commit: fc40c65
topic: The seat-runtime direction — manager seats become Claude-Cowork-like agents with the firm's data. Records the whole 2026-09-21 brainstorm with every vendor fact and citation: the morning's choice (OpenRouter Agent SDK on a Render worker, box retired), dropped that night; the evening's direction (a BOUGHT harness on the Lightsail box, GitHub Copilot SDK first to test, sandboxes from a vendor for managers, technicians thin, Render stays the spine, Telegram stays the UI), of which only step 0, the two-hour test, is decided.
supersedes: nothing
---

**Read this before touching the seat stack.** It records a day of operator decisions
(2026-09-20/21) and the evidence behind them, so the next session does not re-derive the vendor
research or build on the stack that is being replaced. The live half of this work is the board:
task `20260922-step-0-two-hour-test-of-the-github-copil` (parked 2026-09-21, not yet spawned). The
morning's task for a Render-hosted seat was dropped and archived the same night, its worktree and
branch removed.

> **REVISED THE SAME DAY.** Sections 2, 5 and 6 below record a direction chosen on the morning of
> 2026-09-21 (seats on a Render worker via the OpenRouter Agent SDK, box decommissioned) and
> **dropped that night** by the operator ("get rid of the openrouter sdk tasks and it's related
> memory"). The current direction is in §8: the box stays as the agents' home, Render stays the
> spine, the harness is BOUGHT (GitHub Copilot SDK, first to test), sandboxes come from a vendor on
> demand for managers, technicians stay thin, Telegram stays the UI. Only step 0 (the two-hour
> test, task `20260922-step-0-two-hour-test-of-the-github-copil`) is decided. Sections 3 (OpenRouter
> Agent SDK facts) and 4 (Render facts) remain correct as reference.

## 1. The goal, in the operator's words

- "For technician seats, it is a simple chat agent. For manager seats, it should aim to be claude
  cowork with access to the firm's data." (2026-09-20)
- "Remember, the goal is to have claude cowork like agents for managers." (2026-09-21)

Cowork-like, as carried in the spawned task: a manager hands the seat a task and it works for
minutes, not one turn — pulls the firm's data from the spine, produces files (PDF invoices,
CSV/XLSX exports), reaches connected apps through Composio (Gmail, Excel, Sheets), runs on a
schedule, remembers preferences, confirms before anything irreversible or externally visible,
never holds a credential, is capped per session. It works between the spine and connected apps in
one run — the gap the openclaw design could never close, because file work lived in a sandbox the
Composio rail could not see. The operator's example: "accounting work that includes quite a bit
of data for the year, and they want it on an excel spreadsheet."

The technician seat is not this: a capture channel plus a few reads ("we only need them as data
input channels"). Bulk work is a manager thing.

The constraint the goal lives under: cost. Claude was rejected on price, not capability ("The
issue I have with claude is the cost"). Gemini 3.8 Flash primary with Muse fallback stays.

## 2. The decision and why

**Operator, 2026-09-20: "Ok, let's just switch to the agent sdk."** Three hosted options were
compared on one question: who supplies each piece of a Cowork-shaped runtime.

| piece | Anthropic Managed Agents | Google ADK + Agent Runtime | OpenRouter Agent SDK |
|---|---|---|---|
| Telegram in/out, approval relay, Composio as tools | ours | ours | ours |
| schedules | hosted | ours (Cloud Scheduler is separate) | ours (existing cron/worker) |
| the loop process | hosted | hosted | **ours, on Render** |
| sessions store | hosted | hosted | ours (Supabase table via `StateAccessor`) |
| memory across chats | hosted | hosted (Memory Bank) | ours |
| code sandbox + files | hosted | hosted | **hosted** (`openrouter:shell`, containers) |
| model | Claude only | Gemini only, no fallback | any, with a native `models` fallback array |

Why Agent SDK: the technician seat's thin loop on Render is the same worker, sessions table and
Telegram path the manager seat needs, so Agent SDK for managers is one runtime while Google would
be a second; Gemini + Muse fallback survives; one bill, with Workspaces for per-lane limits; if the
0.x SDK stalls, the state is ours and the loop library is a contained swap. Rejected: Anthropic
Managed Agents (closest to Cowork — sandbox, MCP, Skills, scheduled deployments, tool confirmation,
vault credentials, session budgets — but Claude-only; cost), Google (Gemini-only, no fallback,
`@google/adk` 2.1 TypeScript is young, and the 2026-08-24 "high demand" 503s were the AI Studio
free tier — Vertex is the production door, with DSQ/Provisioned Throughput), LangGraph Platform
(any model, durable + cron + HITL, no sandbox, graph model, per-seat pricing), Mastra.

"Hosts nothing but the sandbox" — a phrase used during the comparison — meant only which computer
runs the loop. It says nothing about capability: the loop on our worker holds spine tools,
Composio and the hosted sandbox in one `tools` array, which is exactly what makes the invoice job
one run.

## 3. Verified: the OpenRouter Agent SDK (from the package, 2026-09-20)

`@openrouter/agent` 0.11.0, published 2026-08-22, depends on `@openrouter/sdk ^0.13.7` and
`zod ^4`. Read from the tarball, not the docs:

- `esm/lib/tool-types.d.ts:700` — `export type Tool = ClientTool | ServerToolBase;` with the
  comment "Union of every tool kind accepted by `callModel({ tools: [...] })`: client
  function/generator/manual tools, or OpenRouter server tools."
- `:644` — `ServerToolConfig = Exclude<models.ResponsesRequestToolUnion, {type:'function'}>`, i.e.
  the server-tool list is inherited from the pinned core SDK. `@openrouter/sdk` 0.13.67 (the
  latest `^0.13.7` resolves to) already names `openrouter:shell` and `openrouter:bash`; so does
  1.3.8 (published 2026-09-20). Runtime passes the config through untouched
  (`esm/lib/tool-executor.js:79` returns `tool.config`; `tool-set.js:26` ids it `server:<type>`).
  **So spine tools + Composio + the hosted shell sit in one typed `tools` array, no cast.**
- `callModel` options (https://openrouter.ai/docs/agent-sdk/call-model/api-reference.md):
  `model: string | (ctx) => string` OR `models: string[]` (fallback array; one or the other),
  `tools: Tool[]`, `plugins`, `provider: ProviderPreferences`, `sessionId`; stop helpers include
  `maxCost(amount)`.
- Human-in-the-loop (https://openrouter.ai/docs/agent-sdk/call-model/tool-approval-state.md):
  `requireApproval: true` → `result.requiresApproval()` / `getPendingToolCalls()` → resume with
  `approveToolCalls: [ids]` / `rejectToolCalls`. State is a `ConversationState` persisted through a
  `StateAccessor` (`load()`/`save()`) — "Redis, a database, or file storage". The Responses API is
  stateless: "each request being independent and no server-side state persisted"; `store` /
  `previous_response_id` are rejected with 400.
- Async tools (https://openrouter.ai/docs/agent-sdk/call-model/async-tools.md): background
  (in-process) or deferred — "the conversation pauses (`status: 'awaiting_async_tools'`) until any
  process completes the task"; the SDK injects a `task` tool; deferred survives a restart,
  background does not.
- Doom-loop detection (https://openrouter.ai/docs/agent-sdk/call-model/doom-loop-detection.md):
  off by default (`doomLoop: true`); reactions observe / steer / escalate to a stronger model /
  block / stop. It also watches server-tool repeats.
- Server tools (https://openrouter.ai/docs/guides/features/server-tools): "Server tools and
  user-defined tools can be used in the same request." Request shape `{ type: 'openrouter:shell',
  parameters: { engine: 'openrouter', environment: { type: 'container_auto' } } }`
  (https://openrouter.ai/docs/guides/features/server-tools/shell.md). Also `openrouter:subagent`
  ("delegate self-contained tasks to a smaller, faster worker model"), `openrouter:advisor`
  ("consult a stronger model for guidance mid-generation"), `openrouter:tool_search`,
  `openrouter:files`, `openrouter:memory` (unverified beyond the type name).
- Containers (https://openrouter.ai/docs/guides/features/containers.md,
  https://openrouter.ai/blog/announcements/shell-tool/): "any model on OpenRouter can now run
  commands in a hosted Linux container"; with a session id the container id is `sess_` + session
  id and all requests sharing it share one container; "A container sleeps after 5 minutes idle.
  This is not configurable." — open processes, env vars and installed state are not restored on
  wake; "Container files are kept for 30 days" after last use; "By default, a container has no
  outbound internet access" (`network_policy` allowlist, ≤50 domains, `["*"]` for open); command
  timeout default 120 s, max 300 s; output default 16,384 chars, max 65,536; ≤100 commands per
  call. Files out: "Each shell result lists the files the command touched, with a `cfile_` id for
  each"; `GET /api/v1/containers/{id}/files`, download endpoint, and
  `POST /api/v1/containers/{id}/files/{file_id}/promote` → permanent `or_file_` workspace document.
- Price: "$0.0001 per active second"; "We bill a minimum of 30 seconds when a request starts a
  cold container" — a billing floor, not a wait. A five-minute job ≈ $0.03, next to a manager
  turn measured at ≈ $0.05 in Gemini tokens (2026-09-20 census).
- Workspaces (https://openrouter.ai/docs/guides/features/workspaces): "Every API key lives in a
  workspace"; "daily, weekly, monthly, or lifetime spending limits per workspace"; "unified billing
  across all workspaces" — limits are isolated, the credit pool is not.
- Not offered: hosted sessions, memory, schedules, or a hosted loop. "Ori"
  (https://openrouter.ai/docs/guides/ori/harness) is a local CLI harness, not a runtime.

## 4. Verified: Render, where the loop will run (2026-09-20)

Measured through the Render API (workspace `tea-d69903h5pdvs738dm81g`), last 24 h:

| service | plan | RAM used of 512 MB | CPU used of limit |
|---|---|---|---|
| `TradesDatabase` web (srv-d8uqmdegvqtc73bfn83g: spine MCP over HTTP + every webhook + admin) | **free** | 130–195 MB | ≈2% of 0.15 |
| `Board_Worker` (srv-d9dr8iurnols73d1tjq0) | starter | 85 MB | <0.2% of 0.5 |

A seat turn's in-memory state is the conversation, under 1 MB; the 415 MB/turn figure in earlier
memory was openclaw's Docker sandbox, which no longer exists on our side. Compute is not the risk.
The platform behaviours are:

1. **Free web services sleep.** "spins down a Free web service that goes 15 minutes without
   receiving any inbound traffic"; spin-up "about one minute"; "750 Free instance hours" per
   workspace per month, and over that Render "suspends all of your Free web services until the
   start of the next month" (https://render.com/docs/free). Today the Lightsail box's five-minute
   timers (badge-pull, nudge-runner, office-runner) are what keep the web service awake; retire
   the box and every webhook pays a cold minute. There is a second free web service in the
   workspace (`agent-mediation`), sharing the 750 hours. **Move the web service to Starter before
   the box goes.**
2. **Deploys kill in-flight work.** "After 60 seconds, Render sends a `SIGTERM` signal to your
   app's process on the original instance"; SIGKILL after the shutdown delay, default 30 s,
   `maxShutdownDelaySeconds` max 300 (API or `render.yaml`); applies to "web services, private
   services, background workers, and cron jobs" (https://render.com/docs/deploys). So: persist
   loop state after every step; on SIGTERM stop taking turns; the new instance resumes from the
   table.
3. **One process, one blast radius.** Every seat shares one Node process: an error boundary per
   loop, a process-level rejection handler, resume-from-table.
4. **Seats and webhooks in separate services.** Telegram and Composio expect a fast ack; seats run
   as their own background worker fed by a queue table.
5. **Scaling:** "Manual scaling is available for all Render workspaces" (up to 100 instances);
   "Autoscaling requires a Pro workspace plan or higher" (https://render.com/docs/scaling). A
   second instance needs a claim column on the session.

Plans (https://render.com/pricing): Free 512 MB / 0.1 CPU $0; Starter 512 MB / 0.5 CPU $7; Standard
2 GB / 1 CPU $25; Pro 4 GB / 2 CPU $85. Background workers start at Starter. After the move Render
rises by two Starters ($14/mo) and the Lightsail box goes.

## 5. What openclaw provides today, and what replaces it

Nothing in `src/` calls the openclaw gateway at runtime — the box pulls from Render's control
queues, never the reverse — so the Render side barely changes. Every service on the box exists
only to keep seats inside openclaw sandboxes:

| because … | services | after |
|---|---|---|
| seats are openclaw agents | openshell-gateway, gateway-heal, nemoclaw-boot, nemoclaw-inference-medic, bootstrap-box.sh (+7 copies), deny lists, weekday-guard plugin, device pairing | the worker; the weekday guard returns as a loop hook |
| seats live in Docker sandboxes | sandbox-token-medic, sandbox-recycler, sandbox-orphan-reaper, recycle-sandbox | gone (sandbox work moves to OpenRouter containers) |
| a sandbox needs an identity to reach the spine | doorman, badge-pull, badges.json, the pull token, `sandbox_pool`, `/control/{badges,sandboxes,seat-bots}`, `src/composio/relayHandler.ts` | a seat row + a service credential |
| Render cannot reach into openclaw | nudge-runner, office-runner (poll `/control/nudges`, `/control/office` every 5 min) | the loop reads the same queues; a nudge is a bot send |
| the box needs watching | box-report, seat-sync (Mini App bot id — the reason no assistant token sits on Render today) | gone; bot tokens must move to Render (decision 1 below) |

## 6. The retirement plan (sized 2026-09-21; six items after A and B were folded)

| item | retires | needs | state |
|---|---|---|---|
| **A+B** Seats on the Agent SDK: one worker, technician seat beside s5 (phase 1), then the manager invoice job with the shell tool (phase 2) | nothing yet — the foundation | — | **spawned** |
| **C** Seats for real | per-seat sandboxes: media in, 2000 ms debounce + preview, weekday guard as hook, resume after deploy, tokens on Render, web → Starter | A+B | not parked |
| **D** Office + nudges in-process | office-runner, nudge-runner, timers, the cross-host poll | A+B | not parked |
| **E** Identity without badges | doorman, badge-pull, `sandbox_pool` (16 call sites, 4 migrations), hosts/hostMetrics, relayHandler, three control endpoints | design in parallel, land after C | not parked |
| **F** Cut-over seat by seat, s2 first | the gateway | C, D, E | not parked |
| **G** Decommission the box and its literature | 13 services, the instance, every secret held there, Box_Setup_Stuff, four runbooks, ~313 engineering-memory lines marked historical | F | not parked |

```
A+B seats on the Agent SDK ──► C seats for real ─────┐
D office + nudges in-process (after A+B) ────────────┼──► F cut-over (s2 first) ──► G decommission
E identity without badges (design now, land after C) ┘
manager settings page (parked) ── holds tokens and the Telegram binding, feeds C and E
```

Three decisions the operator owns: (1) where bot tokens live on Render (env var vs encrypted table
behind the settings page) — this reverses the "no assistant token on Render" principle; (2) what a
seat is once the pool is gone (today a per-seat cap on cold sandboxes, refs never reused); (3)
whether the MCP server over HTTP stays for development or goes with the mTLS/allowlist infra.
Estimate, not measured: three to five weeks for one operator. The parked finding "seats hit All
models are temporarily rate-limited" becomes moot at F.

## 7. Corrections this research makes to earlier records

- `src/db/costs.ts:180-186` says GLM 5.3 has "~12% spread, stable provider"; the OpenRouter models
  endpoint showed 34 endpoints at $0.773–$2.10/M (171% spread) on 2026-09-20.
- The 2026-08-24 Gemini outage was the AI Studio free tier (`GEMINI_API_KEY`, 503 "high demand");
  Vertex streamed steadily. Never the API-key door for production.
- The deny-openclaw-dev-toolkit change (this branch's original purpose) is moot once seats move;
  the census behind it (exec 131 uses, sessions_* 0) stands.

## 8. Verified 2026-09-21 evening: the bought-harness direction

**Operator's priorities, in order:** "keep the code lean and keep the model freedom, while having
the cowork like experience. I don't want to build the cowork harness since more people before me
has done that, with a higher level of professionality. Now the maintenance of the harness being on
the long-lived box is fine with me." Then: technicians thin, managers get the Cowork long tail,
sandboxes for managers from a vendor on demand (not on the box), Telegram stays the UI.

**GitHub Copilot SDK** (`@github/copilot-sdk` 1.0.14, published 2026-09-21, MIT, "generally
available and follows semantic versioning"; github.com/github/copilot-sdk): a thin JSON-RPC client
around the Copilot CLI engine, bundled per platform (`@github/copilot-sdk-linux-x64` etc.);
sessions persist as files under the engine's home; `onPermissionRequest` gates every tool call;
MCP and skills supported. Multi-tenant guidance
(docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy): "Always start the client or
runtime in `mode: "empty"`", unique session ids with ownership in your database, explicit tool
allowlists; "Do not use the default `mode: "copilot-cli"` for shared servers… can expose ambient
host filesystem capabilities"; isolated processes per user only for the strongest boundary. BYOK
(github.com/github/copilot-sdk/blob/main/docs/auth/byok.md): `provider: {type: "openai" | "azure" |
"anthropic", baseUrl, apiKey | bearerToken, wireApi: "completions" | "responses"}`, "Other
OpenAI-compatible: vLLM, LiteLLM, etc."; `model` required and a free string; per session; "A
GitHub Copilot subscription is required… unless you are using BYOK". Read from the package types
(`dist/types.d.ts:2791`, `dist/session.d.ts:296`): `MessageOptions.mode?: "enqueue" | "immediate"`
("immediate steering messages… folded into the running turn"), `agentMode?: "interactive" | "plan"
| "autopilot" | "shell"`, `session.abort(): Promise<void>`. Open issues that shape the test:
#2061 (2026-07): after a tool call the replayed assistant message carries `"refusal": null`, strict
OpenAI-compatible providers (Gemini's own endpoint) 400, retries swallow it; #2571 (2026-09-20):
`gemini-3.8-flash` absent from `listModels()` on the hosted catalog and silently run as
`claude-sonnet-5`. OpenRouter fit: `baseUrl: https://openrouter.ai/api/v1`, `wireApi:
"completions"` (the responses wire relies on server-side state OpenRouter rejects with 400),
`model: "@preset/…"` for the fallback; unverified until step 0.

**GitHub Copilot plans, for inference** (docs.github.com/en/billing/concepts/product-billing/github-copilot-licenses,
docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises,
docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing; changelog 2026-06-01):
Business $19/user/month with 1,900 AI credits, 1 credit = $0.01, "pooled at the billing entity
level"; "Each token is priced based on the model used, and the total is converted into AI
credits"; Gemini 3.8 Flash $0.75 in / $0.075 cached / $3.75 out per million — identical to
OpenRouter's rates; "Copilot licenses are required for each user who uses Copilot. A seat is a
license for one user." Conclusion: no inference saving, and a license per end user we cannot
give; the seats stay on the OpenRouter key.

**Sandbox vendors with a plain run-this door** (for our proxied tools): Google Agent Runtime Code
Execution (docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/code-execution-quickstart:
create sandbox, then `execute_code` with files in and `outputs` chunks with `file_name` back, up to
100 MB per call, Python or JavaScript, 2 vCPU/1.5 GB default, TTL reset on each call; usable
without deploying an agent to Agent Runtime; idle between turns not billed); Vercel Sandbox (GA,
$0.128/CPU-hr + $0.0212/GB-hr, sessions up to 24 h and resumable); E2B (not checked today).
OpenRouter's shell does NOT fit this shape: it runs only inside a model call as a server tool.
Mastra Cloud's workspace exists only for agents deployed on Mastra Cloud.

**Rejected the same evening, with why:** Claude Agent SDK via OpenRouter's Anthropic-format
endpoint (openrouter.ai/docs/cookbook/coding-agents/claude-code-integration: "only guaranteed to
work with the Anthropic first-party provider… may not work correctly with other providers");
Ori (openrouter.ai/docs/guides/ori/harness: terminal only); CopilotKit (React front door; Copilot
SDK not a listed backend; Channels SDK ships Slack/Teams, not Telegram); Mastra and the OpenRouter
Agent SDK on a Render worker (frameworks: we would assemble the harness); Google ADK + Agent
Runtime (Python-only deploy; identity on the wire kept); Google Managed Agents API
(docs.cloud.google.com/gemini-enterprise-agent-platform/build/managed-agents: Pre-GA, models
unstated). Other messaging apps as the UI: WhatsApp is the only real alternative (templates for
business-initiated messages; per-message billing including service replies from 2026-10-01 beyond
1,000 free per number per month); iMessage needs an approved messaging provider; Signal has no API.

**The seven-step sequence** a GO unlocks is in memory `openclaw-retirement-plan` and will be
copied into this document when step 0 reports.
