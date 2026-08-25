---
date: 2026-08-25
task: the ask shape — one message may cover several gaps, the answer keeps its link, and the seat agent can follow up
research: thoughts/shared/research/2026-08-24-the-ask-shape.md
status: complete
supersedes: nothing
---

**`supersedes:` note:** overturns nothing; builds on the one-call collapse
(thoughts/shared/plans/2026-08-24-one-call-collapse.md, PR #179). One verbal claim made while
scoping — "the delivered question is anonymous to the seat agent" — was already false at
`2937099`; this plan depends on the `(re: …)` anchor being present.

**Length flag:** this plan is over the 300-line budget. Adversarial review turned up 14 valid
findings, and the fixes for six of them added real work that was not visible when the scope was
chosen. See **Splitting** below — Phase 4 is separable and I recommend it.

## Overview

Three coupled changes. The planner may name several gaps in one `send`, delivered as one message.
A gap closed on a quote keeps its link to the note that answered it — which is what stops batching
from blinding the attribution column. And when a technician answers, the spine reports what else
is open on that job so their assistant can follow up while they are still on the phone.

## Splitting

Phases 1–3 (attribution + batching) are one coherent unit and stand alone. Phase 4 (the sibling
link) touches a different subsystem, has its own live-fleet gate, and its payload shape depends on
Phase 3's storage choice. **Recommendation: land 1–3, then plan Phase 4 separately** against the
grouped world that actually exists. Keeping all four is viable but makes one review gate carry
both a schema change and a fleet-wide doctrine change.

## Decisions

- **Scope: batching + attribution + the sibling link** (user, 2026-08-25). The decline verb for
  pending rows is deferred to its own plan.
- **The planner names a group with `nudgeIds`** (user, 2026-08-25) — not lead/follower, not code
  grouping by job. The planner chooses what travels together; code enforces only coherence.
- **`ask_group_id` holds the LEAD gap's own id**, not a fresh uuid (review finding 9). The plan
  first said `nudgeId` was the lead while Phase 2 said "earliest-created" — two rules that
  disagree whenever the planner does not pick the oldest gap. Storing the lead's id makes the lead
  self-identifying (`id === ask_group_id`), so `sessionId: nudge-<lead>` and the box's sent-marker
  name the gap the planner actually chose.
- **Every member row stores the full grouped message in `question`** (implementation call).
  `question` then says what the person actually saw, and `nudgeQueue.ts:88`'s `if (!row.question)
  continue` tamper-freeze — the only thing between a malformed row and an infinite re-serve loop —
  stays untouched. Consequence handled in Phase 4: the sibling payload dedupes by text.
- **Attribution: keep record-time, add close-derived** (user, 2026-08-25). `setNudgeAnsweredBy`
  already guards `.is(…, null)`, so the paths compose with no new logic.
- **The derived stamp only fires on a capture a badge-holder SPOKE** — implemented as a channel
  test (`technician_note|technician_voice|technician_photo`) AND a non-null ref, not the
  ref-presence test this plan first specified. **Phase-1 review found the ref-only guard inert**:
  the phone worker stamps the sentinel `'phone-line'` (`src/calls/worker.ts:129`) and mail ingest
  stamps the MAILBOX OWNER's ref on a customer's reply (`src/email/ingest.ts:109`), so both foreign
  shapes carry a non-null ref and would have been stamped.
  `listJobEvidenceSince` applies no technician filter, so `evidenceText` includes customer phone
  calls, email and manager notes; without this guard a gap closed on a customer's call would read
  as `closed_by_technician`. Accepted consequence stands: that metric begins counting
  judgment-backed links alongside who-and-when links, and a derived link lands on the planner's
  tick rather than instantly.
- **The sibling payload lists EVERY asked gap on the job, deduped by question text** — it does not
  try to exclude the one just answered (review finding 2). The record-time stamp declines at 2+
  asked, so there is no reliable signal for which gap a note answered; that is the whole premise.
  The seat agent has the person's reply in its own context and judges, which is inference on the
  RESPONSE leg and contradicts nothing (④b governs the ask leg only). §0k carries the rule.
- **Failure mode accepted as benign**: if the agent ignores the payload, the gap stays open and the
  planner asks on its next tick — today's behavior. Strictly additive.
- **Group coherence is a code guarantee**: all members share the lead's `technician_id` and
  `context.jobId`. One anchor names one job; delivery goes to one person.
- **One `nudge_decisions` row per member, with PER-MEMBER outcomes** (review finding 10).
  `markNudgeGroupQueued` is one guarded UPDATE with no rollback, so a partial move really does
  deliver to the movers — recording one `refused` for the group would claim gaps were not asked
  when they were.
- **The expiry sweep expires a group as a unit** (review finding 6). Members have independent
  `created_at`s, so one could cross the 18h never-delivered deadline while the group sits `queued`
  — going terminal while its text still ships inside the lead's message. One message, one fate.
- **Phase order puts attribution FIRST** so batching lands on a stamp that already survives N
  simultaneous asks.

## Plain-language walkthrough

**Phase 1 — the answer keeps its link.** When the planner closes a gap it must quote the words
that answered it, and code already checks that quote against the notes it showed. Those notes are
held in the same order as the records they came from, so code can tell *which* note held the
winning quote — it just discards that today. This phase keeps it and writes the link, but only
when the note came from a person on the roster, so a customer's phone call is never recorded as a
technician answering.

**Phase 2 — the plumbing learns about groups.** A new column marks several gaps as belonging to
one message. The delivery loop collapses a group into a single send; one delivery report moves all
of them. The 18-hour "never delivered" sweep learns to expire a group together, so one member
cannot go terminal while its question still ships inside the shared message. Nothing forms a group
yet — this phase only makes the pipes able to carry one.

```
BEFORE                                  AFTER
gap A ──► message 1                     gap A ┐   ask_group_id = A's id
gap B ──► message 2   (3 pings)         gap B ┼─► one message   (1 ping)
gap C ──► message 3                     gap C ┘   one ack moves all three
```

**Phase 3 — the planner can form one.** A `send` may now list several gap ids and one message
covering all of them. Code checks the group is coherent — same person, same job, none already sent
— and refuses it otherwise, but never decides *whether* to group. Each gap keeps its own line in
the decision log, recording what actually happened to that gap.

**Phase 4 — the assistant can follow up.** When a technician answers, the spine reports the job's
other unanswered questions in the same result, shaped like the existing answers that tell the
assistant "this didn't land, do this next". It cannot tell which question the person just answered
— nothing can, once two are outstanding — so it hands over all of them and the assistant judges
from the reply it just read. The standing instructions on every box, which today forbid re-asking,
are amended to say so.

## Secrets & env preflight

- **Phase 1:** none — local Supabase stack (`.env.test`, `already required`).
- **Phase 2:** none. Migration applied locally with `npx supabase migration up`. **Types are
  regenerated with `npm run gen:types:local`, NEVER `npm run gen:types`** — the latter is
  `--linked`, which points at the pilot, and the pilot is not migrated by deploy, so it would
  strip the new column straight back out.
- **Phase 3:** none for the gates. The optional live planner leg needs `ANTHROPIC_API_KEY` in
  `.env` (`already required`); skipping it leaves the codified tests covering the phase.
- **Phase 4:** none for the code. The fleet doctrine refresh needs box SSH + `nemoclaw` access
  (`already required`) and is user-gated.

---

## Phase 1: the close carries its own link

### What this phase does
`buildGapView` builds `evidenceText` by mapping over `relevant`, so index *i* is the flattened body
of `relevant[i].capture`. `GapView` drops the ids at its boundary and `validateDecisions` asks
`.some()` — a boolean. This carries the ids through, asks `.findIndex()`, and stamps the winning
capture after a successful close.

### Changes required

**`src/teamLead/planner.ts`**
- `GapView` (:334-364): add `evidenceCaptureIds: (string | null)[]; // index-aligned with evidenceText; null when the capture has no technician_ref`.
- `buildGapView` (:421, return at :591-600): add
  `const evidenceCaptureIds = relevant.map((e) => (e.capture.technician_ref ? e.capture.id : null));`
  and include it in the returned object. The null encodes finding 11's guard at the point where the
  capture row is still in hand.
- `PlannerDecision` (:90-118): add `answeredByCaptureId?: string | null;` — code-derived, never model-supplied.
- `validateDecisions` (:971-975): replace the boolean check with an index lookup, same refusal text:
  ```ts
  const shown = view.evidenceText.map(norm);
  const hit = shown.findIndex((text) => text.includes(wanted));
  if (hit === -1) { push('close whose citation does not appear in the evidence'); continue; }
  ```
  then after `usedQuotes.add(wanted); citation = quote;` set
  `answeredByCaptureId = view.evidenceCaptureIds[hit] ?? null;` (declare beside `citation`; spread
  `...(answeredByCaptureId ? { answeredByCaptureId } : {})` into the pushed decision).
- `PlannerDeps` (:194-250): add `stampAnswer?: typeof setNudgeAnsweredBy;`.
- Import `setNudgeAnsweredBy` from `'../db/index.js'` (barrel is `export *`; no new export needed).
- `applyDecision` (signature :1162-1172, close case :1236-1245): add a `stampAnswer` parameter and
  stamp best-effort AFTER a close that moved:
  ```ts
  const closed = await markOutcome(d.nudgeId, tenantId, 'answered', resolution);
  if (closed && d.answeredByCaptureId) {
    try { await stampAnswer(d.nudgeId, tenantId, d.answeredByCaptureId); }
    catch (err) { console.error(`[planner] ${d.nudgeId}: closed, but stamping its answer failed`, err); }
  }
  return done(closed);
  ```
  A failed stamp must never fail the close — `attributeAnswerToGap`'s swallow doctrine.
- `runPlanner` (the `applyDecision` call, ~:1521-1530): thread `deps.stampAnswer ?? setNudgeAnsweredBy`.

**`src/teamLead/planner.test.ts`** — seven cases: an evidence close records the id of the capture
holding the quote (quote in the *second* of several shown); a quote found in a capture with a NULL
`technician_ref` records no id; `record`-basis and refused closes carry none; `applyDecision` calls
`stampAnswer` once with `(nudgeId, tenantId, captureId)` after a close that moved; a close whose
`markOutcome` returns null does NOT stamp; a throwing `stampAnswer` still reports `applied`.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (2236 passed, 8 skipped; lint 0 errors — the one warning at planner.test.ts:1145 is pre-existing and outside this diff)
- [x] the new planner.test.ts cases pass — NINE, not seven: the foreign-capture case split into a `test.each` over the two shapes production actually emits (see below), and a shadow-mode case was added
- [x] existing `src/db/nudges.test.ts` first-write-wins cases still pass (record-time path untouched)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack running.
- [x] none beyond the suite — no model call and no new external surface.

### Manual verification
- [ ] none

---

## Phase 2: the transport learns about groups

### What this phase does
Adds the grouping column and teaches delivery, the ack, and the expiry sweep to treat a group as
one unit. Nothing writes `ask_group_id` yet, so production behavior is unchanged when this lands.

### Changes required

**`supabase/migrations/20260825000000_nudge_ask_group.sql`** (new)
- `alter table nudges add column if not exists ask_group_id uuid;`
- `create index if not exists idx_nudges_ask_group on nudges (tenant_id, ask_group_id) where ask_group_id is not null;`
- Header: null = "asked on its own", the normal case. The column holds the LEAD member's own
  `nudges.id`, so the lead is the row where `id = ask_group_id`. No FK — the group is a set of
  peers and a self-referencing FK would constrain deletion order for no gain.

**`src/db/nudges.ts`**
- `markNudgeGroupQueued(ids: string[], tenantId: string, question: string, leadId: string): Promise<Nudge[]>`
  — one guarded UPDATE, `.in('id', ids).eq('tenant_id', tenantId).eq('status','pending')`, setting
  `status:'queued'`, `question`, `ask_group_id: leadId`, `attempts: 0`, `queued_at`. Returns the rows
  that actually moved so a partial move is visible. `markNudgeQueued` stays for the single-gap path.
- `markNudgeAskedGroup(leadId: string, tenantId: string): Promise<Nudge[]>` — reads the lead's
  `ask_group_id`; null ⇒ delegate to `markNudgeAsked` and wrap its result in an array; otherwise one
  guarded UPDATE over the group, `.eq('status','queued')`, one shared `asked_at`.
- `listQueuedNudgesInGroupForHost(leadId: string, hostId: string): Promise<QueuedNudgeForHost[]>`
  (review finding 5) — `completeNudgeDelivery` point-reads only the lead, but its failure path must
  hand EVERY member to the manager, and `handToManager` needs a full row per member.
- `listNudgesExpiringInGroup(tenantId, leadIds: string[])` is NOT added; the sweep works from rows
  it already holds (below).

**`src/control/nudgeQueue.ts`**
- `NudgeQueueDeps.asked` (:57) becomes `typeof markNudgeAskedGroup`, and `groupMembers?: typeof
  listQueuedNudgesInGroupForHost` is added. **`src/control/nudgeQueue.test.ts`'s `baseDeps` (:71)
  stubs `asked` returning one row and must be updated to return an array** (review finding 8), or
  every existing `completeNudgeDelivery` test fails to compile.
- `buildNudgeDelivery` (:82-122): partition `rows` by `ask_group_id` (null = its own group of one).
  Emit ONE item per group; the lead is the member whose `id === ask_group_id`. **SUPERSEDED
  DURING IMPLEMENTATION:** the plan said to fall back to the first row when no member matches;
  review showed that a group really can lose its lead (`moot` and the pre-ask carve-out each close
  ONE queued row), and promoting a sibling changes the delivery item id — which the box dedupes on
  (`sent-<id>`) — so the whole message would be re-sent with both ledgers reset. A leaderless group
  is FROZEN for the 18h expiry instead. Liveness skip, the
  `!row.question` freeze, `MAX_SERVE_COUNT` and the `serve_count` increment all evaluate on the LEAD.
- Serve-cap and terminal-failure paths (:89-103, :158-168): `handToManager` + `markNudgeOutcome('failed', …)`
  run for EVERY member — an undeliverable question must not orphan the gaps it was written for
  (the F1 doctrine in the file header). `completeNudgeDelivery` gets its members via `groupMembers`.
- `completeNudgeDelivery` (:149-152): on `'delivered'`, call `markNudgeAskedGroup`; a non-empty
  array is `'asked'`, an empty one `'ignored'`.

**`src/jobs/watchers.ts`** (review finding 6)
- The expiry collector (:826-830) currently pushes any `pending|queued` row past
  `created_at + NUDGE_DELIVERY_DEADLINE_HOURS`. Make it group-aware: when a candidate carries an
  `ask_group_id`, pull in every open sibling from the rows this tick already read and expire them
  together, keyed on the EARLIEST member's `created_at`. Without this, one member goes terminal
  while its question still ships inside the lead's message and `markNudgeAskedGroup` silently omits
  it from the ack.

**`src/control/nudgeQueue.test.ts`** — seven cases: three grouped rows produce ONE item keyed on the
lead (`id === ask_group_id`), not the earliest-created; a mixed pull (group of two + one ungrouped)
produces exactly two; one `'delivered'` moves all three to `asked` with one shared `asked_at`; an
inactive technician freezes the whole group; serve-cap exhaustion and terminal delivery failure each
hand EVERY member to the manager and fail all; a group whose lead has a null `question` is frozen.

**`src/db/nudges.test.ts`** — `markNudgeGroupQueued` moves only `pending` members and returns exactly
those; `markNudgeAskedGroup` on an ungrouped row matches `markNudgeAsked`;
`listQueuedNudgesInGroupForHost` is host-scoped and returns nothing for another host.

**`src/jobs/watchers.test.ts`** — a group with one member past 18h expires ALL members, and each
gets its own manager item.

### Automated verification
- [x] `npx supabase migration up` applied on the local stack, then `npm run gen:types:local` —
      `database.types.ts` moved by EXACTLY 3 lines (Row/Insert/Update), confirming local, not the pilot
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass (2263 passed, 8
      skipped, twice in a row). NOTE a PRE-EXISTING load-dependent flake at
      `src/model/toolLoop.test.ts:490` (a 1ms wall-clock budget race) surfaced twice during this
      phase; `toolLoop` is untouched by this branch and it failed 0/12 runs in isolation
- [x] the new nudgeQueue / nudges / watchers cases pass, and each was mutation-checked — the
      grouping, the leaderless freeze, the closedThisTick guard, the host filter, the late-ack
      path, the lead-in-members fallback and the lead-membership guard each kill at least one test
- [x] `information_schema` shows `ask_group_id` (never `list_migrations`), and `pg_indexes` shows
      `idx_nudges_ask_group` as a partial index

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; `psql` against it.
- [x] PASSED 2026-08-24 on the local stack (verification subagent, fresh context). Three pending
      gaps on job `job-phase2-live-0001` grouped under lead `4d991094-…`: `buildNudgeDelivery`
      returned EXACTLY ONE item, `id` and `sessionId` = `nudge-4d991094-…`, and its
      `directMessageB64` decoded byte-identical to the queued grouped text (em dash intact).
      After one `'delivered'` report, CROSS-CHANNEL read-back via `docker exec … psql` (not the
      typed layer that wrote it):
      `rows=3 | distinct_asked_at=1 | distinct_status=1 (asked) | distinct_group=1`, with
      `serve_count` 1 on the lead and 0 on both siblings. Scratch tenant rows deleted by id
      afterwards (`nudges_total=0`, matching the pre-run state); the pilot MCP was never touched.

### Manual verification
- [ ] none

---

## Phase 3: the planner forms a group

### What this phase does
Lets one `send` name several gaps and queue them as one message, with code checking only coherence.

### Changes required

**`src/teamLead/plannerPrompt.ts`**
- `SUBMIT_PLAN_TOOL` (:213-292): add `nudgeIds` — array of strings, `"For 'send' only: the gaps this
  ONE message covers, ids copied exactly, including this entry's own nudgeId. All must be the same
  person on the same job and none may have gone out yet. Omit for an ordinary single question."`
  `required` is unchanged — `nudgeId` stays mandatory and is the group's lead.
- Its `question` description (:229-236) currently says "One question, no preamble or sign-off", and
  `PLANNER_SYSTEM`'s WRITING THE QUESTION block (:112-125) repeats it. **Both must be amended**
  (review finding 14) or the prompt contradicts the new verb: one message may carry several
  questions when `nudgeIds` names several gaps, still with no preamble or sign-off.

**`src/teamLead/planner.ts`**
- `PlannerDecision`: add `nudgeIds?: string[];`.
- `cleanQuestionDraft` (:783) caps at 500 chars, which now has to hold N questions; exceeding it
  nulls `questionDraft` and refuses the WHOLE group. Take an explicit `maxLen` argument —
  `500 + 250 * (members - 1)`, hard-capped at 1200 — and thread the member count from
  `validateDecisions`.
- `validateDecisions`: the pending-status rail lives in the branch at **:891-906**, which is
  `if (action === 'send' || action === 'hold')` and is SHARED with hold — the group rails need their
  own `action === 'send' && Array.isArray(d.nudgeIds)` guard after it. Rails: every member resolves
  in `views` (else `'names a gap that was not in this plan'`); every member is `pending` (existing
  wording); every member shares the lead's `technician_id` and `ctxStr(nudge,'jobId')` (else
  `'groups gaps that are not the same person on the same job — one message can only be anchored to one job'`);
  no member already in `seen`; the lead's own id must appear in the list. On success `seen.add()`
  every member and carry `nudgeIds`. A list of length ≤ 1 is an ordinary single send.
