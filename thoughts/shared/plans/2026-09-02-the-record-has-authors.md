---
date: 2026-09-02
task: "Build 7 — the record has authors: the planner opens its own observations, and a seat's inform can become one"
research: thoughts/shared/research/2026-09-02-the-detectors-report.md
status: draft
supersedes: nothing
---

**`supersedes:` — nothing.** This plan overturns no earlier document. It implements §6a entry 7 as
reshaped by the user on 2026-09-02; the reshape is recorded in the research doc's ADDENDUM and in
§6a, and the entries it corrects (the "15 staged tokens" count, the dead-end kinds, the
`query_spine` residue) were corrected in place there rather than superseded.

## Overview

Build 7 gives the observation record a **second author**. Today exactly one thing may create an
observation — the detector sweep — and everything else the charter asked for has already shipped.
This plan adds a sixth planner verb, `observe`, and makes a seat agent's `inform_team_lead` a thing
the planner can turn into a standing item instead of a message read once and lost.

## Decisions

- **The seats are an eye, but the planner is the author** — USER RULING 2026-09-02. Options were a
  box-side `observe` tool versus the planner recording from an inform. Chose the planner: no write
  path from a sandbox, no attribution column, no volume brake, no new trust boundary, and build 5.5
  is reused whole. Direct seat writes are a later build.
- **Scope is subject + authorship** — USER RULING 2026-09-02. Contradiction detectors split to
  build 9 (`7 < 9`); `review_items` cleanup and `OBSERVATION_STALE_HOURS` stay out.
- **`uq_observations_subject_ever` becomes PARTIAL on `author='detector'`** — not dropped. The index
  compensates for the detector's blindness: it is stateless, runs every 5 min, and has no memory of
  what it noticed. The planner has no such blindness. Left whole, it would mean one planner
  observation per (kind, subject) **forever** — the failure `moneyEvents.ts:253` already documents
  on the sibling store.
- **Nothing brakes duplicate opens but doctrine** — USER CHOICE 2026-09-02, over a partial index on
  open rows and over a per-tick cap (which is the silent drop build 4 deleted). Consistent with
  builds 5 and 6. **Accepted cost, stated:** the gap list is the one unbounded block in the prompt
  and nothing refuses a runaway; the evaluation phase measures it.
- **A job is OPTIONAL on an observe** — USER CHOICE 2026-09-02. With a job it inherits evidence,
  money, the moot fact and the `job id` line free. Costs a uuid rail (Phase 2).
- **`observe` is a VERB, not a dispatched tool** — implementation decision. A tool would mutate
  durable state from inside the loop with **no post-loop validation stage**
  (`identity.ts:25-30`); a verb rides `validateDecisions` + `applyDecision` and lands in
  `nudge_decisions`, the corpus the evals read. The one-tick delay before the planner can act on
  what it opened is a feature.
- **The decision row keys to `observation_id`, not both-null** — implementation decision, and it has
  a consequence the reviewer caught. Keying it to what it created makes it retrievable by per-gap
  recall and lets `jobId` be stamped (the gap-less branch hardcodes `jobId: null` for a documented
  reason — `planner.ts:3858-3864`). **But `plannerSim.ts:646-648` coalesces `observation_id` into
  `nudge_id` before grading, and `gapLessAction` filters on `gapIdOf(d) === null`
  (`plannerEvalGraders2.ts:64-65, 107`) — so a keyed row can never match it, and `action:` cannot
  match either because the created id is not in `targets`.** Hence the next decision.
- **The corpus gets one new expectation key, `anyAction`** — implementation decision, forced by the
  one above. Six lines in `plannerEvalGraders2.ts`: match an applied action across all decisions
  with no key filter. Without it this build ships unmeasurable, and the 6.5 precedent is to delete a
  scenario rather than ship one that grades the wrong thing.
- **One reserved kind, `planner_observation`** — origin is carried by the new `author` column plus
  `context.fromOfficeMessageId`, so a second kind would encode the same fact twice.
