---
date: 2026-09-06
branch: main
commit: 5fb64d3
topic: Rung 10 — inbound commits a visit. How a call or an email reaches the spine today, where the extractor runs, the exact rule that decides create / attach / link-nothing, what a "committed" visit is after 9b/9c, and every gate between L1 and L2 that rung 10 has to pass through.
supersedes: nothing
---

**`supersedes:` is not optional bookkeeping.** This document overturns no prior decision. It
records the state of the inbound write path after rungs 9a–9c, and the rulings that shape rung
10, so the plan can be written against the code rather than against memory.

## Summary

The spine takes input from many channels but writes through ONE function,
`recordFieldNote` (`src/writePath/recordFieldNote.ts:110`). Two inbound channels are live today:
**phone calls** (SignalWire → a durable queue → `Calls-worker`) and **email** (a Composio Gmail
trigger → an HMAC-verified webhook). Both land the words verbatim in L1 (`raw_captures`), run the
AI extractor, match the customer deterministically, and build **customer + job** in L2. What
neither may do today is create a **visit** — the row the schedule is made of since rung 9b. That
gate is one boolean, `mayCreate` (`src/writePath/attachNote.ts:52`), which `recordFieldNote` sets
to "is this a technician channel" (`:297-298`, `:312`); for a technician it creates a visit that
already *happened* (a walk-in), and for correspondence it creates nothing. Rung 10 is the ruling
that inbound correspondence — a call **and** an email — may create a **committed** visit: status
`confirmed`, no day, no time, nobody on it — the same row a manager makes with an untimed
`book_visit`. The plain-language crux: a call that says "we'll send someone out" is a promise the
schedule cannot see today; after rung 10 it becomes a row the manager places later. The parts of
the code that would carry that judgment do not yet have a place to put it: the extractor's output
has no "did the firm commit" field, and the call classifier's `new_job` means "the caller wants
work", not "we agreed to come".

## Entry Points

| path | where it begins | what it does |
|---|---|---|
| phone, leg 1 | `src/mcp/httpServer.ts:708` → `handleVoiceWebhook` `src/inbound/phoneWebhook.ts:48-77` | validates the SignalWire signature, resolves the tenant from the dialed number (`resolveTenantByNumber`, `src/db/callNumbers.ts:10`), answers with cXML that announces consent, forwards, and records. No STT, no write on the request thread. |
| phone, leg 2 | `src/mcp/httpServer.ts:712` → `handleRecordingWebhook` `src/inbound/phoneWebhook.ts:82-123` | validates, keeps only `status === 'completed'` (`:104`), enqueues into `call_ingest` (`enqueueCall`, `src/db/callIngest.ts:23-53`; dedup key = RecordingSid) and fast-acks. |
| phone, the worker | `npm run calls:worker` → `src/calls/runWorker.ts:14-27` → `processNextCall` `src/calls/worker.ts:80-231` | the Render service `Calls-worker` (auto-deploys on the fork). One row per iteration, `SKIP LOCKED` (`claimNextPendingCall`, `callIngest.ts:55`); idle backoff 5 s (`runWorker.ts:7`). |
| email, live | `src/mcp/httpServer.ts:716` → `handleInboundWebhook` `src/inbound/webhook.ts:124-304` | the Composio `GMAIL_NEW_GMAIL_MESSAGE` trigger. HMAC-verify → normalize → roster/tenant → classify-before-L1 → `recordFieldNote`. |
| email, dead | `ingestEmail` `src/email/ingest.ts:75-120` | the Gmail OAuth pull. **Zero callers anywhere in the repo** (no script, no route, no cron); the file itself says "Untested-live pending Gmail provisioning" (`:31-32`). |
| web form | none | `web_form` is a `capture_channel` value (`supabase/migrations/20260620005307_context_spine.sql:16-22`) and the eval world seeds one capture with `technicianRef: 'connector:web'` (`src/eval/worldSpec.ts:626-632`). No route, normalizer or writer exists. |
| the shared door | `recordFieldNote` `src/writePath/recordFieldNote.ts:110-405` | every channel above, plus the technician tool `record_field_note` (`src/mcp/server.ts:2188`). |

## Key Files

