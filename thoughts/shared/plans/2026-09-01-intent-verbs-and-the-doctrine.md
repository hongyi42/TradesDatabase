---
date: 2026-09-01
task: "Build 6 — intent verbs + the doctrine: escalate and leave are deleted, dismiss/recover reach every stage, hold gains a release, citation widens to what was looked up, and stuck becomes visible"
research: thoughts/shared/research/2026-08-31-intent-verbs-and-the-doctrine.md
status: draft
supersedes: nothing
---

Overturns no *document*, but reverses two shipped decisions and two made earlier today:

1. Build 5's escalate-is-terminal (`thoughts/shared/plans/2026-08-31-the-sweep-stops-deciding.md`,
   its user ruling 3). That plan's clocks/alarms/moot work stands, so it is not retired.
2. Build 4's dismiss-is-observation-only (`thoughts/shared/plans/2026-08-31-a-gap-is-not-an-ask.md`).
   Its object split (observation ≠ ask) stands; only the verb's reach widens.
3. **This plan's own earlier drafts** (`780416d`, `18f8196`): the first reworked escalate into
   `ask(manager)`, the second deleted it but kept `leave` and proposed a `note` verb. The user then
   ruled: delete `leave` too, extend `dismiss`/`recover` to every stage, `recover` restores
   `prior_status`, and `note` was never needed — every decision already carries a `reason`, and a
   thought without an action is `write_job_note`.

## Overview

The planner speaks nine verbs, and code decides which are *legal* on which row at which stage. That
legality table is our model of a gap's life; the charter (§6a row 6) is that the list should be a
**suggestion, not a state machine**. This build ends with **seven** verbs, every one of which
changes the record — the two that described a stage in a story (`escalate`) or the planner's state
of mind (`leave`) are gone, and the planner has full lifecycle control of every gap regardless of
stage.

```
today (9)                              after build 6 (7)
 send  hold  close  escalate  leave     send  hold  close
 dismiss  recover                       dismiss  recover        ← now ANY stage
 ask_agent  inform_agent                ask_agent  inform_agent ← 6.5 collapses these + send
```

Base: `main` @ `a80f8d1`. All line numbers were re-verified against `main` after an adversarial
review found an earlier draft's *apply-half* citations stale by ~160 lines.

## Decisions

- **`escalate` is DELETED** — USER 2026-09-01. It is the most lifecycle-shaped verb in the
  vocabulary (`WHEN TO GIVE UP` is literally a stage), reworking it would be discarded when the
  generalized `send` (build 6.5) arrives, and deleting is strictly less work. **No migration:** the
  DB CHECK stays a superset and `mv_escalation_fates`/`mv_gap_outcomes` (`20260824020000:30-40,69`)
  degrade to historic-only, which is the honest reading. The planner temporarily cannot reach a
  manager — accepted; nothing is deployed and evaluation is an end phase.
- **`leave` is DELETED** — USER 2026-09-01. Every other verb changes the record; `leave` changes
  the planner's state of mind and writes nothing (`planner.ts:2241-2250`). Once `hold` works on any
  stage and `dismiss` does too, every legitimate "do nothing" has a verb that acts: waiting →
  `hold(date)`, not pursuing → `dismiss`, done → `close`, nothing to say → silence (already recorded
  as `unmentioned`). It dies in Phase 2, in the same phase as its replacement.
- **No `note` verb.** Every decision already requires a `reason` (`plannerPrompt.ts:409`); a thought
  with no action is `write_job_note`, already on the surface (`identity.ts:53-54`). An earlier draft
  proposed `note` on the theory that `leave` was doing two jobs; it was doing one, badly.
- **`dismiss` and `recover` reach every stage** — USER 2026-09-01 ("it should have full control on
  its gaps"). Reverses build 4's observation-only scope. The write path exists (`markNudgeOutcome`,
  `nudges.ts:371`, any open status). Without this, deleting `escalate` leaves an asked gap that
  nobody will answer and whose record never fills with **no ending at all** — `close` needs a
  code-computed fact or an evidence quote (`planner.ts:1668-1671`).
  - *Decided at implementation:* `dismissNudge` reads the status then guards the UPDATE on that
    exact value, rather than the plan's preferred single-statement column copy — PostgREST cannot
    express `prior_status = status` in an update payload. The GUARD, not the read, is what makes it
    race-free. Cost, now stated in the accessor: a benign forward transition (a delivery ack moving
    queued→asked) also loses and reports "the gap changed state".
  - *Found in review, fixed:* **`recoverNudge` did not clear `not_before`** while the fork's own
    comment said it did — so a recovered question could come back wearing a stale far-future hold
    and, since Phase 2, be exempt from `asksUnattended`, the only alarm on an asked gap.
  - *Found in review, fixed:* the dismissed-id loops **overwrote stage labels set by the open
    reads**. A same-id collision (an observation whose 'asked' stamp failed, beside its own nudge)
    would have keyed every decision and tick mark for the OPEN observation to `nudge_id` — no FK
    error, so silent and permanent. Both loops now write only when the id is unlabelled.
  - *Found in review, fixed:* the recover fork called `setObservationStatus` unwrapped, and it
    THROWS on any error — so a transient fault on `observations` made every dismissed QUESTION
    unrecoverable until it cleared. It now falls through on a throw as well as on null.
  - *Found in review, fixed:* `dismissNudge` now refuses an already-dismissed row outright. Nothing
    at the database level constrains `prior_status` (the CHECK covers `status` only), so a caller
    passing `['dismissed']` would have stored `prior_status='dismissed'` and made the row
    permanently unrecoverable, silently.
  - *Found in live verification, fixed:* the unrecoverable-row refusal reported the generic
    "the gap changed state between the plan and the write". Nothing raced — and that string is what
    `recall_decisions` shows the planner next tick, so it would send it back to retry a row that can
    never work. It now has its own copy ending "Do not retry this one."
