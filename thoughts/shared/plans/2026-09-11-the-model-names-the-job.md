---
date: 2026-09-14
task: The extractor names which of a customer's jobs a message concerns, or none — and the door files on that answer without letting it flip status or silence a promise, on this message or any reply
research: thoughts/shared/research/2026-09-11-re-inventing-the-write-path-door.md
status: draft
supersedes: nothing
---

## Overview

Builds on `thoughts/shared/plans/2026-09-11-the-door-stops-guessing.md` (PR #235, not yet on main),
which created the branch this fills: `!mayGuess && candidates.length > 1` — a known customer, several
open jobs, nothing naming one. There the door gives up: it files under the customer and asks only if
the firm committed. A count is a weak test. The Delphine promise concerned a bathroom faucet and the
candidates were a boiler and a kitchen tap; the truth is "none of these", which no count can say.

**REWRITTEN 2026-09-14** (user: "We are going to fold it"). The previous design in this file, last at
commit `6e45a08`, added a SEPARATE chooser model call. It is rejected in Decisions below.

## Decisions

- **Folded into the extractor — no second model call** (user, 2026-09-14). REJECTED: a chooser call
  after identity resolves. It read the message a second time without the extractor's reading, while
  the extractor read it without the candidates, so the two decisions never met; and it put a second
  model call inside the webhook's delivery timeout. The user's 2026-08-22 direction to collapse
  model-call stages names the same defect: the win is coherence, not cost.
- **Identity from ENVELOPE keys before extraction.** The extractor runs at `recordFieldNote.ts:298`,
  before identity at `:321`, because identity reads its phone and address. But three of the four keys
  are envelope facts — email (sender, or recipient on sent mail), thread id, caller id. A pre-match
  calls the existing `matchIdentity` with `extracted: { phone: input.fallbackPhone }`, so there is
  still ONE deterministic identity implementation.
- **The pre-match only decides whether to show candidates.** The real `matchIdentity` still runs after
  extraction, unchanged. The model's answer is used only if that customer equals the pre-match's; an
  extracted phone resolving someone else voids it.
- **An address-only identity gets no candidates, deliberately.** It needs the extractor first, so it
  keeps PR #235's behaviour. Weakest key, least common path, and still at most one model call.
- **Candidates go in the USER message; `EXTRACTION_SYSTEM` stays byte-identical.** The
  `renderExtractionUser` idiom — a label appears only where it says something new, and
  `extract.test.ts` pins that an ordinary message passes through BARE. Every extraction that shows no
  candidates sees today's prompt exactly. This is what contains the risk of adding a task to the
  highest-volume model call; the only shared change is two optional schema fields.
- **The model answers with a NUMBER from the shown list, never an id.** Models copy UUIDs wrong —
  `UUID_RE` rails exist at `src/mcp/server.ts:2740`, `src/inbound/webhook.ts:39` and
  `src/db/nudgeDecisions.ts:78` for that trap. The door maps `1..N` to a candidate; anything else is
  "none", so a hallucinated id can never reach a foreign key.
- **Candidates show title and status only**, not visit dates — dates are this repo's most repeated
  extraction hazard, and titles are what tell jobs apart.
- **A model's pick FILES and decides nothing else** (user, 2026-09-14). (1) No status flip: "the
  chooser should not be allowed to flip because that is the planner's job". (2) A commitment on a
  model-picked job still asks when a live visit attached — deciding the planner need not hear about a
  promise is the planner's call (inferred from (1); treated as confirmed when `/implement` was run).
- **The basis is recorded on the link actually written** (user, 2026-09-14: "I would record why the
  model picked the job"). A pick lands as `job_captures` with no live trip and `visit_notes` with one —
  the specimen's shape — so BOTH gain nullable `basis` / `basis_reason`, written at insert only (both
  are append-only on UPDATE). CHECK `basis in ('model','inherited')`.
- **OPEN — what a reply on the same thread inherits** (recommended (A); user has not yet chosen).
  `findCustomersByThread` builds a thread's job from earlier messages' links and `withThreadJob` hands
  it back as `match.jobId`, so a reply to a model-picked message arrives "thread-named": it could flip
  status, its promise is silenced by `!visit`, and its link reads as grounded. Replying to the firm's
  own mail is the common next message. (A) CARRY THE DOUBT FORWARD: same job, inherits the model
  basis, records `basis='inherited'`. (B) DISTRUST: the thread lookup skips basis-bearing links and the
  reply is re-picked. (A) keeps a conversation on one job; (B) is less code but a model may answer
  differently the second time. Phase 4 builds (A).
- **No extraction eval existed, so the gate is built first.** `defaultExtractor`'s only other caller
  is `server.ts`, and `extract.test.ts` pins wording, not outputs. Phase 1 measures today's extractor
  before anything changes, so "no regression" has a number.
- **Known, not fixed here:** `basis_reason` is model text about a customer's message, and the link
  views carry no `retracted` flag the way `v_captures` does; `matchIdentity` runs twice on the
  automatic path (a few indexed reads).

## Plain-language walkthrough

**Today (after PR #235).** When a customer with several open jobs writes and nothing says which job,
the door gives up and files under the customer. Safe — but it gives up even when the words are clear.

```
  BEFORE (PR #235)                          AFTER
  extract ─► who? ─► which job?             who? (from the envelope) ─► their open jobs
                      └─ several ─► give up                                    │
                                                extract, SHOWN "1. boiler  2. kitchen tap"
                                                ├─ "2"    ─► file on the tap job, marked as a model's pick
                                                └─ none   ─► give up, exactly as before
```

**Phase 1 — measure the extractor before touching it.** Nothing tests what it actually returns, only
its wording. So: hand-written messages with the right answers written down, run against the live
model, agreement recorded. That number is the bar every later phase must meet.

**Phase 2 — show it the jobs.** Work out the customer from the envelope, list their open jobs, and
show them as a numbered list only when there are several. It answers with a number or nothing.
Nothing uses the answer yet. You would see it work by the Phase 1 score not dropping.

**Phase 3 — file on the answer.** A named job gets the message, and the link records that a model
picked it and why. It never moves the job's status, and a promise on it still reaches the planner.

**Phase 4 — the reply keeps the doubt.** When the customer answers on the same thread, the reply goes
on the same job and is treated as a model's pick too — so it cannot flip or silence what the first
message could not.

## Secrets & env preflight

- **Phases 1–3:** `OPENROUTER_API_KEY` (or `INFERENCE_API_KEY`) in `.env` — *already required*
  (`src/model/forcedTool.ts:115-117`). Present in this worktree since 2026-09-14.
- **Phase 4:** none — deterministic.

---

## Phase 1: A measured baseline

### What this phase does
Adds a key-gated live eval of the extractor's OUTPUTS on labelled messages, and records today's score.

### Changes required

**`src/writePath/extract.eval.test.ts`** (new) — skips without a key, like the repo's other
key-gated live tests, so a keyless `npm test` is unaffected.
- ~8 hand-written fixtures, never taken from the pilot: a firm commitment; a customer only asking; a
  thank-you; "the job's done"; the firm's own reply (`fromTheFirm`); a reschedule inside a thread; a
  quote request; a wrong number.
- Labels only for the fields the door gates on: `visitCommitted`, `touchesOperations`, `statusSignal`.
- Each fixture 3×; print per-field agreement out of 24.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass (the eval skips when keyless)

### Live verification (agent-executable)
- Prerequisites: `.env` with the key.
- [ ] Run the eval. Evidence: the per-field agreement table, written into this plan's Decisions as
      the baseline.

### Manual verification
- [ ] Check the labels. A baseline scored against wrong labels makes every later comparison worthless.

---
*Pause after this phase — its manual list is non-empty.*

## Phase 2: The extractor is shown the jobs

### What this phase does
Resolves the customer from envelope keys before extraction and, when they have several open jobs,
passes them as a numbered list. The answer comes back but nothing acts on it.

### Changes required

**`src/writePath/extract.ts`**
- `ExtractedFields` gains `jobChoice?: number | null` and `jobChoiceReason?: string | null`.
- `EXTRACTION_TOOL.inputSchema` declares both. `jobChoice`: "ONLY when a CANDIDATE JOBS list is shown:
  the number of the one job this message concerns. Omit it if the message concerns none of them."
- `Extractor`'s `context` gains `candidates?: { title: string | null; status: string }[]`.
- `renderExtractionUser`, when `candidates` is non-empty, renders ahead of the latest message:
  `CANDIDATE JOBS for this customer — which ONE does the latest message concern? Answer by number, or
  leave it out if none:` then `1. "Boiler diagnostic" (open)`.
- `EXTRACTION_SYSTEM`: unchanged.

**`src/writePath/recordFieldNote.ts`**
- Hoist `isTechnicianChannel` (`:447`) above the extraction at `:298`.
- Before `:298`, when `!isTechnicianChannel && !input.resolved && !input.decided && !input.captureId`:
  pre-match via `matchIdentity({ …, extracted: { phone: input.fallbackPhone ?? null }, email, threadId })`.
  On `matched` with no `jobId`, read `listJobsForCustomer`, keep non-terminal (ascending, as `:606`),
  and pass them as `candidates` when there are more than one. try/catch: a failed pre-match extracts
  without candidates, never fails the capture.
- Keep the pre-match customer id and the exact ordered list for Phase 3.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] `extract.test.ts` pins still hold; `renderExtractionUser('x')` is still BARE; with candidates the
      numbered block precedes the latest message; the schema declares both new fields
- [ ] a spy extractor receives candidates for a two-job customer matched on email, and does NOT for:
      a technician channel, `resolved`, `decided`, a re-entry, a thread-named job, one candidate, an
      address-only identity
- [ ] a pre-match that throws still extracts, without candidates

### Live verification (agent-executable)
- Prerequisites: `.env` with the key.
- [ ] Re-run the Phase 1 eval. Evidence: no field more than 1 of 24 below baseline; a dip is re-run
      once before it counts.
- [ ] Candidate fixtures, 3× each: the specimen against "Boiler diagnostic" / "Kitchen tap dripping" →
      `jobChoice` absent; a kitchen-tap message → `2`. Evidence: all six results and reasons.

### Manual verification
- [ ] Read the six `jobChoiceReason`s: refusing for the right reason, naming confidently not luckily.

---
*Pause after this phase — its manual list is non-empty.*

## Phase 3: The door files on the answer, and nothing else

### What this phase does
Uses a valid answer to pick the job, records that a model picked it, and keeps both rulings.

### Changes required

**`supabase/migrations/<timestamp>_link_basis.sql`** (new) — on `job_captures` AND `visit_notes`: add
`basis text`, `basis_reason text`; `check (basis is null or basis in ('model','inherited'))`;
`check (basis_reason is null or basis is not null)`. Append both to `v_job_captures` and
`v_visit_notes` via `CREATE OR REPLACE`, each view's tenant re-check copied verbatim. Then
`npm run gen:types:local`.

**`src/db/jobs.ts:468`, `src/db/visits.ts:1368`** — `insertJobCapture` / `insertVisitNote` take
optional `basis` / `basisReason` and send those keys ONLY when set, so no write names a column the
pilot lacks before the migration is applied.

**`src/writePath/recordFieldNote.ts`**
- At `:632`, before `:633`: if `extracted.jobChoice` is an integer in `1..candidates.length` and the
  resolved `customerId` equals the pre-match customer, set `job = candidates[jobChoice - 1]` and
  `jobFromModel = { reason: extracted.jobChoiceReason ?? '' }`, then SKIP `:633-636` entirely.
- The ask at `:792-797`: when `jobFromModel`, a commitment asks even if `visit` is set, via
  `observeInbound(job, candidates)` whose context gains `jobBasis`, `jobBasisReason` and, when a trip
  attached, `attachedVisitId`.
- The links at `:824` / `:890`: `basis: 'model'`, `basisReason` when `jobFromModel`.
- The status block at `:901-906`: skipped when `jobFromModel`.

**`src/teamLead/planner.ts:1590`** — the `open job …` line appends
` — chosen by a model from N open jobs: <reason>`, and ` (already on a booked trip)` with `attachedVisitId`.

**`src/mcp/server.ts:851`** — the `v_job_captures(…)` and `v_visit_notes(…)` catalog lists name
`basis, basis_reason`.

**`docs/onboarding.md:129`, `docs/engineering-memory.md`** — "never a model guess" holds for the
customer; the job may be a model's answer, bounded by a numbered list and recorded as such.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] `jobChoice: 2`, uncommitted, candidate 2 has no trip → `job_captures` on it, `basis='model'`
- [ ] same with a confirmed visit on candidate 2 → a `visit_notes` link with `basis='model'`
- [ ] **no flip:** the chosen job is `in_progress`, `statusSignal: 'completed'` → still `in_progress`
- [ ] **no silenced promise:** chosen job has a visit, `visitCommitted: true` → `inbound_commitment`
      with `jobBasis`, reason, `attachedVisitId`. Mutation-check against the plain `!visit` rule.
- [ ] `jobChoice` of `0`, `3` of 2, `1.5`, `"2"` → none, PR #235 behaviour
- [ ] pre-match customer ≠ final customer → answer ignored
- [ ] every other link path writes a null basis; the CHECKs refuse `'guess'` and a reason without basis
- [ ] the existing specimen test passes unchanged (its stub leaves `jobChoice` unset)
- [ ] the planner renders the model-choice line

### Live verification (agent-executable)
- Prerequisites: local stack; `.env`.
- [ ] Live extractor, local stack: the specimen → ask, customer link, no job link; a kitchen-tap
      message → a `basis='model'` link on the tap job carrying the model's reason. Evidence: the rows.

### Manual verification
- [ ] Judge the pair together: one door, two messages, two different and correct outcomes.

---
*Pause after this phase — its manual list is non-empty.*

## Phase 4: A reply on the thread keeps the doubt

### What this phase does
Builds option (A) of the OPEN decision: the thread lookup reports whether its job came only from a
model's pick, and the door treats that reply exactly like the pick. Replace with (B) if the user
chooses it: arms (b)/(c) skip basis-bearing links, and the test is that the reply is re-picked.

### Changes required

**`src/db/rawCaptures.ts:703`** — `ThreadIdentity` gains `jobBasis: 'model' | null`,
`jobBasisReason`, `jobBasisCaptureId`.

**`src/db/rawCaptures.ts:737`** — arms (b) and (c) also select `capture_id, basis, basis_reason`. A job
is `'model'` only when EVERY link reaching it on the thread carries a basis and no stamp (arm a) names
it; one null-basis link or stamp is independent evidence and grounds it.

**`src/writePath/identityMatch.ts:137-154`** — `withThreadJob` copies the adopted job's basis into
`MatchResult`.

**`src/writePath/recordFieldNote.ts`** — `match.jobBasis === 'model'` sets `jobFromModel` as Phase 3
does; that link writes `basis: 'inherited'`, `basisReason: 'inherited from capture <id>: <reason>'`.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] two messages on one thread: msg 1 model-picks the tap job (trip attached); msg 2 with
      `statusSignal: 'completed'` and `visitCommitted: true` → not flipped, asked, `basis='inherited'`
      naming msg 1
- [ ] a third message inherits again
- [ ] a null-basis link or a stamp on the same job clears the doubt — msg 2 behaves as thread-named

### Live verification (agent-executable)
- [ ] none — deterministic, fully covered above

### Manual verification
- [ ] none

---
*Automated checks suffice; continue.*

## Deploy note

Deploys run NO migrations. Hand-apply PR #235's `customer_captures` migration, then this plan's
`link_basis` migration, to the pilot BEFORE the code. Never `db push`.