- `PlannerDeps`: add `markGroupQueued?: typeof markNudgeGroupQueued` (review finding 4 — the unit
  suite stubs every writer, so an un-injected call is untestable and touches the real DB).
- `applyDecision`: add a `markGroupQueued` parameter. When `d.nudgeIds` has >1 member, call
  `markGroupQueued(d.nudgeIds, tenantId, \`${d.questionDraft}${anchor}\`, d.nudgeId)` — the lead id
  IS the group id. Return the moved ids so the caller can record per-member outcomes. The
  stale-hold clear runs for every member that moved. The anchor is still built from the LEAD row,
  which is why the same-job rail exists.
- `runPlanner` records loop: when a decision carries `nudgeIds`, push one `NudgeDecisionInput` per
  member — same action/reason/confidence/`questionDraft` — with **per-member outcome**: `applied`
  for ids the write moved, `refused` (detail: the existing `moved` string) for the rest (review
  finding 10). **The `mode !== 'live'` shadow branch (:1500-1503) must fan out too** (review
  finding 13), or siblings collect `unmentioned` rows in every shadow and eval run and the corpus
  cannot tell "considered" from "never seen". `spokenFor` (:1580) then covers every member.

**`src/eval/plannerCorpus.ts`** (review finding 12) — nothing in the corpus ever fires `send` on a
multi-gap job: `twoGapWorld` seeds both gaps `asked`. Add a `pendingTwoGapWorld` variant (both
`status:'pending'`, no `askedAt`, no `question`) and one scenario, `MG-09`, with an arc expectation
that either both rows end up sharing one `ask_group_id` or neither does — grouping is the
planner's judgment, so both outcomes pass; what is being pinned is that the verb WORKS and the
rails do not refuse a legitimate group.

