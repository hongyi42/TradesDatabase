---
date: 2026-08-06
branch: feat/phone-call-capture
commit: 7f59a54
topic: Adding a "is this a job?" classifier to the inbound phone-call worker, and how an unscheduled job/visit is represented in the code today
---

## Summary

The inbound **phone-call capture channel** turns a recorded customer call into rows in the
customer/job record ("the spine"). A background worker downloads the recording, transcribes it
to text (AssemblyAI speech-to-text), scrubs sensitive-auth data, then hands the transcript to the
shared write-path (`recordFieldNote`). Today that write-path, whenever it can match the caller to
an existing customer, **always** creates an L2 **job** (open) plus a **visit** record — there is
no filter deciding whether the call actually represents new work. This document maps that pipeline
exactly as it exists, identifies where a classifier ("is this a new service request?") would sit,
and clarifies a naming trap that governs the whole design: the word "visit" means two different
tables in this codebase — the L2 service-record `visits` table, and the dispatch-board
`assignments` table — and "unscheduled work" for the dispatcher is defined off the *jobs* table,
not either visit table.

**Decisions already taken in the design chat (2026-08-06), recorded here for the plan phase — not
recommendations of this read-only research:** (1) an unscheduled call-job lands as an **open job
with no assignment** (no new scheduling write); (2) the classifier counts only a **new service
request** as a job; (3) a non-job call **keeps its L1 transcript, creates no job**. See Decision
Points for the code-level forks each of these still leaves open.

## Entry Points

