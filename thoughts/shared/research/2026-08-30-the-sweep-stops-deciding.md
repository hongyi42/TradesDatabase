---
date: 2026-08-30
branch: main
commit: 245378b
topic: "Build 5 ground — the sweep stops deciding: every model-free decision the lifecycle sweep makes today, the spec machinery it decides with, and the planner verbs that could make the same calls"
supersedes: nothing
---

**`supersedes:` is not optional bookkeeping.** This document overturns nothing — it records the
ground as it stands after build 4 (PR #193, merged at this commit). The build-4 research
(`2026-08-30-a-gap-is-not-an-ask.md`) remains the record of the *pre-split* world; this one
documents what is left for build 5 to move.

## Summary

The "sweep" is the deterministic half of the gap ladder: a Render cron that fires every five
minutes, walks every firm, and — with no model call anywhere in it — detects gaps, closes
questions whose subject was cancelled, hands silent questions to the manager at a 24-hour
deadline, hands undelivered questions to the manager at an 18-hour deadline, and self-cleans the
manager's queue. Build 5's charter (docs/engineering-memory.md §6a) is *"it observes; every
judgment is the planner's."* This document enumerates, with file and line, every decision the
sweep currently makes on its own; the per-kind `NudgeKindSpec` structure those decisions are
routed through (and the recorded constraint that a spec-less sweep must not need it); the
planner verbs that already exist as twins of each sweep decision and the ones that have no twin;
the escalation/review surface the handoffs land on; and everything downstream — evals, metrics,
tests, the box-runner contract — that assumes the sweep decides. The prior rulings that carve
the territory: the 2026-08-22 division ("only `filled` is a judgment; moot, escalate, expire and
the delivery caps are facts"), the solo-operator ruling (2026-08-26, recorded but not built),
no-send-window (2026-08-29), and build 4's alarm-never-actor precedent (the stale-observation
counter).

## Entry Points

- `src/jobs/lifecycle.ts:613` — `main()`, the ONE scheduled entrypoint (Render cron `*/5 * * * *`).
- `src/jobs/lifecycle.ts:202` — `runLifecycle()`: steps 1–7 quarter-hourly (`heavyTick`, :220),
  step 8 (the watcher sweep) every tick (:405–441), step 9 (the planner) on its own grid
  (:443–548), step 10 the mute check (:550–581).
- `src/jobs/watchers.ts:353` — `runWatchers()`: the entire sweep, one per-tenant loop.
- `src/control/nudgeQueue.ts:73/198` — `buildNudgeDelivery` / `completeNudgeDelivery`: the
  delivery half, driven by the box's five-minute pull (`GET/POST /control/nudges`,
  `src/mcp/httpServer.ts:561–566`).
- `src/teamLead/planner.ts:2112` — `runPlanner()`: the judgment half the decisions are meant to
  move toward.

## Key Files

| file | role |
|---|---|
| `src/jobs/watchers.ts` (1362) | the sweep: detection → observations, moot, fail-safe, escalation, expiry, item auto-resolve, the push |
| `src/jobs/lifecycle.ts` (693) | orchestration, mode gates (WATCHERS_MODE / NUDGES_MODE / PLANNER_MODE), the mute check, `lifecycle_runs` record |
| `src/jobs/nudgeKinds.ts` (474) | `NudgeKindSpec` + the two registered specs + `SweepFacts` |
| `src/db/nudges.ts` (545) | status vocabulary, queue reads/writes, the guarded state moves |
| `src/db/observations.ts` (169) | the build-4 store the sweep now also moot-dismisses into |
| `src/db/reviewItems.ts` (523) | every review-item writer, incl. `flagNudgeGap` (:145) and the dead `flagOverdueVisitGap` (:198) |
| `src/db/tenantSettings.ts` | the three detection parameters + `MAX_NEW_ITEMS_PER_TENANT_TICK = 5` (:38) — resolved per firm, **unread at mint since build 4** |
| `src/control/nudgeQueue.ts` (302) | serve rails: liveness skip, leaderless freeze, serve-cap and delivery-failure handoffs, the queued→asked ack |
| `src/teamLead/compose.ts` (96) | compose's one survivor: `handToManager` (:50), the queue's manager fallback |
| `src/teamLead/planner.ts` (2878) | the 8 verbs, their rails, the stale-observation counter (:128, :2374–2394) |
| `src/teamLead/plannerPrompt.ts` (394) | the doctrine — quoted below where its phrasing is structural |
| `src/eval/plannerSim.ts` / `plannerCorpus.ts` / `plannerEvalGraders2.ts` | the eval harness: `runTick` runs the REAL sweep; graders are sweep-aware |
| `scripts/ticks/report.mjs` | `npm run ticks` — reads planner fields + `ladderMute` only; **prints no watcher counter** |
| `supabase/migrations/20260824020000_planner_metrics_v2.sql` | `mv_gap_outcomes`, `mv_escalation_fates` (`by_planner` distinguishes sweep vs planner escalations), `mv_whiplash`, `mv_extend_effectiveness` |

---

