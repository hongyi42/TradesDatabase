# Agentic planner eval — baseline, 2026-08-24

The first at-scale run of the planner **as an agent**: 65 scenarios (62 graded + 3 harness
smokes), each a seeded world run through the REAL tick (sweep → planner → its two read tools,
spine_read + recall_decisions, through the real MCP dispatch) at simulated instants, graded deterministically with a blind judge on top.
Corpus, harness, and graders: plan `thoughts/shared/plans/2026-08-24-agentic-planner-eval.md`;
runs `spine-eval-runs/agentic-{opus,glm}-2026-08-24T10-*`.

**Not a benchmark.** These numbers move when the corpus, the prompt, the rails, or the judge
change. They are the BEFORE picture for the one-call collapse and for lesson-effect
measurement — compare against them only with the same corpus at the same commit.

## Headline

| | Opus 5 (production) | GLM-5.2/Fireworks (rollback) |
|---|---|---|
| deterministic checks | **60/65** | 58/65 |
| with the blind judge | **54/65 (83%)** | 42-44/65 (~66%) |
| reads per decision | 3.97 (59/65 scenarios read) | 3.76 (56/65) |
| run cost | $5.97 (+$0.03 judge) | $1.51 (+$0.06 judge) |

Judge variance note: the judge (Haiku, blind) is mildly non-deterministic — GLM's judged
tally moved 42-44 across re-gradings (borderline unsupported-claim verdicts), Opus held 54-55.
Deterministic numbers are exactly reproducible from results.jsonl. Post-review grading also
counts judge-unactionable notes and judge misses (no verdict / missing block) as failures.

## Where the models separate

The deterministic gap is small (60 vs 58); **the judge is where they separate** (−6 vs −14).
GLM's escalation notes over-claim and imply blame far more often — "hasn't reported back",
"no visit has been logged" (the block was merely silent) — which is precisely the
money-blindness/false-claim specimen class this eval was built from. Family splits (judged):

- **false-claims: Opus 10/10, GLM 7/10.** The specimen family. Opus never asserted an empty
  record over money or notes.
- **lessons: Opus 4/4, GLM 1/4.** Opus follows an apt lesson, cites its id, ignores the
  irrelevant control, and overrides a patience lesson when a CO-alarm complaint demands it.
  GLM largely ignores the LESSONS block — ⑤'s live value depends on the model reading it.
- **premature: both 8/8.** Neither model pings managers early. The dismissal-fodder failure
  mode (mv_escalation_fates) is not where these models fail.
- **late-stuck: Opus 7/8 + two escalate-shaped misses elsewhere.** Opus's characteristic
  failure is the INVERSE of premature: it extends where the corpus expects escalation
  (PJ-03 27h silence → extend; WD-05 at the 48h ceiling → extend; LS-05 second extend on a
  stale gap). It is *patient past the point the metric calls stuck* — the exact opposite of
  the pilot's 2026-08-20 premature-escalation specimen, worth watching in production.
- **CM-03 (both models): neither checked the dismissal pattern.** Six spine_reads, none
  touching v_review_items, before re-escalating a technician whose last three escalations the
  manager dismissed. The ⑤ self-check line in the prompt is not yet strong enough to induce
  the read — a concrete prompt/lesson lever.
- **MG-07 (both): one close applied on a vague shared note** ("All wrapped up over there") —
  the cross-credit temptation the rails cannot fully close, caught by the arc cap.

## What the harness proved mechanically

- Full-fidelity ticks: 341 (Opus) / 297 (GLM) real tool calls through the production MCP
  dispatch gate against seeded worlds; investigation is now MEASURED (production still
  discards these transcripts — the eval is currently the only place they exist).
- Time travel holds: multi-tick arcs (deliver, mid-arc captures/money, manager_resolve, the
  ⑤ gap-summary epilogue) ran with zero harness errors across 130 scenario executions.
- The honest four-tier Anthropic ledger works at scale: cache-write-1h 7.7k / cached 1.94M /
  fresh 387k / output 120k tokens, priced off cost_rates ($0.08/$0.97/$1.93/$2.99).
  Cache economics of the loop are visible: ~83% of Opus input tokens were cached reads.

## Standing follow-ups

0. **Production observation surfaced by the review:** the planner is handed TWO tool schemas
   (`TEAM_LEAD_TOOL_SCHEMAS` = spine_read + recall_decisions). The identity allowlist names
   `get_customer_context` and `resolve_date` too, but no schema reaches the loop, so they are
   unreachable — in production as in the eval. Decide whether to hand them or prune the list.

1. The corpus is the regression suite: new production failures get encoded as scenarios
   (the date-eval's 94-reply precedent).
2. The Opus over-patience cluster (PJ-03/WD-05/LS-05) is a judgment-tuning question — a
   candidate first LESSON once the Reflector proposes from real summaries, and a thing the
   pilot's mv_escalation_fates should be watched for.
3. CM-03's missing self-check read: strengthen the prompt line or ship it as a lesson; re-run
   the family to measure.
4. This baseline is the yardstick for the investigate/plan/compose one-call collapse: run the
   same corpus on the collapsed call and diff per family.
5. Known grading limits (recorded, deliberate for v1): mustNotClaim passes vacuously on total
   silence (silence is a pacing failure, not a false claim — a `mustDecide` field is the
   future fix); the sim pairs sweep+planner only at scripted ticks (production sweeps every
   5 min — deadlines expiring between ticks resolve later than production would); the judge
   covers escalation notes only, and blame/dismissal-invite phrasing outside those notes is
   graded by substring lists narrower than planner-eval's vocabulary.
