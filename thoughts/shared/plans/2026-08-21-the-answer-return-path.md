---
date: 2026-08-21
task: Close the ladder's return path — hold every manager-facing template to "assert nothing you were not given", let field notes record in one call, and give an answer a provable link to the gap it answered
research: thoughts/shared/research/2026-08-21-the-answer-return-path.md
status: draft
---

## Overview

The system can ask a technician a question but cannot hear the answer. The planner infers "did they
answer" purely from rows appearing in the database, the sweep closes gaps on any job activity
whether or not it answered anything, and the manager gets a hardcoded sentence asserting two things
nobody checked.

This plan builds no new transport. The seat agent is **already** an authenticated caller into the
spine over MCP — what is missing is not a channel but a **token**. Phases 3-4 give an answer a
provable link to its gap; phases 1-2 fix the two defects observed live.

Group A feeds B and C: batching cannot tell a good batch from a bad one, and planner memory has
nothing to learn from, until an outcome can be attributed to a gap. Phase 3 produces that.

**Out of scope, deliberately:** the money-ledger blindness trio (`nudgeKinds.ts:52-58` — user
deferred, to be designed together); **transcript harvest — assigned to Group C** (user, 2026-08-21)
alongside planner memory, both being the continual-learning substrate, and the doctrine routes them
the same way: *harvest by reading transcripts, never by asking the agent to remember*
(`docs/engineering-memory.md:1101` — sessions compact past ~50k tokens while the on-disk transcript
stays verbatim); a new `AGENTS.md` duty block (D5 — blocked on whether `AGENTS.md` is truncated on
the `--deliver` path, a live check); the return-path eval (its own plan).

## Decisions

- **The link is a token the agent quotes, not a new channel** (user, D1+D2) — the box runner cannot
  see tool calls at all (the agent talks to the spine directly), and harvest is a new inbound
  *content* path needing a hard work-relevance gate before L1. The stamp needs no transport, no
  policy change and no migration.
- **The planner's reason reaches the manager** (user, D6) — carried by the sweep reading
  `nudge_decisions` at handoff, not a new column: `listDecisionsForNudges` already exists.
- **Field notes record one-shot; standing facts keep their confirm** (user, ratified 2026-08-21).
- **A mixed batch confirms as a whole** (user, ratified) — no code needed here: once phase 2 lands,
  note and money are both one-shot, so no mixed case remains in the nudge-answer path. The rule
  binds only when `record_standing_fact` is in the batch.
