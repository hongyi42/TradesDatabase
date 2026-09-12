---
date: 2026-09-11
task: The door links only what it can justify — a customer-level link, and no positional job guess on the automatic path
research: thoughts/shared/research/2026-09-11-re-inventing-the-write-path-door.md
status: complete
supersedes: nothing
---

## Overview

`recordFieldNote` must always produce a job to link a capture to, because the job link is the only
home an inbound capture can be given after L1 is written. When nothing names a job it takes the
customer's newest non-terminal job — a positional guess inherited from the 2026-06-20 technician
write-path, where the filer was standing at the work. Applied to the firm's own outbound mail it lost
a dated promise (task `20260911-a-new-promise-to-a-known-customer-is-fil`): two candidate jobs, the
guess took one, that job had a booked trip, and "a commitment on a live visit asks nothing" then
suppressed the ask.

This plan removes the guess **on the automatic path only** — mail, calls and web forms with no human
decision attached. Phase 1 adds a customer-level link and something that reads it; Phase 2 stops the
door choosing by position. Letting a model name the job is the follow-on plan, `thoughts/shared/plans/2026-09-11-the-model-names-the-job.md`,
which fills in the branch Phase 2 creates.

## Decisions

- **A customer-level link table, not a column** — `raw_captures.customer_id` is written at insert only
  and L1 is immutable, so an inbound capture can never be stamped after identity resolves
  (`src/db/rawCaptures.ts:307`). `customer_captures` mirrors `job_captures`
  (`supabase/migrations/20260908100000_inbound_asks_and_job_captures.sql`), built for this same reason
  one level down.
- **A link nothing reads is worse than the guess** (review U4) — `getCustomerContext` reads
  `listRawCapturesForCustomer` (`src/db/context.ts:89`), which keys on the L1 stamp, so the new link
  would be invisible to the planner. Phase 1 ships the reader with the table, or Phase 2 moves
  captures from *misfiled but visible* to *correctly filed and lost*.
- **A customer link is NOT a citation** — excluded from `listL2CitingCapture` (`rawCaptures.ts:548`).
  "Filed under Delphine" is no answer to "did anyone book Wednesday?"; that function's jobs arm
  records what happens when a non-answer closes an ask (`rawCaptures.ts:563-568`).
- **But it IS a processed-marker and a retraction target** — it joins `captureHasLinkedL2`
  (`rawCaptures.ts:168`) or a redelivery re-runs the extractor, and the retraction walk
  (`src/mcp/server.ts:4164-4184`) or a retraction of a customer-only capture is orphaned (D7).
- **Technician channels keep the positional heuristic** (D1) — `recordFieldNote.ts:558` is
  technician-exempt and `:604` mints, so removing the guess for a technician with 2+ open jobs would
  silently mint a THIRD job from a field note. The heuristic is sound where it was written.
- **Manager-relayed decisions keep it too** (D2/D3) — with `decided.openJob` the door reuses rather
  than mints, which `src/mcp/server.ts:6552-6557` states as record_caller's contract; and with
  `decided.bookVisit: true` a null job returns at `recordFieldNote.ts:588-591` **before** the booking
  at `:693-704`, so a manager's approved trip would vanish with `status: 'ok'` — the guard at
  `server.ts:6427` only refuses at *zero* live jobs. A guess with a human behind it is not this
  plan's failure class.
- **"Can't tell which" is not "there is none"** (D4) — `src/teamLead/planner.ts:1520-1524` renders an
  absent `jobId` as *"no open job for this customer — a job would have to be opened"*. Passing null
  for a two-job customer tells the planner a falsehood and steers it to open a third. The observation
  gains a `candidates` list and the planner a render line.
- **Ambiguity alone never asks; only a commitment does** (D8) — otherwise ordinary mail to a two-job
  customer starts raising `inbound_new_job`, the noise the unmatched path avoids on purpose
  (`recordFieldNote.ts:356-360`).
- **The closes-itself rule is untouched** (D6) — `recordFieldNote.ts:600` files on the most recent job
  of ANY status: the 2026-09-07 user amendment (`:513-517`), not the guess, pinned by
  `recordFieldNote.test.ts:1480`.
- **The job chooser is a SECOND model call** — the extractor runs at `recordFieldNote.ts:297`, before
  identity resolves at `:320`, so it cannot see the customer's jobs without reordering the door. A
  separate call pays only on the ambiguous branch and leaves 2113 lines of `deps.extract` stubs valid.
