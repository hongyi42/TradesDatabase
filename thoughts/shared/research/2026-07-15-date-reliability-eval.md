---
date: 2026-07-15
branch: feature-date-grounding-resolve
topic: How reliably can the agent turn a spoken day ("this Friday") into a real date, and how much do grounding + a resolve_date tool help?
---

## Why

The pilot manager said "book Tom for **this Friday**" (today = Wed 2026-07-15) and the
bot booked **Saturday 2026-07-18**. The model computed the date wrong. This eval measures
how often the agent lands on the correct calendar date, and whether the two fixes
(Option 1 = rich grounding; Option 2 = a deterministic `resolve_date` tool) actually move
the needle.

## Method

`scripts/eval-date-reliability.mjs` — 98 cases (14 phrase templates × 7 reference "today"s
chosen to stress the math: mid-month, month-end, year-end, near a leap day, various
weekdays), run under three conditions:

- **A — bare date**: system prompt has `Current date: YYYY-MM-DD` only (what OpenAI/Anthropic
  inject by default; the model still computes the weekday + arithmetic itself).
- **B — rich grounding (Option 1)**: `Right now it is Wednesday, July 15, 2026 (…)` — the
  weekday spelled out, no tool.
- **C — grounding + tool (Options 1+2)**: B plus the `resolve_date` tool the model must call;
  the model parses the phrase, deterministic code does the arithmetic.

Ground truth is computed independently of `src/schedule/dateResolve.ts` (plain JS Date in the
harness), so condition C is a real cross-check, not a tautology.

**Reference model: `claude-haiku-4-5` (Haiku 4.5)** — a harness validation + directional
reference, NOT the production bot. The bot runs **GLM-5.2**; that run is pending an inference
key (see Open Questions).

## Results (Haiku 4.5, 2026-07-15)

| Condition | Correct | Accuracy |
|---|---|---|
| A — bare date | 75/98 | 76.5% |
| B — rich grounding | 78/98 | 79.6% |
| C — grounding + resolve_date | 88/98 | **89.8%** |

Condition C called `resolve_date` on 97/98 cases.

**The load-bearing finding:** *every one of condition C's 10 misses was the phrase
"next \<weekday\>".* On all **84 unambiguous** cases, condition C scored **84/84 = 100%**.
Per-template, condition C was perfect (7/7) on today, tomorrow, the-day-after, in-3-days,
a-week-from-today, this-\<wd\>, this-coming-\<wd\>, two-weeks-from-\<wd\>, and explicit dates —
and only failed on `next-friday` (3/7) and `next-monday` (1/7).

## Interpretation

1. **The tool eliminates arithmetic error.** Baseline errors clustered exactly where the live
   bug was — "this Friday", "two weeks from…", and every year-boundary case. All of them go to
   100% under condition C, because the model only has to *name the parts* (weekday + weeksAhead)
   and the code counts the days.
2. **"Next \<weekday\>" is not a computation bug — it's genuine ambiguity.** English speakers
   disagree whether "next Friday" means the coming Friday or the following week's. No tool can
   resolve an ambiguous input; the model's disagreement with our convention is the ambiguity
   surfacing, not a math error. The correct product behavior is to **confirm the exact date**,
   not to compute one. Acted on: the `resolve_date` description and the AGENTS.md §0f block now
   tell the agent to resolve BOTH candidates for "next \<weekday\>" and ask which.
3. **Grounding alone (B) barely helps** (+3 pts): handing the model the weekday removes one
   hidden step, but it still does the final arithmetic unreliably. The tool is what matters.

## Open Questions

- **The real number is GLM-5.2's, not Haiku's.** Haiku is a stronger model than GLM-5.2 and
  its 76.5% baseline is likely *better* than the bot's. The value of condition C is that its
  accuracy is bounded by *tool-calling reliability + argument choice*, not raw arithmetic — so
  it should hold up even on a weaker model, but that must be measured. Re-run with
  `EVAL_PROVIDER=openai EVAL_MODEL=z-ai/glm-5.2 EVAL_INFERENCE_BASE_URL=<nvidia/deepinfra> EVAL_INFERENCE_API_KEY=<key>`.
- Does GLM reliably *call* `resolve_date` at all? Haiku did (97/98). If GLM skips it, the
  AGENTS.md §0f instruction strength (and possibly a per-turn nudge) is what to tune.