## Area 1 — the sweep's full anatomy

Trigger cadence: Render fires the cron every 5 minutes and runs at most one instance,
**delaying** (not dropping) the next firing while one runs (lifecycle.ts:636–663). Steps 1–7
(pairing, offboarding, sessions, log ingest, Brave backfill, cost rollup, run-record prune) run
only on quarter-hour ticks and are outside this build's scope. Step 8 — `runWatchers` — runs
every tick, gated on `WATCHERS_MODE` (unset = skipped; typo = loud stepError, lifecycle.ts:420–429).

Inside `runWatchers`, per tenant, in execution order:

| # | pass | reads | writes | classification |
|---|---|---|---|---|
| 1 | settings + tz (watchers.ts:445) | `tenants`, `tenant_settings` (tolerant of a missing table :432–454) | — | recording |
| 2 | visit candidates (:466–469) | `listOverdueConfirmedAssignments` over the firm's own `lookbackHours`/`overdueHours` window | — | **detection (the eyes)** |
| 3 | open review items, per registered spec (:475–484, live only) | `findOpenReviewItemsByKind` | — | recording |
| 4 | open nudges (:515–516, live only, `pending/queued/asked`) — swept **regardless of NUDGES_MODE** (:502–508) | `listNudgesByStatus` | — | recording |
| 5 | **stranded-kind filter** (:526–535): a kind with no spec is dropped from every path below, with a loud `console.error` | — | — | the invisibility fact (see area 3) |
| 6 | open observations (:521) | `listObservationsByStatus(['open'])` | — | recording |
| 7 | one batched activity fetch (:550–595): captures + visits → `latestByJob`; then `gaps` and `fresh` via the three dedup stores (:613–622: ever-flagged, ever-nudged, ever-**observed**) | | — | detection |
| 8 | `shadow` → `continue` (:625): counts only, nothing below runs | | | — |
| 9 | **item auto-resolve** (:697–711): `spec.itemResolved(item, facts)` → `resolveOpenReviewItemFor(…, 'resolved', text)` | facts | `review_items` | **judgment** (a manager's queue item disappears on code's verdict) |
| 10 | the nudge sweep loop (:798–948): per open nudge — **moot close** (:834–840), the **deadline fail-safe** (:852–925), collect **escalations** (:926), collect **expired** (:942–947) | facts, `nudge_decisions` (liveness read :765–781) | `nudges` | **judgment** (each detailed in area 2) |
| 11 | **moot over open observations** (:950–974, added by build 4): `spec.moot` → code-authored dismissal | facts | `observations` | **judgment** (fact-based) |
| 12 | group-expiry expansion (:991–1006): one member past 18h expires the whole ask-group | — | — | judgment (conservative propagation) |
| 13 | expired handoff loop (:1012–1062): `flagNudge` (Stage-0 copy) + `resolveNudge('failed', 'never delivered — handed to the manager')` | `spec.handoff('expired')` | `review_items`, `nudges` | **judgment → person-visible** |
| 14 | rung-2 escalation loop (:1097–1186): planner's applied-escalate note read back (:1086–1096), `flagNudge` (escalation copy) + `resolveNudge('escalated', …)` | `nudge_decisions` | `review_items`, `nudges` | **judgment → person-visible** |
| 15 | visit mint (:1208–1249, build 4): every fresh gap → `createObservation`, **uncapped, no reachability test, no manager fallback**, technician advisory | roster, jobs | `observations` | **recording** (the build-4 shape: detection = recording, no longer an ask) |
| 16 | cost mint (:1263–1314, build 4): same shape, **ungated by nudgeMode** (:1257–1262) | `listCostGapCandidates`, 4 batched dedups | `observations` | recording |
| 17 | the manager push (:1321–1353): `if (opened > 0)` — once-only by design — one count-only line via `notifyManagers` | — | Telegram | **judgment → person-visible** (dead in the pilot: `BOARD_BOT_TOKEN` unset → `pushSkipped`) |

The delivery half runs on a different clock — the box's own five-minute pull
(`nudgeQueue.ts`) — and carries three more code decisions (area 2, rows 7–9).

The one **demoted** pass — the pattern build 5's charter points at — is the build-4 stale
counter: `OBSERVATION_STALE_HOURS = 72` (planner.ts:128), computed inside `runPlanner`
(:2374–2394) as "open observations older than 72h with no applied decision beyond `leave` inside
the window", carried on `PlannerTenantPlan.observationsStale` / summed on `PlannerSummary`, and
surfaced by `npm run ticks` as a `⚠` line (report.mjs:335–343, :377–378). It reddens nothing and
acts on nothing — **alarm, never actor**. It is the only sweep-adjacent number that watches a
condition instead of acting on it.

## Area 2 — every decision the sweep makes without a model

All constants live in watchers.ts unless noted: `NUDGE_ESCALATE_HOURS = 24` (:130),
`NUDGE_ESCALATE_MAX_HOURS = 48` (:138), `NUDGE_DELIVERY_DEADLINE_HOURS = 18` (:175),
`PLANNER_SILENCE_HOURS = 24` (:191), `MAX_SERVE_COUNT = 10` / `MAX_DELIVERY_ATTEMPTS = 3`
(nudgeQueue.ts:32/35).

