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
otherwise give up. A named job is linked as if the thread had named it; "none" behaves exactly as
before. You would notice it working by a message clearly about the kitchen tap landing on the kitchen
tap job, while the bathroom-faucet promise still refuses and asks.

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

**`src/writePath/recordFieldNote.ts:168`** — add `chooseJob?: JobChooser` to the `deps` parameter.

**`src/writePath/recordFieldNote.ts`** — in the `!mayGuess && candidates.length > 1` branch created
by the first plan, before the customer-link fallback:
- call `deps.chooseJob ?? defaultJobChooser` with the raw text, the candidates, and
  `fromTheFirm: channel === 'outbound_email'`
- on a non-null `jobId`, set `job` to that candidate and fall through to the normal path — the
  capture then behaves exactly as if the thread had named it
- on null, or on a throw, keep the first plan's behaviour unchanged
- wrap in try/catch and log; never rethrow

**`docs/onboarding.md:129`** — amend "never a model guess" to hold for the customer dimension and
name this plan for the job dimension.

**`docs/engineering-memory.md`** — record the amendment and its bound (candidate-list only,
validated, null-on-failure).

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] stub chooser names candidate 2 → `job_captures` row on candidate 2, no customer link, no ask
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
- [ ] Replay a kitchen-tap message end-to-end. Evidence: a `job_captures` row on the kitchen tap job
      and no observation.

### Manual verification
- [ ] Judge the end-to-end pair together: the same door, two messages, two different and correct
      outcomes. This is the behaviour the whole arc exists to produce.

---
*Pause after this phase — its manual list is non-empty.*
