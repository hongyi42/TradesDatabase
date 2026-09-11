# Integrate

Bring main into this task before it lands, and check the combination — not each side again.

## Task

Integrate: **$ARGUMENTS** (a task id; empty means this worktree's active task)

## Why this exists

Tasks land one at a time, each through its own PR. The risk is not in either task alone — both
passed their gates — but in the combination: main has moved since this task started, and some
of what it changed is exactly what this task calls. `work.mjs integrate` finds that edge with the
code graph and names it, so the merge and the review aim at the few places the two can collide
instead of re-reading everything.

## Process

1. **Read the report** (it changes nothing), and record the base BEFORE merging:

   ```bash
   W="$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/work.mjs"
   node "$W" integrate <id>
   BASE="$(node "$W" integrate <id> --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).base')"
   ```

   Keep `BASE` — the report prints it too, as `base: <sha>`. After the merge, a merge-base would
   be main itself, so this is the only way back to where the task started.

   `LANDED ON …` is what main changed since this task's base that the task touches or calls, with
   the commits that did it. `WHOM YOU AFFECT` is which other active tasks overlap this one — they
   will see it in their pre-edit hook once this lands; mention it to the user. A `?  not checked`
   row means git could not read part of one side: that section is incomplete, not clean — say so,
   and do not report "none" from it.

2. **Merge main into the task's branch**, in its worktree: `git merge <label>` — the branch the
   report compared with (`origin/main` in this repo). Merge, never rebase — the branch may
   already be pushed with a PR open.
   - First, the working tree must be clean: `git status --porcelain` shows nothing but
     `supabase/config.toml` (which second-stack.sh always leaves modified). Anything else → stop
     and ask. Never stash or discard to make it clean — the stash stack is shared by every
     worktree, and `git merge --abort` cannot always give uncommitted changes back.
   - Resolve ONLY mechanically-trivial conflicts: independent edits on adjacent lines. If any
     conflict needs a judgment about intended behaviour, run `git merge --abort` and stop: show
     the user the conflicting files and ask. Never guess a semantic resolution.
   - A generated file the report flagged (`src/db/database.types.ts`, `thoughts/INDEX.md`,
     `thoughts/by-file.json`) is never merged by hand: take either side, then run the command in
     its row (`npm run gen:types:local`, `npm run decisions:index`).

3. **Run the gates** — `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` — against
   this worktree's own local Supabase stack. A failure here means the COMBINATION broke: find
   which item in the report caused it.

4. **Review the combination.** Spawn a fresh-context subagent and give it only the `integrate`
   report and `git diff $BASE..HEAD -- <the files the report names, callers included>` — from the
   base recorded in step 1, so main's side of each item is in it (a merge-base taken now would be
   main itself, and would hide exactly that side). Its question: does either side change
   behaviour, data or a contract the other relies on — at exactly the items listed? Fix what it
   finds (root causes only; never loosen a gate), then re-run the gates.

5. **Re-run `integrate`.** Clean means `LANDED … — none that this task touches or calls`.

## Hard constraints

- Never push, open, or merge a PR without the user.
- Never rebase a branch that may be pushed; never force-push.
- Never modify `.env.test` or a test guard to get the gates through.
