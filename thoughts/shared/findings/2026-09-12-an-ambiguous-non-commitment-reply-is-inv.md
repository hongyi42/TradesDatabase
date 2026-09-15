---
date: 2026-09-12
task: an ambiguous non-commitment reply is invisible to the gap-closing evidence reader, so a scheduling gap can stay open with nobody asked
status: complete
origin: 20260911-a-new-promise-to-a-known-customer-is-fil
files: src/db/rawCaptures.ts, src/writePath/recordFieldNote.ts
supersedes: nothing
---

## Files

- src/db/rawCaptures.ts
- src/writePath/recordFieldNote.ts

## Notes

Found by /code-review high on the door-stops-guessing branch, 2026-09-12. Sharpens a trade the user
accepted, rather than contradicting it.

Accepted at plan time: "ambiguous non-commitment mail is reachable from the customer but not from a
job." What the review adds is the consequence: `listJobEvidenceSince` (src/db/rawCaptures.ts:357)
reads `raw_captures.job_id`, `visit_notes` and `job_captures` — NOT `customer_captures` — and the
ambiguity branch raises no observation unless `visitCommitted === true`.

So: a customer with a boiler job and a tap job replies by email with no thread id (matched on
sender address) saying "Friday works for us". Before, it landed on the newest open job and the
planner could read it and close the scheduling gap. Now it is invisible to every evidence reader
AND to the planner, so the gap stays open indefinitely and nobody is asked — the customer answered
and the record behaves as though they never did.

Note what CANNOT fix it: adding customer_captures to listJobEvidenceSince. That reader answers
"what evidence is on THIS job", and a customer-level capture is deliberately not evidence about any
particular job. Treating it as evidence for all of that customer's gaps is the guessing Phase 2
removed, wearing a different hat.

The chooser (2026-09-11-the-model-names-the-job) closes most of this by naming the job, which makes
it ordinary job evidence again. What remains is the chooser's "none of these" answer. Worth
deciding whether an ambiguous capture that READS LIKE AN ANSWER to an open question deserves its
own report — which is the same shape as
[20260912-an-l2-status-flip-reports-to-the-planner]: one general touch-report rather than a
per-case ask.

## Decisions

OPERATOR, 2026-09-14 (board triage, plan 2026-09-14-the-task-board-is-the-operators Phase 3):
FOLD INTO THE FLIP REPORT. The case left after the chooser lands (a customer-level capture that
READS LIKE AN ANSWER to an open question, where the extractor answered "none of these" or showed no
list) becomes a case the general touch-report task
[20260912-an-l2-status-flip-reports-to-the-planner] must decide in its research pass. Recorded in
that task's Decisions. REJECTED: a one-off observation kind in the chooser plan (the bespoke per-case
ask the 2026-09-12 doctrine avoids); accepting the gap; keeping it as its own item.
Still binding on whoever builds it: customer_captures must NOT be added to `listJobEvidenceSince` —
a customer-level capture is deliberately not evidence about any one job.
