---
date: 2026-09-22
task: rung 10c — a seat's message wakes the office within seconds, the way an inbound call already does; and each office door loads only the prompt it uses
research: thoughts/shared/research/2026-09-20-the-desk-as-the-offices-fast-path.md
status: complete
supersedes: nothing
---

> **Rebased 2026-09-23 onto `main` at `c655f91`**: the office merge (PR #279, `dd0fc7c`) and step 1
> of the Copilot seat (#276/#277). What the merge changed for this plan is under "What the merge
> changed". Line numbers below are re-read against the merged code. The adversarial review's eight
> findings and the operator's fix A are applied in this revision.
> The operator approved the `news` kind for access decisions on 2026-09-23 (see Decisions).

## Overview

A technician's `inform_team_lead` today waits for the planner's cadence: up to 30 minutes in firm
hours, 120 outside them. An inbound call reaches the office in about 10 seconds (rung 10). This plan
gives seat messages the same wake:

- a claim column on `office_messages`;
- a focused office run scoped to ONE message;
- a third loop in the Calls worker, plus rung 10's two fallbacks.

It changes WHEN the office reads a message, not WHAT it does with one; the WHAT is rung 10d.

Folded in (operator, 2026-09-23): the office's prompt is **built per door**, so a waiting question
stops paying for the call doctrine it never uses.

## What the merge changed

| Before the merge | After (`dd0fc7c`) | Effect on this plan |
|---|---|---|
| `answerDeskQuestion` (desk.ts) on its own prompt, 40s | `answerAsOffice` / `routeAccessAsOffice` (office.ts) on `OFFICE_SYSTEM`, 240s, no turn cap | The `ask` exclusion now cites office.ts:495-571. Nothing else. |
| A focused pass ran on `PLANNER_SYSTEM` | `runPlanner` uses `focus ? OFFICE_SYSTEM : PLANNER_SYSTEM` (planner.ts:5103) | A message pass is the office **for free**. It needs a fourth door named in the office prompt. |
| `OFFICE_SYSTEM` did not exist | One `OFFICE_SYSTEM` (~10.4K tokens) for every door | Folded in as Phase 2 (per door). |
| Stale "open this narrow ask" comment at planner.ts:4389 | Rewritten by the merge | Nothing left to fix. |
| `focus`, `plannerPass.ts`, `runWorker.ts`, `lifecycle.ts`, `officeMessages.ts` | **Unchanged** | Phases 1, 3 and 4 hold as designed. Only line numbers moved (+1 to +6). |

**Carry-over (1) from the merge's handoff is moot.** It said this worktree had uncommitted
`plannerPrompt.ts` edits to merge onto the section split. It has none: `git status` is clean apart
from `supabase/config.toml`, and the merge of `main` was conflict-free. The only stash is a
7-week-old unrelated autostash.

**Step 1 (the Copilot seat) touches nothing here, with two consequences:**

- A seat's `inform_team_lead` still lands through the spine MCP into `office_messages`, the same as
  from an OpenClaw seat. So the wake works for Ben's seat.
- The office's text BACK to Ben's seat does not arrive until step 3. Office traffic to s5 is broken,
  and the operator accepted that. This is not 10c's hole to fix. Step 3 waits for 10c to land,
  because it rewires the delivery of these same rows.

## Decisions

- **One agent, split by trigger** (operator, 2026-09-22). Pinged = the office; 30-min cron = the
  planner.
- **A seat's message wakes the FOCUSED-PASS path** (operator). It uses rung 10's chassis:
  `submit_plan`, the full verb surface, the guarded send rails. It now runs on the office's prompt
  (see the table above).
- **The office texts people itself; no escalate hop** (operator). The double-text guard is a DB
  stamp (`asked_at`).
- **The office may file a standing instruction as it reads it** (operator). Measured 29/30 on the
  planner's prompt; re-measured on the office's in Phase 3.
- **Scope: WHEN, not WHAT.** The shared message doctrine (`SEAT_MESSAGES`) is unchanged. The office
  prompt gains one door line. Acting on messages with L2 verbs is rung 10d.
- **Only `inform` wakes.** `PINGED_MESSAGE_KINDS = ['inform']`.
  - `reply` stays OFF the wake. This is fix A (operator: "A now, B with 10d"). A reply answers a
    gap, so it must reach the tick together with that gap, as it does today.
  - `ask` stays off. The question door answers it while the seat waits, then marks it read
    (office.ts:495-571). It is left unread only when the office failed, and the tick covers that.
  - `desk` rows are born read.
- **Fix A: the tick sees what the office already read** (operator, 2026-09-22). A message pass
  marks its message read, and the tick only reads unread. Without this, an `inform` that happens to
  answer a gap would never sit beside that gap, and today's "quote a message to close a gap" would
  regress. The tick gets an appendix of `to_planner` messages the office read since the firm's last
  tick. Their bodies are quotable through the existing `readText` pairing. The appendix is labelled
  as already handled, for closing gaps only.
- **The claim column is `pinged_at`**, mirroring `observations.pinged_at` (precedent
  `supabase/migrations/20260908100000_inbound_asks_and_job_captures.sql:19-36`).
  - Partial index on `(created_at)`, fleet-wide.
  - **No backfill**: an unread row is at most one tick old.
- **The claim is a LEASE, and the tick claims too.** The ping loop takes only UNCLAIMED rows and
  never releases a claim. The tick shows only rows it claims itself: unclaimed, or claimed longer
  ago than `OFFICE_CLAIM_LEASE_MS` (10 min, above the 180s focused budget). A crashed pass's
  message is recovered by the first tick at least 10 minutes later. **Worst case: ~130 min off-hours**
  (10-min lease + a 120-min cadence), ~40 in hours. Today it is 120 and 30.
- **`focus` becomes a union told apart by which id field is present**, not by a `kind` tag.
  `planner.test.ts` builds a focus through an `as unknown as` cast, and a tag would silently flip
  that test instead of failing to compile.
- **A third independent loop in `runWorker.ts`** (its "TWO INDEPENDENT LOOPS" comment at :54
  documents why the loops are separate). It backs off at the idle rate on `'error'` too.
- **Both of rung 10's fallbacks are mirrored**: the heartbeat probe (lifecycle.ts:81-94, gate :530)
  and the per-firm due check (planner.ts:4477-4492).
- **The office prompt per door** (operator, 2026-09-23). This is one doctrine, and each door loads
  only the sections it uses:
  - question and access: the office's own sections plus `NOTES`, `CONTEXT` and `WRITING`, about 4.0K
    tokens (was 10.4K);
  - the call door and the new message door: the full set.
- **DECIDED (operator, 2026-09-23): an access decision becomes a `news` kind.** `tellThePlanner`
  (access.ts:348-360) writes each grant, decline and revoke as `kind:'inform'`; under this plan
  that would wake the office for news it has nothing to do with. So Phase 1's migration adds
  `'news'` to the kind check, and access.ts:353 writes it. The writing code knows the category
  for certain, and the Jev eval found access news is the one category both models misread (memory
  `jev-typesafe-system-one-model`).
  - Rejected: accept the wake (pennies a day, a pass that does nothing). Rejected because a writer
    that already knows the category should say it, rather than leave a model to guess.
  - `news` is NOT in `PINGED_MESSAGE_KINDS`, so it never wakes the office. The half-hourly tick
    still shows it unread, exactly as today. *Corrected in Phase 1 review:* the tick's message line
    never printed `kind` (only the office's asker history does, office.ts:279), so
    `buildOfficeMessagesBlock` gains a `, news of an access decision already made` tag beside the
    reply tag. That is the tick's user message, not `PLANNER_SYSTEM`, whose byte pin is untouched.
  - access.ts:407 is a `to_agent` note to the technician's seat, so it is outside this inbox and
    stays `inform`.
- **Jev stays a follow-up**, not folded in. The harness (`scripts/planner-eval/classify-*.mjs`)
  ships with this branch as a record.

## Plain-language walkthrough

```
seat: "route all job messages to Sam"  ──▶ office_messages row (inform, unread, pinged_at empty)
                                               │
      ┌── Calls worker, every ~10s ────────────┤  Phase 4
      │   claims it (pinged_at = now)          │
      ▼                                        ▼  fallback, if the worker is down
  THE OFFICE, message door (Phase 3)       the heartbeat (every 5 min) runs the firm early,
  sees this ONE message, no gaps;          claims the message itself and shows it
  acts, may file a note, marks it read     (a claim older than 10 min counts as abandoned)
                                               │
  next half-hourly tick ◀──────────────────────┘
  THE PLANNER: sees its gaps + "already read by the office" appendix (fix A),
  so a message that answered a gap can still be quoted to close it
```

**Phase 1: a "someone has this" stamp.** Messages today have only unread/read. If a worker marked
a message read to claim it and then crashed, the message would be gone. So we add a separate stamp,
`pinged_at`, meaning "a pass has picked this up", plus a `news` kind for access decisions.
You'd notice it as a new column and passing tests.

**Phase 2: each office door loads only its own instructions.** A technician's question stops
carrying six thousand tokens about calls and gaps. You'd notice it as a smaller prompt in the
office eval's cost line, with the same answers.

**Phase 3: the office can look at just one message.** This is the mirror image of rung 10's call
pass: show ONE message, hide the gaps. The tick claims what it shows, and gains the "already read"
appendix. Nothing calls the new pass yet.

**Phase 4: the wake.** The Calls worker gains a loop that picks up new `inform` messages every
~10 seconds, plus rung 10's two safety nets. You'd notice it: a message written locally gets
`pinged_at` and turns `read` within seconds, and the worker log names it.

## Secrets & env preflight

- **Phases 1–3 (automated):** none. Local stack only. This worktree's `.env.test` targets its own
  stack (`127.0.0.1:54421`).
- **Phase 2 and Phase 3 evals:** `OPENROUTER_API_KEY`, read BY NAME from `.env` by the harness, and
  nothing else loaded (the notes-run rail: `.env`'s `SUPABASE_URL` is the pilot). Mind the key's
  $50/month cap (memory `openrouter-key-monthly-cap`); pass `--reserve`.
- **Phase 4 (live check):** as above, plus `PLANNER_MODE=shadow` set inline for the one command,
  never written to a file.
- **Rollout:** no new variables. The Calls worker has carried `PLANNER_MODE` and the inference
  credentials since rung 10. Read them back through the Render API before deploying.

## Phase 1: the claim column

### Changes required

**`supabase/migrations/20260923120000_office_messages_pinged_at.sql`** (new). It is additive and
safe to apply before the code; its header says so, in the 20260908100000 style:
```sql
alter table office_messages add column if not exists pinged_at timestamptz;
comment on column office_messages.pinged_at is 'Rung 10c: a pass has CLAIMED this message (the Calls-worker''s guarded claim, or a tick about to show it). Separate from status on purpose: a crashed pass leaves it unread, and a claim older than OFFICE_CLAIM_LEASE_MS is treated as abandoned. Not a read marker.';
create index if not exists idx_office_messages_unpinged
  on office_messages (created_at)
  where direction = 'to_planner' and status = 'unread' and pinged_at is null;
```
**The `news` kind.** The same file replaces the `kind` check to add `'news'`. The check is inline
on the column (20260901150000_office_messages.sql:26), so Postgres named it
`office_messages_kind_check`; confirm that name on the local stack (`\d office_messages`), then
`drop constraint if exists` + `add constraint ... check (kind in ('ask','inform','reply','desk','news'))`,
mirroring 20260917200000_person_pushes_ops_kind.sql.

**`src/db/officeMessages.ts`.** Each accessor below is written in the style of its observations
twin (`src/db/observations.ts:402-551`):
- `export const PINGED_MESSAGE_KINDS: OfficeMessageKind[] = ['inform'];`
- `listUnpingedOfficeMessages(kinds, limit)`. FLEET-WIDE, like `listUnpingedObservations`.
  - Filter: `direction='to_planner'`, `status='unread'`, `kind in kinds`, `pinged_at is null`.
  - Order: oldest first. `[]` on empty kinds.
- `claimOfficeMessagePing(id)`. Sets `pinged_at=now`, guarded on `pinged_at is null` AND
  `status='unread'`, with `.maybeSingle()`. Null means "someone else has it, or it was read".
- `hasFreshUnpingedOfficeMessage(kinds, sinceIso)`. The same predicate plus
  `created_at >= sinceIso`, `limit(1)`, returning a boolean. `false` on empty kinds.
- `claimOfficeMessagesForTick(tenantId, ids, staleBeforeIso): Promise<string[]>`. TENANT-SCOPED.
  - Sets `pinged_at=now` where `tenant_id`, `id in ids` and `status='unread'`, plus
    `.or(`pinged_at.is.null,pinged_at.lt.${staleBeforeIso}`)`.
  - Returns the ids it moved. `[]` on empty ids.
- `listOfficeReadSince(tenantId, sinceIso, limit)` (fix A):
  - `to_planner` rows with `status='read'`, `read_at >= sinceIso`, and kind `inform` or `reply`;
  - newest first, capped at `OFFICE_MESSAGES_SHOWN`.
- `OfficeMessageKind` gains `'news'`. `tellThePlanner` (access.ts:353) writes it; update its comment
  ("One inform per grant" → "One news message per grant").

**`src/db/database.types.ts`.** Do this inside this worktree, whose `config.toml` carries its own
`project_id`:
1. Run `npx supabase migration up` (add `--include-all` if it refuses as out of order).
2. Run `npx supabase gen types typescript --local > src/db/database.types.ts`.

**Never run `npm run gen:types`**: it is `--linked`, meaning the pilot. The diff must be only
`pinged_at` and the kind union's `'news'`. Anything more means the local stack is behind, so stop.

**Fixtures.** Add `pinged_at: null` to the full-row `OfficeMessage` literals (`grep -n "read_at:"`
across `src/`, plus `officeRow` in `scripts/planner-eval/notes-run.mjs`).

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] New cases in `src/db/officeMessages.test.ts` (local stack):
  - the reader returns only unread + unpinged `inform` rows, oldest first, and skips a `reply`, an
    `ask`, a read row and a pinged row;
  - the first `claimOfficeMessagePing` wins and the second returns null, and a read row cannot be
    claimed;
  - `claimOfficeMessagesForTick` takes an unclaimed row and a stale claim, but skips a live claim;
  - **tenant B's id passed with tenant A claims nothing**. The file has one tenant today, so create a
    second one, following `src/db/costs.test.ts:82-92`;
  - the probe respects `sinceIso` and ignores `ask`;
  - `listOfficeReadSince` returns read `inform`/`reply` rows after `sinceIso` for its tenant only.
- [x] A grant written through access.ts lands as `kind:'news'`; `listUnpingedOfficeMessages` skips it,
  and the tick's unread list still shows it

## Phase 2: the office prompt per door

### Changes required

**`src/teamLead/officePrompt.ts`**
- `export type OfficeDoor = 'question' | 'access' | 'call' | 'message';`
- `export function officeSystemFor(door: OfficeDoor): string`, composed from named arrays, with no
  duplicated text:
  - `question` and `access`: `OFFICE_OPENING`, `OFFICE_DOORS`, `OFFICE_AUDIENCE`, `OFFICE_ACCESS`,
    `WRITING`, `NOTES`, `CONTEXT`, then a closing for that door. `OFFICE_ACCESS` rides the question
    door too, because a question can end in "ask for access".
  - `call` and `message`: today's full composition.
- `OFFICE_DOORS` gains the fourth door:
  `A MESSAGE a seat sent you — you are shown that one message under OFFICE MESSAGES, and you end by calling submit_plan, like a call.`
- `OFFICE_CLOSING` becomes per door. The full composition's closing names the call AND message
  doors. The waiting doors' closing drops "any tool a section above names…", because their sections
  no longer name tools they lack.
  *As built (Phase 2):* that premise was false — WRITING names `send`/`nudgeIds` and CONTEXT names
  `spine_read`/`submit_plan`, which a technician-facing waiting door lacks — so every door's closing
  KEEPS the other-doors line and ends on its own terminal tool. The call door's "Everything below
  about gaps, verbs, sending and closing…" sentence moved out of `OFFICE_DOORS` into
  `OFFICE_DOCTRINE_POINTER`, included only in the call/message composition. `office.ts` names the
  door explicitly (`door: 'question' | 'access'` on `OfficeDoorInput`).
- `OFFICE_SYSTEM` stays exported and equal to `officeSystemFor('call')`, so every existing import
  keeps its meaning. `office.test.ts:423` then moves to the per-door value.

**`src/teamLead/office.ts:393`**: `system: officeSystemFor(input.terminal.name === ROUTE_ACCESS_TOOL.name ? 'access' : 'question')`.
Better still, add an explicit `door` field on `OfficeDoorInput` set by `answerAsOffice` and
`routeAccessAsOffice`. That is the implementer's call; say which in the report.

**`src/teamLead/planner.ts:5103`**:
`system: focus ? officeSystemFor('observationId' in focus ? 'call' : 'message') : PLANNER_SYSTEM`.
It lands with Phase 3's union; until then it is `'call'`.

`PLANNER_SYSTEM` is NOT touched. Its byte pin in `plannerPrompt.test.ts` must pass unchanged.

### Automated verification
- [x] typecheck, lint, test pass; the `PLANNER_SYSTEM` byte pin passes UNCHANGED
- [x] `plannerPrompt.test.ts`, the "carries every section a call needs" case runs against both
      `'call'` and `'message'`
- [x] New case: `question` and `access` contain `OFFICE_AUDIENCE`'s money line, "never quote a
      note", `NOTES`, `CONTEXT` and `WRITING`, and contain NONE of `STATES`, `CALLS`, `VERBS`,
      `SILENCE`, `SEND` or `CLOSING`
- [x] New case: each door's prompt ends in its own terminal tool's name
- [x] New case: the waiting doors' prompt is under 4,500 tokens by the repo's existing estimator,
      or chars/3.6 if there is none

### Live verification (costs cents)
- [x] `node scripts/planner-eval/office-run.mjs` (all doors). Record per-door input tokens and cost
      against the merge's baseline (about 10.3K fixed per technician question). Answers must still
      hold the disclosure rules the harness grades.
      **Result (2026-09-23, GLM 5.3, local stack):** input tokens per model call, read back from
      `cost_events` by lane: question **4,853** (4 calls, $0.0066), access **5,302** (2 calls,
      $0.0100), call door 15,571 (5 calls, $0.0792). Prompt sizes by chars/3.6: waiting doors
      ~4.08K, call/message ~10.45K, so each waiting-door call carries ~6.4K fewer fixed tokens than
      before. Graded behaviour held: the customer-wide ask narrowed to the one job; after Sam's
      accidental no, the re-ask went to Sam alone and named his "wrong button"; the out-of-view
      question leaked no job title; the 2s hang-up filed and texted nothing; the call door sent the
      manager text + quiet note pair for a real request and dismissed a thank-you.

## Phase 3: the office can be scoped to one message

### Changes required

**`src/teamLead/planner.ts`**
- `:739`: `focus?: { observationId: string; budgetMs: number } | { messageId: string; budgetMs: number };`.
  Every property read is narrowed with `'observationId' in focus`.
- `:529`: add `focusMessageId?: string;` beside `focusObservationId`. `:4230` spreads whichever id
  the focus carries.
- `:5178`: `focus && 'observationId' in focus ? focus.observationId : null` (the quiet-note pairing).
- `:5245-5253`: the gap-less chat-send binding runs ONLY for an observation focus. Hoist
  `const boundTo = focus && 'observationId' in focus ? focus.observationId : null;` and gate the
  map on `boundTo`. A message is not a gap, so there is no id to bind a send to.
- `:5075`: pass `focus ? ('observationId' in focus ? true : 'message') : false`.
  - `buildPlannerUserMessage`'s `focused = false` (`:3535`) becomes
    `focused: boolean | 'message' = false`.
  - At `:3567`, a `'message'` value renders:
    `This pass is about 1 message from a seat, under OFFICE MESSAGES; the firm's open gaps are not shown and are not yours now.`
- Beside `OFFICE_MESSAGES_SHOWN` (`:3382`): `export const OFFICE_CLAIM_LEASE_MS = 10 * 60_000;`,
  commented that it must stay above the focused budget (a test pins that).
- PlannerDeps gains, each injected per the standing rule:
  - `claimMessages?: typeof claimOfficeMessagesForTick;`
  - `listOfficeRead?: typeof listOfficeReadSince;`
- `:4364`: rename the destructured `unreadMessages` to `unreadAll`, then
  `const unreadMessages = focus ? unreadAll : unreadAll.filter((m) => !m.pinged_at || Date.parse(m.pinged_at) < nowMs - OFFICE_CLAIM_LEASE_MS);`.
  A live claim belongs to a running focused pass, so it is neither shown nor counted as work.
  **The filter must not run in focus mode**, because a message pass's own row carries a fresh claim.
- **The claim moves BEFORE the no-work skip (review fix e).** Today the skip at `:4425` runs before
  the slice is built at `:4994`.
  1. Compute `unreadSlice = unreadMessages.slice(0, OFFICE_MESSAGES_SHOWN)`.
  2. When not in focus mode and the slice is non-empty, call `claimMessages`. `unreadShown` = the
     slice filtered to the returned ids. On a throw, log and fall back to the whole slice (today's
     behaviour; this also covers an unmigrated column).
  3. Only then run the `no_gaps` skip: `open.length === 0 && unreadShown.length === 0`.

  A firm whose only messages were claimed by a live pass makes no model call. **Never claim in focus
  mode**: the worker already holds that claim, and the guard would refuse it.

  *As built:* the early `no_gaps` skip uses a PURE filter (live claims hidden, no write), and the
  claim WRITE moved after the cadence skip, followed by a second `no_gaps` check for messages lost
  to a race. Claiming before the cadence skip would let an off-cadence firm claim messages it never
  shows, and the ping loop only takes unclaimed rows, so they would be starved until the lease
  lapsed and a due tick came.
- `:5058`: `unreadMessages.length - unreadSlice.length`. A message lost to a race is not "more
  unread".
- **Fix A, the appendix.** Not in focus mode: `listOfficeRead(tenantId, <this firm's last tick
  time>, OFFICE_MESSAGES_SHOWN)`. Use the same `lastMs` the due check reads, and on NaN, now minus
  the cadence. *As built:* one lease further back than that, and 24h on NaN (Phase 3 review).
  - Render it after the unread block, under one header:
    `ALREADY READ BY THE OFFICE since your last look — handled; shown so you can quote one to close a gap it answers. Do not act on them again.`
  - Add their bodies to the `readText` map, so a close can quote them.
  - Never mark them read, since they already are, and never count them as work for the skip.
  - A failed read degrades to no appendix.
  - Doctrine: `SEAT_MESSAGES`' "You see a message ONCE" stays; the appendix's own header says what
    it is. That leaves `PLANNER_SYSTEM` byte-identical. This is a named wrinkle, not a fix.

**`src/jobs/plannerPass.ts`**
- `export const FOCUSED_PASS_BUDGET_MS = 180_000;`. `runFocusedObservationPass`'s default (`:100`)
  uses it.
- `export async function runFocusedMessagePass(message: OfficeMessage, impl = runPlanner, budgetMs = FOCUSED_PASS_BUDGET_MS)`.
  - It uses the same blocked/mode preamble, with `focus: { messageId: message.id, budgetMs }`.
  - THE SCOPING IS INVERTED:
    - `listTenants` is filtered to `message.tenant_id`;
    - `listOfficeMessages` returns `[message]`;
    - `listObservations`, `listNudges`, `listDeskTranscripts`, `listDismissedIds`,
      `listDismissedNudges` and `listOfficeRead` all return `[]`.

### Automated verification
- [x] typecheck, lint and test pass; the observation-focus tests (`(14i)` and its neighbours in
      `describe('rung 10 …')`) pass UNCHANGED
- [x] `planner.test.ts`: `baseDeps` gains `claimMessages: async (_t, ids) => ids` and
      `listOfficeRead: async () => []` **(review fix d)**. Without these, the inbox tests silently
      hit the database and only exercise the fallback.
- [x] `plannerPass.test.ts`:
  - `runFocusedMessagePass` hands `impl` those exact pinned readers and that focus;
  - a blocked env returns `{ skipped }` without calling `impl`;
  - `OFFICE_CLAIM_LEASE_MS > FOCUSED_PASS_BUDGET_MS`.
- [x] `planner.test.ts`, message focus:
  - with zero gaps and one message, the loop RUNS on `officeSystemFor('message')`;
  - the user message carries the message line and not `This firm has`;
  - `claimMessages` and `listOfficeRead` are not called;
  - the message is marked read, and there is no `planner_runs` write;
  - the summary has `focusMessageId`;
  - a gap-less chat send keeps `nudgeId` null.
- [x] `planner.test.ts`, the tick:
  - a row claimed 1 min ago is not shown, and a firm holding only that row skips `no_gaps` **before
    the model call**;
  - a row claimed 20 min ago IS shown;
  - a row `claimMessages` does not return is not shown;
  - a throwing `claimMessages` shows the whole slice.
- [x] `planner.test.ts`, fix A:
  - an office-read `inform` appears under the appendix header, and a gap closed by quoting it passes
    the quote check;
  - it is not marked read again;
  - a firm with only appendix rows and no gaps skips `no_gaps`.

### Live verification (costs cents: the notes eval, re-framed, review fix g + carry-over 2)
- [x] Extend `scripts/planner-eval/notes-run.mjs` with a `--frame message` option. Render the
      briefing through `buildPlannerUserMessage(…, 'message')` with no gaps, on
      `officeSystemFor('message')`, and keep the same four variants.
- [x] Run 30 standing-instruction runs + 10 controls. **Pass:** the binomial tail from
      `notes-analyze.mjs` rules out a coin flip, the same bar as the 29/30 on the planner.
- [x] A clear drop is a stop-and-ask, not a patch.
- **Result (2026-09-23, GLM 5.3, `thoughts/shared/evals/planner-notes-message-frame-2026-09-20T17-00-00-000Z`):**
  standing instructions filed **30/30** (routing-sam, away-until, no-early-texts 10/10 each), the
  control filed nothing **10/10**, every run submitted a plan (median 3 turns). Binomial tail vs a
  coin flip: 9.3e-10. No drop from the tick's 29/30 on `PLANNER_SYSTEM`. ≈ $0.51.

## Phase 4: the wake, and rung 10's two fallbacks

### Changes required

**`src/calls/messagePing.ts`** (new): `drainOneMessagePing(deps)`, a line-for-line mirror of
`src/calls/observationPing.ts`.
- Deps are `list` / `claim` / `pass` / `blocked`, defaulting to `listUnpingedOfficeMessages` /
  `claimOfficeMessagePing` / `runFocusedMessagePass` / `focusedPassBlockedBy`.
- `blocked()` runs BEFORE any read or claim, with its own `lastBlockedReason`.
- Then `list(PINGED_MESSAGE_KINDS, 1)` → claim → pass the CLAIMED row → log
  `[calls:message-ping] focused pass <id> <summary>`.
- Errors are swallowed, and the claim stays.

**`src/calls/runWorker.ts`**: `messagePingLoop()` becomes a third entry in `Promise.all` (`:61`).
The delay is `PING_BUSY_BACKOFF_MS` only on `'pinged'`, and `PING_IDLE_BACKOFF_MS` otherwise, error
included. The comment at `:54` becomes THREE.

**`src/jobs/lifecycle.ts`**
- Import `PINGED_MESSAGE_KINDS` and `hasFreshUnpingedOfficeMessage`.
- Add the dep `listFreshMessagePings?: typeof hasFreshUnpingedOfficeMessage`.
- Add `freshUnclaimedMessage(nowIso, deps)`, mirroring `:81-94`: the same
  `PING_FALLBACK_WINDOW_MS`, and a failed read counts as none.
- The gate at `:530` becomes
  `!plannerTick && !(await freshUnclaimedObservation(…)) && !(await freshUnclaimedMessage(…))`.
- The skip text (`:531`) becomes
  `'off-cadence tick (no firm due, no unclaimed observation or message)'`.
- In `lifecycle.test.ts`:
  - update the assertions that pin the old text (`grep -n "no unclaimed observation"`);
  - add `listFreshMessagePings: async () => false` to the `STUBS`, so no unit test reads the
    database.

**`src/teamLead/planner.ts`**: add a `messagePinged` check at `:4477-4492`.
- It fires when not in focus mode, `lastRunReadOk`, and some message in `unreadMessages` has a kind
  in `PINGED_MESSAGE_KINDS`, no `pinged_at`, and `created_at` after `lastMs` (or `lastMs` is NaN).
- It counts `summary.pingedByMessage`, a new optional field beside `pingedByObservation` (`:532`).
- It joins the cadence skip at `:4492`:
  `if (!focus && !pinged && !messagePinged && !plannerCadenceDue(…))`.

### Automated verification
- [x] typecheck, lint and test pass
- [x] `src/calls/messagePing.test.ts` mirrors all seven cases in `observationPing.test.ts`:
  - idle;
  - claim, then pass the CLAIMED row;
  - summary printed;
  - a lost claim runs nothing;
  - a throwing pass is swallowed, with exactly one claim;
  - **blocked claims nothing**;
  - a failing read is swallowed.

  Plus: the reader is called with `(PINGED_MESSAGE_KINDS, 1)`.
- [x] `lifecycle.test.ts`: off-cadence with only a fresh unclaimed message → the planner runs; both
      probes false → skipped, with the new text
- [x] `planner.test.ts`: an off-cadence firm with a fresh unpinged `inform` → planned, with
      `pingedByMessage: 1`. The same with a `reply`, an `ask`, or a pinged `inform` → skipped
      `off_cadence`.

### Live verification (agent-executable, LOCAL stack only)
- Prerequisites:
  - this worktree's stack is up;
  - `npm run seed:local` and `npm run build`;
  - **a Telegram binding for the seeded firm (review fix b)**. `seed:local` sets no
    `telegram_user_id`, so `listTenantIdsWithTelegramBindings` filters the tenant out and the pass
    silently does nothing. Run on the LOCAL `DATABASE_URL` from `.env.test`:
    `update technicians set telegram_user_id='9000000001' where ref='manager-sam';`
  - **The worker does not load `.env`** (`calls:worker` = `node dist/calls/runWorker.js`). Export
    ONLY these:
    - the local `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `.env.test`;
    - `INFERENCE_API_KEY`, set to the `OPENROUTER_API_KEY` value;
    - `PLANNER_MODE=shadow`.
  - **Never source `.env`**: its `SUPABASE_URL` is the pilot.
- [x] Insert, via `psql` on `.env.test`'s `DATABASE_URL`, a `to_planner` `inform`, a `reply` and an
      `ask` for that firm.
- [x] Run the worker until the log line `[calls:message-ping] focused pass <inform id>` appears,
      and wait for it rather than for a fixed time.
- [x] Read back:
  - the inform has `pinged_at` set and `status='read'`;
  - the reply and the ask are untouched;
  - the pass ran on the message door's prompt (the loop's `label` / cost row).

  Cost ≈ $0.02–0.08.

  **Result (2026-09-23, local stack, GLM 5.3, shadow):** seeded an inform, a reply and an ask
  (tenant `0168d6ba…`) at 19:05:41Z; the worker logged `[calls:message-ping] focused pass
  a7a3a75d… {"focused":true,"focusMessageId":"a7a3a75d…","planned":1,…}`. Read back over pg: the
  inform `pinged_at` 19:06:10.432Z, `status='read'`, `read_at` 19:06:10.451Z (29s after the
  insert, inside the worker's startup plus its 10s idle poll); the reply and the ask still
  `unread`, `pinged_at` null. Cost rows: lane `planner`, 2 model calls, 30,347 input tokens
  (~15K per call, the full message-door prompt plus tools, vs ~5K for a waiting door). **What
  the office did:** read its notes, submitted an empty plan, and did NOT file the standing
  instruction — in a local world with an empty memory index and no Harbor jobs. An earlier
  attempt of the same check (evidence lost to cleanup) wrote to its notes twice. One live run is
  not a rate; the notes eval (30/30) is the measurement. Rows deleted afterwards.

### Manual verification
- none

## Rollout (operator, after merge; not part of /implement)

**Order: migration → lifecycle-heart → Calls worker (review fix c).**

1. Apply the migration to the pilot FIRST, through the Supabase MCP or the SQL editor (never
   `db push`). Pilot writes are the operator's to run.
2. Deploy `lifecycle-heart`, so the tick claims and filters before anything else claims.
   - It does not auto-deploy; read `autoDeploy` from the Render API.
   - The web service also needs a deploy for Phase 2's waiting-door prompts and the `news` writer.
     It does not auto-deploy either.
3. Deploy the Calls worker last. It auto-deploys from `main`, so merging the PR IS this step:
   - **the migration must already be on the pilot when the PR merges**;
   - so must `lifecycle-heart`, or a merge-time worker starts claiming while the old tick ignores
     claims. That would be a double-handled message for one tick, not a lost one.
4. If the code lands before the migration anyway:
   - the tick's claim throws, so it shows the slice unclaimed, today's behaviour;
   - the message loop logs a failed read every idle backoff until the column exists.
   - **the `news` writer is the one silent loss**: the old kind check rejects `'news'`, and
     `tellThePlanner` is best-effort, so an access decision made in that window never reaches the
     planner (the grant itself still commits; only the planner's copy is lost). Another reason
     the migration goes first.

## Named holes (build fast, then fill)

- **Concurrent note writes can race.** Two passes filing into the same memory file at once:
  `writeMemoryFile` is read-modify-write, so the later write can drop the earlier one. Rare (needs
  a focused pass and a tick on one firm's same file within seconds), not fixed here.
- **"You see a message ONCE"** is slightly untrue for the tick after fix A. The appendix header
  carries the correction; the doctrine is left byte-pinned.
- **Seat-side wording** (`DOCTRINE_UPDATES` / `bootstrap-box.sh`) still says an inform is read "at
  the office's next planning pass". "Shortly" remains true. Not edited here: that text is
  drift-tested by step 1, and editing it means telling step 1 first.
- **The office's replies to a Copilot seat** wait for step 3 (see above).
- **The already-read appendix overlaps on purpose** (Phase 3 review): its window starts one lease
  before the last look, because a message pass stamps `read_at` with its START time and one that
  spans a tick's start would otherwise fall between two windows (with no known last look: 24h back,
  the desk appendix's fallback). Rows read at exactly the last look's instant are left out
  (they are that tick's own reads — final review). The remaining cost is repetition: a pass's
  reads just before a look, and an earlier tick's reads when two ticks land within the lease, can
  reappear under "ALREADY READ BY THE OFFICE". They are labelled handled and are never work.
- **The appendix is capped at 30, newest first, with no "N more" line.** After a flood (a tick
  that read 30 messages), the oldest row in the window — exactly a message a pass read just before
  that tick — is the one dropped, and a failed appendix read on a tick that then succeeds loses
  that window for good. Both are rare; neither is fixed here.
- **A manager's question door is handed `recall_decisions` with no doctrine for it**: the waiting
  composition leaves out `MEMORY_DECISIONS` (as specified), so the tool's own description is its
  only guidance. Matters only if the live model misuses it on manager questions.
- **The waiting-door size test has ~10% headroom** (4,076 of 4,500): a paragraph added to WRITING,
  NOTES or CONTEXT (shared with the planner) trips it, which is the intended alarm.
