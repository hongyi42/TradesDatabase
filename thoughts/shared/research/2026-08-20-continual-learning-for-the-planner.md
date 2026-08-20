---
date: 2026-08-20
branch: main
commit: 69c76b7
topic: Continual learning — what the field is saying, and what it means for the team-lead planner
kind: literature + direction (not a codebase survey)
---

## Summary

The team-lead planner makes one model call per firm every 30 minutes and decides what happens to
every open gap. It is very good at reasoning and it has no idea it has ever run before. Three
talks from the August 2026 AI Engineer / Sequoia sessions name that exact failure and call it the
central open problem in agents: models keep getting smarter (**IQ**) while staying permanently on
**day one of the job** (**experience**). The gap between them is what "continual learning" is
trying to close.

The most useful thing this research produced is a **correction to the obvious fix**. The instinct
— "give the planner its previous traces and logs" — is half right. Feeding an agent its *raw*
past trajectories measurably makes it **worse**; feeding it *abstracted* lessons from those
trajectories makes it better. The numbers are in [Sources](#sources) below. So the direction is
right and the representation matters more than the volume.

The second useful thing: our planner's observed failures are **not** reasoning failures. A
stronger model would make the same mistakes, because the mistakes come from having no record of
its own prior actions and no action for "ask again". Yu Su's phrase for a model scaled on
intelligence alone is *the world's smartest novice* — that is our planner today, precisely.

## Sources

Watched in full (transcripts pulled 2026-08-20):

1. **Arjun Karanam (Trajectory) — "Continual Learning: How AI Agents Get Better With Every Use"**,
   Sequoia Capital, 2026-08-13, 22 min. https://youtu.be/eYrMF9Cht8A
2. **Ronak Malde (Trajectory) — "Scaling up Continual Learning"**, AI Engineer, 2026-08-12,
   23 min. https://www.youtube.com/watch?v=zL1kLftVTlo
3. **Yu Su (Ohio State / NeoCognition) — "Intelligence + Continual Learning = Expertise"**,
   AI Engineer, 2026-08-12, 20 min. https://www.youtube.com/watch?v=I6aiEf3aEFQ

Supplementary (fetched, because all three talks assume weight-training and we cannot train):

4. **ACE — Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models**,
   arXiv 2510.04618. https://arxiv.org/abs/2510.04618
5. **When Continual Learning Moves to Memory: A Study of Experience Reuse in LLM Agents**,
   arXiv 2604.27003. https://arxiv.org/html/2604.27003v1

## The load-bearing findings

### 1. Raw traces hurt. Abstraction is the whole trick. (source 5)

The study compared storing **raw trajectories** (full action-observation sequences) against
**insight memories** (~3 LLM-abstracted lessons per episode). Forward transfer to a new task:

| memory unit | ALFWorld | BabyAI |
|---|---|---|
| raw trajectories | **−9.5%** | **−7.5%** |
| abstracted insights | **+6.5%** | **+9.0%** |

Raw traces were not merely useless — they were **negative**. Any "just give it the logs" design
is starting from the wrong side of zero.

### 2. Homogeneous memory collapses at retrieval. (source 5)

When stored experiences were repetitive, **88.5% of queries retrieved the identical item and only
5.4% of stored entries were ever accessed**. Memory growth did not erase old entries; it *diluted*
them until retrieval could not reach them.

This is a direct warning for us: a planner decision log is *extremely* homogeneous — it will be
`hold, hold, hold, hold` for days. A naive similarity-retrieval store over that pool would degrade
into a single repeated item.

### 3. Summarising a growing context destroys it. (source 4)

ACE names two failure modes precisely:
- **brevity bias** — optimising for concise context drops the domain detail that made it useful;
- **context collapse** — iteratively *rewriting* an accumulated context erodes it over time, with
  sharp performance drops.

ACE's fix is structural and worth copying: keep the context as an **itemised list of bullets**,
and apply **incremental delta updates** — small localised edits merged by **deterministic
non-LLM logic**, never a model rewriting the whole document. Roles are split
**Generator → Reflector → Curator**. Crucially it needs **no labelled supervision** — it learns
from natural execution feedback. Reported +10.6% on agent benchmarks, +8.6% on finance, with
*lower* adaptation latency and rollout cost.

### 4. Expertise is a different axis from intelligence. (source 3)

Yu Su's working definitions, which are the clearest framing of what we are actually missing:

- **Intelligence** — the capacity to reason through unfamiliar problems *from available context*.
  Every episode independent. This is what frontier models keep improving.
- **Expertise** — accumulated, situated competence in one specific environment.

> *"Intelligence solves the problem given the context. Expertise brings the right context."*

And: intelligence **expands** the search (brute-force, spin up 100 attempts); expertise
**compresses** it, because it has learned the shortcuts. Expertise includes knowing which rules
have preconditions, when to bend them, and — named explicitly — **when to stop, when it is good
enough**. That last one is literally the planner's job description.

His other load-bearing claim: modern work is not one world but **millions of micro-worlds** —
every profession, every company, every differently-configured install has its own local physics,
too heterogeneous for any static model to compress. Agents must learn *on the job*, per
micro-world. **Every trades firm we onboard is one of those micro-worlds.** This is the strongest
external statement of the thesis this repo is already built on.

His definition of continual learning, which is the one to reason with because it decomposes:

> **adaptive compression of experience into reusable structures for future behaviour**

Four independent choices — *what experience*, *how compressed*, *into what structure*, *used how*
— which is why everyone means something different by the term.

### 5. Traceability is step one, and we are currently failing it. (sources 1, 2)

Both Trajectory talks open on the same point: hundreds of trillions of inference tokens are
generated daily, they are real work with real signal in them, and they are **thrown away**.
Arjun's wish list for anyone building agents, in order:

1. **Trace the whole tree** — including tool calls and sub-agents, not just the top-level action.
2. **Elicit and capture corrective behaviour.** Thumbs up/down is "incredibly noisy" — people
   accept everything and only realise five commits later. The signal is in **edits, undos and
   retries**.
3. **Evals drawn from real traffic, graded through the real harness** — not a variant of it. Make
   every task **roll-outable** (replayable).
4. **Make tool responses informative.** A tool that returns `done` is "incredibly confusing" from
   the agent's perspective and leaves *nothing to learn from* — you cannot tell what was written
   or read.
5. Harnesses should expose **primitives** and let the agent orchestrate, rather than enforcing
   flows designed to stop last-generation models misbehaving.

Two signal classes, which differ in what they license:
- *something went wrong* (drop-off, thumbs-down) → penalise, but **you do not know what right
  looks like**;
- *here is the correction* (a retry that worked, an explicit fix) → high-confidence reward.

And a **hierarchy of pertinence** that decides where a lesson belongs: globally true facts (a tool
that always fails a certain way) → the model; per-org and per-user preferences → **context**.
Arjun's own example: "this company has been delisted" is context, not something to train in.

### 6. What we could *not* use, and why it is still worth knowing (source 2)

Ronak's talk is mostly the training algorithm — **OPSD / on-policy self-distillation**: give the
student model a *hint* (privileged information) to make it a temporarily smarter teacher, then fit
the un-hinted student's log-probs to the hinted teacher's. It removes the need for parallel
rollouts and gives per-token dense reward instead of one scalar. We cannot use any of this: we run
GLM-5.2 through a hosted provider and do not own weights.

Two ideas survive the translation anyway:

- **The 87/100 essay problem.** A single end-state scalar is a terrible teacher — "you would have
  to run through so many examples to work out what a good essay is." Our shadow log records the
  *action* and nothing about why one was better. That is our 87/100.
- **Hint leakage.** If a hint contains the answer, the model learns to shortcut to it, producing
  reasoning that cannot occur at real inference time. The mitigation is to launder the hint into
  *"what should they reasonably have known at that point"*. **This is the exact trap any future
  planner replay-eval will hit** — never put the outcome in the replayed context.
- Also noted: at 50–100 tool calls per trajectory the student diverges and the teacher hedges
  every step, collapsing output into `wait` / `maybe`. Long-horizon continual learning is not
  solved; the field is in what Ronak calls **"pseudo continual learning"** — batched offline
  updates, not true online adaptation. Nobody is further along than that.

## Applying the four-part definition to us

| axis | what we could realistically use |
|---|---|
| **what experience** | the planner's own decisions + outcomes; manager dismissals of review items; technician replies that did/didn't answer |
| **how compressed** | per-gap decision records now; later, per-firm abstracted lessons — **never raw trace dumps** (finding 1) |
| **into what structure** | an append-only itemised list with deterministic merge (ACE's shape), **not** a model-rewritten summary (finding 3) |
| **used how** | injected into the gap block it belongs to — scoped retrieval, never a global similarity pool (finding 2) |

## What this changes about the planner's diagnosis

The three flags raised against Phase 4 re-read cleanly through this lens:

- **Whiplash (send at 18:30 → escalate at 19:00, no new evidence)** is not indecision. There was
  no mind to change: two independent snap judgments from identical inputs. This is the *smartest
  novice* failure, and **a stronger model does not fix it**.
- **`send` on an already-asked row** is Arjun's uninformative-tool-response problem arriving early:
  the apply step would return nothing, so a no-op is indistinguishable from success.
- **No word for "ask again"** is a harness/primitive gap, and the one thing here that no amount of
  context or model strength fixes.

**Consequence for model choice:** raising the planner to a frontier model or higher reasoning
effort is a reasonable experiment *later*, but it is the wrong first move and we currently could
not measure whether it helped — there is no planner eval. Fix the context and the action
vocabulary, then re-measure. (The repo already has the right shape for such an eval:
`scripts/date-eval/` — real traffic, graded through the real harness, mechanical adjudication.)

## Cautions to carry forward

1. **Never store raw traces as the memory unit.** Negative transfer, measured. Abstract first.
2. **Never let a model rewrite the accumulated context.** Append itemised entries; merge with code.
3. **Scope retrieval.** A homogeneous decision log destroys similarity retrieval (88.5% / 5.4%).
4. **Never put the outcome in a replayed context.** Hint leakage produces evals that flatter.
5. **Uninformative results teach nothing.** Every applied decision must return what actually
   happened, including refusals.
6. **Decide where a lesson belongs before storing it** — global vs per-firm vs per-person. We have
   no weights, so everything lands in context today; the *tier* still has to be recorded or
   per-firm quirks will leak across tenants.
7. **Reliability vs plasticity is a real trade-off**, not a bug to engineer away — the designs
   with the best forward transfer in source 5 also forgot the most.

## Open questions

- What is the right **unit** of planner experience — one decision, one gap's whole life, or one
  firm-day? Source 5 suggests the finer unit only wins when entries are genuinely diverse, which
  argues *against* per-decision for our very repetitive log.
- Does a decision record need the **reasoning** or only the decision? Storing reasoning is closer
  to a raw trace (finding 1); storing only the action is closer to the 87/100 scalar.
- Where does a **manager dismissing a review item** enter? That is the highest-value corrective
  signal we have — the human saying "you were wrong to escalate this" — and today it is not
  connected to the planner at all.
- Is there a **per-firm** lesson store, or per-firm-per-person? The pertinence hierarchy says both
  exist; we have evidence for neither yet.
