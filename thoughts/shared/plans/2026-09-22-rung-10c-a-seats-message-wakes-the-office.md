---
date: 2026-09-22
task: rung 10c — a seat's message wakes the office within seconds, the way an inbound call already does
research: thoughts/shared/research/2026-09-20-the-desk-as-the-offices-fast-path.md
status: draft
supersedes: nothing
---

## Overview

A technician's `inform_team_lead` today waits for the planner's cadence — up to 30 minutes in firm
hours, 120 outside them — while an inbound call reaches the office in ~10 seconds (rung 10). This
plan gives seat messages the same wake: a claim column on `office_messages`, a focused office run
scoped to ONE message, and a third loop in the Calls worker plus rung 10's two fallbacks. It
changes WHEN the office reads a message, not WHAT it does with one.

## Decisions

- **One agent, split by trigger** (operator, 2026-09-22). Pinged = the office; 30-min cron = the
  planner. Recorded in docs/engineering-memory.md (rung 10c section) and memory
  `office-and-planner-are-one-agent`.
- **A seat's message wakes the FOCUSED-PASS path** (operator, 2026-09-22) — rung 10's chassis, which
  already carries the full tool surface and the guarded send path. `answerDeskQuestion` (the path
  where a seat waits for an answer) is untouched.
- **The office texts people itself; no escalate hop** (operator). The double-text guard is a DB
  stamp (`asked_at`), so one agent needs nothing kept in sync.
- **The office may file a standing instruction as it reads it** (operator; measured 29/30 in
  thoughts/shared/research/2026-09-20-the-planner-notes-doctrine-measured.md).
- **Scope: WHEN, not WHAT.** The planner prompt's message doctrine is unchanged except one line
  naming what a message pass is about. Having the office act operationally on messages (L2 verbs)
  is rung 10d, sequenced after (operator).
- **Which kinds wake: `inform` + `reply`** — RECOMMENDED, for the operator's review. `ask` is
  excluded: the quick-answer path answers it while the seat waits and marks it read
  (desk.ts:241-245); it stays unread only when that failed, and the tick already covers that
  case. `desk` rows are born read. Constant: `PINGED_MESSAGE_KINDS`.
- **The claim column is `pinged_at`, mirroring `observations.pinged_at`** (precedent
  supabase/migrations/20260908100000_inbound_asks_and_job_captures.sql:19-36). Partial index on
  `(created_at)`, fleet-wide (no leading `tenant_id`), predicate = the reader's WHERE minus the kind
  list — the rung-10 idiom. **No backfill**: an unread row is at most one tick old (the tick marks
  what it shows read), so the first worker drain is ordinary work, not a burst.
