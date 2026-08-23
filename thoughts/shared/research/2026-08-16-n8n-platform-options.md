# n8n platform options for the trades system

**Date:** 2026-08-16
**Status:** exploratory research — no decision taken, nothing built
**Question:** could/should we put our system (spine + agent stack) on n8n, and in what form?

## What n8n is

n8n is a self-hostable workflow-automation tool: you draw workflows as boxes and arrows
(trigger → steps), and it ships ~400+ pre-built integrations (Gmail, Telegram, Postgres, …),
schedule/webhook triggers, JavaScript "code" nodes, and — since 2025 — AI Agent nodes and
Model Context Protocol (MCP) support in both directions.

## Verified facts (live docs, checked 2026-08-16)

1. **License.** n8n uses the fair-code "Sustainable Use License": free for
   **"internal business purposes"** (syncing your own data, internal automations, consulting,
   self-hosting for yourselves). Explicitly **prohibited without a paid license**:
   white-labeling, hosting n8n for paying customers, and — critical for us —
   **"collecting customer credentials to connect their accounts and build workflows"**.
   Using n8n as a product back-end is allowed only "as long as the back-end process doesn't
   use users' own credentials to access their data."
   Source: <https://docs.n8n.io/privacy-and-security/sustainable-use-license>
2. **MCP Server Trigger** node turns an n8n workflow into an MCP server (SSE / streamable
   HTTP transports; bearer or header auth) that external MCP clients — like our gateway —
   can call as a tool. Queue-mode caveat: all `/mcp*` requests must route to a single
   dedicated webhook replica.
   Source: <https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger>
3. **MCP Client Tool** sub-node lets an n8n AI Agent consume external MCP servers (e.g. our
   spine MCP). Source: <https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp>
