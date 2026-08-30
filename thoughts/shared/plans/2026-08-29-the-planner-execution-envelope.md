---
date: 2026-08-29
task: Build 1b — the planner's execution envelope: the clock becomes the only rail
research: thoughts/shared/research/2026-08-29-the-planner-runs-on-a-clock-it-cannot-see.md
status: draft
supersedes: nothing
---

**On `supersedes`.** This plan overturns nothing, but it **corrects** one claim in its own research
doc — decision point 3, "reading `outcome` in the catch would convert total loss into partial
application." That is false, and the correction is Phase 3's job (see Decisions). The research
document stands otherwise.

## Overview

Each firm's planning conversation runs under two ceilings: a 90-second wall clock and an 8-turn
limit on model calls. Hitting either throws away the entire tick. Measured GLM 5.3 ticks on the
pilot (12.2 s and 16.2 s, 2 turns each) show the **turn ceiling binds first** — at ~5–9 s per turn
the loop stops after ~64 s, having never reached the clock. So raising the clock alone changes
nothing about what the planner can accomplish.

This plan makes **wall-clock time the only rail**: the budget rises to 15 minutes, the planner opts
out of the turn ceiling entirely, and the turns-per-tick distribution gets reported so the question
"does it need a ceiling at all?" can be answered from evidence rather than guessed at now.

## Decisions

