---
date: 2026-09-23
branch: work/step-2-manager-seat-s2-on-the-seat-glue
commit: a22e5c3
topic: Step 2 measured — the Copilot SDK's plan mode, Jev choosing plan mode per message, and Jev as the manager seat's tool search
supersedes: nothing (extends thoughts/shared/research/2026-09-23-step-2-manager-seat-on-the-seat-glue.md, Decision Points 6 and 7)
---

# Plan mode and Jev tool search — what was measured

## Summary

Two operator questions for the manager seat, answered by driven tests on a laptop against the
worktree's LOCAL spine (never the pilot), with the same engine (`@github/copilot-sdk` 1.0.14, mode
"empty"), model route (`@preset/trades-seats`, served by Gemini 3.8 Flash on every call) and
responses wire as the live seat. (1) **Plan mode**: the SDK's plan mode is a prompt, not a gate —
but it behaves, and Jev (TypeSafe's calibrated classifier) can decide per message whether to plan,
with the glue switching the session mode before each send. Operator ruling: **plan mode ON, chosen
by Jev.** (2) **Tool search**: with the manager's ~49 tools, having Jev pick tools on demand works
as well as a strong language model picking them and costs about the same per message as simply
loading every tool. Operator ruling: **all tools loaded for step 2; the Jev tool search is the tested
option for when the catalog grows** (e.g. Composio). Harness: `scripts/seat-eval/`; raw results:
`thoughts/shared/evals/seat-tool-search-2026-09-23/`.

## Entry Points

- `scripts/seat-eval/plan-mode/test.mjs`, `test2.mjs`, `probe-mcp.mjs`
- `scripts/seat-eval/tool-search/run.mjs` (seat runs), `score.mjs` (Jev offline), `compare.mjs` (three arms)
- `scripts/seat-eval/tool-search/seat.mjs` — the manager seat as step 2 would build it

## Key Files

- `tool-search/corpus.jsonl` — 300 synthetic manager messages, 13 categories, `needs`/`alsoOk` labels;
  ~22% hard (multi-request, vague, hidden relative dates, obvious-tool-is-wrong) + 36 follow-ups.
- `tool-search/catalog-spine.json` — the real manager catalog: **45 spine tools, ~19K tokens** of
  descriptions + schemas (chars/4; `query_spine` alone ~2.7K).
- `evals/seat-tool-search-2026-09-23/{ref,cmp-jev,cmp-all2}.jsonl` — every turn's searches, tool
  calls, replies, tokens, and cost from OpenRouter's generation record.

## Data Flows

### Plan mode (27 runs, stand-in tools, then a 12-message conversation ×2)

```
glue: Jev "plan first?" (message) ─► session.rpc.mode.set(plan|interactive) ─► send
engine (plan): model plans ─► exit_plan_mode ─► onExitPlanModeRequest ─► approve → "autopilot" / reject
```

| Setting | Result |
|---|---|
| `send({agentMode:'plan'})` per message | no effect, by design: `agentMode` is documented as a LABEL of the mode the message was sent in (`types.d.ts:2792-2796`); 12/12 stayed interactive |
| session `rpc.mode.set({mode:'plan'})` | planned + asked approval 7/9; approve → "autopilot"; reject → nothing ran 3/3 |
| session plan + "just do it now" | one run skipped the plan and wrote/sent — operator: **correct behaviour** |
| engine enforcement | none for MCP or custom tools (its bundled block covers shell/file writes outside the session folder); our `onPermissionRequest` sees every call |
| Jev per message + `rpc.mode.set` before each send (12 msgs ×2) | Jev 48/48 right, stable; switch took effect 24/24 (incl. back from "autopilot"); approval asked 10/10 with 0 writes before it; quick turns never planned; 1/10 approved plans then did nothing |

### Tool search (100 messages reference + 3 arms on 31)

```
seat ─► find_tools("record a payment on a job") ─► retriever (Gemini reference | Jev)
     ─► glue adds the returned tools: session.rpc.tools.set(visible)  (mid-turn, measured to work)
     ─► seat calls the tool
```

- The engine's own tool search NEVER deferred our tools: 0 of 45 under every config tried
  (`toolSearch:{enabled:true, deferThreshold:1}`, builtin name in `availableTools`, with/without
  override) — `probe-defer.mjs`. The glue-run search above is the working route: spine tools served as
  the glue's own tools, every handler registered (`session.registerTools`), the model's visible set
  swapped with `session.rpc.tools.set`.
- Reference run: 100 messages (every category; 32 hard, 15 follow-ups), 228 real searches, $10.20.
  **The seat bundles capabilities in one search** despite being told one per search (48 of 138 scored
  searches led to more than one tool) — so "Jev's single top pick" is the wrong policy.

**Jev scored offline on the 138 searches that led to a tool call** (3 repeats each; ground truth =
tools the seat called after the search; biased toward the reference's returns, so "all found" is a
floor):

| Jev policy (full descriptions) | all needed found | at least one found | tools loaded |
|---|---|---|---|
| top 1 | 67.6% | 90.8% | 1.0 |
| 2 if top p ≥ 0.6, else 5 | 82.6% | 98.3% | 2.4 |
| top 3 | 83.1% | 96.4% | 3.0 |
| top 5 | 87.2% | 98.3% | 5.0 |

Jev stability (same top pick across repeats) 98.6%; p50/p95 378/474 ms; $0.18 for 532 calls. Short
(first two sentences) vs full descriptions: within a point of each other.

**Three arms on the same 31 messages** (clean runs, one at a time; cost = OpenRouter's records):

| | reference (Gemini picks) | **Jev picks** (2-if-sure-else-5) | **all tools, no search** |
|---|---|---|---|
| every labelled tool called | 24/31 | 22/31 | 22/31 |
| needed tools covered | 88.1% | 84.7% | 84.7% |
| cost / message | $0.105 | $0.112 | $0.121 |
| seconds / message | 62 | 58 | 62 |
| prompt tokens / model call | ~18.6K | ~20.3K | ~35.5K |
| model calls / message | 10.4 | 11.3 | 12.0 |

Differences are within noise (31 messages, one run each). Why search does not save money here:
every search is an extra model request that does no work, and changing the tool list mid-turn stops
OpenRouter reusing the prompt prefix at the cached rate; the ~8–10K-token rulebook rides every call
regardless.

## External Dependencies

- Jev: `typesafe/jev-1.13` via `POST https://openrouter.ai/api/alpha/decisions` (`choice` over the
  catalog with a `none_of_these` option; `noul` for plan-or-not). Per-option descriptions ARE the
  context Jev reads.
- OpenRouter generation records (`/api/v1/generation?id=`) for every cost figure.

## Constraints and Invariants

- Tests ran on the local stack only; the seat's writes landed in the local DB.
- The key is shared with the live seats: its month-to-date usage went $59.30 → $84.75 across these tests
  (≈$25, including any live-seat traffic in that window), leaving $15.25 of the $100 monthly limit.
- Traps hit: (1) chaining two runs in one background shell and killing the first starts the second —
  two runs in parallel timed out 18/59 turns and polluted the first all-tools numbers (discarded,
  kept as `cmp-all.contaminated.jsonl` in the session scratchpad only); (2) a finished run can hang on
  a leftover stdio connection — `run.mjs` now ends with `process.exit(0)`; (3) the key's `usage`
  field lags — price from generation records.

## Decision Points

Decided by the operator on 2026-09-23 (task record `20260923-step-2-manager-seat-s2-on-the-seat-glue`):
1. **Plan mode: ON, chosen per message by Jev**; the glue sets the session mode before each send and
   resets it after; Go/Change buttons approve; the invoice send's Approve still guards the send; the
   glue catches "approved but nothing followed".
2. **Tool search: OFF for step 2 — all tools loaded.** The Jev tool search (glue-run `find_tools` +
   `rpc.tools.set`, policy "2 if p ≥ 0.6 else 5") is the measured option to switch on when the
   catalog grows past what loading everything can carry.

Open: the cost lever for the manager seat is the rulebook + tool descriptions (~19K of tool text),
not search.

## Open Questions

1. At what catalog size does Jev search start to win on cost? (Composio's manager session adds a
   whole app catalog — not measured.)
2. Would picking tools once per message up front (one swap before the first model call, then
   cache-stable) beat on-demand search? Not tested (it gives Jev the manager's whole message).
3. Label quality: the 300 labels are one writer's; 7–9 of 31 messages missed a labelled tool in
   EVERY arm, which points at the labels as much as the seat.
