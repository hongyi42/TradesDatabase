---
date: 2026-08-22
task: The planner writes the technician's question for gaps it decides to send; compose becomes the fallback
research: none — design verified directly against compose.ts and planner.ts
status: draft
---

## Overview

Stage 1 of collapsing the ladder's model calls (user, 2026-08-22). Compose is not the planner's
message writer — it fires on DETECTION, picking up every `pending` nudge that is not held
(`compose.ts:179-199`), and the planner's only lever over it is `not_before`. It shipped
2026-08-15 as the Stage-1 voice; the planner arrived 2026-08-19 and was inserted BESIDE that
pipeline as a brake, never above it. A separate model call whose only job is to write a sentence
the planner is already capable of writing is an artifact of that sequence, not a design.

This does not delete compose. The planner writes the question for gaps it decides to `send`;
compose uses that draft instead of calling the model, and still does everything else it does
today — the ask window, the code-owned frame, the attempt caps, the hand-to-manager paths. Gaps
the planner never touched compose exactly as now.

## Decisions

- **The draft rides on the DECISION, not the nudge row** — `nudge_decisions.question_draft`,
  mirroring `handoff_note`. Writing it to `nudges.question` would make the planner's own next tick
  render "the question asked: …" for a gap that has not been asked.
- **Compose keeps every guard.** The draft goes through the same `flatten(…, 500)`, the same
  empty check, and the same footer-impersonation check that a model-written question does. A
  planner-written question is not more trusted, only cheaper.
- **The planner writes the QUESTION, never the frame.** `assembleNudgeMessage` stays code-owned,
  exactly as it is for a compose-written question. This is not a new trust boundary.
- **Relative day words are ALLOWED in the draft, and here is why that is safe.** A draft can be up
  to ~35 minutes stale (planner every 30, compose every 5, delivery on the next box pull), so
  "yesterday" would be wrong if the firm-local day rolled over in between. It cannot: both the
  planner and compose gate on the 7am-7pm ask window, so no draft is ever written within seven
  hours of local midnight. **If the ask window is ever widened past ~23:25, this stops being true
  and the rail must forbid relative words.** Recorded here because the dependency is invisible
  from either file.
- **Same date rail as the handoff note** — the draft may use only the labels the gap supplied.
  Higher stakes than the manager note: this text reaches a person outside the office.
- **A refused draft costs the draft, not the send.** Compose falls back to its own model call, the
  way it does for any gap with no draft.

## Plain-language walkthrough

Today, deciding to ask and writing the ask are two model calls that never meet — compose cannot
tell a first ask from a third, or know the planner nearly closed the gap on a note that did not
quite answer. After this, when the planner decides to send, it writes the question in the same
breath, and compose spends nothing.

```
 today                                  after
 ─────                                  ─────
 planner  decide  ──► not_before        planner  decide + WRITE ──► question_draft
                          │                                              │
 compose  model call ──► question       compose  uses the draft (no model call)
             │                                   └─ no draft? model call, as now
        assembleNudgeMessage                 assembleNudgeMessage  ← unchanged
```

## Secrets & env preflight
- none.

## Phase 1: The planner drafts, compose spends nothing

### Changes required

**`supabase/migrations/20260822060000_nudge_decisions_question_draft.sql`** — **APPLIED to the pilot by the user 2026-08-22**, alongside `handoff_note`; both verified present and nullable:
```sql
alter table nudge_decisions add column if not exists question_draft text;
```

**`src/db/nudgeDecisions.ts`** — `questionDraft?: string | null`, mapped beside `handoffNote`.

**`src/teamLead/planner.ts`**
- Extract the temporal check out of `cleanHandoffNote` into a shared helper, and add
  `cleanQuestionDraft(raw, dateLabels)`: same date rail, 500-char cap, plus the
  footer-impersonation check compose already applies (`/note for the assistant/i`).
- `PlannerDecision.questionDraft`; populated on `send` only, dropped and logged via `noteDrops`
  when it fails a rail.
- Carry it into the recorded row.

**`src/teamLead/plannerPrompt.ts`** — `question` on the `send` branch of `SUBMIT_PLAN_TOOL`, plus
the writing rules: it is read by the TECHNICIAN in their own assistant's voice, one question, no
preamble, never mention the system or the note itself, same supplied-dates rule.

**`src/teamLead/compose.ts`**
- `listDecisions?` on `ComposeDeps`, defaulted — one batched read for the pending set.
- Before the model call: the newest APPLIED `send` decision's `question_draft`, if any. Use it and
  skip `run(...)`; otherwise call the model exactly as today.
- Count them separately in the summary (`draftedByPlanner`) — a silent substitution would make it
  impossible to tell whether the planner is actually writing anything.

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] a pending nudge WITH a planner draft is queued with that text and makes NO model call
- [ ] a pending nudge with NO draft calls the model exactly as today
- [ ] the draft goes through assembleNudgeMessage — the frame is present in what is queued
- [ ] a draft that fails the footer-impersonation check is refused at the planner, and compose
      falls back to its own call
- [ ] a draft using an unsupplied date is dropped at the planner; the `send` still applies
- [ ] only an APPLIED `send` draft is used — never a refused one, a shadow one, or a `hold`'s
- [ ] mutation: skip the flatten/footer guards on the draft path → their tests fail
- [ ] mutation: use the draft without checking `outcome === 'applied'` → its test fails

### Manual verification
- [ ] Read three planner-written questions and judge them on their own terms: accurate, and
      professional enough to go out in a technician's assistant's voice. NOT "indistinguishable
      from compose" — that was the wrong bar (user, 2026-08-22). Compose's output is not the
      standard; it is just the incumbent.
