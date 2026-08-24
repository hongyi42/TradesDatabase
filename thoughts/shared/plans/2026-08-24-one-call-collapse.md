---
date: 2026-08-24
task: the one-call collapse — the planner queues its own sends; compose's model call retires
research: thoughts/shared/research/2026-08-24-one-call-collapse.md
status: draft
supersedes: nothing
---

**`supersedes:` note:** this executes Stage 2 of the direction recorded in
[[collapse-the-model-call-stages]] (2026-08-22) rather than overturning anything. One recorded
correction: the research doc says the never-asked backstop is 24h — the constant is
`NUDGE_DELIVERY_DEADLINE_HOURS = 18` (watchers.ts:158), and it covers pending AND queued rows.

## Overview

Make the planner the ONLY model call in the nudge pipeline. Its `send` decision writes the
complete technician-facing message (railed against the gap's date vocabulary) and queues it
immediately — one guarded DB write. The compose step's model call, its kind prompts, and the
code-assembled message frame all retire. The box runner, the queue handoff, and the sweep's
clocks are untouched.

## Decisions

- **The planner's apply step queues directly** (user, 2026-08-24) — no model-free forwarding
  sweep; `send` = message queued now. The 5-minute compose sweep deletes entirely.
- **The planner writes the WHOLE delivered message** (user, 2026-08-24, citing the Opus 5
  date verdict: zero date-math errors on a bare clock line) — the code-printed context line
  dies. The date-vocabulary rail (`cleanQuestionDraft`) stays: it costs Opus nothing (~0 hits
  in the eval) and is the machine-side insurance for the GLM rollback arm (~6 rail hits in
  the same runs). Message shape stops being uniform — accepted as the point of an AI manager.
- **Planner-off = the ladder is mute, loudly** (user, 2026-08-24): with `NUDGES_MODE=live`
  and `PLANNER_MODE` ≠ live, gaps are detected but never asked; the 18h never-asked sweep
  hands them to the manager. The lifecycle tick logs a loud warning; no dormant fallback.
- **Cadence stays half-hourly** (user, 2026-08-24): a brand-new gap waits ≤~25 min for its
  question. Bounded far below the 18h backstop; measure pilot arrival patterns before
  spending more.
- **Gate = codified tests + a live local-stack E2E; no paid eval rerun** (user, 2026-08-24):
  the eval loop never contained compose and the planner call is unchanged. The frontier-judge
  env config lands in analyze.mjs for future runs (user ruling: frontier model grades, no
  Haiku fix).
- **`question_draft` keeps being recorded** on decisions (nudgeDecisions.ts:84) — it is ⑤'s
  and the audit trail's copy of what the planner wrote, now identical to what was sent.
- **`hold` semantics unchanged** (pending-only `not_before`). A queued row has left pending,
  so stale holds are moot; `send` no longer needs to clear `not_before` explicitly.
- **Sends are in-window by construction** — the planner already skips whole tenants outside
  the 7am–7pm ask window (planner.ts:1247), so no window check is needed at queue time.
- **Thin-row handling: accepted loss, recorded** (review finding). Compose used to hand a
  display-thin pending row to the manager within 5 min. Post-collapse a thin row is asked
  with buildGapView's placeholder copy or waits for the 18h sweep; a row so tampered that
  `spec.handoff` also fails stays frozen with loud logs (watchers.ts:850-853) — the
  pre-existing frozen-row doctrine. Detector-written rows are never thin; thinness means
  tampering, and no new guard is built for it.
- **Eval comparability caveat (recorded with Phase 3's memory entry):** a rail-dropped or
  missing question now REFUSES the send instead of falling back to compose, so on any future
  corpus rerun the GLM arm's ~6 rail hits become failed send expectations
  (plannerEvalGraders2 requires APPLIED). The 63/65 vs 58/65 baseline is comparable for Opus,
  degraded-by-design for the rollback arm.
- **`handToManager` and `insideAskWindow` survive in compose.ts** — nudgeQueue.ts (delivery
  failures) and planner.ts/plannerSim.ts/workingHours.ts import them. Only the sweep, its
  model call, and its summary retire.

## Plain-language walkthrough

**Phase 1** teaches the planner's `send` to finish the job itself: when it decides to ask,
the question text it wrote is checked by the date rail and — if it survives — written onto
the nudge row and flipped to `queued` in one guarded write. The box runner then delivers it
verbatim, exactly as today. You'd notice it working because a `send` decision and the queued
message become the same text, seconds apart, with no middleman. If the rail dropped the
planner's text, the send is refused with a teaching message and retried next tick — never a
silent fallback.

**Phase 2** removes the now-redundant compose step: the every-5-minute sweep, its model call,
its per-kind prompts, and the message-assembly template all go. The lifecycle tick gets a
loud warning for the one state that changes behavior: ladder live but planner not live means
nobody writes questions until the 18h backstop hands gaps to the manager.

**Phase 3** is bookkeeping and proof: the eval's judge model becomes env-configurable
(frontier by default, per your ruling), the engineering memory records the collapse (and that
the `teamLeadCompose` line vanishing from the cost ledger is expected, not breakage), and a
live end-to-end run on the local stack — real Opus call, seeded pending gap — shows
detect → plan → queue with the planner's own words on the row.

```
before: sweep ─ pending ─► [compose: model call if no draft, assemble] ─► queued ─► box ─► asked
after:  sweep ─ pending ─────────► planner (writes + queues in one apply) ─► queued ─► box ─► asked
```

## Secrets & env preflight

- **Phase 1:** none (unit tests only, local stack — `.env.test` already required).
- **Phase 2:** none.
- **Phase 3:** `ANTHROPIC_API_KEY` in `.env` (`already required` — live local E2E makes one
  real planner call). `EVAL_JUDGE_MODEL` is a new OPTIONAL var (no secret; default in code).

## Phase 1: the planner queues its own sends

### What this phase does
`applyDecision`'s `send` case stops being "clear the hold for compose" and becomes "queue my
message". Draftless sends become refusals. The prompt tells the planner it is writing the
delivered message itself. Compose still runs this phase (consistent intermediate state: rows
the planner queued are invisible to it; draftless rows still get compose's call until
Phase 2).

### Changes required

**`src/teamLead/planner.ts`**
- `applyDecision` (line 1117): the send needs the surviving draft. Today `case 'send'` (line 1128) calls `setSchedule(d.nudgeId, tenantId, { notBefore: null }, ['pending'])`.
  Replace with:
  ```ts
  case 'send': {
    // The planner's words ARE the delivered message (collapse, 2026-08-24).
    // No draft = nothing to deliver: refuse loudly so the model rewrites next
    // tick instead of a silent fallback author that no longer exists.
    if (!d.questionDraft) {
      return {
        outcome: 'refused',
        detail: 'send needs `question` — it was missing or the date rail dropped it; rewrite it within the dates you were given',
      };
    }
    return done(await markQueued(d.nudgeId, tenantId, d.questionDraft));
  }
  ```
  `markQueued` = `markNudgeQueued` from `../db/index.js` (pending-only guard, resets
  attempts, stamps `queued_at` — db/nudges.ts:98), threaded through `PlannerDeps` like
  `setSchedule` is, so tests inject it.
- The rail-drop path must reach the refusal: today a dropped draft still applies the send
  (the draft "costs the draft, never the send" — planner.ts:107). That comment and behavior
  flip: in the decision-collection block (line ~1036), a `send` whose `cleanQuestionDraft`
  returns a null note keeps its noteDrop log AND now flows into the refusal above (the
  decision still records, outcome `refused`, so shadow/⑤ see what the model wanted).
- Teaching text at lines 873-875 (`leave` on pending) still says "a pending question is sent as
  soon as it is composed" — reword: "a pending gap does NOT go out until YOU send it".

**`src/teamLead/plannerPrompt.ts`**
- Line 23: delete the stale "compose still writes that" comment (pre-②b).
- Lines 30-31 ("You do not write the questions and you cannot send anything") — now false;
  reword: the planner writes the questions and its `send` queues them; the box delivers.
- Lines 61-65 (state teaching): pending = "waiting for YOU — nothing goes out until you
  choose `send`, and your `question` is delivered verbatim". KEEP the "`leave` does not work
  on pending" clause — the rail at planner.ts:866-877 survives.
- Lines 111–120 (WRITING THE QUESTION): the text is the ENTIRE message the technician
  receives — keep the rules (one question, colleague tone, no greeting/sign-off, only the
  given dates); DELETE line 120 ("the system writes its own instead" — no fallback author
  exists; a bad question now refuses the send), and drop "the system adds the frame".
- YOUR MEMORY doctrine (~line 163, "making the same one again will fail the same way"):
  add the carve-out — a send refused for a missing/dropped question is the one refusal you
  SHOULD retry, rewritten within the given dates.

**`src/teamLead/planner.test.ts`**
- FOUR existing tests break and must be rewritten (review finding): :1101 "send CLEARS the
  hold" (send no longer calls setSchedule); :1238 draftless-send refusal detail changes;
  :1248 throwing-setSchedule-on-send no longer applies (inject a throwing markQueued
  instead); :1402 expects applied=1 from a draftless send → now 0. The `live()` helper
  (:1084-1099) must inject the new `markQueued` dep or the default hits the real DB.
- New tests: applied `send` → row `queued` with `question` = the draft verbatim; missing
  draft → `refused` with the teaching detail; row already moved (not pending) → `refused`,
  never a throw; rail-dropped draft → `refused` + noteDrop recorded.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass
- [ ] new planner.test.ts cases above pass
- [ ] compose.test.ts still passes untouched (intermediate state is legal)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack (`npx supabase start`, `.env.test`)
- [ ] none beyond the vitest suite this phase (no model call in the new path)

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 2: retire compose

### What this phase does
Deletes the compose sweep, its model call, its prompts, the assembly template, and the
lifecycle step that ran it; adds the mute-mode warning.

### Changes required

**`src/jobs/lifecycle.ts`**
- Remove step 10 (lines 408-419): the `runTeamLeadCompose` call, its gates, and the
  `teamLeadCompose` field from `LifecycleSummary`; drop the import (line 16).
- In its place, the mute-mode warning: when `nudgeMode === 'live'` and
  `plannerMode !== 'live'`, log loudly AND surface `ladderMute: true` in the summary. The
  wording must be watchers-aware (review finding: the 18h never-asked sweep only runs when
  `WATCHERS_MODE === 'live'`, watchers.ts:423): with watchers live — "gaps are detected but
  no questions go out; the 18h never-asked sweep hands them to managers"; without — "… and
  NO backstop sweep is running".

**`src/teamLead/compose.ts`**
- Delete `runTeamLeadCompose`, `ComposeSummary`, `ComposeDeps`, `MAX_COMPOSE_ATTEMPTS`
  (grep first: nudgeQueue.ts has its own delivery attempts — verify no import). KEEP
  `insideAskWindow`, `ASK_WINDOW_START_HOUR/END_HOUR`, `handToManager`, and the re-exports
  that still have importers. Update the header comment (it calls compose "the ONLY model
  call in the ladder" — now there are none).

**`src/teamLead/composeCopy.ts`**
- Delete `COMPOSE_SYSTEM/COMPOSE_TOOL`, `COST_COMPOSE_SYSTEM/COST_COMPOSE_TOOL`,
  `assembleNudgeMessage`, `readComposeContext`, `readCostComposeContext`,
  `relativeDayPhrase` — after a grep confirms no importers remain. KEEP `flatten`
  (reflector.ts:9, lessons.ts:3) and `FOOTER_DELIMITER` (nudgeQueue.ts:13, live at :114) —
  both have live importers (review-verified).

**`src/jobs/nudgeKinds.ts`**
- Remove the `compose: ComposeBlock` field from the spec type (line 235) and both kind
  definitions (lines ~323, ~506). `spec.handoff` (sweep templates) is untouched.

**Tests**
- `compose.test.ts`: trim to surviving exports (`insideAskWindow`, `handToManager`).
- `src/control/nudgeQueue.test.ts` (review finding): imports `assembleNudgeMessage` (:6,
  used :109-131 for the footer-strip no-op proof) — rewrite that assertion against a
  hand-built message string instead of the deleted helper.
- `lifecycle.test.ts`: drop compose-step assertions; add `ladderMute` coverage: live+live →
  absent; live+shadow-planner → present with sweep-backstop wording; live+shadow-planner+
  shadow-WATCHERS → present with the harsher "no backstop is running" wording.
- `watchers.test.ts`: the kind-spec literal at :1158 loses its `compose` field.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass
- [ ] `grep -rn "runTeamLeadCompose\|COMPOSE_SYSTEM\|assembleNudgeMessage" src scripts` → no hits
- [ ] new ladderMute lifecycle test passes

### Live verification (agent-executable)
- Prerequisites: local stack
- [ ] none this phase (Phase 3 runs the full E2E)

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 3: judge config, docs, and the live E2E

### What this phase does
Lands the frontier-judge env knob, records the collapse in the engineering memory, and proves
the whole path live on the local stack with one real Opus call.

### Changes required

**`scripts/agentic-eval/analyze.mjs`**
- Hoist the model to a top-level `const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ??
  'claude-opus-5'` used at line 102 (user ruling 2026-08-24: frontier judge, no Haiku fix),
  and when `--judge` is set print `[judge] model: <JUDGE_MODEL>` BEFORE the grading loop, so
  a zero-row run proves the resolution without a paid call. Note the changed default in the
  header comment.

**`docs/engineering-memory.md`** (+ `npm run decisions:index`)
- New entry: the collapse landed — the planner is the pipeline's only model call; `send`
  queues the planner's verbatim message; compose retired; `teamLeadCompose` disappearing
  from cost_events is EXPECTED; mute-mode semantics; the 18h backstop is the planner-off
  floor. Cross-reference the research doc and this plan.

**`thoughts/shared/research/2026-08-24-one-call-collapse.md`**
- No edit (the 18h/24h erratum is recorded in this plan's header).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass
- [ ] judge-knob check without a paid call (review finding: analyze.mjs has no --help and
      the model is only read inside the judge loop): make a temp run dir whose
      `results.jsonl` is empty, run `analyze.mjs --dir <tmp> --judge` with
      `EVAL_JUDGE_MODEL` unset then set — the printed `[judge] model:` line shows
      `claude-opus-5` then the override, zero rows graded

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; `ANTHROPIC_API_KEY` + `MODEL_PROVIDER=anthropic` in
  the shell for this one command (never printed).
- [ ] The E2E needs a small throwaway driver script, NOT the lifecycle binary (review
      finding: lifecycle uses the wall clock, half-hour cadence, and ask-window gates, and
      `runPlanner` only walks tenants from `listTenantIdsWithTelegramBindings` — plannerSim's
      seeds are deliberately unreachable, no telegram_user_id). The driver: seed a tenant +
      technician WITH a telegram binding + one pending overdue-visit gap via SQL, then call
      `runPlanner(craftedInWindowIso, 'live', { execute: dispatchForIdentity… })` directly.
      Then read back via a SECOND client (psql/supabase MCP): the row is `queued`, `question`
      equals the decision row's `question_draft` byte-for-byte, `queued_at` stamped,
      `nudge_decisions` has the applied `send`. Capture both rows as evidence.
- [ ] One `runLifecycle` smoke on the local stack (any wall time): summary contains no
      compose step and, with live+live modes, no `ladderMute`.

### Manual verification
- [ ] After the next pilot deploy (user-gated): watch one real gap flow detect → planner
      send → box delivery on Telegram, and confirm the received message is the planner's
      text verbatim. (Deferred pilot check — deploy timing is the user's call. Note the
      deploy-does-not-migrate rule does not apply: no migrations in this plan.)

---
*Pause here: the pilot observation is genuinely deferred/manual; everything else is done.*
