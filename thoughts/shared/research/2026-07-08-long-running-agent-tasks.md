# Long-running agentic tasks — how the field handles large backlogs

**Date:** 2026-07-08
**Author:** ragi (via Claude)
**Status:** research complete — feeds the email-cleanup batching decision
**Method:** deep-research harness (5 search angles → 21 sources fetched → 99 claims → 25 adversarially verified 3-vote). All load-bearing claims cited to primary docs; verified against **live** docs per CLAUDE.md.

---

## Why this research exists (the grounding case)

Judy's beta box (sandbox `s3`, OpenClaw running **GLM-5.2 via DeepInfra**) was asked to clean a
**~38,000-email inbox** (16k promos + 4.6k social + 18k updates). It **streamed for the full 600s
per-run timeout** (`agents.defaults.timeoutSeconds=600`) and **died**, with the prompt **ballooned to
~115k tokens** because it kept every touched email in context. A follow-up Composio remote-workbench
batch call also timed out.

Two failure modes, one root cause — **the whole job was crammed into a single unbounded run**:
1. **Wall-clock:** 38k items cannot finish in one 600s window.
2. **Context:** keeping every touched item in-context overflows the window and degrades quality
   ("context rot") long before it hard-fails.

The question this research answers: **what do Anthropic, OpenAI, and the agent-eng field actually do
so a long task doesn't die this way?**

---

## The one distinction that governs everything below

Every mechanism is either:
- **PLATFORM** — the model API/SDK does it for you (you flip a flag), or
- **DEVELOPER** — you build it in your harness/prompt.

**This matters enormously for us**, because our agents do **not** run on the Anthropic API. They run
**GLM-5.2 through DeepInfra via OpenClaw**. So Anthropic's *platform* features (compaction, context
editing, memory tool) are **not available to Judy's box** — they're Claude-API-only. The only tools we
actually have are the **DEVELOPER / prompt-level** patterns. Keep this in view: the fanciest answers in
the survey are ones we structurally can't buy off the shelf.

```
                    Available to a Claude-API app     Available to Judy's box (GLM/DeepInfra/OpenClaw)
Compaction (server)          ✅ flag                          ❌ not on this runtime
Context editing (server)     ✅ flag                          ❌ not on this runtime
Memory tool (client files)   ✅ (you build the store)         ✅  — it's just files + prompt discipline
Orchestrator/sub-agents      ✅ pattern                       ✅  — it's an architecture, model-agnostic
Batch + commit-and-resume    ✅ pattern                       ✅  — it's prompt + external state
Durable exec (Temporal/DBOS) ✅ (app-level)                   ✅  — but app/box-level engineering
```

**Takeaway up front:** for us, the answer is necessarily the **developer-implemented** column —
batching + external-file checkpointing + bounded turns — not a platform flag.

---

## Dimension 1 — Context / window management as a task grows