- **`src/writePath/recordFieldNote.ts`** — the channel-agnostic write path. Exports
  `RecordFieldNoteInput` (`:42-71`; the inbound-specific fields are `externalId`,
  `occurredAt`, `sourceMeta`, `fallbackPhone` `:64`, and `structure` `:70`),
  `RecordFieldNoteResult` (`:73-82`; `status` ∈ matched | needs_confirmation |
  needs_disambiguation | duplicate | captured), `NOTE_SIGNAL_TRANSITIONS` (`:99-105`),
  `recordFieldNote` (`:110`).
- **`src/writePath/attachNote.ts`** — which trip a note belongs to (rung 9b phase 3). Exports
  `resolveVisitForNote` (`:76`), `noteLocalOf` (`:70`). The three-step rule is `:9-23`; the
  channel split is `:25-31`, and `:30-31` names rung 10 outright: *"rung 10 is where inbound
  (call AND email) gets its own creation path: a COMMITTED visit, never a completed one."*
- **`src/writePath/extract.ts`** — the extractor. `ExtractedFields` (`:8-24`), the system prompt
  (`:32-38`, written for *"a trades technician field note"*), the forced tool (`:41-71`),
  `defaultExtractor` (`:84-92`, `maxTokens: 1024`).
- **`src/writePath/identityMatch.ts`** — the hardcoded identity decision. Resolution order
  `:12-15`; unique phone/address `:59-71`; the schedule consultation `:73-116` (needs a roster
  row for `technicianRef`, `:88`); resume `:120-127`; single-scheduled-visit proposal `:130-135`;
  ask `:138-141`.
- **`src/calls/worker.ts`** — the phone pipeline. `WorkerDeps` (`:28-60`), `processNextCall`
  (`:80-231`): download → transcribe → redact → classify (`:111-121`) → `structure` decision
  (`:125`) → `recordFieldNote` (`:127-146`) → review routing (`:155-199`) → `markCallIngested`
  (`:204-208`).
- **`src/calls/classifyCall.ts`** — the intent router. `CallIntent` (`:12-18`): `new_job`,
  `reschedule`, `cancel`, `question`, `complaint`, `other`. Multi-label (`:4-10`). System prompt
  `:50-69`; 3 retries with full jitter `:89-123`, `maxTokens: 256`.
- **`src/inbound/webhook.ts`** — the Composio door. Status vocabulary and HTTP mapping
  (`:85-100`), `handleInboundWebhook` (`:124`), composite `user_id` split (`:169-175`),
  roster/tenant (`:199-214`), classify-before-L1 (`:219-255`), the `recordFieldNote` call
  (`:257-282`) incl. the `pending_verification` stamp (`:277-280`), unknown-ref flag (`:288-298`).
- **`src/inbound/normalize.ts`** — `InboundEnvelope` (`:7-21`, `requiresWorkClassifier` `:20`),
  the normalizer registry (`:27-39`). **`src/inbound/gmail.ts`** — the only registered normalizer
  (`:18-40`).
- **`src/email/classify.ts`** — the work/personal gate (`isWork`, `:10-13`; prompt `:22-26`
  "When unsure, prefer isWork=false"; `maxTokens: 256`). **`src/email/format.ts`** — the L1
  storage form `Subject:/From:/body` (`:12-14`).
- **`src/db/visits.ts`** — `VISIT_TRANSITIONS` (`:222-227`), `CreateVisitInput` (`:229-256`),
  `createVisit` (`:257-319`; **status defaults to `'proposed'`** `:275`), `stageOf`
  (`:634-638`: `committed` = confirmed with `starts_at === null`), `listVisitsForJob` (`:861`),
  `listUnplaced` (`:1083`), `listUntimedVisitsForJob` (`:1102`),
  `listUnassignedVisitsWithRefs` (`:1153`; the tray's read, whose filter is
  `nobody on it || starts_at === null`), `listOverdueConfirmedVisits` (`:934`),
  `listUnscheduledOpenJobsWithCustomer` (`:1221-1240`; the anti-join at `:1233`).
- **`src/db/rawCaptures.ts`** — `appendRawCapture` (`:34`; accepts `visitId` `:26`, never passed
  on the inbound path), `getRawCaptureByExternalId` (`:96`), `captureHasLinkedL2` (`:137-155`:
  `source_capture_id` on visits/jobs/customers, then `visit_notes`).
