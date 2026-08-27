---
date: 2026-08-26
task: Give the planner a seventh verb — `decline`: don't ask this person, hand it to a manager now
research: thoughts/shared/research/2026-08-26-the-decline-verb.md
status: draft
supersedes: nothing
---

**`supersedes:` note.** Overturns nothing. It closes accepted gap (a) from
`thoughts/shared/plans/2026-08-24-one-call-collapse.md` — the capability that died with compose's
`ask:false` path and was recorded as owed. Two of the research doc's *Open Questions* are answered
here rather than in a new research pass (`cancelled` **is** already written, by the moot path at
`watchers.ts:740`; the 18h expiry writes **`failed`**, not `cancelled`), and one of its stated
constraints is corrected: adding a verb needs a **migration**, not only code.

## Overview

A `pending` nudge is a gap nobody has been contacted about. The planner sees it twice an hour and
picks one of six verbs. None of them means *"this should not be asked of this person at all."* So a
gap the planner correctly judged un-askable at 10:00 AM sits untouched until the 18-hour delivery
deadline hands it to the manager labelled **"never delivered"** — neglect-shaped, 18 hours late,
for what was a sound decision made immediately.

This plan adds `decline`: the planner hands the gap to the manager **now**, in its own words, and
closes the row with an audit line that says a decision was made.

## Decisions

- **The manager reads the planner's own sentence** *(user, 2026-08-26)* — options were (a) reuse
  the timeout template unchanged, (b) template + an assistant-only briefing, (c) the planner writes
  the line. Chose (c) **plus** the briefing. It costs almost nothing because
  `suggestion: ctx?.plannerNote ?? template` is already how an escalation works
  (`nudgeKinds.ts:352`, ratified by the user 2026-08-22) — this points the same mechanism at the
  `'expired'` branch. No new handoff mode, no new templates. If the model writes no note, the
  template still prints, so the path cannot break.
- **The row closes as the EXISTING `cancelled`, not a new status** *(user, 2026-08-26 — reversing
  an earlier call in this same session)*. I first recommended a new `declined` status, partly on a
  claim that turned out to be false: that `mv_gap_outcomes` would file declines under `abandoned`.
  It would not — `20260824020000_planner_metrics_v2.sql:31-35` replaced that view, and its bucket
  arm reads *"escalated **or** a citing `review_items` row exists"*, which a gated decline always
  satisfies. With the false reason removed the user chose the cheaper path. **What reuse costs, and
  it is real:** `cancelled` also means *"the visit was cancelled — nothing left to ask"*, so the two
  are told apart by a **compound** test rather than by the status alone — `cancelled` **and** a
  review item citing this nudge. That test is sound because the moot path
  (`watchers.ts:738-744`) flags no item at all, and no path both flags and moots the same row. It
  is written into every consumer below rather than left to be rediscovered.
- **`pending` rows only** *(user, 2026-08-26)* — refused on `queued`/`asked`, mirroring the
  existing `send`/`hold` rail. Declining a queued row would need a real un-queue path. Confirmed
  safe with respect to ask-groups: `ask_group_id` is written only by `markNudgeGroupQueued`
  (`src/db/nudges.ts:244`) at queue time, so a `pending` row never carries one.
- **The close IS gated on the handover landing** *(implementation call)* — the historical path
  deliberately closed regardless, with a recorded reason: a row too thin to hand over would be
  re-composed, re-billing a model call every tick. **That reason died with compose.** The planner
  now runs regardless, so a re-declined row costs nothing extra, and gating removes the orphan risk
  the terminal-failure doctrine forbids. A failed handover records `refused` and leaves the row
  `pending` — its 18h expiry is unchanged, so there is no new stuck state. **Gating is now
  load-bearing twice over:** it is also what makes "a citing item exists" a reliable decline test.
