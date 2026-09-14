---
date: 2026-09-14
task: The extractor names which of a customer's jobs a message concerns, or none — and the door files on that answer without letting it flip status or silence a promise
research: thoughts/shared/research/2026-09-11-re-inventing-the-write-path-door.md
status: draft
supersedes: nothing
---

## Overview

Builds on `thoughts/shared/plans/2026-09-11-the-door-stops-guessing.md` (PR #235, merged 2026-09-12),
which created the branch this fills: `!mayGuess && candidates.length > 1` — a known customer, several
open jobs, nothing naming one. There the door gives up. A count is a weak test: the Delphine promise
concerned a bathroom faucet and the candidates were a boiler and a kitchen tap — "none of these",
which no count can say.

**REWRITTEN 2026-09-14** (user: "We are going to fold it"); the separate-chooser design, last at
commit `6e45a08`, is rejected below. **Lands with**
`thoughts/shared/plans/2026-09-14-a-reply-keeps-the-models-doubt.md`: without it, both rulings hold
for the message the model read and fail on the customer's reply.

## Decisions

- **Folded into the extractor — no second model call** (user). REJECTED: a chooser call after
  identity. It re-read the message without the extractor's reading while the extractor never saw the
  candidates, so the decisions never met; and it added a model call inside the webhook's timeout.
  The user's 2026-08-22 direction to collapse model-call stages names that defect: coherence, not cost.
- **Identity from ENVELOPE keys first.** Extraction (`recordFieldNote.ts:298`) precedes identity
  (`:321`) because identity reads its phone and address; but email, thread and caller id are envelope
  facts. A pre-match reuses `matchIdentity` with `extracted: { phone: input.fallbackPhone }` — still
  one deterministic identity implementation. The real match runs after, unchanged.
- **Address-only identity gets no candidates** — it needs the extractor first. PR #235's behaviour.
- **Candidates go in the USER message; `EXTRACTION_SYSTEM` stays byte-identical.** The
  `renderExtractionUser` idiom, whose "BARE" pin keeps ordinary messages unchanged.
- **A NUMBER, pinned to the list SHOWN** (review fix). The model answers `1..N`. The door keeps the
  exact array it showed (`shownCandidates`), maps the number to a job **id**, and accepts it only if
  that id is still in its own fresh `candidates`. A second `listJobsForCustomer` seconds later can
  differ in membership, and in order — it sorts on `created_at` with no tiebreak (`jobs.ts:149`) — so
  indexing the fresh list could file on the wrong job under a `basis='model'` that looks grounded. No
  list shown → any `jobChoice` is ignored. Models copy UUIDs wrong (`UUID_RE` at `src/mcp/tools/shared.ts:723`,
  `webhook.ts:39`, `nudgeDecisions.ts:78`), so no id is ever asked for.
- **Bounded, and truncation falls back** (review fix). The extractor runs at `maxTokens: 1024` on
  default `medium` reasoning (`forcedTool.ts:39`), already listed as unmeasured truncation risk in
  `docs/engineering-memory.md:3174-3177`. Candidates show only when there are 2–8; titles are cut at
  80 characters; `jobChoiceReason` is one short sentence. A truncated extraction WITH candidates is
  re-run once WITHOUT them — otherwise it throws after L1, the webhook answers `transient_error`, and
  every redelivery truncates the same way: a regression PR #235 does not have. Caught by a typed
  predicate so an outage is never retried into a second bill.
- **Title and status only** — no visit dates, this repo's most repeated extraction hazard.
- **Earlier messages still supply identity only.** "Thursday works", whose job is named three
  messages up, gets no pick — the safe direction, accepted, and a fixture pins it.
- **A pick FILES and decides nothing else** (user). No status flip — "that is the planner's job". A
  commitment on a picked job still asks when a live visit attached (inferred from that; confirmed by
  `/implement`).
- **The basis is recorded on the link written** (user: "record why the model picked the job"):
  `job_captures` with no live trip, `visit_notes` with one — both gain `basis` / `basis_reason` at
  insert. CHECK `basis in ('model','inherited')`; `inherited` is written by the reply plan and defined
  here so it needs no second hand-applied migration.
- **The eval is a script, not a test** (review fix). `vitest.config.ts:6` runs `src/**/*.test.ts` and
  `src/test.setup.ts:8` loads `.env`, so a test file would bill ~30 live calls on every `npm test` in
  a keyed checkout. `describe.skipIf(!hasModelCredentials())` suits 1–3 clear-cut assertions
  (`src/email/classify.test.ts:13`); a scored eval follows `scripts/date-eval/` and
  `scripts/spine-eval/` instead.
- **The eval scores the prompts that CHANGE** (review fix). A candidate block can move the gated
  fields — `EXTRACTION_SYSTEM` says a visit "already handled must NOT set visitCommitted"
  (`extract.ts:123-125`), and a job list nearby could read that way: the Delphine failure, returned.
  So fixtures run WITH and WITHOUT candidates and all three gated fields are scored both ways.
- **Parked, not fixed:** the link views carry no `retracted` flag while `basis_reason` is model text
  about a customer's message (`20260914-the-link-views-expose-basis-reason-but-c`); `listJobsForCustomer`
  has no tiebreak, which also makes PR #235's "newest open job" rule order-dependent on equal
  timestamps (`20260914-listjobsforcustomer-orders-on-created-at`). **Accepted:** `matchIdentity` runs
  twice on the automatic path — a few indexed reads.

## Plain-language walkthrough

**Today (after PR #235),** a customer with several open jobs writes, nothing names one, and the door
gives up and files under the customer — even when the words make the answer obvious.

```
  BEFORE (PR #235)                          AFTER
  extract ─► who? ─► which job?             who? (from the envelope) ─► their 2–8 open jobs
                      └─ several ─► give up                                    │
                                                extract, SHOWN "1. boiler  2. kitchen tap"
                                                ├─ "2" ─► still open? ─► file on it, marked as a model's pick
                                                └─ none, or anything odd ─► give up, as before
```

**Phase 1 — measure the extractor first.** Nothing tests what it returns. Hand-written messages with
the right answers written down, run against the model production uses, scored and recorded.

**Phase 2 — show it the jobs.** Find the customer from the envelope and show their jobs as a numbered
list. It answers with a number or nothing, and nothing acts on it yet. The gate: no score drops —
including on messages that now carry the list.

**Phase 3 — file on the answer.** The number is checked against the list it was given, the job must
still be open, and the link records that a model picked it and why. It never moves status, and a
promise still reaches the planner.

## Secrets & env preflight

- **All phases:** `OPENROUTER_API_KEY` (or `INFERENCE_API_KEY`) in `.env` — *already required*
  (`src/model/forcedTool.ts:115-117`); present in this worktree. **Phase 1 also** needs the model the
  production extractor uses: read `INFERENCE_MODEL` from the Render service (the name only) and pin it
  in the eval. Locally it is unset and falls back to `z-ai/glm-5.3` (`forcedTool.ts:91`).

---

## Phase 1: A measured baseline

### What this phase does
Adds a scored eval script for the extractor's outputs and records today's numbers.

### Changes required

**`scripts/extract-eval/run.mjs`** (new) + **`package.json`** script `extract-eval` — never in
`npm test`. Pins the production model from the preflight.
- Hand-written fixtures, never from the pilot: a firm commitment; a customer only asking; a
  thank-you; "the job's done"; the firm's own reply (`fromTheFirm`); a reschedule in a thread; a
  quote request; a wrong number; "Thursday works" with its job named only earlier in the thread.
- Each also gets a WITH-CANDIDATES twin (a promise beside a job that has a trip; a thank-you; a status
  report), run once Phase 2 renders candidates.
- Labels for `visitCommitted`, `touchesOperations`, `statusSignal`; each fixture 3×. Records per-field
  agreement, `finish_reason`, and output tokens.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass — and `npm test` makes no model call

### Live verification (agent-executable)
- Prerequisites: `.env` key; the production model name.
- [ ] `npm run extract-eval` on today's code (no candidates exist yet). Evidence: per-field agreement,
      finish reasons and token counts, written into Decisions as the baseline.

### Manual verification
- [ ] Check the labels. A baseline scored against wrong labels makes every later comparison worthless.

---
*Pause after this phase — its manual list is non-empty.*

## Phase 2: The extractor is shown the jobs

### What this phase does
Finds the customer from envelope keys before extraction and shows 2–8 open jobs as a numbered list.
The answer comes back; nothing acts on it.

### Changes required

**`src/model/forcedTool.ts`** — export `isOutputTruncated(err)`, true for the errors thrown at `:342`
and `:435` (a typed marker, not message matching); existing messages unchanged.

**`src/writePath/extract.ts`**
- `ExtractedFields` + `EXTRACTION_TOOL`: optional `jobChoice` (number — "ONLY when a CANDIDATE JOBS
  list is shown: the number of the one job this message concerns; omit if none") and `jobChoiceReason`
  (string — "one short sentence").
- `Extractor` context gains `candidates?: { title: string | null; status: string }[]`.
- `renderExtractionUser`: when candidates are non-empty, the order is thread → candidate block →
  label → message, and the latest message is ALWAYS labelled (its bare path has no label, so "the
  latest message" would point at unmarked text). With no candidates, all three current paths unchanged.
- `EXTRACTION_SYSTEM`: unchanged.

**`src/writePath/recordFieldNote.ts`**
- Hoist `isTechnicianChannel` from `:447` to above `:298` — nothing between reads it.
- After the `structure === false` return (`:286`), when
  `!isTechnicianChannel && !input.resolved && !input.decided && !input.captureId`, pre-match with
  `matchIdentity({ tenantId, technicianRef, capturedAt, extracted: { phone: input.fallbackPhone ?? null },
  email: input.fallbackEmail ?? null, threadId: input.threadId ?? null })` in a try/catch. On `matched`
  with no `jobId`: `listJobsForCustomer`, non-terminal (as `:607-609`); if 2–8, set `shownCandidates`
  (ids kept, titles cut at 80) and `preMatchCustomerId`.
- Rewrite the context argument at `:298-303`: pass it when there is a thread, the firm's own mail, OR
  `shownCandidates`, with `earlier: input.threadContext ?? []`. No candidates → `undefined` exactly as
  now (pinned at `recordFieldNote.test.ts:2055`).
- If that extraction throws and `isOutputTruncated(err)` and candidates were shown: re-extract once
  without them and clear `shownCandidates`. Every other error propagates as today.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] `extract.test.ts` pins hold; no candidates → all three render paths unchanged; with candidates →
      thread, block, label, message, in that order; both new fields declared
- [ ] a spy extractor gets candidates for a two-job customer matched on email, and NOT for: a
      technician channel, `resolved`, `decided`, a re-entry, a thread-named job, one job, nine jobs, an
      address-only identity
- [ ] a pre-match that throws still extracts, without candidates
- [ ] a stub throwing a truncation error once → a second call with no candidates, and the capture is
      filed; a stub throwing anything else → it propagates, one call only

### Live verification (agent-executable)
- Prerequisites: `.env`; the pinned model.
- [ ] `npm run extract-eval`, both variants. Evidence: WITHOUT — no field more than 1 run below
      baseline; WITH — no gated field more than 1 run below its WITHOUT twin (a dip is re-run once
      before it counts); no `finish_reason=length`.
- [ ] Specimen vs "Boiler diagnostic" / "Kitchen tap dripping" → no `jobChoice`; a kitchen-tap message
      → `2`; 3× each. Evidence: all six results and reasons.

### Manual verification
- [ ] Read the six reasons: refusing for the right reason, naming confidently rather than luckily.

---
*Pause after this phase — its manual list is non-empty.*

## Phase 3: The door files on the answer, and nothing else

### What this phase does
Accepts a checked answer as the job, records that a model picked it, and keeps both rulings.

### Changes required

**`supabase/migrations/<timestamp>_link_basis.sql`** (new) — on `job_captures` and `visit_notes`:
`basis text`, `basis_reason text`, `check (basis is null or basis in ('model','inherited'))`,
`check (basis_reason is null or basis is not null)`. Append both to `v_job_captures` / `v_visit_notes`
via `CREATE OR REPLACE`, tenant re-checks copied verbatim. `npm run gen:types:local`.

**`src/db/jobs.ts:468`, `src/db/visits.ts:1368`** — optional `basis` / `basisReason`, sent only when
set, so no write names a column the pilot lacks before the migration.

**`src/writePath/recordFieldNote.ts`**
- Declare `let jobFromModel: { reason: string } | null = null` ABOVE `:632`, outside the block —
  `:797`, `:824`, `:890` and `:901` read it.
- Inside the `:632` block, before `:633`: if `shownCandidates` is non-empty, `customerId ===
  preMatchCustomerId`, `jobChoice` is an integer in `1..shownCandidates.length`, and that candidate's
  id is still in the fresh `candidates` → `job` = the FRESH row, `jobFromModel = { reason }`, skip
  `:633-636`. Anything else → PR #235 behaviour.
- `observeInbound` gains explicit parameters `jobBasis`, `jobBasisReason`, `attachedVisitId` — never
  read from the enclosing scope: it is called at `:634`, `:673`, `:689`, before `let visit` at `:736`,
  and reading either from the closure throws "Cannot access before initialization", which `tsc` does
  not catch.
- The ask at `:792-797`: with `jobFromModel`, a commitment asks even if `visit` is set, passing
  `attachedVisitId: visit?.id`. The links at `:824` / `:890` carry `basis: 'model'`. The status block at
  `:901-906` is skipped.

**`src/teamLead/planner.ts:1590`** — ` — chosen by a model from N open jobs: <reason>`, plus
` (already on a booked trip)` with `attachedVisitId`. **`src/mcp/server.ts:212-214`** — the two view
catalog lists name `basis, basis_reason`. **`docs/onboarding.md:129`, `docs/engineering-memory.md`** —
"never a model guess" holds for the customer; the job may be a model's answer from a numbered list.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] choice 2, uncommitted, no trip → `job_captures` on it, `basis='model'`; with a trip → `visit_notes`
- [ ] **no flip:** chosen job `in_progress`, `statusSignal: 'completed'` → still `in_progress`
- [ ] **no silenced promise:** chosen job has a visit, `visitCommitted: true` → `inbound_commitment` with
      `jobBasis`, reason, `attachedVisitId`; mutation-checked against the plain `!visit` rule
- [ ] **the list moved:** shown [A, B], A closes before resolution, choice 1 → none, NOT filed on B
- [ ] `jobChoice` of `0`, `3` of 2, `1.5` → none; `"2"` through `coerceBySchema` becomes `2` and IS
      accepted, as it would be in production
- [ ] a `jobChoice` with no list shown → ignored; pre-match customer ≠ final → ignored
- [ ] every other link writes a null basis; the CHECKs refuse `'guess'` and a reason without a basis
- [ ] the existing specimen test passes unchanged; the planner renders the model-choice line

### Live verification (agent-executable)
- Prerequisites: local stack; `.env`.
- [ ] Live extractor, local stack: the specimen → ask, customer link, no job link; a kitchen-tap
      message → a `basis='model'` link on the tap job with the model's reason. Evidence: the rows.

### Manual verification
- [ ] Judge the pair together: one door, two messages, two different and correct outcomes.

---
*Pause after this phase — its manual list is non-empty.*

## Deploy note

Deploys run NO migrations. Hand-apply PR #235's `customer_captures` migration if it is not already on the pilot,
then `link_basis`, BEFORE the code. Never `db push`.
