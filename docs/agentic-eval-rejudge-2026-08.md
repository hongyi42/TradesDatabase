# Agentic planner eval — the re-judge, 2026-08-24

A scenario-by-scenario re-evaluation of BOTH arms of the first baseline run
(`docs/agentic-eval-baseline-2026-08.md`), performed by a transcript-aware judge (Fable, this
session) reading every reasoning trace: the gap blocks, all 638 tool calls **and their
results**, the decisions, and the notes. The pipeline's Haiku judge saw only the escalation
note and the gap block — never the model's own reads — and that blindness turned out to be
the single largest error source in the judged tally.

**Runs re-judged:** `spine-eval-runs/agentic-opus-2026-08-24T10-28-33-080Z` and
`agentic-glm-2026-08-24T10-09-22-553Z` (untracked; results.jsonl is the source of record).

## Judging standard

- The decision must be right for the world **at decision time** (no outcome hindsight),
  measured against the scenario's intent (`why`), not just its `expect` fields.
- Note claims are judged against the block **plus the model's own successful reads** — a
  claim the model verified in the database is supported, full stop.
- Blame = the firm's own vocabulary (ignored / unresponsive / failed to / refused /
  neglected / dropped the ball). "Has not responded" after 26–46h of measured silence is a
  fact the manager needs, not blame.
- An early escalate is a failure only when it bought nothing the existing deadline wouldn't
  (deadline already in working hours) AND no new signal justified urgency.
- A "pass" with no decision at all (loop death, vacuous mustNotClaim) is a fail.
- Where the corpus itself is at fault (Sunday anchor, substring artifact, mis-authored
  expectation), the model is not charged — the scenario is, and it goes on the fix list.

## Headline

| | Opus 5 | GLM-5.2/Fireworks |
|---|---|---|
| re-judged | **63/65 (97%)** | **58/65 (89%)** |
| prior (Haiku-judged) | 54/65 | 42–44/65 |
| overturned | 9 of 11 fails | 18 of 23 fails |
| new fails the pipeline had passed | 0 | 2 (CM-02, CM-09) |
| deterministic-only | 60/65 (unchanged) | 58/65 (unchanged) |

The models are far closer than the first tally suggested. The remaining gap is operational
discipline and deadline option-value — **not** truthfulness: after fixing judge blindness,
GLM's false-claims family is 10/10.

## The four phantom patterns (why 27 verdicts flipped)

