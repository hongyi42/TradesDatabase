---
date: 2026-09-06
task: Rung 10 — inbound commits a visit, ASK FIRST. The extractor is the planner's eye on call → job → visit; a detected commitment pings the planner within one tick; the planner texts the manager once; the manager's own agent creates the job and an untimed visit with book_visit.
research: thoughts/shared/research/2026-09-06-rung-10-inbound-commits-a-visit.md
status: draft
supersedes: nothing as a document — AMENDS the 2026-09-03 ruling "create, don't stage" at docs/engineering-memory.md:5064-5077 and the ladder row at :3573 ("extractor creates UNPLACED"). User, 2026-09-06: "Before creating the visit, someone gets asked."
---

**`supersedes:` is not optional bookkeeping.** No thoughts/ document is overturned. The ruling
this plan changes lives in `docs/engineering-memory.md`; Phase 3 rewrites it in place so the
old sentence cannot be found and built on.

## Overview

Every call and email already lands in L1, runs the extractor, matches the customer, and builds
customer + job. Nothing lets inbound create a *visit* — `mayCreate` (`attachNote.ts:52`) is
false for correspondence, and the ladder said rung 10 would flip it silently. The user's
2026-09-06 direction: the extractor is the **planner's eye**, and this is the first time an input
path can produce an *actionable* object, so the planner is pinged the moment a commitment is
detected — **before** any job or visit exists — and decides whether to ask. The manager's agent
then creates both with the verb it already has.

```
call / email ─► L1 ─► extractor ─visitCommitted─► attach to an EXISTING live visit? ──yes──► link, done
                       │ false                       │ no
                       ▼                             ▼
             customer + job as today       OBSERVATION kind=inbound_commitment (+ existing job id if any)
             (unscheduled-jobs tray)                 │  the ping: next heartbeat, ≤5 min
                                                     ▼
                                   planner: send{as:'chat', to: manager} — a text on their phone
                                   "I noticed a call from ‹who› about ‹work›. Create the job and a visit?"
                                                     │ manager: "yes" (a normal turn to their agent)
                                                     ▼
                                   agent: book_visit(jobId | customerId+title, no times) → untimed visit
                                          "Created. Place it? Send someone?"
```

## Decisions

- **Ask first, not create-first** *(user, 2026-09-06)* — amends "create, don't stage". Stated
  cost: nothing reaches the schedule without a yes; latency = one heartbeat tick.
- **The judgment is one extractor field** *(user)* — `ExtractedFields.visitCommitted`; zero
  extra model calls; one prompt serves notes, transcripts and email.