- **The row's `resolution` is CODE-written, not the model's `reason`** *(implementation call,
  corrected in review)* — the first draft wrote `d.reason` there. `reason` is declared
  *"Diagnostic … NEVER shown to a manager"* (`planner.ts:103-105`), putting it in front of a manager
  was the recorded 2026-08-21 mistake (`watchers.ts:1004-1006`, pinned at `watchers.test.ts:1903`),
  and `nudges.resolution` **is** manager-readable — a column of `v_nudges`, catalogued at
  `src/mcp/server.ts:696` and served by the manager-tier `query_spine`. Use
  `'declined — handed to the manager'`, matching `'no reply — handed to the manager'` and
  `'never delivered — handed to the manager'`. Under status reuse this string is also the
  human-readable half of the decline/moot distinction. The model's words live in
  `nudge_decisions.reason` and `handoff_note`, both already stored.
- **`handoffNote` and `agentContext` stay optional** *(implementation call)* — exactly as for
  `escalate`, which requires neither. A required note would turn a sound judgment into a rail
  refusal over copy.
- **`mv_whiplash` is left alone** *(implementation call)* — its filter is negative
  (`action not in ('unmentioned','leave')`), so a decline is included automatically, which is right:
  `leave` is excluded as "watching, not a position", and a decline **is** a position.
- **The scenario joins `people-judgment`** *(implementation call)* — `PJ-01` is the same judgment on
  an *asked* row; a decline case is its pre-ask twin. `FAMILY_COUNTS` 8 → 9, total 66 → 67.

## Plain-language walkthrough

Ben already told us *"Dave covered the Holloway call, I was never on site."* Asking Ben to write up
that visit is pointless. Today the system asks anyway — or rather, it waits 18 hours and then tells
the manager the question was never delivered.

```
TODAY     planner knows 10:00 AM ─── 18 hours of nothing ───► manager, 4:00 AM
               (can't say it)                                  "never delivered"

AFTER     planner knows 10:00 AM ──► manager, 10:00 AM
                                      "Ben says Dave covered this one — worth
                                       checking with Dave."
```

**Phase 1** prepares the manager's side of the system, and nothing else. Two small things: the
reporting view learns that a closed-as-cancelled gap **with** a manager item is a handover worth
counting, and a hand-over gains the ability to carry a sentence written by the planner. Nothing
uses either yet. You'd notice it working in unit tests: given a sentence the item prints the
sentence; given none it prints today's wording, byte for byte.

**Phase 2** is the verb itself. The planner can now choose `decline` on a gap that hasn't gone out;
code hands it to the manager, then closes it. You'd notice it working when a real gap reaches the
manager's queue in minutes rather than the next morning, with a sentence that reads like a decision.

**Phase 3 is not optional.** Phase 2 opens a hole in our test corpus: four existing scenarios say
*"do not escalate this gap"*, and once `decline` exists the model can satisfy all four by
declining — which also puts the gap in the manager's queue, the exact thing those scenarios forbid.
Phase 3 teaches the grader that both verbs are handovers, and adds the scenario that pins the new
behaviour.

```
 pending gap ──► planner picks `decline`
                        │
                        ├─(1)─► handToManager(gap, {plannerNote, agentContext})
                        │          └─► review_items row · manager's queue
                        │
                        └─(2)─► only if (1) landed:
                                   status     = 'cancelled'
                                   resolution = 'declined — handed to the manager'

 how anything tells a decline from a cancelled visit:
   status 'cancelled' AND a review_items row citing this nudge   (moot flags none)
```

## Secrets & env preflight

- **Phase 1:** none. Local stack only (`.env.test`, already required).
- **Phase 2:** none new. Live verification reads `PLANNER_MODE` / `WATCHERS_MODE` on the pilot's
  `lifecycle-heart` cron — both already set.
- **Phase 3:** none for the codified tests. The optional live-model eval run needs
  `OPENROUTER_API_KEY` in `.env` (already required; absent in a fresh worktree, where those tests
  skip).

