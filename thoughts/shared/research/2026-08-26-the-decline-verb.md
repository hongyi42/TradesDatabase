---
date: 2026-08-26
branch: feat/the-tick-leaves-a-trace
commit: 297db39
topic: The decline verb — how the planner would say "do not ask the technician this, give it to a person" on a gap that has not gone out yet
supersedes: nothing
---

**`supersedes:` note:** overturns nothing. It documents an accepted gap recorded at the one-call
collapse (`thoughts/shared/plans/2026-08-24-one-call-collapse.md`, deferred item (a)) and closes a
sequencing question raised in `thoughts/shared/research/2026-08-25-planner-tick-observability.md`.

## Summary

A **gap** is a hole in the record the system found on its own — a visit with no write-up, a
finished job with no cost. Each becomes a row in the `nudges` table, and a row that nobody has been
contacted about yet sits in status `pending`. Every 30 minutes the **planner** (the one model call
in this pipeline) looks at each open gap and picks exactly one **verb** from a list of six. There
is no verb meaning *"this should not be asked of the technician at all — hand it to a person."*

That capability existed until 2026-08-24. The retired `compose` stage had an `ask` flag, and
`ask !== true` ran a complete decline path: hand the gap to the manager, then close the row as
`cancelled` with the resolution `declined: <reason>`. It died with compose in the one-call collapse
(PR #179) and nothing replaced it. Today the same judgment has no expression: `escalate` and
`send`/`hold` are rail-refused or meaningless on a `pending` row, and `close` demands evidence the
gap is *filled*, which it is not. Such a row therefore waits out the 18-hour delivery deadline and
reaches the manager as a **timeout** rather than a **decision** — reading as neglect when it was
judgment.

The most useful finding of this research is that **the historical implementation answers most of
the design questions**, and the one genuinely open question is narrower than expected: not "what
should decline do" but "should the manager's *human-facing copy* distinguish a deliberate decline
from a timeout, given that both correctly say nobody was asked."

## Entry Points

- **`src/teamLead/planner.ts:66`** — `PLANNER_ACTIONS`, the six verbs the model may submit.
- **`src/teamLead/planner.ts:78`** — `UNMENTIONED`, code's own seventh verb, deliberately excluded.
- **`src/teamLead/planner.ts:954`** — `validateDecisions`' unknown-action refusal.
- **`src/teamLead/planner.ts:1392`–`1560`** — the `applyDecision` switch; one `case` per verb.
- **`src/jobs/watchers.ts:188`** — `PLANNER_JUDGMENT_ACTIONS`, the sweep's liveness set.
- **`src/jobs/watchers.ts:838`–`877`** — the 18-hour delivery-deadline expiry, today's only exit
  for a pending row nobody can be asked.
- **`src/teamLead/compose.ts:57`** — `handToManager`, the surviving half of the dead decline path.

## Key Files

| Path | Role | Key exports |
|---|---|---|
| `src/teamLead/planner.ts` | The one model call. Owns the verb vocabulary, the rails, and the apply switch. | `PLANNER_ACTIONS`, `UNMENTIONED`, `runPlanner` |
| `src/teamLead/plannerPrompt.ts` | The `submit_plan` tool schema the model sees, and the doctrine text naming when each verb applies. | `SUBMIT_PLAN_TOOL` |
| `src/jobs/watchers.ts` | The 5-minute sweep. Holds `PLANNER_JUDGMENT_ACTIONS` (liveness) and the delivery-deadline expiry. | `PLANNER_JUDGMENT_ACTIONS`, `NUDGE_DELIVERY_DEADLINE_HOURS` |
| `src/teamLead/compose.ts` | 103 lines, all that survived the collapse: the ask window and `handToManager`. | `insideAskWindow`, `handToManager` |
| `src/jobs/nudgeKinds.ts` | Per-kind registry. `handoff(n, mode, …)` builds the manager item; `mode` is `'escalated' \| 'expired'`. | `NUDGE_KIND_SPECS`, `specFor` |
| `src/db/nudges.ts` | The row and its status enum. | `NudgeStatus`, `OPEN_NUDGE_STATUSES`, `markNudgeOutcome` |
| `src/db/reviewItems.ts:145` | `flagNudgeGap` — writes the manager's item. Already accepts `agentContext`. | `flagNudgeGap` |
| `src/eval/plannerCorpus.ts` | 66 scenarios, 9 families. `people-judgment` (`PEOPLE`, from :627) is the nearest neighbour. | `PLANNER_SCENARIOS` |

## Data Flows

### What the dead path did, verbatim

Recovered from `53cfa73:src/teamLead/compose.ts:285-303` — the last commit before the collapse:

```ts
if (args.ask !== true) {
  // A decline is a judgment about ASKING, not about the gap — the
  // manager still gets it (F1).
  //
  // Deliberately NOT gated on the handoff landing. […] Closing bounded
  // beats looping unbounded.
  if (await handToManager(n, flagNudge, reviewItemExists, specs)) summary.handoffs += 1;
  const reason = typeof args.reason === 'string' ? args.reason : 'model declined';
  const moved = await markOutcome(n.id, tenantId, 'cancelled', `declined: ${reason}`);
  if (moved) summary.cancelled += 1;
  continue;
}
```

So the historical shape was: **hand over first, then `cancelled` with a `declined:` resolution**,
and the close was *deliberately not gated* on the handover landing — documented, with the reason
that a row too incoherent to hand over would otherwise be re-composed (a fresh billed call) every
tick forever.

### Today's path for the same row

```
detector writes nudge (pending)
        │
        ▼
planner tick (every 30 min)  ─── send   → rail-refused? no: valid, but WRONG (we don't want to ask)
                             ─── hold   → valid: writes not_before, defers, does not resolve
                             ─── escalate → REFUSED (planner.ts:1034) "escalation is for silence
                                            after a question went out"
                             ─── close  → needs evidence the gap is FILLED; it isn't
                             ─── leave  → valid: changes nothing, records "I looked"
        │
        ▼  (…up to 36 ticks later…)
watchers.ts:838  created_at ≤ now − 18h  →  expired  →  handToManager(n, 'expired')
        │                                                       │
        ▼                                                       ▼
   status: (per expiry path)                        review_items row, Stage-0 copy
```

The rail text at `planner.ts:1034` names the current answer explicitly: *"a gap that cannot be
delivered reaches the manager on its own"* — i.e. the 18-hour deadline is, by design, the disposal
route for a pending row that will never be asked.

### `handToManager`, and the mode that shapes the copy

`compose.ts:79` calls `spec.handoff(n, 'expired')`. The mode union is `'escalated' | 'expired'`
(`nudgeKinds.ts:201`), and the two differ in what they are permitted to claim:

- **`'escalated'`** quotes the ask time and requires `n.asked_at` plus a per-tenant `naiveLocal`
  closure; it returns `null` without them (`nudgeKinds.ts:315-316`).
- **`'expired'`** uses the Stage-0 copy — the plain unreported-visit wording — because *"the ask
  never landed, and the manager must not be told it did"* (`nudgeKinds.ts:307`, `watchers.ts:877`).

For a decline, `'escalated'` is both wrong and structurally impossible (no `asked_at`). `'expired'`
is *honest*: nobody was asked, and the copy says nothing to the contrary. What `'expired'` does not
carry is **why** the item arrived.

### The one channel that can carry intent without changing the copy

`flagNudgeGap` (`reviewItems.ts:145-162`) already accepts:

```ts
// The planner's briefing for the manager's AGENT (④b fourth rail). Stored in
// detail, surfaced by list_pending_reviews, never rendered into suggestion.
agentContext?: string | null;
```

So a reason can reach the manager's *assistant* — and, by the ④b doctrine, never the manager's eyes
directly. `escalatedFromNudge` (`:159`) separately preserves the audit thread from the nudge row to
the item.

## External Dependencies

None new. Everything named here is in-repo. The manager-facing surface is reached through
`review_items`, read by the `list_pending_reviews` tool (manager tier only).

## Constraints and Invariants

1. **A seventh verb must be added in TWO places or the fail-safe misfires.** `planner.ts:62-65`
   carries the warning in its own comment: *"Adding a verb here means adding it to
   `PLANNER_JUDGMENT_ACTIONS` in watchers.ts too, or the sweep's fail-safe stops counting it as
   liveness and starts firing under a planner that is working."* The pair is pinned at
   `watchers.test.ts:1862-1865`, which asserts both the exact set and that every `PLANNER_ACTIONS`
   member is present in `PLANNER_JUDGMENT_ACTIONS`.
2. **`UNMENTIONED` marks the boundary a new verb must not cross.** It is code's record of the model
   having said *nothing*, deliberately not submittable: *"If it were submittable, 'I chose silence'
   and 'silence was observed' would collapse into one value and the corpus would stop being able to
   tell them apart"* (`planner.ts:69-74`). A decline is the opposite — an explicit judgment — so it
   belongs in `PLANNER_ACTIONS`, not beside `UNMENTIONED`.
3. **The status enum already contains `cancelled`** (`nudges.ts:12-20`) and it is not currently
   written by any planner verb; the historical decline path is what used it.
4. **`handToManager` returning `false` means one specific thing** — the spec could not build a plan
   at all (thin/incoherent context) — because `flagNudgeGap`'s `null` path always means "already
   flagged", which the existence probe converts back to `true` (`compose.ts:99-102`). Callers are
   instructed to **freeze** such a row, never cancel it (`compose.ts:82-84`).
5. **The 18h deadline is per-row against `created_at`, and expands across an ask-group** so a whole
   message shares one fate (`watchers.ts:848-876`).
6. **Escalation is performed by the sweep, not the planner** — `escalate` merely pulls
   `escalate_after` forward, and is refused entirely when `WATCHERS_MODE` is not live
   (`planner.ts:1026`), because otherwise the decision log would read `applied` for a handover
   nobody received.
7. **`byAction` is a keyed record, not an enumerated schema.** The observability work landed at
   `297db39` storing the whole `LifecycleSummary` as `summary jsonb not null`
   (`supabase/migrations/20260826120000_lifecycle_runs.sql`), and `src/db/lifecycleRuns.ts` contains
   no reference to any action name. `redactForRecord` (`lifecycle.ts:170-191`) replaces the
   per-decision `decisions`/`dropped` arrays with counts but leaves `byAction` intact.

## Decision Points

**1. What terminal status a declined row takes.** History used `cancelled` with resolution
`declined: <reason>`. The enum also offers `escalated`, which would be inaccurate — nothing was
escalated, and escalation has a specific meaning (silence after an ask). Keeping `cancelled` reuses
an existing value no planner verb writes today; introducing a new status would touch
`OPEN_NUDGE_STATUSES` consumers and every status-gated rail.

**2. Whether the manager's HUMAN-FACING copy distinguishes a decline from a timeout.** This is the
real fork, and all three options are honest — they differ in what the manager sees:
   - **(a) Reuse `'expired'` unchanged.** Zero new copy. The manager's item is byte-identical to a
     timeout's; the distinction lives only in the nudge row's `resolution` string, which is an audit
     field the manager surface does not render.
   - **(b) Reuse `'expired'` and pass `agentContext`.** No new copy and no new mode. The manager's
     *assistant* learns it was a deliberate decline and why, via `list_pending_reviews`; the ④b
     doctrine already forbids that text reaching the person directly. The human-facing item still
     reads identically to a timeout.
   - **(c) Add a third handoff mode `'declined'`.** Requires new copy in every registered kind (two
     today: the visit gap at `nudgeKinds.ts:292`, the cost gap at `:419`) and widens the
     `'escalated' | 'expired'` union at `:201`. It is the only option where the manager can see the
     difference — and the only one that raises whether planner-authored reasoning reaches a human,
     which the codebase has repeatedly ruled against elsewhere.

**3. Whether the close is gated on the handover landing.** History deliberately did *not* gate it,
with a recorded reason (an incoherent row would loop, re-billing every tick). That reasoning was
written when a decline cost a model call; under the collapse the planner has already run
regardless, so the "re-composed every tick" cost no longer exists in the same form. The
freeze-never-cancel instruction for a `false` return (`compose.ts:82-84`) is a separate rule that
still stands.

**4. What the verb requires from the model.** `reason` is already read for every decision
(`planner.ts:970`) and flattened to 300 chars. Whether a decline additionally requires something
`leave` does not — a handoff note, an `agentContext` briefing, a minimum confidence — is open. Note
`escalate` today requires nothing beyond its status.

**5. Which statuses the verb is refused on.** The parallel rails refuse `send`/`hold` on non-pending
rows and `escalate` on non-asked rows, each with copy explaining the alternative
(`planner.ts:1034`, `:1042`). A decline on an already-asked row has no meaning — the question is
with the person — so the same shape of rail appears to apply, but nothing enforces it yet.

**6. Where a scenario lives.** `people-judgment` (8 scenarios, `plannerCorpus.ts:627`) is the
nearest family; its provenance note cites the same ruling that motivates decline — *"techs get
swapped silently — escalation is the CORRECT resolution there"*. But every case in it expects
`escalate`, which requires an **asked** row: `PJ-01` (`:629`) seeds `escalateAfter: '+4h'` and an
evidence line *"Dave covered the Holloway call, I was never on site."* A decline scenario is that
case's **pre-ask twin** — same judgment, row still `pending`. Whether it joins `people-judgment` or
forms a new family determines whether `FAMILY_COUNTS` changes.

## Open Questions

- **Does any current caller of `handToManager` pass `agentContext`?** `flagNudgeGap` accepts it,
  but `handToManager` (`compose.ts:87-97`) does not forward one — it builds its `flagNudge` call
  from `spec.handoff`'s plan only. Option 2(b) would need that parameter threaded through, which is
  a signature change to a function the delivery queue also calls.
- **What does the manager's item actually look like on the pilot today for an expired gap?** The
  copy is built from `stage0Suggestion(title, customer, endsAtLocal, ctx?.noNoteOrStatusChange)`;
  reading a real row would confirm how much a timeout item already communicates before any change.
- **Is `cancelled` reachable by any other path today?** If the historical decline was its only
  writer, every `cancelled` row on the pilot predates 2026-08-24 — worth confirming before reusing
  the value, since it would make the status effectively decline-only going forward.
- **Does the 18h expiry path move the row to a status at all**, or only flag the manager? The
  excerpt at `watchers.ts:877` shows the handoff; the status write was not read in full here.
- **Would a decline need to expand across an ask-group?** A pending row can carry `ask_group_id`
  once Phase 2 of the ask-shape work is live. The expiry path expands deliberately
  (`watchers.ts:848-876`); whether a per-row decline should is unexamined.