- **The call worker** — [src/calls/worker.ts:60](../../src/calls/worker.ts#L60)
  `processNextCall(deps)`: claims one `call_ingest` row and drives it end-to-end. This is the one
  function a classifier step would be inserted into.
  - transcript produced at [src/calls/worker.ts:78](../../src/calls/worker.ts#L78)
    (`deps.redact(await deps.transcribe(signedUrl))`).
  - write-path called at [src/calls/worker.ts:80](../../src/calls/worker.ts#L80)
    (`deps.recordFieldNote({ … channel: 'phone_call', technicianRef: 'phone-line', … })`).
- **The shared write-path** — [src/writePath/recordFieldNote.ts:78](../../src/writePath/recordFieldNote.ts#L78)
  `recordFieldNote(input, deps)`: L1 append → extract → identity-match → L2 job/visit.
- **The existing classifier precedent (email)** — [src/email/ingest.ts:75](../../src/email/ingest.ts#L75)
  `ingestEmail(...)` calls `classify` at [src/email/ingest.ts:87](../../src/email/ingest.ts#L87)
  and gates on `isWork` at [src/email/ingest.ts:92](../../src/email/ingest.ts#L92).
- **The dispatcher's "unscheduled work" read** —
  [src/db/assignments.ts:695](../../src/db/assignments.ts#L695)
  `listUnscheduledOpenJobsWithCustomer(tenantId)`.

## Key Files

- **[src/calls/worker.ts](../../src/calls/worker.ts)** — the async call worker. Exports
  `processNextCall(deps: WorkerDeps): Promise<'idle'|'ingested'|'error'>` and the `WorkerDeps`
  interface (all pipeline steps are injectable for testing: `claimNextPendingCall`, `download`,
  `sign`, `transcribe`, `redact`, `recordFieldNote`, `openUnlinkedCallReview`, …). `liveDeps`
  (line 45) wires the production implementations. No classifier dependency exists today.
- **[src/calls/transcribe.ts](../../src/calls/transcribe.ts)** — `assemblyAiTranscriber:
  Transcriber` (`transcribe(audioUrl) => Promise<string>`); returns a diarized transcript
  (`Speaker A: …\nSpeaker B: …`). Not modified by this feature.
- **[src/calls/redact.ts](../../src/calls/redact.ts)** — `redactSensitive(text) => string`
  (scrubs card/CVV/SSN only; per the E2E note it deliberately keeps names/issues/times). Runs
  BEFORE any write; a classifier would receive the already-redacted transcript.
- **[src/writePath/recordFieldNote.ts](../../src/writePath/recordFieldNote.ts)** — the
  channel-agnostic write-path. `recordFieldNote(input: RecordFieldNoteInput, deps?: { extract? }):
  Promise<RecordFieldNoteResult>`.
  - `RecordFieldNoteInput` (line 34): `tenantId`, `technicianRef`, `text`, `blobPath`, `channel`,
    `resolved?`, `externalId?`, `occurredAt?`, `sourceMeta?`, `fallbackPhone?`. **There is no flag
    to skip structuring** — every call that resolves an identity creates L2.
  - `RecordFieldNoteResult` (line 59): `status: 'matched'|'needs_confirmation'|
    'needs_disambiguation'|'duplicate'`, `captureId`, `customerId?`, `jobId?`, `visitId?`,
    `suggestion?`.
- **[src/email/classify.ts](../../src/email/classify.ts)** — the model classifier this feature
  mirrors. `defaultClassifier: WorkClassifier` (line 49) → `runForcedTool(CLASSIFY_TOOL, …)`.
  `WorkClassifier = (email, ctx?) => Promise<Classification>` where `Classification = { isWork:
  boolean; reason: string }`. `CLASSIFY_SYSTEM` (line 22) is the work-vs-personal prompt;
  `CLASSIFY_TOOL` (line 28) is the forced single-tool schema.
- **[src/email/ingest.ts](../../src/email/ingest.ts)** — the reference "classify-then-record"
  flow. `ingestEmail(tenantId, technicianRef, deps): Promise<{ ingested; skipped }>`. Classifies
  first, and on `isWork === false` records a **content-free audit receipt** via
  `upsertDroppedAudit` ([line 96](../../src/email/ingest.ts#L96)) — it does NOT store the email
  body (email's L1 is gated).
- **[src/writePath/extract.ts](../../src/writePath/extract.ts)** — `defaultExtractor: Extractor`
  (line 84), `Extractor = (rawText, ctx?) => Promise<ExtractedFields>`; the larger (`maxTokens:
  1024`) model call that proposes customer/job/visit fields. Runs INSIDE `recordFieldNote`
  ([recordFieldNote.ts:158](../../src/writePath/recordFieldNote.ts#L158)).
- **[src/model/forcedTool.ts](../../src/model/forcedTool.ts)** — the one transport for every
  forced-tool model call. `runForcedTool(tool: ForcedToolSpec, req: ForcedToolRequest, ctx?:
  CostContext): Promise<Record<string, unknown>>` (line 311). `activeProvider()` (line 48) →
  `'openai'` by default; default model `zai-org/GLM-5.2` via DeepInfra (line 45). Coerces
  quoted-string booleans/numbers by schema (`coerceBySchema`, line 92) and rejects truncated
  output (`finish_reason==='length'`, line 287). **Any new classifier goes through this exact
  entry point** — so it is GLM-5.2 by default, `MODEL_PROVIDER`-switchable, and cost-tracked at one
  site (`recordModelUsage`, line 325).
- **[src/db/jobs.ts](../../src/db/jobs.ts)** — `createJob(input): Promise<Job>` (line 47); default
  `status: 'open'`, `priority: 'routine'`. `ALLOWED_TRANSITIONS` (line 19) is the hardcoded job
  state machine (`open → in_progress|cancelled|declined`).
- **[src/db/visits.ts](../../src/db/visits.ts)** — `createVisit(input): Promise<Visit>` (line 18).
  This is the **L2 service-record** visit (`visits` table), NOT a dispatch-board row. `scheduled_at`
  is an optional column, left null on the phone path.
- **[src/db/assignments.ts](../../src/db/assignments.ts)** — the **dispatch-board** rows
  (`assignments` table), a different table from `visits`. Relevant readers:
  - `listUnscheduledOpenJobsWithCustomer(tenantId)` (line 695): open jobs with **no live
    (proposed/confirmed) assignment** — the board's "unscheduled jobs" queue. A call-created open
    job with no assignment appears here automatically.
  - `listUnassignedAssignmentsWithRefs(tenantId, fromISO)` (line 655): confirmed assignments with
    **no technician** (parked/unassigned visits) — the board's other loose-bucket half.
  - `createAssignment(input)` (line 54): enforces the PLACED (both times) XOR UNPLACED (both range
    dates) shape.
- **[src/schedule/booking.ts](../../src/schedule/booking.ts)** — the deterministic book/move/
  cancel verbs over `assignments`. `bookVisit` (line 480) is the ONLY current writer of
  `assignments` rows from an inbound-ish path, and it is manager/agent-driven, not called by the
  call worker.
- **[supabase/migrations/20260724130000_unplaced_visits.sql](../../supabase/migrations/20260724130000_unplaced_visits.sql)**
  — defines the "unplaced" assignment shape (`earliest_date`/`latest_date`, no times) and the
  `assignment_placed_or_windowed` check. Establishes that an unplaced assignment **requires a day
  or day-range**.
- **[docs/nemoclaw-tech-agent.md](../../docs/nemoclaw-tech-agent.md)** — the agent deployment
  runbook + tool catalog. §4 (line 92) lists the **14-tool technician surface**; the manager
  surface (line 112 onward) totals **39 tools**. The email classifier is documented in §6
  (line 246) and "Inbound email filtering" (line 524). No phone-classifier or call-derived-job
  behavior is documented here yet.

## Data Flows

### Current inbound-call flow (as built)

```
call_ingest row (queued by the recording webhook)
   │  processNextCall()                                  src/calls/worker.ts:60
   ▼
download recording → Supabase bucket                     worker.ts:73
sign object → short-TTL URL                              worker.ts:77
transcribe (AssemblyAI) → redact                         worker.ts:78  → transcript:string
   │
   ▼  recordFieldNote({ channel:'phone_call',
   │                    technicianRef:'phone-line',
   │                    text: transcript,
   │                    fallbackPhone: row.caller_phone, … })   worker.ts:80
   ▼
recordFieldNote()                                        recordFieldNote.ts:78
   ├─ (1) append L1 raw_capture (dedup/heal by externalId)      :117–146
   ├─ (2) extract(rawText, ctx)  ← GLM-5.2, 1024 tok            :158
   ├─     fallbackPhone → extracted.phone if none               :163–165
   ├─ (3) matchIdentity(...)                                     :175
   │        └─ if NOT matched and nothing pre-resolved:
   │             return { status:'needs_confirmation'|            :185–187
   │                      'needs_disambiguation', captureId }   (L1 kept, NO L2)
   ├─ (4) resolve/create customer                                :191–209
   ├─ (5) resolve job: matcher job → newest non-terminal →       :213–217
   │        else createJob({ status:'open' })                    :218–226   ← JOB
   ├─ (6) createVisit({ jobId, technicianName:'phone-line', … }) :229–236   ← VISIT (visits table)
   └─ (7) legal status transition if extracted.statusSignal      :240–242
   ▼
back in worker: if status is needs_confirmation/needs_disambiguation
   → openUnlinkedCallReview(...)                          worker.ts:99–106  (manager review item)
markCallIngested(...)                                     worker.ts:110
```

Key point: on the **matched** path, steps (5) and (6) run unconditionally — a job and a visit are
created for *every* matched call. On the **unmatched** path, `recordFieldNote` returns early at
`:185–187` (L1 kept, no L2) and the worker opens an `unlinked_call` review item.

### Where "unscheduled work" comes from today

The dispatcher's unscheduled-jobs queue is computed off the **jobs** table, not the visit tables:

```
listUnscheduledOpenJobsWithCustomer(tenantId)            src/db/assignments.ts:695
   = jobs WHERE status='open'
     AND no assignment row with status IN ('proposed','confirmed')
```

Because the call worker creates an open **job** but never creates an **assignment**, a
call-derived job already satisfies this predicate and appears in the queue with no extra code. The
`visits`-table row from step (6) is unrelated to this query.

### The email precedent (classify-then-record), for shape comparison

```
ingestEmail()                                            src/email/ingest.ts:75
  for each email:
    classify({subject,body,from}, {tenantId,technicianRef})  :87  → { isWork, reason }
    if !isWork:  upsertDroppedAudit(...)  (NO L1 body stored)  :96   ← email gates BEFORE L1
    else:        recordFieldNote({channel:'email', text, externalId, …})  :106
```

Note the divergence that matters for phone: email drops the body entirely when `isWork` is false
(append-only L1 must not retain personal mail). The phone worker, by contrast, currently lands
**every** call to L1 unconditionally (the transcript is the call log), and only the L2 structuring
is conditional on identity resolution.

### Model-call plumbing (shared by any new classifier)

```
runForcedTool(TOOL, {system,user,maxTokens,label}, ctx)  src/model/forcedTool.ts:311
   activeProvider()  → 'openai' (GLM-5.2 via DeepInfra) | 'anthropic'   :48
   callOpenAiCompatible/callAnthropic → forced tool_choice
   finish_reason==='length' → throw (no silent truncation)             :287
   recordModelUsage(ledgerVendor(), usage, ctx)  ← cost line           :325
   coerceBySchema(args, TOOL.inputSchema)  ← "true"/"false" → boolean  :326
```

## External Dependencies

- **AssemblyAI** — batch speech-to-text with speaker diarization (`ASSEMBLYAI_API_KEY`).
  [src/calls/transcribe.ts](../../src/calls/transcribe.ts). Unchanged by a classifier.
- **DeepInfra / GLM-5.2** — the default inference provider for every forced-tool call
  (`INFERENCE_API_KEY`, base `https://api.deepinfra.com/v1/openai`, model `zai-org/GLM-5.2`).
  A classifier would add one GLM call per processed call. `MODEL_PROVIDER=anthropic` +
  `ANTHROPIC_API_KEY` swaps the whole spine to Claude with no code change.
- **Anthropic SDK** (`@anthropic-ai/sdk`) — imported by `forcedTool.ts` for the rollback path only.
- **Supabase** — `raw_captures`, `customers`, `jobs`, `visits`, `assignments`, `call_ingest`,
  `review_items`, the cost ledger. All DB access via `src/db/`.
- **SignalWire** — upstream of the worker (recording + webhooks); not touched by the classifier.

## Constraints and Invariants

- **L1 (`raw_captures`) is append-only** — insert only, no update/delete (DB trigger enforced,
  CLAUDE.md). Any classification that could *drop* a capture must gate the insert BEFORE it. For
  phone this is only relevant if a design chose to stop storing non-job transcripts; today every
  call is stored regardless.
- **Phone is currently classify-free and stores every transcript.** The worker lands L1 for both
  matched and unmatched calls; only L2 (job/visit) is conditional on identity resolution
  (recordFieldNote.ts:185–187). This is the opposite of email, which gates L1.
- **"visit" is two tables.** `visits` (L2 service record, written by `recordFieldNote` →
  `createVisit`) is distinct from `assignments` (dispatch board, written by `bookVisit`). The
  scheduler, freeze, board, and book/move/cancel verbs all operate on `assignments`; the call
  worker writes only `visits`. They are not linked by a foreign key in the call path.
- **"Unscheduled work" is a jobs-table predicate.** `listUnscheduledOpenJobsWithCustomer` =
  open jobs with no live assignment. An open job with no assignment IS "unscheduled" to the board;
  no assignment row is required for a job to appear as unscheduled.
- **An unplaced *assignment* requires a day or day-range** (`earliest_date`/`latest_date`, the
  `assignment_placed_or_windowed` check; unplaced_visits migration). It cannot represent "work with
  no date at all" — that state is only representable as an open job with no assignment.
- **`recordFieldNote` has no structure-skip switch.** Its only injectable dep is `extract`
  (recordFieldNote.ts:80). Every resolved-identity call creates job+visit. Producing "L1 only, no
  L2" from a matched call is not expressible through the current interface.
- **`recordFieldNote` reuses the newest non-terminal job** (recordFieldNote.ts:213–217) before
  creating a new one. So a second call from the same customer attaches a visit to the existing open
  job rather than minting a duplicate — relevant to how "one call = one job" behaves.
- **Every forced-tool call is billed** at `recordModelUsage` (forcedTool.ts:325). A per-call
  classifier is a real cost line on *every* inbound call, matched or not — the same "runs on
  everything it then drops" property the email classifier comment calls out
  (classify.ts:16–19).
- **The phone source ref is the sentinel `'phone-line'`** (worker.ts:81), not a roster person;
  identity comes from caller-ID via `fallbackPhone`.
- **GLM emits quoted booleans.** A boolean classifier field ("true"/"false") is only safe because
  `coerceBySchema` (forcedTool.ts:92) converts it by the tool schema — the classifier's schema must
  declare the field `boolean` for the gate to read a real boolean (same hazard called out in
  email `classify.ts:44–48`).

## Decision Points

Factual forks the current code creates for this work. No recommendation is made here; the chat-time
selections are noted only as recorded state.

1. **Where the classifier gate lives.**
   - *In the worker* (`worker.ts`, mirroring `ingestEmail`): the worker calls a new `classify`
     dep on the transcript, then decides whether to call `recordFieldNote`. Keeps `recordFieldNote`
     unchanged and channel-agnostic; the phone-specific policy stays in the phone module. Requires
     the worker to have a way to land L1-only for the non-job branch (see fork 2).
   - *Inside `recordFieldNote`*: add a gate/flag to the shared write-path. Touches a file shared by
     email, tech-notes, and the MCP staging path; changes a channel-agnostic component to carry a
     phone-shaped concern.

2. **How a non-job call keeps L1 without creating L2.** Today `recordFieldNote` always structures
   on a matched identity, and the worker's only L1 writer is `recordFieldNote`.
   - *Add `structure?: boolean` (default true) to `RecordFieldNoteInput`*: when false, append L1
     (with the existing dedup/heal) and return before extract/match/L2 — likely a new result
     `status` (e.g. `'captured'`). Keeps L1 dedup/heal in one place; changes a shared interface and
     its result union.
   - *Worker lands L1 directly* via `appendRawCapture` on the non-job branch, calling
     `recordFieldNote` only for jobs. No shared-interface change; duplicates the dedup/heal logic
     (getRawCaptureByExternalId + retraction/heal handling) that `recordFieldNote.ts:103–146`
     currently owns.
   - *Recorded selection:* keep L1, no job on the non-job branch. Which of the two mechanisms is
     used is unresolved.

3. **What "unscheduled job/visit" is written as.** (Recorded selection: open job, no assignment.)
   - *Open job, no assignment*: rely on `listUnscheduledOpenJobsWithCustomer` — the job appears in
     the board's unscheduled queue with no new scheduling write. This is the existing matched-call
     behavior (minus the classifier).
   - *Explicit unplaced assignment*: additionally call `createAssignment`/`bookVisit` with a
     day-range. Requires a date the transcript may not contain; surfaces the item in the parked-
     visits tray instead of (or in addition to) the unscheduled-jobs queue.

4. **Classifier semantics / output shape.** (Recorded selection: "new service request only".)
   - *Binary* `{ isJob: boolean; reason: string }` (email's `Classification` shape) is the minimal
     mirror.
   - *Richer* `{ isJob, reason, … }` adding fields the job shell could seed (e.g. a short title,
     urgency/priority) — note `createJob` already accepts `title`, `priority`, `jobType`
     (jobs.ts:29). Any numeric/boolean field must be schema-declared for `coerceBySchema`.
   - The distinction "new request" vs "follow-up to an existing job" interacts with
     `recordFieldNote`'s newest-non-terminal-job reuse (recordFieldNote.ts:213–217): a follow-up
     from a known customer would attach to the existing open job rather than create a new one.

5. **Ordering of classify vs extract.** Both are GLM calls. The extractor (1024 tok) runs inside
   `recordFieldNote`; a classifier (small) can run before it. If the classifier gates job creation
   in the worker, the extractor call is only incurred on job calls; if the gate is inside
   `recordFieldNote` after extract, both calls run on every call. This is a cost/ordering fork, not
   a behavioral one.

6. **Agent-documentation surface.** No MCP tool is added by the pipeline approach (the job is
   created by the worker, not by an agent tool call), so the 14-tool / 39-tool catalog in
   `docs/nemoclaw-tech-agent.md` (§4, and the manager list from line 112) is unchanged by fork 3's
   recorded selection. The changed "agent instructions" artifact is the new classifier **system
   prompt** (a code constant, like `CLASSIFY_SYSTEM`). A separate optional surface is the manager
   sandbox `AGENTS.md` behavior blocks (in `Box_Setup_Stuff`, re-appended by `bootstrap-box.sh`):
   whether to add a note that inbound calls now auto-populate the unscheduled-jobs bucket is a
   documentation choice, not a code dependency.

## Open Questions

- **Merge/deploy state.** The working tree is on `feat/phone-call-capture` (HEAD `7f59a54`), and
  `git log` shows no merge-to-main commit; the project memory records the feature as "merged to
  main + redeployed on Render" on 2026-08-06. Confirm the actual deployed branch/commit before
  planning where the change lands, since the phone pipeline is described as live.
- **Non-job audit trail.** Email records a content-free `upsertDroppedAudit` receipt for dropped
  mail (ingest.ts:96). For phone, the transcript is retained in L1 regardless, so a separate
  "classified not-a-job" marker is not required for recoverability — but whether the not-a-job
  verdict/reason should be stamped somewhere (e.g. capture metadata) for later audit is unresolved
  and can only be decided against product needs, not from the code.
- **Follow-up vs new-request behavior** (fork 4) depends on `matchIdentity` + the newest-non-
  terminal-job reuse; the exact desired behavior for a repeat caller about an existing job is not
  determinable from the code alone.
- **Classifier precision** on real diarized call transcripts (which include both caller and
  forwarded-human speech) is untested; email's classifier operates on subject+body, a different
  input shape. Would need a live spot-check the way the email classifier is verified.
- **Low-confidence handling.** The chat selected "no review flag" for non-job calls, but the code
  already has an `unlinked_call` review path (`openUnlinkedCallReview`, worker.ts:99); whether a
  future "maybe a job" verdict should reuse that surface is an open product question, not a code
  fact.