- **`src/db/callIngest.ts`** — the queue: `EnqueueCallInput` (`:7-16`), `enqueueCall`
  (`:23-53`), `claimNextPendingCall` (`:55`), `markCallIngested` (`:73`), `markCallError` (`:96`).
- **`src/db/reviewItems.ts`** — `ReviewKind` (`:10-52`; `unlinked_call` `:35`, `call_action`
  `:42`), `flagUnknownRefCapture` (`:110`), `openUnlinkedCallReview` (`:177-190`),
  `openCallActionReview` (`:200-220`).
- **`src/schedule/booking.ts`** — the manager's untimed booking arm (`:350-385`), the twin guard
  (`:363-379`), the "all three or none" rule (`:392-395`).
- **`src/schedule/boardRead.ts`** — `readUnscheduledJobs` (`:293-302`), `readLooseBucket`
  (`:305+`).
- **`src/mcp/server.ts`** — `record_field_note` schema (`:271-316`; `channel` enum is
  `TECH_CHANNELS` `:295`), the planner's untimed-row prose (`:1211-1213`), `resolve_review`
  (`:1157-1172`, handler `:6605`), `get_team_schedule`'s recall halves (`:4123`, `:4176-4178`,
  `:4213-4216`).
- **`src/jobs/nudgeKinds.ts`** — the detector registry: `OVERDUE_VISIT_GAP_SPEC` (`:110`),
  `JOB_COST_GAP_SPEC` (`:137`), `NUDGE_KIND_SPECS` (`:156`). Nothing reads an untimed visit.
- **`src/model/forcedTool.ts`** — the one transport for classify/extract (`:16-17`: provider =
  `MODEL_PROVIDER`; `DEFAULT_REASONING_EFFORT` `:33`).
- Tests that pin today's behavior: `src/writePath/recordFieldNote.test.ts:369-378` (inbound
  email with no visit creates NOTHING), `:380-411` (the stale-forward-signal gap, asserted AS
  the gap), `:414-432` (a linked redelivery is a duplicate), `:913-932` (a phone call is not a
  trip); `src/calls/worker.test.ts:195` (`new_job` structures L2), `:207`, `:227`, `:238`.

## Data Flows

### 1. A phone call, end to end

```
caller ──► SignalWire ──POST──► /inbound/phone/voice        (httpServer.ts:708)
                                 resolveTenantByNumber → cXML: consent · forward · record
              recording done ──► /inbound/phone/recording    (httpServer.ts:712)
                                 enqueueCall → call_ingest(status='pending')   dedup: RecordingSid
                                                    │
                      Calls-worker (runWorker.ts) ── claim_next_call (SKIP LOCKED)
                                                    ▼
   download → bucket ── sign ── AssemblyAI transcribe ── redactSensitive
                                                    ▼
                          classifyCall(transcript) → intents[] (multi-label)      worker.ts:111-121
                                                    ▼
      structure = !unclassified && intents.includes('new_job')                     worker.ts:125
                                                    ▼
      recordFieldNote({ channel:'phone_call', technicianRef:'phone-line',
                        text, fallbackPhone: caller_phone, externalId: RecordingSid,
                        structure, sourceMeta:{ callIntents, reason, … } })        worker.ts:127-146
                                                    ▼
        (a) new_job & unmatched  → openUnlinkedCallReview + notifyManagers          worker.ts:155-170
        (b) reschedule|cancel|question|complaint|unclassified → openCallActionReview
                                                   + notifyManagers (HIGH if complaint/unclassified)  :178-199
        (c) 'other' only → L1 only                                                  :200
                                                    ▼
      markCallIngested(captureId, matchStatus, audioDeleteAfter)                    :204-208
```

Facts about this path that rung 10 inherits:

- `technicianRef` is the sentinel `'phone-line'` (`worker.ts:129`), which is not a roster row.
  Inside `recordFieldNote`, `getTechnician(tenantId, 'phone-line')` returns null (`:302`), so
  `technicianId` reaches `resolveVisitForNote` as null; and inside `matchIdentity` the schedule
  consultation is skipped entirely (`identityMatch.ts:88`) — a call can only match by **phone**
  (the caller-ID fallback, `recordFieldNote.ts:220-222`) or by an extracted **address**.
