---
date: 2026-06-19
branch: context-spine-basic-structure
commit: dbb2abe
topic: Stage 2 — technician write-path; feasibility of NemoClaw/OpenClaw per-user agents as the input channel
---

## Summary
Stage 1 (the spine schema + typed data layer) is built and merged-ready. Stage 2 is the **first
write-path**: getting a technician's voice/typed note *into* the spine as L1 raw → AI-extracted L2/L3
→ identity-matched → provenance-linked. This research evaluates the user's proposed input mechanism:
a **per-user NemoClaw agent** living in a chat app (Telegram/iMessage/Discord), pre-wired to apps
(Gmail, Sheets, SMS), that the tech/manager talks to and that "contributes to the database." Finding:
the approach is **viable and a good fit** — NemoClaw/OpenClaw natively handle the *channel* (chat),
*voice transcription*, *per-user isolation*, and *tool-calling via MCP* — **but the spine write itself
(raw-land + AI extraction + identity matching + provenance) must live in our own code behind a custom
MCP server / HTTPS endpoint; it is not something the off-the-shelf agent does.** Two gaps surfaced:
**iMessage is not a supported channel**, and **identity matching must stay server-side, hardcoded**
(not delegated to the agent), per the overview.

## What NemoClaw / OpenClaw actually is (external findings)
- **NemoClaw** is NVIDIA's open-source stack that runs an agent **inside an "OpenShell" sandbox** for
  security — per-agent **network namespace, filesystem + network restrictions**, and a model where the
  agent **talks only to allow-listed domains and never sees the API keys / bot token** (the token is
  "registered with the OpenShell gateway and doesn't enter the sandbox"). ([NVIDIA blog](https://developer.nvidia.com/blog/build-a-secure-always-on-local-ai-agent-with-nvidia-nemoclaw-and-openclaw/), [github.com/NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw))
- The agent **runtime it sandboxes is "OpenClaw"** (open-source personal-assistant runtime). NemoClaw
  adds the sandbox + policy controls and routes inference to NVIDIA Nemotron (or local models).
- **Per-user model:** one named sandbox per user — `nemoclaw <sandbox-name>` (e.g. `nemoclaw
  tech-jane`), each isolated. Outbound access widened interactively via `nemoclaw <name> policy-add`
  (approve/deny a destination host live). ([NVIDIA blog](https://developer.nvidia.com/blog/build-a-secure-always-on-local-ai-agent-with-nvidia-nemoclaw-and-openclaw/))
- **App connections = MCP.** OpenClaw connects to external services through **MCP servers** configured
  under `mcp.servers` (stdio `command`/`args`); it has connectors for Gmail, Google Sheets, Postgres,
  and 500+ services, **and you can wrap your own API in a custom MCP server** to expose it as a native
  tool. Tool access is restrictable via `tools.profile` / allowlists / `tools.toolsBySender`. Secrets
  go in via env/SecretRef and are kept out of the model context. ([OpenClaw config-tools](https://docs.openclaw.ai/gateway/config-tools), [search summary](https://docs.bswen.com/blog/2026-03-26-openclaw-mcp-integration-guide/))
- **Channels:** **Telegram** (BotFather token, per-user sender allowlist), **Discord**, **Slack** (and
  WhatsApp/Feishu/Matrix for voice). **No iMessage** in any list — Apple does not permit bots, so the
  user's iMessage idea is not directly supported. ([NemoClaw Telegram setup](https://docs.nvidia.com/nemoclaw/latest/deployment/set-up-telegram-bridge.html))
- **Voice is first-class.** A Telegram **voice message is auto-transcribed (STT) before the agent sees
  it** — providers include OpenAI Whisper, Deepgram, Voxtral, or **local Whisper** (privacy/offline).
  TTS replies are supported too. So "voice and typed note" are both handled by the channel layer. ([OpenClaw voice/STT](https://github.com/openclaw/openclaw/issues/18424), [search summary](https://www.stack-junkie.com/blog/openclaw-voice-mode-telegram))

## Entry Points (where the write-path would attach to the spine we built)
The spine's typed data layer is the write target. None of the write-path exists yet; these are the
functions a stage-2 MCP server / endpoint would call:
- [src/db/rawCaptures.ts](src/db/rawCaptures.ts) — `appendRawCapture(input)` (L1 insert; `channel`
  enum already includes `technician_voice` / `technician_note` / `technician_photo`).
- [src/db/customers.ts](src/db/customers.ts) — `createCustomer` / `getCustomer`.
- [src/db/jobs.ts](src/db/jobs.ts) — `createJob` / `getJob` / `listJobsForCustomer` / `updateJobStatus`.
- [src/db/visits.ts](src/db/visits.ts) — `createVisit` / `listVisitsForJob`.
- Provenance is already wired: `raw_captures.{customer_id,job_id,visit_id}` (what a capture is about)
  and L2 `source_capture_id` (what a record was created from).

## Data Flow (how a tech note would land — proposed)
1. **Tech speaks/types in Telegram** → OpenClaw bridge receives it; voice is auto-STT'd to text.
2. **Per-user agent** (knows the sender = which tech) holds a short clarifying conversation if needed
   ("which job/address is this?").
3. **Agent calls our custom MCP tool**, e.g. `record_field_note({ techId, text, photoRefs, jobHint })`
   — the *only* tool that touches the spine; the agent never holds the Supabase key.
4. **Our MCP server (stage-2 code we write) runs the write-path:**
   a. `appendRawCapture(channel: 'technician_voice'|'technician_note', rawText, tenantId)` → **L1**.
   b. **AI extraction** of structured fields from `rawText` → candidate L2/L3.
   c. **Hardcoded identity matching** → which existing customer/job/visit (or new), keyed on tech +
      job hint + address/phone. **Deterministic, tested — never the agent's guess.**
   d. Write/patch L2/L3 via `createJob`/`updateJobStatus`/etc., set `source_capture_id` back to the
      capture, and stamp the capture's `customer_id/job_id/visit_id`.
5. Agent confirms back to the tech ("Logged to job #12 for the Smith property").

The agent is the **channel + collector**; our server is the **write-path + system of record**.

## External Dependencies (introduced by this approach)
- NVIDIA **NemoClaw + OpenShell** runtime (or plain **OpenClaw** without NVIDIA sandboxing — see
  Options), per-user sandboxes.
- A **Telegram bot** per tech (BotFather), or Discord/Slack.
- An **STT provider** (cloud Whisper/Deepgram, or local Whisper for privacy).
- An **LLM** for extraction (separate from the channel; our server's concern).
- A **custom MCP server** (Node/TS — same stack as our data layer) bridging agent → spine.

## Architecture Options (for the plan phase to choose between)
- **A. Custom MCP server, agent calls a structured tool.** Most native to OpenClaw. Agent can be
  conversational/clarifying; server stays authoritative. Risk: agent decides *when* to call — mitigate
  with tool allowlists + a tight tool contract.
- **B. Thin forwarder, agent POSTs raw text to our HTTPS ingestion endpoint.** Agent is a dumb pipe;
  all logic server-side. Simpler to reason about; less conversational. Needs the endpoint domain
  allow-listed in the sandbox.
- **C. Skip NemoClaw's heavy sandbox for v1 — plain OpenClaw, or even a bare Telegram bot → our API.**
  The user wants a *light* per-user agent; the full NVIDIA OpenShell stack may be more than v1 needs.
  A plain Telegram bot calling our endpoint gets a working write-path fastest; NemoClaw's
  sandboxing/policy value grows once agents also touch Gmail/Sheets/SMS on the user's behalf.

In all three, **our backend owns raw-land + extraction + identity matching + provenance.** That split
is the overview's "hardcode what must be correct, let AI interpret."

## Constraints and Invariants
- **Identity matching is hardcoded and tested, server-side** — not delegated to the agent (overview §5,
  lines 140-144). The agent may *suggest* a job; the server *decides*.
- **The agent must never hold the Supabase service-role key** — it calls our tool/endpoint; our server
  holds the key. This aligns with NemoClaw's "agent never sees API keys" model.
- **L1 first, always** — the verbatim note (and the audio blob pointer) lands in `raw_captures` before
  any extraction, so a bad extraction can be re-run later (overview §3).
- **One tenant for now** — `tenant_id` is threaded but RLS is still off; multi-tenant isolation +
  mapping a tech → their firm's tenant is unresolved (see Open Questions).

## Open Questions
- **iMessage:** not supported by NemoClaw/OpenClaw. Drop it, or build a separate iMessage bridge
  (significant)? Telegram is the path of least resistance.
- **Per-user cost/ops:** is one always-on sandboxed agent per tech (5–50 per firm) viable on
  NemoClaw/OpenShell, or does Option C (one shared bot, sender-identified) fit "light" better?
- **Job disambiguation:** how does a tech indicate *which* job a note is about — agent asks, a daily
  schedule/calendar integration, or address/GPS? This is the crux of identity matching for this channel.
- **Tenant resolution:** how does an incoming tech map to their firm's `tenant_id` (and where do
  per-firm bot tokens live)? Ties into the still-deferred RLS work.
- **STT privacy/quality:** cloud Whisper/Deepgram vs local Whisper — recording/transcription of
  on-site audio; any consent concerns for third parties captured in the background.
- **Extraction model + schema-mapping:** which LLM, and how extraction output maps to our exact L2
  columns / status transitions — a stage-2 design task in its own right.
- **NemoClaw maturity / lock-in:** dependency on NVIDIA OpenShell; is self-hosting acceptable, and is
  the value worth it for v1 vs. a plain bot (Option C)?

## Sources
- NVIDIA NemoClaw: [github.com/NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw) ·
  [developer.nvidia.com blog](https://developer.nvidia.com/blog/build-a-secure-always-on-local-ai-agent-with-nvidia-nemoclaw-and-openclaw/) ·
  [Telegram bridge docs](https://docs.nvidia.com/nemoclaw/latest/deployment/set-up-telegram-bridge.html)
- OpenClaw tools/MCP: [docs.openclaw.ai/gateway/config-tools](https://docs.openclaw.ai/gateway/config-tools) ·
  [MCP integration guide](https://docs.bswen.com/blog/2026-03-26-openclaw-mcp-integration-guide/)
- OpenClaw voice/STT: [openclaw#18424](https://github.com/openclaw/openclaw/issues/18424) ·
  [Telegram voice mode](https://www.stack-junkie.com/blog/openclaw-voice-mode-telegram)