Anthropic ships **three first-party mechanisms**, explicitly designed to be **combined**
([cookbook](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools),
[context-windows](https://docs.anthropic.com/en/docs/build-with-claude/context-windows)):

| Mechanism | What it does | Trigger / defaults | Platform or Dev |
|---|---|---|---|
| **Server-side compaction** (`compact_20260112`, beta `compact-2026-01-12`) | Distills the conversation into a high-fidelity summary and continues past the window limit — "the **primary strategy**" for long-running workflows | input-token threshold, **default 150K, min 50K** | **Platform** (opt-in: beta header + `context_management` param) |
| **Context editing / tool-result clearing** (`clear_tool_uses_20250919`) | Auto-clears **oldest tool results first**, replacing each with placeholder text; leaves user messages, reasoning, and `tool_use` records intact | default **100K** input tokens; `keep` last **3** tool pairs; `clear_at_least`, `exclude_tools`, `clear_tool_inputs` | **Platform** (opt-in, developer-tuned) |
| **Memory tool** (`memory_20250818`, **GA**) | File store under `/memories` (`view/create/str_replace/insert/delete/rename`). Claude *requests* ops; **your app executes them** against storage you control. Enables **just-in-time retrieval** — record what you learn, read it back on demand | model-driven | **Developer** (you own the backend; SDK ships a filesystem default) |

Key framing from the docs:
- **"Context rot"** — accuracy/recall *degrade as token count grows*; curation matters as much as raw
  window size ([effective-context-engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
  This is exactly Judy's 115k-token failure: even without the hard limit, quality was rotting.
- For long-running agents, docs recommend **compaction + memory together**: "compaction keeps the active
  context small without client-side bookkeeping, and memory preserves the information that must survive
  summarization" ([memory-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).
- The memory tool auto-injects a **checkpoint protocol** (see Dimension 4).

**For us:** compaction/clearing are off the table (not our runtime). The transferable idea is the
**memory tool *pattern*** — an external file the agent writes progress to and reads back — which OpenClaw
can do with plain files in `/sandbox/.openclaw/workspace/`. And the deeper lesson is **don't keep every
email in context at all** — process, record the outcome to a file, drop it.

---

## Dimension 2 — Task decomposition (sub-agents / orchestrator-worker)

**Anthropic's canonical pattern** is orchestrator-workers / multi-agent
([multi-agent-research-system](https://www.anthropic.com/engineering/multi-agent-research-system),
[building-effective-agents](https://www.anthropic.com/research/building-effective-agents)):
- A **lead/orchestrator** agent decomposes the task and **delegates to specialized subagents that run in
  parallel — each with its OWN independent context window**. It spawns "3–5 subagents in parallel."
- Subagents **compress**: each returns "only a condensed, distilled summary (often **1,000–2,000
  tokens**)" instead of raw work. The separate contexts are *the mechanism* that stops any single window
  from holding the whole job.
- Anthropic recommends **bounding runs with explicit stopping conditions** (e.g. a max-iterations cap)
  rather than letting an agent loop unbounded.

**OpenAI Agents SDK** offers two developer-composed primitives
([multi_agent](https://openai.github.io/openai-agents-python/multi_agent/),
[handoffs](https://openai.github.io/openai-agents-python/handoffs/)):
- **Handoffs** — a triage agent routes to a specialist that becomes the active agent (`transfer_to_<name>`).
- **Agents-as-tools** — a manager keeps control and calls specialists via `Agent.as_tool()`, owning the
  final answer.
- Notably, OpenAI **advises against premature multi-agent decomposition** — start single-agent, add
  specialists only when they materially improve isolation/clarity.

**For us:** decomposition is model-agnostic and *does* apply — but a 38k-email cleanup is **homogeneous
bulk work**, not a research fan-out. The relevant slice isn't "5 parallel researchers"; it's the
**bounded-turn** discipline (process a chunk, return a compressed result, don't accumulate) plus **an
explicit stopping condition per turn**. Full multi-subagent orchestration is heavier than this job needs.

---

## Dimension 3 — Batching + commit-and-resume (THE most relevant dimension for us)

The direct primary source is Anthropic's
**[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)**.
Its recipe:
- **Compaction alone is insufficient** for sustained multi-session progress.
- **Durable progress = developer-implemented checkpointing.** Agents **commit progress to git** with
  descriptive messages and **write summaries to a progress file** (`claude-progress.txt`) — *not* a
  platform durable-execution feature.
- **Role split:** an **Initializer agent** sets up the environment once; a **Coding agent** does
  incremental work in later sessions. (They share system prompt/tools; differ only in the first user prompt.)
- **State is threaded between fresh sessions via durable external artifacts:** git commits per unit, a
  **JSON feature-list tracking completion status**, and an `init.sh` for reproducible setup — enabling
  **commit-and-resume over a large task**.

Reinforced by [effective-context-engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents):
- **Compaction** = summarize near the limit and **reinitialize a fresh window** with the summary,
  keeping decisions/open items, discarding redundant tool output.
- **Structured note-taking** = persist notes to memory outside the window, "minimal overhead across a
  long-running task."
- **Sub-agents** return 1,000–2,000-token distilled summaries rather than one agent holding all state.

**OpenAI's platform surface for bulk work** is the **Batch API**
([batch guide](https://developers.openai.com/api/docs/guides/batch)):
- Async, **24-hour completion window**, decoupled from any per-request timeout; **up to 50,000 requests**
  / 200 MB per job; **separate rate-limit pool**; **50% cost discount**.
- Developer loop: build JSONL → upload → create batch → **poll status by batch ID** → retrieve on
  `completed`. Output order isn't guaranteed — thread identity via `custom_id`.

**For us — this is the blueprint.** Translated to the email case:
> Process **N emails per bounded turn** (~300–500), **commit each batch's outcome to a durable external
> state file** (a cursor + a running tally — the "progress file" / "feature list" analog), **report**,
> then **resume from the cursor in a fresh, small-context turn**. Each turn starts by reading the
> progress file, so context never accumulates and no turn risks the 600s wall.

The state we thread between turns is exactly Anthropic's pattern: a **cursor + JSON status file** living
in the sandbox workspace, read-first at the top of every turn.

---

## Dimension 4 — Durable execution / checkpointing / survive-a-timeout

Two sub-answers: a lightweight one (checkpoint to memory) and a heavyweight one (durable-execution
runtimes). They are **not the same thing**, and the difference is the ceiling on our chosen approach.

**Lightweight — checkpoint to memory (Anthropic).** The memory tool auto-injects a system prompt:
> *"ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE… ASSUME INTERRUPTION: Your context
> window might be reset at any moment, so you risk losing any progress that is not recorded in your
> memory directory."* ([memory-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool))

And in the multi-agent system, the lead agent **persists its plan to Memory because context over
~200,000 tokens is truncated**, then spawns **fresh clean-context subagents via handoffs**, retrieving
the stored plan rather than losing work
([multi-agent](https://www.anthropic.com/engineering/multi-agent-research-system)). This *is* the
commit-and-resume checkpoint primitive: **memory = checkpoint store; fresh turns = bounded resumable units.**

**OpenAI Responses API background mode** ([background](https://developers.openai.com/api/docs/guides/background)):
- `background: true` runs a long request **asynchronously** so it survives client timeouts / dropped
  connections; **poll** the GET endpoint for `status` (queued → in_progress → completed/failed/cancelled);
  developer implements the poll loop.
- Combine with `stream: true`: each event carries a `sequence_number`; a dropped connection resumes from
  the cursor via `starting_after` instead of restarting.
- **Limits:** responses stored only **~10 min** (incompatible with Zero Data Retention); cancel via
  `POST /v1/responses/{id}/cancel`.

**Heavyweight — durable-execution runtimes** (the honest ceiling on prompt-level checkpointing):
- **LangGraph checkpointers** ([durable-execution](https://docs.langchain.com/oss/python/langgraph/durable-execution)):
  persist graph state per **`thread_id`**; `InMemorySaver` (non-durable) vs `PostgresSaver`/`SqliteSaver`
  (survive process death). Developer configures the checkpointer + manages `thread_id`.
- **DBOS** ([customer-service](https://docs.dbos.dev/python/examples/customer-service)): `@DBOS.workflow()`
  / `@DBOS.step()` decorators; state checkpointed in Postgres; a restarted instance **auto-resumes from
  the last completed checkpoint** — no external orchestrator.
- **The sharp critique** ([Diagrid](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows)):
  **"Checkpointing is not durable execution."** Checkpointing frameworks (LangGraph, CrewAI, ADK) give
  save points but **shift recovery to the developer** — **no supervisor/watchdog/heartbeat**, so a
  crashed process **goes unnoticed** and must be manually resumed; and **no coordination** to prevent two
  processes resuming the same `thread_id`. True durable execution makes the **runtime** responsible for
  running to completion, auto-retrying every step.

**For us — the crucial caveat.** Our planned fix is **prompt-level batching + a file checkpoint**. That
is the *lightweight* tier. It has a real ceiling: **prompting steers but does not ENFORCE**, and there is
**no watchdog** — if a turn dies mid-batch, nothing automatically re-invokes it; a human (or the next
Telegram message) has to. That's acceptable for a beta, but name it, and know the escalation path: if the
prompt approach proves too leaky at 38k scale, the next tier is to **move the loop out of the prompt into
the box** — a small systemd/cron worker that re-invokes the agent per batch and owns the cursor (our
local analog of Batch API / DBOS auto-resume).

---

## Comparative synthesis — the consensus architecture

For a **backlog-processing agent that must not die at a per-run timeout**, the field converges on a
**layered** design (verified 3-vote synthesis):

1. **Decompose** so no single context holds the whole job — orchestrator-worker / bounded turns, each
   returning a **compressed** result (1–2k tokens), with an **explicit per-run stopping condition**.
2. **Bound each context** — compaction + tool-result clearing (platform, Claude-API only) *or*, off-platform,
   simply **never accumulate**: process → record outcome to file → drop from context.
3. **Checkpoint to durable external state** — a memory/progress file (cursor + JSON status) that every
   turn **reads first** and **writes to before ending**, so work survives resets and timeouts. This is
   the commit-and-resume core.
4. **(If you need real survival guarantees)** put the **loop in a durable runtime** (background job /
   watchdog / durable-execution framework) rather than trusting the model to resume itself.

Nobody bets a large job on one uninterrupted run. The universal primitive is **"assume interruption;
record progress externally; resume in a fresh small window."**

### Mapping to Judy's box

| Layer | Field consensus | What Judy's box can actually use |
|---|---|---|
| Decompose | orchestrator + parallel subagents | **Bounded turns** (300–500 emails/turn) + hard stop-condition — full multi-subagent overkill for homogeneous bulk |
| Bound context | compaction / clearing | ❌ not our runtime → **don't accumulate**: process, log outcome to file, drop |
| Checkpoint | memory tool / progress file | ✅ **cursor + JSON status file** in `/sandbox/.openclaw/workspace/`, read-first each turn |
| Durable loop | background mode / DBOS / Temporal | ⚠️ **prompt-only for now** (no watchdog); escalate to a box-side cron/worker if it leaks |

**This directly confirms Option B** from the deferred memo (chunked/resumable batching) over Option A
(raise the timeout). Option A fails on all three counts — doesn't scale to 38k, doesn't stop context
bloat, and costs more $/token for less progress. Where it lives is also confirmed: **prompt/harness, not
the TypeScript spine** — the batching block belongs in the sandbox `AGENTS.md` (folded into
`bootstrap-box.sh` §0c + Box_Setup_Stuff so a rebuild doesn't reset it), per
[[box-setup-stuff-sync]].

---

## Caveats & open questions

**Caveats (re-verify before building):**
- All Anthropic context-management IDs are **dated/versioned and several are BETA** (compaction
  `compact_20260112`; context editing `clear_tool_uses_20250919`/`clear_thinking_20251015`, beta
  `context-management-2025-06-27`). Memory tool `memory_20250818` is **GA**. Defaults (150K/50K compaction,
  100K/keep-3 clearing) and the beta model list can shift.
- `docs.claude.com` / `docs.anthropic.com` now 302-redirect to `platform.claude.com` (same content).
- **These platform features are Claude-API-only and do not apply to Judy's GLM-5.2/DeepInfra/OpenClaw
  runtime** — they're cited as field evidence for the *pattern*, not as tools we can flip on.

**Open questions (not fully closed by this pass):**
- Is there an official "**process N items per batch, commit, resume**" *named recipe*, or is it the
  emergent memory-checkpoint + fresh-turn combination the harnesses post demonstrates? (Latter, as far as
  verified.)
- Practical degradation at genuine **38k scale** — compaction summary loss, tool-pairing across the
  summary boundary, ~200k truncation interaction, and cost. Under-evidenced; **must be measured on a real
  large-inbox run** (the memo's own compliance caveat: prompting steers, doesn't enforce).
- Exact OpenClaw mechanics for persisting a cursor file that survives its own per-run lifecycle — a box-side
  implementation detail to pin down when we build.

**Sources:** 21 fetched; primary docs from Anthropic (context-editing, context-windows, memory-tool,
compaction, multi-agent-research-system, building-effective-agents, effective-harnesses-for-long-running-agents,
effective-context-engineering), OpenAI (Agents SDK multi_agent/handoffs, background, batch), LangGraph
durable-execution, DBOS, and two durable-execution analysis blogs. Full list in the workflow journal.

**Related memory:** [[long-running-agent-task-research]], [[nemoclaw-agent-model]], [[judy-beta-account]],
[[box-setup-stuff-sync]], [[telegram-only-surface]].
