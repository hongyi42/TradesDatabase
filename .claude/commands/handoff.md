# Handoff

Write down what only you know about this task, so the next session does not have to be told.

## Task

$ARGUMENTS

## Why this exists

A snapshot is taken automatically at every stop and before every compaction, but it can only
record what a machine can see: the branch, the head commit, which files changed. What was
DECIDED, what you assumed, what you tried that did not work, and what is still open cannot be
extracted from a diff. That is the part that gets lost in a summary and re-explained by the
operator, and it is the part this command writes.

## Process

1. **Read the current packet first** so you extend the record rather than repeating it:

   ```bash
   W="$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/work.mjs"
   node "$W" packet
   ```

2. **Write the handoff.** Five headings, each one or two sentences. Omit a heading only when it
   is genuinely empty — "none" is a useful thing to record:
   - **What changed** — the behaviour now different, not a file list. The file list is already
     recorded automatically. Name any small fix you made in place along the way.
   - **Decisions** — what was chosen, the alternative, and why. This is the part that binds.
   - **Assumptions** — what you took to be true without verifying it.
   - **Open** — what is unfinished, and what the next step is.
   - **Downstream** — anything elsewhere that this affects, including other worktrees.

3. **Append it**, body on stdin:

   ```bash
   node "$W" handoff --body - <<'EOF'
   **What changed** — …
   **Decisions** — …
   **Assumptions** — …
   **Open** — …
   **Downstream** — …
   EOF
   ```

4. **Make the promotion call out loud, finished or not.** The operator will not remember to ask,
   and by tomorrow the reason will have gone fuzzy — so state it now, in one line, either way.

   Promote when a future session would otherwise lose an afternoon: a vendor or tool contract that
   changed under us, a trap whose symptom points somewhere other than its cause, a decision whose
   rejected alternative is invisible in the code, a measurement that would otherwise be re-taken.
   A lesson found along the way — a trap or a contract, nothing to fix — is written in this
   handoff rather than parked, and a handoff carrying one makes the call yes.

   Do **not** promote a fix that a test already pins and the commit already explains. A promoted
   finding is put in front of every future edit of its files, and "this was fixed" is noise
   standing between the next session and its work. If it does not qualify, say so in a few words
   rather than staying silent — an unstated call is indistinguishable from a forgotten one.

5. **If the task is finished**, close it and act on the call you just made:

   ```bash
   node "$W" done <id>
   node "$W" promote <id>     # the call was YES — writes thoughts/shared/findings/<date>-<slug>.md
   node "$W" archive <id>     # the call was NO  — out of the live record, no document
   ```

   After `promote`, run `npm run decisions:index` and commit both, so the pre-edit hook can find
   it. `archive` needs no commit — the record is not tracked.

   Run one of them. A finished task left in the record is not a third option: it makes work
   deliberately left undocumented look identical to work nobody got round to.

6. **Report** the task id, one sentence on what you recorded, and your promotion call.

## Hard constraints

- Write what happened, not what you intended. A handoff that flatters the work is worse than none.
- Record failed approaches too — they are the most expensive thing to rediscover.
- Never promote a task that is not `done` or `dropped`; the record is the live half, `thoughts/`
  is the durable half, and mixing them is what made the old prose notes untrustworthy.
