---
date: 2026-09-14
task: The task board is the operator's — sessions fix small things in place and ask about decisions; nothing is parked without the operator's yes, and a permission prompt backs that up
research: thoughts/shared/research/2026-09-14-the-task-board-is-the-operators.md
status: draft
supersedes: nothing
---

## Overview

Sessions were taught "out of scope → `/park` it, do not fix it here" (`implement.md:20`). The
board filled with one-line fixes and with product questions that were consequences of the parking
session's own change. This plan makes three changes. It rewrites that teaching everywhere it
appears. It adds a Claude Code permission `ask` rule, so every park command stops for the operator's
approval. It walks the 11 open items with the operator, one at a time.

**Amends, does not supersede,** `2026-09-09-the-work-record-park-board-and-compaction-survival.md`:
only its `:258-259` ("park it and continue") is overturned; its record/board/hooks design holds.

## Decisions

Operator, 2026-09-14 (research Decision Points and the plan brief; also in the task file):
- **Big but needing no operator decision does not exist.** Big → ask → park.
- **A small fix found mid-implement** gets its own commit on the same branch and is named in the
  phase report. No separate PR, no board entry. `implement.md:24` and `:41` are reworded so it is
  not a violation.
- **Plan review:** what the plan causes goes into the plan. Product questions are asked before the
  plan is presented.
- **Lessons stay off the board.** They go in the handoff, which makes the promotion call yes, or in
  engineering memory.
- **Nothing reaches the board without the operator's yes: A + C.** A: `/park` asks. C: a
  `permissions.ask` rule prompts on the park command. B (a model-passed flag) was rejected.
- **The session-start sentence (`work.mjs:543`) is left alone.** Triage goes item by item, never in bulk.
- **In scope = caused by my change.** Asking is a legitimate `/implement` stop. Subagents cannot
  ask; their questions go through the parent.
- **"Fix now" items become ONE task the operator approves onto the board**, spawned, one PR
  (precedent PR #223). Rejected: fixing them on this branch (it mixes product code into a workflow PR
  and collides with the active model-names-the-job task's files).
- **The prompt reaches a worktree through tracked `settings.json` only** (on merging main).
  Rejected: a main-checkout `settings.local.json` copy (unreviewed, one Mac, unverified).
- **The operator saying "park this" is the yes.** The session skips its own question, and the prompt
  still shows.
- **Docs contradict `CLAUDE.md:36-41`.** The hooks doc now says settings-file hook edits "are
  normally picked up automatically by the file watcher" (https://code.claude.com/docs/en/hooks,
  "Hook locations"). Decision: record the divergence in engineering memory and keep the restart
  advice.
- **`supersedes: nothing` plus an amendment note.** `decision-index.mjs:434-441` marks a named
  document wholly superseded, and the hook would label the still-valid work-record plan "do not
  build on this".

Mine (implementation detail), with reasons:
- **C is a permission rule, not a PreToolUse hook.** Hooks doc, "Decision control": a hook's
  `ask` is `deny` in `auto` and runs unprompted in `bypassPermissions`. Permission-modes doc,
  "Actions no mode auto-approves": "Tools matched by an explicit ask rule" prompt in every mode.
  No `defaultMode` is set, and Pro/Max defaults to auto.
- **Four rule spellings, each with `park` right after the script reference:** `node "$W" park *`
  (taught form), `node *work.mjs park *`, `node *work.mjs" park *` and `npm run work -- park *`.
  So `handoff`/`spawn`/`done` cannot match. An ask rule "isn't a security boundary" (permissions
  doc, "What a Bash rule doesn't match"): it is the backstop, and A is the gate.
- **A codified test pins every CLI line in the commands to the rules.** The live probe, not the
  test's approximate matcher, is the truth for multi-line heredoc commands.
- **An answered question is closed with `done` + `promote`, not `archive`.** The answer must reach
  the next editor of those files, and archive is unindexed. `dropped` would index as superseded.
  A pure drop is `drop` + `archive`.
- **Cross-task writes use the lock.** An answer that belongs to another active task goes in via
  `node "$W" handoff --cwd <its worktree>`, which runs under `withTaskLock` (`work.mjs:626-644`),
  never a direct edit.

## Plain-language walkthrough

