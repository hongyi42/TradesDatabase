---
date: 2026-08-31
branch: feat/the-sweep-stops-deciding
commit: 6f70936
topic: "Build 6 ground — intent verbs + the doctrine: the seven-verb surface, the prompt as written, the write path an intent layer would resolve through, what the planner reads, the observation record's verb gaps, freeze/pacing remnants, and every coupling pinned to the current vocabulary"
supersedes: nothing
---

**`supersedes:` is not optional bookkeeping.** This document overturns nothing — it maps the
ground build 6 modifies. Note on the base: this research is deliberately conducted on
`feat/the-sweep-stops-deciding` (6f70936, build 5 complete, **PR #194 still open**), not `main` —
build 6 sits on build 5's verb set (`extend` retired, escalate-owns-handoff, the alarm pass), so
main's code is not the ground being modified. If PR #194 changes before merge, re-verify the line
numbers here.

## Summary

The planner — the one model call that decides everything in the gap ladder — speaks a vocabulary
of seven **mechanism verbs** (`send`, `hold`, `close`, `escalate`, `leave`, `dismiss`, `recover`):
each names what the machinery does, not what the planner intends. Build 6's charter (§6a entry 6:
"intent verbs + the doctrine — the list becomes a SUGGESTION, not a state machine") is to rework
that vocabulary into **intents** resolved to mechanism at write time, make what the planner reads
**citable** wherever it read it, and rewrite the system prompt (the "doctrine") per the
2026-08-28 draft. This document records, factually: where the seven verbs live end to end (schema
→ validate → apply → stored rows → readers), everything the doctrine says and what pins its exact
words, the path a wire-vocabulary change would have to travel, what the planner's context contains
and what provenance already exists, which verbs an observation lacks, what the freeze/pacing
remnants of build 5 look like, and every eval/report/metric/test coupled to today's verb names.

One framing fact first: **the five-intent list `ask/wait/close/drop/note` appears nowhere in the
repository.** The in-repo charter is the §6a table row (docs/engineering-memory.md:3407) plus the
doctrine-rewrite draft (`thoughts/shared/design/2026-08-28-planner-doctrine-rewrite.md`); the
five-verb enumeration lives only in session memory (`harness-rebuild-build-order.md`). Whatever
the intent vocabulary ends up being is an open design question, not a recorded ruling.

## Entry Points

- `src/teamLead/planner.ts:89-97` — `PLANNER_ACTIONS`, the seven-verb const the whole surface keys on.
- `src/teamLead/plannerPrompt.ts:20-279` — `PLANNER_SYSTEM`, the doctrine as one joined string; `:282-386` — `SUBMIT_PLAN_TOOL`, the wire schema whose `action` enum (`:302`) is the model-facing vocabulary.
- `src/teamLead/planner.ts:2094` — `runPlanner`, the per-tenant tick; `:2510-2566` the tool loop call with validate-inside-executor.
- `src/teamLead/planner.ts:1258` — `validateDecisions`; `:1797` — `applyDecision`.
- `src/jobs/watchers.ts:137-145` — `PLANNER_JUDGMENT_ACTIONS`, the alarm pass's attention set.
- `thoughts/shared/design/2026-08-28-planner-doctrine-rewrite.md` — the rewrite draft (191 lines, predates builds 3–5).

## Key Files

