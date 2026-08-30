---
date: 2026-08-30
branch: feat/job-notepads-recovered
commit: d726b5e
topic: What every eval observes, build by build — and which ones the harness rebuild invalidates
supersedes: nothing
---

## Summary

We have seven eval harnesses and two instruments. Six of the seven watch things the
harness rebuild does not touch — the spine's tools, the seat agents, date arithmetic — and
survive unchanged. The seventh, the **agentic planner eval**, is the only one that watches the
planner think, and it is the one built on top of the structure we are stripping away: **57 of its
expectations grade "did the planner pick verb X"**, and build 6 turns that verb list into a
suggestion. Separately, the last three builds each removed an observation without replacing it, so
coverage today is *lower* than when the rebuild started.

## The harnesses that exist

| harness | subject | spends money | what it observes | rebuild impact |
|---|---|---|---|---|
| **date-eval** `scripts/date-eval/` | seat agents, live box | yes | does a phrase ("next Monday") become the right calendar date | none — different subject |
| **spine-eval T1** `src/eval/toolCases.ts` | the MCP tools, no model | no | correctness, per-tool latency, tier gating, cross-tenant isolation | none |
| **spine-eval T2** `run-agent.mjs` | seat agent + real model + real MCP | yes | tool choice, confirmation discipline, fabrication | none |
| **spine-eval T3** `run-gateway.mjs` | the same, run by the production gateway | yes | does production's own wiring behave like T2 | none |
| **spine-eval gate** `gate.mjs` | the above | no | one pass/fail screen + an anti-tamper seal over corpus, graders and thresholds | seal must be re-baselined whenever the corpus changes |
| **planner-copy eval** `scripts/planner-eval/` | the planner's *manager note* only, on pre-gathered context | yes | blame, over-claiming, length, usefulness, fabricated dates, cache cost | partial — predates the one-call collapse, so it never sees the *technician question* the planner now also writes |
| **agentic planner eval** `src/eval/planner{Corpus,Sim}.ts` + `plannerEvalGraders2.ts` | **the planner as an agent, through its real tool loop, across a gap's whole life** | yes | see below | **this is the one that breaks** |

Two **instruments**, not evals — they report, they do not pass or fail:

- `npm run ticks` — per firm: turns p50/max, duration p50/max, limit hits, which firms were
  planned/skipped/errored, and what it cost.
- `npm run memory:planner` — what each firm has written, `updated_at` per file, and whether the
  index still mentions it. Version counts are the churn signal.

## What the agentic eval actually grades

62 scenarios in eight families, each citing its provenance — a live specimen, a user ruling, or a
metric definition:

- **FC false claims** — don't tell a manager "nobody replied" when a reply is on the record.
- **CM context-miss** — our measured failure mode is context and vocabulary, not reasoning.
- **PM premature** — escalations the manager then dismisses.
- **LS late / stuck** — the opposite error, and the specimen that escalated at 6h because the *day*
  was ending.
- **PJ people judgment** — the technician may not know, may not have been there; escalation can be
  the correct answer.
- **MG multi-gap** — one job, several questions: shared evidence must not close both.
- **WD day edges** — re-purposed after the send window was deleted: does it use the freedom sensibly.
- **SMOKE** — the harness works at all.

Graded five ways: `action` (the verb applied), `mustName` / `mustNotClaim` (what the note says),
`mustRead` (**did it look before deciding** — the thing no other harness measures), and `arc`
(escalation count, close count, whiplash, cross-credit, grouping coherence, closed-by).

## Build by build