- **The close-on-an-observation TRANSLATION** — the one remapping this build accepts, and worth
  being uneasy about, since everywhere else it refuses rather than remaps. What makes it different:
  on a stage where nobody was asked, "the hole is filled" and "this no longer needs attention" are
  the SAME claim about the record; the close rails do not soften (basis, the ≥12-char/≥2-word floor,
  evidence membership, one-quote-one-gap all still run); only the target table differs. `stampAnswer`
  is skipped because `answered_by_capture_id` is a column on `nudges` and there is no row to stamp.
- **Discovered, not fixed (pre-existing):** `runPlanner` skips a firm with no open gaps BEFORE it
  reads the dismissed sets, so a recover-only tick is unreachable — every recover has to ride along
  with a tick that had other business. True of observations before this build too.
- **`recover` restores `prior_status`** — USER 2026-09-01. A dismissed ask was `pending`, `queued`
  or `asked`; a new nullable `prior_status` column on `nudges` records which, set on dismiss and
  cleared on recover. Observations need none — their prior is always `open`.
- **Historic verbs keep counting as attention.** `attentionActions = new Set([...
  PLANNER_JUDGMENT_ACTIONS, 'extend'])` (`watchers.ts:756`) gains `'escalate'` and `'leave'`, or
  every gap the planner touched with either last week reads as neglected. The existing
  `leaveCounts` branch (leave counts on asks, never on observations) keeps working for historic rows.
- **BUILD 6.5 (next, before 7) — a generalized `send`.** One verb reaching anyone (person or role,
  their chat or their assistant), not pinned to a gap. Today **every decision must name a gap**
  (`required: ['nudgeId',…]`) — that is 6.5's real work. Build 6 must not foreclose it; Phase 3 only
  deletes rails.
- **Loosen the rails; do NOT rename the verbs** — USER 2026-09-01. The classification is Phase 3.
- **Pause an asked gap, and release it** — USER 2026-09-01. Release is `hold` with
  `notBefore: null`. Three things an earlier draft got wrong and this one fixes: the apply call site
  passes `['pending']` explicitly, the tool schema types `notBefore` as a plain string, and
  `asksUnattended` has **no** hold exemption today.
  - *Decided at implementation (Phase 2):* **both an omitted key and an explicit `null` release.**
    The plan said "explicit null" in one bullet and "null/omitted" in another. Both release, because
    providers differ on whether a null-valued key survives serialization and a release that worked
    only one way would be a coin flip. A **present-but-unusable** value ("next Thursday", a number)
    is still refused loudly — that is a model that TRIED to give a date and failed, and it can
    rewrite the decision the same tick.
  - *Decided at implementation:* a hold decision **always carries the `notBefore` key, null
    included**. The plan had a release work by the ABSENCE of the key, clearing the column only
    because apply wrote `d.notBefore ?? null` — a coupling across two files that no type would
    catch if either side moved. Better removed than pinned.
  - *Found in review, fixed:* a release on a gap that was **never held** is refused. Writing null
    over null returns the row and reports `applied` — a silent no-op recorded as a decision, the
    class every rail here exists to prevent (`recover` has the same rail). It also restores the loud
    refusal for the likeliest model error: meaning "hold until Thursday" and dropping the field.
  - *Found in review, fixed:* **a hold on a QUEUED row must not silence the delivery-stuck alarm.**
    `listQueuedNudgesForHost` selects on status alone and never reads `not_before`, so a hold cannot
    pace or recall a queued message — but `deliveryStuckRows` exempted any held row, so it would
    have switched off the operator's only signal that delivery is broken. That exemption was written
    when hold was pending-only and so was unreachable on queued rows; it is now narrowed to
    `pending`. The refusal copy that offered the hold as pacing was corrected too.
  - *Recorded, not fixed:* an **unbounded** hold on an asked row silences `asksUnattended` — the
    only operator-visible watch on an asked gap — for as long as the date says, since a held row is
    filtered out before its decisions are read. Holds have had no ceiling since build 5, deliberately.
    Capping the verb would be code overruling the pacing judgment build 5 handed the planner, so the
    question "does it choose sane horizons?" belongs to the evaluation phase; if the answer is no,
    the fix is a separate held-gap counter, not a cap.
  - *Doc drift, deliberately not fixed:* `20260821180000_nudge_decisions_extend.sql:26` says
    "not_before is null for everything but a hold", which a release makes imprecise. Applied
    migrations are immutable — editing one would diverge from what actually ran.
- **The planner may cite what it looked up** — USER 2026-09-01. **The stamp gate STAYS:**
  `TECHNICIAN_SPOKEN_CHANNELS` (`planner.ts:807-811`) gates only `answered_by_capture_id` — which
  *is* `closed_by_technician` — never what is shown. A looked-up citation stamps **no** capture id.
