---
date: 2026-09-06
task: Rung 10 — inbound commits a visit, ASK FIRST. The extractor is the planner's eye on call → job → visit; a detected commitment calls the planner IMMEDIATELY for that one item (a focused pass, ~10 s); the planner decides in its own words whether to text the manager; the manager's own agent creates the job and an untimed visit with book_visit.
research: thoughts/shared/research/2026-09-06-rung-10-inbound-commits-a-visit.md
status: draft
supersedes: nothing as a document — AMENDS the 2026-09-03 ruling "create, don't stage" at docs/engineering-memory.md:5064-5077 and the ladder row at :3573. User, 2026-09-06: "Before creating the visit, someone gets asked"; "the planner should be specifically called for the one issue".
---

**`supersedes:` is not optional bookkeeping.** No thoughts/ document is overturned. The ruling
this plan changes lives in `docs/engineering-memory.md`; Phase 3 rewrites it in place.

## Overview

Every call and email lands in L1, runs the extractor, matches the customer, builds customer +
job. Nothing lets inbound create a *visit* (`mayCreate`, `attachNote.ts:52`). The user's
direction: the extractor is the **planner's eye**, and this is the first time an input path can
yield an *actionable* object, so the planner is called the moment a commitment is detected —
before any job or visit exists, for that one item only — and decides. The manager's agent then
creates both with the verb it already has.

```
call / email ─► L1 ─► extractor ─visitCommitted─► attaches to a LIVE visit? ──yes──► link, done
                       │ false                        │ no
                       ▼                              ▼
             customer + job as today      OBSERVATION kind=inbound_commitment (words, customer, open job?)
             (unscheduled-jobs tray)                  │  Calls-worker's ping loop CLAIMS it (pinged_at), ~10 s
                                                      ▼
                        FOCUSED PLANNER PASS — this item only, own notes + doctrine + verbs, ≤180 s
                        usual move: send{as:'chat', to: a manager} in its own words; the send marks asked_at
                                                      │ manager: "yes" (a normal turn to their agent)
                                                      ▼
                        agent: book_visit(jobId | customerId+title, no times) → job + untimed visit
                        heartbeat :00/:30 = the fallback if the worker is down (same asked_at guard)
```

## Decisions

- **Ask first, not create-first** *(user)* — amends "create, don't stage". Nothing reaches the
  schedule without a yes.
- **The judgment is one extractor field** *(user)* — `visitCommitted`; zero extra model calls.
- **No job is built for a committed capture** *(user)*. Uncommitted `new_job` calls build
  customer + job as today. A committed capture stops after identity **and after the attach**:
  linked to a live visit ⇒ correspondence about booked work, no ask. Otherwise an observation
  carrying the customer and, when one exists, the open job.
- **Matched customers only** (overview §5). Unmatched ⇒ today's `unlinked_call`. **Rung 10b, stacked
  after this** *(user 2026-09-07)*: an `inbound_unmatched` observation through the SAME ping loop (one
  observation per capture, `visitCommitted` carried inside it), the planner as the second opinion via
  `spine_read`, and a manager `add_customer` verb that re-runs the one door with the identity resolved,
  ask-first. So every helper below is kind-blind and reads `PINGED_KINDS`: 10b appends a kind, nothing else.
- **Immediate, and about one thing** *(user, both)*. The always-on process is `Calls-worker`
  (the web service is Render free-plan and spins down). A second loop in the same process polls
  for unclaimed commitments and runs a **focused pass**: `runPlanner` for one tenant with the
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
  whether to create the job and a visit, in the planner's words. Rails that stay: `to` required,
  `as:'chat'` (the `assistant` leg injects a turn nobody delivers), `countsAsTheAsk` omitted, and
  **never the caller's day or time** — the date rail drops them, and no clock label is added for
  this kind because it would re-legalise the caller's weekday (round-2 #5).
- **Closing is code-authorised** — a confirmed visit created after `noticed_at` on the named job
  (or for the customer). `dismiss` follows a no via `inform_team_lead`.