**Hard ordering constraint:** Phase 2's migration must reach the pilot **before** the code that
writes `'decline'`. Render deploys run no migrations (`docs/engineering-memory.md`, 2026-08-23), and
`recordNudgeDecisions` inserts one statement per chunk with **no partial insert** — one un-migrated
`'decline'` rejects up to 500 decisions at once (the reason `extend` and `leave` each shipped a
migration first). Applying to the pilot is a separate, explicitly-authorised step; do not fold it
into a code phase.

## Phase 1: The manager's side learns what a decline is

### What this phase does
Two independent, inert preparations. The handover telemetry learns to count a
`cancelled`-with-an-item gap as a manager handover, and `handToManager` gains the ability to carry
the planner's sentence and briefing. Nothing writes a decline yet, so both are provably unused.

### Changes required

**`supabase/migrations/20260826180000_decline_handoff_telemetry.sql`** (new)
- **Build from `20260824020000_planner_metrics_v2.sql`, NOT from
  `20260823230000_planner_metrics_views.sql`** — v2 replaced both view definitions, and a
  `create or replace` regenerated from v1 would silently revert the landed expiry-path fix and fail
  `src/db/plannerMetrics.test.ts:253`.
- `create or replace view mv_escalation_fates` — replace, not drop, so the existing
  `revoke … from anon, authenticated` survives. Add a third arm to the `where` at `:69-73`:
  `or (n.status = 'cancelled' and exists (… citing item …))`. Without it every decline is invisible
  to the fates telemetry — no `fate`, no `premature` — which is precisely the telemetry that would
  answer "is this verb working". `handoff_kind` is `n.status` (`:61`); the header must record that
  `'cancelled'` there means a decline, because the moot path flags no item and so never enters.
- Same view: widen `by_planner` (`:58-60`) to `d.action in ('escalate', 'decline')`. A decline **is**
  planner-driven; leaving it false would misattribute the whole verb to the sweep.
- **`mv_gap_outcomes` needs no change** — `cancelled` is already in its `where` (`:40`), and the
  `exists (… escalatedFromNudge …)` arm (`:32-35`) already buckets a gap with a citing item as
  `'manager'`. State this in the header so a later reader does not "fix" it.

**`src/jobs/summarize.ts`**
- `:109` — `if (n.status === 'escalated' || n.status === 'failed' || n.status === 'cancelled')`, so
  the item join and the 7-day holdback run for a decline. A moot-`cancelled` row now costs one extra
  `findItem` read and finds nothing, which lands on the existing `managerFate = 'none'` path — the
  same result it gets today. Update the two-paths comment above it to three, naming the compound
  test.
- `:158` — `escalated: n.status === 'escalated' || ((n.status === 'failed' || n.status === 'cancelled') && item !== null)`.
- No change to `CLOSED_NUDGE_STATUSES` (`gapSummaries.ts:13`), `NudgeStatus` (`nudges.ts:12-19`) or
  `markNudgeOutcome`'s status union (`:326`) — all already carry `'cancelled'`.

**`src/teamLead/compose.ts:57`**
- Fifth optional param: `ctx?: { plannerNote?: string | null; agentContext?: string | null }`.
  Backward-compatible — `nudgeQueue.ts:156` and `:290` pass three args, as do the five existing
  `compose.test.ts` call sites.
- `:79` — `spec.handoff(n, 'expired', undefined, ctx)`.
- `:87` — forward `...(plan.agentContext ? { agentContext: plan.agentContext } : {})` into
  `flagNudge` (the shape `watchers.ts:1029` already uses).
- Rewrite the `'expired' mode is always right here` comment (`:71-73`): still true — nobody was
  asked on either path — but it now also carries a *decline*, not only a failure.

**`src/jobs/nudgeKinds.ts`**
- `:307-313` (visit spec, expired branch): `suggestion: ctx?.plannerNote ?? stage0Suggestion(…)`,
  and spread `agentContext` as the escalated branch does at `:351`.
- `:444-447` (cost spec, **expired** arm only): wrap that template in `ctx?.plannerNote ?? (…)`.
  **Do not touch the escalated arm at `:448-453` — it already has `ctx?.plannerNote ??` and must not
  be double-wrapped.** `agentContext` is already spread at `:430`.
