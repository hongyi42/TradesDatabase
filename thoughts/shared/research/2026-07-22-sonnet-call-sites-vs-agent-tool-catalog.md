---
date: 2026-07-22
branch: fix/telegram-board-latency
commit: 59e9173
topic: Where the repo calls Anthropic Sonnet directly, what each call actually ships in its prompt, and how that differs from the OpenClaw agent's per-turn tool catalog (the "heartbeat" cost shape)
---

## Summary

This repo talks to a large language model (a "model" = the AI that reads text and writes
text back) in **two completely separate places**, and they have very different cost shapes.

1. **The agent brain.** Each technician/manager has a sandbox running OpenClaw, whose brain is
   currently **GLM-5.2** (via the DeepInfra gateway). Every time that agent takes a turn, the
   request carries a big fixed prefix: system prompt + the **whole MCP tool catalog** (MCP =
   Model Context Protocol, the standard the agent uses to call this repo's `src/mcp/server.ts`
   tools). That catalog is ~8.7k tokens for a manager badge. That reload-every-turn prefix is
   exactly what makes the 30-minute heartbeat poll expensive (see
   `thoughts/shared/plans/2026-07-20-model-cost-benchmark-and-cache-diagnosis.md`).

2. **The repo's own inline model calls.** Four functions in this codebase call Anthropic's
   `messages.create` directly with the `@anthropic-ai/sdk` package: `sonnetClassifier`,
   `sonnetExtractor`, `sonnetBriefer`, `sonnetAnswerer`. Each one is a **single-shot,
   single-tool, no-history** call. It ships exactly **one** tool schema — the one output shape
   it forces the model into — plus a short system prompt and the input text. It never sees the
   25-tool MCP catalog, never carries conversation history, and never sets `cache_control`
   (Anthropic's prompt-cache opt-in), so **these calls are already uncached today**.

Measured prompt overhead per inline call (system + its single tool schema, source characters
÷ 4 as a token estimate):

| Call site | system + tool chars | ≈ tokens |
|---|---|---|
| `sonnetClassifier` (`src/email/classify.ts:17-35`) | 874 | ~219 |
| `sonnetExtractor` (`src/writePath/extract.ts:30-69`) | 2,085 | ~521 |
| `sonnetAnswerer` (`src/synthesis/answerQuestion.ts:13-44`) | 1,302 | ~326 |
| `sonnetBriefer` (`src/synthesis/briefCustomer.ts:19-52`) | 1,542 | ~386 |
| **agent per-turn tool catalog** (`src/mcp/server.ts:169-855`) | 34,852 | **~8,713** |

So the classification call's fixed overhead is roughly **1/40th** of one agent turn's tool
catalog. Whatever swapping the model does to cost, it does not reload the tool catalog —
that catalog lives in a different process (OpenClaw), on a different API, and these four
functions never touch it.

## Entry Points

Inline model calls (the "classification" family the question is about):

- `src/email/classify.ts:39` — `sonnetClassifier`, the work-vs-personal email gate.
- `src/writePath/extract.ts:73` — `sonnetExtractor`, field-note → structured fields.
- `src/synthesis/briefCustomer.ts:57` — `sonnetBriefer`, pre-visit briefing prose.
- `src/synthesis/answerQuestion.ts:49` — `sonnetAnswerer`, grounded Q&A over a customer record.

Who invokes each:

- `src/inbound/webhook.ts:136` + `:219-224` — Composio webhook path calls `classify` before the
  L1 insert.
- `src/email/ingest.ts:81` + `:87` — Gmail pull path calls `classify` once per fetched email.
- `src/writePath/recordFieldNote.ts:77` — `deps.extract ?? sonnetExtractor`.
- `src/mcp/server.ts:1175` — `record_field_note` staging calls the extractor.
- `src/mcp/server.ts:1516` — `brief_customer` tool calls the briefer.
- `src/mcp/server.ts:1530` — `answer_customer_question` tool calls the answerer.

Agent-side tool catalog (the other surface, for contrast):

- `src/mcp/server.ts:169` — `TOOLS` (technician surface).
- `src/mcp/server.ts:471` — `ADMIN_TOOLS`.
- `src/mcp/server.ts:856` — `MANAGER_TOOLS = [...TOOLS.filter(t => t.name !== 'get_schedule'), ...ADMIN_TOOLS]`.
- `src/mcp/server.ts:3795-3805` — the `ListToolsRequestSchema` handler; returns
  `admin ? MANAGER_TOOLS : TOOLS`.
- `Box_Setup_Stuff/bootstrap-box.sh:274` — where the agent brain is pinned:
  `inference set -g nemoclaw --provider deepinfra-prod --model zai-org/GLM-5.2`
  (NVIDIA fallback `z-ai/glm-5.2` at `Box_Setup_Stuff/nemoclaw-inference-medic.sh:35-37`).

Existing dual-provider harness (already speaks both Anthropic and GLM):

- `scripts/eval-date-reliability.mjs:119-165` — `EVAL_PROVIDER=openai|anthropic`, default GLM id
  `z-ai/glm-5.2`, OpenAI-compatible `callOpenAI` at `:123` and `callAnthropic` at `:142`.

## Key Files

| Path | Role | Key exports |
|---|---|---|
| `src/email/classify.ts` | Work-vs-personal email classifier. Defines `CLASSIFY_SYSTEM` (`:17`) and one tool `CLASSIFY_TOOL` (`:23`), forced via `tool_choice` (`:48`). `max_tokens: 256`. | `EmailInput`, `Classification`, `WorkClassifier`, `sonnetClassifier` |
| `src/writePath/extract.ts` | Field-note → `ExtractedFields`. One forced tool `record_extraction` (`:39`). `max_tokens: 1024`. | `ExtractedFields`, `Extractor`, `sonnetExtractor` |
| `src/synthesis/briefCustomer.ts` | Customer briefing prose + citations. One forced tool `record_briefing` (`:28`). Citations validated against real captures at `:80`. | `BriefFocus`, `CustomerBriefing`, `Briefer`, `sonnetBriefer` |
| `src/synthesis/answerQuestion.ts` | Grounded Q&A. One forced tool `record_answer` (`:20`). Citations validated at `:69`. | `CustomerAnswer`, `Answerer`, `sonnetAnswerer` |
| `src/synthesis/grounding.ts` | `serializeContextForPrompt` / `validateCitations` — builds the variable part of the brief/answer prompts. | (used by both synthesis files) |
| `src/inbound/webhook.ts` | Composio webhook handler. Roster read happens *before* classify (`:199`) so no model call is spent on a known-gone person (comment `:192-198`). | `handleInboundWebhook`, `verifyWebhookSignature` |
| `src/email/ingest.ts` | Gmail pull loop; one classify call per email in the `newer_than:7d` window, `maxResults: 25` (`:44`). | `ingestEmail`, `IngestDeps` |
| `src/writePath/recordFieldNote.ts` | Write path; injects `deps.extract ?? sonnetExtractor` at `:77`. | `recordFieldNote` |
| `src/mcp/server.ts` | The single agent-facing boundary. Holds the tool catalog and the dispatch switch; also the *caller* of extractor/briefer/answerer. `ServerDeps` (`:141`) makes all three injectable so tests never hit a live model. | `createServer`, `ServerDeps` |
| `scripts/eval-date-reliability.mjs` | Standalone eval harness with both an Anthropic adapter and an OpenAI-compatible (GLM/DeepInfra/NVIDIA) adapter, including a tool-calling path. | (script) |
| `thoughts/shared/plans/2026-07-20-model-cost-benchmark-and-cache-diagnosis.md` | Recorded cache/cost diagnosis: heartbeat = ~99% of agent turns; blended prod cache ~3%; GLM/Luna price table; `toolSearch:false` on all 5 sandboxes. | (doc) |

## Data Flows

### Flow A — inbound email classification (the call the question is about)

```
Composio trigger (Gmail)
        │  POST /inbound/*  (signed)
        ▼
src/inbound/webhook.ts  handleInboundWebhook()
        │  HMAC verify → parse → normalize → roster read (getTechnician)
        ▼
  classify({from, subject, body})            ← src/email/classify.ts sonnetClassifier
        │
        │  ONE HTTPS request to api.anthropic.com/v1/messages:
        │     model:        'claude-sonnet-4-6'
        │     max_tokens:   256
        │     system:       CLASSIFY_SYSTEM        (~110 tok)
        │     tools:        [CLASSIFY_TOOL]        (~110 tok)  ← ONE tool, not 25
        │     tool_choice:  {type:'tool', name:'classify_email'}
        │     messages:     [ one user turn: From/Subject/Body ]
        │     (no cache_control, no history, no MCP catalog)
        ▼
  tool_use block → {isWork, reason}
        │
   isWork=false ──► upsertDroppedAudit()  (content-free receipt; email NOT stored)
   isWork=true  ──► recordFieldNote() ──► L1 insert ──► sonnetExtractor (2nd model call)
```

The request body is built literally in `classify.ts:43-52`. The Anthropic Messages API is
stateless: **whatever is in that object is the entire prompt.** There is no ambient tool
registry, no session, nothing carried over from a previous call. Same for extract/brief/answer.

### Flow B — the agent turn (where the tool catalog *is* reloaded)

```
Telegram / heartbeat
        ▼
OpenClaw sandbox agent  (brain = GLM-5.2 @ DeepInfra)
        │  every turn ships:  system prompt + FULL tool catalog (~8.7k tok manager)
        │  toolSearch:false on all 5 sandboxes → no deferred loading
        ▼
   picks a tool  ──►  MCP call  ──►  src/mcp/server.ts dispatch()
                                              │
                                              ├─ record_field_note → sonnetExtractor  ┐
                                              ├─ brief_customer    → sonnetBriefer    ├─ Flow A-shaped
                                              └─ answer_customer_question → sonnetAnswerer ┘
```

Two model layers stacked: the **agent's** model (GLM) decides *which* tool; the **server's**
model (Sonnet) runs inside three of those tools. They are separate API calls to separate
vendors with separate prompts. The tool catalog belongs only to the outer layer.

`tools/list` is served per-request and tier-filtered (`server.ts:3795-3805`), and the comment at
`server.ts:1125-1128` notes the gateway caches `tools/list` per process — so the catalog is
assembled rarely on the server side but re-serialized into the agent's prompt every turn on the
OpenClaw side.

### Call frequency (how often a classify-shaped call fires)

- Webhook path: **1 classify per delivered inbound message** whose envelope sets
  `requiresWorkClassifier` (`webhook.ts:219`), gated behind the roster read so offboarded
  people cost nothing (`webhook.ts:199-214`).
- Pull path: **1 classify per email returned by the Gmail list**, up to 25 per run over a
  `newer_than:7d` window (`ingest.ts:44`, loop at `:86`). The comment at `ingest.ts:70-74`
  records that a re-fetched, never-matched email re-incurs the *extract* call each window.
- Extract: 1 per `record_field_note` **staging** call (`server.ts:1175`) and 1 per work email
  ingested.
- Brief / answer: 1 per `brief_customer` / `answer_customer_question` tool invocation.

## External Dependencies

- **`@anthropic-ai/sdk`** (`package.json`) — the only client used by the four inline calls.
  Model string hardcoded as `'claude-sonnet-4-6'` in all four files; key from
  `process.env.ANTHROPIC_API_KEY`, checked per call (e.g. `classify.ts:40-41`).
- **DeepInfra** (`zai-org/GLM-5.2`) — agent brain, production provider
  (`Box_Setup_Stuff/bootstrap-box.sh:274`).
- **NVIDIA integrate** (`z-ai/glm-5.2`) — free-tier failover for the agent brain
  (`Box_Setup_Stuff/nemoclaw-inference-medic.sh:35-37`); the medic script flips between them.
- **Composio** — delivers the inbound webhooks that trigger classify.
- **googleapis** — the Gmail pull fetcher (`ingest.ts:1`, `:33-58`).
- **Supabase** — everything downstream of the model calls (`src/db/`).

## Constraints and Invariants

1. **The Anthropic Messages API is stateless.** Each `messages.create` call carries its complete
   prompt in the request body; nothing persists between calls. There is no mechanism by which a
   classify call could "reload every tool" — the only tools it can send are the ones written into
   its own `tools:` array, and all four sites hardcode exactly one.

2. **`tool_choice: {type:'tool', name: …}` on every inline call.** The model is forced into the
   single tool; the code then finds that `tool_use` block and throws if absent
   (`classify.ts:53-57`, `extract.ts:85-89`, `briefCustomer.ts:71-75`, `answerQuestion.ts:63-67`).
   The tool is a *return-shape contract*, not a capability the model may choose to invoke.

3. **No prompt caching anywhere in this repo.** `cache_control` appears in zero source files.
   Under Anthropic's rules the minimum cacheable prefix for Sonnet 4.6 is 2,048 tokens, and every
   inline prompt's fixed part is 219–521 tokens — below the floor. So these calls cannot cache
   today even if a breakpoint were added, and a provider's lack of caching costs nothing relative
   to the current behavior.

4. **The four classifiers are dependency-injected seams, not hardcoded call paths.** Every caller
   takes `deps.classify` / `deps.extract` / `deps.brief` / `deps.answer` and falls back to the
   Sonnet implementation (`ingest.ts:81`, `webhook.ts:136`, `recordFieldNote.ts:77`,
   `server.ts:1175/1516/1530`; `ServerDeps` at `server.ts:141-160`). Tests inject stubs; production
   constructs with no deps, so the `??` fallbacks are load-bearing (comment `server.ts:1173-1174`).

5. **Classify gates the L1 insert and cannot be moved after it.** `raw_captures` is append-only
   (CLAUDE.md; DB trigger). `webhook.ts:216-250` and `ingest.ts:87-101` both run classify *before*
   any write, and a `false` verdict stores only a content-free drop receipt. Any change to the
   classifier changes what is permanently retained.

6. **Model errors are transient, not deterministic, in the webhook path.** `webhook.ts:188-190`
   documents that any throw inside the try block (including a model blip) maps to
   `transient_error` → HTTP 503 → Composio retries. A classifier that fails differently
   (e.g. returns malformed tool args) surfaces here as a retry loop, not a drop.

7. **GLM emits quoted integers.** `scripts/eval-date-reliability.mjs:88-92` records that the live
   tool path had to coerce string-typed zero integers (`"0"`) because "models — GLM in particular
   — often emit zero-valued integer args as quoted strings," mirroring `intArg` coercion in
   `src/mcp/server.ts`. The inline classify tool's `isWork` is a **boolean**, and extract's
   `laborHours` is a **number** — neither has coercion today.

8. **The recorded GLM price table says GLM-5.2 *does* have caching**, just short-lived:
   `$0.95/1M in, $3.00/1M out, $0.18/1M cached (81% off)`, "Cache TTL: short/unspecified",
   sourced to `deepinfra.com/blog/glm-5-2-pricing-benchmarks-cost-comparison` and
   `docs.deepinfra.com/chat/prompt-caching`
   (`thoughts/shared/plans/2026-07-20-model-cost-benchmark-and-cache-diagnosis.md:93-102`).
   That is a point-in-time finding from 2026-07-20, not re-verified in this pass. Sonnet 4.6 list
   price is $3.00/1M in, $15.00/1M out.

9. **The 5 sandboxes run `toolSearch:false`** (same doc, §Part 3) — the full tier-filtered catalog
   is injected as native function tools every agent turn. Tool-search mode exists but is disabled,
   and GLM's ability to drive it is recorded as UNVERIFIED.

10. **One hardcoded model string per file.** There is no central model-config module; changing
    the provider means editing four files (`classify.ts:44`, `extract.ts:78`,
    `briefCustomer.ts:62`, `answerQuestion.ts:54`) or introducing one.

## Decision Points

These are forks the current code creates. Stated factually; no recommendation.

**1. Which of the four Sonnet call sites are in scope.** They share a shape but not a job:
`sonnetClassifier` is a 2-field boolean verdict (~219 tok fixed overhead, `max_tokens: 256`);
`sonnetExtractor` fills 13 optional fields including a free-form `attributes` object;
`sonnetBriefer` and `sonnetAnswerer` write prose *and* must ground every claim in a real
`captureId`, with hallucinated ids dropped by `validateCitations`. Moving all four is one edit
pattern; moving only `classify` is a smaller blast radius but captures only the smallest of the
four prompts.

**2. Where the provider switch lives.** Today: four files, four hardcoded `'claude-sonnet-4-6'`
strings, four `new Anthropic({apiKey})` constructions. The options the code shape allows are
(a) edit each `sonnet*` function in place, (b) add a sibling `glm*` implementation per file and
choose at the injection sites (all of which already accept a `deps.` override), or (c) introduce a
shared provider module the four import. `scripts/eval-date-reliability.mjs:123-165` already
contains a working two-adapter pattern (`callOpenAI` / `callAnthropic`) with tool calling on both
sides, so the wire-shape translation is already written once in this repo.

**3. Wire shape: Anthropic tool-use vs OpenAI-compatible function-calling.** The four inline calls
read `message.content.find(block => block.type === 'tool_use')` and cast `toolUse.input`. The
OpenAI-compatible shape is `choices[0].message.tool_calls[0].function.arguments` — a **JSON
string** that must be parsed (`eval-date-reliability.mjs:140`, `safeJSON` at `:166`). Also
`input_schema` → `parameters`, and `tool_choice:{type:'tool',name}` → the OpenAI `tool_choice`
form. A switch means either translating at each call site or writing one adapter.

**4. What happens to the "no tool_use block" error path.** All four sites throw a specific error
when the forced tool is missing. GLM-5.2's compliance with a *forced* single-tool call on the
DeepInfra endpoint is not exercised anywhere in this repo — the eval harness uses optional
tools (`tools: condition === 'C'`, `eval-date-reliability.mjs:176`) and has a text-extraction
fallback (`:181`) that the production call sites do not have. In the webhook path that error
becomes `transient_error` → 503 → Composio retry (`webhook.ts:295-298`).

**5. Type coercion for non-string tool args.** `classify_email.isWork` is a boolean and
`record_extraction.laborHours` a number; both are consumed via a bare cast
(`toolUse.input as Classification`). The repo already carries a recorded GLM quirk of emitting
quoted integers, and `src/mcp/server.ts` has `intArg` coercion for exactly that reason. A GLM
classifier either inherits that coercion or trusts the raw types.

**6. Whether the heartbeat work and the classifier work are the same project.** The recorded
priority order in the 2026-07-20 plan is: (1) kill/shrink the heartbeat inference, (2) improve
caching for real traffic, (3) the model comparison, (4) tool-search. Items 1–2 are about the
agent's ~8.7k-token catalog prefix; the classifier swap touches none of that prefix and none of
the ~99%-of-turns heartbeat traffic. They are independent levers on different token pools.

**7. Cost arithmetic depends on which token pool dominates.** For an inline classify call the
input is `~219 fixed + email body` and output is capped at 256 tokens — input-heavy, output-tiny.
Sonnet 4.6 lists at $3.00/1M in; the recorded GLM-5.2 figure is $0.95/1M in. Nothing in these
calls is cacheable at either provider today (constraint 3), so the comparison is uncached-input
rate × volume, with no cache-rate term — unlike the agent turns, where cache rate is the
dominant variable.

## Open Questions

- **Does GLM-5.2 on DeepInfra reliably honor a *forced* single-function `tool_choice`?** Not
  exercised in this repo. The eval harness only ever offers the tool optionally.
- **Actual DeepInfra cache TTL.** Listed as an open action item in the 2026-07-20 plan
  ("Confirm DeepInfra cache TTL"); the doc infers only that it is < 30 min from heartbeat gap data.
- **Current GLM-5.2 pricing and caching semantics.** Recorded 2026-07-20 with citations; per
  CLAUDE.md's external-services rule these need re-verification against live vendor docs before
  being load-bearing.
- **Real per-day classify/extract volume.** The code shows the *shape* (1 per inbound message;
  ≤25 per Gmail pull run) but the repo holds no measured counts. The 2026-07-20 diagnosis parsed
  OpenClaw session logs (`/sandbox/.openclaw/agents/main/sessions/*.jsonl`) for agent turns only —
  the inline Anthropic calls happen in the Render web service and are not in those logs.
- **Whether the Render service emits any usage telemetry for the four inline calls.** No
  `usage` field is read anywhere in `src/` — the four call sites discard `message.usage`
  entirely, so per-call token counts are not currently observable from inside the app.
- **Classification quality baseline.** `classify.ts:37-38` notes the classifier was "verified by
  a live spot-check (not in the always-run suite)" — there is no codified accuracy fixture to
  compare a replacement model against, unlike the date task which has
  `scripts/eval-date-reliability.mjs`.
