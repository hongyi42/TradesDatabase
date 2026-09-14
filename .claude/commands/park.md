# Park

Put an item on the operator's board — only after the operator says yes.

## Task

Park this: **$ARGUMENTS**

## Why this exists

The board (`npm run board`, the files in `.claude/work/tasks/`) is the operator's reading list.
An item belongs there only if the operator must decide it AND it is big enough to need its own
research → plan → implement cycle. Everything else costs the operator attention and buys nothing:
a board that grows faster than it drains buries the items that matter. A parked item is seen by
every worktree, and the pre-edit hook shows it to whoever next touches its files.

## Process

1. **Decide where it goes.** If the operator asked for this park, or answered "put it on the board"
   (or "park it") to your question, their answer decides it — go to step 3, whatever its size. Otherwise, most things you notice do not belong on the board:

   |                          | no operator decision needed          | operator decision needed        |
   | ------------------------ | ------------------------------------ | ------------------------------- |
   | **small**                | fix it on this branch — its own commit unless it shares a file with other uncommitted edits — and name it in your report; do not park | ask now (`AskUserQuestion`), then act on the answer |
   | **big (its own RPI)**    | does not exist: anything too big to fix in place is the operator's to approve, so ask | ask; park only on a yes         |

   A consequence of your own change is yours to raise. It is never "out of scope": if it needs a
   decision, ask, however big the fix would be.

   A **lesson** — a vendor's contract, a trap, something true that has nothing to fix — is not
   parked either. Write it in this task's `/handoff` (which makes its promotion call yes) or in
   `docs/engineering-memory.md`.

2. **Get the yes.** If the operator asked for this park in this conversation, or already answered
   "put it on the board" when you asked, that is the yes — do not ask again. Otherwise ask with `AskUserQuestion`, showing the title and one line on why it needs them,
   with the options: put it on the board / decide it now / don't record it. Only the first one
   continues below; for "decide it now", ask the actual question with its options and act on
   that answer instead.

3. **Work out four things**, asking the operator only if the item is genuinely ambiguous:
   - **A title** — one line, specific enough to be recognisable in a list six weeks from now.
     "record_caller accepts a visit with no date" beats "bug in record_caller".
   - **Kind** — `finding` (something you noticed) or `task` (something somebody means to do).
     Default to `finding`.
   - **Files** — every repo-relative path involved, comma-separated. This is what makes the
     item reach the next person: the hook matches on exactly these paths. For an idea with no code
     yet, name the files it would most likely touch, or leave it empty and say so in the body.
   - **A body** — 2 to 5 lines: what you observed, the evidence (file:line, an error, a
     measurement), and what the operator has to decide. Enough that someone can pick it up cold.

4. **Write it**, passing the body on stdin so newlines survive. Claude Code shows the operator an
   approval prompt for this command (a `permissions.ask` rule in `.claude/settings.json`); that is
   expected, not an error:

   ```bash
   W="$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/work.mjs"
   node "$W" park --title "<title>" --kind <finding|task> --files "<a.ts,b.ts>" --body - <<'EOF'
   <body>
   EOF
   ```

   It prints the task id. If a task is active in this worktree, the new item records it as the
   origin automatically, so the item remembers where it came from.

5. **Tell the operator** the id, the title, and one sentence on what you parked. Then continue the
   work you interrupted. A parked item that can start now, in parallel, is started with
   `/spawn <id>` — never by picking it up in this session.

## Hard constraints

- Never park without the operator's yes — their own request, or their answer to your question.
- Never park something already in the record — check `npm run board` if you are unsure.
- The body states what you observed. If you are inferring rather than observing, say so in it.