**`src/teamLead/planner.test.ts`** — eight cases: a two-gap group queues once and records two
decision rows; groups spanning different jobs, different technicians, or containing an already-asked
gap are each refused with their own message; a group omitting its own lead id is refused; a partial
move records `applied` for movers and `refused` for the rest; no member of an applied group gets an
`unmentioned` row, in live AND in shadow; a `send` with no `nudgeIds` behaves exactly as today.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass (2279 passed, 8 skipped)
- [x] the new planner.test.ts cases pass — THIRTEEN, not eight: review found four Phase-3 rails with
      code but NO test (the member `seen.add` in both directions, the cap threading, the
      refused-group record fan-out), each now mutation-checked to kill a test
- [x] `MG-09` is in the corpus and the eval suite passes. Its expectation was TIGHTENED after
      review: `groupingCoherent` alone passes when nothing is grouped AND when nothing is sent, so
      it could not fail for the verb it exists to pin — it now also requires an applied `send` on
      both gaps. The `groupingCoherent` grader itself gained the test every other arc check had
- [x] the existing planner and `plannerEvalGraders` suites pass unchanged; a regression test pins
      that a send with no `nudgeIds` is byte-for-byte the old path

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; `ANTHROPIC_API_KEY` in `.env`.
- [x] PASSED 2026-08-25 (verification subagent, fresh context, real paid model call). The planner
      GROUPED on its first attempt. Cross-channel `docker exec … psql` read-back:
      `rows=2 | distinct_group=1 | distinct_question=1 | ungrouped=0`, the group id equal to the
      `overdue_visit_gap` row's own id (`is_lead=t` on exactly one row), both questions
      byte-identical (same md5, 302 chars). Both gaps got their own applied `send` row in
      `nudge_decisions`; ZERO `unmentioned` rows. Message delivered:
      "Quick check-in on the water heater replacement for Phase3 Live Customer — two things needed
      for the record: (1) Can you confirm the visit status? … (2) What were the materials or job
      costs on this one?" followed by the code-printed
      "(re: Phase3 Live Customer — Water heater replacement)".
      Scratch rows deleted by id; the pilot MCP was never touched.
      TWO OBSERVATIONS, neither a Phase-3 defect: (a) the model ALSO submitted a redundant separate
      `send` for the sibling, correctly refused by the `seen` dedup — the prompt now says one entry
      decides them all; (b) `ANTHROPIC_MODEL` was unset so the run used `claude-sonnet-4-6`, the
      code default — which CONFIRMS the standing open question that the default is Sonnet, not Opus.