- **One rule governs every template on the manager path** (user, 2026-08-21, after a survey of all
  twelve fixed strings across the planner/seat-agent/human paths): *a template may render data it
  was given and may carry instructions, but must never assert a fact it did not receive as an
  argument.* It is checkable from a function signature — `handoff(n, mode, naiveLocal?)` takes a
  nudge and a clock, so every factual claim in its output was unbacked by construction. That is a
  signature bug, not a copy bug. Phase 1 applies the rule to all four offending templates (#4-#7),
  widened from the original two on user instruction.
- **A clause is argument-fed ONLY where a predicate genuinely backs it; otherwise it is deleted**
  (implementation call, from the review) — the first draft would have passed `hasActivitySince` in
  so the copy could check itself. Two problems. At the escalation push it is false by construction
  (`watchers.ts:553-557` resolves and `continue`s whenever `filled()` is truthy, and `filled` **is**
  `hasActivitySince`). And it is blind to `money_events` — the exact reason the 2026-08-20 specimen
  was false. So the flag that IS passed is named `noNoteOrStatusChange`, after the predicate rather
  than a conclusion, and it licenses one wording only. Claims it cannot back — anything about "the
  record" generally, anything about cost — are deleted. Backing those honestly needs the deferred
  money-ledger trio.
- **Phase 4 is ADDITIVE** — making the sweep close only on stamped answers would break every flow on
  day one, since no stamp exists until agents start passing one. Both paths close the gap and write
  different `resolution` text; that difference IS the corpus.
- **OPEN — the implementer must choose and record: what gives a one-shot note its idempotency
  stamp.** Today the commit path passes `externalId: 'note:<reviewItemId>'` (`server.ts:2320`),
  which drives `recordFieldNote`'s dedup and orphan-heal (`recordFieldNote.ts:125-177`). A one-shot
  call has no review item, so a retried tool call would write a **second permanent L1 row and a
  second visit** — undeletable. Options: (a) derive `externalId` from a content hash,
  `note:<sha256(tenantId|technicianRef|text)>:<yyyy-mm-dd>` — a same-day retry dedups, a genuinely
  repeated note on another day still records; (b) keep staging purely as an idempotency token, which
  defeats the phase. **Recommend (a)**; it must be settled before phase 2 is written, not during.

## Plain-language walkthrough

**Phase 1 — stop telling the manager things we haven't checked.** An escalation hands the manager a
fixed sentence claiming the technician "hasn't heard back" and that "nothing is on the job's record
yet". Neither is looked up; on 2026-08-20 both were false. We delete the claims rather than trying
to verify them, because verifying them needs the money ledger the ladder deliberately cannot see
yet. In their place the manager gets something we *do* know: the planner's own reason for
escalating, which today never leaves our logs.

**Phase 2 — one call, not two.** Recording a field note takes two tool calls: the first stages a
preview and writes nothing, the second commits. On 2026-08-19 a technician answered two questions in
one message; the money half committed instantly, the note half stopped at "shall I?", and the reply
opened with "Recorded!" — telling them they were done when they were not. Since a wrong note can be
retracted by its own author, the confirm buys ceremony rather than safety. Standing facts keep
theirs: those land in every future briefing.

**Phase 3 — give the answer a name tag.** The agent is told to record the answer but never told
*which question* it is answering, so nothing downstream can connect the two.

```
 today                                  after phase 3
 ─────                                  ─────────────
 nudge ──► "ask about this visit"       nudge ──► "ask ... answersGapId: <id>"
              │                                      │
        technician replies                    technician replies
              │                                      │
        record_field_note(text)            record_field_note(text, answersGapId)
              │                                      │
        raw_captures row                   raw_captures row
          job_id ✓                           job_id ✓
          which gap? UNKNOWN                  metadata.answersGapId ✓
```

**Phase 4 — let the sweep tell the difference.** Any activity on the job currently closes the gap: a
note about something else, a status change, a visit being logged. The planner's instructions say
that is *not* an answer, but the sweep runs six times more often and gets there first. This phase
teaches the sweep to recognise a stamped answer and record it differently. Both still close the gap
— nothing gets stricter yet — but we can then measure how often they disagree, which is what Groups
B and C need.

## Secrets & env preflight

- **Phase 1 / 2 / 3 / 4:** none. No new secrets.

Phases 2-4 need the local Supabase stack (`npm run seed:local`, already required). Live checks need
the `supabase-test` MCP (pilot read-back, already connected); phase 3's message check additionally
needs ssh to trades-box-1.

## Phase 1: The manager copy asserts nothing it wasn't given

### What this phase does
Applies one rule to every fixed string on the manager path: **a template may render data it was
given and may carry instructions, but must never assert a fact it did not receive as an argument.**
Four templates violate it today. Each factual clause either becomes argument-fed with wording that
exactly matches the predicate backing it, or is deleted. The planner's own reason replaces the
guesswork with something we actually know.

### Changes required

**`src/jobs/nudgeKinds.ts`**
- Add the context type. **The field name is the constraint — it names the predicate, not a
  conclusion**, so a future caller cannot use it to justify a wider claim:
  ```ts
  interface HandoffContext {
    plannerReason?: string | null;
    // TRUE only when the caller has just evaluated hasActivitySince and it was
    // false. Backs ONE clause with ONE wording: "no field note and no status
    // change". It does NOT back "nothing is on the record" (that predicate is
    // blind to money_events — the 2026-08-20 specimen) and it does NOT back any
    // claim about cost (see :314 — the cost `filled` ignores the ledger).
    noNoteOrStatusChange?: boolean;
  }
  ```
- Widen `handoff` (`:138-142`) to `handoff(n, mode, naiveLocal?, ctx?: HandoffContext)`. Optional for
  the same reason `naiveLocal` is: `compose.ts:98` has no sweep state — and that is exactly the call
  site that must stop asserting.
- **(#4) `stage0Suggestion` (`:151-159`)** — takes a 4th arg `noNoteOrStatusChange?: boolean`. Drop
  the general claim "nothing has been recorded about it yet"; keep only the specific one, and only
  when the flag is true: "no field note and no status change has been recorded for it". The general
  claim is the false one — it is a statement about the whole record made from a predicate that reads
  two tables.
- **(#5) `OVERDUE_VISIT_GAP_SPEC.handoff` escalated (`:258-262`)** — delete "and hasn't heard back"
  (no reply-side datum exists anywhere in the system) and "nothing is on the job's record yet"
  (replaced by the argument-fed clause above).
- **(#6) `JOB_COST_GAP_SPEC.handoff` (`:325`)** — its signature is `(n, mode)` only; widen it to the
  interface. Delete "and hasn't heard back" AND "the job's costs are still incomplete". The cost
  clause is **deleted, not made argument-fed**: `filled` (`:301`) tests `hasActivitySince`, and the
  comment at `:314` states the nudge path "deliberately still ignores the ledger", so nothing
  reaching this function can back a claim about cost.
- Append the reason when present, attributed and truncated to 200 chars:
  `` `\n\nThe assistant's note: "<reason>"` `` — attributed because it is model-authored text on a
  surface where every other word is code-owned. `flat()` is private to `planner.ts:220` and
  `flatten` is unexported in `composeCopy.ts`; add a local helper rather than exporting either.

**`src/jobs/watchers.ts`**
- Add `listDecisions?: typeof listDecisionsForNudges` to `WatcherDeps` (`:182-210`). **Required** —
  `watchers.test.ts:17` states every collaborator is injected; an un-injected read would make the
  existing escalation tests (`:656`, `:814`) hit the database.
- Before the escalation loop (`:654`), batch-read once for all escalating ids; `reasonFor(id)` = the
  newest row with `action === 'escalate' && outcome === 'applied'`, else null. One query, not N.
- `:656` — pass `{ plannerReason: reasonFor(x.n.id), noNoteOrStatusChange: true }`. The flag is
  honest here for both specs: escalation is only reached after `filled()` returned null, and both
  specs' `filled` is `hasActivitySince` (over different windows).
- `:605` (`'expired'`) — same flag, same justification; no `plannerReason` (nobody planned it).
- `:804` — `stage0Suggestion(title, customer, g.ends_at, true)`; the detector filtered on
  `!hasActivitySince` at `:444`.
- **(#7) `:888-891`** — delete "so the job's costs are incomplete". **Before wording the survivor,
  confirm what the cost candidate filter actually reads**: `jobsWithCostEvents` is built at `:506`
  and used only in `itemResolved`, so it is NOT obvious the detector consults the ledger. If it does
  not, the sentence may say only that the job has no recorded cost *note*, never that its costs are
  incomplete.

**`src/teamLead/compose.ts:98`** — unchanged, and that is the point: passing no `ctx` now means both
factual clauses are omitted. This path asserts nothing because it has checked nothing.

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] new test: escalated visit copy contains neither "hasn't heard back" nor "on the job's record"
- [ ] new test: escalated cost copy contains no claim about costs being incomplete
- [ ] new test: `stage0Suggestion` WITHOUT the flag omits the note/status clause entirely
- [ ] new test: `stage0Suggestion` WITH the flag says "no field note and no status change" and does
      NOT say "nothing has been recorded"
- [ ] new test: `handoff` called with no `ctx` (the `compose.ts:98` shape) emits no factual clause
      and still returns a valid plan
- [ ] new test: an `applied` escalate reason appears, attributed, truncated at 200
- [ ] new test: a `refused` or `shadow` decision's reason is NOT carried
- [ ] new test: reasons are read in ONE batched call for N escalations
- [ ] mutation: restore any deleted claim → its test fails

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP
- [ ] Read the stored `suggestion` on the two existing specimen items and confirm it is the OLD copy,
      so any new item is distinguishable from the pre-change corpus

### Manual verification
- [ ] Read one regenerated escalation and one regenerated expiry side by side and judge they read as
      a colleague's note, not a machine hedging

---
*Pause after this phase — Manual verification is non-empty.*

## Phase 2: Field notes record in one call

### What this phase does
Removes `record_field_note`'s staged confirm so a resolved-identity note commits on the first call.
`needs_identity` stays — that is a missing datum, not a confirmation.

### Changes required

**Settle the OPEN idempotency decision above before writing code.**

**`src/mcp/server.ts`**
- `:255-262` — rewrite the description: no longer two-step; the note is recorded on this call; a
  mistake is fixed with `retract_capture`.
- `:2128` (the `if (!confirmId)` branch) — on resolved identity, call `recordFieldNote` directly
  with the chosen `externalId` stamp and return the recorded result.
- Keep the `needs_identity` return (`:2179-2185`) and the whole `confirmId` branch (`:2291-2318`)
  intact — in-flight staged tokens must still confirm. **Note `needs_identity` still stages** (it
  needs `upsertOpenReviewItem` at `:2168` to mint a `confirmId`), so `pending_field_note` items do
  not stop entirely.
- `:556` — `record_standing_fact`'s description says "Unlike record_field_note … two-step"; correct
  it.
- **Staged-item cleanup gap:** `resolveOpenReviewItemFor(… 'superseded by a new note')` (`:2150`) is
  the ONLY sweep for open `pending_field_note` items, and the 15-min TTL is checked only inside the
  `confirmId` branch. Once most stages stop, a stranded item lingers in `list_pending_reviews`
  forever. Add a TTL-based resolve for stale `pending_field_note` items, or state explicitly why not.

**Existing tests this phase MUST rewrite** (they stage-then-confirm and will go red):
`src/mcp/server.test.ts:425` (both cases expect `needs_confirmation` from a resolvable
`confirmed.customerId`), `:458` (backdated `stagedAt`, asserts 0 captures), `:485` (crash-heal on
`external_id = 'note:<confirmId>'`), `:511` (resolve_review refuses a live staged token), `:1088`
(retraction fixture). The supersede / expiry / crash-heal coverage must be re-pointed at the paths
that still have those behaviours, not deleted.

**Box_Setup_Stuff sync** (standing rule — an agent-stack change updates these in the same commit):
- `Box_Setup_Stuff/bootstrap-box.sh` §0c permanent-record block (`:592-646`, ritual `:620-628`).
  **The block is guarded by a presence grep at `:589`, not the delete-then-append refresh idiom used
  at `:655-660` — so editing the text is a NO-OP on every already-wired seat.** Convert it to
  delete-then-append, or specify the per-seat fix. This is the documented template-drift trap.
- `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:24`, `:137-140`, `:164`
- `Box_Setup_Stuff/doorman-architecture-memory.md:314`
- `Box_Setup_Stuff/nemoclaw-inference-medic.sh:149` — embeds the tool's schema for its real-tool-call
  probe; a stale copy breaks the health probe
- `docs/nemoclaw-tech-agent.md`

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] new test: one call with resolvable identity writes the L1 capture and returns the recorded id
- [ ] new test: one call with ambiguous identity returns `needs_identity` and writes NOTHING
- [ ] new test: **a repeated identical call does not write a second capture or a second visit**
      (the idempotency decision, locked in)
- [ ] regression: an already-staged `pending_field_note` still commits via `confirmId`
- [ ] test: `record_standing_fact` still returns `needs_confirmation` on its first call
- [ ] `md5` of the §0c block in `bootstrap-box.sh` differs from the deployed copy, and the wire path
      actually replaces it (grep the guard, not just the text)
- [ ] mutation: make the one-shot path stage instead → test 1 fails

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP
- [ ] Compare `raw_captures` of channel `technician_note` against `review_items` of kind
      `pending_field_note` in the 24h after deploy. Expect captures to continue and *confirmation-
      driven* stages to fall — **not to zero**, because `needs_identity` still stages. Report both
      counts rather than asserting a direction

### Manual verification
- [ ] none

---

## Phase 3: The gap-id stamp

### What this phase does
Carries the nudge id to the seat agent in the agent-directed footer, accepts it back on
`record_field_note`, validates it, and stamps it into the capture's metadata.

### Changes required

**`src/teamLead/composeCopy.ts`**
- `assembleNudgeMessage` (`:130-146`) and `assembleCostNudgeMessage` (`:219-233`) take the nudge id
  and extend the closing sentence: `… passing answersGapId: <id>, so the office knows which question
  it answered.`
- The existing "never mention this note … or any internal detail" instruction (`:140-142`) already
  covers not showing the id to the technician — do not weaken it.
- **Callers are `src/jobs/nudgeKinds.ts:225` and `:365`** (inside `prepare`, where `n` is in scope).
  `src/teamLead/compose.ts:34` only RE-EXPORTS these. `src/teamLead/compose.test.ts:413` and `:433`
  call with two arguments — a required third parameter breaks typecheck, so either default it or fix
  both call sites.

**`src/db/nudges.ts`**
- **New accessor required** — there is no `(id, tenantId)` point-read today; `getQueuedNudgeForHost`
  (`:143`) is host-scoped and `status='queued'`. Add `getNudgeForTenant(id, tenantId)` and export it
  from `src/db/index.ts`.

**`src/mcp/server.ts`**
- `record_field_note` schema (`:264-277`): add `answersGapId: { type: 'string', … }`.
- Dispatch: validate as a uuid AND tenant-guard via the new accessor, exactly as the
  `confirmed.customerId` branch does at `:2119-2125`. An unknown or foreign id is **dropped with a
  console warning, never an error** — a mangled token must not cost the firm the note.
- Pass it as **`sourceMeta: { answersGapId }`** on the `recordFieldNote` call.

**`src/writePath/recordFieldNote.ts`** — **no change needed.** `metadata` is already
`buildCaptureMetadata(input.sourceMeta, input.occurredAt)` (`:148`); `sourceMeta` (`:51`) is the
existing convention for keyed metadata (`stagedConfirmId`, `occurredAt`). Writing `metadata:` directly
would clobber the `occurredAt` merge.

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] new test: a valid `answersGapId` lands in `raw_captures.metadata` **and `occurredAt` survives**
- [ ] new test: an id from ANOTHER tenant is dropped, the note still records, a warning logs
- [ ] new test: a non-uuid is dropped, the note still records
- [ ] new test: the composed message contains the nudge id (both message shapes)
- [ ] mutation: drop the tenant guard → the foreign-id test fails

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP; ssh trades-box-1
- [ ] After one real nudge delivers, read `nudges.question` from the pilot and confirm the id is in
      the body
- [ ] Check whether any `raw_captures.metadata` carries `answersGapId` within 24h. **Zero is a
      FINDING, not a pass** — it means the agent is not passing the token, which is exactly what the
      eval would measure

### Manual verification
- [ ] Read one delivered message as the technician sees it and confirm the id is NOT visible in what
      the agent forwards

---
*Pause after this phase — Manual verification is non-empty.*

## Phase 4: The sweep can tell an answer from activity

### What this phase does
Teaches the sweep to recognise a stamped answer as distinct from generic job activity. Both still
close the gap; they write different resolutions, which creates the corpus.

### Changes required

**`src/db/rawCaptures.ts`**
- New reader `listCapturesAnsweringNudges(tenantId, nudgeIds): Promise<Map<string, string>>`
  (nudge id → earliest `captured_at`). **Query on the metadata key directly** — PostgREST
  `.eq('metadata->>answersGapId', …)` batched via `.or(...)`. Do NOT filter in memory off
  `listJobStampedCaptureTimes`: it selects only `job_id, captured_at` (`:187`) and its own header
  (`:167-170`) records that a tech note often carries **no `job_id` stamp** — a note whose identity
  resolves to `createFrom` is invisible to a job-keyed read. If a job-keyed read is used anyway it
  must union `visits.source_capture_id` the way `listJobEvidenceSince` does. Page it — the silent
  1000-row cap applies.

**`src/jobs/nudgeKinds.ts`**
- `SweepFacts` (`:39`) gains `answeredGapAt: (nudgeId: string) => string | null`. Only one
  constructor exists (`watchers.ts:513`) and no test builds one, so nothing else breaks.
- `OVERDUE_VISIT_GAP_SPEC.filled` (`:181-189`) and the cost twin (`:301`): check
  `f.answeredGapAt(n.id)` FIRST, returning `'the technician answered this question'`; fall through to
  today's `hasActivitySince` branch (`'a field report arrived — the gap filled itself'`) otherwise.
  Those two strings are the corpus labels.

**`src/jobs/watchers.ts`**
- Add `listAnsweringCaptures?` to `WatcherDeps` (same injection requirement as phase 1) and build
  `answeredGapAt` into `facts` (`:513-519`) from the batched pre-fetch.

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] new test: a stamped capture closes the gap with the ANSWERED resolution
- [ ] new test: an unstamped capture on the same job still closes with today's resolution (proves
      the change is additive)
- [ ] new test: a capture stamped with a DIFFERENT gap's id does not produce the answered resolution
- [ ] new test: a stamped capture with **no `job_id`** is still found (the case the job-keyed read
      would miss)
- [ ] mutation: make `answeredGapAt` always return null → test 1 fails

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP
- [ ] After 48h, group `nudges` by `resolution` and report the split between the two strings. This is
      the deliverable that unblocks Groups B and C — report the numbers, and if the answered count is
      zero, say so plainly rather than reporting the phase as working
