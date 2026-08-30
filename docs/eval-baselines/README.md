# Agentic planner eval — archived baseline rows (2026-08-24)

## READ THIS BEFORE COMPARING ANYTHING TO THESE NUMBERS

**These rows were produced by a harness that is being dismantled.** They are kept as
*evidence of how the planner behaved*, **not** as a baseline a future run can be scored
against. Do not open a report that says "we regressed against the 2026-08-24 baseline"
without reading the rest of this file first — after the harness rebuild, a lower number
almost certainly means the harness changed, not that the planner got worse.

Specifically, these runs were executed against a structure that builds 4–7 of the harness
rebuild (`docs/engineering-memory.md` §6a) exist to remove:

| what the rows assume | which build removes it |
|---|---|
| a detected gap **is** a question for somebody | 4 — *a gap is not an ask* |
| the sweep escalates, closes and decides on a schedule | 5 — *the sweep stops deciding* |
| the planner picks from a **fixed list of verbs**, and the verb name is the graded thing | 6 — *intent verbs become a suggestion* |
| detectors **mint** `nudges` rows, which is what a scenario seeds | 7 — *the detectors report* |

Every scenario's timeline also relies on a rail that build 5 invalidates: seeded gaps must
carry a deadline **later than the first tick**, because the sweep would otherwise escalate a
stale gap before the planner ever saw it. Once the sweep stops deciding, that rail is not
loose — it is wrong.

## So what ARE these good for

Three things, all of which survive the rebuild:

1. **Transcripts.** 65 scenarios × 2 arms of what the planner actually read, wrote and
   decided, turn by turn — `toolCalls`, `userPrompt`, `decisions`, and `nudgesAfter` per
   tick. This is the only recorded picture of the planner's judgment under the old harness
   and it cannot be regenerated: the code that produced it is being deleted.
2. **Scenario provenance.** Each row carries its `why` — the live specimen, user ruling or
   metric definition the scenario encodes. Those judgments ("don't tell a manager nobody
   replied when a reply is on the record") are durable; they should be the *input* to
   whatever eval gets built after build 7, even though the graders will be written fresh.
3. **Failure-mode reference.** `docs/agentic-eval-rejudge-2026-08.md` documents which
   apparent failures were judge artifacts rather than planner errors. That analysis is about
   how to grade prose, and outlives the harness entirely.

## What is here

| file | arm | model | rows |
|---|---|---|---|
| `agentic-opus-2026-08-24.results.jsonl` | opus | `claude-opus-5` | 65 (62 graded + 3 harness smokes) |
| `agentic-glm-2026-08-24.results.jsonl` | glm | `accounts/fireworks/routers/glm-5p2-fast` | 65 |

Plus the two `meta.json` files, which carry the token ledger and the simulated `t0`.

Copied out of `spine-eval-runs/`, which is gitignored — that directory is one
`git clean -xdf` from empty, and these were the only copies. The narrative that goes with
them is `docs/agentic-eval-baseline-2026-08.md`; the corrected verdicts are in
`docs/agentic-eval-rejudge-2026-08.md`.

## The headline, for reference only

| | Opus 5 | GLM-5.2 / Fireworks |
|---|---|---|
| deterministic checks | 60/65 | 58/65 |
| re-judged, transcript-aware | 63/65 | 58/65 |
| reads per decision | 3.97 | 3.76 |
| run cost | $5.97 | $1.51 |

Not a benchmark even on its own terms — the original doc already warned these move when the
corpus, prompt, rails or judge change. The rebuild changes all four.
