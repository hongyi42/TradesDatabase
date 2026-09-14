---
date: 2026-09-11
task: On the ambiguous branch only, a model names which of the customer's jobs a message is about — or says it cannot
research: thoughts/shared/research/2026-09-11-re-inventing-the-write-path-door.md
status: draft
supersedes: nothing
---

## Overview

Builds directly on `thoughts/shared/plans/2026-09-11-the-door-stops-guessing.md`, which must land
first: it creates the branch this plan fills in — `!mayGuess && candidates.length > 1`, where the
door has a known customer, several non-terminal jobs, and nothing naming which one a message is
about. That plan files such a capture under the customer and asks only when the firm committed.

A count of candidates is a weak test. In the specimen that prompted all of this, the promise was
about a dripping bathroom faucet while the candidates were a boiler diagnostic and a kitchen tap —
the true statement is not "two candidates" but "about none of them", which no count can express, and
which is invisible when the customer has exactly one open job. This plan asks a model that question.

Split out of the first plan rather than carried as its phase 3: it crosses a recorded doctrine line
and adds a model call to the inbound path, and both deserve their own review.

## Decisions

- **A SECOND model call, not a field on the main extractor** — the extractor runs at
  `src/writePath/recordFieldNote.ts:297`, before identity resolves at `:320`, so it cannot be shown
  the customer's jobs without reordering the whole door. A separate call pays only on the ambiguous
  branch and leaves every `deps.extract` stub in `recordFieldNote.test.ts` (2113 lines) valid.
- **Crosses the deterministic line for the JOB dimension only** — `docs/onboarding.md:129` says
  identity matching decides "which existing customer/job" and is "never a model guess". Customer
  identity stays deterministic code; the job choice becomes a model judgment bounded by a supplied
  candidate list. User decision, 2026-09-11. The doc must be amended in the same commit or it
  contradicts the code.
- **The model may only choose from the list** — a returned id that is not a candidate is treated as
  "none" and never written. The failure mode this forbids is a hallucinated job id reaching a
  foreign key.
- **"None" is a first-class answer**, not an error — it falls back to the first plan's behaviour
  (customer link, ask if committed), which is already correct.
- **A chooser failure must not cost the capture** — try/catch, fall back to "none". The
  `withThreadJob` precedent (`src/writePath/identityMatch.ts:123-131`): a failed "which" must never
  turn a resolved identity into a 503, because the connector then redelivers and the extractor is
  paid for twice.
- **The chooser's BASIS is recorded, never laundered** (amendment 2026-09-12, user) — Phase 2 said a
  named job makes the capture "behave exactly as if the thread had named it". For FILING that is
  right; for the RECORD it erases the one fact a reader most needs: that a model picked this job,
  from these candidates, for this reason. `JobChooser` already returns `reason` — Phase 2 threw it
  away at the fall-through. Why it matters: task `20260912-an-l2-status-flip-reports-to-the-planner`
  reports every L2 touch as "what changed, on what evidence, how sure". Without the basis, a flip
  driven by a chooser-filed message reports "job completed, evidence: this message", with no sign
  the job itself was a model's pick from a list.
  **Where it lives: on the link.** `job_captures` is `(tenant_id, job_id, capture_id, created_at)`
  today, with no room for it, and L1 is append-only so the capture cannot be stamped after insert.
  Add nullable `basis text` and `basis_reason text` (the latter set only for `chooser`), appended to
  `v_job_captures` so the planner can read them. **APPROVED (user, 2026-09-14): "I would record why
  the model picked the job."**
  Only the chooser writes a basis; every other path leaves both columns null. Recording a basis for
  every path (thread, single candidate, technician, decided) would be more complete, but it is not
  what was approved and it is the natural shape of `20260912-an-l2-status-flip-reports-to-the-planner`
  rather than of this plan. The link is append-only on UPDATE, so the basis must be written AT insert
  — there is no later moment to add it.
