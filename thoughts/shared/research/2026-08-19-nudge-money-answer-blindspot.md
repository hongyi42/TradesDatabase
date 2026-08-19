---
date: 2026-08-19
topic: "DEFECT — an answer recorded as MONEY does not close a nudge, and the field report is lost"
status: live specimen open on the pilot; not fixed
severity: "will produce a FALSE manager item ~2026-08-21 19:05Z unless acted on"
related:
  - src/jobs/watchers.ts (hasActivitySince / latestByJob)
  - src/jobs/nudgeKinds.ts (both specs' `filled`)
  - thoughts/shared/research/2026-08-19-nudge-pacing-replacement-design.md
---

# An answer recorded as money leaves the nudge open — and drops the field report

Found live on the pilot 2026-08-19 while confirming the Stage-1 tone fix. Not engineered; this is
an ordinary answer to an ordinary question. **The specimen is still open — do not clean it up
before deciding what to do**, it is the only unmanufactured instance we have.

## What happened, verbatim

Nudge `10d68c23-df2c-4547-ad53-121d445e3546` (kind `overdue_visit_gap`) asked at 19:05:44Z about
assignment `976ca8d8-…` / job `eea05151-77af-4a23-bc27-e47031406f33` — Tankless descaling,
Marisol Duarte. The operator (manager-sam) replied:

> "The visit went well. The customer paid 500 on the spot."

Two facts in one sentence. The agent recorded **only the second**:

```
money_events on the job : 1   payment_received, 50000c, actor manager-sam,
                              detail.note "Paid on the spot at the tankless descaling visit",
                              source_capture_id: NULL
raw_captures            : 0   ← "the visit went well" exists NOWHERE
visits                  : 0
nudge                   : still `asked`
```

The agent then offered the note as an afterthought — *"If you'd like, I can also record a field
note… Just say the word."* — and stopped.

## Three consequences, in order of how much they matter

1. **A false statement about a person is queued.** `hasActivitySince` counts captures and visits
   only, so the nudge does not close. At `asked_at + 48h` (~2026-08-21 19:05Z) it escalates with:
   *"Sam Rivera's assistant asked about the 'Tankless descaling' visit … and hasn't heard back —
   nothing is on the job's record yet."* Both halves are false: they answered in minutes, and
   something IS on the record.
2. **The field report is lost.** "The visit went well" was never written anywhere. The job's
   record is emptier after the exchange than the exchange implies.
3. **The money event cites no evidence.** `source_capture_id` is NULL — the amount was written
   from a chat message that never became L1. Worth checking against the money-ledger evidence
   contract; recording an amount with no citable source may be intended for manager-tier chat, or
   may be a second gap. **Confirm before treating it as a bug.**

## Why it happens — two INDEPENDENT causes

Fix either and the false escalation stops; fix both and the design is actually right.

**A. Spine-side (the load-bearing one).** `latestByJob` in `src/jobs/watchers.ts` is built from
`listCaptureTimes` + `listVisitTimes`. Nothing else counts as activity. Both kind specs'
`filled()` predicates route through the same `hasActivitySince`, so **neither `overdue_visit_gap`
nor `job_cost_gap` can see a money event.** The money ledger (PR #146) landed after the watcher
was written and nobody widened the closure check.

Note the neighbouring blind spot already fixed in this file — job-scoped gaps were silently
excluded from the `jobIds` fetch, so the cost kind's `filled` could never see its own answer. This
is the same class of bug one layer up: the closure check enumerates TABLES rather than asking
"did anything land on this job?"

**B. Agent-side.** The footer instructs the agent to save the answer with `record_field_note`
"even 'nothing to report'". It didn't — it found a richer tool for the more actionable fact and
treated "went well" as pleasantry. Prompt-level instruction, no mechanism.

## Blast radius — smaller than it looks, but it is exactly the pilot

`record_money_event` is **manager-only**. `nudgeKinds.ts` already banks on this: *"the
technician's agent cannot write money … so the amount lands as PROSE on the job and a manager must
record it."* For a real technician, a payment mentioned in an answer becomes a field note, which
DOES fill the gap. So this path needs a **manager-tier answerer** — which is precisely the
pilot's only nudgeable seat today, and managers are a permanent user class, not a test artifact.

The trigger is also not rare. Answering "how did it go?" with a payment detail is how trades
operators talk, and the cost detector actively trains them to mention money.

## Suggested direction (not a decision)

**Recommended: widen the activity source.** Add money events to `latestByJob` so closure asks
"did anything land on this job since the bound?" rather than naming tables. That is mechanism, not
instruction, and it fixes both kinds at once. Consider making the accumulator's inputs a list the
kind registry can extend, so the next write surface does not repeat this.

**Also worth doing: make the footer insist.** The field note should be recorded regardless of what
else the answer contains — the money tool is *additional*, never a substitute. Cheap, but
prompt-level, so it cannot be the only fix.

**Do NOT** close the nudge on "the agent replied" — closure by evidence-in-the-record is
deliberate and correct (it lets an answer arrive in any session, days later, through any agent).
The bug is that the record is bigger than the check knows.

## Open question for the user

Should a money event alone count as "the visit gap is filled"? A payment proves contact happened
but says nothing about how the work went. Arguably it should close the nudge (the person
answered) but should NOT count as the field report the job's record still lacks. That distinction
may want two different predicates, and it is a product call, not an engineering one.
