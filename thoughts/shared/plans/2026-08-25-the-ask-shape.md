---
date: 2026-08-25
task: the ask shape — one message may cover several gaps, the answer keeps its link, and the seat agent can follow up
research: thoughts/shared/research/2026-08-24-the-ask-shape.md
status: draft
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
- **The derived stamp only fires on a capture with a `technician_ref`** (review finding 11).
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
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass
- [ ] the seven new planner.test.ts cases pass
- [ ] existing `src/db/nudges.test.ts` first-write-wins cases still pass (record-time path untouched)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack running.
- [ ] none beyond the suite — no model call and no new external surface.

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
  Emit ONE item per group; the lead is the member whose `id === ask_group_id`, falling back to the
  first row when no member matches (a group whose lead was expired out). Liveness skip, the
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
- [ ] `npx supabase migration up` applies on the local stack, then **`npm run gen:types:local`**
      (never `gen:types` — see preflight) and `src/db/database.types.ts` shows `ask_group_id`
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass
- [ ] the new nudgeQueue / nudges / watchers cases pass
- [ ] `select column_name from information_schema.columns where table_name='nudges'` shows
      `ask_group_id` (never `list_migrations` — the pilot's ledger lies)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; `psql` against it.
- [ ] Seed three pending gaps on one job, group them with `markNudgeGroupQueued`, run
      `buildNudgeDelivery`: exactly one item, `directMessageB64` decoding to the grouped text,
      item id equal to the lead. Report one `'delivered'`; confirm all three read `status='asked'`
      with identical `asked_at`. Capture before/after row states.

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
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass
- [ ] the eight new planner.test.ts cases pass
- [ ] `MG-09` runs in the simulator without harness error (`npm test -- plannerSim`)
- [ ] the existing planner and `plannerEvalGraders` suites pass unchanged — the single-send path
      must be byte-identical

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; `ANTHROPIC_API_KEY` in `.env`.
- [ ] Seed one tenant, two pending gaps, one job, one technician; run `runPlanner` live; read back
      via a second client. If grouped: one `ask_group_id` equal to the lead's id, shared by both,
      one `question`. If not: two ordinary queued rows. EITHER passes — the phase ships the verb,
      not the policy. Capture the decision rows and nudge rows; delete the scratch tenant after.

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
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass
- [ ] the six new server.test.ts cases pass
- [ ] `src/mcp/server.test.ts`'s 14-tool count assertions (:175, :2309) still pass — no tool added
- [ ] `md5 Box_Setup_Stuff/bootstrap-box.sh` recorded before any fleet refresh (copy-drift trap)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; MCP server reachable with a technician badge.
- [ ] Call `record_field_note` with a badge holding two asked gaps on one job; confirm the result
      carries `openQuestions` with both, and that a grouped pair yields one deduped entry. Capture
      the full tool result.

### Manual verification
- [ ] Refresh §0k on **s2 first** (the canary seat), then the fleet; watch one real answer produce
      a follow-up in the technician's own chat. User-gated — six live seats.
- [ ] Judge whether the follow-up reads as the assistant's own curiosity rather than the office
      chasing, and whether it correctly skips what the person already covered. If the agent does
      not follow up at all, record the observation rather than tightening the wording immediately —
      that is the discipline question the observation pass exists to answer.

---
*Pause after this phase — its Manual verification list is non-empty.*