- **Crosses the deterministic line for the JOB dimension only** — `docs/onboarding.md:129`. Customer
  identity stays deterministic; the job choice becomes a model judgment bounded by a candidate list.
  User decision, 2026-09-11.
- **OPEN — the residual hole stays open.** One job + a booked trip + a promise about different work is
  still silenced; that needs a structured promised date. Out of scope, recorded.

## Plain-language walkthrough

**Today.** Every captured message must be filed against a *job*. When the message does not say which
job, the code takes the customer's newest unfinished one. That was a good rule when the only filers
were technicians standing in the customer's kitchen. It is a coin flip for an email the office typed.

```
        BEFORE                                AFTER  (automatic path only)
  which job?                            which job?
   └─ nothing names one                  ├─ the thread names one   ─► file there
      └─ newest open job                 ├─ exactly one candidate  ─► file there
         (a guess, always confident)     ├─ none at all            ─► unchanged
                                         └─ several, none named
                                            └─ file under the CUSTOMER
                                               + ask, only if a promise was made
                                               (the follow-on plan asks a model first)

  technician notes and manager-relayed decisions: unchanged, deliberately
```

**Phase 1 — a place to say "this is Delphine's", and somewhere that shows it.** A message can
currently be tied to a job or a trip and nothing else; the one thing the door is certain of has no
home. This adds that link *and* wires it into what the planner reads about a customer — a link
nothing reads would just hide messages more tidily than misfiling them.

**Phase 2 — stop guessing where the guess has no grounds.** On the automatic path the door keeps a
job only when the thread named one or there is exactly one candidate. Otherwise the message is filed
under the customer, and if the firm promised to come out, the swallowed ask is raised — carrying the
candidate jobs, so the planner hears "I cannot tell which of these two", never "there are none".
Technician notes and anything a manager decided keep today's behaviour. You would see it work by
replaying the Delphine email and getting a question instead of silence.

**Next, in its own plan.** `thoughts/shared/plans/2026-09-11-the-model-names-the-job.md` fills in that last branch: show
a model the candidates and let it name one or say none — the case a count cannot see.

## Secrets & env preflight

- **Phase 1:** none — local Supabase stack only.
- **Phase 2:** none.

---

## Phase 1: A capture can belong to a customer, and be seen there

### What this phase does
Adds `customer_captures` — the twin of `job_captures`, one level up — its accessors, its view, its
arms in the redelivery marker and the retraction walk, and the reader that makes it visible. Nothing
writes to it yet.

### Changes required

**`supabase/migrations/20260912100000_customer_captures.sql`** (new) — mirror the job_captures
section of `20260908100000_inbound_asks_and_job_captures.sql`:
```sql
create table customer_captures (
  tenant_id   uuid not null references tenants(id),
  customer_id uuid not null references customers(id) on delete cascade,
  capture_id  uuid not null references raw_captures(id),
  created_at  timestamptz not null default now(),
  primary key (customer_id, capture_id)
);
create index idx_customer_captures_capture on customer_captures(capture_id);
create index idx_customer_captures_tenant_customer on customer_captures(tenant_id, customer_id);
create trigger customer_captures_append_only
  before update on customer_captures
  for each row execute function raise_append_only();
revoke all on customer_captures from anon, authenticated;
alter table customer_captures enable row level security;
```
- `raise_append_only()` exists (`20260620005307_context_spine.sql:25`, redefined
  `20260819140000_append_only_names_its_table.sql:19`).
- Plus `v_customer_captures` — `select customer_id, capture_id, created_at from customer_captures
  where tenant_id = current_setting('spine.tenant_id')::uuid`. No join: unlike `v_job_captures` there
  is no second table to re-check (U3). `grant select on v_customer_captures to spine_reader`.

**`src/db/customers.ts`** — add `insertCustomerCapture({ tenantId, customerId, captureId })` (upsert,
`onConflict: 'customer_id,capture_id', ignoreDuplicates: true`, mirroring `src/db/jobs.ts:468`) and
`captureHasCustomerCapture(captureId)` (mirroring `src/db/jobs.ts:481`). `src/db/index.ts:5` already
re-exports this module — no export edit needed (U5).

