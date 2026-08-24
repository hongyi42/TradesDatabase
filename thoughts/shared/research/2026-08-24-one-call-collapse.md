---
date: 2026-08-24
branch: main
commit: 85da452
topic: the one-call collapse — every model call left in the nudge pipeline, what context each sees, what compose still does after ②b/④, and the seams a collapse would touch
supersedes: nothing
---

**`supersedes:` is not optional bookkeeping.** This documents the current state ahead of the
collapse; it overturns nothing.

## Summary

The "investigate / plan / compose" stages named in the collapse direction
([[collapse-the-model-call-stages]], user 2026-08-22) are already two-thirds merged. The
planner is ONE agentic call that investigates with its own read tools (④) and decides — and
since ②b it also writes every word humans see: the technician question (`question` on a
`send`), the manager handoff note, and the manager-assistant briefing. What remains un-merged
is **compose**: a separate single-shot model call (`runTeamLeadCompose`) that still runs every
5-minute tick and writes the technician question for any pending gap the planner has NOT
left an applied draft on. With the planner live, compose is a fallback lane that mostly
forwards planner drafts without calling a model; with the planner off, it is the only voice
the ladder has. The collapse (Stage 2 of the recorded plan) = retire compose's model call.
The code around it — message assembly, the ask window, attempts, the manager handoff for
thin rows — is not model work and was never part of the collapse. The eval corpus
(re-judged baseline 63/65 Opus vs 58/65 GLM, `docs/agentic-eval-rejudge-2026-08.md`) already
exercises exactly the collapsed shape: its loop is sweep → planner only, with delivery
simulated — so the yardstick reruns unchanged, graded by a frontier model (user ruling
2026-08-24, no Haiku fix).

## Entry Points

