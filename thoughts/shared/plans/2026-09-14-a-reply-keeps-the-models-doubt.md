---
date: 2026-09-14
task: A reply on a thread whose job a model picked inherits that doubt — it cannot flip status or silence a promise the pick itself could not
research: thoughts/shared/research/2026-09-11-re-inventing-the-write-path-door.md
status: draft
supersedes: nothing
---

## Overview

**Lands with** `thoughts/shared/plans/2026-09-11-the-model-names-the-job.md`, and needs its
`link_basis` migration. Split out of it on 2026-09-14 to keep both under the plan limit; this was its
Phase 4.

That plan lets the extractor pick a job and forbids the pick from flipping status or silencing a
promise. Both rules hold for the message the model read — and fail on the next one.
`findCustomersByThread` (`src/db/rawCaptures.ts:737`) decides a thread's job from the links and stamps
earlier messages left, and `withThreadJob` (`src/writePath/identityMatch.ts:137-153`) hands it back as
`match.jobId`. So the customer's reply to a model-picked message arrives "thread-named": no candidates,
no `jobFromModel`. It can flip the job, its promise is silenced by `!visit`, and its link reads as
grounded. Replying to the firm's own mail is the common next message.

## Decisions

- **OPEN — what a reply inherits** (recommended (A); the user has not yet chosen). (A) CARRY THE
  DOUBT: same job, inherits the model basis, records `basis='inherited'`. (B) DISTRUST: the thread
  lookup ignores basis-bearing links and the reply is re-picked by the extractor. (A) keeps a
  conversation on one job; (B) is less code, but a model may answer differently the second time and
  split one conversation across two jobs. This plan builds (A); (B) replaces the Phase 1 rule with
  "skip basis-bearing links in arms (b) and (c)".
- **An email the ASSISTANT sent is not evidence** (review fix, 2026-09-14). `send_email` stamps
  `raw_captures.job_id` from an id the agent typed (`src/mcp/tools/comms.ts:335-365`, moved there by #239), checked only
  against the recipient's customer — and after the model plan, the id the agent reads is the model's
  pick. Treating that stamp as grounding launders the pick through the firm's own reply: message 1 is
  model-picked, the assistant replies naming that job, the customer's reply arrives grounded and can
  flip and silence. The assistant's send also leaves no `inherited` link, because the door never runs
  it (`isAgentWrittenCapture`, `src/db/rawCaptures.ts:58` — `sentVia` / `toolSlug`).
- **The grounding rule, therefore.** A thread's job is `'model'` when at least one `model` or
  `inherited` link reaches it AND no independent evidence does. Independent evidence is: a link with a
  null basis; a stamp (arm a) on a capture that `isAgentWrittenCapture` rejects; or an L2 row created
  from a thread capture (arm d, `jobs.source_capture_id`). An agent-written stamp is ignored either
  way — it neither grounds a pick nor creates doubt on its own.
- **New `ThreadIdentity` fields are OPTIONAL, present only when the basis is `'model'`** — the way
  `withThreadJob` spreads `jobId` (`identityMatch.ts:152`). `src/mcp/server.test.ts:2835` asserts
  `toContainEqual({ customerId, jobId })`, which ignores `undefined` keys but fails on `null` ones.
- **Traceable, not nested.** `jobBasisCaptureId` / `jobBasisReason` come from the EARLIEST model link
  by `captured_at`; an inherited reason copies the ORIGINAL — `inherited from capture <id>: <reason>` —
  so message 3 does not read `inherited from … inherited from …`.
- **The caps are unchanged.** Same rows, same `.limit(THREAD_ROW_CAP + 1)`. The refuse-when-full rule
  is what makes "every link reaching it" computable; a refused thread returns `[]`, and the message
  simply becomes a candidates case.

## Plain-language walkthrough

When the model picks the kitchen-tap job for the firm's email and the customer replies on that thread,
the reply is filed on the same job — but it carries the same "a model chose this" marker, so it cannot
move the job's status or be silenced where the first message could not. The doubt only lifts when
something that is not a model's guess — a person confirming, or a thread link made without one — points
at the same job. An email the assistant itself sent does not count: the job it named was copied from
the record, which is where the model's pick lives.

```
  msg 1  firm:     "we'll come about the tap"   → model picks tap   → link basis=model
  msg 2  assistant replies naming the tap job   → stamp, agent-written → IGNORED
  msg 3  customer: "can you do Thursday?"       → thread → tap job, doubt carried
                                                  → no flip, asks, link basis=inherited
```

## Secrets & env preflight

- **Phase 1:** none — deterministic.

---

## Phase 1: The thread lookup reports how its job was chosen

### What this phase does
Makes `findCustomersByThread` know, per job, whether only a model's pick reaches it, and has the door
treat such a reply exactly as the model plan treats the pick.

### Changes required

**`src/db/rawCaptures.ts:703`** — `ThreadIdentity` gains optional `jobBasis?: 'model'`,
`jobBasisReason?: string`, `jobBasisCaptureId?: string`.

**`src/db/rawCaptures.ts:737`** — restructure: the single `jobIds` set (`:774`) becomes a map from job
id to `{ grounded: boolean; modelLinks: { captureId; reason; capturedAt }[] }`.
- arm (a) `:776` also selects `metadata`; a stamp grounds only when `!isAgentWrittenCapture(metadata)`.
- arms (b) `:787` and (c) `:801` also select `capture_id, basis, basis_reason` — on (c) from
  `visit_notes` itself, not the `visits!inner` embed; a null basis grounds, a non-null one is recorded.
- arm (d) `:819` grounds.
- The final loop (`:870-886`) and dedupe (`:889-894`) read the map; a job gets the optional fields only
  when it is not grounded and has a model link, taken from the earliest by `captured_at` (select it).

**`src/writePath/identityMatch.ts:137-153`** — `withThreadJob` copies the adopted job's optional basis
fields into `MatchResult`, only when present.

**`src/writePath/recordFieldNote.ts`** — `match.jobBasis === 'model'` sets `jobFromModel` exactly as the
model plan does; that capture's link writes `basis: 'inherited'` and the copied original reason.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass; `server.test.ts:2835` unchanged and green
- [ ] msg 1 model-picks the tap job (trip attached); msg 2 on the thread with `statusSignal: 'completed'`
      and `visitCommitted: true` → not flipped, asked, `basis='inherited'` naming msg 1
- [ ] msg 3 inherits again, reason copied from msg 1, not nested
- [ ] **the laundering case:** msg 1 model-picked; an agent-written capture on the thread stamped with
      that job; the customer's reply → still inherits the doubt
- [ ] a null-basis link, a non-agent stamp, or an arm-(d) row on the same job → grounded, and the reply
      behaves as thread-named does today
- [ ] a thread over `THREAD_ROW_CAP` still refuses (returns `[]`)

### Live verification (agent-executable)
- [ ] none — deterministic, covered above

### Manual verification
- [ ] none

---
*Automated checks suffice; continue.*