- **The note skips the date rail, and that is safe** — `cleanPlannerText` couples the date check to
  every call (`planner.ts:1657-1663`). An observation note is never delivered, is not in
  `v_observations` (which selects no `context`), and is not a citation source. A date in a note
  still cannot reach a person: a message carrying it must pass that gap's own `dateLabels`. Phase 2
  pins exactly that, both directions.
- **`fromMessageId` is validated against THIS tick's unread ids** — implementation decision, from
  the review. It renders as provenance ("from a message from `<ref>`"), so an unchecked
  model-supplied id would let the planner attribute its own noticing to a person — the exact trust
  boundary Phase 3 says must survive. `fromRef` is taken from the resolved row, never from the model.

## Plain-language walkthrough

**Today** two small automated checks ("detectors") are the only things that can put an item on the
planner's list. A technician's assistant can *tell* the planner something — that already works — but
the message is read once and then gone forever.

```
BEFORE                                    AFTER
  detector ──► observation ──► the list     detector  ──► observation ──┐
                                            seat agent ──► inform ─────►├─► the list
  seat agent ──► inform ──► read once,          (the planner decides    │
                            then gone            which are worth keeping)┘
```

**Phase 1 — the record learns who wrote each row.** One new column saying whether a row came from a
detector or the planner, and the "notice this only once, ever" database rule narrows to apply only
to detectors. You would notice it working by nothing changing: detectors behave exactly as before.

**Phase 2 — the planner can open its own.** A sixth thing the planner may decide: `observe`. It
writes a sentence and usually the job it is about; next tick that appears on its list like any other
item, with that job's evidence and money attached, endable the same two ways. You would notice it
working when a gap block appears whose `kind` is `planner_observation`, carrying the planner's own
words.

**Phase 3 — the seats become an eye.** One sentence of the planner's instructions currently says a
seat's message *"takes no decision entry — decide only about gaps."* That is exactly what this build
overturns, so it is rewritten — carefully, because two other clauses in the same sentence are the
trust boundary and must survive: a seat's message is that person's **claim**, never the record's own
finding, and it can never fill or close anything. You would notice it working when a technician
mentions a problem in passing and it is still on the planner's list two days later.

## Secrets & env preflight

- **Phase 1:** none — local Supabase stack only (`.env.test`, already required).
- **Phase 2:** none.
- **Phase 3:** none. The optional live check reuses `.env` keys the pilot already requires; without
  `.env` the key-gated tests skip, which is the normal worktree state.

**Standing trap, every phase:** `npm run gen:types` is `--linked` = the **hosted pilot**. After a
local migration use `npx supabase gen types typescript --local > src/db/database.types.ts` and check
`git diff --stat` is ADDITIVE. See [[gen-types-points-at-the-pilot]].

---

## Phase 1: The record learns who wrote it

### What this phase does
Adds `observations.author`, narrows the once-ever index to detector rows, widens
`nudge_decisions_action_check` for Phase 2's verb, and adds `planner_observation` to the shared kind
vocabulary. **No behaviour changes** — the sweep defaults to `author='detector'` and its dedup is
bit-for-bit what it is today.

### Changes required

**`supabase/migrations/20260904110000_observations_author.sql`** (new, re-runnable throughout)
- `alter table observations add column if not exists author text not null default 'detector';`
- CHECK `author in ('detector','planner')` via the `pg_constraint` `do $$` idiom
  (`20260903130000_office_messages_via.sql:28-38`).
- The once-ever rule must become an INDEX — a table CONSTRAINT cannot be partial:
  ```sql
  alter table observations drop constraint if exists uq_observations_subject_ever;
  create unique index if not exists uq_observations_subject_ever
    on observations (tenant_id, kind, subject_ref) where author = 'detector';
  ```
  *Verified safe:* nothing references it by name — `createObservation` uses a bare `.insert()` plus
  `isUniqueViolation` (SQLSTATE 23505, which a partial unique index raises identically), there is no
  `onConflict`/`upsert` on `observations` anywhere, and the repo's only `pg_constraint`/`pg_indexes`
  assertions are `schema.test.ts:145-158` and `jobNotes.test.ts:212-217`, neither about this table.
