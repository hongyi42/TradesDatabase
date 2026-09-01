---
date: 2026-09-01
task: "Build 6 — intent verbs + the doctrine: escalate is deleted, the rails stop enforcing a lifecycle, pacing gets a release, citation widens to what was looked up, and stuck becomes visible"
research: thoughts/shared/research/2026-08-31-intent-verbs-and-the-doctrine.md
status: draft
supersedes: nothing
---

Overturns no *document*, but reverses two shipped decisions and one made earlier today:

1. Build 5's escalate-is-terminal (`thoughts/shared/plans/2026-08-31-the-sweep-stops-deciding.md`,
   its user ruling 3). That plan's clocks/alarms/moot work stands, so it is not retired.
2. **This plan's own first draft** (2026-09-01, committed `780416d`), whose Phase 1 *reworked*
   escalate into `ask(manager)`. The user then ruled escalate should be **deleted** outright and
   replaced later by a generalized `send`. Phase 1 is now a deletion, and is smaller than the
   rework it replaces.

## Overview

The planner speaks nine verbs, and code decides which are *legal* on which row at which stage. That
legality table is our model of a gap's life; the charter (§6a row 6) is that the list should be a
**suggestion, not a state machine**. Verb names are kept — renaming was rejected on cost and would
change no refusal — with one exception: `escalate` is removed entirely, because it is not a verb
about a gap so much as a stage in a story about how a gap ends.

What lands: escalate dies, pacing gains a pause **and a release**, the refusals protecting only our
lifecycle story are deleted, the planner may cite what it looked up, and the delivery ledgers it is
asked to judge without become visible.

Base: `main` @ `a80f8d1`. All line numbers were re-verified against `main` after an adversarial
review found the first draft's *apply-half* citations stale by ~160 lines.

## Decisions

- **`escalate` is DELETED** — USER 2026-09-01, superseding the same day's earlier
  "escalate = ask(manager)" ruling. Reasons recorded: it is the most lifecycle-shaped verb in the
  vocabulary (`WHEN TO GIVE UP` is literally a stage), reworking it would be thrown away when the
  generalized `send` arrives, and deleting it is strictly less work than the rework.
- **No migration, and the metric views are left alone.** `mv_escalation_fates` and `mv_gap_outcomes`
  key on `n.status = 'escalated'` (`20260824020000:30-40,69`). With nothing writing that status
  they degrade to **historic-only**, which is the correct reading — those escalations really did
  happen. Repairing them would have been the first draft's work; deleting the verb makes it moot.
- **Historic `escalate` decisions must keep counting as attention.** `attentionActions =
  new Set([...PLANNER_JUDGMENT_ACTIONS, 'extend'])` (`watchers.ts:756`) — add `'escalate'` to that
  historic set, or a gap escalated last week suddenly reads as neglected. Same precedent `extend`
  set when build 5 retired it.
- **The planner temporarily cannot reach a manager.** Accepted: nothing is deployed, evaluation is
  an end phase, and the replacement is build 6.5. The doctrine must state what exists rather than
  promise what is coming — no dead text about a future verb.
- **BUILD 6.5 (next, before 7) — a generalized `send`.** One verb reaching anyone (person or role,
  their chat or their assistant), not pinned to a gap. Today **every decision must name a gap**
  (`required: ['nudgeId','action','confidence','reason']`, `plannerPrompt.ts:409`), so a gap-less
  message has no slot in the decision shape — that is 6.5's real work, not the verb.
  Build 6 must not foreclose it; Phase 3 only deletes rails, which can only widen expressiveness.
- **Loosen the rails; do NOT rename the verbs** — USER 2026-09-01. The build's content is the
  classification in Phase 3.
- **RIDER, STILL NOT RATIFIED — veto at plan review:** split `leave` into `leave` (waiting) and
  `note` (not acting, here is why), because the alarms read these strings to judge neglect. **If
  vetoed, drop Phase 3 step R only.**
- **Pause an asked gap, and release it** — USER 2026-09-01 (the release half is the user's
  addition). Release is `hold` with `notBefore: null`, not a tenth verb. Three things the first
  draft got wrong and this one fixes: the apply call site passes `['pending']` explicitly, the tool
  schema types `notBefore` as a plain string so the model is never told a release exists, and
  `asksUnattended` has **no** hold exemption today.
