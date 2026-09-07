---
date: 2026-09-06
task: Rung 10 — inbound ASKS before it creates, and what it creates cites the call. The extractor is the planner's eye on call → job → visit; a new job or a detected commitment calls the planner IMMEDIATELY for that one item (a focused pass, ~10 s); the planner decides in its own words whether to text the manager; the manager's own agent opens the job / books an untimed visit, and the row cites the capture; what the caller said is kept on the job.
research: thoughts/shared/research/2026-09-06-rung-10-inbound-commits-a-visit.md
status: draft
supersedes: nothing as a document — AMENDS the 2026-09-03 ruling "create, don't stage" at docs/engineering-memory.md:5064-5077 and the ladder row at :3573. User, 2026-09-06: "Before creating the visit, someone gets asked"; "the planner should be specifically called for the one issue". User, 2026-09-07: "for new jobs, we also want the planner to ask the manager"; amendments A, B, C "are all necessary".
---

**`supersedes:` is not optional bookkeeping.** No thoughts/ document is overturned. The ruling
this plan changes lives in `docs/engineering-memory.md`; Phase 3 rewrites it in place.

## Overview

Every call and email lands in L1, runs the extractor, matches the customer — and today silently
mints a job whenever the customer has no open one (`recordFieldNote.ts:275-283`); the manager
never hears of it. The extracted facts are then dropped (the only home is the technician's trip
report), and on an open job with no trip the capture links to nothing (`rawCaptures.ts:177-182`).
Nothing lets inbound create a *visit*. The user's direction: the extractor is the **planner's
eye**; the moment it sees a request to create something — a new job, or a visit the firm agreed
to — the planner is called for that one item and decides; the manager's agent creates it on a
yes; everything created cites the call; what the caller said stays on the job, labelled.

```
call / email ─► L1 ─► extractor ─► matched customer? ──no──► unlinked_call / silence  (rung 10b)
                                        │ yes
                     open job on file? ──no──► OBSERVATION inbound_new_job ──────────────────┐
                                        │ yes           (visitCommitted ⇒ kind inbound_commitment) │
                     attaches to a LIVE visit? ─yes─► visit_notes link ─┐                       │
                                        │ no                            ├─► correspondence on   │
                     job_captures link (A) ─────────────────────────────┘   the job (C)         │
                     visitCommitted? ──yes──► OBSERVATION inbound_commitment (with jobId) ──────┤
                                        │ no: status signal as today, done                      ▼
                       Calls-worker's ping loop CLAIMS it (pinged_at), ~10 s
                       FOCUSED PLANNER PASS — this item only, ≤180 s; usual move: send{as:'chat', to: a manager}
                                        │ manager: "yes" (a normal turn to their agent)
                                        ▼
                       agent: open_job | book_visit (untimed) — the new rows CITE the capture (B), carry the facts (C)
                       heartbeat :00/:30 = the fallback (same asked_at guard); closes on THE RECORD (exact citation)
```

## Decisions

- **Ask first, never create-first** *(user)* — amends "create, don't stage". Nothing inbound opens
  a job or reaches the schedule without a manager's yes. **Widened 2026-09-07 *(user)*: a NEW job
  asks too** — "so the manager can know, instead of being blind to the job being created."
  Accepted consequences: an unanswered ask means no job until answered (the observation stays open;
  the planner re-asks by its own doctrine); a work email that is not a request, on a customer with
  no open job, raises one too and costs one focused pass — the planner dismisses it.
- **The commitment judgment is one extractor field** *(user)* — `visitCommitted`. "New job" is
  code's own fact (no non-terminal job on file). Zero extra model calls.
- **One observation per capture; the kind names what code could not decide** —
  `inbound_new_job` (no open job) or `inbound_commitment` (the firm agreed to come out; `jobId`
  absent means a job would be opened too). A committed capture stops after identity **and after
  the attach**: linked to a live visit ⇒ correspondence about booked work, no ask.
