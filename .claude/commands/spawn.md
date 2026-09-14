# Spawn

Start a parked task in parallel, in its own worktree — after checking it against everything in
flight.

## Task

Spawn: **$ARGUMENTS**

## Why this exists

An item on the board is work the operator approved; it rarely depends on the task that found it,
and `spawn` is what lets it start now: it checks the parked item against every
active task, cuts a fresh worktree from main, claims the task there, and hands back the one
command that starts a session inside it.

The check is what makes that safe, and it is not yours to wave through. When two pieces of work
overlap, how much that matters depends on how big the overlap is — so the tool stops, sizes each
one, and the operator decides (user, 2026-09-10).

## Process

1. **Run it:**

   ```bash
   W="$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/work.mjs"
   node "$W" spawn <id>
   ```

2. **Exit 0 — created.** Relay the worktree path and the `cd <path> && claude` line verbatim, and
   the second-stack line if the task will run tests.

3. **Exit 2 — STOPPED.** Nothing was created. Show the user the report exactly as printed. Then,
   in one line, name the biggest item and what it would mean in practice — for example "HIGH:
   task X is rewriting `cleanQuestionDraft`, the function this finding is about". Ask whether to
   proceed. Only on an explicit yes, re-run with `--proceed`.

   If it stopped because the task **names no files**, there is no report: nothing could be checked.
   Say exactly that, and ask whether to proceed unchecked — or suggest adding the files it will
   touch to the task's `files:` and re-running, which makes the check possible.

   Two more stops that are not overlaps, and must be said as what they are:
   - **`?  not checked`** — git could not read part of an active task's checkout (a timeout, a
     held lock, a broken `.git`). The report is incomplete, not clean. Name the checkout; fixing
     it and re-running is usually better than proceeding.
   - **"names N paths not in origin/main"** — a new file the task will create, or a typo in its
     `files:`. Ask which; for a typo, fix the task's `files:` and re-run.

4. **Exit 1 — an error** (not open, already spawned, the branch exists). Report it as printed; do
   not work around it.

## Hard constraints

- **Never add `--proceed` without the user's explicit yes to the report you showed them.**
- Never start the new session yourself, and never begin the spawned task's work in this session.
  It belongs to a session LAUNCHED in its worktree — that is what makes its hooks and its packet
  fire.
- Never pass `--branch` to get past "already exists" without saying why that branch existed.