- **The planner may cite what it looked up** — USER 2026-09-01. Kills "READING IS NOT CITING". **The
  stamp gate STAYS:** `TECHNICIAN_SPOKEN_CHANNELS` (`planner.ts:807-811`) gates only
  `answered_by_capture_id` — which *is* `mv_gap_outcomes.closed_by_technician` — never what is
  shown. Email-derived evidence landing after the ask is already shown and citable; the blocked case
  is what `spine_read` returns.
- **A looked-up citation stamps NO capture id** — implementation call. A `spine_read` row has no
  channel gate; stamping it would let a customer's words define `closed_by_technician`.
- **Phase 4 requires a `toolLoop.ts` change.** The executor receives `raw: unknown`
  (`toolLoop.ts:610`); the string the model is shown is built by the module-private
  `stringifyResult` at `:620` and pushed to `calls` at `:622`. Citing "what was shown" needs the
  loop to hand results back, not the planner to re-stringify.
- **Frozen becomes a printed fact, not a status** — USER 2026-09-01. No schema change.
- **`open_gap` moves whole to build 7** — USER 2026-09-01. A verb that can only refuse is dead text.
- **`review_items` needs no action here** — USER 2026-09-01 ("realistically it should contain the
  confirmation sessions"). Its two gap kinds stop being written the moment escalate dies; its four
  dead-end kinds and two reminders leave in build 7 when detectors stop minting. The table empties
  itself; renaming it (and `list_pending_reviews`/`resolve_review`, which will only be able to
  *dismiss* once staged actions are all that remain) is a cleanup after 7.
- **The doctrine is rewritten last, against the current prompt** — the 2026-08-28 draft predates
  builds 3–5.5, so it is a source of intent, never a diff base.
- **BUILD 8 — does this foreclose multi-technician visits? No.** Phases 1, 2, 5 touch verbs and view
  text, never a gap's subject. Phase 3 *deletes* rails. Phase 4's citation is job-scoped and a job
  is already shared by a crew. The seven group rails keying on `technician_id` are KEPT — but as
  *delivery* facts, and Phase 3 rewords their copy so build 8 inherits no one-person-per-gap premise.

## Plain-language walkthrough

Today the planner picks a verb and code checks whether it is *allowed here*. Sometimes that protects
something real — "that would text the wrong customer". Sometimes it only enforces our invented story
about how a gap goes. This build separates the two.

```
BEFORE                                  AFTER
 verb ─► is it LEGAL at this stage?      verb ─► would this break something REAL?
           │                                        │
      legal│illegal ─► refused,               no ───┴─── yes ─► refused (and tested)
           ▼           gap untouched          ▼
      do the write                        do the write
```

**Phase 1 — escalate is removed.** Escalating hands a gap to a manager and strikes it off the
planner's list. It's being replaced later by one general "send a message to anyone" verb, so rather
than rework it now and throw that away, it goes. Nothing is deployed, so the gap this leaves — the
planner can't reach a manager until 6.5 — costs nothing. You'd notice it working because the verb
simply isn't offered any more, and old escalations still read correctly in the history.

**Phase 2 — pause a question, and un-pause it.** If Judy was asked this morning and is on a big
install, the planner should be able to say "give her until Thursday". Today it can't; the only
option is saying "doing nothing" every 30 minutes forever. It also gains the opposite: lifting a
pause early. Three separate things currently prevent this from working, all fixed here — including
that the neglect alarm doesn't know a paused question is paused, so it would keep firing.

**Phase 3 — the make-believe refusals get deleted.** The careful part. Every refusal is examined and
labelled. Ones protecting a real person or the data are kept *and pinned with a test*. Ones
enforcing only our lifecycle story go.

**Phase 4 — quote what you went and looked up.** To close a gap the planner must quote its evidence,
but may only quote the few notes printed in its briefing. If it looks something up and finds the
answer there, the quote is rejected and the close fails. This keeps the honesty rule — quote only
what you actually saw — while widening "saw" to what the lookups returned that same tick.

**Phase 5 — stuck becomes visible, and the doctrine is rewritten.** An undeliverable message
freezes: never sent, never retried, still labelled "queued". The planner is told "if it's sat for
hours, delivery is broken" but never shown the counters. It gets shown them. Then the instruction
sheet is rewritten to describe what phases 1–4 built.

## Secrets & env preflight

- **Phases 1–5:** none. No new external service. `already required` only: local-stack keys via
  `.env.test`; `OPENROUTER_API_KEY` for the key-gated live eval runner, which gates no phase here.

---

## Phase 1: escalate is deleted

### What this phase does
Removes the verb, its rails, its apply case, its writer, and its doctrine. Nothing replaces it in
this build. Historic rows and the metric views that read them are deliberately untouched.

### Changes required

**`src/teamLead/planner.ts`**
- `PLANNER_ACTIONS` (`:101-111`): remove `'escalate'` → eight verbs.
- Delete the validate rails: escalate-on-`noticed` (`:1442-1451`), escalate-without-jobId
  (`:1453-1461`), and the `handoffNote` rail (`:1781-1787`).
- Delete `applyDecision` case `'escalate'` (`:2150-2210`) in full, including the `flagNudge` call,
  the `findOpenItem` settled-subject refusal, and the `markOutcome(…, 'escalated', …)` write.
- Delete the `itemOpened` gate on the once-only manager push (`:2786-2805` region).
- Remove `handoffNote` and `agentContext` from `PlannerDecision` and from the `cleanPlannerText`
  pass at `:1772-1775` — escalate was their only consumer (verify before deleting).

**`src/teamLead/plannerPrompt.ts`**
- Remove `'escalate'` from the `submit_plan` enum (`:319`) and drop the `handoffNote`/`agentContext`
  properties from the schema.
- Delete escalate's verb line (`:50-52`), the whole `WHEN TO GIVE UP` section (`:210-219`), and
  every escalate mention in the state lines (`:88-104`).

**`src/jobs/watchers.ts`**
- Remove `'escalate'` from `PLANNER_JUDGMENT_ACTIONS` (`:137-150`).
- **Add `'escalate'` to `attentionActions`** (`:756`), joining `'extend'`. Without this a gap the
  planner escalated last week reads as neglected the moment this ships.

**`src/db/reviewItems.ts`** — delete `flagNudgeGap` (`:145-197`); the planner is its only caller
(verify). KEEP `listEverFlaggedSubjectRefs` — the detectors' fresh-filter reads historic rows.

**No migration.** The DB CHECK stays a superset so historic `'escalate'` rows keep validating, and
both metric views degrade to historic-only, which is the honest reading.

### Tests this phase BREAKS and must update
- `planner.test.ts:1545-1574` — asserts the exact `markOutcome('escalated', …)` call.
- `planner.test.ts:1578-1593` — asserts `markOutcome` was called on the open-item path.
- `planner.test.ts:4048-4080` — the escalate half of "close and escalate on an observation are
  refused"; the close half moves to Phase 3.
- `plannerSim.test.ts:534-544` — asserts 2 ticks and `status === 'escalated'`.
- `plannerSim.ts`'s `manager_resolve` step (`:950-977`) still manipulates `review_items` directly,
  so it runs — but it now tests nothing the planner can produce. Mark it dead or delete it.
- **`plannerCorpus.ts`: 24 real escalate expectations** (`action:'escalate'` ×10,
  `actionNot:'escalate'` ×14) become unsatisfiable. Unlike the `extend` occurrences — which are
  seed data, not expectations, correcting a miscount in the research — **these are inside `expect`
  blocks**. `npm test` stays green (`plannerCorpus.test.ts` checks only shape/monotonicity/
  seedability); they are graded solely by the key-gated live runner. Document the re-grade;
  do not attempt it here.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] `escalate` is refused as an unknown action; the three pinned equalities still agree at eight
      verbs.