- **FIFTH amendment** of `nudge_decisions_action_check` (drop/re-add — the fourth was
  `20260901160000_office_verbs.sql:15-18`): add `'observe'`.
- Header carries the DEPLOY-ORDER note and why the index is partial rather than dropped.

**`src/db/reviewItems.ts`** — add `| 'planner_observation'` to `ReviewKind` (after `job_cost_gap`,
~`:62`), noting it has no `NudgeKindSpec` and is deliberately absent from `NUDGE_KIND_SPECS` so the
sweep can never mint it.

**`src/db/observations.ts`**
- `CreateObservationInput` gains `author?: 'detector' | 'planner'`; write `input.author ?? 'detector'`.
- Amend `createObservation`'s header: the 23505 catch now only fires for detector rows.
- **Correct the stale claim at `:80-84`** (`listObservedSubjectRefs`) — it says the any-status read
  is what makes dismissal mean "stop showing me this", conflating two mechanisms (research Area 2).
  Restate: the index and this read are the DETECTOR's memory; dismissal hides a row from the
  PLANNER's `['open']` read.

**`src/db/database.types.ts`** — regenerate with `--local`.

**`v_observations` + `src/mcp/server.ts:816` — ADDED DURING IMPLEMENTATION, not in the plan.**
The Phase-1 verification made the omission plain: the view is `spine_reader`'s ONLY window on this
table — the surface doctrine points the planner at to find dismissed rows — and it could not say who
authored a row, in the phase whose title is "the record learns who wrote it". `author` is appended
LAST (what `create or replace view` requires), grants re-asserted, and the `SPINE_VIEW_CATALOG`
string the planner is actually SHOWN now lists it. Worded neutrally on purpose: Phase 1 must not
advertise a verb Phase 2 has not built yet.

### Automated verification
- [x] `npx supabase migration up` applies clean; re-applying is a clean 3-NOTICE no-op (replayed the file directly 3x)
- [x] `npx tsc --noEmit`, `npm run lint`, `npm test` pass — **2620** (2618 + 2 new); no existing test changed behaviour
- [x] new `observations.test.ts`: two `createObservation` calls with the same `(kind, subject_ref)`
      and `author:'planner'` both succeed with distinct ids; the same pair at the default author
      returns a row then `null`. **Mutation-checked both ways by the round-2 reviewer:** whole index
      → both new tests fail; `.eq('author','detector')` removed → the detector's-memory test fails
- [x] ACL probe: `observations` and `v_observations` stay revoked from `anon` / `authenticated`
      after the migration AND after the `create or replace view` (grants re-asserted in the file)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack only.
- [x] `indexdef` = `CREATE UNIQUE INDEX uq_observations_subject_ever ON public.observations USING
      btree (tenant_id, kind, subject_ref) WHERE (author = 'detector'::text)`; `pg_constraint` lookup
      returns 0 rows; CHECK = `((author = ANY (ARRAY['detector'::text, 'planner'::text])))`.
      **Behaviour tested, not inferred** (rolled-back txn): 2 planner rows on one triple both insert;
      2 detector rows → 2nd raises 23505; a detector + 2 planner rows coexist; 0 rows left behind.

### Manual verification
None.

---
*No manual items: continue to Phase 2.*

## Phase 2: `observe` — the planner opens its own

### What this phase does
Adds the verb end to end, and closes a latent hazard the new `jobId` field would otherwise expose.

### Changes required