- **Subject = capture id, author `detector`**; processed for `captureHasLinkedL2`. The
  uncommitted-inbound redelivery gap stays open — recorded.
- **Technician report on a committed visit** → rung 12 *(user)*. **Web form** out *(user)*.
- **Delete `ingestEmail`** and `googleapis` (its only importer).
- **Deploy pair:** the additive migration goes BEFORE the fork sync; five env names go onto
  `Calls-worker` first; `database.types.ts` is regenerated from the LOCAL stack (`gen:types`
  targets the pilot and would write the old schema — round-2 #2).

## Plain-language walkthrough

**Phase 1 — the eye.** The extractor gains a yes/no: *did the business agree to send someone
out?* When it says yes for a customer we know, the write path first tries to attach the words to
a visit that already exists. If nothing attaches, it writes an **observation** in the planner's
own record: the caller's words, who they are, what they asked for, the open job if any. No job
is created. You'd see a new `v_observations` row and nothing new in the tray.

**Phase 2 — the focused pass.** Within seconds the call worker claims the observation and calls
the planner *about that one thing* — the same planner as at :00/:30, with its notes, shown only
this item, on a three-minute budget. It reads the words and decides in its own words; usually a
text to the manager asking whether to create the job and a visit. The text marks the item asked
so nobody asks twice; a booked visit closes it; a no dismisses it. The half-hourly pass is the
fallback and cannot double-text.

**Phase 3 — the hands, and the record.** The manager's agent learns the reply: on "yes", find
the customer from the office's text and book untimed on the job the office named (or customer +
title); offer to place it and send someone. On "no", tell the office. Docs stop saying rung 10
creates visits silently; the dead Gmail pull goes.

## Secrets & env preflight
- **Phase 1:** none new.
- **Phase 2:** on Render `Calls-worker` (`srv-d9qelh710e5c739hb8vg`) add, copied from
  `lifecycle-heart`: `INFERENCE_MODEL`, `INFERENCE_BASE_URL`, `INFERENCE_CACHE_KEY`,
  `MODEL_PROVIDER`, `PLANNER_MODE` (it has `INFERENCE_API_KEY`, `SUPABASE_*`, `BOARD_BOT_TOKEN`).
  Names only — never paste values.
- **Phase 3:** none. Deploy: fork push rights; `ssh tradesbox`; `supabase-test` MCP.

## Phase 1: The eye — the extractor names a commitment; the write path attaches or records it

### Changes required

**`src/writePath/extract.ts`** — `ExtractedFields` (`:8-24`): `visitCommitted?: boolean | null`.
`EXTRACTION_SYSTEM` (`:32-38`): widen to "a technician field note, an inbound phone-call
transcript, or a customer email"; add *"Set `visitCommitted` true ONLY when the BUSINESS agreed
to send someone out — never because the caller asked, requested a quote, or it is undecided."*
`EXTRACTION_TOOL` (`:41-71`): add the boolean; **export** the const for a schema pin.

**`src/db/reviewItems.ts`** — `ReviewKind` (`:10-63`): `| 'inbound_commitment'`.

**`supabase/migrations/20260908100000_observations_commitment_marks.sql`** — `alter table
observations add column if not exists pinged_at timestamptz, add column if not exists asked_at
timestamptz;` + a partial index on `(tenant_id, noticed_at) where
status='open' and pinged_at is null` (kind-blind, for 10b). Comments: `pinged_at` = the planner was called about it;
`asked_at` = a text went out. Additive; applied to the pilot BEFORE the deploy.
**`src/db/database.types.ts`** — regenerate with `npm run gen:types:local` after `supabase db
reset` (NEVER `gen:types`); commit it.