- [ ] A stored historic `escalate` decision still counts as attention (no new `asksUnattended`).
- [ ] `mv_escalation_fates` still returns pre-existing escalations.
- [ ] No caller of `flagNudgeGap` remains; `listEverFlaggedSubjectRefs` still returns historic refs.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack (`npx supabase start`, `.env.test`). No MCP needed.
- [ ] Drive a `runPlanner` tick on a seeded firm with an escalate in its history: confirm the tick
      applies, the history line still renders the old `escalate`, and no alarm fires for it.

### Manual verification
- [ ] None.

---

## Phase 2: pacing — pause an asked gap, and release it

### What this phase does
`hold` becomes legal on `queued` and `asked`, and gains a release form. Four things must change
together or the phase is a silent no-op.

### Changes required

**`src/teamLead/planner.ts`**
- The shared `send || hold` stage rail (`:1515-1527`): narrow to `action === 'send'`. Send keeps its
  pending/noticed-only rail — world-protecting (a re-send on an asked row is a silent no-op observed
  live 2026-08-20, and `uq_nudges_subject_ever` forbids a second ask structurally).
- **`applyDecision` case `'hold'` is at `:2113-2124`** (not `:1957-1964`) and passes `['pending']`
  **explicitly** at `:2123`. Widen it to `OPEN_NUDGE_STATUSES`. Without this edit a hold on a
  queued/asked row matches no row, `done(null)` records *refused — "the gap changed state between
  the plan and the write"*, and the whole phase does nothing.
