# Park

Record something you noticed, without derailing what you are doing.

## Task

Park this: **$ARGUMENTS**

## Why this exists

Mid-implementation you will find things that deserve their own small plan — a latent bug, a
missing test, a rule the code contradicts. They are usually out of scope and independent of the
current work. Today they get a sentence in prose that nothing tracks, and they end up serialized
behind whatever you are doing, or forgotten. Parking writes them into the shared work record,
where every worktree can see them and the pre-edit hook will surface them to whoever next touches
the files involved.

## Process

1. **Do not implement it.** Parking is the whole action. Return to what you were doing after.

2. **Work out four things**, asking the user only if the finding is genuinely ambiguous:
   - **A title** — one line, specific enough to be recognisable in a list six weeks from now.
     "record_caller accepts a visit with no date" beats "bug in record_caller".
   - **Kind** — `finding` (something you noticed) or `task` (something somebody means to do).
     Default to `finding`.
   - **Files** — every repo-relative path involved, comma-separated. This is what makes the
     finding reach the next person: the hook matches on exactly these paths.
   - **A body** — 2 to 5 lines: what you observed, the evidence (file:line, an error, a
     measurement), and why it is out of scope here. Enough that someone can pick it up cold.
   - **Whether it is a job or a lesson.** Most parked items are work someone will do. Some are
     not fixable at all — a vendor's behaviour, a tool's contract, something true about the
     environment — and those are finished the moment they are written down and verified. Say
     which in the body, because they close differently: a job is closed by fixing it, a lesson by
     promoting it. A lesson left looking like a job sits open forever waiting for a fix that was
     never possible.

3. **Write it**, passing the body on stdin so newlines survive:

   ```bash
   W="$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/work.mjs"
   node "$W" park --title "<title>" --kind <finding|task> --files "<a.ts,b.ts>" --body - <<'EOF'
   <body>
   EOF
   ```

   It prints the task id. If a task is active in this worktree, the new item records it as the
   origin automatically, so the finding remembers where it came from.

4. **Tell the user** the id, the title, and one sentence on what you parked. Then continue the
   work you interrupted. A parked item that can start now, in parallel, is started with
   `/spawn <id>` — never by picking it up in this session.

## Hard constraints

- Never fix the thing you are parking, in the same turn or the next one, unless the user asks.
- Never park something already in the record — check `npm run board` if you are unsure.
- The body states what you observed. If you are inferring rather than observing, say so in it.
