---
date: 2026-09-10
task: build the shared work record (plan 2026-09-09)
status: complete
origin: 
files: scripts/work.mjs, src/work/work-cli.test.ts, src/work/decisions-hook.test.ts
supersedes: nothing
---

## Files

- scripts/work.mjs
- src/work/work-cli.test.ts
- src/work/decisions-hook.test.ts

## Outcome

All four phases landed on `main`: the plan in `bfe0278` (#221), the untracking fix and the last
manual gate in `f0163c0` (#222). The plan document is `status: complete` with every checkbox
ticked and its evidence recorded.

Two caveats for anyone reading this document as a record:

- **The `files:` list above undercuts what was touched.** It names three files because it was
  typed by hand at `park` time; the `touch` hook that maintains it automatically was not live in
  the session that did the building, for the reason in the handoffs below. The real footprint is
  17 files — see `bfe0278`. This is the tool's own file list failing in exactly the way the tool
  exists to prevent, which is worth keeping rather than tidying away.
- **Six findings were parked, not fixed**, and are live in the record rather than here.
- **This document attaches to no source file, so the pre-edit hook will never surface it.** All
  three files above fall outside the index's source-path pattern `^src/[a-zA-Z0-9_/-]+\.ts$`:
  `scripts/work.mjs` is not under `src/`, and both test files have dotted basenames, which the
  character class excludes. That is parked as
  `the source-path regex excludes dotted basenames, so no test file ever attaches` — and this,
  the first real promotion, is the first thing to demonstrate it.

## Notes

*(Written when the task was parked. Left verbatim; the handoffs below overtake it.)*

Phases 1-3 of thoughts/shared/plans/2026-09-09-the-work-record-park-board-and-compaction-survival.md
are implemented and committed on feat/the-work-record. Phase 4 (promote, the `finding` document
kind, and the CLAUDE.md section) is not started.

## Handoff 2026-09-10T00:01:07.276Z

**What changed** — Phases 1-3 are committed on feat/the-work-record. The shared record lives at
<main>/.claude/work/, the pre-edit hook now works inside worktrees and names in-flight work, and
the task packet is re-injected at session start and after compaction.

**Decisions** — id allocation is the filesystem's (exclusive create) and every task mutation
takes a lock file, because measured concurrency lost data both ways: 5 concurrent parks left 2
files, and 8 concurrent edits recorded 1 file. Hook verbs fail silently, person verbs fail loudly.
PreCompact only snapshots, since the docs give it no way to inject context.

**Assumptions** — that this branch lands on main before other checkouts need the fixed hook: a
session running from a checkout that lacks it still runs its own older copy.

**Open** — Phase 4 (promote, the `finding` document kind, the CLAUDE.md section) is not started.
Two non-blocking gaps are listed in the phase reports: `packet` without --cwd blocks on a pipe
that is never closed, and `base` is empty when origin/main is absent.

**Downstream** — .claude/settings.json gained SessionStart, PreCompact and Stop hooks, so every
session in a checkout carrying this branch will start taking snapshots.

## Handoff 2026-09-10T00:08:12.398Z

**What changed** — nothing in the code. This entry records a reachability limit found while
running Phase 3's manual gate.

**Decisions** — none new.

**Assumptions** — the earlier handoff assumed "this branch lands on main before other checkouts
need the fixed hook", and scoped that to the decisions hook. It is broader: it covers EVERY hook
this build adds. Claude Code reads settings from the session's LAUNCH ROOT, not its cwd, so a
session that starts in the main checkout and then enters a worktree reads the main checkout's
.claude/settings.json. That file has only PreToolUse and PostToolUse. Such a session therefore
takes no snapshots, gets no packet at session start or after compaction, and records no touched
files -- silently, because every hook command ends in "; true".

**Open** — Phase 3's manual gate is UNVERIFIED, not passed. Measured instead: a session launched
inside the worktree got the packet on SessionStart(startup) with zero conversation history and
answered with the task id, the file list and the handoff. That leaves only the compact matcher
untested. Also confirmed working: snapshot writes <id>.snapshot.json with changedFiles
["supabase/config.toml"] -- the leading-space fix holding on a modified tracked file.

**Downstream** — until this branch is on main, the build only reaches sessions launched from a
checkout that carries it. Running the gate means launching the session from inside the worktree.

## Handoff 2026-09-10T01:13:13.867Z

**What changed** — Phase 4 landed, so the plan is complete. `promote` turns a closed task into
thoughts/shared/findings/<date>-<slug>.md and archives it; the decision index indexes that as kind
`finding`, ranks it above plain documents for its files, treats `dropped` as superseded, and seeds
attribution from the frontmatter `files:` list the edit hook maintained. CLAUDE.md now documents
the record. The pre-edit hook labels a finding FINDING rather than showing a bare date.

**Decisions** — findings rank at 2 in by-file.json, level with prose rules and above research and
plan documents. Not in the plan; added because 52 of this repo's 96 attached files are already at
MAX_PER_FILE and a finding's seeded count is the FLOOR, so it lost every tiebreak and was dropped
from exactly the busy files it is most likely to be about. Verified both ways on src/db/jobs.ts.
Also: ids are retired permanently rather than reissued after promotion, and promote does all its
work under the task lock. Both came from review, both are about losing a record silently.

**Assumptions** — that `## Files` plus the `files:` frontmatter line is a stable output shape.
The seeding is belt-and-braces today: promote emits each path twice, so it already clears
MENTION_FLOOR without help. The round-trip test is what makes that assumption safe to hold —
it runs the real promote and feeds its output to the real index, so if either side's shape moves
the suite fails rather than the attribution silently going quiet.

**Open** — four findings parked and spawnable: by-file keeps the first 8 files a task touched
rather than the last; the source-path regex excludes dotted basenames so no test file ever
attaches; packet without --cwd blocks on a pipe that is never closed; base is empty when
origin/main is absent. The second plan — spawn, the code-graph overlap check, the seventh
`integrate` verb — is not started.

**Downstream** — this task stays ACTIVE on purpose: it is what the Phase 3 compaction check reads,
and that check has still never run. Once this branch is on main every session gets the hooks
wherever it launches; until then only a session launched inside this worktree does.

## Handoff 2026-09-10T18:49:46.894Z

**What changed** — Phase 3's manual gate PASSED on 2026-09-10, the last unverified check in the
plan. All four phases are now verified end to end.

**Decisions** — none new.

**Assumptions** — none new.

**Open** — the plan document's Phase 3 manual checkbox is still unticked; it needs a doc-only
commit to main. Six findings are parked and spawnable, one of them a live defect: two work-record
files are tracked on main and need untracking (rm --cached).

**Downstream** — evidence, so nobody has to re-run this. The gate was run in a SEPARATE session in
the main checkout, on task 20260910-base-is-empty-when-origin-main-is-absent, deliberately chosen
because that session had no history of it. After /compact it returned the task id, its single file
(scripts/work.mjs), the problem statement, "carried from Phase 3", and the proposed fix verbatim:
"a fallback chain -- try origin/main, then main, then the merge-base with whatever default branch
git actually reports". Only the packet could carry that; the claim command's output in its
transcript supplies the id and nothing else. Also learned along the way, and already parked: a
running session does NOT pick up newly added hook events, so landing on main is necessary but not
sufficient -- every session predating the merge keeps its old hook set until restarted.