- **A. Attach to the job when no trip attaches** *(user 2026-09-07)* — `job_captures`
  (`job_id, capture_id`), the twin of `visit_notes`, for an inbound capture on an open job with no
  live visit; a third arm `via:'job'` in both evidence homes and in `captureHasLinkedL2`. Closes
  the link-less shape AND the repeat-extractor redelivery cost. (`job_notes` is taken — the
  planner's notepad, migration 20260901120000.)
- **B. What the manager's agent creates cites the call** *(user 2026-09-07)* — `bookVisit` and the
  new `open_job` take `sourceCaptureId`; the handler finds the customer's ONE open pinged-kind
  observation and passes its capture (zero or many ⇒ no citation, logged). Code never closes the
  observation — the planner does (the record is planner-kept).
- **C. What the caller said lands on the job** *(user 2026-09-07)* — `attributes.correspondence[]`
  on the JOB: `{captureId, channel, at, followUp, facts}` from the extractor, APPENDED under CAS,
  never merged over a top-level key, never `laborHours`/`workPerformed` (the report and the bill
  stay technician-only — 9b's line). Written at capture time on an open job; at creation for a job
  opened from an ask (copied from the observation by the handler). Readers label it "from the caller".
- **Matched customers only** (overview §5). Unmatched ⇒ today's `unlinked_call`. **Rung 10b,
  stacked after this** *(user 2026-09-07)*: `inbound_unmatched` on the SAME ping loop, the planner
  as second opinion via `spine_read`, a manager `add_customer` verb that re-runs the one door with
  the identity resolved, ask-first. Helpers are kind-blind (`PINGED_KINDS`); 10b appends a kind.
- **Immediate, and about one thing** *(user, both)*. The always-on process is `Calls-worker`
  (the web service is Render free-plan and spins down). A second loop in the same process polls
  for unclaimed observations and runs a **focused pass**: `runPlanner` for one tenant with the
  readers scoped to that observation (+ its job's evidence), the memory index riding, no office
  inbox consumed, **no `planner_runs` watermark**, and a 180 s budget — the :00/:30 pass still
  inspects everything and calls are never starved. Rejected: in-request from the webhook; the
  Render trigger-run API (a broad key on an internet-facing service).
- **Two markers on the observation, `pinged_at` and `asked_at`** — `pinged_at` = the planner was
  CALLED about it (the worker's guarded claim; the heartbeat also stamps what it showed);
  `asked_at` = a text went out, set by the `send` itself under a guard (`asked_at is null`), so
  the focused pass and the heartbeat can never both text the manager, and the planner's own
  `hold` never blocks its later `send` (round-2 #1).
- **No template** *(user)* — the gap view shows the caller's words (bounded) with a pointer to
  the full capture, the customer, the open job, the extractor's fields; the doctrine says what
  the situation is and what the manager's agent can do, and that the usual move is to ask
  whether to open the job and, if they committed, a visit — in the planner's words. Rails that
  stay: `to` required, `as:'chat'` (the `assistant` leg injects a turn nobody delivers),
  `countsAsTheAsk` omitted, and **never the caller's day or time** — the date rail drops them,
  and no clock label is added for these kinds (it would re-legalise the weekday; round-2 #5).
- **Closing is exact** — a job or visit whose `source_capture_id` is the observation's capture
  (B); the inferred fallback for a booking made by hand on the board: one created after
  `noticed_at` on the named job or customer. `dismiss` follows a no via `inform_team_lead`.
- **Subject = capture id, author `detector`**; processed for `captureHasLinkedL2`.
- **Technician report on a committed visit** → rung 12 *(user)*. **Web form** out *(user)*.
- **Delete `ingestEmail`** and `googleapis` (its only importer).
- **Deploy pair:** the additive migration goes BEFORE the fork sync; five env names go onto
  `Calls-worker` first; `database.types.ts` is regenerated from the LOCAL stack (`gen:types`
  targets the pilot and would write the old schema — round-2 #2).

## Plain-language walkthrough

**Phase 1 — the eye, and the record.** The extractor gains a yes/no: *did the business agree to
send someone out?* For a customer we know, the write path stops creating things. If the caller
has an open job, the words are pinned to it (to the trip if one is on the calendar, to the job
itself if not — A) and what they said is kept on the job in a labelled corner (C). If they have no
open job, or the firm agreed to come out, an **observation** is written in the planner's own record
instead of a job: the words, who they are, what they asked for. You'd see a new `v_observations`
row and nothing new in the tray.

**Phase 2 — the focused pass.** Within seconds the call worker claims the observation and calls
the planner *about that one thing* — the same planner as at :00/:30, with its notes, shown only
this item, on a three-minute budget. It reads the words and decides in its own words; usually a
text to the manager asking whether to open the job, and a visit if they committed. The text marks
the item asked so nobody asks twice; the created job or visit closes it; a no dismisses it. The
half-hourly pass is the fallback and cannot double-text.

**Phase 3 — the hands, the citation, and the deploy.** The manager's agent learns the reply: on
"yes", find the customer from the office's text and `open_job`, or `book_visit` untimed when a
visit was asked for. The new rows are stamped with the call they came from (B) and carry the
caller's facts (C), so "why is this on the calendar" has an answer. Docs stop saying rung 10
creates visits silently; the dead Gmail pull goes.

## Secrets & env preflight
- **Phase 1:** none new.
- **Phase 2:** on Render `Calls-worker` (`srv-d9qelh710e5c739hb8vg`) add, copied from
  `lifecycle-heart`: `INFERENCE_MODEL`, `INFERENCE_BASE_URL`, `INFERENCE_CACHE_KEY`,
  `MODEL_PROVIDER`, `PLANNER_MODE` (it has `INFERENCE_API_KEY`, `SUPABASE_*`, `BOARD_BOT_TOKEN`).
  Names only — never paste values.
- **Phase 3:** none. Deploy: fork push rights; `ssh tradesbox`; `supabase-test` MCP.

## Phase 1: The eye and the record — inbound attaches, keeps, or asks; never creates

### Changes required

**`src/writePath/extract.ts`** — `ExtractedFields` (`:8-24`): `visitCommitted?: boolean | null`.
`EXTRACTION_SYSTEM` (`:32-38`): widen to "a technician field note, an inbound phone-call
transcript, or a customer email"; add *"Set `visitCommitted` true ONLY when the BUSINESS agreed
to send someone out — never because the caller asked, requested a quote, or it is undecided."*
`EXTRACTION_TOOL` (`:41-71`): add the boolean; **export** the const for a schema pin.

**`src/db/reviewItems.ts`** — `ReviewKind` (`:10-63`): `| 'inbound_new_job' | 'inbound_commitment'`.

**`supabase/migrations/20260908100000_inbound_asks_and_job_captures.sql`** — (a) `alter table
observations add column if not exists pinged_at timestamptz, add column if not exists asked_at
timestamptz;` + a partial index on `(tenant_id, noticed_at) where status='open' and pinged_at is
null` (kind-blind, for 10b); comments: `pinged_at` = the planner was called about it, `asked_at`
= a text went out. (b) `create table job_captures (tenant_id uuid not null references tenants(id),
job_id uuid not null references jobs(id) on delete cascade, capture_id uuid not null references
raw_captures(id), created_at timestamptz not null default now(), primary key (job_id, capture_id))`
+ `idx_job_captures_capture` — mirror `visit_notes` (20260906140000:114-122) incl. its RLS/grants.
Additive; applied to the pilot BEFORE the deploy.
**`src/db/database.types.ts`** — regenerate with `npm run gen:types:local` after `supabase db
reset` (NEVER `gen:types`); commit it.

**`src/db/observations.ts`** — `captureHasObservation(captureId)`; `PINGED_KINDS: ReviewKind[] =
['inbound_new_job', 'inbound_commitment']` (10b appends); `listUnpingedObservations(kinds, limit)`
(open, kind, `pinged_at is null and asked_at is null`, oldest first, fleet-wide);
`claimObservationPing(id)` — guarded `set pinged_at=now() where id and pinged_at is null`, null =
taken; `markObservationAsked(id, notBeforeIso)` — guarded `set asked_at=now(), not_before=… where
id and status='open' and asked_at is null`, null = already asked; `stampObservationsPinged(ids)` —
best-effort, `where pinged_at is null`.
**`src/db/jobs.ts`** — `insertJobCapture({tenantId, jobId, captureId})` (ignore 23505);
`captureHasJobCapture(captureId)`; `listJobCaptureTimesForJobs(tenantId, jobIds, sinceUtcIso)`
(the twin of `visits.ts:1324`); `appendJobCorrespondence(jobId, entry)` — read → `[...existing,
entry]` under key `correspondence` via `trySetJobAttribute` (`:90`), 3 attempts (the
`setJobAttribute` loop at `:115`); `entry = { captureId, channel, at, followUp, facts }` where
`facts` = `extracted.attributes` (object only), `followUp` = `extracted.followUp`; NEVER
`laborHours`/`workPerformed`; skip the write when both are empty.
**`src/db/rawCaptures.ts`** — `captureHasLinkedL2` (`:137-155`): arms `captureHasJobCapture`,
`captureHasObservation` after the visit-note arm. `listJobEvidenceSince` (`:262`) and
`listJobStampedCaptureTimes` (`:183`): a third arm over `job_captures`, `via: 'job'` (widen the
union; comments at `:172-182` rewritten — the link-less shape is closed).

**`src/writePath/recordFieldNote.ts`** — `RecordFieldNoteResult` (`:73-82`): `observationId?`.
Hoist `isTechnicianChannel` (`:297-298`), `technician`, `timezone` above job resolution; resolve
`job` as today (`:268-274`) but **do not `createJob` for inbound**; then:
```ts
if (!isTechnicianChannel) {
  // RUNG 10 — THE EYE. Inbound never creates: it attaches (A), keeps (C), or asks.
  let visitId: string | undefined;
  if (job) {
    const r = await resolveVisitForNote({ tenantId, jobId: job.id, technicianId: null, capturedAt, timezone, captureId, mayCreate: false });
    if (r.visit) { await insertVisitNote({ tenantId, visitId: r.visit.id, captureId }); visitId = r.visit.id; }
    else await insertJobCapture({ tenantId, jobId: job.id, captureId });
    await appendJobCorrespondence(job.id, correspondenceOf(captureId, channel, capturedAt, extracted));
  }
  if (job && (extracted.visitCommitted !== true || visitId)) { /* fall through to the status-signal block, then return as today */ }
  else {
    const kind = extracted.visitCommitted === true ? 'inbound_commitment' : 'inbound_new_job';
    const obs = await createObservation({ tenantId, kind, subjectRef: captureId, technicianId: null,
      context: { captureId, capturedAt, customerId, channel, customerName: (await getCustomer(customerId))?.name ?? null,
        from: fromOf(input.sourceMeta), ...(job ? { jobId: job.id, jobTitle: job.title } : {}),
        asked: { jobTitle, jobType, address, city, workPerformed, followUp, attributes } /* from extracted, nulls kept */,
        words: rawText.slice(0, 1500) } });
    return { status: 'matched', captureId, customerId, ...(job ? { jobId: job.id } : {}), observationId: obs.id };
  }
}
if (!job) job = await createJob({ …as today });   // technician channels only now
```
The technician path (`:305-381`) is untouched; the status-signal block (`:390-395`) runs for an
inbound capture on an open job exactly as today.

**Tests** — `src/writePath/recordFieldNote.test.ts` (widen `noteBy` at `:123` with
`'phone_call'`; afterAll `:35-39` also truncates `observations`, `job_captures`): (1) committed
email, matched customer, no job → one `inbound_commitment` observation (`subject_ref`,
`context.customerId`, `context.words`, `context.asked.attributes`, no `jobId`), NO job, NO visit,
`observationId`; (2) committed `phone_call`, open job, no live visit → `context.jobId`, one
`job_captures` row, `attributes.correspondence[0].captureId`, no new job; (3) committed email on a
job with a live placed visit today → `visitId`, one `visit_notes` link, correspondence appended,
NO observation; (4) uncommitted email, matched, no job → `inbound_new_job`, NO job; (5) uncommitted
email on an open job, no live visit → `job_captures` + correspondence, no observation; (6)
redelivery of (5) AND of (1) → `duplicate`, extractor spy not called; (7) unmatched committed
call → `needs_disambiguation`, nothing written; (8) `technician_note` + `visitCommitted:true` →
walk-in unchanged, no correspondence; (9) correspondence never carries `laborHours`/`workPerformed`;
a second capture appends (length 2); an existing top-level key survives. `observations.test.ts`:
the five helpers, second claim/ask null. `rawCaptures.test.ts`: `listJobEvidenceSince` yields a
`via:'job'` row; `captureHasLinkedL2` true on a `job_captures` link alone. Schema pin on
`EXTRACTION_TOOL`.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`; `supabase db reset` clean;
      `git diff --stat src/db/database.types.ts` shows the two columns and the table
- [ ] (1)–(9) pass; falsify (4) by restoring `createJob` for inbound → job count; (3) by moving the
      observation above the attach; (6) by dropping the `job_captures` arm from `captureHasLinkedL2`
### Live verification — none until Phase 3. ### Manual verification — none. *Continue.*

## Phase 2: The focused pass — called at once, about one thing, in its own words

### Changes required

**`src/jobs/plannerPass.ts`** (new) — `runPlannerPass(nowIso, mode, extra: Partial<PlannerDeps>,
impl = runPlanner)` wraps `lifecycle.ts:485-493` (`tools`, `execute` via `dispatchForIdentity`
+ `TEAM_LEAD_REF`); `lifecycle.ts` calls it passing `deps.runPlanner` as `impl` so the injectable
seam at `lifecycle.test.ts:804-834` survives (round-2 #3). `runFocusedObservationPass(obs, impl?)`
= `runPlannerPass(now, mode, { focus: { observationId: obs.id, budgetMs: 180_000 },
listTenants: [obs.tenant_id], listObservations: [obs], listNudges: [], listOfficeMessages: [],
listDeskTranscripts: [], plannerRun: async () => {} })`; no-op when `PLANNER_MODE` is unset/off
or `!hasModelCredentials()`.

**`src/calls/observationPing.ts`** (new) — `drainOneObservationPing(deps)`:
`listUnpingedObservations(PINGED_KINDS, 1)` → `claimObservationPing` → `runFocusedObservationPass`;
a throw is logged, never rethrown; the claim stays (the heartbeat is the fallback).
**`src/calls/runWorker.ts`** (`:14-27`): `main` becomes `Promise.all([callLoop(), pingLoop()])` —
two independent loops, each with its own backoff (round-2 #4).

**`src/teamLead/planner.ts`**
- `PlannerDeps` (`:542`): `focus?: { observationId: string; budgetMs: number }`. In focus: skip
  `plannerRun`; pass `budgetMs` into the `runLoop` request; the user message's `This firm has N
  open gap(s).` (`:2951`) becomes *"This pass shows 1 item; the firm's other open work is not
  shown and is not yours now."* (round-2 #6); `PlannerSummary` (`:367`) gains optional
  `focused?: true`, `pingedByObservation?`.
- Per-tenant due check (`:3652-3656`): focused ⇒ due; else `pinged = openObs.some(o =>
  PINGED_KINDS.includes(o.kind) && !o.pinged_at && !o.asked_at && noticed_at > lastMs)` with the
  guarded `lastRunAt` read hoisted from `:3942-3966` (failure ⇒ not pinged); `if (!pinged &&
  !plannerCadenceDue(…))`. After a SUCCESSFUL non-focused pass, `stampObservationsPinged` on the
  pinged-kind rows it showed (best-effort).
- `buildGapView` (`:1181`, after `:1313-1326`) for both kinds: `  the caller's words (${channel},
  from ${from}, ${agoLabel}): "${words}"`, `  customer: … (id …)`, `  they asked for: …`, `  on
  file: open job … (job id …) | no open job — a job would be opened`, `  the firm agreed to come
  out: yes | not said`, `  capture id: … (spine_read v_captures for the full words)`, and when
  `asked_at`: `  you texted a manager about this ${ago}`. No clock label; `dateLabels` unchanged.
- `apply` `case 'send'` (`:3017`): for these kinds, FIRST `markObservationAsked(id, now + 24h)`;
  null ⇒ `{ outcome: 'refused', detail: 'already asked' }`; then the office row `via: 'chat'`.
  Validate: `as` must be `'chat'`, `to` present, `countsAsTheAsk` absent.
- `mootFactFor`: exact arm — `listL2CitingCapture(captureId)` (new in `src/db/rawCaptures.ts`:
  jobs + visits with `source_capture_id`) ⇒ `'a job/visit was created from this capture'`;
  inferred arm — `listVisitsCreatedSince(tenantId, minNoticedAt)` (new in `src/db/visits.ts`:
  `{ id, job_id, customer_id, created_at }` via `jobs!inner`, confirmed/completed, paged) on
  `context.jobId` or the customer after `noticed_at` ⇒ `'a visit was booked for this customer
  after it was noticed (not cited)'`.

**`src/jobs/lifecycle.ts`** — `LifecycleDeps` (`:79` region): `listFreshPings?`. Keep
`:452`; the `!plannerTick` arm (`:481-482`) becomes a lazy `else if (!plannerTick && !(await
freshPing()))` — the dep over `now − 35 min`, `pinged_at is null and asked_at is null`,
try/caught ⇒ false + log. Skip text: `'off-cadence tick (no firm due, no unclaimed observation)'`
(update the pin at `lifecycle.test.ts:903`).

**`src/teamLead/plannerPrompt.ts`** — after the closing doctrine (`:186-208`), **REQUESTS FROM
CALLS AND EMAIL**: what it is (the extractor heard a customer ask for work, or the firm agree to
come out; the words are shown; nothing has been created, deliberately — you decide); what can
happen (the manager's agent can `open_job`, or `book_visit` an untimed visit when the manager says
so; you cannot); the usual move (`send` a manager, `as:'chat'`, `to` required, no `countsAsTheAsk`,
asking in your own words whether to open the job — and a visit when they committed — who, what,
the open job if any); when not to (created on THE RECORD, cited — close; not a request, a
thank-you, a supplier — dismiss with a reason); rails (never the caller's day or time — the record
keeps them; the send marks it asked; `hold` to wait).

**Tests** — `planner.test.ts`: (10) focus: one item shown, `plannerRun` not called, the focus line
present and the firm-count line absent, `focused:true`, `budgetMs` reaches `runLoop`; (11)
heartbeat: unpinged + unasked after `lastRunAt` makes 09:45 run (hours 8-16); pinged, asked, or
earlier ⇒ skipped; a successful pass stamps `pinged_at`; (12) gap-view lines for both kinds, no
weekday anywhere; (13) `mootFactFor` exact (a cited job) vs inferred vs none; (14) `send` sets
`asked_at`; a second `send` refused; `hold` then `send` on a later tick succeeds; `as:'assistant'`
refused; (15) the heading. `lifecycle.test.ts`: `listFreshPings: async () => []` in `STUBS`
(`:796`); extend `:877`. `observationPing.test.ts`: claim → pass once; second claim null; a
throwing pass keeps the claim.

### Automated verification
- [ ] gates green; (10)–(15) + worker tests pass; falsify (14) by removing the guard → double send
### Live verification — none until Phase 3. ### Manual verification — none. *Continue.*

## Phase 3: The hands, the citation, the record, and the deploy

### Changes required

**`src/schedule/booking.ts`** — `BookVisitInput` (`:208`): `sourceCaptureId?: string`; pass it to
`createJob` (`:549`) and `createVisit` (`:569`). **`src/mcp/server.ts`** — a helper
`inboundAskFor(tenantId, { customerId?, jobId? })`: `listObservationsByStatus(tenantId, ['open'])`
filtered to `PINGED_KINDS` and `context.customerId`/`context.jobId`; exactly one ⇒ `{ captureId,
asked }`, else `null` (log the count). `case 'book_visit'` (the `bookVisit(bookInput)` call):
pass `sourceCaptureId` from it; after a job was minted, `appendJobCorrespondence` with the
observation's `asked` (C at creation). New tool **`open_job`** (same tier as `book_visit`):
`{ customerId, title, jobType?, priority? }`, one-shot (a job is cancellable), the same open-work
refusal as `book_visit`'s customerId path (re-call with `forceNewJob:true` only for genuinely
different work), `createJob` with `sourceCaptureId` from `inboundAskFor`, the correspondence copy,
returns the job. Neither verb touches the observation — the planner closes it on the citation.

**`Box_Setup_Stuff/bootstrap-box.sh`** — inside the confirmation heredoc (`:701-738`), rule
**7**: *When the office texts about a call or email asking whether to open a job — or to open one
and book a visit because we agreed to come out: the office's text is above in this chat — take
the customer and the work from it, `find_customer` for the id. A visit asked for: `book_visit`
with the existing jobId if the office named one, else customerId + the work as title; NO date, NO
times (it books untimed; a new job is minted in the same call). Job only: `open_job`. If either
refuses with open jobs, re-call with the matching jobId. Offer to place it and to send someone.
On a no, `inform_team_lead` in one sentence. Never create it before they answer.* No new `##`.

**`docs/nemoclaw-tech-agent.md`** (`:190-212`): mirror rule 7; rewrite `:299-311` to the
webhook-only truth. **Delete `src/email/ingest.ts`, `ingest.test.ts`; `npm uninstall googleapis`**
(`package.json:53`); reword `classify.ts:15,44`, `planner.ts:923`, `planner.test.ts:3305`,
`engineering-memory.md:1933, :5070`. Catalog text for `get_job`/`get_customer_context`: the
`correspondence` entries are "what the caller/emailer said, labelled by capture".

**Docs** — `engineering-memory.md`: ladder row `:3573` → `10 inbound asks before it creates —
extractor → observation (new job | commitment) → focused planner pass → manager's agent
open_job/book_visit, cited; job_captures + correspondence [BUILT …; §10]`; rewrite `:5064-5077`
(dated 2026-09-06/07); `:4558`, `onboarding.md:307`, `nemoclaw-tech-agent.md:277` → "rung 11";
`rawCaptures.ts:172-182` → the third home is `job_captures`, the shape is closed. A `### ✅ BUILT —
rung 10` record in `- **Title**` bullets (new-caller path = rung 10b; the silent `assistant` leg;
the two markers; A/B/C; the accepted focused-pass cost per non-request email). Overview §4
(`:121-157`): one sentence. `npm run decisions:index`.

**Tests** — `boardApi.test.ts`/`server.test.ts`: (16) `book_visit` by customerId with ONE open
`inbound_new_job` observation → minted job and visit both carry `source_capture_id` = its capture;
`attributes.correspondence[0]` = its `asked`; the observation is still `open`; (17) zero or two
observations → no citation, booking unchanged; (18) `open_job` cites, copies, refuses with open work
unless `forceNewJob`, and a technician-tier caller cannot see it.

**Deploy (owner's call):** 1. `apply_migration` on the pilot (additive: two columns + the table);
2. set the five env names on `Calls-worker`; 3. fork sync → deploy `TradesDatabase`,
`lifecycle-heart`, `Board_Worker` (the worker auto-deploys); all five `live`; 4. `bootstrap-box.sh
wire s2` (md5 the repo copy first), read rule 7 back, `nemoclaw s2 gateway restart`, then s3 s5 s6 s7 s8.

### Automated verification
- [ ] gates green; `doctrine.test.ts` green; (16)–(18) pass;
      `grep -rn "ingestEmail\|email/ingest\|googleapis" src scripts docs package.json` → 0
### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP, `ssh tradesbox`, Render logs for `Calls-worker`, a paired
  manager mailbox, and ONE human action: the owner emails it from a known customer's address with
  no open job, saying the firm will come out (one email exercises new-job AND commitment).
- [ ] pilot: newest `observations` row is `inbound_commitment`/`open` with that customer and no
      `jobId`; `pinged_at` set within ~30 s; `Calls-worker` logs one focused pass.
- [ ] `nudge_decisions` has the pass's `send` row keyed to that `observation_id`; `office_messages`
      has the `to_agent` row, `via='chat'`, naming the customer, NO weekday; the manager's phone
      shows it; `asked_at` is set.
- [ ] after the manager's yes: one new `jobs` row and one `visits` row (`starts_at is null`,
      `status='confirmed'`, `booked` event `detail.untimed=true`), BOTH with `source_capture_id` =
      the observation's capture; the job's `attributes.correspondence[0].captureId` matches; the
      next :00/:30 pass closes it on THE RECORD (exact) and does NOT send again.
### Manual verification
- [ ] The manager judges the text says what the caller said, not more, and that their agent found
      the right customer without asking again.