**`src/db/rawCaptures.ts:193-197`** — add `captureHasCustomerCapture` to the `Promise.all` and the
returned disjunction; extend the comment block with the fourth arm.

**`src/db/context.ts:89`** — union customer-linked captures into `capturesByCustomer` alongside
`listRawCapturesForCustomer`, deduped by capture id. This is what makes the link readable (U4).

**`src/mcp/server.ts:4164-4184`** — add the `customer_captures` arm to the retraction walk (D7).

**`src/mcp/server.ts:837,846`** — add `v_customer_captures` to the `query_spine` catalog prose, or
the planner is handed a view it is never told exists (U3).

**`src/db/database.types.ts`** — `npm run gen:types:local` (NOT `gen:types`, which targets the pilot).

### Automated verification
- [x] `npx supabase migration up --local` applies cleanly
- [x] `npm run gen:types:local`; diff contains only the new table and view
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass
- [x] **`src/db/querySpine.test.ts:348-370` updated** — it asserts the exact spine_reader grant list
      and WILL fail on the new view (D5). Add `v_customer_captures` to the expected list.
- [x] **`src/db/schema.test.ts:326-337` extended** — the Data-API-closure test that `job_captures`
      has: RLS enabled AND grants revoked, both halves (D9; `supabase/config.toml:31`).
- [x] new test file `src/db/customerCaptures.test.ts` (does not exist today, U5): insert is
      idempotent; UPDATE raises via the trigger; `captureHasCustomerCapture` true after insert
- [x] new test: `captureHasLinkedL2` true for a capture with ONLY a customer link
- [x] new test: `listL2CitingCapture` returns nothing for a capture with only a customer link
- [x] new test: `getCustomerContext` surfaces a customer-linked capture that has no L1 stamp

### Live verification (agent-executable)
- Prerequisites: none beyond the local stack.
- [x] none — no runtime behaviour changes.

### Manual verification
- [x] none

---
*Automated checks suffice; continue.*

## Phase 2: The door stops guessing on the automatic path

### What this phase does
Replaces the positional guess with a justification test, for non-technician captures carrying no
manager decision. Everything it will no longer guess at goes to the customer link; a commitment still
asks, and the ask now says which jobs it could not choose between.

### Changes required

**`src/writePath/recordFieldNote.ts:541-550`** — justification test, scoped:
```ts
// JUSTIFIED, OR NOT AT ALL — but only where the guess has no grounds. A
// technician is standing at the work, and `decided.*` is a human's answer
// relayed; both keep the 2026-06-20 heuristic. What loses promises is the
// AUTOMATIC path: mail and calls, nobody asked, position deciding the job.
let job: Job | null = match.jobId ? await getJob(match.jobId) : null;
let priorJobs: Job[] = [];
let candidates: Job[] = [];
const mayGuess = isTechnicianChannel || !!input.decided;
if (!job) {
  priorJobs = await listJobsForCustomer(customerId);
  candidates = priorJobs.filter((c) => !TERMINAL_STATUSES.has(c.status));
  job = mayGuess
    ? ([...candidates].reverse()[0] ?? null)   // unchanged: newest non-terminal
    : (candidates.length === 1 ? candidates[0] : null);
}
```
The `mayGuess` arm must be behaviour-identical to today's
`[...priorJobs].reverse().find((c) => !TERMINAL_STATUSES.has(c.status))`.

**`src/writePath/recordFieldNote.ts:558-603`** — the `!job` branch now also carries "2+ candidates":
- **settled re-entry (`input.captureId`)** — `input.decided` is set on this path, so `mayGuess` is
  true and `job` is non-null whenever candidates exist. Unreachable by the new case (U1); leave
  entirely unchanged, including the zero-candidate `[...priorJobs].reverse().find(c => c.status !==
  'cancelled')` that `recordFieldNote.test.ts:1990/2017/2042` pin.
- **closes-itself** — unchanged (D6). Still `priorJobs[priorJobs.length - 1] ?? null`, the most
  recent job of ANY status.
- **otherwise** — `observeInbound(null)` unchanged for the zero-candidate case.
- **NEW, ahead of the three arms:** when `!mayGuess && candidates.length > 1`, do not fall through.
  Raise `observeInbound(null, candidates)` **only if** `extracted.visitCommitted === true` (D8), then
  write the customer link. **Ask first, link second** (U2) — the ordering rule at
  `recordFieldNote.ts:648-666`, pinned by `recordFieldNote.test.ts:1341-1380`.