- `hold` validate (`:1737-1750`): accept explicit `notBefore: null` as RELEASE. Keep "hold until a
  moment that has already passed" (`:1744`) for non-null values. Note the built object is
  `...(notBefore ? { notBefore } : {})` (`:1797`), so a release drops the key and only clears
  because apply does `d.notBefore ?? null` — **pin that coupling with a test**, it is accidental.
- The `noticed` branch (`:2117-2120`) already routes to `setObservation` with `['open']`; recover's
  clear-to-null precedent is at **`:2138-2149`**.

**`src/teamLead/plannerPrompt.ts`**
- **`SUBMIT_PLAN_TOOL`'s `notBefore` property (`:337-342`) is `type: 'string'`**, described
  "Required for hold, ignored otherwise" — the model is never told a release exists. Change to
  `['string','null']` and say a null/omitted `notBefore` on `hold` RELEASES an existing hold.
  (`coerceBySchema`, `forcedTool.ts:210-248`, passes null through and no transport sets `strict`,
  so the wire already carries it — nothing asks for it.)
- `hold`'s verb line (`:48`): works at any stage; omitting the date releases it. State lines:
  `queued`/`asked` gain hold.

**`src/jobs/watchers.ts`**
- **`askCandidates` (`:728-733`) has NO `not_before` filter** — only `deliveryStuckRows` (`:714`)
  and `staleCandidates` (`:737`) use `heldPast` (`:706-707`). Add `!heldPast(n.not_before)` to
  `askCandidates`, or a paused question keeps reading as neglect.

### Tests this phase BREAKS
- `planner.test.ts:1223-1229` — "hold on an already-asked gap is refused too".

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] hold+future date on an `asked` row **writes `not_before` and records `applied`** (this is the
      assertion that catches the `['pending']` bug — an outcome-only check would not).
- [ ] `notBefore: null` on a held `asked` row clears it; hold on `queued` works; an already-passed
      date is still refused; `send` on an `asked` row is still refused.
- [ ] A held asked gap is exempt from `asksUnattended` and re-enters it once released.
- [ ] The schema advertises a nullable `notBefore`.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [ ] Hold-then-release an asked gap through `runPlanner`; read `not_before` back via `psql` at both
      steps (set, then null), and confirm both decisions recorded `applied`.

### Manual verification
- [ ] None.

---

## Phase 3: the rails get classified

### What this phase does
Every refusal in `validateDecisions` is labelled **world-protecting** (kept, pinned by a test naming
*what in the world* it protects) or **lifecycle-protecting** (deleted). This is the charter and the
build's main risk: a world rail deleted by accident is how a real person gets a wrong message.

### Changes required

**`src/teamLead/planner.ts`** — the enumeration, exhaustive and line-verified on `main`. Escalate's
three rails are already gone (Phase 1) and are not listed.

*KEEP — world-protecting:*
- `:1329` entry is not a decision object · `:1379` gap not in this plan · `:1369,1383` a second
  decision for the same gap · `:1387` unknown action — integrity of the decision set.