### Manual verification
- [ ] Read the grouped message and judge whether it reads as one natural question to a technician
      rather than three stapled together. The only check that cannot be codified, and the point of
      the feature.

---
*Pause after this phase — its Manual verification list is non-empty.*

## Phase 4: the assistant can follow up

### What this phase does
Reports the job's open questions back to the seat agent when an answer lands, and amends the box
doctrine that currently forbids re-asking.

### Changes required

**`src/mcp/server.ts`**
- `commitNote` (:2109-2121): after `attributeAnswerToGap`, read the caller's asked gaps on that job
  and include them in the `recorded` result. **`attributeAnswerToGap` keeps its `Promise<void>`
  signature** (review finding 7 — `src/mcp/server.test.ts:8232-8241` pins
  `.resolves.toBeUndefined()`), and the payload does NOT try to exclude the just-answered gap
  (finding 2 — the stamp declines at 2+ asked, so no such signal exists):
  ```ts
  let openQuestions: { question: string }[] = [];
  try {
    if (input.answeredByTechnicianId && result.jobId) {
      const asked = await listAskedNudgesForTechnicianJob(
        input.tenantId, input.answeredByTechnicianId, result.jobId);
      openQuestions = [...new Set(asked.map((n) => n.question).filter((q): q is string => !!q))]
        .map((question) => ({ question }));
    }
  } catch (err) { console.error(`[openQuestions] job ${result.jobId} lookup failed`, err); }
  ```
  The `Set` dedupes (finding 3): grouped members all hold the same full message, so a batched ask
  yields ONE entry, not N copies. No ids are returned — the agent has no tool that takes one, and a
  ref in front of a technician is the mistake the anchor exists to avoid. The try/catch is
  mandatory: a failed lookup must never fail a note that landed.
