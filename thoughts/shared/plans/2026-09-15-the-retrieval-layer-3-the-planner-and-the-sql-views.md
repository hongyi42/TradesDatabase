---
date: 2026-09-15
task: The retrieval layer, plan 3 of 4 — the planner and the SQL views: v_captures folds retractions, one v_capture_links replaces three link views, the planner's evidence / watcher activity / moot-fact readers move onto capture_membership, evidence and money lines carry ids and announce cuts, the gap list is capped at 100 and the planner is always told the ceiling
research: thoughts/shared/research/2026-09-15-the-retrieval-and-delivery-layer.md
status: draft
supersedes: supabase/migrations/20260823120000_planner_read_surface.sql (its "retractions are a labelled trail, not a fold" ruling — overturned by operator ruling 3, 2026-09-15)
---

## Overview

Plan 1 (PR #242) put membership, retraction and tier rules into Postgres. The planner and SQL views
still use their own copies (`listJobEvidenceSince`, the watcher's activity readers,
`listL2CitingCapture`, a `v_captures` that returns retracted rows), and the unbounded gap list fails
a firm's tick at ~200 open items (research finding 4). This plan moves those readers onto the
membership, folds the views, and caps what the planner is shown.

## Decisions

- **Retracted removed from SQL** (operator ruling 3): `v_captures` is live-only, its retraction
  columns gone; the manager `includeRetracted` seat trail stays the one exception.
- **One `v_capture_links` replaces the three link views and `v_captures.customer_id/job_id`**
  (operator, this session). No shim views (mine; the pilot is a test surface): migrations apply
  immediately before merge; manager gateways need a restart for the new description.
- **Gap order under the cap: not on hold (oldest first), then held by `not_before`** (operator, this
  session, over inbound-first). The chosen gaps render in today's order; at or under the cap, none move.
- **Hard cap 100 gaps + noticed items, a SUGGESTED (unenforced) target under 30, both ALWAYS stated** (operator
  2026-09-15). GLM 5.3 context 1,310,720 tokens (OpenRouter `/api/v1/models`) vs ~190K worst case. Hidden: no reads, marks, stamps.
- **A retracted call/email's gap hides its words and states a record fact** (operator, this session).
- **A technician is never told a money AMOUNT in anything the planner sends** (operator 2026-09-15,
  added after the final review): the invoice is what the firm charged, and a technician who needs the
  figure asks a manager. A DEFAULT, NOT A CEILING — a manager may widen, money included — so the rail
  asks one question, `mayBeToldMoney(tier, grant)`, with the grant as a parameter rather than an
  exception to remember later. Phase 4.
- **A new call hidden by the ceiling is left as is** (operator 2026-09-15, after the final review): over
  100 gaps the newest item is hidden first, so the heartbeat's backup ping for a fresh call cannot
  show it until the backlog clears. Accepted: the Calls-worker's focused pass is uncapped and normally
  claims it within seconds, and a firm over the ceiling is itself the alarm. Rejected: reserving slots
  for inbound items, and inbound-first ordering.
- **`security definer` functions name `pg_temp` last** (final review): unnamed, `pg_temp` is searched
  FIRST, so a caller who can create temp tables could shadow `raw_captures` inside a definer body. Fixed
  on this plan's three functions; the same hardening is OWED on plan 1's eight
  (`20260916120000_retrieval_layer_core.sql`) and belongs to whoever next edits that file.
- **Pushed evidence includes `manager_only` notes** (operator, this session): planner tier sees all.
- **`query_spine`'s 5 s limit is dead; the real bound is 8 s** (measured this session, local stack):
  `pg_sleep(6)` returned at 6.03 s, `pg_sleep(12)` was cancelled at 8.05 s. `authenticator` has
  `statement_timeout=8s` locally and on the pilot (`pg_roles`); a GUC set inside a running function
  does not arm its statement's timer. Delete the line.
- **Views fold inline, not via `capture_is_live`** (mine): view functions are EXECUTE-checked as the
  querying role; a test pins that `v_captures` and `captures_page` agree on the live set.
- **Id lists travel in RPC bodies, results as one `jsonb`** (mine): no URL wall, no row clamp. The
  other batched tick readers go CHUNK 500 → 150 (ruling); subject-ref probes stay (plan 4).
- **Evidence is asked for per gap** (mine): newest 6 + an exact `total` per `{gap_id, job_id, since}`,
  so "N earlier not shown" is true; still gated on `sinceIso` (review blocker: `'j1'` fixtures).
- **Evidence text is a 2,400-char prefix; `flat()` still cuts at 600** (mine): haystack unchanged
  unless ≥75% of the prefix is whitespace (then `…` may be missing). Accepted.
- **Watcher activity = every job arm, by `captured_at`, live only** (mine, rulings 2, 3): a
  retracted note stops counting as a report. **`listL2CitingCapture` becomes tenant-scoped** (mine),
  not folded: it answers "what was created from this capture", and those rows still exist.
- **The planner keeps `toolLoop`'s 20,000-char cap, not `capToolResult`** (mine): the hub re-escapes
  quotes. The citation haystack adds each citable result's JSON string leaves, so `"` and line breaks match.
- **`listNudgesByStatus` pages on `(created_at, id)`** (mine): the count line needs a true total.
  `JobEvidenceRow.via` becomes arms joined by `,` (mine), so fixtures keep `'job_stamp'`.

## Plain-language walkthrough

```
               BEFORE                                          AFTER
planner tick ─ every open gap ─► 3 TS arms (URL wall) ─►   ─ ≤100 gaps (not held first) ► gap_evidence (RPC body)
               ─► lines: no ids, silent 6×600 cut             ─► lines: capture id, "3 earlier not shown"
watcher      ─► 2 TS readers, unchunked                    ─► job_activity_since (RPC body); retracted ≠ activity
moot fact    ─► 5 TS arms, fleet-wide                      ─► capture_records (RPC body), tenant-scoped
SQL          ─► v_captures (retracted, labelled) + 3 links ─► v_captures (live only) + v_capture_links
```

**Phase 1** fixes what the planner and managers read with SQL: retracted notes disappear from
`v_captures`, and one links view answers "which job, customer or trip is this note on". You'd notice
it when a retracted note no longer comes back and a trip-linked note is found with one join.

**Phase 2** gives the planner and watcher the seat tools' definition of "a job's notes": three
database functions replace eleven hand-written queries. You'd notice it in the tests: a trip-linked
note is evidence, a retracted note is not a report, and 250 ids pass through every reader.

**Phase 3** changes what the planner is shown: at most 100 gaps, a line naming that ceiling (and "N more" when hit), capture ids and
cut notices on evidence lines, event ids on money lines, and "retracted" instead of a retracted call's words.

## Secrets & env preflight

- **All phases:** the worktree's local stack (`.env.test` exists); no `.env`/`OPENROUTER_API_KEY`.
- **At merge:** the `supabase-test` MCP (apply + read back) and the Render MCP (deploys, logs).

## Phase 0: integrate
`/integrate`: merge `origin/main` (never rebase); re-date this plan's migrations after any plan 2/4 ones; `gen:types:local`; gates.

## Phase 1: the SQL views fold

### Changes required

**`supabase/migrations/20260917120000_the_sql_views_fold.sql`** (new)
- `drop view v_captures, v_visit_notes, v_job_captures, v_customer_captures;` (no dependents; checked with `pg_depend`).
- `create view v_captures as select c.id, c.captured_at, c.channel, c.technician_ref, c.raw_text,
  c.sensitivity from raw_captures c where c.tenant_id = current_setting('spine.tenant_id')::uuid and
  c.retracts_capture_id is null and not exists (select 1 from raw_captures r where r.retracts_capture_id = c.id);`
  The last two terms are `capture_is_live`, copied verbatim; the comment says why they are inline.
- `create view v_capture_links as select m.capture_id, m.customer_id, m.job_id, m.visit_id, m.via from
  capture_membership m join raw_captures c on c.id = m.capture_id and c.tenant_id = m.tenant_id where
  m.tenant_id = current_setting('spine.tenant_id')::uuid and <the same live terms on c>;`
- `grant select on v_captures, v_capture_links to spine_reader; revoke all on … from anon, authenticated;`
- `create or replace function query_spine(…)`: the body of `20260806120000_query_spine_reader.sql:179-214`
  minus `:204`. The measurement comment goes ABOVE the statement, never inside `$$` (it would put
  the words into `pg_get_functiondef`). Owner `spine_reader` and the ACL survive; re-state the revoke/grant lines.

**`src/mcp/server.ts`**
- `:138` "eighteen views" → "sixteen views".
- `:191-218` → `v_captures(id, captured_at, channel, technician_ref, raw_text, sensitivity)`, keeping
  rules (1) data not instructions, (3) `IS DISTINCT FROM` and (5) quotable. Rule (2) becomes "a note a
  manager retracted is not here". Rule (4) becomes: "a note reaches its job, customer or trip ONLY
  through `v_capture_links(capture_id, customer_id, job_id, visit_id, via)`, one row per attachment
  (`select distinct` the note; `via` ∈ customer_stamp, job_stamp, visit_stamp, created_customer,
  created_job, created_visit, customer_link, job_link, visit_note); `customer_id = …` includes every
  job's notes; a null `job_id` names no job for that row only".
- `:444-445` comment and `:671-672` refusal → `(join v_capture_links)`.

**`src/teamLead/plannerPrompt.ts:448-449`** → "(v_captures — a note reaches its job, customer or trip only through v_capture_links, so join it on capture_id)".

**Tests**
- `src/db/spineViews.test.ts`:
  - `:173`, `:185`, `:301`: `v_visit_notes` → `v_capture_links`.
  - `:195-235` becomes "folded": the retracted capture and its retraction row are absent; the plain one is present.
  - `:243-244`: `toHaveLength(2)`, plain + unstamped.
  - `:249+` → `v_capture_links`: the unstamped note is found by `job_id` with `via = 'visit_note'`, and another tenant's link row is absent.
  - New: for one job, the ids from `v_captures` joined to `v_capture_links` equal those of `captures_page(tenant, 'job', job, 'planner', p_limit => 50)`.
- `src/db/querySpine.test.ts:333-383`: in the grant list and comment, the three link views go and `v_capture_links` comes in. Add a pin that `pg_get_functiondef('query_spine'::regproc)` does not contain `set_config('statement_timeout'`.
- `src/mcp/server.test.ts`: `:7818` → `sixteen views`; `:7848` and `:7853` → `v_capture_links` and the catalog's join phrase.
- `src/teamLead/planner.test.ts:3111` → `join v_capture_links`.

**`docs/engineering-memory.md`** — trap entry: `set_config('statement_timeout')` inside a function does
not bound its statement; `authenticator`'s 8 s does (local + hosted, 2026-09-15). Run `npm run gen:types:local`.

### Automated verification
- [x] `npx supabase db reset` applies; the regenerated types show `v_capture_links` and no `v_visit_notes`.
- [x] `grep -rn "v_visit_notes\|v_job_captures\|v_customer_captures\|retraction_reason" src scripts` → migration-history comments only.
- [x] `npm run typecheck`, `npm run lint`, `npm test` (record the count) — 3,173 passed, 9 skipped (baseline before the phase: the same suite minus the new view tests).

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP; runs at merge time with Phase 2's migration (see Phase 3 live).
- [ ] After apply + `notify pgrst, 'reload schema'`: `v_visit_notes` is gone; `pg_get_viewdef('v_captures')`
      carries the live terms; `select query_spine('<pilot tenant>', 'select count(*) from v_capture_links')` returns.

### Manual verification
- [ ] none

## Phase 2: the planner's and watcher's readers move onto the membership

### Changes required

**`supabase/migrations/20260917120100_planner_capture_readers.sql`** (new): three `plpgsql security
definer stable set search_path = public` functions returning `jsonb`, revoked from public, anon and
authenticated and granted to `service_role` (the plan-1 block). Every uuid cast from `jsonb` sits in a
regex-guarded `CASE`. Shared rules: live = `capture_is_live`, visible = `capture_visible(c.channel,
c.sensitivity, 'planner')`, members = `capture_scope_members(p_tenant, 'job', job)`.
- `gap_evidence(p_tenant uuid, p_asks jsonb, p_per_gap int default 6, p_text_chars int default 2400)`
  → `[{gap_id, job_id, total, captures:[{id, channel, captured_at, technician_ref, text, text_chars, via}]}]`
  - one entry per ask, in input order
  - `captured_at > since`, strict like `buildGapView`
  - `total` = live visible count since
  - `captures` = the newest `p_per_gap` by `(captured_at desc, id desc)`, emitted oldest-first
  - `text = left(raw_text, p_text_chars)`; `via` = `array_to_string(arms, ',')`
  - clamps: `p_per_gap` 1..20, `p_text_chars` 1..8000
- `job_activity_since(p_tenant uuid, p_job_ids uuid[], p_since timestamptz)` → `{"<job id>": "<max
  captured_at>"}` over `capture_membership` where `tenant_id = p_tenant and job_id = any(p_job_ids)`,
  live captures with `captured_at >= p_since`.
- `capture_records(p_tenant uuid, p_capture_ids uuid[])` → `{records:[{capture_id, via, customer_id, job_id, visit_id}], retracted:[id…]}`
  - `via` ∈ created_customer, created_job, created_visit, job_link, visit_note
  - drops a cancelled job (created_job, job_link) and a cancelled visit (created_visit, visit_note), the rules at `rawCaptures.ts:602`, `:618`, `:666`, `:686`
  - `retracted` = the input ids on this tenant that have a retraction row

**`src/db/captureMembership.ts`** (new; `export *` in `src/db/index.ts`). It moves `JobEvidenceRow`
(`rawCaptures.ts:374-381`) and `L2CitingCapture` (`:574-579`) here:
```ts
export interface JobEvidenceRow { jobId: string; gapId?: string; gapTotal?: number; via: string;
  capture: Pick<RawCapture, 'id' | 'captured_at' | 'channel' | 'technician_ref' | 'raw_text'> }
export interface EvidenceAsk { gapId: string; jobId: string; sinceIso: string }
export async function listGapEvidence(tenantId: string, asks: EvidenceAsk[], perGap = 6): Promise<JobEvidenceRow[]>
export async function listJobActivitySince(tenantId: string, jobIds: string[], sinceUtcIso: string): Promise<Map<string, string>>
export async function readCaptureRecords(tenantId: string, captureIds: string[]): Promise<{ citing: L2CitingCapture[]; retracted: string[] }>
export async function listL2CitingCapture(tenantId: string, captureIds: string[]): Promise<L2CitingCapture[]>
```
- Empty input returns without a round trip.
- `via` → kind:

  | via | kind | id | jobId |
  |---|---|---|---|
  | created_customer | `customer` | customer_id | null |
  | created_job | `job` | job_id | job_id |
  | created_visit | `visit` | visit_id | job_id |
  | job_link | `link` | job_id | job_id |
  | visit_note | `note` | visit_id | job_id |

- Narrow the jsonb by hand (`src/db/costs.ts:603-620`); throw `<fn> failed: <message>`.

**Delete** `listJobStampedCaptureTimes` (`rawCaptures.ts:221-296`), `listJobEvidenceSince` (`:352-522`),
the old `listL2CitingCapture` (`:545-699`) and `listNoteTimesForJobs` (`visits.ts:1420-1455`). Keep
`foldRetractions` (used at `:993`) and fix the comments that name the deleted readers.

**CHUNK 500 → 150** (URL wall), each with a one-line comment:
- `jobs.ts:204` (`listJobsWithCustomerByIds`)
- `moneyEvents.ts:268` (`listJobIdsWithCostEvents`)
- `moneyEvents.ts:352` (`listLiveMoneyEventsForJobsSince`)
- `nudgeDecisions.ts:70` (`listDecisionsForNudges`)

**`src/teamLead/planner.ts`**
- Imports `:8` and `:43`. Deps: `:711` → `listCiting?: typeof readCaptureRecords`, `:737` → `listEvidence?: typeof listGapEvidence`. Defaults at `:4050` and `:4071`.
- `:4434` → `asks` = each gap in `open` whose `context.jobId` passes `UUID_ISH_RE` and whose `asked_at ?? created_at` parses, with `sinceIso: new Date(Math.max(ms, floorMs)).toISOString()`. Then `evidence = sinceIso ? await listEvidence(tenantId, asks, EVIDENCE_PER_GAP) : []`, keeping the gate at `:4430-4433` unchanged.
- `:4524-4541` → `records = await listCiting(tenantId, inboundCaptureIds)`, `citing = records.citing`, and `retractedCaptures = new Set(records.retracted)` for Phase 3.
- `buildGapView` `:1415-1417`: the filter also requires `e.gapId === undefined || e.gapId === n.id`.

**`src/jobs/watchers.ts`** — deps `:201-202` → `listActivity?: typeof listJobActivitySince`; defaults
`:283-284`; `:452-463` → `for (const [jobId, at] of await listActivity(tenantId, ids, floorUtcIso)) note(jobId, at);`

**`src/mcp/tools/customers.ts:808`, `:999`** → `listL2CitingCapture(tenantId, [capture.id])`.

**Tests**
- **New `src/db/captureMembership.test.ts`.** Port every behaviour in `rawCaptures.test.ts:111-341`, `:343-421` and `:462-490`:
  - the floor is strict
  - a note is reached through its visit note or its job link
  - another tenant's words are unreachable by stamp, note link or job link
  - retracted captures and retraction rows are absent
  - results come back oldest-first
  - cancelled rows are not records
  - the customer, link and note kinds
  
  Two expectations flip: `:150` (`manager_only` is now included), and the provenance tests become "`via` contains each arm".
  
  New tests:
  - 8 notes → 6 rows with `gapTotal` 8
  - two asks on one job with different floors
  - activity ignores a retracted note
  - `retracted` is filled
  - 250 random uuids go through all three readers and through `listJobsWithCustomerByIds`/`listJobIdsWithCostEvents` without throwing
- **Other files:**
  - Delete the ported describes from `rawCaptures.test.ts`; keep `:312-318` and `:422-461`.
  - `src/db/spine.test.ts:246-288` → `listJobActivitySince`, flipping `:287-288`: tenant B's rows on tenant A's job are now walled off, so the Map is empty.
  - `src/jobs/watchers.test.ts`: 13 stub sites (e.g. `:99-100`, `:360`) → `listActivity` returning a Map.
  - `planner.test.ts`: the stubs at `:211`, `:6792-6823` and `:7450` (a cast hides this one from typecheck) → `{ citing, retracted: [] }`; `:2825` asserts the asks' `jobId`s equal `[good]`.
  - Imports: `server.test.ts:6-11` and `customerCaptures.test.ts:12` import `listL2CitingCapture` from `./captureMembership.js`; their calls at `:8485` and `:106` pass the tenant.

### Automated verification
- [x] `npx supabase db reset`; the regenerated types list the three functions.
- [x] `grep -rn "listJobEvidenceSince\|listJobStampedCaptureTimes\|listNoteTimesForJobs" src` → comments only (none left).
- [x] `npm run typecheck`, `npm run lint`, `npm test` (count vs the Phase 1 baseline) — 3,175 passed after the phase, 3,178 after its review's added tests.

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP, at merge time (see Phase 3 live).
- [ ] After apply, the `md5(pg_get_functiondef(oid))` of each of the three functions equals the local stack's, and `gap_evidence(<tenant>, '[]')` returns `[]`.

### Manual verification
- [ ] none

## Phase 3: what the planner is shown

### Changes required

**`src/db/nudges.ts:114-127`** — `listNudgesByStatus` pages (`PAGE = 1000`, `.order('created_at').order('id')`,
`.range`), the `listObservationsByStatus` twin (`observations.ts:90-110`).

**`src/teamLead/planner.ts`**
- **The cap.** Beside `:629`: `export const PLANNER_GAPS_SHOWN = 100;`, `export const PLANNER_GAPS_TARGET = 30;` and `export function gapsToShow(open: Nudge[], nowMs: number): Nudge[]`.
  - At or under the cap it returns `open` unchanged.
  - Over the cap it ranks gaps not on hold (`not_before` null or `≤ nowMs`) by `(created_at, id)`, then held gaps by `(not_before, created_at, id)`, takes 100, and returns them in `open`'s order (`open.filter(n => chosen.has(n.id))`).
- **Where `shown` replaces `open`.** After `:4342`: `const shown = focus ? open : gapsToShow(open, nowMs); const hiddenGaps = open.length - shown.length;`.
  - Use `shown` at `:4393`, `:4396`, the `asks` line (`:4434`), `:4439`, `:4474`, `:4504`, `:4614-4617`, `:4650-4658`, `:4692` and `:4864`.
  - Keep `open` at `:4665` (the sibling-gap fact), `:4676` (a hidden lead is not leaderless), `:4319`, `:5384` and `:5476`.
- **The count line.** `buildPlannerUserMessage` (`:3379-3445`) gets a new last param `hiddenGaps = 0`.
  - Line `:3439` becomes `This firm has ${views.length + hiddenGaps} open gap(s). Aim to keep the firm under ${PLANNER_GAPS_TARGET} open gaps and noticed items by settling them, never by setting aside ones that still need doing. You are shown at most ${PLANNER_GAPS_SHOWN} per look — anything past that waits for a later one.` on EVERY non-focused tick (one line, so the `This firm has` forged-line neutraliser, `memory.test.ts:145`, still covers it, and the existing `toContain('This firm has N open gap(s).')` assertions still hold).
  - When `hiddenGaps > 0` it adds ` Right now ${hiddenGaps} more are NOT shown: you see the ones not on hold first, then held ones.`
  - `PlannerTenantPlan` (`:409`) gets `gapsHidden?: number`, set when > 0.
- **Evidence lines** (`:1413-1419`, `:1828-1834`). Keep the pre-slice `matching` list. Each line gains ` capture ${e.capture.id}` before its colon. After the loop:
  - `earlier = max(matching.length, ...matching.map(e => e.gapTotal ?? 0)) - relevant.length`; when > 0, add `    (${earlier} earlier note(s) since ${since} not shown — spine_read v_captures joined to v_capture_links on this job id)`.
  - If any shown line ends in `…`, add `    (a line ending in … was cut at ${EVIDENCE_TEXT_CHARS} characters — spine_read v_captures where id = its capture id has the full words)`.
- **Money lines** (`:1466-1467`, `:1839-1841`). `moneyLine` gains ` (event ${m.id})`. When `moneyHere.length > moneyShown.length`, add `    (${n} earlier ledger entries not shown)`.
- **A retracted inbound message.**
  - `marksById` (`:4685-4687`) adds `retracted: retractedCaptures.has(captureId ?? subject_ref)`, and the `marks` type (`:1393`) gains `retracted?: boolean`.
  - When it is set, `:1544-1550` pushes `  the message this is about was RETRACTED as recorded in error — its words are no longer on the record` instead of the words, and `:1574-1577` and the `:1607` pointer are skipped.
  - `mootFactFor` (`:4550`) returns `'the message this is about was retracted — it is no longer on the record'` first for PINGED kinds.
- **The citation haystack.** Beside `:1986`, add `export function citableTexts(result: string): string[]`, which returns `[result, ...every string leaf of JSON.parse(result)]` (a parse failure gives `[result]`). `:4939` pushes `...citableTexts(call.result)`.

**Tests** (`src/teamLead/planner.test.ts` unit tests; `src/db/nudges.test.ts` on the local stack)
- **The cap:**
  - 101 open gaps → `101 open gap(s)`, `at most 100`, `1 more are NOT shown`, 100 `gap ` blocks; 1 gap → the `under 30` and `at most 100` sentences are present, no `NOT shown`.
  - An old held gap is the one hidden.
  - The hidden gap's job is absent from the `listEvidence` asks, and a decision on it is refused.
  - A member whose lead is hidden does not render `FROZEN`.
  - `plans[0].gapsHidden === 1`.
  - With ≤100 gaps and a held gap, the gap order is unchanged.
- **Evidence and money:**
  - `:331-333`: the expected line gains ` capture c-2026-08-15T12:30:00.000Z`.
  - `gapTotal: 9` with 6 shown → `3 earlier notes`.
  - A 700-char note → the cut line.
  - The money line has `(event …)`.
- **Retracted inbound:** the words are absent, the RETRACTED line and a `THE RECORD:` line are present, and a `record` close is accepted.
- **Citations:** a `spine_read` result whose `raw_text` holds `he said "no parts"` and a newline lets a verbatim evidence close through (it is refused before `citableTexts`).
- **`nudges.test.ts`:** two nudges with an identical `created_at` come back ordered by id.

### Automated verification
- [x] `npx vitest run src/teamLead src/db/nudges.test.ts src/eval`.
- [x] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` — 3,188 passed, 9 skipped; build clean.

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP; Render MCP (workspace `tea-d69903h5pdvs738dm81g`).
- [ ] **Immediately before merge:** apply both migrations to the pilot, then do Phase 1's and Phase 2's read-backs.
- [ ] **Right after merge:** check that the lifecycle-heart and Calls-worker deploys are on the merge commit (`list_deploys`), triggering the heartbeat's deploy if it did not start. On the next heartbeat, the planner summary shows no new `tenantErrors`, and the logs have no `gap_evidence`, `capture_records` or `job_activity_since` failures.

## Phase 4: the money rail on the way out

### What this phase does
The planner relays money to technicians: its gap block lists a job's ledger lines with amounts and it
writes that person's message itself. Plan 2 hides amounts on the technician's own reads; this closes
the same hole on the planner's surface, where the words are model-written.

### Changes required
**`src/teamLead/planner.ts`**
- Beside `TEMPORAL_RE`: `MONEY_RE` (a currency-marked figure — `$900`, `forty dollars`, `USD 40` — or a
  bare number within 24 characters of a money word: invoice, bill, balance, owe, paid, payment, charge,
  quote, deposit, refund, cost), and `export function mayBeToldMoney(recipientTier, grant = null)` —
  true for `manager`, true when `grant.money`, false otherwise (an unknown tier FAILS CLOSED).
- `cleanPlannerText` gains `opts.noMoney`, checked after the link check, refusing with the amount it
  caught and what to do instead; `cleanQuestionDraft` passes it through.
- Both send paths set it from the resolved addressee's tier (`reachable.get(ref)?.tier`), on BOTH legs
  — a quiet note lands in that person's own assistant's session.
- Both `send needs \`message\`` refusals append the specific reason; `noteDrops` only reaches the log,
  and a planner told "one of these four things" cannot tell which rail it hit.

**`src/teamLead/plannerPrompt.ts`** — a `MONEY` line beside WHO/HOW/WHETHER under SEND.

### Automated verification
- [x] `mayBeToldMoney`: manager true, technician false, unknown false, `{money:true}` true.
- [x] A figure to a technician refused on chat AND assistant, the refusal naming the amount and "ask a
      manager"; status in words accepted; a bare number beside a money word refused; a manager may be
      told; the doctrine line pinned.
- [x] `npm run typecheck`, `npm run lint`, `npm test` (3,197 passed, 9 skipped), `npm run build`.
- [x] Mutation check: `mayBeToldMoney` returning true for everyone fails 3 of the new tests.

### Live verification (agent-executable)
- [ ] Covered by Phase 3's post-merge check (no new database surface).

### Manual verification
- [ ] none

---

### Manual verification
- [ ] Restart the manager seats' gateways (s2 first; `tools/list` is cached per process), then read `query_spine`'s description back: it names `v_capture_links`. This is also plan 1's owed restart.