- **No job is built for a committed capture** *(user: "before going from call to job to visit")*.
  An UNcommitted `new_job` call still builds customer + job as today. A committed capture stops
  after identity, **after the attach**: if it links to a live visit it is correspondence about
  booked work and no ask is raised (review #7). Otherwise it becomes an observation carrying the
  customer and — when one exists — the open job, so the agent books ON that job (review #8).
- **Matched customers only** *(overview §5)*. An unmatched committed call keeps today's
  `unlinked_call` review; no seat verb can create a customer. FOLLOW-UP: the new-caller path.
- **The ping is an off-cadence override, not a new process** — the heartbeat already ticks every
  5 min with the planner's credentials. An open, un-held `inbound_commitment` noticed since the
  firm's last successful planner run makes the firm due on the next tick. Rejected: running the
  planner from `Calls-worker`/the webhook (no model env there; a webhook must answer in 300 s).
- **The ask is a TEXT, gap-less, plus a hold in the same plan** *(review #1, #2)* — the
  `assistant` leg injects a turn nobody delivers (`Box_Setup_Stuff/office-runner.sh:13-16`), so the
  send is `as:'chat'`, `to:` a manager, `nudgeId` omitted; the rails allow `hold` on the
  observation in the same plan only because the send names no gap. The message names the
  customer and the work and **never a day or time** — the date rail drops weekday names
  (review #3); the caller's words stay in the record.
- **Closing is code-authorised** — `mootFactFor` gains a fact for this kind: a confirmed visit
  created after `noticed_at` on the named job (or, jobless, for the customer). `dismiss` follows
  a manager's no via `inform_team_lead`.
- **The observation's subject is the capture id, author `detector`** — once-ever dedup; the
  capture is "processed" for `captureHasLinkedL2`. The stale-forward-signal gap stays open for
  *uncommitted* inbound (research §6) — recorded.
- **Technician report on a committed visit** waits for rung 12 *(user)*. **Web form** out *(user)*.
- **Delete `ingestEmail`** and drop `googleapis` (its only importer) rather than teach a dead copy.
- **Pilot deploy needs NO migration.** Fork sync → 5 services → AGENTS.md refresh on six seats.

## Plain-language walkthrough

**Phase 1 — the eye.** The extractor gains a yes/no: *did the business agree to send someone
out?* When it says yes for a call or email from a customer we know, the write path first tries
to attach the words to a visit that already exists (a "see you Tuesday" about a booked trip is
evidence, not a new request). If nothing attaches, it writes an **observation** — a row in the
planner's own record saying "this capture is a commitment" — with the customer, what was asked,
the existing open job if there is one, and where the words are. No job is created. You'd see a
new `v_observations` row of kind `inbound_commitment`, and nothing new in the tray.

**Phase 2 — the ping.** The planner thinks on a grid (:00/:30 in the firm's hours). A fresh
commitment makes the firm due on the **next heartbeat**, so the ask goes out within five
minutes of the capture finishing (a call also waits for transcription). The planner sees the
commitment in its gap view with the caller's snippet and a pointer to the transcript, and its
doctrine says: text the manager once — customer and work, no dates — and hold the observation
so it isn't asked twice; close it when the record shows a visit was booked, dismiss on a no.

**Phase 3 — the hands, and the record.** The manager's agent learns the reply: on "yes", find
the customer from the office's text and run `book_visit` with the job id the office named (or
customer + title for new work), no date and no times — the visit books untimed and, for new
work, the job is minted in the same call — then offer placement and a person. On "no", tell the
office. Docs stop saying rung 10 creates visits silently; the dead Gmail pull goes.

## Secrets & env preflight
- **Phase 1:** none new (`INFERENCE_MODEL` + the spine model key — already required).
- **Phase 2:** `PLANNER_MODE=live` on `lifecycle-heart` — already set.
- **Phase 3:** none. Deploy: fork push rights; `ssh tradesbox` — already held.

## Phase 1: The eye — the extractor names a commitment; the write path attaches or records it

### What this phase does
Adds `visitCommitted` to the extractor. In `recordFieldNote`, a committed non-technician
capture on a matched customer attaches to a live visit if one fits; otherwise it becomes an
`inbound_commitment` observation. Uncommitted captures behave exactly as today.

### Changes required

**`src/writePath/extract.ts`** — `ExtractedFields` (`:8-24`): add `visitCommitted?: boolean | null`.
`EXTRACTION_SYSTEM` (`:32-38`): widen "a trades technician field note" to "a technician field
note, an inbound phone-call transcript, or a customer email" and add: *"Set `visitCommitted`
true ONLY when the BUSINESS agreed to send someone out — never because the caller asked for one,
requested a quote, or the outcome is undecided."* `EXTRACTION_TOOL` (`:41-71`): add the boolean;
**export** the const so a test can pin the schema.

**`src/db/reviewItems.ts`** — `ReviewKind` (`:10-63`): add `| 'inbound_commitment'` — the
extractor's finding; subject = the L1 capture id; never a review item, never swept.

**`src/db/observations.ts`** — add `captureHasObservation(captureId): Promise<boolean>`
(`kind='inbound_commitment' and subject_ref=captureId`, any status, `limit(1)`).
**`src/db/rawCaptures.ts`** — `captureHasLinkedL2` (`:137-155`): final arm
`return await captureHasObservation(captureId)` (function-level import; no cycle rule exists).

**`src/writePath/recordFieldNote.ts`**
- `RecordFieldNoteResult` (`:73-82`): add `observationId?: string`.
- Hoist `isTechnicianChannel` (`:297-298`) above job resolution. Replace the job block
  (`:268-283`) with: resolve `job` from the matcher or the most recent non-terminal job as today,
  but **do not `createJob` yet**. Then:
```ts
if (!isTechnicianChannel && extracted.visitCommitted === true) {
  // RUNG 10 — THE EYE. Attach first: a commitment about a trip already on the
  // schedule is evidence, not a new request (review #7). Only then observe.
  if (job) {
    const r = await resolveVisitForNote({ …as below, jobId: job.id, mayCreate: false });
    if (r.visit) { await insertVisitNote({ tenantId, visitId: r.visit.id, captureId });
      return { status: 'matched', captureId, customerId, jobId: job.id, visitId: r.visit.id,
               stage: stageOf(r.visit, true) }; }
  }
  const obs = await createObservation({
    tenantId, kind: 'inbound_commitment', subjectRef: captureId, technicianId: null,
    context: { captureId, customerId, channel, occurredAt: input.occurredAt ?? null,
      customerName: (await getCustomer(customerId))?.name ?? null,
      from: fromOf(input.sourceMeta),                 // sourceMeta.from | sourceMeta.fromNumber
      ...(job ? { jobId: job.id, jobTitle: job.title } : {}),
      asked: { jobTitle: extracted.jobTitle ?? null, jobType: …, address: …, city: …,
               workPerformed: …, followUp: … },
      snippet: rawText.slice(0, 240) },
  });
  return { status: 'matched', captureId, customerId, ...(job ? { jobId: job.id } : {}),
           ...(obs ? { observationId: obs.id } : {}) };
}
if (!job) job = await createJob({ …as today });
```
  `context.jobId` is what makes the gap view print `job id:` and inherit evidence (build 7).

**Tests** — `src/writePath/recordFieldNote.test.ts` (widen `noteBy`'s channel union at `:123`
with `'phone_call'`; afterAll `:35-39` must also truncate `observations` — review #5):
(1) committed email, matched customer, no job → one observation (`subject_ref=captureId`,
`context.customerId`, `context.asked.jobTitle`, no `jobId`), job/visit counts unchanged,
`observationId` set; (2) committed `phone_call`, customer with an open job and no live visit →
observation carries `context.jobId`, no new job; (3) committed email on a customer whose job has
a live placed visit today → `visitId` returned, one `visit_notes` link, NO observation; (4)
uncommitted email → job created as today, no observation; (5) redelivery of (1) → `duplicate`,
extractor spy not called, still one observation; (6) unmatched committed call →
`needs_disambiguation`, no observation; (7) `technician_note` with `visitCommitted:true` → the
walk-in path unchanged. `src/db/observations.test.ts`: `captureHasObservation`. A schema pin:
`EXTRACTION_TOOL.inputSchema.properties.visitCommitted.type === 'boolean'`.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] tests (1)–(7) pass; falsify (1) by deleting the observation branch → fails on the job count;
      falsify (3) by moving the branch above the attach → fails on the link count
### Live verification — none until Phase 3. ### Manual verification — none. *Continue.*

## Phase 2: The ping — the planner wakes for a commitment, sees it, and knows the one move

### What this phase does
A fresh commitment overrides both cadence gates; the gap view renders it; a code-computed fact
lets the planner close it; the doctrine names the single legal move.

### Changes required

**`src/db/observations.ts`** — `listTenantIdsWithFreshCommitments(sinceIso)`: distinct
`tenant_id` where `kind='inbound_commitment' and status='open' and noticed_at > since and
(not_before is null or not_before <= now())` — a HELD row does not ping (review #4). Paged.

**`src/db/visits.ts`** — `listVisitsCreatedSince(tenantId, sinceIso)`: `{ id, job_id,
customer_id, created_at }` via `jobs!inner(customer_id)`, status in confirmed/completed,
`created_at > since`, paged. One tenant-wide read bounded by the oldest open commitment; no
`in()` over ids (review #9).

**`src/jobs/lifecycle.ts`** — add `listFreshCommitments?` to the deps interface (`:79` region).
Do NOT touch `plannerTick` at `:452`. In the planner branch, replace the `!plannerTick` arm
(`:481-482`) with a lazy check INSIDE the branch: `else if (!plannerTick && !(await
freshPing()))` where `freshPing` calls the dep with `now − 35 min`, try/caught → `false` +
`console.error` (the grid still runs at :00/:30; a real DB fault surfaces as `tenantErrors`
there). Skip text becomes `'off-cadence tick (no firm due, no fresh commitment)'`.

**`src/teamLead/planner.ts`**
- Per-tenant due check (`:3652-3656`): hoist the tick's existing `lastRunAt` read (the guarded
  one at `:3942-3966`) above it, keep its try/catch (failure ⇒ not pinged, review #10);
  `pinged = openObs.some(o => o.kind === 'inbound_commitment' && (!o.not_before ||
  Date.parse(o.not_before) <= nowMs) && Date.parse(o.noticed_at) > lastMs)`; skip becomes
  `if (!pinged && !plannerCadenceDue(nowIso, everyMinutes))`. `PlannerSummary` (`:367`) gains
  **optional** `pingedByCommitment?: number`, set only when nonzero (the `memoryTableMissing`
  pattern — three test fixtures build the literal, review #6).
- `buildGapView` (`:1181`, after `:1313-1326`): for `n.kind === 'inbound_commitment'` print
  `  a ${channel} committed the firm to a visit — from ${from}: "${snippet}"`,
  `  they asked for: ${asked.jobTitle ?? 'unstated'} at ${asked.address ?? 'unstated address'}`,
  `  customer: ${customerName} (id ${customerId})`, and
  `  capture id: ${captureId}  (spine_read v_captures for the exact words)`. `ctxStr`, all nullable.
- `mootFactFor`: read `listVisitsCreatedSince(tenantId, minNoticedAt)` once for the tenant's
  open commitments; per observation, a row with `created_at > noticed_at` on `context.jobId`
  (or on `context.customerId` when jobless) ⇒ `'a visit was booked for this after it was
  noticed'` — the fact that authorises `close` with `basis:'record'`.

**`src/teamLead/plannerPrompt.ts`** — in `PLANNER_SYSTEM` after the closing doctrine
(`:186-208`), a paragraph **COMMITMENTS FROM CALLS AND EMAIL**: the extractor heard the firm
agree to come out; NOTHING exists yet and you create nothing. The one move: a `send` with
`as:'chat'`, `to:` a manager (REQUIRED — this gap names nobody), **no `nudgeId`**, message in the
shape *"I noticed you had a call from ‹customer› about ‹work›. Want me to create the job and a
visit now?"* — name the customer and the work exactly as the gap view prints them; **never a
day or a time** (the caller's words are in the record; the manager's agent can read them). In
the SAME plan, `hold` the observation for 24h so it is not asked twice. Close with basis
"record" when THE RECORD says a visit was booked; `dismiss` when a seat reports a no.

**Tests** — `src/teamLead/planner.test.ts`: (8) an open commitment noticed after `lastRunAt`
makes a 09:45 tick run for a firm with hours 8-16 (`planned:1`, `pingedByCommitment:1`); (9)
noticed before `lastRunAt`, or held, → skipped; (10) the gap view prints the four lines; (11)
`mootFactFor` text when a visit was created after `noticed_at` on the job, and NOT for an
earlier one; (12) a plan `[send{as:'chat', to, no nudgeId}, hold{observation}]` applies both;
(13) the prompt contains "COMMITMENTS FROM CALLS AND EMAIL". `src/jobs/lifecycle.test.ts`:
add `listFreshCommitments: async () => []` to `STUBS` (`:796`, review #5); extend the
coarse-gate test at `:877`: with `['t1']` an off-cadence tick calls `runPlanner`, with `[]` it
skips with the new string.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] tests (8)–(13) pass; falsify (8) by removing `!pinged &&` → it must fail
### Live verification — none until Phase 3. ### Manual verification — none. *Continue.*

## Phase 3: The hands, the record, and the deploy

### What this phase does
Teaches the manager's agent the reply, rewrites the record, deletes the dead path, deploys.

### Changes required

**`Box_Setup_Stuff/bootstrap-box.sh`** — inside the confirmation heredoc (`:701-738`), rule
**7**: *When the office texts that it noticed a call or email in which we agreed to come out and
asks whether to create the job and a visit: the office's text is in this chat above — take the
customer name and the work from it, `find_customer` for the id. If the office named an existing
job, `book_visit` with that jobId; otherwise with customerId and the work as title. Pass NO
date and NO times (the visit books untimed; for new work the job is minted in the same call).
If book_visit refuses with a list of open jobs, re-call with the matching jobId. In the same
reply, offer to place it and to send someone. If the manager says no, `inform_team_lead` in one
sentence. Never create it before they answer.* No new `##` heading (`src/eval/doctrine.ts:28`).

**`docs/nemoclaw-tech-agent.md`** (`:190-212`): mirror rule 7 as a bullet; rewrite
`:299-311` (the Gmail-pull description) to the webhook-only truth.

**Delete `src/email/ingest.ts`, `src/email/ingest.test.ts`**; `npm uninstall googleapis`
(`package.json:53`; `src/routes/googleRoutes.ts` uses only a URL string). Reword the
`ingestEmail` mentions at `src/email/classify.ts:15,44`, `src/teamLead/planner.ts:923`,
`src/teamLead/planner.test.ts:3305`, `docs/engineering-memory.md:1933, :5070` (review #11).

**Docs** — `docs/engineering-memory.md`: ladder row `:3573` → `10 inbound commits a visit —
ASK FIRST: extractor → observation → planner texts → manager's agent books [BUILT …; §10]`;
rewrite `:5064-5077` to the ask-first shape, dated 2026-09-06; `:4558`, `docs/onboarding.md:307`,
`docs/nemoclaw-tech-agent.md:277` → "rung 11"; a `### ✅ BUILT — rung 10` record in
`- **Title**` bullets (the new-caller follow-up; the open uncommitted-redelivery gap; the
chat-leg finding). `docs/Three-Layer-Context-Spine-Overview.md` §4 (`:121-157`): one sentence.
`npm run decisions:index`; commit the regenerated files.

**Deploy (owner's call):** fork sync → deploy `TradesDatabase`, `lifecycle-heart`,
`Board_Worker`; all five `live`; `bootstrap-box.sh wire s2` (md5 the repo copy first), read rule
7 back with `docker exec … grep "Never create it before" …/AGENTS.md`, `nemoclaw s2 gateway
restart`, then s3 s5 s6 s7 s8. No migration.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] `src/eval/doctrine.test.ts` green; `grep -rn "ingestEmail\|email/ingest\|googleapis" src scripts docs package.json` → 0
### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP, `ssh tradesbox`, a paired manager mailbox on the pilot, and
  ONE human action: the owner emails that mailbox from a known customer's address saying the
  firm will come out ("we'll be there Tuesday to look at the heater").
- [ ] pilot: newest `observations` row is `inbound_commitment` / `open` with that customer's name.
- [ ] the next `lifecycle_runs` summary shows `teamLeadPlanner.pingedByCommitment >= 1` on an
      off-grid minute.
- [ ] `office_messages`: a `to_agent` row from `spine:team-lead`, `via='chat'`, naming the customer
      and containing NO weekday; the manager's phone shows the text.
- [ ] after the manager replies yes: one new `visits` row for that customer, `starts_at is null`,
      `status='confirmed'`, `booked` event `detail.untimed=true`; the observation closes on the
      following planner run with the record-basis resolution.
### Manual verification
- [ ] The manager judges the text says what the caller said, not more, and that their agent's
      "yes" handling found the right customer without asking again.