- `structure` is off for every call that does not carry `new_job` (`worker.ts:122-125`). L1 is
  always kept; L2 is built only for `new_job`. The router's verdict is stamped on the durable L1
  row (`sourceMeta.callIntents`, `:143`).
- A matched `new_job` call builds customer + job and returns `status:'matched'` with **no
  `visitId`** (`recordFieldNote.test.ts:913-932` pins this: *"a phone call is NOT a trip … a call
  that commits one is rung 10, and creates it UNPLACED"*). The job appears in the tray's
  *unscheduled jobs* half (`readUnscheduledJobs`, via the anti-join at `visits.ts:1233`).
- An unmatched `new_job` call stays **L1-only** — `recordFieldNote` returns before any L2 write
  (`:242-244`) — and opens an `unlinked_call` review "for the manager to link/create (resolve)
  or mark spam/wrong-number (dismiss)" (`reviewItems.ts:31-35`). **`resolve_review` does not
  link or create anything** — it marks the item resolved/dismissed and dispatches only on the
  staged-token kinds (`server.ts:6605+`); the manager acts through ordinary verbs.
- Every intent except `new_job` is human-routed and never auto-executed (`worker.ts:148-152`).

### 2. An email, end to end (the live path)

```
Gmail ──► Composio trigger GMAIL_NEW_GMAIL_MESSAGE ──POST──► /inbound/…      (httpServer.ts:716)
   verifyWebhookSignature (HMAC-SHA256 over id.timestamp.rawBody; 300 s replay window) webhook.ts:38-73
   metadata.user_id = "<tenantUuid>:<technicianRef>"  → split on FIRST colon       :169-175
   normalizer(GMAIL, GMAIL_NEW_GMAIL_MESSAGE) → InboundEnvelope                    gmail.ts:18-40
   getTechnician(tenant, ref) ── inactive → recordDrop + skipped_offboarded         :199-214
   requiresWorkClassifier → classify({from,subject,body})                          :219-255
        !isWork → upsertDroppedAudit (content-free receipt) → skipped_non_work
   recordFieldNote({ channel:'email', technicianRef: <mailbox owner's ref>,
                     text: "Subject:…\nFrom:…\n\nbody", externalId: message_id,
                     occurredAt, sourceMeta:{from, subject, pendingVerification?} })  :257-282
   !tech && !duplicate → flagUnknownRefCapture                                      :288-298
   → ingested | duplicate                                                           :299
```

Facts about this path that rung 10 inherits:

- `technicianRef` is the **mailbox owner's roster ref** (a manager's or a technician's), so —
  unlike the phone path — `getTechnician` resolves, `technicianId` is real, and `matchIdentity`'s
  schedule consultation runs against **that person's** day (`identityMatch.ts:83-116`). A
  customer's email arriving in a technician's paired mailbox on a day that technician has exactly
  one visit with an address yields `needs_confirmation` with that visit as the suggestion
  (`:130-135`); nothing on the inbound path ever answers a confirmation, so the capture stays
  L1-only.
- `resolveVisitForNote` step 1 ("held by this technician or by nobody") likewise matches visits
  the **mailbox owner** is on (`attachNote.ts:89-96`).
- Classification happens **before** the L1 insert because L1 is append-only (`webhook.ts:216-218`;
  CLAUDE.md). The only recorded exception is mail arriving while the pairing is
  `pending_verification`: ingested and stamped (`:277-280`).
- No manager push exists on the email path — `handleInboundWebhook` returns a status and nothing
  notifies anyone (contrast `notifyManagers` on calls, `src/calls/notify.ts`).
- Cost: the work classifier bills on **every** inbound email, dropped ones included
  (`webhook.ts:227-229`, `email/classify.ts:16-19`).

### 3. Inside `recordFieldNote` — the gates in order

```
(1) L1  ─ externalId dedup: linked → 'duplicate' · retracted → 'duplicate' · orphan → heal   :142-201
(1b)    ─ structure === false → 'captured'  (phone router's non-new_job calls)                :208
(2-3)   ─ extract(rawText)  → ExtractedFields                                                :215
        ─ fallbackPhone if no phone extracted                                                :220-222
(4)     ─ matchIdentity  (or the pre-resolved staged identity)                               :226-238
(6)     ─ NOT matched → return { status, captureId }   ← inbound stops here when unmatched   :242-244
(5)     ─ customer: matched | createCustomer(sourceCaptureId)                                :248-266
        ─ job: matcher's | most recent non-terminal | createJob(sourceCaptureId)             :270-283
(9b)    ─ isTechnicianChannel = channel ∈ {technician_voice, technician_photo, technician_note} :297-298
        ─ resolveVisitForNote({ …, technicianId, mayCreate: isTechnicianChannel })            :305-315
        ─ visit? → insertVisitNote (EVERY channel)                                            :323
                 → recordVisitReport   (technician only, existing visit)                     :328-335
                 → happened flip       (technician only, confirmed, starts_at ≠ null,
                                        note at/after start)                                 :353-380
        ─ statusSignal → updateJobStatus  (NOTE_SIGNAL_TRANSITIONS subset)                    :390-395
```

### 4. `resolveVisitForNote` — the three steps and where rung 10 lands

```
live = visits for the job, this tenant, status ∈ {confirmed, completed}              attachNote.ts:84-86
(1) placed on the note's firm-local day, crew includes technicianId OR crew empty;
    nearest start wins                                                                :88-106
       ── an UNTIMED visit never matches step 1: starts_at === null → false          :90
(2) exactly ONE live visit on the job, any day → attach                               :109
       ── an untimed visit CAN be that one visit
(3) !mayCreate → { visit: null }                                                      :112
    else createVisit({ startsAt:null, endsAt:null, status:'completed',
                       completedAt: noteLocal, technicianId, sourceCaptureId })       :113-127
```

The interaction that follows from steps 2 and 3 once inbound may create: after a call creates a
committed visit on a job, a later technician note on that job with no same-day placed visit hits
step 2, **attaches to the committed visit**, and then fails the happened-flip's
`visit.starts_at !== null` condition (`recordFieldNote.ts:356`) — the note links, the report
fields land, and the visit stays `committed`. Today that shape cannot arise because no
non-technician path mints a visit; the technician path mints one as `completed` (`attachNote.ts:122`).

### 5. What a "committed" visit is, and who can see one

A committed visit is `status = 'confirmed'`, `starts_at IS NULL`, `ends_at IS NULL`
(`stageOf`, `visits.ts:634-638`; `v_schedule.stage = 'committed'`). Exactly one writer exists:
the manager's untimed `book_visit` (`booking.ts:350-385`), which

- resolves a crew or none (`:317`), then refuses a twin — an untimed visit already on the job
  keyed by the first crew member or null (`listUntimedVisitsForJob`, `:363-379`);
- appends a `booked` schedule event with `detail.untimed: true` (`:601-616`);
- inserts with `status: 'confirmed'` explicitly. `createVisit` itself defaults to `'proposed'`
  (`visits.ts:275`), and the record says a `proposed` row "would vanish from every
  `['confirmed']`-filtered reader — on the board, in the tray, and in the overlap guard"
  (`visits.ts:528-536`); the 9b plan's leftover reads *"drop `proposed` from `visit_status` once a
  test pins that nothing writes it"* (`thoughts/shared/plans/2026-09-05-the-visit-is-one-object.md:544`);
- is exempt from the overlap guard by construction: `no_confirmed_overlap_participant`'s
  predicate is `status='confirmed' AND starts_at IS NOT NULL`, and an untimed row has no crew
  row with a time (`supabase/migrations/20260907100000_visit_participants.sql`).

| reader | sees an untimed visit? | where |
|---|---|---|
| the tray (`readLooseBucket`) | **yes** — the `\|\| starts_at === null` arm | `visits.ts:1153` (filter at the end of the function) |
| `get_team_schedule` recall / windowed | **yes** — its own top-level untimed list | `server.ts:4176-4178`, `:4213-4216` (`listUnplaced`, `visits.ts:1083`) |
| `v_schedule` (planner SQL) | **yes**, `stage = 'committed'`, `local_day` NULL; the catalog warns the planner to use `starts_at is null` | `server.ts:1211-1213` |
| customer brief | **yes**, marked `untimed: true` | `src/db/context.ts:126` |
| unscheduled-jobs half of the tray | the **job leaves** it — a confirmed visit is "live" | `visits.ts:1233` |
| `listOverdueConfirmedVisits` (the only visit detector) | **no** — `gte/lt ends_at` never match NULL | `visits.ts:934` |
| `identityMatch`'s schedule consult | **no** — `starts_at.slice(0,10) === day` | `identityMatch.ts:99` |
| `resolveVisitForNote` step 1 | **no**; step 2 **yes** | `attachNote.ts:90`, `:109` |
| the board's day grid | **no** — it has no day | `boardRead.ts` (the tray is its only home) |

There is **no detector** for "committed and never placed": `NUDGE_KIND_SPECS` is
`[OVERDUE_VISIT_GAP_SPEC, JOB_COST_GAP_SPEC]` (`nudgeKinds.ts:156`), one keyed on a placed
visit's end time, one on a job.

### 6. Redelivery and the gap the 9b record says rung 10 closes

`captureHasLinkedL2` (`rawCaptures.ts:137-155`) is true when any of `visits`, `jobs`,
`customers` carries the capture as `source_capture_id`, or a `visit_notes` row links it. An
inbound capture that resolves to an **existing** customer and an **existing** job — and, today,
creates no visit — leaves no such mark, so a redelivery (Composio retry, worker retry) takes the
orphan-heal path and re-runs the extractor (`recordFieldNote.ts:133-141`). The test at
`recordFieldNote.test.ts:380-411` pins the consequence **as the current behavior**: a `completed`
status signal correctly skipped on pass 1 (job still `open`) lands on pass 2 once the job has
moved to `in_progress` — *"a five-week-old email can close a job late."* Its final assertion is
`expect(after2[0].status).toBe('completed')`, i.e. it asserts the gap. A visit created with
`sourceCaptureId: captureId` would make `captureHasLinkedL2` true on the first pass.

## External Dependencies

- **SignalWire** — inbound number, consent/forward/record cXML, `RecordingStatusCallback`,
  `X-SignalWire-Signature` validation (`src/inbound/signalwire.ts`). Env: `SIGNALWIRE_API_TOKEN`,
  `SIGNALWIRE_WEBHOOK_BASE_URL`. The callback URL's query must be emitted in alphabetical key
  order (`phoneWebhook.ts:64-71`, live finding 2026-08-06).
- **AssemblyAI** — transcription from a signed bucket URL (`src/calls/transcribe.ts`).
- **Supabase Storage** — `CALL_AUDIO_BUCKET` (default `call-audio`), retention
  `CALL_AUDIO_RETENTION_DAYS` (default 30; `0` = transcript-only), purged by `Calls-purge`.
- **Composio** — the Gmail trigger and Standard-Webhooks signing (`COMPOSIO_WEBHOOK_SECRET`);
  per-person pairing via composite `user_id`. Connector-layer research:
  `thoughts/shared/research/2026-06-25-composio-connector-layer.md`; the inbound seam plan:
  `thoughts/shared/plans/2026-06-25-composio-inbound-connector-seam.md`.
- **The model** — three forced-tool calls on the inbound path, all through `runForcedTool`
  (`src/model/forcedTool.ts`): `classify_call` (256 tokens, 3 retries), `classify_email`
  (256, no retry), `record_extraction` (1024, no retry). Provider = `MODEL_PROVIDER`
  (`forcedTool.ts:16-17`); every call is billed against the tenant (`CostContext`).
- **Telegram** — `notifyManagers` fans a one-liner to every active manager with a binding
  (`src/calls/notify.ts`), calls only.

## Constraints and Invariants

- **L1 is append-only; classification gates the L1 insert on inbound email** (CLAUDE.md;
  `webhook.ts:216-218`). Recorded exception: `pending_verification` mail is ingested and stamped
  (`:277-280`). The phone path stores every transcript and gates **L2** instead (`worker.ts:66-69`
  in `recordFieldNote.ts`; `worker.ts:101-107`).
- **Attach is channel-blind, create is not** (`attachNote.ts:25-31`; `recordFieldNote.ts:292-296`).
  The record calls this **interim**: *"rung 10 is where inbound starts creating a COMMITTED
  (unplaced) visit, and it covers email as well as calls"* (9b plan `:60-62`;
  `docs/engineering-memory.md:4895-4896`, `:5064-5076`).
