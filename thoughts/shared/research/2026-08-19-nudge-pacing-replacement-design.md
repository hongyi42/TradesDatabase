---
date: 2026-08-19
topic: "Replacing the per-person nudge cap — design constraints derived against the shipped Stage-1 code"
status: design notes, nothing built
supersedes: nothing
related:
  - thoughts/shared/plans/2026-08-15-feature-B-intelligent-spine-stage1-voice.md (Stage 1, closed)
  - docs/engineering-memory.md (nudge pacing entry)
---

# Replacing the nudge cap — what the shipped code forces

The user removed the 2-asks/person/24h cap on 2026-08-18 and ratified a three-part replacement:
**earn the ask**, **urgency sets latency (not permission)**, **batch the unimportant**. Nothing is
built. These notes are the constraints that fall out of the code as it actually stands, derived
while proving Stage 1 live. They exist so the replacement is designed against reality rather than
against the plan's description of it.

## 1. ask / derive / attempt is a SWITCH, not a pipeline

The class is declared per gap kind at design time — whether an answer exists in the database is a
property of the *question*, not of the moment. Nothing walks all three stages.

```
detector fires
   ├─ ask      → compose the question                        0 extra cost
   ├─ derive   → run the SQL predicate
   │               ├─ resolves → close silently, NO ask ever
   │               └─ no       → compose the question
   └─ attempt  → bounded model attempt
                   ├─ confident → compose a CONFIRMATION  ("$40 for the pump, right?")
                   └─ no        → compose the open question
```

**`derive` can REMOVE an ask. `attempt` almost never does — it RESHAPES one.** A confident attempt
turns an open question into a yes/no, which is far easier to answer but still costs a contact. So
never justify `attempt` on the grounds that it avoids asking. Cost ordering is awkward and worth
being deliberate about: `derive` (~0) < `ask` (one compose) < `attempt` (compose **plus** the
attempt, and it still asks).

Chaining (`derive` → `attempt` → `ask`) is possible but should be rare and explicit. Blanket
derive-first is already rejected: it burns tokens on gaps nothing can derive.

## 2. Urgency must NOT be a model call

Scoring urgency per gap with a model contradicts the deterministic-detection doctrine the watcher
rests on, and costs tokens on every gap. Instead: **each detector declares a base tier;
deterministic SQL facts modulate it per instance.** Three signals, all SQL-answerable:

- **Decay** — does the answer degrade with time? Visit recall decays in hours; a receipt amount
  does not decay at all. Property of the DETECTOR.
- **Blocking** — is something downstream waiting (an invoice that cannot go out, a quote a
  customer expects)? Per instance.
- **Window closing** — a promise date, a warranty, month-end books. Per instance.

Tiers: **interrupt** (ask now, alone, never waits to fill a batch) / **timely** (ask today, may
lead a batch) / **routine** (batch; flush on size ~3, an age deadline, or piggyback).

**Piggyback is the best case and worth building for**: an interrupt already going out can carry
routine items with it ("while I have you"). Urgency then genuinely sets latency and never
permission — nothing is dropped, and the important item is never delayed to fill a batch.

## 3. Batching needs a CARRIER, and each rider needs its own asked_at

Today compose is strictly one nudge → one question → one delivery
(`src/teamLead/compose.ts`, `for (const n of pending)`), and the box pulls each queued row and
delivers it as its own agent turn. Batching therefore needs a **carrier pattern**: one nudge holds
the combined text, riders are marked so they do not deliver separately.

The easy thing to get wrong: **each rider needs its own `asked_at` stamped when the carrier
lands**, or their 48h escalation clocks never start. And the orphan doctrine must extend to the
group — a carrier that fails delivery must hand EVERY rider to the manager, not just itself.

What already works and needs no change: nudges are per-subject and each closes on its own
activity check, so asking three things and getting one answer resolves correctly with no schema
change. A partial answer records one note; the other two stay open and escalate on their own
clocks. That is acceptable behaviour to design around, not a bug to prevent.

## 4. The planner is a LAYER, not a fatter prompt

The compose prompt is kind-scoped by construction ("this prompt knows how to ask about ONE gap")
and is deliberately thin — 462 input / 66 output tokens measured live, `reasoningEffort: 'none'`,
no tools. That thinness is load-bearing: at ~$0.0014 per compose the no-cap ruling is affordable;
a context-rich team lead would reintroduce the deleted bottleneck as a budget line.

So cross-gap decisions (rank, group, time) belong in a **deterministic planner between the watcher
and compose** — SQL plus design-time tiers, no model call — which hands compose one gap or three.
Compose stays exactly as thin as it is.

Corollary from measured cost: **batching is primarily a COST optimisation.** Three questions in
one message still cost 3 composes (~$0.004) but collapse three agent delivery turns into one, and
the delivery turns are where 95%+ of the money is (fleet turns run ~35k input tokens). Being
collegial and being cheap point the same way here.

## 5. Removing the cap also removes a runaway brake

The per-person counter was incidentally capping a *misfiring detector*. The user accepted that
this backstop must move per-detector. Today the exposure is low — ONE well-tested detector, plus
`uq_nudges_subject_ever` (once per subject forever), so the blast radius is bounded by the number
of real overdue visits. **That margin comes from having exactly one detector, not from the
design.** When detector #2 lands, a per-detector brake must land with it. The per-tenant per-tick
surge brake (`MAX_NEW_ITEMS_PER_TENANT_TICK = 5`) stays either way.

## 6. Why removing the cap changes almost nothing today

One detector, once-ever-per-subject dedup, ~1 gap/day for the pilot's only nudgeable seat. The cap
essentially never binds. Frequency will come from MORE DETECTORS, not from deleting the counter —
so the replacement design is best exercised against a real second gap kind (cost-chasing is the
natural candidate and is squarely `ask` class, needing no derivation machinery at all) rather than
designed in the abstract.