- `:1509` send with nobody to ask — a queued row with no addressee freezes forever.
- `:1515` **send** on a non-pending/noticed row (see Phase 2).
- `:1550, 1566, 1577, 1582, 1587, 1601, 1610` — the group block's **seven** pushes. **Reword the
  copy** (build 8): they protect *delivery* — one message is anchored to one job and lands in one
  chat — not a claim that a gap has one person. The one-stage-per-group rail (`:1601`) prevents a
  23505 that freezes a partial group.
- `:1670-1726` the close rails — record-basis authorisation, citation length, citation-must-appear,
  one-quote-one-gap. Phase 4 widens *where* a quote may come from and changes none of them.
- `:1359` recover on a non-dismissed gap · `:1472` office verbs with no addressee · `:1484` office
  verbs with no usable `agentMessage` · `:1740` hold without a usable `notBefore` (Phase 2 rewrites
  it to admit an explicit null) · `:1744` hold until a passed moment.

*DELETE — lifecycle-protecting:*
1. `:1413-1420` **close on an observation.** Apply path — the existing `case 'close'`
   (`:2251-2283`) calls `markOutcome` with the default `OPEN_NUDGE_STATUSES`, which matches no
   `nudges` row for an observation id and would silently record `refused`. It must be
   **stage-forked**: on `noticed`, call `setObservationStatus(id, tenantId, {status:'dismissed',
   dismissReason: <citation>, dismissedAt: nowIso}, ['open'])` — `setObservationStatus` has **no
   default `fromStatuses`** and throws on an empty array (`observations.ts:131-141,155-157`) — and
   skip `stampAnswer` (`:2275-2281`). Record that this is a **translation**, the one this build
   accepts, because the alternative is refusing a correct judgment.
2. `:1636-1643` **leave on a pending gap.** The stated reason ("leave would let it drift") is a
   lifecycle claim; build 5 removed every clock that made drift matter, and `deliveryStuck` watches
   pending rows regardless.
3. The `hold` half of `:1515` — handled in Phase 2.

*KEEP DESPITE LOOKING LIFECYCLE — and record why:*
- `:1395-1401` **dismiss on a non-observation.** Deleting it would produce an applied decision that
  writes nothing: `dismiss` calls `setObservationStatus`, which has no nudges equivalent — the exact
  silent no-op these rails prevent. A **missing write path**, not our lifecycle story; minting one
  is build 7's `open_gap`-shaped work. Reword the copy to say so.

**Copy that contradicts change (1) and must move with it:** `buildGapView` prints "Nothing needs
asking: dismiss this observation" on both THE RECORD forks (`planner.ts:954-961`, `:963-973`), and
the doctrine repeats it at `plannerPrompt.ts:119-121`. All three are `toContain`-pinned.

*RIDER (veto-able, step R):* split `leave`. Add `note` to `PLANNER_ACTIONS` (`:101-111`), the
`submit_plan` enum (`plannerPrompt.ts:319`), `PLANNER_JUDGMENT_ACTIONS` (`watchers.ts:137-150`), **an
`applyDecision` case** (a `leave`-style `return {outcome:'applied'}` — the switch's non-nullable
return type makes the omission a typecheck failure), and a **5th** `nudge_decisions_action_check`
amendment (superset; the new migration must sort after `20260901160000`). Only `note` joins `leave`
in `mv_whiplash`'s exclusion (`20260824020000:81`).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] One test per KEPT rail, its title naming the harm it prevents.
- [ ] close on an observation records **`applied`** and writes `dismissed` with the citation as
      `dismiss_reason` (an outcome check, not just a no-throw); leave on a pending gap is accepted.
- [ ] The pinned equalities hold at eight verbs: enum == `PLANNER_ACTIONS`
      (`planner.test.ts:3147-3158`) and `PLANNER_JUDGMENT_ACTIONS` (`watchers.test.ts:1142-1146`),
      plus a **fourth** check that every `PLANNER_ACTIONS` member is in the DB CHECK list.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [ ] Drive `runPlanner` with one deleted-rail action (close on an observation) and one kept-rail
      violation (a group spanning two people); read back that the first applied and wrote the
      observation row, and the second was refused with the refusal recorded.

### Manual verification
- [ ] **Judgment call:** read the final KEEP/DELETE table and confirm no kept rail is lifecycle and
      no deleted rail is world. The one genuinely human check in this build.