**`src/writePath/recordFieldNote.ts:458-511`** — `observeInbound` takes a second parameter
`candidates: Job[] = []` and adds to `context` when non-empty:
```ts
candidates: candidates.map((c) => ({ id: c.id, title: c.title, status: c.status })),
```

**`src/teamLead/planner.ts:1520-1524`** — a third branch, so "can't tell" never reads as "none" (D4):
```ts
jobId ? `  on file: open job …`
: candidates?.length ? `  on file: ${candidates.length} open jobs — which one this is about is not known: …`
: '  on file: no open job for this customer — a job would have to be opened'
```

**`src/writePath/identityMatch.ts:123-131`** — amend the comment: its "we fall back to the door's own
job choice" is now true only on the `mayGuess` path (U6).

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass
- [x] **the specimen**: outbound_email, known customer, 2 non-terminal jobs, no `match.jobId`,
      `visitCommitted: true` → `inbound_commitment` with NO `jobId` and a 2-entry `candidates` list,
      a customer link, no `job_captures` row
- [x] 2 candidates, `visitCommitted` absent, `touchesOperations` true → customer link, **no
      observation** (D8)
- [x] exactly 1 candidate → job link, unchanged
- [x] `match.jobId` supplied + 3 other candidates → that job wins
- [x] **technician_note, 2 candidates → newest non-terminal, no new job minted** (D1)
- [x] **`decided.openJob` + 2 candidates → reuses, does not mint** (D2)
- [x] **`decided.bookVisit: true` + 2 candidates → a visit IS booked** (D3)
- [x] `touchesOperations: false`, zero candidates, one paid job → unchanged
      (`recordFieldNote.test.ts:1480`) (D6)
- [x] planner renders the candidates line for a candidates-carrying observation (D4)

### Live verification (agent-executable)
- Prerequisites: local stack; `mcp__supabase-test__execute_sql` (read-only) for the baseline.
- [x] Baseline confirmed on the pilot 2026-09-12: `observations` for capture `5440d4b4` = **0**
      (the ask was swallowed), the kitchen-tap job `1959bd8f` holds **2** correspondence entries
      (the promise filed on unrelated work), and visits on Wed 16 Sep = **0** (still unbooked).
      `customer_captures` does not exist there yet, which also confirms the migration has not been
      hand-applied — see the Deploy note.
- [x] The replay is CODIFIED rather than run once: test (15) in `recordFieldNote.test.ts` seeds two
      non-terminal jobs and a confirmed visit on one, and asserts the observation, its `candidates`,
      the customer link and the absent `job_captures` row. Mutation-tested — restoring the old
      always-guess behaviour fails it with `expected <job id> to be undefined`. A codified check
      runs on every suite; the one-off would have run once.

### Manual verification
- [x] Judgment: until the follow-on plan lands, ambiguous non-commitment mail is reachable from the
      customer but not from a job. **ANSWERED (user, 2026-09-12): land Phase 2 now, the chooser
      follows shortly.** The interval is accepted.
- [x] Judgment (found in review, 2026-09-12): a two-candidate customer's "all done, thanks" email
      used to move the guessed job to `completed` via `NOTE_SIGNAL_TRANSITIONS`. It no longer moves
      anything, and asks nothing. **ANSWERED (user, 2026-09-12): leave it to the planner.** Nothing
      is added here — and note the gap that answer exposes: ambiguity alone raises no observation,
      so today the planner is not TOLD; the capture is reachable from the customer's context and
      nothing more. Closing that is its own task, parked as
      `20260912-an-l2-status-flip-reports-to-the-planner`, under the doctrine the same conversation
      produced: extractors are the planner's minions, and every L2 TOUCH — create, status flip,
      ambiguity — reports, through ONE general report rather than a job-completion-specific ask.

---
*Pause after this phase — its manual list is non-empty.*

## Deploy note

Deploys run NO migrations. Phase 1's migration must reach the pilot by hand BEFORE the Phase 2
code — "migration first, then the services", the job_captures header's idiom. Blast radius if that
order slips: `captureHasLinkedL2` has no missing-relation tolerance (contrast
`src/teamLead/planner.ts:4053-4068`) and sits on the hottest inbound path, so every Composio delivery
would 500 and retry forever. Never `db push` — ledger versions do not match filenames.