- **RESOLVED — a chooser hit does NOT flip the job's status** (user, 2026-09-14: "the chooser should
  not be allowed to flip because that is the planner's job"). Option (b) below. `the-door-stops-guessing`
  Phase 2 dropped the `statusSignal` write for ambiguous captures: "leave it to the planner" (user,
  2026-09-12). This plan's fall-through sends a chooser-named capture down the normal path, which
  reaches `updateJobStatus` (`recordFieldNote.ts:905` on PR #235's branch) — so, read literally, a model's pick
  restores the exact flip that ruling removed. (a) Allow it, with the basis recorded so the flip's
  report can say a model chose the job; or (b) skip `statusSignal` when the job came from the
  chooser, keeping that flip the planner's. (b) matches the existing ruling.
  VERIFIED 2026-09-12 on PR #235's branch — NOT on main, where this code does not exist until #235
  merges — not inferred: the ambiguous branch at `recordFieldNote.ts:632-636`
  RETURNS EARLY (`insertCustomerCapture` then `return`) — that early return IS how the ruling removed
  the write — and `statusSignal` is applied only further down, at `:901-906`. Replacing that return
  with a fall-through lands a chooser-named capture directly on it, so Phase 2 must skip that block
  explicitly when the job came from the chooser.
- **A chooser-picked job does NOT silence a promise either** (inferred 2026-09-14 from the user's
  reason for the ruling above — confirm or overrule). Falling through reaches `resolveVisitForNote`,
  which attaches the capture to the picked job's one live visit, and then "a committed capture that
  landed on a LIVE visit asks nothing" (`recordFieldNote.ts:792-797`) suppresses the ask. That is the
  specimen's own failure — and `the-door-stops-guessing` closed it for exactly this case by always
  asking when there are several candidates. Without this carve-out, "we'll come Wednesday about the
  kitchen tap" to a customer whose tap job has a Tuesday trip would be swallowed again. Deciding that
  the planner need not hear about a promise is the planner's call, not a model's pick. So on the
  chooser path a commitment asks even when a live visit attached, and the ask carries the basis.
- **OPEN — the latency budget is not yet known.** `src/calls/observationPing.ts:18-21` records that
  an in-request *agent pass* was rejected because a connector retries on every timeout. One bounded
  forced-tool call is a different thing, but the number is unmeasured; Phase 1 below measures it
  before Phase 2 wires it in.

## Plain-language walkthrough

**Today (after the first plan).** When the door cannot tell which of a customer's jobs a message is
about, it files the message under the customer and asks a manager if a promise was made. Correct, but
blunt: it gives up whenever there is more than one candidate, even when the answer is obvious from
the words.

```
  several candidates, none named
        │
        ├─ BEFORE (first plan)  ─► give up: file under the customer
        │
        └─ AFTER (this plan)    ─► show the model the message + the candidate list
                                     ├─ "it's the kitchen tap"  ─► file on that job
                                     └─ "none of these"          ─► give up, as before
```

**Phase 1 — build the chooser and measure it, wired to nothing.** A small module that takes a message
and a list of jobs and returns one id or null, plus a measurement of what the call costs in latency.
Nothing calls it yet, so the door is unchanged. You would notice it working by its own tests passing
and a recorded p50/p95.

**Phase 2 — wire it into the ambiguous branch.** The door calls the chooser exactly where it would
otherwise give up. A named job is filed on that job, and the link records that a model chose it and
why; "none" behaves exactly as before. A model's pick is trusted to FILE a message and nothing more:
it never moves the job's status, and it never silences a promise — both stay the planner's. You
would notice it working by a message clearly about the kitchen tap landing on the kitchen tap job,
while the bathroom-faucet promise still refuses and asks.

## Secrets & env preflight

- **Phase 1:** `INFERENCE_API_KEY` (or `OPENROUTER_API_KEY`), optionally `INFERENCE_MODEL`, in
  `.env` — *already required* by the existing extractor (`src/model/forcedTool.ts:115-117`). A fresh
  worktree has no `.env`; copy one in or the key-gated live checks silently skip.
- **Phase 2:** same, and only for the live check.

---

## Phase 1: The chooser, and what it costs

### What this phase does
Adds `src/writePath/chooseJob.ts` and its tests, and measures the added latency. Nothing calls it.

### Changes required

**`src/writePath/chooseJob.ts`** (new, ~80 lines)
- `export interface JobCandidate { id: string; title: string | null; status: string }`
- `export type JobChooser = (input: { text: string; candidates: JobCandidate[]; fromTheFirm: boolean }, ctx?: CostContext) => Promise<{ jobId: string | null; reason: string }>`
- `export const defaultJobChooser: JobChooser` — one `runForcedTool` call mirroring `defaultExtractor`
  (`src/writePath/extract.ts:227`), `maxTokens: 256`, `label: 'chooseJob'`.
- Export `CHOOSE_JOB_SYSTEM` and `CHOOSE_JOB_TOOL` so tests pin the prompt and schema — the
  `EXTRACTION_SYSTEM` precedent (`extract.ts:101-103`), whose comment records why: a field silently
  dropped from the schema fails open with nothing to notice it.
- The system prompt must state: choose only from the listed ids; return null when the message
  concerns work none of them covers; **a promise to attend is about the work it names, not the
  nearest open job**; `fromTheFirm` means the text is the firm's own outbound mail.
- **Validate the returned id against the candidate list inside the module** — an unlisted id returns
  `{ jobId: null }`, so no caller can be handed one.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] new `src/writePath/chooseJob.test.ts` with a stubbed `runForcedTool`: a listed id passes
      through; an unlisted id becomes null; a malformed/absent id becomes null
