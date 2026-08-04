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

Two models under the identical (fixed) harness: **`zai-org/GLM-5.2` via DeepInfra — the
production bot's actual model** — and `claude-haiku-4-5` (Haiku 4.5) as a cross-model reference.

## Results (2026-07-17)

| Condition | GLM-5.2 (the bot) | Haiku 4.5 (ref) |
|---|---|---|
| A — bare date only | **69.4%** (68/98) | 75.5% |
| B — rich grounding (Option 1) | 79.6% | 81.6% |
| C — grounding + resolve_date (Options 1+2) | **98.0%** (96/98) | 89.8% |

Both models called `resolve_date` on nearly every C case (GLM 98/98, Haiku 96/98).

**Headline:** on the actual bot, the tool takes date accuracy from **69% → 98%**. Of GLM's 84
unambiguous cases it got **83/84**; of the 14 ambiguous "next \<weekday\>" cases, **13/14**.
Baseline errors clustered exactly where the live bug was — "this Friday", "two weeks from…",
year-boundary cases — and the tool drove them to ~perfect.

### A correction worth recording
The *first* GLM run showed condition C at **63% — worse than baseline** — which turned out to be
a bug in the **harness**, not the tool. GLM emits zero-valued integer args as quoted strings
(`"weeksAhead": "0"`) while emitting nonzero as numbers (`1`, `2`). The live `resolve_date`
server coerces stringified integers (the `intArg` guard in `src/mcp/server.ts`); the harness's
inline resolver didn't, so it wrongly rejected every "this \<weekday\>"/"today" case. Mirroring
the coercion fixed the harness → 98%. **Lesson: an eval that reimplements server logic must
match it exactly, or it measures the harness, not the model.** (This is also a real
robustness point: the server's stringified-int coercion is load-bearing for GLM specifically.)

## Interpretation

1. **The tool makes accuracy independent of the model's arithmetic.** GLM is *weaker* than Haiku
   at raw date math (baseline 69% < 76%) yet ends up *higher* with the tool (98% > 90%) — because
   the tool does the counting and GLM only has to name the parts, which it does cleanly.
2. **"Next \<weekday\>" is genuine ambiguity — the two models prove it by disagreeing.** GLM
   consistently reads "next Friday" as the following week (weeksAhead 1, matching our convention
   → 13/14); Haiku often reads it as the coming Friday (→ its main failures). No convention is
   "right" when speakers *and* models split. Hence the guidance already added: for "next
   \<weekday\>", resolve both candidates and confirm — never assume.
3. **Grounding alone (B) is ~+10 pts; the tool gives the rest.** Handing the model the weekday
   helps, but it still does the final arithmetic unreliably. The deterministic tool closes the gap.

## Re-run 2026-07-25 (fresh DeepInfra key; owner asked whether date injection alone suffices)

Same harness, same corpus, live `zai-org/GLM-5.2`: **A 66.3% · B 80.6% · C 99.0%** (tool called
98/98) — replicates July 17 within noise. The per-template table splits the story cleanly:

- **Offset + passthrough templates (today/tomorrow/in-3-days/a-week-out/explicit): 42/42 in
  condition A.** With the date injected, GLM's *basic* date math is perfect — the owner's
  intuition holds for this tier.
- **Weekday-walking templates ("this friday", "next monday", "two weeks from this monday"):
  23/56 (41%) in A, 31/56 in B, 55/56 in C.** This tier is the entire gap, and it is the tier
  scheduling conversations live in.
- The raw failures show BOTH failure kinds: true arithmetic errors ("two weeks from this
  monday" → +7 not +14) and the "next <weekday>" convention split ("next monday" → the coming
  Monday repeatedly — same split the owner hit live on 2026-07-25). Condition C pins the
  convention via the tool's parameter description, which is why C holds 6–7/7 there.
- Many A-failures are "got none" — the model produced no date at all despite "reply with only
  the date". On a booking path that's a stall, not a wrong booking — less dangerous than
  silent-wrong, but not an answer either.

**Conclusion (2026-07-25): date injection and the tool are complements, not rivals.** Injection
alone = perfect basics, coin-flip weekday phrases. Decision: keep `resolve_date` on the money
path; add grounding riders ({today, weekday, timezone} on spine tool results) for tool-free
moments; the "next <weekday>" ambiguity needs the ask-mechanism (`saidNext`) regardless.

## Live end-to-end run 2026-07-25 (deployed stack, post-PR #82 + #83)

Owner asked for the same testing against the LIVE agent. Method: the 14 phrase templates
(+ "next thursday", the same-day live bite) anchored to real today (Sat 2026-07-25 — the
reference date can't be varied live), one FRESH embedded-agent session per case on s2
(`probe-dateval-live-1..15`; embedded path exercises deployed Render + real tool choice;
AGENTS.md-truncation caveat noted).

**Score: 15/15.** All five offsets, all four "this/coming" weekday walks (correctly
weekend-aware: "this friday" on a Saturday → Jul 31), both "two weeks from" (one showed its
working), explicit passthrough with weekday label — and ALL THREE ambiguous "next <weekday>"
cases (friday, monday, thursday) got the designed **both-candidates-and-ask** response,
including "next thursday", which had silently resolved to Aug 6 hours earlier. 3/3 asks is
favorable but not causal proof the grounding rider fixed the ask-behavior (GLM variance is
documented; `saidNext` remains the mechanism-level guarantee, still open). Bonus case-5
behavior: volunteered "that's a Saturday — if your team doesn't work weekends…".

Rider verification in the same run: tool results in the probe trajectories carry the exact
condition-B `now` line (grep evidence, 1–2 hits per session) → PR #83 verifiably live.
**Parrot watch: CLEAN** — zero of 15 replies quoted "Right now it is…".

## Remaining

- GLM's residual ~2% is a couple of stray arg choices plus the inherent "next" ambiguity, which
  the confirmation preview (manager sees the resolved date + weekday) catches. Good enough for the
  money-at-risk path *with* that confirmation.
- DeepInfra returned 402 (no balance) on the first attempt — re-runs need a funded account or the
  NVIDIA key (`EVAL_INFERENCE_BASE_URL=https://integrate.api.nvidia.com/v1 EVAL_MODEL=z-ai/glm-5.2`).

---

## Re-run 2026-08-04 — reasoning effort, and a correction to the numbers above

**Why:** the harness never set a reasoning parameter, and it capped `max_tokens` at 300. Probing
the live endpoint (`zai-org/GLM-5.2` on DeepInfra, 2026-08-04) showed **reasoning is ON BY DEFAULT** —
a bare request to a trivial date question returns a 777-char thinking trace and ~255 output tokens.
`reasoning_effort` *is* supported (`none|low|medium|high`), despite DeepInfra's reasoning page
listing only DeepSeek-R1. So every run above was made **with thinking on and a 300-token ceiling**,
i.e. the trace was competing with the answer for the budget.

Harness now takes `EVAL_REASONING_EFFORT` and `EVAL_MAX_TOKENS`, and records `finish_reason`,
output tokens, and reasoning-trace size per case. Defaults unchanged, so old invocations reproduce.

| Run | reasoning_effort | max_tokens | A | B | C | total out tokens |
|---|---|---|---|---|---|---|
| `thinking-off` | `none` | 2000 | **82.7%** | **84.7%** | **100.0%** | 2,975 |
| `thinking-high` | `high` | 2000 | 81.6% | 80.6% | 100.0% | 23,470 |
| `original-repro` | *(unset → on)* | 300 | 57.1% | 76.5% | 98.0% | 38,372 |

**1. Thinking effort does not improve date accuracy — at ~8× the output tokens.** `high` scores
81.6/80.6/100 against `none`'s 82.7/84.7/100. With n=98 the standard error is ~3.9pp, so every
difference here is inside the noise; the honest reading is *no measurable effect*. It is pure cost
on this task. (Date-specific — this says nothing about thinking on other work.)

**2. The condition-A numbers above were a token-budget artifact, not date arithmetic.** In the
reproduced original config, **39 of the 42 condition-A failures (93%) hit `finish_reason: "length"`** —
the answer was cut off by the thinking trace. Condition A truncated 39/98 with median output 216
tokens against a 300 cap. Give the model room and A goes 57.1% → 82.7%. **This retires the
"GLM is weaker than Haiku at date math" reading of the A/B rows** — that comparison was measuring
who fits inside 300 tokens, not who counts days correctly. (Haiku's numbers were produced by the
Anthropic adapter, which had its own 300 cap but no default thinking, so it was not truncated the
same way — the two columns were never like-for-like.)

**3. What survives unchanged, and is the load-bearing result:** condition C — grounding plus the
`resolve_date` tool — scores **100.0% (98/98) in both fair-budget runs**, with the tool called on
98/98 cases. It is the only condition that is insensitive to thinking, to budget, and to the
model's own arithmetic. Every mechanical template (`today`, `tomorrow`, `in 3 days`, `a week from
today`, `explicit`) is 7/7 even in condition A; the residual A/B failures are concentrated in the
genuinely ambiguous phrasings (`next monday` 2/7, `two weeks from this monday` 4/7, and `this
friday` when today *is* Friday) — the same ambiguity §0f already handles by resolving both
candidates and asking.

**4. Run-to-run variance is larger than it looks.** `original-repro` scored A 57.1% where the
2026-07-25 run of the same configuration scored 66.3% — a 9-point spread at temperature 0. Treat
single-run deltas under ~10 points on this corpus as noise unless truncation counts are also shown.

**Production relevance:** since 2026-07-30 the fleet runs `reasoning: true` +
`thinkingDefault: adaptive` (before that, `reasoning: false` silently forced `thinkingLevel: off`,
so the July numbers happened to match production). On date work that setting buys nothing
measurable and costs ~8× output tokens — but the fleet does more than dates, so this is an argument
for measuring thinking per task type, not for switching it off wholesale.