- **Delete the now-false comment at `:441-442`** — *"Expired never has a planner note — nothing was
  ever asked, so nothing was ever planned."* A decline is planned and never asked. Replace it with
  the distinction that holds: expired means *nobody was asked*, true of both a timeout and a
  decline; only a decline arrives with a sentence.
- `HandoffContext.plannerNote` (`:85-91`) already exists — widen its doc to name both writers.

### Automated verification
- [ ] `npx supabase migration up` applies on the local stack
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass — **including
      `src/db/plannerMetrics.test.ts:253`**, the regression guard against rebuilding views from v1
- [ ] new test in `src/db/plannerMetrics.test.ts`: a `cancelled` nudge **with** a citing review item
      appears in `mv_escalation_fates` with `handoff_kind = 'cancelled'` and, when its decision row
      is a `decline`, `by_planner = true`; a moot-`cancelled` nudge with **no** item does **not**
      appear at all — this is the test that pins the compound distinction
- [ ] new test in `src/jobs/summarize.test.ts`: a `cancelled` nudge with an open item is **held
      back**; with a resolved item it writes a summary carrying `escalated: true`; with **no** item
      (the moot shape) it writes `escalated: false, manager_fate: 'none'` exactly as today
- [ ] new tests in `src/jobs/nudgeKinds.test.ts`, both specs: `handoff(n, 'expired', …, {plannerNote})`
      returns the note as `suggestion`; with no `plannerNote` returns the template **byte-identical
      to today** (pin the exact string — this is manager-visible copy)
- [ ] new test in `src/teamLead/compose.test.ts`: `handToManager` with a ctx passes `agentContext`
      through to `flagNudge`; called with three args (the `nudgeQueue` shape) behaves as before
- [ ] regression pin in `src/jobs/watchers.test.ts`: the 18h expiry handoff still produces the
      template. It calls `spec.handoff(x.n, 'expired', naiveLocal, {noCostOnLedger})` **directly**
      (`watchers.ts:892-894`), never through `handToManager`, so the new branch is unreachable from
      there — this test is what keeps that true.

### Live verification (agent-executable)
- Prerequisites: none. Deliberately no pilot write this phase.

### Manual verification
- [ ] none

---
*Manual list empty — continue.*

## Phase 2: The verb

### What this phase does
Adds `decline` to the model's vocabulary, the rails that fence it, and the apply step that hands the
gap over and then closes it.

### Changes required

**`supabase/migrations/20260826180100_nudge_decisions_decline.sql`** (new)
- Drop/re-add `nudge_decisions_action_check` with `'decline'` added to the seven at
  `20260822140000_nudge_decisions_leave.sql`. Header states the no-partial-insert hazard.

**`src/teamLead/planner.ts`**
- `:66` — `PLANNER_ACTIONS` gains `'decline'`. Extend the comment above it: a new verb must ALSO be
  added to `PLANNER_JUDGMENT_ACTIONS` **and** ship a `nudge_decisions.action` migration.
- Import `flagNudgeGap` and `reviewItemExistsFor` from `../db/index.js` (`:1-20` imports neither
  today) and `handToManager` from `./compose.js`.
- New rail after the `send`/`hold` block (`:1042-1057`):
  ```ts
  if (action === 'decline' && view.nudge.status !== 'pending') {
    push(
      'decline on a gap that has already gone out — declining is about whether to ASK, and ' +
        'that is settled once the question is written. For an asked gap, escalate hands it over.',
    );
    continue;
  }
  ```
- `:1335` — note gate becomes `if (action === 'escalate' || action === 'decline')`, so
  `cleanHandoffNote` / `cleanAgentContext` and their date rails apply identically.