**`src/db/observations.ts`** — `captureHasObservation(captureId)`; `PINGED_KINDS: ReviewKind[] = ['inbound_commitment']` (10b appends);
`listUnpingedObservations(kinds, limit)` (open, kind, `pinged_at is null and asked_at is null`, oldest
first, fleet-wide); `claimObservationPing(id)` — guarded `set pinged_at=now() where id and
pinged_at is null`, null = taken; `markObservationAsked(id, notBeforeIso)` — guarded `set
asked_at=now(), not_before=… where id and status='open' and asked_at is null`, null = already
asked; `stampObservationsPinged(ids)` — best-effort, `where pinged_at is null`.
**`src/db/rawCaptures.ts`** — `captureHasLinkedL2` (`:137-155`): final arm `captureHasObservation`.

**`src/writePath/recordFieldNote.ts`** — `RecordFieldNoteResult` (`:73-82`): `observationId?`.
Hoist `isTechnicianChannel` (`:297-298`), `technician`, `timezone` above job resolution; resolve
`job` as today (`:268-274`) but **do not `createJob` yet**; then:
```ts
if (!isTechnicianChannel && extracted.visitCommitted === true) {
  // RUNG 10 — THE EYE. Attach first (a commitment about a booked trip is evidence);
  // only then observe. Nothing is created here — that is the point.
  if (job) {
    const r = await resolveVisitForNote({ tenantId, jobId: job.id, technicianId: technician?.id ?? null,
      capturedAt, timezone, captureId, mayCreate: false });
    if (r.visit) { await insertVisitNote({ tenantId, visitId: r.visit.id, captureId });
      return { status: 'matched', captureId, customerId, jobId: job.id, visitId: r.visit.id, stage: stageOf(r.visit, true) }; }
  }
  const obs = await createObservation({ tenantId, kind: 'inbound_commitment', subjectRef: captureId,
    technicianId: null, context: { captureId, capturedAt, customerId, channel,
      customerName: (await getCustomer(customerId))?.name ?? null, from: fromOf(input.sourceMeta),
      ...(job ? { jobId: job.id, jobTitle: job.title } : {}),
      asked: { jobTitle, jobType, address, city, workPerformed, followUp } /* from extracted, nulls kept */,
      words: rawText.slice(0, 1500) } });
  return { status: 'matched', captureId, customerId, ...(job ? { jobId: job.id } : {}), ...(obs ? { observationId: obs.id } : {}) };
}
if (!job) job = await createJob({ …as today });
```