**Phase 1: the words.** Every place that told a session "out of scope → park it" is rewritten
around the operator's table. A small fix with no decision gets fixed in the branch. A decision gets
asked. Something big and needing a decision gets parked, but only after a yes. A side effect of
your own change is never "out of scope". You will notice it when a session reports an in-place fix
or asks you a question instead of handing back a parked id.

```
 session finds X
   ├─ small, no decision ─► fix on this branch, own commit, named in the report
   └─ needs the operator ─► ASK ─┬─ "decide now" ─► act on the answer
                                 ├─ "put it on the board" ─► /park ─► [permission prompt] ─► tasks/
                                 └─ "no" ─► nothing written
```

**Phase 2: the dialog.** A rule in `.claude/settings.json` tells Claude Code to ask the operator
before running the park command. A test checks that every park line in the commands still matches
the rule. A probe runs Claude Code non-interactively in a throwaway repository. With no one there to
ask, a prompted command is refused, so a refused park proves the rule fires, for every way of
writing the command. You will notice it the first time a session parks: an approve/deny box shows
the exact command. The phase ends by asking you to restart the session so it runs with the new rule.

**Phase 3: the board.** The 11 open items, with you, one at a time: fix, ask, keep or drop. Your
answers are saved where the next editor of those files sees them; the "fix" items become one task
you approve, which is also your first live look at the prompt.

## Secrets & env preflight

- **Phase 1:** `.env.test`, written by `scripts/second-stack.sh <N>` (no secrets). Find a free N
  across ALL worktrees, including `../TradesDatabase-decline`:
  `git worktree list --porcelain | sed -n 's/^worktree //p' | while read p; do grep -h '^port = 54.21' "$p/supabase/config.toml" 2>/dev/null; done`.
  N is free when `54(3+N)21` is absent. On 2026-09-14 the used ports were 54321, 54421 and 54521,
  so N=3.
- **Phase 2:** the same `.env.test`, plus the `claude` CLI logged in (v2.1.270 verified).
- **Phase 3:** none.

## Phase 1: The rule, in every place sessions read it

### What this phase does
Rewrites the parking doctrine in five commands, CLAUDE.md, onboarding and engineering memory, and
notes the amendment in the old plan. No code changes.

### Changes required

**`.claude/commands/park.md`** — rewrite.
- **Why this exists:** the board is the operator's reading list. An item belongs only if the
  operator must decide it AND it needs its own RPI cycle. Cut the "serialized behind" argument
  (`:9-16`) and "Parking is the whole action" (`:20`).
