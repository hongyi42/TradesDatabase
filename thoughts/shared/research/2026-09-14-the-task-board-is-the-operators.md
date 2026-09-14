---
date: 2026-09-14
branch: work/the-task-board-is-the-operator-s-a-sessi
commit: d00564a
topic: The task board is the operator's — every place that teaches a session to park, what parking does mechanically, and what reads the pile
supersedes: nothing
---

## Summary

The **work record** is a folder of small Markdown files (`<main checkout>/.claude/work/tasks/`),
one per task or "parked finding", that every Claude session in every git **worktree** (a second
checkout of the repo on its own branch) can read the instant it is written. The **board** is
`npm run board`, a terminal table of worktrees and tasks. **Parking** (`/park`) writes a new file
into that folder with `status: open`. The operator ruled on 2026-09-14 that the board is theirs:
an item belongs there only if the operator must decide on it *and* it needs its own
Research → Plan → Implement (RPI) cycle; a small fix gets done in place, and a small decision gets
asked. Today the opposite is taught. Four prose documents say "out of scope → park it", and one
says explicitly "do not fix it here". Nothing in the tool distinguishes a one-line fix from a rung
of the build ladder. Three machine surfaces then push every open item, of either kind, back at
every session: the session-start line, the pre-edit hook and the board. This document maps all of
it: the prose, the CLI (command-line tool) verbs, the hooks, the tests that pin the wording, and
the 11 items open on the board right now. It records no recommendation.

## Entry Points

| Entry point | What starts there |
|---|---|
| `/park <what>` → `.claude/commands/park.md` | A session writes an open item into the record |
| `/implement` → `.claude/commands/implement.md:20` | The instruction that sends mid-implementation discoveries to `/park` |
| `/plan` → `.claude/commands/plan.md:30` | The adversarial plan review, a source of findings (it says "fix valid findings in the plan" but names no home for findings about code *outside* the plan) |
| `node scripts/work.mjs park` → `cmdPark`, `scripts/work.mjs:359-390` | The CLI verb that creates the file |
| `SessionStart` hook → `.claude/settings.json:50-61` → `cmdPacketForSession`, `scripts/work.mjs:514-595` | Announces the open-item count to every session (`:540-545`) |
| `PreToolUse(Edit\|Write)` hook → `.claude/settings.json:38-49` → `.claude/hooks/decisions-for-file.mjs` | Names open items against the file about to be edited (`:200-205`) |
| `npm run board` → `package.json:35` → `cmdBoard`, `scripts/work.mjs:1643-1694` | The operator's table |
| `/spawn <id>` → `.claude/commands/spawn.md` → `cmdSpawn`, `scripts/work.mjs:921-1053` | The only way a parked item becomes work in its own worktree |
| `/handoff` → `.claude/commands/handoff.md` → `done` / `promote` / `archive` | How an item leaves the live record |

## Key Files

**Prose that teaches parking** (every line the task file names, verified against this checkout at `d00564a`):

- `.claude/commands/implement.md`
  - `:20`: "**An issue outside this phase's scope: `/park` it and continue.** Do not fix it here and
    do not carry it in your head — parking is what lets it be picked up in parallel instead of
    serialized behind this work." Added by PR #221 (`bfe0278`, 2026-09-10), as specified in
    `thoughts/shared/plans/2026-09-09-the-work-record-park-board-and-compaction-survival.md:258-259`.
  - `:24`: the per-phase adversarial reviewer is told to check that "nothing outside the phase's
    scope changed". An in-place fix outside the phase would register as a finding here.
  - `:31`: final `/code-review` gate. "Surface nit-level findings to the user without acting on
    them unless asked."
  - `:41`: hard constraint "Do not modify files outside the plan's stated scope without flagging it
    first." This is the only line in the command that already permits an out-of-scope edit (after
    flagging).
