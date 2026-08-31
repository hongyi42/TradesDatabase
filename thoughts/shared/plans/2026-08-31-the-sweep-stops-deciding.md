---
date: 2026-08-31
task: "Build 5 — the sweep stops deciding: clocks become alarms, moot becomes information, escalate performs its own handoff"
research: thoughts/shared/research/2026-08-30-the-sweep-stops-deciding.md
status: draft
supersedes: nothing
---

**`supersedes:` note.** This plan *amends* the 2026-08-22 ruling recorded in
docs/engineering-memory.md §6 ("moot, escalate, expire and the delivery caps are FACTS"):
under the user's 2026-08-31 rulings, those facts stop *acting* — they become information and
alarms. It supersedes no document; the amendment is recorded here and in §6a at implement time.

## Overview

After build 4, the sweep still acts on people's behalf in nine places (research, area 2). This
build removes every one of those judgments except the manager-queue self-clean, leaving the
sweep as: detect → record observations → self-clean the manager's queue → raise alarms. The
planner becomes the only judge; its `escalate` builds the manager's item itself; the facts the
sweep used to act on (cancelled visit/job) are printed into the planner's view instead, with a
rail that lets the planner end such gaps on `basis: 'record'`.

## Decisions

- **Acting clocks deleted; alarms only** (USER, final) — the 24h escalation clock, the
  fail-safe auto-close, and the 18h expiry stop acting. Replacement: a sweep-side alarm pass
  (Phase 4, spelled out in detail there) that survives planner death.
- **Moot becomes information** (USER, final) — the sweep stops closing/dismissing on
  cancelled visits/jobs; the fact becomes a THE RECORD line and the planner ends the gap.
- **Escalate performs its own handoff at apply time** (USER, final) — the send-collapse
  pattern; the `sweepLive` refusal dies.