- [src/jobs/lifecycle.ts:361](src/jobs/lifecycle.ts#L361) — step 9, the planner: runs on the
  half-hour only (`getUTCMinutes() % 30 < 5`), gated by `PLANNER_MODE`, deliberately NOT
  gated by `NUDGES_MODE` (rollback-rescue doctrine: silence must always escalate).
- [src/jobs/lifecycle.ts:405](src/jobs/lifecycle.ts#L405) — step 10, compose: every 5-minute
  tick, gated `NUDGES_MODE === 'live'` (a rolled-back ladder must not keep composing).
- [src/teamLead/planner.ts:1178](src/teamLead/planner.ts#L1178) — `runPlanner`: per-tenant
  agentic loop; the single `runToolLoop` call is at
  [src/teamLead/planner.ts:1349](src/teamLead/planner.ts#L1349).
- [src/teamLead/compose.ts:157](src/teamLead/compose.ts#L157) — `runTeamLeadCompose`: the
  pending-row sweep whose model call ([line 274](src/teamLead/compose.ts#L274)) is the
  collapse's target.

## Key Files

**The planner (the call everything folds into):**
- [src/teamLead/planner.ts](src/teamLead/planner.ts) — `buildGapView` (line 414) renders each
  gap's block: state, ages, the question asked, deadlines, the VERBATIM date vocabulary, the
  watched-history line, bounded evidence + money since the ask, THE RECORD line for cost
  gaps. Verbs and rails: `send`/`hold` are pending-only (line 845); `leave` on a pending row
  is refused with teaching text (line 871: "a pending question is sent as soon as it is
  composed — use hold to wait"); `escalate` only pulls `escalate_after` to now — the SWEEP
  performs the handoff (line 1137); `close` needs basis+citation; date rails clean the
  handoff note, agent context, and question draft (lines 1036-1056; drops are logged as
  noteDrops, never refusals). `send` applies by CLEARING `not_before` on the pending row
  (line 1128) — the planner does not queue; compose does, next tick, using the stored draft.
  Skips: tenants with no open gaps, and the whole tenant outside the ask window (line 1247 —
  "the single largest lever on what the planner costs").
- [src/teamLead/plannerPrompt.ts](src/teamLead/plannerPrompt.ts) — the doctrine. Line 111:
  "When you choose `send`, YOU write the question… A question that breaks these is thrown
  away and the system writes its own instead." NOTE a stale header comment at line 23 still
  says "the question's wording — compose still writes that" — pre-②b text.
- Loop rails ([src/model/toolLoop.ts:35-55](src/model/toolLoop.ts#L35-L55)): 8 turns, 90s
  budget, 20k chars/result, 8 calls/turn. The planner passes `maxTokens 8192`,
  `reasoningEffort 'low'`, label `teamLeadPlanner`.

**Compose (what retires):**
- [src/teamLead/compose.ts](src/teamLead/compose.ts) — per tenant: list `pending` rows of
  registered kinds → honour `not_before` holds (planner pacing) and the 7am–7pm firm-local
  ask window (lines 52-67; out-of-window rows are held untouched so the day phrase is baked
  fresh) → ONE batched read of planner decisions (line 227): the newest APPLIED `send` with a
  `question_draft` wins → if a draft exists, NO model call (`draftedByPlanner` counter);
  else `runForcedTool` (line 274: `maxTokens 300`, `reasoningEffort 'none'`, label
  `teamLeadCompose`) which may DECLINE → `handToManager` (line 77, rung-2 fallback: flag
  first, then cancel) → accepted question is flattened (≤500 chars), checked for
  footer-impersonation, then `markNudgeQueued` with `prepared.assemble(question)`.
  `MAX_COMPOSE_ATTEMPTS = 3` (line 29); thin rows (`prepare` returns null) hand to the
  manager without any model call.
- [src/teamLead/composeCopy.ts](src/teamLead/composeCopy.ts) — the CODE half that stays
  regardless: `assembleNudgeMessage` (line 138) builds the delivered message around the
  model's sentence (code-printed evidence date — the weekday guard's ally), plus the per-kind
  prompts (`COMPOSE_SYSTEM` line 36, `COST_COMPOSE_SYSTEM` line 154) that would be deleted
  with the call. `FOOTER_DELIMITER` survives only as a rejection pattern — ④b retired the
  footer itself (stored = shown = sent).
- [src/jobs/nudgeKinds.ts](src/jobs/nudgeKinds.ts) — the kind registry each side reads:
  `spec.compose.prepare/system/tool` (compose's context builder) and `spec.handoff`
  (the sweep's template copy when no planner note exists).

**The clocks that bound any latency argument
([src/jobs/watchers.ts](src/jobs/watchers.ts)):** `NUDGE_ESCALATE_HOURS = 24` (line 120),
`NUDGE_ESCALATE_MAX_HOURS = 48` (line 128), `NUDGE_DELIVERY_DEADLINE_HOURS = 18` (line 158).

**Transports and routing** (documented in
[thoughts/shared/research/2026-08-23-per-call-model-routing.md](thoughts/shared/research/2026-08-23-per-call-model-routing.md)):
planner and compose already run in the SAME process (`lifecycle-heart` cron,
`MODEL_PROVIDER=anthropic`, Opus 5), so the collapse changes no routing and almost no cost —
compose bills ~5 calls/day of ≤300 tokens vs the planner's 24 in-window ticks. Coherence,
not cost, per the direction memory.

**The yardstick:** `scripts/agentic-eval/` + `src/eval/plannerSim.ts` / `plannerCorpus.ts` /
`plannerEvalGraders2.ts`; baseline `docs/agentic-eval-baseline-2026-08.md`; corrected
verdicts `docs/agentic-eval-rejudge-2026-08.md`.

## Data Flows

Today — two model calls can touch one gap, on different cadences:

```
every 5 min                             :00 / :30 only, in ask window
┌─────────────┐                         ┌──────────────────────────────┐
│ SWEEP (code)│ detects → nudge PENDING │ PLANNER (model, 1 loop/tenant)│
└─────────────┘                         │  reads: gap blocks + its own  │
      │                                 │  spine_read / recall_decisions│
      │                                 │  writes: verb + reason +      │
      │                                 │  question draft + handoff note│
      │                                 │  + agent context              │
      │                                 │  send = clear not_before ─────┼──┐
      ▼                                 └──────────────────────────────┘  │
┌───────────────────────────────────────────────┐                         │
│ COMPOSE (every 5 min, NUDGES_MODE=live)        │ ◄───────────────────────┘
│  pending row + planner draft? → NO model call  │
│  pending row, no draft?       → forcedTool call│  ← the call that retires
│  either way: code assembles → QUEUED           │
└───────────────────────────────────────────────┘
      │ box runner v2 delivers verbatim → ASKED
      ▼
  answers close via the PLANNER (③); silence escalates via the SWEEP's clocks
```

The collapsed target (Stage 2 of the direction memory): the planner remains the only model
call; pending rows either carry its draft or wait for its next tick; compose's surviving
duties (assembly, window, attempts, thin-row handoff) are code.

The eval already runs this target shape: `runTick` = `runWatchers` → `runPlanner` (no
compose step; the `deliver` timeline step simulates pending→asked). Both arms sent 10/10
pending-gap scenarios WITH planner-written drafts in the baseline run.

## External Dependencies

Anthropic API (Opus 5 in `lifecycle-heart`) via the two shared transports; Supabase
(`nudges`, `nudge_decisions`, `review_items`, cost ledger). Delivery is the OpenClaw box
runner (out of scope — ④b, verbatim send).

## Constraints and Invariants

1. **Compose is the ladder's voice when the planner is off.** `PLANNER_MODE` and
   `NUDGES_MODE` gate independently, on purpose. Retiring compose's model call puts the
   technician-facing ask behind `PLANNER_MODE` — the direction memory names this cost #1,
   "decide deliberately, not discover."
2. **The planner does not queue.** Its `send` clears `not_before` on a pending-only guard;
   `markNudgeQueued` is compose's write today. Whoever owns pending→queued after the
   collapse must also own assembly and the freshness rule (day phrases are baked at
   compose time — a held row must be composed FRESH, which is why holds and the overnight
   window leave rows untouched).
3. **Cadence asymmetry.** Compose runs every in-window 5-minute tick; the planner every 30
   minutes, and skips no-gap tenants and out-of-window hours entirely. Worst-case added ask
   latency if sends wait for the planner: ~25 minutes — bounded far below the 18h delivery
   deadline and 24h never-asked backstop, but it is a product-visible change.
4. **Failure isolation inverts** (direction memory cost #2): a compose failure today costs
   exactly one gap (per-row try/catch, attempts, 3-strike handoff). One planner call carries
   ALL of a tenant's gaps; its failure already means "no decisions this tick" and the sweep's
   fail-safes own the floor. The eval measured one such death (GLM CM-02, 8-turn ceiling).
5. **The decline path is judgment compose owns today.** Its model may answer `ask:false` →
   manager handoff. The planner's verb set already expresses every version of "don't ask"
   (hold / escalate / close), so the judgment doesn't vanish — but the code path mapping
   "planner never chose send" onto compose's decline/handoff semantics does not exist yet.
6. **Thin/tampered rows never reach a model** (`prepare` → null → `handToManager`) — code,
   unaffected, must survive.
7. **The date rails differ by lane.** The planner's question draft is railed at submit time
   against the gap's date vocabulary (drops logged as noteDrops); compose's lane bakes the
   day phrase in code. The re-judge showed rail drops are a real GLM failure mode
   (LN-04's note died on "this morning") — whichever lane survives is the only lane.
8. **The stale comment** at plannerPrompt.ts:23 ("compose still writes that") predates ②b —
   a two-line cleanup riding along.
9. **Ledger visibility:** `teamLeadCompose` disappearing from cost_events is expected and
   should be recorded, or a dashboard watcher may read it as breakage.

## Decision Points

1. **Who performs pending→queued.** (a) The planner's applied `send` calls the assembly +
   `markNudgeQueued` directly (compose becomes a pure code function invoked from
   applyDecision); (b) compose survives as a MODEL-FREE step that only forwards planner
   drafts (draftless rows wait or hand to the manager); (c) status quo. Each option decides
   where the freshness rule and the ask window live.
2. **The rollback combination** (`NUDGES_MODE=live`, `PLANNER_MODE=off`). Today the ladder
   still asks via compose. After the collapse: accept that the ladder is mute without the
   planner (and document it), or keep compose's model call dormant as the explicit fallback
   for exactly this combination.
3. **Planner cadence.** Stay half-hourly (accept ~25 min worst-case ask latency), move to
   every tick (5-6× more planner calls — the cost lever the code comments name), or a hybrid
   (every-tick ONLY when pending rows exist, half-hourly otherwise).
4. **Draftless-row policy.** A pending row the planner saw but did not `send` (or never saw —
   created seconds after its tick): wait for the next planner tick, or a bounded code
   fallback. The 24h never-asked deadline is the current backstop either way.
5. **What the collapse run measures.** The corpus reruns unchanged (the eval loop already has
   no compose); grading per the user's 2026-08-24 ruling uses a frontier-model judge, diffed
   per family against the re-judged baseline (Opus 63/65, GLM 58/65). Corpus nits recorded in
   the baseline follow-ups (FC-08 claim string, MG-07 re-author, weekday `--anchor`, 4 AM
   visit times) can fold into the same prep.
6. **Compose's counters and tests.** `ComposeSummary` (composed / draftedByPlanner / held /
   heldNotBefore / handoffs) is the observability for pacing and the planner-writes-questions
   split; its replacement shape is a design choice, and the compose test suite either
   follows the surviving code paths or retires with the call.

## Open Questions

- Does the cost-gap compose prompt (`COST_COMPOSE_SYSTEM`) encode any asking behavior the
  planner prompt lacks? The planner's question rules (plannerPrompt.ts:111-120) are
  kind-generic; the baseline showed both models writing serviceable drafts, but nobody has
  diffed draft quality per KIND against compose's output.
- `serve_count`/`attempts` semantics after the transition — attempts today counts COMPOSE
  failures; what does it count when composing is a code-only assemble?
- Whether any consumer outside lifecycle.ts calls `runTeamLeadCompose` (tests aside) — not
  exhaustively audited here.
- The pilot's real pending-gap arrival pattern (how often a gap would actually wait the
  extra ~25 minutes) — measurable from nudges.created_at vs asked_at before choosing the
  cadence option.