**Tests** — `src/writePath/recordFieldNote.test.ts` (widen `noteBy` at `:123` with
`'phone_call'`; afterAll `:35-39` also truncates `observations`): (1) committed email, matched
customer, no job → one observation (`subject_ref`, `context.customerId`, `context.words`, no
`jobId`), job/visit counts unchanged, `observationId`; (2) committed `phone_call`, open job, no
live visit → `context.jobId`, no new job; (3) committed email on a job with a live placed visit
today → `visitId`, one `visit_notes` link, NO observation; (4) uncommitted email → job as today;
(5) redelivery of (1) → `duplicate`, extractor spy not called; (6) unmatched committed call →
`needs_disambiguation`, no observation; (7) `technician_note` + `visitCommitted:true` → walk-in
unchanged. `observations.test.ts`: the five helpers, second claim/ask null. Schema pin on
`EXTRACTION_TOOL`.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`; `supabase db reset` clean;
      `git diff --stat src/db/database.types.ts` shows the two columns
- [ ] (1)–(7) pass; falsify (1) by deleting the branch → job count; (3) by moving it above the attach
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
`listUnpingedObservations(PINGED_KINDS, 1)` → `claimObservationPing` → `runFocusedObservationPass`; a throw is
logged, never rethrown; the claim stays (the heartbeat is the fallback). **`src/calls/runWorker.ts`**
(`:14-27`): `main` becomes `Promise.all([callLoop(), pingLoop()])` — two independent loops, each
with its own backoff (round-2 #4).

**`src/teamLead/planner.ts`**
- `PlannerDeps` (`:542`): `focus?: { observationId: string; budgetMs: number }`. In focus: skip
  `plannerRun`; pass `budgetMs` into the `runLoop` request; the user message's `This firm has N
  open gap(s).` (`:2951`) becomes *"This pass shows 1 item; the firm's other open work is not
  shown and is not yours now."* (round-2 #6); `PlannerSummary` (`:367`) gains optional
  `focused?: true`, `pingedByObservation?`.
- Per-tenant due check (`:3652-3656`): focused ⇒ due; else `pinged = openObs.some(o => PINGED_KINDS.includes(o.kind)
  && !o.pinged_at && !o.asked_at && noticed_at > lastMs)` with the guarded
  `lastRunAt` read hoisted from `:3942-3966` (failure ⇒ not pinged); `if (!pinged &&
  !plannerCadenceDue(…))`. After a SUCCESSFUL non-focused pass, `stampObservationsPinged` on the
  commitments it showed (best-effort).
- `buildGapView` (`:1181`, after `:1313-1326`) for this kind: `  the caller's words (${channel},
  from ${from}, ${agoLabel}): "${words}"`, `  customer: … (id …)`, `  they asked for: …`, `  on
  file: open job … (job id …) | no open job — a job would be created`, `  capture id: … (spine_read
  v_captures for the full words)`, and when `asked_at`: `  you texted a manager about this ${ago}`.
  No clock label; `dateLabels` unchanged.
- `apply` `case 'send'` (`:3017`): for this kind, FIRST `markObservationAsked(id, now + 24h)`;
  null ⇒ `{ outcome: 'refused', detail: 'already asked' }`; then the office row `via: 'chat'`.
  Validate: `as` must be `'chat'`, `to` present, `countsAsTheAsk` absent.
- `mootFactFor`: `listVisitsCreatedSince(tenantId, minNoticedAt)` (new in `src/db/visits.ts`:
  `{ id, job_id, customer_id, created_at }` via `jobs!inner`, confirmed/completed, paged); per
  observation a row after `noticed_at` on `context.jobId` (or the customer) ⇒ `'a visit was
  booked for this after it was noticed'`.

**`src/jobs/lifecycle.ts`** — `LifecycleDeps` (`:79` region): `listFreshPings?`. Keep
`:452`; the `!plannerTick` arm (`:481-482`) becomes a lazy `else if (!plannerTick && !(await
freshPing()))` — the dep over `now − 35 min`, `pinged_at is null and asked_at is null`,
try/caught ⇒ false + log. Skip text: `'off-cadence tick (no firm due, no unclaimed commitment)'`
(update the pin at `lifecycle.test.ts:903`).