- **Step 1, the table** (the operator's shape, task file Notes): small + no decision → fix it on
  this branch as its own commit, named in the report, and do not park; needs a decision → ask; big +
  decision → park after a yes. A consequence of your own change is your question to ask, never an
  out-of-scope park.
- **Step 2, the yes:** unless the operator asked for this park in this conversation, ask with
  `AskUserQuestion` (title plus a one-line body). Options: put it on the board / decide it now /
  don't record it. Write only on the first.
- **A lesson** (a vendor contract, a trap, nothing to fix) is not parked. It goes in the handoff,
  which makes the promotion call yes, or in `docs/engineering-memory.md`.
- **Keep** the title/kind/files/body guidance (`:22-37`), the write block (`:38-45`) with its line
  exactly `node "$W" park --title …` (Phase 2 matches it), and the tell-the-user step (`:50-52`).
  Add that Claude Code will show an approval prompt.
- **Hard constraints:** never park without the operator's yes. Delete `:56` ("never fix the thing
  you are parking"). Keep `:57-58`.

**`.claude/commands/implement.md`**
- `:20` becomes: "**Something the plan did not cover.** A small fix needing no decision: fix it on
  this branch as its own commit, before touching that file again for the phase (if the file already
  has uncommitted phase edits, it rides in the phase commit), and name it in the phase report.
  Anything that needs the user's decision, including a side effect of this change: ask
  (`AskUserQuestion`) and act on the answer. Park only work the user approves onto the board
  (`/park`). A consequence of this change is never out of scope."
- `:24`: the reviewer also gets `git show <sha>` for each in-place fix commit, and "nothing outside
  the phase's scope changed" gains "except those fixes, which are reviewed for correctness only".
  After "Fix the findings", add: "a finding that needs the user's decision is asked, not parked;
  the reviewer cannot ask, so you do."
- `:27`: the conditional pause also stops for a pending question to the user.
- `:31`: product questions from `/code-review` are asked, not parked.
- `:41` becomes: "Do not modify files outside the plan's stated scope except as an in-place fix
  named in the phase report."

**`.claude/commands/plan.md`**
- `:30`, after "Fix valid findings in the plan": "A finding this plan causes belongs in the plan,
  never on the board; if fixing it needs the user's decision, present it as a decision brief and
  wait, before presenting the plan."
- Hard constraints (`:125-131`): add "Never `/park` a consequence of this plan."

**`.claude/commands/handoff.md`** — `:28-29` "What changed" names in-place fixes. Step 4
(`:47-57`): "a lesson found along the way is written here; a handoff carrying one makes the call yes."

**`.claude/commands/spawn.md:12-15`** — becomes: "An item on the board is work the operator
approved; it rarely depends on the task that found it, and `spawn` lets it start now."

**`CLAUDE.md`**
- `:43-45`: replace the "`/park` it … serialized" sentence with: fix small no-decision things in
  place; ask about decisions; park only big work needing a decision, after the operator's yes
  (`/park` asks, and a permission prompt backs it); a consequence of your own change is never out
  of scope. Keep the `/spawn` clause.
- `:161-162`: "Out of scope mid-task → `/park` it." becomes "Big work needing the operator's
  decision, approved by them → `/park`."

**`docs/onboarding.md:564`** — the same substitution as `CLAUDE.md:161`.

**`docs/engineering-memory.md`**
- `:306-308`: append "(parking needs the operator's yes; small things are fixed in place)".
- A new §1 bullet after `:308`, dated 2026-09-14: the doctrine; the evidence (12 open items, the
  self-described one-line fix, three product questions that were consequences of their own
  branch/plan); A + C with both doc citations; and the hooks-reload divergence against
  `CLAUDE.md:36-41`.

**`thoughts/shared/plans/2026-09-09-the-work-record-park-board-and-compaction-survival.md:258-259`**
— add beneath: "Amended 2026-09-14 by `2026-09-14-the-task-board-is-the-operators.md`: parking
needs the operator's yes; small fixes are made in place."

**Session memory** (outside the repo): `run-phases-without-asking.md` gains "a pending question to
the user" in its stop list.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass
- [ ] `grep -rn "Do not fix it here\|mid-task → \`/park\`\|Find something out of scope mid-task\|serialized behind\|Parking is the whole action\|Never fix the thing you are parking" .claude/commands CLAUDE.md docs/onboarding.md` prints nothing
- [ ] `grep -n 'node "\$W" park --title' .claude/commands/park.md` still prints the write line
- [ ] `npm run decisions:index` run; `thoughts/INDEX.md` still lists the 2026-09-09 plan as live (not superseded); output committed

### Live verification (agent-executable)
- Prerequisites: none (Agent tool only).
- [ ] A fresh-context subagent gets only the rewritten command files and five scenarios, graded
      against these answers:
      (a) mid-implement, a one-line sort tiebreak in a file this phase touches → fix in place, own commit;
      (b) plan review finds that the column this plan adds leaks retracted text → into the plan, asked before presenting;
      (c) `/code-review` finds that the question this branch builds cannot be acted on → ask;
      (d) mid-implement, an RPI-sized gap unrelated to this change → ask; park only on a yes;
      (e) the user says "park this: <an idea not on the board>" → park without asking first.
      Record its answers with the line each cites.

### Manual verification
- (none)

---

## Phase 2: The permission prompt on park

### What this phase does
Adds the `ask` rules, pins them to every CLI line in the commands with a test, and proves each
spelling live.

### Changes required

**`.claude/settings.json`** — in `"permissions"` (`:2-23`), beside `"allow"`:
```json
"ask": ["Bash(node \"$W\" park *)", "Bash(node *work.mjs park *)", "Bash(node *work.mjs\" park *)", "Bash(npm run work -- park *)"]
```

**`src/work/park-approval.test.ts`** (new, no DB):
- Asserts `permissions.ask` in `.claude/settings.json` contains the four rules.
- `matches(rule, line)`: strip `Bash(`…`)`, regex-escape, `*` → `[\s\S]*`, anchor. A comment says it
  approximates Claude Code's matcher for single lines; the probe covers the rest.
- Scans every line inside a fenced block of every `.claude/commands/*.md` for
  `/(?:"\$W"|work\.mjs"?|npm run work --)\s+([a-z]+)/`, then trims the line. Every line whose verb
  is `park` must match ≥1 rule. Every other CLI line must match none. `park.md` must yield ≥1 park line.
- Also asserts `node scripts/work.mjs park --title x` and `npm run work -- park --title x` match,
  and `npm run board` / `npm run work -- overlap a b` do not.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass
- [ ] Temporarily edit `park.md`'s write line to `node "$W"  park` (two spaces). `npx vitest run src/work/park-approval.test.ts` must FAIL. Revert, and it passes.

### Live verification (agent-executable)
- Prerequisites: `claude` CLI logged in; the scratchpad directory.
- [ ] Build a throwaway `git init` repo in the scratchpad containing:
      - `scripts/work.mjs` (copied);
      - `package.json` `{"scripts":{"work":"node scripts/work.mjs"}}`;
      - `.claude/settings.json` = `{"permissions":{"ask":[<the four rules read from the real file>]}}`.

      Commit once. Run `claude -p "<prompt>" --output-format json` from inside it twice, once with
      `--allowedTools Bash` and once with `--permission-mode auto`. The prompt says to run each
      command below exactly, in its own Bash call, and print the result.
      (1) two lines, `W="$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/work.mjs"` then `node "$W" park --title probe-heredoc --body - <<'EOF'` / `a body` / `EOF`;
      (2) `node "$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/work.mjs" park --title probe-inline`;
      (3) `node scripts/work.mjs park --title probe-path`;
      (4) `npm run work -- park --title probe-npm`;
      controls: (5) `npm run work -- board`; (6) the (1)-style `handoff --body -` heredoc with body `we will not park this`.

      **Required evidence:**
      - The JSON `permission_denials` (or the transcript's denial text) names (1)-(4).
      - `ls .claude/work/tasks/` finds no probe file.
      - (5) printed its WORKTREES table, so the npm path works.
      - (6) failed with work.mjs's own "no active task", not a denial.

      If a spelling slips through, fix the rules and the test together and re-run. Delete the
      throwaway repo.

### Manual verification
- [ ] The operator restarts this session inside the worktree (`cd <worktree> && claude`), so Phase 3 runs with the new rule.

---

## Phase 3: Triage the board with the operator

### What this phase does
Walks the 11 open items (research, "The board today") with the operator, one question per item.
Each is closed or kept, answered questions are saved, and the "fix now" set becomes one approved task.

### Changes required (through `node "$W" …` only, one item at a time)
- **For each item:** show the id, title and a two-line summary with a proposed outcome (research
  expectation: fix = tiebreak, retract test, index ranking, fetch batching; ask = the three product
  questions; keep = 10c, 10d, the status-flip report, timestamp branding). The operator picks.
  - **keep:** nothing. **drop:** `drop`, then `archive`. **fix:** collect.
  - **ask:** put the item's own options to the operator.
    - Answer means work the operator wants done: record it in the item's `## Decisions` (a direct
      edit is safe, because an open item with no worktree has no concurrent writer) and keep it open.
    - Otherwise: record it, `done`, then `promote`, which writes `thoughts/shared/findings/…` here.
    - If the answer concerns another active task (the `basis_reason` item →
      `20260912-the-model-names-the-job-on-the-ambiguous`), also append it via
      `node "$W" handoff --cwd <that task's worktree> --body -`, and tell the operator to mention it
      to that session.
- **After the last item:** if anything was collected, ask the operator to approve one task,
  "fix the small board findings: <list>", with `--kind task`, `--files` = the union of their `files:`,
  and each finding's Notes copied verbatim under `### <id>`. On the yes, park it; Claude Code's
  prompt appears and the operator approves. Then `drop` + `archive` each folded finding. Don't spawn it.
- Commit any promoted findings with `npm run decisions:index`.

### Automated verification
- [ ] `npm run board` shows only kept items, plus the fix task if one was created
- [ ] every promoted finding exists under `thoughts/shared/findings/` and appears in `thoughts/INDEX.md` after `npm run decisions:index`

### Live verification (agent-executable)
- (none; every outcome is the operator's choice)

### Manual verification
- [ ] The operator saw Claude Code's approve/deny prompt for the fix task's park (live proof of Phase 2). If none was parked: `/park` a throwaway title, see the prompt, answer No.
- [ ] The operator confirms the phase report's outcome for each item.
