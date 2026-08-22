---
date: 2026-08-22
task: Give the ladder a ground truth — an answer names its gap, `answered` stops meaning `filled`, and a tick that decides nothing still leaves a trace
research: thoughts/shared/research/2026-08-22-brain-memory-foundations.md
status: draft
---

## Overview

The planner's memory has nothing trustworthy to learn from. Three holes in one seam: an answer
never says which question it answered; `nudges.status = 'answered'` means "traffic landed on the
job" rather than "the hole is closed"; and a tick that looks at fifteen gaps and decides all
fifteen can wait writes nothing. This plan fixes the ground truth. It deliberately does **not**
build the manager-facing drain for money items — that is Group B.

## Decisions

- **How an answer names its gap — USER, 2026-08-22: a short ref code, with the inference fallback
  underneath.** Rejected: a raw 36-char nudge id (this repo has repeatedly measured models
  mangling long literals — the date rail exists for that — and a mistyped id is a *silent*
  misattribution where an unknown code is a refusal); and no code at all. The fallback is built
  regardless, since an assistant may simply not pass the ref.
- **Where the ref rides — decided here: the message text, written by compose.** The MCP badge
  covers `tenantId.technicianRef` only ([identity.ts:54](src/mcp/identity.ts#L54)), so the
  `nudge-<uuid>` session name cannot be read back server-side; `nudge-runner.sh` passes
  `--message-file` and has no side channel into a tool call.
- **The code is minted at QUEUE time, not create time — decided here (review finding).**
  `createPendingNudge` catches 23505 to mean "already considered, ever"
  ([nudges.ts:50](src/db/nudges.ts#L50)); a second unique constraint on the same insert would make
  that catch ambiguous, and `PostgrestError` exposes no `constraint` field to disambiguate with
  (only `{message, details, hint, code}` — see [rawCaptures.ts:112](src/db/rawCaptures.ts#L112)).
  Minting in `markNudgeQueued` leaves that catch untouched and makes its own 23505 unambiguous.
  A code is only needed when the message is written, which is exactly then.
- **A cost gap answered but not on the ledger — USER, 2026-08-22: record both facts, change no
  routing.** Rejected: converging `filled` with `itemResolved`, and auto-opening a manager item —
  both add load to a queue holding 90 open items with zero ever resolved.
- **`holeClosed` is a NEW spec method, deliberately NOT unified with `buildGapView`'s
  `recordFilled` — decided here (review finding).** Unifying them looks like removing a duplicate
  but is a behaviour change: `validateDecisions` authorises a `basis:'record'` close from
  `view.recordFilled` for **any** kind ([planner.ts:775](src/teamLead/planner.ts#L775)), and a
  visit gap's `recordFilled` is null today only because of the `n.kind === 'job_cost_gap'` guard
  at [planner.ts:428](src/teamLead/planner.ts#L428). Giving the visit kind a non-null record
  verdict would start accepting record-basis closes that are refused today.
- **How "considered and left alone" is produced — USER, 2026-08-22: code infers, model may
  explain.** Code writes a row for every gap the model saw and did not name; a new `leave` action
  lets it say *why* it waits.
- **Append-only is preserved — decided here.** Rows are appended, never updated; the model reads a
  code-computed rollup, never the rows.
- **`recall_decisions` excludes `unmentioned` rows — decided here.** They are the homogeneous
  filler the research measured collapsing retrieval (88.5% of queries returned one item).
- **Ref codes are scoped to the calling technician, fail-closed — decided here (review finding).**
  A ref resolves only to a nudge whose `technician_id` is the caller's roster row. This tool also
  serves **roster-less badges**, where `caller` is null ([server.ts:2256](src/mcp/server.ts#L2256))
  and no scoping is possible — those refuse the ref and record the note.

## Plain-language walkthrough

**Phase 1 — the answer says which question it answers.** Today the office asks Ben a question, Ben
answers through his assistant, and the answer arrives with nothing saying what it was about. The
spine guesses by asking "did anything land on this job after we asked?" — right when there is one
question, wrong when there are two. This phase gives every question a short reference, prints it
in the message, and lets the assistant hand it back.

```
  gap cf90711d…   ref K7M2QX4P   (minted when the question is composed)
        │
        ▼
  "…what did the job cost? (when they answer, save it with ref K7M2QX4P)"
        │
        ▼
    Ben's assistant asks ──▶ Ben: "about $780"
        │
        ▼
    record_field_note({ text: "about $780", ref: "K7M2QX4P" })
        │
        ├── note recorded FIRST, always ──────────────▶ L1 + L2
        │
        └── then: K7M2QX4P → this technician's open gap → stamp it
                  unknown / not theirs → refWarning, note still recorded
```

The note is never lost to a bad ref. You would notice it working by reading
`nudges.answered_by_capture_id` on the pilot: a closed gap points at the capture that answered it.

**Phase 2 — `answered` stops meaning `filled`.** One word carries two facts today. When Ben says
"$780", the cost gap closes as "answered" while the money ledger is still empty — so the hole it
named is wide open. This phase records both facts. Routing does not change: the gap closes exactly
when it closes today, so no new items reach the manager's queue.

```
   before                          after
   ──────                          ─────
   status: answered                status:       answered   ← someone replied
                                   record_filled: false      ← the hole is still open
```

**Phase 3 — the quiet ticks leave a trace.** The planner wakes every 30 minutes and usually
decides, correctly, to wait. Today that writes nothing, so next tick starts from zero — on the
pilot, ~14 Friday-afternoon ticks left no record. This phase writes one row per gap per tick and
gives the model one line summarising them.

```
   before   prior decisions: 1 (last: extend, 3h ago).
   after    watched since Fri 12:07 — considered 15×, last: extend 3h ago.
```

"last" names the newest **real** decision, skipping the filler rows — otherwise it would say
`unmentioned` on almost every gap. The model never reads the rows, only that line.

## Secrets & env preflight

- **Phases 1–3:** none. No new secret; `record_field_note`, compose and the planner all use
  existing config.

Every phase needs the local Supabase stack (`npx supabase start`, `.env.test`) and ends with
**`npm run gen:types:local`** — never `npm run gen:types`, which is `--linked` to the pilot.
**Grep `project_id` in `supabase/config.toml` before any local supabase command.**

---

## Phase 1: An answer names its gap

### What this phase does
Mints a short per-tenant-unique reference code when a question is composed, prints it in the
message, accepts it back on `record_field_note`, and stamps the answering capture onto the nudge.
Builds the inference fallback underneath so attribution still happens when the ref is absent.

### Changes required

**`supabase/migrations/20260822120000_nudge_ref_code.sql`** (new)
- `add column ref_code text;` and `add column answered_by_capture_id uuid;` — no FK on the latter:
  L1 is append-only and must not be constrained by the ladder (`nudge_decisions.job_id` precedent).
- `create unique index uq_nudges_ref_code on nudges (tenant_id, ref_code) where ref_code is not null;`
- Header states: minted at queue time, per-tenant unique, never reused.

**`src/db/nudges.ts`**
- `export function mintRefCode(): string` — 8 chars from `23456789ABCDEFGHJKMNPQRSTVWXYZ`
  (no `0/O`, `1/I/L`, `U`). `randomInt` from `node:crypto`, never `Math.random`.
- `markNudgeQueued(id, tenantId, question, mint: () => string = mintRefCode)` — sets `ref_code`
  alongside `question`. On 23505 (unambiguous here: `uq_nudges_subject_ever` cannot fire on this
  UPDATE) retry with a fresh code up to 3 times, then throw. `mint` is the **test seam**.
  `createPendingNudge` is NOT touched.
- `getNudgeByRefCode(tenantId, refCode, technicianId): Promise<Nudge | null>` — filters
  `tenant_id`, `ref_code`, `technician_id`, `status in OPEN_NUDGE_STATUSES`.
- `setNudgeAnsweredBy(id, tenantId, captureId): Promise<Nudge | null>` — guarded with
  **`.is('answered_by_capture_id', null)`**, so the first answer wins. `.eq(col, null)` renders as
  `col=eq.null` and matches zero rows — there is no `.eq(x, null)` anywhere in `src/db/`.

**`src/teamLead/composeCopy.ts`**
- `ComposeContext` / `CostComposeContext` gain `refCode: string | null`; both readers take it from
  the nudge ROW (a column, not `context`) — they already receive the `Nudge`.
- Both `assemble*Message`: when non-null the footer's closing sentence gains `, passing ref
  ${refCode},`. When null the sentence is **byte-identical to today** — an old nudge must deliver.
- Callers to update: `src/teamLead/compose.test.ts:414-421` and `:434-441` build `ComposeContext`
  literals inline.

**`src/mcp/server.ts`**
- `record_field_note` inputSchema gains `ref` (string, **not** in `required`): the code from the
  question you were asked to pass back; omit if you were not given one.
- `StagedNoteDetail` ([:1821](src/mcp/server.ts#L1821)) gains `answersRef?: string`, set when the
  note is staged. **Without this the ref is lost on every resume** — the tool contract says
  `needs_identity` / `needs_confirmation` are answered with `confirmId` (+`confirmed`) and no
  text, so the two resume `commitNote` calls ([:2464](src/mcp/server.ts#L2464),
  [:2516](src/mcp/server.ts#L2516)) never see the original `ref`. Those are exactly the ambiguous
  replies a nudge answer produces.
- All three `commitNote` sites ([:2316](src/mcp/server.ts#L2316), `:2464`, `:2516`) **merge**
  `answersRef` into `sourceMeta` — the resume paths already pass `{ stagedConfirmId: item.id }`,
  so replace nothing.
- **Attribution runs AFTER a `recorded` result, never before the append.** `recordFieldNote`
  resolves the job *after* L1 lands ([recordFieldNote.ts:251](src/writePath/recordFieldNote.ts#L251))
  — which is why the live specimen has `job_id = NULL` — so a pre-append job comparison has
  nothing to compare. Use the `captureId`/`jobId` the commit returns.
  - `ref` present + `caller` non-null → `getNudgeByRefCode` → `setNudgeAnsweredBy(captureId)`.
  - `ref` present but unresolved, or `caller` null (roster-less badge, no `technicians.id` to
    scope by — [server.ts:2256](src/mcp/server.ts#L2256)) → **never fail the call.** Return
    `refWarning: 'that ref did not match an open question of yours — the note was recorded without it'`.
  - `ref` absent → fallback: if the caller has exactly ONE open nudge whose context `jobId` equals
    the returned `jobId`, stamp it. More than one → stamp nothing; the planner judges.

**`Box_Setup_Stuff/bootstrap-box.sh`** — the doctrine that actually reaches an agent
- One line inside the **existing** `## Permanent-record writes` AGENTS.md heredoc section
  ([:629](Box_Setup_Stuff/bootstrap-box.sh#L629)): when a delivered question names a ref, pass it
  to `record_field_note`; never invent one.
- **Add no new heading** — `EXPECTED_SECTIONS` in [doctrine.ts:28](src/eval/doctrine.ts#L28) pins
  the section list and fails on drift.
- Mirror the wording into `docs/nemoclaw-tech-agent.md` (the human copy). There is no
  `Box_Setup_Stuff/nemoclaw-tech-agent.md`.

### Automated verification
- [ ] the CLAUDE.md gates: `npm run typecheck`, `npm run lint`, `npm test`
- [ ] `npm run gen:types:local` run after the migration; `database.types.ts` committed
- [ ] `mintRefCode`: length 8, alphabet-only, over 10k samples
- [ ] `markNudgeQueued` retries on a ref collision and throws after 3 — driven through the `mint`
      seam against a row already holding that code
- [ ] `createPendingNudge`'s "already considered" 23505 path is unchanged (regression test)
- [ ] `getNudgeByRefCode` returns null for another tenant's, another technician's, a closed gap's
- [ ] `setNudgeAnsweredBy` stamps once and is a no-op on a second call **with a different capture
      id** (proves the guard, not just the path)
- [ ] both `assemble*Message` carry the ref when present, **byte-identical to today** when null
- [ ] a bad ref returns `recorded` + `refWarning`, leaving `answered_by_capture_id` null
- [ ] a roster-less badge with a valid-looking ref records the note and warns
- [ ] **the ref survives a `needs_identity` round-trip**: stage, resume with `confirmId` +
      `confirmed`, and assert the nudge is stamped
- [ ] the single-open-gap fallback stamps; two open gaps on one job stamp nothing
- [ ] `src/eval/doctrine.ts` passes (section list unchanged)

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test`, plus ssh to `trades-box-1` for the wire.
- **Dependency, stated precisely:** PR #163 deployed and the fleet was re-wired 2026-08-22, so the
  seats are current. This phase edits the SAME `## Permanent-record writes` block, so its
  seat-agent E2E needs a **second** wire after this phase lands — it cannot run inline, and the
  wire must not be run before the spine deploys (the box would promise a `ref` the tool rejects).
  Wire order is fixed: `export PATH="$HOME/.local/bin:$PATH"` (a bare `nemoclaw` is not on a
  non-interactive ssh PATH) → md5 the repo tree against the box → s2 canary → verify
  **in-container** → fleet → audit a non-s2 seat.
- [ ] After deploy: a newly-queued pilot nudge has a non-null 8-char `ref_code`. Evidence: the row.
- [ ] After the second wire: a seat agent handed a ref-bearing question passes it back, and the
      nudge gains `answered_by_capture_id`. Evidence: the nudge row + the capture's `metadata`.

### Manual verification
- [ ] The ref sentence reads naturally and leaks no operator vocabulary to the technician.

---

## Phase 2: `answered` stops meaning `filled`

### What this phase does
Adds a per-kind `holeClosed` predicate — "is the hole this gap names actually closed" — used
**only by the sweep**, and records its verdict on the nudge at closure. `buildGapView`'s
`recordFilled` is deliberately untouched (see Decisions).

### Changes required

**`supabase/migrations/20260822130000_nudge_record_filled.sql`** (new)
- `alter table nudges add column record_filled boolean;` — null while open, and null forever on
  rows closed before this phase. No back-fill: an old row's verdict is genuinely unknown.

**`src/jobs/nudgeKinds.ts`**
- `NudgeKindSpec` gains `holeClosed(n: Nudge, f: SweepFacts): string | null`.
- `OVERDUE_VISIT_GAP_SPEC.holeClosed` — a visit gap's hole IS "nothing recorded since the visit",
  so it delegates to what `filled` uses. Document that the coincidence is real.
- `JOB_COST_GAP_SPEC.holeClosed` — non-null only when `f.jobsWithCostEvents.has(jobId)`.
  **`filled` is unchanged** — that is the whole point of the split.
- Update `SweepFacts.jobsWithCostEvents`'s comment: now consumed by `holeClosed`, still
  deliberately not by `filled`.
- **Every implementer must gain the method.** Three exist: `:239`, `:367`, and the full literal
  `secondSpec` at [watchers.test.ts:1132](src/jobs/watchers.test.ts#L1132) (its `...over` spread is
  `Partial`, so it does not supply a required member). `compose.test.ts:459` and
  `watchers.test.ts:1823` spread a real spec and survive.

**`src/db/nudges.ts`**
- `markNudgeOutcome` gains an optional **6th** parameter `recordFilled?: boolean`. Write the column
  only when `!== undefined` — `?? null` would clear it, the exact trap `setNudgeSchedule`
  documents at [nudges.ts:255](src/db/nudges.ts#L255).

**`src/jobs/watchers.ts`**
- The two closing sites ([:569](src/jobs/watchers.ts#L569), [:575](src/jobs/watchers.ts#L575)) are
  4-arg calls, so reaching the 6th means passing `OPEN_NUDGE_STATUSES` explicitly as the 5th —
  the existing default, stated rather than a placeholder.
- `filled` path passes `!!spec.holeClosed(x.n, facts)`; `moot` path passes `false` (a cancelled
  job's hole is not filled).
- Escalation/expiry ([:656](src/jobs/watchers.ts#L656), [:753](src/jobs/watchers.ts#L753)) are
  untouched and leave the column null.

**`src/teamLead/planner.ts`**
- `applyDecision`'s `close` case passes `d.basis === 'record'` as `recordFilled` — a record-basis
  close means the record itself says the hole is shut; an evidence-basis close means a person said
  so. **No `views` parameter is needed**, and the signature at
  [:972](src/teamLead/planner.ts#L972) does not change.

### Automated verification
- [ ] the CLAUDE.md gates (typecheck / lint / test) + `npm run gen:types:local`
- [ ] a cost gap with a note but no ledger row closes `answered` with `record_filled = false`
- [ ] the same gap with a ledger row closes with `record_filled = true`
- [ ] a visit gap closed by a field report gets `true`; a `moot` close gets `false`
- [ ] escalation and expiry leave `record_filled` **null**, not `false`
- [ ] a planner close with `basis:'record'` writes `true`; `basis:'evidence'` writes `false`
- [ ] **routing unchanged**: same gaps close/escalate/expire, same `WatcherSummary` counts
- [ ] **`buildGapView` output is byte-identical to today**, asserted by the existing whole-string
      test at [planner.test.ts:1645-1661](src/teamLead/planner.test.ts#L1645-L1661) and the
      `THE RECORD:` assertion at [:821](src/teamLead/planner.test.ts#L821) — this is what proves
      `holeClosed` did not leak into the planner's close authorisation

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test`.
- [ ] After deploy, pilot nudge `1e1c0a27…` (the $780 cost gap) has `record_filled` **null**, not
      `false` — it predates the column, so old rows stay honestly unknown. Evidence: the row.

### Manual verification
- None.

---

## Phase 3: The quiet ticks leave a trace

### What this phase does
Writes one `nudge_decisions` row per open gap per planner tick — including gaps the model did not
mention, and including a tick that failed outright — and replaces the pushed history line with one
carrying elapsed time and a consideration count.

### Changes required

**`supabase/migrations/20260822140000_nudge_decisions_leave.sql`** (new)
- Drop and re-add `nudge_decisions_action_check` with `'leave'` and `'unmentioned'` added to the
  existing five. Follow [20260821180000_nudge_decisions_extend.sql](supabase/migrations/20260821180000_nudge_decisions_extend.sql)
  exactly, including its `drop constraint if exists` and its verify-the-name-against-the-pilot note.

**`src/teamLead/planner.ts`**
- `PLANNER_ACTIONS` gains `'leave'`. `'unmentioned'` is **code-only**, never in that array — it
  must be unwritable by the model, and `validateDecisions` must refuse it.
- `SUBMIT_PLAN_TOOL`'s action enum gains `'leave'`; `PLANNER_SYSTEM` gains one line: it means "I
  looked and I am waiting", takes a reason, changes nothing.
- `applyDecision` gains `case 'leave': return { outcome: 'applied' };` — the switch is exhaustive
  over `PlannerDecision['action']` with no `default` ([:986](src/teamLead/planner.ts#L986)), so
  this is required for the build.
- After the `decisions` and `dropped` loops ([:1227](src/teamLead/planner.ts#L1227)), append a
  third source: every `nudgeId` in `views` in neither, as
  `{ action: 'unmentioned', confidence: 'low', reason: '', outcome: live ? 'applied' : 'shadow' }`.
- **The failure path too:** the per-tenant `catch` ([:1330](src/teamLead/planner.ts#L1330)) sits
  after `runLoop`, so a `ToolLoopLimitError` or provider error currently writes nothing. Append one
  `unmentioned` row per view there with `outcome: 'refused'`, `outcomeDetail: 'tick failed: <msg>'`.
  Without this the phase's own goal fails in exactly the case worth knowing about.
- `historyLine(history, nowMs, tz)` ([:331](src/teamLead/planner.ts#L331)) — **`tz` is a new
  parameter**, threaded from the call at [:457](src/teamLead/planner.ts#L457) — becomes:
  `watched since <first decided_at via clockLabel> — considered N×, last: <action><marker> Xh ago.`
  - `last` = the newest row whose `action !== 'unmentioned'`. Rendering `history[length-1]` would
    say `unmentioned` on nearly every gap, since filler is appended every tick. When there is no
    real decision yet, omit the `last:` clause rather than inventing one.
  - `N` = `history.length`. Rows predating this phase under-count, so say "considered" (what a row
    now means), never a tick count the data cannot back.
  - Still returns `null` on empty history.
- Three tests pin the current bytes and must move with it:
  [planner.test.ts:1009](src/teamLead/planner.test.ts#L1009), [:1019](src/teamLead/planner.test.ts#L1019),
  [:1025](src/teamLead/planner.test.ts#L1025).

**`src/db/nudgeDecisions.ts`**
- `listDecisionsForNudge` / `listDecisionsForJob` (the `recall_decisions` lookups) filter out
  `action = 'unmentioned'`. `listDecisionsForNudges` (the per-tick read feeding `historyLine`)
  keeps them — the count is the point.
- **Add `.order('id')` after `.order('decided_at')`** in all three: `decided_at` defaults to
  `now()`, so every row from one insert shares a timestamp and "newest" is otherwise undefined.
- Growth note: rows accrue per open gap per in-window tick (~24/day), bounded by gap lifetime (18h
  delivery deadline + 48h absolute ceiling) — **except** under `NUDGES_MODE` off/shadow with
  `PLANNER_MODE` live, where nothing closes gaps. Add a per-gap cap: stop appending `unmentioned`
  once a gap's history exceeds 200 rows, logging once when it first bites.

### Automated verification
- [ ] the CLAUDE.md gates (typecheck / lint / test) + `npm run gen:types:local`
- [ ] 3 open gaps, model names 1 → **3** rows (1 decision, 2 `unmentioned`)
- [ ] an EMPTY plan over 3 open gaps writes 3 rows (today: zero)
- [ ] a tick whose `runLoop` throws writes 3 `unmentioned` rows with `outcome='refused'`
- [ ] `leave` records the model's reason; `unmentioned` records none — distinguishable
- [ ] `'unmentioned'` submitted by the model is REFUSED by `validateDecisions`
- [ ] shadow mode writes `outcome='shadow'` and touches no nudge
- [ ] `recall_decisions` omits `unmentioned`; the per-tick read includes them
- [ ] **`historyLine` reports the last REAL action** with 20 `unmentioned` rows appended after it —
      the test that would have caught the filler bug
- [ ] `historyLine` omits `last:` when every row is `unmentioned`; returns null on empty history
- [ ] the 200-row cap stops appending and logs once

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test`.
- [ ] After deploy, one in-window tick adds a row per open pilot gap rather than zero. Evidence:
      `select action, count(*) … group by action` before and after, with timestamps.

### Manual verification
- None.