- **Phase 4 requires a `toolLoop.ts` change.** The executor receives `raw: unknown` (`:610`); the
  shown string is built by the module-private `stringifyResult` at `:620`. The loop must hand
  results back. Done as an `onResult` hook.
  - *Found in live verification, fixed:* **the planner could cite its own writing.** `onResult`
    saw every tool result, and the surface includes two write verbs whose readers hand the text
    straight back — `write_job_note` → `read_job_note` → close on basis `evidence` was ACCEPTED,
    laundering a sentence the planner wrote into `nudges.resolution`, the durable audit line a
    manager reads, under a basis meaning "a person's own words". The haystack is now an ALLOWLIST
    (`CITABLE_TOOLS` = `spine_read`, `get_customer_context`) plus a `call.ok` guard, which also
    keeps a refused `submit_plan`'s error text — it echoes the model's own rejected quote — out.
  - *Accepted residue, recorded not guarded:* `query_spine` requires no FROM clause, so
    `select 'words I made up'` returns quotable text. No allowlist closes that, and no shape check
    would either (`select 'x' from v_jobs limit 1` defeats a require-a-view rule; banning string
    literals bans every legitimate `like '%…%'`). Bounded by: no capture id is stamped, so the
    technician metric is untouched; every query is written to `query_audit` with its SQL, so a
    manufactured citation names itself; and it takes SQL whose only purpose is to fabricate.
  - **THE PLAN'S ORDERING CLAIM WAS BACKWARDS, and so was the doctrine written from it.** The
    terminal-tool early return sits INSIDE the per-call loop, so tools run in the order the model
    lists them: `[spine_read, submit_plan]` WORKS (the read runs, `onResult` fires, the plan
    validates against it) and only `[submit_plan, spine_read]` fails. The doctrine now states the
    true rule — your tools run in the order you list them, and `submit_plan` ends the turn.
- **Frozen becomes a printed fact, not a status** — USER 2026-09-01. No schema change.
  - *Found in review, fixed — a regression this phase introduced.* The line first read
    `served N times, failed M times; still being attempted`, and the doctrine then told the model
    that "still being attempted" is a gap to leave alone. That is FALSE in three reachable states
    the counters cannot tell apart — a leaderless group, an inactive technician, and (commonest) a
    box that is not pulling at all, where `serve_count` simply stays 0 forever. So the phase whose
    purpose is *stuck becomes visible* had deleted the only guidance covering the ordinary stuck
    row (the old bullet said "sat queued for HOURS means delivery is broken") and replaced it with
    an instruction to ignore it. The line now prints AGE plus the two counters and asserts nothing;
    the doctrine teaches all three readings.
  - *Found in review, fixed:* the leaderless freeze IS derivable, and `leadFor` was throwing the
    fact away — for a grouped member, a lead absent from the open read means the lead has ended,
    which is the leaderless freeze with certainty. It collapsed that into the same `null` as
    "not a group member". Now a third case, rendered as its own FROZEN reason.
  - *Found in review, fixed:* the schema and the doctrine headline promised the planner could quote
    "anything you read this tick". `CITABLE_TOOLS` is `spine_read` in practice, so the surfaces
    invited a close the rails refuse. Both now name `spine_read` and say plainly that the planner's
    own notes are not quotable — it may not be the witness to its own conclusion.
  - *Found in review, fixed:* the verb list said a close "MUST quote the words that answered it",
    contradicting basis `record` and all four state bullets. Pre-existing; the one-document pass is
    where it should have been caught.
  - *Found in review, fixed:* the frozen advice omitted `ask_agent`, which is the one verb that
    still reaches the person when their queued message never will.
  - *Found in review, narrowed:* "a frozen question was never asked" is only strictly proved by the
    attempt cap. The serve cap means "served ten times with no ack", and the box writes its
    sent-marker BEFORE reporting — so a delivered message whose acks all failed can reach the cap.
    The doctrine now says "almost certainly nobody ever read it".
- **Corpus honesty (found in review):** the first three build-6 scenarios all passed if the planner
  did NOTHING — the claim graders build their haystack from the last tick's decisions, so silence
  makes every `mustNotClaim` vacuous, and `actionNot` is satisfied by silence too. Rewritten to
  grade `action:` (an APPLIED verb) or `arc.closedBy` (the gap must have ENDED), both of which fail
  on silence. A fourth was added for Phase 4's capability, which had none.
- **`open_gap` moves whole to build 7** — USER 2026-09-01.
- **`review_items` needs no action here** — USER 2026-09-01. Its 2 gap kinds stop being written when
  escalate dies; dead ends and reminders leave in build 7. Cleanup (rename it and
  `list_pending_reviews`/`resolve_review`, which will only be able to *dismiss*) is after 7.
- **The doctrine is rewritten last, against the current prompt** — the 2026-08-28 draft is intent
  only.
- **BUILD 8 — does this foreclose multi-technician visits? No.** No phase touches a gap's subject.
  The seven group rails keying on `technician_id` are KEPT as *delivery* facts, and Phase 3 rewords
  their copy so build 8 inherits no one-person-per-gap premise.

## Plain-language walkthrough

Today the planner picks a verb and code checks whether it is *allowed here*. Sometimes that protects
something real — "that would text the wrong customer". Sometimes it only enforces our invented story
about how a gap goes. This build separates the two, and removes the two verbs that were never about
the record in the first place.

