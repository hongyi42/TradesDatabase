---
date: 2026-09-28
branch: work/step-2c-batching
commit: 2bd0786
topic: Step 2c spike — do the Copilot SDK's sub-agents work on the seat glue, and do they help a 100-email job?
supersedes: nothing
---

## Summary

Operator 2026-09-28: batching is step 2c, "using the Claude Code documented pattern" (sub-agents with
clean contexts + notes; https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents,
https://code.claude.com/docs/en/agents), and "run the spike first". Harness:
`scripts/seat-eval/batching/spike.mjs` — the real engine (Copilot SDK 1.0.14, mode "empty", our
`sessionConfig`) and model (`@preset/trades-seats`), a FAKE mailbox of 100 emails served by custom
tools (12 urgent, only in the body), scored on how many of the 12 customers the final answer names.

**Verdict: sub-agents work on the glue, and help — but four things must be built before they ship.**

## Results (setups: A no sub-agents / B customAgents only / C customAgents + `builtin:task`)

| run | secs | urgent named | main-context peak | sub-agents |
|---|---|---|---|---|
| A (batch4) | 92 | 12/12 | 30,572 tokens | — |
| B (batch4) | 82 | 12/12 | 30,538 | never used (the `task` tool is not available without `builtin:task`) |
| C (batch4) | 69 | 12/12 | 6,577 | 5 (1 trial, then 4 **in parallel**, same ms) |
| C + dedupe (batch5) | 63 | 12/12 | 6,497 | 5 |

- **Delegation = the engine's built-in `task` tool**, `{name, prompt}` (and an agent type), enabled by
  `availableTools: [..., 'builtin:task']` + `customAgents: [{name, description, prompt, tools, infer:true}]`.
  B proves the agent definition alone does nothing. Parallelism came without asking ("Fleet Mode" not needed).
- **The main context stays ~5× smaller** with sub-agents (6.5K vs 30.5K tokens): each returned a few lines.
- Accuracy was 12/12 in every run that finished.

## Found — must be handled before 2c ships

1. **The engine dispatches a sub-agent's tool call TWICE.** `external_tool.requested` arrives twice with
   the same `requestId` (219 events / 114 unique ids; 100 ids twice), and the SDK runs the handler on
   each (`session.js:621-638`, no dedupe). Measured: every sub-agent `get_email` and `write_note` ran
   twice, 0–10 ms apart; the main agent's calls ran once. Harmless for reads, **a double send for a
   send tool**. A guard in our tool wrapper — a repeat of the same `toolCallId` gets the first run's
   result — fixed it (batch5: 105 repeats answered, every tool once, 12/12).
2. **Sub-agents' messages flow through the main event stream** (22 of 26 `assistant.message` in C),
   including their narration and final lines. They carry **`agentId` on the event envelope** (absent for
   the main agent; `session-events.d.ts`). The glue must drop `agentId` events from held text, replies,
   the transcript and the prompt bookkeeping, or a sub-agent's line reaches Telegram as the answer.
3. **Sub-agents' model calls are missing from the stream's `api_id`s** (C: 7 generation ids vs dozens of
   calls), so the cost log (priced from OpenRouter generation records) would under-count them. Open:
   where their generation ids surface (the `subagent.completed` data carries token/tool totals).
4. **The `task` call itself asks no permission** (only the sub-agents' own tool calls do), so the glue's
   pending tracking and Stop see the sub-agents' tools but not the delegation. Untested: Stop mid-sub-agent.

## Also seen

- **OpenRouter "400 Provider returned error"** ended one C run and one A run here (4 times today across
  the rigs, always mid-way through tool-heavy work). Separate from batching; worth its own look.
- The engine can end a turn with an EMPTY `assistant.message` after the real answer.
- The model infers rather than reads when the fixture lets it: telling subjects (run 1), bare vendor
  addresses (run 2) and unique urgent surnames (last A: 26 reads, 12/12). The real 2c gate needs
  realistic mail, not a fixture with tells.

## Decision points for the 2c plan

- Ship sub-agents (C) with the four fixes above, vs notes-only (A: works, slower, 5× the context).
- The sub-agent's tool list (read tools + write_note/write_file only — never send tools, even with dedupe).
- A cheaper model for sub-agents (`customAgents[].model`) — cost not yet measured.
- The gate: a driven test on realistic mail (a seeded mailbox, or Composio Gmail on a test account).
