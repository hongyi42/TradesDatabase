---
date: 2026-09-17
task: The extractor names which of a customer's jobs a message concerns, or none — and the door files on that answer without letting it flip status or silence a promise
research: thoughts/shared/research/2026-09-11-re-inventing-the-write-path-door.md
status: draft
supersedes: nothing
---

## Overview

Builds on `thoughts/shared/plans/2026-09-11-the-door-stops-guessing.md` (PR #235, merged 2026-09-12),
which created the branch this fills: `!mayGuess && candidates.length > 1` — a known customer, several
open jobs, nothing naming one. There the door gives up. A count is a weak test: the Delphine promise
concerned a bathroom faucet and the candidates were a boiler and a kitchen tap — "none of these",
which no count can say.

**REBASED 2026-09-17** onto main, which moved 39 commits in three days. What changed for this plan:
the retrieval layer (#242, #247, #248, #251) folded the link views away, two of its own parked
findings landed, and `src/mcp/server.ts` was split (#239). Every citation below was re-found in the
code, not adjusted by arithmetic. The design survives: `extract.ts`, `identityMatch.ts` and
`attachNote.ts` are untouched, and `recordFieldNote.ts` changed by one word of comment.

**REWRITTEN 2026-09-14** (user: "We are going to fold it"); the separate-chooser design, last at
commit `6e45a08`, is rejected below. Phase 4 was briefly a second plan and was folded back on the
user's instruction — the split was only ever the line limit, and the two halves are one guarantee:
without Phase 4 the rulings hold for the message the model read and fail on the customer's reply.

## Decisions

- **Folded into the extractor — no second model call** (user). REJECTED: a chooser call after
  identity. It re-read the message without the extractor's reading while the extractor never saw the
  candidates, so the decisions never met; and it added a model call inside the webhook's timeout.
  The user's 2026-08-22 direction to collapse model-call stages names that defect: coherence, not cost.
- **Identity from ENVELOPE keys first.** Extraction (`recordFieldNote.ts:298`) precedes identity
  (`:321`) because identity reads its phone and address; but email, thread and caller id are envelope
  facts. A pre-match reuses `matchIdentity` with `extracted: { phone: input.fallbackPhone }` — still
  one deterministic identity implementation. The real match runs after, unchanged.
- **Address-only identity gets no candidates** — it needs the extractor first. PR #235's behaviour.
- **Candidates go in the USER message; `EXTRACTION_SYSTEM` stays byte-identical.** The
  `renderExtractionUser` idiom, whose "BARE" pin keeps ordinary messages unchanged.
- **A NUMBER, pinned to the list SHOWN** (review fix). The model answers `1..N`. The door keeps the
  exact array it showed (`shownCandidates`), maps the number to a job **id**, and accepts it only if
  that id is still in its own fresh `candidates`. A second `listJobsForCustomer` seconds later can
  still differ in MEMBERSHIP — a job can close or open while the model is answering, and one dropping
  out shifts every number after it. (The ORDER half of this hazard is gone: `jobs.ts:151` now breaks
  ties on `id`, which landed on main as `bf9d5ea` from this plan's own parked finding.) Indexing the
  fresh list could still file on the wrong job under a `basis='model'` that looks grounded. No
  list shown → any `jobChoice` is ignored. Models copy UUIDs wrong (`UUID_RE` at `src/mcp/tools/shared.ts:723`,
  `webhook.ts:39`, `nudgeDecisions.ts:78`), so no id is ever asked for.
- **Bounded, and truncation falls back** (review fix). The extractor runs at `maxTokens: 1024` on
  default `medium` reasoning (`forcedTool.ts:39`), already listed as unmeasured truncation risk in
  `docs/engineering-memory.md:3174-3177`. Candidates show only when there are 2–8; titles are cut at
  80 characters; `jobChoiceReason` is one short sentence. A truncated extraction WITH candidates is
  re-run once WITHOUT them — otherwise it throws after L1, the webhook answers `transient_error`, and
  every redelivery truncates the same way: a regression PR #235 does not have. Caught by a typed
  predicate so an outage is never retried into a second bill.
- **Title and status only** — no visit dates, this repo's most repeated extraction hazard.
- **Earlier messages still supply identity only.** "Thursday works", whose job is named three
  messages up, gets no pick — the safe direction, accepted, and a fixture pins it.
- **A pick FILES and decides nothing else** (user). No status flip — "that is the planner's job". A
  commitment on a picked job still asks when a live visit attached (inferred from that; confirmed by
  `/implement`).
- **The basis is recorded on the link written** (user: "record why the model picked the job"):
  `job_captures` with no live trip, `visit_notes` with one — both gain `basis` / `basis_reason` at
  insert. CHECK `basis in ('model','inherited')`; `inherited` is Phase 4's value, defined here so it
  needs no second hand-applied migration.
- **It surfaces through `capture_membership`, not the old link views** (rebase 2026-09-17). The
  retrieval layer's fold DROPPED `v_job_captures`, `v_visit_notes` and `v_customer_captures` — the
  last of which this arc added — and replaced all three with one `v_capture_links`
  (`20260917130000_the_sql_views_fold.sql:19-21`, `:45`) over the `capture_membership` view
  (`20260916120000_retrieval_layer_core.sql:53`). That view already unions nine arms with a `via`
  discriminator, three of which are the link tables (`customer_link`, `job_link`, `visit_note`), so
  the basis belongs on those arms and rides out through `v_capture_links`. The three TABLES are
  untouched, so the columns themselves go exactly where planned.
- **A retracted capture no longer leaks its `basis_reason`** (rebase). That was parked on 2026-09-14;
  the fold resolved it before it was built — `v_capture_links` excludes both retractions and retracted
  captures (`20260917130000:54-55`), under the operator ruling that a retracted note is removed from
  every default read. The one labelled exception is the manager's audit path
  (`captures_page` / `capture_full` with `includeRetracted`), so Phase 3 must check that the basis
  does not ride along there by accident.
- **The eval is a script, not a test** (review fix). `vitest.config.ts:6` runs `src/**/*.test.ts` and
  `src/test.setup.ts:8` loads `.env`, so a test file would bill ~30 live calls on every `npm test` in
  a keyed checkout. `describe.skipIf(!hasModelCredentials())` suits 1–3 clear-cut assertions
  (`src/email/classify.test.ts:13`); a scored eval follows `scripts/date-eval/` and
  `scripts/spine-eval/` instead.
- **The eval scores the prompts that CHANGE** (review fix). A candidate block can move the gated
  fields — `EXTRACTION_SYSTEM` says a visit "already handled must NOT set visitCommitted"
  (`extract.ts:123-125`), and a job list nearby could read that way: the Delphine failure, returned.
  So fixtures run WITH and WITHOUT candidates and all three gated fields are scored both ways.
- **A REPLY CARRIES THE DOUBT FORWARD** (user, 2026-09-14). Without Phase 4 a reply to a model-picked
  message arrives "thread-named": `findCustomersByThread` builds a thread's job from earlier messages'
  links and `withThreadJob` hands it back as `match.jobId`, so it could flip status, its promise is
  silenced by `!visit`, and its link reads as grounded — and replying to the firm's own mail is the
  common next message. REJECTED: having the thread lookup ignore basis-bearing links and re-pick. Less
  code, but a model may answer differently the second time and split one conversation across two jobs.
  The thread proves the conversation, not the pick: the reply gets the same job AND the same doubt.
- **An email the ASSISTANT sent is not evidence** (review fix, 2026-09-14). `send_email` stamps
  `raw_captures.job_id` from an id the agent typed (`src/mcp/tools/comms.ts:335-365`), checked only
  against the recipient's customer — and once Phase 3 lands, the id the agent reads is the model's
  pick. Treating that stamp as grounding launders the pick through the firm's own reply: message 1 is
  model-picked, the assistant replies naming that job, the customer's reply arrives grounded and can
  flip and silence. The assistant's send also leaves no `inherited` link, because the door never runs
  it (`isAgentWrittenCapture`, `src/db/rawCaptures.ts:58` — `sentVia` / `toolSlug`).
- **The grounding rule, therefore.** A thread's job is `'model'` when at least one `model` or
  `inherited` link reaches it AND no independent evidence does. Independent evidence is: a link with a
  null basis; a stamp (arm a) on a capture that `isAgentWrittenCapture` rejects; or an L2 row created
  from a thread capture (arm d, `jobs.source_capture_id`). An agent-written stamp is ignored either
  way — it neither grounds a pick nor creates doubt on its own.
- **New `ThreadIdentity` fields are OPTIONAL, present only when the basis is `'model'`** — the way
  `withThreadJob` spreads `jobId` (`identityMatch.ts:152`). `src/mcp/server.test.ts:3121` asserts
  `toContainEqual({ customerId, jobId })`, which ignores `undefined` keys but fails on `null` ones.
- **Traceable, not nested.** `jobBasisCaptureId` / `jobBasisReason` come from the EARLIEST model link
  by `captured_at`; an inherited reason copies the ORIGINAL — `inherited from capture <id>: <reason>` —
  so message 3 does not read `inherited from … inherited from …`.
- **The caps are unchanged.** Same rows, same `.limit(THREAD_ROW_CAP + 1)`. The refuse-when-full rule
  is what makes "every link reaching it" computable; a refused thread returns `[]`, and the message
  simply becomes a candidates case.
- **This plan's provenance shape is now a template** (rebase). Task
  `20260915-the-extractor-tags-each-inbound-capture` sequences itself behind this one — "waits for
  (1) that chooser task to land — it is active in recordFieldNote.ts, the same door" — and names
  "the chooser task's `basis` + `reason` migration" as the template for its own per-capture tag
  provenance. It adds fields to the same `EXTRACTION_TOOL` on every capture, where this adds them on
  one branch. Getting the shape right here is load-bearing for it.
- **`listLinkedCapturesForCustomer` is DELETED** (user, 2026-09-17). The reader this arc insisted on
  in #235 lost its last production caller when the retrieval layer moved the customer read into the
  `customer_contents` RPC (`src/db/context.ts:501`) and the `customer_link` arm of
  `capture_membership` took over in SQL. Its own comment claimed it "stays for the retraction walk",
  which was untrue — that walk keys on the capture (`listCustomerCapturesForCapture`), not the
  customer. Its two test reads now go straight to SQL, so both assertions survive the deletion.
- **THE BASELINE, measured 2026-09-17** (corpus v2, `z-ai/glm-5.3` via OpenRouter, 9 fixtures x 3):
  `committed 20/27 (74%)` · `skips 27/27 (100%)` · `status 26/27 (96%)`; no truncation, no errors;
  p50 1,060ms, p95 26,927ms. Per fixture, every miss is one of three:
  `commitment-outbound` committed 2/3 — THE SPECIMEN's own dated promise, missed once in three;
  `firm-confirms` committed 0/3 and `thursday-works-thread` committed 0/3 — see the next bullet;
  `thank-you` status 2/3. SUPERSEDED AS THE BAR by the v3 baseline below — kept as the record of
  what v2 measured, and of the two fixtures that exposed the definition question. The bar is on the
  FIELDS THE DOOR GATES ON, never on the model's prose.
- **THE v3 BASELINE, measured 2026-09-17** (corpus v3, `z-ai/glm-5.3` via OpenRouter, 12 fixtures x
  10 = 120 calls; no truncation, no errors; p50 1,179ms, p95 3,420ms — so v2's 26,927ms p95 was a
  single cold call, not a tail): `committed 102/120 (85%)` · `skips 106/120 (88%)` ·
  `status 114/120 (95%)`. THIS is the bar Phase 2 must not fall below. Realism moved four fixtures,
  and the movement IS the finding:
  * `firm-confirms` 0/3 → **10/10 committed**. Given a `Subject: Re: Thursday?` line the model reads
    "Yes … we will see you then" as agreement every time. v2's number was an artifact of bare text
    and three samples.
  * `thursday-works-thread` **0/10 committed, and `touchesOperations: false` in 9 of 10**. At v2 —
    bare, with thread context — the model called it committed 3/3. Add the quoted tail the reply
    really carries and it flips to not-committed every run: the already-handled clause firing on
    history quoted INSIDE the message being judged, which is the mechanism this corpus was rebuilt
    to reach.
  * `long-thread-accept` **4/10 committed** — the same acceptance shape across six messages.
  * `work-finished` skips 3/3 → **5/10**, status → 7/10: `Subject: All sorted` plus "just to let you
    know" reads as the prompt's own example of an "acknowledgement".
  THE PATTERN, and Phase 5's target: the model is reliable on a commitment the firm DECLARES
  (`commitment-outbound` 8/10, its quoted twin 10/10, `firm-confirms` 10/10) and unreliable on one
  completed by an ACCEPTANCE (0/10 and 4/10) — precisely the half ruling B newly requires.
- **`touchesOperations` IS PHASE 5's SECOND TARGET** (found by the v3 run). `skips` was 100% at v2
  and is 88% at v3, and both failures are operational replies read as acknowledgements. The
  suppression is not absolute — `touchesOperations === false` silences only when
  `visitCommitted !== true`, a commitment outranking the filter (`recordFieldNote.ts:363`, `:685`) —
  but on the acceptance fixture the two failures COMPOUND: no ask is raised, and the capture goes to
  `fileWithoutAsking(priorJobs[priorJobs.length - 1])`, the newest-job guess this arc removed from
  the ambiguous branch. So Phase 5 edits both clauses or neither.
- **PHASE 5 RUNS FIRST, AND ITS TARGET IS THE SKIP, NOT THE COMMITMENT** (operator ruling
  2026-09-17). Order: Phase 5 → 2 → 3 → 4. The phases are NOT renumbered — the handoff, the board and
  the sibling tasks all cite them by number. Priority, in the operator's words: when the firm accepts
  a visit "they're probably going to create it through UI or their seat agent anyways", so a missed
  commitment has a second path to the calendar; "if an L2 change is ignored, that might get picked up
  much later", and nothing else in the firm's day catches it. Raising `committed` stays wanted, but
  second.
  TWO PRECISIONS from the v3 data, because the target is not quite where it looks:
  (a) the skip FLAG is inert on the matched path — a `touchesOperations: false` there still appends
      the words, writes the link and applies the status signal (`recordFieldNote.ts:903`). What loses
      the L2 change is the JUDGMENT underneath it: deciding a message is chit-chat makes the model
      return a minimal object and drop `statusSignal` with it. `work-finished` flipped the job in 7
      runs of 10 and lost it in 3, two of which also said `touchesOperations: false`. So the fix pays
      out through `statusSignal` as much as through the gate.
  (b) `statusSignal` fails in BOTH directions and the wrong one is worse: `firm-confirms` returned
      `in_progress` twice and `commitment-outbound-quoted` once, and `open → in_progress` is a
      permitted transition (`NOTE_SIGNAL_TRANSITIONS`, `recordFieldNote.ts:156`), so agreeing a date
      flips the job to work-underway. An ignored change surfaces late; a wrong one is silently false
      and nobody is looking for it. Phase 5 fixes both directions.
- **PHASE 5 IS TWO MEASURED STEPS, not one edit** (the discipline this plan already applies to the
  candidate block). Step 1 edits the `touchesOperations` and `statusSignal` clauses and re-runs the
  eval; step 2 edits the `visitCommitted` clauses and re-runs it again. One edit for all three would
  make any regression un-attributable, and a re-run is ~120 calls of a cheap model. Phase 2's
  no-regression comparison is then against the baseline STEP 2 records, not the v3 one.
- **PHASE 5 IS DONE, and here is every number it moved** (2026-09-17; corpus v3, 12 fixtures x 10):
  ```
                          committed        skips          status
  v3 baseline             102/120  85%    106/120  88%   114/120  95%
  + step 1 skip/status    108/120  90%    120/120 100%   120/120 100%
  + step 2 commitment     119/120  99%    120/120 100%   117/120  98%
    step 2, re-run        120/120 100%    120/120 100%   110/120  92%
  ```
  ACCEPTED at step 2 (operator: "we don't have to get perfect numbers", "+ step 2 is fine"). **Phase
  2 compares against step 2**: `committed` 119-120/120, `skips` 120/120, `status` 110-117/120. The
  one soft spot left is `long-thread-accept`'s status wobbling 3/10-10/10 on a thread about sourcing
  parts — one fixture, in the direction the transition table and the planner both see again.
- **A CLAUSE ABOUT ONE FIELD IS NOT LOCAL TO THAT FIELD** (measured, and the most useful thing this
  phase learned). Chasing that status wobble, a sentence was added under `statusSignal`: "read the
  signal from the LATEST message alone — work discussed as upcoming earlier in a conversation is not
  work underway now". True of `statusSignal`, and it fixed the parts thread outright. It also
  collapsed every fixture carrying quoted or earlier context — the firm's own promise with the
  customer's request quoted beneath went 10/10 to 2/10, and `committed` overall 120/120 to 93/120,
  BELOW the pre-Phase-5 baseline — because the commitment rule depends on reading an earlier offer
  and accepting it now. Both that sentence and the companion "preparing is not starting" were
  reverted, the second unmeasured rather than keep a clause added only to chase one fixture. The
  reasoning is recorded in `extract.ts` beside the clause, and `scripts/extract-eval` is the loop for
  whoever tries again.
- **COMMITMENT IS "A VISIT IS NOW AGREED"** (operator ruling 2026-09-17, option B). `visitCommitted`
  answers: is a visit agreed as of this message, whoever said so. REJECTED: "is THIS message the
  firm agreeing" (v2's labels). Its hole is the commonest booking flow there is — the firm offers a
  slot ("we could come Thursday if that suits", not agreement) and the customer accepts ("Thursday
  works.", not the firm speaking), so an agreed visit exists and NEITHER message ever raises an ask:
  a silent loss identical in shape to the live specimen. Also rejected: C, B minus messages that
  merely restate a complete agreement — cleanest in principle, hardest for a model to execute, and
  nothing in the corpus tests it yet, so it is kept as a Phase 5 refinement to try; and E, counting
  offers too, which turns the field from a commitment signal into scheduling traffic. B's cost is
  duplicates, and the system HAS rails for over-telling — a capture landing on a job with a live
  visit asks nothing, and the once-ever send rail stops a second nudge — where it has none for a
  promise nobody raised. An offer alone is not agreement; a request alone is not; the firm stating it
  will attend IS agreement without waiting for a reply.
- **What that ruling does to the v2 numbers.** It relabels `thursday-works-thread` to `true`, which
  the model already answered `true` 3/3, so that fixture closes. `firm-confirms` KEEPS its `true`
  label — "Yes, Thursday morning works on our side, we will see you then" is an agreement completing
  — and the model answered `false` 3/3. B would have scored v2 at 23/27 (85%), not the 96% I first
  said in chat. (I then called that `firm-confirms` result a real model defect. The v3 run below
  FALSIFIES that: on realistic text, at ten runs, it is 10/10. The defect was in the fixture.)
- **`status` does not gate Phase 2** (operator 2026-09-17). It scored 26/27, and the planner is a
  second gate: prompted to read a job's history before declaring a flip, it does not pass a stray
  extractor signal through. So a `status` dip is not counted against Phase 2's no-regression
  comparison. `committed` and `skips` are.
- **THE CORPUS IS REBUILT AT v3, because v2 tested text production never sends** (2026-09-17). Every
  email path builds `formatEmailRawText` (`src/email/format.ts:13`) — `Subject:`/`From:` then the
  body — and NOTHING in the path strips a quoted reply tail, a signature block or a mobile footer:
  the body is Composio's `message_text` verbatim (`src/inbound/gmail.ts:39`, `gmailSent.ts:82`,
  `comms.ts:383`). v2's fixtures were bare one-liners, so the mechanism that most plausibly
  suppresses a live promise was unreachable — the already-handled clause (`extract.ts:123-125`)
  assumes earlier messages arrive AS earlier messages, and in real mail the earlier offer sits
  INSIDE the body being judged. v3 is 12 fixtures: real headers, signatures and footers throughout;
  quoted-tail TWINS of both commitment cases, the controlled comparison for that mechanism; a
  6-message thread with one body over `THREAD_MESSAGE_CHARS` so the 600-char cut in
  `renderThreadContext` runs for the first time; and the wrong-number case as a bare phone
  transcript, the door's other text shape (`src/calls/worker.ts:130`), since every other fixture is
  email. Runs raised to 10 — "0/3" is three samples of one fixture, and an answer given 20% of the
  time shows up as 0/3 easily.
- **NOT graded: a thank-you whose quoted tail carries the firm's promise.** `EXTRACTION_SYSTEM` ends
  "when in any doubt, leave it true", so `touchesOperations: true` there is the prompt being obeyed
  and scoring it against `skips: true` would manufacture a failure out of correct behaviour.
  Recorded in the corpus as a known untested shape.
- **PHASE 5 RAISES `committed`; phases 2-4 do not touch it** (operator 2026-09-17). The eval found a
  failure mode this plan had no phase for: the extractor sometimes does not notice a commitment at
  all. A missed commitment never wakes the planner, so better filing on a promise nobody saw buys
  nothing — and the user's point is that the gain runs the other way too, since a `committed` the
  model reads correctly means the planner is called more often and the manager is told in time.
  Phases 2-4 are a FILING change: Phase 2 must only not make `committed` worse, and
  `EXTRACTION_SYSTEM` stays byte-identical there so a moved number has one suspect. Phase 5 comes
  AFTER Phase 2 lands, for that clean before/after.
- **Both 2026-09-14 parks have LANDED** (rebase): the job-order tiebreak is on main (`jobs.ts:151`,
  `bf9d5ea`) and the retracted-link exposure was resolved by the views fold. Neither is on the board.
  **Accepted:** `matchIdentity` runs twice on the automatic path — a few indexed reads.

## Plain-language walkthrough

**Today (after PR #235),** a customer with several open jobs writes, nothing names one, and the door
gives up and files under the customer — even when the words make the answer obvious.

```
  BEFORE (PR #235)                          AFTER
  extract ─► who? ─► which job?             who? (from the envelope) ─► their 2–8 open jobs
                      └─ several ─► give up                                    │
                                                extract, SHOWN "1. boiler  2. kitchen tap"
                                                ├─ "2" ─► still open? ─► file on it, marked as a model's pick
                                                └─ none, or anything odd ─► give up, as before
```

**Phase 1 — measure the extractor first.** Nothing tests what it returns. Hand-written messages with
the right answers written down, run against the model production uses, scored and recorded.

**Phase 2 — show it the jobs.** Find the customer from the envelope and show their jobs as a numbered
list. It answers with a number or nothing, and nothing acts on it yet. The gate: no score drops —
including on messages that now carry the list.

**Phase 3 — file on the answer.** The number is checked against the list it was given, the job must
still be open, and the link records that a model picked it and why. It never moves status, and a
promise still reaches the planner.

**Phase 4 — the reply keeps the doubt.** When the customer answers on the same thread, the reply goes
on the same job and is treated as a model's pick too, so it cannot flip or silence what the first
message could not. The doubt lifts only when something that is not a model's guess points at the same
job. An email the assistant itself sent does not count: the job it named was copied from the record,
which is where the pick lives.

```
  msg 1  firm:     "we'll come about the tap"   → model picks tap     → link basis=model
  msg 2  assistant replies naming that job      → stamp, agent-written → IGNORED
  msg 3  customer: "can you do Thursday?"       → thread → same job, doubt carried
                                                  → no flip, asks, link basis=inherited
```

## Secrets & env preflight

- **All phases:** `OPENROUTER_API_KEY` (or `INFERENCE_API_KEY`) in `.env` — *already required*
  (`src/model/forcedTool.ts:115-117`); present in this worktree. The eval pins `z-ai/glm-5.3`
  EXPLICITLY rather than inheriting the default, so a later change to `DEFAULT_OPENAI_MODEL` cannot
  move the baseline silently. That IS production, for a structural reason and not just a count:
  `toolLoop.ts:483` (the planner) and `forcedTool.ts:117` (the extractor) both call
  `resolveOpenAiEndpoint()`, which reads the ONE variable `INFERENCE_MODEL` — there is no separate
  planner model, so the two cannot diverge. Confirmed against the pilot's own billing with the planner
  excluded: `cost_events.metadata->>'lane'` is `'planner'`/`'desk'` for those callers and NULL for the
  extractor's, and the no-lane bucket is 230 `glm-5.3` calls whose latest (2026-09-14 21:03) is two
  hours after the planner's. Render's API exposes no env read — `get_service` returns none and the only
  env tool is a write — which is why this was answered from what ran rather than from config.

---

## Phase 1: A measured baseline

### What this phase does
Adds a scored eval script for the extractor's outputs and records today's numbers.

### Changes required

**`scripts/extract-eval/run.mjs`** (new) + **`package.json`** script `extract-eval` — never in
`npm test`. Pins the production model from the preflight.
- Hand-written fixtures, never from the pilot: a firm commitment; a customer only asking; a
  thank-you; "the job's done"; the firm's own reply (`fromTheFirm`); a reschedule in a thread; a
  quote request; a wrong number; "Thursday works" with its job named only earlier in the thread.
- Each also gets a WITH-CANDIDATES twin (a promise beside a job that has a trip; a thank-you; a status
  report), run once Phase 2 renders candidates.
- Labels for `visitCommitted`, `touchesOperations`, `statusSignal`; each fixture 3×. Records per-field
  agreement, `finish_reason`, and output tokens.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass — and `npm test` makes no model call

### Live verification (agent-executable)
- Prerequisites: `.env` key; the production model name.
- [x] `npm run extract-eval` on today's code (no candidates exist yet). Evidence: per-field agreement,
      finish reasons and token counts, written into Decisions as the baseline.

### Manual verification
- [x] Check the labels. A baseline scored against wrong labels makes every later comparison worthless.
      DONE, and it found two wrong ones plus a corpus that did not resemble production: ruling B, the
      v3 rebuild and the v3 baseline above are the result.

---
*Pause after this phase — its manual list is non-empty.*

## Phase 2: The extractor is shown the jobs

### What this phase does
Finds the customer from envelope keys before extraction and shows 2–8 open jobs as a numbered list.
The answer comes back; nothing acts on it.

### Changes required

**`src/model/forcedTool.ts`** — export `isOutputTruncated(err)`, true for the errors thrown at
`:340` (anthropic, `stop_reason=max_tokens`) and `:433` (openai, `finish_reason=length`) — a typed
marker, not message matching; existing messages unchanged.

**`src/writePath/extract.ts`**
- `ExtractedFields` + `EXTRACTION_TOOL`: optional `jobChoice` (number — "ONLY when a CANDIDATE JOBS
  list is shown: the number of the one job this message concerns; omit if none") and `jobChoiceReason`
  (string — "one short sentence").
- `Extractor` context gains `candidates?: { title: string | null; status: string }[]`.
- `renderExtractionUser`: when candidates are non-empty, the order is thread → candidate block →
  label → message, and the latest message is ALWAYS labelled (its bare path has no label, so "the
  latest message" would point at unmarked text). With no candidates, all three current paths unchanged.
- `EXTRACTION_SYSTEM`: unchanged.

**`src/writePath/recordFieldNote.ts`**
- Hoist `isTechnicianChannel` from `:447` to above `:298` — nothing between reads it.
- After the `structure === false` return (`:286`), when
  `!isTechnicianChannel && !input.resolved && !input.decided && !input.captureId`, pre-match with
  `matchIdentity({ tenantId, technicianRef, capturedAt, extracted: { phone: input.fallbackPhone ?? null },
  email: input.fallbackEmail ?? null, threadId: input.threadId ?? null })` in a try/catch. On `matched`
  with no `jobId`: `listJobsForCustomer`, non-terminal (as `:607-609`); if 2–8, set `shownCandidates`
  (ids kept, titles cut at 80) and `preMatchCustomerId`.
- Rewrite the context argument at `:298-303`: pass it when there is a thread, the firm's own mail, OR
  `shownCandidates`, with `earlier: input.threadContext ?? []`. No candidates → `undefined` exactly as
  now (pinned at `recordFieldNote.test.ts:2055`).
- If that extraction throws and `isOutputTruncated(err)` and candidates were shown: re-extract once
  without them and clear `shownCandidates`. Every other error propagates as today.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] `extract.test.ts` pins hold; no candidates → all three render paths unchanged; with candidates →
      thread, block, label, message, in that order; both new fields declared
- [ ] a spy extractor gets candidates for a two-job customer matched on email, and NOT for: a
      technician channel, `resolved`, `decided`, a re-entry, a thread-named job, one job, nine jobs, an
      address-only identity
- [ ] a pre-match that throws still extracts, without candidates
- [ ] a stub throwing a truncation error once → a second call with no candidates, and the capture is
      filed; a stub throwing anything else → it propagates, one call only

### Live verification (agent-executable)
- Prerequisites: `.env`; the pinned model.
- [ ] `npm run extract-eval`, both variants. Evidence: WITHOUT — no field more than 1 run below
      baseline; WITH — no gated field more than 1 run below its WITHOUT twin (a dip is re-run once
      before it counts); no `finish_reason=length`.
- [ ] Specimen vs "Boiler diagnostic" / "Kitchen tap dripping" → no `jobChoice`; a kitchen-tap message
      → `2`; 3× each. Evidence: all six results and reasons.

### Manual verification
- [ ] Read the six reasons: refusing for the right reason, naming confidently rather than luckily.

---
*Pause after this phase — its manual list is non-empty.*

## Phase 3: The door files on the answer, and nothing else

### What this phase does
Accepts a checked answer as the job, records that a model picked it, and keeps both rulings.

### Changes required

**`supabase/migrations/<timestamp>_link_basis.sql`** (new) — on `job_captures` and `visit_notes`:
`basis text`, `basis_reason text`, `check (basis is null or basis in ('model','inherited'))`,
`check (basis_reason is null or basis is not null)`. Then surface them through the fold's own
definitions, since the old link views are gone: `CREATE OR REPLACE VIEW capture_membership`
(`20260916120000_retrieval_layer_core.sql:53`) APPENDING `basis` / `basis_reason` as the last two
columns — `null::text` on the seven non-link arms, the link row's own values on `job_link` and
`visit_note` — then the same append on `v_capture_links`
(`20260917130000_the_sql_views_fold.sql:45`), keeping its retraction filter and tenant check
verbatim. Appending at the END is what `CREATE OR REPLACE VIEW` allows; a reorder would need a drop,
and `v_capture_links` depends on `capture_membership`, so the order is membership first.
`npm run gen:types:local`.

**`src/db/jobs.ts:481`, `src/db/visits.ts:1424`** — optional `basis` / `basisReason`, sent only when
set, so no write names a column the pilot lacks before the migration.

**`src/writePath/recordFieldNote.ts`**
- Declare `let jobFromModel: { reason: string } | null = null` ABOVE `:632`, outside the block —
  `:797`, `:824`, `:890` and `:901` read it.
- Inside the `:632` block, before `:633`: if `shownCandidates` is non-empty, `customerId ===
  preMatchCustomerId`, `jobChoice` is an integer in `1..shownCandidates.length`, and that candidate's
  id is still in the fresh `candidates` → `job` = the FRESH row, `jobFromModel = { reason }`, skip
  `:633-636`. Anything else → PR #235 behaviour.
- `observeInbound` gains explicit parameters `jobBasis`, `jobBasisReason`, `attachedVisitId` — never
  read from the enclosing scope: it is called at `:634`, `:673`, `:689`, before `let visit` at `:736`,
  and reading either from the closure throws "Cannot access before initialization", which `tsc` does
  not catch.
- The ask at `:792-797`: with `jobFromModel`, a commitment asks even if `visit` is set, passing
  `attachedVisitId: visit?.id`. The links at `:824` / `:890` carry `basis: 'model'`. The status block at
  `:901-906` is skipped.

**`src/teamLead/planner.ts:1590`** — ` — chosen by a model from N open jobs: <reason>`, plus
` (already on a booked trip)` with `attachedVisitId`. **`src/mcp/server.ts:198-199` and `:213`** — the `v_capture_links(capture_id, customer_id, job_id,
visit_id, via)` catalog lists gain `basis, basis_reason`, and `src/mcp/server.test.ts:8068` pins that
description, so it is extended with them. **`docs/onboarding.md:129`, `docs/engineering-memory.md`** —
"never a model guess" holds for the customer; the job may be a model's answer from a numbered list.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] choice 2, uncommitted, no trip → `job_captures` on it, `basis='model'`; with a trip → `visit_notes`
- [ ] **no flip:** chosen job `in_progress`, `statusSignal: 'completed'` → still `in_progress`
- [ ] **no silenced promise:** chosen job has a visit, `visitCommitted: true` → `inbound_commitment` with
      `jobBasis`, reason, `attachedVisitId`; mutation-checked against the plain `!visit` rule
- [ ] **the list moved:** shown [A, B], A closes before resolution, choice 1 → none, NOT filed on B
- [ ] `jobChoice` of `0`, `3` of 2, `1.5` → none; `"2"` through `coerceBySchema` becomes `2` and IS
      accepted, as it would be in production
- [ ] a `jobChoice` with no list shown → ignored; pre-match customer ≠ final → ignored
- [ ] every other link writes a null basis; the CHECKs refuse `'guess'` and a reason without a basis
- [ ] the existing specimen test passes unchanged; the planner renders the model-choice line

### Live verification (agent-executable)
- Prerequisites: local stack; `.env`.
- [ ] Live extractor, local stack: the specimen → ask, customer link, no job link; a kitchen-tap
      message → a `basis='model'` link on the tap job with the model's reason. Evidence: the rows.

### Manual verification
- [ ] Judge the pair together: one door, two messages, two different and correct outcomes.

---
*Pause after this phase — its manual list is non-empty.*

## Phase 4: A reply on the thread keeps the doubt

### What this phase does
Makes `findCustomersByThread` know, per job, whether only a model's pick reaches it, and has the door
treat such a reply exactly as Phase 3 treats the pick.

### Changes required

**`src/db/rawCaptures.ts:324`** — `ThreadIdentity` gains optional `jobBasis?: 'model'`,
`jobBasisReason?: string`, `jobBasisCaptureId?: string`.

**`src/db/rawCaptures.ts:358`** — restructure: the single `jobIds` set (`:395`) becomes a map from job
id to `{ grounded: boolean; modelLinks: { captureId; reason; capturedAt }[] }`.
- arm (a) `:397` also selects `metadata`; a stamp grounds only when `!isAgentWrittenCapture(metadata)`.
- arms (b) `:408` and (c) `:422` also select `capture_id, basis, basis_reason` — on (c) from
  `visit_notes` itself, not the `visits!inner` embed; a null basis grounds, a non-null one is recorded.
- arm (d) `:440` grounds.
- The job-resolution loop (`:491`) and the dedupe (`:510`) read the map; a job gets the optional fields
  only when it is not grounded and has a model link, taken from the earliest by `captured_at`.

**`src/writePath/identityMatch.ts:137-153`** — `withThreadJob` copies the adopted job's optional basis
fields into `MatchResult`, only when present.

**`src/writePath/recordFieldNote.ts`** — `match.jobBasis === 'model'` sets `jobFromModel` exactly as Phase 3 does; that capture's link writes `basis: 'inherited'` and the copied original reason.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass; `server.test.ts:3121` unchanged and green
- [ ] msg 1 model-picks the tap job (trip attached); msg 2 on the thread with `statusSignal: 'completed'`
      and `visitCommitted: true` → not flipped, asked, `basis='inherited'` naming msg 1
- [ ] msg 3 inherits again, reason copied from msg 1, not nested
- [ ] **the laundering case:** msg 1 model-picked; an agent-written capture on the thread stamped with
      that job; the customer's reply → still inherits the doubt
- [ ] a null-basis link, a non-agent stamp, or an arm-(d) row on the same job → grounded, and the reply
      behaves as thread-named does today
- [ ] a thread over `THREAD_ROW_CAP` still refuses (returns `[]`)

### Live verification (agent-executable)
- [ ] none — deterministic, covered above

### Manual verification
- [ ] none

---
*Automated checks suffice; continue.*

## Phase 5 (RUNS FIRST): The extractor reads a short reply for what it says

### What this phase does
Fixes what the v3 baseline measured, in the operator's priority order, with the eval as the loop:
edit, `npm run extract-eval -- --runs 10`, compare. It runs BEFORE Phase 2, and in TWO measured
steps so a regression has one suspect. Nothing outside `EXTRACTION_SYSTEM` changes — no behaviour,
no schema, no door logic.

### Step 1 — the skip and the status signal (the operator's target)

**`src/writePath/extract.ts`**, `EXTRACTION_SYSTEM`:
- `:113-115`, the `touchesOperations` exemption. "an acknowledgement" is matching short operational
  replies by FORM: "Thursday works." (9 of 10 runs) and "just to let you know your engineer finished
  the repair" (5 of 10) are acknowledgements in shape and a schedule or a job state in content. Drop
  that word from the exemption list, keep "a bare thank-you / an auto-reply / a wrong number", and
  say outright that length and tone are not the test, with the counter-examples named.
- `:109-110`, `statusSignal`, BOTH directions: agreeing or arranging a visit is not work underway
  (`in_progress` means somebody has started), and a customer reporting the work done IS `completed`
  however casually they put it.

### Step 2 — the commitment (wanted, second)

**`src/writePath/extract.ts`**, same constant:
- `:111-112`, what sets `visitCommitted`: ruling B in the prompt's own words — a visit agreed as of
  this message, whoever said so; the firm saying it will attend, or the customer accepting a time
  the firm offered; an offer alone and a request alone are neither.
- `:123-125`, the already-handled clause: an OFFER made earlier is not an agreement, so a latest
  message that accepts one agrees the visit NOW; and quoted history reproduced inside the latest
  message (under "On <date>, <person> wrote:") is earlier context, not something the latest message
  is committing to. This is the clause the quoted-tail twins implicate — `thursday-works-thread`
  answered committed 3/3 bare at v2 and 0/10 once the tail was added.

**`src/writePath/extract.test.ts`** — the pins on the changed sentences move with them.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass — 127 files, 3,283 tests
- [x] the `EXTRACTION_SYSTEM` pins assert the new sentences

### Live verification (agent-executable)
- Prerequisites: `.env`; the pinned model.
- [x] STEP 1: skips 120/120, status 120/120, committed 108/120 — all three ABOVE the v3 baseline.
- [x] STEP 2: committed 119/120 then 120/120, skips 120/120, status 117/120 then 110/120. Each
      commitment fixture's quoted twin equalled or beat its bare twin.
- [x] Both baselines written into Decisions. Phase 2 compares against STEP 2's.

### Manual verification
- [ ] Read the prompt against the rulings. A prompt that scores well by naming the fixtures is the
      failure the eval cannot detect — the wording must generalise, not recite.

---
*Pause after this phase — its manual list is non-empty.*

## Deploy note

Deploys run NO migrations. Hand-apply PR #235's `customer_captures` migration if it is not already on the pilot,
then `link_basis`, BEFORE the code. Never `db push`.