| build | what it gave the planner | what watches it | the hole |
|---|---|---|---|
| ① eyes see the record | money is visible on a visit gap | `costWorld` scenarios | no expectation names money directly |
| ② the mouth stops lying | it authors the manager note | **planner-copy eval** — the only harness on prose | still runs on pre-gathered context |
| ③ the brain can attribute | closing becomes its judgment; sweep keeps facts + fail-safe | FC / MG families, `arc.maxCloses`, `minCloseTicks` | — |
| ④ the brain can look | reads captures, nudges, review items | `mustRead` | nothing checks it read the *right* thing |
| ⑤ memory architecture | gap summaries, lessons, Reflector | 4 `lessons` scenarios | **all deleted 2026-08-30 — nothing replaced them** |
| ⑥ agentic eval | — | it *is* the harness | — |
| one-call collapse | it writes and queues the technician question itself | **nothing** | the biggest single gap: no harness reads that message |
| the ask shape | one message may cover several gaps | `arc.groupingCoherent` | grades coherence, never *judgment* — should these have been grouped? |
| the tick leaves a trace | — | `npm run ticks` | instrument only |
| **1 OpenRouter** | ten providers, GLM 5.3 | date-eval ran on it (49/49 unambiguous) | no failover rehearsal |
| **1b execution envelope** | 15-min clock, no turn ceiling | `npm run ticks` distribution | the runaway alarm **has never fired against a real runaway** |
| **2 the firm is data** | per-firm cadence; send window deleted | WD family re-purposed | nothing measures cadence-from-approximate-hours |
| **3 the planner's memory** | writes and reconciles its own `.md` files | `npm run memory:planner` (churn only) | **nothing measures whether a memory ever changed a decision** — the `[8-hex]` stamp was the only mechanism and it died with `planner_lessons` |
| retire gap_summaries | — | — | `manager_fate` — *"does escalating work at this firm"* — is now observable **nowhere** |
| job notepads | per-job prose it reads and rewrites | nothing yet | no scenario writes or re-reads a note across an arc |

## The verb-coupling problem

This is the finding that decides how much of the corpus survives.

The corpus grades **verb names**: `action: 'escalate'`, `actionNot: 'close'` — 57 expectations in
total (14 not-escalate, 10 escalate, 9 close, 8 not-close, 7 extend, 4 send, and the rest). Build 6
makes the verb list *"a SUGGESTION, not a state machine"*. When the vocabulary moves, every one of
those expectations grades against a name that may no longer mean the same thing — and a corpus that
fails for vocabulary reasons teaches nothing.

The fix is not to delete them. Every one encodes a real judgment, and the judgment survives the
vocabulary. What has to change is the *level*: grade the **outcome** ("the manager was brought in",
"the gap ended without anyone being asked", "the technician was asked once, not twice"), not the
token the model emitted.

A second coupling, smaller but real: the corpus's authoring rail requires every seeded gap's
deadline to fall **after the first tick**, because *the sweep runs first and would escalate a stale
gap before the planner sees it*. Build 5 stops the sweep deciding. That rail becomes wrong — not
loose, wrong — the moment it lands.

## What is worth observing that nothing measures today

Drawn from the plans, in rough order of how much the product rests on it:

1. **The technician question itself.** The planner writes it (one-call collapse) and no harness reads it.
2. **Whether memory changes anything.** Build 3's whole premise, unmeasured.
3. **Whether reconcile-first corrects a stale belief.** Seed a memory the record contradicts; see if it survives the tick.
4. **Whether escalation works at this firm** — the `manager_fate` rollup, now derivable live but not derived.
5. **Grouping judgment**, not just grouping coherence.
6. **Notepad use across an arc** — does it write one, and does re-reading it change the next decision.
7. **Elapsed time as a fact** — build 3 tells it when it last ran; nothing tests it acting on that.
8. **Memory growth** — one file per gap is the named failure mode, and the runtime has no bound to hit.
9. **The runaway alarm**, which has never fired against a real runaway.

## Decision points

- **Re-level the corpus or rewrite it.** Re-levelling to outcomes keeps 62 scenarios' worth of
  provenance; rewriting starts from documented specimens again and costs weeks.
- **When to re-baseline.** The gate carries an anti-tamper seal over corpus + graders + thresholds,
  so any corpus change is a deliberate, visible re-baseline. Doing it once at the end is cheaper
  than after each build; doing it per build is the only way to know which build moved a number.
- **Whether the planner-copy eval merges into the agentic one.** It is the only harness that grades
  prose, and the prose it grades is now half of what the planner writes.