- `.claude/commands/park.md` (58 lines)
  - `:9-16` "Why this exists": out-of-scope items "end up serialized behind whatever you are doing,
    or forgotten"; parking lets "every worktree see them".
  - `:20` "**Do not implement it.** Parking is the whole action."
  - `:25-26` kind defaults to `finding`.
  - `:31-36` job-vs-lesson distinction, recorded only in the body text (no field).
  - `:50-52` a parked item is started "with `/spawn <id>` — never by picking it up in this session".
  - `:56` "Never fix the thing you are parking, in the same turn or the next one, unless the user asks."
  - The command has no step that asks whether the operator needs to decide the item, or whether it is RPI-sized.
- `.claude/commands/spawn.md:12-15`: "A finding parked mid-task is usually independent of the work
  that found it, yet it waits behind that work anyway."
- `.claude/commands/plan.md`: does not mention `/park`. `:26` decision brief (the plan session
  already stops to ask the user about open choices); `:30` adversarial review ("Fix valid findings
  in the plan"); `:127` "Do not modify any source files." A plan session therefore *cannot* fix
  anything in place.
- `.claude/commands/handoff.md:47-71`: the promotion call and the three exits (`done` then
  `promote` or `archive`). It does not mention parking.
- `CLAUDE.md:43-48`: "Find something out of scope mid-task? **`/park` it** — that is what lets it be
  picked up in parallel instead of serialized behind the current work".
- `CLAUDE.md:161-162` (§ "Parallel work — park, spawn, integrate"): "Out of scope mid-task → `/park` it."
- `docs/onboarding.md:564`: "Work in parallel? **Park, spawn, integrate.** Something out of scope mid-task → `/park` it."
- `docs/engineering-memory.md:306-308` (§1 process rules): "Parallel work: park → spawn → integrate.
  Details in `CLAUDE.md`". At `:352-360` is the 2026-09-09 user entry that motivated the record:
  "which out-of-scope finding was parked mid-implementation (today those get serialized to after
  the work)". The operator's 2026-09-14 doctrine is not yet recorded anywhere in the repo. It
  exists only in session memory (`task-board-is-the-operators.md`) and in the task file.

**Mechanics:**