```
BEFORE                                  AFTER
 verb ─► is it LEGAL at this stage?      verb ─► would this break something REAL?
           │                                        │
      legal│illegal ─► refused,               no ───┴─── yes ─► refused (and tested)
           ▼           gap untouched          ▼
      do the write                        do the write
```

**Phase 1 — escalate is removed.** It's being replaced later by one general "send to anyone" verb,
so rather than rework it now and throw that away, it goes. Old escalations still read correctly in
the history.

**Phase 2 — hold replaces leave.** The planner can pause any question ("give Judy until Thursday")
and un-pause it early. That makes `leave` — "I'm doing nothing, here's why" — redundant, so it goes
too. Three separate bugs currently stop pausing from working, all fixed here, including that the
neglect alarm doesn't know a paused question is paused.

**Phase 3 — the make-believe refusals get deleted, and dismiss works everywhere.** Every refusal is
labelled: protects something real (kept, pinned with a test) or protects our story (deleted). And
`dismiss`/`recover`, which today only work on things nobody has been asked about, work on everything
— so a question that will never be answered can finally be dropped, and picked back up.

**Phase 4 — quote what you went and looked up.** The honesty rule stays — quote only what you saw —
but "saw" widens to what the planner's lookups returned that same tick.

**Phase 5 — stuck becomes visible, and the doctrine is rewritten.** The planner is shown the
delivery counters so frozen is distinguishable from slow. Then the instruction sheet is rewritten
to describe what phases 1–4 built.

## Secrets & env preflight

- **Phases 1–5:** none. No new external service. `already required` only: local-stack keys via
  `.env.test`; `OPENROUTER_API_KEY` for the key-gated live eval runner, which gates no phase here.

---

## Phase 1: escalate is deleted

### What this phase does
Removes the verb, its rails, its apply case, its writer, and its doctrine. Historic rows and the
views that read them are untouched.

### Changes required

**`src/teamLead/planner.ts`**
- `PLANNER_ACTIONS` (`:101-111`): remove `'escalate'` → eight verbs.
- Delete the validate rails: escalate-on-`noticed` (`:1442-1451`), escalate-without-jobId
  (`:1453-1461`), the `handoffNote` rail (`:1781-1787`).
- Delete `applyDecision` case `'escalate'` (`:2150-2210`) in full — `flagNudge`, the
  `findOpenItem` refusal, the `markOutcome(…, 'escalated', …)` write.
- Delete the `itemOpened` gate on the once-only manager push (`:2786-2805` region).
- Remove `handoffNote`/`agentContext` from `PlannerDecision` and the `cleanPlannerText` pass at
  `:1772-1775` (verify escalate was their only consumer).

**`src/teamLead/plannerPrompt.ts`** — remove `'escalate'` from the enum (`:319`) and drop the
`handoffNote`/`agentContext` schema properties; delete the verb line (`:50-52`), `WHEN TO GIVE UP`
(`:210-219`), and every escalate mention in the state lines (`:88-104`).

**`src/jobs/watchers.ts`** — remove from `PLANNER_JUDGMENT_ACTIONS` (`:137-150`); **add
`'escalate'` to `attentionActions`** (`:756`) beside `'extend'`.

**`src/db/reviewItems.ts`** — delete `flagNudgeGap` (`:145-197`); the planner is its only caller
(verify). KEEP `listEverFlaggedSubjectRefs`.

**No migration.**

### Tests this phase BREAKS
- `planner.test.ts:1545-1574` (exact `markOutcome('escalated')` call), `:1578-1593` (open-item
  path), `:4048-4080` (escalate half only — the close half moves to Phase 3).
- `plannerSim.test.ts:534-544` — asserts `status === 'escalated'`. `plannerSim.ts`'s
  `manager_resolve` step (`:950-977`) now tests nothing the planner can produce — mark dead.