1. **Moot-close on an open nudge** (watchers.ts:834–840). Trigger: `spec.moot` — the visit left
   `confirmed` (cancelled/completed, nudgeKinds.ts:277–282) or the job was cancelled (:402–405).
   Act: `markNudgeOutcome(id, tenant, 'cancelled', mootText)`. Records: `nudges.status`,
   `nudges.resolution` (the fact's own sentence), `nudgesResolved` counter. No decision row is
   written — **the sweep never writes `nudge_decisions`** (its only writer is the planner,
   planner.ts:19; verified by grep). A person sees nothing directly; the paired queue item (if
   any) self-cleans on pass 9.

2. **Moot-dismiss on an open observation** (:957–974, build 4). Same fact test; act:
   `setObservationStatus(…, {status:'dismissed', dismissReason: moot}, ['open'])`;
   `observationsMooted` counter. The manager can read `dismiss_reason` via `v_observations`.

3. **The deadline fail-safe auto-close** (:852–925). Trigger: an `asked` gap at/past its
   deadline (`dueAtOf` :738–743 — a stamped `escalate_after` wins, malformed falls back to
   asked_at + 24h) whose gap is answerable from the record (`spec.filled`), which is the **sole
   gap on its job** (:892–894), and whose planner made **no applied real-verb decision in 24h**
   (`plannerAlive` :787–796 — `PLANNER_JUDGMENT_ACTIONS` :205–218, now including
   `dismiss`/`recover`; `unmentioned` deliberately excluded; a failed decision read fails toward
   escalation :768–781). Act: `markNudgeOutcome('answered', "…closed automatically — … Nobody
   reviewed it within 24h…")` + `nudgesAutoClosed` + a `console.error` naming the fail-safe
   (:918–922). This is the one place the sweep still closes on `filled` — kept exactly as the
   backstop for a **dead** planner, never a disagreeing one (:186–190).

4. **Rung-2 escalation** (:926, :1097–1186). Trigger: `asked` + past `dueAtOf` and not
   auto-closed. Act: `flagNudge` opens a `review_items` row (kind-generic, once-per-subject-ever
   dedup, reviewItems.ts:138–145) with `spec.handoff(n,'escalated',…)` copy — the planner's own
   `handoff_note` from an applied `escalate` **is** the message when one exists (:1086–1096,
   nudgeKinds.ts:352–359); then `resolveNudge('escalated', …)` with an honest resolution ("no
   reply" vs "not confirmed as answered", :1172–1181). An answerable-but-escalating gap logs
   "a judgment worth reviewing" (:1130–1143). Person sees: a queue item + (when the token
   exists) the count-only push.

5. **Delivery-deadline expiry** (:942–947, :991–1062). Trigger: `pending`/`queued` and
   `created_at ≤ now − 18h`; the whole ask-group expires with its earliest member (:991–1006).
   Act: `flagNudge` with the **Stage-0** copy (the ask never landed — the manager must never be
   told it did) + `resolveNudge('failed', 'never delivered — handed to the manager',
   ['pending','queued'])` (a racing delivery ack wins, :1046–1057). `nudgesExpired`.

6. **Item auto-resolve** (:697–711). Trigger: `spec.itemResolved` — activity arrived / status
   changed (visit kind) or a cost landed on the ledger / job cancelled (cost kind,
   nudgeKinds.ts:287–296, :415–423). Act: `resolveOpenReviewItemFor(…, 'resolved', text)`.
   The one queue surface that cleans itself.

7. **Serve-cap poison handoff** (nudgeQueue.ts:148–167). A queued row served ≥10 times with no
   ack: every group member goes through `handToManager` (compose.ts:50 — the compose survivor,
   'expired'-mode copy) then `markNudgeOutcome('failed', 'undeliverable: served Nx…')`.

8. **Delivery-failure handoff** (nudgeQueue.ts:252–301). The box reports `failed` a third time
   (`MAX_DELIVERY_ATTEMPTS = 3`): every member → `handToManager` + `'failed'`.

9. **Queued → asked** (nudgeQueue.ts:246–249, :232–241). The box's `delivered` report flips the
   whole group with one shared `asked_at` (`markNudgeAskedGroup`), including the
   closed-lead-survivors path. This is a delivery **ack** — the record of a fact the box
   observed — not a choice; the give-up rules (7, 8) and the liveness re-filter skip
   (:143–146, frozen-not-failed) are where the queue path decides.

**Caps surviving after build 4: none bind.** `settings.maxNewPerTick` (default
`MAX_NEW_ITEMS_PER_TENANT_TICK = 5`) and the per-kind `maxNewPerTenantTick` (5 visit / 3 cost)
are "left DECLARED but unread at mint (build 5 owns retiring them)" (watchers.ts:1196–1198).
Tests pin the unread state (watchers.test.ts:264, :1513, :1556, :1814).

**Where the 2026-08-22 division stands now.** That ruling classified `moot`, escalate, expire
and the delivery caps as FACTS and only `filled` as a judgment. Today: `filled`'s authority is
fully removed (it closes nothing except inside the dead-planner fail-safe;
nudgeKinds.ts:150–179 documents the demotion). `moot` is still treated as a fact
("a cancelled visit or job is a FACT, not a judgment" — watchers.ts:832–833) and build 4
*extended* it to observations. Escalation is a clock the planner may move (`extend`) or pull
(`escalate` = stamp `escalate_after = now`, planner.ts:2060) — but the **handoff itself** is
performed only by the sweep, and only when `WATCHERS_MODE=live` (the planner's escalate is
refused otherwise, planner.ts:1409–1416). Expiry and the delivery caps are untouched clocks.
Build 5's charter ("every judgment is the planner's") therefore has to say, for each of these,
whether the 2026-08-22 "fact" classification stands or falls — the two rulings genuinely
overlap and neither has been amended.

## Area 3 — the spec structure

`NudgeKindSpec` (nudgeKinds.ts:134–211), field by field, with its consumer:

| field | type | consumed by | half |
|---|---|---|---|
| `kind` | `ReviewKind` | everything — the registry key | routing |
| `subjectIsVisit` | boolean (:140) | which batched status read a subject joins (watchers.ts:640–653); the `noNoteOrStatusChange` gate (:1103–1125) | routing |
| `maxNewPerTenantTick` | number (:149) | **nothing** — unread at mint since build 4 | dead brake |
| `filled(n, facts)` | → string \| null (:180) | the fail-safe (:867), the escalation copy's claims (:1120–1126), the planner's gap view (`buildGapView`'s THE RECORD line) | **judgment** (read-only truth) |
| `moot(n, facts)` | → string \| null (:182) | nudge close (:834), observation dismiss (:961) | **judgment** (fact predicate) |
| `itemResolved(item, facts)` | → string \| null (:195) | item auto-resolve (:697) | **judgment** |
| `handoff(n, mode, naiveLocal?, ctx?)` | → `HandoffPlan` \| null (:205) | expiry (:1020), escalation (:1122), `handToManager` (compose.ts:76) | **manager copy** |

`SweepFacts` (:27–48) is the pre-fetched world a spec may judge against — activity-by-job,
visit/job status maps, the tenant clock, the cost ledger — pure functions, never a DB client.

**Detection does not live in the spec.** The candidate queries are DB listers
(`listOverdueConfirmedAssignments`, `listCostGapCandidates`) called directly from watchers.ts
(:469, :1265) with the firm's own thresholds; the two mint passes are hand-written blocks, one
per kind (:1208–1249, :1263–1314). The spec carries the *judgment and copy* halves plus routing
metadata. So "detectors stay ours" (the eyes, build 7's re-homing question) and "spec-less
sweep" (build 5) touch **different code**: stripping the spec's judgment half touches `moot`,
`filled`, `itemResolved`, `handoff` and the dead brake — not the candidate queries.

**The invisibility fact** (cited as :487–497 at commit `a60af27`; now watchers.ts:521–535 after
build 4's insertions): an open nudge whose kind has no registered spec is filtered out of every
sweep path — never answered, escalated, or expired — with one loud log. Creation is also
registry-gated at both mints (:1208, :1263–1264). **And the planner has the same gate**: its
merged gap list drops unregistered kinds too (`.filter((n) => !!specFor(n.kind, specs))`,
planner.ts:2265). The build-4 direction's constraint — "a planner-opened observation has no
`NudgeKindSpec` … The sweep that stops deciding must also stop needing per-kind specs to decide
with" (§6a entry 4) — therefore binds the *planner's own read* as much as the sweep: today a
planner-opened observation of a novel kind would be invisible to the sweep **and to the planner
that opened it**.

Registered kinds: `NUDGE_KIND_SPECS = [OVERDUE_VISIT_GAP_SPEC, JOB_COST_GAP_SPEC]` (:467);
`specFor` (:469) is the single lookup.

## Area 4 — NUDGES_MODE and the dead rails

**NUDGES_MODE gates nothing inside the sweep any more.** `nudgeMode` reaches `runWatchers` as a
parameter and is only *stored* (`summary.nudgeMode`, watchers.ts:405) — there is no remaining
branch on it (verified by grep; the mint blocks are explicitly "UNGATED BY nudgeMode",
:1257–1262, and the test at watchers.test.ts:693 pins "'off' still records the observation").
What still reads the env var:

- lifecycle.ts:415–429 — parse + loud stepError on a typo (unset = valid 'off').
- lifecycle.ts:562–580 — the mute check's `nudgeMode === 'live'` condition and its wording.
- Comments that cite it as a live configuration: watchers.ts:89–94 and **:502–508, whose tail
  ("Only rung-1 CREATION is nudgeMode-gated") is now stale** — creation is observation-minting
  and ungated; planner.ts:117 and :2715 (the `UNMENTIONED_CAP` rationale — "NUDGES_MODE
  off/shadow with PLANNER_MODE live" is the configuration where the filler grows forever);
  nudgeDecisions.ts:122.
- The retired-at-0 summary fields `nudgesWouldCreate`/`nudgesCreated` (watchers.ts:311–318 —
  "build 5 owns removing them") and their pins (lifecycle.test.ts:304–306).

**PLANNER_MODE vs NUDGES_MODE today**: PLANNER_MODE alone gates the planner step
(lifecycle.ts:459–476, deliberately not gated on NUDGES_MODE :464–469); WATCHERS_MODE alone
gates the sweep; `sweepLive: watchersMode === 'live'` (:513) is passed into the planner and is
what refuses the `escalate` verb when the sweep that would perform the handoff is dark
(planner.ts:1409–1416).

**`flagOverdueVisitGap`** (reviewItems.ts:198) has **no production caller** — its callers died
when mint-time flagging retired (build 4); only its own unit tests use it
(reviewItems.test.ts:84). The kind-generic `flagNudgeGap` (:145) carries every live handoff.

**`not_before` has no enforcer left.** The queue pull (`listQueuedNudgesForHost`,
nudges.ts:177–186) does not read it; compose — its old reader — is deleted (the comment at
nudges.ts:475, "`not_before` gates compose only", is stale). What remains: the planner's own
gap-view line ("currently held until", planner.ts:908), the send path clearing it
(planner.ts:1994–2003), and the observation column being *documented* advisory (migration
20260901130000, :54–56). A hold on a relic pending row is today enforced by exactly the same
thing as a hold on an observation: the planner's next look. The hold **rail** still clamps
relic holds to the 18h delivery ceiling (planner.ts:1678–1688) — a ceiling whose enforcement
arm is the sweep's expiry.

**The send window is gone** (build 2) and nothing replaced it as a gate: the queue's remaining
conditions are liveness (frozen-not-failed skip), a present `question`, the serve cap, and the
group-lead rule (nudgeQueue.ts:117–167). The working-hours *metric* keeps a fixed 7–19
convention of its own in `src/jobs/workingHours.ts` (a yardstick, not a claim — compose.ts:36–41).

## Area 5 — the judgment twins

Cadences first, because they decide every race: the sweep considers every firm **every 5
minutes**; the planner thinks about a firm **every 30 minutes** inside its approximate hours,
**every 120** outside them (planner.ts:307/324), and only if the firm has open work. The sweep
wins every race it is still allowed to run.

| sweep decision | planner twin today | the gap |
|---|---|---|
| moot-close / moot-dismiss (facts) | `close` basis `'record'` — but the code-computed RECORD line that authorises it exists **only for `job_cost_gap`** (buildGapView, planner.ts:888–903); `dismiss` works for any observation | for a cancelled **visit**, the planner has no rail-passable close: no RECORD line is printed, and `basis:'evidence'` needs a quote nobody spoke. The sweep is currently the only organ that can end a moot visit gap |
| fail-safe auto-close | `close` (either basis) **is** the primary path; the fail-safe exists solely for a planner that is dead (:186–190) | twin complete by design |
| escalation at the deadline | `escalate` (stamps `escalate_after = now`, planner.ts:2060) + `extend` (moves it out, ≤ asked_at + 48h, rails :1690–1750) | the planner chooses *when*; the sweep alone **performs** the handoff (builds the item, writes the resolution) — and the verb is refused when the sweep is not live (:1409–1416). The clock also fires with no planner decision at all — the 24h default is the fail-safe for a planner that never ran (watchers.ts:841–846) |
| 18h never-delivered expiry | **none** — `escalate` is refused on non-asked gaps (:1429–1435) and on observations (:1417–1428, "nothing hands it to a manager by itself") | an undelivered relic reaches the manager only via the clock; an *observation* never reaches the manager by any path but the planner's own `send` |
| item auto-resolve | **none** — no planner verb touches `review_items`; `close` moves only `nudges` | the manager queue self-cleans on code's verdict alone |
| serve-cap / delivery-failure handoffs | **none** | pure machinery-health judgments, queue-side |
| the count-only push | **none** (and dead in the pilot) | |

What the planner **cannot** decide today, because no verb exists: hand an un-asked gap to a
manager (the decline-verb draft's territory, superseded by build 4's `dismiss` for the
inconsequential case but not for the "a manager should see this un-asked" case); resolve or
annotate a review item; un-escalate (the prompt: "once the handover goes through the gap leaves
your list for good", plannerPrompt.ts:198–199); re-ask an escalated/expired subject (once-ever
indexes); expire; anything about delivery mechanics.

**The demoted-pass precedent, precisely** (the one existing example of actor → instrument): the
stale counter reads the tick's own gap list and history (`historyByNudge`), counts open
observations older than `OBSERVATION_STALE_HOURS = 72` with no applied non-`leave` decision
*inside the window* (planner.ts:2374–2394 — "untouched within the threshold", so an ancient
touch does not exempt forever), rides `PlannerTenantPlan.observationsStale` →
`lifecycle_runs.summary` → `npm run ticks` (`⚠ stale observations: N`, last-planned-write-wins,
`no_gaps` resets to 0 — report.mjs:294, :335–343, :377). It reddens nothing. Its known
weakness, recorded at build 4's review: it is computed *inside the planner*, so it goes silent
exactly when the planner does.

**The prompt already teaches the clocks as the sweep's** — phrasing that is part of what build 5
changes (plannerPrompt.ts, verbatim):
- "Every asked gap tells you the instant it escalates automatically. That is the clock extend
  has to beat" (:73–74).
- "leaving a gap out of your plan does NOT give anybody more time. Every asked gap is already
  counting down to an automatic escalation, and that clock runs whether or not you look at it —
  and you are not always awake." (:89–92)
- "If you leave an answered gap open it stays open until its deadline, and at the deadline it
  closes itself and records that you did not act on it." (:97–99)
- state "noticed" "carries no deadline: it simply stays in front of you until you decide"
  (:79–82) — the deadline-less stage already exists; build 5 decides what happens to the staged
  clocks behind the other three states.

## Area 6 — the escalation/review surface

**Writers of `review_items`** (statuses: `open → resolved | dismissed`; `resolveReviewItem`
reviewItems.ts:507, `resolveOpenReviewItemFor` :348):
- `flagNudgeGap` (:145) — every ladder handoff: sweep expiry (watchers.ts:1030), sweep
  escalation (:1148), queue serve-cap/failure via `handToManager` (compose.ts:82).
- `flagOverdueVisitGap` (:198) — dead, no production caller.
- Non-ladder writers, untouched by this build: `flagUnknownRefCapture` (:109),
  `openUnlinkedCallReview` (:276), `openCallActionReview` (:299), `flagOffboardingReminder`
  (:372), plus the confirmation/staging flows in `src/mcp/server.ts` that resolve their own
  items.

**Readers**: `list_pending_reviews` (server.ts:813) — the manager's Telegram board through
their seat agent, the queue's only interactive surface; `v_review_items` in the shared
`spine_read`/`query_spine` catalog (server.ts:711); the sweep's own `findOpenReviewItemsByKind`
for auto-resolve. **The planner reads `review_items` only if it chooses to**: nothing pushes an
item into its prompt (grep `review_items` in planner.ts: absent), but the doctrine explicitly
directs it to check `v_review_items where escalated_from_nudge is not null` before escalating
("a pattern of dismissals is a reason to extend instead", plannerPrompt.ts:265–267). A review
item can never *wake* the planner — the rung-2-has-no-ladder finding (§6a preamble): once a gap
is escalated, no software component follows up on it, ever.

**The push**: one count-only line per tenant per tick, only when `opened > 0`
(watchers.ts:1321) — once-only by design, "a quiet queue never re-pings on any cadence". The
pilot's `lifecycle-heart` has no `BOARD_BOT_TOKEN`, so `pushSkipped: true` and the push has
never fired ([[manager-push-is-dead]]); the pilot held **94 open `overdue_visit_gap` items**
with nothing following up (eng-memory, 2026-08-25 finding — a *pilot* observation, not a rate
to size from).

**Escalation when the assignee IS the manager**: there is no tier gate anywhere in the ladder —
observations mint for manager-tier roster rows like any other (`listTeam`), and the escalation
handoff opens an item in the *same person's* queue that the silent ask was addressed to.
Functionally, "escalate" then re-routes a question from the manager's chat to the manager's
board ([[managers-are-nudgeable]]: the real gap). The **solo-operator ruling** (2026-08-26,
recorded, NOT built): solo = one rung; the planner asks once; an unanswered ask stays in the
review queue; "delete the handoff pretence, don't re-word it". The code that ruling names is
all still present and unchanged at this commit: the escalation loop, both handoff copies, the
rung-2 framing in the prompt and item suggestions.

## Area 7 — the couplings

**The eval simulator runs the real sweep.** `runTick` calls
`runWatchers(nowIso, 'live', {stubs}, 'live')` before every planner call (plannerSim.ts:508–519)
— arcs genuinely experience moot, escalation, expiry and the fail-safe mid-run. Seeding:
asked/queued/pending-relic states seed `nudges` directly; pending specs seed **observations**
(a pending spec with `askedAt`/`escalateAfter` is refused loudly, :256–262). The timeline's
`deliver` step flips pending/queued → asked by direct update (:867–880); `manager_resolve`
writes real `review_items` (:884–916). `runArc` counts `noticed` as open (:824–834) and caps at
`MAX_ARC_TICKS = 12`.

**The graders are sweep-aware.** `arc-escalations` counts planner escalations from decision
rows PLUS sweep escalations inferred from final status with no planner row —
"the sweep escalates on its own clock and never writes a decision row"
(plannerEvalGraders2.ts:172–187). `closedBy` (:224–246) grades against `resolved_at` however
the close happened. The `OPEN` set includes `noticed` (:43).

**Scenario families that script sweep behavior** (plannerCorpus.ts — 62 scenarios in 8
families): every `visitWorld` seeds an `escalateAfter` offset, so the deadline column's
semantics are load-bearing corpus-wide. Directly scripted: **late-stuck** (LS-01/02/03/05
escalate-vs-clock; LS-04 `maxEscalations: 0` — the sweep must NOT escalate; LS-07 "leave, and
the 18h expiry owns it"; LS-08 deliver-mid-arc, already dated model-contingent at :623–629);
**premature** (don't escalate before the clock earns it); **context-miss** (extend histories
walking `escalate_after`). `manager_resolve` steps ride the escalation surface.

**`npm run ticks` prints no watcher counter.** report.mjs reads
`summary.teamLeadPlanner.*` and `summary.ladderMute` only — `nudgesEscalated`, `nudgesExpired`,
`nudgesResolved`, `nudgesAutoClosed`, `observationsCreated/Mooted`, `itemsOpened/Resolved` all
land in `lifecycle_runs.summary.watchers` (redactForRecord passes them through,
lifecycle.ts:170–191) and are read by nobody downstream. The sweep's alarms are `console.error`
lines and the `ok` flag.

**Metric views**: `mv_gap_outcomes` buckets on `nudges.status` + `escalatedFromNudge` items —
sweep-authored statuses are its raw data; `mv_escalation_fates` carries
`by_planner` = "an applied `escalate` decision exists" — the one place sweep-driven and
planner-driven handoffs are distinguished (20260824020000, :42–74); `mv_whiplash` and
`mv_extend_effectiveness` read `nudge_decisions` (planner/sim authored only).

**Tests pinning sweep decisions** (watchers.test.ts, by describe block): the firm's own
thresholds (:195); core detection/cutoffs (:352); the ladder (:692 — mint-ungated, moot reaches
observations :850, activity closes nothing :930, rung 2 :989, delivery deadline :1045);
`escalate_after` semantics (:1189); kind-generic item auto-resolve (:1294); the registry
(:1464 — stranded kinds :1478, brakes unread :1513/:1556); detector #2 (:1597); **the deadline
fail-safe** (:1908 — including the `unmentioned`-rows hazard :2017 and the
PLANNER_JUDGMENT_ACTIONS pin :2207); manager-copy claims (:2228); group expiry (:2679).
lifecycle.test.ts pins the summary shapes (:304–306 retired-at-0 fields; :429/:846 limitHits).
`scripts/agentic-eval/run.mjs` resets `observations` per scenario (:133–140, :231–234);
`scripts/seed.mjs` and `scripts/spine-eval/world.mjs` gained observation rows in build 4.

**The box-runner contract**: the box pulls `GET /control/nudges` and acks
`POST /control/nudges` on its own 5-minute loop (httpServer.ts:561–566); it dedupes on the
delivery item id (`sent-<id>` markers, the reason a leaderless group freezes rather than
promotes — nudgeQueue.ts:117–141). The contract consumes `queued` rows and the
`markNudgeAskedGroup` flip; it never sees observations.

## External Dependencies

Render Cron (`*/5`, at-most-one-run, delayed-not-dropped firings), Supabase/PostgREST (the
silent 1000-row cap shapes every lister), Telegram via `sendBoardMessage` (the dead push), the
box fleet's `nudge-runner.sh` (pull/ack). No model call exists anywhere in the sweep or queue.

## Constraints and Invariants

- **One id, two stages** (build 4): a sent gap's nudge row shares the observation's uuid;
  `nudge_decisions` spans both; readers coalesce.
- **Once-ever, three stores**: `uq_observations_subject_ever` owns "noticed once, ever";
  `uq_nudges_subject_ever` and the review-item dedup keep pre-split history from re-surfacing
  (watchers.ts:613–622).
- The sweep **never writes `nudge_decisions`**; its record surfaces are `nudges.status/resolution`,
  `review_items`, `observations.dismiss_reason`, counters, and `console.error`.
- Fail direction is uniform: every ambiguity fails **toward the manager** (decision-read failure
  → escalate without reasons and hold the auto-close, :768–781; two-gaps-one-job → decline the
  auto-close, :877–894; expiry loses to a racing ack, :1046–1057).
- The planner's `escalate`/`extend`/`hold` rails mirror the sweep's exact clock arithmetic
  (`currentDeadlineMs` planner.ts:1085 ↔ `dueAtOf` watchers.ts:738 — "if the two disagreed,
  `extend` could report success while the sweep escalated on a different clock").
- `PLANNER_JUDGMENT_ACTIONS` must contain every planner verb, or the fail-safe fires under a
  live planner (planner.ts:80–82; pinned watchers.test.ts:2207).
- `lifecycle_runs` step names are a stable external reference — renumbering invalidates runbooks.
- Harness-rebuild standing rules: nothing deploys until the whole order is evaluated;
  observations migration applies before code; REFLECTOR_MODE deleted at deploy time.

## Decision Points

Stated factually — what the fork is and what each side involves, given the code today. No
recommendations.

**(a) Per sweep judgment: move it, keep it, or kill it.** The inventory is area 2's nine rows;
the twin table is area 5's. Three distinct shapes exist: judgments with a complete planner twin
(the fail-safe auto-close — the twin IS the design and the sweep's copy exists only for a dead
planner); judgments with a partial twin (moot — the planner can `dismiss` a moot observation
and `close` a moot cost gap on the RECORD line, but has no rail-passable way to end a
cancelled-visit *ask*; escalation — the planner owns the *when* but not the *handoff*);
judgments with no twin at all (expiry, item auto-resolve, the queue's give-up rules, the push).
The solo-operator ruling bears directly on the escalation/expiry handoffs (delete the pretence,
not re-word it), and the pilot's dead push means one of them has never actually reached a
person.

**(b) What, if anything, stays time-triggered.** Today three clocks act (24h escalation, 18h
delivery, the fail-safe's 24h liveness window) and one clock only *reports* (the 72h stale
counter, the demoted-pass pattern). If the acting clocks move to the planner: the
planner-goes-quiet failure mode changes shape — today a dead planner still escalates every gap
on the 24h constant ("the safe behaviour lives in the ABSENCE of a value rather than in a
writer being healthy", watchers.ts:841–846) and the stale counter goes dark WITH the planner
(it is computed inside `runPlanner`). Any alarm that must survive planner death has to live in
the sweep or the report, not the planner — the counter's placement is the one existing
counter-example, recorded as such at build 4's review.

**(c) Where the judgment half of the spec goes.** "Spec-less" strips exactly `moot`, `filled`,
`itemResolved`, `handoff` and the dead brake (area 3's table); detection queries are already
elsewhere. Two registry gates then need an answer: the sweep's stranded-kind filter
(watchers.ts:521–535) and the **planner's own** `specFor` filter (planner.ts:2265) — as long as
either survives, a planner-opened observation of a new kind is invisible to the component that
opened it, which is the exact constraint §6a entry 4 records against this build.

**(d) NUDGES_MODE's retirement footprint** (should the build take it): lifecycle's parse +
stepError + the mute check's condition and wording (:415–429, :562–580); `runWatchers`'
4th parameter and `summary.nudgeMode`; the retired-at-0 `nudgesWouldCreate`/`nudgesCreated`
fields and their lifecycle.test pins (:304–306); four stale comments (watchers.ts:502–508 tail,
:89–94; planner.ts:117, :2715; nudgeDecisions.ts:122); the Render env var itself (a deploy-time
action under the standing rule); the eng-memory environment map.

**(e) What the eval scripts once sweep judgments move.** `runTick`'s embedded
`runWatchers('live', …, 'live')` call is the sweep's presence in every scenario; every
`visitWorld` seeds `escalateAfter`; late-stuck and premature grade against the clocks; the
grader's sweep-escalation arm infers handoffs from final status; LS-07 expects the 18h expiry
to own a frozen row; `deliver` writes the status flip the queue ack owns in production. Each of
those is a fixture shaped like the current sweep. (The eval re-levelling is already ruled to
happen AFTER builds 4–7 — this lists what will have moved, not work for this build.)

**(f) The deadline columns if the clocks stop firing.** `escalate_after` is written by two
planner verbs (`escalate` = now, `extend` = later, both `['asked']`-guarded) and read by
`dueAtOf`/`currentDeadlineMs` and the gap view's "escalates automatically at" line;
`not_before` already has **no runtime enforcer** (area 4) — the hold is real only because the
planner honors its own note next tick. A sweep that stops escalating leaves `extend` moving a
number nothing reads and the hold rail clamping to a ceiling (18h) nothing enforces; the prompt
paragraphs quoted in area 5 would then teach clocks that do not exist.

**(g) Delivery: mechanics vs judgment.** The queued→asked flip is the box's ack of an observed
fact and rides the host-token trust boundary; the queue's *decisions* are the give-up rules
(serve cap, attempt cap, leaderless freeze, liveness skip) and each ends in `handToManager` —
the same manager-handoff judgment as the sweep's, living in a different file on a different
clock. Whether "the sweep stops deciding" includes the queue's give-up rules is a scope
question the charter's wording does not answer by itself.

## Open Questions

- Whether Render's delayed-not-dropped cron semantics ever stack multiple delayed firings is
  still unverified upstream (lifecycle.ts:647–650 records the docs' silence).
- The moot predicate treats a **completed** visit the same as a cancelled one ("nothing left to
  ask", nudgeKinds.ts:277–282) — whether "completed" is a *fact* in the 2026-08-22 sense or a
  judgment about the question being answered was never separately ruled on; the sweep closes
  both today.
- `PLANNER_SILENCE_HOURS`, `NUDGE_DELIVERY_DEADLINE_HOURS` and `NUDGE_ESCALATE_HOURS` are
  documented as inherited-not-retuned (watchers.ts:156–171); no measurement exists of how often
  each clock actually fires in the pilot (and pilot rates could not be sized from anyway —
  [[never-size-from-the-pilot-box]]).
- Whether the planner's `close` should ever gain a rail-passable path for a moot *visit* ask
  (today only the sweep can end one) is a build-5/6 boundary question: the verb exists, the
  authorising fact line does not.