- `scripts/work.mjs` (1805 lines), the only writer of the record.
  - `FIELDS` (`:186`): `id, kind, title, status, tags, origin, files, worktree, branch, base, created, updated`.
    Nothing records who must decide, or how big the item is.
  - `createTask` (`:302-321`): exclusive-create id `YYYYMMDD-<slug>`; archived ids are never reissued.
  - `cmdPark` (`:359-390`): validates `--title` and `--kind ∈ {task, finding}` (default `finding`, `:364`).
    Sets `status: open` and `origin` = the active task of the caller's worktree, if any (`:380`).
    The body becomes `## Notes\n\n<body>\n\n## Decisions`. No other checks.
  - `claimInto` (`:411-461`): needs an existing record entry (`findTask`, `:412`). Sets
    `status: active`, `worktree`, `branch`, and `base` (the merge-base with main).
  - `cmdSetStatus` (`:463-477`): `done` / `drop` → `done` / `dropped`, clears `worktree`. Accepts any prior status.
  - `cmdPacketForSession` (`:514-595`): the text a session receives at start.
    `:540-545` counts **every** `status: open` item and prints "`N finding(s) are parked and
    unclaimed in the record. Run npm run board to see them before starting something new.`"
    The count includes `kind: task` items (4 of today's 11). `:550-557` lists done/dropped items
    still waiting on promote-or-archive.
  - `cmdTouch` (`:818-853`): the PostToolUse hook appends every file edited through Edit/Write to the
    active task's `files:`. An in-place fix made during a task therefore joins that task's footprint,
    which `overlap`, `spawn`, `integrate` and the SIBLING hook lines all read.
  - `cmdArchive` (`:674-705`) / `cmdPromote` (`:722-808`): both refuse anything not `done`/`dropped`.
    `promote` writes `thoughts/shared/findings/<date>-<slug>.md` into the caller's worktree.
    There is no path from an idea straight to a promoted finding without it first being a record entry.
  - `cmdSpawn` (`:921-1053`): refuses anything not `open` (`:926`). Overlap-checks against every
    `active` task. Cuts `.claude/worktrees/<slug>` on `work/<slug>` and claims it there.
  - `cmdBoard` (`:1643-1694`): the TASKS header counts open+active (`:1677-1678`) but lists every
    task file. The empty-state text says "park one with /park" (`:1680`).
- `.claude/hooks/decisions-for-file.mjs` (386 lines), the pre-edit hook.
  - `recordLines` (`:183-231`): for every `status: open` item (either kind) whose `files:` includes
    the edited path, and not in this worktree, it prints `- OPEN FINDING <id> · <title> (parked from <origin>)`
    (`:201-205`). A `kind: task` item is labelled "OPEN FINDING" too.
  - The closing paragraph (`:121-127`) tells the session "An OPEN FINDING is something already
    noticed about this file; read it before spending time rediscovering it."
  - Promoted findings arrive separately, from `thoughts/by-file.json`, tagged `FINDING` (`:80`).
- `.claude/settings.json`: `PostToolUse` → `touch` (`:25-37`), `PreToolUse` → the decisions hook
  (`:38-49`), `SessionStart` → `packet --for-session` (`:50-61`), `PreCompact`/`Stop` → `snapshot`
  (`:62-83`). Per `CLAUDE.md:36-41`, a running session never picks up a change to `settings.json`,
  but *does* pick up a changed hook script, and `work.mjs` is always run from the **main checkout**.

**Tests that pin the current behaviour** (`src/work/`):

- `decisions-hook.test.ts:144-149`: an open finding parked against a file shows up as a line naming it.
- `work-cli.test.ts:106`: `park` defaults `kind` to `finding`.
- `work-cli.test.ts:581`: session start contains "waiting on a promote-or-archive call".
- **No test asserts the "`N finding(s) are parked and unclaimed`" sentence** (grep for `parked` /
  `unclaimed` in `toContain` assertions finds nothing). `code-graph.test.ts:715-720` pins "only an
  open (parked) task can be spawned".

## Data Flows

### Where a discovery goes today

```
  a session notices X (a bug, a missing test, a rule the code breaks)
        │
        ├─ during /plan ──── plan review subagent (plan.md:30) ──► "fix in the plan" or … /park
        │                    (plan session cannot edit source, plan.md:127)
        ├─ during /implement ─ implement.md:20 "park it, do not fix it here" ──► /park
        │                    phase reviewer (implement.md:24) flags out-of-scope edits
        ├─ during /code-review (implement.md:31) ── nits surfaced to user ──► often /park
        └─ during a doc-only chore (e.g. a promotion commit) ─────────────► /park
                                          │
                                          ▼
      work.mjs park --title --kind(finding) --files --body   (cmdPark :359)
                                          │
                                          ▼
      <main>/.claude/work/tasks/<id>.md   status: open   origin: <active task id>