- **The clock: 90 s → 15 min** — user ruling 2026-08-29: *"Planner model calls occur 30 minutes at
  a time, so it's ok if it does something truly long horizon… I would try to keep it within 15
  minutes or so for now."* A safety bound, not a target. Verified safe against the platform: Render
  stops a cron run only after **12 hours**, and an overrunning run causes Render to *delay* the next
  firing, not drop it ([render.com/docs/cronjobs](https://render.com/docs/cronjobs)).
- **The turn ceiling: removed for the planner** — user choice. Options were 24 turns, 40 turns,
  leave at 8, or no ceiling; the user chose no ceiling *"and then we can evaluate the planner's
  behavior to see if it needs a ceiling at all."* Implemented as an explicit per-caller opt-out
  (`maxTurns: null`), **not** by deleting `MAX_TOOL_LOOP_TURNS` — the default rail stays for any
  future caller, and the opt-out is greppable.
- **Runaway ticks: measured, not policed** — user choice. No skip-the-next-tick rule, no
  shrink-the-work rule. `scripts/ticks/report.mjs` gains the turns/duration distribution instead.
  The two rules considered are recorded here so the evaluation phase can reach for them if the
  numbers call for it.
- **The model is NOT told its remaining time** — user choice: wait for build 6, where doctrine is
  rewritten anyway, rather than editing `PLANNER_SYSTEM` twice.
- **CORRECTION to the research doc (decision point 3): there is no partial plan to rescue.**
  `submit_plan` is the loop's terminal tool ([toolLoop.ts:538](../../../src/model/toolLoop.ts)), so
  a successful submission **returns the loop immediately** and cannot then hit a limit. The one path
  that records a submission and keeps running is
  [planner.ts:1909](../../../src/teamLead/planner.ts) — a submission where *every* decision was
  refused by the rails — and there `outcome.decisions` is empty by definition. So `outcome` at throw
  time is always either empty or empty-plus-refusals. What a limit throw destroys is the model's
  *reasoning*, which only ever existed in the message array. No catch-block change can reach it.
  Phase 3 amends the research doc in place.
- **The eval harness pins its own budget** (implementation detail, decided here): `plannerSim`'s
  `wrapLoop` passes `budgetMs: EVAL_LOOP_BUDGET_MS = 120_000`. Without this, every eval scenario
  inherits the 15-minute production budget and one stalled provider costs a quarter-hour per
  scenario. The divergence from production is deliberate and commented.
- **Context exhaustion becomes the de-facto ceiling, and that is accepted.** With no turn limit the
  worst case is ~128 turns × up to 8 tool results × `MAX_TOOL_RESULT_CHARS` (20 000 chars ≈ 5 k
  tokens) — which can exceed GLM 5.3's 1 310 720-token context
  ([openrouter.ai/z-ai/glm-5.3](https://openrouter.ai/z-ai/glm-5.3)). It surfaces as a provider
  error caught by the per-tenant catch (`tenantErrors`), with a different signature from a
  `limitHits.budget` throw. Not built against; named so the evaluation phase recognises it. Note
  this figure is **model-dependent** — the point of OpenRouter is switching models, and a
  128 k-context model would hit it far sooner.

## Plain-language walkthrough

**Phase 1 — the stopwatch replaces the turn counter.** Today the planner is stopped by two things:
a 90-second stopwatch, and a rule that it may only "think" 8 times (one *turn* = one model call plus
whatever database reads it asks for). Real measurements say the 8-thought rule always fires first,
so the stopwatch has never actually done anything. This phase raises the stopwatch to 15 minutes and
lets a caller say "no thought limit for me — just the stopwatch." Nothing else in the codebase reads
these settings: the four other model callers use a different function entirely.

```
BEFORE                                   AFTER
 ┌ 90s stopwatch ──────────┐              ┌ 15-minute stopwatch ─────────────┐
 │ turn 1 ~8s              │              │ turn 1 ~8s                       │
 │ turn 2 ~7s   ← real     │              │ turn 2 ~7s   ← real ticks end    │
 │ …            ticks end  │              │ …              here today        │
 │ turn 8  ◄─ STOPS, 64s   │              │ turn 9, 10, … no limit           │
 └─────────────────────────┘              │ …                                │
   stopwatch never reached                └── STOPS only when time runs out ─┘
```

**Phase 2 — the planner takes the opt-out; the eval keeps a shorter leash.** The planner declares
"no turn limit." The eval harness, which replays scenarios against a real model, pins itself to two
minutes — otherwise a single stuck scenario would hold an eval run for fifteen.

**Phase 3 — make the behaviour visible.** The tick report currently prints *total* turns across all
ticks, which hides exactly what we now need: how long the longest tick ran and how many thoughts it
took. This phase reports the middle and the maximum for both, so "does the planner need a ceiling?"
becomes a number you can read. It also fixes a wrong comment about Render's cron behaviour and
corrects the research doc's mistaken claim about rescuing partial plans.

## Secrets & env preflight

- **Phase 1:** none
- **Phase 2:** none
- **Phase 3:** none — `npm run ticks` reads `.env` (the pilot) for a **read-only** report; already
  required, nothing new.

## Phase 1: The clock becomes the only rail

### What this phase does

Raises `MAX_TOOL_LOOP_BUDGET_MS` to 15 minutes and adds an explicit, documented way for a caller to
run with no turn ceiling. `MAX_TOOL_LOOP_TURNS` survives as the default for callers that say
nothing.

### Changes required

**`src/model/toolLoop.ts`**

- `MAX_TOOL_LOOP_BUDGET_MS`: `90_000` → `900_000`. **Rewrite the comment** — its current
  justification ("8 turns leaves ~11s each") is derived from the turn ceiling and dies with it.
  The replacement must state: this is now the *only* rail; the measured GLM 5.3 per-turn latency
  (5–9 s, pilot ticks 2026-08-29T17:30Z and 18:00Z); the user's 15-minute ruling; and that Render's
  own limits are 12 hours / delayed-not-dropped firings, so the platform is not the constraint.
- `MAX_TOOL_LOOP_TURNS`: value unchanged at `8`. Amend the comment: it is now the **default for
  callers that do not opt out**, no longer a ceiling nobody can raise.
- `ToolLoopRequest.maxTurns`: `number | undefined` → `number | null | undefined`, with a doc comment:
  `undefined` = the default ceiling, a number = a lower one (still clamped), `null` = **no turn
  ceiling; the budget is the only rail**.
- Line 436 becomes:
  ```ts
  // `null` is the planner's explicit opt-out (build 1b): time is the only rail,
  // and the turn count is the caller's business. A NUMBER is still clamped —
  // a caller may only ever ask for LESS than the default.
  const maxTurns =
    req.maxTurns === null
      ? Number.POSITIVE_INFINITY
      : Math.min(req.maxTurns ?? MAX_TOOL_LOOP_TURNS, MAX_TOOL_LOOP_TURNS);
  ```
  `turns >= Number.POSITIVE_INFINITY` is never true, so the throw at line 448 becomes unreachable
  for an opted-out caller without any change to the check itself.
- `budgetMs` clamp at line 437: **unchanged**. The budget stays hard-clamped — it is the rail now,
  and no caller may raise it.

### Automated verification

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] new test in `src/model/toolLoop.test.ts`: a loop with `maxTurns: null` completes a run that
      takes **more than 8 turns** (stub the transport to call a tool 10 times, then answer) — proves
      the ceiling is genuinely gone, not merely raised
- [ ] new test in `src/model/toolLoop.test.ts`: a loop with `maxTurns: null` and a small `budgetMs`
      still throws `ToolLoopLimitError('budget')` — proves the clock still bites
- [ ] existing test: a loop with no `maxTurns` still throws `ToolLoopLimitError('turns')` at 8
      (the default rail is intact for other callers) — confirm it survives unchanged
- [ ] new test: `maxTurns: 3` is still honoured and still clamped (asking for 100 yields 8)

### Live verification (agent-executable)

- Prerequisites: none — this phase changes only in-process constants and control flow, and the
  harness rebuild does not reach the pilot until the whole build order is evaluated (user ruling
  2026-08-29). Live behaviour is exercised by the eval harness in Phase 2 and by the build order's
  final evaluation phase.

### Manual verification

- none

---
*No manual items — continue to Phase 2 once the automated checks pass.*

## Phase 2: The planner opts out; the eval keeps a shorter leash

### What this phase does

Wires the opt-out to its one production caller, and stops the eval harness inheriting a 15-minute
budget per scenario.

### Changes required

**`src/teamLead/planner.ts`**

- In the `runLoop({...})` request at line 1885, add `maxTurns: null` with a comment recording the
  user's ruling: the planner may think as long as it needs to inside the clock, and whether it needs
  a ceiling at all is a question for the evaluation phase, not an assumption baked in now.
- `PlannerSummary.limitHits` keeps **both** keys. `turns` becomes structurally unreachable for the
  planner and must stay in the shape anyway: `lifecycle.test.ts:435` and `:841` assert the object,
  it rides into `lifecycle_runs.summary` untouched by `redactForRecord`, and the two limits still call
  for opposite responses if a future caller keeps the default. Add a one-line comment saying so, or
  the next reader deletes it as dead. (`scripts/ticks/report.mjs` does NOT read it — an earlier draft
  of this plan claimed it did, and the Phase 2 review caught the false claim propagating into a code
  comment. A justification the next reader can disprove is worse than none.)

**`src/eval/plannerSim.ts`**

- Add near the other module constants:
  ```ts
  // The eval does NOT inherit production's 15-minute budget (build 1b). A
  // corpus run replays many scenarios against a real provider, and one stalled
  // call would hold the run for a quarter-hour. Deliberately divergent from
  // production, and short enough that a scenario needing more than this is
  // itself the finding.
  export const EVAL_LOOP_BUDGET_MS = 120_000;
  ```
- In `wrapLoop` (declared line 459), change the `inner(...)` call at **line 480** to pass the override: `inner({ ...req, budgetMs: EVAL_LOOP_BUDGET_MS }, tools, spyExecute, ctx, loopDeps)`.
  Leave `maxTurns` alone — the eval must reproduce production's *turn* behaviour, which is now
  unbounded; it is the *clock* that differs.

### Automated verification

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] new test in `src/teamLead/planner.test.ts`: the request handed to `runLoop` carries
      `maxTurns: null` (assert on the stubbed `runLoop`'s first argument) — locks the opt-out in, so
      a future edit cannot silently restore the ceiling
- [ ] new test in `src/eval/plannerSim.test.ts`: the request reaching `inner` carries
      `budgetMs: EVAL_LOOP_BUDGET_MS` — locks the eval's shorter leash in
- [ ] existing `planner.test.ts:1581-1588` limit-hit assertions still pass unchanged (they stub
      `runLoop` and throw directly, so they do not depend on the real ceilings)

### Live verification (agent-executable)

- Prerequisites: none, for the reason given in Phase 1. `scripts/agentic-eval/run.mjs` exercises
  this path against a real model and is run in the build order's evaluation phase, not here.

### Manual verification

- none

---
*No manual items — continue to Phase 3 once the automated checks pass.*

## Phase 3: Make the behaviour measurable, and fix the record

### What this phase does

Replaces summed turn counts in the tick report with the distribution that actually answers "does the
planner need a ceiling?", and corrects two written claims that are now known to be wrong.

### Changes required

**`scripts/ticks/report.mjs`**

- The per-firm accumulator (line 240) currently sums `turns`, `toolCalls` and `ms`. A sum cannot
  answer the question this build exists to ask. Collect the per-tick values as arrays alongside the
  existing totals — `turnsEach: []`, `msEach: []` — pushing only for `planned` outcomes (an
  `off_cadence` or `no_gaps` tick contributes a meaningless zero and would drag every percentile
  down).
- Add a small local `pct(sorted, q)` helper (nearest-rank; no dependency).
- Extend the `if (f.planned > 0)` output block (line 286) with a second line:
  ```
      turns p50 <n> / max <n> · duration p50 <n.n>s / max <n.n>s   (<n> planned ticks)
  ```
- Keep the existing decisions/turns/tool-calls totals line — it is what the historical reports show,
  and changing both at once makes the record discontinuous.

**`src/jobs/lifecycle.ts`**

- The comment at line 653 states *"Render runs at most one lifecycle cron at a time and SKIPS an
  overlapping firing."* Render's documentation says it **delays** the next scheduled run until the
  active one finishes, and stops a run only after 12 hours
  ([render.com/docs/cronjobs](https://render.com/docs/cronjobs)). Correct the wording, cite the URL,
  and record why the practical effect is unchanged: a delayed firing lands on an off-grid minute, and
  `plannerCadenceDue` (`minutesSinceMidnight % everyMinutes < 5`) will not call it due — so the
  planner's slot is missed either way. The reasoning this comment supports is sound; only its
  mechanism was wrong.

**`thoughts/shared/research/2026-08-29-the-planner-runs-on-a-clock-it-cannot-see.md`**

- Amend decision point 3 in place with a dated correction naming this plan: a submitted plan cannot
  survive a later throw because `submit_plan` is terminal, and `outcome` at throw time holds no
  decisions. Amend the "Constraints and invariants" bullet *"Whatever replaces the hard discard must
  not let a half-applied plan look like a whole one"* — the premise is void.
- Amend the **firm-count table**: its "firings skipped" column rests on the same wrong Render
  mechanism, and its arithmetic assumed a 15-minute cap that is now real. Restate with *delayed*.

**`docs/engineering-memory.md`**

- In §6a (the harness rebuild build order), mark build 1b as built and record the envelope in one
  entry: time is the only rail at 15 minutes, the planner has no turn ceiling, runaways are measured
  rather than policed, and the evaluation phase owns the question of whether a ceiling returns.

### Automated verification

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] `npm run ticks` runs against the pilot's 90-day record and prints the new distribution line
      with plausible values (read-only; ~2 planned GLM ticks exist as of 2026-08-29T18:00Z, so
      expect p50 ≈ max ≈ 2 turns, ~12–16 s)
- [ ] `npm run decisions:index` regenerated and committed with the document changes

### Live verification (agent-executable)

- Prerequisites: `.env` with the pilot's read credentials (already required by `npm run ticks`).
- [ ] `npm run ticks` output shows the new `turns p50 / max · duration p50 / max` line for the pilot
      tenant, and the numbers agree with `lifecycle_runs.summary->teamLeadPlanner->plans` read
      directly via SQL — cross-channel read-back, capture both outputs as evidence

### Manual verification

- none

---
*No manual items — the plan is complete when Phase 3's checks pass.*