4. **AI Agent node** exists (LangChain-based; chat model + tools). Custom OpenAI-compatible
   base URLs (our GLM-5.2 via DeepInfra/Fireworks) work via the OpenAI Chat Model sub-node's
   base-URL field, but community/issue threads show version-dependent quirks (e.g. n8n issue
   #21651); the reliable fallback is a raw HTTP Request node.
   Sources: <https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent>,
   <https://github.com/n8n-io/n8n/issues/21651>
5. **Telegram Trigger** node exists (messages, callbacks, etc.).
   Source: <https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.telegramtrigger>
   **Platform constraint (Telegram, not n8n):** one bot token = one webhook/getUpdates
   consumer; n8n listening on a bot token would fight the OpenClaw gateway for the same
   updates. Any Telegram use in n8n needs its own bot token.

## Options considered

- **Option 1 — full replatform** (agent + connectors rebuilt as n8n workflows): rejected.
  Discards the safety/eval moat (weekday-guard plugin, doctrine blocks, 59-scenario tool
  eval, 94-question date eval, typed `src/db/` layer, `testEnvGuard`), and the AI Agent node
  has no equivalent of our streamed-reply guard hooks. Telegram token conflict with the
  gateway. A rewrite, not a migration.
- **Option 2 — n8n replaces Render cron/watchers + inbound webhook plumbing**: rejected for
  spine-writing paths. The classify-before-L1 gate would move into untyped, untested code
  nodes in front of an **append-only, undeletable** L1. Watchers just landed in TS with
  tests (feat/spine-watchers). Possible only for automations that never write the spine.
- **Option 3 — n8n as a tool shelf for the existing agent** (MCP Server Trigger → gateway
  MCP client): the interesting one. Long-tail integrations become agent tools without
  hand-writing TS connectors; spine writes still go through spine MCP gates. Caveats:
  (a) instance-level credentials — n8n has no per-person session boundary like Composio,
  so manager/technician tiering and the doorman identity model don't carry over → license
  problem too if the credentials are the customer's own (see fact 1);
  (b) tool-schema size discipline (the 13-deep-schema 67s-turn lesson) applies to any
  exposed workflow; (c) a new stateful service to operate.
- **Option 4 — n8n for internal ops only** (provider-balance watch, medic flip alerts,
  digest plumbing for ourselves): clean under the license, zero customer-path risk, cheap
  to trial. Recommended entry point if we want hands-on n8n experience.
- **Option 5 — embed n8n as customer-facing automation builder**: paid Embed license, and
  contradicts the ratified Telegram-only / agent-first product principle. Rejected.

## Pricing (verified 2026-08-16)

Cloud (n8n-hosted), billed annually — from <https://n8n.io/pricing/>:

| Plan | Price | Executions/mo | Concurrency | Notes |
|---|---|---|---|---|
| Starter | €20/mo | 2,500 | 5 | 1 shared project |
| Pro | €50/mo | 10,000 | 20 | 3 shared projects |
| Business | €667/mo (~€8k/yr) | 40,000 | n/s | self-hosted option exists |
| Enterprise | contact sales | custom | 200+ | required tier for "host and manage **your clients'** workflows and credentials" |

Self-hosted Community edition: free, unlimited executions (license limits above still apply
to *how* it's used, not how much). An "execution" = one run of a whole workflow regardless of
steps — a single */5-minute polling workflow ≈ ~8,900 executions/mo, blowing Starter on its own;
polling-heavy designs favor self-hosting.

License-tier mapping (n8n support article, exact words):
- "host and manage **your** clients' workflows and credentials within your own internal n8n
  instance" → **Enterprise license** (no public price).
  Source: <https://support.n8n.io/article/can-i-use-your-license-for-my-use-case>
- Embed (white-label the builder UI into your product) → **Embed license, starts at
  $50,000/yr** (n8n OEM page via search; third-party reporting agrees).
  Sources: <https://n8n.io/oem/>, <https://taskjuice.ai/blog/n8n-white-label-cost-agencies>
- Our own credentials / internal automations → free (sustainable-use license).

Implication: the affordable tiers (€20–667/mo) are licensed for automating *our own*
business, not for powering the product with customer credentials — that's negotiated
Enterprise, realistically five figures/yr judging by the adjacent Embed floor. Willingness
to pay at cloud-plan level doesn't unlock the product use case.

## Follow-up 2026-08-16: "we only want the visual UI" — build our own

User clarified the real want: n8n's visual canvas as a management surface, not its engine.
Findings:

- **n8n's UI is inseparable from its engine** — the canvas only renders workflows that live
  in n8n; it cannot visualize external systems (our TS watchers). "n8n just for the UI"
  therefore isn't achievable with n8n itself short of migrating the automations in.
- **Copying n8n's frontend code is barred** by the sustainable-use license — a product-embedded
  canvas is exactly what the $50k/yr Embed license sells.
- **Building our own canvas is cheap**: the node-editor canvas is commodity —
  React Flow / xyflow is MIT-licensed (<https://xyflow.com/open-source>,
  <https://github.com/xyflow/xyflow>); n8n-style editors are its headline use case. The hard
  90% of n8n (execution engine, node registry, credential store, 400 connectors) we already
  have in different clothes: watchers + lifecycle cron + agent + Composio + spine tools.
  Our UI is a *projection of our own automation registry*, not a general editor.
- Scope ladder: (1) **automation board v1** — render each watcher as
  trigger→condition→action nodes with live status, run history, on/off, param edits
  (~small, week-scale); (2) **agent-authored automations rendered for approval** — manager
  asks in Telegram, agent stages, board shows the diagram + approve button (fits ratified
  agent-first + stage-only ceiling); (3) **full drag-and-drop builder** — rebuilding n8n,
  months+, contradicts agent-first authoring; not recommended.
- Fits the Telegram-only principle via the existing ratified "board" precedent
  (board = manager's hands, deep-linked from chat).

## Follow-up 2026-08-16 (2): internal devops use only

User narrowed the want again: n8n purely for internal systems management (devops). This is
the license's free case — "internal business purposes", our own credentials only. Shape:

- **Candidate workflows** (all real recurring pain): inference-provider balance/spend-cap
  watch (Fireworks 412 / DeepInfra 402 both bit us; balance-outs ~monthly), medic
  provider-flip alerts, deployed-vs-repo md5 drift check (the "repo-merged ≠ box-deployed"
  trap, e.g. doorman PR #119), Render deploy watcher (env-save deploys stale commit trap),
  sandbox JWT expiry sweep, uptime checks on doorman/gateway/spine, dated reminders
  (GRANT migration due 2026-10-30).
- **Hosting decision**: checks that need ssh into trades-box-1 (md5 drift, systemd state)
  mean the n8n instance holds prod ssh keys → **self-host Community** (free) on a small
  separate VPS, NOT on trades-box-1 itself and NOT n8n Cloud (key custody). If we stay
  HTTP-only (billing APIs, Render API, uptime), n8n Cloud Starter €20/mo is the zero-ops
  alternative — but 5-min polling ≈ 8.9k executions/mo blows Starter's 2.5k cap, so
  self-hosting also wins on polling math.
- **Guardrails**: dedicated NEW ops Telegram bot token (Telegram = one listener per token;
  never reuse fleet bots); read-only against our infra — no spine writes, no pilot-DB
  writes (keeps n8n outside every gated path); treat the n8n host as secret-bearing
  infrastructure (it stores credentials encrypted with an instance key).

## Recommendation

Don't replatform. If n8n at all: start with Option 4 (internal ops sidecar), graduate to a
contained Option 3 experiment only when a concrete long-tail integration need appears that
Composio can't serve — and treat any workflow touching customer credentials as a licensing
red line requiring the paid tier (at which point compare against just adding a Composio
toolkit, which is priced for exactly that).