| File | Role for build 6 |
|---|---|
| `src/teamLead/planner.ts` (2921) | Verb definitions, decision shape, gap-view composition, validate rails, apply cases, record writes |
| `src/teamLead/plannerPrompt.ts` (386) | The doctrine + the submit_plan schema (the wire vocabulary) |
| `src/model/toolLoop.ts` (615) | The transport: system+schemas are the cacheable prefix; terminal-tool loop |
| `src/jobs/watchers.ts` (799) | `PLANNER_JUDGMENT_ACTIONS` + the alarm pass reading stored action strings |
| `src/control/nudgeQueue.ts` (255) | Freeze semantics (the vocabulary-less frozen state) |
| `src/db/nudges.ts` (519) | `NudgeStatus`, `setNudgeSchedule` (dormant `escalateAfter` arm), `markNudgeOutcome` |
| `src/db/nudgeDecisions.ts` (236) | The decision log — `action: string` stored **verbatim from the wire** |
| `src/db/observations.ts` (168) | `ObservationStatus` (`open`/`dismissed`/`asked`) and its one guarded writer |
| `src/db/reviewItems.ts` (467) | `flagNudgeGap` (escalate's writer), `findOpenReviewItem` |
| `src/teamLead/identity.ts` (57) | `TEAM_LEAD_TOOL_NAMES` — the deny-by-default tool allowlist |
| `src/mcp/server.ts:662-717,1710-1860` | `SPINE_VIEW_CATALOG` (thirteen views) + `TEAM_LEAD_TOOLS` |
| `src/teamLead/memory.ts` (221) | `renderMemoryIndex` — the index block that opens every prompt |
| `src/eval/plannerCorpus.ts` (1050) | Scenario expectations naming verbs (incl. 7× `action:'extend'`) |
| `src/eval/plannerSim.ts` (930) | `runTick`/`runArc` — the production pair driven over seeded worlds |
| `src/eval/plannerEvalGraders2.ts` (272) | Deterministic graders (verb sequences, whiplash) |
| `scripts/ticks/report.mjs` (513) | The operator report (alarms section; per-firm decision counts) |
| `supabase/migrations/20260824020000_planner_metrics_v2.sql` | `mv_escalation_fates`, `mv_whiplash`, `mv_extend_effectiveness` — SQL reading action literals |

## Area 1 — the verb surface today

### Where the vocabulary is declared

Three declarations must agree, and two tests pin the agreement:

1. `PLANNER_ACTIONS` (`planner.ts:89-97`) — the code-side const. Header (`:77-88`) states the
   contract: adding a verb means adding it to `PLANNER_JUDGMENT_ACTIONS` in watchers.ts too, and
   records `extend`'s retirement ("build 6 may reintroduce a pacing intent").
2. The `submit_plan` schema enum (`plannerPrompt.ts:302`) — what the model is shown.
   `planner.test.ts:2866-2876` pins enum == `PLANNER_ACTIONS`.
3. `PLANNER_JUDGMENT_ACTIONS` (`watchers.ts:137-145`) — what the alarm pass counts as attention.
   `watchers.test.ts:1142-1144` pins it == `PLANNER_ACTIONS` and never `unmentioned`.

`UNMENTIONED = 'unmentioned'` (`planner.ts:110`) is code's own eighth word — deliberately not
submittable (an unknown action is refused), written as the silence tick-mark, capped per gap at
`UNMENTIONED_CAP = 200` (`:119`).

### The decision shape

`PlannerDecision` (`planner.ts:121-165`): `nudgeId`, `action`, plus per-verb fields — `notBefore`
(hold), `basis`/`citation`/`answeredByCaptureId`/`mootClose` (close), `handoffNote`/`agentContext`
(escalate), `questionDraft`/`nudgeIds` (send), always `confidence` + `reason`. `mootClose` is
validate-set, never model-suppliable. Refusals keep the model's own confidence/reason
(`DroppedDecision`, `:169-184`).

### Per-verb rails and writes (validate `planner.ts:1258-1730` → apply `:1797-2092`)

| Verb | Stage rails (validate) | Apply writes |
|---|---|---|
| `send` | needs a person (`:1428` — refused when `technician_id` null); pending/noticed only (`:1435-1449`); group rails `:1461-1542` (member-of-own-group `:1469`, one stage per group `:1520`, same person+job `:1529`); question required at apply (`:1828`) after the date rail (`cleanQuestionDraft :1242`) | on `noticed`: **creates the ask** — `createNudgeFromObservation` born `'queued'` with the observation's own uuid, lead first, observation stamped `'asked'` best-effort (`:1847-1917`); on relic `pending`: `markNudgeQueued`/`markNudgeGroupQueued` (`:1918-1920`); stale holds cleared best-effort (`:1928-1935`) |
| `hold` | usable future `notBefore` (`:1657-1666`); pending/noticed only; **no ceiling** (`:1667-1671`) | `noticed` → `setObservationStatus{notBefore}` (`:1957-1960`); relic pending → `setNudgeSchedule{notBefore}` (`:1962-1964`). Advisory both ways — nothing reads it but the planner's next view and the alarms' hold-exemption |
| `close` | refused on `noticed` (`:1370-1376` — "dismiss it"); basis `'record'` authorised only by the code-computed chain `recordFilled ?? mootFact ?? moneyOnRecord` (`:1588`); basis `'evidence'` needs a ≥12-char/≥2-word verbatim quote found in the shown evidence (`:1611-1634`), one quote one gap (`:1645`) | `markNudgeOutcome(_, 'cancelled'\|'answered', resolution)` (`:2069-2074`) — `'cancelled'` when moot-authorised; `setNudgeAnsweredBy` stamp best-effort (`:2082-2087`) |
| `escalate` | refused on `noticed` (`:1399-1409` — "no handover path yet", named build-6 vocabulary work in the code comment `:1402-1403`); refused without jobId (`:1410-1419`); `handoffNote` required at validate (`:1701-1707`, belt at apply `:1995`) after the date rail | flag first (`flagNudgeGap` with `escalatedFromNudge`, `suggestion` = the note, `agentContext` — `:2007-2018`), null-flag disambiguated by `findOpenReviewItem` (`:2025-2035`), then `markNudgeOutcome(_, 'escalated', 'handed to the manager by the team lead', ['pending','queued','asked'])` (`:2039-2045`); `itemOpened` gates the once-only manager push (`:2786-2805`) |
| `leave` | refused on `pending` only (`:1556-1562` — an unowned wait would sit forever); legal on noticed/queued/asked | no write (`:2048-2057`) — recorded `applied`; counts as alarm attention on asks, NOT on stale observations |
| `dismiss` | `noticed` only (`:1352-1358`) | `setObservationStatus{status:'dismissed', dismissReason, dismissedAt}` from `['open']` (`:1965-1977`) |
| `recover` | validated against the tenant's dismissed-id set, before the view lookup (`:1314-1332`); a hallucinated id drops silently (FK safety) | `setObservationStatus{status:'open', notBefore:null, …}` from `['dismissed']` — the hold clears too (`:1978-1989`) |

### Which verbs act on which record

The two-record split (build 4): observations (`status` worn as `'noticed'` via
`observationAsGapRow`, `planner.ts:1045-1069`) vs asks (`nudges`, statuses
`pending`/`queued`/`asked` open). Today's matrix:

- **Observation only:** `dismiss`, `recover`.
- **Ask only:** `close`, `escalate`.
- **Both:** `send` (creates the ask on noticed; queues the relic pending), `hold` (different
  table, same meaning), `leave` (all stages but pending).

`hold`'s post-build-5 semantics, precisely: `not_before` is written on the row's own table,
unbounded (`:1667-1671` — the 18h clamp died with the delivery deadline), enforced by nothing (the
host pull `listQueuedNudgesForHost`, `nudges.ts:176-185`, never filters on it), read by exactly
two things — the gap view's "currently held until" line (`planner.ts:933`) and the alarm pass's
hold-exemptions (`watchers.ts:701-709,732`).

## Area 2 — the doctrine as written

### `PLANNER_SYSTEM` anatomy (`plannerPrompt.ts:20-279`), section order

1. **Identity** (`:21-24`): "You are the team lead inside a trades firm's record system… You produce a plan; the system applies it."
2. **WHAT A GAP ACTUALLY IS** (`:26-31`): a hole in the record, not an unanswered message.
3. **WHEN A MESSAGE GOES OUT IS YOURS** (`:33-43`): the no-send-window ruling as doctrine.
4. **The verb list** (`:45-57`): one line per verb, mechanism-described ("escalate — … handing over is what this action DOES, the moment you choose it").
5. **`leave` IS NOT THE DEFAULT** (`:59-63`): silence is recorded anyway.
6. **NOTHING HAPPENS ON ITS OWN** (`:65-69`): build 5's contract — no clocks, alarms only, "every gap needs an ENDING from you eventually."
7. **WHAT EACH ACTION CAN DO, AND WHEN** (`:71-88`): the per-state lines — `noticed` / `pending` / `queued` / `asked`, each enumerating its legal verbs. This is the "state machine as prose" the charter row targets.
8. **CLOSING IS YOURS** (`:90-92`) + **THE TWO WAYS A GAP CLOSES** (`:94-115`): basis record (THE RECORD line, money-as-fact) vs basis evidence (verbatim quote).
9. **HOW TO JUDGE AN ANSWER** (`:117-122`); **HOW TO PACE** (`:124-129`).
10. **WRITING THE QUESTION** (`:131-165`): grouped sends, sound-like-a-person, never mention the record system, dates only from the given strings.
11. **WRITING THE HANDOVER** (`:167-191`): two sentences, tell-the-truth-about-delivery ("never write 'we asked'"), never blame, dates verbatim, `agentContext`.
12. **WHEN TO GIVE UP** (`:193-202`): escalate as the last, irreversible act.
13. **YOUR MEMORY** (`:204-216`): recall_decisions doctrine; **YOUR OWN NOTES** (`:218-229`), **RECONCILE BEFORE YOU PLAN** (`:231-236`), **DO IT FROM THE INDEX** (`:238-241`), **IF NOTHING CONTRADICTS, CHANGE NOTHING** (`:243-245`), **YOUR NOTES ON A JOB** (`:247-258`).
14. **CONTEXT** (`:260-275`): spine_read views, escalation-fates self-check, "READING IS NOT CITING" (`:268-271`), **"Do not browse"** (`:272-273` — the exact instruction the rewrite draft targets, still present), never work out a date.
15. **Submit** (`:277-278`): call submit_plan once; omissions are recorded as considered.

Everything here is **hardcoded prose** — no section is data-driven. The only dynamic parts of the
planner's context live in the *user* message (`buildPlannerUserMessage`, `planner.ts:1740-1781`):
memory index first (cache reasoning in the comment `:1752-1760`), the last-run pair, the firm
clock line, then the gap blocks.

### What pins the doctrine's exact words

- `planner.test.ts:2639-2712` — four prompt-drift tests string-matching `PLANNER_SYSTEM`:
  `v_captures`/`v_nudges`/`v_review_items`/`join v_visits`/`never instructions to you`/`READING IS
  NOT CITING`/`escalated_from_nudge is`/not-`LESSONS`; the notes doctrine (`YOUR OWN NOTES`,
  `RECONCILE BEFORE YOU PLAN`, `the record is right and the note is behind`, `DO IT FROM THE
  INDEX`, `never as a routine sweep`, `IF NOTHING CONTRADICTS, CHANGE NOTHING`, `MEMORY.md is your
  INDEX`, `rides in every prompt`, `read_memory`, `write_memory`, `saving nothing deletes it`);
  the job-note paragraph (`YOUR NOTES ON A JOB`, `read_job_note`, `write_job_note`, `CANNOT be
  deleted, only replaced`); and `ORPHAN_FOOTER_PREFIX` code-prompt agreement (`:2710`).
- `planner.test.ts` carries ~207 `toContain` assertions overall; most pin the **gap-view block**
  and validate/refusal copy rather than the system prompt (e.g. `THE RECORD:` lines `:873`,
  money-block wording `:214-315`, `SHARED between` `:327`, the firm clock `:417-429`).
- `planner.test.ts:2866` pins schema enum == `PLANNER_ACTIONS`; `watchers.test.ts:1142` pins the
  judgment set; a validate test pins that `unmentioned` is never submittable.
- The **eval renders the real prompt**: `buildGapView`'s header (`planner.ts:779-784`) records
  that `src/eval/doctrine.ts` exists "because measuring a copy of a prompt measures a paraphrase" —
  though `doctrine.ts` itself extracts the **box agents'** AGENTS.md from bootstrap-box.sh, not
  the planner prompt; the planner-side equivalent is the exported `buildPlannerUserMessage` +
  `PLANNER_SYSTEM` used directly by plannerSim (`runTick` captures `userPrompt`).

A rewrite therefore has two classes of text: **pinned** (the strings above — tests break, and the
reads they steer are real mechanisms: the citation rail, the memory tools, recall), and **free**
(the pacing/judgment prose — sections 2, 5, 9, 12 — which nothing but the model consumes).

### The rewrite draft, and its drift

`thoughts/shared/design/2026-08-28-planner-doctrine-rewrite.md` (status: draft for review;
research: the harness audit). Structure: Why (the 2026-08-28 ruling + three user instructions:
suggestion-not-assignment, encourage search, the central-intelligence role) → the contradiction
(good map, "Do not browse") → three replacement texts (A: the opening, "You are the central
intelligence of a trades firm…"; B: the list framing, "WHAT YOU ARE SHOWN… a suggestion, not an
assignment"; C: navigation, "GO AND LOOK") → **What is NOT free** (widening citation to
turn-scoped spine_read captures — "a change to `validateDecisions` plus turn-scoped read capture —
real work, not a prompt edit") → What point 3 implies (`open_gap`; completeness-as-lesson) →
Addendum: the memory-as-.md-files design.

Where it has drifted from the branch (it predates builds 3, 4 and 5):

1. **The addendum is built.** Build 3 shipped `planner_memory` (+versions), the four tools, the
   index-in-prompt, and deleted `lessons.ts`/`reflector.ts` (both files gone). The addendum reads
   as a proposal for what now exists — including details that landed differently (no
   `list_memory`/`delete_memory` tools on the surface; deletion is write-empty, `identity.ts:37-57`).
2. **"`firm_fact`-typed lesson"** — typed lessons are dead; build 3 chose free-form .md files.
3. **"twelve views" at `server.ts:651`** — thirteen now (`server.ts:662-663`), `v_observations`
   added by build 4, and the citation rule it quotes is rule (5) at `:703-704` (still accurate).
4. **Targets still accurate:** the opening it replaces (`plannerPrompt.ts:21`), "Do not browse"
   (`:272-273`), the citation restriction (doctrine `:268-271` + catalog rule 5), none of which
   builds 3–5 touched. The list framing it adds does not exist (`buildPlannerUserMessage` says
   only "This firm has N open gap(s)").
5. **Not mentioned at all** (post-dates it): the seven-verb set (it was six + extend when
   written), the per-state lines, NOTHING HAPPENS ON ITS OWN, THE RECORD rail, the handover
   truth-telling rule, dismiss/recover, the memory/job-note/reconcile doctrine — i.e. roughly half
   of today's `PLANNER_SYSTEM` is younger than the draft that proposes to rewrite it.
6. **`open_gap`** — the draft derives it from point 3; the recorded build order files it under
   build 7 (§6a: "detectors report… `open_gap`"), while §6a's build-4 consequences note says
   "dismiss / recover / open-an-observation are intents the verb vocabulary must express" under
   build 6 (docs/engineering-memory.md:3725). The two records split the same capability across
   two builds — see Decision Points.

## Area 3 — intent→mechanism resolution ground

### The path from model output to DB write

```
PLANNER_SYSTEM + [TEAM_LEAD_TOOL_SCHEMAS, SUBMIT_PLAN_TOOL]     (lifecycle.ts:486-491)
        │  runToolLoop (toolLoop.ts:484): system+tools = the cacheable prefix
        ▼
model emits submit_plan{decisions:[{nudgeId, action, …}]}       (schema plannerPrompt.ts:287-385)
        │  executor callback (planner.ts:2534-2560)
        ▼
validateDecisions(args, views, nowMs, recoverable)              (planner.ts:1258)
        │  all-refused → throw back into the loop; model retries (:2547-2555)
        ▼
applyDecision per decision (live only)                          (planner.ts:1797)
        │  writes: nudges / observations / review_items
        ▼
recordNudgeDecisions(records)                                   (planner.ts:2770; nudgeDecisions.ts:74)
        └─ action stored VERBATIM: `action: d.action` (nudgeDecisions.ts:86) — string column, no enum
```

**The stored vocabulary IS the wire vocabulary.** `nudge_decisions.action` is a plain text column
(`NudgeDecisionInput.action: string`, `nudgeDecisions.ts:21`); whatever string validate accepts is
what history, alarms, metrics and recall read back forever. There is no translation layer anywhere
on the path today.

### Everything that reads stored action values back

- The alarm pass: `attentionActions = new Set([...PLANNER_JUDGMENT_ACTIONS, 'extend'])`
  (`watchers.ts:751`) — **historic verbs must stay readable**: an applied `extend` recorded before
  build 5 still counts as attention, a precedent any renamed verb inherits.
- `historyLine` (`planner.ts:706-744`): skips `UNMENTIONED`, prints `last: <action>` — the raw
  stored string reaches the next tick's prompt.
- `recall_decisions` (`server.ts:5570`; `listDecisionsForNudge` excludes `'unmentioned'` by
  literal, `nudgeDecisions.ts:207`).
- SQL literals in the metric views: `mv_escalation_fates` `d.action = 'escalate'`
  (migration 20260824020000:59); `mv_whiplash` `d.action not in ('unmentioned','leave')` (:81);
  `mv_extend_effectiveness` `d.action = 'extend'` (:128, now historic-only by construction).
- The corpus/graders (area 7) and `summary.byAction` (`planner.ts:2572` — keys are the raw
  strings; ridden into `lifecycle_runs.summary`; report.mjs aggregates counts without naming verbs).

### Schema/enum sites that must agree

`PLANNER_ACTIONS` (planner.ts:89) · the submit_plan enum (plannerPrompt.ts:302) ·
`PLANNER_JUDGMENT_ACTIONS` (watchers.ts:137) · the per-verb rails in validate ·
the per-verb cases in apply · the doctrine's verb list and state lines (plannerPrompt.ts:45-88) ·
the stored-string readers above. The first three are test-pinned to each other.

### Mechanism↔intent correspondence, factually

Against the memory-recorded candidate intents (`ask/wait/close/drop/note` — not in-repo, see
Summary):

| Mechanism verb today | Intent-side reading |
|---|---|
| `send` | `ask` — clean 1:1 (send already resolves to two mechanisms by stage: create-the-ask vs queue-the-relic — apply is already an intent resolver here) |
| `hold` | `wait`-with-a-time; `leave` on queued/asked is `wait`-without-one. Two mechanism verbs would fold into one intent, today split by stage rails (`hold` pending/noticed; `leave` everything but pending) |
| `close` | `close` — clean, with basis/citation as its qualifiers |
| `dismiss` | `drop` — revisable, observation-only today |
| `leave`-with-a-reason | `note`? ambiguous: `leave` is both "wait" and "record why I'm not acting"; the doctrine (`:59-63`) frames it as the reason-worth-remembering verb |
| `escalate` | no charter intent names it; it is `ask(manager)` under build 4's original phrasing (§6a row 4: "escalation becomes `ask(manager, …)` so a handed-over gap stays the planner's") — but build 5 implemented it as hand-off-and-leave-your-list (`markOutcome('escalated')`, doctrine "the gap leaves your list for good"). The two records disagree in spirit; the code is the build-5 shape |
| `recover` | no intent-side name in any record |
| *(missing)* | a pacing intent (extend's successor — build-5 inheritance, named at `planner.ts:85-88` and §6a:3760); an observation-handover intent (the escalate-on-noticed refusal names it, `planner.ts:1402-1403`); open-own-gap (build 6 or 7 — see Decision Points) |

### Where resolution could live (options, not recommendations)

- **Schema-side swap:** the enum and doctrine speak intents; validate maps intent+stage →
  mechanism before the rails run. Stored actions change vocabulary — every reader above (incl. the
  SQL literals and the alarm's historic-verb set) needs the old strings kept readable.
- **Apply-time mapping:** the enum keeps intents but `PlannerDecision.action` stays mechanism —
  validate translates on entry. Stored vocabulary stays stable; the doctrine and schema alone
  change; the wire and the record diverge (the record would say `send` where the model said `ask`).
- **Note:** validate already refuses-rather-than-translates by explicit doctrine
  (`planner.ts:1388-1392`: "Inventing a mapping from `hold` to some other write would be code
  doing the model's judgment for it"). An intent layer is a reversal of that stance and the audit
  (§"Two classes are fused here") records which rails are world-protecting vs lifecycle-protecting.

## Area 4 — citable-what-you-read

### What the planner's context contains

Per tick (`buildPlannerUserMessage`, `planner.ts:1740-1781`): the memory index (`MEMORY.md`
content ≤3000 chars + orphan footer `not in your index:` — `memory.ts:21,25,87`), the last-run
pair, the firm clock line, and one block per gap (`buildGapView`, `:886-1024`): id/kind/about/job
id/person/state/noticed/asked, the queued question (≤1450 chars), **THE RECORD** lines (cost
`:909-921`, moot `:922-932` — both stage-forked dismiss-vs-close), held-until, the date-label
menu, the history line, the job-note announcement, the shared-evidence warning, the evidence lines
(≤6 × ≤600 chars, channel + tech ref + `<-- LINKED TO THIS GAP` marker), the money block.

Beyond the push, the pull surface (`TEAM_LEAD_TOOLS`, `server.ts:1710+`): `spine_read` over
thirteen views, `recall_decisions`, `read_memory`/`write_memory`, `read_job_note`/`write_job_note`,
plus `get_customer_context`/`resolve_date` on the allowlist (`identity.ts:37-57`).

### The provenance that already exists

- **`evidenceCaptureIds`** (`planner.ts:649-659,831-833`): index-aligned with `evidenceText` — a
  verified citation names its own L1 capture without the model asserting anything, gated by
  `TECHNICIAN_SPOKEN_CHANNELS` (`:771-777`). This is the one live citation mechanism, and it is
  **view-scoped**: it exists only because the view builder held the capture rows.
- The citation check itself (`:1621-1634`): normalized substring match against **exactly the shown
  truncated text** — "a quote from unseen text would pass" is the recorded reason (`:368-372`).
- `answered_by_capture_id` (spine-side attribution at record time + close-time stamp) — defines
  `mv_gap_outcomes.closed_by_technician`.
- The three-layer spine's field→raw links exist in the DB (visits.source_capture_id — the
  note-to-job bridge the catalog teaches), and `v_captures` exposes L1 ids — but **nothing records
  what spine_read returned during a turn**. `ToolLoopCall` (`toolLoop.ts:173-180`) captures every
  tool result string on the loop result and plannerSim persists it for grading; production
  discards it after the tick (nothing writes `calls` anywhere durable).

### What blocks close-by-going-and-looking

Two co-located statements of the same rule: doctrine "READING IS NOT CITING… words you found
through spine_read, however relevant, will be refused as a citation" (`plannerPrompt.ts:268-271`)
and catalog rule (5) (`server.ts:703-704`). The rail that enforces it is the evidence-lines-only
match above. The draft's "What is NOT free" names the change shape: turn-scoped read capture +
`validateDecisions` accepting a citation found in what the turn actually returned. The pieces a
citation rail would bind to today: the per-call result strings already on `ToolLoopResult.calls`,
the `MAX_TOOL_RESULT_CHARS = 20_000` truncation (`toolLoop.ts:75` — quotes must match what was
*shown*, truncation note included), and `evidenceCaptureIds`' null-for-non-technician convention
(a spine_read row has no channel gate applied).

### What the planner asserts without having read

The known failure class (CL memory: context + vocabulary) is guarded piecewise today: dates
(TEMPORAL_RE against supplied labels, `:1101-1113`), delivery claims (the handover truth rule +
the pending/queued escalate copy), invented evidence (the citation rail). No general
assert-only-cited rule exists for `reason`, `handoffNote` content beyond dates, or memory writes
(`write_memory` has only the date rail and size caps, `memory.ts`).

## Area 5 — the observation record's verb gaps

What the planner can do to an observation today: `send` (creates the ask), `hold`, `leave`,
`dismiss`, `recover`. What it cannot:

- **`close`** — refused (`planner.ts:1370-1376`): "nobody was asked, so there is nothing to
  close… dismiss it." A filled-hole observation is dismissed (revisable), never terminal.
- **`escalate`** — refused (`:1399-1409`): "no handover path yet." The refusal copy itself names
  the gap: no nudges row exists to mark `'escalated'`, and `ObservationStatus` is only
  `open|dismissed|asked` (`observations.ts:19`) — there is no "the manager owns it" state. The
  code comment calls inventing one "build-6 vocabulary work."
- **Open its own** — no verb mints an observation. `createObservation` (`observations.ts:34`) is
  called only by the sweep's two detector passes (`watchers.ts:588,656`), and creation is
  deliberately registry-gated (`:570-572`: an unregistered kind's manager items could never
  self-clean). The planner *sees* every kind (the spec-registry filter died, `planner.ts:2243-2246`)
  but can only act on rows something else minted. What a planner-mint would meet: `kind` is typed
  `ReviewKind` (a compile-time union, `reviewItems.ts:10-62` — "new kinds must not need a
  migration" but the union is code); `uq_observations_subject_ever` dedup; the moot-fact reads
  filter non-uuid `subject_ref`s (`planner.ts:2368-2370` — a planner-named subject that isn't a
  uuid contributes no moot fact, silently); the item sweep iterates the registry, so a
  planner-opened kind's escalations would produce manager items nothing self-cleans (the exact
  constraint §6a records against build 5, resolved there by keeping creation registry-gated).

The escalate-vs-observation tension in records: §6a's build-4 notes say the planner may open its
own observation "and conduct an ask on it" (docs/engineering-memory.md:3714-3716) and file
dismiss/recover/open-an-observation under build 6 (:3725), while the build-order table gives
`open_gap` to build 7. The hard dependency recorded is only 6 < 7 (verbs before minting).

## Area 6 — frozen rows and pacing

### The freeze (build 5's vocabulary-less state)

A queued row freezes — is never served, never re-labelled — on four paths, all in
`nudgeQueue.ts`: leaderless group (`:126-133`), inactive/unbound technician (`:136-138`),
serve-cap `serve_count >= 10` (`:140-151`), attempts-cap `attempts >= 3` (`:155-161`); the box's
third failure report also just bumps attempts and logs "frozen" (`:241-254`). **No status change
anywhere** — a frozen row is `status='queued'` plus ledger columns past a threshold, visible only
as stderr lines and the `deliveryStuck` alarm (`watchers.ts:703-720`, which counts caps on queued
rows only and exempts `not_before`-held rows). The planner sees such a row as state "queued" with
its ledgers not shown (the gap view prints neither `serve_count` nor `attempts`), and the doctrine
tells it "one that has sat queued for HOURS means delivery is broken: escalate it" (`:81-84`).
"Frozen" exists as a word only in log strings and comments — the build-5 inheritance is exactly
this missing vocabulary.

### Pacing remnants

- `extend` is gone; `escalate_after` is a **dormant column**: production writers none
  (`setNudgeSchedule` keeps its `escalateAfter` arm, `nudges.ts:404-434`, but both live call
  sites pass `notBefore` only — `planner.ts:1931,1963`), readers are `v_nudges` (the catalog
  still lists it, `server.ts:708`), `mv_extend_effectiveness` (historic rows), and the eval
  seeders (`plannerSim.ts:288,351`; corpus worlds seed it as an authoring rail,
  `plannerCorpus.ts:143`).
- What a first-class pacing intent finds in place: `not_before` on both tables with guarded
  writers, hold-exempt alarms, the "currently held until" view line, send's stale-hold clearing.
  What is absent: any enforcement (a hold is "real because the planner honors its own note",
  §6a:3761-3762), any pacing verb legal on an **asked** row (waiting there is `leave` or
  silence), and any horizon the record can distinguish from neglect (the `asksUnattended` alarm
  counts a deliberately-paced asked gap unless a judgment verb was applied within 24h — `leave`
  counts, so the planner's pacing tool on asked gaps is periodic `leave`).

## Area 7 — the couplings

- **Corpus** (`plannerCorpus.ts`): expectations name verbs as strings — counted on this branch:
  `action:` close×9, escalate×10, **extend×7**, leave×1, send×4, unmentioned×2; `actionNot:`
  close×8, escalate×14, extend×1, send×1. The 7 `action:'extend'` expectations are **unsatisfiable
  live** (extend is refused as unknown; `actionNot` grading counts a refused attempt as failure
  too — `plannerCorpus.ts:63-68`), the mis-grades accepted under deferred re-levelling. Extend
  also appears in seeded history rows (`:361,541,567,600,958`) and world `escalateAfter`s — those
  seed fine (the sim writes rows directly). `npm test` stays green because
  `plannerCorpus.test.ts` checks only shape/monotonicity/seedability (its :69 family still
  asserts deadlines outlast scripted ticks; :98's comment still cites the dead
  `NUDGE_ESCALATE_MAX_HOURS`); the expectations are graded only by the key-gated live runner
  (`scripts/agentic-eval/run.mjs`).
- **Graders** (`plannerEvalGraders2.ts`): pure over the results row; verb-sequence logic includes
  the extend-after-escalate whiplash check (`:251-254`). `runArc`'s recorded caveats stand: the
  graders never read review_items, and manager resolved-vs-dismissed is observable nowhere
  (`plannerSim.ts:788-802,910-921`).
- **Sim** (`plannerSim.ts`): drives production `runWatchers`+`runPlanner`; `deliver` flips
  pending/queued→asked directly (`:859-876`); `manager_resolve` finds items via
  `detail->>escalatedFromNudge` (`:877-906`) — build 5's escalate keeps writing that key, so this
  step still works.
- **Tests pinning verbs/doctrine**: `watchers.test.ts:1142` (judgment set == verb list),
  `planner.test.ts:2866` (schema enum == verb list), the doctrine-string family
  (`planner.test.ts:2639-2712`), ~207 `toContain`s across planner.test.ts on view/refusal copy,
  and the alarm-family tests in watchers.test.ts (`:973+`) asserting attention semantics per verb
  (leave counts on asks, not on observations).
- **Report** (`scripts/ticks/report.mjs`): prints alarm counts (`:417-445`, absent ≠ zero,
  partial = floor) and per-firm decision **counts** (`:340-355`) — it never names verbs, so a
  vocabulary change does not touch it; `summary.byAction` keys ride raw into
  `lifecycle_runs.summary`.
- **Metric views**: `mv_escalation_fates.by_planner` = exists applied `action='escalate'`;
  `mv_whiplash` excludes `('unmentioned','leave')`; `mv_extend_effectiveness` keys
  `action='extend'`. SQL literals — a renamed wire vocabulary either keeps writing these strings
  (apply-time mapping) or the views need forward-compatible predicates plus historic literals.
- **Caching**: on the OpenRouter path the cacheable prefix is system + tool schemas
  (`openAiTransport` sends system as message[0] + `cacheKeyFields()`, `toolLoop.ts:362-393`;
  measured 2026-08-30: prefix ≈ 6,080 tokens, cross-tick hits intermittent). On the Anthropic
  rollback path the prefix is explicit (`cache_control` 1h TTL on the system block,
  `:295-304`). Provider caches key on the byte-identical prefix, so **any doctrine or schema
  edit invalidates the whole prefix** — a one-time cold write per provider after each deploy of a
  rewrite, plus 2× write pricing on the Anthropic path; steady-state economics return once the
  new prefix warms. The user-message head (memory index first, `planner.ts:1752-1761`) is
  positioned for the same reason and a list-framing block added above the gaps would sit in the
  variable tail regardless.

## External Dependencies

OpenRouter (GLM 5.3 pinned; `openrouter-routing-mechanics` memory) / Anthropic as rollback —
both consume the system+schema prefix described above. Supabase/PostgREST for every store named.
No new external service is implicated by build 6.

## Constraints and Invariants

- Stored `nudge_decisions.action` strings are **forever**: insert-only table, read back into
  prompts, alarms and SQL views; `'extend'` already demonstrates the historic-verb pattern
  (`watchers.ts:747-751`).
- Three test-pinned equalities: schema enum == `PLANNER_ACTIONS` == `PLANNER_JUDGMENT_ACTIONS`;
  `unmentioned` submittable never, attention never.
- `UNMENTIONED` must stay non-submittable, or chosen-silence and observed-silence collapse
  (`planner.ts:100-110`).
- Validate builds its own checked objects field by field — nothing model-supplied passes through
  unexamined (`mootClose` is the exemplar).
- The dispatch gate: `spine:team-lead` may dispatch only `TEAM_LEAD_TOOL_NAMES`; writes admitted
  so far are versioned-and-internal only (`identity.ts` header). An `open_gap`-style verb was
  pre-argued as passing ("internal and reversible", §6a:3726-3728) — but as a submit_plan action
  it would go through applyDecision, not the gate.
- Escalate's subject dedup is once-ever **per (tenant, kind, subject_ref)** (`flagNudgeGap`,
  `reviewItems.ts:164-172`) — any intent layer keeps meeting the settled-subject refusal
  (`planner.ts:2025-2035`).
- Doc-drift found while reading (record, don't act): §6a entry 5 states the record-basis chain as
  `recordFilled ?? moneyOnRecord ?? mootFact` and `EVIDENCE_FLOOR_MAX_DAYS = 30`
  (docs/engineering-memory.md:3766-3770); the shipped code is `recordFilled ?? mootFact ??
  moneyOnRecord` (`planner.ts:1588`, moot outranks money — final-review change) and `365`
  (`planner.ts:384`). Two stale sentences in the same branch's own record.

## Decision Points

1. **What the intent vocabulary actually is.** `ask/wait/close/drop/note` is session memory, not
   a repo ruling; the repo says only "the list becomes a SUGGESTION, not a state machine." The
   mapping table (area 3) shows: send/close/dismiss map 1:1; hold+leave fold into one wait-shaped
   intent or stay two; escalate is either `ask(manager)` (build 4's phrasing — the gap stays the
   planner's) or hand-off-and-done (build 5's implementation — it leaves the list for good);
   recover and the three missing intents (pacing, observation handover, open-own) have no
   recorded names.
2. **Where resolution lives.** Schema-side (wire and record change vocabulary; every stored-string
   reader and SQL literal needs both vocabularies readable) vs apply-time (record keeps mechanism
   strings; wire diverges from the record). The alarm's historic-`extend` handling is the existing
   pattern for surviving either.
3. **What the doctrine rewrite must keep vs may rewrite.** Pinned: the read-surface strings, the
   memory/reconcile/job-note doctrine, the orphan-footer literal, the verb enum agreement, and
   every mechanism the prose steers that code enforces (citation rail, date rail, group rails).
   Free: identity/opening, list framing, pacing prose, "Do not browse." The per-state lines
   (`:71-88`) sit in between — they describe rails that exist; rewriting them without changing the
   rails changes only wording, changing the rails is verb work.
4. **Citable-what-you-read's binding point.** The turn's tool results already exist as strings on
   `ToolLoopResult.calls`; a citation widened to them needs turn-scoped capture into validate
   (which currently sees only `views`), a decision on capture-id attribution for spine_read rows
   (no channel gate there — `closed_by_technician` semantics at stake), and reconciling the two
   co-located reading-is-not-citing texts (doctrine + catalog rule 5) with their pin tests.
5. **Which inheritances are build-6 verb work vs build-7 minting work.** Recorded: pacing intent —
   build 6 (`planner.ts:85-88`, §6a:3760); observation handover — build 6 (`planner.ts:1402-1403`);
   dismiss/recover/open-an-observation "intents the vocabulary must express" — build 6
   (§6a:3725); but `open_gap` itself — build 7 (§6a table row 7). Whether build 6 names
   open-own-gap without building the mint, or defers the name too, is unrecorded.
6. **The frozen-row vocabulary.** Today "frozen" = queued + ledger thresholds, log-only. Options
   the code shapes: a real status (touches `NudgeStatus`, the CHECK, the host pull's queued-only
   reads, the alarm's cap tests), a view-line fact (the THE RECORD pattern — planner-visible,
   no schema change), or doctrine-only (the current "sat queued for HOURS" heuristic; the ledgers
   aren't shown, so the planner cannot distinguish frozen from slow today).
7. **Eval re-grading scope (deferred — document only).** The 7 `action:'extend'` expectations and
   the extend-seeded histories/escalateAfter rails; grader whiplash sequences naming extend; the
   corpus-authoring rails that reference dead clock constants in comments. All live-runner-only;
   `npm test` is insulated.

## Open Questions

- Does the user's intent vocabulary match the memory's five, and which of hold/leave folds?
- Is escalate's intent-form `ask(manager)` (gap stays on the list) — reversing build 5's
  leaves-your-list-for-good doctrine — or a renamed handover? The two prior records point opposite
  ways and only the user can rule.
- Should the wire vocabulary reach the stored record (schema-side) at all, given the SQL/report
  literals and the insert-only history?
- For citation widening: do spine_read-sourced citations stamp `answered_by_capture_id` (they can
  name L1 ids the view never showed), or is the stamp view-scoped forever?
- Does the intent layer keep validate's refuse-don't-translate stance for stage mismatches (an
  `ask` on an asked gap), or translate (to a re-ask that `uq_nudges_subject_ever` structurally
  forbids)?