- Spread `...(openQuestions.length > 0 ? { openQuestions } : {})` into the `recorded` return.
- `record_field_note`'s description (:268-278): a `recorded` answer may carry `openQuestions` — the
  office's questions still outstanding on that job, which MAY include the one just answered. Judge
  from what the person said; ask the first genuinely unanswered one now, in your own words.

**`Box_Setup_Stuff/bootstrap-box.sh`** (§0k block, ~:1023-1041)
- Clause 1 keeps its meaning for questions already answered and gains: when `record_field_note`
  returns `openQuestions`, compare them against what the person just told you. Anything they
  already covered is answered — do not raise it. Ask ONE thing they have not covered, in your own
  words, while they are still here; if they do not engage, drop it. Never mention the office, a
  queue, or how many are outstanding.

**`docs/nemoclaw-tech-agent.md`** — mirror the §0k change (Box_Setup_Stuff sync rule).

**`src/mcp/server.test.ts`** — six cases: a note on a job with two asked gaps returns
`openQuestions` with both (the payload does not guess); grouped members sharing one question text
yield ONE deduped entry; another technician's gap never appears; a `pending`/`queued` gap never
appears; a duplicate note returns `duplicate` and no `openQuestions`; a throwing lookup still
returns `recorded`. The existing `attributeAnswerToGap` `toBeUndefined` pin still passes.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass (2300 passed, 8
      skipped; lint exits 0 — the one warning at planner.test.ts:1148 is pre-existing and outside
      this diff)