**`src/teamLead/planner.ts`**
- Import `randomUUID` from `node:crypto` (nothing from that module is imported today).
- `PLANNER_ACTIONS` (`:144`) → six entries, adding `'observe'`.
- `PlannerDecision` (`:177`) gains `note?: string` and `jobId?: string`.
- `cleanPlannerText` (`:1638`) — add `skipDateRail?: boolean` to `opts`, guarding only the
  `TEMPORAL_RE` loop (`:1659-1663`). All existing callers pass object literals, so this is additive.
  Record the safety argument at the call site.
- `validateDecisions` — **two separate placements, and this is the part the review caught:**
  - *Gap-less branch* (`:1915`, today refuses everything but `send`): admit `observe`. Rails —
    `note` required, cleaned with `{label:'note', maxLen:500, skipDateRail:true}`; `jobId`, when
    present, must match `UUID_ISH_RE` (`:1537`). Push a fresh literal carrying `note`/`jobId` (every
    branch constructs its own — nothing spreads the raw decision). Do **not** add to `seen`.
  - *Gap-bound path*: refuse an `observe` that NAMES a gap. It must go **before the catch-all tail
    at `:2513-2530`** — that tail today carries only `hold` and evidence-basis `close`, and would
    otherwise accept an `observe` with no `note`, producing `context: { note: undefined }`.
- **The uuid rail is load-bearing, not hygiene.** `jobIds` is built unfiltered at `:3419-3421` and
  passed raw to `listEvidence` (`:3437`), `listMoneySince` (`:3457`) **and `listJobNoteMeta`
  (`:3524`)**; one malformed element rejects the whole PostgREST `in()`. The first two 400 the
  tenant's entire tick; the third is inside a try/catch and fails *quietly*, silently costing every
  gap its job-note line. Filter all three with `UUID_ISH_RE`, matching the moot reads at
  `:3473-3475`. Belt to the validate rail's braces. (`listCostEvents` at `:3451` is safe —
  `costJobIds` is pre-filtered to `kind === 'job_cost_gap'`.)
- `applyDecision` (`:2738`, **not exported**; 15 positional params, 2 call sites at `:3880` and
  `:3949`) — add a trailing `createObs: typeof createObservation = createObservation`; widen the
  belt at `:2770` to `d.action !== 'send' && d.action !== 'observe' && !d.nudgeId`; widen the return
  type with `createdId?: string`; add:
  ```ts
  case 'observe': {
    const row = await createObs({
      tenantId, kind: 'planner_observation', author: 'planner',
      subjectRef: d.jobId ?? randomUUID(),   // a LABEL for planner rows, not a dedup key
      technicianId: null,
      context: { note: d.note, ...(d.jobId ? { jobId: d.jobId } : {}) },
    });
    return row ? { outcome: 'applied', createdId: row.id } : { outcome: 'refused', detail: moved };
  }
  ```
- `runPlanner` — **the record path is the gap-less branch at `:3857-3894`**, not the gap-bound one:
  an observe has `d.nudgeId === null`, so it enters that fork, and its `continue` at `:3894` is
  unconditional. Changes there:
  - widen the local annotation `let res: { outcome…; detail?: string }` at `:3878` to carry
    `createdId?: string`, or `tsc` fails;
  - pass `createObservation` as the new trailing argument;
  - on `res.createdId`, push the record with `nudgeId: res.createdId`, `subject: 'observation'` and
    `jobId: d.jobId ?? null` instead of the branch's `base` (whose `nudgeId`/`jobId` are null and
    which sets no `subject`). `recordNudgeDecisions` routes on `subject` (`nudgeDecisions.ts:108-109`).
    A REFUSED observe keeps `base` — a both-null row, legal since 6.5.
- `buildGapView` (`:1138`) — make the `about:` line (**`:1266`**) conditional on `jobTitle` or
  `customerName`, falling back to `about: ${ctxStr(n,'note')}`. **Safe by construction:** both
  detectors always write both keys as non-empty strings (`watchers.ts:591-592`, `:660-661`) and
  `plannerSim.ts:256-265` seeds both, so no detector row's rendering can change and no test pins an
  `about:` string. Leave `person:` untouched — `person: unknown` is already reachable today.