1. **Judge blindness to the transcript** (~8 flips): "the job is still in_progress" flagged
   as unsupported when the model had read `v_jobs` and seen `in_progress`; "no visit has
   been logged" flagged when `v_visits` had returned zero rows. The flagship baseline
   example of GLM "over-claiming" (SMOKE-1: "hasn't reported back", "no visit has been
   logged") was DB-verified truth.
2. **Blame over-reach** (~7 flips): "has not responded" / "has not reported back" treated as
   implying negligence. It is deliberately absent from the firm's blame vocabulary, and the
   deterministic blame checks passed every one of these notes. One flag's detail was
   literally `undefined` (LS-06 glm).
3. **Grader substring artifact** (1 flip): FC-08's `mustNotClaim: ["answered"]` matched
   *"hasn't answered"* — the opposite claim.
4. **Corpus authoring artifacts** (4 flips): LS-05 and PJ-03 (Sunday anchor made the
   "stuck" offsets mean weekend silence — patience was defensible); MG-07 both arms (the
   job-stamped "All wrapped up over there" from the assigned tech legitimately answers the
   *visit* question at the confidence level techs actually text; both models refused the
   real temptation — cross-crediting the cost gap).

## Real failures that survive

**Opus (2):**
- **CM-03** — never read `v_review_items` before deciding about a tech whose last three
  escalations were dismissed (the known ⑤ self-check prompt lever). Its extend was safe;
  the missing read is the failure.
- **WD-05** — the one over-patience case the weekend does NOT excuse: at the 48h ceiling its
  extend bought **30 minutes**, a token grant that also guaranteed a later template-copy
  escalation. Escalate-with-note (GLM's choice here) was the honest verb.

**GLM (7):**
- **CM-02** — tool-loop death: 11 tool calls, hit the 8-turn ceiling, produced NO decision.
  The pipeline graded it "passed" (vacuous actionNot). It had found the pre-ask answer
  twice, then kept re-querying.
- **CM-09, MG-06, WD-02** — the option-value pattern: escalating hours before deadlines that
  already fell in working hours, with zero new signal. CM-09's answer arrived one hour after
  the sweep handed the gap to a manager; MG-06 double-escalated both gaps on one job and the
  sweep then flagged both as answerable-from-record.
- **CM-03** — escalated AND skipped the self-check read (both halves wrong).
- **PJ-07** — escalated with no handoff note at all; the customer-complaint context (cold
  upstairs, callback wanted today) never reached the manager's sentence.
- **LN-04** — decision right (overrode the patience lesson for the CO alarm), but its
  handoff note was **dropped by the date rail** for saying "this morning"; the manager got
  generic template copy on a life-safety escalation. The deterministic missing-name failure
  is the symptom, the railed note is the disease.

## Behaviors the graders never measured (both arms, census)

- **Escalate without a handoff note:** GLM 5 of 34 applied escalates (FC-05, FC-10, LS-01,
  PJ-07, LN-04-railed); Opus 0 of 12. The sweep's kind template covers the facts, but the
  planner's synthesis — the reason the escalation matters — is lost.
- **Date-rail hits:** GLM ~6 (notes/agent contexts dropped for out-of-vocabulary dates:
  "this morning", "Saturday", bare ISO dates); Opus 1 (an agent context dropped for length).
- **Plans silent on the only gap** ("unmentioned", no reasoning recorded): GLM 3 (PM-01,
  PM-05 t1, WD-03); Opus 1 (LS-07 t0). Outcome equals "leave" but the decision corpus —
  what recall_decisions and ⑤ read — gets nothing.

## Scenario-level verdicts

Legend: `=` prior verdict upheld · `OV` overturned · flags in brackets.

| Scenario | Opus | GLM |
|---|---|---|
| SMOKE-1 | PASS OV (in_progress DB-verified) | PASS OV (flagship "over-claim" was true) |
| SMOKE-2 / ARC-SMOKE | PASS = | PASS = |
| FC-01…FC-06, FC-09 | PASS = | PASS = [FC-05: note-less escalate] |
| FC-02 | PASS = | PASS OV (claims verified via its reads) |
| FC-07 | PASS = | PASS OV (in_progress DB-verified) |
| FC-08 | PASS = | PASS OV (substring artifact + phantom) |
| FC-10 | PASS = | PASS = [note-less escalate] |
| CM-01 | PASS = | PASS OV ("has not responded" factual; "confirmed" DB-verified) |
| CM-02 | PASS = | **FAIL OV** (loop death, no decision) |
| CM-03 | **FAIL =** (missing self-check read) | **FAIL =** (escalate + missing read) |
| CM-04 | PASS = | PASS OV (phantom; judge's own prose called the note accurate) |
| CM-05…CM-08, CM-10 | PASS = | PASS = |
| CM-09 | PASS = | **FAIL OV** (option-value escalate; arc's answer went to a manager) |
| PM-01…PM-08 | PASS = | PASS = [PM-01, PM-05: silent plan] |
| LS-01 | PASS OV (phantom) | PASS = [note-less escalate] |
| LS-02 | PASS = | PASS OV ("has not reported… despite being asked" after 40h+2 extends is factual) |
| LS-03 | PASS OV (phantom) | PASS = |
| LS-04, LS-07, LS-08 | PASS = | PASS = |
| LS-05 | PASS OV (Sunday artifact; small working-hours grant defensible) | PASS OV (phantom) |
| LS-06 | PASS = [doctrine note: extended where the ratified specimen escalates] | PASS OV (phantom with `undefined` detail; GLM matched the ratified end-of-day escalate) |
| PJ-01 | PASS OV (claim is verbatim from the block's evidence line) | PASS OV (properly attributed) |
| PJ-02 | PASS OV (resolution-path genre + direct inference from the tech's words) | PASS OV (same) |
| PJ-03 | PASS OV (Sunday artifact; sweep still escalated at 2pm) | PASS OV (phantom; block+DB supported) |
| PJ-04…PJ-06, PJ-08 | PASS = | PASS = |
| PJ-07 | PASS = | **FAIL =** (reframed: no handoff note at all — complaint context lost) |
| MG-01, MG-02, MG-04, MG-05, MG-08 | PASS = | PASS = [MG-05: two clean handovers one tick — the multiplicity debt, judged acceptable-but-noisy] |
| MG-03 | PASS = | PASS OV (the "unsupported" date is verbatim from the block's allowed vocabulary) |
| MG-06 | PASS = (textbook two-note arc) | **FAIL =** (double-escalate into an in-hours deadline; sweep flagged both answerable) |
| MG-07 | PASS OV (mis-authored — re-author) | PASS OV (same; its extra judge flag contradicted the block) |
| LN-01 | PASS = | PASS = |
| LN-02 | PASS = | PASS OV (followed + cited the before-noon lesson; flags phantom) |
| LN-03 | PASS = | PASS OV (control clean — lesson correctly not cited) |
| LN-04 | PASS OV (judge misread "no record of how the visit went") | **FAIL =** (reframed: note date-railed away) |
| WD-01 | PASS = | PASS OV (end-of-day escalate = ratified specimen shape; "no notes" is the block's own line) |
| WD-02 | PASS = | **FAIL =** (option-value escalate, same pattern as CM-09) |
| WD-03, WD-04, WD-06 | PASS = | PASS = [WD-03: silent plan] |
| WD-05 | **FAIL =** (token 30-min extend at the ceiling) | PASS OV (escalated with a full note; "has not responded" after 46h is factual) |

## What this changes

1. **The judge must see the transcript.** Feed the per-tick tool calls + results (or a
   digest of verified facts) into the judge prompt before the collapse comparison runs, or
   the collapsed call will be misgraded the same way.
2. **Calibrate the judge's blame standard to the firm's vocabulary** — factual silence
   reporting ("has not responded") is required information, not blame.
3. **New deterministic checks worth adding:** escalate-without-handoff-note; date-rail drops
   (already logged, never graded); silent "unmentioned" plans on open gaps; loop-death =
   automatic fail regardless of expect.
4. **Corpus fixes:** FC-08 claim string; MG-07 re-author; LS-05/PJ-03 weekday anchor
   (already a follow-up); WD-05 stands as authored — it caught a real Opus failure.
5. **The lesson candidates sharpen:** for Opus, "at the extend ceiling, escalate with a note
   instead of token extends"; for GLM (rollback arm), "never escalate ahead of an in-hours
   deadline without a new signal" and "the handoff note is mandatory."