- [x] the new cases pass — ELEVEN in `server.test.ts` (the describe went 8 → 19) plus one new file,
      `src/mcp/serverFollowUp.test.ts`, against the plan's six. Beyond the plan: a roster-less/no-job
      fail-closed case mirroring `attributeAnswerToGap`'s own guard, three from round 1 (F2/F3/F5),
      the resume-path case from round 2 (R2-D), and the `confirmed`-schema pin (R2-A). SEVEN were
      mutation-checked, each failing only on the mutation named: dropping the `new Set` (grouped
      case), re-throwing instead of swallowing (helper failure case), adding `nudgeId` to an entry
      (two-gap case, via `toEqual` on whole entries), making the spread unconditional (absent-key
      case), deleting the record-the-reply duty from the tool description (description case),
      inlining an unguarded read in `commitNote` (`serverFollowUp.test.ts`, fails with
      `Error: nudges read is down`), and — caught by the pre-existing `src/eval/doctrine.test.ts` —
      the two-line §0k heading.
- [x] `src/mcp/server.test.ts`'s 14-tool count assertions (:175, :2309) still pass — no tool added
- [x] `md5 Box_Setup_Stuff/bootstrap-box.sh` = **`203d9ae2c05b103cb378092fc27ce4ed`** (recorded
      before any fleet refresh — copy-drift trap). The earlier `caa229f2…` (pre-review draft) and
      `199902b4…` (post-round-1) are SUPERSEDED and must not be what a refresh verifies against.
- [x] §0k refresh idempotency proven mechanically, not by eye: replaying the block's own
      delete-then-append `awk` (`bootstrap-box.sh:1019`) three times, and separately upgrading a
      simulated seat carrying TODAY's 2026-08-23 block, both yield exactly one §0k heading, one
      clause 1a, one clause 1b, and untouched neighbouring sections.
- [x] **`src/eval/doctrine.test.ts` caught a real fleet bug in the first draft of this phase.** The
      §0k heading was split across two `## ` lines; the block's own delete-then-append `awk`
      (`bootstrap-box.sh:1019`) stops at the next `^## `, so every refresh would have orphaned a
      stray heading line into all six seats' AGENTS.md, and `extractDoctrine`'s `nameOf` would have
      read the section as empty. Fixed to a single-line heading.

### Adversarial review (rounds 1–2) — ten findings, all resolved

- **F1 (the one that mattered): clause 1a told the agent to ASK the follow-up but never to RECORD
  the answer.** Clause 1's record-duty is keyed on *"when the person answers an office question"*,
  and a follow-up the agent asks in its own words carries no `(re: …)` line — so on a literal
  reading the reply was not an office answer and had nothing to file against. The gap would stay
  `asked`, the planner would re-ask it next tick, and **the technician would be asked the very
  thing they had just said** — worse than never following up, and it silently deletes the only
  outcome that makes this phase worth building. Fixed by adding **§0k clause 1b** (and the same
  duty to the tool description): their reply is an answer to an office question, record it with
  `record_field_note` on the SAME job.