**`src/jobs/watchers.ts`** — `PLANNER_JUDGMENT_ACTIONS` (`:142`) += `'observe'` (the file's own rule
at `:135-137`): an observe is a real judgment, so it must count as attention.

**`src/jobs/watchers.test.ts:1236`** — `expect(PLANNER_ACTIONS).toHaveLength(5)` → `6`. A hard-coded
literal the equality tests do not cover; without this `npm test` fails at the phase boundary.

**`src/teamLead/plannerPrompt.ts`** — `SUBMIT_PLAN_TOOL` enum (`:370`) += `'observe'`; new `note` and
`jobId` properties; and `nudgeId`'s description (`:361-367`) says "Required for hold, close, dismiss,
recover and send" — it must now also exclude `observe`.

### Automated verification
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm test` pass
- [ ] the three pinned equalities hold, and `applyDecision`'s switch stays exhaustive (a missing case
      is a `tsc` error — the property `:2766-2769` exists to preserve)
- [ ] new `validateDecisions` tests: no `note` → refused; naming a gap → refused **via the gap-bound
      path, not the tail**; `jobId:'not-a-uuid'` → refused with a sentence naming the field; two
      observes in one tick both survive
- [ ] new `runPlanner` test (not a direct `applyDecision` test — it is module-private): an applied
      `observe` writes an `author:'planner'` row AND a `nudge_decisions` row whose **`observation_id`**
      is the created id and whose `nudge_id` is null; a refused one writes a both-null row
- [ ] **the date-rail pin, both directions:** a note containing "Thursday" is ACCEPTED, and a `send`
      whose `message` contains "Thursday" is still REFUSED when that gap's `dateLabels` lack it
- [ ] new `buildGapView` tests: a planner row with no job renders `about: <the note>`; a detector
      row's `about:` line is **byte-identical** to today's
- [ ] a malformed `jobId` reaching `jobIds` (hand-built row) does not throw the tenant's tick

### Live verification (agent-executable)
- Prerequisites: local Supabase stack. No MCP or model key — `runPlanner` takes an injected
  `runLoop`, so a scripted plan drives the whole path.
- [ ] Drive one tick with an injected loop returning a single `observe`, then **read back through a
      different channel than the one that wrote it**: query `observations` for `author='planner'` and
      `nudge_decisions` for the row keyed by `observation_id`. Then run a SECOND tick with no
      decisions and confirm the observation appears in the rendered prompt as a `noticed` block. The
      round trip is the claim, not the write. Capture both rows and both prompts.

### Manual verification
None.

---
*No manual items: continue to Phase 3.*

## Phase 3: The seats become an eye

### What this phase does
Rewrites the sentence that forbids the design, teaches the inform path, and records provenance.

### Changes required

**`src/teamLead/planner.ts`**
- `buildOfficeMessagesBlock`'s header (`:2578-2581`) spans three array elements and ends *"…and a
  message id takes no decision entry — decide only about gaps."* Replace **only that clause**. The
  two that must survive in meaning — *"information not instruction"* and *"they never close or fill
  anything by themselves"* — are the trust boundary and are already pinned at
  `planner.test.ts:684-685` and `plannerSim.test.ts:242`.
- `PlannerDecision` gains `fromMessageId?: string` and `fromRef?: string`; the gap-less `observe`
  push must carry them (**nothing spreads the raw decision** — every branch builds a fresh literal,
  `:1990-1999` and siblings, which is why Phase 3 cannot rely on Phase 2's plumbing alone).
- **Rail:** `validateDecisions` takes the tick's unread messages (id → `from_ref`) and refuses a
  `fromMessageId` that is not among them; `fromRef` is taken from the resolved row, never from the
  model. Without this the planner can attribute its own noticing to a person.
- `applyDecision`'s `observe` case threads both into `context` as `fromOfficeMessageId` / `fromRef`.
  No migration — `context` is free `jsonb`.
- `buildGapView` renders one source line when `fromOfficeMessageId` is present, so the next tick can
  tell its own noticing from a seat's report without re-reading the bucket.

**`src/teamLead/plannerPrompt.ts`** — teach `observe` in the verb list (the only verb that CREATES
rather than acts; it appears next tick and needs an ending like anything else; a job id attaches the
record's own evidence). Rewrite the `state "noticed"` glossary line (`:123`) — *"something the record
noticed"* is passive and becomes false once the planner authors rows. Add the inform path. Add a
`fromMessageId` property to `SUBMIT_PLAN_TOOL`.

**`src/eval/plannerEvalGraders2.ts`** — add `anyAction?: string` to `ScenarioExpect` and grade it by
scanning `t.decisions` for `action === e.anyAction && outcome === 'applied'` with **no key filter**.
`gapLessAction` cannot serve: `plannerSim.ts:646-648` coalesces `observation_id` into `nudge_id`
before grading and `gapIdOf` (`:64-65`) then returns non-null, while `action:` only inspects
`targets`, which never contains a newly created id.

**`src/eval/plannerCorpus.ts`** — one `build7` scenario seeded with `officeMessages`
(`plannerSim.ts:185`, seeds `to_planner`/`unread`) where the right move is `observe`, graded with
`anyAction: 'observe'`. **Add `build7: 1` to `FAMILY_COUNTS` (`:1339-1352`)** — `plannerCorpus.test.ts:27-28`
asserts the map exactly and the total, so omitting it fails `npm test`. Note in the scenario's `why`
that, like every action expectation here, it grades only under the key-gated live runner.

### Automated verification
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` pass
- [ ] **doctrine pinned BOTH directions** with a CONTIGUOUS single-line phrase — `PLANNER_SYSTEM` and
      the office header are joined arrays, so a pin spanning a line break can never match (§6a entry
      6, lesson 2). Assert the new clause present AND *"takes no decision entry"* absent