**`src/teamLead/plannerPrompt.ts`** — after the closing doctrine (`:186-208`), **COMMITMENTS
FROM CALLS AND EMAIL**: what it is (the extractor heard the firm agree to come out; the words
are shown; nothing has been created, deliberately — you decide); what can happen (the manager's
agent can create the job if none and an untimed visit with `book_visit` when the manager says so;
you cannot); the usual move (`send` a manager, `as:'chat'`, `to` required, no `countsAsTheAsk`,
asking in your own words whether to create the job and a visit — who, what, the open job if any);
when not to (booked on THE RECORD — close; not a commitment — dismiss with a reason); rails
(never the caller's day or time — the record keeps them; the send marks it asked; `hold` to wait).

**Tests** — `planner.test.ts`: (8) focus: one item shown, `plannerRun` not called, the focus line
present and the firm-count line absent, `focused:true`, `budgetMs` reaches `runLoop`; (9) heartbeat:
unpinged + unasked after `lastRunAt` makes 09:45 run (hours 8-16); pinged, asked, or earlier ⇒
skipped; a successful pass stamps `pinged_at`; (10) gap-view lines, no weekday anywhere; (11)
`mootFactFor` after vs before; (12) `send` sets `asked_at`; a second `send` refused; `hold` then
`send` on a later tick succeeds; `as:'assistant'` refused; (13) the heading. `lifecycle.test.ts`:
`listFreshPings: async () => []` in `STUBS` (`:796`); extend `:877`. `observationPing.test.ts`:
claim → pass once; second claim null; a throwing pass keeps the claim.

### Automated verification
- [ ] gates green; (8)–(13) + worker tests pass; falsify (12) by removing the guard → double send
### Live verification — none until Phase 3. ### Manual verification — none. *Continue.*

## Phase 3: The hands, the record, and the deploy

### Changes required

**`Box_Setup_Stuff/bootstrap-box.sh`** — inside the confirmation heredoc (`:701-738`), rule
**7**: *When the office texts about a call or email in which we agreed to come out and asks
whether to create the job and a visit: the office's text is above in this chat — take the
customer and the work from it, `find_customer` for the id. If it named an existing job,
`book_visit` with that jobId; otherwise customerId + the work as title. NO date, NO times (the
visit books untimed; for new work the job is minted in the same call). If book_visit refuses
with open jobs, re-call with the matching jobId. Offer to place it and to send someone. On a no,
`inform_team_lead` in one sentence. Never create it before they answer.* No new `##` heading.

**`docs/nemoclaw-tech-agent.md`** (`:190-212`): mirror rule 7; rewrite `:299-311` to the
webhook-only truth. **Delete `src/email/ingest.ts`, `ingest.test.ts`; `npm uninstall googleapis`**
(`package.json:53`); reword `classify.ts:15,44`, `planner.ts:923`, `planner.test.ts:3305`,
`engineering-memory.md:1933, :5070`.

**Docs** — `engineering-memory.md`: ladder row `:3573` → `10 inbound commits a visit — ASK FIRST:
extractor → observation → focused planner pass → manager's agent books [BUILT …; §10]`; rewrite
`:5064-5077` (dated 2026-09-06); `:4558`, `onboarding.md:307`, `nemoclaw-tech-agent.md:277` →
"rung 11"; `rawCaptures.ts:177-182` ("Rung 10 closes that by letting inbound create a COMMITTED
visit") → the observation is a THIRD home for a committed capture; the link-less shape STAYS for an
uncommitted matched inbound with no live visit (10b/later). A `### ✅ BUILT — rung 10` record in `- **Title**` bullets (new-caller path = rung 10b;
uncommitted-redelivery gap; the silent `assistant` leg; the two markers). Overview §4
(`:121-157`): one sentence. `npm run decisions:index`.

**Deploy (owner's call):** 1. `apply_migration` the two columns on the pilot (additive); 2. set
the five env names on `Calls-worker`; 3. fork sync → deploy `TradesDatabase`, `lifecycle-heart`,
`Board_Worker` (the worker auto-deploys); all five `live`; 4. `bootstrap-box.sh wire s2` (md5 the
repo copy first), read rule 7 back, `nemoclaw s2 gateway restart`, then s3 s5 s6 s7 s8.

### Automated verification
- [ ] gates green; `doctrine.test.ts` green; `grep -rn "ingestEmail\|email/ingest\|googleapis" src scripts docs package.json` → 0
### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP, `ssh tradesbox`, Render logs for `Calls-worker`, a paired
  manager mailbox, and ONE human action: the owner emails it from a known customer's address
  saying the firm will come out.
- [ ] pilot: newest `observations` row is `inbound_commitment`/`open` with that customer;
      `pinged_at` set within ~30 s; `Calls-worker` logs one focused pass.
- [ ] `nudge_decisions` has the pass's `send` row keyed to that `observation_id`; `office_messages`
      has the `to_agent` row, `via='chat'`, naming the customer, NO weekday; the manager's phone
      shows it; `asked_at` is set.
- [ ] after the manager's yes: one new `visits` row, `starts_at is null`, `status='confirmed'`,
      `booked` event `detail.untimed=true`; the next :00/:30 pass closes it on THE RECORD and
      does NOT send again.
### Manual verification
- [ ] The manager judges the text says what the caller said, not more, and that their agent found
      the right customer without asking again.