---

## Phase 4: the planner may cite what it looked up

### What this phase does
Tool results from the current tick become citable. The honesty rail's shape is unchanged — a quote
must appear in text the model was shown — but "shown" widens from the ~6 pushed evidence lines to
what the turn's tool calls returned.

### Changes required

**`src/model/toolLoop.ts`** — a change IS required. The executor is called at `:610` and receives
`raw: unknown`; the string the model actually sees is built by the module-private `stringifyResult`
(`:486-495`, truncated at `MAX_TOOL_RESULT_CHARS = 20_000`, `:75`) at `:620` and pushed to `calls`
at `:622`. Two options — **recommended: (a)** add an optional `onResult?: (call: ToolLoopCall) =>
void` hook invoked right after `:622`, so the caller receives exactly the shown string. *(b)* export
`stringifyResult`. (a) hands over the real artefact rather than a recipe for reproducing it.
- **Known limit, document it:** if the model emits `submit_plan` in the same assistant turn as a
  `spine_read`, the loop returns at `:627-629` and that read never executes. Reads must precede the
  submitting turn — say so in the doctrine (Phase 5).

**`src/teamLead/planner.ts`**
- Accumulate shown results via the new hook into a closure array, the way `views` is hoisted for the
  catch (**`:2396`**, not `:2407`). The `runLoop` call is `:2784-2840`; the executor is
  **`:2807-2838`**.
- `validateDecisions` (`:1301`) sees only `views`; add an optional `readText: string[]`.
- Citation check (`:1712` region): haystack becomes evidence ∪ `readText`, same normalized substring
  match. Keep the ≥12-char/≥2-word floor (`:1698`) and one-quote-one-gap (`:1726`).
- **Attribution:** a citation matching only `readText` leaves `answeredByCaptureId` null. Comment
  why. `TECHNICIAN_SPOKEN_CHANNELS` (`:807-811`) untouched.

**`src/teamLead/plannerPrompt.ts`** (`:285`) and **`src/mcp/server.ts`** catalog rule (5)
(`:801-802`) — the two co-located texts. Both become: you may quote anything you read THIS tick; you
may not quote what you did not read. Update the doctrine pin at **`planner.test.ts:2941`** (the
doctrine-pin family is `:2920-2991`) to the new **contiguous single-line** phrase — a phrase
spanning a line break inside the joined array will not match. Catalog rule (5) has **no** test pin;
`SPINE_VIEW_CATALOG` is shared by `query_spine` (`server.ts:1318`) and `spine_read` (`:1818`), so
the edit lands in both descriptions and cold-writes both prompt caches.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] A close citing a `spine_read` result from this tick is ACCEPTED and stamps no capture id; a
      close citing text from nowhere is still REFUSED; a close citing a pushed evidence line still
      stamps its capture id; **a quote from beyond the 20,000-char truncation point is REFUSED**
      (this test is what proves the hook hands over the truncated string, not the raw object).

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [ ] Seed a gap whose answer exists only in a record the briefing does not print; drive
      `runPlanner`; read back that it closed with `basis='evidence'`, `answered_by_capture_id IS
      NULL`, and a `nudge_decisions` row carrying the citation.

### Manual verification
- [ ] None.

---

## Phase 5: stuck becomes visible, and the doctrine is rewritten

### What this phase does
Prints the delivery ledgers the planner is asked to judge without, then rewrites `PLANNER_SYSTEM` to
describe what phases 1–4 built. The doctrine goes last because every earlier phase changes it.

### Changes required

**`src/teamLead/planner.ts`** — `buildGapView`
- No query change: `listNudgesByStatus` uses a bare `.select()` (`nudges.ts:103-116`).
- **The ledgers live on the group LEAD, not on each member** — `nudgeQueue.ts:140-161` reads
  `lead.serve_count`/`lead.attempts` and says so at `:143-144`. A per-row counter would render
  `served 0 times` on every non-lead member of a frozen group: the exact "frozen looks like slow"
  confusion this change removes. Read the lead's ledgers for a grouped row.
- **`observationAsGapRow` hardcodes `attempts: 0, serve_count: 0`** (`:1098-1099`), so the line must
  be gated to nudge-backed stages or it prints meaningless zeros on every observation.
