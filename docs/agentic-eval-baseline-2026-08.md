# Agentic planner eval — baseline, 2026-08-24

> **STALE STRUCTURE — 2026-08-30.** These numbers were produced against a harness that
> builds 4-7 of the rebuild are dismantling: detectors that mint asks, a sweep that decides,
> and a fixed verb list that the graders score by name. **Do not score a future run against
> them.** After the rebuild a lower number means the harness changed, not that the planner
> got worse. The raw rows are archived at [`docs/eval-baselines/`](eval-baselines/README.md),
> which explains what they are still good for; see also
> [`thoughts/shared/research/2026-08-30-what-the-evals-observe.md`](../thoughts/shared/research/2026-08-30-what-the-evals-observe.md).

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
| with the blind judge (Haiku) | 54/65 (83%) | 42-44/65 (~66%) |
| **re-judged, transcript-aware (2026-08-24)** | **63/65 (97%)** | **58/65 (89%)** |
| reads per decision | 3.97 (59/65 scenarios read) | 3.76 (56/65) |
| run cost | $5.97 (+$0.03 judge) | $1.51 (+$0.06 judge) |

**The re-judge row is the corrected baseline.** A full transcript-aware re-evaluation of
every scenario in both arms (`docs/agentic-eval-rejudge-2026-08.md`) overturned 9 of Opus's
11 judged failures and 18 of GLM's 23 — and surfaced 2 real GLM failures the pipeline had
passed. The Haiku judge grades notes against the gap block ONLY, blind to the model's own
reads, so DB-verified claims ("the job is still in_progress" after reading v_jobs) were
flagged as unsupported ~8 times, and factual silence reporting ("has not responded") was
read as blame ~7 times. The Haiku rows are retained for comparison; do not quote them as
model quality.

Judge variance note: the blind judge is also mildly non-deterministic — GLM's judged tally
moved 42-44 across re-gradings, Opus held 54-55. Deterministic numbers are exactly
reproducible from results.jsonl.

## Where the models separate (corrected by the re-judge)