- **Report fields and the happened flip are technician-only** (`recordFieldNote.ts:324-335`,
  `:336-358`): folding an inbound extractor's `laborHours` would let a customer's email edit the
  job's cost; flipping on inbound would let "nobody ever showed up" mark the trip completed and
  silence the overdue detector forever.
- **A visit has a time or it does not** — both timestamps or neither (`createVisit`,
  `visits.ts:262-267`; `booking.ts:392-395`). There is no stored window (rung 9a).
- **Untimed rows are exempt from the DB overlap guard**, so duplicate protection is app-side:
  `listUntimedVisitsForJob(tenant, job, firstCrewMemberOrNull)` refuses a second untimed visit on
  one job with the same person-or-nobody (`booking.ts:357-379`; `visits.ts:1102`).
- **Identity is hardcoded, never the model's guess** (`docs/Three-Layer-Context-Spine-Overview.md`
  §5, `:159-178`). `matchIdentity` resolves by unique phone, unique address, or the technician's
  own schedule; otherwise it asks — and on the inbound path nobody answers.
- **`createVisit` defaults `status` to `'proposed'`** (`visits.ts:275`); every live writer passes
  `'confirmed'` or `'completed'` explicitly. The unscheduled-jobs anti-join treats `proposed` as
  live (`:1233`) while the tray and every `['confirmed']` reader ignore it (`:1218-1221`).