- **F2: nothing pinned that no ids are returned.** The helper read only `.question`, so adding
  `nudgeId` to each entry passed every test while gap uuids reached a technician's chat context —
  the machine-artifact-in-a-human's-face failure the anchor exists to prevent. Fixed with `toEqual`
  on whole entry objects; mutation-checked.
- **F3: nothing pinned that the key is ABSENT when nothing is open.** The only `toBeUndefined` sat
  on the `duplicate` branch, which returns before the lookup runs — so making the spread
  unconditional (`openQuestions: []` on every note) passed. Fixed with a recorded-with-nothing-open
  case; mutation-checked.
- **F5: the tool description was unpinned**, and until the user-gated fleet refresh it is the ONLY
  instruction the six live seats have. Fixed with assertions on the description text itself
  (existing precedent in this file pins the `agentContext` clauses the same way).
- **F6: production `question` values are `questionDraft + anchorLine(row)`**, so every entry ends
  with the code-printed `(re: Customer — Job)`, while all fixtures passed bare strings. **Decision:
  do NOT strip it.** Stripping would couple `src/mcp/server.ts` to the planner's anchor format, and
  a silent format change would stop stripping while still reading as working. The real hazard is
  the agent ECHOING it, which is closed in the instructions instead (§0k 1a + the description both
  forbid repeating that line). A production-shaped fixture now pins the received shape, so this is
  a recorded decision rather than an untested accident.
- **F4 was accepted in round 1 and then FIXED in round 2.** The surviving mutation was "delete
  `openQuestionsFor` and inline an unguarded read in `commitNote`", which throws AFTER the L1 append
  and tells a technician their note did not land when it permanently did. Round 1's stated reason
  for accepting it was wrong on the facts — I said a `REVOKE`-based injection would poison
  *concurrently running* files, but `vitest.config.ts:11` sets `fileParallelism: false`, so nothing
  runs concurrently; the real objection was always durability (a revoke whose restore is skipped
  breaks the local stack for every later file and the next run). The half that WAS true is that no
  per-row input can make the query raise: `technicianId` is the badge's roster uuid at all three
  `commitNote` sites, `jobId` is minted by the write path, and `nudges.context` is `jsonb`, so a
  malformed context makes `->>` return NULL rather than error. Round 2 supplied the missing route:
  `src/mcp/serverFollowUp.test.ts` stubs the single db function with `vi.mock` (module-registry
  scope is per-FILE, which is why it is its own file — `server.test.ts` needs the genuine one),
  reaching `server.ts` through the `export * from './nudges.js'` barrel, and drives the REAL tool
  against the local stack. Mutation-checked: the inline-unguarded-read mutation now fails with
  `Error: nudges read is down`. The real-database-error property stays pinned on the helper too.

**Round 2 (review of the round-1 fixes) — four more, all fixed:**

- **R2-A: clause 1b told the agent to record "on the SAME job", which is not a lever it has.**
  `record_field_note` takes no job or customer target; job selection is server-side from the
  MATCHED CUSTOMER (`src/writePath/recordFieldNote.ts:250-264`). The only lever is identity, and
  the schema pointed away from it — `confirmed` was documented as *"With confirmId: …"* even though
  the dispatch reads `args.confirmed` at `server.ts:2415` and passes it to `matchIdentity` on the
  NO-confirmId branch, which one-shot commits. Consequence in production: a follow-up reply is a
  bare fragment ("about two hundred"), `matchIdentity` cannot resolve it, the tool answers
  `needs_identity`, and **the assistant asks the technician which customer it was seconds after
  recording one for them** — friction and abandonment, and if the agent gives up, F1 is back. No
  corruption risk (a bare fragment never auto-matches). Fixed in three places: the `confirmed`
  schema description now documents the standalone use, the tool description names it, and 1b says
  to pass `confirmed: {customerId}` — the id the previous `recorded` result already returned.
- **R2-B: 1a's stop condition pointed at the last message, but the list never shrinks.**
  `setNudgeAnsweredBy` writes only `answered_by_capture_id` — status stays `asked` — and the
  watcher's activity auto-close needs `soleGapOnJob` (`watchers.ts:796-799`), which is false in
  exactly the 2+ gap case `openQuestions` exists for. So every subsequent note on that job returns
  the SAME entries, and a literal reading of 1a ("read it against what the person said") re-asks
  question 1 after recording the answer to question 2. Fixed: 1a now judges against everything said
  **in this conversation**, and says outright that the list does not shrink.
- **R2-C: nothing pinned the §0k clause CONTENT.** `doctrine.test.ts` catches a renamed or deleted
  SECTION, not a deleted clause — so removing 1b failed no test, in the one artifact that actually
  reaches the six seats. Fixed with a §0k body assertion (same precedent as the existing
  `RECORDS ON THE FIRST CALL` pin), covering the record-duty, the `confirmed:{customerId}`
  mechanism, the whole-conversation rule and both tone rules.
