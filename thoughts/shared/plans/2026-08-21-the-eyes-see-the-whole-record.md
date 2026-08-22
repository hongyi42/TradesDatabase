---
date: 2026-08-21
task: Let the planner see money and give it a way to postpone an escalation — the first of three plans splitting Group A, in dependency order
research: thoughts/shared/research/2026-08-21-money-trio-reverify.md
status: complete
---

## Overview

Plan ① of three (see `memory: ladder-build-schedule`). The ladder's closure check reads exactly two
tables, so an answer given as money is invisible to it — the 2026-08-19 Tankless specimen answered
a question in under an hour and escalated two days later telling a manager nobody had replied.

Three of the six money-touching components turned out to be money-aware already (the cost detector,
the item sweep, the planner's cost-gap `recordFilled`). What is left is narrower than the original
"money trio" framing: **the planner cannot see money on a visit gap, and it has no way to postpone
a deadline even when it can see something.**

This plan does NOT widen the sweep's `filled` predicate. That would make the sweep — which runs 12x
more often, at an earlier lifecycle step — the judge of a genuinely ambiguous question, and would
shrink the planner's already-narrow reachable `close` further. Money is instead made visible and
citable to the planner, which is the organ the architecture assigns judgment to.

**Out of scope:** the manager copy and the resolution strings (plan ②); the gap-id stamp (plan ③);
`hasActivitySince` itself, which is deliberately untouched — see Decisions.

## Decisions

- **The planner judges, not the sweep** (user, research D1 Option B) — the repo's split is that
  facts live in code and the planner adjudicates (`plannerPrompt.ts:11`). *"Did money land on this
  job"* is a fact; *"does a payment answer 'how did the visit go'"* is a judgment. `filled` stays
  narrow; the planner's gap view widens, the way `recordFilled` (`planner.ts:292-296`) already does
  for cost gaps. Money is also the one evidence class the sweep cannot pre-empt — because it cannot
  see it — so this is where the planner's `close` is genuinely reachable.
- **One broad reader, all money kinds** (user, research D2 Option A) — per-kind scoping in the
  registry would be code doing the model's job again. If the planner can judge that a payment
  answers a visit question, it can judge that a payment does not answer a cost question.
- **`hasActivitySince` and detection are untouched** (follows from D1) — because `filled` does not
  change, the predicate shared with the visit detector (`watchers.ts:444`) does not change either.
  Research D4 dissolves. No gap that opens today stops opening.
- **Money is a code-computed RECORD FACT, not "evidence"** (implementation call, reversed after
  review) — the first draft put rendered money lines into `view.evidenceText` so `basis: 'evidence'`
  could quote them. That is wrong on this plan's own terms. `evidence` means *"somebody answered and
  `citation` quotes THEIR words"* (`planner.ts:56-57`), and `applyDecision` writes
  `answered — "<citation>"` (`:628`). A money line is CODE's words, so a money-close would have
  written a durable audit line asserting a person replied when nobody did — the exact
  false-assertion class plan ② exists to remove.
  Instead the view gains `moneyOnRecord: string | null`, a stated FACT, and `basis: 'record'` is
  authorised by `recordFilled ?? moneyOnRecord` with the resolution
  `closed on the record — <fact>`. This still satisfies D1: code states a fact, the MODEL decides
  whether that fact answers the question — structurally identical to how cost gaps already work
  (`:292-296`). It also needs no new enum value, so no migration: `nudge_decisions.basis` is
  `check (basis in ('evidence','record'))`.
  Consequence: `evidenceText` keeps meaning "capture text" and is untouched.
- **The bound is `created_at`, not `occurred_at`** (implementation call) — a payment that HAPPENED
  before the ask but was RECORDED after it is still the person answering. `occurred_at` is
  manager-stated (`money_events.sql:38`); `created_at` is when it landed (`:46`).
- **`extend` ceiling: `asked_at + 48h`** (user) — the model may re-derive the old default case by
  case but never exceed it. 48h was the shipped behaviour for months before it was halved to 24h on
  2026-08-20. Bounds TOTAL postponement regardless of how many times it extends, which a per-extend
  cap would not.
- **`extend` requires a MIGRATION and it lands first** (implementation call) —
  `nudge_decisions.action` is `check (action in ('send','hold','close','escalate'))`
  (`20260820120000_nudge_decisions.sql:37`). `recordNudgeDecisions` has no partial insert, so a
  single un-migrated `extend` would reject **up to 500 decisions** in one statement. Same failure
  shape as the `safeJobId` guard added in PR #160, one layer down.
- **Money-event provenance is in scope** (user, research D5) — `money_events` is the only
  L2-adjacent surface recording none. Additive and optional: if no caller passes it, nothing changes.

## Plain-language walkthrough

**Phase 1 — the planner can see money.** Today the planner is shown any notes that landed on a job
since it asked its question. It is not shown money. So when a technician answers "the visit went
well, they paid 500 on the spot" and the agent records only the payment, the planner sees an empty
job and concludes nobody replied. This phase adds money to what the planner is shown, and makes it
quotable so the planner can actually close a gap on it rather than just look at it.

```
 the planner's view of a gap
 ───────────────────────────
 today                              after phase 1
   evidence since the ask:            evidence since the ask:
     NOTHING has landed                 NOTHING has landed
                                      money on this job since the ask:
                                        [1] payment_received $500.00 on 2026-08-19
   → looks unanswered                 → the planner decides whether that answers
```

Note what this does *not* do: the sweep still closes gaps on notes and visits only. We are not
telling the machinery that money means "answered" — we are telling the planner money exists and
letting it judge. That distinction is the whole design.

**Phase 2 — the planner can say "not yet".** An escalation fires on a flat 24-hour clock enforced
by a sweep that runs 288 times a day. The planner is awake at most 24 times a day, and for a gap
that has already gone out its entire vocabulary is *close it*, *escalate it now*, or *leave it
alone* — and leaving it alone does not stop the clock. Its own instructions currently tell it
otherwise. This phase adds an `extend` verb, capped at 48 hours from when the question was asked,
so a planner that sees a reason to wait can act on it instead of forfeiting its turn.

**Phase 3 — an amount can point at what it came from.** Every other record in the system says where
it came from: a visit, a customer, a job, a standing fact all carry the id of the message that
produced them. A money row does not — the column exists and nothing has ever filled it. So a $500
payment cannot be traced back to the sentence that reported it. This phase lets the tool accept
that link.

## Secrets & env preflight

- **Phase 1 / 2 / 3:** none. No new secrets.

All phases need the local Supabase stack (`npm run seed:local`, already required). Phase 2's
migration must reach the pilot via `mcp__supabase-test__apply_migration` — **user authorisation
required before applying**, per the standing rule that the hosted "test" project is the pilot's live
database. Live checks need the `supabase-test` MCP (already connected).

## Phase 1: The planner can see money

### What this phase does
Adds a batched, negation-folded reader for money that landed on a job since a bound, threads it into
the planner's gap view as a stated fact, and lets the model close on it under the existing
`record` basis.

### Changes required

**`src/db/moneyEvents.ts`**
- New export:
  ```ts
  export async function listLiveMoneyEventsForJobsSince(
    tenantId: string, jobIds: string[], sinceIso: string,
  ): Promise<MoneyEvent[]>
  ```
- Chunk `jobIds` by 500, page by 1000 — the shape of `listJobIdsWithCostEvents` (`:234-260`).
  **`listMoneyEventsForJobs` (`:203-216`) is NOT the model to copy: it has no paging loop and is
  exposed to PostgREST's silent 1000-row cap.**
- Filter `.gt('created_at', sinceIso)`. Not `occurred_at`: that is caller-supplied
  (`server.ts` passes it through) while `created_at` is never set by `appendMoneyEvent`'s insert
  (`:154-170`), so only `created_at` is unspoofable and only it means "landed since we asked".
- **Fold negations in a second pass** as `listJobIdsWithCostEvents` does (`:265-288`): query
  `corrects_event_id in (ids)` for `NEGATING_KINDS` **with NO time filter** — a row cancelling an
  in-window event may itself fall outside the window.
- **Also drop the negating rows themselves** from the result. `summarizeMoney` (`:339-341`) excludes
  `invoice_voided`/`correction` from `live`, and `:51-54` requires ONE definition of "still live";
  without this a cancellation renders as fresh money. `payment_refunded` is deliberately NOT a
  negation (it folds by subtraction), so a refunded payment still renders — say so in the comment.
- `src/db/index.ts:21` already does `export * from './moneyEvents.js'` — no export edit needed.

**`src/teamLead/planner.ts`**
- `PlannerDeps` gains `listMoneySince?: typeof listLiveMoneyEventsForJobsSince`.
- `GapView` (`:226-237`) gains `moneyOnRecord: string | null`.
- `buildGapView` (`:271-277`) gains a `money: MoneyEvent[]` parameter, filtered to this gap's job
  and `Date.parse(created_at) > askedAtMs` — the same bound and the same no-`asked_at`-means-none
  rule the capture path uses (`:279-285`).
- Render money in its OWN block, **after** the evidence loop and **never into `evidenceText`**
  (the loop at `:339-344` indexes `evidenceText[i]` by `relevant`'s index; appending money there
  mis-labels every capture line):
  ```
  money on this job since the question went out:
    [1] payment_received $500.00, recorded 2026-08-19
  ```
  Render the SAME column the filter used (`created_at`) — `get_job` renders `occurred_at`
  (`server.ts:2445`), and mixing them prints "since the ask … on <date before the ask>". Amounts are
  cents → dollars, **never summed and never signed**: direction comes from `kind`
  (`moneyEvents.ts:36-37`). An amountless kind renders without a figure.
- `moneyOnRecord` is the code-computed fact, non-null when any money is in window, e.g.
  `` `a payment of $500.00 was recorded against this job on 2026-08-19, after the question went out` ``.
  For a `job_cost_gap`, `recordFilled` still wins.
- **Fix two rendering bugs this exposes** (`:326-337`): the "NOTHING has landed on this job" line
  must say *notes* specifically, or it contradicts the money block directly beneath it; and the
  `sharesJob` shared-evidence warning currently lives inside the `relevant.length > 0` branch, so
  two gaps on one job with money but no notes would see identical money lines with no warning.
- `validateDecisions` `basis: 'record'` (`:500-513`): authorise on `recordFilled ?? moneyOnRecord`
  and cite whichever is non-null. Refusal message unchanged in spirit.
- `runPlanner` (`:634`): one batched read per tenant per tick beside the existing
  `jobsWithCostEvents` fetch (`:720`), bounded by the EARLIEST `asked_at` among this tick's gaps;
  per-gap filtering happens in `buildGapView`.
- **`src/teamLead/planner.test.ts:99-113` — `baseDeps()` MUST stub `listMoneySince`.** Without it a
  `?? listLiveMoneyEventsForJobsSince` default sends ~40 shadow tests at the real database with
  `tenantId 't1'` and non-uuid job ids; they fail as `tenantErrors: 1` rather than loudly. This
  phase leaves `npm test` red without it.

**`src/teamLead/plannerPrompt.ts`** — extend the `basis "record"` paragraph (`:50-53`) to say the
record line may describe money as well as a cost, and that money on the job is a fact to weigh, not
an instruction to close. The existing THE RECORD wording for cost gaps stays.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass
- [x] new test: money after `asked_at` appears in its own block and sets `moneyOnRecord`
- [x] new test: `evidenceText` is UNCHANGED by money (it stays capture text only)
- [x] new test: a close with `basis: 'record'` on a visit gap citing `moneyOnRecord` is accepted and
      writes `closed on the record — …`, never `answered — "…"`
- [x] new test: money BEFORE `asked_at` does not appear; a gap with no `asked_at` shows none
- [x] new test: an event cancelled by a LATER `correction` does not appear, and the `correction`
      row itself does not appear either
- [x] new test: a `payment_refunded` still renders (it is not a negation)
- [x] new test: the capture lines keep their correct `[n]` labels when money is present
- [x] new test: two gaps on one job with money but no notes both get the shared-evidence warning
- [x] DB-backed test: the reader pages past 1000 rows
- [x] mutation: drop the negation fold → the cancelled-event test fails
- [x] EXTRA (review): the `created_at` vs `occurred_at` choice was untested — a mutation to
      `occurred_at` passed everything. Now pinned at all three sites (reader filter, gap filter,
      rendered date) with fixtures where the two columns genuinely differ
- [x] EXTRA (review): the money block and `moneyOnRecord` were uncapped — one job can carry
      1005+ rows (the reader's own test writes that many), which would be an enormous prompt and
      a multi-kilobyte PERMANENT `nudges.resolution`. Capped at `EVIDENCE_PER_GAP`, most recent
      first, and the record fact names the latest entry plus a count

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP (read-only)
- [x] Read job `eea05151-77af-4a23-bc27-e47031406f33` and confirm its `payment_received` row's
      **`created_at`** falls after nudge `10d68c23-…`'s `asked_at` (2026-08-19 19:05:44Z). Report
      both timestamps and name the column

### Manual verification
- [ ] Read one rendered money block and judge it reads as a fact a person would recognise

---
*Pause after this phase — Manual verification is non-empty.*

## Phase 2: The planner can say "not yet"

### What this phase does
Adds an `extend` action that writes a later `escalate_after`, capped at 48h from `asked_at`, and
corrects the two places that tell the model it can already grant time.

### Changes required

**`supabase/migrations/<ts>_nudge_decisions_extend.sql`** — **written and applied to the LOCAL
stack first** (this phase's DB-backed test needs it), then to the pilot with user authorisation.
```sql
alter table nudge_decisions drop constraint if exists nudge_decisions_action_check;
alter table nudge_decisions add constraint nudge_decisions_action_check
  check (action in ('send','hold','close','escalate','extend'));
alter table nudge_decisions add column if not exists escalate_after timestamptz;
```
The name is deterministic — Postgres generates `<table>_<column>_check` for the inline constraint at
`20260820120000_nudge_decisions.sql:37`; do NOT "look it up on the pilot", a migration must run
identically on both. Drop/re-add is safe: RLS-no-policy and the `revoke` are unaffected and every
existing row satisfies the superset. **Without this, one `extend` rejects its whole insert chunk —
up to 500 decisions** (`recordNudgeDecisions` has no partial insert), the same failure shape the
`safeJobId` guard prevents one layer up.
The `escalate_after` column exists so the corpus can say how far a decision pushed; without it an
applied `extend` logs with no instant and the eval can never measure postponement.

**`src/db/nudgeDecisions.ts`** — `NudgeDecisionInput` (`:11-24`) gains `escalateAfter?: string | null`
and the insert maps it, mirroring `notBefore`.

**`src/jobs/watchers.ts`**
- `export const NUDGE_ESCALATE_MAX_HOURS = 48;` beside `NUDGE_ESCALATE_HOURS` (`:119`), carrying the
  reasoning from Decisions.

**`src/teamLead/planner.ts`**
- `PLANNER_ACTIONS` (`:48`) gains `'extend'`. **`PlannerDecision.escalateAfter` already exists
  (`:55`)** — no type change needed there.
- `validateDecisions` rails, mirroring the `hold` block (`:552-566`):
  - status must be `'asked'` — a pending row has no ask to measure silence from and the delivery
    deadline owns it;
  - **`asked_at` must parse to a finite number, checked FIRST.** `Date.parse(null)` is `NaN`, and
    both `at > NaN` and `at <= NaN` are false, so every rail below would pass and an unbounded
    `extend` would land. Fail closed;
  - `escalateAfter` must parse and be in the future;
  - it must be strictly later than the current effective deadline — `escalate_after` if it parses,
    else `asked_at + NUDGE_ESCALATE_HOURS`, mirroring the sweep's own fallback
    (`watchers.ts:577-580`). An unparseable stamp must NOT be treated as "stamped". Otherwise
    `extend` is a no-op or an escalate-sooner wearing the wrong name;
  - it must not exceed `asked_at + NUDGE_ESCALATE_MAX_HOURS`.
- `planner.ts:24` imports only `NUDGE_DELIVERY_DEADLINE_HOURS` — add both other constants.
- `applyDecision` (`:599`): `case 'extend'` →
  `setSchedule(d.nudgeId, tenantId, { escalateAfter: d.escalateAfter }, ['asked'])`.
- The decision record `base` (`:831-842`) carries `escalateAfter` alongside `notBefore`.
- **`planner.ts:477-479` carries a SECOND copy of the false claim** — the refusal message tells the
  model "To give them more time, leave the gap out of your plan". Correct it to name `extend`.
  `planner.test.ts:578` asserts that string and must be updated with it.

**`src/teamLead/plannerPrompt.ts`**
- Add `extend` to the action list (`:32-36`), the state table (`:38-46`), the `action` enum
  (`:120`), and an `escalateAfter` property on `SUBMIT_PLAN_TOOL`.
- **Correct `:44-46`** — "Leaving it alone is how waiting is expressed" is true for a `pending` row
  and false for an `asked` one, where the 24h clock runs regardless. For an asked gap, more time is
  `extend`; leaving it alone forfeits the turn.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass
- [x] new test: `extend` on an asked gap writes the later instant, status-guarded
- [x] new test: `extend` on a `pending` gap is refused
- [x] new test: `extend` on a gap whose `asked_at` is null/unparseable is refused (the fail-open bug)
- [x] new test: an unparseable `escalate_after` falls back to `asked_at + 24h`, not to "stamped"
- [x] new test: `extend` past `asked_at + 48h` is refused and the reason names the ceiling
- [x] new test: `extend` earlier than the current deadline is refused
- [x] new test: repeated extends cannot push past the ceiling in aggregate
- [x] DB-backed test: an `extend` decision INSERTS, with its `escalate_after` readable back
      (a code-only test passes against the old constraint and proves nothing)
- [x] mutation: remove the ceiling check → the past-48h test fails
- [x] EXTRA (review): the plan's "must be in the future" rail was MISSING from the
      implementation. Reachable whenever the current deadline has already passed (sweep in
      shadow, or an escalate stamp not yet swept): an extend to a PAST instant satisfied
      "later than the current deadline" and was written as applied — an extend that shortens
- [x] EXTRA (review): the model was never told the clock it had to beat. The gap view printed
      `escalates at` only when a stamp existed — i.e. never on a FIRST extend — and refusal
      reasons only reach the model when EVERY decision is refused. The effective deadline is now
      stated on every asked gap and the 48h ceiling is named in the prompt
- [x] EXTRA (review): `applyDecision` used `?? null`, which would CLEAR the stamp and report
      applied. Unreachable today; now refused explicitly so it stays that way
- [x] EXTRA (review): two tests were vacuous — the pending-gap test tripped the asked_at rail
      rather than the status rail (which had zero coverage), and the unparseable-stamp test
      asserted acceptance, which passes under the bug too. Both repointed

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test__apply_migration` — **ask the user before applying to the pilot**
- [x] After applying, read the constraint definition and the column back from the pilot and report
      both verbatim

### Manual verification
- [ ] none — mechanical

---

## Phase 3: An amount can cite what it came from

### What this phase does
Lets `record_money_event` accept the capture the amount came from, so a figure is traceable to the
message that reported it.

### Changes required

**`src/db/moneyEvents.ts`** — the guard goes HERE, not in the dispatch. `appendMoneyEvent` does not
validate `sourceCaptureId` today (`:164` passes it straight to the insert; only the FK protects it,
and the FK is cross-tenant-blind). The dispatch's own comment (`server.ts:5473-5477`) states that
tenant/job coherence lives in the typed layer as "ONE write-side guard for every surface" — and
`appendMoneyEvent` already loads the job and checks `correctsEventId` coherence. Put it beside those.
- **No existence oracle** (`:107-109`, the rule this file already states): a capture id belonging to
  another tenant and an unknown capture id must produce the SAME outcome. Both are dropped with the
  same warning; neither refuses the write. An amount that fails to record because its provenance was
  mistyped is strictly worse than an amount recorded without provenance.

**`src/mcp/server.ts`**
- `record_money_event` schema (`:1429-1470`): add
  `sourceCaptureId: { type: 'string', description: 'The capture this amount came from, if one was recorded in the same conversation. Copy the id returned by record_field_note.' }`
- Add `sourceCaptureId` to the non-string rejection list at `:5448`, per that block's own "EVERY arg"
  rule.
- Pass it into the `appendMoneyEvent` call — the input field already exists (`moneyEvents.ts:64`) and
  already writes the column (`:164`).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass
- [x] new test: a valid `sourceCaptureId` lands on the row
- [x] new test: a capture from ANOTHER tenant is dropped and the money event still records
- [x] new test: an UNKNOWN capture id produces the identical outcome and the identical warning
      (no existence oracle — a test asserting they differ would be asserting the bug)
- [x] new test: a malformed id is dropped, a warning logs, and the money event STILL records
- [x] mutation: drop the tenant guard → the cross-tenant test fails
- [x] EXTRA (review): `sourceCaptureId: ''` THREW and lost the money row — `?? null` keeps an
      empty string while the truthiness guard skips it, so `''` reached a uuid column. Reachable
      from the dispatch, since `str()` returns `''` unchanged. Now `|| null`, with a test
- [x] EXTRA (review): nothing asserted that the two warnings are the same STRING. Outcome parity
      alone would let a future edit split them into "unknown" vs "another tenant" and rebuild the
      existence oracle with a green suite. Now spied and compared

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP
- [x] Query `money_events` for rows with a non-null `source_capture_id` over the following week.
      **Zero is a finding, not a pass** — it means no agent is passing it, which is the same
      adoption question plan ③'s stamp faces

### Manual verification
- [ ] none — mechanical