- **The `capture_channel` enum is fixed by migration** — `technician_voice`, `technician_photo`,
  `technician_note`, `phone_call`, `web_form`, `sms`, `email`, `chat`, `manager_assistant`,
  `manual_correction`, `sales_note`, `quote`, `crm_import`, `accounting_event`, `iot`
  (`20260620005307_context_spine.sql:16-22`). `InboundEnvelope.channel` is constrained to it
  (`normalize.ts:8-11`).
- **Dedup keys**: `RecordingSid` for calls (`callIngest.ts:8`, `worker.ts:134`), Gmail
  `message_id` for email (`gmail.ts:30`), both as `raw_captures.external_id` per tenant.
- **The extractor has no commitment field.** `ExtractedFields` (`extract.ts:8-24`) carries
  identity, job, `workPerformed`, `laborHours`, `statusSignal ∈ {completed, in_progress}`,
  `followUp`, `attributes`. Its prompt addresses *"a trades technician field note"* (`:33`) and
  is the same prompt for a customer's email or a call transcript.
- **The call classifier's `new_job` is "the caller wants new work done"** (`classifyCall.ts:54`),
  a statement about the caller's wish. Nothing in the vocabulary distinguishes "we agreed to send
  someone" from "they asked for a quote".
- **`ingestEmail` is dead code**: no caller in `src/`, `scripts/`, or `package.json`.
- **`listVisitsForJob` is imported by `attachNote.ts` directly from `../db/visits.js`**
  (`attachNote.ts:35`), not through the `db/index.ts` barrel; the 9b plan (`:66`) recorded it as
  deleted with zero callers.