- **The claim is a LEASE, and the tick claims too** (found while planning). With two readers — the
  focused pass and the half-hourly tick — one message could be handled by both at once, and now
  that the office can create L2 rows that is a duplicate write with nothing like `asked_at` behind
  it. Rule: the ping loop takes only UNCLAIMED rows and never releases a claim; the tick shows only
  rows it claims itself — unclaimed, or claimed longer ago than `OFFICE_CLAIM_LEASE_MS` (10 min,
  above the 180 s focused-pass budget). A crashed pass's message is therefore recovered by the
  first tick at least 10 minutes later (worst case ~40 min vs today's 30). This deliberately
  differs from rung 10, which stamps observations only after success, because observations have
  `asked_at` as a backstop and messages have none.
- **`focus` becomes a union told apart by which id field is present, not by a `kind` tag.**
  `planner.test.ts:7026` builds a focus through an `as unknown as` cast; a `kind` tag would make
  that test silently take the message branch instead of failing to compile.
- **A third independent loop in `runWorker.ts`**, not a fold. That file documents why its loops are
  separate (own backoff, no pass blocking another queue). Cost: at most two focused passes at once
  per worker. The new loop backs off at the idle rate on `'error'` too, so a failing read (e.g. the
  column not yet migrated) does not spin every 500 ms.
- **Both of rung 10's fallbacks are mirrored**, keyed on `PINGED_MESSAGE_KINDS`: the heartbeat probe
  (lifecycle.ts:81-94) and the per-firm due check (planner.ts:4475-4490).

## Plain-language walkthrough

```
seat: "route all job messages to Sam"  ──▶ office_messages row (unread, pinged_at empty)
                                               │
      ┌── Calls worker, every ~10s ────────────┤  Phase 3
      │   claims it (pinged_at = now)          │
      ▼                                        ▼  fallback, if the worker is down
  the office, scoped to THIS message       the heartbeat (every 5 min) runs the firm early,
  (Phase 2): acts, may file a note,        claims the message itself, shows it
  marks it read                            (a claim older than 10 min counts as abandoned)
```

**Phase 1 — a "someone has this" stamp.** Messages today only have unread/read. If a worker
marked a message read to claim it and then crashed, the message would be gone for good — nothing
ever shows a read message again. So we add a separate stamp, `pinged_at`, meaning "a pass has
picked this up". You'd notice it working as a new column in the database and passing tests.

**Phase 2 — the office can look at just one message.** Rung 10's focused pass shows the office
one inbound call and hides everything else. This phase adds its mirror image: show ONE message,
hide the gaps. It also makes the half-hourly tick claim the messages it shows, so the two readers
can never handle the same message at once. Nothing calls the new pass yet.

**Phase 3 — the wake.** The Calls worker (the always-on process that already wakes the office for
calls) gains a loop that picks up new `inform`/`reply` messages every ~10 seconds, plus the same
two safety nets rung 10 has for when that process is down. You'd notice it working: a message
written locally gets `pinged_at` and turns `read` within seconds, and the worker log names it.

## Secrets & env preflight

- **Phase 1:** none — local stack only; `.env.test` was generated by `scripts/second-stack.sh`.
- **Phase 2:** none.
- **Phase 3 (live check):** `OPENROUTER_API_KEY` in `.env` (already present); `PLANNER_MODE=shadow`
  set inline for the one command, never written to a file.
- **Rollout:** no new variables. The Calls worker has carried `PLANNER_MODE` and the inference
  credentials since rung 10 — read them back through the Render API before deploying.

## Phase 1: the claim column

### Changes required

**`supabase/migrations/20260922120000_office_messages_pinged_at.sql`** (new) — additive, safe to
apply before the code (header says so, 20260908100000 style):
```sql
alter table office_messages add column if not exists pinged_at timestamptz;
comment on column office_messages.pinged_at is 'Rung 10c: a pass has CLAIMED this message (the Calls-worker''s guarded claim, or a tick about to show it). Separate from status on purpose: a crashed pass leaves it unread, and a claim older than OFFICE_CLAIM_LEASE_MS is treated as abandoned. Not a read marker.';
create index if not exists idx_office_messages_unpinged
  on office_messages (created_at)
  where direction = 'to_planner' and status = 'unread' and pinged_at is null;
```

**`src/db/officeMessages.ts`** — four accessors plus a constant, each written in the style of its
observations twin (`src/db/observations.ts:402-551`):
- `export const PINGED_MESSAGE_KINDS: OfficeMessageKind[] = ['inform', 'reply'];`
- `listUnpingedOfficeMessages(kinds, limit)` — FLEET-WIDE by design (the worker polls every
  tenant, like `listUnpingedObservations`): `direction='to_planner'`, `status='unread'`,
  `kind in kinds`, `pinged_at is null`, oldest `created_at` first. `[]` on empty kinds.
- `claimOfficeMessagePing(id)` — `update pinged_at=now` guarded on `pinged_at is null` AND
  `status='unread'`, `.maybeSingle()`; null means "someone else has it, or it was read".
- `hasFreshUnpingedOfficeMessage(kinds, sinceIso)` — the heartbeat probe: same predicate plus
  `created_at >= sinceIso`, `limit(1)`, boolean. `false` on empty kinds.
- `claimOfficeMessagesForTick(tenantId, ids, staleBeforeIso): Promise<string[]>` — TENANT-SCOPED:
  `update pinged_at=now` where `tenant_id`, `id in ids`, `status='unread'`, and
  `.or(`pinged_at.is.null,pinged_at.lt.${staleBeforeIso}`)`; returns the ids it moved. `[]` on
  empty ids.

**`src/db/database.types.ts`** — inside this worktree (its `config.toml` carries its own
`project_id`): `npx supabase migration up` (add `--include-all` if it refuses as out of order),
then `npx supabase gen types typescript --local > src/db/database.types.ts`. **Never
`npm run gen:types`** — it is `--linked`, meaning the pilot. The diff must be only `pinged_at` on
the `office_messages` Row/Insert/Update; anything more means the local stack is behind, so stop.

**Fixtures** — `pinged_at: null` added to the one `OfficeMessage` row factory in each of
`src/teamLead/planner.test.ts` and `src/control/officeQueue.test.ts` (the only full-row literals;
`grep -n "read_at:"`), and to `officeRow` in `scripts/planner-eval/notes-run.mjs` for fidelity.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] new cases in `src/db/officeMessages.test.ts` (local stack): the reader returns only
      unread + unpinged `inform`/`reply` rows, oldest first, and skips an `ask`, a read row and a
      pinged row; the first `claimOfficeMessagePing` wins and the second returns null, and a read
      row cannot be claimed; `claimOfficeMessagesForTick` takes an unclaimed row and a stale claim
      but skips a live claim, and **tenant B's id passed with tenant A claims nothing** (the
      2-tenant leak case); the probe respects `sinceIso` and ignores `ask`