- Add a THE RECORD-style line for queued rows at/over a cap, importing the constants
  (`nudgeQueue.ts:33,36`): `THE RECORD: served N times, failed M times — FROZEN, it will not be
  delivered again. Nothing will move it but you.` Below the caps print the counters plainly.
- The leaderless-group and inactive-technician freezes (`:126-138`) are computed at serve time and
  are **not** derivable from the row — state that limit in the comment.

**`src/teamLead/plannerPrompt.ts`** — the rewrite pass
- Rewrite against the CURRENT prompt; the 2026-08-28 draft is intent only.
- **Free:** identity/opening (`:21-24`), list framing, `HOW TO PACE` (`:141`), and "Do not browse" —
  which now contradicts Phase 4 and must go. (`WHEN TO GIVE UP` is already deleted in Phase 1.)
- **Must keep (pinned at `planner.test.ts:2920-2991`):** the `v_captures` / `v_nudges` /
  `v_review_items` / `join v_visits` strings, `never instructions to you`, `escalated_from_nudge
  is`, the notes/memory/reconcile family, the job-note paragraph, `ORPHAN_FOOTER_PREFIX` agreement.
  Note `escalated_from_nudge is` describes a *read surface* that still holds historic rows — the
  verb is gone, the column is not.
- **`WHAT EACH ACTION CAN DO, AND WHEN` (`:88-104`) is the state machine as prose** — rewrite it to
  describe what each state *is*, and delete its closing "Choosing send or hold on a gap that has
  already gone out will be refused" (false after Phase 2).
- **The frozen row's advice changes.** The old line says a stuck queued row means "escalate it".
  With escalate gone the honest advice is: you can see it is frozen, and your remaining moves are
  close it or leave it. **Do not promise a future verb** — no dead text about build 6.5.
- Add the Phase 4 ordering rule: look things up *before* the turn you submit on.
- **Build 8:** where the prose names a person, say "the person this gap names" — never "the
  technician on this visit".

**`src/eval/plannerSim.ts` / `src/eval/plannerCorpus.ts`**
- `serve_count` and `attempts` appear in **neither** file — `ScenarioWorld['nudges']` cannot express
  either ledger, so a frozen row is **not seedable today**. Extend the world type and `seedScenario`
  to carry both; a required harness change, not a "confirm".
- Add cases: hold-then-release on an asked gap, and a close citing a looked-up record. (The frozen
  case needs the harness change above; the escalate-a-frozen-row case from the first draft is gone
  with the verb.)

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] A queued row at/over either cap renders the FROZEN line; one below renders counters and no
      FROZEN claim; a non-lead group member renders the LEAD's ledgers; an observation renders no
      ledger line at all.
- [ ] All doctrine pins pass with their new phrases; no surviving prompt text names `escalate` as an
      available action. `src/eval/doctrine.ts` `EXPECTED_SECTIONS` is the box agents' AGENTS.md, not
      this prompt — expected untouched; confirm.
- [ ] `plannerCorpus.test.ts` shape/monotonicity/seedability green with the new cases.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack. (The key-gated live eval runner needs `OPENROUTER_API_KEY`
  and gates nothing here.)
- [ ] Drive one `runPlanner` tick against a seeded firm containing a frozen queued row; capture the
      rendered `userPrompt` and confirm the FROZEN line appears with real counters.

### Manual verification
- [ ] **Judgment call:** read the rewritten `PLANNER_SYSTEM` end to end — it should read as one
      document, not five phases of patches, and nothing in it should still describe a rail or a verb
      that no longer exists.

---

## Closing the build (all phases done)

- [ ] `npm run decisions:index`, commit the regenerated `thoughts/INDEX.md` and the
      `docs/engineering-memory.md` map alongside the code (CLAUDE.md standing rule).
- [ ] Add the §6a build-6 entry recording: escalate's deletion, the KEEP/DELETE rail table, the
      24 orphaned corpus expectations, and the `leave`/`note` outcome.
- [ ] Add §6a build 6.5 (the generalized `send`) between 6 and 7, with its hard dep `6.5 < 7`.
- [ ] Flip this plan's `status:` to `complete`.
