---
date: 2026-09-11
branch: work/a-new-promise-to-a-known-customer-is-fil
commit: 697aaba
topic: The inbound/outbound door (recordFieldNote + identityMatch + extract) as it exists today, and what each candidate re-invention would touch
supersedes: nothing
---

## Summary

The **door** is the single function every captured message passes through on its way from the
verbatim record into the firm's structured record: `recordFieldNote()` in
`src/writePath/recordFieldNote.ts`. "Capture" means one message — a technician's dictated note, an
inbound customer email, a phone-call transcript, a web-form submission, or a copy of an email the
firm itself sent. The door does five things in a fixed order: it appends the verbatim text to **L1**
(`raw_captures`, append-only, never edited or deleted); it calls a language model once to read
candidate fields out of the text (the **extractor**); it resolves **identity** with deterministic
code (`identityMatch.ts`); it decides which job and which visit the capture belongs to; and it
decides whether to raise an **observation** — a row in the planner's own record that is the only
thing which wakes the planner about a capture.

The door was written on 2026-06-20 for one caller: a technician dictating a note from the field
(commit `7e61212`, "Add Stage 2 technician write-path"). That original version already contained the
job-resolution heuristic still in the file today — when nothing names a job, file on *the customer's
most recently created job that is not in a terminal state*. Four more callers have since been routed
through the same function (inbound email, phone calls, web forms, and the firm's own outbound email),
each adding its own guards around that heuristic without replacing it. The result is a function of
916 lines in which the decisions of five different callers interleave, and in which the same
heuristic is read as "the technician is standing at the work" by one caller and as a fallback guess
by the other four.

The live specimen that prompted this research (task `20260911-a-new-promise-to-a-known-customer-is-fil`)
is what that inheritance costs: the firm emailed a known customer a dated promise to attend; the
door recognised the customer, found no job named for the message, guessed her nearest open job about
different work, attached the capture to that job's already-booked trip, and — because a commitment
landing on a live trip is treated as correspondence about that trip — raised nothing. No observation
means no ping, and no ping means the planner is never told.

## Entry Points

| Entry | File:line | What arrives |
|---|---|---|
| Inbound + outbound email webhook | `src/inbound/webhook.ts:441` | Composio Gmail deliveries, both received and sent mail; assembles thread context first |
| Phone-call worker | `src/calls/worker.ts:127` | Call transcripts, channel `phone_call`, with caller-ID fallback |
| MCP staged-confirm (technician/manager) | `src/mcp/server.ts:2438` | Technician notes and `record_caller` re-entries, identity pre-resolved |
| Identity matcher, called directly | `src/mcp/server.ts:2933`, `src/mcp/server.ts:3103` | Preview/stage paths that resolve identity before showing a confirmation |

The planner's own wake path begins separately, at `src/calls/observationPing.ts:38`
(`drainOneObservationPing`), which polls for unpinged observations every 10 seconds.

## Key Files

- **`src/writePath/recordFieldNote.ts`** (916 lines) — the door. Exports `recordFieldNote`,
  `correspondenceOf`, `NOTE_SIGNAL_TRANSITIONS`. Contains all job/visit/ask decisions.
- **`src/writePath/identityMatch.ts`** (274 lines) — exports `matchIdentity`. Deterministic
  customer resolution by phone → email → thread → address, then a same-day schedule consultation.
  `withThreadJob` (line 132) is the only path that names a **job**.
- **`src/writePath/extract.ts`** (235 lines) — exports `defaultExtractor`, `EXTRACTION_SYSTEM`,
  `EXTRACTION_TOOL`, `renderExtractionUser`, `renderThreadContext`, type `ExtractedFields`. One
  forced-tool model call per capture, `maxTokens: 1024`.
- **`src/writePath/attachNote.ts`** (145 lines) — exports `resolveVisitForNote`, `noteLocalOf`.
  Decides which trip a capture reports.
- **`src/inbound/webhook.ts`** (523 lines) — email door; classify-before-L1 gate, thread-context
  assembly, and the outbound (`sent:`) path.
- **`src/calls/observationPing.ts`** (89 lines) — the 10-second loop that turns an observation into
  a focused planner pass.
- **`src/db/observations.ts`** — `createObservation` (line 46), `PINGED_KINDS` (line 256),
  `captureHasObservation` (line 264).
- **`src/db/rawCaptures.ts:168`** — `captureHasLinkedL2`, the redelivery short-circuit.

## Data Flows

### The door, end to end

```
   message (email / call / form / technician note / the firm's own sent mail)
        │
        ▼
 ┌─ webhook.ts ─────────────────────────────────────────────┐
 │  classify work-vs-personal  (BEFORE L1 — L1 has no delete)│
 │  assemble thread context (Composio, else our captures)    │
 └───────────────────────────┬───────────────────────────────┘
                             ▼
 ┌─ recordFieldNote ─────────────────────────────────────────────────────────┐
 │ (1) L1 append / dedup / orphan-heal        rawCaptures                    │
 │      └─ structure:false  ──► STOP, capture only                           │
 │ (2) extractor — ONE model call             extract.ts                     │
 │ (3) matchIdentity — deterministic          identityMatch.ts               │
 │      phone → email → thread → address, then same-day schedule             │
 │      whichever key won, withThreadJob() asks the thread for the JOB       │
 │ (4) NOT matched? ──► observation 'inbound_unmatched' ──► RETURN  (line 348)│
 │      · inbound channels always                                            │
 │      · outbound ONLY when visitCommitted === true                         │
 │ (5) matched: resolve the JOB                                              │
 │      match.jobId ?? most recent NON-TERMINAL job ?? (technician: create)  │
 │ (6) resolveVisitForNote — which trip?       attachNote.ts                 │
 │      same firm-local day ?? the job's ONE live visit ?? (technician: new) │
 │ (7) the ask  (line 705)                                                   │
 │      !technician && decidedBook===undefined && visitCommitted && !visit   │
 │ (8) correspondence append → links → status signal                         │
 └───────────────────────────┬───────────────────────────────────────────────┘
                             ▼
                   observations row?
                   ├── yes ──► observationPing (10s) ──► focused planner pass
                   └── no  ──► nothing wakes the planner, ever
```

### The specimen, step by step

1. `webhook.ts` ingests the firm's own sent mail as channel `outbound_email`. `fallbackEmail` is set
   to the sole **recipient** rather than the sender (`webhook.ts:459`), because on sent mail the
   sender is the firm.
2. The extractor is told `fromTheFirm: true` (`recordFieldNote.ts:296`) and returns
   `visitCommitted: true`, `followUp: "Send technician Wednesday 16 September…"`, and the window as a
   free-text L3 fact in `attributes`.
3. `matchIdentity` matches the customer on the **email** key (`identityMatch.ts:163`) and calls
   `withThreadJob`, which finds the thread is new and returns no `jobId`.
4. `recordFieldNote.ts:547-550` runs the guess: `listJobsForCustomer` then the last non-terminal job.
5. `resolveVisitForNote` finds no visit on the note's own day and falls to rule (2) — the job's one
   live visit (`attachNote.ts:112`).
6. `recordFieldNote.ts:705-711`: `!visit` is false, so `asked` is `null`. The capture is filed, the
   links are written, and nothing is raised.

### What the planner can and cannot see

`PINGED_KINDS` is `['inbound_new_job', 'inbound_commitment', 'inbound_unmatched']`
(`src/db/observations.ts:256`). Only those three kinds are picked up by the ping loop. The planner's
tick reads observations and gaps; `grep correspondence src/teamLead/planner.ts` returns no hits, so a
capture written into a job's `correspondence` list with no observation is reachable only by an
explicit `spine_read` the planner has no reason to perform. The deterministic watchers
(`src/jobs/watchers.ts`) key on **visits** — the archetype being a confirmed visit whose end has
passed — so a promise that never became a visit has no row for them to watch.

## External Dependencies

- **Composio** — Gmail delivery of inbound and sent mail, and the thread fetch
  (`fetchThread`, `webhook.ts:416`). Redelivers on any non-2xx, which is why the door's
  dedup/orphan-heal logic exists.
- **The model provider** — `MODEL_PROVIDER` selects OpenAI-protocol (default) or Anthropic
  (`src/model/forcedTool.ts:166`). The extractor is one forced-tool call, `maxTokens: 1024`, billed
  per tenant through `CostContext`.
- **Supabase / PostgREST** — every read and write; `createObservation` relies on a unique-violation
  return to mean "already noticed".

## Constraints and Invariants

1. **L1 is append-only, and classification must precede the write.** `raw_captures` has no delete
   path (DB trigger plus CLAUDE.md rule), so the work-vs-personal gate runs in `webhook.ts` before
   the insert.
2. **An observation is the only thing that wakes the planner about a capture.** No observation, no
   ping, no pass. This is what makes the ask-suppression rules load-bearing rather than cosmetic.
3. **Observations are once-ever per (tenant, kind, subject_ref).** `uq_observations_subject_ever`;
   `createObservation` returns `null` on the unique violation and the FIRST row keeps the ask
   (`observations.ts:62`). The index would permit one `inbound_new_job` AND one `inbound_commitment`
   for a single capture; "one per capture" is enforced by `captureHasObservation` on the dedup path,
   not by the database (`recordFieldNote.ts:467-473`).
4. **An observation is also a processed-marker.** `captureHasLinkedL2` reads `visit_notes`,
   `job_captures` and `observations` (`rawCaptures.ts:180-188`). A redelivery of a capture that
   raised an ask is a real duplicate and does not pay for the extractor twice.
5. **The write order in the tail is deliberate**, worst-loss-first: the ask → the correspondence →
   the link → the status signal (`recordFieldNote.ts:662-666`). Writing a link before the ask would
   let a mid-way failure bury the promise forever behind the duplicate short-circuit.
6. **Identity matching is deterministic by doctrine** — "never a model guess"
   (`docs/onboarding.md:129`); the model only proposes fields. Every key is unique-or-refuse.
7. **Only a technician channel may create work silently** — `mayCreate` is false for every inbound
   channel (`attachNote.ts:115`), and job creation without an ask requires `decided.openJob`, which
   only `record_caller` supplies (`recordFieldNote.ts:558`).
8. **`visitCommitted` carries no date.** It is a boolean; the promised window survives only as prose
   in `followUp` and as a free-form L3 key in `attributes` (`extract.ts:27`, `extract.ts:51`).
9. **`touchesOperations === false` is the only value that skips**; absent and null keep asking
   (`extract.ts:43-47`). `visitCommitted` outranks it.
10. **Terminal-job filing is inert by construction** — no status transition exists for terminal
    statuses, no visit can be minted, and the correspondence append is idempotent per capture id
    (`recordFieldNote.ts:519-525`).
11. **The rung 10d doctrine is recorded and unbuilt.** `docs/engineering-memory.md:3698`: the door
    gives up its six L2 writes, five move to the planner, `labor_hours` is deleted, and the door is
    reduced to "L1 + identity + links". Ordered after rung 10b.2, which is built but not deployed
    (`docs/engineering-memory.md:5128`).

## Decision Points

### 1. Where the "which job" judgment lives

Today: deterministic code, in the door, with a fallback that always produces an answer.

- **Keep it in the door, make it refuse** — the guess becomes conditional (for example, refusing when
  the matcher named no job and the capture is a commitment). Touches `recordFieldNote.ts:541-603`
  only; no extractor change, no new model call. The door still decides, but decides to ask.
- **Move it to the extractor as inference** — the model proposes the job. This crosses the line
  `docs/onboarding.md:129` draws ("never a model guess") for the job dimension; the customer
  dimension would still need deterministic keys or the model would need the same L2 read.
- **Move it to the planner** — the door raises and stops. This is rung 10d's shape. Requires the
  planner to gain the verbs the door gives up; `docs/engineering-memory.md:3715` records that 10d's
  door side and planner side must not be split, because only one call site can complete a visit today.

### 2. Whether the extractor reads L2

Today it reads text only: raw message plus up to 8 earlier thread messages, each capped at 600
characters (`extract.ts:75-76`).

- **No L2** (today) — one model call per capture; the call is stateless and testable with a stub
  (`deps.extract`), which is how all 2113 lines of `recordFieldNote.test.ts` run without a model.
- **L2 handed in** — the door reads candidate jobs/visits and passes them into the prompt. Keeps one
  model call; makes the extractor's output depend on database state, so every test stub must now
  model that state.
- **L2 fetched by the model** — the extractor gains tools and becomes an agent loop. Multiplies the
  per-capture latency inside a connector's delivery timeout; `observationPing.ts:20` records that
  running a model pass inside the webhook's request was already considered and rejected for the
  focused planner pass, on the grounds that a connector retries on every timeout.

### 3. What ends the ask-suppression rule

Today: `!visit` (`recordFieldNote.ts:709`) — a commitment that landed on a live trip asks nothing.

- **Direction-aware** — outbound commitments stop being judged by the inbound rule. One condition;
  no new data. Asks on every outbound commitment including confirmations of existing bookings.
- **Date-aware** — compare the promised window against the visit. Requires a structured date field in
  `EXTRACTION_TOOL` and a prompt line, plus whatever date-normalisation rules apply
  (`resolve_date` is documented as a convention, not a crutch).
- **Job-aware** — require that the commitment be about the job it landed on. No field exists that
  expresses this today; the nearest available signal is `followUp` prose versus `job.title`.

### 4. Whether a second observation kind is needed

`inbound_commitment` is reused for outbound promises on the matched path, while the unmatched path
states `outbound: true` in context and reuses `inbound_unmatched` (`recordFieldNote.ts:370-376`).
A new kind would need adding to `PINGED_KINDS`, to the planner's gap block, to the heartbeat probe
and to the MCP filters — `observations.ts:253-255` records that `inbound_unmatched` was added exactly
that way and that every helper followed with no edit of its own.

## Open Questions

1. **What does one extractor call cost and how long does it take?** The call is billed per tenant
   through `CostContext` and lands in `cost_events`, but no figure is recorded in the repo docs. The
   only populated instance is the pilot database, and repo rule forbids sizing from its accumulated
   state — a driven measurement would be needed.
2. **How often does the guess actually fire, and how often is it wrong?** Deriving this needs either
   a driven test or instrumentation; the guess currently leaves no trace distinguishing "the matcher
   named this job" from "the door guessed it". Nothing in the record says which of a job's
   `job_captures` arrived by guess.
3. **Is the `attributes.appointment_window` key stable?** It appeared in the specimen, but
   `attributes` is documented as free-form L3 with no declared property types
   (`extract.ts:180-184`), so the key name is the model's choice on that call, not a contract.
4. **Does the planner have a verb that could act on a raised-but-unfiled commitment?** `record_caller`
   supplies `decided.openJob` and `decided.bookVisit`, but whether those cover a promise whose job
   does not exist yet would need checking against the MCP dispatch's guards.
5. **What happens to `withThreadJob` under any shape that moves job resolution?** It is the one place
   that resolves a job non-heuristically, and rung 10b.3 added it specifically to stop the guess
   running when the thread knew the answer.