## Phase 2: the office can be scoped to one message

### Changes required

**`src/teamLead/planner.ts`**
- `:738` — `focus?: { observationId: string; budgetMs: number } | { messageId: string; budgetMs: number };`
  Every property read is narrowed with `'observationId' in focus`.
- `:526-528` — add `focusMessageId?: string;` beside `focusObservationId`. `:4229` spreads
  whichever id the focus carries.
- `:5173` — `focus && 'observationId' in focus ? focus.observationId : null` (the quiet-note pairing).
- `:5242-5247` — the gap-less chat-send binding runs ONLY for an observation focus. Hoist
  `const boundTo = focus && 'observationId' in focus ? focus.observationId : null;` and gate the
  map on `boundTo`. A message is not a gap, so there is no id to bind a send to.
- `:5073` — pass `focus ? ('observationId' in focus ? true : 'message') : false`.
  `buildPlannerUserMessage`'s `focused = false` (`:3534`) becomes `focused: boolean | 'message' = false`
  (so `true` keeps today's line for the eval scripts), and at `:3566` a `'message'` value renders:
  `This pass is about 1 message from a seat, under OFFICE MESSAGES; the firm's open gaps are not shown and are not yours now.`
- `:3381` — `export const OFFICE_CLAIM_LEASE_MS = 10 * 60_000;`, with a comment that it must stay
  above the focused-pass budget (a test pins that).
- PlannerDeps — `claimMessages?: typeof claimOfficeMessagesForTick;` (injected, per the standing
  't1' rule).
- `:4363` — rename the destructured `unreadMessages` to `unreadAll`, then:
  `const unreadMessages = focus ? unreadAll : unreadAll.filter((m) => !m.pinged_at || Date.parse(m.pinged_at) < nowMs - OFFICE_CLAIM_LEASE_MS);`
  A live claim belongs to a running focused pass, so it is neither shown nor counted as work by the
  `no_gaps` skip at `:4423`. **The filter must not run in focus mode** — a message pass's own row
  carries a fresh claim.
- `:4992` — `const unreadSlice = unreadMessages.slice(0, OFFICE_MESSAGES_SHOWN);` and
  `unreadShown` = `focus ? unreadSlice : <the slice filtered to the ids claimMessages returned>`.
  Call it only when the slice is non-empty. On a throw, log and fall back to `unreadSlice` (today's
  behaviour — this also covers an unmigrated column). **Never call it in focus mode**: the worker
  already holds that claim, and the guard would refuse it.
- `:5056` — `unreadMessages.length - unreadSlice.length` (a message lost to a race is not "more unread").

**`src/jobs/plannerPass.ts`**
- `export const FOCUSED_PASS_BUDGET_MS = 180_000;` — `runFocusedObservationPass`'s default
  (`:100`) uses it.
- `export async function runFocusedMessagePass(message: OfficeMessage, impl = runPlanner, budgetMs = FOCUSED_PASS_BUDGET_MS)`
  — the same blocked/mode preamble as `:102-104`, with `focus: { messageId: message.id, budgetMs }`
  and THE SCOPING INVERTED: `listTenants` filtered to `message.tenant_id`; `listOfficeMessages →
  [message]`; `listObservations`, `listNudges`, `listDeskTranscripts`, `listDismissedIds` and
  `listDismissedNudges` all `→ []`.

### Automated verification
- [ ] typecheck, lint and test pass; the existing observation-focus tests (`planner.test.ts:6618`,
      `:7026`, `:7203`, `:7243`) pass UNCHANGED
- [ ] `plannerPass.test.ts`: `runFocusedMessagePass` hands `impl` those exact pinned readers and
      that focus; a blocked env returns `{ skipped }` without calling `impl`;
      `OFFICE_CLAIM_LEASE_MS > FOCUSED_PASS_BUDGET_MS`
- [ ] `planner.test.ts`, message focus: with zero gaps and one message the loop RUNS; the user
      message carries the message line and not `This firm has`; `claimMessages` is not called; the
      message is marked read; there is no `planner_runs` write; the summary has `focusMessageId`;
      a gap-less chat send keeps `nudgeId` null
- [ ] `planner.test.ts`, the tick: a row claimed 1 min ago is not shown, and a firm holding only
      that row skips `no_gaps`; a row claimed 20 min ago IS shown; a row `claimMessages` does not
      return is not shown; a throwing `claimMessages` shows the whole slice

## Phase 3: the wake, and rung 10's two fallbacks

### Changes required

**`src/calls/messagePing.ts`** (new) — `drainOneMessagePing(deps)`, a line-for-line mirror of
`src/calls/observationPing.ts`. Deps are `list` / `claim` / `pass` / `blocked`, defaulting to
`listUnpingedOfficeMessages` / `claimOfficeMessagePing` / `runFocusedMessagePass` /
`focusedPassBlockedBy`. `blocked()` runs BEFORE any read or claim, with its own
`lastBlockedReason`. Then `list(PINGED_MESSAGE_KINDS, 1)` → claim → pass the CLAIMED row → log
`[calls:message-ping] focused pass <id> <summary>`. Errors are swallowed, and the claim stays.

**`src/calls/runWorker.ts`** — `messagePingLoop()`, added as a third entry in `Promise.all` (`:61`).
Delay is `PING_BUSY_BACKOFF_MS` only on `'pinged'`, and `PING_IDLE_BACKOFF_MS` otherwise, error
included. The "TWO INDEPENDENT LOOPS" comment (`:54`) becomes three.

**`src/jobs/lifecycle.ts`** — import `PINGED_MESSAGE_KINDS` and `hasFreshUnpingedOfficeMessage`; add
deps `listFreshMessagePings?: typeof hasFreshUnpingedOfficeMessage`; add a
`freshUnclaimedMessage(nowIso, deps)` mirroring `:81-94` (same `PING_FALLBACK_WINDOW_MS`, and a
failed read counts as none). The gate at `:530` becomes
`!plannerTick && !(await freshUnclaimedObservation(…)) && !(await freshUnclaimedMessage(…))`, and
its skip text becomes `'off-cadence tick (no firm due, no unclaimed observation or message)'`.
Update the two assertions at `lifecycle.test.ts:906` and `:936`, and add
`listFreshMessagePings: async () => false` to the `STUBS` at `:803-813`, so no unit test reads the
database.

**`src/teamLead/planner.ts`** — at `:4475-4490`, add a `messagePinged` check: not in focus mode,
`lastRunReadOk`, and some message in `unreadMessages` with a kind in `PINGED_MESSAGE_KINDS`, no
`pinged_at`, and `created_at` after `lastMs` (or `lastMs` is NaN). It counts
`summary.pingedByMessage`, a new optional field beside `pingedByObservation` at `:531`, and joins
the cadence skip: `if (!focus && !pinged && !messagePinged && !plannerCadenceDue(…))`.

### Automated verification
- [ ] typecheck, lint and test pass
- [ ] `src/calls/messagePing.test.ts` mirrors all seven cases in `observationPing.test.ts`
      (idle; claim then pass the CLAIMED row; summary printed; a lost claim runs nothing; a
      throwing pass is swallowed with exactly one claim; **blocked claims nothing**; a failing read
      is swallowed), plus: the reader is called with `(PINGED_MESSAGE_KINDS, 1)`
- [ ] `lifecycle.test.ts`: off-cadence with only a fresh unclaimed message → the planner runs;
      both probes false → skipped, with the new text
- [ ] `planner.test.ts`: an off-cadence firm with a fresh unpinged `inform` → planned, with
      `pingedByMessage: 1`; the same with an `ask`, or a pinged `inform` → skipped `off_cadence`

### Live verification (agent-executable, LOCAL stack only)
- Prerequisites: this worktree's stack is up (`.env.test` → `127.0.0.1:54421`),
  `npm run seed:local`, and `npm run build`. **The worker does not load `.env`**
  (`calls:worker` = `node dist/calls/runWorker.js`), so export ONLY the local `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` from `.env.test`, `INFERENCE_API_KEY` = the `OPENROUTER_API_KEY`
  value, and `PLANNER_MODE=shadow`. **Never source `.env`**: its `SUPABASE_URL` is the pilot.
- [ ] Insert a `to_planner` `inform` for a seeded firm with a Telegram binding, plus an `ask`,
      via `psql` on `.env.test`'s `DATABASE_URL`. Run the worker for ~60 s. Read back: the inform
      has `pinged_at` set and `status='read'`; the ask is untouched; the log shows
      `[calls:message-ping] focused pass <inform id>`. Cost ≈ $0.02–0.08.

### Manual verification
- none

## Rollout (operator, after merge — not part of /implement)
1. Apply `20260922120000_office_messages_pinged_at.sql` to the pilot FIRST, through the Supabase
   MCP or the SQL editor (never `db push`). Pilot writes are the operator's to run.
2. Deploy `lifecycle-heart` and the Calls worker. Neither auto-deploys, so read `autoDeploy` from
   the Render API.
3. If the code lands before the migration: the tick falls back to today's behaviour (the claim
   throws, so it shows the slice unclaimed), and the message loop logs a failed read every ~10 s
   until the column exists.