- **`plannerCorpus.ts`: 24 real escalate expectations** (`action:'escalate'`×10,
  `actionNot:'escalate'`×14, all inside `expect` blocks — unlike `extend`'s, which are seed data,
  correcting the research's miscount). `npm test` stays green; graded only by the key-gated live
  runner. Document the re-grade; do not attempt it.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` (2490 passed) · `npm run build`
- [x] `escalate` is refused as unknown; the pinned equalities agree at eight (the COUNT is
      pinned too, `watchers.test.ts` — two sets that drift together are still equal).
- [x] A stored historic `escalate` decision still counts as attention (with a not-a-verb
      control, `watchers.test.ts`).
- [x] `mv_escalation_fates` still returns pre-existing escalations (probed on the local stack:
      `fate: resolved, by_planner: true, handoff_kind: escalated`; `mv_gap_outcomes` buckets it
      `outcome_bucket: manager`); no caller of `flagNudgeGap` remains.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack (`npx supabase start`, `.env.test`).
- [x] `runPlanner` tick on a seeded firm with an escalate in its history: applied (`applied: 1`),
      history line rendered `last: escalate 10h ago`, no alarm fired for it — while a
      same-age CONTROL gap with no decisions DID alarm. A fresh `escalate` came back
      `unknown action 'escalate'`; read-back showed `review_items` empty and both `nudges`
      rows' `updated_at` untouched.

### Manual verification
- [x] None.

---

## Phase 2: hold replaces leave

### What this phase does
`hold` becomes legal on every open stage and gains a release form. `leave` is deleted in the same
phase, because `hold` is its replacement and the alarm's mechanism shifts from "the planner said
`leave`" to "the row is held".

### Changes required

**`src/teamLead/planner.ts`**
- `PLANNER_ACTIONS`: remove `'leave'` → **seven verbs.**
- The shared `send || hold` stage rail (`:1515-1527`): narrow to `action === 'send'`. Send's
  pending/noticed-only rail is world-protecting (a re-send on an asked row is a silent no-op
  observed live 2026-08-20; `uq_nudges_subject_ever` forbids a second ask).
- **`applyDecision` case `'hold'` (`:2113-2124`) passes `['pending']` explicitly at `:2123`.**
  Widen to `OPEN_NUDGE_STATUSES`. Without this a hold on a queued/asked row matches no row and
  records *refused — "the gap changed state"*: the phase silently does nothing.
- `hold` validate (`:1737-1750`): accept explicit `notBefore: null` as RELEASE; keep the
  already-passed refusal (`:1744`) for non-null values. The built object is
  `...(notBefore ? { notBefore } : {})` (`:1797`), so a release drops the key and only clears because
  apply does `d.notBefore ?? null` — **pin that coupling with a test.**
- Delete the `leave`-on-pending rail (`:1636-1643`) and `applyDecision` case `'leave'`
  (`:2241-2250` region).

**`src/teamLead/plannerPrompt.ts`**
- **`notBefore` (`:337-342`) is `type: 'string'`** — the model is never told a release exists.
  Change to `['string','null']`; say a null/omitted `notBefore` on `hold` RELEASES.
- Remove `'leave'` from the enum; delete its verb line (`:53`) and the `leave IS NOT THE DEFAULT`
  section (`:59-63`); `hold`'s line (`:48`) says any stage, omit the date to release.

**`src/jobs/watchers.ts`**
- Remove `'leave'` from `PLANNER_JUDGMENT_ACTIONS`; **add it to `attentionActions`** (`:756`). The
  `leaveCounts` parameter of `attendedWithin` (`:757`) stays — it still governs historic rows.
- **`askCandidates` (`:728-733`) has NO `not_before` filter** — only `deliveryStuckRows` (`:714`) and
  `staleCandidates` (`:737`) use `heldPast` (`:706-707`). Add `!heldPast(n.not_before)` to
  `askCandidates`, or a paused question keeps reading as neglect.

### Tests this phase BREAKS
- `planner.test.ts:1223-1229` — "hold on an already-asked gap is refused too".
- The `watchers.test.ts` alarm family (`:973+`) asserting leave-counts-on-asks — rewrite as
  historic-only, plus held-asked-is-exempt.
- **No corpus expectation.** The single `action:'leave'` in `plannerCorpus.ts` is inside a
  `history:` SEED block, not an `expect` — a seeded row naming a retired verb keeps working
  exactly as the `extend` seeds beside it do. (Corrected during Phase 1: this line and the
  closing checklist both repeated the seed-vs-expectation miscount the Phase 1 notes warn
  about for `extend`.)

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` (2503 passed) · `npm run build`
- [x] hold+future date on an `asked` row **writes `not_before` and records `applied`** (asserted on
      the write AND the recorded outcome — either alone still passes).
- [x] `notBefore: null` on a held `asked` row clears it; hold on `queued` works; a passed date is
      refused; `send` on `asked` is refused; `leave` is refused as unknown (all three stages).
- [x] A held asked gap is exempt from `asksUnattended` and re-enters once released; a historic
      `leave` row still counts as attention on an ask and not on an observation.
- [x] The schema advertises a nullable `notBefore` **and documents the release** (a revert to
      `type: 'string'` would otherwise pass green — the tests never go through the JSON schema);
      the pinned equalities agree at seven, count included.
- [x] **Added after review:** a release on a gap that is NOT held is refused; a held QUEUED row
      still alarms as delivery-stuck while a held PENDING one does not.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [x] Hold-then-release an asked gap through `runPlanner`, real accessors, raw-SQL read-back:
      `not_before` null → `2026-09-04T16:00:00.000Z` → null, `applied:1 refusedAtApply:0` at every
      step, both release spellings (key omitted / explicit `null`). The alarm carve-out was proved
      with a same-age control and **zero decision rows** on either gap — holding through the
      planner would have written an applied `hold`, which `attendedWithin` counts as attention on
      its own, making the `not_before` carve-out unprovable.

### Manual verification
- [x] None.

---

## Phase 3: the rails get classified, and dismiss reaches every stage

### What this phase does
Every refusal in `validateDecisions` is labelled **world-protecting** (kept, pinned by a test naming
*what in the world* it protects) or **lifecycle-protecting** (deleted). `dismiss`/`recover` widen to
asks, with `prior_status` so recover puts a row back where it was.

### Changes required

**`supabase/migrations/20260902xxxxxx_nudges_dismissed.sql`** (new — must sort after
`20260901160000`)
- Drop/re-add the `nudges.status` CHECK (`20260817090000:29-30`) to add `'dismissed'` — superset,
  every historic value kept.
- `alter table nudges add column prior_status text;` nullable; set on dismiss, cleared on recover.
- Header records the ruling and that `OPEN_NUDGE_STATUSES` deliberately excludes `'dismissed'`, so
  the planner's open read, the host pull (`listQueuedNudgesForHost`, `status='queued'`) and the
  alarms all stop seeing a dismissed row without any of them changing.
- DEPLOY ORDER: apply before code.

**`src/db/nudges.ts`**
- `NudgeStatus` (`:12`): add `'dismissed'`.
- New `dismissNudge(id, tenantId, reason, fromStatuses = OPEN_NUDGE_STATUSES)` — writes
  `status:'dismissed', prior_status: <the row's current status>, resolution: reason, resolved_at`.
  Read-then-write with the status guard, or a single `update … returning` that copies `status` into
  `prior_status` in SQL — the latter is race-free; prefer it.
- New `recoverNudge(id, tenantId)` — from `['dismissed']`: `status = prior_status`,
  `prior_status = null`, `resolution = null`, `resolved_at = null`. Refuse (return null) if
  `prior_status` is null — a row dismissed before this migration cannot be recovered blind.
- New `listDismissedNudgeIds(tenantId)` — the twin of `listDismissedIds` (observations).

**`src/teamLead/planner.ts`** — the enumeration, exhaustive and line-verified on `main`.
Escalate's and leave's rails are already gone (Phases 1–2) and are not listed.

*KEEP — world-protecting:*
- `:1329` not a decision object · `:1379` gap not in this plan · `:1369,1383` a second decision for
  the same gap · `:1387` unknown action.
- `:1509` send with nobody to ask · `:1515` **send** on a non-pending/noticed row.
- `:1550, 1566, 1577, 1582, 1587, 1601, 1610` — the group block's **seven** pushes. **Reword the
  copy** (build 8): they protect *delivery* — one message anchored to one job, landing in one
  chat. The one-stage rail (`:1601`) prevents a 23505 that freezes a partial group.
- `:1670-1726` the close rails — Phase 4 widens *where* a quote may come from, changes none.
- `:1359` recover on a non-dismissed gap · `:1472` / `:1484` office verbs without addressee /
  message · `:1740` / `:1744` hold's two rails (Phase 2 admits null on the first).

*DELETE — lifecycle-protecting:*
1. `:1413-1420` **close on an observation.** Stage-fork the existing `case 'close'`
   (`:2251-2283`, which calls `markOutcome` against `nudges` and would silently record `refused`
   for an observation id): on `noticed`, `setObservationStatus(id, tenantId, {status:'dismissed',
   dismissReason: <citation>, dismissedAt: nowIso}, ['open'])` — no default `fromStatuses`, throws on
   empty (`observations.ts:131-141,155-157`) — and skip `stampAnswer` (`:2275-2281`). A recorded
   **translation**, the one this build accepts.
2. `:1395-1401` **dismiss on a non-observation.** An earlier draft KEPT this as "a missing write
   path"; that was wrong — `markNudgeOutcome` exists. Stage-fork `case 'dismiss'` (`:2125-2137`):
   `noticed` → the existing observation write; otherwise → `dismissNudge`. Reword: dismiss works on
   anything.
3. `recover` (`:1357-1372`) — widen the `recoverable` set (`:2515-2519`, today
   `listDismissedIds` only) to include `listDismissedNudgeIds`; stage-fork `case 'recover'`
   (`:2138-2149`): observation → existing write; nudge → `recoverNudge`. The doctrine's "find
   dismissed observations with spine_read over v_observations" (`plannerPrompt.ts:56-57`) must also
   point at `v_nudges` — **check `v_nudges` exposes `status='dismissed'` rows**; it may filter.

**Copy that contradicts change (1):** `buildGapView` prints "Nothing needs asking: dismiss this
observation" on both THE RECORD forks (`planner.ts:954-961`, `:963-973`) and the doctrine repeats it
(`plannerPrompt.ts:119-121`). All `toContain`-pinned.

**Metric views:** `mv_gap_outcomes` buckets by status (`20260824020000:30-40`); `'dismissed'` is a
new outcome it does not know. Leave it — a dismissed ask simply falls outside the view — and note
it for the eval phase rather than amending a view this build otherwise leaves alone.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` (2550 passed) · `npm run build`
- [x] One test per KEPT rail, its title naming the harm — as an executable `test.each` table
      (`describe('the rails that REMAIN, and the harm each one prevents')`), checked exhaustive
      against every `push(...)` in `validateDecisions`. Round 1 found four rails missing from it,
      one of which (`groups gaps whose job or person the record does not name`) had **no test
      anywhere in the repo**. A companion test asserts the three DELETED rails now accept.
- [x] close on an observation records **`applied`** and writes `dismissed` + citation, with
      neither nudges-table writer firing.
- [x] dismiss on an `asked` row writes `status='dismissed'`, `prior_status='asked'`, the reason;
      it vanishes from the planner's next gap list, the host pull, and every alarm.
- [x] recover on it restores `status='asked'`, clears `prior_status` **and `not_before`**; recover
      on a row with null `prior_status` is refused, with its OWN refusal copy rather than the
      generic race message; recover on a queued row returns it to the host pull.
- [x] The pinned equalities hold at seven, plus the DB-CHECK superset check (every historic value
      still writes; a bad one is refused by name).

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [x] Through `runPlanner` with real accessors, raw-SQL read-back, 11/11: dismiss an asked gap
      (`asked → dismissed, prior_status='asked'`), recover it (`→ asked`, prior/resolution/
      resolved_at all null), same for a queued row returning to the host pull, the null-prior row
      refused and byte-identical, and a close on an observation writing
      `dismiss_reason = 'answered — "…"'` with **no** nudges row created. All 26 decision rows
      keyed to the right FK. The alarm proof used a CONTROL row flipped to `dismissed` by raw SQL
      with **zero** decision rows (`asksUnattended 2 → 1`), because an end-to-end dismiss is
      exempt for two reasons at once — status AND the fresh applied decision counting as attention.

### Manual verification
- [x] **Judgment call — RESOLVED by the user 2026-09-02.** The KEEP/DELETE table was read and the
      classification stands. The one product question inside it was raised explicitly: the
      once-ever rail means a technician who never answers can never be asked again, and the
      planner's only remaining moves are wait, close or dismiss. **USER RULING: re-asking and
      multiple sends belong to build 6.5, not here.** Deleting the rail now would not buy
      re-asking — it would let the planner believe it re-asked while the technician's phone stayed
      silent, because `uq_nudges_subject_ever` blocks the second row at the database. The
      companion rail (no mixed-stage grouping, so the planner occasionally sends two messages
      where one would do) stands for the same reason: cosmetic cost, real crash if removed.

---

## Phase 4: the planner may cite what it looked up

### What this phase does
Tool results from the current tick become citable. The honesty rail's shape is unchanged — a quote
must appear in text the model was shown — but "shown" widens to what the turn's tool calls returned.

### Changes required

**`src/model/toolLoop.ts`** — a change IS required. The executor is called at `:610` with
`raw: unknown`; the shown string is built by the module-private `stringifyResult` (`:486-495`,
truncated at `MAX_TOOL_RESULT_CHARS = 20_000`) at `:620` and pushed to `calls` at `:622`.
**Recommended:** add an optional `onResult?: (call: ToolLoopCall) => void` hook invoked right after
`:622`, so the caller receives exactly the shown string. (Alternative: export `stringifyResult`.)
- **Known limit, document it:** `submit_plan` in the same assistant turn as a `spine_read` returns
  at `:627-629` before that read runs. Reads precede the submitting turn — say so in the doctrine.

**`src/teamLead/planner.ts`**
- Accumulate shown results via the hook into a closure array, hoisted like `views` (**`:2396`**).
  The `runLoop` call is `:2784-2840`; the executor **`:2807-2838`**.
- `validateDecisions` (`:1301`): add optional `readText: string[]`.
- Citation check (`:1712` region): haystack = evidence ∪ `readText`, same normalized match. Keep
  the ≥12-char/≥2-word floor (`:1698`) and one-quote-one-gap (`:1726`).
- A citation matching only `readText` leaves `answeredByCaptureId` null — comment why.
  `TECHNICIAN_SPOKEN_CHANNELS` (`:807-811`) untouched.

**`src/teamLead/plannerPrompt.ts`** (`:285`) and **`src/mcp/server.ts`** catalog rule (5)
(`:801-802`): both become *you may quote anything you read THIS tick; you may not quote what you
did not read*. Update the pin at **`planner.test.ts:2941`** to a **contiguous single-line** phrase.
Rule (5) has no pin; `SPINE_VIEW_CATALOG` is shared by `query_spine` (`:1318`) and `spine_read`
(`:1818`), so the edit cold-writes both prompt caches.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm run build`. `npm test`: **2561 passed, 1 failed**
      — `recordFieldNote.test.ts` "an unmatched note proposes the scheduled address". PRE-EXISTING
      and NOT this build's: it fails identically on `main` with this branch's work stashed, and in
      isolation, on a freshly `npm run seed:local`-ed stack. Left for a separate fix rather than
      absorbed into this diff. Every other file is green.
- [x] A close citing a `spine_read` result from this tick is ACCEPTED with no capture id; text from
      nowhere is REFUSED; a pushed evidence line still stamps its capture id (asserted in the HARD
      case, where the quote is in BOTH places, so an implementation consulting `readText` first
      would fail); **a quote from beyond the 20,000-char truncation point is REFUSED** — proved in
      `toolLoop.test.ts` against the REAL loop, since a stubbed loop could only assert about itself.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [x] 5/5, driven through the REAL `runToolLoop` against a local OpenAI-compatible server (only
      `listTenants` stubbed): the answer seeded where the briefing does not print it (the gap block
      shows `notes: NO notes have landed`), a real two-turn read-then-close, and raw-SQL read-back
      showing `status='answered'`, the resolution carrying the quote, and
      **`answered_by_capture_id IS NULL`**. Plus: the ordering limit is real, and cross-tenant
      isolation holds.
      - *Note for the next reader:* the plan suggested seeding the answer behind the visit bridge.
        That does not work — `listJobEvidenceSince` already reaches through
        `visits.source_capture_id`, so a visit-bridged note IS printed. The bound that genuinely
        excludes a record is TIME (`captured_at > asked_at`).

### Manual verification
- [x] None.

---

## Phase 5: stuck becomes visible, and the doctrine is rewritten

### What this phase does
Prints the delivery ledgers the planner is asked to judge without, then rewrites `PLANNER_SYSTEM` to
describe what phases 1–4 built. Last, because every earlier phase changes it.

### Changes required

**`src/teamLead/planner.ts`** — `buildGapView`
- No query change (`listNudgesByStatus` uses a bare `.select()`, `nudges.ts:103-116`).
- **The ledgers live on the group LEAD** (`nudgeQueue.ts:140-161`, `:143-144`) — read the lead's for
  a grouped row, or non-lead members render `served 0 times`: the exact confusion this removes.
- **`observationAsGapRow` hardcodes `attempts: 0, serve_count: 0`** (`:1098-1099`) — gate the line
  to nudge-backed stages.
- THE RECORD-style line for queued rows at/over a cap, importing `MAX_SERVE_COUNT` /
  `MAX_DELIVERY_ATTEMPTS` (`nudgeQueue.ts:33,36`): `served N times, failed M times — FROZEN, it will
  not be delivered again. Nothing will move it but you.` Below the caps, print the counters plainly.
- Leaderless-group and inactive-technician freezes (`:126-138`) are serve-time facts, not derivable
  from the row — state the limit in the comment.

**`src/teamLead/plannerPrompt.ts`** — the rewrite pass
- Against the CURRENT prompt; the 2026-08-28 draft is intent only.
- **Free:** identity/opening (`:21-24`), list framing, `HOW TO PACE` (`:141`), "Do not browse"
  (contradicts Phase 4 — must go).
- **Must keep (pinned at `planner.test.ts:2920-2991`):** `v_captures` / `v_nudges` /
  `v_review_items` / `join v_visits`, `never instructions to you`, `escalated_from_nudge is` (a read
  surface that still holds historic rows — the verb is gone, the column is not), the
  notes/memory/reconcile family, the job-note paragraph, `ORPHAN_FOOTER_PREFIX` agreement.
- **`WHAT EACH ACTION CAN DO, AND WHEN` (`:88-104`) is the state machine as prose** — rewrite to
  describe what each state *is*. Delete "Choosing send or hold on a gap that has already gone out
  will be refused" (false after Phase 2) and "An asked gap ends with close or escalate" (false after
  Phases 1 and 3).