- **"Rung 10" is two different things in the docs.** The ladder (`engineering-memory.md:3573`)
  says *inbound commits a visit*. Three older passages say rung 10 is where **route optimization
  returns as an advisory tool** — `docs/onboarding.md:307`, `docs/nemoclaw-tech-agent.md:277`,
  `docs/engineering-memory.md:4558` (which also says `Requirement = '…|maps'` in `toolCases.ts` is
  "reserved for rung 10's advisory optimizer"). The current ladder has no row for the advisory
  optimizer; rung 11 is "the planner learns the schedule — recommends".
- Hard dependency recorded: `9b < 10`; `9c` and `10` independent (`engineering-memory.md:3578-3580`).

## Decision Points

1. **Where the judgment "the firm committed to a visit" lives.** Today no output carries it.
   The options the code presents: (a) a new field on `ExtractedFields` (`extract.ts:8-24`) so the
   existing extractor call decides it — one prompt for technician notes, emails and transcripts;
   (b) a new label in `CallIntent` (`classifyCall.ts:12-18`) — call-only, and email has no intent
   classifier at all, only work/personal; (c) a separate forced-tool call — a third model call per
   inbound capture; (d) no judgment: every matched `new_job` call and every matched work email
   mints a committed visit, and the manager drops the wrong ones (the ruling's *"create, don't
   stage"*, `engineering-memory.md:5064-5066`).
2. **Where the creation runs.** (a) inside `resolveVisitForNote` step 3, replacing the boolean
   `mayCreate` with a mode (`completed` for technicians, `committed` for inbound) — the rung-9b
   comment already points there (`attachNote.ts:30-31`); (b) in `recordFieldNote` after job
   resolution, beside the report/flip gates; (c) in the callers (`worker.ts` after `:146`,
   `webhook.ts` after `:282`) when the result is `matched` with no `visitId` — which keeps the
   shared door unchanged but splits the rule per channel.
3. **The row's status.** `confirmed` + null times matches the manager's own untimed booking and is
   visible to the tray, recall, `v_schedule`, and the customer brief (§5 table); `proposed` is
   invisible to all of them and to the overlap guard, and the record wants the value gone.
4. **Whether a created visit writes a ledger event and a push.** `book_visit` appends a `booked`
   schedule event whose `detail` carries `untimed: true` for an untimed booking, plus
   `technicianRefs` and `customerId` (`booking.ts:601-616`; the tool result echoes it at
   `server.ts:4491`); the inbound paths append no schedule events at all. Calls push managers
   via `notifyManagers`; email pushes nobody.
5. **The unmatched branch.** `recordFieldNote` returns before any L2 write when identity is not
   matched (`:242-244`); the phone path then opens an `unlinked_call` review. A visit can only be
   created on the matched branch unless identity resolution changes; overview §5 says identity is
   hardcoded and never the model's guess.
6. **Step-2 attach onto a committed visit.** A technician's later note on that job attaches
   (`attachNote.ts:109`) and does **not** flip the visit (`recordFieldNote.ts:356`, `starts_at`
   null). The visit stays `committed` after the trip was reported. Options: leave it; let a
   technician note on a committed visit mark it `completed` with `completed_at = noteLocal`
   (the walk-in shape, `attachNote.ts:117-124`); require placement first.
7. **The twin guard.** `listUntimedVisitsForJob` keyed on job + first-crew-or-null
   (`booking.ts:363-379`) would refuse a manager's later untimed `book_visit` on a job that
   already carries an inbound-created untimed visit ("likely a duplicate; place that one").
   Conversely, a job with two live visits (one placed, one committed) fails step 2's "exactly one"
   and a second inbound capture would reach the create arm.
8. **Web form.** No intake exists; the ruling says settle it with rung 10
   (`engineering-memory.md:5071-5072`). Building one means a route, a normalizer registered in
   `normalize.ts`, an `externalId` source, and a decision on whether it runs the work classifier.
9. **The dead Gmail pull.** `ingestEmail` has no caller; rung 10 either teaches it the same rule
   or it stays a second, untested copy of the email path.
10. **Detection of "committed, never placed".** No `NudgeKindSpec` reads untimed visits
    (`nudgeKinds.ts:156`). Whether that is rung 10, rung 11 ("the planner reads the schedule +
    unplaced visits, RECOMMENDS", `engineering-memory.md:5076-5077`), or rung 12.
11. **The tests that pin today's behavior** must be inverted, not deleted:
    `recordFieldNote.test.ts:369-378`, `:380-411` (asserts the gap), `:913-932`;
    `worker.test.ts:195`.
12. **The numbering collision** — which document is corrected: the three "advisory optimizer =
    rung 10" passages, or the ladder.

## Open Questions

- What `MODEL_PROVIDER` resolves to on the Render services today (`forcedTool.ts:16-17` says
  `'openai'` → GLM-5.2 via Fireworks by default), and therefore which model runs `classify_call`,
  `classify_email` and `record_extraction` on the pilot. Not readable from the repo.
- The pilot's real inbound volume: the deploy preflight read 2 captures in 3 days. Which mailboxes
  are paired (whose schedule `identityMatch` consults for email) and whether the SignalWire number
  receives calls.
- Who passes `visitId` to `appendRawCapture` (`server.ts:3506`, `:3652`, `:4067`) and whether an
  inbound-created visit should stamp its capture (L1 is inserted before the visit exists).
- Accuracy of the call router's `new_job` on real transcripts — no eval corpus for it was found
  under `src/eval/` in this pass.
- Whether the Composio trigger redelivers on a 503 (`transient_error`) often enough for the
  orphan-heal path to matter at pilot volume.