- [ ] the two surviving clauses still render (their existing pins must stay green)
- [ ] `plannerCorpus.test.ts` passes, `FAMILY_COUNTS` included
- [ ] new tests: the source line renders only when `fromOfficeMessageId` is set; a `fromMessageId`
      not among this tick's unread messages is REFUSED; `fromRef` never comes from the model
- [ ] **render `PLANNER_SYSTEM` and the office block and READ them** before claiming the phase done —
      an edit script's exit code is not evidence it landed ([[read-the-rendered-artifact]])

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; a model key in `.env` optional (without it, drive an injected
  loop as in Phase 2 — a fresh worktree has no `.env` and those tests skip, which is expected).
- [ ] Seed a `to_planner` inform, run one tick, and confirm through a **separate read** that (a) the
      inform was marked read and (b) an observation exists carrying `context.fromOfficeMessageId`
      equal to that message's id. Run a second tick and confirm the observation is still on the list
      while the inform is gone from the block — that persistence past the drain is the entire point
      of the build. Capture both ticks' rendered prompts.

### Manual verification
- [ ] Read the rewritten office header and the `observe` doctrine as a person would: does a seat's
      message still read as somebody's claim rather than as the record speaking? A judgment about
      tone and trust framing that no assertion can make.

---
*Manual verification is non-empty: PAUSE after this phase and wait for the user.*

## Final gate

Run the bundled `/code-review` skill on the full diff. Fix Important findings, re-run every gate,
set `status: complete`, mark §6a entry 7 **BUILT**, amend [[seat-agents-are-an-eye]] and
[[observation-record-is-planner-kept]], and regenerate `npm run decisions:index`.

**Carried forward, not fixed here:** `listNudgesByStatus` does not page while its observation twin
does; the quiet-firm skip (`:3328`) makes a recover-only tick unreachable and this build makes that
state ordinary; `docs/observability-gaps.md` entries 1 and 2 are untouched.