- **R2-D: the RESUME path was untested.** All new cases used the one-shot branch, yet this file's
  own attribution test calls resume *"the common answer path"* — and R2-A makes that truer still.
  Fixed with a stage → `needs_identity` → resume case asserting `openQuestions` survives.
- Two cosmetic drifts fixed alongside: the §0k heading stamp said "clause 1a" when 1a **and** 1b
  shipped, and `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:394` still described §0k as
  record-only.
- **Known, not fixed (efficiency only):** `commitNote` issues `listAskedNudgesForTechnicianJob`
  twice per recorded note with identical arguments — once inside `attributeAnswerToGap`, once
  inside `openQuestionsFor` — on the hottest technician write path. Halving it means having
  attribution hand back what it read, which the `Promise<void>` pin (`server.test.ts:8241`) rules
  out. Recorded as a known choice.
- **Pre-existing hazard surfaced, not introduced here:** if the `docker exec … grep -q` at
  `bootstrap-box.sh:1018` fails for a reason OTHER than the block's absence (a transient docker
  error), the delete is skipped and the block DOUBLE-APPENDS. No repo test can see it —
  `doctrine.ts` reads the script, not the seat. Worth a `grep -c` audit after any fleet refresh.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; MCP server reachable with a technician badge.
- [x] PASSED 2026-08-25, 4/4 (verification subagent, fresh context). Driven through the REAL
      production entry — `createHttpServer()` on 127.0.0.1:8977 with a gateway-HMAC-signed
      technician badge, real MCP JSON-RPC over SSE, live `defaultExtractor` (no stub) — and every
      result confirmed by raw `psql` inside the Postgres container, out of process and bypassing
      PostgREST entirely. Env pinned to `.env.test` through `assertLocalTestEnv()`; `.env` was
      never loaded wholesale (one grepped line, `ANTHROPIC_API_KEY`), and the `supabase-test` MCP
      was never touched.
  * **Two separate asked gaps → both reported**, `ask_group_id` NULL on each and
    `answered_by_capture_id` NULL on both (attribution correctly declined at 2+):
    `openQuestions: [{"How did the visit go?"},{"What did the parts come to?"}]`.
  * **Grouped ask → exactly ONE entry.** `markNudgeGroupQueued` moved 2 rows,
    `markNudgeAskedGroup` moved 2 rows; SQL confirms two `asked` rows sharing one
    `ask_group_id` (= the lead id) and one question text, and the payload carried
    `[{"How did the visit go, and what did the parts come to?"}]`. The text dedupe is proven
    against a real group, not a hand-made fixture.
  * **Negative controls held** with four gaps on ONE job — mine `asked`, a stranger's `asked`,
    one `pending`, one `queued`. Only mine came back.
  * **Technician surface still exactly 14 tools** off the live `tools/list`.
  * L1 read-back shows all three captures landed with matching `visits.source_capture_id`.
  * Fixtures cleaned (8 nudges, 2 technicians deleted; nothing truncated). `raw_captures` left
    in place — append-only by design.
- **Live specimen worth recording (not a defect):** in the negative-control run the single asked
  gap WAS stamped by `attributeAnswerToGap`, and `openQuestions` still reported it back. That is
  the one case where a filter would be available, and it is still deliberately not applied: the
  stamp fires whenever exactly one gap is asked, including for a note that answered nothing
  ("dropped off a part"), so treating it as proof-of-answer would hide a genuinely open question
  from the assistant and the office's question would go unanswered with no follow-up. A redundant
  entry costs one doctrine comparison; a filtered-out entry costs the ask.

### Manual verification
- [x] **DONE 2026-08-25.** §0k refreshed on s2 first, then s3/s5/s6/s7/s8. All six audited against
      the canonical block (normalised section md5 `9ee678c4e62c`, 40 lines — six of six MATCH), and
      each seat's `diff` vs its in-container `AGENTS.md.prev-20260825` backup shows ONLY §0k changed
      with the section count unchanged. Applied as the §0k step alone, not `wire`. Fleet healthy
      after: `doorman.service` + all six `nemoclaw-agent-sN.service` running, container uptimes
      unchanged, `nudge-runner.timer` waiting. **Found and fixed a live defect en route:**
      `/usr/local/sbin/bootstrap-box.sh`, the copy the recycler runs, was at 2026-08-15 — predating
      §0k — so any sandbox recycled since 2026-08-23 would have come back with no office-questions
      doctrine at all. Three live copies updated to `203d9ae2c05b103cb378092fc27ce4ed`, each with a
      `.prev-20260825` backup.
- [ ] Watch one real answer produce a follow-up in the technician's own chat. STILL OWED — needs a
      real technician answering a real question; cannot be manufactured.
- [ ] Judge whether the follow-up reads as the assistant's own curiosity rather than the office
      chasing, and whether it correctly skips what the person already covered. If the agent does
      not follow up at all, record the observation rather than tightening the wording immediately —
      that is the discipline question the observation pass exists to answer.

---
*Pause after this phase — its Manual verification list is non-empty.*
