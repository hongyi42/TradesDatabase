---
id: 20260910-build-the-shared-work-record-plan-2026-0
kind: task
title: build the shared work record (plan 2026-09-09)
status: active
tags: work-record, hooks
origin: 
files: scripts/work.mjs, src/work/work-cli.test.ts, src/work/decisions-hook.test.ts
worktree: /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/work-record
branch: feat/the-work-record
base: 8f428bdd2ecae98eb186021e0ce318ea6edd76eb
created: 2026-09-10T00:00:45.503Z
updated: 2026-09-10T00:08:12.404Z
---

## Notes

Phases 1-3 of thoughts/shared/plans/2026-09-09-the-work-record-park-board-and-compaction-survival.md
are implemented and committed on feat/the-work-record. Phase 4 (promote, the `finding` document
kind, and the CLAUDE.md section) is not started.

## Decisions

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