- **Machinery give-ups demoted to operator alarms** (USER, final) — no manager handoff for
  broken pipes; `handToManager` and compose.ts are deleted (solo-operator ruling: delete the
  pretence, don't re-word it).
- **Item auto-resolve stays** (USER) · **all riders in** (USER): NUDGES_MODE retired,
  `flagOverdueVisitGap` deleted, unread caps deleted, stale comments fixed, planner's
  spec-registry filter dropped.
- **`extend` retires with the clock** (implementation, consequence of ruling 1) — with no
  automatic escalation, `extend` moves a number nothing reads (research, point f). Keeping it
  would teach a fake clock. Build 6 may reintroduce a pacing intent. Corpus scenarios expecting
  `extend` will mis-grade at the eval phase — accepted; re-levelling is already ruled deferred.
- **`escalate` requires a surviving `handoffNote`** (implementation) — the sweep's fallback
  template dies with the sweep's escalation, so like `send` after the collapse, no fallback
  author exists: a missing/date-rail-dropped note refuses the escalate; the model rewrites next
  tick.
- **`escalate` allowed on pending/queued/asked; still refused on `noticed`** (implementation) —
  a stuck relic or frozen queued row can now be handed over deliberately (replaces the 18h
  automatic handoff). An observation has no status for "the manager owns it"; giving it one is
  build-6 vocabulary work. Refusal copy rewritten honestly (no more "reaches the manager on its
  own", which stops being true).
- **The count-only manager push moves to the planner tick** (implementation) — the sweep's
  `opened > 0` push dies with its loops; one count-only line per tenant per tick when the
  planner's applied escalations opened items, same `BOARD_BOT_TOKEN` gate. Behavior parity with
  today (and equally dead in the pilot until the token exists).
- **`observationsStale` moves sweep-side** (implementation, ruling 1's logic) — build 4
  computed it inside the planner, so it dies with the planner; one owner, one number.
- **`tenant_settings.max_new_per_tick` stays as recorded data** (implementation) — it is a
  firm-writable build-2 surface; only the unread *readers* (constants, spec brakes, re-export)
  are deleted. A comment marks the column dormant.
- **No migration** — no schema change anywhere; `nudges.escalate_after` stays as a dormant
  column, documented. (Deploy-order discipline therefore doesn't arise.)

## Plain-language walkthrough

```
BEFORE                                        AFTER
sweep: detect → observe                       sweep: detect → observe
       moot? → close it itself                       print facts, raise alarms
       24h silent? → hand to manager                 clean the manager's queue
       18h undelivered? → hand to manager     planner: the ONLY judge —
       manager did the thing? → clean queue          ends moot gaps on the record,
planner: judges, but the clocks outrun it            escalates by CREATING the item
```

**Phase 1** teaches the planner's `escalate` to do the whole job: when it decides a manager
should take a gap, the code immediately creates the manager's review item with the planner's
own note as the message, and marks the gap handed over. Today it only moves a deadline stamp
and waits for the sweep. You'd notice: an escalate in a tick's plan produces a review item in
the same tick, even with the sweep off.

**Phase 2** gives the planner the fact the sweep used to act on: a gap whose visit or job was
cancelled now shows a "THE RECORD" line saying so, and the planner may close it (or dismiss the
observation) citing that fact — the rail that today exists only for cost gaps. You'd notice: a
cancelled visit's gap block tells the planner "nothing left to ask" and a `close` with basis
"record" is accepted.

**Phase 3** deletes the sweep's acting half: the moot closes, the fail-safe, the escalation
loop, the expiry, all their clocks — and with the clock gone, the `extend` verb and the
"escalates automatically at" language leave the prompt. NUDGES_MODE, which already gates
nothing, is retired. You'd notice: a silent gap stays open until the *planner* decides,
forever if need be — which is exactly why Phase 4 exists.

**Phase 4** builds the watchdog: a sweep pass (no model, runs every 5 minutes, works even if
the planner is dead) that counts three things and shouts about them without touching anything —
asked questions nobody has judged in 24h, queued messages stuck 18h+ or past their delivery
retries, and observations untouched for 72h. The numbers ride the tick record and `npm run
ticks` prints them as ⚠ lines. The delivery queue's give-up rules stop dumping broken-pipe
failures into the manager's queue; they freeze the row and feed the alarm instead.

**Phase 5** is the broom: dead flagger, dead caps, stale comments, the spec slimmed to the
three fields the surviving item-sweep needs, and the docs/§6a record.

## Secrets & env preflight

- **Phases 1–5:** none new. `BOARD_BOT_TOKEN` stays optional (push seam, already existing).
  Deploy-time note (NOT now): `NUDGES_MODE` joins `REFLECTOR_MODE` on the delete-at-deploy list
  for the lifecycle-heart Render service.

## Phase 1: escalate performs its own handoff

### What this phase does
Moves the manager handoff from the sweep's clock loop into `applyDecision`. The planner's note
becomes the item's suggestion (no template fallback), the `sweepLive` coupling dies, and the
count-only push moves to the planner tick.

### Changes required

**`src/teamLead/planner.ts`**
- `validateDecisions` (:1256): delete the `sweepLive` param and its refusal (:1409–1416).
  Escalate stage rule: allowed when `view.nudge.status` ∈ {pending, queued, asked} (replaces
  the `!== 'asked'` refusal :1429–1435); the `noticed` refusal (:1417–1428) stays with
  rewritten copy ("an observation has no manager surface yet — send, dismiss, or leave").
  New rails: escalate with no surviving `handoffNote` → refused ("escalate needs `handoffNote`
  — it was missing or the date rail dropped it; rewrite it using only the dates you were
  given"); escalate on a gap whose context has no `jobId` → refused (flagNudgeGap requires it).
- `applyDecision` (:1865) `case 'escalate'` (:2059–2060) becomes the handoff, flag-first
  (the F1 order):
  ```ts
  case 'escalate': {
    const n = getGap(d.nudgeId)!;
    const item = await flagNudge({ tenantId, kind: n.kind as ReviewKind,
      subjectRef: n.subject_ref, jobId: ctxStr(n, 'jobId')!,
      technicianRef: ctxStr(n, 'technicianRef'),
      startsAtLocal: ctxStr(n, 'startsAtLocal'), endsAtLocal: ctxStr(n, 'endsAtLocal'),
      escalatedFromNudge: n.id, suggestion: d.handoffNote!,
      ...(d.agentContext ? { agentContext: d.agentContext } : {}) });
    // item null = subject ever-flagged: the manager HAS it — still mark the row
    // (the sweep's mark-regardless precedent, watchers.ts:1168–1181 today).
    return done(await markOutcome(d.nudgeId, tenantId, 'escalated',
      'handed to the manager by the team lead', ['pending', 'queued', 'asked']));
  }
  ```
  `flagNudge` = new `PlannerDeps.flagNudge?: typeof flagNudgeGap` seam (import from db).
- Push: new `PlannerDeps.notify?: typeof notifyManagers` + `hasPushToken?: () => boolean`
  seams. In the tenant loop after the apply pass: if mode live and ≥1 escalate applied and
  `hasPushToken()`, send ONE count-only line (reuse the sweep's current wording,
  watchers.ts:1338–1347 style); else count a `pushSkipped`-equivalent nowhere (drop silently —
  the summary field lives sweep-side today and dies in Phase 3).
- Call-site: `validateDecisions(args, views, nowMs, recoverable)` (:2516) — signature shrinks.
- Stale doc: `setNudgeSchedule`'s header ("the planner never escalates … lets the sweep perform
  the handoff", nudges.ts:391–397) rewritten in Phase 3 when escalate stops writing schedules.

**`src/jobs/lifecycle.ts`** — delete `sweepLive` (:505–513 comment + property).
**`src/eval/plannerSim.ts`** — delete `sweepLive: true` (:564); stub the new seams
(`notify: async () => {}`, `hasPushToken: () => false`) in `runTick`'s `runPlanner` deps.
**Tests** — also update `src/jobs/lifecycle.test.ts:953–967` (the `sweepLive` passthrough
describe pins the property this phase deletes — review finding 5).

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass
- [x] planner.test.ts: applied escalate → review_items row exists with the note as suggestion +
  `detail.escalatedFromNudge`; nudge `escalated`; works with NO sweep in the loop
- [x] escalate refused without a surviving handoffNote; refused on `noticed`; ACCEPTED on a
  stuck `queued` relic; ever-flagged subject (null flag) still marks the row escalated
- [x] push seam: one line when an escalate applies and token exists; none in shadow

### Live verification (agent-executable)
- Prerequisites: local Supabase stack (`npx supabase start`, `.env.test`)
- [x] Through the real store: seed an asked nudge, run a scripted planner tick that escalates,
  read review_items back via pg — item + status + decision row all present, sweep never ran.
  *(codified: plannerSim.test.ts arc test — real flagNudgeGap/markNudgeOutcome against the local
  stack, pg read-back of the item incl. the planner's note as suggestion + escalatedFromNudge.)*

### Manual verification
- [ ] none

---

## Phase 2: moot becomes information — the record rail for every kind

### What this phase does
The planner learns the facts the sweep used to act on, and gains the rail to act on them. The
sweep's moot behavior is untouched in this phase (harmless overlap; sweep usually wins the
race until Phase 3 removes it) so the codebase never passes through a state where nobody can
end a moot gap.

### Changes required

**`src/teamLead/planner.ts`**
- Tenant loop: two batched status reads over the open gaps (the sweep's discipline,
  watchers.ts:640–673): `listAssignmentsByIds(tenantId, [subject_refs that carry a context
  assignmentId])` → `visitStatusById`; `listJobsWithCustomerByIds(tenantId, [context jobIds])`
  → `jobStatusById` (tenant re-checked). Spec-free: keyed off context keys, not
  `subjectIsVisit`.
- `buildGapView` (:775): new param carrying a code-computed `mootFact: string | null` —
  visit-subject gap whose assignment status ∈ {cancelled, completed} → `"the visit was
  <status> — nothing left to ask"`; any gap whose job status = cancelled → `"the job was
  cancelled — nothing left to ask"` (wording preserved from nudgeKinds.ts:277–282, :402–405).
  Printed as a THE RECORD line for EVERY kind, stage-forked like the cost line (:888–903):
  asked/relic → `Close this gap with basis "record".`; `noticed` → `Nothing needs asking:
  dismiss this observation.`
- `GapView` (:640): add `mootFact: string | null`. `validateDecisions` close-basis-'record'
  authorization (the `fact` derivation at :1600): `view.recordFilled ?? view.moneyOnRecord ??
  view.mootFact` — moneyOnRecord MUST stay in the chain (review finding 1: dropping it would
  break money-basis closes the prompt teaches and the tests at planner.test.ts:1464–1505).
  Code overwrites the citation with the fact's own words (existing mechanism).
- **A moot-authorized close ends the gap as `'cancelled'`, not `'answered'`** (review
  finding 3 — the sweep's moot wrote `'cancelled'`, and `mv_gap_outcomes` buckets on status):
  validateDecisions marks the checked decision internally (a validate-set flag on the checked
  object, never model-suppliable) when mootFact authorized it; `applyDecision`'s close case
  (:2094–2100) then calls `markOutcome(…, 'cancelled', `closed on the record — ${citation}`)`
  for that flag and `'answered'` otherwise.
- Planner's registry filter DROPPED (:2265 `.filter((n) => !!specFor(n.kind, specs))` deleted;
  `specs` dep may go entirely if nothing else reads it) — the planner sees every open gap of
  any kind (rider 6).

**`src/teamLead/plannerPrompt.ts`** — extend the basis-'record' paragraph (:103–115): the
RECORD line now also reports a cancelled/completed subject, same verb fork.

### Automated verification
- [x] gates pass
- [x] new tests: cancelled visit → view shows the line; close basis 'record' ACCEPTED on it
  (citation = code's words); dismissed guidance on a noticed observation; completed visit same;
  cancelled job authorizes a cost gap's close; no moot → basis 'record' still refused
- [x] a gap of an unregistered kind now reaches the planner's view (filter-drop pin)

### Live verification (agent-executable)
- Prerequisites: local stack
- [x] Scripted tick over a seeded cancelled-visit ask: model-free path check via
  validate/apply unit harness + pg read-back of the close's resolution text.
  *(codified: plannerSim.test.ts "the planner ends a moot gap on the record" — real status
  reads + real markNudgeOutcome against the local stack; pg reads back status 'cancelled' and
  the fact as resolution.)*

### Manual verification
- [ ] none

---

## Phase 3: the sweep stops acting

### What this phase does
Deletes every acting path from `runWatchers` and the machinery that fed them; retires
`extend` and NUDGES_MODE; rewrites the prompt's clock language. After this phase the sweep
detects, records, and self-cleans the manager queue — nothing else.

### Changes required

**`src/jobs/watchers.ts`**
- DELETE: the nudge sweep loop's moot close (:834–840), fail-safe (:852–925), escalation
  collect + loop (:926, :1064–1186), expiry collect + group expansion + handoff (:930–947,
  :976–1062); the observation moot pass (:950–974); the decisions read + `plannerAlive` +
  `dueAtOf` (:731–796); the push block (:1317–1353); the stranded-kind filter for nudges
  (:521–535 — the open-nudge read survives only as Phase-4 alarm input).
- DELETE constants: `NUDGE_ESCALATE_HOURS`, `NUDGE_ESCALATE_MAX_HOURS`,
  `NUDGE_DELIVERY_DEADLINE_HOURS`, `PLANNER_SILENCE_HOURS` (:119–191). Phase 4 introduces the
  alarm constants that inherit the 24/18 values as *watch thresholds*.
- `PLANNER_JUDGMENT_ACTIONS` (:205): remove `extend`; keep the set + export — Phase 4's alarm
  is its consumer now (comment updated; the pin test moves with it).
- `WatchersSummary` (:300): remove `nudgeMode`, `nudgesWouldCreate`, `nudgesCreated`,
  `nudgesResolved`, `nudgesAutoClosed`, `nudgesEscalated`, `nudgesExpired`,
  `observationsMooted`, `pushed`, `pushSkipped`, `itemsOpened`; keep `mode/tenants/gapsFound/
  freshGaps/itemsResolved/tenantErrors/observationsCreated/byKind/settingsTableMissing`.
- `runWatchers` signature loses the `nudgeMode` 4th param.
- Orphaned collaborators go WITH the deleted paths (review finding 4 — lint has
  `no-unused-vars: 'error'`): the destructures `flagNudge` (:369), `notify`/`hasPushToken`
  (:371–372), `resolveNudge` (:379), `listDecisions` (:384), their `WatcherDeps` fields and
  imports. `listDecisions` and its dep RETURN in Phase 4 (the alarm's read).

**`src/teamLead/planner.ts`**
- Retire `extend`: out of `PLANNER_ACTIONS` (:88), rails (:1690–1750), `applyDecision` case
  (:2062–2076); `escalate` no longer touches `setNudgeSchedule` (Phase 1 replaced it).
  `hold` rail: drop the 18h ceiling clamp (:1678–1688) — future-instant check only (the
  ceiling's enforcement arm no longer exists; holds were already advisory, research area 4).
- `buildGapView`: delete the "escalates automatically at" line (:911–919) and
  `currentDeadlineMs`/`holdCeilingMs` (:1076–1090).

**`src/teamLead/plannerPrompt.ts`** — remove `extend` everywhere (verb list :59, clock
paragraphs :73–75, :89–94 rewritten: no automatic anything; "a gap stays exactly as you leave
it — pacing is yours alone"), CLOSING IS YOURS paragraph (:96–99) loses the deadline sentence;
`submit_plan` enum (:302) and `escalateAfter` property (:351–357) dropped; drop the
`NUDGE_ESCALATE_MAX_HOURS` import (:9). "queued" state line (:86) reworded: normally in
flight within minutes; one stuck for many hours means delivery is broken — escalate it or
hold. "pending" line (:83–85) loses its delivery-deadline claim.

**`src/jobs/lifecycle.ts`** — NUDGES_MODE parse + stepError deleted (:412–429); `runWatchers`
call updated (:432); `ladderMute` reworded (:550–581): condition = `watchersMode === 'live'`
and planner not live/credential-less → "observations are being recorded but no planner is
running — nobody can ask or escalate anything"; header comments updated.

**`src/eval/plannerSim.ts`** — `runWatchers(nowIso, 'live', {stubs})` (drop 4th arg; drop
`notify`/`hasPushToken` stubs there — the push left the sweep).

**Tests** — watchers.test.ts: delete the ladder/fail-safe/escalate_after/expiry/group-expiry/
manager-copy describe blocks (:692–1187, :1189–1292, :1908–2677, :2679–2872 — the item
auto-resolve, registry-for-items, detection, and mint families stay), AND the surviving
file-scope imports/fixtures those blocks used (:11–13 imports, :48–50
`UNDELIVERED_PAST_DUE`/`_YOUNG` — they reference the deleted constant; review finding 5);
lifecycle.test.ts summary-shape pins updated (:304–306 etc.); planner.test.ts: extend-rail
tests deleted, hold-ceiling refusal test (:941) deleted, PLANNER_SYSTEM pins on the
`NUDGE_ESCALATE_MAX_HOURS` copy (:231/:235) updated, verb pin self-syncs (:2861–2871).

### Automated verification
- [x] gates pass
- [x] pins: a silent asked gap past 24h is UNTOUCHED by the sweep; a cancelled visit's
  observation stays `open` (no moot-dismiss); an 18h-old queued row stays `queued`;
  no review_items row is ever opened by `runWatchers` (item auto-resolve still closes them)
- [x] `PLANNER_ACTIONS`/schema pin passes with 7 verbs; PLANNER_JUDGMENT_ACTIONS pin updated

### Live verification (agent-executable)
- Prerequisites: local stack
- [x] Full `runWatchers` over a seeded firm with one moot ask + one silent-past-24h ask:
  pg read-back shows both rows unmoved; observations minted; summary shape matches.
  *(codified: plannerSim.test.ts "the sweep touches nothing" — real runWatchers live over a
  30h-silent ask, a 20h queued relic and a cancelled-visit observation; pg reads all unmoved,
  zero review items.)*

### Manual verification
- [ ] none

---

## Phase 4: the alarms — the watchdog that survives the planner

### What this phase does
The replacement ruling 1 demands, in full. One new sweep pass computes three counters per
tenant; the queue's give-up rules stop handing to the manager and feed the same instrument.
Posture throughout: **alarm, never actor; never `ok=false`** (the ladderMute/alarm-fatigue
precedent — the operator surface is `npm run ticks` + stderr, not a red heartbeat).

### Changes required

**`src/jobs/watchers.ts`** — the alarm pass, end of the live per-tenant block:
- Constants: `ASK_UNATTENDED_ALARM_HOURS = 24`, `DELIVERY_STUCK_ALARM_HOURS = 18`,
  `OBSERVATION_STALE_HOURS = 72` (moved here from planner.ts:128; same value, new home —
  comments state these are WATCH thresholds inheriting the dead deadlines' values, chosen
  numbers unre-derived, and that nothing fires on them).
- Inputs it already has: `allOpenNudges`, `allOpenObs` (both reads survive Phase 3 for exactly
  this), `MAX_DELIVERY_ATTEMPTS`/`MAX_SERVE_COUNT` (import from control/nudgeQueue — no cycle:
  nudgeQueue does not import watchers).
- Compute:
  - `deliveryStuck` = pending/queued rows where `created_at ≤ now − 18h` OR
    `serve_count ≥ MAX_SERVE_COUNT` OR `attempts ≥ MAX_DELIVERY_ATTEMPTS`.
  - candidates for the other two: asked rows with `asked_at ≤ now − 24h`; open observations
    with `noticed_at ≤ now − 72h`. ONE `listDecisionsForNudges` read over exactly those ids
    (usually zero — the pre-hoist scoping discipline, research area 2 item 3);
    `asksUnattended` / `observationsStale` = candidates with NO applied
    `PLANNER_JUDGMENT_ACTIONS` (minus `leave`, for observations — the build-4 semantics,
    planner.ts:2374–2394 moved verbatim) decision inside the window. A failed decisions read
    logs and reports the candidates as unattended (fail toward alarming — a missing read is
    not evidence of attention).
  - `WatchersSummary.alarms: { asksUnattended: number; deliveryStuck: number;
    observationsStale: number }` + one `console.error` per tenant with nonzero alarms, naming
    up to 5 ids per class.

**`src/control/nudgeQueue.ts`** — serve-cap branch (:148–167): delete `handToManager` +
`outcome('failed')`; keep the skip + one bounded log (the row freezes; the alarm and the
planner own it now). Failure path (:252–301): keep the attempts bump; delete the handoff +
`outcome('failed')`; serve loop additionally skips rows with `attempts ≥
MAX_DELIVERY_ATTEMPTS` (frozen, not re-served). Delete `flagNudge`/`reviewItemExists` deps +
imports. Header doctrine rewritten: a broken pipe is an operator condition; the gap stays the
planner's.

**`src/teamLead/compose.ts`** — DELETED (last caller gone). Its send-window history block
moves to docs/engineering-memory.md at implement time.

**`src/teamLead/planner.ts`** — retire the planner-side stale counter: computation
(:2374–2394), `PlannerTenantPlan.observationsStale` (:218–222), `PlannerSummary.
observationsStale` — removed (one number, one owner).

**`scripts/ticks/report.mjs`** — replace the planner-side stale read (:294, :335–343, :377)
with the latest run's `summary.watchers.alarms`; print
`⚠ unattended asks: N · stuck deliveries: N · stale observations: N` when any is nonzero.

**Tests** — watchers.test.ts alarm family (unattended counted; attended-within-window not;
leave doesn't count for observations; stuck queued counted on each of the three triggers;
failed decisions read → counted; alarms never flip `ok`); nudgeQueue tests: cap paths freeze
(no item, no 'failed' status), attempts-frozen rows not served; compose.test deletions; the
`observationsStale` pins at planner.test.ts:3861–3886 and lifecycle.test.ts:431/:504/:849
deleted/updated with the field (review finding 5).

### Automated verification
- [ ] gates pass · new alarm tests pass
- [ ] pin: a tick with alarms nonzero still exits 0 (never reddens)

### Live verification (agent-executable)
- Prerequisites: local stack
- [ ] Seed one 30h-silent asked row + one 20h queued row + one 80h observation; run the real
  sweep; pg read-back: nothing changed state, summary.alarms = {1,1,1}; report.mjs over the
  recorded run prints the ⚠ line.

### Manual verification
- [ ] none

---

## Phase 5: riders, spec slim-down, and the record

### What this phase does
Deletes the dead surface and writes the record.

### Changes required

- **`src/db/reviewItems.ts`** — delete `flagOverdueVisitGap` (:198) + its tests
  (reviewItems.test.ts:84–…); keep `flagNudgeGap` (now planner-called) and
  `listEverFlaggedSubjectRefs` (dedup store).
- **Caps**: `NudgeKindSpec.maxNewPerTenantTick` deleted (field + both values); from watchers'
  re-export block (:113–117) remove **only `MAX_NEW_ITEMS_PER_TENANT_TICK`** — the block also
  re-exports `OVERDUE_HOURS`/`LOOKBACK_HOURS`, which `src/db/tenantSettings.test.ts:10–14`
  deliberately imports from `../jobs/watchers.js` to pin the chain (review finding 2); update
  that test's cap import to point at tenantSettings. `MAX_NEW_ITEMS_PER_TENANT_TICK` in
  tenantSettings.ts stays only as the fallback for the dormant `max_new_per_tick` settings
  column, comment marking it unread-by-design (build-2 data surface, not deleted).
- **`src/jobs/nudgeKinds.ts`** — spec slims to `{ kind, subjectIsVisit, itemResolved }`;
  `filled`, `moot`, `handoff`, `stage0Suggestion`, `HandoffPlan`, `HandoffContext` deleted
  (consumers all died in Phases 3–4; grep-verify before deleting — note the research's area-3
  consumer table is WRONG on one row: buildGapView never consumed `spec.filled`, it computes
  `recordFilled` itself from `jobsWithCostEvents` (planner.ts:840–843), so `filled`'s only real
  consumers were watchers.ts:867 and :1120, both dead after Phase 3; review finding 6); header
  rewritten: the registry now exists for the ITEM sweep alone.
- **Stale comments** (research area 4): watchers.ts:502–508 tail, :89–94; planner.ts:117
  UNMENTIONED_CAP rationale, :2715; nudgeDecisions.ts:122 + the escalateAfter input doc
  (:24–27 — field kept for historic rows, writer no longer passes it); nudges.ts:391–397
  (`setNudgeSchedule` header — notBefore-only writer now), :475.
- **Docs**: engineering-memory §6a build-5 entry (rulings verbatim, the 2026-08-22 amendment,
  the NUDGES_MODE + REFLECTOR_MODE deploy-time deletions, compose.ts's send-window history);
  `npm run decisions:index`.

### Automated verification
- [ ] gates + `npm run build` pass; full suite green twice
- [ ] grep pins: no reference to `NUDGES_MODE` outside docs/history; no `flagOverdueVisitGap`;
  no `handToManager`; no `spec.moot`/`spec.filled`/`spec.handoff` call sites

### Live verification (agent-executable)
- Prerequisites: local stack
- [ ] One full `runLifecycle` against the seeded local stack: summary shape, no stepError,
  observations minted, alarms present, no items opened by the sweep.

### Manual verification
- [ ] none