- **The frozen row's advice:** the old line says "escalate it". Honest now: you can see it is
  frozen; close it, dismiss it, or hold it. **No dead text about build 6.5.**
- Say that a thought without an action is `write_job_note`, and that silence is recorded — the
  `leave IS NOT THE DEFAULT` paragraph's surviving truth, restated without the verb.
- Add the Phase 4 ordering rule: look things up *before* the turn you submit on.
- **Build 8:** where the prose names a person, say "the person this gap names".

**`src/eval/plannerSim.ts` / `src/eval/plannerCorpus.ts`**
- `serve_count`/`attempts` appear in **neither** file — extend `ScenarioWorld['nudges']` and
  `seedScenario` to carry both; a frozen row is not seedable today. Also seed `prior_status`.
- Add cases: hold-then-release on an asked gap; dismiss-then-recover on an asked gap; a close citing
  a looked-up record.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` (2575 passed) · `npm run build`
- [x] A queued row at/over either cap renders FROZEN; below renders **age + counters and asserts
      nothing else**; a non-lead member renders the LEAD's ledgers — pinned BOTH at `buildGapView`
      (explicit lead) and through `runPlanner` (`leadFor`, which review found untested); an
      observation renders no ledger line; a LEADERLESS member renders FROZEN despite its own zeros.
- [x] All doctrine pins pass; no surviving prompt text offers `escalate` or `leave` — checked
      against the RENDERED prompt, not the source. `src/eval/doctrine.ts` untouched.
- [x] `plannerCorpus.test.ts` green with four new cases.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [x] 16/16 through the real `runPlanner`. Two beyond the ask: a NEGATIVE CONTROL on the group
      borrow (lead small / member past the caps → the member renders the LEAD's small numbers and
      no FROZEN, proving direction rather than "whichever is higher"), and a cross-check against
      the real serve loop — `buildNudgeDelivery` skipped the frozen row (`serve_count` 10 → 10)
      while a below-caps control was served (2 → 3), so "it will not be delivered again" is true
      of the machinery and not just of the copy.

### Manual verification
- [ ] **Judgment call (OPEN — for the user):** read the rewritten `PLANNER_SYSTEM` end to end —
      one document, not five phases of patches, and nothing describing a rail or verb that no
      longer exists.

---

## Closing the build (all phases done)

- [ ] `npm run decisions:index`; commit the regenerated `thoughts/INDEX.md` and the
      `docs/engineering-memory.md` map alongside the code.
- [ ] Add the §6a build-6 entry: the two deletions, dismiss/recover on every stage with
      `prior_status`, the KEEP/DELETE table, and the `mv_gap_outcomes` blind spot for
      `'dismissed'`. **The corpus damage, counted honestly:** 24 orphaned ACTION expectations
      (10 `action:'escalate'` + 14 `actionNot:'escalate'`; there is no `leave` expectation),
      PLUS 23 claim clauses (22 `mustNotClaim`, 1 `mustName`) weakened rather than orphaned —
      `plannerEvalGraders2.ts` grades them over `[handoff_note, reason]` and `handoff_note` is
      now never written, so they still fire but against diagnostic copy instead of the
      manager-facing copy they were authored against. Also record that an `escalate` the model
      TRIES leaves NO trace: it fails the unknown-action check, and the dropped-recorder skips
      unknown verbs, so the gap takes an `unmentioned` tick mark instead of a refusal row.
- [ ] Flip this plan's `status:` to `complete`.