- [ ] a test pins `CHOOSE_JOB_TOOL`'s schema and the candidate-only sentence in `CHOOSE_JOB_SYSTEM`

### Live verification (agent-executable)
- Prerequisites: `.env` with `INFERENCE_API_KEY` / `OPENROUTER_API_KEY`; key-gated, skipped without.
- [ ] The specimen: its real text against its two real candidates ("Boiler diagnostic", "Kitchen tap
      dripping"). Evidence: `jobId: null` with a reason naming the bathroom faucet as matching
      neither. **Run 3 times, report all three** — one pass proves nothing about a model.
- [ ] The inverse: a message plainly about the kitchen tap. Evidence: it returns that id, 3 runs.
      Without this pair, a chooser that always says "none" passes the test above.
- [ ] Record p50/p95 wall-clock over those 6 calls and write the numbers into this plan's Decisions
      section, closing the OPEN latency item.

### Manual verification
- [ ] Read the six reasons and judge whether the refusals are for the right reason rather than by
      luck, and whether the hit is confident rather than a coin flip that landed well.

---
*Pause after this phase — its manual list is non-empty.*

## Phase 2: Wire it into the ambiguous branch

### What this phase does
Calls the chooser where the door would otherwise give up, and links a named job.

### Changes required

**`src/writePath/recordFieldNote.ts:169`** — add `chooseJob?: JobChooser` to the `deps` parameter.

**`src/writePath/recordFieldNote.ts`** — in the `!mayGuess && candidates.length > 1` branch created
by the first plan, before the customer-link fallback:
- call `deps.chooseJob ?? defaultJobChooser` with the raw text, the candidates, and
  `fromTheFirm: channel === 'outbound_email'`
- on a non-null `jobId`, set `job` to that candidate and fall through to the normal path for FILING —
  but write the link with `basis = 'chooser'` and `basis_reason` = the returned `reason`. It must
  never be indistinguishable in the record from a thread-named job (see Decisions: the basis is
  never laundered)
- hold a `jobFromChooser` flag (`{ reason: string } | null`) and use it at TWO later sites:
  - the ask at `:792-797` — when set, a commitment asks even if `visit` is non-null (Decisions:
    a model's pick does not silence a promise)
  - the `statusSignal` block at `:901-906` — when set, skip it entirely (Decisions: no flip)
- `observeInbound`'s context gains `jobBasis: 'chooser'` and `jobBasisReason` when set, so the ask is
  not laundered either; `src/teamLead/planner.ts`'s "on file: open job …" line appends
  `— chosen by a model from N candidates: <reason>` when `jobBasis` is present
- on null, or on a throw, keep the first plan's behaviour unchanged
- wrap in try/catch and log; never rethrow

**`supabase/migrations/<timestamp>_job_captures_basis.sql`** (new) — add nullable `basis text` and
`basis_reason text` to `job_captures`, and append both to `v_job_captures` (a view may only APPEND
columns under `CREATE OR REPLACE`, so no drop is needed). Constrain the vocabulary so it tracks what
actually gates: `check (basis is null or basis = 'chooser')` and
`check (basis_reason is null or basis is not null)` — a new basis value is then a deliberate
migration, not a typo that silently reads as "no basis".

**`src/db/jobs.ts:468`** — `insertJobCapture` takes optional `basis` / `basisReason` and writes them at
insert. Its `ignoreDuplicates` upsert means a SECOND link write can never add a basis to an existing
row — correct, because the append-only trigger forbids it anyway, and the redelivery short-circuit
(`captureHasLinkedL2`) stops the door before a second write. The retraction walk copies links without
a basis, which is right: a retraction row is not a model's pick.
Existing rows stay null. Regenerate types with `npm run gen:types:local` — never the default, which
points at the pilot. Deploys do not migrate: hand-apply to the pilot before this code ships.

**`docs/onboarding.md:129`** — amend "never a model guess" to hold for the customer dimension and
name this plan for the job dimension.

**`docs/engineering-memory.md`** — record the amendment and its bound (candidate-list only,
validated, null-on-failure).

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] stub chooser names candidate 2 → `job_captures` row on candidate 2, no customer link, no ask,
      and that row reads `basis = 'chooser'` with the stub's reason
- [ ] a link written by any path other than the chooser does NOT read `basis = 'chooser'` — the two
      stay distinguishable in the record, which is the whole point of the amendment
- [ ] **no flip**: stub names the in_progress candidate, extractor says `statusSignal: 'completed'` →
      the job is STILL `in_progress`
- [ ] **no silenced promise**: stub names a candidate that has a confirmed visit, `visitCommitted:
      true` → an `inbound_commitment` IS raised, its context carries `jobBasis: 'chooser'` and the
      reason. Mutation-check it against the plain `!visit` rule — this is the specimen's failure
      trying to come back through a new door
- [ ] the migration's check constraints refuse `basis = 'guess'` and a reason with no basis
- [ ] the planner renders "chosen by a model from N candidates" for a chooser-based ask
- [ ] stub returns null → first plan's behaviour exactly (customer link; ask iff committed)
- [ ] stub returns an unlisted id → treated as null, nothing written
- [ ] stub throws → customer link, no 503, error logged
- [ ] a spy asserts the chooser is NOT called when the job is justified, when `mayGuess` is true, or
      when `candidates.length <= 1` — the cost boundary
- [ ] the specimen test from the first plan still passes: the live chooser is not in play there, and
      a stub returning null must leave that assertion untouched

### Live verification (agent-executable)
- Prerequisites: local stack seeded with two non-terminal jobs; `.env` for the live chooser.
- [ ] Replay the specimen's text end-to-end through `recordFieldNote` with the real chooser.
      Evidence: the `inbound_commitment` observation, its `candidates` list, the customer link, and
      no `job_captures` row.
- [ ] Replay a kitchen-tap message end-to-end. Evidence: a `job_captures` row on the kitchen tap job,
      reading `basis = 'chooser'` with the model's own reason, and no observation.

### Manual verification
- [ ] Judge the end-to-end pair together: the same door, two messages, two different and correct
      outcomes. This is the behaviour the whole arc exists to produce.

---
*Pause after this phase — its manual list is non-empty.*