```

### What reads the pile, and who sees it

```
 tasks/*.md (status: open, any kind)
   │
   ├─► SessionStart  packet --for-session (:540-545)
   │     → EVERY session start/resume/compaction, in every worktree:
   │       "11 finding(s) are parked and unclaimed … Run npm run board … before starting something new"
   │
   ├─► PreToolUse    decisions-for-file.mjs recordLines (:201-205)
   │     → a session editing a file an open item names:  "- OPEN FINDING <id> · <title>"
   │       (once per file per session)
   │
   ├─► npm run board cmdBoard (:1643-1694)
   │     → the operator: one row per task file, kind/status/where/files/origin/title
   │
   └─► spawn / overlap  (code-graph)
         → an open item is the SUBJECT of a spawn; only ACTIVE tasks are compared against it
```

### How an item leaves

```
 open ──spawn──► active (own worktree) ──/handoff──► done ──┬─ promote ─► thoughts/shared/findings/ + archive/
   │                                                        └─ archive ─► archive/ (no document)
   ├──claim (in an existing worktree)──► active ──► …
   └──done / drop directly (no claim)─► done|dropped ──► promote | archive
```

### How an in-place fix would travel (the path the new rule opens)

An edit made through Edit/Write while a task is active: `touch` (`:818`) adds the file to that
task's `files:`. The file then appears in the SIBLING hook lines of other sessions and in
`spawn`/`integrate` overlap reports as part of *that* task. It lands through that task's branch
and PR. The per-phase reviewer (`implement.md:24`) and `integrate`'s review (`integrate.md:54-59`)
see it in the diff. Nothing writes a record entry for it.

## The board today (observed 2026-09-14, main checkout, this session)

13 task files: 2 `active` (this task, and `20260912-the-model-names-the-job-on-the-ambiguous`),
11 `open`. Of the 11 open: **7 `finding`, 4 `task`**. 9 carry an `origin` (parked from inside a
task). The origins are `20260911-a-new-promise-to-a-known-customer-is-fil` ×3,
`20260912-the-model-names-the-job-on-the-ambiguous` ×2 and `20260910-planner-s-manager-facing-copy-needs-a-fo` ×2.

| id | kind | where it came from (its own words) | size / decision signal in its body |
|---|---|---|---|
| `20260914-listjobsforcustomer-orders-on-created-at` | finding | "Found in plan review of 2026-09-11-the-model-names-the-job" | "Fix is one line … but it changes which job a tie resolves to, so it wants its own test" |
| `20260914-retract-capture-s-customer-captures-loop` | finding | parked during #239 (a pure move) | "A JOB … Fix: a server.test.ts case" |
| `20260914-decision-index-max-per-file-lets-prose-m` | finding | "Out of scope for a doc-only promotion commit" | "A JOB"; cause traced to `scripts/decision-index.mjs` rank/tiebreak |
| `20260914-the-link-views-expose-basis-reason-but-c` | finding | "Found in plan review"; "parked now so it is decided with it" | names two options; `tags: privacy`; does not exist until a migration lands |
| `20260912-getcustomercontext-fetches-customer-link` | finding | "Found during the Phase 1 review of plan 2026-09-11-the-door-stops-guessing" | "no `listRawCapturesByIds` today — adding one is why this was parked"; "not urgent" |
| `20260912-an-ambiguous-non-commitment-reply-is-inv` | finding | "Found by /code-review high" | "Worth deciding whether …" (a product question) |
| `20260912-the-ambiguity-ask-names-candidate-jobs-b` | finding | "Found by /code-review high" | options a/b/c, "none investigated"; "Worth settling before the ask ships" |
| `20260912-rung-10d-the-planner-writes-l2-and-the-d` | task | "Parked at the user's request" | ladder rung, 8 files |
| `20260912-rung-10c-a-seat-s-inform-wakes-the-plann` | task | "Parked at the user's request" | ladder rung, "BLOCKED", needs a migration |
| `20260912-an-l2-status-flip-reports-to-the-planner` | task | "USER DOCTRINE 2026-09-12" | general design, 4 files |
| `20260910-brand-the-two-timestamp-species-so-the-c` | task | no origin | type-system change across 7 files |

**The archive** (30 task files in `.claude/work/archive/`): 22 findings (18 `done`, 4 `dropped`)
and 8 tasks (4 `done`, 4 `dropped`). Of the 18 done findings, 9 have an empty `branch:`, meaning
they were closed without ever being claimed. One precedent for batching small findings:
`20260910-harden-the-work-record-the-small-finding` ("four parked findings fixed and closed …
PR #223") claimed one task and fixed several parked items together in one PR. Another precedent,
for a small finding spawned into its own worktree and PR: `20260911-toolloop-test-ts-wall-clock-budget-test`
(PR #229, spawn → merge in ~20 minutes).

## External Dependencies

- **Claude Code hooks** (`SessionStart`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`). The
  contract is cited in `decisions-for-file.mjs:13-17` (https://code.claude.com/docs/en/hooks,
  verified there 2026-09-09). `additionalContext` output is capped at 10,000 characters
  (`work.mjs:559-561`). Not re-verified for this research, since nothing here depends on a new hook capability.
- **`AskUserQuestion`**, the tool the operator names for "ask". It is a Claude Code tool available
  to the interactive session. Whether a subagent can call it was not checked. `implement.md:24`
  runs reviewers as subagents, and `CLAUDE.md:168-169` notes subagents "can't pause".
- `git` (worktrees, merge-base) and `gh` (merged-PR lookups on the board). Neither is touched by this area's rules.

## Constraints and Invariants

- **The record is untracked and shared.** `.claude/work/` lives in the main checkout and no commit
  carries it (`work.mjs:10-14`). Changing the *commands* (tracked) reaches other worktrees only
  after they merge main. Changing `scripts/work.mjs` or the hook script reaches every session on
  its next invocation, because both are run from the main checkout (`CLAUDE.md:32-34`).
- **Hook verbs never fail loudly** (`work.mjs:32-35`, `:1698-1701`). Any wording change to
  `packet --for-session` must keep it silent-on-error and under the 9,000-character budget (`:575`).
- **`spawn` works only on a record entry with `status: open`** (`:926`), and overlap checks compare
  only against `active` entries (`:943-949`). Work with no record entry (a branch nobody claimed) is
  invisible to `spawn`, `integrate`, `overlap` and the SIBLING hook lines.
- **`promote` and `archive` accept only `done`/`dropped`** (`:746`, `:689`). A lesson reaches
  `thoughts/shared/findings/` only via park → done → promote.
- **Code reaches `main` only by PR; doc-only diffs may go straight to `main`**
  (`docs/engineering-memory.md:301-305`). This bears on whether a small code fix can ride along
  or needs its own PR.
- **`kind` is binary** (`task`/`finding`), and the hook and session-start text both call every open
  item a "finding" regardless of kind (`decisions-for-file.mjs:203`, `work.mjs:543`).
- **Job vs lesson is prose only** (`park.md:31-36`). Open bodies mark it by hand: "A JOB." in
  `decision-index-max-per-file` and `retract-capture`, and "JOB (a ladder rung…)" in 10c and 10d.
- **Session memory already outranks the commands until this task lands**: the memory file says
  "Until it lands, this memory outranks them." That memory is session-local, not in the repo.
- **The two memories the task file weighs for the prompt-only-vs-mechanical question are rulings
  about the PLANNER (the product's AI), not the dev harness.** `harness-is-places-and-verbs`
  (2026-08-28) and `doctrine-says-what-not-how` (2026-09-11) are about planner doctrine and gates
  on the planner. The task file marks applying them here as "Inferred, not stated by the operator".
- **`run-phases-without-asking` (user, 2026-09-06)**: `/implement` runs phases straight through and
  stops only for human checks, plan/code divergence, or outward-facing steps. "Ask now" for a small
  decision is a new stop reason that ruling does not list.

## Decision Points

These restate the task file's five open questions against the code as it stands, plus three the
reading surfaced. No recommendation is made.

1. **The "big, but no operator decision" cell.**
   - *Park it (today's behaviour):* it gets a record entry, can be `spawn`ed with an overlap check,
     and shows on the board.
   - *Do it as its own branch/PR without a record entry:* nothing in `spawn`/`integrate`/`overlap`
     or the SIBLING hook would know it exists, because they read only record entries.
   - *A record entry that skips the board:* no such state exists. It would need a new status or
     field in `FIELDS` (`work.mjs:186`), plus board and hook changes.
   - *Claim it into the current worktree:* not possible while a task is active there. One active
     task per worktree is refused at `work.mjs:422-426` without `--force`.

2. **Where a small fix found mid-implement lands.**
   - *Same commit:* `touch` folds its files into the current task's footprint automatically. The
     phase reviewer's "nothing outside the phase's scope changed" (`implement.md:24`) would flag it.
   - *Own commit on the same branch:* same footprint effect, and it stays separable in history.
     `implement.md:41` "flag it first" already allows it after flagging.
   - *Its own tiny PR:* the PR rule applies (`engineering-memory.md:301`). It needs a branch and,
     for tests, a Supabase stack (`CLAUDE.md:175-183`). In today's tools the only way to get one
     with an overlap check is park → spawn, which puts it on the board.

3. **Findings from `/plan` review.** A plan session cannot edit source (`plan.md:127`), so "fix it in
   place" is unavailable there. Its existing choices are to fold the fix into the plan as a
   change/phase, ask at the decision brief (`plan.md:26`), or park. The `listJobsForCustomer` and
   `link-views` items on today's board both came from plan review.

4. **Where a LESSON goes if it is not parked.** Routes available today:
   - `promote` (needs a record entry first).
   - An `engineering-memory.md` entry (doc-only commit straight to main; reaches the pre-edit hook
     through `decision-index.mjs` file mentions).
   - A code comment next to the thing.
   - The task's `/handoff` (durable only if that task is later promoted rather than archived).

   The pre-edit hook shows open record entries as "OPEN FINDING" (`decisions-for-file.mjs:203`) and
   promoted documents as "FINDING" (`:80`). A lesson written anywhere else does not produce either line.

5. **Prompt-only, or also mechanical.**
   - *Prompt-only:* edit `park.md`, `implement.md:20/:24/:41`, `CLAUDE.md:43/:161`,
     `onboarding.md:564` and `engineering-memory.md:306-308`. No test changes are needed for the
     wording, since no test pins it.
   - *Also mechanical:* for example a required reason or flag on `park`. That touches `cmdPark`
     (`:359-390`), possibly `FIELDS` (`:186`) and `serializeTask`, and requires updating every
     test that calls `park` without it. There are 60 `work(['park', …])` call sites across
     `src/work/*.test.ts`.

6. **The session-start line (`work.mjs:540-545`).** It fires in every session and tells the session to
   read the board "before starting something new". Options that change it: reword, count only
   `finding` vs `task`, or remove. No test pins the sentence. Because it runs from the main
   checkout's script, a change reaches every session on its next start once merged to main.

7. **Triage of the 11 open items.** Per the task file: item by item with the operator (fix / ask /
   keep / archive), never in bulk. `archive` requires `done`/`dropped` first (`work.mjs:689`), so
   closing without a fix is `drop` then `archive`, or `drop` then `promote` for a lesson.

8. **The `supersedes:` field of the plan.** The "park it and continue / do not fix it here" line was a
   decision of `thoughts/shared/plans/2026-09-09-the-work-record-park-board-and-compaction-survival.md`
   (`:250-259`). A plan that changes that line changes a decision of that document.

## Open Questions

- **Why sessions parked the small items: habit or pressure.** Was it `implement.md:20`'s "do not fix
  it here", the reviewer's "nothing outside the phase's scope changed" (`:24`), or `park.md:56`?
  Reading cannot separate these. Two of the specimens came from plan review, where no instruction
  names `/park` at all.
- **What "small" means.** No file defines it. The only size signals are self-descriptions in item bodies.
- **Whether "ask now" can be carried out by the sessions that find things.** Adversarial reviewers
  and verification runs are subagents (`implement.md:23-24`), which `CLAUDE.md:168-169` says cannot
  pause. Whether a subagent's finding is asked about by the parent session, or dropped, is not specified anywhere.
- **How the operator actually reads the board.** It is `npm run board` in a terminal. Whether the
  session-start line or the board is the operator's main exposure to the pile was not measured.
- **Whether other worktrees' running sessions see a new rule.** Command files are read per
  invocation from the session's own checkout. A worktree cut before this lands keeps the old
  `implement.md` until it merges main. How many live sessions that affects at landing time depends
  on what is active then.