- New `case 'decline':` in `applyDecision`. Two new params — `gap: Nudge | null` and
  `handOver: HandOverFn`:
  ```ts
  case 'decline': {
    if (!gap) return { outcome: 'refused', detail: 'the gap row was not in this plan' };
    // Flag FIRST, close second — the terminal-failure order. GATED, unlike the
    // pre-collapse path: re-declining next tick now costs no model call, so an
    // un-flaggable row stays pending for its 18h expiry rather than orphaning.
    // The gate is also what makes "cancelled + a citing item" mean DECLINED:
    // closing without the item would be indistinguishable from a moot visit.
    const handed = await handOver(gap, {
      plannerNote: d.handoffNote ?? null,
      agentContext: d.agentContext ?? null,
    });
    if (!handed) {
      return { outcome: 'refused', detail: 'the manager handover did not land — gap left open' };
    }
    // CODE-WRITTEN, never d.reason (planner.ts:103 — diagnostic, never shown to a
    // manager). nudges.resolution is manager-readable through v_nudges, and this
    // line is the human-readable half of the decline/moot distinction.
    return done(
      await markOutcome(d.nudgeId, tenantId, 'cancelled', 'declined — handed to the manager', [
        'pending',
      ]),
    );
  }
  ```
  `['pending']` narrows the status guard the way the expiry's `['pending','queued']` does: a
  delivery ack landing mid-decision must lose.
- `PlannerDeps` (`:252`): `handOver?: HandOverFn`, defaulted in `runPlanner` to
  `(n, ctx) => handToManager(n, flagNudgeGap, reviewItemExistsFor, specs, ctx)` so the unit suite
  never touches the database.
- `:1840-1850` — the `applyDecision` call passes **`gapRow ?? null`** (the binding at `:1839` is
  `Nudge | undefined`; passing it raw fails `tsc`) and `handOver`.

**`src/jobs/watchers.ts:188-196`** — `PLANNER_JUDGMENT_ACTIONS` gains `'decline'`.

**`src/jobs/watchers.test.ts:1862`** — extend the pinned set to include `'decline'`.

**`src/teamLead/plannerPrompt.ts`**
- `:47` — verb list gains
  `'  decline  — nobody should be asked this; a manager takes it from here. Say why.'`
- `:62-64` — the `state "pending"` doctrine gains decline alongside send and hold.
- `:243` — `enum` gains `'decline'` (pinned equal to `PLANNER_ACTIONS` by `planner.test.ts:2243`).
- `:275` and `:284` — `handoffNote` / `agentContext` descriptions: `"For 'escalate'"` becomes
  `"For 'escalate' and 'decline'"`. For decline, `handoffNote` is *the manager's whole item*.

