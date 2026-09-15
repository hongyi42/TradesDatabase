---
date: 2026-09-14
task: the task board is the operator's: a session fixes small out-of-scope things in place or asks, and parks only what needs an operator decision and its own RPI cycle
status: complete
origin: 
files: .claude/commands/park.md, .claude/commands/implement.md, .claude/commands/plan.md, .claude/commands/handoff.md, CLAUDE.md, docs/onboarding.md, docs/engineering-memory.md, scripts/work.mjs, .claude/hooks/decisions-for-file.mjs, thoughts/shared/research/2026-09-14-the-task-board-is-the-operators.md, thoughts/shared/plans/2026-09-14-the-task-board-is-the-operators.md, .claude/commands/spawn.md, thoughts/shared/plans/2026-09-09-the-work-record-park-board-and-compaction-survival.md, .claude/settings.json, src/work/park-approval.test.ts, thoughts/shared/findings/2026-09-14-the-link-views-expose-basis-reason-but-c.md, scripts/decision-index.mjs, src/work/decision-index.test.ts
supersedes: nothing
---

## Files

- .claude/commands/park.md
- .claude/commands/implement.md
- .claude/commands/plan.md
- .claude/commands/handoff.md
- CLAUDE.md
- docs/onboarding.md
- docs/engineering-memory.md
- scripts/work.mjs
- .claude/hooks/decisions-for-file.mjs
- thoughts/shared/research/2026-09-14-the-task-board-is-the-operators.md
- thoughts/shared/plans/2026-09-14-the-task-board-is-the-operators.md
- .claude/commands/spawn.md
- thoughts/shared/plans/2026-09-09-the-work-record-park-board-and-compaction-survival.md
- .claude/settings.json
- src/work/park-approval.test.ts
- thoughts/shared/findings/2026-09-14-the-link-views-expose-basis-reason-but-c.md
- scripts/decision-index.mjs
- src/work/decision-index.test.ts

## Outcome (read first)

LANDED as PR #241 (squash `9a69697`, 2026-09-15). What binds now, where the record below is older:
- `/park` writes its park as ONE command, `node "$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/work.mjs" park …`,
  and the three ask rules in `.claude/settings.json` each START with a park. Decision 5's "verify the
  rule matches `node "$W" park`" is superseded: a park through a variable set in the same command
  (`W=…` then `node "$W" park`) matches NO park-first rule and parks with no prompt (measured,
  `claude -p` v2.1.270, default + auto). `src/work/park-approval.test.ts` refuses `$W` on a taught
  park line. Do not "simplify" `/park` back to the `W=` form the other commands use.