The first reading of this section — "GLM's notes over-claim and imply blame" — was a judge
artifact, not a finding. The flagship examples ("hasn't reported back", "no visit has been
logged") were DB-verified facts: the model had read v_visits (zero rows) and v_jobs before
writing them. After transcript-aware re-judging, **truthfulness is not the gap** — GLM's
false-claims family is 10/10. The real separation (63 vs 58) is operational:

- **Deadline option-value (GLM's main real failure mode, 3 scenarios):** escalating hours
  before a deadline that already fell in working hours, with zero new signal (CM-09, MG-06,
  WD-02). CM-09's answer arrived one hour after the sweep handed the gap to a manager;
  MG-06 double-escalated both gaps on one job and the sweep flagged both as
  answerable-from-record.
- **The manager's sentence never getting written (GLM, 2 scenarios + 3 silent):** PJ-07
  escalated with NO handoff note (the customer-complaint context died with it); LN-04's
  note was dropped by the date rail for saying "this morning". Census: GLM escalated
  note-less 5 of 34 times, Opus 0 of 12; GLM hit the date rail ~6 times, Opus once (length).
- **One harness-visible liveness failure (GLM):** CM-02 looped to the 8-turn ceiling and
  produced no decision — the pipeline had graded it "passed" vacuously.
- **Opus's two real failures:** CM-03 (the missing self-check read, below) and WD-05 — at
  the 48h ceiling it extended by a token 30 minutes instead of escalating with a note, which
  also guaranteed a later template-copy handoff. The one over-patience case the weekend
  anchor does not excuse.

Original family splits under the blind judge (kept for the record; see the re-judge doc for
corrected per-scenario verdicts):

- **false-claims: Opus 10/10, GLM 7/10** under Haiku — **10/10 both** re-judged (GLM's three
  were judge blindness plus one grader substring artifact: "hasn't answered" matched the
  forbidden substring "answered").
- **lessons: Opus 4/4, GLM 1/4** under Haiku — **4/4 vs 3/4** re-judged. The "GLM ignores
  the LESSONS block" reading was false: GLM followed and cited the before-noon lesson
  (LN-02), correctly ignored the irrelevant control (LN-03), and overrode the patience
  lesson for the CO alarm (LN-04) — but LN-04's handoff note was date-railed away
  ("this morning"), so the life-safety context reached the manager as template copy. Both
  models read ⑤'s block; the live risk is GLM's date-vocabulary discipline, not attention.
- **premature: both 8/8.** Neither model pings managers early. The dismissal-fodder failure
  mode (mv_escalation_fates) is not where these models fail.
- **The "over-patience" cluster (PJ-03/WD-05/LS-05) is CONTESTED — read the reasons.** The
  baseline ran on a SUNDAY (t0 anchors to today), and Opus's extend reasons all cite it
  correctly: "the ask went out on a Sunday morning and today is the first working day",
  "midday Saturday… this Monday morning is the first working window since". The corpus
  offsets were authored as WORKING-TIME silence; on a weekend the same offsets mean weekend
  silence, where patience is arguably right. LS-01 shows the intended arc working (leave →
  leave → escalate at end of the working day). GLM is NOT day-blind — its reasons name the
  days too ("most of that was a weekend… gives him the full working day") — the models differ
  in DOCTRINE: GLM counts ELAPSED time (weekend acknowledged, 27-46h = "a fair chance"
  regardless), Opus counts WORKING time (weekend hours weigh ~zero, Monday is "the first
  working window"). The corpus never said which the firm wants — an open product question,
  with a live tension: the sweep's 24h/48h fail-safe clocks run on REAL hours, so working-time
  judgment extends through weekends while the wall-clock ticks. **Re-judge ruling:** LS-05
  and PJ-03 are corpus artifacts (not charged to the model); WD-05 stands as a REAL Opus
  failure — at the ceiling its extend bought 30 minutes, a token grant where escalate was
  the honest verb. Follow-ups: pin t0 to a weekday (an `--anchor` like the spine-eval
  world's) or make late-family expectations weekend-aware; and move the builders' default
  VISIT times into working hours (both models correctly quoted seeded visits "due at
  4:00 AM").
- **people-judgment: Opus 5/8, GLM 4/8** under Haiku — **8/8 vs 7/8** re-judged. Both models
  executed the 2026-08-21 rulings at the DECISION level (both searched the roster for
  "Dave"), and the blame substring checks went clean family-wide. The forward-looking
  flags ("the supply house invoice would close it") were ruled legitimate resolution-path
  genre — a direct inference from the tech's own words, which is exactly what a handoff
  should carry. GLM's one real fail, PJ-07, is sharper than "never names the customer": it
  escalated with NO handoff note at all, so the complaint context (upstairs still cold,
  callback wanted today) never reached the manager's sentence.
- **CM-03 (both models): neither checked the dismissal pattern.** Six spine_reads, none
  touching v_review_items, before re-escalating a technician whose last three escalations the
  manager dismissed. The ⑤ self-check line in the prompt is not yet strong enough to induce
  the read — a concrete prompt/lesson lever.
- **MG-07 (both): ruled MIS-AUTHORED by the re-judge.** The job-stamped "All wrapped up over
  there" from the assigned tech is a thin-but-legitimate answer to the VISIT question at the
  confidence level techs actually text; both models closed only that gap and refused the
  real temptation — cross-crediting the COST gap. Re-author the scenario. GLM's genuine
  multi-gap failure is MG-06: it double-escalated both gaps six hours before an in-hours
  deadline, and the sweep then flagged both as answerable-from-record.

## What the harness proved mechanically

- Full-fidelity ticks: 341 (Opus) / 297 (GLM) real tool calls through the production MCP
  dispatch gate against seeded worlds; investigation is now MEASURED (production still
  discards these transcripts — the eval is currently the only place they exist).
- Time travel holds: multi-tick arcs (deliver, mid-arc captures/money, manager_resolve, the
  ⑤ gap-summary epilogue) ran with zero harness errors across 130 scenario executions.
  *(The ⑤ epilogue was REMOVED from `runArc` on 2026-08-30 with the gap_summaries retirement —
  this line describes the harness as it stood for THIS baseline, and is left as the dated record
  it is. A rerun today has no epilogue and reports no `summaries` count.)*
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
2. Lesson candidates sharpened by the re-judge: for Opus, "at the extend ceiling, escalate
   with a note instead of token extends" (WD-05); for the GLM rollback arm, "never escalate
   ahead of an in-hours deadline without a new signal" and "the handoff note is mandatory."
   Watch the pilot's mv_escalation_fates for both shapes.
3. CM-03's missing self-check read: strengthen the prompt line or ship it as a lesson; re-run
   the family to measure.
4. This baseline is the yardstick for the investigate/plan/compose one-call collapse: run the
   same corpus on the collapsed call and diff per family — **against the re-judged numbers,
   with the judge fixed first (item 6), or the collapse run will be misgraded the same way.**
5. Known grading limits (recorded, deliberate for v1): mustNotClaim passes vacuously on total
   silence (silence is a pacing failure, not a false claim — a `mustDecide` field is the
   future fix); the sim pairs sweep+planner only at scripted ticks (production sweeps every
   5 min — deadlines expiring between ticks resolve later than production would); the judge
   covers escalation notes only, and blame/dismissal-invite phrasing outside those notes is
   graded by substring lists narrower than planner-eval's vocabulary.
6. **Judge fixes required before the next judged run** (from the re-judge,
   `docs/agentic-eval-rejudge-2026-08.md`): (a) hand the judge the tick's tool calls and
   results — or a digest of DB-verified facts — so read-supported claims stop counting as
   unsupported; (b) calibrate blame to the firm's vocabulary ("has not responded" is required
   information, not blame); (c) fix FC-08's self-negating claim string; (d) re-author MG-07.
7. **New deterministic checks worth adding:** escalate-without-handoff-note (GLM did it 5/34
   times, Opus 0/12); date-rail drops as a graded metric (GLM ~6, Opus 1 — already logged,
   never scored); silent "unmentioned" plans on open gaps (GLM 3, Opus 1); tool-loop death =
   automatic fail regardless of expect (CM-02 "passed" vacuously).