### Automated verification
- [ ] `npx supabase migration up`; `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] `src/jobs/watchers.test.ts` liveness pin passes with the widened set
- [ ] `planner.test.ts:2243` (schema enum ≡ `PLANNER_ACTIONS`) passes unchanged
- [ ] new `planner.test.ts` cases: decline on `queued` and on `asked` are **refused** and recorded
      with the model's own reason and confidence; decline on `pending` calls `handOver` **before**
      `markOutcome`; a `handOver` returning `false` yields `refused` and calls `markOutcome`
      **never**; the row's `resolution` is the code-written line and **never contains `d.reason`**;
      `handoffNote` survives the date rail onto the item; a note carrying an unlisted date is
      dropped without refusing the decline
- [ ] mutation check: make `applyDecision` close before handing over → the ordering test must fail
- [ ] `npm run build`

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP (**read-only read-backs** — this is the pilot's live
  database), `render` MCP scoped to workspace `tea-d69903h5pdvs738dm81g`. **The migration applied to
  the pilot by hand, with the user's explicit authorisation, BEFORE the deploy.**
- [ ] Confirm on the pilot, before deploying: `information_schema` shows the widened
      `nudge_decisions_action_check` (never `list_migrations` — the pilot's ledger is known to lie)
- [ ] After deploy, from a `lifecycle-heart` tick: a `nudge_decisions` row with
      `action='decline', outcome='applied'`, its nudge at `status='cancelled'` with
      `resolution='declined — handed to the manager'`, and a `review_items` row whose
      `detail->>'escalatedFromNudge'` is that nudge id — cross-channel: DB read-back **plus** the
      tick's JSON in the Render log
- [ ] The item's `suggestion` is the planner's sentence, not the Stage-0 template

### Manual verification
- [ ] Read the manager-facing sentence on that live item and confirm it reads as a decision, names
      no blame, and needs no context the manager doesn't have

---
*Manual list non-empty — pause here for the user.*

## Phase 3: The corpus keeps its teeth

### What this phase does
**Closes a hole Phase 2 opens.** `actionNot: 'escalate'` forbids one verb by name, and
`arc.maxEscalations` counts `d.action === 'escalate'` plus rows ending `status === 'escalated'`
(`plannerEvalGraders2.ts:88-96`, `:183-190`). Nothing counts a decline — so four scenarios written
to forbid a premature manager handover can now be satisfied by performing one. This phase teaches
the grader that both verbs are handovers, then adds the scenario that pins the new behaviour.

### Changes required

**`src/eval/plannerEvalGraders2.ts`**
- `:88-96` — `actionNot` accepts one verb or several; normalise with `[e.actionNot].flat()` and
  report the verb that hit.
- `:183` — `applied.filter((x) => x.d.action === 'escalate' || x.d.action === 'decline')`.
- `:189-190` — the sweep arm additionally counts a gap that ended `cancelled` **with** an applied
  `decline` decision, matching the compound test used everywhere else. (A moot-`cancelled` gap has
  no such decision and must not count.)
- `:196-199` — the finding text becomes "handover(s)", since it no longer counts only escalations.

**`src/eval/plannerCorpus.ts`**
- `ScenarioExpect.actionNot` (`:59`): `string | string[]`, doc updated.
- `arc.maxEscalations` doc (`:78`): state that it counts manager handovers by **either** verb — the
  field name is kept so no scenario changes for the rename alone.
- `PM-06` (`:511`), `PM-07` (`:519`), `WD-06` (`:934`): `actionNot: ['escalate', 'decline']`. Each
  seeds a `pending` gap with **no** evidence that the person is the wrong one to ask, so a decline
  is as wrong there as an escalate. `LS-08` (`:614`) is covered by the widened arc counter.
- New `PJ-09` at the end of `PEOPLE` (`:710`) — `PJ-01`'s pre-ask twin: same swapped-tech evidence,
  row still `pending`. Seeded with the pending recipe `PM-06` uses (`:514`):
  `{ status: 'pending', askedAt: undefined, createdAt: '-2h', escalateAfter: undefined }`.
  `why:` cites the same ruling as the family header (technician-not-always-qualified) plus this plan.
  ```ts
  expect: { action: 'decline', actionNot: 'send', mustNotClaim: BLAME }
  ```
- `FAMILY_COUNTS['people-judgment']` (`:1053`): 8 → 9.

### Automated verification
- [ ] `npm test` passes, including `plannerCorpus.test.ts`'s family-count and total assertions
- [ ] new `plannerEvalGraders2` unit tests: a scenario with `actionNot: ['escalate','decline']` fails
      on **either** verb; `arc.maxEscalations: 0` fails on an applied `decline`; a moot-`cancelled`
      gap with no decline decision does **not** trip the arc counter
- [ ] mutation check: revert `:183` to escalate-only → that arc test must fail
- [ ] `npx tsc --noEmit`, `npm run lint`

### Live verification (agent-executable)
- Prerequisites: `OPENROUTER_API_KEY` in `.env` (absent in a fresh worktree — those tests skip).
- [ ] Run the planner eval over `people-judgment` and `premature` and report PJ-09's graded outcome
      plus both families' before/after pass rates — a decline the model never chooses is a scenario
      that pins nothing, and PM-06/07 must still pass with the widened guard

### Manual verification
- [ ] none

---
*Manual list empty — finish and run `/code-review` on the full diff.*