- A rule with a leading wildcard (`node *work.mjs park *`) is rejected: it prompts on commands that
  only MENTION a park, and DENIES them in a subagent (operator: "only fire when something is
  actually being parked").
- An in-place fix on a file a sibling task is changing stays an in-place fix (operator, final review).
- Decision 8 was overridden (supersedes: nothing, the 2026-09-09 plan is amended, not superseded).
- The "not yet PR'd" / "Open" lines in the last handoff are history.

## Notes

A JOB. USER DOCTRINE, 2026-09-14 (operator's words, condensed):
The task board is for the OPERATOR to read. Something belongs on it only if the operator must
understand it, make a decision on it, and would spawn a worktree and run an RPI cycle for it. A
"one line fix", or anything technical that needs no operator decision, does not belong there. If it
needs only a SMALL decision, the session should ASK the operator directly rather than park it.
Today worktree sessions, while planning or implementing, use the board as a garbage can for easy
fixes they defer as "outside the scope of the plan". Finishing one task spawns several, the board
grows faster than it drains, and every new item, important or not, dilutes the operator's attention.

THE RULE, as the operator stated it (the plan should keep this shape, not add a how-to):

                    needs an operator decision?
                    no                          yes
   small      fix it in this branch        ASK now, then act on the answer
   big (RPI)  (plan must settle this cell)  PARK -> the board

EVIDENCE (observed 2026-09-14, main checkout board): 12 open items, 7 of them `finding`; 9 were
parked by worktree sessions, 4 by the chooser session alone. Two specimens say in their own bodies
that they are small: 20260914-listjobsforcustomer-orders-on-created-at ("Fix is one line") and
20260914-retract-capture-s-customer-captures-loop ("Fix: a server.test.ts case").

WHERE THE CURRENT BEHAVIOUR IS TAUGHT (all on origin/main):
- .claude/commands/implement.md:20 — "An issue outside this phase's scope: /park it and continue.
  Do not fix it here". Also its hard constraint "Do not modify files outside the plan's stated
  scope without flagging it first", which the new rule has to be reconciled with.
- .claude/commands/park.md — "Default to finding"; its "Why this exists" argues parking beats
  serializing. For a small fix that premise is backwards: doing it in place IS the cheap path.
- CLAUDE.md:43 and :161, docs/onboarding.md:564 — "out of scope mid-task -> /park it".
- scripts/work.mjs:543 — every session start announces "N finding(s) are parked and unclaimed ...
  Run npm run board before starting something new", which itself pushes the pile at every session.
- .claude/commands/plan.md — plan-review findings are a source too (the listJobsForCustomer
  specimen was "Found in plan review").

OPEN FOR THE PLAN (decision brief, operator decides):
1. The "big but no operator decision" cell: park, or just do it as its own branch/PR?
2. A small fix found mid-implement: same commit, own commit on the same branch, or its own tiny PR?
   (Trade-off: PR reviewability vs the board staying clean.)
3. Some findings are LESSONS for the next editor of a file, not jobs; decisions-for-file.mjs shows
   OPEN FINDINGs before an edit. Where does that knowledge go if it stops being parked (promote,
   a code comment, the handoff)?
4. Prompt-only (the commands say it) or also a mechanical nudge in `park` (e.g. a required reason
   the operator needs it)? Inferred, not stated by the operator: memory says doctrine should say
   WHAT not HOW, and curation over gates; weigh that.
5. Triage the items already on the board under the new rule, ITEM BY ITEM with the operator
   (fix / ask / keep / archive). Never bulk-archive.
Also record the doctrine in docs/engineering-memory.md (standing rule: local memory -> repo doc).

## Decisions

OPERATOR, 2026-09-14 (after research thoughts/shared/research/2026-09-14-the-task-board-is-the-operators.md;
numbers are that doc's Decision Points):
1. "Big but no operator decision" does not exist: anything RPI-sized passes the operator's plan
   review, so big -> park. The rule's empty cell is closed.
2. Small fix mid-implement: fix it on the SAME branch as its OWN commit, name it in the phase
   report. No separate PR, no board entry. Reword implement.md:24 (reviewer "nothing outside the
   phase's scope changed") and :41 ("flag it first") so an in-place fix is not a violation.
3. Plan review: what the plan itself causes goes INTO the plan; product questions are ASKED before
   the plan is presented (a second ask after the adversarial review; the brief comes before it).
4. Lessons stay off the board: promote / engineering-memory so the next editor of the file sees
   them, and name them in the handoff.
5. EVERYTHING on the board is approved by the operator BEFOREHAND. A + C: /park asks
   (AskUserQuestion) and writes only on a yes; PLUS a settings.json permission rule so each park
   command pops an approve/deny prompt — the plan must VERIFY the rule matches `node "$W" park`
   before relying on it. Rejected B (a flag the model passes itself — protects nothing).
   `park` is the only verb that creates a task file, so gating it gates the whole folder.
6. The session-start sentence (work.mjs:543): LEAVE IT ALONE.
7. Triage item by item with the operator. Expected: fix now the sort tiebreak, the missing
   retract test, the index ranking, the fetch batching; ASK the 3 product questions (retracted
   basis_reason, invisible non-commitment reply, ambiguity ask with no filing verb); keep the 4
   tasks (10c, 10d, status-flip report, timestamp branding — parked at the operator's request, so
   already approved).
8. The plan's supersedes: names thoughts/shared/plans/2026-09-09-the-work-record-park-board-and-compaction-survival.md.

Cross-cutting, agreed:
- IN SCOPE = CAUSED BY MY CHANGE. A consequence of the session's own change is its question to
  ask, even when building the fix is big. (All 3 product questions on the board were consequences
  of the branch or plan that parked them, and parked as "out of scope".)
- Asking is a legitimate stop in /implement, beside human checks, divergence and deploys.
- Subagents cannot ask; a reviewer's question reaches the operator through the parent session.

OPERATOR, 2026-09-14, plan decision brief (plan thoughts/shared/plans/2026-09-14-the-task-board-is-the-operators.md):
- "Fix now" items → ONE task the operator approves onto the board, spawned, one PR (precedent #223).
- The permission prompt reaches worktrees via TRACKED .claude/settings.json only (on merging main);
  not a main-checkout settings.local.json copy. Running old-branch sessions are told in chat.
- The operator saying "park this" IS the yes: skip the session's own question; the prompt still shows.
- Hooks doc now says settings hook edits reach running sessions; CLAUDE.md:36-41 says not (measured
  2026-09-10): record the divergence in engineering memory, keep the restart advice, don't measure.
- supersedes: NOTHING (overrides decision 8): decision-index marks a named doc WHOLLY superseded, so the
  plan instead says it AMENDS the 2026-09-09 plan's :258-259 and adds an "amended by" note there.
- (Mine, from the docs) C is a permissions.ask RULE, not a PreToolUse hook: only an explicit ask rule
  is on "Actions no mode auto-approves" (bypassPermissions included). CORRECTED in implement: an
  earlier WebFetch summary claimed a hook's "ask" is DENY in auto mode; the raw doc says it PROMPTS
  (hooks, "PreToolUse decision control"). Quote docs from `curl -sL <page>.md`, not WebFetch.

## Handoff 2026-09-14T20:10:24.828Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/the-task-board-is-the-operator-s-a-sessi on work/the-task-board-is-the-operator-s-a-sessi, from origin/main d00564a.

Overlap check: 1 overlap with active tasks — the operator read them and proceeded (--proceed):

  LOW   same file only      docs/onboarding.md
        20260912-the-model-names-the-job-on-the-ambiguous lists it but has not changed it; 20260914-the-task-board-is-the-operator-s-a-sessi names it

## Handoff 2026-09-14T23:48:03.899Z

**What changed** — Plan complete (d4e2508), not yet PR'd. Sessions now fix small no-decision things in place (own commit, named in the report), ask about decisions, and park only on the operator's yes. /park asks first and a permissions.ask rule prompts on the park command itself (operator saw and approved it live). The board was triaged 11 → 4 kept tasks + 1 approved fix task (20260914-fix-the-small-board-findings-listjobsfor, open, NOT spawned). In-place fixes: decision-index `--check` now exits 1 on a stale index (it used to rewrite and print OK), is CRLF-tolerant, and says what it can gate; two comments cite symbols not line numbers; the empty board no longer offers the raw park verb; /spawn's "add files" advice names the one safe direct edit.
**Decisions** — (1) Final review, operator: the ask rules fire ONLY on a real park, so every rule STARTS with the park (inline `node "$(git rev-parse …)/../scripts/work.mjs" park *`, `node scripts/work.mjs park *`, `npm run work -- park *`). Rejected: the wide `node *work.mjs park *`, which prompted on mere mentions and DENIED a review subagent's `node -e`. Unusual park spellings going unprompted is accepted (/park's question is the gate). (2) Operator: an in-place fix on a file a SIBLING task is changing stays an in-place fix; rejected "ask when the hook names a sibling"; collisions surface at /integrate. (3) Operator doctrine (item 11): a to-do is a SUGGESTION the planner owns and closes; an inbound item is a gap spotted at L1 capture time; the inbound cycle is optional. Recorded in engineering memory beside the 2026-09-10 closing ruling. I had proposed "a booking auto-closes its ask": that is the per-tool wiring rejected 2026-09-10, withdrawn. (4) A wrong-premise item is done + archive, not promote (plan Decisions exception).
**Assumptions** — That Claude Code rewrites a same-command variable before matching (inferred: only the wide rule caught `W=` + `node "$W" park`; the exact matching text was NOT identified). That the `--check` false-stale on shallow clones / after fetch is acceptable because nothing calls it.
**Open** — Open the PR for this branch (code changed: settings.json, work.mjs, decision-index.mjs, tests). After it merges, every session must restart to get the new ask rules (settings are read at launch). Then spawn the fix task. This task stays active until the PR merges.
**Downstream** — Chooser task 20260912-the-model-names-the-job-on-the-ambiguous has two handoffs from here: its link_basis migration must add `retracted` to v_job_captures / v_visit_notes, and its plan's "Parked, not fixed" bullet (:96) cites ids now closed. Operator plans: fix task first, then tell the chooser session to /integrate and read those handoffs. Status-flip task absorbed the lost-reply case; rung 10d absorbed "planner files a customer-level capture onto a job". Failed approach worth knowing: `W=` + `node "$W" park` parks UNPROMPTED under any park-first rule (measured, default + auto, v2.1.270); /park now teaches the one-line form, and park-approval.test.ts refuses `$W` on a taught park line.
